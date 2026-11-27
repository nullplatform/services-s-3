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
/**
 * The operations of the `s3_browser` specification. No delete: deleting is the service's
 * `delete-object` link action, which goes through the link's approval; a catalog delete would skip it.
 */
export const LINK_ACTIONS = ["list-objects", "search-objects", "head-object", "presign-download", "presign-upload"] as const;
export type Action = (typeof LINK_ACTIONS)[number];

/** Default slug of the per-application catalog specification that selects link mode. */
export const DEFAULT_LINK_SPECIFICATION = "s3_browser";
/** The catalog's notification action for an action execution. */
export const CATALOG_ACTION = "catalog:action:create";
/** How a presign-download link tells the browser to treat the file: save it, or show it as plain text. */
export const DISPOSITIONS = ["attachment", "inline"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
/** The longest text `search-objects` looks for in a name. */
export const QUERY_MAX = 128;

export interface Command {
  action: Action;
  prefix: string;
  /** list-objects: S3's continuation token. search-objects: the last key the previous call looked at. */
  token?: string;
  /** list-objects: the page size. search-objects: how many matches end the call. */
  limit: number;
  key?: string;
  /** search-objects only: the text a file's or folder's name must contain, whatever its case. */
  query?: string;
  /** presign-download only: `attachment` (the default) or `inline`, a short-lived link that shows the file as plain text. */
  disposition?: Disposition;
  /** presign-upload only: the exact size in bytes of the file the upload is for. */
  size?: number;
  /** presign-upload only: the content type S3 stores for the object. */
  content_type?: string;
  /**
   * From the payload: the execution id and specification slug (and, for the opt-in unverified
   * fallback only, the application id it claims). `link_id`, `entity_nrn` and `actor_id` (the user
   * who ran the execution) are empty until the handler fills them from the catalog's record of it.
   */
  link?: { execution_id: string; specification_slug: string; envelope_application_id?: string; link_id: string; entity_nrn: string; actor_id: string };
}

/** The operations that take a `prefix` (a folder) instead of a `key` (an object). */
export const FOLDER_ACTIONS: ReadonlySet<Action> = new Set<Action>(["list-objects", "search-objects"]);

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
  "search-objects": ["link_id", "prefix", "query", "token", "limit"],
  "head-object": ["link_id", "key"],
  "presign-download": ["link_id", "key", "disposition"],
  "presign-upload": ["link_id", "key", "size", "content_type"],
};
const LINK_ID = /^[A-Za-z0-9-]{1,64}$/;
/** A media type without parameters, as a browser reports a file's: `text/csv`, `application/pdf`. */
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$/;
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
  const command: Command = { action: operation as Action, prefix: "", limit: 200, link: { execution_id: executionId, specification_slug: record(payload.specification)!.slug as string, link_id: "", entity_nrn: "", actor_id: "" } };
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
  if (!FOLDER_ACTIONS.has(action)) {
    key = typeof body.key === "string" ? body.key : undefined;
    if (!key || key.startsWith("/") || key.endsWith("/") || key.length > KEY_MAX) throw new CommandError("key is required (a relative object key)", 400);
  }
  const command: Command = { action, prefix, token, limit, key };
  if (action === "search-objects") {
    const query = body.query;
    if (typeof query !== "string" || !query.trim() || query.length > QUERY_MAX) throw new CommandError(`query is required (the text to look for, up to ${QUERY_MAX} characters)`, 400);
    command.query = query;
    // The token is where the last call stopped: a key under the folder searched, and nothing else.
    if (token !== undefined && (token.length > KEY_MAX || !token.startsWith(prefix))) throw new CommandError("token must be the next_token of a search of this prefix", 400);
  }
  if (action === "presign-upload") {
    // S3 replaces `${filename}` in a POST's key with the name of the file sent: the key would not be the one signed for.
    if (key!.includes("${filename}")) throw new CommandError("key may not contain ${filename}", 400);
    const size = body.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new CommandError("size is required (the file's size in bytes)", 400);
    command.size = size;
    const contentType = body.content_type === undefined || body.content_type === null || body.content_type === "" ? undefined : body.content_type;
    if (contentType !== undefined && (typeof contentType !== "string" || !CONTENT_TYPE.test(contentType))) throw new CommandError("content_type must be a media type such as text/csv", 400);
    command.content_type = contentType;
  }
  if (action === "presign-download") {
    const disposition = body.disposition === undefined ? "attachment" : body.disposition;
    if (!(DISPOSITIONS as readonly unknown[]).includes(disposition)) throw new CommandError(`disposition must be one of ${DISPOSITIONS.join(", ")}`, 400);
    command.disposition = disposition as Disposition;
  }
  command.link = { execution_id: "", specification_slug: "", link_id: linkId, entity_nrn: "", actor_id: "" };
  return command;
}
