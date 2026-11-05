# Only the platform provider: an environment has no cloud resources of its
# own, it registers the account's role.
mock_provider "nullplatform" {}

variables {
  installation = {
    id           = "0f4c2d1e-aaaa-bbbb-cccc-000000000001"
    nrn          = "organization=1:account=2"
    package_slug = "nullplatform-aws-s3-bucket"
    version      = "0.5.8"
  }
  name       = "production"
  dimensions = { environment = "production" }
  role_arn   = "arn:aws:iam::123456789012:role/nullplatform-nullplatform-aws-s3-bucket-0f4c2d1e-prod"
  agent_tags = { environment = "production" }
}

run "nothing_given_creates_an_iam_provider_and_the_channel" {
  command = plan

  assert {
    condition     = length(nullplatform_provider_config.iam) == 1 && length(terraform_data.iam_role_entry) == 0 && length(nullplatform_notification_channel.worker) == 1
    error_message = "With nothing given, an IAM provider holding the account's role and the channel are created"
  }

  assert {
    condition     = nullplatform_provider_config.iam[0].type == "aws-iam-configuration" && nullplatform_provider_config.iam[0].dimensions == tomap({ environment = "production" }) && can(regex("0f4c2d1e-prod", nullplatform_provider_config.iam[0].attributes))
    error_message = "The created IAM provider is an aws-iam-configuration with the environment's dimensions, naming the account's role under selector s3"
  }
}

run "the_channel_selects_this_environments_agent_and_only_routes_its_dimensions" {
  command = plan

  assert {
    condition     = nullplatform_notification_channel.worker[0].configuration[0].agent[0].selector == tomap({ environment = "production" }) && nullplatform_notification_channel.worker[0].configuration[0].agent[0].command[0].data["package"] == "nullplatform-aws-s3-bucket"
    error_message = "The channel selects the agent by its tags and runs the package's worker"
  }

  assert {
    condition     = can(regex("service\\.dimensions\\.environment", nullplatform_notification_channel.worker[0].filters)) && can(regex("\"production\"", nullplatform_notification_channel.worker[0].filters))
    error_message = "With dimensions, the channel routes only services in them"
  }
}

run "an_environment_without_dimensions_routes_every_service_of_the_package" {
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

run "two_environments_in_one_account_share_the_role_and_differ_only_on_the_platform" {
  command = plan

  variables {
    name       = "staging"
    dimensions = { environment = "staging" }
    agent_tags = { environment = "development" } # the development account's agent serves staging too
  }

  assert {
    condition     = nullplatform_provider_config.iam[0].dimensions == tomap({ environment = "staging" }) && can(regex("0f4c2d1e-prod", nullplatform_provider_config.iam[0].attributes))
    error_message = "A second environment registers the same account role under its own dimensions, creating nothing in the cloud"
  }

  assert {
    condition     = nullplatform_notification_channel.worker[0].configuration[0].agent[0].selector == tomap({ environment = "development" }) && can(regex("\"staging\"", nullplatform_notification_channel.worker[0].filters))
    error_message = "Its channel selects the shared agent but routes only staging services"
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

run "a_role_the_provider_already_lists_is_not_written_back" {
  command = plan

  variables {
    iam_provider_id = "prov-existing"
    role_from_entry = true
  }

  assert {
    condition     = length(nullplatform_provider_config.iam) == 0 && length(terraform_data.iam_role_entry) == 0
    error_message = "When the provider's own s3 entry is the role, nothing is written to it"
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
