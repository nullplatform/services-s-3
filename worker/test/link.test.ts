import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ListObjectsV2Command, type S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { type Handler, createHandler, createReplayGuard, linkOwnedBy, normalisePathPrefix, runCommand as runPayload } from "../src/handler";
import { type CatalogEntity, type CatalogExecution, createPlatform, type Link, type Platform, PlatformError } from "../src/platform";
import { CommandError, type ParseOptions, isLinkPayload, parseCommand as parsePayload, parseLinkOperation } from "../src/protocol";
import { type AssumeRole, type AssumeRoleRequest, linkRoleArn, linkRoleName, roleSessionName } from "../src/role";
import { createS3, defaultClientFactory, type ObjectStore, type StoreError, type Target } from "../src/s3";

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
  attributes: { access_level: "read-write", path_prefix: "", browser_enabled: true, aws_access_key_id: KEY_ID, aws_secret_access_key: SECRET, ...(overrides.attributes ?? {}) },
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
  attributes: { access_level: "read-write", path_prefix: "", browser_enabled: true, credentials: "role", role_arn: ROLE_ARN, iam_role_name: "np-s3-0a1b2c3d4e5f6789", ...(overrides.attributes ?? {}) },
});

// The catalog as the worker sees it: execution records and entities. `linkEnvelope` records a
// pending execution for every envelope it builds (unless told not to), as the catalog would.
const executions = new Map<string, CatalogExecution>();
// Entities by external id (the application id), as the flat formatted read returns them.
const entities = new Map<string, CatalogEntity>([["4", { application_id: "4", nrn: APP_NRN, created_at: "2026-01-01T00:00:00.000Z" }]]);
const catalogReads: string[] = [];

/** What authz answers for a user, an action and an NRN; every user holds everything unless a test says otherwise. */
type Grants = (userId: string, action: string, nrn: string) => boolean | Promise<boolean>;

