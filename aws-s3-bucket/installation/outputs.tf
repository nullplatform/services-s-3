output "installation_id" {
  description = "Id of the package installation."
  value       = module.package.installation_id
}

output "installed_version" {
  description = "Version new services are born with."
  value       = module.package.installed_version
}

output "missing_optional_requirements" {
  description = "Optional providers the package can use that are not configured at nrn or above it."
  value       = module.package.missing_optional_requirements
}

output "package_slug" {
  description = "Slug of the package: the package_slug of the agent channel."
  value       = local.package_slug
}

# Same names as service_definition's outputs.

output "service_specification_id" {
  description = "Id of the service specification."
  value       = module.package.service_specification_id
}

output "service_specification_slug" {
  description = "Slug of the service specification: what the agent channel filters on."
  value       = module.package.service_specification_slug
}

output "package_id" {
  description = "Id of the installed package."
  value       = module.package.package_id
}

output "package_default_version" {
  description = "Same as installed_version."
  value       = module.package.package_default_version
}
