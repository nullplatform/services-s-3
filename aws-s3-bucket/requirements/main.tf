################################################################################
# IAM role (only when create_role = true)
################################################################################

resource "aws_iam_role" "nullplatform_s3_role" {
  count = var.create_role ? 1 : 0
  name  = "nullplatform_${var.name}_s3_role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { AWS = var.trusted_arns }
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

################################################################################
# Policy attachments (when create_role = true or role_name is provided)
################################################################################

locals {
  effective_role_name = var.create_role ? aws_iam_role.nullplatform_s3_role[0].name : var.role_name
  attach_policies     = var.create_role || var.role_name != null
}

resource "aws_iam_role_policy_attachment" "s3" {
  count      = local.attach_policies ? 1 : 0
  role       = local.effective_role_name
  policy_arn = aws_iam_policy.nullplatform_s3_policy.arn
}

resource "aws_iam_role_policy_attachment" "s3_iam" {
  count      = local.attach_policies ? 1 : 0
  role       = local.effective_role_name
  policy_arn = aws_iam_policy.nullplatform_s3_iam_policy.arn
}

resource "aws_iam_role_policy_attachment" "s3_tfstate" {
  count      = local.attach_policies ? 1 : 0
  role       = local.effective_role_name
  policy_arn = aws_iam_policy.nullplatform_s3_tfstate_policy.arn
}

################################################################################
# S3 bucket management policy
################################################################################

# Permissions to create/configure/delete user buckets managed by this service.
resource "aws_iam_policy" "nullplatform_s3_policy" {
  name        = "nullplatform_${var.name}_s3_policy"
  description = "Policy for managing S3 buckets provisioned by the aws-s3-bucket service"

  policy = jsonencode({
    "Version" : "2012-10-17",
    "Statement" : [
      {
        "Effect" : "Allow",
        "Action" : [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:HeadBucket",
          "s3:ListBucket",
          "s3:ListBucketVersions",
          "s3:ListAllMyBuckets",
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:GetBucketEncryption",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetBucketPolicy",
          "s3:GetBucketTagging",
          "s3:GetBucketAcl",
          "s3:GetBucketOwnershipControls",
          "s3:GetBucketLogging",
          "s3:GetBucketNotification",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetBucketReplication",
          "s3:GetBucketRequestPayment",
          "s3:GetBucketWebsite",
          "s3:GetBucketCORS",
          "s3:GetLifecycleConfiguration",
          "s3:GetAccelerateConfiguration",
          "s3:PutBucketVersioning",
          "s3:PutBucketEncryption",
          "s3:PutBucketPublicAccessBlock",
          "s3:PutBucketPolicy",
          "s3:PutBucketTagging",
          "s3:PutBucketOwnershipControls",
          "s3:DeleteBucketPolicy",
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

################################################################################
# IAM management policy (for per-link IAM users + access keys)
################################################################################

resource "aws_iam_policy" "nullplatform_s3_iam_policy" {
  name        = "nullplatform_${var.name}_s3_iam_policy"
  description = "Policy for managing per-link IAM users and access keys for S3 bucket access"

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
        "Resource" : [
          "arn:aws:iam::*:user/np-s3-*"
        ]
      }
    ]
  })
}

################################################################################
# Tfstate bucket management policy (per-service S3 buckets: np-service-<id>)
################################################################################

resource "aws_iam_policy" "nullplatform_s3_tfstate_policy" {
  name        = "nullplatform_${var.name}_s3_tfstate_policy"
  description = "Policy for managing per-service S3 tfstate buckets (np-service-*)"

  policy = jsonencode({
    "Version" : "2012-10-17",
    "Statement" : [
      {
        "Effect" : "Allow",
        "Action" : [
          "s3:CreateBucket",
          "s3:HeadBucket",
          "s3:PutBucketVersioning",
          "s3:ListBucket",
          "s3:ListBucketVersions",
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:DeleteBucket"
        ],
        "Resource" : [
          "arn:aws:s3:::np-service-*",
          "arn:aws:s3:::np-service-*/*"
        ]
      }
    ]
  })
}
