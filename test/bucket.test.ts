import { describe, test, expect, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
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
} from "@aws-sdk/client-s3";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import pkg from "../src/package";
import { bucket } from "../src/resources";

process.env.NO_COLOR = "1";
const s3 = mockClient(S3Client);
const sts = mockClient(STSClient);

const providers = {
  "cloud-providers": { account: { region: "us-east-2" } },
  "identity-access-control": {
    iam_role_arns: { arns: [{ selector: "s3", arn: "arn:aws:iam::123456789012:role/np-s3" }] },
  },
};
const service = {
  id: "svc-1",
  name: "Orders API",
  nrn: "organization=1:account=2:namespace=3:application=4",
  attributes: {},
};
const notFound = Object.assign(new Error("Not Found"), { name: "NotFound" });

beforeEach(() => {
  s3.reset();
  sts.reset();
  sts.on(AssumeRoleCommand).resolves({
    Credentials: { AccessKeyId: "AKIA", SecretAccessKey: "secret", SessionToken: "tok", Expiration: new Date() },
  });
});

describe("create", () => {
  test("creates the bucket in the account's region with tags, versioning, encryption and public access block", async () => {
    s3.on(HeadBucketCommand).rejects(notFound);
    s3.on(CreateBucketCommand).resolves({});
    const run = await pkg.run(
      bucket,
      "create",
      { bucket_name_suffix: "uploads", versioning: true, encryption: "AES256", public_access_block: true },
      { service, providers },
    );
    expect(run.status).toBe("success");
    expect(run.results).toEqual({
      bucket_name: "np-orders-api-uploads",
      bucket_arn: "arn:aws:s3:::np-orders-api-uploads",
      bucket_region: "us-east-2",
    });
    expect(run.steps.map((s) => s.key)).toEqual([
      "assume role",
      "bucket np-orders-api-uploads",
      "versioning",
      "encryption",
      "public access",
    ]);
    expect(sts.commandCalls(AssumeRoleCommand)[0].args[0].input).toMatchObject({
      RoleArn: "arn:aws:iam::123456789012:role/np-s3",
      RoleSessionName: "np-aws-s3-bucket-svc-1",
    });
    expect(s3.commandCalls(CreateBucketCommand)[0].args[0].input).toEqual({
      Bucket: "np-orders-api-uploads",
      CreateBucketConfiguration: { LocationConstraint: "us-east-2" },
    });
    expect(s3.commandCalls(PutBucketTaggingCommand)[0].args[0].input.Tagging?.TagSet).toEqual([
      { Key: "managed-by", Value: "nullplatform" },
      { Key: "service-id", Value: "svc-1" },
    ]);
    expect(s3.commandCalls(PutBucketVersioningCommand)[0].args[0].input.VersioningConfiguration).toEqual({
      Status: "Enabled",
    });
    expect(
      s3.commandCalls(PutBucketEncryptionCommand)[0].args[0].input.ServerSideEncryptionConfiguration?.Rules?.[0]
        .ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
    ).toBe("AES256");
    expect(s3.commandCalls(PutPublicAccessBlockCommand)).toHaveLength(1);
    expect(s3.commandCalls(DeletePublicAccessBlockCommand)).toHaveLength(0);
  });

  test("us-east-1 needs no location constraint; no IAM role means the agent's own credentials", async () => {
    s3.on(HeadBucketCommand).rejects(notFound);
    s3.on(CreateBucketCommand).resolves({});
    const run = await pkg.run(
      bucket,
      "create",
      { bucket_name_suffix: "x" },
      { service, providers: { "cloud-providers": { account: { region: "us-east-1" } } } },
    );
    expect(run.status).toBe("success");
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
    expect(s3.commandCalls(CreateBucketCommand)[0].args[0].input).toEqual({ Bucket: "np-orders-api-x" });
    expect(run.logs).toContain('  · no role for selector "s3"; using the agent\'s credentials');
  });

  test("a retried create finds the bucket and only converges it", async () => {
    s3.on(HeadBucketCommand).resolves({});
    const run = await pkg.run(
      bucket,
      "create",
      { bucket_name_suffix: "x" },
      { service: { ...service, attributes: { bucket_name: "np-orders-api-x" } }, providers },
    );
    expect(run.status).toBe("success");
    expect(s3.commandCalls(CreateBucketCommand)).toHaveLength(0);
    expect(s3.commandCalls(PutBucketVersioningCommand)).toHaveLength(1);
  });

  test("without a region there is nothing to do, and the error says so", async () => {
    const run = await pkg.run(bucket, "create", { bucket_name_suffix: "x" }, { service, providers: {} });
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("NO_REGION");
  });
});

