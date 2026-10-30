output "service_specification_slug" {
  description = "Slug of the published service specification."
  value       = module.service_definition.service_specification_slug
}

output "package_id" {
  description = "Id of the published package."
  value       = module.service_definition.package_id
}

output "package_version" {
  description = "Version published by this apply."
  value       = local.version
}

output "package_published_revision_id" {
  description = "Revision published by this apply."
  value       = module.service_definition.package_published_revision_id
}
