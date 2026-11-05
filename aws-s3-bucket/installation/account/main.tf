################################################################################
# aws-s3-bucket — installation, one AWS account
#
# The cloud side of the installation: the role the worker assumes (what
# specs/requirements/aws is today). One instance per account, whatever the
# number of environments the account serves: those are environment/
# instances that register this role where the runtime reads it. Ownership
# rules:
#   - what is created here is owned, and destroy removes it;
#   - a given role is reused and left alone.
################################################################################

locals {
  installation_suffix = substr(replace(var.installation.id, "-", ""), 0, 8)
  role_arn            = coalesce(var.role_arn, try(aws_iam_role.s3[0].arn, null))
  create_role         = var.role_arn == null
}

resource "aws_iam_role" "s3" {
  count = local.create_role ? 1 : 0

  name        = "nullplatform-${var.installation.package_slug}-${local.installation_suffix}-${var.name}"
  description = "Permissions role assumed by the nullplatform agent for the ${var.installation.package_slug} package (installation ${var.installation.id}, account ${var.name})"

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
    Account      = var.name
  }
}

# Policies grouped by verb, not s3:*, to cover every read the AWS provider does
# when it refreshes a bucket; Resource stays "*" so an organization can narrow it.
resource "aws_iam_role_policy" "s3" {
  count  = local.create_role ? 1 : 0
  name   = "s3"
  role   = aws_iam_role.s3[0].name
  policy = file("${path.module}/policies/s3.json")
}

# Per-link IAM users and access keys.
resource "aws_iam_role_policy" "s3_iam" {
  count  = local.create_role ? 1 : 0
  name   = "s3-iam"
  role   = aws_iam_role.s3[0].name
  policy = file("${path.module}/policies/s3-iam.json")
}
