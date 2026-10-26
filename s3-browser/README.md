# s3-browser

The worker behind the **S3 browser** UI plugin (`frontend-ui-plugins/examples/s3-browser`).
It runs as the executor of four **sync service actions** on the `aws-s3-bucket` service
specification. The dashboard never talks to a backend of ours: the plugin creates a service
action, the platform hands it to this worker through an agent channel, and the worker reads S3
with its own identity. The action specifications declare `"execution": "sync"`: the create
request is held until this worker answers, and the response is the finished action. The caller
sends no header and makes no choice.

```
plugin ── POST /service/:id/action  {slug, parameters} ──▶ services API (spec says execution: sync)
services API ── service:action:create notification, execution_strategy: sync (agent channel) ──▶ agent ──▶ this worker ──▶ S3
services API ◀── the worker's JSON, stored as the action `results` ◀────────────┘
```

Nothing is exposed inbound, there is no CORS, and the caller needs only the permission to
create service actions (plus an optional grant for the delete, below), not `agent:run_command`.

## Actions

Specifications live in [`actions/`](actions/), one JSON document per action
(`custom`, `execution: sync`, `parallelize: true`, `parameters` and `results` JSON Schemas).

| Action slug (`parameters`) | Results | Permission |
|---|---|---|
| `list-objects` (`prefix?`, `token?`, `limit?` 1–1000, default 200) | `{ bucket, region, prefix, folders[{prefix,name}], objects[{key,name,size,last_modified,storage_class,etag}], next_token, truncated }` | |
| `head-object` (`key`) | `{ key, size, content_type, last_modified, etag, storage_class, metadata }` | |
| `presign-download` (`key`) | `{ key, url, expires_at }`, a presigned GET, default 15 min | |
| `delete-object` (`key`) | `{ key }`, only with `S3_BROWSER_ALLOW_WRITES=1` | `custom:s3:objectdelete` |

```bash
curl -X POST "https://api.nullplatform.com/service/$SERVICE_ID/action" \
  -H "Authorization: Bearer $NP_TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"list-objects","parameters":{"prefix":"logs/"}}'
```

### The envelope

The channel passes `NP_ACTION_CONTEXT = {"notification": {...}}` to the worker:

| Field | Used as |
|---|---|
| `notification.specification.slug` | the operation |
| `notification.parameters` | the operation's fields |
| `notification.service.id` | the service |
| `notification.service.attributes` | `bucket_name` and `bucket_region`, used when present |
| `notification.service.specification.slug` | must match `S3_BROWSER_SPECIFICATIONS` for the attributes to be trusted |

When the attributes carry no bucket (or the specification is missing), the worker resolves the
service by id through the nullplatform API with the agent's key. The bucket never comes from
`parameters`: a `bucket` there is ignored.

The worker prints one JSON object on stdout, logs go to stderr. A refusal is
`{ "error": { "status", "code", "message" } }`, which the platform turns into a failed action
with a message: `400` not an S3 service or bad input, `403` S3 denied, `404` unknown service or
key, `405` writes disabled, `409` bucket not provisioned yet. A worker that cannot work at all
(no API key, no AWS credentials) is a failed execution.

## Setup

1. **Action specifications.** Create the four documents in `actions/` as action specifications
   of the `aws-s3-bucket` service specification (`POST /service_specification/:id/action_specification`
   with each file as the body). They are not wired into the service's tofu module: that module
   registers the service definition from `aws-s3-bucket/specs`, which has no action list.
2. **Channel.** Create an agent notification channel from [`channel.example.json`](channel.example.json)
   (`POST /notification/channel`, fill in `nrn` and `api_key`). It matches `service:action:create`
   notifications for `aws-s3-bucket` and these four slugs, and runs `package-exec` of the
   `s3-browser` package on the agent with the `{ package: "s3-browser" }` selector. The channel
   validator requires `api_key`, `selector`, `command.type` and a non-empty `command.data.cmdline`.
3. **Grants.** Without them anyone allowed to create service actions can run the three reads.
   `delete-object` declares `custom:s3:objectdelete`, so nobody can run it until a grant names
   that permission. Add `authorization` to the service specification
   (`custom:` names are never sent to auth-z; the caller must be granted the name):

