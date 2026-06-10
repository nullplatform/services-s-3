# AWS S3 Service

Nullplatform **dependency service** that provisions and manages an Amazon S3 bucket on AWS. Each application link creates a dedicated IAM user + access key with scoped S3 permissions, so apps authenticate with standard AWS credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`).

The service lives under [`aws-s3-bucket/`](./aws-s3-bucket) to keep the repo open for future S3-related services.

## What It Does

- Provisions an S3 bucket via OpenTofu (versioning, server-side encryption, public access block)
- Creates a dedicated IAM user per link with an inline policy scoped to the bucket (and optional path prefix)
- Exposes `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` per link (each linked app gets its own IAM user) plus `BUCKET_NAME` / `BUCKET_ARN` / `BUCKET_REGION` from the service itself
- Stores per-instance OpenTofu state in a dedicated bucket (`np-service-<SERVICE_ID>`) with native S3 locking (`use_lockfile=true`)

## Repository Layout

```
.
├── aws-s3-bucket/
│   ├── specs/
│   │   ├── service-spec.json.tpl   # Service schema (attributes user sees)
│   │   └── links/connect.json.tpl  # Link schema (access_level, path_prefix, credentials)
│   ├── deployment/                 # OpenTofu module: S3 bucket + versioning + encryption
│   ├── permissions/                # OpenTofu module: IAM user + access key + scoped policy (per link)
│   ├── requirements/               # OpenTofu module: IAM policies the agent role needs
│   ├── workflows/aws/              # Workflow YAMLs (create/update/delete/link/link-update/unlink)
│   ├── scripts/aws/                # build_context, do_tofu, write_service_outputs, write_link_outputs, delete_tfstate_bucket, assume_role, assume_role_lib (+ test/)
│   ├── entrypoint/                 # entrypoint/service/link (agent entrypoint)
│   └── values.yaml                 # Static config (aws_profile, assume_role_selector, assume_role_arn)
└── README.md
```

## Service Configuration Parameters

Exposed in the nullplatform UI when creating/updating the service:

| Parameter | Type | Default | Allowed Values | Editable After Create |
|---|---|---|---|---|
| `bucket_name_suffix` | string | — | lowercase alphanumeric + `-`, 3–40 chars | No |
| `versioning` | bool | `true` | | Yes |
| `encryption` | string | `AES256` | `AES256`, `aws:kms` | Yes |
| `public_access_block` | bool | `true` | | Yes |
| `force_destroy` | bool | `false` | | Yes |

**Bucket naming**: `np-<sanitized-service-name>-<bucket_name_suffix>` (computed once on first create, then persisted — immutable to prevent accidental replacement on service rename).

## Link Parameters (`connect`)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `access_level` | enum | `read-write` | `read`, `write`, `read-write` |
| `path_prefix` | string | `""` | Scope IAM permissions to a key prefix (empty = full bucket) |

## Service Attributes (post-create, exported as env vars)

| Attribute | Description |
|---|---|
| `bucket_name` | S3 bucket name |
| `bucket_arn` | S3 bucket ARN |
| `bucket_region` | AWS region |

## Link Attributes (per link, exported as env vars)

Only credentials are exposed at the link level — bucket identity (name / ARN / region) comes from the service attributes above to avoid duplicate env vars in linked apps.

| Attribute | Env Var Type | Description |
|---|---|---|
| `aws_access_key_id` | plain | IAM user access key ID |
| `aws_secret_access_key` | secret | IAM user secret access key |

## Workflows

| Workflow | Trigger | What It Does |
|---|---|---|
| `create` | Service created | Creates bucket, versioning, encryption, public access block |
| `update` | Service updated | Re-applies terraform with updated attributes |
| `delete` | Service deleted | Destroys bucket (needs `force_destroy=true` if non-empty) and tfstate bucket |
| `link` | Application linked | Creates IAM user + access key scoped to the bucket and access level |
| `link-update` | Link updated | In-place update of the IAM user policy (access_level or path_prefix changes). Credentials are preserved. |
| `unlink` | Application unlinked | Destroys the IAM user and access key |

## Agent AWS Authentication

The agent resolves the IAM role ARN to assume using the following **order of precedence**, then either assumes that role or falls back to IRSA:

1. `ASSUME_ROLE_ARN` already set in the environment (explicit override).
2. The **"AWS IAM" provider** (category *Identity & Access Control*) declared in nullplatform — matched by selector. *(preferred)*
3. `assume_role_arn` in `values.yaml` (static fallback / local testing).
4. None of the above → the pod's **IRSA** identity is used directly.

### Provider-based assume role (preferred)

Declare an **"AWS IAM" provider** (specification `aws-iam-configuration`) at the account level in nullplatform. Its `iam_role_arns.arns` is a list of `{selector, arn}` pairs, so a single provider holds the role ARNs for every service/scope in the account:

| selector | arn |
|---|---|
| `aws-s3-bucket` | `arn:aws:iam::<account-id>:role/<s3-role>` |
| `lambda` | `arn:aws:iam::<account-id>:role/<lambda-role>` |

The agent looks the provider up at the account NRN, then picks the ARN whose `selector` matches `assume_role_selector` from `values.yaml` (default: the service slug, `aws-s3-bucket`). It then calls `sts:AssumeRole` with its IRSA identity and uses the resulting temporary credentials for all subsequent AWS calls (CLI + Terraform).

```yaml
# values.yaml — selector to match in the IAM provider (empty -> service slug)
assume_role_selector: "aws-s3-bucket"
```

This is the right choice when the bucket lives in a **different account** than the agent (cross-account) or you want a **dedicated role per service type** rather than granting all permissions to the agent's base role — without committing any account-specific ARN to the repo.

### IRSA (default)

With no provider entry for the selector and `assume_role_arn` empty, the agent pod's IRSA role is used directly for all AWS calls. This is the right choice when the IRSA role already has the required S3 and IAM permissions in the target account.

### Static `assume_role_arn` (fallback)

For local testing or single-account back-compat, set `assume_role_arn` in `values.yaml` directly. It is used only when the provider yields no ARN for the selector.

```yaml
# values.yaml
assume_role_arn: "arn:aws:iam::123456789012:role/np-s3-creator-role"
```

### Trust policy

However the ARN is resolved, the target role must have a trust policy that allows the agent's IRSA role to assume it:

```json
{
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::<AGENT_ACCOUNT>:role/<IRSA_ROLE_NAME>"
  },
  "Action": "sts:AssumeRole"
}
```

The target role needs the same IAM permissions as listed in the [AWS IAM permissions](#aws-iam-permissions-for-the-agent-role) section below.

Once an ARN is resolved (from the provider or `assume_role_arn`), a failing `sts:AssumeRole` call (wrong ARN, missing trust policy, insufficient permissions) makes the workflow **abort immediately** — it does not fall back to the IRSA credentials. The IRSA fallback only applies when no ARN is resolved at all.

#### Credential isolation before assume role

Link actions (`link` / `link-update` / `unlink`) run `build_permissions_context`, which **unsets any AWS credentials inherited from earlier steps** (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`) before sourcing `assume_role`. This is deliberate: without it, `sts:AssumeRole` would be called using *already-assumed* temporary credentials instead of the pod's IRSA identity, which fails as a self-assume (the assumed role is usually not trusted to assume itself). Clearing the environment first guarantees the assume-role call always starts from the IRSA identity, whether or not a previous step had already assumed the role.

