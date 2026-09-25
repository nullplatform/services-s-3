/**
 * The IAM policy a link's user gets: exactly what permissions/locals.tf and
 * the policy document in permissions/main.tf used to render, as a function.
 */

export type AccessLevel = "read" | "write" | "read-write";

const BUCKET_ACTIONS = ["s3:ListBucket", "s3:GetBucketLocation"];
const OBJECT_ACTIONS: Record<AccessLevel, string[]> = {
  read: ["s3:GetObject"],
  write: ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
  "read-write": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
};

export interface PolicyInput {
  bucketArn: string;
  accessLevel: AccessLevel;
  /** Key prefix the permissions are scoped to; empty means the whole bucket. */
  pathPrefix?: string;
}

export function linkPolicy({ bucketArn, accessLevel, pathPrefix = "" }: PolicyInput): Record<string, unknown> {
  const bucketLevel: Record<string, unknown> = {
    Sid: "BucketLevel",
    Effect: "Allow",
    Action: BUCKET_ACTIONS,
    Resource: bucketArn,
  };
  if (pathPrefix) {
    bucketLevel.Condition = { StringLike: { "s3:prefix": [`${pathPrefix}*`, pathPrefix] } };
  }
  return {
    Version: "2012-10-17",
    Statement: [
      bucketLevel,
      {
        Sid: "ObjectLevel",
        Effect: "Allow",
        Action: OBJECT_ACTIONS[accessLevel],
        Resource: pathPrefix ? `${bucketArn}/${pathPrefix}*` : `${bucketArn}/*`,
      },
    ],
  };
}

/** `np-s3-<link id without dashes, 16 chars, lowercase>` — the name the scripts used. */
export const iamUserName = (linkId: string): string => `np-s3-${linkId.replace(/-/g, "").slice(0, 16).toLowerCase()}`;

/** `<np-service-name>-<suffix>`, lowercase, at most 63 characters — as build_context computed it. */
export function bucketNameFor(serviceName: string, serviceId: string, suffix: string): string {
  const base = (serviceName || `svc-${serviceId}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55);
  return `np-${base}-${suffix}`.toLowerCase().slice(0, 63);
}
