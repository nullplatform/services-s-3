import { describe, test, expect, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import { IAMClient, CreateAccessKeyCommand, CreateUserCommand, DeleteAccessKeyCommand, DeleteUserCommand, DeleteUserPolicyCommand, ListAccessKeysCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import pkg from "../src/package";
import { connect } from "../src/resources";

process.env.NO_COLOR = "1";
const iam = mockClient(IAMClient);
const sts = mockClient(STSClient);

const providers = { "cloud-providers": { account: { region: "us-east-1" } } };
const service = { id: "svc-1", name: "Orders API", attributes: { bucket_name: "np-orders-api-uploads", bucket_arn: "arn:aws:s3:::np-orders-api-uploads", bucket_region: "us-east-1" } };
const link = { id: "9f2a1b3c-4d5e-6f70-8192-a3b4c5d6e7f8", attributes: {} };

beforeEach(() => {
  iam.reset();
  sts.reset();
});

describe("link create", () => {
  test("creates the user, its scoped policy and one access key", async () => {
    iam.on(CreateUserCommand).resolves({});
    iam.on(PutUserPolicyCommand).resolves({});
    iam.on(CreateAccessKeyCommand).resolves({ AccessKey: { AccessKeyId: "AKIAEXAMPLE", SecretAccessKey: "s3cr3t", UserName: "u", Status: "Active" } });
    const run = await pkg.run(connect, "create", { access_level: "read", path_prefix: "uploads/" }, { service, link, providers });
    expect(run.status).toBe("success");
    expect(run.results).toEqual({ aws_access_key_id: "AKIAEXAMPLE", aws_secret_access_key: "s3cr3t", iam_user_name: "np-s3-9f2a1b3c4d5e6f70" });
    expect(iam.commandCalls(CreateUserCommand)[0].args[0].input.Tags).toEqual([
      { Key: "managed-by", Value: "nullplatform" }, { Key: "link-id", Value: link.id }, { Key: "bucket", Value: "np-orders-api-uploads" },
    ]);
    const policy = JSON.parse(iam.commandCalls(PutUserPolicyCommand)[0].args[0].input.PolicyDocument!);
    expect(iam.commandCalls(PutUserPolicyCommand)[0].args[0].input.PolicyName).toBe(`s3-access-${link.id}`);
    expect(policy.Statement[1]).toMatchObject({ Action: ["s3:GetObject"], Resource: "arn:aws:s3:::np-orders-api-uploads/uploads/*" });
    expect(run.steps.map((s) => s.key)).toEqual(["user np-s3-9f2a1b3c4d5e6f70", "policy read on uploads/", "access key"]);
  });

  test("before the bucket exists the link is retryable", async () => {
    const run = await pkg.run(connect, "create", { access_level: "read-write" }, { service: { ...service, attributes: {} }, link, providers });
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "BUCKET_NOT_READY", retryable: true });
    expect(iam.commandCalls(CreateUserCommand)).toHaveLength(0);
  });

  test("a retried create reuses the user and keeps the key already issued", async () => {
    iam.on(CreateUserCommand).rejects(Object.assign(new Error("exists"), { name: "EntityAlreadyExistsException" }));
    iam.on(PutUserPolicyCommand).resolves({});
    const run = await pkg.run(connect, "create", { access_level: "read-write" }, {
      service, providers,
      link: { ...link, attributes: { aws_access_key_id: "AKIAOLD", aws_secret_access_key: "old", iam_user_name: "np-s3-9f2a1b3c4d5e6f70" } },
    });
    expect(run.status).toBe("success");
    expect(run.results).toEqual({ aws_access_key_id: "AKIAOLD", aws_secret_access_key: "old", iam_user_name: "np-s3-9f2a1b3c4d5e6f70" });
    expect(iam.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
  });
});

describe("link update", () => {
  test("rewrites the policy and keeps the credentials", async () => {
    iam.on(PutUserPolicyCommand).resolves({});
    const run = await pkg.run(connect, "update", { access_level: "write" }, { service, link: { ...link, attributes: { iam_user_name: "np-s3-custom", path_prefix: "" } }, providers });
    expect(run.status).toBe("success");
    expect(run.results).toEqual({});
    expect(iam.commandCalls(PutUserPolicyCommand)[0].args[0].input.UserName).toBe("np-s3-custom");
    expect(JSON.parse(iam.commandCalls(PutUserPolicyCommand)[0].args[0].input.PolicyDocument!).Statement[1].Action).toEqual(["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]);
    expect(iam.commandCalls(CreateAccessKeyCommand)).toHaveLength(0);
  });
});

describe("link delete", () => {
  test("removes policy, keys and user; the bucket is untouched", async () => {
    iam.on(DeleteUserPolicyCommand).resolves({});
    iam.on(ListAccessKeysCommand).resolves({ AccessKeyMetadata: [{ AccessKeyId: "AKIA1" }, { AccessKeyId: "AKIA2" }] });
    iam.on(DeleteAccessKeyCommand).resolves({});
    iam.on(DeleteUserCommand).resolves({});
    const run = await pkg.run(connect, "delete", {}, { service, link: { ...link, attributes: { iam_user_name: "np-s3-9f2a1b3c4d5e6f70" } }, providers });
    expect(run.status).toBe("success");
    expect(iam.commandCalls(DeleteAccessKeyCommand)).toHaveLength(2);
    expect(iam.commandCalls(DeleteUserCommand)[0].args[0].input.UserName).toBe("np-s3-9f2a1b3c4d5e6f70");
  });

  test("a user that is already gone is not an error", async () => {
    const gone = Object.assign(new Error("gone"), { name: "NoSuchEntityException" });
    iam.on(DeleteUserPolicyCommand).rejects(gone);
    iam.on(ListAccessKeysCommand).rejects(gone);
    const run = await pkg.run(connect, "delete", {}, { service, link, providers });
    expect(run.status).toBe("success");
    expect(run.logs).toContain("  · already gone");
  });
});
