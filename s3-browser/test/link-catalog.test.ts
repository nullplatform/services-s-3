import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHandler, runCommand } from "../src/handler";
import type { Platform } from "../src/platform";
import { CommandError, LINK_ACTIONS, LINK_INPUT_FIELDS, parseCommand } from "../src/protocol";
import type { ObjectStore } from "../src/s3";

// The s3_browser catalog documents against the worker that answers them (link mode): the
// inputs the schemas accept are the ones the worker accepts, and its real outputs validate.

const root = join(import.meta.dir, "..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

const specification = read("catalog/s3_browser.specification.json");
const executors: Array<{ action: string; transport: string; timeout_ms: number }> = read("catalog/s3_browser.executors.json");
const channel = read("catalog/s3_browser.channel.example.json");
const actions: Record<string, { name: string; execution: string; input: object; output: object; permission?: string }> = specification.schema.actions;
const ajv = new Ajv({ strict: false });

const APP_NRN = "organization=1:account=2:namespace=3:application=4";
const platform: Platform = {
  async getService(id) {
    return { id, status: "active", specification_id: "spec-s3", attributes: { bucket_name: "link-bucket", bucket_region: "us-east-1" } };
  },
  async getSpecification(id) {
    return { id, slug: "aws-s3-bucket" };
  },
  async getLink(id) {
    return { id, status: "active", service_id: "svc-1", entity_nrn: APP_NRN, attributes: { access_level: "read-write", path_prefix: "", aws_access_key_id: "AKIAEXAMPLE", aws_secret_access_key: "example-secret" } };
  },
};
const store: ObjectStore = {
  async list(t, prefix) {
    return { bucket: t.bucket, region: t.region ?? null, prefix, folders: [{ prefix: `${prefix}x/`, name: "x" }], objects: [{ key: `${prefix}a`, name: "a", size: 1, last_modified: "2026-01-01T00:00:00.000Z", storage_class: "STANDARD", etag: '"e"' }], next_token: "next", truncated: true };
  },
  async head(_t, key) {
    return { key, size: 1, content_type: "text/plain", last_modified: null, etag: '"e"', storage_class: "STANDARD", metadata: { a: "b" } };
  },
  async presign(_t, key) {
    return { key, url: "https://example.invalid/x", expires_at: "2026-01-01T00:00:00.000Z" };
  },
  async remove(_t, key) {
    return { key };
  },
  async read(_t, key, maxBytes) {
    return { key, text: "x".repeat(Math.min(maxBytes, 3)), truncated: true, content_type: "text/plain", size: 10 };
  },
};
const handler = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites: true } });

const inputs: Record<string, Record<string, unknown>> = {
  "list-objects": { link_id: "lnk-1", prefix: "docs/", limit: 50, token: "t" },
  "head-object": { link_id: "lnk-1", key: "docs/a.txt" },
  "read-object": { link_id: "lnk-1", key: "docs/a.txt", max_bytes: 1024 },
  "presign-download": { link_id: "lnk-1", key: "docs/a.txt" },
  "delete-object": { link_id: "lnk-1", key: "docs/a.txt" },
};
const minimal: Record<string, Record<string, unknown>> = {
  "list-objects": { link_id: "lnk-1" },
  "head-object": { link_id: "lnk-1", key: "a" },
  "read-object": { link_id: "lnk-1", key: "a" },
  "presign-download": { link_id: "lnk-1", key: "a" },
  "delete-object": { link_id: "lnk-1", key: "a" },
};
const envelope = (slug: string, input: unknown) =>
  JSON.stringify({ notification: { action: "catalog:action:create", slug, input, specification: { id: "s", slug: "s3_browser" }, entity: { application_id: "4", nrn: APP_NRN }, entity_nrn: APP_NRN, user: { id: null } } });
const workerAccepts = (slug: string, input: unknown) => {
  try {
    parseCommand(envelope(slug, input));
    return true;
  } catch (error) {
    if (error instanceof CommandError) return false;
    throw error;
  }
};

