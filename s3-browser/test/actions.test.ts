import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIONS } from "../src/protocol";
import { createHandler, runCommand } from "../src/handler";
import type { Platform } from "../src/platform";
import type { ObjectStore } from "../src/s3";

const dir = resolve(import.meta.dir, "../actions");
const specs = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(resolve(dir, f), "utf8"))]));
const ajv = new Ajv({ strict: false });

const store: ObjectStore = {
  async list(t, prefix) {
    return { bucket: t.bucket, region: t.region ?? null, prefix, folders: [{ prefix: `${prefix}x/`, name: "x" }], objects: [{ key: `${prefix}a`, name: "a", size: 1, last_modified: "2026-01-01T00:00:00.000Z", storage_class: "STANDARD", etag: '"e"' }], next_token: null, truncated: false };
  },
  async head(_t, key) {
    return { key, size: 1, content_type: "text/plain", last_modified: null, etag: '"e"', metadata: { a: "b" } };
  },
  async presign(_t, key) {
    return { key, url: "https://example.invalid/x", expires_at: "2026-01-01T00:00:00.000Z" };
  },
  async remove(_t, key) {
    return { key };
  },
};
const unused = async (): Promise<never> => {
  throw new Error("unused");
};
const platform: Platform = { getService: unused, getSpecification: unused };
const handler = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites: true } });
const inputs: Record<string, Record<string, unknown>> = {
  "list-objects": { prefix: "docs/", limit: 50, token: "t" },
  "head-object": { key: "docs/a.txt" },
  "presign-download": { key: "docs/a.txt" },
  "delete-object": { key: "docs/a.txt" },
};
const envelope = (slug: string, parameters: unknown) =>
  JSON.stringify({ notification: { specification: { slug }, parameters, service: { id: "svc-1", specification: { slug: "aws-s3-bucket" }, attributes: { bucket_name: "bucket-placeholder", bucket_region: "us-east-1" } } } });

describe("action specification documents", () => {
  test("one per worker action", () => {
    expect(Object.keys(specs).sort()).toEqual([...ACTIONS].sort());
  });

  test("shape: custom, parallel, permission only on the write", () => {
    for (const [slug, spec] of Object.entries(specs)) {
      expect(spec).toMatchObject({ slug, type: "custom", parallelize: true });
      expect(spec.permission).toBe(slug === "delete-object" ? "custom:s3:objectdelete" : undefined);
    }
  });

  for (const slug of ACTIONS) {
    test(`${slug}: schemas accept the worker's real input and output`, async () => {
      const parameters = ajv.compile(specs[slug].parameters.schema);
      const results = ajv.compile(specs[slug].results.schema);
      expect(parameters(inputs[slug])).toBe(true);
      const result = await runCommand(envelope(slug, inputs[slug]), handler);
      expect(result.success).toBe(true);
      const output = JSON.parse(result.data.stdout);
      expect(output.error).toBeUndefined();
      expect(results(output)).toBe(true);
    });

    test(`${slug}: parameters schema rejects a smuggled field`, () => {
      expect(ajv.compile(specs[slug].parameters.schema)({ ...inputs[slug], bucket: "other" })).toBe(false);
    });
  }

  test("parameters schema rejects absolute and missing keys", () => {
    const validate = ajv.compile(specs["head-object"].parameters.schema);
    expect(validate({})).toBe(false);
    expect(validate({ key: "/etc/passwd" })).toBe(false);
    expect(validate({ key: "dir/" })).toBe(false);
  });
});
