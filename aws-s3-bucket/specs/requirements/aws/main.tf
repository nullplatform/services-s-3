################################################################################
# aws-s3-bucket service — assume-role IAM
#
# The service operates AWS (S3 buckets + per-link IAM users + tfstate) via the
# ASSUME-ROLE pattern: this dedicated role holds the permissions and the
# nullplatform agent assumes it (sts:AssumeRole). The consuming stack passes this
# role's ARN to the agent (assume_role_arns) and publishes it to the nullplatform
# AWS IAM provider (selector "s3").
#
# The role trusts the agent role BY NAME (derived default) rather than by a
# module output, so the consuming stack can wire the ARN back into the agent
# without creating a dependency cycle. The agent role name is the conventional
# "nullplatform-{cluster_name}-agent-role".
################################################################################

resource "aws_iam_role" "nullplatform_s3" {
  count = local.iam_create ? 1 : 0

  name        = local.role_name
  description = "Permissions role assumed by the nullplatform agent role for the aws-s3-bucket service"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = concat([local.agent_role_arn], var.additional_agent_role_arns) }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.iam_default_tags
}

# --- S3 bucket management -----------------------------------------------------
# The AWS provider (v6+) refreshes aws_s3_bucket by reading a wide surface of
# bucket attributes (ACL, CORS, Logging, Lifecycle, Replication, etc.).
# Enumerating each s3:Get* action is brittle, so we grant s3:* scoped to the same
# wildcard resource. If a tighter scope is ever needed, narrow the Resource
# (e.g. arn:aws:s3:::np-*) rather than the Action list.
resource "aws_iam_policy" "nullplatform_s3" {
  count = local.iam_create ? 1 : 0

  name        = "${local.policies_name_prefix}_s3_policy"
  description = "Policy for managing S3 buckets provisioned by the aws-s3-bucket service"
  tags        = local.iam_default_tags

  # Actions are enumerated (not s3:*) to avoid a wildcard action. Resource stays
  # "*" on purpose so the consuming stack can restrict it (e.g. arn:aws:s3:::np-*)
  # without changing this module.
  policy = jsonencode({
    "Version" : "2012-10-17",
    "Statement" : [
      {
        "Effect" : "Allow",
        "Action" : [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:HeadBucket",
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketEncryption",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicy",
          "s3:GetBucketTagging",
          "s3:PutBucketVersioning",
          "s3:PutBucketEncryption",
          "s3:PutBucketPublicAccessBlock",
          "s3:PutBucketPolicy",
          "s3:PutBucketTagging",
          "s3:DeleteBucketPolicy",
          "s3:ListBucket",
          "s3:ListBucketVersions",
          "s3:ListAllMyBuckets",
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion"
        ],
        "Resource" : "*"
      }
    ]
  })
}

# --- IAM management (per-link IAM users + access keys) ------------------------
resource "aws_iam_policy" "nullplatform_s3_iam" {
  count = local.iam_create ? 1 : 0

  name        = "${local.policies_name_prefix}_s3_iam_policy"
  description = "Policy for managing per-link IAM users and access keys for S3 bucket access"
  tags        = local.iam_default_tags

  policy = jsonencode({
    "Version" : "2012-10-17",
    "Statement" : [
      {
        "Effect" : "Allow",
        "Action" : [
          "iam:CreateUser",
          "iam:DeleteUser",
          "iam:GetUser",
          "iam:TagUser",
          "iam:UntagUser",
          "iam:ListUserTags",
          "iam:CreateAccessKey",
          "iam:DeleteAccessKey",
          "iam:ListAccessKeys",
          "iam:PutUserPolicy",
          "iam:DeleteUserPolicy",
          "iam:GetUserPolicy",
          "iam:ListUserPolicies",
          "iam:ListAttachedUserPolicies"
        ],
        "Resource" : "*"
      }
    ]
  })
}

# --- Attach the policies to the assume-role ----------------------------------
resource "aws_iam_role_policy_attachment" "s3" {
  count = local.iam_create ? 1 : 0

  role       = aws_iam_role.nullplatform_s3[0].name
  policy_arn = aws_iam_policy.nullplatform_s3[0].arn
}

resource "aws_iam_role_policy_attachment" "s3_iam" {
  count = local.iam_create ? 1 : 0

  role       = aws_iam_role.nullplatform_s3[0].name
  policy_arn = aws_iam_policy.nullplatform_s3_iam[0].arn
}
