################################################################################
# aws-s3-bucket — installation (nullplatform layer)
#
# Installs the published aws-s3-bucket package in an organization. Reference it
# at a release tag:
#
#   source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation?ref=vX.Y.Z"
#
# The tag fixes the installed version: version.txt of that tag is the package
# revision new services are born with. Upgrading = moving the ref.
#
# Only the nullplatform side, so it goes in the layer of your stack that
# registers specifications. Everything else stays where it is today:
#   - the IAM role the service assumes: ../specs/requirements/aws, in your
#     infrastructure layer;
#   - the agent channel and the IAM provider entry (selector "s3"): your
#     bindings layer.
# The outputs carry the names service_definition outputs, so a stack that
# registered this service with it switches by changing the module.
################################################################################

locals {
  package_slug = "nullplatform-aws-s3-bucket"
  version      = trimspace(file("${path.module}/../../version.txt"))
}

module "package" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/package_installation?ref=feat/package-installation-layered"

  nrn             = var.nrn
  package_slug    = local.package_slug
  package_version = local.version
  visible_to      = var.visible_to
}