```json
{
  "authorization": {
    "entities": {
      "grants": [
        { "principals": [{ "type": "role", "id": 7 }], "actions": ["action:list-objects", "action:head-object", "action:presign-download"] },
        { "principals": [{ "type": "role", "id": 9 }], "actions": ["custom:s3:objectdelete"] }
      ]
    }
  }
}
```

   Here role 7 (readers) can run the three reads and role 9 (maintainers) can run
   `delete-object`; a caller with no matching grant gets 403. Role ids are placeholders.
   `delete-object` additionally needs the worker's `S3_BROWSER_ALLOW_WRITES=1`.

The bucket must come from an instance of an accepted specification
(`S3_BROWSER_SPECIFICATIONS`, default `aws-s3-bucket*`); the pod's IAM (IRSA) reads the bucket.

## On the catalog

Use the catalog path when no service sits behind the bucket, or when the plugin lives on a
catalog page. The catalog instance IS the bucket: `bucket_name` and `region` are properties of
the instance, so there is no service lookup. The service-action path above is unchanged.

```
plugin ── POST /catalog/actions/aws-s3-bucket/{bucket_name}/list-objects {input} ──▶ catalog API
catalog (execution: sync, executor transport: notification) ── notification, source catalog ──▶ notifications ──▶ agent ──▶ worker ──▶ S3
catalog ◀── 200 with the worker's JSON, validated against the action `output` ◀──────────┘
```

Files in [`catalog/`](catalog/):

- [`aws-s3-bucket.specification.json`](catalog/aws-s3-bucket.specification.json): the entity
  specification. `bucket_name` is the primary key, `region` is indexed, `nrn` marks the NRN. The four
  actions are `sync`, with `input`/`output` copied from `actions/*.json` (a test keeps them equal).
  Reads are granted to everyone; `delete-object` is granted to nobody until a grant names `action:delete-object`.
- [`executors.json`](catalog/executors.json): four bodies, each `POST /catalog/specifications/{id}/executors`
  (`transport: notification`, `timeout_ms: 15000`).
- [`channel.example.json`](catalog/channel.example.json): agent channel on `source: catalog`,
  `action == catalog:action:create` and `specification.slug == aws-s3-bucket`.

The delete is granted by whoever installs the specification, for example on top of the grants in it:

```json
{ "principals": [{ "type": "role", "id": 9 }], "actions": ["action:delete-object"] }
```

Every catalog action runs behind the instance's `entity:write` gate (the catalog's base rule for
custom actions); the spec's grants narrow it per action.

Envelope (`NP_ACTION_CONTEXT = {"notification": <context>}`), detected when
`notification.action == "catalog:action:create"`, or when `slug`, `input` and `entity` are all present:

| Field | Used as |
|---|---|
| `notification.slug` | the operation |
| `notification.input` | the operation's fields |
| `notification.entity.bucket_name` | the bucket, required |
| `notification.entity.region` | the region, required |

A missing bucket or region is an error answer (`400`); there is no fallback lookup. A bucket or region
in `input` is ignored. `delete-object` needs `S3_BROWSER_ALLOW_WRITES=1` here too. The answer is one
JSON object on stdout; `{ "error": { "code", "message" } }` is a failure for the catalog.

## Link mode (per application, with the link's own keys)

A developer browses the S3 buckets **linked to their application**. S3 is opened with the
link's own IAM keys (the key the application already has), never with the worker's identity.
The full contract shared with the UI plugin is [`catalog/LINK_MODE.md`](catalog/LINK_MODE.md).

```
plugin ── POST /catalog/actions/s3_browser/{application_id}/{action} {input:{link_id,…}} ──▶ catalog (sync)
catalog ── notification (source catalog) ──▶ agent channel (specification.slug == s3_browser) ──▶ agent ──▶ worker
worker ── verify execution + entity in the catalog, read link (+secrets), read its service ──▶ S3 with the link's keys
catalog ◀── 200 with the worker's JSON (or a failed record "<CODE>: <message>") ◀──────────┘
```

