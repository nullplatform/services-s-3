variable "installation" {
  description = "The installation this module serves: its id, the NRN it was installed at, and the package slug and version."
  type = object({
    id           = string
    nrn          = string
    package_slug = string
    version      = string
  })
}

variable "agent_tags" {
  description = "Tags of the agent that runs this package's worker; the channel selects it by them. Required with create_channel."
  type        = map(string)
  default     = {}
}

variable "create_channel" {
  description = "Create the agent channel that routes the service's actions to the package worker. Off when the organization creates channels elsewhere."
  type        = bool
  default     = true

  validation {
    condition     = !var.create_channel || length(var.agent_tags) > 0
    error_message = "create_channel needs agent_tags: the channel selects the agent by them."
  }
}
