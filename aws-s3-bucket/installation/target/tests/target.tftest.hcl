mock_provider "aws" {}
mock_provider "nullplatform" {}

variables {
  installation = {
    id           = "0f4c2d1e-aaaa-bbbb-cccc-000000000001"
    nrn          = "organization=1:account=2"
    package_slug = "nullplatform-aws-s3-bucket"
    version      = "0.5.8"
  }
  name           = "production"
  dimensions     = { environment = "production" }
  agent_role_arn = "arn:aws:iam::123456789012:role/nullplatform-agent-role"
}

run "nothing_provided_creates_the_role_and_an_iam_provider" {
  command = plan

  assert {
    condition     = length(aws_iam_role.s3) == 1 && length(nullplatform_provider_config.iam) == 1 && length(terraform_data.iam_role_entry) == 0
    error_message = "With no role_arn and no iam_provider_id, the role and its own IAM provider are created"
  }

  assert {
    condition     = can(regex("nullplatform-agent-role", aws_iam_role.s3[0].assume_role_policy))
    error_message = "The created role must trust the agent role"
  }

  assert {
    condition     = aws_iam_role.s3[0].name == "nullplatform-nullplatform-aws-s3-bucket-0f4c2d1e-production"
    error_message = "Role names carry the package, a suffix of the installation id and the target, so two installations in one account do not collide"
  }

  assert {
    condition     = nullplatform_provider_config.iam[0].type == "aws-iam-configuration" && nullplatform_provider_config.iam[0].dimensions == tomap({ environment = "production" })
    error_message = "The created IAM provider is an aws-iam-configuration with the target's dimensions"
  }
}

run "a_provided_role_is_registered_but_not_created" {
  command = plan

  variables {
    role_arn = "arn:aws:iam::123456789012:role/their-s3-role"
  }

  assert {
    condition     = length(aws_iam_role.s3) == 0 && can(regex("their-s3-role", nullplatform_provider_config.iam[0].attributes))
    error_message = "A provided role is registered under selector s3, not created"
  }

  assert {
    condition     = contains([for r in output.resources : r.ownership if r.type == "aws_iam_role"], "provided")
    error_message = "The report must mark the provided role as provided, so destroy leaves it alone"
  }
}

run "an_existing_iam_provider_is_adopted_and_only_gets_an_entry" {
  command = plan

  variables {
    iam_provider_id = "prov-existing"
  }

  assert {
    condition     = length(nullplatform_provider_config.iam) == 0 && length(terraform_data.iam_role_entry) == 1 && terraform_data.iam_role_entry[0].triggers_replace.selector == "s3"
    error_message = "A named IAM provider must not be created; it gets one entry under selector s3"
  }

  assert {
    condition     = contains([for r in output.resources : r.ownership if r.type == "provider_config"], "adopted") && output.iam_provider_id == "prov-existing"
    error_message = "The report must mark the existing provider as adopted"
  }
}