describe("update", () => {
  test("suspends versioning, switches to KMS and drops the public access block", async () => {
    s3.on(HeadBucketCommand).resolves({});
    const run = await pkg.run(
      bucket,
      "update",
      { versioning: false, encryption: "aws:kms", public_access_block: false },
      { service: { ...service, attributes: { bucket_name: "np-orders-api-x", bucket_name_suffix: "x" } }, providers },
    );
    expect(run.status).toBe("success");
    expect(run.results?.bucket_name).toBe("np-orders-api-x");
    expect(s3.commandCalls(PutBucketVersioningCommand)[0].args[0].input.VersioningConfiguration).toEqual({
      Status: "Suspended",
    });
    expect(
      s3.commandCalls(PutBucketEncryptionCommand)[0].args[0].input.ServerSideEncryptionConfiguration?.Rules?.[0]
        .ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
    ).toBe("aws:kms");
    expect(s3.commandCalls(DeletePublicAccessBlockCommand)).toHaveLength(1);
  });
});

describe("delete", () => {
  test("refuses a non-empty bucket unless force_destroy", async () => {
    s3.on(HeadBucketCommand).resolves({});
    s3.on(DeleteBucketCommand).rejects(Object.assign(new Error("not empty"), { name: "BucketNotEmpty" }));
    const run = await pkg.run(
      bucket,
      "delete",
      {},
      { service: { ...service, attributes: { bucket_name: "np-orders-api-x", force_destroy: false } }, providers },
    );
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "BUCKET_NOT_EMPTY", retryable: false });
    expect(s3.commandCalls(ListObjectVersionsCommand)).toHaveLength(0);
  });

  test("force_destroy empties every version and delete marker first", async () => {
    s3.on(HeadBucketCommand).resolves({});
    s3.on(ListObjectVersionsCommand)
      .resolvesOnce({
        IsTruncated: true,
        NextKeyMarker: "k",
        NextVersionIdMarker: "v",
        Versions: [{ Key: "a", VersionId: "1" }],
        DeleteMarkers: [{ Key: "b", VersionId: "2" }],
      })
      .resolvesOnce({ IsTruncated: false, Versions: [{ Key: "c", VersionId: "3" }] });
    s3.on(DeleteObjectsCommand).resolves({});
    s3.on(DeleteBucketCommand).resolves({});
    const run = await pkg.run(
      bucket,
      "delete",
      {},
      { service: { ...service, attributes: { bucket_name: "np-orders-api-x", force_destroy: true } }, providers },
    );
    expect(run.status).toBe("success");
    expect(run.results).toBeUndefined();
    expect(s3.commandCalls(DeleteObjectsCommand)).toHaveLength(2);
    expect(s3.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete?.Objects).toEqual([
      { Key: "a", VersionId: "1" },
      { Key: "b", VersionId: "2" },
    ]);
    expect(s3.commandCalls(DeleteBucketCommand)).toHaveLength(1);
    expect(run.logs).toContain("  · 3 object versions removed");
  });

  test("a service that never got a bucket, or whose bucket is gone, deletes cleanly", async () => {
    const none = await pkg.run(bucket, "delete", {}, { service, providers });
    expect(none.status).toBe("success");
    s3.on(HeadBucketCommand).rejects(notFound);
    const gone = await pkg.run(
      bucket,
      "delete",
      {},
      { service: { ...service, attributes: { bucket_name: "np-x" } }, providers },
    );
    expect(gone.status).toBe("success");
    expect(s3.commandCalls(DeleteBucketCommand)).toHaveLength(0);
  });
});
