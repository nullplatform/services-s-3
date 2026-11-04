################################################################################
# aws-s3-bucket — installation, platform plane
#
# What the service needs once per installation on the platform side. For this
# service that is the agent channel only; the cloud side (the role the worker
# assumes, per account) is target/, instantiated once per account by the
# caller with the right AWS provider.
################################################################################

locals {
  installation_suffix = substr(replace(var.installation.id, "-", ""), 0, 8)
}

resource "nullplatform_notification_channel" "worker" {
  count = var.create_channel ? 1 : 0

  nrn         = var.installation.nrn
  type        = "agent"
  source      = ["service", "telemetry"]
  description = "${var.installation.package_slug} worker (${local.installation_suffix})" # the API caps it at 64 characters

  configuration {
    agent {
      selector = var.agent_tags
      command {
        type = "package-exec"
        data = {
          package = var.installation.package_slug
          cmdline = "/app/packages/${var.installation.package_slug}/entrypoint"
          environment = jsonencode({
            NP_ACTION_CONTEXT = "'$${NOTIFICATION_CONTEXT}'"
            NP_PLUGIN         = var.installation.package_slug
          })
        }
      }
    }
  }

  filters = jsonencode({
    "$or" = [
      { "service.specification.slug" = { "$eq" = var.installation.package_slug } },
      { "arguments.service_specification.slug" = { "$eq" = var.installation.package_slug } },
    ]
  })
}
