# s3_browser link mode — shared contract (worker ↔ plugin)

Goal: a developer browses the S3 buckets linked to their application from a UI plugin. Every bucket
operation is a synchronous catalog action. The worker opens S3 with the **link's own IAM keys**
(the key the app already has), never with the agent's role.

## Chain

plugin → `POST /catalog/actions/s3_browser/{application_id}/{action}` `{ input }`
→ catalog (gate `entity:write` at the entity NRN + spec grant `action:<slug>`; `execution: sync`)
→ executor `transport: notification` → main-notifications-api (sync, one responder channel)
→ agent channel (filter `source: catalog`, `action: catalog:action:create`, `specification.slug == s3_browser`)
→ np-agent `package-exec` → worker `s3-browser` with `NP_ACTION_CONTEXT = {"notification": <context>}`
→ stdout JSON → back as the execution record (HTTP 200).

Catalog context the worker receives (catalog-entities-api `ActionContext`):
`{ id, action: "catalog:action:create", slug: "<action slug>", input: {...}, status, specification: { id, slug: "s3_browser" }, entity: {...}, entity_nrn: "<entity NRN>", user: { id } }`.

## Catalog specification `s3_browser`

- One entity **per application**. Properties: `application_id` (string, `primaryKey: true`, `autoGenerate: false`),
  `nrn` (string, `nrn: true`) = the application NRN `organization=…:account=…:namespace=…:application=<id>`.
  Path id in `/catalog/actions/s3_browser/{id}/…` and `/catalog/instances/s3_browser/{id}` = `application_id`.
- Create body: `POST /catalog/instances/s3_browser` with the flat data `{ "application_id": "123", "nrn": "<app nrn>" }`
  (needs `entity:create` at that NRN).
- Actions, all `"execution": "sync"`. Every input has `link_id` (string, required, `^[A-Za-z0-9-]{1,64}$`), `additionalProperties: false`:

| action | input (besides link_id) | output |
|---|---|---|
| `list-objects` | `prefix?` (relative, no leading `/`, ≤1024), `token?`, `limit?` (1..1000, default 200) | `{ bucket, region, prefix, folders:[{prefix,name}], objects:[{key,name,size,last_modified,storage_class?,etag?}], next_token, truncated }` (same as the existing worker's Listing) |
| `head-object` | `key` (relative, no leading/trailing `/`, ≤1024) | `{ key, size, content_type?, last_modified, etag?, storage_class?, metadata }` |
| `read-object` (new) | `key`, `max_bytes?` (1..262144, default 262144) | `{ key, text, truncated, content_type?, size }` — first `max_bytes` bytes decoded as UTF-8; `truncated` = object larger than what was read |
| `presign-download` | `key` | `{ key, url, expires_at }` |
| `delete-object` | `key` | `{ key }` |

- Authorization block (`schema.authorization.entities.grants`): principal `{type:"*"}` gets
  `read`, `list`, `action:list-objects`, `action:head-object`, `action:read-object`, `action:presign-download`.
  `delete-object` is granted to nobody by default; whoever installs adds e.g.
  `{ "principals": [{ "type": "role", "id": <ops role id> }], "actions": ["action:delete-object"] }`.

## Errors

The worker prints `{ "error": { "status", "code", "message" } }` on stdout for refusals (exit 0) and fails the
execution (exit 1) for status ≥ 500 — unchanged from the existing worker. Catalog turns the refusal into a
**failed** record: `output.error = { code: "executor_error", message: "<CODE>: <message>" }`
(catalog-entities-api `ActionDispatchService.executorError` joins code and message with `": "`).
Platform failures arrive as `output.error.code` ∈ `no_channel | timeout | executor_error | invalid_output | dispatch_error`
with a free-form message.

Worker codes in link mode (CODE → status):

| CODE | status | when |
|---|---|---|
| `BAD_REQUEST` / `UNKNOWN_ACTION` | 400 | malformed input |
| `LINK_NOT_FOUND` | 404 | `GET /link/{id}` is 404 |
| `LINK_NOT_OWNED` | 403 | link.entity_nrn is neither the entity NRN nor under it (`entity_nrn + ":"` prefix) |
| `LINK_NOT_READY` | 409 | link status not `active`, or no `aws_access_key_id`/`aws_secret_access_key` |
| `NOT_A_BUCKET` | 400 | the link's service specification does not match `S3_BROWSER_SPECIFICATIONS` |
| `NO_BUCKET` | 409 | service has no `bucket_name` yet |
| `OUTSIDE_PREFIX` | 403 | prefix/key outside the link's `path_prefix` |
| `WRITE_NOT_ALLOWED` | 403 | `delete-object` on a link whose `access_level` is `read` |
| `WRITES_DISABLED` | 405 | `delete-object` while `S3_BROWSER_ALLOW_WRITES` is not `1` |
| S3 error names (`AccessDenied`, `NoSuchKey`, `NotFound`, `NoSuchBucket`, …) | 403/404/502 | from AWS, as today (`StoreError`) |
| `PLATFORM`, `NO_CREDENTIALS`, `WORKER` | ≥500 | worker broken → failed execution |

## Worker behaviour in link mode (security-relevant, all mandatory)

1. Link mode = catalog envelope whose `notification.specification.slug` equals `S3_BROWSER_LINK_SPECIFICATION`
   (env, default `s3_browser`). The existing bucket-entity catalog mode (`aws-s3-bucket`) and service/legacy shapes keep working.
2. Read the link with the agent's API key: `GET /link/{link_id}` including secret attributes
   (query `include_secret_attributes=true`; needs `service:link:read-secrets` on the agent key — **unverified name, confirm in e2e**).
   Never cache link reads beyond the request; never log or return the keys.
3. Ownership: `link.entity_nrn === notification.entity_nrn` or starts with `notification.entity_nrn + ":"`. Otherwise `LINK_NOT_OWNED`.
4. `link.status` must be `active`; keys must be present.
5. Bucket and region come **only** from the link's service (`GET /service/{link.service_id}` → spec matches
   `S3_BROWSER_SPECIFICATIONS`, `attributes.bucket_name`, `attributes.bucket_region`). Never from the input.
