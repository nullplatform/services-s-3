variable "installation" {
  description = "The installation this environment belongs to: its id, the NRN it was installed at, and the package slug and version."
  type = object({
    id           = string
    nrn          = string
    package_slug = string
    version      = string
  })
}

variable "name" {
  description = "Name of this environment, unique within the installation. Part of the channel's description."
  type        = string
}

variable "dimensions" {
  description = "Dimensions this environment serves; the IAM provider created here carries them so the runtime resolves it for services in them, and the channel routes only those services. Empty serves every service at the NRN."
  type        = map(string)
  default     = {}
}

# ── From the account the environment runs in (account/'s output) ──

variable "role_arn" {
  description = "The role the worker assumes in this environment's account; registered in the IAM provider under selector s3."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", var.role_arn))
    error_message = "role_arn must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)."
  }
}

variable "role_from_entry" {
  description = "True when role_arn is what the IAM provider already lists under selector s3: nothing is written to the provider then."
  type        = bool
  default     = false
}

# ── Each one received, or provisioned when absent ──

variable "iam_provider_id" {
  description = "The IAM provider the role is registered in under selector \"s3\". Null creates one at the installation NRN with the environment's dimensions; otherwise only this entry is added to it."
  type        = string
  default     = null

  validation {
    condition     = var.iam_provider_id == null || can(regex("^[A-Za-z0-9_-]+$", var.iam_provider_id))
    error_message = "iam_provider_id must be a provider id (letters, digits, '-' and '_')."
  }
}

# ── The agent channel, one per environment ──

variable "agent_tags" {
  description = "Tags of the agent that runs this package's worker for this environment; the channel selects it by them. Required with create_channel."
  type        = map(string)
  default     = {}
}

variable "channel_id" {
  description = "An agent channel that already routes this package for these dimensions, reused as is. Null creates one when create_channel is on."
  type        = string
  default     = null
}

variable "create_channel" {
  description = "Create the agent channel that routes this environment's services to the package worker. Off when the organization creates channels elsewhere."
  type        = bool
  default     = true

  validation {
    condition     = !(var.create_channel && var.channel_id == null) || length(var.agent_tags) > 0
    error_message = "Creating the channel needs agent_tags: the channel selects the agent by them."
  }
}
