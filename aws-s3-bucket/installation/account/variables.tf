variable "installation" {
  description = "The installation this account belongs to: its id, the NRN it was installed at, and the package slug and version."
  type = object({
    id           = string
    nrn          = string
    package_slug = string
    version      = string
  })
}

variable "name" {
  description = "Name of this account within the installation (e.g. dev, prod). Part of the created role's name."
  type        = string
}

variable "agent_role_arn" {
  description = "IAM role the agent's workers run with in this account; the created role trusts it."
  type        = string
}

variable "role_arn" {
  description = "The role the worker assumes in this account. Null creates one, trusting agent_role_arn."
  type        = string
  default     = null

  validation {
    condition     = var.role_arn == null || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", var.role_arn))
    error_message = "role_arn must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)."
  }
}
