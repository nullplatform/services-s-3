terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # This module only reads data.aws_caller_identity.
      version = ">= 5.0"
    }
  }
}
