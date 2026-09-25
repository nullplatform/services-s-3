/**
 * The bucket: create, update, delete.
 *
 * Create and update are the same convergence — make the bucket exist, then
 * apply versioning, default encryption and the public access block — so a
 * retried action never fails on "already exists". Delete empties the bucket
 * first only when `force_destroy` says so.
 */

import { ActionError, type ContextOf } from "@nullplatform/plugin/package";
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
  type S3Client,
} from "@aws-sdk/client-s3";
import { isAwsError, s3, session } from "./aws";
import { bucketNameFor } from "./policy";
import type { bucket } from "./resources";

type Context = ContextOf<typeof bucket>;

export interface BucketOutputs {
  bucket_name: string;
  bucket_arn: string;
  bucket_region: string;
}

const serviceId = (ctx: Context) => String(ctx.service.id ?? "");
const sessionName = (ctx: Context) => `np-aws-s3-bucket-${serviceId(ctx)}`;

export async function create(ctx: Context): Promise<BucketOutputs> {
  return converge(ctx);
}

export async function update(ctx: Context): Promise<BucketOutputs> {
  return converge(ctx);
}

export async function remove(ctx: Context): Promise<void> {
  const name = ctx.params.bucket_name;
  if (!name) {
    ctx.log.detail("the service never got a bucket; nothing to delete");
    return;
  }
  const client = s3(await session(ctx, sessionName(ctx)));
  if (!(await exists(client, name))) {
    ctx.log.detail(`${name} is already gone`);
    return;
  }
  if (ctx.params.force_destroy) {
    await ctx.step("empty the bucket", () => emptyBucket(ctx, client, name));
  }
  await ctx.step(`delete ${name}`, () => deleteBucket(client, name));
  ctx.log.ok(`${name} deleted`);
}

// ─── Convergence ──────────────────────────────────────────────────────

async function converge(ctx: Context): Promise<BucketOutputs> {
  const aws = await session(ctx, sessionName(ctx));
  const client = s3(aws);
  const name = bucketName(ctx);

  await ctx.step(`bucket ${name}`, () => ensureBucket(ctx, client, name, aws.region));
  await ctx.step("versioning", () => applyVersioning(client, name, ctx.params.versioning !== false));
  await ctx.step("encryption", () => applyEncryption(client, name, ctx.params.encryption ?? "AES256"));
  await ctx.step("public access", () => applyPublicAccess(client, name, ctx.params.public_access_block !== false));

  ctx.log.ok(`${name} ready in ${aws.region}`);
  return { bucket_name: name, bucket_arn: `arn:aws:s3:::${name}`, bucket_region: aws.region };
}

/** Decided once: the name already on the service, else derived from the service name and the suffix. */
function bucketName(ctx: Context): string {
  if (ctx.params.bucket_name) return ctx.params.bucket_name;
  if (!ctx.params.bucket_name_suffix) throw new ActionError("MISSING_SUFFIX", "bucket_name_suffix is required");
  return bucketNameFor(String(ctx.service.name ?? ""), serviceId(ctx), ctx.params.bucket_name_suffix);
}

async function ensureBucket(ctx: Context, client: S3Client, name: string, region: string): Promise<void> {
  if (await exists(client, name)) {
    ctx.log.detail("exists, converging its configuration");
    return;
  }
  const location =
    region === "us-east-1"
      ? {}
      : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } };
  await client.send(new CreateBucketCommand({ Bucket: name, ...location }));
  await client.send(
    new PutBucketTaggingCommand({
      Bucket: name,
      Tagging: {
        TagSet: [
          { Key: "managed-by", Value: "nullplatform" },
          { Key: "service-id", Value: serviceId(ctx) },
        ],
      },
    }),
  );
  ctx.log.detail("created");
}

async function exists(client: S3Client, name: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch (err) {
    if (isAwsError(err, "NotFound", "NoSuchBucket")) return false;
    throw err;
  }
}

function applyVersioning(client: S3Client, name: string, enabled: boolean) {
  return client.send(
    new PutBucketVersioningCommand({
      Bucket: name,
      VersioningConfiguration: { Status: enabled ? "Enabled" : "Suspended" },
    }),
  );
}

function applyEncryption(client: S3Client, name: string, algorithm: "AES256" | "aws:kms") {
  return client.send(
    new PutBucketEncryptionCommand({
      Bucket: name,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: algorithm } }],
      },
    }),
  );
}

function applyPublicAccess(client: S3Client, name: string, blocked: boolean) {
  if (!blocked) return client.send(new DeletePublicAccessBlockCommand({ Bucket: name }));
  return client.send(
    new PutPublicAccessBlockCommand({
      Bucket: name,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
}

// ─── Deletion ─────────────────────────────────────────────────────────

/** Every object version and delete marker, page by page. */
async function emptyBucket(ctx: Context, client: S3Client, name: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let removed = 0;
  do {
    const page = await client.send(
      new ListObjectVersionsCommand({ Bucket: name, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }),
    );
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((o) => ({
      Key: o.Key!,
      VersionId: o.VersionId,
    }));
    if (objects.length) {
      await client.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: objects, Quiet: true } }));
      removed += objects.length;
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker || versionIdMarker);
  ctx.log.detail(`${removed} object versions removed`);
}

async function deleteBucket(client: S3Client, name: string): Promise<void> {
  try {
    await client.send(new DeleteBucketCommand({ Bucket: name }));
  } catch (err) {
    if (isAwsError(err, "BucketNotEmpty")) {
      throw new ActionError("BUCKET_NOT_EMPTY", `${name} still has objects; set force_destroy to delete it anyway`);
    }
    throw err;
  }
}
