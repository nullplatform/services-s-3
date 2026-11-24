#!/bin/bash
# Tests for scripts/aws/delete_object: the validation functions directly, and the whole script
# with stubbed `aws` and `np` on PATH (no AWS or nullplatform call is made).
# Run: bash aws-s3-bucket/tests/delete_object_test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/aws/delete_object"
FAILS=0
PASSES=0

check() { # name, expected, actual
  if [ "$2" = "$3" ]; then PASSES=$((PASSES + 1)); else FAILS=$((FAILS + 1)); echo "FAIL: $1 (expected '$2', got '$3')"; fi
}

# --- functions ---------------------------------------------------------------
export DELETE_OBJECT_LIB_ONLY=1
# shellcheck source=../scripts/aws/delete_object
source "$SCRIPT"
unset DELETE_OBJECT_LIB_ONLY
set +e # the sourced script turns errexit on

check "prefix empty" "" "$(normalise_path_prefix "")"
check "prefix gets slash" "a/b/" "$(normalise_path_prefix "a/b")"
check "prefix keeps slash" "a/b/" "$(normalise_path_prefix "a/b/")"

key_refusal "a/b.txt" >/dev/null; check "plain key ok" 0 $?
key_refusal "" >/dev/null; check "empty key refused" 1 $?
key_refusal "/a" >/dev/null; check "leading slash refused" 1 $?
key_refusal "a/" >/dev/null; check "folder marker refused" 1 $?
key_refusal "$(printf 'k%.0s' $(seq 1 1024))" >/dev/null; check "1024 bytes ok" 0 $?
key_refusal "$(printf 'k%.0s' $(seq 1 1025))" >/dev/null; check "1025 bytes refused" 1 $?
key_refusal "a/../b" >/dev/null; check "dot-dot is a literal key (the worker does not refuse it)" 0 $?

LINK='{"status":"active","attributes":{"browser_enabled":true,"access_level":"read-write","path_prefix":"uploads"}}'
link_refusal "$LINK" L1 "uploads/a.txt" >/dev/null; check "link ok" 0 $?
link_refusal "$LINK" L1 "uploads/../a.txt" >/dev/null; check "inside prefix by string" 0 $?
link_refusal "$LINK" L1 "uploads2/a.txt" >/dev/null; check "sibling of prefix refused" 1 $?
link_refusal "$LINK" L1 "other/a.txt" >/dev/null; check "outside prefix refused" 1 $?
link_refusal "${LINK/active/pending}" L1 "uploads/a" >/dev/null; check "inactive refused" 1 $?
# While an action of the link runs (this one included) the platform holds the link in `updating`.
link_refusal "${LINK/active/updating}" L1 "uploads/a" >/dev/null; check "updating allowed" 0 $?
for other in creating failed deleting deleted archived cancelled; do
  link_refusal "${LINK/active/$other}" L1 "uploads/a" >/dev/null; check "$other refused" 1 $?
done
link_refusal "${LINK/true/false}" L1 "uploads/a" >/dev/null; check "browser off refused" 1 $?
link_refusal '{"status":"active","attributes":{"access_level":"read-write"}}' L1 "uploads/a" >/dev/null; check "browser_enabled missing refused" 1 $?
link_refusal "${LINK/read-write/read}" L1 "uploads/a" >/dev/null; check "read-only refused" 1 $?
link_refusal "${LINK/read-write/write}" L1 "uploads/a" >/dev/null; check "write ok" 0 $?
link_refusal '{"status":"active","attributes":{"browser_enabled":true,"access_level":"read-write"}}' L1 "any/key" >/dev/null; check "no prefix: whole bucket" 0 $?

# --- the whole script, with stubs --------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/np" <<'STUB'
#!/bin/bash
# np link read --id X --format json  |  np link|service action update --results JSON
# Which route the results went through is recorded: a link's action must use the link's.
case "$1 $2" in
  "link read") cat "$STUB_LINK" ;;
  "link action" | "service action")
    printf '%s\n' "$5" > "$STUB_DIR/results.json"
    printf '%s\n' "$1" > "$STUB_DIR/results.route"
    ;;
