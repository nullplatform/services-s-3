output "package_version" {
  description = "Version published by this apply."
  value       = module.publish.package_version
}

output "package_published_revision_id" {
  description = "Revision published by this apply."
  value       = module.publish.package_published_revision_id
}
