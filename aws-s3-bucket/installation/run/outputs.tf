# The installation's report, in the shape the runner prints (README).

output "outputs" {
  value = {
    role_arn        = module.account.role_arn
    iam_provider_id = { for name, environment in module.environment : name => environment.iam_provider_id }
    channel_id      = { for name, environment in module.environment : name => environment.channel_id }
  }
}

output "resources" {
  value = concat(module.account.resources, flatten([for environment in module.environment : environment.resources]))
}

output "missing" {
  value = []
}
