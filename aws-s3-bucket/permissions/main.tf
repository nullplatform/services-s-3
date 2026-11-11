# ---------------------------------------------------------------------------
# IAM user per link (credentials = access-key)
# ---------------------------------------------------------------------------

resource "aws_iam_user" "link" {
  count = var.credentials == "access-key" ? 1 : 0

  name                 = var.principal_name
  permissions_boundary = local.permissions_boundary

  tags = local.tags

  # The boundary is set at creation only: adding one to an existing principal would need
  # iam:PutUserPermissionsBoundary, which the agent's role does not get.
  lifecycle {
    ignore_changes = [permissions_boundary]
  }
}

# Links created before role mode hold the user and its policy without an index: move them
# into the counted address instead of destroying and recreating them.
moved {
  from = aws_iam_user.link
  to   = aws_iam_user.link[0]
}

moved {
  from = aws_iam_user_policy.link
  to   = aws_iam_user_policy.link[0]
}

# ---------------------------------------------------------------------------
# Access key: not managed here. scripts/aws/link_access_key creates it with
# the AWS CLI and writes its secret only to the link, so the tfstate never
# holds it. Links created before this change keep their key: the block below
# forgets it from the state without deleting it in AWS.
# ---------------------------------------------------------------------------

removed {
  from = aws_iam_access_key.link

  lifecycle {
    destroy = false
  }
}

# ---------------------------------------------------------------------------
# Inline policy scoped to the bucket (and optionally a path prefix)
# ---------------------------------------------------------------------------

data "aws_partition" "current" {}

data "aws_iam_policy_document" "link" {
  statement {
    sid       = "BucketLevel"
    effect    = "Allow"
    actions   = local.bucket_actions
    resources = [local.bucket_arn]

    dynamic "condition" {
      for_each = var.path_prefix == "" ? [] : [1]
      content {
        test     = "StringLike"
        variable = "s3:prefix"
        values   = ["${var.path_prefix}*", var.path_prefix]
      }
    }
  }

  statement {
    sid       = "ObjectLevel"
    effect    = "Allow"
    actions   = local.object_actions
    resources = [local.object_resource_arn]
  }
}

resource "aws_iam_user_policy" "link" {
  count = var.credentials == "access-key" ? 1 : 0

  name   = "s3-access-${var.link_id}"
  user   = aws_iam_user.link[0].name
  policy = data.aws_iam_policy_document.link.json
}

# ---------------------------------------------------------------------------
# IAM role per link (credentials = role): no static key. Only the exact role
# ARNs in trusted_principal_arns (the S3 browser worker) can assume it,
# and it carries the same bucket policy as the user would.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "link_trust" {
  count = var.credentials == "role" ? 1 : 0

  statement {
    sid     = "TrustedPrincipals"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = var.trusted_principal_arns
    }
  }
}

resource "aws_iam_role" "link" {
  count = var.credentials == "role" ? 1 : 0

  name                 = var.principal_name
  assume_role_policy   = data.aws_iam_policy_document.link_trust[0].json
  max_session_duration = 3600
  permissions_boundary = local.permissions_boundary

  tags = local.tags

  lifecycle {
    # Set at creation only, as for the user.
    ignore_changes = [permissions_boundary]

    precondition {
      condition     = length(var.trusted_principal_arns) > 0
      error_message = "credentials = role needs at least one trusted_principal_arns entry (LINK_ROLE_TRUSTED_PRINCIPALS / link_role_trusted_principals)."
    }
  }
}

resource "aws_iam_role_policy" "link" {
  count = var.credentials == "role" ? 1 : 0

  name   = "s3-access-${var.link_id}"
  role   = aws_iam_role.link[0].id
  policy = data.aws_iam_policy_document.link.json
}
