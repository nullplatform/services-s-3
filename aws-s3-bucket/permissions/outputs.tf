output "iam_user_name" {
  value       = aws_iam_user.link.name
  description = "IAM user created for this link"
}

output "iam_role_name" {
  value       = var.browser_role ? aws_iam_role.link[0].name : ""
  description = "IAM role created for this link (empty while the link has no role)"
}

output "role_arn" {
  value       = var.browser_role ? aws_iam_role.link[0].arn : ""
  description = "ARN of the IAM role created for this link (empty while the link has no role)"
}

output "bucket_name" {
  value       = var.bucket_name
  description = "Target S3 bucket name"
}

output "region" {
  value       = var.region
  description = "AWS region"
}
