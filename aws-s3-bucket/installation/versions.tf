terraform {
  required_version = ">= 1.6"

  required_providers {
    nullplatform = {
      source = "nullplatform/nullplatform"
      # nullplatform_package_installation and data.nullplatform_package.visible_at
      # ship in the first provider release after 0.0.108.
      version = ">= 0.0.109"
    }
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}
