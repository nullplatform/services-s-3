# worker

The services/s3 image's worker: one process, on [`@nullplatform/plugin`](https://www.npmjs.com/package/@nullplatform/plugin)
0.4.0, that the controlplane agent spawns and drives over gRPC. It answers two kinds of command:

| Route (in order) | Takes | Answers with |
|---|---|---|
| `link-mode` ([`src/plugin.ts`](src/plugin.ts) `linkRoute`) | catalog executions of the `s3_browser` specification: `notification.action == catalog:action:create` and `notification.specification.slug == s3_browser` | the **S3 browser**: S3 opened with the link's own IAM keys or a session of its IAM role, after every catalog and link check below |
| `execute` ([`src/plugin.ts`](src/plugin.ts) `bridgeRoute`) | everything else: the aws-s3-bucket service and link actions, any other command | the **aws-s3-bucket bash entrypoint**, run exactly as worker-bridge v2.0.7 ran it |

There is no mode that opens S3 with the worker's own AWS identity: the old s3-browser worker's direct command,
service-action and `aws-s3-bucket` catalog modes are gone, and such a payload is handed to bash, which knows nothing of
it. The S3 store refuses any request that does not carry the link's credentials ([`src/s3.ts`](src/s3.ts)).

```
src/index.ts      environment → createWorker → main (describe, exec or gRPC serve)
src/plugin.ts     definePlugin: the two routes; keeps the delivered document for the bash route
src/bridge.ts     the bash entrypoint, worker-bridge's command line, environment and answer
src/handler.ts    link mode: execution verification, link checks, role links, scrubbing
src/protocol.ts   link-mode payloads and the recorded input
src/platform.ts   nullplatform reads (catalog execution and entity, link, service, specification)
src/role.ts       role links: the role ARN rebuilt from the link id, STS AssumeRole
src/s3.ts         S3 with the link's credentials: list, head, read, presign, delete
catalog/          s3_browser specification, executors, channel example, install.mjs, LINK_MODE.md
```

## The bash route: worker-bridge, as it was

Until this worker, the image's entrypoint was worker-bridge v2.0.7 (nullplatform/worker-bridge `src/index.ts`). For every
command that is not the S3 browser's, [`src/bridge.ts`](src/bridge.ts) does what it did:

- runs `bash $NP_SCOPE_ENTRYPOINT --service-path=$NP_SERVICE_PATH`, plus one `--overrides-path=<path>` per entry of the
  comma-separated `NP_OVERRIDES_PATH` (defaults `/app/entrypoint`, `/app`, none);
- with the worker's environment as it started, plus `NP_ACTION_CONTEXT` = the delivered document (the
  `{ "notification": … }` wrapper and anything beside it, re-serialized from the parsed JSON: same JSON, not
  necessarily the same bytes; a shell's single quotes around it are already gone);
- no timeout and no cancellation, as the bridge had none;
- mirrors the entrypoint's stdout and stderr to the worker's own (to stderr only in exec mode, where stdout is the answer);
- answers `{ exitCode, stdout, stderr }` on exit 0. Over gRPC that is byte-for-byte the bridge's result: `success: true`,
  that JSON as `data`, empty `error`/`error_code`, `exit_code: 0`, nothing streamed (`test/grpc.test.ts`).

What differs, both forced by the SDK (0.4.0), whose gRPC failure carries no data:

| | worker-bridge v2.0.7 | this worker |
|---|---|---|
| exit ≠ 0: result | `success: false`, `data: {exitCode, stdout, stderr}`, `error` = last 4000 chars of stderr (else stdout, else `entrypoint exited N`), `exit_code: 0`, `error_code: ""` | `success: false`, no `data`, the same `error`, `exit_code: 1`, `error_code: ENTRYPOINT_FAILED`; stdout and stderr streamed as output events, so the agent's `stdOut`/`stdErr` still carry them (plus the SDK's `ENTRYPOINT_FAILED: …` line on stderr, and a partial update per event) |
| `Capabilities` | `NP_COMMAND_TYPES` (default `scope,service,action`) | always `action` (the agent only logs it: controlplane-agent `grpc_manager.go`) |
| `--describe` | `{ name, version, command_types, agent: { selector, sources } }` | the SDK's manifest (`name`, `slug`, `version`, `components: []`, `runs`) plus the bridge's `command_types` and `agent` |
| a payload that is not a JSON object | handed to bash | refused by the SDK (`MISSING_CONTEXT`); the agent only sends JSON objects (it parses the action context first) |

