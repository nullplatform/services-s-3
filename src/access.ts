/**
 * The `connect` link: one IAM user per link, an inline policy scoped to the
 * bucket (and an optional prefix), one access key the application receives
 * as AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
 *
 * Update rewrites the policy and keeps the credentials. Delete removes the
 * user. The bucket and its objects are never touched from here.
 */

import { ActionError, type ContextOf } from "@nullplatform/plugin/package";
import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  ListAccessKeysCommand,
  PutUserPolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { iam, isAwsError, session } from "./aws";
import { iamUserName, linkPolicy } from "./policy";
import type { BucketAttributes } from "./resources";
import type { connect } from "./resources";

type Context = ContextOf<typeof connect>;

export interface AccessOutputs {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  iam_user_name: string;
}

const linkId = (ctx: Context) => String(ctx.link?.id ?? "");
const userName = (ctx: Context) => ctx.params.iam_user_name || iamUserName(linkId(ctx));
const policyName = (ctx: Context) => `s3-access-${linkId(ctx)}`;
const sessionName = (ctx: Context) => `np-aws-s3-link-${linkId(ctx)}`;

export async function create(ctx: Context): Promise<AccessOutputs> {
  const { name: bucketName } = bucketOf(ctx);
  const client = iam(await session(ctx, sessionName(ctx)));
  const user = userName(ctx);

  await ctx.step(`user ${user}`, () => ensureUser(ctx, client, user, bucketName));
  await ctx.step(describePolicy(ctx), () => putPolicy(ctx, client, user));
  const key = await ctx.step("access key", () => issueKey(ctx, client, user));

  ctx.log.ok(`${user} can reach ${bucketName}`);
  return { aws_access_key_id: key.id, aws_secret_access_key: key.secret, iam_user_name: user };
}

export async function update(ctx: Context): Promise<Record<string, never>> {
  const client = iam(await session(ctx, sessionName(ctx)));
  const user = userName(ctx);
  await ctx.step(describePolicy(ctx), () => putPolicy(ctx, client, user));
  ctx.log.ok(`${user} policy updated`);
  return {};
}

export async function remove(ctx: Context): Promise<void> {
  const client = iam(await session(ctx, sessionName(ctx)));
  const user = userName(ctx);
  await ctx.step(`remove ${user}`, () => deleteUser(ctx, client, user, policyName(ctx)));
  ctx.log.ok(`${user} removed; the bucket and its objects are untouched`);
}

// ─── Steps ────────────────────────────────────────────────────────────

/** The bucket comes from the service's attributes, written by its create. */
function bucketOf(ctx: Context): { name: string; arn: string } {
  const attrs = (ctx.service.attributes ?? {}) as BucketAttributes;
  if (!attrs.bucket_name || !attrs.bucket_arn) {
    throw ActionError.retry("BUCKET_NOT_READY", "the service has no bucket yet; link again once it is created");
  }
  return { name: attrs.bucket_name, arn: attrs.bucket_arn };
}

const describePolicy = (ctx: Context) =>
  `policy ${ctx.params.access_level ?? "read-write"}${ctx.params.path_prefix ? ` on ${ctx.params.path_prefix}` : ""}`;

async function ensureUser(ctx: Context, client: IAMClient, user: string, bucketName: string): Promise<void> {
  try {
    await client.send(
      new CreateUserCommand({
        UserName: user,
        Tags: [
          { Key: "managed-by", Value: "nullplatform" },
          { Key: "link-id", Value: linkId(ctx) },
          { Key: "bucket", Value: bucketName },
        ],
      }),
    );
  } catch (err) {
    if (!isAwsError(err, "EntityAlreadyExistsException", "EntityAlreadyExists")) throw err;
    ctx.log.detail("exists, reusing it");
  }
}

async function putPolicy(ctx: Context, client: IAMClient, user: string): Promise<void> {
  const policy = linkPolicy({
    bucketArn: bucketOf(ctx).arn,
    accessLevel: ctx.params.access_level ?? "read-write",
    pathPrefix: ctx.params.path_prefix ?? "",
  });
  await client.send(
    new PutUserPolicyCommand({ UserName: user, PolicyName: policyName(ctx), PolicyDocument: JSON.stringify(policy) }),
  );
}

/** A retried create must not mint a second key: the one the link already has is kept. */
async function issueKey(ctx: Context, client: IAMClient, user: string): Promise<{ id: string; secret: string }> {
  const { aws_access_key_id: id, aws_secret_access_key: secret } = ctx.params;
  if (id && secret) {
    ctx.log.detail("access key already issued, keeping it");
    return { id, secret };
  }
  const out = await client.send(new CreateAccessKeyCommand({ UserName: user }));
  if (!out.AccessKey?.AccessKeyId || !out.AccessKey.SecretAccessKey) {
    throw new ActionError("NO_ACCESS_KEY", "iam:CreateAccessKey returned no key");
  }
  return { id: out.AccessKey.AccessKeyId, secret: out.AccessKey.SecretAccessKey };
}

/** Policy, then every key, then the user. A user that is already gone is not an error. */
async function deleteUser(ctx: Context, client: IAMClient, user: string, policy: string): Promise<void> {
  const gone = (err: unknown) => isAwsError(err, "NoSuchEntityException", "NoSuchEntity");
  try {
    await client.send(new DeleteUserPolicyCommand({ UserName: user, PolicyName: policy }));
  } catch (err) {
    if (!gone(err)) throw err;
  }
  try {
    const keys = await client.send(new ListAccessKeysCommand({ UserName: user }));
    for (const key of keys.AccessKeyMetadata ?? []) {
      if (key.AccessKeyId)
        await client.send(new DeleteAccessKeyCommand({ UserName: user, AccessKeyId: key.AccessKeyId }));
    }
    await client.send(new DeleteUserCommand({ UserName: user }));
  } catch (err) {
    if (!gone(err)) throw err;
    ctx.log.detail("already gone");
  }
}
