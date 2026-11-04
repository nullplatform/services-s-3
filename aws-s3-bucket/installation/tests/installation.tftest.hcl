mock_provider "nullplatform" {}

variables {
  installation = {
    id           = "0f4c2d1e-aaaa-bbbb-cccc-000000000001"
    nrn          = "organization=1:account=2"
    package_slug = "nullplatform-aws-s3-bucket"
    version      = "0.5.8"
  }
  agent_tags = { environment = "development" }
}

run "the_channel_routes_the_package_to_the_agent_by_its_tags" {
  command = plan

  assert {
    condition     = length(nullplatform_notification_channel.worker) == 1 && nullplatform_notification_channel.worker[0].configuration[0].agent[0].selector == tomap({ environment = "development" })
    error_message = "The channel selects the agent by the tags given"
  }

  assert {
    condition     = nullplatform_notification_channel.worker[0].configuration[0].agent[0].command[0].data["package"] == "nullplatform-aws-s3-bucket"
    error_message = "The channel runs the package's worker"
  }
}

run "the_channel_can_be_left_to_the_organization" {
  command = plan

  variables {
    create_channel = false
    agent_tags     = {}
  }

  assert {
    condition     = length(nullplatform_notification_channel.worker) == 0 && output.channel_id == null && length(output.resources) == 0
    error_message = "With create_channel = false nothing is created or reported"
  }
}

run "a_channel_needs_the_agent_tags" {
  command = plan

  variables {
    agent_tags = {}
  }

  expect_failures = [var.create_channel]
}