function fakePlatform(links: Record<string, Link>, grants: Grants = () => true) {
  const seen: string[] = [];
  // The permission checks, apart from `seen`: "<user> <action> <nrn>".
  const asked: string[] = [];
  const platform: Platform = {
    async isActionGranted(userId, action, nrn) {
      asked.push(`${userId} ${action} ${nrn}`);
      return grants(userId, action, nrn);
    },
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
  return { platform, seen, asked };
}

function recordingStore(existing: string[] = []) {
  const calls: Array<{ op: string; target: Target; arg?: unknown }> = [];
  const store: ObjectStore = {
    async exists(target, key) {
      calls.push({ op: "exists", target, arg: key });
      return existing.includes(key);
    },
    async presignUpload(target, key, size, contentType) {
      calls.push({ op: "presignUpload", target, arg: [key, size, contentType] });
      return { key, url: "https://link-bucket.s3.example.invalid/", fields: [{ name: "key", value: key }, { name: "Policy", value: "signed-policy" }], expires_at: "2026-01-01T00:05:00.000Z" };
    },
    async list(target, prefix, _token, _limit) {
      calls.push({ op: "list", target, arg: prefix });
      return { bucket: target.bucket, region: target.region ?? null, prefix, folders: [], objects: [{ key: `${prefix}a.txt`, name: "a.txt", size: 1, last_modified: null }], next_token: null, truncated: false };
    },
    async search(target, prefix, query, after, limit) {
      calls.push({ op: "search", target, arg: [prefix, query, after, limit] });
      return { bucket: target.bucket, region: target.region ?? null, prefix, query, folders: [], objects: [{ key: `${prefix}deep/match.txt`, name: "match.txt", size: 1, last_modified: null }], scanned: 3, next_token: null, truncated: false };
    },
    async head(target, key) {
      calls.push({ op: "head", target, arg: key });
      return { key, size: 1, last_modified: null, metadata: {} };
    },
    async presign(target, key, disposition) {
      calls.push({ op: "presign", target, arg: disposition === undefined ? key : [key, disposition] });
      return { key, url: `https://example.invalid/${key}`, expires_at: "2026-01-01T00:00:00.000Z" };
    },
    async remove(target, key) {
      calls.push({ op: "remove", target, arg: key });
      return { key };
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

function setup(
  links: Record<string, Link> = { "lnk-1": baseLink() },
  allowWrites = false,
  { grants, existing, ...extra }: { unverifiedEntityBinding?: boolean; uploadMaxBytes?: number; grants?: Grants; existing?: string[] } = {},
) {
  const { platform, seen, asked } = fakePlatform(links, grants);
  const { store, calls } = recordingStore(existing);
  const warnings: string[] = [];
  const handler = createHandler({ platform, store, config: { specifications: ["aws-s3-bucket*"], allowWrites, ...extra, warn: (message) => warnings.push(message) } });
  return { handler, seen, asked, calls, warnings };
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

  test("presign-upload takes a key, the file's size and an optional media type", () => {
    expect(parseLinkOperation("presign-upload", { link_id: "lnk-1", key: "docs/a.csv", size: 12, content_type: "text/csv" })).toMatchObject({ action: "presign-upload", key: "docs/a.csv", size: 12, content_type: "text/csv" });
    expect(parseLinkOperation("presign-upload", { link_id: "lnk-1", key: "a", size: 0, content_type: "" }).content_type).toBeUndefined();
    for (const input of [{ key: "a" }, { key: "a", size: -1 }, { key: "a", size: 1.5 }, { key: "a", size: "1" }, { key: "a", size: 1, content_type: "text" }, { key: "a", size: 1, content_type: "text/plain; charset=utf-8" }, { key: "a", size: 1, bucket: "b" }]) {
      expect(() => parseLinkOperation("presign-upload", { link_id: "lnk-1", ...input })).toThrow(CommandError);
    }
    // S3 would replace ${filename} with the name of the file sent: the key signed would not be the key written.
    expect(() => parseLinkOperation("presign-upload", { link_id: "lnk-1", key: "docs/${filename}", size: 1 })).toThrow(/filename/);
  });

  test("search-objects takes a folder, the text to look for and where to go on", () => {
    expect(parseLinkOperation("search-objects", { link_id: "lnk-1", prefix: "docs/", query: "Report" })).toMatchObject({ action: "search-objects", prefix: "docs/", query: "Report", limit: 200, link: { link_id: "lnk-1" } });
    expect(parseLinkOperation("search-objects", { link_id: "lnk-1", prefix: "docs/", query: "a", token: "docs/2026/a.csv", limit: 50 })).toMatchObject({ token: "docs/2026/a.csv", limit: 50 });
    for (const input of [{}, { query: "" }, { query: "   " }, { query: 7 }, { query: "x".repeat(129) }]) {
      expect(() => parseLinkOperation("search-objects", { link_id: "lnk-1", ...input })).toThrow(/query is required/);
    }
    // Where to go on is a key of the folder searched.
    expect(() => parseLinkOperation("search-objects", { link_id: "lnk-1", prefix: "docs/", query: "a", token: "other/a.csv" })).toThrow(/token/);
    expect(() => parseLinkOperation("search-objects", { link_id: "lnk-1", query: "a", key: "a" })).toThrow(/unexpected input/);
    expect(() => parseLinkOperation("list-objects", { link_id: "lnk-1", query: "a" })).toThrow(/unexpected input/);
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

  test("presign-download: disposition is attachment by default, or inline, and nothing else", () => {
    expect(parseLinkOperation("presign-download", { link_id: "lnk-1", key: "a.txt" }).disposition).toBe("attachment");
    expect(parseLinkOperation("presign-download", { link_id: "lnk-1", key: "a.txt", disposition: "attachment" }).disposition).toBe("attachment");
    expect(parseLinkOperation("presign-download", { link_id: "lnk-1", key: "a.txt", disposition: "inline" }).disposition).toBe("inline");
    for (const bad of ["download", "Inline", "", null, 7, true]) expect(() => parseLinkOperation("presign-download", { link_id: "lnk-1", key: "a.txt", disposition: bad })).toThrow(/disposition/);
  });

  test("read-object does not exist: the worker never handles file content", () => {
    expect(() => parseLinkOperation("read-object", { link_id: "lnk-1", key: "a.txt" })).toThrow(/unknown action/);
    expect(() => parseCommand(JSON.stringify({ notification: { action: "catalog:action:create", id: "exec-1", slug: "read-object", specification: { slug: "s3_browser" } } }))).toThrow(/unknown action/);
  });

  test("only a catalog execution of the link specification is link mode", () => {
    const notLink = [
      // The old agent-identity shapes: a direct command, the bucket-entity catalog, a service action.
      { action: "head-object", service_id: "svc-1", key: "a" },
      { command: { action: "list-objects", service_id: "svc-1" } },
      { action: "catalog:action:create", slug: "head-object", input: { key: "a" }, entity: { bucket_name: "b", region: "r" }, specification: { slug: "aws-s3-bucket" } },
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

  test("LINK_BROWSER_DISABLED: the link's browser_enabled is off, absent, or anything but true", async () => {
    for (const value of [false, undefined, null, "true", 1]) {
      const { handler, calls, seen } = setup({ "lnk-1": baseLink({ attributes: { browser_enabled: value } }) });
      const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), handler);
      expect(result.success).toBe(true);
      expect(parse(result).error).toMatchObject({ status: 403, code: "LINK_BROWSER_DISABLED" });
      expect(calls).toHaveLength(0);
      // Refused on the read without secrets: the keys are never read.
      expect(seen).toEqual(["link lnk-1"]);
    }
  });

  test("the user who ran the execution needs the link's read permission, asked at the link's own NRN", async () => {
    const scopeNrn = `${APP_NRN}:scope=9`;
    const { handler, asked } = setup({ "lnk-1": baseLink(), "lnk-2": baseLink({ id: "lnk-2", entity_nrn: scopeNrn }) });
    for (const [slug, input] of [["list-objects", {}], ["search-objects", { query: "a" }], ["head-object", { key: "a.txt" }], ["presign-download", { key: "a.txt" }], ["presign-download", { key: "a.txt", disposition: "inline" }]] as const) {
      expect(parse(await runCommand(linkEnvelope(slug, { link_id: "lnk-1", ...input }), handler)).error).toBeUndefined();
    }
    await runCommand(linkEnvelope("list-objects", { link_id: "lnk-2" }), handler);
    // Once per execution, for the user the catalog recorded, not the one the envelope names.
    expect(asked).toEqual([...Array(5).fill(`u-1 service:link:read ${APP_NRN}`), `u-1 service:link:read ${scopeNrn}`]);
    const other = setup();
    await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }, { user: { id: "u-forged" } }, { actor_id: "u-7" }), other.handler);
    expect(other.asked).toEqual([`u-7 service:link:read ${APP_NRN}`]);
  });

  test("LINK_ACCESS_DENIED: without the permission nothing is read, and nothing about the link's state is told", async () => {
    for (const link of [baseLink(), baseLink({ status: "pending" }), baseLink({ attributes: { browser_enabled: false } })]) {
      const { handler, calls, seen, asked } = setup({ "lnk-1": link }, false, { grants: () => false });
      const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), handler);
      expect(result.success).toBe(true);
      expect(parse(result).error).toMatchObject({ status: 403, code: "LINK_ACCESS_DENIED" });
      expect(parse(result).error.message).toContain("service:link:read");
      expect(calls).toHaveLength(0);
      expect(seen).toEqual(["link lnk-1"]);
      expect(asked).toEqual([`u-1 service:link:read ${APP_NRN}`]);
    }
    // A link of another application is refused before anyone's permission is asked.
    const foreign = setup({ "lnk-1": baseLink({ entity_nrn: "organization=1:account=2:namespace=3:application=5" }) }, false, { grants: () => false });
    expect(parse(await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), foreign.handler)).error.code).toBe("LINK_NOT_OWNED");
    expect(foreign.asked).toEqual([]);
  });

  test("a delete asks for the permission that changes the link", async () => {
    const reader = setup(undefined, true, { grants: (_user, action) => action === "service:link:read" });
    expect(parse(await runCommand(linkEnvelope("delete-object", { link_id: "lnk-1", key: "a.txt" }), reader.handler)).error).toMatchObject({ status: 403, code: "LINK_ACCESS_DENIED" });
    expect(reader.asked).toEqual([`u-1 service:link:write ${APP_NRN}`]);
    expect(reader.calls).toHaveLength(0);
    const writer = setup(undefined, true, { grants: (_user, action) => action === "service:link:write" });
    expect(parse(await runCommand(linkEnvelope("delete-object", { link_id: "lnk-1", key: "a.txt" }), writer.handler))).toEqual({ key: "a.txt" });
  });

  test("presign-upload: a form for one file of one size at one key, with the link's keys", async () => {
    const { handler, calls, asked } = setup({ "lnk-1": baseLink({ attributes: { path_prefix: "uploads" } }) }, true);
    const result = await runCommand(linkEnvelope("presign-upload", { link_id: "lnk-1", key: "uploads/report.csv", size: 2048, content_type: "text/csv" }), handler);
    expect(parse(result)).toEqual({ key: "uploads/report.csv", url: "https://link-bucket.s3.example.invalid/", fields: [{ name: "key", value: "uploads/report.csv" }, { name: "Policy", value: "signed-policy" }], expires_at: "2026-01-01T00:05:00.000Z" });
    // An upload changes the link's bucket: the permission that changes the link, and the key checked free first.
    expect(asked).toEqual([`u-1 service:link:write ${APP_NRN}`]);
    expect(calls.map((call) => [call.op, call.arg])).toEqual([
      ["exists", "uploads/report.csv"],
      ["presignUpload", ["uploads/report.csv", 2048, "text/csv"]],
    ]);
    expect(calls[1].target).toEqual({ bucket: "link-bucket", region: "sa-east-1", credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } });
    // The content type is optional; a zero-byte file is a file.
    expect(parse(await runCommand(linkEnvelope("presign-upload", { link_id: "lnk-1", key: "uploads/empty", size: 0 }), handler)).error).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ op: "presignUpload", arg: ["uploads/empty", 0, undefined] });
  });

  test("presign-upload is refused like a delete: writes off, a read link, outside the prefix, without the permission", async () => {
    const upload = (handler: Handler, input: Record<string, unknown> = {}) => runCommand(linkEnvelope("presign-upload", { link_id: "lnk-1", key: "a.txt", size: 1, ...input }), handler);
    const off = setup();
    expect(parse(await upload(off.handler)).error).toMatchObject({ status: 405, code: "WRITES_DISABLED" });
    expect(off.seen).toEqual([]);
    const readOnly = setup({ "lnk-1": baseLink({ attributes: { access_level: "read" } }) }, true);
    expect(parse(await upload(readOnly.handler)).error).toMatchObject({ status: 403, code: "WRITE_NOT_ALLOWED" });
    const prefixed = setup({ "lnk-1": baseLink({ attributes: { path_prefix: "uploads/" } }) }, true);
    expect(parse(await upload(prefixed.handler, { key: "other/a.txt" })).error).toMatchObject({ status: 403, code: "OUTSIDE_PREFIX" });
    const reader = setup(undefined, true, { grants: (_user, action) => action === "service:link:read" });
    expect(parse(await upload(reader.handler)).error).toMatchObject({ status: 403, code: "LINK_ACCESS_DENIED" });
    for (const refused of [off, readOnly, prefixed, reader]) expect(refused.calls).toHaveLength(0);
    // A write-only link uploads: it needs no read.
    const writeOnly = setup({ "lnk-1": baseLink({ attributes: { access_level: "write" } }) }, true);
    expect(parse(await upload(writeOnly.handler)).error).toBeUndefined();
  });

  test("presign-upload: UPLOAD_TOO_LARGE before the link is read; OBJECT_EXISTS instead of replacing a file", async () => {
    const small = setup(undefined, true, { uploadMaxBytes: 10 });
    const tooLarge = await runCommand(linkEnvelope("presign-upload", { link_id: "lnk-1", key: "a.txt", size: 11 }), small.handler);
    expect(parse(tooLarge).error).toMatchObject({ status: 413, code: "UPLOAD_TOO_LARGE" });
    expect(small.seen).toEqual([]);
    expect(parse(await runCommand(linkEnvelope("presign-upload", { link_id: "lnk-1", key: "a.txt", size: 10 }), small.handler)).error).toBeUndefined();
    // The default ceiling is 100 MiB.
    const byDefault = setup(undefined, true);
    expect(parse(await runCommand(linkEnvelope("presign-upload", { link_id: "lnk-1", key: "a.txt", size: 104_857_600 }), byDefault.handler)).error).toBeUndefined();
    expect(parse(await runCommand(linkEnvelope("presign-upload", { link_id: "lnk-1", key: "b.txt", size: 104_857_601 }), byDefault.handler)).error.code).toBe("UPLOAD_TOO_LARGE");
    const taken = setup(undefined, true, { existing: ["docs/a.txt"] });
    const exists = await runCommand(linkEnvelope("presign-upload", { link_id: "lnk-1", key: "docs/a.txt", size: 1 }), taken.handler);
    expect(parse(exists).error).toMatchObject({ status: 409, code: "OBJECT_EXISTS" });
    expect(taken.calls.map((call) => call.op)).toEqual(["exists"]);
  });

  test("a permission check that cannot be made is a worker failure, and opens nothing", async () => {
    const { handler, calls, seen } = setup(undefined, false, {
      grants: () => {
        throw new PlatformError("/authz answered HTTP 503");
      },
    });
    const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }), handler);
    expect(result).toMatchObject({ success: false, errorCode: "PERMISSION_CHECK_FAILED" });
    expect(parse(result).error).toMatchObject({ status: 502, code: "PERMISSION_CHECK_FAILED" });
    expect(calls).toHaveLength(0);
    expect(seen).toEqual(["link lnk-1"]);
  });

  test("an execution that names no user is not verified", async () => {
    for (const record of [{ actor_id: null }, { actor_id: "" }, { actor_id: undefined }, { actor_type: "service" }, { actor_type: null }]) {
      const { handler, seen, asked } = setup();
      const result = await runCommand(linkEnvelope("list-objects", { link_id: "lnk-1" }, {}, record), handler);
      expect(parse(result).error).toMatchObject({ status: 403, code: "EXECUTION_NOT_VERIFIED" });
      expect(parse(result).error.message).toContain("names no user");
      expect(seen).toEqual([]);
      expect(asked).toEqual([]);
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
    // A search with no folder searches the link's own, and never above it.
    expect(parse(await runCommand(linkEnvelope("search-objects", { link_id: "lnk-1", query: "a" }), handler)).prefix).toBe("uploads/");
    expect(calls.at(-1)).toMatchObject({ op: "search", arg: ["uploads/", "a", undefined, 200] });
    expect(parse(await runCommand(linkEnvelope("presign-download", { link_id: "lnk-1", key: "uploads/a.txt" }), handler))).toMatchObject({ key: "uploads/a.txt" });
    const before = calls.length;
    for (const [slug, input] of [
      ["list-objects", { prefix: "upload" }],
      ["list-objects", { prefix: "uploads" }],
      ["list-objects", { prefix: "other/" }],
      ["search-objects", { prefix: "other/", query: "a" }],
      ["search-objects", { prefix: "upload", query: "a" }],
      ["head-object", { key: "other/a.txt" }],
      ["presign-download", { key: "uploadsX/a.txt", disposition: "inline" }],
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

  test("search-objects searches the folder with the link's keys, from where the last call stopped", async () => {
    const { handler, calls } = setup();
    const found = parse(await runCommand(linkEnvelope("search-objects", { link_id: "lnk-1", prefix: "docs/", query: "Match", token: "docs/a/b.txt", limit: 20 }), handler));
    expect(found).toMatchObject({ prefix: "docs/", query: "Match", objects: [{ key: "docs/deep/match.txt", name: "match.txt" }], scanned: 3, next_token: null, truncated: false });
    expect(calls.at(-1)).toMatchObject({ op: "search", target: { bucket: "link-bucket" }, arg: ["docs/", "Match", "docs/a/b.txt", 20] });
  });

  test("presign-download passes the disposition to the store: attachment unless inline is asked for", async () => {
    const { handler, calls } = setup();
    await runCommand(linkEnvelope("presign-download", { link_id: "lnk-1", key: "a.txt" }), handler);
    expect(calls.at(-1)).toMatchObject({ op: "presign", arg: ["a.txt", "attachment"] });
    await runCommand(linkEnvelope("presign-download", { link_id: "lnk-1", key: "a.txt", disposition: "inline" }), handler);
    expect(calls.at(-1)).toMatchObject({ op: "presign", arg: ["a.txt", "inline"] });
    expect(parse(await runCommand(linkEnvelope("presign-download", { link_id: "lnk-1", key: "a.txt", disposition: "download" }), handler)).error).toMatchObject({ code: "EXECUTION_NOT_VERIFIED", message: expect.stringContaining("disposition") });
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

  test("asks authz whether a user holds an action at an NRN, never from cache; only an explicit true is a yes", async () => {
    const seen: string[] = [];
    const answers: unknown[] = [{ granted: true }, { granted: false }, { granted: "true" }, {}];
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      seen.push(String(url));
      if (String(url).includes("user_id=down")) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    }) as typeof fetch;
    const client = createPlatform({ apiUrl: "https://api.test", apiKey: "k", fetchImpl });
    const ask = () => client.isActionGranted("42", "service:link:read", `${APP_NRN}:scope=9`);
    expect([await ask(), await ask(), await ask(), await ask()]).toEqual([true, false, false, false]);
    const url = "https://api.test/authz?nrn=organization%3D1%3Aaccount%3D2%3Anamespace%3D3%3Aapplication%3D4%3Ascope%3D9&action=service%3Alink%3Aread&user_id=42";
    expect(seen).toEqual([url, url, url, url]);
    await expect(client.isActionGranted("down", "service:link:read", APP_NRN)).rejects.toBeInstanceOf(PlatformError);
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

describe("link mode: S3 store, uploads", () => {
  test("exists asks for the key as a prefix and answers only for the exact key", async () => {
    const answers = [{ Contents: [{ Key: "docs/a.txt" }] }, { Contents: [{ Key: "docs/a.txt.bak" }] }, {}];
    const { factory, sent } = fakeClients(() => answers.shift());
    const s3 = createS3({ clientFactory: factory });
    const target = { bucket: "b", credentials: KEYS };
    expect([await s3.exists(target, "docs/a.txt"), await s3.exists(target, "docs/a.txt"), await s3.exists(target, "docs/a.txt")]).toEqual([true, false, false]);
    expect(sent[0]).toBeInstanceOf(ListObjectsV2Command);
    expect((sent[0] as ListObjectsV2Command).input).toEqual({ Bucket: "b", Prefix: "docs/a.txt", MaxKeys: 1 });
  });

  test("presignUpload signs a form for that key and that size, valid five minutes", async () => {
    const asked: unknown[] = [];
    const presignPost = (async (_client: unknown, options: unknown) => (asked.push(options), { url: "https://b.s3.amazonaws.com/", fields: { key: "docs/a.csv", Policy: "p" } })) as never;
    const s3 = createS3({ clientFactory: fakeClients().factory, presignPost, now: () => Date.parse("2026-01-01T00:00:00.000Z") });
    expect(await s3.presignUpload({ bucket: "b", credentials: KEYS }, "docs/a.csv", 2048, "text/csv")).toEqual({ key: "docs/a.csv", url: "https://b.s3.amazonaws.com/", fields: [{ name: "key", value: "docs/a.csv" }, { name: "Policy", value: "p" }], expires_at: "2026-01-01T00:05:00.000Z" });
    expect(asked[0]).toEqual({ Bucket: "b", Key: "docs/a.csv", Conditions: [["content-length-range", 2048, 2048]], Fields: { "Content-Type": "text/csv" }, Expires: 300 });
    await s3.presignUpload({ bucket: "b", credentials: KEYS }, "docs/b", 0);
    expect(asked[1]).toEqual({ Bucket: "b", Key: "docs/b", Conditions: [["content-length-range", 0, 0]], Expires: 300 });
  });

  test("a role link's upload form never outlives its session", async () => {
    let requested = 0;
    const presignPost = (async (_client: unknown, options: { Expires?: number }) => ((requested = options.Expires ?? 0), { url: "https://b.s3.amazonaws.com/", fields: {} })) as never;
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const s3 = createS3({ clientFactory: fakeClients().factory, presignPost, uploadTtlSeconds: 600, now: () => now });
    const upload = await s3.presignUpload({ bucket: "b", credentials: { ...SESSION, expiration: new Date(now + 120_000) } }, "a", 1);
    expect(requested).toBe(120);
    expect(upload.expires_at).toBe("2026-01-01T00:02:00.000Z");
    await s3.presignUpload({ bucket: "b", credentials: KEYS }, "a", 1);
    expect(requested).toBe(600);
  });

  test("the real signer pins the bucket, the key and the size in the policy", async () => {
    const s3 = createS3({ now: () => Date.now() });
    const upload = await s3.presignUpload({ bucket: "link-bucket", region: "us-east-1", credentials: KEYS }, "docs/a.csv", 2048, "text/csv");
    expect(upload.url).toBe("https://link-bucket.s3.us-east-1.amazonaws.com/");
    const fields = Object.fromEntries(upload.fields.map((field) => [field.name, field.value]));
    expect(fields).toMatchObject({ key: "docs/a.csv", bucket: "link-bucket", "Content-Type": "text/csv" });
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(["Policy", "X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Signature"]));
    const policy = JSON.parse(Buffer.from(fields.Policy, "base64").toString("utf8")) as { conditions: unknown[] };
    expect(policy.conditions).toEqual(expect.arrayContaining([["content-length-range", 2048, 2048], { bucket: "link-bucket" }, { key: "docs/a.csv" }, { "Content-Type": "text/csv" }]));
    // Nothing in the form is the secret; the key id is, as in a presigned URL.
    expect(JSON.stringify(upload)).not.toContain(SECRET);
  });
});

describe("link mode: S3 store, search", () => {
  const TARGET = { bucket: "b", credentials: KEYS };
  const entries = (keys: string[]) => keys.map((Key) => ({ Key, Size: 1, LastModified: new Date("2026-01-01T00:00:00.000Z") }));
  /** S3 answering a listing of `keys`: those after `StartAfter`, `MaxKeys` at a time. */
  const bucketOf = (keys: string[]) => (command: unknown) => {
    const { StartAfter, MaxKeys } = (command as { input: { StartAfter?: string; MaxKeys: number } }).input;
    const rest = keys.filter((key) => !StartAfter || key > StartAfter);
    return { Contents: entries(rest.slice(0, MaxKeys)), IsTruncated: rest.length > MaxKeys };
  };

  test("finds files and folders by name at any depth, whatever the case, and each folder once", async () => {
    const { factory, sent } = fakeClients(bucketOf(["docs/", "docs/Reports/", "docs/Reports/a.csv", "docs/Reports/annual-REPORT.pdf", "docs/reports-old/x.txt", "docs/z/report.txt", "docs/zebra.txt"]));
    const found = await createS3({ clientFactory: factory }).search(TARGET, "docs/", "report");
    expect(found.folders).toEqual([
      { prefix: "docs/Reports/", name: "Reports" },
      { prefix: "docs/reports-old/", name: "reports-old" },
    ]);
    expect(found.objects.map((object) => object.key)).toEqual(["docs/Reports/annual-REPORT.pdf", "docs/z/report.txt"]);
    expect(found.objects[0]).toEqual({ key: "docs/Reports/annual-REPORT.pdf", name: "annual-REPORT.pdf", size: 1, last_modified: "2026-01-01T00:00:00.000Z", storage_class: undefined, etag: undefined });
    expect(found).toMatchObject({ bucket: "b", region: null, prefix: "docs/", query: "report", scanned: 7, next_token: null, truncated: false });
    // One listing of every level: no delimiter, a thousand keys at a time.
    expect((sent[0] as { input: unknown }).input).toEqual({ Bucket: "b", Prefix: "docs/", MaxKeys: 1000 });
  });

  test("a folder's name matches the folder, not the files in it", async () => {
    const { factory } = fakeClients(bucketOf(["logs/2026/app.txt", "logs/2026/blog.txt"]));
    const found = await createS3({ clientFactory: factory }).search(TARGET, "", "log");
    expect(found.folders).toEqual([{ prefix: "logs/", name: "logs" }]);
    expect(found.objects.map((object) => object.key)).toEqual(["logs/2026/blog.txt"]);
  });

  test("stops at the limit and goes on right after the last key it looked at", async () => {
    const { factory, sent } = fakeClients(bucketOf(["d/a1", "d/a2", "d/b", "d/sub/a3", "d/sub/a4"]));
    const s3 = createS3({ clientFactory: factory, searchPageSize: 2 });
    const first = await s3.search(TARGET, "d/", "a", undefined, 2);
    expect(first.objects.map((object) => object.key)).toEqual(["d/a1", "d/a2"]);
    expect(first).toMatchObject({ scanned: 2, next_token: "d/a2", truncated: true });
    const second = await s3.search(TARGET, "d/", "a", first.next_token!, 2);
    expect(second.objects.map((object) => object.key)).toEqual(["d/sub/a3", "d/sub/a4"]);
    expect(second).toMatchObject({ scanned: 3, next_token: "d/sub/a4", truncated: true });
    const third = await s3.search(TARGET, "d/", "a", second.next_token!, 2);
    expect(third).toMatchObject({ folders: [], objects: [], scanned: 0, next_token: null, truncated: false });
    expect(sent.map((command) => (command as { input: { StartAfter?: string } }).input.StartAfter)).toEqual([undefined, "d/a2", "d/sub/a3", "d/sub/a4"]);
  });

  test("answers with what it has when its time is up, and says where to go on", async () => {
    let clock = 0;
    const answer = bucketOf(["d/x1", "d/x2", "d/x3", "d/x4"]);
    const { factory, sent } = fakeClients((command) => ((clock += 600), answer(command)));
    const found = await createS3({ clientFactory: factory, searchPageSize: 1, searchBudgetMs: 1000, now: () => clock }).search(TARGET, "d/", "nothing");
    expect(found).toMatchObject({ folders: [], objects: [], scanned: 2, next_token: "d/x2", truncated: true });
    expect(sent).toHaveLength(2);
  });

  test("a folder an earlier call reported is not reported again when the search goes on inside it", async () => {
    const { factory } = fakeClients(bucketOf(["d/logs/a", "d/logs/b", "d/logs/deep/c"]));
    const found = await createS3({ clientFactory: factory }).search(TARGET, "d/", "logs", "d/logs/a");
    expect(found).toMatchObject({ folders: [], objects: [], scanned: 2, truncated: false });
  });

  test("S3 errors of a search quote no key", async () => {
    const { factory } = fakeClients(() => {
      throw Object.assign(new Error(`denied for ${KEYS.accessKeyId} ${KEYS.secretAccessKey}`), { name: "AccessDenied" });
    });
    const failure = await createS3({ clientFactory: factory }).search(TARGET, "d/", "a").catch((error: unknown) => error as StoreError);
    expect(failure).toMatchObject({ status: 403, code: "AccessDenied" });
    expect((failure as StoreError).message).not.toContain(KEYS.secretAccessKey);
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
    const throwing: ObjectStore = { list: leaky("list"), search: leaky("search"), head: leaky("head"), presign: leaky("presign"), exists: leaky("exists"), presignUpload: leaky("presignUpload"), remove: leaky("remove") };
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
            ["presign-download", { key: "a.txt" }],
            ["presign-download", { key: "a.txt", disposition: "inline" }],
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

  test("presign inline: plain text, shown in the browser, valid 60 seconds by default and never past the session", async () => {
    const asked: Array<{ input: Record<string, unknown>; expiresIn?: number }> = [];
    const presign = (async (_client: unknown, command: { input: Record<string, unknown> }, options?: { expiresIn?: number }) => (asked.push({ input: command.input, expiresIn: options?.expiresIn }), "https://example.invalid/signed")) as never;
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    const target = { bucket: "b", credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } };
    const s3 = createS3({ clientFactory: fakeClients().factory, presign, now: () => at });

    expect(await s3.presign(target, "docs/a.html", "inline")).toEqual({ key: "docs/a.html", url: "https://example.invalid/signed", expires_at: "2026-01-01T00:01:00.000Z" });
    expect(asked.at(-1)).toEqual({ input: { Bucket: "b", Key: "docs/a.html", ResponseContentDisposition: "inline", ResponseContentType: "text/plain; charset=utf-8" }, expiresIn: 60 });

    // The attachment link is what it always was: the download TTL and a filename.
    expect((await s3.presign(target, "docs/a.html")).expires_at).toBe("2026-01-01T00:15:00.000Z");
    expect(asked.at(-1)).toEqual({ input: { Bucket: "b", Key: "docs/a.html", ResponseContentDisposition: 'attachment; filename="a.html"' }, expiresIn: 900 });
    await s3.presign(target, "docs/a.html", "attachment");
    expect(asked.at(-1)!.input).toEqual({ Bucket: "b", Key: "docs/a.html", ResponseContentDisposition: 'attachment; filename="a.html"' });

    // The view TTL is its own option, and a role session still caps it.
    const custom = createS3({ clientFactory: fakeClients().factory, presign, now: () => at, viewTtlSeconds: 30, downloadTtlSeconds: 3600 });
    await custom.presign(target, "a.txt", "inline");
    expect(asked.at(-1)!.expiresIn).toBe(30);
    const session = { ...target, credentials: { ...target.credentials, expiration: new Date(at + 20_000) } };
    expect((await custom.presign(session, "a.txt", "inline")).expires_at).toBe("2026-01-01T00:00:20.000Z");
    expect(asked.at(-1)!.expiresIn).toBe(20);
  });

  test("ownership, status, service, prefix and write checks apply as for key links, before any AssumeRole", async () => {
    const cases: Array<[Link, string, Record<string, unknown>, boolean, number, string]> = [
      [roleLink({ entity_nrn: "organization=1:account=2:namespace=3:application=5" }), "list-objects", {}, false, 403, "LINK_NOT_OWNED"],
      [roleLink({ status: "pending" }), "list-objects", {}, false, 409, "LINK_NOT_READY"],
      [roleLink({ attributes: { browser_enabled: false } }), "list-objects", {}, false, 403, "LINK_BROWSER_DISABLED"],
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
