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

variable "principal_name" {
  type        = string
  description = "Name of the link's IAM user or role (np-s3-<16 hex chars of the link ID>)"
}

variable "credentials" {
  type        = string
  default     = "access-key"
  description = "How the link authenticates: access-key (IAM user, key created by scripts/aws/link_access_key) or role (IAM role, no static key)"

  validation {
    condition     = contains(["access-key", "role"], var.credentials)
    error_message = "credentials must be one of: access-key, role"
  }
}

variable "trusted_principal_arns" {
  type        = list(string)
  default     = []
  description = "IAM role ARNs allowed to assume the link's role (credentials = role). The same list goes to every role link, so it should hold only the S3 browser worker's role"

  # Exact role ARNs only: an account root (arn:aws:iam::<account>:root) or a user would trust
  # far more than the one workload meant to assume the link's role.
  validation {
    condition     = alltrue([for arn in var.trusted_principal_arns : can(regex("^arn:aws(-us-gov|-cn)?:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", arn))])
    error_message = "each trusted_principal_arns entry must be an IAM role ARN: arn:<aws|aws-us-gov|aws-cn>:iam::<account-id>:role/<role-name>"
  }
}

variable "permissions_boundary_arn" {
  type        = string
  default     = ""
  description = "Optional IAM policy ARN set as the permissions boundary of the link's user or role"

  validation {
    condition     = var.permissions_boundary_arn == "" || can(regex("^arn:aws(-us-gov|-cn)?:iam::([0-9]{12}|aws):policy/[A-Za-z0-9+=,.@_/-]+$", var.permissions_boundary_arn))
    error_message = "permissions_boundary_arn must be empty or an IAM policy ARN: arn:<aws|aws-us-gov|aws-cn>:iam::<account-id>:policy/<name>"
  }
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
  # are wildcards and ${...} is a policy variable. Only those and control characters are
  # rejected: any other key character (= + , @ : ~ space ...) stays literal, so links created
  # before this rule keep updating.
  validation {
    condition     = can(regex("^[^*?$\\x00-\\x1f\\x7f]{0,512}$", var.path_prefix))
    error_message = "path_prefix may not contain *, ?, $ or control characters, and is at most 512 characters"
  }
}
