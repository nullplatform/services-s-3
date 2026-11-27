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

# --- action_refusal ----------------------------------------------------------
ACTION='{"id":"A1","link_id":"L1","specification_id":"AS-DEL","status":"in_progress","parameters":{"key":"uploads/a.txt"}}'
action_refusal "$ACTION" L1 AS-DEL >/dev/null; check "action ok" 0 $?
action_refusal "${ACTION/in_progress/pending}" L1 AS-DEL >/dev/null; check "pending action ok" 0 $?
for other in pending_create success failed cancelled deleted; do
  action_refusal "${ACTION/in_progress/$other}" L1 AS-DEL >/dev/null; check "$other action refused" 1 $?
done
action_refusal "$ACTION" L2 AS-DEL >/dev/null; check "action of another link refused" 1 $?
action_refusal "$ACTION" L1 AS-OTHER >/dev/null; check "action of another specification refused" 1 $?
action_refusal "$ACTION" L1 "" >/dev/null; check "no delete-object specification refused" 1 $?

# --- the whole script, with stubs --------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/np" <<'STUB'
#!/bin/bash
# np link read --id X --format json            -> $STUB_DIR/link.json
# np link action read --linkId L --id A ...    -> $STUB_DIR/action.json
# np link specification action specification list --linkSpecificationId S ...  -> $STUB_DIR/specs.json
# np service read --id S --format json         -> $STUB_DIR/service.json
# np link|service action update --results JSON -> recorded, with the route it went through
# Every read is recorded in np.calls; STUB_NP_FAIL makes the read it names fail.
case "$1 $2 $3" in
  "link read --id") file=link ;;
  "link action read") file=action ;;
  "link specification action") file=specs ;;
  "service read --id") file=service ;;
  "link action update" | "service action update")
    printf '%s\n' "$5" > "$STUB_DIR/results.json"
    printf '%s\n' "$1" > "$STUB_DIR/results.route"
    exit 0
    ;;
  *) echo "unexpected np $*" >&2; exit 2 ;;
esac
printf '%s\n' "$*" >> "$STUB_DIR/np.calls"
if [ "${STUB_NP_FAIL:-}" = "$file" ]; then echo "np: 403" >&2; exit 1; fi
cat "$STUB_DIR/$file.json"
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

run() { # context-json  (the records come from $TMP/*.json; STUB_AWS_ERROR and STUB_NP_FAIL from the caller)
  rm -f "$TMP/results.json" "$TMP/results.route" "$TMP/aws.calls" "$TMP/np.calls"
  PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" CONTEXT="$1" bash "$SCRIPT" >"$TMP/out" 2>&1
  echo $?
}
ctx() { # key: the notification of action A1 of link L1, as the platform sends it
  jq -nc --arg key "$1" '{id:"A1",service:{id:"S1",attributes:{bucket_name:"the-bucket",bucket_region:"eu-west-1"}},link:{id:"L1"},parameters:{key:$key}}'
}
records() { # key: the records the API answers with for that notification
  echo "$LINK" | jq -c '.service_id = "S1" | .specification_id = "LS1"' > "$TMP/link.json"
  jq -nc --arg key "$1" '{id:"A1",link_id:"L1",specification_id:"AS-DEL",status:"in_progress",parameters:{key:$key}}' > "$TMP/action.json"
  echo '{"results":[{"id":"AS-UPD","slug":"update-connect"},{"id":"AS-DEL","slug":"delete-object"}]}' > "$TMP/specs.json"
  echo '{"id":"S1","attributes":{"bucket_name":"the-bucket","bucket_region":"eu-west-1"}}' > "$TMP/service.json"
}
edit() { # file jq-filter: changes one record
  jq -c "$2" "$TMP/$1.json" > "$TMP/$1.next" && mv "$TMP/$1.next" "$TMP/$1.json"
}
calls() { cat "$TMP/aws.calls" 2>/dev/null | wc -l | tr -d ' '; }
result() { jq -r "$1" "$TMP/results.json"; }

records "uploads/a.txt"
check "delete ok exit" 0 "$(run "$(ctx "uploads/a.txt")")"
check "delete ok calls aws once" 1 "$(calls)"
check "delete ok targets bucket, key and region" "s3api delete-object --bucket=the-bucket --key=uploads/a.txt --region=eu-west-1" "$(cat "$TMP/aws.calls")"
check "delete ok result" "deleted" "$(result .status)"
check "a link's action reports through the link's route" "link" "$(cat "$TMP/results.route")"
check "the action is read back by its link and id" 1 "$(grep -c -- '^link action read --linkId L1 --id A1 ' "$TMP/np.calls")"
check "the link's specification is asked for its actions" 1 "$(grep -c -- '--linkSpecificationId LS1 ' "$TMP/np.calls")"
check "the service is read back by the link's service id" 1 "$(grep -c -- '^service read --id S1 ' "$TMP/np.calls")"

