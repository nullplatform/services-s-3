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

  # Grouped by verb (not s3:*) to avoid a full wildcard action while still
  # covering every read the AWS provider (v6+) performs when it refreshes an
  # aws_s3_bucket — it reads a wide surface (ACL, CORS, Logging, Lifecycle,
  # Replication, Website, etc.), so enumerating each s3:Get*/List* by hand is
  # brittle (a missing one surfaces as AccessDenied on refresh). Resource stays
  # "*" on purpose so the consuming stack can restrict it (e.g. arn:aws:s3:::np-*)
  # without changing this module.
  policy = jsonencode({
    "Version" : "2012-10-17",
    "Statement" : [
      {
        "Effect" : "Allow",
        "Action" : [
          "s3:Get*",
          "s3:List*",
          "s3:Put*",
          "s3:Delete*",
          "s3:CreateBucket",
          "s3:HeadBucket"
        ],
        "Resource" : "*"
      }
    ]
  })
}

# --- IAM management (per-link IAM users + access keys, per-link IAM roles) ----
# Link users and roles are named np-s3-<16 hex chars of the link id>; both
# statements match exactly that shape (16 '?'), not every np-s3-* name, so roles
# or users an operator named np-s3-... stay out of reach. A permissions boundary
# can be set when a link principal is created (IAM authorizes that like a
# Put*PermissionsBoundary, so Put* is not denied; it is not allowed either) and
# never removed (the explicit Deny). A mandatory boundary (CreateRole/CreateUser/
# PutRolePolicy/PutUserPolicy conditioned on iam:PermissionsBoundary) needs a
# boundary policy to exist first; that is tracked separately.
resource "aws_iam_policy" "nullplatform_s3_iam" {
  count = local.iam_create ? 1 : 0

  name        = "${local.policies_name_prefix}_s3_iam_policy"
  description = "Policy for managing per-link IAM users, access keys and roles for S3 bucket access"
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
          "iam:ListAttachedUserPolicies",
          # The AWS provider always clears group memberships before DeleteUser,
          # even with force_destroy = false; without these, unlink fails with 403.
          "iam:ListGroupsForUser",
          "iam:RemoveUserFromGroup"
        ],
        "Resource" : "arn:aws:iam::*:user/np-s3-????????????????"
      },
      {
        "Sid" : "LinkRoles",
        "Effect" : "Allow",
        "Action" : [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:UpdateRole",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
          # The AWS provider lists the role's instance profiles before DeleteRole.
          "iam:ListInstanceProfilesForRole",
          "iam:UpdateAssumeRolePolicy"
        ],
        "Resource" : "arn:aws:iam::*:role/np-s3-????????????????"
      },
      {
        "Sid" : "NoLinkBoundaryRemoval",
        "Effect" : "Deny",
        "Action" : [
          "iam:DeleteRolePermissionsBoundary",
          "iam:DeleteUserPermissionsBoundary"
        ],
        "Resource" : [
          "arn:aws:iam::*:role/np-s3-*",
          "arn:aws:iam::*:user/np-s3-*"
        ]
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
