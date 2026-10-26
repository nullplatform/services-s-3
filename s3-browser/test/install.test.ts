import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// catalog/install.mjs is plain JavaScript for Node; loaded through a variable path so the
// typecheck does not need declarations for it.
const path = resolve(import.meta.dir, "../catalog/install.mjs");
const installer = await import(path);

const AGENT_KEY = "agent-key-should-never-print";
const API_KEY = "admin-key-should-never-print";
const env = { NP_API_KEY: API_KEY, NP_API_URL: "https://api.test", NRN: "organization=1", AGENT_API_KEY: AGENT_KEY };

type Call = { method: string; url: string; body?: unknown };

/** A fake API: answers by "METHOD path" (query included), records every call. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.replace("https://api.test", "");
    if (path === "/token") return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: `no route ${method} ${path}` }), { status: 500 });
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), { status: route.status ?? 200 });
  };
  return { fetchImpl, calls };
}

describe("install.mjs pure parts", () => {
  test("parseArgs", () => {
    expect(installer.parseArgs(["--dry-run", "--skip-seed"])).toMatchObject({ dryRun: true, skipSeed: true, skipChannel: false });
    expect(() => installer.parseArgs(["--nope"])).toThrow(/unknown argument/);
  });

  test("applicationOf cuts the NRN after the application segment", () => {
    expect(installer.applicationOf("organization=1:account=2:namespace=3:application=4:scope=5")).toEqual({ application_id: "4", nrn: "organization=1:account=2:namespace=3:application=4" });
    expect(installer.applicationOf("organization=1:account=2:namespace=3:application=4")).toEqual({ application_id: "4", nrn: "organization=1:account=2:namespace=3:application=4" });
    expect(installer.applicationOf("organization=1:account=2:namespace=3:application=45x")).toBeUndefined();
    expect(installer.applicationOf("organization=1:account=2:namespace=3")).toBeUndefined();
    expect(installer.applicationOf(undefined)).toBeUndefined();
  });

  test("channelBody fills nrn and api_key without touching the template; redact hides keys", () => {
    const template = { nrn: "<x>", configuration: { api_key: "<k>", selector: { package: "s3-browser" } } };
    const body = installer.channelBody(template, { nrn: "organization=1", agentApiKey: AGENT_KEY });
    expect(body).toEqual({ nrn: "organization=1", configuration: { api_key: AGENT_KEY, selector: { package: "s3-browser" } } });
    expect(template.configuration.api_key).toBe("<k>");
    expect(JSON.stringify(installer.redact(body))).not.toContain(AGENT_KEY);
  });
});

describe("install.mjs", () => {
  test("--dry-run sends nothing and prints the plan deterministically, without secrets", async () => {
    const run = async () => {
      const { fetchImpl, calls } = fakeFetch({});
      const lines: string[] = [];
      await installer.install({ env, flags: installer.parseArgs(["--dry-run"]), fetchImpl, log: (line: string) => lines.push(line) });
      expect(calls).toEqual([]);
      return lines;
    };
    const lines = await run();
    expect(await run()).toEqual(lines);
    const output = lines.join("\n");
    expect(output).not.toContain(AGENT_KEY);
    expect(output).not.toContain(API_KEY);
    const requests = lines.filter((line) => line.startsWith("[dry-run] ")).map((line) => line.replace("[dry-run] ", "").replace(/ \{.*$/, ""));
    expect(requests).toEqual([
      "POST /token",
      "GET /catalog/specifications?slug=s3_browser",
      "POST /catalog/specifications",
      "GET /catalog/specifications/<specification id>/executors",
      ...["list-objects", "head-object", "read-object", "presign-download", "delete-object"].map(() => "POST /catalog/specifications/<specification id>/executors"),
      "GET /notification/channel?nrn=organization%3D1",
      "POST /notification/channel",
      "GET /link?nrn=organization%3D1&show_descendants=true&limit=100&offset=0",
    ]);
  });

  test("creates what is missing, updates what exists, seeds one entity per application with an S3 link", async () => {
    const appA = "organization=1:account=2:namespace=3:application=10";
    const appB = "organization=1:account=2:namespace=3:application=11";
    const { fetchImpl, calls } = fakeFetch({
      "GET /catalog/specifications?slug=s3_browser": { body: { results: [{ id: "spec-1", slug: "s3_browser" }] } },
      "PATCH /catalog/specifications/spec-1": { body: { id: "spec-1" } },
      "GET /catalog/specifications/spec-1/executors": { body: { results: [{ id: "ex-1", action: "list-objects" }] } },
      "PATCH /catalog/specifications/spec-1/executors/ex-1": { body: {} },
      "POST /catalog/specifications/spec-1/executors": { status: 201, body: {} },
      "GET /notification/channel?nrn=organization%3D1": { body: { results: [] } },
      "POST /notification/channel": { status: 201, body: { id: 77 } },
      "GET /link?nrn=organization%3D1&show_descendants=true&limit=100&offset=0": {
        body: {
          results: [
            { id: 1, entity_nrn: `${appA}:scope=1`, service_id: "svc-s3" },
            { id: 2, entity_nrn: appA, service_id: "svc-s3" },
            { id: 3, entity_nrn: appB, service_id: "svc-s3" },
            { id: 4, entity_nrn: "organization=1:account=2:namespace=3:application=12", service_id: "svc-db" },
            { id: 5, entity_nrn: "organization=1:account=2:namespace=3", service_id: "svc-s3" },
          ],
        },
      },
      "GET /service/svc-s3": { body: { id: "svc-s3", specification_id: "sp-s3" } },
      "GET /service/svc-db": { body: { id: "svc-db", specification_id: "sp-db" } },
      "GET /service_specification/sp-s3": { body: { slug: "aws-s3-bucket-agent-k8s" } },
      "GET /service_specification/sp-db": { body: { slug: "rds-postgres" } },
      "POST /catalog/instances/s3_browser": { status: 409, body: { message: "exists" } },
    });
    const lines: string[] = [];
    const result = await installer.install({ env, flags: installer.parseArgs(["--allow-destructive"]), fetchImpl, log: (line: string) => lines.push(line) });
    const sent = calls.map((call) => `${call.method} ${call.url.replace("https://api.test", "")}`);
    expect(sent.filter((line) => line === "POST /token")).toHaveLength(1);
    expect(calls.find((call) => call.method === "PATCH" && call.url.endsWith("/catalog/specifications/spec-1"))?.body).toMatchObject({ name: "S3 browser", allow_destructive: true });
    expect(sent.filter((line) => line === "POST /catalog/specifications/spec-1/executors")).toHaveLength(4);
    expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/notification/channel"))?.body).toMatchObject({ nrn: "organization=1", configuration: { api_key: AGENT_KEY } });
    const seeded = calls.filter((call) => call.method === "POST" && call.url.endsWith("/catalog/instances/s3_browser")).map((call) => call.body);
    expect(seeded).toEqual([
      { application_id: "10", nrn: appA },
      { application_id: "11", nrn: appB },
    ]);
    // The service of the duplicated links is read once.
    expect(sent.filter((line) => line === "GET /service/svc-s3")).toHaveLength(1);
    expect(result.seeded).toEqual({ created: 0, existing: 2 });
    expect(lines.join("\n")).not.toContain(AGENT_KEY);
    expect(lines.join("\n")).not.toContain(API_KEY);
  });

  test("an unexpected answer stops the install", async () => {
    const { fetchImpl } = fakeFetch({ "GET /catalog/specifications?slug=s3_browser": { status: 403, body: { message: "forbidden" } } });
    await expect(installer.install({ env, flags: installer.parseArgs([]), fetchImpl, log: () => {} })).rejects.toThrow(/HTTP 403/);
  });

  test("required environment", async () => {
    await expect(installer.install({ env: { NRN: "organization=1" }, flags: installer.parseArgs(["--dry-run"]), log: () => {} })).rejects.toThrow(/NP_API_KEY, AGENT_API_KEY/);
    await expect(installer.install({ env: { ...env, NRN: "organization=1:account=2:namespace=3" }, flags: installer.parseArgs(["--dry-run"]), log: () => {} })).rejects.toThrow(/NRN must be/);
  });
});