Envelope (`NP_ACTION_CONTEXT = {"notification": <catalog context>}`), detected when
`notification.specification.slug` equals `S3_BROWSER_LINK_SPECIFICATION` (default `s3_browser`):

| Field | Used as |
|---|---|
| `notification.id` | the catalog execution, re-read and verified before anything else |
| `notification.slug` / `notification.input` | must match the catalog's record; the operation's fields are taken **from the record** |
| `notification.entity_nrn` | ignored: the NRN comes from the catalog entity |

Actions (all `sync`, every input has `link_id`, nothing else allowed):
`list-objects` (`prefix?`, `token?`, `limit?`), `head-object` (`key`), `read-object` (`key`,
`max_bytes?` 1–262144, default 262144: the first bytes as UTF-8 with `truncated` and the total
`size`), `presign-download` (`key`), `delete-object` (`key`). Outputs as in the bucket mode.

Checks, in order (all mandatory):

1. `delete-object` needs `S3_BROWSER_ALLOW_WRITES=1` (`WRITES_DISABLED`, before any lookup).
2. The execution is verified with the agent's key, without cache: `GET /catalog/actions/s3_browser/executions/{id}`
   must be `pending`, of the same action and `link_id`; `GET /catalog/instances/s3_browser/{entity_id}` must be of the
   same specification and sit exactly at an application NRN whose `application=<id>` is its `application_id`; an
   execution id runs once per worker process (`EXECUTION_NOT_VERIFIED`).
3. `GET /link/{link_id}?include_secret_attributes=true` (never cached; `LINK_NOT_FOUND`).
4. The link's `entity_nrn` is the entity's NRN or under it (`:` boundary), e.g. a scope of the app (`LINK_NOT_OWNED`).
5. The link is `active` with `aws_access_key_id`/`aws_secret_access_key` (`LINK_NOT_READY`).
6. Bucket and region come only from the link's service, which must be an accepted specification (`NOT_A_BUCKET`, `NO_BUCKET`).
7. Every prefix and key stays under the link's `path_prefix` (an empty list prefix lists at it) (`OUTSIDE_PREFIX`).
8. `delete-object` needs `access_level` `write` or `read-write` (`WRITE_NOT_ALLOWED`).

