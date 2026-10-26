import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { createHandler, createReplayGuard, linkOwnedBy, normalisePathPrefix, runCommand } from "../src/handler";
import { type CatalogEntity, type CatalogExecution, createPlatform, type Link, type Platform, PlatformError } from "../src/platform";
import { CommandError, parseCommand, parseLinkOperation } from "../src/protocol";
import { createS3, defaultClientFactory, type ObjectStore, type Target, totalFromContentRange } from "../src/s3";

// Distinctive values: any appearance of these in an output is a leak.
const KEY_ID = "AKIALINKKEYID0000001";
const SECRET = "linkSecret/Example+Value0000000000000001";

const APP_NRN = "organization=1:account=2:namespace=3:application=4";

const BUCKET_SERVICE = { id: "svc-bucket", status: "active", specification_id: "spec-s3", attributes: { bucket_name: "link-bucket", bucket_region: "sa-east-1" } };
const PENDING_SERVICE = { id: "svc-pending", status: "creating", specification_id: "spec-s3", attributes: {} };
const DB_SERVICE = { id: "svc-db", status: "active", specification_id: "spec-rds", attributes: { bucket_name: "not-a-bucket" } };

const baseLink = (overrides: Partial<Link> & { attributes?: Record<string, unknown> } = {}): Link => ({
  id: "lnk-1",
  status: "active",
  service_id: "svc-bucket",
  entity_nrn: APP_NRN,
  ...overrides,
  attributes: { access_level: "read-write", path_prefix: "", aws_access_key_id: KEY_ID, aws_secret_access_key: SECRET, ...(overrides.attributes ?? {}) },
});

// The catalog as the worker sees it: execution records and entities. `linkEnvelope` records a
// pending execution for every envelope it builds (unless told not to), as the catalog would.
const executions = new Map<string, CatalogExecution>();
// Entities by external id (the application id), as the flat formatted read returns them.
const entities = new Map<string, CatalogEntity>([["4", { application_id: "4", nrn: APP_NRN, created_at: "2026-01-01T00:00:00.000Z" }]]);
const catalogReads: string[] = [];

function fakePlatform(links: Record<string, Link>) {
  const seen: string[] = [];
  const platform: Platform = {
    async getExecution(slug, id) {
      catalogReads.push(`execution ${slug} ${id}`);
      const found = executions.get(id);
      if (!found) throw new PlatformError(`/catalog/actions/${slug}/executions/${id} not found`, 404, "NOT_FOUND");
      return found;
    },
    async getEntity(slug, id) {
      catalogReads.push(`entity ${slug} ${id}`);
      const found = entities.get(id);
      if (!found) throw new PlatformError(`/catalog/instances/${slug}/${id} not found`, 404, "NOT_FOUND");
      return found;
    },
    async getService(id) {
      seen.push(`service ${id}`);
      const found = [BUCKET_SERVICE, PENDING_SERVICE, DB_SERVICE].find((service) => service.id === id);
      if (!found) throw new PlatformError(`/service/${id} not found`, 404, "NOT_FOUND");
      return found;
    },
    async getSpecification(id) {
      return id === "spec-s3" ? { id, slug: "aws-s3-bucket-agent-k8s" } : { id, slug: "rds-postgres" };
    },
    async getLink(id) {
      seen.push(`link ${id}`);
      const found = links[id];
      if (!found) throw new PlatformError(`link ${id} not found`, 404, "LINK_NOT_FOUND");
      return found;
    },
  };
  return { platform, seen };
}

function recordingStore() {
  const calls: Array<{ op: string; target: Target; arg?: unknown }> = [];
  const store: ObjectStore = {
    async list(target, prefix, _token, _limit) {
      calls.push({ op: "list", target, arg: prefix });
      return { bucket: target.bucket, region: target.region ?? null, prefix, folders: [], objects: [{ key: `${prefix}a.txt`, name: "a.txt", size: 1, last_modified: null }], next_token: null, truncated: false };
    },
    async head(target, key) {
      calls.push({ op: "head", target, arg: key });
      return { key, size: 1, last_modified: null, metadata: {} };
    },
    async presign(target, key) {
      calls.push({ op: "presign", target, arg: key });
      return { key, url: `https://example.invalid/${key}`, expires_at: "2026-01-01T00:00:00.000Z" };
    },
    async remove(target, key) {
      calls.push({ op: "remove", target, arg: key });
      return { key };
    },
    async read(target, key, maxBytes) {
      calls.push({ op: "read", target, arg: [key, maxBytes] });
      return { key, text: "hi", truncated: false, size: 2 };
    },
  };
  return { store, calls };
}

