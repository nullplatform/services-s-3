import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, type S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { type Handler, createHandler, createReplayGuard, linkOwnedBy, normalisePathPrefix, runCommand as runPayload } from "../src/handler";
import { type CatalogEntity, type CatalogExecution, createPlatform, type Link, type Platform, PlatformError } from "../src/platform";
import { CommandError, type ParseOptions, isLinkPayload, parseCommand as parsePayload, parseLinkOperation } from "../src/protocol";
import { type AssumeRole, type AssumeRoleRequest, linkRoleArn, linkRoleName, roleSessionName } from "../src/role";
import { createS3, defaultClientFactory, type ObjectStore, type Target, totalFromContentRange } from "../src/s3";

// Distinctive values: any appearance of these in an output is a leak.
const KEY_ID = "AKIALINKKEYID0000001";
const SECRET = "linkSecret/Example+Value0000000000000001";
// A role session's credentials, as STS would return them.
const SESSION = { accessKeyId: "ASIASESSIONKEYID0001", secretAccessKey: "sessionSecret/Example+Value000000000001", sessionToken: "sessionToken/Example+Value000000000000000001" };

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

const ROLE_ACCOUNT = "123456789012";
const ROLE_LINK_ID = "0A1B2C3D-4E5F-6789-abcd-ef0123456789";
const ROLE_ARN = `arn:aws:iam::${ROLE_ACCOUNT}:role/np-s3-0a1b2c3d4e5f6789`;

