################################################################################
# aws-s3-bucket — installation, the runner root
#
# For installing without a Terraform repository of one's own: what a person
# or `np package install` runs. It configures the providers from the
# environment and calls the target module once per dimension set; one AWS
# provider, so one account. An organization with its own Terraform calls
# ../target directly, once per account with its provider alias, and does not
# need this.
################################################################################

terraform {
  required_version = ">= 1.6"

  # No backend: lib/context passes the state file in NP_INSTALL_STATE.
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    nullplatform = {
      source  = "nullplatform/nullplatform"
      version = ">= 0.0.106"
    }
  }
}

# Credentials are the runner's: a profile locally, the agent's role in the
# cluster. IAM is global; the region only matters for the API endpoint.
provider "aws" {
  region = var.aws_region
}

# NULLPLATFORM_API_KEY from the environment.
provider "nullplatform" {}

module "target" {
  source   = "../target"
  for_each = var.targets

  installation    = var.installation
  name            = each.key
  dimensions      = each.value.dimensions
  agent_role_arn  = var.agent.role_arn
  agent_tags      = coalesce(each.value.agent_tags, var.agent.tags)
  role_arn        = each.value.role_arn
  iam_provider_id = each.value.iam_provider_id
  channel_id      = each.value.channel_id
  create_channel  = var.create_channel
}