let sequence = 0;
const linkEnvelope = (slug: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, record: Partial<CatalogExecution> | null = {}) => {
  const id = `exec-${++sequence}`;
  if (record) executions.set(id, { id, entity_id: "0b6c2f5e-internal-uuid", entity_specification_id: "spec-cat", action: slug, status: "pending", input, actor_type: "user", actor_id: "u-1", entity_nrn: APP_NRN, ...record });
  return linkPayload(id, slug, input, extra);
};
const linkPayload = (id: string, slug: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    notification: {
      id,
      action: "catalog:action:create",
      slug,
      input,
      status: "pending",
      specification: { id: "spec-cat", slug: "s3_browser" },
      entity: { application_id: "4", nrn: APP_NRN },
      entity_nrn: APP_NRN,
      user: { id: "u-1" },
      ...extra,
    },
  });

const parse = (result: { data: { stdout: string } }) => JSON.parse(result.data.stdout);

function setup(links: Record<string, Link> = { "lnk-1": baseLink() }, allowWrites = false, extra: { unverifiedEntityBinding?: boolean } = {}) {
  const { platform, seen } = fakePlatform(links);
  const { store, calls } = recordingStore();
  const warnings: string[] = [];
  const handler = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites, ...extra, warn: (message) => warnings.push(message) } });
  return { handler, seen, calls, warnings };
}

describe("link mode: protocol", () => {
  test("detected by the specification slug; only the execution id and slug are taken from the envelope", () => {
    const command = parseCommand(linkEnvelope("list-objects", { link_id: "lnk-1", prefix: "docs/", bucket: "ignored" }));
    expect(command).toMatchObject({ action: "list-objects", prefix: "", link: { specification_slug: "s3_browser", envelope_application_id: "4", link_id: "", entity_nrn: "" } });
    expect(command.link!.execution_id).toMatch(/^exec-/);
    expect(command.catalog).toBeUndefined();
  });

  test("the link specification slug is configurable", () => {
    const payload = linkEnvelope("list-objects", { link_id: "lnk-1" });
    // Under another slug the envelope is the bucket-entity catalog mode, which needs a bucket.
    expect(() => parseCommand(payload, { linkSpecification: "other_browser" })).toThrow(/bucket_name/);
    expect(parseCommand(payload, { linkSpecification: "s3_browser" }).link).toBeDefined();
  });

  test("the envelope needs an execution id and a known operation", () => {
    expect(() => parseCommand(linkEnvelope("list-objects", {}, { id: undefined }))).toThrow(/notification.id/);
    expect(() => parseCommand(linkEnvelope("list-objects", {}, { id: "../x" }))).toThrow(/notification.id/);
    expect(() => parseCommand(linkEnvelope("rm-rf", { link_id: "lnk-1" }))).toThrow(CommandError);
  });

  test("the recorded input: link_id and per-action fields", () => {
    expect(parseLinkOperation("list-objects", { link_id: "lnk-1", prefix: "docs/" })).toMatchObject({ action: "list-objects", prefix: "docs/", link: { link_id: "lnk-1" } });
    expect(() => parseLinkOperation("list-objects", {})).toThrow(/link_id/);
    expect(() => parseLinkOperation("list-objects", { link_id: "../x" })).toThrow(/link_id/);
    expect(() => parseLinkOperation("list-objects", { link_id: 12 })).toThrow(/link_id/);
    expect(() => parseLinkOperation("list-objects", { link_id: "a".repeat(65) })).toThrow(/link_id/);
    expect(() => parseLinkOperation("list-objects", { link_id: "lnk-1", bucket: "evil" })).toThrow(/unexpected input/);
    expect(() => parseLinkOperation("head-object", { link_id: "lnk-1", key: "a", prefix: "x/" })).toThrow(/unexpected input/);
    expect(() => parseLinkOperation("head-object", { link_id: "lnk-1", key: "/etc/passwd" })).toThrow(/key is required/);
    expect(() => parseLinkOperation("list-objects", { link_id: "lnk-1", prefix: "/abs" })).toThrow(/prefix/);
    expect(() => parseLinkOperation("rm-rf", { link_id: "lnk-1" })).toThrow(CommandError);
  });

  test("read-object: max_bytes defaults to 262144 and is bounded", () => {
    expect(parseLinkOperation("read-object", { link_id: "lnk-1", key: "a.txt" }).max_bytes).toBe(262144);
    expect(parseLinkOperation("read-object", { link_id: "lnk-1", key: "a.txt", max_bytes: 1 }).max_bytes).toBe(1);
    for (const bad of [0, 262145, 1.5, "10"]) expect(() => parseLinkOperation("read-object", { link_id: "lnk-1", key: "a.txt", max_bytes: bad })).toThrow(/max_bytes/);
  });

  test("read-object does not exist outside link mode", () => {
    expect(() => parseCommand({ action: "read-object", service_id: "svc-1", key: "a" })).toThrow(/unknown action/);
    const catalog = JSON.stringify({ notification: { action: "catalog:action:create", slug: "read-object", input: { key: "a" }, entity: { bucket_name: "b", region: "r" }, specification: { slug: "aws-s3-bucket" } } });
    expect(() => parseCommand(catalog)).toThrow(/unknown action/);
  });
});