6. `path_prefix` (link attribute, may be empty): normalise to end with `/` when non-empty. list with empty
   prefix → list at `path_prefix`; any prefix/key not starting with it → `OUTSIDE_PREFIX`.
7. `access_level` (`read|write|read-write`): `delete-object` needs `write` or `read-write` (else `WRITE_NOT_ALLOWED`);
   `WRITES_DISABLED` still applies first. Reads are left to AWS (the `write` level has no GetObject).
8. S3 client built with the link's static credentials (one client per region+access key id; never shared with
   the default-chain client).

## Plugin behaviour

- Entity id = application id taken from the link's `entity_nrn` (`application=<id>` segment). The app NRN for
  create = the link's entity_nrn cut after the `application=<id>` segment.
- Call the action directly. On HTTP 403 or 404 for an application whose entity is not known to exist yet,
  `POST /catalog/instances/s3_browser` `{ application_id, nrn }`: 2xx → retry the action once; 409 → surface the
  original error; 403 → `not_enabled` ("Browsing isn't enabled for this application. Ask an administrator to enable it.").
- Sync is decided by the action definition (no `X-Mode` header). A record whose status is neither `success` nor
  `failed` is `not_sync`.
- `failed` + `executor_error` + message `^([A-Za-z_]+): ` → a **domain** error with that CODE (normalised to the
  plugin's message codes); other failures → platform errors.
- Input names follow this contract (`token`, `limit`, `max_bytes`); outputs as above (`next_token` may be null,
  `delete-object` returns `{ key }`).

## Verified ordering

In catalog-entities-api `ActionDispatchService` (main 8ac01a3) `executorError(output)` runs **before**
`outputSchemaViolation(...)`, so a refusal is recorded as `executor_error` with `"<CODE>: <message>"` and never
as `invalid_output`. Output schemas therefore describe only the success shape.

## Unverified names (confirm in e2e)

- Query param for secret attributes on `GET /link/{id}`: read from env `S3_BROWSER_LINK_SECRETS_QUERY`
  (default `include_secret_attributes=true`) so a rename is a config change.
- Permission the agent's API key needs: `service:link:read-secrets`.

## Install (not run yet)

`s3-browser/catalog/install.mjs` (Node ≥ 20, no deps), given `NP_API_KEY` (and optional `NP_API_URL`),
`NRN` (organization NRN for the channel), `AGENT_API_KEY` for the channel and flags:
creates the `s3_browser` specification (idempotent: PATCH when it exists), its 5 executors, the agent channel
from `s3_browser.channel.example.json`, and seeds one `s3_browser` entity per application that has a link to an
`aws-s3-bucket*` service. `--dry-run` prints every request without sending.
