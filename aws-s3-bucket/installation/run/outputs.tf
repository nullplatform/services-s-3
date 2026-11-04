# The installation's report, in the shape the runner prints (README).

output "outputs" {
  value = {
    role_arn   = { for name, target in module.target : name => target.role_arn }
    channel_id = module.installation.channel_id
  }
}

output "resources" {
  value = concat(module.installation.resources, flatten([for target in module.target : target.resources]))
}

output "missing" {
  value = []
}
