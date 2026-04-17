output "bucket_name" {
  value       = aws_s3_bucket.main.id
  description = "S3 bucket name"
}

output "bucket_arn" {
  value       = aws_s3_bucket.main.arn
  description = "S3 bucket ARN"
}

output "bucket_region" {
  value       = aws_s3_bucket.main.region
  description = "AWS region where the bucket is located"
}
