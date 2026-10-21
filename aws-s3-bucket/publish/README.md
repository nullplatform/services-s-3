# aws-s3-bucket publish

OpenTofu stack that publishes this service as the package `aws-s3-bucket`, visible to every organization. Only the `publish-package` job of [`release.yml`](../../.github/workflows/release.yml) runs it; organizations install the package with [`../installation`](../installation).

Each apply publishes one immutable revision that pins:

- the service specification and link specifications from this checkout (`git_provider = "local"`);
- every action specification, including the ones the platform creates by default;
- the worker image the same release pushed, by digest.

The revision's version is `version.txt`. The job refuses to run when it does not match the release tag. Re-applying the same version is a no-op.

## Repository configuration

| Kind | Name | Purpose |
|---|---|---|
| secret | `PACKAGE_NP_API_KEY` | API key of the publisher organization, allowed to write specs and packages |
| secret | `AWS_ROLE_ARN_PUBLISH_STATE` | OIDC role with access to the state bucket |
| variable | `PUBLISH_TFSTATE_BUCKET` | S3 bucket for this stack's state. The job is skipped while it is unset |
| variable | `PUBLISH_TFSTATE_REGION` | Region of that bucket |
| variable | `NP_ARTIFACT_NRN` | Publisher organization NRN (already used to register the image) |

## First publish

The platform creates the default action specifications when the service specification is created, so the package can only pin them on a later apply. Run the first apply once with `-var publish_package=false`; every release after that publishes normally.
