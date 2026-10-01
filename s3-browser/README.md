# s3-browser

The worker behind the **S3 browser** UI plugin (`frontend-ui-plugins/examples/s3-browser`).
It runs as the executor of four **sync service actions** on the `aws-s3-bucket` service
specification. The dashboard never talks to a backend of ours: the plugin creates a service
action, the platform hands it to this worker through an agent channel, and the worker reads S3
with its own identity.

```
plugin ── POST /service/:id/action  {slug, parameters}  + X-Mode: sync ──▶ services API
services API ── service:action:create notification (agent channel) ──▶ agent ──▶ this worker ──▶ S3
services API ◀── the worker's JSON, stored as the action `results` ◀────────────┘
```

Nothing is exposed inbound, there is no CORS, and the caller needs only the permission to
create service actions (plus an optional grant for the delete, below), not `agent:run_command`.

## Actions

Specifications live in [`actions/`](actions/), one JSON document per action
(`custom`, `parallelize: true`, `parameters` and `results` JSON Schemas).

| Action slug (`parameters`) | Results | Permission |
|---|---|---|
| `list-objects` (`prefix?`, `token?`, `limit?` 1–1000, default 200) | `{ bucket, region, prefix, folders[{prefix,name}], objects[{key,name,size,last_modified,storage_class,etag}], next_token, truncated }` | |
| `head-object` (`key`) | `{ key, size, content_type, last_modified, etag, storage_class, metadata }` | |
| `presign-download` (`key`) | `{ key, url, expires_at }`, a presigned GET, default 15 min | |
| `delete-object` (`key`) | `{ key }`, only with `S3_BROWSER_ALLOW_WRITES=1` | `custom:s3:objectdelete` |

```bash
curl -X POST "https://api.nullplatform.com/service/$SERVICE_ID/action" \
  -H "Authorization: Bearer $NP_TOKEN" -H 'X-Mode: sync' -H 'content-type: application/json' \
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
   (`POST /notification/channel`, fill in `nrn`). It matches `service:action:create`
   notifications for `aws-s3-bucket` and these four slugs, and runs `package-exec` of the
   `s3-browser` package on the agent with the `{ package: "s3-browser" }` selector.
3. **Grants (optional).** Without them anyone allowed to create service actions can run all four.
   To restrict the delete, add `authorization` to the service specification
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
| `NP_API_KEY`, `NP_API_URL` | injected by the agent at spawn; used to read the service when the envelope lacks the bucket |
| `AWS_REGION` | default region when the service has none; credentials from the default chain (IRSA in a cluster, env locally) |
| `S3_BROWSER_ALLOW_IMDS` | `1` lets the credential chain query EC2 instance metadata (off by default: a container without a route to it hangs) |
| `S3_BROWSER_SPECIFICATIONS` | accepted specification slugs, comma list, trailing `*` = prefix; default `aws-s3-bucket*` |
| `S3_BROWSER_ALLOW_WRITES` | `1` enables `delete-object` |
| `S3_BROWSER_DOWNLOAD_TTL_SECONDS` | presigned URL lifetime, default 900 |

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
