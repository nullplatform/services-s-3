output "role_arn" {
  description = "The role the worker assumes in this account, created here or given."
  value       = local.role_arn
}

output "iam_provider_id" {
  description = "The IAM provider the role is registered in, created here or given."
  value       = var.iam_provider_id != null ? var.iam_provider_id : nullplatform_provider_config.iam[0].id
}

output "channel_id" {
  description = "The agent channel for this target, created here or given; null when the organization creates it elsewhere."
  value       = var.channel_id != null ? var.channel_id : try(tostring(nullplatform_notification_channel.worker[0].id), null)
}

output "resources" {
  description = "What this module touched, with who owns it: owned (created here, removed on destroy), provided (a parameter, never removed)."
  value = concat(
    [for role in aws_iam_role.s3 : { type = "aws_iam_role", id = role.arn, target = var.name, ownership = "owned" }],
    var.role_arn != null ? [{ type = "aws_iam_role", id = var.role_arn, target = var.name, ownership = "provided" }] : [],
    [for provider in nullplatform_provider_config.iam : { type = "provider_config", id = provider.id, target = var.name, ownership = "owned" }],
    var.iam_provider_id != null ? [{ type = "provider_config", id = var.iam_provider_id, target = var.name, ownership = "provided" }] : [],
    [for entry in terraform_data.iam_role_entry : { type = "iam_role_entry", id = "${entry.triggers_replace.provider_id}/s3", target = var.name, ownership = "owned" }],
    [for channel in nullplatform_notification_channel.worker : { type = "notification_channel", id = tostring(channel.id), target = var.name, ownership = "owned" }],
    var.channel_id != null ? [{ type = "notification_channel", id = var.channel_id, target = var.name, ownership = "provided" }] : [],
  )
}