`NP_PACKAGE_NAME` (default `worker`) and `NP_PACKAGE_VERSION` (default `0.0.0`) name the package, as before.

The bash route trusts the envelope, as worker-bridge did: aws-s3-bucket reads the service and link from it, including
the bucket name a link policy is built from (`scripts/aws/build_permissions_context`). A caller with `agent:run_command`
can therefore point its own link's policy at another application's bucket. Treat `agent:run_command` on this agent as
full control of every service and link it manages (details in
[`catalog/LINK_MODE.md`](catalog/LINK_MODE.md#residual-risks)).

## The link-mode route: the S3 browser

A developer browses the S3 buckets **linked to their application** from the S3 browser UI plugin. S3 is opened with the
link's own IAM keys (the key the application already has) or, for a link created with `credentials: role`, a 900 s
session of the link's IAM role; never with the worker's identity. The full contract shared with the UI plugin is
[`catalog/LINK_MODE.md`](catalog/LINK_MODE.md).

```
plugin ── POST /catalog/actions/s3_browser/{application_id}/{action} {input:{linkId,…}} ──▶ catalog (sync)
catalog ── notification (source catalog) ──▶ agent channel (specification.slug == s3_browser) ──▶ agent ──▶ this worker (package aws-s3-bucket)
worker ── verify the execution in the catalog, read link (+secrets unless a role link), read its service ──▶ S3 with the link's keys or role
catalog ◀── 200 with the worker's JSON (or a failed record "<CODE>: <message>") ◀──────────┘
```

The document is `{"notification": <catalog context>}`; the route takes it when `notification.action` is
`catalog:action:create` and `notification.specification.slug` equals `S3_BROWSER_LINK_SPECIFICATION` (default `s3_browser`):

| Field | Used as |
|---|---|
| `notification.id` | the catalog execution, re-read and verified before anything else |
| `notification.slug` | the operation; must equal the record's `action` |
| `notification.input`, `notification.entity_nrn` | ignored: the fields come from the record's `input`, the NRN from the record's `entity_nrn` |

Actions (all `sync`, every input has `link_id`, nothing else allowed; the specification declares the inputs in camelCase
because the catalog camelCases the request body before validating it, and the execution record comes back snake_case):
`list-objects` (`prefix?`, `token?`, `limit?`), `head-object` (`key`), `read-object` (`key`,
`max_bytes?` 1–262144, default 262144: the first bytes as UTF-8 with `truncated` and the total
`size`), `presign-download` (`key`), `delete-object` (`key`). Outputs in [`catalog/LINK_MODE.md`](catalog/LINK_MODE.md).

Checks, in order (all mandatory):

1. `delete-object` needs `S3_BROWSER_ALLOW_WRITES=1` (`WRITES_DISABLED`, before any lookup).
2. The execution is verified with the agent's key, without cache: `GET /catalog/actions/s3_browser/executions/{id}`
   must be `pending` and of the same action; its `input` gives every field (`link_id` included) and its `entity_nrn`
   must be exactly an application NRN; an execution id runs once per worker process (`EXECUTION_NOT_VERIFIED`).
3. `GET /link/{link_id}` without secret attributes (never cached; `LINK_NOT_FOUND`).
4. The link's `entity_nrn` is the entity's NRN or under it (`:` boundary), e.g. a scope of the app (`LINK_NOT_OWNED`).
5. The link is `active` (`LINK_NOT_READY`). Then, by the link's `credentials` attribute:
   - `access-key` or absent: `GET /link/{link_id}?include_secret_attributes=true` (never cached), checks 4–5 again, and
     the link must have `aws_access_key_id`/`aws_secret_access_key` (`LINK_NOT_READY`).
   - `role`: no secret is read. The role ARN is rebuilt from the link id, `arn:<partition>:iam::<account>:role/np-s3-<first
     16 chars of the id without dashes, lowercased>`, with `S3_BROWSER_LINK_ROLE_ACCOUNT_ID` / `S3_BROWSER_LINK_ROLE_PARTITION`
     (`LINK_ROLE_NOT_CONFIGURED` without a valid account); a `role_arn` on the link that differs is refused
     (`LINK_ROLE_MISMATCH`), never assumed.
6. Bucket and region come only from the link's service, which must be an accepted specification (`NOT_A_BUCKET`, `NO_BUCKET`).
7. Every prefix and key stays under the link's `path_prefix` (an empty list prefix lists at it) (`OUTSIDE_PREFIX`).
8. `delete-object` needs `access_level` `write` or `read-write` (`WRITE_NOT_ALLOWED`).
9. Role links only, after every check above: STS `AssumeRole` on the rebuilt ARN with the worker's own identity, session
   `s3-browser-<execution id>`, 900 s, in the bucket's region (`LINK_ROLE_DENIED` when STS refuses).

| CODE | Status | When |
|---|---|---|
| `BAD_REQUEST`, `UNKNOWN_ACTION` | 400 | malformed input |
| `EXECUTION_NOT_VERIFIED` | 403 | no pending execution of that action, invalid recorded input, `entity_nrn` missing or not an application NRN, replay, or a catalog read failed |
| `LINK_NOT_FOUND` | 404 | the link does not exist |
| `LINK_NOT_OWNED` | 403 | the link belongs to another application |
| `LINK_NOT_READY` | 409 | the link is not active or has no keys yet |
| `LINK_ROLE_NOT_CONFIGURED` | 409 | a role link while `S3_BROWSER_LINK_ROLE_ACCOUNT_ID` is unset or not 12 digits (or the partition is invalid) |
| `LINK_ROLE_MISMATCH` | 403 | the role link's `role_arn` is not the role rebuilt from its id |
| `LINK_ROLE_DENIED` | 403 | STS refused the `AssumeRole` (the worker's role is not trusted by the link's role, or the role does not exist); STS's own message goes to the worker's log only |
| `NOT_A_BUCKET` / `NO_BUCKET` | 400 / 409 | the link's service is not an S3 bucket / has no bucket yet |
| `OUTSIDE_PREFIX` | 403 | prefix or key outside `path_prefix` |
| `WRITE_NOT_ALLOWED` | 403 | delete on a `read` link |
| `WRITES_DISABLED` | 405 | delete without `S3_BROWSER_ALLOW_WRITES=1` |
| S3 / STS error names (`AccessDenied`, `NoSuchKey`, `CredentialsProviderError`, …) | 403/404/500/502 | from AWS |
| `PLATFORM`, `NO_CREDENTIALS`, `WORKER` | ≥500 | failed execution (e.g. the link's secret came back masked) |

The keys and role sessions never appear in stdout, stderr, logs or error messages (S3 and STS error
messages are scrubbed of them). One exception by design: a presigned URL carries the access key id in
`X-Amz-Credential` (and, for a role link, the session token in `X-Amz-Security-Token`); the secret
never leaves the worker. A role link's presigned URL (and its `expires_at`) is capped at the end of its
900 s session, even with a longer `S3_BROWSER_DOWNLOAD_TTL_SECONDS`. Each request builds its own S3 client with the link's
keys or session; nothing built with them is cached or shared, and there is no S3 client with the worker's identity.

Files in [`catalog/`](catalog/): [`s3_browser.specification.json`](catalog/s3_browser.specification.json)
(entity `application_id` + `nrn`, the five actions, reads granted to everyone, delete to nobody),
[`s3_browser.executors.json`](catalog/s3_browser.executors.json) (five `notification` executors,
15 s), [`s3_browser.channel.example.json`](catalog/s3_browser.channel.example.json) (agent channel).
To grant the delete, add e.g. `{ "principals": [{ "type": "role", "id": 9 }], "actions": ["action:delete-object"] }`.

### Interim demo flag: `S3_BROWSER_UNVERIFIED_ENTITY_BINDING=1` (off by default)

The catalog change that adds `entity_nrn` to the execution read is pending deploy; until then every
link-mode request is refused. With this flag, and only when the record has no `entity_nrn`, the
worker reads the entity named by the envelope (`GET /catalog/instances/s3_browser/{entity.application_id}`)
and uses its `nrn`, still requiring a pending record of the same action, the input from the record
and an exact application NRN for that id. Every use logs a warning. **Never enable it in a customer
organization; remove it once the catalog change is deployed.** It unbinds the entity from the
execution, so a caller with `agent:run_command` could pair a real execution with another
application. That is not the only way: the bash route below trusts its envelope too.

### Install

```bash
NP_API_KEY=… NRN=organization=<id> AGENT_API_KEY=… AGENT_SELECTOR='{"<tag>":"<value>"}' node catalog/install.mjs --dry-run   # prints, sends nothing
NP_API_KEY=… NRN=organization=<id> AGENT_API_KEY=… AGENT_SELECTOR='{"<tag>":"<value>"}' node catalog/install.mjs
```

It creates or updates the specification (`--allow-destructive` when an update narrows it), the five executors and the
agent channel (`--skip-channel`), and seeds one `s3_browser` entity per application with a link to an `aws-s3-bucket*`
service (`--skip-seed`; 409 = already there). The channel runs `package-exec` of the `aws-s3-bucket` package (this
image) on the agents `AGENT_SELECTOR` names: the same `tags_selectors` as the service's own channel, and the package must
be the `package_slug` that channel uses. `--dry-run` cannot preview the seeding (it sends no reads either). Not yet run
against a real API.

### Confirmed, and to confirm in e2e

- Confirmed in main-service-api source: `include_secret_attributes=true` on `GET /link/{id}` (still
  configurable with `S3_BROWSER_LINK_SECRETS_QUERY`) and the permission `service:link:read-secrets`.
- To confirm: that an agent API key can hold `service:link:read-secrets` and catalog read on
  `s3_browser` executions (and entities, for the demo flag only).
- To confirm once deployed: `entity_nrn` on `GET /catalog/actions/s3_browser/executions/{id}`.
- Installer list queries: `GET /notification/channel?nrn=…` and `GET /link?nrn=…&show_descendants=true&limit=&offset=`.

## Environment

| Variable | Meaning |
|---|---|
| `NP_SCOPE_ENTRYPOINT`, `NP_SERVICE_PATH`, `NP_OVERRIDES_PATH` | the bash route's entrypoint, `--service-path` and `--overrides-path`s (the image sets the first two) |
| `NP_PACKAGE_NAME`, `NP_PACKAGE_VERSION`, `NP_COMMAND_TYPES`, `NP_AGENT_SOURCES` | the package's name and version; the bridge's manifest fields, printed by `--describe` |
| `NP_API_KEY`, `NP_API_URL` | injected by the agent at spawn; link mode reads the catalog execution, the link and its service with them (and bash gets them, as before) |
| `AWS_REGION` | default region when the link's service has none |
| `S3_BROWSER_ALLOW_IMDS` | `1` lets STS's source credential chain query EC2 instance metadata (off by default: a container without a route to it hangs); never changes bash's environment |
| `S3_BROWSER_SPECIFICATIONS` | service specifications a link's service may be, comma list, trailing `*` = prefix; default `aws-s3-bucket*` |
| `S3_BROWSER_ALLOW_WRITES` | `1` enables `delete-object` |
| `S3_BROWSER_DOWNLOAD_TTL_SECONDS` | presigned URL lifetime, default 900 (a role link's is capped at its session) |
| `S3_BROWSER_LINK_SPECIFICATION` | catalog specification slug that selects link mode, default `s3_browser` |
| `S3_BROWSER_LINK_SECRETS_QUERY` | query string for `GET /link/{id}` that includes secret attributes, default `include_secret_attributes=true` |
| `S3_BROWSER_UNVERIFIED_ENTITY_BINDING` | `1` = demo-only fallback when the execution record has no `entity_nrn`; never in a customer organization |
| `S3_BROWSER_LINK_ROLE_ACCOUNT_ID` | 12-digit AWS account the role links' IAM roles live in; unset refuses role links (`LINK_ROLE_NOT_CONFIGURED`). The worker's own role must be in the aws-s3-bucket service's `link_role_trusted_principals` and be allowed `sts:AssumeRole` on `arn:<partition>:iam::<account>:role/np-s3-*` |
| `S3_BROWSER_LINK_ROLE_PARTITION` | partition of those role ARNs, default `aws` (e.g. `aws-cn`, `aws-us-gov`) |

## Develop

```bash
bun install
bun run test        # unit, routing (through the SDK's transport) and gRPC (src/index.ts as the agent runs it)
bun run typecheck
bun run lint
NP_PACKAGE_NAME=aws-s3-bucket bun src/index.ts --describe
```

The image is the repository's [`Dockerfile`](../Dockerfile): this worker compiled to a musl binary in place of
worker-bridge's, on worker-bridge's runtime image (bash, jq, curl, np, the app user) plus aws-cli, gomplate and OpenTofu.
`.github/workflows/worker.yml` runs the tests, the typecheck and the lint on every pull request and before every release.

```bash
docker build -t s3-worker:dev ..
# Exec mode, no agent: the document in NP_ACTION_CONTEXT, the answer on stdout.
docker run --rm --network none -e NP_AGENT_PLUGIN= -e NP_ACTION_CONTEXT='{"notification":{…}}' s3-worker:dev
```