describe("link mode: handler", () => {
  test("lists the link's bucket with the link's keys; bucket and region from the service", async () => {
    const { handler, calls } = setup();
    const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1", prefix: "docs/" }), handler);
    expect(result.success).toBe(true);
    expect(parse(result)).toMatchObject({ bucket: "link-bucket", region: "sa-east-1", prefix: "docs/" });
    expect(calls.at(-1)).toEqual({ op: "list", target: { bucket: "link-bucket", region: "sa-east-1", credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } }, arg: "docs/" });
  });

  test("a link of the application or of a resource under it is owned", async () => {
    for (const nrn of [APP_NRN, `${APP_NRN}:scope=9`]) {
      const { handler } = setup({ "lnk-1": baseLink({ entity_nrn: nrn }) });
      expect(parse(await runCommand(linkEnvelope("head-object", { link_id: "lnk-1", key: "a.txt" }), handler))).toEqual({ key: "a.txt", size: 1, last_modified: null, metadata: {} });
    }
  });

  test("LINK_NOT_OWNED: a sibling application, a parent namespace, an id-prefix lookalike", async () => {
    for (const nrn of ["organization=1:account=2:namespace=3:application=5", "organization=1:account=2:namespace=3", `${APP_NRN}5`, `${APP_NRN}5:scope=1`, undefined]) {
      const { handler, calls, seen } = setup({ "lnk-1": baseLink({ entity_nrn: nrn }) });
      const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), handler);
      expect(result.success).toBe(true);
      expect(parse(result).error).toMatchObject({ status: 403, code: "LINK_NOT_OWNED" });
      expect(calls).toHaveLength(0);
      // Ownership is decided before the service is even read.
      expect(seen).toEqual(["link lnk-1"]);
    }
  });

  test("LINK_NOT_FOUND", async () => {
    const { handler } = setup({});
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-404" }), handler)).error).toMatchObject({ status: 404, code: "LINK_NOT_FOUND" });
  });

  test("LINK_NOT_READY: not active, or no keys", async () => {
    const cases = [baseLink({ status: "pending" }), baseLink({ attributes: { aws_access_key_id: "" } }), baseLink({ attributes: { aws_secret_access_key: undefined } }), baseLink({ service_id: undefined })];
    for (const link of cases) {
      const { handler, calls } = setup({ "lnk-1": link });
      const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), handler);
      expect(parse(result).error).toMatchObject({ status: 409, code: "LINK_NOT_READY" });
      expect(calls).toHaveLength(0);
    }
  });

  test("masked keys are a worker failure, not a refusal", async () => {
    // The services API masks secrets as null when the read did not include them.
    for (const masked of ["********", null]) {
      const { handler } = setup({ "lnk-1": baseLink({ attributes: { aws_secret_access_key: masked } }) });
      const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), handler);
      expect(result.success).toBe(false);
      expect(parse(result).error).toMatchObject({ status: 500, code: "PLATFORM" });
    }
  });

  test("NOT_A_BUCKET and NO_BUCKET come from the link's service", async () => {
    const notBucket = setup({ "lnk-1": baseLink({ service_id: "svc-db" }) });
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), notBucket.handler)).error).toMatchObject({ status: 400, code: "NOT_A_BUCKET" });
    const pending = setup({ "lnk-1": baseLink({ service_id: "svc-pending" }) });
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), pending.handler)).error).toMatchObject({ status: 409, code: "NO_BUCKET" });
  });

  test("path_prefix: an empty list prefix lists at it; anything outside is OUTSIDE_PREFIX", async () => {
    const { handler, calls } = setup({ "lnk-1": baseLink({ attributes: { path_prefix: "uploads" } }) });
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), handler)).prefix).toBe("uploads/");
    expect(calls.at(-1)?.arg).toBe("uploads/");
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1", prefix: "uploads/2026/" }), handler)).prefix).toBe("uploads/2026/");
    expect(parse(await runCommand(linkEnvelope("read-object", { link_id: "lnk-1", key: "uploads/a.txt" }), handler))).toMatchObject({ key: "uploads/a.txt" });
    const before = calls.length;
    for (const [slug, input] of [
      ["list-objects", { prefix: "upload" }],
      ["list-objects", { prefix: "uploads" }],
      ["list-objects", { prefix: "other/" }],
      ["head-object", { key: "other/a.txt" }],
      ["read-object", { key: "uploadsX/a.txt" }],
      ["presign-download", { key: "a.txt" }],
    ] as const) {
      expect(parse(await runCommand(linkEnvelope(slug, { link_id: "lnk-1", ...input }), handler)).error).toMatchObject({ status: 403, code: "OUTSIDE_PREFIX" });
    }
    expect(calls.length).toBe(before);
  });

  test("normalisePathPrefix", () => {
    expect(normalisePathPrefix("")).toBe("");
    expect(normalisePathPrefix(undefined)).toBe("");
    expect(normalisePathPrefix("a")).toBe("a/");
    expect(normalisePathPrefix("a/")).toBe("a/");
  });

  test("linkOwnedBy needs a ':' boundary and a non-empty entity NRN", () => {
    expect(linkOwnedBy(APP_NRN, APP_NRN)).toBe(true);
    expect(linkOwnedBy(`${APP_NRN}:scope=1`, APP_NRN)).toBe(true);
    expect(linkOwnedBy(`${APP_NRN}0`, APP_NRN)).toBe(false);
    expect(linkOwnedBy(":x", "")).toBe(false);
    expect(linkOwnedBy("", "")).toBe(false);
  });

  test("WRITE_NOT_ALLOWED on a read link; read-write and write may delete", async () => {
    const readOnly = setup({ "lnk-1": baseLink({ attributes: { access_level: "read" } }) }, true);
    expect(parse(await runCommand(linkEnvelope("delete-object", { link_id: "lnk-1", key: "a.txt" }), readOnly.handler)).error).toMatchObject({ status: 403, code: "WRITE_NOT_ALLOWED" });
    expect(readOnly.calls).toHaveLength(0);
    const missing = setup({ "lnk-1": baseLink({ attributes: { access_level: undefined } }) }, true);
    expect(parse(await runCommand(linkEnvelope("delete-object", { link_id: "lnk-1", key: "a.txt" }), missing.handler)).error).toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    for (const level of ["write", "read-write"]) {
      const writable = setup({ "lnk-1": baseLink({ attributes: { access_level: level } }) }, true);
      expect(parse(await runCommand(linkEnvelope("delete-object", { link_id: "lnk-1", key: "a.txt" }), writable.handler))).toEqual({ key: "a.txt" });
    }
    // Reads on a read link are fine (and on a write link left to AWS).
    expect(parse(await runCommand(linkEnvelope("head-object", { link_id: "lnk-1", key: "a.txt" }), readOnly.handler)).key).toBe("a.txt");
  });

  test("WRITES_DISABLED comes first: no link read at all", async () => {
    const { handler, seen } = setup({ "lnk-1": baseLink({ attributes: { access_level: "read" }, entity_nrn: "organization=9" }) }, false);
    expect(parse(await runCommand(linkEnvelope("delete-object", { link_id: "lnk-1", key: "a.txt" }), handler)).error).toMatchObject({ status: 405, code: "WRITES_DISABLED" });
    expect(seen).toEqual([]);
  });

  test("read-object passes max_bytes to the store", async () => {
    const { handler, calls } = setup();
    expect(parse(await runCommand(linkEnvelope("read-object", { link_id: "lnk-1", key: "a.txt", max_bytes: 10 }), handler))).toEqual({ key: "a.txt", text: "hi", truncated: false, size: 2 });
    expect(calls.at(-1)?.arg).toEqual(["a.txt", 10]);
  });

  test("the bucket-entity catalog and service modes ignore links", async () => {
    const { handler, seen } = setup();
    const catalog = JSON.stringify({ notification: { action: "catalog:action:create", slug: "list-objects", input: { link_id: "lnk-1" }, entity: { bucket_name: "entity-bucket", region: "us-east-1" }, specification: { slug: "aws-s3-bucket" }, entity_nrn: APP_NRN } });
    expect(parse(await runCommand(catalog, handler)).bucket).toBe("entity-bucket");
    expect(seen).toEqual([]);
  });
});

