# Installation

Everything this service needs installed in an organization, written by the
package as an OpenTofu module the organization calls from its own Terraform,
the way it calls any vendor's module. It crosses the layers on purpose: the AWS
provider and the nullplatform provider live in the same module, because an
installation is exactly a change that touches the cloud account and the
platform at once.

```
installation/target/     module, once per AWS account: the role the worker assumes, registered in the IAM provider, and the agent channel
installation/run/        a runner root for installing without a Terraform repository (np package install, or by hand)
```

A service has nothing of its own on the platform side (no scope type, settings
or schema), so everything is per account: one `target` per AWS account, each
with that account's provider alias and agent.

## From the organization's Terraform

```hcl
provider "nullplatform" {}                     # NULLPLATFORM_API_KEY from the environment
provider "aws" { alias = "dev";  region = "us-east-1"; profile = "dev" }
provider "aws" { alias = "prod"; region = "us-east-1"; assume_role { role_arn = "arn:aws:iam::222222222222:role/platform-admin" } }

locals {
  s3_installation = { id = nullplatform_package_installation.s3.id, nrn = var.nrn, package_slug = "nullplatform-aws-s3-bucket", version = "0.5.8" }
}

module "s3_dev" {
  source         = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation/target?ref=v0.5.8"
  providers      = { aws = aws.dev }
  installation   = local.s3_installation
  name           = "development"
  dimensions     = { environment = "development" }
  agent_role_arn = module.agent_dev.role_arn
  agent_tags     = { environment = "development" }     # this account's agent; the channel routes only development services to it
}                                                      # role and IAM provider: created in dev

module "s3_prod" {
  source          = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation/target?ref=v0.5.8"
  providers       = { aws = aws.prod }
  installation    = local.s3_installation
  name            = "production"
  dimensions      = { environment = "production" }
  agent_role_arn  = module.agent_prod.role_arn
  agent_tags      = { environment = "production" }
  role_arn        = "arn:aws:iam::222222222222:role/their-s3-role"   # bring your own; null creates one
  iam_provider_id = module.bindings.iam_provider_prod_id             # register in an existing provider; null creates one
}                                                                     # only registers: the s3 entry and the channel
```

Each requirement is **received as a parameter** or **provisioned here**:

| Requirement | Parameter | When the parameter is absent |
|---|---|---|
| Role the worker assumes | `role_arn` | created in that account, trusting `agent_role_arn` |
| IAM provider the role is registered in (selector `s3`) | `iam_provider_id` | created at the installation NRN with the target's dimensions; when given, only this package's entry is added |
| Agent channel, one per target because the agent is per account | `channel_id`, `create_channel` | created, selecting that account's agent by `agent_tags` and routing only the target's dimensions |

The organization's state is the memory: ownership, idempotency, upgrades
(`ref` moves) and removal (`destroy`) are OpenTofu's. The module still
reports what it touched in its `resources` output, marked `owned` or
`provided`, for whoever wants to show it.

## Without a Terraform repository: the runner

`run/` is a root that configures the providers from the environment and calls
the target module once per dimension set, for one account. Its entrypoints
(`install`, `update`, `uninstall`, `status`) take:

- `NP_INSTALL_CONTEXT`: JSON with `installation` (`id`, `nrn`, `package_slug`,
  `version`), `agent` (`role_arn`, `tags`) and `parameters` (`targets`,
  `create_channel`). Data only, never a secret.
- `NP_INSTALL_STATE`: path of the state file the runner keeps between runs.

Credentials come from the environment, the way the worker already gets them:
`NULLPLATFORM_API_KEY` (the agent's `NP_API_KEY` is bridged to it) and the
runner's AWS credentials. `NULLPLATFORM_HOST` points at another API host.

`run/lib/context` is what makes the runner different from the module: when
`parameters` leaves something out, it resolves it through the API (targets
from the cloud providers visible from the NRN, the IAM provider and an
existing channel for each target's dimensions), and it keeps what the
previous report marked as owned out of discovery, so a second run reconciles
instead of adopting its own resources. An organization with its own Terraform
never runs it: it fills the module variables from its own outputs.

Each entrypoint prints the installation's report on stdout:

```json
{ "outputs":   { "role_arn": { "production": "arn:aws:iam::…" }, "channel_id": { "production": "…" } },
  "resources": [ { "type": "aws_iam_role", "id": "arn:…", "target": "production", "ownership": "owned" }, … ],
  "missing":   [] }
```

## What is emulated until the platform has it

- **IAM provider entries.** The API updates a provider as a whole, so adding one
  entry to an existing IAM provider is done by `target/scripts/iam_role_entry`
  (read, merge, write) from a `terraform_data` resource. An entry endpoint and
  a `nullplatform_iam_role_entry` resource would replace it at that seam.
- **Discovery** in the runner, because the Terraform provider has no data source
  for provider configs or channels. With them, the module could look things up
  itself and the runner would lose most of `lib/context`.

## Known tightening point

`target/policies/s3-iam.json` is the policy `specs/requirements/aws` ships
today, kept identical so the role created here behaves like the one
organizations already run. It lets the worker create per-link IAM users with
`Resource: "*"`. Scoping it to a user path and requiring a permissions boundary
is the right next step, but it needs the link workflow to create users under
that path first, so it is a change to the service, not to this folder.
