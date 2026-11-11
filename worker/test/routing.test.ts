import { describe, expect, test } from "bun:test";
import { type Logger, handle, noopTracing, recordingPlatform } from "@nullplatform/plugin";
import { type EntrypointRun, bridgeConfigOf } from "../src/bridge";
import { CommandError, type Command } from "../src/protocol";
import { PlatformError } from "../src/platform";
import { createWorker } from "../src/plugin";

// Which route answers what, through the SDK's own transport (`handle`, what exec runs): catalog
// executions of s3_browser are the worker's; everything else is bash's, with NP_ACTION_CONTEXT the
// document as delivered.

const APP_NRN = "organization=1:account=2:namespace=3:application=4";
const ENV = { NP_SCOPE_ENTRYPOINT: "/app/pkg/aws-s3-bucket/entrypoint/entrypoint", NP_SERVICE_PATH: "/app/pkg/aws-s3-bucket", NP_API_KEY: "agent-key", HOME: "/home/app" };

function setup({ link = async (command: Command): Promise<unknown> => ({ handled: command.action }), exitCode = 0 } = {}) {
  const spawned: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
  const linked: Command[] = [];
  const logged: string[] = [];
  const spawn = async (argv: string[], env: Record<string, string | undefined>): Promise<EntrypointRun> => {
    spawned.push({ argv, env });
    return { exitCode, stdout: exitCode === 0 ? '{"ok":true}\n' : "partial\n", stderr: exitCode === 0 ? "" : "boom\n" };
  };
  const worker = createWorker({
    package: { name: "aws-s3-bucket", version: "1.2.3" },
    sources: ["service", "telemetry"],
    commandTypes: ["scope", "service", "action"],
    link: { handler: async (command) => (linked.push(command), link(command)), parse: {} },
    bridge: { ...bridgeConfigOf(ENV), spawn, mirror: { stdout: () => {}, stderr: () => {} } },
  });
  const log: Logger = { debug: () => {}, info: (m) => void logged.push(`info ${m}`), warn: (m) => void logged.push(`warn ${m}`), error: (m) => void logged.push(`error ${m}`) };
  const answer = async (document: unknown) => {
    const { output, success } = await handle(worker, typeof document === "string" ? document : JSON.stringify(document), { log, fetch: recordingPlatform().fetch, tracing: noopTracing });
    return { success, output: JSON.parse(output) };
  };
  return { worker, answer, spawned, linked, logged };
}

const catalog = (slug: string, specification: string, extra: Record<string, unknown> = {}) => ({
  notification: { id: "exec-1", action: "catalog:action:create", slug, input: { link_id: "lnk-1" }, status: "pending", specification: { id: "spec", slug: specification }, entity: { application_id: "4", nrn: APP_NRN }, entity_nrn: APP_NRN, ...extra },
});

describe("routing: link mode", () => {
  test("a catalog execution of s3_browser is the worker's; bash never runs", async () => {
    const { answer, spawned, linked } = setup();
    for (const slug of ["list-objects", "head-object", "read-object", "presign-download", "delete-object"]) {
      const { success, output } = await answer(catalog(slug, "s3_browser"));
      expect(success).toBe(true);
      // The worker's JSON on stdout, which the agent surfaces as the command's stdOut.
      expect(output).toEqual({ success: true, data: { stdout: JSON.stringify({ handled: slug }) } });
    }
    expect(linked.map((command) => [command.action, command.link?.execution_id])).toEqual(["list-objects", "head-object", "read-object", "presign-download", "delete-object"].map((slug) => [slug, "exec-1"]));
    expect(spawned).toEqual([]);
  });

  test("an s3_browser execution of an unknown operation is refused by the worker, not handed to bash", async () => {
    const { answer, spawned, linked } = setup();
    const { output } = await answer(catalog("rm-rf", "s3_browser"));
    expect(JSON.parse(output.data.stdout).error).toMatchObject({ status: 400, code: "UNKNOWN_ACTION" });
    expect(linked).toEqual([]);
    expect(spawned).toEqual([]);
  });

  test("a refusal is a completed command; a worker failure fails it with its code, its JSON logged as stdOut", async () => {
    const refusing = setup({ link: async () => Promise.reject(new CommandError("link lnk-1 does not belong to this application", 403, "LINK_NOT_OWNED")) });
    const refused = await refusing.answer(catalog("list-objects", "s3_browser"));
    expect(refused.success).toBe(true);
    expect(JSON.parse(refused.output.data.stdout)).toEqual({ error: { status: 403, code: "LINK_NOT_OWNED", message: "link lnk-1 does not belong to this application" } });

    const broken = setup({ link: async () => Promise.reject(new PlatformError("NP_API_KEY is not set on this worker; the agent injects it at spawn", 500, "NO_CREDENTIALS")) });
    const failed = await broken.answer(catalog("list-objects", "s3_browser"));
    expect(failed.success).toBe(false);
    expect(failed.output).toEqual({ success: false, error: "NP_API_KEY is not set on this worker; the agent injects it at spawn", errorCode: "NO_CREDENTIALS" });
    expect(broken.logged).toContain(`info ${JSON.stringify({ error: { status: 500, code: "NO_CREDENTIALS", message: "NP_API_KEY is not set on this worker; the agent injects it at spawn" } })}`);
    expect(broken.spawned).toEqual([]);
  });
});

