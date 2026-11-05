# A module: the caller configures the provider. One AWS provider means one
# account, so the caller instantiates this module once per account, with the
# alias for it. Nothing here touches the platform: that is environment/'s,
# instantiated once per dimension set the account serves.
terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}
