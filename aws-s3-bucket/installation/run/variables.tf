# Filled by lib/context from NP_INSTALL_CONTEXT.

variable "installation" {
  type = object({
    id           = string
    nrn          = string
    package_slug = string
    version      = string
  })
}

variable "agent" {
  description = "The agent that runs this package's worker: the IAM role its workers run with and the tags its channel selects it by (an environment may name another agent with its own agent_tags)."
  type = object({
    role_arn = string
    tags     = map(string)
  })
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "account" {
  description = "The one AWS account the runner installs in: its name within the installation and the role it already has (null creates one)."
  type = object({
    name     = optional(string, "default")
    role_arn = optional(string)
  })
  default = {}
}

variable "environments" {
  description = "One environment per dimension set the account serves, with what each already has on the platform (each null is created)."
  type = map(object({
    dimensions      = map(string)
    agent_tags      = optional(map(string))
    channel_id      = optional(string)
    role_from_entry = optional(bool, false)
    iam_provider_id = optional(string)
  }))

  validation {
    condition     = length(var.environments) > 0
    error_message = "At least one environment is required: no cloud provider resolves at the installation NRN and none was given."
  }
}

variable "create_channel" {
  type    = bool
  default = true
}