edit action '.status = "pending"'
check "a pending (approved) action runs" 0 "$(run "$(ctx "uploads/a.txt")")"

records "uploads/-rf"
check "key starting with a dash is one value" 0 "$(run "$(ctx "uploads/-rf")")"
check "dash key passed as --key=" "s3api delete-object --bucket=the-bucket --key=uploads/-rf --region=eu-west-1" "$(cat "$TMP/aws.calls")"

records "other/a.txt"
check "outside prefix fails" 1 "$(run "$(ctx "other/a.txt")")"
check "outside prefix never calls aws" 0 "$(calls)"
check "outside prefix result is failed" "failed" "$(result .status)"

records "uploads/dir/"
check "folder marker fails" 1 "$(run "$(ctx "uploads/dir/")")"
check "folder marker never calls aws" 0 "$(calls)"

records "uploads/a.txt"
check "bare service (no link) fails" 1 "$(run '{"id":"A1","service":{"id":"S1"},"parameters":{"key":"a"}}')"
check "bare service never calls aws" 0 "$(calls)"
check "bare service reports through the service's route" "service" "$(cat "$TMP/results.route")"

check "no action id fails" 1 "$(run "$(ctx "uploads/a.txt" | jq -c 'del(.id)')")"
check "no action id never calls aws" 0 "$(calls)"

edit link '.service_id = "OTHER"'
check "link of another service fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "link of another service never calls aws" 0 "$(calls)"

records "uploads/a.txt"
edit link '.attributes.access_level = "read"'
check "read-only link fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "read-only link never calls aws" 0 "$(calls)"

# A forged notification: only its ids are used, and it must agree with the records read back.
records "uploads/a.txt"
check "forged key fails" 1 "$(run "$(ctx "uploads/other.sql")")"
check "forged key never calls aws" 0 "$(calls)"
check "forged key is named in the result as the approved one" "uploads/a.txt" "$(result .key)"

check "forged bucket fails" 1 "$(run "$(ctx "uploads/a.txt" | jq -c '.service.attributes.bucket_name = "victim-bucket"')")"
check "forged bucket never calls aws" 0 "$(calls)"
check "forged region fails" 1 "$(run "$(ctx "uploads/a.txt" | jq -c '.service.attributes.bucket_region = "us-east-1"')")"
check "forged region never calls aws" 0 "$(calls)"
check "a notification without a region uses the service's" 0 "$(run "$(ctx "uploads/a.txt" | jq -c 'del(.service.attributes.bucket_region)')")"
check "the region comes from the service" "s3api delete-object --bucket=the-bucket --key=uploads/a.txt --region=eu-west-1" "$(cat "$TMP/aws.calls")"

check "forged service id fails" 1 "$(run "$(ctx "uploads/a.txt" | jq -c '.service.id = "S2"')")"
check "forged service id never calls aws" 0 "$(calls)"

edit service '.attributes.bucket_name = "the-real-bucket"'
check "a bucket that differs from the service's fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "a bucket that differs from the service's never calls aws" 0 "$(calls)"

records "uploads/a.txt"
edit action '.status = "pending_create"'
check "an action waiting for approval fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "an action waiting for approval never calls aws" 0 "$(calls)"
for status in success failed cancelled; do
  edit action ".status = \"$status\""
  check "a $status action fails (no replay)" 1 "$(run "$(ctx "uploads/a.txt")")"
  check "a $status action never calls aws" 0 "$(calls)"
done

records "uploads/a.txt"
edit action '.link_id = "L2"'
check "an action of another link fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "an action of another link never calls aws" 0 "$(calls)"

records "uploads/a.txt"
edit action '.specification_id = "AS-UPD"'
check "another action of the link fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "another action of the link never calls aws" 0 "$(calls)"

records "uploads/a.txt"
echo '{"results":[{"id":"AS-UPD","slug":"update-connect"}]}' > "$TMP/specs.json"
check "a link specification without delete-object fails" 1 "$(run "$(ctx "uploads/a.txt")")"
check "a link specification without delete-object never calls aws" 0 "$(calls)"

records "uploads/a.txt"
for read in action specs service; do
  check "a failed $read read fails" 1 "$(STUB_NP_FAIL=$read run "$(ctx "uploads/a.txt")")"
  check "a failed $read read never calls aws" 0 "$(calls)"
done

records "uploads/a.txt"
check "S3 error fails" 1 "$(STUB_AWS_ERROR=1 run "$(ctx "uploads/a.txt")")"
check "S3 error keeps only the code" "S3 refused the delete (AccessDenied)" "$(result .message)"
check "S3 error does not leak the role" 0 "$(grep -c 'assumed-role' "$TMP/results.json" "$TMP/out" | awk -F: '{s+=$2} END {print s+0}')"

if [ "$FAILS" -gt 0 ]; then echo "$FAILS failed, $PASSES passed"; exit 1; fi
echo "all $PASSES checks passed"
