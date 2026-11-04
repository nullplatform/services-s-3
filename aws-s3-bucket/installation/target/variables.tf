variable "installation" {
  description = "The installation this target belongs to: its id, the NRN it was installed at, and the package slug and version."
  type = object({
    id           = string
    nrn          = string
    package_slug = string
    version      = string
  })
}

variable "name" {
  description = "Name of this target, unique within the installation (e.g. the environment). Part of the created role's name."
  type        = string
}

variable "dimensions" {
  description = "Dimensions this target serves; the IAM provider created here carries them so the runtime resolves it for services in that environment."
  type        = map(string)
  default     = {}
}

variable "agent_role_arn" {
  description = "IAM role the agent's workers run with in this account; the created role trusts it."
  type        = string
}

# ── Each one received, or provisioned when absent ──

variable "role_arn" {
  description = "The role the worker assumes. Null creates one in this account, trusting agent_role_arn."
  type        = string
  default     = null

  validation {
    condition     = var.role_arn == null || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", var.role_arn))
    error_message = "role_arn must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)."
  }
}

variable "iam_provider_id" {
  description = "The IAM provider the role is registered in under selector \"s3\". Null creates one at the installation NRN with the target's dimensions; otherwise only this entry is added to it."
  type        = string
  default     = null

  validation {
    condition     = var.iam_provider_id == null || can(regex("^[A-Za-z0-9_-]+$", var.iam_provider_id))
    error_message = "iam_provider_id must be a provider id (letters, digits, '-' and '_')."
  }
}
