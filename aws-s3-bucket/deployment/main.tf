# ---------------------------------------------------------------------------
# S3 bucket
# The bucket name is passed in by build_context. It is computed ONCE on the
# first create and then persisted to service attributes; subsequent runs read
# it back from there. This prevents service renames from forcing a bucket
# replace (which would orphan the original bucket on destroy failure).
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "main" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy

  tags = {
    "managed-by" = "nullplatform"
    "service-id" = var.service_id
  }

  lifecycle {
    # Safety net: ignore incoming bucket name drift. The immutability is
    # enforced upstream in build_context, so this should never fire — but if
    # it did, ignoring the change is safer than silently replacing the bucket.
    ignore_changes = [bucket]
  }

  # The data bucket depends on the logs bucket so that a destroy removes the data bucket first:
  # when deleting the service is refused (a non-empty data bucket without force_destroy), the
  # logs bucket and its logs are still there. No effect while access_logs is off.
  depends_on = [aws_s3_bucket.access_logs]
}

resource "aws_s3_bucket_versioning" "main" {
  bucket = aws_s3_bucket.main.id

  versioning_configuration {
    status = var.versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "main" {
  bucket = aws_s3_bucket.main.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = var.encryption
    }
  }
}

resource "aws_s3_bucket_public_access_block" "main" {
  count = var.public_access_block ? 1 : 0

  bucket = aws_s3_bucket.main.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# Server access logs (optional, var.access_logs)
# S3 records every request to the data bucket (requester principal, including
# role session names, operation, key, time, status) and delivers it, best
# effort and with a delay of minutes to hours, to a separate logs bucket in the
# same account and region. Turning access_logs off destroys the logging config
# and the logs bucket.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {
  count = var.access_logs ? 1 : 0
}

locals {
  # <bucket_name>-logs when it fits S3's 63 chars. Otherwise the name is cut and
  # a hash of the full bucket name keeps it unique and deterministic. bucket_name
  # always starts with np-, so the logs bucket stays under the np-* IAM scope.
  access_logs_bucket_name = (
    length(var.bucket_name) <= 58
    ? "${var.bucket_name}-logs"
    : "${replace(substr(var.bucket_name, 0, 49), "/-+$/", "")}-${substr(sha1(var.bucket_name), 0, 8)}-logs"
  )
  access_logs_prefix = "access/"
}

resource "aws_s3_bucket" "access_logs" {
  count = var.access_logs ? 1 : 0

  bucket = local.access_logs_bucket_name
  # Always true, unlike the data bucket: the logs bucket is never empty (even
  # tofu's own reads get logged), its logs expire anyway, and with false turning
  # access_logs off or deleting the service would fail on it with no way to
  # recover once the resource is out of the configuration.
  force_destroy = true


  tags = {
    "managed-by" = "nullplatform"
    "service-id" = var.service_id
    "logs-for"   = var.bucket_name
  }

  lifecycle {
    precondition {
      condition     = length(local.access_logs_bucket_name) <= 63
      error_message = "The access logs bucket name must be at most 63 characters."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  count = var.access_logs ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  count = var.access_logs ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Always SSE-S3, whatever var.encryption is: S3 delivers server access logs only
# to buckets whose default encryption is SSE-S3 (AES256), not SSE-KMS.
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  count = var.access_logs ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  count = var.access_logs ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.access_logs_retention_days
    }
  }
}

# Only the S3 logging service may write, and only for this service's data bucket
# in this account. Requests without TLS are denied, except those AWS services
# make with their own service principal (the log delivery itself).
resource "aws_s3_bucket_policy" "access_logs" {
  count = var.access_logs ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "S3ServerAccessLogsPolicy"
        Effect    = "Allow"
        Principal = { Service = "logging.s3.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.access_logs[0].arn}/${local.access_logs_prefix}*"
        Condition = {
          ArnLike      = { "aws:SourceArn" = aws_s3_bucket.main.arn }
          StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current[0].account_id }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.access_logs[0].arn, "${aws_s3_bucket.access_logs[0].arn}/*"]
        Condition = {
          Bool         = { "aws:SecureTransport" = "false" }
          BoolIfExists = { "aws:PrincipalIsAWSService" = "false" }
        }
      }
    ]
  })

  # Serializes the writes to the logs bucket's configuration.
  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}

resource "aws_s3_bucket_logging" "main" {
  count = var.access_logs ? 1 : 0

  bucket        = aws_s3_bucket.main.id
  target_bucket = aws_s3_bucket.access_logs[0].id
  target_prefix = local.access_logs_prefix

  # Enable delivery only once the logs bucket accepts it.
  depends_on = [
    aws_s3_bucket_policy.access_logs,
    aws_s3_bucket_ownership_controls.access_logs,
    aws_s3_bucket_server_side_encryption_configuration.access_logs,
  ]
}
