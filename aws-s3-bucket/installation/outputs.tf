output "permissions_role_arn" {
  description = "ARN of the IAM role the service assumes. Add it to your AWS IAM provider with selector \"s3\"."
  value       = module.iam.permissions_role_arn
}

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

output "notification_channel_id" {
  description = "Id of the agent notification channel."
  value       = module.package.notification_channel_id
}
