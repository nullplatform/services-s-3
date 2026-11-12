/**
 * One command in, one JSON result out. The result travels back to the caller of the agent
 * command as the worker's stdout (the agent surfaces `data.stdout` when nothing streamed, the
 * API parses it into `result`), so business refusals are results too — `{ error }` with an
 * HTTP-like status — and only worker failures are unsuccessful executions.
 */
import type { ExecuteResult } from "@nullplatform/plugin";
import { type Command, CommandError, parseCommand } from "./protocol";
import { type Platform, PlatformError, resolveBucket } from "./platform";
import { type ObjectStore, StoreError } from "./s3";

export interface HandlerConfig {
  /** Accepted specification slugs; a trailing `*` matches a prefix. */
  specifications: string[];
  /** `delete-object` only when true. */
  allowWrites: boolean;
}

export type Handler = (command: Command) => Promise<unknown>;

export function createHandler({ platform, store, config }: { platform: Platform; store: ObjectStore; config: HandlerConfig }): Handler {
  return async (command) => {
    const { bucket, region } = await resolveBucket(platform, command.service_id, config.specifications);
    const target = { bucket, region };
    switch (command.action) {
      case "list-objects":
        return store.list(target, command.prefix, command.token, command.limit);
      case "head-object":
        return store.head(target, command.key!);
      case "presign-download":
        return store.presign(target, command.key!);
      case "delete-object":
        if (!config.allowWrites) throw new CommandError("writes are disabled on this worker (S3_BROWSER_ALLOW_WRITES=1 enables them)", 405, "WRITES_DISABLED");
        return store.remove(target, command.key!);
    }
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
export async function runCommand(payload: Buffer | string, handler: Handler): Promise<ExecuteResult & { data: { stdout: string } }> {
  try {
    const command = parseCommand(payload);
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
