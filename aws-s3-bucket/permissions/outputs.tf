output "iam_user_name" {
  value       = aws_iam_user.link.name
  description = "IAM user created for this link"
}

output "bucket_name" {
  value       = var.bucket_name
  description = "Target S3 bucket name"
}

output "region" {
  value       = var.region
  description = "AWS region"
}
