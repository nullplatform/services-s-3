# aws-s3-bucket installation

OpenTofu module that installs the `aws-s3-bucket` package in your organization. The package is published once for every organization; this module does not copy it. It creates:

1. The IAM permissions role the service's workflows assume, in the AWS account your provider credentials point to ([`../specs/requirements/aws`](../specs/requirements/aws)).
2. The installation of the package at `nrn`, at the version of the tag you reference.
3. The agent notification channel that routes the service's actions to the package worker.

## Usage

```hcl
module "s3_service" {
  source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation?ref=v0.5.5"

  nrn                  = "organization=123:account=456"
  cluster_name         = "my-cluster"
  agent_tags_selectors = { cluster = "runtime" }
}
```

After the apply, add `module.s3_service.permissions_role_arn` to your AWS IAM provider with selector `s3`. That provider belongs to your stack and its ARN list is shared with other services, so this module does not write it.

**Upgrade**: move `ref` to a newer tag and apply. New services are born with the new version; existing services keep theirs until they are moved one by one.

Use this module to keep receiving updates. Fork the repository only when you need to extend the service substantially; see [Global package or fork?](../../README.md#global-package-or-fork) for what a fork costs.

## Prerequisites

- **Agent**: running in your cluster with `TAGS` matching `agent_tags_selectors`, and `public.ecr.aws/nullplatform/*` in `worker.allowedRegistries`.
- **Agent IAM role**: allowed to `sts:AssumeRole` the role this module creates (`nullplatform_<cluster_name>_s3_role` by default).
- **Providers**: an AWS cloud provider exposing `account.region`, configured at `nrn` or above it.
- **Credentials for the apply**: AWS credentials that can create IAM roles and policies, and a nullplatform API key (`NULLPLATFORM_API_KEY`) that can install packages and create notification channels at `nrn`.

## Inputs

| Name | Description | Default |
|---|---|---|
| `nrn` | NRN of your organization where the service is installed | required |
| `agent_tags_selectors` | Tags that select the agent (must match its `TAGS`) | required |
| `cluster_name` | Cluster where the agent runs; names the IAM role | required |
| `visible_to` | Where inside your organization the service can be used | `[nrn]` |
| `agent_role_arn` | Agent role trusted by the permissions role | `nullplatform-<cluster_name>-agent-role` |
| `additional_agent_role_arns` | Extra roles allowed to assume the permissions role | `[]` |
| `iam_create_role` | Create the IAM role (false when your stack already has it) | `true` |
| `iam_role_name` | Name of the IAM role | `nullplatform_<cluster_name>_s3_role` |
| `iam_policies_name_prefix` | Prefix of the IAM policy names | `nullplatform_<cluster_name>` |
| `iam_resource_tags` | Tags on every IAM resource | `{}` |

## Outputs

| Name | Description |
|---|---|
| `permissions_role_arn` | Role to add to your AWS IAM provider with selector `s3` |
| `installation_id` | Id of the package installation |
| `installed_version` | Version new services are born with |
| `missing_optional_requirements` | Optional providers the package can use that you have not configured |
| `notification_channel_id` | Id of the agent notification channel |
