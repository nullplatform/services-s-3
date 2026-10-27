# aws-s3-bucket installation

OpenTofu module that installs the `nullplatform-aws-s3-bucket` package (specification "nullplatform AWS S3 Bucket") in your organization. The package is published once for every organization; this module does not copy it. It creates:

1. The IAM permissions role the service's workflows assume, in the AWS account your provider credentials point to ([`../specs/requirements/aws`](../specs/requirements/aws)).
2. The installation of the package at `nrn`, at the version of the tag you reference.
3. The agent notification channel that routes the service's actions to the package worker.

## Usage

```hcl
terraform {
  required_providers {
    aws          = { source = "hashicorp/aws", version = ">= 5.0" }
    nullplatform = { source = "nullplatform/nullplatform", version = ">= 0.0.110" }
  }
}

# AWS credentials come from the environment (profile, SSO or role); nullplatform
# from NULLPLATFORM_API_KEY, a key with package:create at the NRN.
provider "aws" {
  region = "us-east-1"
}
provider "nullplatform" {}

locals {
  nrn = "organization=123:account=456"
}

# 1. Install the service: IAM role, installation of the global package, agent channel.
module "s3_service" {
  source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation?ref=v0.5.6"

  nrn                  = local.nrn
  cluster_name         = "my-cluster"            # names the role nullplatform_my-cluster_s3_role
  agent_tags_selectors = { cluster = "runtime" } # must match the agent's TAGS
}

# 2. Register the role in the NRN's AWS IAM provider, under the selector the
#    service looks up ("s3"). One aws-iam-configuration per NRN and dimensions:
#    if you already have one, add this entry to its list instead.
resource "nullplatform_provider_config" "aws_iam" {
  nrn  = local.nrn
  type = "aws-iam-configuration"
  attributes = jsonencode({
    iam_role_arns = {
      arns = [
        { selector = "s3", arn = module.s3_service.permissions_role_arn },
      ]
    }
  })
}

output "s3_installed_version" {
  value = module.s3_service.installed_version
}
```

Step 2 is yours, not the module's: the service assumes the role it finds under selector `s3` in the NRN's `aws-iam-configuration` provider, and that provider belongs to your stack and is shared with other services.

**Upgrade**: move `ref` to a newer tag and apply. New services are born with the new version; existing services keep theirs until they are moved one by one.

Already registered this service with `service_definition`? Both can live in one organization: see [Already registered with `service_definition`?](../../README.md#already-registered-with-service_definition).

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
