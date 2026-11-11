/**
 * Role links (link attribute `credentials: role`): the link has no static key, only an IAM role
 * that trusts this worker's role. The worker never takes the role from the link: it rebuilds the
 * ARN from the link id the way the aws-s3-bucket service names it (`np-s3-<first 16 chars of the
 * id without dashes, lowercased>`), in the account configured on the worker, and assumes it with
 * its own identity for one short session per request.
 */
import { fromNodeProviderChain, fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { StaticCredentials } from "./s3";

/** Where link roles live (S3_BROWSER_LINK_ROLE_ACCOUNT_ID / S3_BROWSER_LINK_ROLE_PARTITION). */
export interface LinkRoleConfig {
  accountId?: string;
  partition?: string;
}

export interface AssumeRoleRequest {
  roleArn: string;
  sessionName: string;
  durationSeconds: number;
  /** STS region; the SDK's default (AWS_REGION, else us-east-1) when absent. */
  region?: string;
}

/** One STS AssumeRole: the session's credentials, never cached. */
export type AssumeRole = (request: AssumeRoleRequest) => Promise<StaticCredentials>;

/** STS's minimum, and the longest a request needs. */
export const ROLE_SESSION_SECONDS = 900;

const ACCOUNT_ID = /^\d{12}$/;
const PARTITION = /^aws(-[a-z]+)*$/;

/** The role name the service derives from the link id (scripts/aws/build_permissions_context). */
export function linkRoleName(linkId: string): string {
  return `np-s3-${linkId.replace(/-/g, "").slice(0, 16).toLowerCase()}`;
}

/** The link's role ARN; undefined when the worker has no valid account (or partition) configured. */
export function linkRoleArn(linkId: string, { accountId, partition = "aws" }: LinkRoleConfig = {}): string | undefined {
  if (!accountId || !ACCOUNT_ID.test(accountId) || !PARTITION.test(partition)) return undefined;
  return `arn:${partition}:iam::${accountId}:role/${linkRoleName(linkId)}`;
}

/** `s3-browser-<execution id>` in the characters and length STS accepts (CloudTrail shows it). */
export function roleSessionName(executionId: string): string {
  return `s3-browser-${executionId}`.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);
}

/**
 * AssumeRole with the worker's own identity as the source, through the same bounded default chain
 * the S3 client uses (see defaultClientFactory).
 */
export function createAssumeRole(): AssumeRole {
  // Built once: the chain caches the worker's credentials and refreshes them when they expire.
  const source = fromNodeProviderChain({ timeout: 1500, maxRetries: 0 });
  return async ({ roleArn, sessionName, durationSeconds, region }) => {
    const provider = fromTemporaryCredentials({
      params: { RoleArn: roleArn, RoleSessionName: sessionName, DurationSeconds: durationSeconds },
      masterCredentials: source,
      ...(region ? { clientConfig: { region } } : {}),
    });
    const { accessKeyId, secretAccessKey, sessionToken, expiration } = await provider();
    return { accessKeyId, secretAccessKey, sessionToken, expiration };
  };
}
