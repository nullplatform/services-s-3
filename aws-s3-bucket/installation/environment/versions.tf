# A module: the caller configures the provider. Only the platform is touched
# here, so one instance per dimension set (environment) the installation
# serves, in whatever account: the role comes in from account/'s output.
terraform {
  required_version = ">= 1.6"

  required_providers {
    nullplatform = {
      source  = "nullplatform/nullplatform"
      version = ">= 0.0.106"
    }
  }
}
