################################################################################
# aws-s3-bucket — installation, one target (one AWS account)
#
# The cloud side of the installation for one account: the role the worker
# assumes (what specs/requirements/aws is today), registered where the runtime
# reads it. Ownership rules:
#   - what is created here is owned, and destroy removes it;
#   - an IAM provider the caller names is adopted: it only gets this package's
#     entry, never a rewrite.
################################################################################

locals {
  installation_suffix = substr(replace(var.installation.id, "-", ""), 0, 8)
  role_arn            = coalesce(var.role_arn, try(aws_iam_role.s3[0].arn, null))
}

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
