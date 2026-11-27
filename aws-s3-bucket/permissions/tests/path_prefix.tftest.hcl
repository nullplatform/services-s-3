# path_prefix is a folder: the policy covers exactly `<prefix>/` and what is under it, or the whole
# bucket when empty, never a sibling that only starts with the same text (`team-a-secrets/`).
# The provider is mocked: nothing reaches AWS. Run with `tofu init -backend=false && tofu test`.

mock_provider "aws" {
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  # A mocked document is not JSON, and the policies' validation would refuse it. What this file
  # checks is the prefix the document is built from (the locals), not its rendering.
  override_data {
    target = data.aws_iam_policy_document.link
    values = { json = "{}" }
  }
}

variables {
  link_id        = "lnk-1"
  region         = "us-east-1"
  bucket_name    = "the-bucket"
  principal_name = "np-s3-0123456789abcdef"
}

run "a_prefix_without_slash_is_a_folder" {
  command = plan

  variables {
    path_prefix = "team-a"
  }

  assert {
    condition     = local.path_prefix == "team-a/"
    error_message = "team-a must read as team-a/"
  }
  assert {
    condition     = local.object_resource_arn == "arn:aws:s3:::the-bucket/team-a/*"
    error_message = "objects must be scoped to team-a/*, not team-a* (which reaches team-a-secrets/)"
  }
  assert {
    condition     = local.list_prefixes == tolist(["team-a/*", "team-a/"])
    error_message = "listing must be scoped to the team-a/ folder"
  }
}

run "a_prefix_with_slash_stays_as_it_is" {
  command = plan

  variables {
    path_prefix = "team-a/"
  }

  assert {
    condition     = local.object_resource_arn == "arn:aws:s3:::the-bucket/team-a/*"
    error_message = "team-a/ must not get a second slash"
  }
  assert {
    condition     = local.list_prefixes == tolist(["team-a/*", "team-a/"])
    error_message = "listing must be scoped to the team-a/ folder"
  }
}

run "a_nested_prefix_is_a_folder_too" {
  command = plan

  variables {
    path_prefix = "apps/team-a"
  }

  assert {
    condition     = local.object_resource_arn == "arn:aws:s3:::the-bucket/apps/team-a/*"
    error_message = "apps/team-a must read as apps/team-a/"
  }
}

run "no_prefix_is_the_whole_bucket" {
  command = plan

  assert {
    condition     = local.path_prefix == ""
    error_message = "an empty prefix must stay empty"
  }
  assert {
    condition     = local.object_resource_arn == "arn:aws:s3:::the-bucket/*"
    error_message = "no prefix must cover every object"
  }
  assert {
    condition     = length(local.list_prefixes) == 0
    error_message = "no prefix must list without a condition"
  }
}
