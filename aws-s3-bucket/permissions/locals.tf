locals {
  # Bucket-level actions (required so the app can list/head the bucket)
  bucket_actions_by_level = {
    "read"       = ["s3:ListBucket", "s3:GetBucketLocation"]
    "write"      = ["s3:ListBucket", "s3:GetBucketLocation"]
    "read-write" = ["s3:ListBucket", "s3:GetBucketLocation"]
  }

  # Object-level actions (scoped to the key prefix if provided)
  object_actions_by_level = {
    "read"       = ["s3:GetObject"]
    "write"      = ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    "read-write" = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
  }

  bucket_actions = local.bucket_actions_by_level[var.access_level]
  object_actions = local.object_actions_by_level[var.access_level]

  # If path_prefix is set, scope object-level permissions to that prefix.
  object_resource_arn = var.path_prefix == "" ? "${var.bucket_arn}/*" : "${var.bucket_arn}/${var.path_prefix}*"

  # When a prefix is set, restrict s3:ListBucket to that prefix via condition.
  list_bucket_condition = var.path_prefix == "" ? {} : {
    StringLike = {
      "s3:prefix" = ["${var.path_prefix}*", var.path_prefix]
    }
  }
}
