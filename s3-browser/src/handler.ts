/**
 * One command in, one JSON result out. The result travels back to the caller of the agent
 * command as the worker's stdout (the agent surfaces `data.stdout` when nothing streamed, the
 * API parses it into `result`), so business refusals are results too — `{ error }` with an
 * HTTP-like status — and only worker failures are unsuccessful executions.
 */
import type { ExecuteResult } from "@nullplatform/plugin";
import { type Command, CommandError, type ParseOptions, parseCommand } from "./protocol";
import { type Link, type Platform, PlatformError, bucketFromEnvelope, resolveBucket } from "./platform";
import { type ObjectStore, StoreError, type Target, redact } from "./s3";

export interface HandlerConfig {
  /** Accepted specification slugs; a trailing `*` matches a prefix. */
  specifications: string[];
  /** `delete-object` only when true. */
  allowWrites: boolean;
}

export type Handler = (command: Command) => Promise<unknown>;

/** The link belongs to the application: same NRN, or a resource under it (`:` boundary). */
export function linkOwnedBy(linkNrn: unknown, entityNrn: string): boolean {
  if (typeof linkNrn !== "string" || !linkNrn || !entityNrn) return false;
  return linkNrn === entityNrn || linkNrn.startsWith(`${entityNrn}:`);
}

/** `path_prefix` as a key prefix: empty stays empty, anything else ends with `/`. */
export function normalisePathPrefix(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

const WRITE_LEVELS = new Set(["write", "read-write"]);

/** A masked value means the read did not include secrets; using it would only fail at AWS. */
const MASKED = /^\*+$/;

interface LinkScope {
  target: Target;
  pathPrefix: string;
}

/**
 * Link mode, in the contract's order: the link must exist, belong to the entity's application,
 * be active with keys; the bucket comes only from its service; reads and writes stay under its
 * `path_prefix`; deletes need a write access level.
 */
async function resolveLink(platform: Platform, command: Command, config: HandlerConfig, secrets: string[]): Promise<LinkScope> {
  const { link_id: linkId, entity_nrn: entityNrn } = command.link!;
  const link: Link = await platform.getLink(linkId);
  if (!linkOwnedBy(link.entity_nrn, entityNrn)) throw new CommandError(`link ${linkId} does not belong to this application`, 403, "LINK_NOT_OWNED");
  if (link.status !== "active") throw new CommandError(`link ${linkId} is not active (status ${link.status ?? "unknown"})`, 409, "LINK_NOT_READY");
  const attributes = link.attributes ?? {};
  const accessKeyId = attributes.aws_access_key_id;
  const secretAccessKey = attributes.aws_secret_access_key;
  // Known to the caller's scrubber from here on, whatever fails next.
  for (const value of [accessKeyId, secretAccessKey]) if (typeof value === "string" && value) secrets.push(value);
  if (typeof accessKeyId !== "string" || !accessKeyId || typeof secretAccessKey !== "string" || !secretAccessKey) throw new CommandError(`link ${linkId} has no access keys yet`, 409, "LINK_NOT_READY");
  if (MASKED.test(accessKeyId) || MASKED.test(secretAccessKey)) throw new PlatformError(`link ${linkId} came back with masked keys; the agent's API key needs the permission to read link secrets`, 500, "PLATFORM");
  if (link.service_id === undefined || link.service_id === null || link.service_id === "") throw new CommandError(`link ${linkId} has no service`, 409, "LINK_NOT_READY");
  const resolved = await resolveBucket(platform, String(link.service_id), config.specifications);

  const pathPrefix = normalisePathPrefix(attributes.path_prefix);
  if (pathPrefix) {
    const scoped = command.action === "list-objects" ? command.prefix : command.key!;
    if (command.action === "list-objects" && !command.prefix) command.prefix = pathPrefix;
    else if (!scoped.startsWith(pathPrefix)) throw new CommandError(`${command.action === "list-objects" ? "prefix" : "key"} is outside the link's path prefix ${pathPrefix}`, 403, "OUTSIDE_PREFIX");
  }
  if (command.action === "delete-object" && !WRITE_LEVELS.has(String(attributes.access_level ?? ""))) throw new CommandError(`link ${linkId} does not allow writes (access level ${String(attributes.access_level ?? "unknown")})`, 403, "WRITE_NOT_ALLOWED");
  return { target: { bucket: resolved.bucket, region: resolved.region, credentials: { accessKeyId, secretAccessKey } }, pathPrefix };
}

/** The same error with every secret removed from its message. */
function scrub(error: unknown, secrets: string[]): unknown {
  if (error instanceof CommandError) return new CommandError(redact(error.message, secrets), error.status, error.code);
  if (error instanceof PlatformError) return new PlatformError(redact(error.message, secrets), error.status, error.code);
  if (error instanceof StoreError) return new StoreError(redact(error.message, secrets), error.status, error.code);
  const e = error as { message?: string };
  return new Error(redact(e?.message ?? String(error), secrets));
}

async function runOnTarget(store: ObjectStore, command: Command, target: Target): Promise<unknown> {
  switch (command.action) {
    case "list-objects":
      return store.list(target, command.prefix, command.token, command.limit);
    case "head-object":
      return store.head(target, command.key!);
    case "read-object":
      return store.read(target, command.key!, command.max_bytes!);
    case "presign-download":
      return store.presign(target, command.key!);
    case "delete-object":
      return store.remove(target, command.key!);
  }
}

export function createHandler({ platform, store, config }: { platform: Platform; store: ObjectStore; config: HandlerConfig }): Handler {
  return async (command) => {
    // Gate writes before any lookup: a refused delete costs no platform call.
    if (command.action === "delete-object" && !config.allowWrites) throw new CommandError("writes are disabled on this worker (S3_BROWSER_ALLOW_WRITES=1 enables them)", 405, "WRITES_DISABLED");
    if (command.link) {
      const secrets: string[] = [];
      try {
        const scope = await resolveLink(platform, command, config, secrets);
        return await runOnTarget(store, command, scope.target);
      } catch (error) {
        throw scrub(error, secrets);
      }
    }
    if (command.action === "read-object") throw new CommandError("read-object is only available in link mode", 400, "UNKNOWN_ACTION");
    const resolved = command.catalog ?? bucketFromEnvelope(command.service, config.specifications) ?? (await resolveBucket(platform, command.service_id, config.specifications));
    return runOnTarget(store, command, { bucket: resolved.bucket, region: resolved.region });
  };
}

export interface ErrorResult {
  error: { status: number; code: string; message: string };
}

function describe(error: unknown): ErrorResult["error"] {
  if (error instanceof CommandError || error instanceof PlatformError || error instanceof StoreError) return { status: error.status, code: error.code, message: error.message };
  const e = error as { message?: string };
  return { status: 500, code: "WORKER", message: e?.message ?? String(error) };
}

/** Runs one payload; never throws. */
export async function runCommand(payload: Buffer | string, handler: Handler, options: ParseOptions = {}): Promise<ExecuteResult & { data: { stdout: string } }> {
  try {
    const command = parseCommand(payload, options);
    const result = await handler(command);
    return { success: true, exitCode: 0, data: { stdout: JSON.stringify(result) } };
  } catch (error) {
    const described = describe(error);
    const body: ErrorResult = { error: described };
    // A refusal the caller can act on is a completed command with an error result; a broken
    // worker (no credentials, unexpected exception) is a failed one.
    const failure = described.status >= 500;
    return { success: !failure, exitCode: failure ? 1 : 0, error: failure ? described.message : undefined, errorCode: failure ? described.code : undefined, data: { stdout: JSON.stringify(body) } };
  }
}
