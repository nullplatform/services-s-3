variable "publisher_nrn" {
  description = "Owner NRN of the package: the publisher organization (e.g. organization=123). Its specs, action specs and link specs are created here."
  type        = string
}

variable "image_digest" {
  description = "Digest of the worker image this release pushed (sha256:<64 hex>). Pins the package revision to that exact image."
  type        = string
  default     = null

  validation {
    condition     = var.image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must look like sha256:<64 hex chars>."
  }
}

variable "publish_package" {
  description = <<-EOT
    Publish the package revision. Set to false only for the one-time bootstrap
    apply: the platform creates the default action specifications
    (use_default_actions) when the service spec is created, and the package can
    only pin them on a later apply.
  EOT
  type        = bool
  default     = true
}

variable "image_registry" {
  description = "Registry host of the worker image."
  type        = string
  default     = "public.ecr.aws"
}

variable "image_repository" {
  description = "Repository of the worker image inside the registry."
  type        = string
  default     = "nullplatform/services/s3"
}
