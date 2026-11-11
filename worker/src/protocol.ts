/**
 * What the link-mode route receives: the payload the agent delivered, which the SDK has already
 * unwrapped from its `{ notification }` document. Link mode is the catalog's context for the
 * `s3_browser` specification (one entity per application):
 *
 *   `{ id, action: "catalog:action:create", slug: "<operation>", input, status,
 *      specification: { id, slug: "s3_browser" }, entity: {...}, entity_nrn, user }`
 *
 * Only `id` (the execution) and `slug` are taken from it; the handler reads everything else,
 * `link_id` included, from the catalog's record of the execution (see catalog/LINK_MODE.md).
 * Every other payload belongs to the bash service and never reaches this module.
 */
/** The operations of the `s3_browser` specification. */
export const LINK_ACTIONS = ["list-objects", "head-object", "read-object", "presign-download", "delete-object"] as const;
export type Action = (typeof LINK_ACTIONS)[number];

/** Default slug of the per-application catalog specification that selects link mode. */
export const DEFAULT_LINK_SPECIFICATION = "s3_browser";
/** The catalog's notification action for an action execution. */
export const CATALOG_ACTION = "catalog:action:create";
export const READ_MAX_BYTES = 262_144;

export interface Command {
  action: Action;
  prefix: string;
  token?: string;
  limit: number;
  key?: string;
  /** read-object only: how many bytes to read from the start of the object. */
  max_bytes?: number;
  /**
   * From the payload: the execution id and specification slug (and, for the opt-in unverified
   * fallback only, the application id it claims). `link_id` and `entity_nrn` are empty until the
   * handler fills them from the catalog's record of the execution.
   */
  link?: { execution_id: string; specification_slug: string; envelope_application_id?: string; link_id: string; entity_nrn: string };
}

/** A refusal the caller can act on; `status` follows HTTP semantics for the UI's messages. */
export class CommandError extends Error {
  constructor(message: string, readonly status: number, readonly code = "BAD_REQUEST") {
    super(message);
    this.name = "CommandError";
  }
}

const KEY_MAX = 1024;

export interface ParseOptions {
  /** Catalog specification slug that selects link mode (S3_BROWSER_LINK_SPECIFICATION). */
  linkSpecification?: string;
}

/** Fields each link-mode action accepts in `input`; anything else is refused, as the schemas do. */
export const LINK_INPUT_FIELDS: Record<string, string[]> = {
  "list-objects": ["link_id", "prefix", "token", "limit"],
  "head-object": ["link_id", "key"],
  "read-object": ["link_id", "key", "max_bytes"],
  "presign-download": ["link_id", "key"],
  "delete-object": ["link_id", "key"],
};
const LINK_ID = /^[A-Za-z0-9-]{1,64}$/;
const EXECUTION_ID = /^[A-Za-z0-9-]{1,64}$/;

const record = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);

/** Whether the worker answers `payload`: a catalog execution of the link specification. Anything else is the bash service's. */
export function isLinkPayload(payload: Record<string, unknown>, { linkSpecification = DEFAULT_LINK_SPECIFICATION }: ParseOptions = {}): boolean {
  return payload.action === CATALOG_ACTION && record(payload.specification)?.slug === linkSpecification;
}

/** The link-mode command a payload names: which execution, which operation, nothing else. */
export function parseCommand(payload: Record<string, unknown>, options: ParseOptions = {}): Command {
  if (!isLinkPayload(payload, options)) throw new CommandError("not a link-mode payload", 400);
  // Nothing but WHICH execution this is comes from the payload: the operation's fields come
  // from the catalog's record of it, read by the handler before anything else.
  const executionId = payload.id;
  if (typeof executionId !== "string" || !EXECUTION_ID.test(executionId)) throw new CommandError("notification.id (the catalog execution) is required", 400);
  const operation = payload.slug;
  if (typeof operation !== "string" || !(LINK_ACTIONS as readonly string[]).includes(operation)) {
    throw new CommandError(`unknown action ${JSON.stringify(operation ?? null)}; expected one of ${LINK_ACTIONS.join(", ")}`, 400, "UNKNOWN_ACTION");
  }
  const entity = record(payload.entity);
  const claimed = entity?.application_id ?? entity?.id;
  const command: Command = { action: operation as Action, prefix: "", limit: 200, link: { execution_id: executionId, specification_slug: record(payload.specification)!.slug as string, link_id: "", entity_nrn: "" } };
  if ((typeof claimed === "string" || typeof claimed === "number") && /^\d+$/.test(String(claimed))) command.link!.envelope_application_id = String(claimed);
  return command;
}

/**
 * A link-mode operation and its input, as the s3_browser schemas define them: only the
 * declared fields, `link_id` required. Used on the catalog's record of the execution.
 */
export function parseLinkOperation(operation: unknown, rawInput: unknown): Command {
  const input = rawInput === undefined || rawInput === null ? {} : rawInput;
  if (typeof input !== "object" || Array.isArray(input)) throw new CommandError("input must be an object", 400);
  const body = input as Record<string, unknown>;
  if (typeof operation !== "string" || !(LINK_ACTIONS as readonly string[]).includes(operation)) {
    throw new CommandError(`unknown action ${JSON.stringify(operation ?? null)}; expected one of ${LINK_ACTIONS.join(", ")}`, 400, "UNKNOWN_ACTION");
  }
  const action = operation as Action;
  const extra = Object.keys(body).filter((field) => !LINK_INPUT_FIELDS[action].includes(field));
  if (extra.length) throw new CommandError(`unexpected input field(s): ${extra.join(", ")}`, 400);
  const linkId = body.link_id;
  if (typeof linkId !== "string" || !LINK_ID.test(linkId)) throw new CommandError("link_id is required (1-64 letters, digits or dashes)", 400);

  const prefix = body.prefix === undefined || body.prefix === null ? "" : body.prefix;
  if (typeof prefix !== "string" || prefix.startsWith("/") || prefix.length > KEY_MAX) throw new CommandError("prefix must be a relative key prefix", 400);

  const limit = body.limit === undefined || body.limit === null ? 200 : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new CommandError("limit must be an integer between 1 and 1000", 400);

  const token = body.token === undefined || body.token === null || body.token === "" ? undefined : String(body.token);

  let key: string | undefined;
  if (action !== "list-objects") {
    key = typeof body.key === "string" ? body.key : undefined;
    if (!key || key.startsWith("/") || key.endsWith("/") || key.length > KEY_MAX) throw new CommandError("key is required (a relative object key)", 400);
  }
  const command: Command = { action, prefix, token, limit, key };
  if (action === "read-object") {
    const maxBytes = body.max_bytes === undefined || body.max_bytes === null ? READ_MAX_BYTES : body.max_bytes;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > READ_MAX_BYTES) throw new CommandError(`max_bytes must be an integer between 1 and ${READ_MAX_BYTES}`, 400);
    command.max_bytes = maxBytes;
  }
  command.link = { execution_id: "", specification_slug: "", link_id: linkId, entity_nrn: "" };
  return command;
}