describe("link mode: the request is verified against the catalog", () => {
  const otherApp = "organization=1:account=2:namespace=3:application=5";
  const refused = async (payload: string, links: Record<string, Link> = { "lnk-1": baseLink() }) => {
    const { handler, seen, calls } = setup(links, true);
    const result = await runCommand(payload, handler);
    expect(result.success).toBe(true);
    expect(parse(result).error).toMatchObject({ status: 403, code: "EXECUTION_NOT_VERIFIED" });
    // Nothing about the link is read, nothing reaches S3.
    expect(seen).toEqual([]);
    expect(calls).toHaveLength(0);
  };

  test("a forged envelope with no execution behind it", async () => {
    await refused(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, null));
    // The agent_command shape (no notification.action) is verified the same way.
    await refused(JSON.stringify({ notification: { id: "exec-forged", slug: "list-objects", input: { link_id: "lnk-1" }, specification: { slug: "s3_browser" }, entity: {}, entity_nrn: APP_NRN } }));
  });

  test("an execution that already finished", async () => {
    for (const status of ["success", "failed"]) await refused(linkEnvelope("head-object", { link_id: "lnk-1", key: "a.txt" }, {}, { status }));
  });

  test("an execution of another operation, or with invalid recorded input", async () => {
    await refused(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { action: "delete-object", input: { link_id: "lnk-1", key: "a.txt" } }));
    await refused(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { input: { link_id: "lnk-1", bucket: "evil" } }));
    await refused(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { input: null }));
  });

  test("the operation's fields, link_id included, come from the catalog's record, not the envelope", async () => {
    const { handler, calls, seen } = setup({ "lnk-1": baseLink(), "lnk-2": baseLink({ id: "lnk-2" }) });
    const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1", prefix: "docs/" }, {}, { input: { link_id: "lnk-2", prefix: "recorded/" } }), handler);
    expect(parse(result).prefix).toBe("recorded/");
    expect(calls.at(-1)?.arg).toBe("recorded/");
    expect(seen).toContain("link lnk-2");
    expect(seen).not.toContain("link lnk-1");
  });

  test("the NRN comes from the execution record, not the envelope", async () => {
    // The envelope claims app 5, which owns the link; the record is on app 4: refused.
    const forged = setup({ "lnk-1": baseLink({ entity_nrn: otherApp }) });
    const claim = { entity_nrn: otherApp, entity: { application_id: "5", nrn: otherApp } };
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }, claim), forged.handler)).error).toMatchObject({ status: 403, code: "LINK_NOT_OWNED" });
    // The envelope claims app 5, the link and the record are app 4: allowed.
    const honest = setup();
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }, claim), honest.handler)).bucket).toBe("link-bucket");
  });

  test("the record's entity_nrn must be exactly an application NRN", async () => {
    // A namespace-level entity would make every link of the namespace pass the ownership prefix.
    for (const entity_nrn of ["organization=1:account=2:namespace=3", `${APP_NRN}:scope=1`, "organization=1:account=2:namespace=3:application=x", ""]) {
      await refused(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { entity_nrn }), { "lnk-1": baseLink({ entity_nrn: `${APP_NRN}:scope=1` }) });
    }
    // Present but invalid never falls back, even with the demo flag on.
    const { handler, seen, warnings } = setup({ "lnk-1": baseLink() }, false, { unverifiedEntityBinding: true });
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { entity_nrn: "organization=1:account=2:namespace=3" }), handler)).error.code).toBe("EXECUTION_NOT_VERIFIED");
    expect(seen).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("no entity_nrn on the record fails closed when the demo flag is off", async () => {
    catalogReads.length = 0;
    for (const entity_nrn of [null, undefined]) await refused(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { entity_nrn }));
    expect(catalogReads.some((read) => read.startsWith("entity"))).toBe(false);
  });

  test("demo flag: without entity_nrn the entity named by the envelope is read back, with its checks", async () => {
    const demo = (links: Record<string, Link> = { "lnk-1": baseLink() }) => setup(links, false, { unverifiedEntityBinding: true });
    const ok = demo();
    catalogReads.length = 0;
    const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1", prefix: "ignored/" }, {}, { entity_nrn: null, input: { link_id: "lnk-1", prefix: "recorded/" } }), ok.handler);
    // Input still from the record; the entity read by the envelope's application id; a warning every time.
    expect(parse(result)).toMatchObject({ bucket: "link-bucket", prefix: "recorded/" });
    expect(catalogReads.filter((read) => read.startsWith("entity"))).toEqual(["entity s3_browser 4"]);
    expect(ok.warnings).toHaveLength(1);
    expect(ok.warnings[0]).toContain("S3_BROWSER_UNVERIFIED_ENTITY_BINDING");
    await runCommand(linkEnvelope("head-object", { link_id: "lnk-1", key: "a.txt" }, {}, { entity_nrn: null }), ok.handler);
    expect(ok.warnings).toHaveLength(2);

    const refusedWith = async (payload: string) => {
      const { handler, seen } = demo();
      expect(parse(await runCommand(payload, handler)).error).toMatchObject({ status: 403, code: "EXECUTION_NOT_VERIFIED" });
      expect(seen).toEqual([]);
    };
    // Still pending + same action + input from the record.
    await refusedWith(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { entity_nrn: null, status: "success" }));
    await refusedWith(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { entity_nrn: null, action: "head-object" }));
    await refusedWith(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { entity_nrn: null, input: { link_id: "lnk-1", bucket: "x" } }));
    // The envelope must name an application the catalog knows, at exactly its application NRN.
    entities.set("6", { application_id: "6", nrn: "organization=1:account=2:namespace=3" });
    entities.set("7", { application_id: "7", nrn: "organization=1:account=2:namespace=3:application=8" });
    entities.set("9", { application_id: "10", nrn: "organization=1:account=2:namespace=3:application=9" });
    for (const entity of [{ application_id: "6" }, { application_id: "7" }, { application_id: "9" }, { application_id: "404" }, {}, { application_id: "x" }]) {
      await refusedWith(linkEnvelope("list-objects", { link_id: "lnk-1" }, { entity }, { entity_nrn: null }));
    }
    // And the link must still belong to that application.
    const otherLink = demo({ "lnk-1": baseLink({ entity_nrn: otherApp }) });
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { entity_nrn: null }), otherLink.handler)).error.code).toBe("LINK_NOT_OWNED");
  });

  test("an execution id runs once per worker process", async () => {
    catalogReads.length = 0;
    const { handler, calls } = setup();
    const payload = linkEnvelope("list-objects", { link_id: "lnk-1" });
    expect(parse(await runCommand(payload, handler)).bucket).toBe("link-bucket");
    const replayed = await runCommand(payload, handler);
    expect(parse(replayed).error).toMatchObject({ status: 403, code: "EXECUTION_NOT_VERIFIED" });
    expect(calls).toHaveLength(1);
    // The replay is refused before the catalog is read again.
    const id = JSON.parse(payload).notification.id;
    expect(catalogReads).toEqual([`execution s3_browser ${id}`]);
    // A refused attempt does not burn the id: a forged envelope first, the real run after it.
    const forgedFirst = linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, { status: "success" });
    expect(parse(await runCommand(forgedFirst, handler)).error.code).toBe("EXECUTION_NOT_VERIFIED");
    executions.set(JSON.parse(forgedFirst).notification.id, { ...executions.get(JSON.parse(forgedFirst).notification.id)!, status: "pending" });
    expect(parse(await runCommand(forgedFirst, handler)).bucket).toBe("link-bucket");
  });

  test("the replay guard is bounded and expires", () => {
    let clock = 0;
    const guard = createReplayGuard({ max: 3, ttlMs: 100, now: () => clock });
    for (const id of ["a", "b", "c", "d"]) guard.claim(id);
    expect(guard.size).toBe(3);
    expect(guard.has("a")).toBe(false);
    expect(guard.has("d")).toBe(true);
    clock = 101;
    expect(guard.has("d")).toBe(false);
    expect(guard.size).toBe(0);
  });

  test("the catalog is read with the configured specification slug, for every execution", async () => {
    catalogReads.length = 0;
    const { handler } = setup();
    const first = linkEnvelope("list-objects", { link_id: "lnk-1" });
    const second = linkEnvelope("list-objects", { link_id: "lnk-1" });
    await runCommand(first, handler);
    await runCommand(second, handler);
    const ids = [first, second].map((payload) => JSON.parse(payload).notification.id);
    expect(catalogReads).toEqual([`execution s3_browser ${ids[0]}`, `execution s3_browser ${ids[1]}`]);
  });
});

