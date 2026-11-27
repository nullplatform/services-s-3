#!/bin/bash
# Tests for how a link gets the S3 browser's IAM role: build_context (LINK_BROWSER_ENABLED),
# build_permissions_context (the module's variables) and link_access_key (what the link records).
# `aws`, `np` and `tofu` are stubs on PATH: no AWS or nullplatform call is made.
# Run: bash aws-s3-bucket/tests/link_role_test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$HERE/../scripts/aws"
FAILS=0
PASSES=0

check() { # name, expected, actual
  if [ "$2" = "$3" ]; then PASSES=$((PASSES + 1)); else FAILS=$((FAILS + 1)); echo "FAIL: $1 (expected '$2', got '$3')"; fi
}

TMP="$(mktemp -d)"
RUN_ID="roletest$$"
trap 'rm -rf "$TMP" "/tmp/np-service-svc-$RUN_ID" /tmp/np-link-*"$RUN_ID"*' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/aws" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$STUB_DIR/aws.calls"
case "$1 $2" in
  "iam list-access-keys") jq -nc --argjson ids "${STUB_KEYS:-[]}" '{AccessKeyMetadata: ($ids | map({AccessKeyId: .}))}' ;;
  "iam create-access-key") echo '{"AccessKey":{"AccessKeyId":"AKIANEWKEY","SecretAccessKey":"newSecretValue"}}' ;;
esac
STUB
cat > "$TMP/bin/np" <<'STUB'
#!/bin/bash
case "$1 $2" in
  "provider list") echo '{"results":[{"id":"P1","data_source":{"stored_keys":["account.region"]}}]}' ;;
  "provider read") echo '{"attributes":{"account":{"region":"us-east-1"}}}' ;;
  "link read") cat "$STUB_LINK" ;;
  "link patch") printf '%s\n' "$6" > "$STUB_DIR/patch.json" ;;
esac
STUB
cat > "$TMP/bin/tofu" <<'STUB'
#!/bin/bash
# tofu -chdir=DIR output -raw NAME
case "$4" in
  role_arn) echo "arn:aws:iam::123456789012:role/np-s3-stub" ;;
  iam_role_name) echo "np-s3-stub" ;;
esac
STUB
chmod +x "$TMP/bin/"*
printf 'aws_profile: ""\nlink_role_trusted_principals: "%s"\n' "arn:aws:iam::123456789012:role/worker" > "$TMP/values.yaml"
printf 'aws_profile: ""\nlink_role_trusted_principals: ""\n' > "$TMP/values-empty.yaml"

ctx() { # action-type, link attributes json, parameters json
  jq -nc --arg id "link-$RUN_ID-$1" --argjson attrs "$2" --argjson params "$3" \
    '{service:{id:("svc-'"$RUN_ID"'"),nrn:"organization=1:account=2:namespace=3",name:"x",attributes:{bucket_name:"the-bucket",bucket_region:"us-east-1"}},link:{id:$id,attributes:$attrs},parameters:$params}'
}

# Runs build_context then build_permissions_context for a link action; prints the stage's
# exit code, and leaves the variables in $TMP/vars.
prepare() { # action-type, context, values-file
  ( export PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" CONTEXT="$2" VALUES="${3:-$TMP/values.yaml}" ACTION_SOURCE=link SERVICE_ACTION_TYPE="$1" SERVICE_PATH="$HERE/.."
    # shellcheck source=/dev/null
    source "$SCRIPTS/build_context" >/dev/null 2>&1 || exit 11
    # shellcheck source=/dev/null
    source "$SCRIPTS/build_permissions_context" >"$TMP/perm.out" 2>&1 || exit 12
    echo "$LINK_BROWSER_ENABLED" > "$TMP/browser"
    cp "$TOFU_VAR_FILE" "$TMP/tfvars.json" )
  echo $?
}
tfvar() { jq -c "$1" "$TMP/tfvars.json"; }

# --- build_context + build_permissions_context ---------------------------------
check "create, explorer on: ok" 0 "$(prepare create "$(ctx create '{}' '{"access_level":"read","browser_enabled":true}')")"
check "create, explorer on: role requested" true "$(tfvar .browser_role)"
check "create, explorer on: only the configured principal may assume it" '["arn:aws:iam::123456789012:role/worker"]' "$(tfvar .trusted_principal_arns)"
check "the module is not given a credentials mode" null "$(tfvar .credentials)"

check "create, explorer off: ok" 0 "$(prepare create "$(ctx create '{}' '{"access_level":"read","browser_enabled":false}')")"
check "create, explorer off: no role" false "$(tfvar .browser_role)"
check "create, explorer off: no principals sent" '[]' "$(tfvar .trusted_principal_arns)"

check "create, browser_enabled absent: ok" 0 "$(prepare create "$(ctx create '{}' '{"access_level":"read"}')")"
check "create, browser_enabled absent: no role" false "$(tfvar .browser_role)"

check "a string true is not true" 0 "$(prepare create "$(ctx create '{}' '{"browser_enabled":"true"}')")"
check "a string true gives no role" false "$(tfvar .browser_role)"

