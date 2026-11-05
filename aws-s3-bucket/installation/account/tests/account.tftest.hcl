mock_provider "aws" {}

variables {
  installation = {
    id           = "0f4c2d1e-aaaa-bbbb-cccc-000000000001"
    nrn          = "organization=1:account=2"
    package_slug = "nullplatform-aws-s3-bucket"
    version      = "0.5.8"
  }
  name           = "prod"
  agent_role_arn = "arn:aws:iam::123456789012:role/nullplatform-agent-role"
}

run "no_role_given_creates_one_trusting_the_agent" {
  command = plan

  assert {
    condition     = length(aws_iam_role.s3) == 1 && can(regex("nullplatform-agent-role", aws_iam_role.s3[0].assume_role_policy))
    error_message = "With no role given, one is created trusting the agent role"
  }

  assert {
    condition     = aws_iam_role.s3[0].name == "nullplatform-nullplatform-aws-s3-bucket-0f4c2d1e-prod"
    error_message = "Role names carry the package, a suffix of the installation id and the account, so two installations in one account do not collide"
  }

  assert {
    condition     = length(aws_iam_role_policy.s3) == 1 && length(aws_iam_role_policy.s3_iam) == 1
    error_message = "The created role gets the bucket and the per-link IAM policies"
  }
}

run "a_given_role_is_handed_on_and_not_created" {
  command = plan

  variables {
    role_arn = "arn:aws:iam::123456789012:role/their-s3-role"
  }

  assert {
    condition     = length(aws_iam_role.s3) == 0 && output.role_arn == "arn:aws:iam::123456789012:role/their-s3-role"
    error_message = "A given role is not created; the output hands it to environment/"
  }

  assert {
    condition     = contains([for r in output.resources : r.ownership if r.type == "aws_iam_role"], "provided")
    error_message = "The report must mark the given role as provided, so destroy leaves it alone"
  }
}
