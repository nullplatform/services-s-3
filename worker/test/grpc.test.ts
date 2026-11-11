import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type PluginTestClient, startPluginProcess } from "@nullplatform/plugin/testing";

// The worker as the agent runs it: src/index.ts started with the agent's cookie, driven over its
// gRPC protocol, the bash entrypoint a fixture. The results are compared with what worker-bridge
// v2.0.7 answered for the same runs (its execute() result through @nullplatform/plugin 0.0.4's
// gRPC server): data `{ exitCode, stdout, stderr }`, error "", exit_code 0, error_code "", and
// nothing streamed.

const FIXTURE = resolve(import.meta.dir, "fixtures/entrypoint");
let plugin: PluginTestClient;
let dir: string;
let ranLog: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "s3-worker-grpc-"));
  ranLog = join(dir, "ran");
  plugin = await startPluginProcess(resolve(import.meta.dir, "../src/index.ts"), {
    env: {
      NP_PACKAGE_NAME: "aws-s3-bucket",
      NP_SCOPE_ENTRYPOINT: FIXTURE,
      NP_SERVICE_PATH: "/app/pkg/aws-s3-bucket",
      NP_OVERRIDES_PATH: "/o/a,/o/b",
      FIXTURE_INHERITED: "from-the-worker",
      FIXTURE_LOG: ranLog,
      // No platform at all: link mode fails closed before any request (NO_CREDENTIALS).
      NP_API_KEY: "",
      NP_API_URL: "http://127.0.0.1:9",
    },
  });
});

afterAll(() => {
  plugin?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const ran = () => (existsSync(ranLog) ? readFileSync(ranLog, "utf8").split("\n").filter(Boolean).length : 0);

describe("over the agent's gRPC protocol", () => {
  test("a service action runs bash; the result is worker-bridge's", async () => {
    const document = { notification: { action: "service:action:create", slug: "create-s3-bucket", service: { id: "svc-1", specification: { slug: "aws-s3-bucket" } } } };
    const before = ran();
    const response = await plugin.execute(document);
    expect(ran()).toBe(before + 1);
    expect(response.result).toEqual({
      success: true,
      data: {
        exitCode: 0,
        stdout: `args=--service-path=/app/pkg/aws-s3-bucket --overrides-path=/o/a --overrides-path=/o/b\ncontext=${JSON.stringify(document)}\ninherited=from-the-worker\nimds=unset\n`,
        stderr: "warning on stderr\n",
      },
      error: "",
      errorCode: "",
      exitCode: 0,
    });
    // Started, then the result: nothing streamed, as the bridge streamed nothing.
    expect(response.events.map((event) => Object.keys(event).find((key) => event[key as keyof typeof event]))).toEqual(["started", "result"]);
  });

  test("a failing entrypoint: the bridge's error text; the streams reach the agent as output", async () => {
    const response = await plugin.execute({ notification: { action: "link:action:create", fixture: "fail" } });
    expect(response.result).toMatchObject({ success: false, error: "warning on stderr\ntofu apply failed\n", errorCode: "ENTRYPOINT_FAILED", exitCode: 1 });
    const streamed = response.events.flatMap((event) => (event.output ? [event.output] : []));
    expect(streamed.map((output) => output.stdout).join("")).toContain("args=--service-path=/app/pkg/aws-s3-bucket");
    expect(streamed.map((output) => output.stderr).join("")).toContain("tofu apply failed");
  });

  test("a catalog execution of s3_browser is the worker's: it fails closed without an API key, and bash never runs", async () => {
    const before = ran();
    const response = await plugin.execute({ notification: { id: "exec-1", action: "catalog:action:create", slug: "list-objects", input: { link_id: "lnk-1" }, specification: { slug: "s3_browser" }, entity: { application_id: "4" } } });
    expect(ran()).toBe(before);
    expect(response.result).toMatchObject({ success: false, errorCode: "NO_CREDENTIALS", exitCode: 1 });
  });

  test("the old agent-identity shapes go to bash, never to S3", async () => {
    const before = ran();
    for (const document of [{ action: "list-objects", service_id: "svc-1" }, { notification: { action: "catalog:action:create", slug: "list-objects", input: {}, entity: { bucket_name: "b", region: "us-east-1" }, specification: { slug: "aws-s3-bucket" } } }]) {
      const response = await plugin.execute(document);
      expect(response.result).toMatchObject({ success: true, exitCode: 0, data: { exitCode: 0 } });
    }
    expect(ran()).toBe(before + 2);
  });

  test("the IMDS guard of the S3 browser does not reach bash's environment", async () => {
    const response = await plugin.execute({ notification: { action: "service:action:create" } });
    expect((response.result?.data as { stdout: string }).stdout).toContain("imds=unset\n");
  });
});