/** A role link as the service leaves it: credentials role, the role's ARN, no keys at all. */
const roleLink = (overrides: Partial<Link> & { attributes?: Record<string, unknown> } = {}): Link => ({
  id: ROLE_LINK_ID,
  status: "active",
  service_id: "svc-bucket",
  entity_nrn: APP_NRN,
  ...overrides,
  attributes: { access_level: "read-write", path_prefix: "", credentials: "role", role_arn: ROLE_ARN, iam_role_name: "np-s3-0a1b2c3d4e5f6789", ...(overrides.attributes ?? {}) },
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
    async getLink(id, { secrets = true } = {}) {
      // "link <id>" is a read without secrets; "+secrets" marks the read that includes them.
      seen.push(secrets ? `link ${id} +secrets` : `link ${id}`);
      const found = links[id];
      if (!found) throw new PlatformError(`link ${id} not found`, 404, "LINK_NOT_FOUND");
      if (secrets) return found;
      // As the services API does: secret attributes come back masked as null.
      const attributes = { ...(found.attributes ?? {}) };
      if ("aws_secret_access_key" in attributes) attributes.aws_secret_access_key = null;
      return { ...found, attributes };
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

// The tests build documents as the agent delivers them; the link-mode route is handed what the SDK
// unwraps from one, its `notification`.
const delivered = (document: string) => JSON.parse(document).notification as Record<string, unknown>;
const runCommand = (document: string, handler: Handler, options?: ParseOptions) => runPayload(delivered(document), handler, options);
const parseCommand = (document: string, options?: ParseOptions) => parsePayload(delivered(document), options);

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
  });

  test("the link specification slug is configurable", () => {
    const payload = linkEnvelope("list-objects", { link_id: "lnk-1" });
    // Under another slug the payload is not link mode: it is the bash service's.
    expect(isLinkPayload(delivered(payload), { linkSpecification: "other_browser" })).toBe(false);
    expect(() => parseCommand(payload, { linkSpecification: "other_browser" })).toThrow(/not a link-mode payload/);
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

  test("only a catalog execution of the link specification is link mode", () => {
    const notLink = [
      // The old agent-identity shapes: a direct command, the bucket-entity catalog, a service action.
      { action: "read-object", service_id: "svc-1", key: "a" },
      { command: { action: "list-objects", service_id: "svc-1" } },
      { action: "catalog:action:create", slug: "read-object", input: { key: "a" }, entity: { bucket_name: "b", region: "r" }, specification: { slug: "aws-s3-bucket" } },
      { action: "service:action:create", specification: { slug: "list-objects" }, parameters: {}, service: { id: "svc-1", specification: { slug: "aws-s3-bucket" } } },
      // The s3_browser slug alone, or the catalog action alone, is not enough.
      { slug: "list-objects", input: { link_id: "lnk-1" }, specification: { slug: "s3_browser" } },
      { action: "catalog:action:update", slug: "list-objects", specification: { slug: "s3_browser" } },
    ];
    for (const payload of notLink) {
      expect(isLinkPayload(payload)).toBe(false);
      expect(() => parsePayload(payload)).toThrow(/not a link-mode payload/);
    }
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

  test("a key link is read without secrets first, then with them; a refused link never with them", async () => {
    const { handler, seen } = setup();
    await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), handler);
    expect(seen).toEqual(["link lnk-1", "link lnk-1 +secrets", "service svc-bucket"]);
    const pending = setup({ "lnk-1": baseLink({ status: "pending" }) });
    await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), pending.handler);
    expect(pending.seen).toEqual(["link lnk-1"]);
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
    // A bare forged document, with nothing of a real execution but its shape, is verified the same way.
    await refused(JSON.stringify({ notification: { id: "exec-forged", action: "catalog:action:create", slug: "list-objects", input: { link_id: "lnk-1" }, specification: { slug: "s3_browser" }, entity: {}, entity_nrn: APP_NRN } }));
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

  test("secrets: false reads the link without the secrets query", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify(baseLink()), { status: 200 });
    }) as typeof fetch;
    const client = createPlatform({ apiUrl: "https://api.test", apiKey: "k", fetchImpl, linkSecretsQuery: "show_secrets=1" });
    await client.getLink("lnk-1", { secrets: false });
    expect(seen.at(-1)).toBe("https://api.test/link/lnk-1");
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

const KEYS = { accessKeyId: KEY_ID, secretAccessKey: SECRET };

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
  test("every request gets a fresh client with the target's credentials; none is cached", async () => {
    const { factory, built, sent } = fakeClients(() => ({ Contents: [] }));
    const s3 = createS3({ clientFactory: factory });
    const linkA = { accessKeyId: "AKIA_A", secretAccessKey: "secret-a" };
    const linkB = { accessKeyId: "AKIA_B", secretAccessKey: "secret-b" };
    const calls: Target[] = [
      { bucket: "b", region: "us-east-1", credentials: linkA },
      { bucket: "b", region: "us-east-1", credentials: linkA },
      { bucket: "b", region: "us-east-1", credentials: linkB },
      { bucket: "b", region: "eu-west-1", credentials: linkA },
    ];
    for (const target of calls) await s3.list(target, "");
    expect(built.map((entry) => [entry.config.region, (entry.config.credentials as { accessKeyId?: string } | undefined)?.accessKeyId ?? null])).toEqual([
      ["us-east-1", "AKIA_A"],
      ["us-east-1", "AKIA_A"],
      ["us-east-1", "AKIA_B"],
      ["eu-west-1", "AKIA_A"],
    ]);
    expect(sent).toHaveLength(4);
    expect(new Set(built.map((entry) => entry.client)).size).toBe(4);
  });

  test("a target without credentials is refused before any client: S3 never opens with the worker's identity", async () => {
    const { factory, built } = fakeClients(() => ({ Contents: [] }));
    const s3 = createS3({ clientFactory: factory });
    for (const credentials of [undefined, { accessKeyId: "", secretAccessKey: "x" }, { accessKeyId: "AKIA_A", secretAccessKey: "" }]) {
      const error = await s3.list({ bucket: "b", credentials } as unknown as Target, "").catch((e) => e);
      expect(error).toMatchObject({ status: 500, code: "NO_CREDENTIALS" });
    }
    expect(built).toHaveLength(0);
  });

  test("a role session's token reaches the client and is redacted from S3 errors", async () => {
    const { factory, built } = fakeClients(() => {
      throw Object.assign(new Error(`denied for token ${SESSION.sessionToken}`), { name: "AccessDenied" });
    });
    const s3 = createS3({ clientFactory: factory });
    const error = await s3.list({ bucket: "b", credentials: SESSION }, "").catch((e) => e);
    expect(built[0]!.config.credentials).toEqual(SESSION);
    expect(error.message).not.toContain(SESSION.sessionToken);
    expect(error.message).toContain("[redacted]");
  });

  test("the real client factory keeps static credentials instead of the default chain", async () => {
    const client = defaultClientFactory({ region: "us-east-1", credentials: { accessKeyId: "AKIA_STATIC", secretAccessKey: "static-secret" } });
    const credentials = await (client.config.credentials as () => Promise<{ accessKeyId: string; secretAccessKey: string }>)();
    expect(credentials).toMatchObject({ accessKeyId: "AKIA_STATIC", secretAccessKey: "static-secret" });
  });

  test("read-object: ranged GetObject, truncation from Content-Range, total size", async () => {
    const { factory, sent } = fakeClients((command) => (command instanceof GetObjectCommand ? { Body: body("0123456789"), ContentRange: "bytes 0-9/100", ContentLength: 10, ContentType: "text/plain" } : {}));
    const s3 = createS3({ clientFactory: factory });
    expect(await s3.read({ bucket: "b", credentials: KEYS }, "a.txt", 10)).toEqual({ key: "a.txt", text: "0123456789", truncated: true, content_type: "text/plain", size: 100 });
    expect((sent.at(-1) as GetObjectCommand).input).toMatchObject({ Bucket: "b", Key: "a.txt", Range: "bytes=0-9" });
  });

  test("read-object: a whole small object is not truncated", async () => {
    const { factory } = fakeClients(() => ({ Body: body("héllo"), ContentRange: "bytes 0-5/6", ContentLength: 6 }));
    expect(await createS3({ clientFactory: factory }).read({ bucket: "b", credentials: KEYS }, "a.txt", 262144)).toEqual({ key: "a.txt", text: "héllo", truncated: false, content_type: undefined, size: 6 });
  });

  test("read-object: without Content-Range, ContentLength vs bytes read; never more than max", async () => {
    const { factory } = fakeClients(() => ({ Body: body("abcdefgh"), ContentLength: 8 }));
    expect(await createS3({ clientFactory: factory }).read({ bucket: "b", credentials: KEYS }, "a.txt", 4)).toMatchObject({ text: "abcd", truncated: true, size: 8 });
  });

  test("read-object: a multibyte character cut by the range is held back", async () => {
    const bytes = new TextEncoder().encode("aé"); // 61 c3 a9
    const { factory } = fakeClients(() => ({ Body: body(bytes.subarray(0, 2)), ContentRange: "bytes 0-1/3" }));
    expect(await createS3({ clientFactory: factory }).read({ bucket: "b", credentials: KEYS }, "a.txt", 2)).toMatchObject({ text: "a", truncated: true, size: 3 });
  });

  test("read-object: an empty object (416 on the range) is empty text", async () => {
    const { factory } = fakeClients((command) => {
      if (command instanceof GetObjectCommand) throw Object.assign(new Error("The requested range is not satisfiable"), { name: "InvalidRange", $metadata: { httpStatusCode: 416 } });
      if (command instanceof HeadObjectCommand) return { ContentLength: 0, ContentType: "text/plain" };
      return {};
    });
    expect(await createS3({ clientFactory: factory }).read({ bucket: "b", credentials: KEYS }, "empty.txt", 10)).toEqual({ key: "empty.txt", text: "", truncated: false, content_type: "text/plain", size: 0 });
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
    // A store whose S3 errors quote the credentials it was given (a link's keys or a role
    // session), as a careless SDK message could.
    const quoted = (target: Target) => `key ${target.credentials?.accessKeyId} secret ${target.credentials?.secretAccessKey} token ${target.credentials?.sessionToken}`;
    const leaky = (op: string) => async (target: Target) => {
      throw Object.assign(new Error(`${op} failed: ${quoted(target)}`), { name: "SignatureDoesNotMatch" });
    };
    const throwing: ObjectStore = { list: leaky("list"), head: leaky("head"), presign: leaky("presign"), remove: leaky("remove"), read: leaky("read") };
    const unexpected: ObjectStore = { ...throwing, list: async (target) => Promise.reject(new TypeError(`boom ${quoted(target)}`)) };
    const links = {
      "lnk-1": baseLink(),
      "lnk-read": baseLink({ attributes: { access_level: "read" } }),
      "lnk-off": baseLink({ status: "inactive" }),
      "lnk-other": baseLink({ entity_nrn: "organization=1:account=2:namespace=3:application=5" }),
      "lnk-prefix": baseLink({ attributes: { path_prefix: "p/" } }),
      "lnk-db": baseLink({ service_id: "svc-db" }),
      "lnk-pending": baseLink({ service_id: "svc-pending" }),
      [ROLE_LINK_ID]: roleLink(),
      "role-prefix": roleLink({ id: "role-prefix", attributes: { role_arn: undefined, path_prefix: "p/" } }),
      "role-read": roleLink({ id: "role-read", attributes: { role_arn: undefined, access_level: "read" } }),
    };
    const { platform } = fakePlatform(links);
    const { store: happy } = recordingStore();
    const results: Array<{ data: { stdout: string }; error?: string; errorCode?: string }> = [];
    for (const store of [happy, throwing, unexpected]) {
      for (const allowWrites of [true, false]) {
        const handler = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites, linkRole: { accountId: ROLE_ACCOUNT } }, assumeRole: async () => SESSION });
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
    for (const value of Object.values(SESSION)) expect(everything).not.toContain(value);
  });
});

