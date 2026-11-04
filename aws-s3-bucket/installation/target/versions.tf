# A module: the caller configures the providers. One AWS provider means one
# account, so the caller instantiates this module once per account, with the
# alias for it.
terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    nullplatform = {
      source  = "nullplatform/nullplatform"
      version = ">= 0.0.106"
    }
  }
}
