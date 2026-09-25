# AWS S3 Bucket

A nullplatform **dependency service**: an Amazon S3 bucket, and one IAM user
per linked application with permissions scoped to that bucket. Applications
get `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from their link and
`BUCKET_NAME` / `BUCKET_ARN` / `BUCKET_REGION` from the service.

This repository is a **package**: the service and its link are declared in
code with `@nullplatform/plugin`, every action is a TypeScript function that
talks to AWS with the AWS SDK, and one `np package publish` registers all of
it. No shell, no YAML workflows, no Terraform state.

## Layout

```
src/
  resources.ts   the service (aws-s3-bucket) and its link (connect): the specs, as values
  package.ts     definePackage: resources + handlers
  main.ts        the worker entrypoint
  aws.ts         region and credentials from the platform's providers (STS AssumeRole)
  bucket.ts      create / update / delete the bucket        (@aws-sdk/client-s3)
  access.ts      link create / update / delete: IAM user, policy, access key (@aws-sdk/client-iam)
  policy.ts      the link policy document, user and bucket names — pure functions
test/            pkg.run() against mocked AWS clients
requirements/    one-time IAM: the role the agent assumes, applied by an account operator
Dockerfile       the worker image, non-root
mise.toml        describe · test · build · build:image · run
```

## What each action does

| Action | Does |
|---|---|
| `create` | Creates `np-<service>-<suffix>` in the account's region with tags, then converges versioning, default encryption and the public access block. Returns `bucket_name`, `bucket_arn`, `bucket_region`. |
| `update` | The same convergence on the existing bucket. |
| `delete` | Deletes the bucket. With `force_destroy` it removes every object version first; otherwise a non-empty bucket fails with `BUCKET_NOT_EMPTY`. |
| link `create` | Creates IAM user `np-s3-<link id>`, puts the inline policy for `access_level` and `path_prefix`, issues one access key. Returns the credentials. A retried create keeps the key already issued. |
| link `update` | Rewrites the policy. Credentials are preserved. |
| link `delete` | Removes policy, keys and user. The bucket and its objects are untouched. |

Before the service has a bucket, a link fails with `BUCKET_NOT_READY`, retryable.

## Attributes

Service (`src/resources.ts`): `bucket_name_suffix` (create only), `versioning`,
`encryption` (`AES256` | `aws:kms`), `public_access_block`, `force_destroy`;
written back: `bucket_name`, `bucket_arn`, `bucket_region`.

Link: `access_level` (`read` | `write` | `read-write`), `path_prefix`; written
back: `aws_access_key_id`, `aws_secret_access_key` (secret), `iam_user_name`.

## AWS access

Region comes from the account's `cloud-providers` configuration
(`account.region`). Credentials: the `identity-access-control` provider names
the role to assume by selector `s3` (`iam_role_arns.arns[]`); without one the
worker keeps the agent's own credentials. `requirements/aws` provisions that
role and the permissions it needs (`s3:*` on `np-*` buckets, IAM user
management on `np-s3-*`).

## Develop

```bash
mise run test                 # pkg.run() with the AWS SDK mocked
mise run describe             # the manifest np package publish sends
np package run                # a real agent on your machine, tagged local:<you>
np package publish --nrn organization=…:account=… --bump minor
```
