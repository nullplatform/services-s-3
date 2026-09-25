/**
 * AWS access, from the platform's providers:
 *
 *   region       the account's `cloud-providers` configuration (`account.region`)
 *   credentials  the `identity-access-control` provider names the role to
 *                assume by selector (`iam_role_arns.arns[] { selector, arn }`);
 *                with no entry for the selector the worker keeps the
 *                credentials it already has, the agent's.
 *
 * The same ladder scripts/aws/assume_role_step used to walk, as one function.
 */

import { ActionError, type HandlerContext } from "@nullplatform/plugin/package";
import { IAMClient } from "@aws-sdk/client-iam";
import { S3Client } from "@aws-sdk/client-s3";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

export const ASSUME_ROLE_SELECTOR = "s3";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface Session {
  region: string;
  credentials?: Credentials;
}

type Providers = Record<string, Record<string, unknown>>;

interface IdentityProvider {
  iam_role_arns?: { arns?: Array<{ selector?: string; arn?: string }> };
}

interface CloudProvider {
  account?: { region?: string };
}

/** Region and, when the identity provider names a role for this service, the assumed credentials. */
export async function session(ctx: HandlerContext, sessionName: string): Promise<Session> {
  const providers = await ctx.settings.providers(["cloud-providers", "identity-access-control"]);
  const region = regionOf(providers);
  const roleArn = roleArnFor(providers, ASSUME_ROLE_SELECTOR);
  if (!roleArn) {
    ctx.log.detail(`no role for selector "${ASSUME_ROLE_SELECTOR}"; using the agent's credentials`);
    return { region };
  }
  const credentials = await ctx.step("assume role", () => assumeRole(region, roleArn, sessionName));
  ctx.log.detail(`assumed ${roleArn}`);
  return { region, credentials };
}

export const s3 = (s: Session) => new S3Client({ region: s.region, credentials: s.credentials });
export const iam = (s: Session) => new IAMClient({ region: s.region, credentials: s.credentials });

/** AWS SDK errors carry their name; the callers decide which ones are fine. */
export const isAwsError = (err: unknown, ...names: string[]): boolean =>
  !!err && typeof err === "object" && names.includes(String((err as { name?: string }).name));

// ─── Providers ────────────────────────────────────────────────────────

function regionOf(providers: Providers): string {
  const region = (providers["cloud-providers"] as CloudProvider | undefined)?.account?.region;
  if (!region) throw new ActionError("NO_REGION", "no cloud-providers configuration with account.region at this NRN");
  return region;
}

function roleArnFor(providers: Providers, selector: string): string | undefined {
  const arns = (providers["identity-access-control"] as IdentityProvider | undefined)?.iam_role_arns?.arns ?? [];
  return arns.find((entry) => entry.selector === selector)?.arn;
}

async function assumeRole(region: string, roleArn: string, sessionName: string): Promise<Credentials> {
  const out = await new STSClient({ region }).send(
    new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName }),
  );
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) {
    throw new ActionError("ASSUME_ROLE_FAILED", `sts:AssumeRole returned no credentials for ${roleArn}`);
  }
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}
