/**
 * One command in, one JSON result out. The result travels back to the caller of the agent
 * command as the worker's stdout (the agent surfaces `data.stdout` when nothing streamed, the
 * API parses it into `result`), so business refusals are results too — `{ error }` with an
 * HTTP-like status — and only worker failures are unsuccessful executions.
 */
import type { ExecuteResult } from "@nullplatform/plugin";
import { type Command, CommandError, type ParseOptions, parseCommand, parseLinkOperation } from "./protocol";
import { type CatalogEntity, type Link, type Platform, PlatformError, bucketFromEnvelope, resolveBucket } from "./platform";
import { type ObjectStore, StoreError, type Target, redact } from "./s3";

export interface HandlerConfig {
  /** Accepted specification slugs; a trailing `*` matches a prefix. */
  specifications: string[];
  /** `delete-object` only when true. */
  allowWrites: boolean;
  /** Link mode: how many verified execution ids to remember, and for how long (replay guard). */
  replay?: { max?: number; ttlMs?: number; now?: () => number };
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

/** An s3_browser entity lives exactly at an application, never at a namespace or above. */
export const APPLICATION_NRN = /^organization=\d+:account=\d+:namespace=\d+:application=(\d+)$/;

const notVerified = (why: string) => new CommandError(`execution not verified: ${why}`, 403, "EXECUTION_NOT_VERIFIED");

/**
 * The application NRN of a catalog entity read: only its top-level `nrn` (the one the catalog
 * authorizes on), exactly an application NRN whose `application=<id>` is `data.application_id`.
 */
export function entityApplicationNrn(entity: CatalogEntity): string | undefined {
  const data = entity.data && typeof entity.data === "object" ? entity.data : {};
  const nrn = entity.nrn;
  const applicationId = data.application_id;
  if (typeof nrn !== "string" || !nrn) return undefined;
  const match = APPLICATION_NRN.exec(nrn);
  if (!match || (typeof applicationId !== "string" && typeof applicationId !== "number") || match[1] !== String(applicationId)) return undefined;
  return nrn;
}

/**
 * Remembers execution ids already run in this process, so a replayed envelope is refused. Bounded
 * (oldest first out) and time-limited; it only helps while the worker process lives.
 */
export function createReplayGuard({ max = 10_000, ttlMs = 600_000, now = Date.now }: { max?: number; ttlMs?: number; now?: () => number } = {}) {
  const seen = new Map<string, number>();
  const prune = () => {
    const current = now();
    for (const [id, expiresAt] of seen) {
      if (expiresAt > current && seen.size <= max) break;
      seen.delete(id);
    }
  };
  return {
    has(id: string): boolean {
      prune();
      return seen.has(id);
    },
    claim(id: string): void {
      seen.delete(id);
      seen.set(id, now() + ttlMs);
      prune();
    },
    get size() {
      return seen.size;
    },
  };
}

/**
 * Binds a link-mode request to the catalog: the envelope is not trusted (anyone who can run an
 * agent command can forge one). The execution must exist, still be pending and be the same
 * operation on the same link; the operation's fields come from the catalog's record, and the
 * NRN the link must belong to from the catalog's entity, which must sit exactly at an
 * application whose id matches its application_id. Nothing here is cached.
 */
export async function verifyExecution(platform: Platform, command: Command): Promise<Command> {
  const { execution_id: executionId, specification_slug: slug, link_id: linkId } = command.link!;
  const read = async <T>(work: () => Promise<T>, what: string): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PlatformError && error.code === "NO_CREDENTIALS") throw error;
      throw notVerified(`${what} could not be read (${(error as Error)?.message ?? String(error)})`);
    }
  };
  const record = await read(() => platform.getExecution(slug, executionId), `execution ${executionId}`);
  if (record.status !== "pending") throw notVerified(`execution ${executionId} is ${record.status ?? "unknown"}, not pending`);
  if (record.action !== command.action) throw notVerified(`execution ${executionId} is ${record.action ?? "unknown"}, not ${command.action}`);
  let verified: Command;
  try {
    verified = parseLinkOperation(record.action, record.input);
  } catch (error) {
    throw notVerified(`the recorded input is invalid (${(error as Error).message})`);
  }
  if (verified.link!.link_id !== linkId) throw notVerified(`execution ${executionId} is for another link`);
  if (typeof record.entity_id !== "string" || !record.entity_id) throw notVerified(`execution ${executionId} names no entity`);
  const entity = await read(() => platform.getEntity(slug, record.entity_id!), `entity ${record.entity_id}`);
  // Fail closed: both sides must name the specification, and the same one.
  if (!record.entity_specification_id || !entity.entity_specification_id || record.entity_specification_id !== entity.entity_specification_id) throw notVerified(`entity ${record.entity_id} is not known to be of the execution's specification`);
  const entityNrn = entityApplicationNrn(entity);
  if (!entityNrn) throw notVerified(`entity ${record.entity_id} is not at an application NRN matching its application_id`);
  verified.link = { link_id: linkId, entity_nrn: entityNrn, execution_id: executionId, specification_slug: slug };
  return verified;
}

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
  // The services API masks secret attributes as null when the read did not include them; the
  // (non-secret) key id is still there. That is a worker misconfiguration, not a pending link.
  const masked = typeof accessKeyId === "string" && accessKeyId && secretAccessKey === null;
  if (!masked && (typeof accessKeyId !== "string" || !accessKeyId || typeof secretAccessKey !== "string" || !secretAccessKey)) throw new CommandError(`link ${linkId} has no access keys yet`, 409, "LINK_NOT_READY");
  if (masked || MASKED.test(String(accessKeyId)) || MASKED.test(String(secretAccessKey))) throw new PlatformError(`link ${linkId} came back with masked keys; the agent's API key needs the permission to read link secrets`, 500, "PLATFORM");
  if (link.service_id === undefined || link.service_id === null || link.service_id === "") throw new CommandError(`link ${linkId} has no service`, 409, "LINK_NOT_READY");
  const resolved = await resolveBucket(platform, String(link.service_id), config.specifications);

  const pathPrefix = normalisePathPrefix(attributes.path_prefix);
  if (pathPrefix) {
    const scoped = command.action === "list-objects" ? command.prefix : command.key!;
    if (command.action === "list-objects" && !command.prefix) command.prefix = pathPrefix;
    else if (!scoped.startsWith(pathPrefix)) throw new CommandError(`${command.action === "list-objects" ? "prefix" : "key"} is outside the link's path prefix ${pathPrefix}`, 403, "OUTSIDE_PREFIX");
  }
  if (command.action === "delete-object" && !WRITE_LEVELS.has(String(attributes.access_level ?? ""))) throw new CommandError(`link ${linkId} does not allow writes (access level ${String(attributes.access_level ?? "unknown")})`, 403, "WRITE_NOT_ALLOWED");
  return { target: { bucket: resolved.bucket, region: resolved.region, credentials: { accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string } }, pathPrefix };
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
  const replay = createReplayGuard(config.replay);
  return async (command) => {
    // Gate writes before any lookup: a refused delete costs no platform call.
    if (command.action === "delete-object" && !config.allowWrites) throw new CommandError("writes are disabled on this worker (S3_BROWSER_ALLOW_WRITES=1 enables them)", 405, "WRITES_DISABLED");
    if (command.link) {
      // Never act on the envelope alone: everything below uses the catalog-verified command.
      const executionId = command.link.execution_id;
      if (replay.has(executionId)) throw notVerified(`execution ${executionId} was already run by this worker`);
      const verified = await verifyExecution(platform, command);
      // One run per execution id: claimed before any link or S3 work.
      if (replay.has(executionId)) throw notVerified(`execution ${executionId} was already run by this worker`);
      replay.claim(executionId);
      const secrets: string[] = [];
      try {
        const scope = await resolveLink(platform, verified, config, secrets);
        return await runOnTarget(store, verified, scope.target);
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
