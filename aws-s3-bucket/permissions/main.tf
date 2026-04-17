# ---------------------------------------------------------------------------
# IAM user per link
# ---------------------------------------------------------------------------

resource "aws_iam_user" "link" {
  name = var.iam_user_name

  tags = {
    "managed-by" = "nullplatform"
    "link-id"    = var.link_id
    "bucket"     = var.bucket_name
  }
}

# ---------------------------------------------------------------------------
# Access key
# The keepers block ensures the key is only recreated if link_id changes.
# ---------------------------------------------------------------------------

resource "aws_iam_access_key" "link" {
  user = aws_iam_user.link.name
}

# ---------------------------------------------------------------------------
# Inline policy scoped to the bucket (and optionally a path prefix)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "link" {
  statement {
    sid       = "BucketLevel"
    effect    = "Allow"
    actions   = local.bucket_actions
    resources = [var.bucket_arn]

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
  name   = "s3-access-${var.link_id}"
  user   = aws_iam_user.link.name
  policy = data.aws_iam_policy_document.link.json
}