describe("link mode: platform", () => {
  test("reads the link with secrets, never from cache; 404 is LINK_NOT_FOUND", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      if (String(url).includes("/link/missing")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(baseLink()), { status: 200 });
    }) as typeof fetch;
    const client = createPlatform({ apiUrl: "https://api.test", apiKey: "k", fetchImpl });
    await client.getLink("lnk-1");
    await client.getLink("lnk-1");
    expect(seen).toEqual(["POST https://api.test/token", "GET https://api.test/link/lnk-1?include_secret_attributes=true", "GET https://api.test/link/lnk-1?include_secret_attributes=true"]);
    await expect(client.getLink("missing")).rejects.toMatchObject({ status: 404, code: "LINK_NOT_FOUND" });
    const renamed = createPlatform({ apiUrl: "https://api.test", apiKey: "k", fetchImpl, linkSecretsQuery: "show_secrets=1" });
    await renamed.getLink("lnk-1");
    expect(seen.at(-1)).toBe("GET https://api.test/link/lnk-1?show_secrets=1");
  });

  test("reads the execution record and the entity from the catalog, never from cache", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      if (String(url).includes("missing")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }) as typeof fetch;
    const client = createPlatform({ apiUrl: "https://api.test", apiKey: "k", fetchImpl });
    await client.getExecution("s3_browser", "exec-1");
    await client.getExecution("s3_browser", "exec-1");
    await client.getEntity("s3_browser", "ent-4");
    await client.getEntity("s3_browser", "ent-4");
    expect(seen.slice(1)).toEqual([
      "GET https://api.test/catalog/actions/s3_browser/executions/exec-1",
      "GET https://api.test/catalog/actions/s3_browser/executions/exec-1",
      "GET https://api.test/catalog/instances/s3_browser/ent-4",
      "GET https://api.test/catalog/instances/s3_browser/ent-4",
    ]);
    await expect(client.getExecution("s3_browser", "missing")).rejects.toMatchObject({ status: 404 });
  });
});

