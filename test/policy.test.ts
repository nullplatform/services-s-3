import { describe, test, expect } from "bun:test";
import { linkPolicy, iamUserName, bucketNameFor } from "../src/policy";

describe("linkPolicy", () => {
  test("read-write on the whole bucket: exactly the statements permissions/main.tf rendered", () => {
    expect(linkPolicy({ bucketArn: "arn:aws:s3:::np-orders-uploads", accessLevel: "read-write" })).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "BucketLevel",
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:GetBucketLocation"],
          Resource: "arn:aws:s3:::np-orders-uploads",
        },
        {
          Sid: "ObjectLevel",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
          Resource: "arn:aws:s3:::np-orders-uploads/*",
        },
      ],
    });
  });

  test("a prefix scopes ListBucket with a condition and the object resource", () => {
    const p = linkPolicy({ bucketArn: "arn:aws:s3:::b", accessLevel: "read", pathPrefix: "uploads/" }) as any;
    expect(p.Statement[0].Condition).toEqual({ StringLike: { "s3:prefix": ["uploads/*", "uploads/"] } });
    expect(p.Statement[1]).toMatchObject({ Action: ["s3:GetObject"], Resource: "arn:aws:s3:::b/uploads/*" });
  });

  test("write is put, delete and abort — never get", () => {
    const p = linkPolicy({ bucketArn: "arn:aws:s3:::b", accessLevel: "write" }) as any;
    expect(p.Statement[1].Action).toEqual(["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]);
  });
});

describe("names", () => {
  test("the IAM user name is np-s3- plus 16 chars of the link id", () => {
    expect(iamUserName("9F2A1B3C-4D5E-6F70-8192-A3B4C5D6E7F8")).toBe("np-s3-9f2a1b3c4d5e6f70");
  });
  test("the bucket name is np-<service>-<suffix>, lowercase, 63 chars at most", () => {
    expect(bucketNameFor("Orders API", "1", "uploads")).toBe("np-orders-api-uploads");
    expect(bucketNameFor("", "42", "x")).toBe("np-svc-42-x");
    expect(bucketNameFor("a".repeat(80), "1", "b".repeat(20))).toHaveLength(63);
  });
});
