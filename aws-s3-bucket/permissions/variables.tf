variable "link_id" {
  type        = string
  description = "Nullplatform link ID (used as a keeper to stabilize resources across re-applies)"
}

variable "region" {
  type        = string
  description = "AWS region"
}

variable "bucket_name" {
  type        = string
  description = "Target S3 bucket name"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a single S3 bucket name."
  }
}

variable "iam_user_name" {
  type        = string
  description = "IAM user name for this link (derived from link ID)"
}

variable "access_level" {
  type        = string
  default     = "read-write"
  description = "Permission level: read, write, or read-write"

  validation {
    condition     = contains(["read", "write", "read-write"], var.access_level)
    error_message = "access_level must be one of: read, write, read-write"
  }
}

variable "path_prefix" {
  type        = string
  default     = ""
  description = "Optional S3 key prefix to scope the permissions (e.g., 'uploads/')"

  # The prefix ends up inside the policy's resource ARN and s3:prefix condition, where * and ?
  # are wildcards; only S3's safe characters and "/" keep it a literal prefix.
  validation {
    condition     = can(regex("^[A-Za-z0-9!_.'()/-]{0,512}$", var.path_prefix))
    error_message = "path_prefix may only contain letters, digits, / and ! _ . ' ( ) -"
  }
}
