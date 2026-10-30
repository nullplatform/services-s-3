variable "nrn" {
  description = "NRN of your organization where the service is installed (e.g. organization=123:account=456)."
  type        = string
}

variable "visible_to" {
  description = "Where inside your organization the service can be used. Null uses [nrn]."
  type        = list(string)
  default     = null
}
