# AWS S3 Service

Nullplatform **dependency service** that provisions and manages an Amazon S3 bucket on AWS. Each application link creates a dedicated IAM principal with scoped S3 permissions: by default an IAM user + access key, so apps authenticate with standard AWS credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`); or, with `credentials: role`, an IAM role with no static key that only the configured trusted role, the S3 browser worker's, can assume.

The service lives under [`aws-s3-bucket/`](./aws-s3-bucket) to keep the repo open for future S3-related services.

## What It Does

- Provisions an S3 bucket via OpenTofu (versioning, server-side encryption, public access block, optional server access logs to a separate bucket)
- Creates a dedicated IAM user (or, for role links, an IAM role) per link with an inline policy scoped to the bucket (and optional path prefix)
- Exposes `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` per access-key link (each linked app gets its own IAM user), or `ROLE_ARN` per role link, plus `BUCKET_NAME` / `BUCKET_ARN` / `BUCKET_REGION` from the service itself
- Stores per-instance OpenTofu state in a dedicated bucket (`np-service-<SERVICE_ID>`) with native S3 locking (`use_lockfile=true`)

## Repository Layout

```
.
├── aws-s3-bucket/
│   ├── specs/
│   │   ├── service-spec.json.tpl   # Service schema (attributes user sees)
│   │   └── links/connect.json.tpl  # Link schema (access_level, path_prefix, credentials)
│   ├── deployment/                 # OpenTofu module: S3 bucket + versioning + encryption
│   ├── permissions/                # OpenTofu module: IAM user or role + scoped policy (per link)
│   ├── specs/requirements/aws/     # OpenTofu module: IAM policies the agent role needs
│   ├── workflows/aws/              # Workflow YAMLs (create/update/delete/link/link-update/unlink)
│   ├── scripts/aws/                # build_context, do_tofu, write_service_outputs, write_link_outputs, delete_tfstate_bucket
│   ├── entrypoint/                 # entrypoint/service/link (agent entrypoint)
│   └── values.yaml                 # Static config (aws_profile for local dev, link role trust and boundary)
├── worker/                         # The image's worker: runs the entrypoint above, and the S3 browser (worker/README.md)
├── Dockerfile                      # services/s3 image: worker-bridge's runtime + aws/gomplate/tofu + the worker
└── README.md
```

The image's worker answers catalog executions of the `s3_browser` specification itself (the S3 browser, with each link's own keys or role) and runs `aws-s3-bucket/entrypoint/entrypoint` for everything else, exactly as worker-bridge did: see [`worker/README.md`](./worker/README.md).

## Service Configuration Parameters

Exposed in the nullplatform UI when creating/updating the service:

| Parameter | Type | Default | Allowed Values | Editable After Create |
|---|---|---|---|---|
| `bucket_name_suffix` | string | — | lowercase alphanumeric + `-`, 3–40 chars; not `logs` nor ending in `-logs` | No |
| `versioning` | bool | `true` | | Yes |
| `encryption` | string | `AES256` | `AES256`, `aws:kms` | Yes |
| `public_access_block` | bool | `true` | | Yes |
| `force_destroy` | bool | `false` | | Yes |
| `access_logs` | bool | `false` | | Yes |

**Versioning and public access block are always on**: the workflow applies `true` even when `versioning` or `public_access_block` is `false`, as it always has. Every existing bucket was deployed that way, so honoring `false` would suspend versioning or remove the public access block on a service's next update; that change needs its own release.

**Bucket naming**: `np-<sanitized-service-name>-<bucket_name_suffix>` (computed once on first create, then persisted — immutable to prevent accidental replacement on service rename).

## Link Parameters (`connect`)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `access_level` | enum | `read-write` | `read`, `write`, `read-write` |
| `path_prefix` | string | `""` | Scope IAM permissions to a key prefix (empty = full bucket) |
| `credentials` | enum | `access-key` | `access-key` (IAM user + static key) or `role` (IAM role, no static key; for the S3 browser). Set on create only |

## Service Attributes (post-create, exported as env vars)

| Attribute | Description |
|---|---|
| `bucket_name` | S3 bucket name |
| `bucket_arn` | S3 bucket ARN |
| `bucket_region` | AWS region |
| `access_logs_bucket` | Bucket receiving the access logs (empty while `access_logs` is off). Not exported as an env var: apps have no access to it |

## Link Attributes (per link, exported as env vars)

Only credentials are exposed at the link level — bucket identity (name / ARN / region) comes from the service attributes above to avoid duplicate env vars in linked apps.

| Attribute | Env Var Type | Description |
|---|---|---|
| `aws_access_key_id` | plain | IAM user access key ID (access-key links) |
| `aws_secret_access_key` | secret | IAM user secret access key (access-key links) |
| `role_arn` | plain | IAM role to assume (role links) |

## Workflows

| Workflow | Trigger | What It Does |
|---|---|---|
| `create` | Service created | Creates bucket, versioning, encryption, public access block |
| `update` | Service updated | Re-applies terraform with updated attributes |
| `delete` | Service deleted | Destroys bucket (needs `force_destroy=true` if non-empty) and tfstate bucket |
| `link` | Application linked | Creates the IAM user + access key (or the IAM role) scoped to the bucket and access level |
| `link-update` | Link updated | In-place update of the user or role policy (access_level or path_prefix changes). Credentials are preserved. |
| `unlink` | Application unlinked | Destroys the IAM user and access key (or the IAM role) |

## Requirements

### nullplatform prerequisites

- An account-level provider exposing `account.region`

### AWS IAM permissions (for the agent role)

The agent executing this service needs the IAM policies defined in [`aws-s3-bucket/specs/requirements/aws/main.tf`](./aws-s3-bucket/specs/requirements/aws/main.tf):

- S3 bucket management (`s3:CreateBucket`, `s3:PutBucketVersioning`, etc.) over `*`. The `s3:Put*` / `s3:Get*` / `s3:Delete*` groups also cover the access logs bucket (logging, ownership controls, lifecycle, bucket policy); its name starts with `np-` like the data bucket, so a stack that narrows the resource to `arn:aws:s3:::np-*` still covers it
- IAM user management (`iam:CreateUser`, `iam:CreateAccessKey`, `iam:PutUserPolicy`, etc.) over `arn:aws:iam::*:user/np-s3-????????????????` (link users only: `np-s3-` + 16 characters)
- IAM role management for role links (`iam:CreateRole`, `iam:PutRolePolicy`, `iam:UpdateAssumeRolePolicy`, etc.) over `arn:aws:iam::*:role/np-s3-????????????????`, and an explicit Deny on removing the permissions boundary of `np-s3-*` users and roles
- S3 tfstate management over `arn:aws:s3:::np-service-*`

### Runtime dependencies

- **OpenTofu 1.11.6** — auto-downloaded to `/tmp/np-tofu-bin/` if not in `PATH`. Version 1.10+ is required for native S3 state locking (`use_lockfile=true`), which avoids the need for a DynamoDB lock table.
- AWS CLI
- `jq`

## How to register this service in nullplatform

Use the [`nullplatform/service_definition`](https://github.com/nullplatform/tofu-modules/tree/main/nullplatform/service_definition) and [`nullplatform/service_definition_agent_association`](https://github.com/nullplatform/tofu-modules/tree/main/nullplatform/service_definition_agent_association) modules. Example:

```hcl
module "service_definition_aws_s3_bucket" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/service_definition?ref=v1.51.0"
  nrn    = var.nrn

  git_provider      = "github"
  repository_org    = "nullplatform"
  repository_name   = "services-s-3"
  repository_branch = "main"
  service_path      = "aws-s3-bucket"

  service_name = "AWS S3 Bucket"
}

