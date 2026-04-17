output "s3_policy_arn" {
  description = "ARN of the S3 bucket management policy"
  value       = aws_iam_policy.nullplatform_s3_policy.arn
}

output "s3_iam_policy_arn" {
  description = "ARN of the IAM user management policy (per-link users)"
  value       = aws_iam_policy.nullplatform_s3_iam_policy.arn
}

output "s3_tfstate_policy_arn" {
  description = "ARN of the tfstate bucket management policy"
  value       = aws_iam_policy.nullplatform_s3_tfstate_policy.arn
}
