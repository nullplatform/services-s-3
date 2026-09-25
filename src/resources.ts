/**
 * The two things this package publishes: the S3 bucket service and its
 * `connect` link. Every field here is one of the service API's own
 * (`use_default_actions`, `assignable_to`, `sub_category`, …) in camelCase;
 * the schemas are the ones the platform renders, verbatim.
 */

import { service, link } from "@nullplatform/plugin/package";

export const bucket = service({
  slug: "aws-s3-bucket",
  name: "AWS S3 Bucket",
  type: "dependency",
  unique: false,
  assignableTo: "any",
  useDefaultActions: true,
  selectors: { category: "Storage", imported: false, provider: "AWS", subCategory: "Object Storage" },
  attributes: {
    schema: {
      type: "object",
      required: ["bucket_name_suffix"],
      properties: {
        bucket_name_suffix: {
          type: "string",
          title: "Bucket Name Suffix",
          description:
            "Suffix used to build the bucket name (combined with service name). Must be lowercase alphanumeric with hyphens, 3-40 chars.",
          pattern: "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$",
          editableOn: ["create"],
          order: 1,
        },
        versioning: {
          type: "boolean",
          title: "Versioning",
          default: true,
          description: "Enable S3 versioning to keep multiple versions of each object",
          editableOn: ["create", "update"],
          order: 2,
        },
        encryption: {
          type: "string",
          title: "Encryption",
          default: "AES256",
          enum: ["AES256", "aws:kms"],
          description:
            "Server-side encryption algorithm (AES256 uses S3-managed keys; aws:kms uses the AWS-managed KMS key)",
          editableOn: ["create", "update"],
          order: 3,
        },
        public_access_block: {
          type: "boolean",
          title: "Block Public Access",
          default: true,
          description: "Block all public access to the bucket (recommended)",
          editableOn: ["create", "update"],
          order: 4,
        },
        force_destroy: {
          type: "boolean",
          title: "Force Destroy",
          default: false,
          description: "Allow deleting the bucket even if it contains objects. USE WITH CAUTION.",
          editableOn: ["create", "update"],
          order: 5,
        },
        bucket_name: {
          type: "string",
          title: "Bucket Name",
          export: true,
          visibleOn: ["read"],
          editableOn: [],
          description: "Actual S3 bucket name (auto-populated after creation)",
          order: 6,
        },
        bucket_arn: {
          type: "string",
          title: "Bucket ARN",
          export: true,
          visibleOn: ["read"],
          editableOn: [],
          description: "S3 bucket ARN (auto-populated after creation)",
          order: 7,
        },
        bucket_region: {
          type: "string",
          title: "Bucket Region",
          export: true,
          visibleOn: ["read"],
          editableOn: [],
          description: "AWS region where the bucket lives (auto-populated after creation)",
          order: 8,
        },
      },
    },
    values: {},
  },
});

export const connect = link(bucket, {
  slug: "connect",
  name: "Connect",
  unique: false,
  assignableTo: "any",
  useDefaultActions: true,
  selectors: { category: "Storage", imported: false, provider: "AWS", subCategory: "Object Storage" },
  attributes: {
    schema: {
      type: "object",
      required: ["access_level"],
      properties: {
        access_level: {
          type: "string",
          title: "Access Level",
          enum: ["read", "write", "read-write"],
          default: "read-write",
          editableOn: ["create", "update"],
          description:
            "Permission level: read (GetObject/ListBucket), write (PutObject/DeleteObject), read-write (both)",
          order: 1,
        },
        path_prefix: {
          type: "string",
          title: "Path Prefix",
          default: "",
          description:
            "Optional S3 key prefix to scope the IAM permissions (e.g., 'uploads/'). Empty means full bucket access.",
          editableOn: ["create", "update"],
          order: 2,
        },
        aws_access_key_id: {
          type: "string",
          title: "AWS Access Key ID",
          export: { type: "environment_variable" },
          visibleOn: ["read"],
          editableOn: [],
          description: "IAM user access key ID (auto-populated after link creation)",
          order: 3,
        },
        aws_secret_access_key: {
          type: "string",
          title: "AWS Secret Access Key",
          export: { type: "environment_variable", secret: true },
          visibleOn: ["read"],
          editableOn: [],
          description: "IAM user secret access key (auto-populated, delivered as secret env var)",
          order: 4,
        },
        iam_user_name: {
          type: "string",
          export: false,
          visibleOn: [],
          editableOn: [],
          description: "Internal IAM user name created for this link",
        },
      },
    },
    values: {},
  },
});

/** The attributes the bucket service carries, for typing handlers. */
export interface BucketAttributes {
  bucket_name_suffix: string;
  versioning?: boolean;
  encryption?: "AES256" | "aws:kms";
  public_access_block?: boolean;
  force_destroy?: boolean;
  bucket_name?: string;
  bucket_arn?: string;
  bucket_region?: string;
}

export interface ConnectAttributes {
  access_level: "read" | "write" | "read-write";
  path_prefix?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  iam_user_name?: string;
}