| CODE | Status | When |
|---|---|---|
| `BAD_REQUEST`, `UNKNOWN_ACTION` | 400 | malformed input |
| `EXECUTION_NOT_VERIFIED` | 403 | no matching pending execution, entity not at a matching application NRN, replay, or a catalog read failed |
| `LINK_NOT_FOUND` | 404 | the link does not exist |
| `LINK_NOT_OWNED` | 403 | the link belongs to another application |
| `LINK_NOT_READY` | 409 | the link is not active or has no keys yet |
| `NOT_A_BUCKET` / `NO_BUCKET` | 400 / 409 | the link's service is not an S3 bucket / has no bucket yet |
| `OUTSIDE_PREFIX` | 403 | prefix or key outside `path_prefix` |
| `WRITE_NOT_ALLOWED` | 403 | delete on a `read` link |
| `WRITES_DISABLED` | 405 | delete without `S3_BROWSER_ALLOW_WRITES=1` |
| S3 error names (`AccessDenied`, `NoSuchKey`, …) | 403/404/502 | from AWS |
| `PLATFORM`, `NO_CREDENTIALS`, `WORKER` | ≥500 | failed execution (e.g. the link's secret came back masked) |

The keys never appear in stdout, stderr, logs or error messages (S3 error messages are scrubbed of
them). One exception by design: a presigned URL carries the access key id in `X-Amz-Credential`;
the secret never leaves the worker. Each request builds its own S3 client with the link's keys;
nothing built with them is cached or shared with the worker's default-chain client.

Files in [`catalog/`](catalog/): [`s3_browser.specification.json`](catalog/s3_browser.specification.json)
(entity `application_id` + `nrn`, the five actions, reads granted to everyone, delete to nobody),
[`s3_browser.executors.json`](catalog/s3_browser.executors.json) (five `notification` executors,
15 s), [`s3_browser.channel.example.json`](catalog/s3_browser.channel.example.json) (agent channel).
To grant the delete, add e.g. `{ "principals": [{ "type": "role", "id": 9 }], "actions": ["action:delete-object"] }`.

### Install

```bash
NP_API_KEY=… NRN=organization=<id> AGENT_API_KEY=… node catalog/install.mjs --dry-run   # prints, sends nothing
NP_API_KEY=… NRN=organization=<id> AGENT_API_KEY=… node catalog/install.mjs
```

It creates or updates the specification (`--allow-destructive` when an update narrows it), the
five executors and the agent channel (`--skip-channel`), and seeds one `s3_browser` entity per
application with a link to an `aws-s3-bucket*` service (`--skip-seed`; 409 = already there).
`--dry-run` cannot preview the seeding (it sends no reads either). Not yet run against a real API.

### To confirm in e2e

- The query that returns secret attributes on `GET /link/{id}`: `include_secret_attributes=true`
  (main-service-api reads `includeSecretAttributes` from the query; `S3_BROWSER_LINK_SECRETS_QUERY`
  changes it without a release).
- The agent's API key needs `service:link:read-secrets` (the action name in main-service-api) and
  catalog read on `s3_browser` executions and entities; whether an agent key can hold them is unverified.
- `GET /catalog/instances/s3_browser/{record.entity_id}` accepts the record's `entity_id`, and the
  entity read carries `entity_specification_id` and a top-level `nrn`.
- Installer list queries: `GET /notification/channel?nrn=…` and `GET /link?nrn=…&show_descendants=true&limit=&offset=`.

## Legacy direct command

Existing installs keep working: the worker still accepts
`{"action":"list-objects","service_id":"<id>", ...fields}` (flat, or under `command`) as
`NP_ACTION_CONTEXT`, sent with `POST /controlplane/agent_command`
(`type: package-exec`, `selector: {package: "s3-browser"}`, which needs `agent:run_command`).
The fields are the `parameters` above plus `service_id`; the service is always resolved by
id, and the result is the same JSON.

## Environment

| Variable | Meaning |
|---|---|
| `NP_API_KEY`, `NP_API_URL` | injected by the agent at spawn; used to read the service when the envelope lacks the bucket, and in link mode the catalog execution, the entity, the link and its service |
| `AWS_REGION` | default region when the service has none; credentials from the default chain (IRSA in a cluster, env locally) |
| `S3_BROWSER_ALLOW_IMDS` | `1` lets the credential chain query EC2 instance metadata (off by default: a container without a route to it hangs) |
| `S3_BROWSER_SPECIFICATIONS` | accepted specification slugs, comma list, trailing `*` = prefix; default `aws-s3-bucket*` |
| `S3_BROWSER_ALLOW_WRITES` | `1` enables `delete-object` |
| `S3_BROWSER_DOWNLOAD_TTL_SECONDS` | presigned URL lifetime, default 900 |
| `S3_BROWSER_LINK_SPECIFICATION` | catalog specification slug that selects link mode, default `s3_browser` |
| `S3_BROWSER_LINK_SECRETS_QUERY` | query string for `GET /link/{id}` that includes secret attributes, default `include_secret_attributes=true` |

## Develop

```bash
bun install
bun test
bun run describe          # the manifest np package publish reads
mise run build:image      # s3-browser-worker:dev
NP_API_KEY=… NP_PACKAGE_ENV_JSON='{"AWS_ACCESS_KEY_ID":"…","AWS_SECRET_ACCESS_KEY":"…","AWS_SESSION_TOKEN":"…"}' mise run run
```

`mise run run` (what `np package run` does) starts a controlplane agent in Docker tagged
`package:s3-browser,local:<you>` that spawns this worker; a command with
`selector: { package: "s3-browser", local: "<you>" }` then runs here.

## Publish

```bash
NP_PUSH_REGISTRY=<registry>/<repo> np package publish --dir s3-browser --nrn organization=…
```

It builds and pushes the image, registers the package `s3-browser` with the image as its
worker artifact and the agent channel. The UI bundle is attached to the same package by
`frontend-ui-plugins/scripts/publish.mjs --dir examples/s3-browser`.
