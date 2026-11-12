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
│   ├── specs/requirements/aws/     # OpenTofu module: IAM role the agent assumes for this service
│   ├── workflows/aws/              # Workflow YAMLs (create/update/delete/link/link-update/unlink)
│   ├── scripts/aws/                # build_context, do_tofu, write_service_outputs, write_link_outputs, delete_tfstate_bucket
│   ├── entrypoint/                 # entrypoint/service/link (agent entrypoint)
│   ├── publish/                    # OpenTofu stack: publishes the package (release workflow only)
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

The agent executing this service assumes the IAM role defined in [`aws-s3-bucket/specs/requirements/aws/main.tf`](./aws-s3-bucket/specs/requirements/aws/main.tf) (see [Install in your organization](#install-in-your-organization)):

- S3 bucket management (`s3:CreateBucket`, `s3:PutBucketVersioning`, etc.) over `*`. The `s3:Put*` / `s3:Get*` / `s3:Delete*` groups also cover the access logs bucket (logging, ownership controls, lifecycle, bucket policy); its name starts with `np-` like the data bucket, so a stack that narrows the resource to `arn:aws:s3:::np-*` still covers it
- IAM user management (`iam:CreateUser`, `iam:CreateAccessKey`, `iam:PutUserPolicy`, etc.) over `arn:aws:iam::*:user/np-s3-????????????????` (link users only: `np-s3-` + 16 characters)
- IAM role management for role links (`iam:CreateRole`, `iam:PutRolePolicy`, `iam:UpdateAssumeRolePolicy`, etc.) over `arn:aws:iam::*:role/np-s3-????????????????`, and an explicit Deny on removing the permissions boundary of `np-s3-*` users and roles
- S3 tfstate management over `arn:aws:s3:::np-service-*`

### Runtime dependencies

- **OpenTofu 1.11.6** — auto-downloaded to `/tmp/np-tofu-bin/` if not in `PATH`. Version 1.10+ is required for native S3 state locking (`use_lockfile=true`), which avoids the need for a DynamoDB lock table.
- AWS CLI
- `jq`

## Install in your organization

The service is published once as the package `np-aws-s3-bucket` (specification "AWS S3 Bucket"), visible to every organization. You do not copy its specs: you install the package and use it read-only.

If you need to change the specification, the links, the actions or the workflows themselves, see [the global package, or your own fork](#two-ways-to-run-this-service-the-global-package-or-your-own-fork) below before installing anything.

Installing it touches the same three layers as registering a service yourself, and only the nullplatform layer changes:

| Layer | What | Module |
|---|---|---|
| infrastructure (AWS credentials) | The IAM role the service assumes | [`aws-s3-bucket/specs/requirements/aws`](./aws-s3-bucket/specs/requirements/aws) |
| nullplatform (nullplatform API key) | The installation of the package and the agent channel | tofu-modules' `service_package_installation` |
| bindings | The role under selector `s3` in your IAM provider | your `aws-iam-configuration` provider |

Reference both modules of this repository at the same release tag:

```hcl
# ── infrastructure layer ─────────────────────────────────────────────
module "s3_requirements" {
  source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/specs/requirements/aws?ref=v0.5.8"

  cluster_name   = "my-cluster" # names the role nullplatform_my-cluster_s3_role
  agent_role_arn = module.agent_iam.nullplatform_agent_role_arn
}

# The agent role must be allowed to assume it: add it to the assume_role_arns
# of tofu-modules' infrastructure/aws/iam/agent.
#   assume_role_arns = [..., module.s3_requirements.permissions_role_arn]

# ── nullplatform layer ───────────────────────────────────────────────
# The same module a catalog entry with `install_package` becomes. For a
# service the installation is the whole nullplatform side, channel included.
module "s3" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/service_package_installation?ref=v9.12.0"

  nrn                  = var.nrn
  package_slug         = "np-aws-s3-bucket"
  package_version      = "0.5.6"                  # the release you install; upgrading = moving it
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

Prerequisites: an agent whose `TAGS` match the channel's `tags_selectors` and with `public.ecr.aws/nullplatform/*` in `worker.allowedRegistries`, and an AWS cloud provider exposing `account.region` at the NRN or above it.

### Already registered with `service_definition`?

Organizations that registered this service with `service_definition` have their own copy: specification "AWS S3 Bucket" (slug `aws-s3-bucket`) and a channel filtered to that slug. The global package uses other names (`np-aws-s3-bucket`), so both live side by side in one organization:

- In the nullplatform layer, add the installation (the module above, or a catalog entry with `install_package`) next to your `service_definition`. Its outputs have the same names, so the map your bindings layer reads keeps its shape, and its channel routes only the global slug: your existing channel keeps serving your copy.
- Keep your IAM role: both specifications assume the role under selector `s3`, with the same permissions. The infrastructure layer does not change.
- Existing services stay on your copy (a service cannot move to another specification). Create new services from "AWS S3 Bucket", and remove your `service_definition` and its channel once no service uses them.

### Two ways to run this service: the global package, or your own fork

| | **Global package** (default) | **Your own fork** |
|---|---|---|
| Specs and code | Maintained by nullplatform in this repository | Maintained by you, in your fork |
| What you install | The package `np-aws-s3-bucket`, read-only | A package you publish in your organization, or a registered copy |
| Updates | A new release: move the version | Only when you merge upstream into your fork |
| When | Always, unless you need changes to the specification, the links, the actions or the workflows | Substantial changes: new actions or links, another specification (attributes, validations), workflows that behave differently |

**Use the global package.** It is the only way to keep receiving fixes, features and security patches: each one arrives as a release of this repository and you take it by moving the installed version. The section above is that path; its two forms are the same module:

- From a catalog of `service_definition` entries (tofu-modules): the same entry with an `install_package = { slug = "np-aws-s3-bucket", version = "X.Y.Z" }` block becomes a `service_package_installation`. For a service the installation is the whole nullplatform side, the agent channel included.
- From a root of your own: the module call in the section above, with the same inputs.

If something is missing or wrong, open an issue or a pull request here, so every organization gets it.

**Fork only to change what the service is.** A fork means you become the publisher of a different service: you build its worker image, publish its package in your organization and maintain its specs, code and installation. Step by step:

1. **Fork the repository and give the service its own names.** In [`aws-s3-bucket/publish/main.tf`](./aws-s3-bucket/publish/main.tf): `package_slug` (for example `acme-aws-s3-bucket`), `service_name` ("Acme S3 Bucket") and `service_slug` (`acme-aws-s3-bucket`). The slug must differ from `np-aws-s3-bucket`, and from `aws-s3-bucket` if you also run a copy: agent channels route by the specification slug, so two services with one slug share a worker. Link specifications keep their own slugs; give them yours with `link_slugs` only if they collide inside your organization.
2. **Publish into your organization, not every organization.** In the same file, `visible_to` goes from `["organization=*"]` to `[var.publisher_nrn]`: only the platform organization may publish globally, and your package is yours. Point `image_registry` / `image_repository` ([`aws-s3-bucket/publish/variables.tf`](./aws-s3-bucket/publish/variables.tf)) at your registry.
3. **Set the release workflow's secrets in your fork**: `ARTIFACT_NP_API_KEY` (a key of your organization, allowed to write artifacts, specifications and packages), `AWS_ROLE_ARN_ECR_PUSH`, `PACKAGE_STATE_AWS_ACCOUNT_ID` (with a role named `github-actions-<repository>-package-state` that may write the state bucket) or `AWS_ROLE_ARN_PACKAGE_STATE` (a role named otherwise), `PACKAGE_TFSTATE_BUCKET` and `PACKAGE_TFSTATE_REGION`, plus the `NP_ARTIFACT_NRN` variable. From then on, each release of your fork builds the image, registers it and publishes a revision of your package ([`release.yml`](./.github/workflows/release.yml)), versioned by its release tag.
4. **Install your package the same way as the global one**, with your slug in `install_package` and your own agent channel. The IAM role and its selector can stay `s3` as long as the permissions in [`aws-s3-bucket/specs/requirements/aws`](./aws-s3-bucket/specs/requirements/aws) still fit what your fork does; if they do not, give your fork its own role and selector too.

**Your specs on our image: the shortcut, and why it is risky.** The worker image this repository publishes is a global artifact, so a package of your own may pin it (`lookup = true` with our registry, repository and the digest of one of our releases, as [`aws-s3-bucket/publish/main.tf`](./aws-s3-bucket/publish/main.tf) does) and change only the specs. It saves you the build, and it is the main trade-off to understand before taking it: the code in that image reads the specification it was released with — the attributes the form collects, the actions and their parameters, the link specification and what it exports — so every change to your specs is a divergence the image does not know about, and the next release of ours assumes specs you no longer have. A service behaves as one thing because its specs and its code are released together; that coupling is the reason the global package carries both, and splitting them puts the breakage on your side, at runtime, with nothing in the platform to warn you. Take the shortcut only for changes the image cannot see, such as descriptions, defaults within the same shape, or visibility; anything the workflows read belongs with a forked image.

Without packages, the classic way still works: register your fork as a copy with `service_definition` pointing at your fork's repository and tag.

What a fork costs, before you take it:

- **Updates stop arriving.** Upstream fixes reach you only when you merge them into your fork yourself.
- **There is no way back for existing services.** A service cannot move to another specification: services created from your fork's specification stay on it.
- **You own the operations.** Images, releases, state of the publisher stack and the compatibility of your specs with the agent are yours to keep.

## How the package is published

Every release publishes a new revision of the package from this repository, in the same run that pushes the worker image ([`.github/workflows/release.yml`](./.github/workflows/release.yml)): the `publish-package` job applies [`aws-s3-bucket/publish`](./aws-s3-bucket/publish), which pins this tag's specs and the image by digest. The package version is the release tag, as for the image.

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
