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
#   2. the installation of the package at var.nrn (nullplatform);
#   3. the agent notification channel routing the service's actions to the
#      package worker (nullplatform).
#
# The role ARN is an output: add it to your AWS IAM provider with selector "s3".
# That provider belongs to your own stack and its ARN list is shared with other
# services, so this module does not write it.
################################################################################

locals {
  package_slug = "aws-s3-bucket"
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

# 2. The package, found by where it is visible (it is owned by the publisher
#    organization, not yours), installed at the version of this module's tag.
data "nullplatform_package" "this" {
  visible_at = var.nrn
  slug       = local.package_slug
  version    = local.version
}

resource "nullplatform_package_installation" "this" {
  nrn                 = var.nrn
  package_id          = data.nullplatform_package.this.id
  default_revision_id = data.nullplatform_package.this.revision_id
  visible_to          = var.visible_to
}

# 3. Agent channel: package-exec to the package worker, filtered to this
#    service's specification.
module "agent_channel" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/service_definition_agent_association?ref=v9.4.0"

  nrn                        = var.nrn
  description                = "aws-s3-bucket package worker"
  tags_selectors             = var.agent_tags_selectors
  channel_sources            = ["service", "telemetry"]
  service_specification_slug = local.package_slug
  worker_orchestrator        = true
  package_slug               = local.package_slug

  # The channel is useless until the specification is reachable at var.nrn.
  depends_on = [nullplatform_package_installation.this]
}
