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
├── version.txt                     # Package version, bumped by release-please
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

The service is published once as the package `nullplatform-aws-s3-bucket` (specification "nullplatform AWS S3 Bucket"), visible to every organization. You do not copy its specs: you install the package and use it read-only.

Installing it touches the same three layers as registering a service yourself, and only the nullplatform layer changes:

| Layer | What | Module |
|---|---|---|
| infrastructure (AWS credentials) | The IAM role the service assumes | [`aws-s3-bucket/specs/requirements/aws`](./aws-s3-bucket/specs/requirements/aws) |
| nullplatform (nullplatform API key) | The installation of the package, at the version of the tag | [`aws-s3-bucket/installation`](./aws-s3-bucket/installation) |
| bindings | The agent channel, and the role under selector `s3` in your IAM provider | tofu-modules' `service_definition_agent_association`, your `aws-iam-configuration` provider |

Reference both modules of this repository at the same release tag:

```hcl
# ── infrastructure layer ─────────────────────────────────────────────
module "s3_requirements" {
  source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/specs/requirements/aws?ref=v0.5.6"

  cluster_name   = "my-cluster" # names the role nullplatform_my-cluster_s3_role
  agent_role_arn = module.agent_iam.nullplatform_agent_role_arn
}

# The agent role must be allowed to assume it: add it to the assume_role_arns
# of tofu-modules' infrastructure/aws/iam/agent.
#   assume_role_arns = [..., module.s3_requirements.permissions_role_arn]

# ── nullplatform layer ───────────────────────────────────────────────
module "s3" {
  source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation?ref=v0.5.6"

  nrn = var.nrn
}

# ── bindings layer ───────────────────────────────────────────────────
# s3_requirements and s3 come from the other layers (remote state).
module "s3_channel" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/service_definition_agent_association?ref=vX.Y.Z"

  nrn                        = var.nrn
  tags_selectors             = { cluster = "runtime" } # must match the agent's TAGS
  service_specification_slug = local.s3.service_specification_slug
  worker_orchestrator        = true
  package_slug               = local.s3.package_slug
}

# One aws-iam-configuration per NRN and dimensions: add the entry to the list
# your IAM provider already has.
#   { selector = "s3", arn = local.s3_requirements.permissions_role_arn }
```

The service assumes the role it finds under selector `s3` in the IAM provider closest to its NRN. To upgrade, move `ref` to a newer tag in both layers. See [`aws-s3-bucket/installation`](./aws-s3-bucket/installation) for its inputs and outputs.

Prerequisites: an agent whose `TAGS` match the channel's `tags_selectors` and with `public.ecr.aws/nullplatform/*` in `worker.allowedRegistries`, and an AWS cloud provider exposing `account.region` at the NRN or above it.

### Already registered with `service_definition`?

Organizations that registered this service with `service_definition` have their own copy: specification "AWS S3 Bucket" (slug `aws-s3-bucket`) and a channel filtered to that slug. The global package uses other names (`nullplatform-aws-s3-bucket`), so both live side by side in one organization:

- In the nullplatform layer, add the installation module next to your `service_definition`. Its outputs have the same names, so the map your bindings layer reads keeps its shape.
- In the bindings layer, add a channel for the global slug. Your existing channel keeps serving your copy.
- Keep your IAM role: both specifications assume the role under selector `s3`, with the same permissions. The infrastructure layer does not change.
- Existing services stay on your copy (a service cannot move to another specification). Create new services from "nullplatform AWS S3 Bucket", and remove your `service_definition` and its channel once no service uses them.

### Global package or fork?

**Use the global package.** It is the default, and the only way to keep receiving updates: every fix, new feature and security patch arrives as a new release, and you take it by moving `ref`. The specs, the code and how the service is installed stay maintained here. If something is missing or wrong, open an issue or a pull request in this repository, so every organization gets it.

**Fork only when you need to extend the service substantially**: new actions or links, a different specification (attributes, validations), or workflows that behave differently. A fork has real costs:

- **You become the publisher.** You build and register your own image, publish your own package in your organization, and maintain its specs, code and installation.
- **Updates stop arriving.** Upstream fixes reach you only when you merge them into your fork yourself.
- **There is no way back for existing services.** Services created from your fork's specification cannot be moved to the global one.
- **Names must not collide.** Give your fork its own `package_slug` and service specification name (the channel routes by the specification's slug, which comes from its name), and its own IAM role and selector, or your fork and the global package share one worker and one role.

## How the package is published

Every release publishes a new revision of the package from this repository, in the same run that pushes the worker image ([`.github/workflows/release.yml`](./.github/workflows/release.yml)): the `publish-package` job applies [`aws-s3-bucket/publish`](./aws-s3-bucket/publish), which pins this tag's specs and the image by digest. `version.txt` is the package version; release-please bumps it.

## Important considerations

### Data loss on delete

Deleting the service destroys the bucket. If `force_destroy=false` (default) and the bucket is non-empty, OpenTofu refuses to destroy. Set `force_destroy=true` before deleting if you want the agent to wipe objects.

### Access keys are long-lived

Links use static IAM access keys. Rotate by re-creating the link or manually in the AWS console if needed.

### Bucket name global uniqueness

S3 bucket names are globally unique across all AWS accounts. The combination `np-<service-name>-<bucket_name_suffix>` must be globally unique.

### State locking

OpenTofu uses native S3 lockfile (`use_lockfile=true`). Concurrent `apply` runs are serialized — the second one waits for the lock and then sees the up-to-date state, producing idempotent behavior on retries.
