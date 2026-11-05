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
  agent_tags     = { environment = "production" }
}

run "nothing_provided_creates_the_role_an_iam_provider_and_the_channel" {
  command = plan

  assert {
    condition     = length(aws_iam_role.s3) == 1 && length(nullplatform_provider_config.iam) == 1 && length(terraform_data.iam_role_entry) == 0 && length(nullplatform_notification_channel.worker) == 1
    error_message = "With nothing given, the role, its own IAM provider and the channel are created"
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

run "the_channel_selects_this_accounts_agent_and_only_routes_its_dimensions" {
  command = plan

  assert {
    condition     = nullplatform_notification_channel.worker[0].configuration[0].agent[0].selector == tomap({ environment = "production" }) && nullplatform_notification_channel.worker[0].configuration[0].agent[0].command[0].data["package"] == "nullplatform-aws-s3-bucket"
    error_message = "The channel selects the agent of this account by its tags and runs the package's worker"
  }

  assert {
    condition     = can(regex("service\\.dimensions\\.environment", nullplatform_notification_channel.worker[0].filters)) && can(regex("\"production\"", nullplatform_notification_channel.worker[0].filters))
    error_message = "With dimensions, the channel routes only services in them"
  }
}

run "a_target_without_dimensions_routes_every_service_of_the_package" {
  command = plan

  variables {
    name       = "default"
    dimensions = {}
  }

  assert {
    condition     = !can(regex("dimensions", nullplatform_notification_channel.worker[0].filters))
    error_message = "Without dimensions the channel has no dimension filter"
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

run "an_existing_iam_provider_and_channel_are_reused" {
  command = plan

  variables {
    iam_provider_id = "prov-existing"
    channel_id      = "ch-existing"
    agent_tags      = {}
  }

  assert {
    condition     = length(nullplatform_provider_config.iam) == 0 && length(terraform_data.iam_role_entry) == 1 && terraform_data.iam_role_entry[0].triggers_replace.selector == "s3" && length(nullplatform_notification_channel.worker) == 0
    error_message = "A named IAM provider gets one entry under selector s3; a named channel is not created again"
  }

  assert {
    condition     = output.iam_provider_id == "prov-existing" && output.channel_id == "ch-existing"
    error_message = "The outputs hand the given ids on"
  }
}

run "the_channel_can_be_left_to_the_organization" {
  command = plan

  variables {
    create_channel = false
    agent_tags     = {}
  }

  assert {
    condition     = length(nullplatform_notification_channel.worker) == 0 && output.channel_id == null
    error_message = "With create_channel = false no channel may be created"
  }
}

run "creating_the_channel_needs_the_agent_tags" {
  command = plan

  variables {
    agent_tags = {}
  }

  expect_failures = [var.create_channel]
}