describe("s3_browser catalog specification", () => {
  test("one entity per application: application_id is the key, nrn the NRN", () => {
    expect(specification.slug).toBe("s3_browser");
    expect(specification.schema.properties.application_id).toEqual({ type: "string", primaryKey: true, autoGenerate: false });
    expect(specification.schema.properties.nrn).toEqual({ type: "string", nrn: true });
    expect(specification.schema.required.sort()).toEqual(["application_id", "nrn"]);
  });

  test("declares exactly the link-mode actions, all sync, no per-action permission", () => {
    expect(Object.keys(actions).sort()).toEqual([...LINK_ACTIONS].sort());
    for (const action of Object.values(actions)) {
      expect(action.execution).toBe("sync");
      expect(action.permission).toBeUndefined();
    }
  });

  test("every input requires link_id, admits nothing extra, and names the fields the worker accepts", () => {
    for (const [slug, action] of Object.entries(actions)) {
      const input = action.input as { required: string[]; additionalProperties: boolean; properties: Record<string, { pattern?: string }> };
      expect(input.required).toContain("link_id");
      expect(input.additionalProperties).toBe(false);
      expect(input.properties.link_id.pattern).toBe("^[A-Za-z0-9-]{1,64}$");
      expect(Object.keys(input.properties).sort()).toEqual([...LINK_INPUT_FIELDS[slug]].sort());
    }
  });

  for (const slug of LINK_ACTIONS) {
    test(`${slug}: schemas accept the worker's real input and output`, async () => {
      const validateInput = ajv.compile(actions[slug].input);
      const validateOutput = ajv.compile(actions[slug].output);
      for (const input of [inputs[slug], minimal[slug]]) {
        expect(validateInput(input)).toBe(true);
        const result = await runCommand(envelope(slug, input), handler);
        expect(result.success).toBe(true);
        const output = JSON.parse(result.data.stdout);
        expect(output.error).toBeUndefined();
        expect(validateOutput(output)).toBe(true);
      }
    });

    test(`${slug}: schema and worker agree on what to refuse`, () => {
      const validate = ajv.compile(actions[slug].input);
      const refused: unknown[] = [
        { ...inputs[slug], bucket: "other" },
        { ...inputs[slug], link_id: undefined },
        { ...inputs[slug], link_id: "../x" },
        { ...inputs[slug], link_id: "a".repeat(65) },
        { ...inputs[slug], link_id: 7 },
      ];
      if (slug !== "list-objects") refused.push({ link_id: "lnk-1" }, { link_id: "lnk-1", key: "/abs" }, { link_id: "lnk-1", key: "dir/" });
      else refused.push({ link_id: "lnk-1", prefix: "/abs" }, { link_id: "lnk-1", limit: 0 }, { link_id: "lnk-1", limit: 1001 });
      if (slug === "read-object") refused.push({ link_id: "lnk-1", key: "a", max_bytes: 0 }, { link_id: "lnk-1", key: "a", max_bytes: 262145 });
      for (const input of refused) {
        const clean = JSON.parse(JSON.stringify(input));
        expect([slug, clean, validate(clean)]).toEqual([slug, clean, false]);
        expect([slug, clean, workerAccepts(slug, clean)]).toEqual([slug, clean, false]);
      }
    });
  }

  test("everyone gets read, list and the four reads; nobody gets the delete", () => {
    const grants: Array<{ principals: Array<{ type: string }>; actions: string[] }> = specification.schema.authorization.entities.grants;
    expect(grants).toEqual([{ principals: [{ type: "*" }], actions: ["read", "list", "action:list-objects", "action:head-object", "action:read-object", "action:presign-download"] }]);
    expect(JSON.stringify(grants)).not.toContain("action:delete-object");
  });

  test("one notification executor per action, 15 s budget", () => {
    expect(executors.map((executor) => executor.action).sort()).toEqual([...LINK_ACTIONS].sort());
    for (const executor of executors) expect(executor).toEqual({ action: executor.action, transport: "notification", timeout_ms: 15000 });
  });

  test("the channel routes catalog executions of s3_browser only, to the s3-browser package", () => {
    expect(channel.type).toBe("agent");
    expect(channel.source).toEqual(["catalog"]);
    expect(channel.filters).toEqual({ $and: [{ action: { $eq: "catalog:action:create" } }, { "specification.slug": { $eq: "s3_browser" } }] });
    expect(channel.configuration.selector).toEqual({ package: "s3-browser" });
    expect(channel.configuration.command).toMatchObject({ type: "package-exec", data: { cmdline: "s3-browser" } });
    expect(channel.configuration.command.data.environment.NP_ACTION_CONTEXT).toBe("${NOTIFICATION_CONTEXT}");
  });
});
