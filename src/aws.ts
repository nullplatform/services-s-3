/**
 * AWS access for the handlers, straight from the platform's providers:
 *
 *   - region: the account's `cloud-providers` configuration (`account.region`)
 *   - credentials: the `identity-access-control` provider names the role to
 *     assume by selector (`iam_role_arns.arns[] { selector, arn }`); with no
 *     entry for the selector the worker keeps the credentials it already has,
 *     the agent's — the same ladder scripts/aws/assume_role_step walked.
 */

import { ActionError, type HandlerContext } from "@nullplatform/plugin/package";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { S3Client } from "@aws-sdk/client-s3";
import { IAMClient } from "@aws-sdk/client-iam";

export const ASSUME_ROLE_SELECTOR = "s3";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsSession {
  region: string;
  credentials?: AwsCredentials;
}

type Providers = Record<string, Record<string, unknown>>;

function roleArnFor(providers: Providers, selector: string): string | undefined {
  const iam = providers["identity-access-control"] as { iam_role_arns?: { arns?: Array<{ selector?: string; arn?: string }> } } | undefined;
  return iam?.iam_role_arns?.arns?.find((e) => e.selector === selector)?.arn;
}

function regionOf(providers: Providers): string {
  const cloud = providers["cloud-providers"] as { account?: { region?: string } } | undefined;
  const region = cloud?.account?.region;
  if (!region) throw new ActionError("NO_REGION", "no cloud-providers configuration with account.region at this NRN");
  return region;
}

/** Region and, when the IAM provider names a role for this service, assumed credentials. */
export async function awsSession(ctx: HandlerContext, sessionName: string): Promise<AwsSession> {
  const providers = await ctx.settings.providers(["cloud-providers", "identity-access-control"]);
  const region = regionOf(providers);
  const roleArn = roleArnFor(providers, ASSUME_ROLE_SELECTOR);
  if (!roleArn) {
    ctx.log.detail(`no role for selector "${ASSUME_ROLE_SELECTOR}"; using the agent's credentials`);
    return { region };
  }
  const credentials = await ctx.step("assume role", async () => {
    const out = await new STSClient({ region }).send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName }));
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new ActionError("ASSUME_ROLE_FAILED", `sts:AssumeRole returned no credentials for ${roleArn}`);
    ctx.log.detail(`assumed ${roleArn}`);
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  });
  return { region, credentials };
}

export const s3 = (s: AwsSession) => new S3Client({ region: s.region, credentials: s.credentials });
export const iam = (s: AwsSession) => new IAMClient({ region: s.region, credentials: s.credentials });

/** AWS SDK errors carry their name; `NoSuchBucket`, `NotFound`, `NoSuchEntity` are the ones we tolerate. */
export const isAwsError = (err: unknown, ...names: string[]): boolean =>
  !!err && typeof err === "object" && names.includes(String((err as { name?: string }).name));
