# S3 browser API

The backend of the **S3 browser** UI plugin: when a user opens an `aws-s3-bucket` service in the
dashboard, the plugin (sandboxed in the browser, no credentials) asks this service to list the
bucket, read an object's metadata and mint a download link. This service verifies the platform's
plugin call token, resolves the bucket from the nullplatform service, checks the caller's
organization, and reads S3 with its own IAM identity.

```
dashboard ── plugin call token (RS256, 60 s, aud = this host) ──▶ browser-api ──▶ S3 (own role)
                                                                     └──▶ nullplatform API (own API key): GET /service/:id, GET /service_specification/:id
```

## Endpoints

All answers are JSON; `Authorization: Bearer <plugin call token>` on every call.

| Method | Path | Answer |
|---|---|---|
| `GET` | `/services/:serviceId/objects?prefix=&token=&limit=` | `{ bucket, region, prefix, folders[{prefix,name}], objects[{key,name,size,last_modified,storage_class,etag}], next_token, truncated }` |
| `GET` | `/services/:serviceId/objects/meta?key=` | `{ key, size, content_type, last_modified, etag, storage_class, metadata }` |
| `GET` | `/services/:serviceId/objects/download?key=` | `{ key, url, expires_at }` — a presigned GET (default 15 min); the plugin opens it as a link. Never a redirect: the plugin bridge cannot follow one. |
| `PUT` | `/services/:serviceId/objects?key=` body `{ content_base64, content_type? }` | `{ key, size }` — only with `ALLOW_WRITES=1`, up to `MAX_UPLOAD_BYTES` |
| `DELETE` | `/services/:serviceId/objects?key=` | `{ key }` — only with `ALLOW_WRITES=1` |
| `GET` | `/health` | `{ status: "ok" }` |

Errors: `401` no/invalid token, `403` token for another plugin or a service of another
organization (or S3 denied), `400` not an S3 service / bad key, `404` unknown service or key,
`409` bucket not provisioned yet, `405` writes disabled, `413` too big, `502` upstream.

## Authorization model

1. The token must verify against the plugin API's JWKS (`PLUGIN_JWKS_URL`), with `iss` =
   `PLUGIN_TOKEN_ISSUER`, `aud` = `PUBLIC_HOST` and `plugin` = `PLUGIN_SLUG`. The platform only
   mints it for a user for whom the plugin is effectively installed on that NRN.
2. The service named in the path is read with this backend's API key. Its `entity_nrn` must be in
   the token's organization (`org` claim) and its specification slug in `SERVICE_SPECIFICATIONS`.
3. The bucket and region come from the service's attributes (`bucket_name`, `bucket_region`),
   never from the request.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `PUBLIC_HOST` | yes | this backend's host as the plugin manifest declares it (`permissions.http[].host`), e.g. `s3-browser.example.com` |
| `PLUGIN_JWKS_URL` | yes | `https://<plugin api>/.well-known/plugin-jwks.json` |
| `PLUGIN_TOKEN_ISSUER` | no | default `https://ui-plugins.nullplatform.io` |
| `PLUGIN_SLUG` | no | default `s3-browser` |
| `NP_API_KEY` | yes* | an API key with `service:read` and `service-specification:read` in the organization(s) (*or `NP_TOKEN`, a bearer, for local development) |
| `NP_API_URL` | no | default `https://api.nullplatform.com` |
| `AWS_REGION` | no | default region when the service has none; credentials from the default chain (IRSA in the cluster) |
| `SERVICE_SPECIFICATIONS` | no | comma list of accepted specification slugs, a trailing `*` matches a prefix; default `aws-s3-bucket*` (covers `aws-s3-bucket-agent-k8s` and friends) |
| `ALLOW_WRITES` | no | `1` enables PUT and DELETE |
| `MAX_UPLOAD_BYTES` | no | default 5 MiB |
| `DOWNLOAD_TTL_SECONDS` | no | default 900 |
| `ALLOWED_ORIGINS` | no | comma list of dashboard origins for CORS; default `*` (fine: the token is the credential, no cookies) |
| `DEV_TOKEN`, `DEV_ORG`, `DEV_NRN` | no | local development only: accept `Bearer <DEV_TOKEN>` as a fixed identity. Refused in production. |
| `DEV_SERVICES` | no | local development only (needs `DEV_TOKEN`): `<service id>=<bucket>[@region],...` answered from memory, so no platform credentials are needed to browse a bucket of yours |
| `PORT` | no | default 8080 |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | no | serve https directly (local development: the plugin bridge only calls https hosts) |

## IAM

The backend's role needs, on the buckets the S3 service creates (`np-*`):

```json
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::np-*" },
  { "Effect": "Allow", "Action": ["s3:GetObject", "s3:GetObjectAttributes"], "Resource": "arn:aws:s3:::np-*/*" }
] }
```

Add `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::np-*/*` only with `ALLOW_WRITES=1`.

## Run locally

The plugin bridge only calls `https` hosts and a manifest host must be a dotted name, so the
local backend answers as `s3-browser.localhost:8790` (browsers resolve `*.localhost` to loopback)
with a self-signed certificate:

```bash
npm install
mkdir -p .certs && openssl req -x509 -newkey rsa:2048 -nodes -keyout .certs/localhost-key.pem -out .certs/localhost.pem \
  -days 30 -subj "/CN=s3-browser.localhost" -addext "subjectAltName=DNS:s3-browser.localhost,DNS:localhost,IP:127.0.0.1"
PORT=8790 PUBLIC_HOST=s3-browser.localhost:8790 TLS_CERT_FILE=.certs/localhost.pem TLS_KEY_FILE=.certs/localhost-key.pem \
PLUGIN_JWKS_URL=https://localhost:9/unused NP_TOKEN=<your bearer> AWS_PROFILE=… DEV_TOKEN=letmein DEV_ORG=<your org id> npm run dev
```

With `DEV_TOKEN` the harness (`frontend-ui-plugins/apps/harness`) can call it, after the browser
accepts the certificate once (open `https://s3-browser.localhost:8790/health`):

```
http://localhost:4310/?plugin=http://localhost:4306&view=service&service=<service id>&spec=aws-s3-bucket-agent-k8s\
  &http=https://s3-browser.localhost:8790&httpToken=letmein&config={"backend":"https://s3-browser.localhost:8790"}
```

```bash
npm test
```
