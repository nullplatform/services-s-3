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
}

variable "bucket_arn" {
  type        = string
  description = "Target S3 bucket ARN"
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
}