module "service_definition_channel_association_aws_s3_bucket" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/service_definition_agent_association?ref=v1.51.0"

  nrn                          = var.nrn
  api_key                      = module.service_notification_api_key.api_key
  tags_selectors               = var.tags_selectors
  service_specification_slug   = module.service_definition_aws_s3_bucket.service_specification_slug
  repository_service_spec_repo = "nullplatform/services-s-3"
  service_path                 = "aws-s3-bucket"
}
```

## Important considerations

### Data loss on delete

Deleting the service destroys the bucket. If `force_destroy=false` (default) and the bucket is non-empty, OpenTofu refuses to destroy. Set `force_destroy=true` before deleting if you want the agent to wipe objects.

### Access logs

With `access_logs: true`, S3 server access logging records every request to the bucket: the requester (IAM user, or role and session name, such as `s3-browser-<execution id>` for role links), the operation, the object key, the time and the result. The logs go to a separate bucket `<bucket_name>-logs` (when that exceeds 63 characters, the name is cut and an 8-char hash of the bucket name is added; it always keeps the `np-` prefix), under the `access/` prefix. That bucket blocks public access, uses SSE-S3 (S3 does not deliver access logs to SSE-KMS buckets, so it is AES256 even when `encryption` is `aws:kms`), disables ACLs (`BucketOwnerEnforced`), only lets `logging.s3.amazonaws.com` write logs for this bucket and account, and expires logs after 90 days (`access_logs_retention_days` in the deployment module).

Requests to the logs bucket without TLS are denied (log delivery, made by the S3 service principal, is exempt). Delivery is best effort and arrives minutes to hours after the request. Turning `access_logs` off, or deleting the service, deletes the logs bucket with its logs whatever `force_destroy` says: the logs bucket is never empty (even OpenTofu's own reads get logged), so it always has `force_destroy=true`.

Bucket names ending in `-logs` are reserved for logs buckets, so a new service whose bucket name would end in `-logs` (`bucket_name_suffix` `logs` or ending in `-logs`) fails on create. Services created before this rule keep their name; if one ends in `-logs`, it can match the logs bucket of a service whose bucket name is the same without `-logs`.

### Access keys are long-lived

Access-key links use static IAM access keys. Rotate by re-creating the link or manually in the AWS console if needed. Role links have no static key.

### Role links

A link created with `credentials: role` gets an IAM role `np-s3-<first 16 hex chars of the link id>` with the same bucket policy an access-key link's user would get, and no access key. Its trust policy allows `sts:AssumeRole` only to the exact role ARNs configured on the agent, comma-separated, in `LINK_ROLE_TRUSTED_PRINCIPALS` (env) or `link_role_trusted_principals` (`values.yaml`); account roots and IAM users are rejected, and creating or updating a role link fails while the list is empty (unlink does not need it). Access-key links ignore the list. Sessions last at most one hour. The link exposes the role as `role_arn`.

The list is one for the whole service, not per link: every principal on it can assume every role link's role, for every bucket and application. Role names derive from link ids and `role_arn` is exported to the app, so the ARNs are not secret. Put only the S3 browser worker's role on the list, never an application's workload role; giving each app its own trust would need a per-link list, which this service does not have.

An optional permissions boundary (`LINK_PERMISSIONS_BOUNDARY_ARN` or `link_permissions_boundary_arn`) is set on every link user and role at creation. Links created before it was set keep no boundary (the module ignores later boundary changes), and the requirements policy denies removing one.

`credentials` cannot be changed after the link is created: an update that asks for the other mode fails before anything is applied, and update/unlink take the mode from what the link stores (its role or its user). Re-create the link to switch.

### Bucket name global uniqueness

S3 bucket names are globally unique across all AWS accounts. The combination `np-<service-name>-<bucket_name_suffix>` must be globally unique.

### State locking

OpenTofu uses native S3 lockfile (`use_lockfile=true`). Concurrent `apply` runs are serialized — the second one waits for the lock and then sees the up-to-date state, producing idempotent behavior on retries.
