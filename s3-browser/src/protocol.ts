/**
 * What the worker receives as NP_ACTION_CONTEXT / the execute() payload, in three shapes:
 *
 * - the service-action envelope `{ notification: { specification: { slug }, parameters,
 *   service: { id, attributes, specification: { slug } } } }`, built by the services API for
 *   `POST /service/:id/action` and substituted into the agent channel's command;
 * - the legacy direct command `{ action, service_id, ...fields }` sent through
 *   `POST /controlplane/agent_command` (optionally nested under `command`).
 *
 * - the catalog envelope `{ notification: { action: "catalog:action:create", slug, input,
 *   entity: { bucket_name, region } } }`, built by the catalog API for an executor with
 *   `transport: notification`;
 * - link mode: the same catalog envelope for the `s3_browser` specification (one entity per
 *   application). `input.link_id` names the link whose IAM keys open S3 and the top-level
 *   `entity_nrn` is the application it must belong to (see catalog/LINK_MODE.md).
 *
 * All reduce to a `Command`; only the fields below matter here.
 */
/** The service-action, legacy and bucket-entity catalog modes. */
export const ACTIONS = ["list-objects", "head-object", "presign-download", "delete-object"] as const;
/** Link mode adds `read-object`; the other modes do not declare it, so they refuse it. */
export const LINK_ACTIONS = [...ACTIONS, "read-object"] as const;
export type Action = (typeof LINK_ACTIONS)[number];

/** Default slug of the per-application catalog specification that selects link mode. */
export const DEFAULT_LINK_SPECIFICATION = "s3_browser";
export const READ_MAX_BYTES = 262_144;

export interface Command {
  action: Action;
  /** The nullplatform service (an aws-s3-bucket instance); the bucket comes from it, never from the caller. */
  service_id: string;
  prefix: string;
  token?: string;
  limit: number;
  key?: string;
  /** read-object only: how many bytes to read from the start of the object. */
  max_bytes?: number;
  /**
   * Link mode: the link to open S3 with, plus what the envelope claims about the execution.
   * `entity_nrn` is informational only: the handler verifies the execution with the catalog and
   * takes the operation, its fields and the entity NRN from there.
   */
  link?: { link_id: string; entity_nrn: string; execution_id: string; specification_slug: string };
  /** Present for the action envelope: what the platform sent about the service. Never caller-controlled. */
  /** Present for the catalog envelope: the catalog instance IS the bucket, no lookup. */
  catalog?: { bucket: string; region: string };
  service?: { attributes: Record<string, unknown>; specification_slug?: string };
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

export function parseCommand(raw: unknown, { linkSpecification = DEFAULT_LINK_SPECIFICATION }: ParseOptions = {}): Command {
  let value: unknown = raw;
  if (Buffer.isBuffer(raw)) value = raw.toString("utf8");
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new CommandError("payload is not JSON", 400);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommandError("payload must be an object", 400);
  const outer = value as Record<string, unknown>;
  const record = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);

