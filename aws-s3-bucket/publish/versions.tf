terraform {
  required_version = ">= 1.6"

  # Partial configuration: bucket, key and region come from -backend-config in
  # the release workflow, so no account detail lives in the repository.
  backend "s3" {}

  required_providers {
    nullplatform = {
      source  = "nullplatform/nullplatform"
      version = ">= 0.0.108"
    }
  }
}

# Credentials come from NULLPLATFORM_API_KEY: a key of the publisher
# organization, the only one allowed to publish with organization=* visibility.
provider "nullplatform" {}
