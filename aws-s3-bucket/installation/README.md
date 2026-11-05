# Installation

Everything this service needs installed in an organization, written by the
package as OpenTofu modules the organization calls from its own Terraform,
the way it calls any vendor's module. It crosses the layers on purpose: an
installation is exactly a change that touches the cloud account and the
platform at once, so the modules are cut by what they touch, not by layer.

```
installation/account/      module, once per AWS account: the role the worker assumes          (aws provider)
installation/environment/  module, once per dimension set: IAM provider entry, agent channel   (nullplatform provider)
installation/run/          a runner root for installing without a Terraform repository (np package install, or by hand)
```

A service has nothing of its own on the platform side (no scope type,
settings or schema), so there is no platform module. `account` and
`environment` are separate because they are counted differently: an
organization with development and staging in one account and production in
another has two accounts and three environments. Each environment takes the
role of the account it runs in, so two environments in one account never
create a second role.

## From the organization's Terraform

```hcl
provider "nullplatform" {}                     # NULLPLATFORM_API_KEY from the environment
provider "aws" { alias = "dev";  region = "us-east-1"; profile = "dev" }
provider "aws" { alias = "prod"; region = "us-east-1"; assume_role { role_arn = "arn:aws:iam::123456789012:role/platform-admin" } }

locals {
  s3_installation = { id = nullplatform_package_installation.s3.id, nrn = var.nrn, package_slug = "nullplatform-aws-s3-bucket", version = "0.5.8" }
}

module "s3_account_dev" {                                       # once per account
  source         = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation/account?ref=v0.5.8"
  providers      = { aws = aws.dev }
  installation   = local.s3_installation
  name           = "dev"
  agent_role_arn = module.agent_dev.role_arn
}

module "s3_account_prod" {
  source         = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation/account?ref=v0.5.8"
  providers      = { aws = aws.prod }
  installation   = local.s3_installation
  name           = "prod"
  agent_role_arn = module.agent_prod.role_arn
  role_arn       = "arn:aws:iam::123456789012:role/their-s3-role"   # bring your own; null creates one
}

module "s3_development" {                                       # once per environment, from its account
  source       = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation/environment?ref=v0.5.8"
  installation = local.s3_installation
  name         = "development"
  dimensions   = { environment = "development" }
  role_arn     = module.s3_account_dev.role_arn
  agent_tags   = { environment = "development" }     # the dev account's agent; the channel routes only development services to it
}

module "s3_staging" {                                           # same account as development: nothing new in the cloud
  source       = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation/environment?ref=v0.5.8"
  installation = local.s3_installation
  name         = "staging"
  dimensions   = { environment = "staging" }
  role_arn     = module.s3_account_dev.role_arn
  agent_tags   = { environment = "development" }
}

module "s3_production" {
  source          = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation/environment?ref=v0.5.8"
  installation    = local.s3_installation
  name            = "production"
  dimensions      = { environment = "production" }
  role_arn        = module.s3_account_prod.role_arn
  agent_tags      = { environment = "production" }
  iam_provider_id = module.bindings.iam_provider_prod_id             # register in an existing provider; null creates one
}
```

Each requirement is **received as a parameter** or **provisioned here**:

| Requirement | Module | Parameter | When the parameter is absent |
|---|---|---|---|
| Role the worker assumes | `account` | `role_arn` | created in that account, trusting `agent_role_arn` |
| IAM provider the role is registered in (selector `s3`) | `environment` | `iam_provider_id` | created at the installation NRN with the environment's dimensions; when given, only this package's entry is added |
| Agent channel | `environment` | `channel_id`, `create_channel` | created, selecting the agent by `agent_tags` and routing only the environment's dimensions |

The organization's state is the memory: ownership, idempotency, upgrades
(`ref` moves) and removal (`destroy`) are OpenTofu's. The modules still
report what they touched in their `resources` output, marked `owned` or
`provided`, for whoever wants to show it.

## Without a Terraform repository: the runner

`run/` is a root that configures the providers from the environment and calls
`account` once (one AWS provider, so one account) and `environment` once per
dimension set. Installing a second account is a second run with its own
`NP_INSTALL_STATE`. Its entrypoints (`install`, `update`, `uninstall`,
`status`) take:

- `NP_INSTALL_CONTEXT`: JSON with `installation` (`id`, `nrn`, `package_slug`,
  `version`), `agent` (`role_arn`, `tags`) and `parameters`: `account` (its
  `name` and an existing `role_arn`) and `environments` (one entry per
  dimension set, with what each already has on the platform). Data only,
  never a secret.
- `NP_INSTALL_STATE`: path of the state file the runner keeps between runs.

Credentials come from the environment, the way the worker already gets them:
`NULLPLATFORM_API_KEY` (the agent's `NP_API_KEY` is bridged to it) and the
runner's AWS credentials. `NULLPLATFORM_HOST` points at another API host.

`run/lib/context` is what makes the runner different from the modules: when
`parameters` leaves something out, it resolves it through the API (the
environments from the cloud providers visible from the NRN, the account's
role when an environment's IAM provider already lists one under `s3`, and
per environment its IAM provider and an existing channel for its
dimensions), and it keeps what the previous report marked as owned out of
discovery, so a second run reconciles instead of adopting its own resources.
An organization with its own Terraform never runs it: it fills the module
variables from its own outputs.

Each entrypoint prints the installation's report on stdout:

```json
{ "outputs":   { "role_arn": "arn:aws:iam::…", "iam_provider_id": { "development": "…", "staging": "…" }, "channel_id": { "development": "…", "staging": "…" } },
  "resources": [ { "type": "aws_iam_role", "id": "arn:…", "account": "default", "ownership": "owned" },
                 { "type": "provider_config", "id": "…", "environment": "staging", "ownership": "provided" }, … ],
  "missing":   [] }
```

## What is emulated until the platform has it

- **IAM provider entries.** The API updates a provider as a whole, so adding one
  entry to an existing IAM provider is done by `environment/scripts/iam_role_entry`
  (read, merge, write) from a `terraform_data` resource. An entry endpoint and
  a `nullplatform_iam_role_entry` resource would replace it at that seam.
- **Discovery** in the runner, because the Terraform provider has no data source
  for provider configs or channels. With them, the modules could look things up
  themselves and the runner would lose most of `lib/context`.

## Known tightening point

`account/policies/s3-iam.json` is the policy `specs/requirements/aws` ships
today, kept identical so the role created here behaves like the one
organizations already run. It lets the worker create per-link IAM users with
`Resource: "*"`. Scoping it to a user path and requiring a permissions boundary
is the right next step, but it needs the link workflow to create users under
that path first, so it is a change to the service, not to this folder.
