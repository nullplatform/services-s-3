output "role_arn" {
  description = "The role the worker assumes in this account, created here or given. environment/ registers it in each environment's IAM provider."
  value       = local.role_arn
}

output "resources" {
  description = "What this module touched, with who owns it: owned (created here, removed on destroy), provided (a parameter, never removed)."
  value = concat(
    [for role in aws_iam_role.s3 : { type = "aws_iam_role", id = role.arn, account = var.name, ownership = "owned" }],
    var.role_arn != null ? [{ type = "aws_iam_role", id = var.role_arn, account = var.name, ownership = "provided" }] : [],
  )
}
