output "aws_access_key_id" {
  value       = aws_iam_access_key.link.id
  description = "IAM user access key ID"
}

output "aws_secret_access_key" {
  value       = aws_iam_access_key.link.secret
  sensitive   = true
  description = "IAM user secret access key"
}

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