  // The action envelope: no legacy `action`/`command`, the operation is the action slug.
  const notification = record(outer.notification);
  const slug = record(notification?.specification)?.slug;
  const catalogEntity = record(notification?.entity);
  const isCatalog =
    outer.action === undefined && outer.command === undefined && notification !== undefined &&
    (notification.action === "catalog:action:create" || (typeof notification.slug === "string" && record(notification.input) !== undefined && catalogEntity !== undefined));
  const isEnvelope = !isCatalog && outer.action === undefined && outer.command === undefined && typeof slug === "string";
  const isLink = isCatalog && typeof slug === "string" && slug === linkSpecification;
  let body: Record<string, unknown>;
  let service: Command["service"];
  let catalog: Command["catalog"];
  if (isLink) {
    // The envelope only says WHICH execution this is; what to do comes from the catalog's own
    // record of it (the handler re-reads it before anything else). Parsing the envelope's input
    // here only rejects malformed requests early.
    const executionId = notification!.id;
    if (typeof executionId !== "string" || !EXECUTION_ID.test(executionId)) throw new CommandError("notification.id (the catalog execution) is required", 400);
    const parsed = parseLinkOperation(notification!.slug, notification!.input);
    const entityNrn = notification!.entity_nrn;
    if (typeof entityNrn !== "string" || !entityNrn) throw new CommandError("entity_nrn is required", 400);
    parsed.link = { ...parsed.link!, entity_nrn: entityNrn, execution_id: executionId, specification_slug: slug as string };
    return parsed;
  }
  if (isCatalog) {
    // Operation = slug, fields = input; bucket and region come from the entity only.
    const { bucket, region } = { bucket: catalogEntity?.bucket_name, region: catalogEntity?.region };
    if (typeof bucket !== "string" || !bucket) throw new CommandError("entity.bucket_name is required", 400, "NO_BUCKET");
    if (typeof region !== "string" || !region) throw new CommandError("entity.region is required", 400, "NO_REGION");
    body = { ...(record(notification!.input) ?? {}), action: notification!.slug, service_id: "catalog" };
    catalog = { bucket, region };
  } else if (isEnvelope) {
    const entity = record(notification!.service);
    body = { ...(record(notification!.parameters) ?? {}), action: slug, service_id: entity?.id };
    service = { attributes: record(entity?.attributes) ?? {}, specification_slug: typeof record(entity?.specification)?.slug === "string" ? (record(entity?.specification)!.slug as string) : undefined };
  } else {
    // Either flat, or nested under `command` next to the platform's `notification`.
    body = (outer.command && typeof outer.command === "object" ? outer.command : outer) as Record<string, unknown>;
  }

  const command = buildCommand(body, ACTIONS);
  if (catalog) command.catalog = catalog;
  if (service) command.service = service;
  return command;
}

/** The validation every mode shares, on the operation and its flattened fields. */
function buildCommand(body: Record<string, unknown>, actions: readonly string[]): Command {
  const action = body.action;
  if (typeof action !== "string" || !actions.includes(action)) {
    throw new CommandError(`unknown action ${JSON.stringify(action ?? null)}; expected one of ${actions.join(", ")}`, 400, "UNKNOWN_ACTION");
  }
  const serviceId = body.service_id;
  if (typeof serviceId !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(serviceId)) throw new CommandError("service_id is required", 400);

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
  const command: Command = { action: action as Action, service_id: serviceId, prefix, token, limit, key };
  if (action === "read-object") {
    const maxBytes = body.max_bytes === undefined || body.max_bytes === null ? READ_MAX_BYTES : body.max_bytes;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > READ_MAX_BYTES) throw new CommandError(`max_bytes must be an integer between 1 and ${READ_MAX_BYTES}`, 400);
    command.max_bytes = maxBytes;
  }
  return command;
}

/**
 * A link-mode operation and its input, as the s3_browser schemas define them: only the
 * declared fields, `link_id` required. Used on the envelope and on the catalog's record.
 */
export function parseLinkOperation(operation: unknown, rawInput: unknown): Command {
  const input = rawInput === undefined || rawInput === null ? {} : rawInput;
  if (typeof input !== "object" || Array.isArray(input)) throw new CommandError("input must be an object", 400);
  const fields = input as Record<string, unknown>;
  if (typeof operation !== "string" || !(LINK_ACTIONS as readonly string[]).includes(operation)) {
    throw new CommandError(`unknown action ${JSON.stringify(operation ?? null)}; expected one of ${LINK_ACTIONS.join(", ")}`, 400, "UNKNOWN_ACTION");
  }
  const extra = Object.keys(fields).filter((field) => !LINK_INPUT_FIELDS[operation].includes(field));
  if (extra.length) throw new CommandError(`unexpected input field(s): ${extra.join(", ")}`, 400);
  const linkId = fields.link_id;
  if (typeof linkId !== "string" || !LINK_ID.test(linkId)) throw new CommandError("link_id is required (1-64 letters, digits or dashes)", 400);
  const command = buildCommand({ ...fields, action: operation, service_id: "link" }, LINK_ACTIONS);
  command.link = { link_id: linkId, entity_nrn: "", execution_id: "", specification_slug: "" };
  return command;
}
