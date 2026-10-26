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
  = the application NRN exactly. The worker refuses (`EXECUTION_NOT_VERIFIED`) an execution whose `entity_nrn` is not
  exactly an application NRN: an entity at a namespace NRN would otherwise make every link of that namespace pass the
  ownership prefix.
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
| `EXECUTION_NOT_VERIFIED` | 403 | no pending execution with that id and action in the catalog, invalid recorded input, `entity_nrn` missing (flag off) or not exactly an application NRN, a replayed execution id, or a catalog read failed |
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
   `POST /controlplane/agent_command`. Link mode takes only `notification.id` and `notification.slug` from it. Before anything
   else (after the `WRITES_DISABLED` gate) the worker reads, with the agent's key and no caching,
   `GET /catalog/actions/{slug}/executions/{notification.id}` (specification-scoped: the catalog only returns records of
   that specification) and requires the record to exist, `status === "pending"` and `record.action === notification.slug`.
   **All operation fields (`link_id`, `prefix`, `token`, `limit`, `key`, `max_bytes`) come from `record.input`**, validated
   with the same rules; the envelope's `input` and `entity_nrn` are ignored. The NRN the link must belong to is
   `record.entity_nrn` (the NRN the catalog authorized the execution against), which must match
   `^organization=\d+:account=\d+:namespace=\d+:application=\d+$`; absent, null or not matching → refused. Each execution
   id runs at most once per worker process (see Residual risks). Any failure → `EXECUTION_NOT_VERIFIED` (403).
1c. **Interim demo flag, default off: `S3_BROWSER_UNVERIFIED_ENTITY_BINDING=1`.** Only when `record.entity_nrn` is absent or
   null (the catalog change that adds it is not deployed yet), the worker reads the entity named by the envelope,
   `GET /catalog/instances/{slug}/{notification.entity.application_id}` (flat response, top-level `nrn`), and uses its `nrn`.
   It still requires a pending record of the same action, takes the input from the record, and requires the NRN to be
   exactly an application NRN whose `application=<id>` is the envelope's application id. Every use logs a warning.
   A present but invalid `entity_nrn` never falls back. **Never enable it in a customer organization; remove it once the
   catalog change is deployed.** What it gives up: the entity is no longer bound to the execution, so a caller with
   `agent:run_command` can pair a real pending execution (of an entity they can write) with another application's id.
   That caller can already use this same binary's legacy direct command and the `aws-s3-bucket` catalog mode, which open S3
   with the agent's own identity without any catalog check, so in our own organization the flag adds no new capability; it
   matters in a client organization whose agent role cannot read objects.
2. Read the link with the agent's API key: `GET /link/{link_id}` including secret attributes
   (query `include_secret_attributes=true`; needs `service:link:read-secrets` on the agent key — both confirmed in main-service-api source).
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

## Binding the execution to its entity (resolved: catalog change pending deploy)

The execution record's `entity_id` is the catalog's internal uuid, which no public read accepts for a specification with
an external primary key (`uuidv5(application_id, <per-spec namespace>)`), so the worker cannot read the entity from the
record. Resolution: catalog-entities-api adds `entity_nrn` (string|null, the NRN the catalog authorized against) to
`GET /catalog/actions/:slug/executions/:actionId`, and the worker binds on it (step 1b). Until that is deployed the record
has no `entity_nrn` and link mode refuses every request, unless the demo flag of step 1c is on.
Verified in source (8ac01a3): the record is written as `pending` before the notification is dispatched and stays so until
the sync answer is recorded.

## Residual risks

- **Replay of a pending execution.** A caller holding `agent:run_command` who learns the id of someone else's execution
  while it is still `pending` can send a matching envelope through `POST /controlplane/agent_command` and receive the
  result. The worker remembers execution ids it already ran (in memory, last 10 000, ~10 minutes) and refuses a second run
  with `EXECUTION_NOT_VERIFIED`. That only helps while the worker process lives (a fresh process per command remembers
  nothing) and does not stop a replay that wins the race against the legitimate run. A true one-time claim needs a
  catalog status transition the worker could make atomically (e.g. pending → running), which catalog-entities-api does
  not offer today. The window is bounded by the execution's pending time (≤ the executor's `timeout_ms`) and to callers
  with `agent:run_command`.
- **Other modes of the same binary.** The legacy direct command (`{action, service_id}` through `agent_command`) and the
  `aws-s3-bucket` catalog mode open S3 with the worker's own identity and do no catalog check; anyone with
  `agent:run_command` can use them on any bucket that identity reaches. Candidates to disable or gate in the security review.
- **`S3_BROWSER_UNVERIFIED_ENTITY_BINDING=1`** (step 1c) unbinds the entity from the execution while it is on.
- **Presigned URLs** carry the link's access key id in `X-Amz-Credential` (SigV4 by design); the secret never leaves the worker.

## Verified ordering

In catalog-entities-api `ActionDispatchService` (main 8ac01a3) `executorError(output)` runs **before**
`outputSchemaViolation(...)`, so a refusal is recorded as `executor_error` with `"<CODE>: <message>"` and never
as `invalid_output`. Output schemas therefore describe only the success shape.

## Names: confirmed and still to confirm in e2e

- Confirmed in main-service-api source: the query `include_secret_attributes=true` on `GET /link/{id}` (the controller reads
  `includeSecretAttributes`) and the permission `service:link:read-secrets` (`LinkInstanceActions.READ_SECRETS`). Without
  the query the services API masks the secret as `null`; the worker reports that as a `PLATFORM` failure. The query stays
  configurable (`S3_BROWSER_LINK_SECRETS_QUERY`).
- To confirm: that an agent API key can be granted `service:link:read-secrets` and catalog read on `s3_browser`
  executions (and, only for the demo flag, entities) across the organization.
- To confirm once deployed: `entity_nrn` on the execution read.

## Install (not run yet)

`s3-browser/catalog/install.mjs` (Node ≥ 20, no deps), given `NP_API_KEY` (and optional `NP_API_URL`),
`NRN` (organization NRN for the channel), `AGENT_API_KEY` for the channel and flags:
creates the `s3_browser` specification (idempotent: PATCH when it exists), its 5 executors, the agent channel
from `s3_browser.channel.example.json`, and seeds one `s3_browser` entity per application that has a link to an
`aws-s3-bucket*` service. `--dry-run` prints every request without sending.
