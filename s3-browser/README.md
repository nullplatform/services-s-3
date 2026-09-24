# s3-browser

The worker behind the **S3 browser** UI plugin (`frontend-ui-plugins/examples/s3-browser`).
The dashboard never talks to a backend of ours: the plugin asks the platform to run a command
on the organization's agent, the agent spawns this worker (the package's image), the worker
resolves the bucket from the nullplatform service and reads S3 with its own identity.

```
dashboard ── POST /controlplane/agent_command (package-exec, package s3-browser) ──▶ agent ──▶ this worker ──▶ S3
                                                                                        └──▶ GET /service/:id (agent's API key)
```

Nothing is exposed inbound, there is no CORS, and there is no second credential: the agent's
API key reads the service, the pod's IAM (IRSA) reads the bucket.

## Commands

The command is the JSON the caller puts in `command.data.environment.NP_ACTION_CONTEXT`;
the result is the JSON the worker writes to stdout, which the API returns as `result`.

| `action` | Fields | Result |
|---|---|---|
| `list-objects` | `service_id`, `prefix?`, `token?`, `limit?` (1–1000, default 200) | `{ bucket, region, prefix, folders[{prefix,name}], objects[{key,name,size,last_modified,storage_class,etag}], next_token, truncated }` |
| `head-object` | `service_id`, `key` | `{ key, size, content_type, last_modified, etag, storage_class, metadata }` |
| `presign-download` | `service_id`, `key` | `{ key, url, expires_at }` — a presigned GET, default 15 min |
| `delete-object` | `service_id`, `key` | `{ key }` — only with `S3_BROWSER_ALLOW_WRITES=1` |

A refusal is a completed command whose result is `{ error: { status, code, message } }`:
`400` not an S3 service or bad input, `403` S3 denied, `404` unknown service or key,
`405` writes disabled, `409` bucket not provisioned yet. A worker that cannot work at all
(no API key, no AWS credentials) is a failed execution.

```bash
curl -X POST https://api.nullplatform.com/controlplane/agent_command \
  -H "Authorization: Bearer $NP_TOKEN" -H 'content-type: application/json' -d '{
  "nrn": "organization=…:account=…",
  "selector": { "package": "s3-browser" },
  "command": { "type": "package-exec", "data": { "package": "s3-browser",
    "environment": { "NP_ACTION_CONTEXT": "{\"action\":\"list-objects\",\"service_id\":\"<service id>\",\"prefix\":\"logs/\"}" } } }
}'
```

The bucket always comes from the service (`attributes.bucket_name`, `bucket_region`), never
from the request, and the service must be an instance of an accepted specification
(`S3_BROWSER_SPECIFICATIONS`, default `aws-s3-bucket*`).

## Environment

| Variable | Meaning |
|---|---|
| `NP_API_KEY`, `NP_API_URL` | injected by the agent at spawn; used to read the service |
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