esac
STUB
cat > "$TMP/bin/aws" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$STUB_DIR/aws.calls"
if [ -n "${STUB_AWS_ERROR:-}" ]; then
  echo "An error occurred (AccessDenied) when calling the DeleteObject operation: User: arn:aws:sts::1:assumed-role/secret is not authorized" >&2
  exit 254
fi
STUB
chmod +x "$TMP/bin/np" "$TMP/bin/aws"

run() { # context-json  (STUB_LINK and STUB_AWS_ERROR come from the caller)
  rm -f "$TMP/results.json" "$TMP/results.route" "$TMP/aws.calls"
  PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" CONTEXT="$1" bash "$SCRIPT" >"$TMP/out" 2>&1
  echo $?
}
ctx() { # key [link-json-fragment]
  jq -nc --arg key "$1" '{service:{id:"S1",attributes:{bucket_name:"the-bucket",bucket_region:"eu-west-1"}},link:{id:"L1"},parameters:{key:$key}}'
}
calls() { cat "$TMP/aws.calls" 2>/dev/null | wc -l | tr -d ' '; }
result() { jq -r "$1" "$TMP/results.json"; }

echo "$LINK" | jq -c '.service_id = "S1"' > "$TMP/link.json"
export STUB_LINK="$TMP/link.json"

check "delete ok exit" 0 "$(run "$(ctx "uploads/a.txt")")"
check "delete ok calls aws once" 1 "$(calls)"
check "delete ok targets bucket, key and region" "s3api delete-object --bucket=the-bucket --key=uploads/a.txt --region=eu-west-1" "$(cat "$TMP/aws.calls")"
check "delete ok result" "deleted" "$(result .status)"
check "a link's action reports through the link's route" "link" "$(cat "$TMP/results.route")"

check "key starting with a dash is one value" 0 "$(run "$(ctx "uploads/-rf")")"
check "dash key passed as --key=" "s3api delete-object --bucket=the-bucket --key=uploads/-rf --region=eu-west-1" "$(cat "$TMP/aws.calls")"

check "outside prefix fails" 1 "$(run "$(ctx "other/a.txt")")"
check "outside prefix never calls aws" 0 "$(calls)"
check "outside prefix result is failed" "failed" "$(result .status)"

check "folder marker fails" 1 "$(run "$(ctx "uploads/dir/")")"
check "folder marker never calls aws" 0 "$(calls)"

check "bare service (no link) fails" 1 "$(run '{"service":{"id":"S1"},"parameters":{"key":"a"}}')"
check "bare service never calls aws" 0 "$(calls)"
check "bare service reports through the service's route" "service" "$(cat "$TMP/results.route")"

echo "$LINK" | jq -c '.service_id = "OTHER"' > "$TMP/link.json"
check "link of another service fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "link of another service never calls aws" 0 "$(calls)"

echo "$LINK" | jq -c '.service_id = "S1" | .attributes.access_level = "read"' > "$TMP/link.json"
check "read-only link fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "read-only link never calls aws" 0 "$(calls)"

echo "$LINK" | jq -c '.service_id = "S1"' > "$TMP/link.json"
check "S3 error fails" 1 "$(STUB_AWS_ERROR=1 run "$(ctx "uploads/a.txt")")"
check "S3 error keeps only the code" "S3 refused the delete (AccessDenied)" "$(result .message)"
check "S3 error does not leak the role" 0 "$(grep -c 'assumed-role' "$TMP/results.json" "$TMP/out" | awk -F: '{s+=$2} END {print s+0}')"

if [ "$FAILS" -gt 0 ]; then echo "$FAILS failed, $PASSES passed"; exit 1; fi
echo "all $PASSES checks passed"
