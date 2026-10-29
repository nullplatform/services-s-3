################################################################################
# aws-s3-bucket — publisher stack
#
# Publishes the service as ONE package visible to every organization
# (organization=*): the service spec, its action specs and link specs from this
# checkout, plus the worker image the same release pushed, pinned by digest.
# Each release publishes a new immutable revision (version.txt, bumped by
# release-please); re-applying the same version is a no-op.
#
# Organizations do not get a copy: they install this package with
# ../installation, which consumes it read-only.
#
# Run only by the release workflow, through actions-nullplatform's
# publish-package (see release.yml).
################################################################################

locals {
  # The nullplatform- prefix keeps the global package and its specification
  # apart from the copies organizations registered from this repository with
  # service_definition (specification "AWS S3 Bucket", slug aws-s3-bucket):
  # agent channels route by specification slug, so the two must differ for
  # both to live in one organization.
  package_slug = "nullplatform-aws-s3-bucket"
  service_path = "aws-s3-bucket"
  version      = trimspace(file("${path.module}/../../version.txt"))
}

# A revision without a digest would float to whatever image is newest, and one
# whose version is not the tag's would publish other specs under it: refuse both.
resource "terraform_data" "release_guard" {
  lifecycle {
    precondition {
      condition     = !var.publish_package || var.image_digest != null
      error_message = "image_digest is required to publish a package revision (only the bootstrap apply with publish_package = false may omit it)."
    }
    precondition {
      condition     = var.release_tag == null || var.release_tag == "v${local.version}"
      error_message = "version.txt is ${local.version} but the release tag is ${coalesce(var.release_tag, "unset")}."
    }
  }
}

module "service_definition" {
  source = "git::https://github.com/nullplatform/tofu-modules.git//nullplatform/service_definition?ref=v9.7.0"

  nrn = var.publisher_nrn

  # Specs come from this checkout, not from a raw GitHub URL, so a release
  # publishes exactly the specs of its own tag.
  git_provider     = "local"
  local_specs_path = abspath("${path.module}/..")
  # Required by the module but not read with git_provider = "local"; set to
  # the release tag so the stack says which specs it published.
  repository_branch = "v${local.version}"
  service_path      = local.service_path
  # Slugifies to the package slug, so the installation's channel filter
  # (specification slug = package slug) matches it.
  service_name = "nullplatform AWS S3 Bucket"

  package = var.publish_package ? {
    slug       = local.package_slug
    version    = local.version
    visible_to = ["organization=*"]
    # Checked at install, before anything is written: the region comes from
    # the account's cloud provider; the IAM provider gets the role the
    # installation creates, so it may not exist yet the first time.
    requires_providers = [
      { category = "cloud-providers" },
      { category = "identity-access-control", optional = true },
    ]
    artifacts = [{
      name   = "worker-image"
      type   = "oci_image"
      lookup = true # registered by the release workflow before this runs
      meta = {
        registry   = var.image_registry
        repository = var.image_repository
        digest     = var.image_digest
      }
    }]
  } : null
}
