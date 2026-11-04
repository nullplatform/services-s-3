################################################################################
# aws-s3-bucket — installation
#
# One root module for everything the service needs in an organization, cloud
# and platform at once. Every requirement is a parameter or is provisioned
# here when the parameter is absent (variables.tf). Ownership rules:
#   - cloud providers are read by lib/context, never written;
#   - what is created here is owned, and uninstall removes it;
#   - what is found is adopted: an existing IAM provider only gets this
#     package's entry, never a rewrite of the provider.
################################################################################

locals {
  # A short, stable suffix that keeps two installations of this package in one
  # account apart (resource names are account-global).
  installation_suffix = substr(replace(var.installation.id, "-", ""), 0, 8)

  targets_creating_role     = { for key, target in var.targets : key => target if target.role_arn == null }
  targets_creating_provider = { for key, target in var.targets : key => target if target.iam_provider_id == null }
  targets_adopting_provider = { for key, target in var.targets : key => target if target.iam_provider_id != null }

  role_arn = {
    for key, target in var.targets :
    key => coalesce(target.role_arn, try(aws_iam_role.s3[key].arn, null))
  }
}

# ── Cloud plane: the role the worker assumes (what specs/requirements/aws is today) ──

resource "aws_iam_role" "s3" {
  for_each = local.targets_creating_role

  name        = "nullplatform-${var.installation.package_slug}-${local.installation_suffix}-${each.key}"
  description = "Permissions role assumed by the nullplatform agent for the ${var.installation.package_slug} package (installation ${var.installation.id}, target ${each.key})"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = var.agent.role_arn }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    ManagedBy    = "nullplatform-package-installation"
    Package      = var.installation.package_slug
    Installation = var.installation.id
    Target       = each.key
  }
}

# Policies grouped by verb, not s3:*, to cover every read the AWS provider does
# when it refreshes a bucket; Resource stays "*" so an organization can narrow it.
resource "aws_iam_role_policy" "s3" {
  for_each = aws_iam_role.s3

  name   = "s3"
  role   = each.value.name
  policy = file("${path.module}/policies/s3.json")
}

# Per-link IAM users and access keys.
resource "aws_iam_role_policy" "s3_iam" {
  for_each = aws_iam_role.s3

  name   = "s3-iam"
  role   = each.value.name
  policy = file("${path.module}/policies/s3-iam.json")
}

# ── Platform plane: register the role where the runtime reads it ──

# A target with no IAM provider for its dimensions gets one, owned by this
# installation and holding only this package's entry.
resource "nullplatform_provider_config" "iam" {
  for_each = local.targets_creating_provider

  nrn        = var.installation.nrn
  type       = "aws-iam-configuration"
  dimensions = each.value.dimensions
  attributes = jsonencode({
    iam_role_arns = {
      arns = [{ selector = "s3", arn = local.role_arn[each.key] }]
    }
  })
}

# A target whose IAM provider already exists (the organization's, or another
# package's) gets exactly one entry added, and removed on destroy. Done with a
# script until the API has an entry endpoint: this resource is the seam where
# a nullplatform_iam_role_entry swaps in.
resource "terraform_data" "iam_role_entry" {
  for_each = local.targets_adopting_provider

  triggers_replace = {
    provider_id = each.value.iam_provider_id
    selector    = "s3"
    arn         = local.role_arn[each.key]
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/iam_role_entry upsert '${self.triggers_replace.provider_id}' '${self.triggers_replace.selector}' '${self.triggers_replace.arn}'"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "${path.module}/scripts/iam_role_entry remove '${self.triggers_replace.provider_id}' '${self.triggers_replace.selector}'"
  }
}

# ── The agent channel: package-exec to the package worker ──

resource "nullplatform_notification_channel" "worker" {
  count = var.create_channel ? 1 : 0

  nrn    = var.installation.nrn
  type   = "agent"
  source = ["service", "telemetry"]
  # The API caps descriptions at 64 characters.
  description = "${var.installation.package_slug} worker (${local.installation_suffix})"

  configuration {
    agent {
      selector = var.agent.tags
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