check "update turning it on: ok" 0 "$(prepare update "$(ctx update '{"browser_enabled":false,"access_level":"read"}' '{"browser_enabled":true}')")"
check "update turning it on: the parameter wins, role requested" true "$(tfvar .browser_role)"
check "update turning it on keeps the stored access level" '"read"' "$(tfvar .access_level)"
check "update turning it off: ok" 0 "$(prepare update "$(ctx update '{"browser_enabled":true}' '{"browser_enabled":false}')")"
check "update turning it off: no role" false "$(tfvar .browser_role)"
check "update of another field keeps the stored flag" true "$(prepare update "$(ctx update '{"browser_enabled":true}' '{"access_level":"read"}')" >/dev/null; tfvar .browser_role)"

check "the explorer on without a trusted principal fails" 1 "$(prepare create "$(ctx create '{}' '{"browser_enabled":true}')" "$TMP/values-empty.yaml")"
check "the failure says what to set" 1 "$(grep -c 'link_role_trusted_principals' "$TMP/perm.out")"
check "it is the principals check that failed" 1 "$(grep -c 'no principal may assume its role' "$TMP/perm.out")"
check "the explorer off needs no trusted principal" 0 "$(prepare create "$(ctx create '{}' '{"browser_enabled":false}')" "$TMP/values-empty.yaml")"
check "update with the explorer on and no principal fails" 1 "$(prepare update "$(ctx update '{}' '{"browser_enabled":true}')" "$TMP/values-empty.yaml")"
check "unlink needs no trusted principal even with a role" 0 "$(prepare delete "$(ctx delete '{"browser_enabled":true}' '{}')" "$TMP/values-empty.yaml")"
check "an env list wins over values.yaml" '["arn:aws:iam::123456789012:role/other"]' "$(LINK_ROLE_TRUSTED_PRINCIPALS=arn:aws:iam::123456789012:role/other prepare create "$(ctx create '{}' '{"browser_enabled":true}')" >/dev/null; tfvar .trusted_principal_arns)"

# --- link_access_key -------------------------------------------------------------
# link-json, browser-enabled, existing-key-ids-json, action -> exit code; calls and patch recorded.
ensure() {
  rm -f "$TMP/aws.calls" "$TMP/patch.json"
  echo "$1" > "$TMP/link.json"
  ( export PATH="$TMP/bin:$PATH" STUB_DIR="$TMP" STUB_LINK="$TMP/link.json" STUB_KEYS="$3" CONTEXT='{"link":{"id":"L1"}}' IAM_USER_NAME=np-s3-stub LINK_BROWSER_ENABLED="$2" OUTPUT_DIR="$TMP" LINK_KEY_ACTION="${4:-ensure}"
    bash "$SCRIPTS/link_access_key" >"$TMP/ensure.out" 2>&1 )
  echo $?
}
patched() { jq -c "$1" "$TMP/patch.json"; }
created() { grep -c 'create-access-key' "$TMP/aws.calls" 2>/dev/null | head -1; }
ROLE='"role_arn":"arn:aws:iam::123456789012:role/np-s3-stub","iam_role_name":"np-s3-stub"'
KEPT="{\"attributes\":{\"aws_access_key_id\":\"AKIAOLD\",$ROLE}}"

check "new link, explorer off: ok" 0 "$(ensure '{"attributes":{}}' false '[]')"
check "new link, explorer off: a key is created" 1 "$(created)"
check "new link, explorer off: the key and user are recorded" '["aws_access_key_id","aws_secret_access_key","iam_user_name"]' "$(patched '.attributes | keys')"
check "new link, explorer off: no role is recorded" null "$(patched '.attributes.role_arn')"

check "new link, explorer on: ok" 0 "$(ensure '{"attributes":{}}' true '[]')"
check "new link, explorer on: key and role recorded together" '["aws_access_key_id","aws_secret_access_key","iam_role_name","iam_user_name","role_arn"]' "$(patched '.attributes | keys')"
check "new link, explorer on: the role is the module's" '"arn:aws:iam::123456789012:role/np-s3-stub"' "$(patched '.attributes.role_arn')"

check "update turning it on: ok" 0 "$(ensure '{"attributes":{"aws_access_key_id":"AKIAOLD"}}' true '["AKIAOLD"]')"
check "update turning it on: the key is kept, not recreated" 0 "$(created)"
check "update turning it on: only the role is recorded" "{\"attributes\":{$ROLE}}" "$(patched .)"

check "update turning it off: ok" 0 "$(ensure "$KEPT" false '["AKIAOLD"]')"
check "update turning it off: the recorded role is cleared" '{"attributes":{"role_arn":"","iam_role_name":""}}' "$(patched .)"

check "update with nothing to change: ok" 0 "$(ensure "$KEPT" true '["AKIAOLD"]')"
check "update with nothing to change: no patch" 0 "$(test -f "$TMP/patch.json" && echo 1 || echo 0)"
check "explorer off and no role recorded: no patch" 0 "$(ensure '{"attributes":{"aws_access_key_id":"AKIAOLD"}}' false '["AKIAOLD"]' >/dev/null; test -f "$TMP/patch.json" && echo 1 || echo 0)"

check "unlink deletes the user's keys" 0 "$(ensure '{"attributes":{}}' true '["AKIA1","AKIA2"]' delete-all)"
check "unlink deleted both keys" 2 "$(grep -c 'delete-access-key' "$TMP/aws.calls")"
check "unlink does not patch the link" 0 "$(test -f "$TMP/patch.json" && echo 1 || echo 0)"
check "the secret is not printed" 0 "$(grep -c newSecretValue "$TMP/ensure.out")"

if [ "$FAILS" -gt 0 ]; then echo "$FAILS failed, $PASSES passed"; exit 1; fi
echo "all $PASSES checks passed"