describe("routing: everything else runs bash as worker-bridge did", () => {
  const documents: Array<[string, unknown]> = [
    ["a service action", { notification: { action: "service:action:create", slug: "create-s3-bucket", type: "create", service: { id: "svc-1", specification: { slug: "aws-s3-bucket" } }, parameters: { versioning: true } } }],
    ["a link action", { notification: { action: "link:action:create", slug: "create-s3-bucket-link", type: "create", service: { id: "svc-1" }, link: { id: "lnk-1", attributes: { credentials: "role" } } } }],
    ["a catalog execution of another specification", catalog("list-objects", "aws-s3-bucket")],
    ["the s3_browser slug without the catalog action", { notification: { action: "service:action:create", specification: { slug: "s3_browser" }, slug: "list-objects" } }],
    ["the old direct command (agent identity)", { action: "list-objects", service_id: "svc-1", prefix: "" }],
    ["the old nested command", { notification: { package: { slug: "s3-browser" } }, command: { action: "list-objects", service_id: "svc-1" } }],
    ["an unknown command", { notification: { action: "telemetry:metric:list", whatever: [1, 2.5, "x", null] } }],
  ];

  for (const [name, document] of documents) {
    test(`${name}: bash with the bridge's command line, environment and NP_ACTION_CONTEXT`, async () => {
      const { answer, spawned, linked } = setup();
      const { success, output } = await answer(document);
      expect(success).toBe(true);
      expect(output).toEqual({ success: true, data: { exitCode: 0, stdout: '{"ok":true}\n', stderr: "" } });
      expect(linked).toEqual([]);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.argv).toEqual(["bash", ENV.NP_SCOPE_ENTRYPOINT, `--service-path=${ENV.NP_SERVICE_PATH}`]);
      expect(spawned[0]!.env).toEqual({ ...ENV, NP_ACTION_CONTEXT: JSON.stringify(document) });
    });
  }

  test("NP_ACTION_CONTEXT is the whole document: the notification wrapper and its siblings, not the unwrapped payload", async () => {
    const { answer, spawned } = setup();
    const document = { notification: { action: "service:action:create", id: 1 }, sibling: { kept: true } };
    await answer(document);
    expect(JSON.parse(spawned[0]!.env.NP_ACTION_CONTEXT!)).toEqual(document);
    // A document the shell left single-quoted (as the service channel's '${NOTIFICATION_CONTEXT}') arrives unquoted.
    await answer(`'${JSON.stringify(document)}'`);
    expect(JSON.parse(spawned[1]!.env.NP_ACTION_CONTEXT!)).toEqual(document);
  });

  test("a non-zero exit fails the command with the bridge's error text", async () => {
    const { answer, logged } = setup({ exitCode: 3 });
    const { success, output } = await answer({ notification: { action: "service:action:create" } });
    expect(success).toBe(false);
    expect(output).toEqual({ success: false, error: "boom\n", errorCode: "ENTRYPOINT_FAILED" });
    expect(logged.slice(0, 2)).toEqual(["info partial\n", "warn boom\n"]);
  });
});

describe("describe", () => {
  test("the package, its agent channel's selector and sources, and the bridge's command types", () => {
    const { worker } = setup();
    const manifest = worker.manifest();
    // worker-bridge's manifest was { name, version, command_types, agent: { selector, sources } }.
    expect(manifest).toMatchObject({ name: "aws-s3-bucket", slug: "aws-s3-bucket", version: "1.2.3", command_types: ["scope", "service", "action"], agent: { selector: { package: "aws-s3-bucket" }, sources: ["service", "telemetry"] } });
    // As the bridge's, it registers no channel of its own: the service's tofu module manages it.
    expect(manifest.components).toEqual([]);
    expect(worker.routes.map((route) => route.name)).toEqual(["link-mode", "execute"]);
  });
});
