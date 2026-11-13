# The stack used to call service_definition directly; the module now wraps it.
# OpenTofu follows the state to the new addresses instead of recreating the
# specification and the package, which would be refused (installed
# specifications have instances) and would mint a second package.
moved {
  from = module.service_definition
  to   = module.publish.module.service_definition
}

# The guards the stack used to carry are the module's variable validations
# now; the terraform_data that held them leaves the state without a destroy.
removed {
  from = terraform_data.release_guard

  lifecycle {
    destroy = false
  }
}
