output "permissions_role_arn" {
  description = "ARN of the IAM role the service assumes. Add it to your AWS IAM provider with selector \"s3\"."
  value       = module.iam.permissions_role_arn
}

output "installation_id" {
  description = "Id of the package installation."
  value       = nullplatform_package_installation.this.id
}

output "installed_version" {
  description = "Version new services are born with."
  value       = nullplatform_package_installation.this.default_version
}

output "missing_optional_requirements" {
  description = "Optional providers the package can use that are not configured at nrn or above it."
  value       = nullplatform_package_installation.this.missing_optional_requirements
}

output "notification_channel_id" {
  description = "Id of the agent notification channel."
  value       = module.agent_channel.id
}
