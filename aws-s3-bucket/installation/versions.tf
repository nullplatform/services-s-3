# A module: the caller configures the providers. This one only touches the
# platform, so it needs nullplatform alone.
terraform {
  required_version = ">= 1.6"

  required_providers {
    nullplatform = {
      source  = "nullplatform/nullplatform"
      version = ">= 0.0.106"
    }
  }
}
