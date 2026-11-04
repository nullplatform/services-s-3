import { describe, expect, test } from "bun:test";
import { createHandler, runCommand } from "../src/handler";
import { createPlatform, matchesSpecification, type Platform } from "../src/platform";
import type { ObjectStore } from "../src/s3";

const BUCKET = { id: "svc-bucket", status: "active", specification_id: "spec-s3", entity_nrn: "organization=1:account=2", attributes: { bucket_name: "np-svc-bucket", bucket_region: "eu-west-1" } };
const PENDING = { id: "svc-pending", status: "creating", specification_id: "spec-s3", entity_nrn: "organization=1", attributes: {} };
const DATABASE = { id: "svc-db", status: "active", specification_id: "spec-rds", entity_nrn: "organization=1", attributes: { bucket_name: "not-really" } };

const platform: Platform = {
  async getService(id) {
    const found = [BUCKET, PENDING, DATABASE].find((service) => service.id === id);
    if (!found) throw Object.assign(new Error(`/service/${id} not found`), { status: 404, code: "NOT_FOUND", name: "PlatformError" });
    return found;
  },
  async getSpecification(id) {
    return id === "spec-s3" ? { id, slug: "aws-s3-bucket-agent-k8s" } : { id, slug: "rds-postgres" };
  },
};

const calls: unknown[] = [];
const store: ObjectStore = {
  async list(target, prefix, token, limit) {
    calls.push(["list", target, prefix, token, limit]);
    return { bucket: target.bucket, region: target.region ?? null, prefix, folders: [{ prefix: `${prefix}logs/`, name: "logs" }], objects: [{ key: `${prefix}a.txt`, name: "a.txt", size: 3, last_modified: null }], next_token: null, truncated: false };
  },
  async head(target, key) {
    return { key, size: 3, content_type: "text/plain", last_modified: null, metadata: {} };
  },
  async presign(target, key) {
    return { key, url: `https://${target.bucket}.s3.amazonaws.com/${key}?X-Amz-Signature=x`, expires_at: "2026-01-01T00:00:00.000Z" };
  },
  async remove(_target, key) {
    calls.push(["remove", key]);
    return { key };
  },
};

const handler = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites: false } });
const parse = (result: { data: { stdout: string } }) => JSON.parse(result.data.stdout);

describe("runCommand", () => {
  test("lists a folder of the bucket the service points at", async () => {
    const result = await runCommand(JSON.stringify({ action: "list-objects", service_id: "svc-bucket", prefix: "docs/" }), handler);
    expect(result.success).toBe(true);
    expect(parse(result)).toMatchObject({ bucket: "np-svc-bucket", region: "eu-west-1", folders: [{ name: "logs" }], objects: [{ name: "a.txt" }] });
    expect(calls.at(-1)).toEqual(["list", { bucket: "np-svc-bucket", region: "eu-west-1" }, "docs/", undefined, 200]);
  });

  test("presigns a download", async () => {
    const result = await runCommand(JSON.stringify({ action: "presign-download", service_id: "svc-bucket", key: "docs/a.txt" }), handler);
    expect(parse(result).url).toContain("X-Amz-Signature");
  });

  test("refusals are completed commands with an error result", async () => {
    const notBucket = parse(await runCommand(JSON.stringify({ action: "list-objects", service_id: "svc-db" }), handler));
    expect(notBucket.error).toMatchObject({ status: 400, code: "NOT_A_BUCKET" });
    const pending = parse(await runCommand(JSON.stringify({ action: "list-objects", service_id: "svc-pending" }), handler));
    expect(pending.error).toMatchObject({ status: 409, code: "NO_BUCKET" });
    const gated = await runCommand(JSON.stringify({ action: "delete-object", service_id: "svc-bucket", key: "a.txt" }), handler);
    expect(gated.success).toBe(true);
    expect(parse(gated).error).toMatchObject({ status: 405, code: "WRITES_DISABLED" });
    expect(calls.some((call) => Array.isArray(call) && call[0] === "remove")).toBe(false);
    const bad = parse(await runCommand("{", handler));
    expect(bad.error.status).toBe(400);
  });

  test("a worker without credentials is a failed execution", async () => {
    const noKey = createHandler({ platform: createPlatform({ apiKey: undefined }), store, config: { specifications: ["aws-s3-bucket*"], allowWrites: false } });
    const result = await runCommand(JSON.stringify({ action: "list-objects", service_id: "svc-bucket" }), noKey);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("NO_CREDENTIALS");
    expect(parse(result).error.status).toBe(500);
  });

  test("delete works once writes are allowed", async () => {
    const writable = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites: true } });
    const result = await runCommand(JSON.stringify({ action: "delete-object", service_id: "svc-bucket", key: "docs/a.txt" }), writable);
    expect(parse(result)).toEqual({ key: "docs/a.txt" });
  });
});

describe("platform", () => {
  test("matches specification slugs exactly or by prefix", () => {
    expect(matchesSpecification("aws-s3-bucket", ["aws-s3-bucket"])).toBe(true);
    expect(matchesSpecification("aws-s3-bucket-agent-k8s", ["aws-s3-bucket"])).toBe(false);
    expect(matchesSpecification("aws-s3-bucket-agent-k8s", ["aws-s3-bucket*"])).toBe(true);
    expect(matchesSpecification(undefined, ["aws-s3-bucket*"])).toBe(false);
  });

  test("exchanges the API key once and caches reads", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ id: "svc-1", specification_id: "spec-s3" }), { status: 200 });
    }) as typeof fetch;
    const client = createPlatform({ apiUrl: "https://api.test", apiKey: "k", fetchImpl });
    await client.getService("svc-1");
    await client.getService("svc-1");
    expect(seen).toEqual(["POST https://api.test/token", "GET https://api.test/service/svc-1"]);
  });
});
