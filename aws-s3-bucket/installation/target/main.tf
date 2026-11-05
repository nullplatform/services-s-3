################################################################################
# aws-s3-bucket — installation, one target (one AWS account)
#
# Everything the service needs in an organization is per account: the role
# the worker assumes (what specs/requirements/aws is today), registered where
# the runtime reads it, and the agent channel, since the agent is per
# account. There is no platform-side module: a service has no scope type,
# settings or schema of its own. Ownership rules:
#   - what is created here is owned, and destroy removes it;
#   - what the caller names is reused: an IAM provider only gets this
#     package's entry, never a rewrite; a channel is left alone.
################################################################################

locals {
  installation_suffix = substr(replace(var.installation.id, "-", ""), 0, 8)
  role_arn            = coalesce(var.role_arn, try(aws_iam_role.s3[0].arn, null))

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

# ── The role the worker assumes ──

resource "aws_iam_role" "s3" {
  count = var.role_arn == null ? 1 : 0

  name        = "nullplatform-${var.installation.package_slug}-${local.installation_suffix}-${var.name}"
  description = "Permissions role assumed by the nullplatform agent for the ${var.installation.package_slug} package (installation ${var.installation.id}, target ${var.name})"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = var.agent_role_arn }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    ManagedBy    = "nullplatform-package-installation"
    Package      = var.installation.package_slug
    Installation = var.installation.id
    Target       = var.name
  }
}

# Policies grouped by verb, not s3:*, to cover every read the AWS provider does
# when it refreshes a bucket; Resource stays "*" so an organization can narrow it.
resource "aws_iam_role_policy" "s3" {
  count  = var.role_arn == null ? 1 : 0
  name   = "s3"
  role   = aws_iam_role.s3[0].name
  policy = file("${path.module}/policies/s3.json")
}

# Per-link IAM users and access keys.
resource "aws_iam_role_policy" "s3_iam" {
  count  = var.role_arn == null ? 1 : 0
  name   = "s3-iam"
  role   = aws_iam_role.s3[0].name
  policy = file("${path.module}/policies/s3-iam.json")
}

# ── Where the runtime reads it ──

# A target with no IAM provider gets one, owned here, holding only this entry.
resource "nullplatform_provider_config" "iam" {
  count = var.iam_provider_id == null ? 1 : 0

  nrn        = var.installation.nrn
  type       = "aws-iam-configuration"
  dimensions = var.dimensions
  attributes = jsonencode({
    iam_role_arns = { arns = [{ selector = "s3", arn = local.role_arn }] }
  })
}

# An existing IAM provider gets exactly one entry added, removed on destroy.
# Script until the API has an entry endpoint; a nullplatform_iam_role_entry
# resource would swap in here. Values reach the script through its
# environment, never interpolated into the shell line.
resource "terraform_data" "iam_role_entry" {
  count = var.iam_provider_id == null ? 0 : 1

  triggers_replace = {
    provider_id = var.iam_provider_id
    selector    = "s3"
    arn         = local.role_arn
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

# ── The agent channel: package-exec to the agent of this account ──
# One per target: it selects that agent by its tags and, when the target has
# dimensions, routes only the services in them.

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
