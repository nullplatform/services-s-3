/**
 * The service: create, update and delete the bucket. Idempotent by design —
 * update is create applied to an existing bucket — so a retried action never
 * fails on "already exists".
 */

import { handler, ActionError, type HandlerContext } from "@nullplatform/plugin/package";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  DeletePublicAccessBlockCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketEncryptionCommand,
  PutBucketTaggingCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { awsSession, isAwsError, s3 } from "./aws";
import { bucketNameFor } from "./policy";
import { bucket, type BucketAttributes } from "./resources";

type Ctx = HandlerContext<Record<string, unknown>, BucketAttributes>;

interface Outputs {
  bucket_name: string;
  bucket_arn: string;
  bucket_region: string;
}

const serviceName = (ctx: Ctx) => String(ctx.service.name ?? "");
const serviceId = (ctx: Ctx) => String(ctx.service.id ?? "");

/** The bucket name is decided once: the one already on the service, else derived from name + suffix. */
function resolveBucketName(ctx: Ctx): string {
  const existing = ctx.params.bucket_name;
  if (existing) return existing;
  if (!ctx.params.bucket_name_suffix) throw new ActionError("MISSING_SUFFIX", "bucket_name_suffix is required");
  return bucketNameFor(serviceName(ctx), serviceId(ctx), ctx.params.bucket_name_suffix);
}

async function exists(client: ReturnType<typeof s3>, name: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch (err) {
    if (isAwsError(err, "NotFound", "NoSuchBucket")) return false;
    throw err;
  }
}

/** Create if missing, then converge versioning, encryption and public access. */
async function converge(ctx: Ctx): Promise<Outputs> {
  const session = await awsSession(ctx, `np-aws-s3-bucket-${serviceId(ctx)}`);
  const client = s3(session);
  const name = resolveBucketName(ctx);
  const p = ctx.params;

  await ctx.step(`bucket ${name}`, async () => {
    if (await exists(client, name)) {
      ctx.log.detail("exists, converging its configuration");
      return;
    }
    await client.send(
      new CreateBucketCommand({
        Bucket: name,
        ...(session.region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: session.region as BucketLocationConstraint } }),
      }),
    );
    await client.send(new PutBucketTaggingCommand({ Bucket: name, Tagging: { TagSet: [{ Key: "managed-by", Value: "nullplatform" }, { Key: "service-id", Value: serviceId(ctx) }] } }));
    ctx.log.detail("created");
  });

  await ctx.step("versioning", () =>
    client.send(new PutBucketVersioningCommand({ Bucket: name, VersioningConfiguration: { Status: p.versioning === false ? "Suspended" : "Enabled" } })),
  );

  await ctx.step("encryption", () =>
    client.send(
      new PutBucketEncryptionCommand({
        Bucket: name,
        ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: p.encryption === "aws:kms" ? "aws:kms" : "AES256" } }] },
      }),
    ),
  );

  await ctx.step("public access", () =>
    p.public_access_block === false
      ? client.send(new DeletePublicAccessBlockCommand({ Bucket: name }))
      : client.send(
          new PutPublicAccessBlockCommand({
            Bucket: name,
            PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
          }),
        ),
  );

  const outputs = { bucket_name: name, bucket_arn: `arn:aws:s3:::${name}`, bucket_region: session.region };
  ctx.log.ok(`${name} ready in ${session.region}`);
  return outputs;
}

export const create = handler<Record<string, unknown>, BucketAttributes, Outputs>(bucket, "create", converge);
export const update = handler<Record<string, unknown>, BucketAttributes, Outputs>(bucket, "update", converge);

/** Empties the bucket when force_destroy says so, then deletes it. Never touches a bucket it did not name. */
export const remove = handler<Record<string, unknown>, BucketAttributes, void>(bucket, "delete", async (ctx) => {
  const name = ctx.params.bucket_name;
  if (!name) {
    ctx.log.detail("the service never got a bucket_name; nothing to delete");
    return;
  }
  const session = await awsSession(ctx, `np-aws-s3-bucket-${serviceId(ctx)}`);
  const client = s3(session);
  if (!(await exists(client, name))) {
    ctx.log.detail(`${name} is already gone`);
    return;
  }

  if (ctx.params.force_destroy) {
    await ctx.step("empty the bucket", async () => {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      let removed = 0;
      do {
        const page = await client.send(new ListObjectVersionsCommand({ Bucket: name, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
        const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((o) => ({ Key: o.Key!, VersionId: o.VersionId }));
        if (objects.length) {
          await client.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: objects, Quiet: true } }));
          removed += objects.length;
        }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
      } while (keyMarker || versionIdMarker);
      ctx.log.detail(`${removed} object versions removed`);
    });
  }

  await ctx.step(`delete ${name}`, async () => {
    try {
      await client.send(new DeleteBucketCommand({ Bucket: name }));
    } catch (err) {
      if (isAwsError(err, "BucketNotEmpty")) {
        throw new ActionError("BUCKET_NOT_EMPTY", `${name} still has objects; set force_destroy to delete it anyway`);
      }
      throw err;
    }
  });
  ctx.log.ok(`${name} deleted`);
});
