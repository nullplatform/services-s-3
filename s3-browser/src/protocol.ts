/**
 * The command the UI plugin sends through `POST /controlplane/agent_command` (type
 * `package-exec`, package `s3-browser`): it travels as NP_ACTION_CONTEXT and reaches
 * `execute()` as the payload. The platform adds `notification.package` for image
 * resolution; only the fields below matter here.
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
  // Either flat, or nested under `command` next to the platform's `notification`.
  const body = (outer.command && typeof outer.command === "object" ? outer.command : outer) as Record<string, unknown>;

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
  return { action: action as Action, service_id: serviceId, prefix, token, limit, key };
}
