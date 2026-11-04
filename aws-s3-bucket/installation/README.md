# Installation

Everything this service needs installed in an organization, in one place, written
by the package and run by the platform. It crosses the layers on purpose: the AWS
provider and the nullplatform provider live in the same root module, because an
installation is exactly a change that touches the cloud account and the platform
at once.

Each requirement is either **received as a parameter** or **provisioned here**:

| Requirement | Parameter | When the parameter is absent |
|---|---|---|
| Targets (one per cloud provider the NRN resolves, with its dimensions) | `targets` | Discovered: the `aws-configuration` providers visible from the NRN |
| IAM role the worker assumes | `targets.<key>.role_arn` | Created in that target's account, trusting the agent role |
| IAM provider the role is registered in (selector `s3`) | `targets.<key>.iam_provider_id` | Discovered for the target's dimensions; created when there is none |
| Agent channel routing the service's actions to the package worker | `create_channel` (default `true`) | Created, selecting the agent by `agent.tags` |

What the installation **reads and never writes**: the cloud providers (account,
region). What it **creates**, it owns and `uninstall` removes. What it **finds**,
it adopts: an existing IAM provider only gets this package's entry added (and
removed on uninstall); the provider itself is left alone.

## Contract with the runner

The entrypoints (`install`, `update`, `uninstall`, `status`) take two environment
variables, the ones `np package install` and the agent will set:

- `NP_INSTALL_CONTEXT`: JSON with `installation` (`id`, `nrn`, `package_slug`,
  `version`), `agent` (`role_arn`, `tags`) and `parameters` (`targets`,
  `create_channel`). Data only, never a secret.
- `NP_INSTALL_STATE`: path of the state file. The runner hands over the previous
  one and keeps the updated one; this module never needs a bucket of its own.

Credentials come from the environment, the way the worker already gets them:
`NULLPLATFORM_API_KEY` (what `np` and the Terraform provider read; the agent's
`NP_API_KEY` is bridged to it) and the runner's AWS credentials (a profile when
run locally, the agent's role when run by the agent). `NULLPLATFORM_HOST`
points at another API host. Nothing is resolved here.

Each entrypoint prints one JSON document on stdout, the installation's report:

```json
{ "outputs":   { "role_arn": { "default": "arn:aws:iam::123456789012:role/…" } },
  "resources": [ { "type": "aws_iam_role", "id": "arn:…", "target": "default", "ownership": "owned" }, … ],
  "missing":   [] }
```

`ownership` is `owned` (created here, removed on uninstall), `provided` (a
parameter) or `adopted` (found and reused, never removed). Logs go to stderr.

## Running it by hand

```bash
export NULLPLATFORM_API_KEY=…            # or NP_API_KEY, as the agent sets it
export AWS_PROFILE=my-profile
export NP_INSTALL_CONTEXT='{"installation":{"id":"…","nrn":"organization=…:account=…","package_slug":"nullplatform-aws-s3-bucket","version":"0.5.8"},
                            "agent":{"role_arn":"arn:aws:iam::123456789012:role/my-agent-role","tags":{"environment":"development"}},
                            "parameters":{}}'
export NP_INSTALL_STATE=/path/to/installation.tfstate
aws-s3-bucket/installation/install
```

With `parameters: {}` every target is discovered and every role is created. With
`"targets": {"production": {"dimensions": {"environment": "production"}, "role_arn": "arn:…"}}`
nothing is created in IAM for that target: the role is registered as provided.

## What is emulated until the platform has it

- **IAM provider entries.** The API updates a provider as a whole, so adding one
  entry to an IAM provider the organization already owns is done by
  `scripts/iam_role_entry` (read, merge, write) from a `terraform_data`
  resource. The right shape is an entry endpoint and a `nullplatform_iam_role_entry`
  resource that owns only its entry; the resource here is the seam where that
  swaps in.
- **Discovery.** The Terraform provider has no data source for provider configs,
  so `lib/context` resolves targets and IAM providers through the API before
  OpenTofu runs, walking up the NRN the way the platform does.
- **The agent's role and tags** come in the context; the platform knows them,
  the package does not.

## Known tightening point

`policies/s3-iam.json` is the policy `specs/requirements/aws` ships today, kept
identical so the role created here behaves like the one organizations already
run. It lets the worker create per-link IAM users with `Resource: "*"`. Scoping
it to a user path (`arn:aws:iam::*:user/nullplatform-s3/*`) and requiring a
permissions boundary on `iam:CreateUser` and `iam:PutUserPolicy` is the right
next step, but it needs the link workflow to create users under that path
first, so it is a change to the service, not to this folder.

## Layout

```
installation/
  install · update · uninstall · status   entrypoints (bash)
  lib/context                              NP_INSTALL_CONTEXT → tfvars, discovery
  scripts/iam_role_entry                   upsert/remove one entry of an IAM provider
  providers.tf · variables.tf · main.tf · outputs.tf
  policies/                                the role's policies (unchanged)
  tests/installation.tftest.hcl            plan-time tests with mocked providers
```