/** A fake S3 client: records the config it was built with and answers GetObject/HeadObject. */
function fakeClients(answer: (command: unknown) => unknown = () => ({})) {
  const built: Array<{ config: S3ClientConfig; client: S3Client }> = [];
  const sent: unknown[] = [];
  const factory = (config: S3ClientConfig) => {
    const client = { send: async (command: unknown) => (sent.push(command), answer(command)) } as unknown as S3Client;
    built.push({ config, client });
    return client;
  };
  return { factory, built, sent };
}

const body = (text: string | Uint8Array) => ({ transformToByteArray: async () => (typeof text === "string" ? new TextEncoder().encode(text) : text) });

describe("link mode: S3 store", () => {
  test("static credentials get a fresh client per request; the default-chain client is cached per region and never carries them", async () => {
    const { factory, built, sent } = fakeClients(() => ({ Contents: [] }));
    const s3 = createS3({ clientFactory: factory });
    const linkA = { accessKeyId: "AKIA_A", secretAccessKey: "secret-a" };
    const linkB = { accessKeyId: "AKIA_B", secretAccessKey: "secret-b" };
    const calls: Target[] = [
      { bucket: "b", region: "us-east-1" },
      { bucket: "b", region: "us-east-1", credentials: linkA },
      { bucket: "b", region: "us-east-1", credentials: linkA },
      { bucket: "b", region: "us-east-1", credentials: linkB },
      { bucket: "b", region: "eu-west-1", credentials: linkA },
      { bucket: "b", region: "us-east-1" },
    ];
    for (const target of calls) await s3.list(target, "");
    expect(built.map((entry) => [entry.config.region, (entry.config.credentials as { accessKeyId?: string } | undefined)?.accessKeyId ?? null])).toEqual([
      ["us-east-1", null],
      ["us-east-1", "AKIA_A"],
      ["us-east-1", "AKIA_A"],
      ["us-east-1", "AKIA_B"],
      ["eu-west-1", "AKIA_A"],
    ]);
    // The sixth call (default chain again) reused the first client: 6 requests, 5 clients.
    expect(sent).toHaveLength(6);
    expect(new Set(built.map((entry) => entry.client)).size).toBe(5);
  });

  test("the real client factory keeps static credentials instead of the default chain", async () => {
    const client = defaultClientFactory({ region: "us-east-1", credentials: { accessKeyId: "AKIA_STATIC", secretAccessKey: "static-secret" } });
    const credentials = await (client.config.credentials as () => Promise<{ accessKeyId: string; secretAccessKey: string }>)();
    expect(credentials).toMatchObject({ accessKeyId: "AKIA_STATIC", secretAccessKey: "static-secret" });
    // Without credentials it is the bounded default chain (a provider, not static values).
    expect(typeof defaultClientFactory({ region: "us-east-1" }).config.credentials).toBe("function");
  });

  test("read-object: ranged GetObject, truncation from Content-Range, total size", async () => {
    const { factory, sent } = fakeClients((command) => (command instanceof GetObjectCommand ? { Body: body("0123456789"), ContentRange: "bytes 0-9/100", ContentLength: 10, ContentType: "text/plain" } : {}));
    const s3 = createS3({ clientFactory: factory });
    expect(await s3.read({ bucket: "b" }, "a.txt", 10)).toEqual({ key: "a.txt", text: "0123456789", truncated: true, content_type: "text/plain", size: 100 });
    expect((sent.at(-1) as GetObjectCommand).input).toMatchObject({ Bucket: "b", Key: "a.txt", Range: "bytes=0-9" });
  });

  test("read-object: a whole small object is not truncated", async () => {
    const { factory } = fakeClients(() => ({ Body: body("héllo"), ContentRange: "bytes 0-5/6", ContentLength: 6 }));
    expect(await createS3({ clientFactory: factory }).read({ bucket: "b" }, "a.txt", 262144)).toEqual({ key: "a.txt", text: "héllo", truncated: false, content_type: undefined, size: 6 });
  });

  test("read-object: without Content-Range, ContentLength vs bytes read; never more than max", async () => {
    const { factory } = fakeClients(() => ({ Body: body("abcdefgh"), ContentLength: 8 }));
    expect(await createS3({ clientFactory: factory }).read({ bucket: "b" }, "a.txt", 4)).toMatchObject({ text: "abcd", truncated: true, size: 8 });
  });

  test("read-object: a multibyte character cut by the range is held back", async () => {
    const bytes = new TextEncoder().encode("aé"); // 61 c3 a9
    const { factory } = fakeClients(() => ({ Body: body(bytes.subarray(0, 2)), ContentRange: "bytes 0-1/3" }));
    expect(await createS3({ clientFactory: factory }).read({ bucket: "b" }, "a.txt", 2)).toMatchObject({ text: "a", truncated: true, size: 3 });
  });

  test("read-object: an empty object (416 on the range) is empty text", async () => {
    const { factory } = fakeClients((command) => {
      if (command instanceof GetObjectCommand) throw Object.assign(new Error("The requested range is not satisfiable"), { name: "InvalidRange", $metadata: { httpStatusCode: 416 } });
      if (command instanceof HeadObjectCommand) return { ContentLength: 0, ContentType: "text/plain" };
      return {};
    });
    expect(await createS3({ clientFactory: factory }).read({ bucket: "b" }, "empty.txt", 10)).toEqual({ key: "empty.txt", text: "", truncated: false, content_type: "text/plain", size: 0 });
  });

  test("totalFromContentRange", () => {
    expect(totalFromContentRange("bytes 0-9/100")).toBe(100);
    expect(totalFromContentRange("bytes 0-9/*")).toBeUndefined();
    expect(totalFromContentRange(undefined)).toBeUndefined();
  });

  test("S3 errors quoting the keys are redacted", async () => {
    const { factory } = fakeClients((command) => {
      if (command instanceof ListObjectsV2Command) throw Object.assign(new Error(`denied for ${KEY_ID} signed with ${SECRET}`), { name: "AccessDenied" });
      return {};
    });
    const s3 = createS3({ clientFactory: factory });
    const error = await s3.list({ bucket: "b", credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } }, "").catch((e) => e);
    expect(error.status).toBe(403);
    expect(error.message).not.toContain(KEY_ID);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("[redacted]");
  });
});

