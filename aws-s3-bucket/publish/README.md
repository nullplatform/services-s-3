# aws-s3-bucket publish

OpenTofu stack that publishes this service as the package `np-aws-s3-bucket` (specification "AWS S3 Bucket"), visible to every organization. Only the release workflow runs it, through the shared [`publish-package`](https://github.com/nullplatform/actions-nullplatform#publish-package) workflow that [`release.yml`](../../.github/workflows/release.yml) enables with `package_stack_dir`; organizations install the package with tofu-modules' `service_package_installation` (see the repository README).

Each apply publishes one immutable revision that pins:

- the service specification and link specifications from this checkout (`git_provider = "local"`);
- every action specification, including the ones the platform creates by default;
- the worker image the same release pushed, by digest.

The revision's version is `version.txt`. The apply refuses to publish when it does not match the release tag (`release_tag`, set by the workflow). Re-applying the same version is a no-op.

## Which revision becomes the default

Not every publish moves the package default, the revision an organization that installs without pinning a version is born with. A stable release promotes itself; a prerelease (any version with a `-`, such as `0.6.0-rc.1`) is published without moving the default, so it can be installed by version to try it. `promote_default` (`-var promote_default=false`, or `true`) forces either way.

## Repository configuration

| Kind | Name | Purpose |
|---|---|---|
| secret | `ARTIFACT_NP_API_KEY` | API key of the publisher organization, already used to register the image. Passed as `package_np_api_key`, so it must also be allowed to write specs and packages |
| secret | `AWS_ROLE_ARN_PACKAGE_STATE` | OIDC role with access to the state bucket |
| secret | `PACKAGE_TFSTATE_BUCKET` | S3 bucket for package stack states. Publishing is skipped while it is unset. A secret, not a variable: this repository is public and so are its run logs, and GitHub masks only secrets |
| secret | `PACKAGE_TFSTATE_REGION` | Region of that bucket, a secret for the same reason |
| variable | `NP_ARTIFACT_NRN` | Publisher organization NRN (already used to register the image) |

## First publish

The platform creates the default action specifications when the service specification is created, so the package can only pin them on a later apply. Run the first apply once with `-var publish_package=false`; every release after that publishes normally.
