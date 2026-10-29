################################################################################
# aws-s3-bucket — installation into an organization
#
# Everything an organization needs to use the published aws-s3-bucket package,
# kept next to the service so whoever maintains the service also maintains how
# it is installed. Reference it at a release tag:
#
#   source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation?ref=vX.Y.Z"
#
# The tag fixes the installed version: version.txt of that tag is the package
# revision new services are born with. Upgrading = moving the ref.
#
# Creates, in the caller's accounts:
#   1. the IAM permissions role the service's workflows assume (AWS);
#   2. the installation of the package at var.nrn and the agent notification
#      channel routing the service's actions to the package worker
#      (nullplatform, tofu-modules' service_package_installation).
#
# The role ARN is an output: add it to your AWS IAM provider with selector "s3".
# That provider belongs to your own stack and its ARN list is shared with other
# services, so this module does not write it.
################################################################################

locals {
  package_slug = "nullplatform-aws-s3-bucket"
  version      = trimspace(file("${path.module}/../../version.txt"))
}

# 1. IAM permissions role (same module the service has always documented)
module "iam" {
  source = "../specs/requirements/aws"

  cluster_name               = var.cluster_name
  agent_role_arn             = var.agent_role_arn
  additional_agent_role_arns = var.additional_agent_role_arns
  iam_create_role            = var.iam_create_role
  role_name                  = var.iam_role_name
  policies_name_prefix       = var.iam_policies_name_prefix
  iam_resource_tags_json     = var.iam_resource_tags
}

# 2. The package, installed at the version of this module's tag, and its agent
#    channel.
module "package" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/service_package_installation?ref=v9.7.0"

  nrn                  = var.nrn
  package_slug         = local.package_slug
  package_version      = local.version
  visible_to           = var.visible_to
  agent_tags_selectors = var.agent_tags_selectors
}