describe("link mode: the keys never leave the worker", () => {
  const output: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, out: process.stdout.write, err: process.stderr.write };
  beforeEach(() => {
    output.length = 0;
    const capture = (...args: unknown[]) => void output.push(args.map(String).join(" "));
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    console.info = capture;
    process.stdout.write = ((chunk: unknown) => (output.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (output.push(String(chunk)), true)) as typeof process.stderr.write;
  });
  afterEach(() => {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
    console.info = originals.info;
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
  });

  test("no key string in any result, error, log or stream", async () => {
    // A store whose S3 errors quote the keys, as a careless SDK message could.
    const leaky = (op: string) => async () => {
      throw Object.assign(new Error(`${op} failed: key ${KEY_ID} secret ${SECRET}`), { name: "SignatureDoesNotMatch" });
    };
    const throwing: ObjectStore = { list: leaky("list"), head: leaky("head"), presign: leaky("presign"), remove: leaky("remove"), read: leaky("read") };
    const unexpected: ObjectStore = { ...throwing, list: async () => Promise.reject(new TypeError(`boom ${SECRET} ${KEY_ID}`)) };
    const links = {
      "lnk-1": baseLink(),
      "lnk-read": baseLink({ attributes: { access_level: "read" } }),
      "lnk-off": baseLink({ status: "inactive" }),
      "lnk-other": baseLink({ entity_nrn: "organization=1:account=2:namespace=3:application=5" }),
      "lnk-prefix": baseLink({ attributes: { path_prefix: "p/" } }),
      "lnk-db": baseLink({ service_id: "svc-db" }),
      "lnk-pending": baseLink({ service_id: "svc-pending" }),
    };
    const { platform } = fakePlatform(links);
    const { store: happy } = recordingStore();
    const results: Array<{ data: { stdout: string }; error?: string; errorCode?: string }> = [];
    for (const store of [happy, throwing, unexpected]) {
      for (const allowWrites of [true, false]) {
        const handler = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites } });
        for (const linkId of [...Object.keys(links), "lnk-missing"]) {
          for (const [slug, input] of [
            ["list-objects", {}],
            ["list-objects", { prefix: "x/" }],
            ["head-object", { key: "a.txt" }],
            ["read-object", { key: "a.txt", max_bytes: 5 }],
            ["presign-download", { key: "a.txt" }],
            ["delete-object", { key: "a.txt" }],
          ] as const) {
            results.push(await runCommand(linkEnvelope(slug, { link_id: linkId, ...input }), handler));
          }
        }
      }
    }
    // The run covered successes, refusals and failed executions.
    expect(results.some((r) => !JSON.parse(r.data.stdout).error)).toBe(true);
    expect(results.some((r) => JSON.parse(r.data.stdout).error?.status < 500)).toBe(true);
    expect(results.some((r) => r.error !== undefined)).toBe(true);
    const everything = [...output, ...results.map((r) => `${r.data.stdout} ${r.error ?? ""} ${r.errorCode ?? ""}`)].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(KEY_ID);
  });
});
