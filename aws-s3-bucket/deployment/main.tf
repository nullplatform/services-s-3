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
