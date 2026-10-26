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

- One entity **per application**. Properties: `application_id` (string, `primaryKey: true`, `autoGenerate: false`,
  pattern `^\d+$`), `nrn` (string, `nrn: true`, pattern `^organization=\d+:account=\d+:namespace=\d+:application=\d+$`)
  = the application NRN exactly. The catalog cannot cross-check the two, so the worker refuses (`EXECUTION_NOT_VERIFIED`)
  an entity whose NRN is not exactly an application NRN or whose `application=<id>` differs from its `application_id`:
  an entity at a namespace NRN would otherwise make every link of that namespace pass the ownership prefix.
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
| `EXECUTION_NOT_VERIFIED` | 403 | the catalog has no pending execution matching the envelope (id, action, link_id), or its entity is not exactly at an application NRN matching its `application_id`, or either read failed |
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
1b. **The envelope is not trusted.** Anyone with `agent:run_command` can send a catalog-shaped envelope through
   `POST /controlplane/agent_command`. Before anything else (after the `WRITES_DISABLED` gate) the worker reads, with the
   agent's key and no caching, `GET /catalog/actions/{slug}/executions/{notification.id}` and requires: the record exists,
   `status === "pending"`, `record.action === notification.slug`, `record.input.link_id === input.link_id`. **All operation
   fields are taken from `record.input`**, never from the envelope. Then it reads `GET /catalog/instances/{slug}/{record.entity_id}`
   and requires `record.entity_specification_id` and `entity.entity_specification_id` to both be present and equal (fail
   closed). The entity NRN is **only** the entity's top-level `nrn` (never `data.nrn`); it must match the application-NRN
   pattern and its `application=<id>` must equal `data.application_id`. `notification.entity_nrn` is ignored. Each execution
   id runs at most once per worker process (see Residual risks). Any failure → `EXECUTION_NOT_VERIFIED` (403).
2. Read the link with the agent's API key: `GET /link/{link_id}` including secret attributes
   (query `include_secret_attributes=true`; needs `service:link:read-secrets` on the agent key — **unverified name, confirm in e2e**).
   Never cache link reads beyond the request; never log or return the keys.
3. Ownership: `link.entity_nrn === <verified entity NRN>` or starts with `<verified entity NRN> + ":"`. Otherwise `LINK_NOT_OWNED`.
4. `link.status` must be `active`; keys must be present.
5. Bucket and region come **only** from the link's service (`GET /service/{link.service_id}` → spec matches
   `S3_BROWSER_SPECIFICATIONS`, `attributes.bucket_name`, `attributes.bucket_region`). Never from the input.
6. `path_prefix` (link attribute, may be empty): normalise to end with `/` when non-empty. list with empty
   prefix → list at `path_prefix`; any prefix/key not starting with it → `OUTSIDE_PREFIX`.
7. `access_level` (`read|write|read-write`): `delete-object` needs `write` or `read-write` (else `WRITE_NOT_ALLOWED`);
   `WRITES_DISABLED` still applies first. Reads are left to AWS (the `write` level has no GetObject).
8. S3 client built with the link's static credentials, a fresh client per request (never cached, never shared with
   the default-chain client, which keeps its per-region cache).

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

## OPEN BLOCKER: binding the execution to its entity (catalog-entities-api 8ac01a3, read in source)

- Verified: the execution record is written (`status: pending`) before the notification is dispatched and stays
  `pending` until the sync answer is recorded, so `GET /catalog/actions/{slug}/executions/{id}` sees it while the worker runs.
- Blocker: `record.entity_id` is the **internal** uuid (`uuidv5(application_id, <per-spec random namespace>)`), but
  `GET /catalog/instances/s3_browser/{id}` takes the **external** id (it applies `uuidv5` again), so the read by
  `record.entity_id` is a 404 and every link-mode request is refused (`EXECUTION_NOT_VERIFIED`, fail closed).
  The namespace is not exposed (spec `metadata` is omitted from reads), and `GET /catalog/actions/{slug}/{id}/history`
  queries the repository with the external id unresolved, so it is empty for this specification too.
- Also from source: the entity read is the flat formatted data (`application_id`, `nrn`, `created_at`, `updated_at`), with
  no `entity_specification_id` and no `data` wrapper; the worker's checks on `data.application_id` and on
  `entity.entity_specification_id` therefore refuse as well until they are adapted.
- Options: (a) catalog fix — resolve the external id in the history list, then bind via
  `GET /catalog/actions/s3_browser/{application_id}/history?status=pending&action=<slug>` containing the execution id;
  (b) catalog change — expose the external entity id (or the entity NRN) on the execution record;
  (c) identity `autoGenerate: true` (internal id = external id) — breaks addressing by `application_id`;
  (d) trust the envelope's entity id and read the entity by it — leaves a cross-entity pairing attack for a caller with
  `agent:run_command` plus `entity:write` on any `s3_browser` entity.

## Residual risks

- **Replay of a pending execution.** A caller holding `agent:run_command` who learns the id of someone else's execution
  while it is still `pending` can send a matching envelope through `POST /controlplane/agent_command` and receive the
  result. The worker remembers execution ids it already ran (in memory, last 10 000, ~10 minutes) and refuses a second run
  with `EXECUTION_NOT_VERIFIED`. That only helps while the worker process lives (a fresh process per command remembers
  nothing) and does not stop a replay that wins the race against the legitimate run. A true one-time claim needs a
  catalog status transition the worker could make atomically (e.g. pending → running), which catalog-entities-api does
  not offer today. The window is bounded by the execution's pending time (≤ the executor's `timeout_ms`) and to callers
  with `agent:run_command`.
- **Presigned URLs** carry the link's access key id in `X-Amz-Credential` (SigV4 by design); the secret never leaves the worker.

## Verified ordering

In catalog-entities-api `ActionDispatchService` (main 8ac01a3) `executorError(output)` runs **before**
`outputSchemaViolation(...)`, so a refusal is recorded as `executor_error` with `"<CODE>: <message>"` and never
as `invalid_output`. Output schemas therefore describe only the success shape.

## Unverified names (confirm in e2e)

- Query param for secret attributes on `GET /link/{id}`: read from env `S3_BROWSER_LINK_SECRETS_QUERY`
  (default `include_secret_attributes=true`) so a rename is a config change.
- Permission the agent's API key needs: `service:link:read-secrets` (the action name is in main-service-api
  `LinkInstanceActions.READ_SECRETS`; whether an agent key can be granted it is still to confirm). Without
  `include_secret_attributes` the services API masks the secret as `null`; the worker reports that as a `PLATFORM` failure.
- Catalog reads the agent's API key needs for the verification: the execution record
  (`GET /catalog/actions/s3_browser/executions/{id}`) and the entity (`GET /catalog/instances/s3_browser/{id}`), i.e. catalog
  read on executions/entities of `s3_browser` across the organization. Whether `record.entity_id` is accepted by
  `GET /catalog/instances/{slug}/{id}` (internal id vs `application_id`) is also to confirm.

## Install (not run yet)

`s3-browser/catalog/install.mjs` (Node ≥ 20, no deps), given `NP_API_KEY` (and optional `NP_API_URL`),
`NRN` (organization NRN for the channel), `AGENT_API_KEY` for the channel and flags:
creates the `s3_browser` specification (idempotent: PATCH when it exists), its 5 executors, the agent channel
from `s3_browser.channel.example.json`, and seeds one `s3_browser` entity per application that has a link to an
`aws-s3-bucket*` service. `--dry-run` prints every request without sending.
