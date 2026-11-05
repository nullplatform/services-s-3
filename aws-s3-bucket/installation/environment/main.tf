################################################################################
# aws-s3-bucket — installation, one environment (one dimension set)
#
# What the runtime reads per environment, all on the platform: the IAM
# provider entry naming the account's role and the agent channel. Two
# environments in one account are two instances of this module taking the
# same account/ output. Ownership rules:
#   - what is created here is owned, and destroy removes it;
#   - what the caller names is reused: an IAM provider only gets this
#     package's entry, never a rewrite; a channel is left alone.
################################################################################

locals {
  installation_suffix = substr(replace(var.installation.id, "-", ""), 0, 8)

  create_iam_provider = var.iam_provider_id == null
  write_entry         = var.iam_provider_id != null && !var.role_from_entry

  channel_route = {
    "$or" = [
      { "service.specification.slug" = { "$eq" = var.installation.package_slug } },
      { "arguments.service_specification.slug" = { "$eq" = var.installation.package_slug } },
    ]
  }
  # Encoded in each branch: the two shapes are different object types, which
  # a conditional cannot return as one.
  channel_filters = length(var.dimensions) == 0 ? jsonencode(local.channel_route) : jsonencode({
    "$and" = concat([local.channel_route], [for key, value in var.dimensions : { "service.dimensions.${key}" = { "$eq" = value } }])
  })
}

# ── IAM provider: where the runtime finds the role for these dimensions ──

# An environment with no IAM provider gets one, owned here, holding only this entry.
resource "nullplatform_provider_config" "iam" {
  count = local.create_iam_provider ? 1 : 0

  nrn        = var.installation.nrn
  type       = "aws-iam-configuration"
  dimensions = var.dimensions
  attributes = jsonencode({
    iam_role_arns = { arns = [{ selector = "s3", arn = var.role_arn }] }
  })
}

# An existing IAM provider gets exactly one entry added, removed on destroy.
# Script until the API has an entry endpoint; a nullplatform_iam_role_entry
# resource would swap in here. Values reach the script through its
# environment, never interpolated into the shell line.
resource "terraform_data" "iam_role_entry" {
  count = local.write_entry ? 1 : 0

  triggers_replace = {
    provider_id = var.iam_provider_id
    selector    = "s3"
    arn         = var.role_arn
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/iam_role_entry upsert \"$PROVIDER_ID\" \"$SELECTOR\" \"$ROLE_ARN\""
    environment = {
      PROVIDER_ID = self.triggers_replace.provider_id
      SELECTOR    = self.triggers_replace.selector
      ROLE_ARN    = self.triggers_replace.arn
    }
  }

  provisioner "local-exec" {
    when    = destroy
    command = "${path.module}/scripts/iam_role_entry remove \"$PROVIDER_ID\" \"$SELECTOR\""
    environment = {
      PROVIDER_ID = self.triggers_replace.provider_id
      SELECTOR    = self.triggers_replace.selector
    }
  }
}

# ── The agent channel: package-exec to the agent serving this environment ──
# It selects the agent by its tags and, when the environment has dimensions,
# routes only the services in them.

resource "nullplatform_notification_channel" "worker" {
  count = var.create_channel && var.channel_id == null ? 1 : 0

  nrn         = var.installation.nrn
  type        = "agent"
  source      = ["service", "telemetry"]
  description = "${var.installation.package_slug} worker (${local.installation_suffix}, ${var.name})" # the API caps it at 64 characters

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

  filters = local.channel_filters
}
