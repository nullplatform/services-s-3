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

output "role_arn" {
  description = "ARN of the IAM role created by this module. Empty string when create_role is false."
  value       = var.create_role ? aws_iam_role.nullplatform_s3_role[0].arn : ""
}

output "role_name" {
  description = "Name of the IAM role created by this module. Empty string when create_role is false."
  value       = var.create_role ? aws_iam_role.nullplatform_s3_role[0].name : ""
}
