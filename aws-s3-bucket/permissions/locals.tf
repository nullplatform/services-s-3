locals {
  # Built from the validated bucket name, never taken from the service's attributes.
  bucket_arn = "arn:${data.aws_partition.current.partition}:s3:::${var.bucket_name}"

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

  # The prefix is a folder: `team-a` reads as `team-a/`, so its policy never reaches a sibling such
  # as `team-a-secrets/`. Empty is the whole bucket. The S3 browser worker (normalisePathPrefix) and
  # scripts/aws/delete_object read it the same way. Every use below goes through this local.
  path_prefix = var.path_prefix == "" || endswith(var.path_prefix, "/") ? var.path_prefix : "${var.path_prefix}/"

  # If path_prefix is set, scope object-level permissions to that folder.
  object_resource_arn = local.path_prefix == "" ? "${local.bucket_arn}/*" : "${local.bucket_arn}/${local.path_prefix}*"

  # When a prefix is set, s3:ListBucket lists only that folder and what is under it.
  list_prefixes = local.path_prefix == "" ? [] : ["${local.path_prefix}*", local.path_prefix]

  # Tags of the link's user or role.
  tags = {
    "managed-by" = "nullplatform"
    "link-id"    = var.link_id
    "bucket"     = var.bucket_name
  }

  # Optional boundary on the link's user or role; null leaves it unset.
  permissions_boundary = var.permissions_boundary_arn != "" ? var.permissions_boundary_arn : null
}
