output "iam_user_name" {
  value       = var.credentials == "access-key" ? aws_iam_user.link[0].name : ""
  description = "IAM user created for this link (empty for role links)"
}

output "iam_role_name" {
  value       = var.credentials == "role" ? aws_iam_role.link[0].name : ""
  description = "IAM role created for this link (empty for access-key links)"
}

output "role_arn" {
  value       = var.credentials == "role" ? aws_iam_role.link[0].arn : ""
  description = "ARN of the IAM role created for this link (empty for access-key links)"
}

output "bucket_name" {
  value       = var.bucket_name
  description = "Target S3 bucket name"
}

output "region" {
  value       = var.region
  description = "AWS region"
}
