terraform {
  required_version = ">= 1.6"

  required_providers {
    nullplatform = {
      source = "nullplatform/nullplatform"
      # nullplatform_package_installation, data.nullplatform_package.visible_at
      # and .components: the first provider release after 0.0.109.
      version = ">= 0.0.110"
    }
  }
}
