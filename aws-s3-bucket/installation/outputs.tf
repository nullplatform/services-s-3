# The installation's report, in the shape the runner stores (README).

output "outputs" {
  description = "What the runtime reads: the role the worker assumes, per target."
  value       = { role_arn = local.role_arn }
}

output "resources" {
  description = "Every resource this installation touched, with who owns it: owned (created here, removed on uninstall), provided (a parameter), adopted (found and reused, never removed)."
  value = concat(
    [for key, role in aws_iam_role.s3 :
    { type = "aws_iam_role", id = role.arn, target = key, ownership = "owned" }],
    [for key, target in var.targets :
    { type = "aws_iam_role", id = target.role_arn, target = key, ownership = "provided" } if target.role_arn != null],
    [for key, provider in nullplatform_provider_config.iam :
    { type = "provider_config", id = provider.id, target = key, ownership = "owned" }],
    [for key, target in var.targets :
    { type = "provider_config", id = target.iam_provider_id, target = key, ownership = "adopted" } if target.iam_provider_id != null],
    [for key, entry in terraform_data.iam_role_entry :
    { type = "iam_role_entry", id = "${entry.triggers_replace.provider_id}/s3", target = key, ownership = "owned" }],
    [for channel in nullplatform_notification_channel.worker :
    { type = "notification_channel", id = tostring(channel.id), ownership = "owned" }],
  )
}

output "missing" {
  description = "Optional requirements that could not be satisfied. This service has none."
  value       = []
}