describe("link mode: role links", () => {
  /** A handler over role links whose AssumeRole is recorded (and answered by `sts`). */
  function setupRole(links: Record<string, Link> = { [ROLE_LINK_ID]: roleLink() }, { allowWrites = false, linkRole = { accountId: ROLE_ACCOUNT } as { accountId?: string; partition?: string }, sts = async (_request: AssumeRoleRequest) => SESSION } = {}) {
    const { platform, seen } = fakePlatform(links);
    const { store, calls } = recordingStore();
    const assumed: AssumeRoleRequest[] = [];
    const warnings: string[] = [];
    const assumeRole: AssumeRole = async (request) => (assumed.push(request), sts(request));
    const handler = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites, linkRole, warn: (message) => warnings.push(message) }, assumeRole });
    return { handler, seen, calls, assumed, warnings };
  }
  const run = (handler: ReturnType<typeof setupRole>["handler"], slug: string, input: Record<string, unknown> = {}, linkId = ROLE_LINK_ID) => runCommand(linkEnvelope(slug, { link_id: linkId, ...input }), handler);

  test("opens S3 with a session of the role rebuilt from the link id; no secret is read", async () => {
    const { handler, seen, calls, assumed } = setupRole();
    const payload = linkEnvelope("list-objects", { link_id: ROLE_LINK_ID, prefix: "docs/" });
    const result = await runCommand(payload, handler);
    expect(parse(result)).toMatchObject({ bucket: "link-bucket", region: "sa-east-1", prefix: "docs/" });
    const executionId = JSON.parse(payload).notification.id;
    expect(assumed).toEqual([{ roleArn: ROLE_ARN, sessionName: `s3-browser-${executionId}`, durationSeconds: 900, region: "sa-east-1" }]);
    expect(calls.at(-1)).toMatchObject({ op: "list", target: { bucket: "link-bucket", region: "sa-east-1", credentials: SESSION }, arg: "docs/" });
    // Without an expiration from STS, the session is taken to end 900 s after it was asked for.
    const expiration = calls.at(-1)!.target.credentials!.expiration!.getTime();
    expect(expiration).toBeGreaterThan(Date.now() + 890_000);
    expect(expiration).toBeLessThanOrEqual(Date.now() + 900_000);
    // Only the read without secrets, ever.
    expect(seen).toEqual([`link ${ROLE_LINK_ID}`, "service svc-bucket"]);
  });

  test("a link with no role_arn yet still gets the rebuilt role; the partition is configurable", async () => {
    const { handler, assumed } = setupRole({ [ROLE_LINK_ID]: roleLink({ attributes: { role_arn: undefined } }) }, { linkRole: { accountId: ROLE_ACCOUNT, partition: "aws-cn" } });
    expect(parse(await run(handler, "head-object", { key: "a.txt" })).key).toBe("a.txt");
    expect(assumed[0]!.roleArn).toBe(`arn:aws-cn:iam::${ROLE_ACCOUNT}:role/np-s3-0a1b2c3d4e5f6789`);
  });

  test("LINK_ROLE_MISMATCH: the link's role_arn is never assumed when it is not the rebuilt one", async () => {
    for (const role_arn of ["arn:aws:iam::999999999999:role/np-s3-0a1b2c3d4e5f6789", `arn:aws:iam::${ROLE_ACCOUNT}:role/admin`, `${ROLE_ARN}x`]) {
      const { handler, calls, assumed } = setupRole({ [ROLE_LINK_ID]: roleLink({ attributes: { role_arn } }) });
      const result = await run(handler, "list-objects");
      expect(result.success).toBe(true);
      expect(parse(result).error).toMatchObject({ status: 403, code: "LINK_ROLE_MISMATCH" });
      expect(assumed).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("LINK_ROLE_NOT_CONFIGURED: no account, or an invalid account or partition", async () => {
    for (const linkRole of [{}, { accountId: "" }, { accountId: "12345" }, { accountId: "1234567890123" }, { accountId: "12345678901a" }, { accountId: ROLE_ACCOUNT, partition: "evil:arn" }]) {
      const { handler, calls, assumed } = setupRole(undefined, { linkRole });
      const result = await run(handler, "list-objects");
      expect(result.success).toBe(true);
      expect(parse(result).error).toMatchObject({ status: 409, code: "LINK_ROLE_NOT_CONFIGURED" });
      expect(assumed).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  test("LINK_ROLE_DENIED when STS refuses the AssumeRole; other STS failures fail the execution", async () => {
    const denied = setupRole(undefined, {
      sts: async () => {
        throw Object.assign(new Error(`User: arn:aws:sts::111111111111:assumed-role/worker/x is not authorized to perform: sts:AssumeRole on resource: ${ROLE_ARN}`), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      },
    });
    const refused = await run(denied.handler, "list-objects");
    expect(refused.success).toBe(true);
    expect(parse(refused).error).toMatchObject({ status: 403, code: "LINK_ROLE_DENIED" });
    expect(parse(refused).error.message).toContain(ROLE_ARN);
    // STS's own message (the worker's identity) goes to the worker's log only.
    expect(refused.data.stdout).not.toContain("111111111111");
    expect(refused.data.stdout).not.toContain("assumed-role");
    expect(denied.warnings.join("\n")).toContain("assumed-role/worker");
    expect(denied.calls).toHaveLength(0);

    const broken = setupRole(undefined, {
      sts: async () => {
        throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
      },
    });
    const failed = await run(broken.handler, "list-objects");
    expect(failed.success).toBe(false);
    expect(parse(failed).error).toMatchObject({ status: 500, code: "CredentialsProviderError" });

    // STS answers the worker's own bad credentials with a 403 as well: a broken worker, not a refusal.
    const invalid = setupRole(undefined, {
      sts: async () => {
        throw Object.assign(new Error("The security token included in the request is invalid."), { name: "InvalidClientTokenId", $metadata: { httpStatusCode: 403 } });
      },
    });
    const broke = await run(invalid.handler, "list-objects");
    expect(broke.success).toBe(false);
    expect(parse(broke).error).toMatchObject({ status: 500, code: "InvalidClientTokenId" });
  });

  test("no STS failure puts the worker's identity or a session value in the result", async () => {
    const workerArn = "arn:aws:sts::111111111111:assumed-role/s3-browser-worker/i-0abc";
    const failures = [
      Object.assign(new Error(`User: ${workerArn} is not authorized to perform: sts:AssumeRole on resource: ${ROLE_ARN}`), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }),
      Object.assign(new Error(`STS is not activated in sa-east-1 for account 111111111111 (caller ${workerArn}, token ${SESSION.sessionToken})`), { name: "RegionDisabledException", $metadata: { httpStatusCode: 403 } }),
      Object.assign(new Error(`Request ARN ${workerArn} key ${SESSION.accessKeyId} secret ${SESSION.secretAccessKey} expired`), { name: "ExpiredToken" }),
    ];
    for (const failure of failures) {
      const { handler } = setupRole(undefined, {
        sts: async () => {
          throw failure;
        },
      });
      const result = await run(handler, "list-objects");
      const output = `${result.data.stdout} ${result.error ?? ""} ${result.errorCode ?? ""}`;
      expect(JSON.parse(result.data.stdout).error.code).toBe(failure.name === "AccessDenied" ? "LINK_ROLE_DENIED" : failure.name);
      for (const leak of ["111111111111", "assumed-role", "s3-browser-worker", ...Object.values(SESSION)]) expect(output).not.toContain(leak);
    }
  });

  test("a role link's presigned URL never outlives its session", async () => {
    const { handler, calls } = setupRole(undefined, { sts: async () => ({ ...SESSION, expiration: new Date(Date.now() + 900_000) }) });
    await run(handler, "presign-download", { key: "a.txt" });
    const target = calls.at(-1)!.target;
    // The store caps the URL at the session's end, even with a longer download TTL.
    let requested = 0;
    const s3 = createS3({
      downloadTtlSeconds: 3600,
      clientFactory: fakeClients().factory,
      presign: (async (_client: unknown, _command: unknown, options?: { expiresIn?: number }) => ((requested = options?.expiresIn ?? 0), "https://example.invalid/signed")) as never,
    });
    const before = Date.now();
    const download = await s3.presign(target, "a.txt");
    expect(requested).toBeGreaterThan(890);
    expect(requested).toBeLessThanOrEqual(900);
    expect(new Date(download.expires_at).getTime()).toBeLessThanOrEqual(target.credentials!.expiration!.getTime() + 1000);
    expect(new Date(download.expires_at).getTime() - before).toBeLessThanOrEqual(901_000);
    // Key links (no expiration) keep the configured TTL.
    await s3.presign({ bucket: "b", credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } }, "a.txt");
    expect(requested).toBe(3600);
  });

  test("ownership, status, service, prefix and write checks apply as for key links, before any AssumeRole", async () => {
    const cases: Array<[Link, string, Record<string, unknown>, boolean, number, string]> = [
      [roleLink({ entity_nrn: "organization=1:account=2:namespace=3:application=5" }), "list-objects", {}, false, 403, "LINK_NOT_OWNED"],
      [roleLink({ status: "pending" }), "list-objects", {}, false, 409, "LINK_NOT_READY"],
      [roleLink({ service_id: undefined }), "list-objects", {}, false, 409, "LINK_NOT_READY"],
      [roleLink({ service_id: "svc-db" }), "list-objects", {}, false, 400, "NOT_A_BUCKET"],
      [roleLink({ attributes: { path_prefix: "uploads" } }), "head-object", { key: "other/a.txt" }, false, 403, "OUTSIDE_PREFIX"],
      [roleLink({ attributes: { path_prefix: "uploads" } }), "list-objects", { prefix: "other/" }, false, 403, "OUTSIDE_PREFIX"],
      [roleLink({ attributes: { access_level: "read" } }), "delete-object", { key: "a.txt" }, true, 403, "WRITE_NOT_ALLOWED"],
      [roleLink(), "delete-object", { key: "a.txt" }, false, 405, "WRITES_DISABLED"],
    ];
    for (const [link, slug, input, allowWrites, status, code] of cases) {
      const { handler, calls, assumed, seen } = setupRole({ [ROLE_LINK_ID]: link }, { allowWrites });
      expect(parse(await run(handler, slug, input)).error).toMatchObject({ status, code });
      expect(assumed).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(seen.some((entry) => entry.endsWith("+secrets"))).toBe(false);
    }
    // Inside the prefix and with a write level, the same link works.
    const { handler, calls } = setupRole({ [ROLE_LINK_ID]: roleLink({ attributes: { path_prefix: "uploads", access_level: "write" } }) }, { allowWrites: true });
    expect(parse(await run(handler, "list-objects")).prefix).toBe("uploads/");
    expect(parse(await run(handler, "delete-object", { key: "uploads/a.txt" }))).toEqual({ key: "uploads/a.txt" });
    expect(calls.map((call) => call.op)).toEqual(["list", "remove"]);
  });

  test("a key link (credentials access-key or absent) never assumes a role", async () => {
    for (const credentials of ["access-key", undefined]) {
      const { handler, calls, assumed, seen } = setupRole({ "lnk-1": baseLink({ attributes: { credentials } }) });
      await run(handler, "list-objects", {}, "lnk-1");
      expect(assumed).toHaveLength(0);
      expect(calls.at(-1)?.target.credentials).toEqual({ accessKeyId: KEY_ID, secretAccessKey: SECRET });
      expect(seen).toContain("link lnk-1 +secrets");
    }
  });

  test("names: the role as the service derives it, the session in STS's alphabet", () => {
    // scripts/aws/build_permissions_context: np-s3-$(tr -d '-' | cut -c1-16 | tr upper lower)
    expect(linkRoleName("ABCDEF01-2345-6789-abcd-ef0123456789")).toBe("np-s3-abcdef0123456789");
    expect(linkRoleName("12-34")).toBe("np-s3-1234");
    expect(linkRoleArn("ABCDEF01-2345", { accountId: ROLE_ACCOUNT })).toBe(`arn:aws:iam::${ROLE_ACCOUNT}:role/np-s3-abcdef012345`);
    expect(linkRoleArn("x", { accountId: ROLE_ACCOUNT, partition: "aws-us-gov" })).toBe(`arn:aws-us-gov:iam::${ROLE_ACCOUNT}:role/np-s3-x`);
    expect(linkRoleArn("x", {})).toBeUndefined();
    expect(roleSessionName("exec-1")).toBe("s3-browser-exec-1");
    expect(roleSessionName("a b/c:d")).toBe("s3-browser-a-b-c-d");
    const long = roleSessionName("e".repeat(100));
    expect(long).toHaveLength(64);
    expect(long).toMatch(/^[\w+=,.@-]+$/);
  });
});
