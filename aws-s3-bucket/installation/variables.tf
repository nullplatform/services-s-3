# ── Injected from NP_INSTALL_CONTEXT by lib/context; never written by the installer ──

variable "installation" {
  description = "The installation this run belongs to: its id, the NRN it was installed at, and the package slug and version."
  type = object({
    id           = string
    nrn          = string
    package_slug = string
    version      = string
  })
}

variable "agent" {
  description = "The agent that runs this package's worker: the IAM role its workers run with (trusted by every role created here) and the tags its channel selects it by."
  type = object({
    role_arn = string
    tags     = map(string)
  })
}

variable "aws_region" {
  description = "Region of the AWS API endpoint. IAM is global; lib/context sets it from the first target's cloud provider."
  type        = string
  default     = "us-east-1"
}

# ── Parameters: each one is received, or resolved here when absent ──

variable "targets" {
  description = <<-EOT
    One target per cloud provider the installation NRN resolves, keyed by a name
    the installer chooses (lib/context derives it from the dimensions when it
    discovers them). Per target: the provider's dimensions; `role_arn`, the role
    the worker assumes (created in that account when null); `iam_provider_id`,
    the IAM provider the role is registered in under selector "s3" (discovered
    for the dimensions when null, created when none exists).
  EOT
  type = map(object({
    dimensions      = map(string)
    role_arn        = optional(string)
    iam_provider_id = optional(string)
  }))

  validation {
    condition     = length(var.targets) > 0
    error_message = "At least one target is required: no cloud provider resolves at the installation NRN and none was given."
  }

  validation {
    condition     = alltrue([for target in var.targets : target.role_arn == null || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", target.role_arn))])
    error_message = "role_arn must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)."
  }

  validation {
    condition     = alltrue([for target in var.targets : target.iam_provider_id == null || can(regex("^[A-Za-z0-9_-]+$", target.iam_provider_id))])
    error_message = "iam_provider_id must be a provider id (letters, digits, '-' and '_')."
  }
}

variable "create_channel" {
  description = "Create the agent channel that routes the service's actions to the package worker. Off when the organization creates channels elsewhere."
  type        = bool
  default     = true
}
