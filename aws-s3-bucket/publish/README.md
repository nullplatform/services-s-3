# aws-s3-bucket publish

OpenTofu stack that publishes this service as the package `nullplatform-aws-s3-bucket` (specification "nullplatform AWS S3 Bucket"), visible to every organization. Only the release workflow runs it, through the shared [`publish-package`](https://github.com/nullplatform/actions-nullplatform#publish-package) workflow that [`release.yml`](../../.github/workflows/release.yml) enables with `package_stack_dir`; organizations install the package with [`../installation`](../installation).

Each apply publishes one immutable revision that pins:

- the service specification and link specifications from this checkout (`git_provider = "local"`);
- every action specification, including the ones the platform creates by default;
- the worker image the same release pushed, by digest.

The revision's version is `version.txt`. The apply refuses to publish when it does not match the release tag (`release_tag`, set by the workflow). Re-applying the same version is a no-op.

## Repository configuration

| Kind | Name | Purpose |
|---|---|---|
| secret | `ARTIFACT_NP_API_KEY` | API key of the publisher organization, already used to register the image. Passed as `package_np_api_key`, so it must also be allowed to write specs and packages |
| secret | `AWS_ROLE_ARN_PACKAGE_STATE` | OIDC role with access to the state bucket |
| variable | `PACKAGE_TFSTATE_BUCKET` | S3 bucket for package stack states (can be set once for the organization). Publishing is skipped while it is unset |
| variable | `PACKAGE_TFSTATE_REGION` | Region of that bucket |
| variable | `NP_ARTIFACT_NRN` | Publisher organization NRN (already used to register the image) |

## First publish

The platform creates the default action specifications when the service specification is created, so the package can only pin them on a later apply. Run the first apply once with `-var publish_package=false`; every release after that publishes normally.
