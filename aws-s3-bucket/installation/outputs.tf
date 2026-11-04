output "channel_id" {
  description = "The agent channel created, null when the organization creates it elsewhere."
  value       = var.create_channel ? tostring(nullplatform_notification_channel.worker[0].id) : null
}

output "resources" {
  description = "What this module touched, with who owns it (owned: created here, removed on destroy)."
  value = [
    for channel in nullplatform_notification_channel.worker :
    { type = "notification_channel", id = tostring(channel.id), ownership = "owned" }
  ]
}
