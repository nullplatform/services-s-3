################################################################################
# Policy attachments (only when role_name is provided)
################################################################################

resource "aws_iam_role_policy_attachment" "s3" {
  count      = var.role_name != null ? 1 : 0
  role       = var.role_name
  policy_arn = aws_iam_policy.nullplatform_s3_policy.arn
}

resource "aws_iam_role_policy_attachment" "s3_iam" {
  count      = var.role_name != null ? 1 : 0
  role       = var.role_name
  policy_arn = aws_iam_policy.nullplatform_s3_iam_policy.arn
}

resource "aws_iam_role_policy_attachment" "s3_tfstate" {
  count      = var.role_name != null ? 1 : 0
  role       = var.role_name
  policy_arn = aws_iam_policy.nullplatform_s3_tfstate_policy.arn
}

################################################################################
# S3 bucket management policy
################################################################################

# Permissions to create/configure/delete user buckets managed by this service.
#
# Uses `s3:*` rather than an enumerated Get/Put list because the AWS
# Terraform provider refreshes `aws_s3_bucket` by reading a wide surface of
# bucket attributes (ACL, CORS, Logging, Lifecycle, Replication,
# OwnershipControls, Website, Notification, AccelerateConfiguration,
# RequestPayment, ObjectLock, ...). Each time the provider gains a new
# refreshed attribute, an enumerated list breaks with AccessDenied on the
# missing Get* action. Observed on provider v6.x: `s3:GetBucketAcl` was not
# in the previous enumerated list and aborted the first create workflow on
# a tenant with an up-to-date provider.
#
# Resource stays `"*"` to preserve current behavior. Tenants wanting a
# tighter blast radius can attach this policy via a wrapper that overrides
# the Resource list to a known bucket prefix (this service's default naming
# is `np-<sanitized-service-name>-<suffix>` for user buckets and
# `np-service-<SERVICE_ID>` for tfstate buckets — both `np-*`).
resource "aws_iam_policy" "nullplatform_s3_policy" {
  name        = "nullplatform_${var.name}_s3_policy"
  description = "Policy for managing S3 buckets provisioned by the aws-s3-bucket service"

  policy = jsonencode({
    "Version" : "2012-10-17",
    "Statement" : [
      {
        "Effect" : "Allow",
        "Action" : "s3:*",
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
