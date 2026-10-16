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
 *   `transport: notification`.
 *
 * All reduce to a `Command`; only the fields below matter here.
 */
export const ACTIONS = ["list-objects", "head-object", "presign-download", "delete-object"] as const;
export type Action = (typeof ACTIONS)[number];

export interface Command {
  action: Action;
  /** The nullplatform service (an aws-s3-bucket instance); the bucket comes from it, never from the caller. */
  service_id: string;
  prefix: string;
  token?: string;
  limit: number;
  key?: string;
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

export function parseCommand(raw: unknown): Command {
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
  let body: Record<string, unknown>;
  let service: Command["service"];
  let catalog: Command["catalog"];
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

  const action = body.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    throw new CommandError(`unknown action ${JSON.stringify(action ?? null)}; expected one of ${ACTIONS.join(", ")}`, 400, "UNKNOWN_ACTION");
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
  if (catalog) command.catalog = catalog;
  if (service) command.service = service;
  return command;
}
