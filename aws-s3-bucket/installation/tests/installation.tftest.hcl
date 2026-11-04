mock_provider "aws" {}
mock_provider "nullplatform" {}

# What lib/context hands over for an installation with two targets, one per
# environment, where nothing was given: both roles and both providers are
# created. The runs below vary what is provided.
variables {
  installation = {
    id           = "0f4c2d1e-aaaa-bbbb-cccc-000000000001"
    nrn          = "organization=1:account=2"
    package_slug = "nullplatform-aws-s3-bucket"
    version      = "0.5.8"
  }
  agent = {
    role_arn = "arn:aws:iam::123456789012:role/nullplatform-agent-role"
    tags     = { environment = "development" }
  }
  targets = {
    development = { dimensions = { environment = "development" } }
    production  = { dimensions = { environment = "production" } }
  }
}

run "nothing_provided_creates_a_role_and_an_iam_provider_per_target" {
  command = plan

  assert {
    condition     = length(aws_iam_role.s3) == 2 && length(nullplatform_provider_config.iam) == 2 && length(terraform_data.iam_role_entry) == 0
    error_message = "With no role_arn and no iam_provider_id, every target gets its own role and its own IAM provider"
  }

  assert {
    condition     = alltrue([for role in aws_iam_role.s3 : can(regex("nullplatform-agent-role", role.assume_role_policy))])
    error_message = "Every created role must trust the agent role from the context"
  }

  assert {
    condition     = aws_iam_role.s3["production"].name == "nullplatform-nullplatform-aws-s3-bucket-0f4c2d1e-production"
    error_message = "Role names carry the package, a suffix of the installation id and the target, so two installations in one account do not collide"
  }

  assert {
    condition     = length(nullplatform_notification_channel.worker) == 1 && nullplatform_notification_channel.worker[0].configuration[0].agent[0].selector == tomap({ environment = "development" })
    error_message = "The channel selects the agent by the tags from the context"
  }
}

run "a_provided_role_is_registered_but_not_created" {
  command = plan

  variables {
    targets = {
      production = { dimensions = { environment = "production" }, role_arn = "arn:aws:iam::123456789012:role/their-s3-role" }
    }
  }

  assert {
    condition     = length(aws_iam_role.s3) == 0
    error_message = "A target with role_arn must not get a role created"
  }

  assert {
    condition     = can(regex("their-s3-role", nullplatform_provider_config.iam["production"].attributes))
    error_message = "The provided role is the one registered under selector s3"
  }

  assert {
    condition     = contains([for r in output.resources : r.ownership if r.type == "aws_iam_role"], "provided")
    error_message = "The report must mark the provided role as provided, so uninstall leaves it alone"
  }
}

run "an_existing_iam_provider_is_adopted_and_only_gets_an_entry" {
  command = plan

  variables {
    targets = {
      production = { dimensions = { environment = "production" }, iam_provider_id = "prov-existing" }
    }
  }

  assert {
    condition     = length(nullplatform_provider_config.iam) == 0 && length(terraform_data.iam_role_entry) == 1
    error_message = "A target with iam_provider_id must not get a provider created; it gets one entry"
  }

  assert {
    condition     = terraform_data.iam_role_entry["production"].triggers_replace.provider_id == "prov-existing" && terraform_data.iam_role_entry["production"].triggers_replace.selector == "s3"
    error_message = "The entry targets the given provider under selector s3"
  }

  assert {
    condition     = contains([for r in output.resources : r.ownership if r.type == "provider_config"], "adopted")
    error_message = "The report must mark the existing provider as adopted"
  }
}

run "the_channel_can_be_left_to_the_organization" {
  command = plan

  variables {
    create_channel = false
  }

  assert {
    condition     = length(nullplatform_notification_channel.worker) == 0
    error_message = "With create_channel = false no channel may be created"
  }
}

run "a_created_iam_provider_is_of_the_aws_iam_type_at_the_installation_nrn" {
  command = plan

  assert {
    condition     = alltrue([for provider in nullplatform_provider_config.iam : provider.type == "aws-iam-configuration" && provider.nrn == "organization=1:account=2"])
    error_message = "A created IAM provider must be an aws-iam-configuration at the installation NRN, with the target's dimensions"
  }

  assert {
    condition     = nullplatform_provider_config.iam["production"].dimensions == tomap({ environment = "production" })
    error_message = "The created provider carries the target's dimensions, so the runtime resolves it for scopes and services in that environment"
  }
}
