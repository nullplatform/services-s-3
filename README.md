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
│   │   └── requirements/aws/       # OpenTofu module: IAM role the agent assumes for this service
│   ├── workflows/aws/              # Workflow YAMLs (create/update/delete/link/link-update/unlink)
│   ├── scripts/aws/                # build_context, do_tofu, write_service_outputs, write_link_outputs, delete_tfstate_bucket
│   ├── entrypoint/                 # entrypoint/service/link (agent entrypoint)
│   ├── installation/               # OpenTofu module: install the package (nullplatform layer)
│   ├── publish/                    # OpenTofu stack: publishes the package (release workflow only)
│   └── values.yaml                 # Static config (aws_profile for local dev)
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

## Requirements

### nullplatform prerequisites

- An account-level provider exposing `account.region`

### AWS IAM permissions (for the agent role)

The agent executing this service assumes the IAM role defined in [`aws-s3-bucket/specs/requirements/aws/main.tf`](./aws-s3-bucket/specs/requirements/aws/main.tf) (see [Install in your organization](#install-in-your-organization)):

- S3 bucket management (`s3:CreateBucket`, `s3:PutBucketVersioning`, etc.) over `*`
- IAM user management (`iam:CreateUser`, `iam:CreateAccessKey`, `iam:PutUserPolicy`, etc.) over `arn:aws:iam::*:user/np-s3-*` (or `*` for simpler scope)
- S3 tfstate management over `arn:aws:s3:::np-service-*`

### Runtime dependencies

- **OpenTofu 1.11.6** — auto-downloaded to `/tmp/np-tofu-bin/` if not in `PATH`. Version 1.10+ is required for native S3 state locking (`use_lockfile=true`), which avoids the need for a DynamoDB lock table.
- AWS CLI
- `jq`

## Install in your organization

The service is published once as the package `np-aws-s3-bucket` (specification "AWS S3 Bucket"), visible to every organization. You do not copy its specs: you install the package and use it read-only.

How installing a package works, how it coexists with a copy you registered, how to upgrade, and when to fork instead are in the [package installation guide](https://docs.nullplatform.com/docs/packages/install); this section has what is specific to this service.

Installing it touches the same three layers as registering a service yourself, and only the nullplatform layer changes:

| Layer | What | Module |
|---|---|---|
| infrastructure (AWS credentials) | The IAM role the service assumes | [`aws-s3-bucket/specs/requirements/aws`](./aws-s3-bucket/specs/requirements/aws) |
| nullplatform (nullplatform API key) | The installation of the package and the agent channel | tofu-modules' `service_package_installation` |
| bindings | The role under selector `s3` in your IAM provider | your `aws-iam-configuration` provider |

Pick ONE release of this repository (the latest is on its [releases page](https://github.com/nullplatform/services-s-3/releases)) and use its version in both places below: the IAM role is the one the worker of that same release expects.

```hcl
# ── infrastructure layer ─────────────────────────────────────────────
module "s3_requirements" {
  source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/specs/requirements/aws?ref=vX.Y.Z"

  cluster_name   = "my-cluster" # names the role nullplatform_my-cluster_s3_role
  agent_role_arn = module.agent_iam.nullplatform_agent_role_arn
}

# The agent role must be allowed to assume it: add it to the assume_role_arns
# of tofu-modules' infrastructure/aws/iam/agent.
#   assume_role_arns = [..., module.s3_requirements.permissions_role_arn]

# ── nullplatform layer ───────────────────────────────────────────────
# For a service the installation is the whole nullplatform side, channel included.
module "s3" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/service_package_installation?ref=v9.16.0"

  nrn                  = var.nrn
  package_slug         = "np-aws-s3-bucket"
  package_version      = "X.Y.Z" # the same release, without the v
  agent_tags_selectors = { cluster = "runtime" } # must match the agent's TAGS
}
# Keeping channels in a separate bindings layer instead? Use
# nullplatform/package_installation here and service_definition_agent_association
# there, with package_slug = "np-aws-s3-bucket".

# ── bindings layer ───────────────────────────────────────────────────
# One aws-iam-configuration per NRN and dimensions: add the entry to the list
# your IAM provider already has.
#   { selector = "s3", arn = local.s3_requirements.permissions_role_arn }
```

The service assumes the role it finds under selector `s3` in the IAM provider closest to its NRN. To upgrade, move the release in both layers: `ref` of the requirements module and `package_version` of the installation. See tofu-modules' [`service_package_installation`](https://github.com/nullplatform/tofu-modules/tree/main/nullplatform/service_package_installation) for its inputs and outputs.

Prerequisites: an agent whose `TAGS` match the channel's `tags_selectors`, with `public.ecr.aws/nullplatform/*` in `worker.allowedRegistries` and `np-aws-s3-bucket` in its `worker_orchestrated_packages` (the worker then runs with the agent's identity, the one the role trusts), and an AWS cloud provider exposing `account.region` at the NRN or above it.

## How the package is published

Every release publishes a new revision of the package from this repository, in the same run that pushes the worker image ([`.github/workflows/release.yml`](./.github/workflows/release.yml)): the `publish-package` job applies [`aws-s3-bucket/publish`](./aws-s3-bucket/publish), a stack on tofu-modules' `service_package_publish`, which pins this tag's specs and the image by digest. The package version is the release tag, as for the image.

## Important considerations

### Data loss on delete

Deleting the service destroys the bucket. If `force_destroy=false` (default) and the bucket is non-empty, OpenTofu refuses to destroy. Set `force_destroy=true` before deleting if you want the agent to wipe objects.

### Access keys are long-lived

Links use static IAM access keys. Rotate by re-creating the link or manually in the AWS console if needed.

### Bucket name global uniqueness

S3 bucket names are globally unique across all AWS accounts. The combination `np-<service-name>-<bucket_name_suffix>` must be globally unique.

### State locking

OpenTofu uses native S3 lockfile (`use_lockfile=true`). Concurrent `apply` runs are serialized — the second one waits for the lock and then sees the up-to-date state, producing idempotent behavior on retries.