> **Note for overrides:** `values.yaml` ships with `assume_role_arn` empty so the published service stays account-agnostic. Prefer declaring the per-account ARNs in the **"AWS IAM" provider** (account-specific data stays in nullplatform, not the repo). The static `assume_role_arn` remains available per deployment via the `--overrides-path` mechanism for local testing or environments without the provider.

## Requirements

### nullplatform prerequisites

- An account-level provider exposing `account.region`

### AWS IAM permissions (for the agent role)

The agent executing this service (its IRSA role, or the `assume_role_arn` target) needs the three IAM policies defined in [`aws-s3-bucket/requirements/main.tf`](./aws-s3-bucket/requirements/main.tf). The `requirements/` module can also create the role itself (`create_role = true`) with a trust policy for `trusted_arns`.

| Policy | Purpose | Resource scope |
|---|---|---|
| `nullplatform_<name>_s3_policy` | Create / configure / delete the user-facing S3 buckets | `*` |
| `nullplatform_<name>_s3_iam_policy` | Manage the per-link IAM users + access keys | `arn:aws:iam::*:user/np-s3-*` |
| `nullplatform_<name>_s3_tfstate_policy` | Manage the per-service OpenTofu state buckets | `arn:aws:s3:::np-service-*` (+ `/*`) |

**Why so many `s3:Get*` read actions?** The AWS Terraform provider refreshes the *full* configuration of every managed bucket on each `plan`/`apply` (versioning, encryption, replication, public-access block, ACL, ownership, logging, lifecycle, CORS, website, etc.). Each of those reads maps to a distinct IAM action — e.g. `s3:GetEncryptionConfiguration`, `s3:GetReplicationConfiguration`, `s3:GetBucketPublicAccessBlock`. Missing any one of them makes the provider fail the refresh even when the bucket itself is fine, so the bucket-management policy grants the complete read set alongside the `Create`/`Put`/`Delete` actions.

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

### Access keys are long-lived

Links use static IAM access keys. Rotate by re-creating the link or manually in the AWS console if needed.

### Bucket name global uniqueness

S3 bucket names are globally unique across all AWS accounts. The combination `np-<service-name>-<bucket_name_suffix>` must be globally unique.

### State locking

OpenTofu uses native S3 lockfile (`use_lockfile=true`). Concurrent `apply` runs are serialized — the second one waits for the lock and then sees the up-to-date state, producing idempotent behavior on retries.
