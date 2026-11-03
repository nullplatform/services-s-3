# aws-s3-bucket installation

OpenTofu module that installs the `nullplatform-aws-s3-bucket` package (specification "nullplatform AWS S3 Bucket") in your organization, at the version of the tag you reference. The package is published once for every organization; this module does not copy it.

It is only the nullplatform side of the installation, so it goes in the layer of your stack that registers specifications. The IAM role the service assumes and the agent channel stay in the layers that already hold them. See [Install in your organization](../../README.md#install-in-your-organization) for the three layers together.

## Usage

```hcl
module "s3" {
  source = "git::https://github.com/nullplatform/services-s-3.git//aws-s3-bucket/installation?ref=v0.5.6"

  nrn = "organization=123:account=456"
}
```

**Upgrade**: move `ref` to a newer tag and apply. New services are born with the new version; existing services keep theirs until they are moved one by one.

Already registered this service with `service_definition`? This module goes next to it in the same layer, and its outputs have the same names. See [Already registered with `service_definition`?](../../README.md#already-registered-with-service_definition).

Use this module to keep receiving updates. Fork the repository only when you need to extend the service substantially; see [Global package or fork?](../../README.md#global-package-or-fork) for what a fork costs.

## Prerequisites

- **Providers**: an AWS cloud provider exposing `account.region`, configured at `nrn` or above it.
- **Credentials for the apply**: a nullplatform API key (`NULLPLATFORM_API_KEY`) that can install packages at `nrn`.

## Inputs

| Name | Description | Default |
|---|---|---|
| `nrn` | NRN of your organization where the service is installed | required |
| `visible_to` | Where inside your organization the service can be used | `[nrn]` |

## Outputs

| Name | Description |
|---|---|
| `service_specification_id` | Id of the service specification |
| `service_specification_slug` | Slug of the service specification: what the agent channel filters on |
| `package_slug` | Slug of the package: the `package_slug` of the agent channel |
| `package_id` | Id of the installed package |
| `installed_version` | Version new services are born with (also `package_default_version`) |
| `installation_id` | Id of the package installation |
| `missing_optional_requirements` | Optional providers the package can use that you have not configured |
