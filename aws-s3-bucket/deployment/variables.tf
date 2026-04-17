variable "service_id" {
  type        = string
  description = "Nullplatform service ID"
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region"
}

variable "bucket_name" {
  type        = string
  description = "S3 bucket name. IMMUTABLE: computed once in build_context on first create, then read back from service attributes to prevent accidental renames that would replace the bucket."

  validation {
    condition     = length(var.bucket_name) >= 3 && length(var.bucket_name) <= 63
    error_message = "bucket_name must be between 3 and 63 characters."
  }
}

variable "versioning" {
  type        = bool
  default     = true
  description = "Enable S3 versioning"
}

variable "encryption" {
  type        = string
  default     = "AES256"
  description = "Server-side encryption algorithm (AES256 or aws:kms)"

  validation {
    condition     = contains(["AES256", "aws:kms"], var.encryption)
    error_message = "encryption must be AES256 or aws:kms"
  }
}

variable "public_access_block" {
  type        = bool
  default     = true
  description = "Block all public access to the bucket"
}

variable "force_destroy" {
  type        = bool
  default     = false
  description = "Allow deleting the bucket even if it contains objects"
}
