terraform {
  required_version = ">= 1.6"

  # No backend: the runner hands the state file in NP_INSTALL_STATE and keeps
  # it afterwards (see README). A backend here would need a bucket to exist
  # before the installation, which is one of the things it may create.

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

# Credentials are the runner's (a profile locally, the agent's role in the
# cluster). IAM is global; the region only matters for the API endpoint.
provider "aws" {
  region = var.aws_region
}

# NULLPLATFORM_API_KEY from the context (lib/context exports it).
provider "nullplatform" {}
