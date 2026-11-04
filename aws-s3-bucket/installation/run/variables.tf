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
  description = "The agent that runs this package's worker: the IAM role its workers run with and the tags its channel selects it by."
  type = object({
    role_arn = string
    tags     = map(string)
  })
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "targets" {
  description = "One target per account the installation serves; the runner has one AWS provider, so one account, with as many dimension sets as given."
  type = map(object({
    dimensions      = map(string)
    role_arn        = optional(string)
    iam_provider_id = optional(string)
  }))

  validation {
    condition     = length(var.targets) > 0
    error_message = "At least one target is required: no cloud provider resolves at the installation NRN and none was given."
  }
}

variable "create_channel" {
  type    = bool
  default = true
}
