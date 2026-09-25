/**
 * The `connect` link: one IAM user per link, an inline policy scoped to the
 * bucket (and optional prefix), one access key the application receives as
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. Update rewrites the policy and
 * keeps the credentials; unlink removes the user. The bucket is never touched.
 */

import { handler, ActionError, type HandlerContext } from "@nullplatform/plugin/package";
import {
  CreateAccessKeyCommand,
  CreateUserCommand,
  DeleteAccessKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  ListAccessKeysCommand,
  PutUserPolicyCommand,
} from "@aws-sdk/client-iam";
import { awsSession, iam, isAwsError } from "./aws";
import { iamUserName, linkPolicy } from "./policy";
import { connect, type BucketAttributes, type ConnectAttributes } from "./resources";

type Ctx = HandlerContext<Record<string, unknown>, ConnectAttributes>;

interface Outputs {
  aws_access_key_id: string;
  aws_secret_access_key: string;
  iam_user_name: string;
}

const linkId = (ctx: Ctx) => String(ctx.link?.id ?? "");
const policyName = (ctx: Ctx) => `s3-access-${linkId(ctx)}`;

/** The bucket this link grants access to comes from the service's attributes, written by create. */
function bucketOf(ctx: Ctx): { name: string; arn: string } {
  const attrs = (ctx.service.attributes ?? {}) as BucketAttributes;
  if (!attrs.bucket_name || !attrs.bucket_arn) {
    throw ActionError.retry("BUCKET_NOT_READY", "the service has no bucket yet; link again once it is created");
  }
  return { name: attrs.bucket_name, arn: attrs.bucket_arn };
}

async function putPolicy(ctx: Ctx, client: ReturnType<typeof iam>, userName: string): Promise<void> {
  const { arn } = bucketOf(ctx);
  const policy = linkPolicy({ bucketArn: arn, accessLevel: ctx.params.access_level ?? "read-write", pathPrefix: ctx.params.path_prefix ?? "" });
  await ctx.step(`policy ${ctx.params.access_level ?? "read-write"}${ctx.params.path_prefix ? ` on ${ctx.params.path_prefix}` : ""}`, () =>
    client.send(new PutUserPolicyCommand({ UserName: userName, PolicyName: policyName(ctx), PolicyDocument: JSON.stringify(policy) })),
  );
}

export const create = handler<Record<string, unknown>, ConnectAttributes, Outputs>(connect, "create", async (ctx) => {
  const { name: bucketName } = bucketOf(ctx);
  const session = await awsSession(ctx, `np-aws-s3-link-${linkId(ctx)}`);
  const client = iam(session);
  const userName = ctx.params.iam_user_name || iamUserName(linkId(ctx));

  await ctx.step(`user ${userName}`, async () => {
    try {
      await client.send(
        new CreateUserCommand({
          UserName: userName,
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
  });
  await putPolicy(ctx, client, userName);

  // A retried create must not mint a second key: keep the one the link already has.
  if (ctx.params.aws_access_key_id && ctx.params.aws_secret_access_key) {
    ctx.log.detail("access key already issued, keeping it");
    return { aws_access_key_id: ctx.params.aws_access_key_id, aws_secret_access_key: ctx.params.aws_secret_access_key, iam_user_name: userName };
  }
  const key = await ctx.step("access key", async () => {
    const out = await client.send(new CreateAccessKeyCommand({ UserName: userName }));
    if (!out.AccessKey?.AccessKeyId || !out.AccessKey.SecretAccessKey) throw new ActionError("NO_ACCESS_KEY", "iam:CreateAccessKey returned no key");
    return out.AccessKey;
  });
  ctx.log.ok(`${userName} can reach ${bucketName}`);
  return { aws_access_key_id: key.AccessKeyId!, aws_secret_access_key: key.SecretAccessKey!, iam_user_name: userName };
});

/** Only the policy changes; credentials are preserved, as the link-update workflow did. */
export const update = handler<Record<string, unknown>, ConnectAttributes, Record<string, never>>(connect, "update", async (ctx) => {
  const userName = ctx.params.iam_user_name || iamUserName(linkId(ctx));
  const session = await awsSession(ctx, `np-aws-s3-link-${linkId(ctx)}`);
  await putPolicy(ctx, iam(session), userName);
  ctx.log.ok(`${userName} policy updated`);
  return {};
});

export const remove = handler<Record<string, unknown>, ConnectAttributes, void>(connect, "delete", async (ctx) => {
  const userName = ctx.params.iam_user_name || iamUserName(linkId(ctx));
  const session = await awsSession(ctx, `np-aws-s3-link-${linkId(ctx)}`);
  const client = iam(session);
  const gone = (err: unknown) => isAwsError(err, "NoSuchEntityException", "NoSuchEntity");

  await ctx.step(`remove ${userName}`, async () => {
    try {
      await client.send(new DeleteUserPolicyCommand({ UserName: userName, PolicyName: policyName(ctx) }));
    } catch (err) {
      if (!gone(err)) throw err;
    }
    try {
      const keys = await client.send(new ListAccessKeysCommand({ UserName: userName }));
      for (const k of keys.AccessKeyMetadata ?? []) {
        if (k.AccessKeyId) await client.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: k.AccessKeyId }));
      }
      await client.send(new DeleteUserCommand({ UserName: userName }));
    } catch (err) {
      if (!gone(err)) throw err;
      ctx.log.detail("already gone");
    }
  });
  ctx.log.ok(`${userName} removed; the bucket and its objects are untouched`);
});
