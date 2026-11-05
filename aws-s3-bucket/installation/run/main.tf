################################################################################
# aws-s3-bucket — installation, the runner root
#
# For installing without a Terraform repository of one's own: what a person
# or `np package install` runs. It configures the providers from the
# environment and calls the account module once (one AWS provider, so one
# account) and the environment module once per dimension set the account
# serves. An organization with its own Terraform calls ../account and
# ../environment directly, with its provider aliases, and does not need this.
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

# Once: the runner's AWS provider is one account, so one role, whatever the
# number of environments it serves.
module "account" {
  source = "../account"

  installation   = var.installation
  name           = var.account.name
  agent_role_arn = var.agent.role_arn
  role_arn       = var.account.role_arn
}

module "environment" {
  source   = "../environment"
  for_each = var.environments

  installation    = var.installation
  name            = each.key
  dimensions      = each.value.dimensions
  role_arn        = module.account.role_arn
  role_from_entry = each.value.role_from_entry
  iam_provider_id = each.value.iam_provider_id
  agent_tags      = coalesce(each.value.agent_tags, var.agent.tags)
  channel_id      = each.value.channel_id
  create_channel  = var.create_channel
}
