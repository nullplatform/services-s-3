variable "name" {
  description = "Unique identifier for policy naming. Must be unique per AWS account (IAM policy names are account-global). Example: \"prod-us-east-1\"."
  type        = string
}

variable "role_name" {
  description = "IAM role name to attach the S3 service policies to. If set, Terraform manages the attachments and will detach them automatically on destroy. Ignored when create_role is true."
  type        = string
  default     = null
}

variable "create_role" {
  description = "When true, creates a new IAM role for the S3 service and attaches all policies to it. The role will allow the ARNs in trusted_arns to assume it via sts:AssumeRole."
  type        = bool
  default     = false
}

variable "trusted_arns" {
  description = "List of IAM principal ARNs (roles, users, accounts) allowed to assume the role created by this module. Only used when create_role is true."
  type        = list(string)
  default     = []
}
