import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ActionError } from "@nullplatform/plugin";
import { ENTRYPOINT_FAILED, type EntrypointRun, bridgeConfigOf, bunSpawn, entrypointArgv, failureMessage, runEntrypoint } from "../src/bridge";

// worker-bridge v2.0.7 (nullplatform/worker-bridge src/index.ts) is the reference: its defaults,
// its command line, its environment and its answer.

const FIXTURE = resolve(import.meta.dir, "fixtures/entrypoint");

function recorder() {
  const logged: string[] = [];
  const mirrored: string[] = [];
  return {
    logged,
    mirrored,
    context: { log: { debug: () => {}, info: (m: string) => void logged.push(`info ${m}`), warn: (m: string) => void logged.push(`warn ${m}`), error: (m: string) => void logged.push(`error ${m}`) } },
    mirror: { stdout: (t: string) => void mirrored.push(`stdout ${t}`), stderr: (t: string) => void mirrored.push(`stderr ${t}`) },
  };
}

describe("bridge settings", () => {
  test("worker-bridge's defaults: /app/entrypoint, /app, no overrides", () => {
    expect(bridgeConfigOf({})).toEqual({ entrypoint: "/app/entrypoint", servicePath: "/app", overridesPaths: [], env: {} });
  });

  test("NP_OVERRIDES_PATH is comma-separated, trimmed, blanks dropped; each is one --overrides-path", () => {
    const config = bridgeConfigOf({ NP_SCOPE_ENTRYPOINT: "/app/pkg/aws-s3-bucket/entrypoint/entrypoint", NP_SERVICE_PATH: "/app/pkg/aws-s3-bucket", NP_OVERRIDES_PATH: " /o/a, ,/o/b ," });
    expect(entrypointArgv(config)).toEqual(["bash", "/app/pkg/aws-s3-bucket/entrypoint/entrypoint", "--service-path=/app/pkg/aws-s3-bucket", "--overrides-path=/o/a", "--overrides-path=/o/b"]);
    expect(entrypointArgv(bridgeConfigOf({ NP_OVERRIDES_PATH: "" }))).toEqual(["bash", "/app/entrypoint", "--service-path=/app"]);
  });

  test("the failure text: the last 4000 characters of stderr, else stdout, else the exit code", () => {
    expect(failureMessage({ exitCode: 3, stdout: "out", stderr: "err" })).toBe("err");
    expect(failureMessage({ exitCode: 3, stdout: "out", stderr: "" })).toBe("out");
    expect(failureMessage({ exitCode: 3, stdout: "", stderr: "" })).toBe("entrypoint exited 3");
    expect(failureMessage({ exitCode: 1, stdout: "", stderr: `${"a".repeat(10)}${"b".repeat(4000)}` })).toBe("b".repeat(4000));
  });
});

describe("runEntrypoint", () => {
  test("runs the command line with the worker's environment plus NP_ACTION_CONTEXT; exit 0 answers { exitCode, stdout, stderr }", async () => {
    const spawned: Array<{ argv: string[]; env: Record<string, string | undefined> }> = [];
    const spawn = async (argv: string[], env: Record<string, string | undefined>): Promise<EntrypointRun> => (spawned.push({ argv, env }), { exitCode: 0, stdout: "out\n", stderr: "err\n" });
    const { context, mirror, logged, mirrored } = recorder();
    const config = bridgeConfigOf({ NP_SCOPE_ENTRYPOINT: "/e", NP_SERVICE_PATH: "/s", NP_API_KEY: "k", PATH: "/bin", NP_ACTION_CONTEXT: "stale" });
    const answer = await runEntrypoint('{"notification":{}}', context, config, spawn, mirror);
    // The bridge's answer, keys in its order (what the gRPC result's data bytes carry).
    expect(JSON.stringify(answer)).toBe('{"exitCode":0,"stdout":"out\\n","stderr":"err\\n"}');
    expect(spawned).toEqual([{ argv: ["bash", "/e", "--service-path=/s"], env: { NP_SCOPE_ENTRYPOINT: "/e", NP_SERVICE_PATH: "/s", NP_API_KEY: "k", PATH: "/bin", NP_ACTION_CONTEXT: '{"notification":{}}' } }]);
    // Mirrored to the worker's own streams, never logged (nothing is streamed to the agent).
    expect(mirrored).toEqual(["stdout out\n", "stderr err\n"]);
    expect(logged).toEqual([]);
  });

  test("a non-zero exit fails with the bridge's error text; both streams are logged for the agent", async () => {
    const { context, mirror, logged, mirrored } = recorder();
    const spawn = async (): Promise<EntrypointRun> => ({ exitCode: 3, stdout: "partial\n", stderr: "tofu apply failed\n" });
    const error = await runEntrypoint("{}", context, bridgeConfigOf({}), spawn, mirror).catch((e) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect(error).toMatchObject({ code: ENTRYPOINT_FAILED, message: "tofu apply failed\n" });
    expect(mirrored).toEqual(["stdout partial\n", "stderr tofu apply failed\n"]);
    expect(logged).toEqual(["info partial\n", "warn tofu apply failed\n"]);
  });

  test("a silent failure says the exit code", async () => {
    const { context, mirror, logged } = recorder();
    const error = await runEntrypoint("{}", context, bridgeConfigOf({}), async () => ({ exitCode: 7, stdout: "", stderr: "" }), mirror).catch((e) => e);
    expect(error.message).toBe("entrypoint exited 7");
    expect(logged).toEqual([]);
  });

  test("Bun's spawn runs a real script: arguments, environment, streams and exit code", async () => {
    const config = bridgeConfigOf({ NP_SCOPE_ENTRYPOINT: FIXTURE, NP_SERVICE_PATH: "/svc", NP_OVERRIDES_PATH: "/o", PATH: process.env.PATH, FIXTURE_INHERITED: "yes" });
    const { context, mirror } = recorder();
    const ok = await runEntrypoint('{"notification":{"action":"service:action:create"}}', context, config, bunSpawn, mirror);
    expect(ok).toEqual({
      exitCode: 0,
      stdout: 'args=--service-path=/svc --overrides-path=/o\ncontext={"notification":{"action":"service:action:create"}}\ninherited=yes\nimds=unset\n',
      stderr: "warning on stderr\n",
    });
    const failed = await runEntrypoint('{"fixture":"fail"}', context, config, bunSpawn, mirror).catch((e) => e);
    expect(failed).toMatchObject({ code: ENTRYPOINT_FAILED, message: "warning on stderr\ntofu apply failed\n" });
  });
});
