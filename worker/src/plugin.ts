/**
 * The image's worker: one plugin, two routes, tried in order.
 *
 *   1. link-mode: catalog executions of the `s3_browser` specification (`action:
 *      catalog:action:create`, `specification.slug: s3_browser`) are the S3 browser's, answered
 *      here with the link's own keys or role, after every catalog and link check.
 *   2. execute: everything else (the aws-s3-bucket service's service and link actions, and any
 *      command this worker does not know) runs the bash entrypoint, as worker-bridge did.
 *
 * The S3 browser never opens S3 with the worker's own identity: a payload that is not a verified
 * link-mode execution goes to bash, which knows nothing of it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ActionError, definePlugin, execute, type Context, type Plugin, type Route } from "@nullplatform/plugin";
import { type BridgeConfig, type Mirror, type Spawn, runEntrypoint } from "./bridge";
import { type Handler, type LinkResult, runCommand } from "./handler";
import { type ParseOptions, isLinkPayload } from "./protocol";

export interface WorkerOptions {
  /** NP_PACKAGE_NAME (default `worker`) and NP_PACKAGE_VERSION (default `0.0.0`), as the bridge named itself. */
  package: { name: string; version: string };
  /** NP_AGENT_SOURCES: the notification sources the bridge's manifest declared for the package's channel. */
  sources: string[];
  /** NP_COMMAND_TYPES: the command types the bridge's manifest and Capabilities declared. */
  commandTypes: string[];
  link: { handler: Handler; parse: ParseOptions };
  bridge: BridgeConfig & { spawn?: Spawn; mirror?: Mirror };
}

/** The document a transport delivered, for the bash route: the SDK hands routes only the payload it unwraps from it. */
const delivered = new AsyncLocalStorage<Record<string, unknown>>();

/** The link-mode answer: the result JSON on stdout; a failed execution logs it, as the agent's stdOut, and fails with its code. */
function linkAnswer(result: LinkResult, context: Pick<Context, "log">): { stdout: string } {
  if (result.success) return result.data;
  context.log.info(result.data.stdout);
  throw new ActionError(result.errorCode ?? "WORKER", result.error ?? "the worker failed");
}

export function linkRoute(link: WorkerOptions["link"]): Route {
  return {
    name: "link-mode",
    match: (payload) => isLinkPayload(payload, link.parse),
    handler: async (payload, context) => {
      // No streamed output on success: every emitted line becomes a partial update on the caller's
      // response, and the result must stay one JSON document on stdout.
      const started = Date.now();
      const result = await runCommand(payload, link.handler, link.parse);
      console.error(`[s3-browser] ${result.success ? "completed" : "failed"} in ${Date.now() - started} ms`);
      return linkAnswer(result, context);
    },
  };
}

export function bridgeRoute(bridge: WorkerOptions["bridge"]): Route {
  return execute(async (_payload, context) => {
    // NP_ACTION_CONTEXT is the whole document the agent delivered, `{ notification }` wrapper
    // and all, as the bridge passed it, not the payload the SDK unwrapped from it.
    const document = delivered.getStore();
    if (!document) throw new Error("the bash route runs only inside createWorker's plugin");
    return runEntrypoint(JSON.stringify(document), context, bridge, bridge.spawn, bridge.mirror);
  });
}

export function createWorker(options: WorkerOptions): Plugin {
  const agent = { selector: { package: options.package.name }, sources: options.sources };
  const plugin = definePlugin({
    package: options.package,
    agent,
    routes: [linkRoute(options.link), bridgeRoute(options.bridge)],
    // The bridge's manifest fields, which the SDK's describe has no place for (no route declares a
    // channel, and its Capabilities always answer `action`): printed beside it, as the bridge did.
    tooling: { command_types: options.commandTypes, agent },
  });
  // Every transport answers through `answer` with the parsed document: keep it for the bash route.
  return { ...plugin, answer: (document, ports) => delivered.run(document, () => plugin.answer(document, ports)) };
}
