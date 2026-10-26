#!/usr/bin/env node
/**
 * Installs s3-browser link mode in an organization (Node >= 20, no dependencies):
 *
 *   1. the `s3_browser` catalog specification (created, or PATCHed when it exists);
 *   2. its five notification executors (created, or PATCHed per action);
 *   3. the agent channel from s3_browser.channel.example.json (created, or PATCHed when one with the
 *      same filters exists at NRN);
 *   4. one `s3_browser` entity per application that has a link to an `aws-s3-bucket*` service.
 *
 * Environment: NP_API_KEY (an API key allowed to do all of the above), NP_API_URL (default
 * https://api.nullplatform.com), NRN (the organization NRN the channel lives at and links are
 * listed under), AGENT_API_KEY (the API key the channel hands to the agent; never printed),
 * S3_BROWSER_SPECIFICATIONS (service specifications whose links are seeded, default aws-s3-bucket*).
 *
 * Flags: --dry-run prints every request (secrets redacted) and sends nothing — not even reads, so
 * it shows the plan as if nothing existed and cannot preview the seeding; --skip-channel;
 * --skip-seed; --allow-destructive (sent on the specification PATCH: the catalog rejects narrowing
 * changes, such as a new pattern, without it); --help.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SPECIFICATION_SLUG = "s3_browser";
const PAGE = 100;

export const USAGE = `usage: NP_API_KEY=… NRN=organization=… AGENT_API_KEY=… node catalog/install.mjs [--dry-run] [--skip-channel] [--skip-seed] [--allow-destructive]`;

export function parseArgs(argv) {
  const flags = { dryRun: false, skipChannel: false, skipSeed: false, allowDestructive: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--skip-channel") flags.skipChannel = true;
    else if (arg === "--skip-seed") flags.skipSeed = true;
    else if (arg === "--allow-destructive") flags.allowDestructive = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return flags;
}

/** `organization=1:account=2:namespace=3:application=4[:scope=…]` → the application part, or undefined. */
export function applicationOf(entityNrn) {
  const match = /^(organization=\d+:account=\d+:namespace=\d+:application=(\d+))(?::|$)/.exec(String(entityNrn ?? ""));
  return match ? { application_id: match[2], nrn: match[1] } : undefined;
}

/** `aws-s3-bucket*` matches by prefix, a bare slug exactly (same rule as the worker). */
export function matchesSpecification(slug, patterns) {
  return patterns.some((pattern) => (pattern.endsWith("*") ? String(slug ?? "").startsWith(pattern.slice(0, -1)) : slug === pattern));
}

export function channelBody(template, { nrn, agentApiKey }) {
  const body = structuredClone(template);
  body.nrn = nrn;
  body.configuration = { ...body.configuration, api_key: agentApiKey };
  return body;
}

/** A copy safe to print: API keys replaced. */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, /^(api_?key|apikey)$/i.test(key) ? "<redacted>" : redact(inner)]));
  return value;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createClient({ apiUrl, apiKey, fetchImpl, dryRun, log }) {
  const base = apiUrl.replace(/\/$/, "");
  let token;
  const describe = (method, path, body) => `${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(redact(body))}`}`;

  async function bearer() {
    if (token) return token;
    const response = await fetchImpl(`${base}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apikey: apiKey }) });
    if (!response.ok) throw new Error(`POST /token answered HTTP ${response.status}`);
    const body = await response.json();
    token = body.access_token ?? body.token;
    if (!token) throw new Error("POST /token returned no access token");
    return token;
  }

  /** `{ status, body }`; in a dry run `{ status: 0, body: null }` without sending anything. */
  async function request(method, path, body) {
    log(`${dryRun ? "[dry-run] " : ""}${describe(method, path, body)}`);
    if (dryRun) return { status: 0, body: null };
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await bearer()}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  }

  /** Same as request, but anything not 2xx (or not in `accept`) is an error. */
  async function expectOk(method, path, body, accept = []) {
    const result = await request(method, path, body);
    if (dryRun || (result.status >= 200 && result.status < 300) || accept.includes(result.status)) return result;
    throw new Error(`${method} ${path} answered HTTP ${result.status}: ${JSON.stringify(redact(result.body))}`);
  }

  if (dryRun) log(`[dry-run] POST /token {"apikey":"<redacted>"} (exchanged on the first request)`);
  return { request, expectOk };
}

async function upsertSpecification(api, specification, log, allowDestructive) {
  const found = await api.expectOk("GET", `/catalog/specifications?slug=${SPECIFICATION_SLUG}`);
  const existing = (found.body?.results ?? []).find((item) => item.slug === SPECIFICATION_SLUG);
  if (existing) {
    const { name, description, schema } = specification;
    await api.expectOk("PATCH", `/catalog/specifications/${existing.id}`, { name, description, schema, ...(allowDestructive ? { allow_destructive: true } : {}) });
    log(`specification ${SPECIFICATION_SLUG}: updated (${existing.id})`);
    return existing.id;
  }
  const created = await api.expectOk("POST", "/catalog/specifications", specification);
  const id = created.body?.id ?? "<specification id>";
  log(`specification ${SPECIFICATION_SLUG}: created (${id})`);
  return id;
}

async function upsertExecutors(api, specificationId, executors, log) {
  const found = await api.expectOk("GET", `/catalog/specifications/${specificationId}/executors`);
  const existing = found.body?.results ?? [];
  for (const executor of executors) {
    const current = existing.find((item) => item.action === executor.action);
    if (current) {
      await api.expectOk("PATCH", `/catalog/specifications/${specificationId}/executors/${current.id}`, { transport: executor.transport, timeout_ms: executor.timeout_ms });
      log(`executor ${executor.action}: updated`);
    } else {
      await api.expectOk("POST", `/catalog/specifications/${specificationId}/executors`, executor);
      log(`executor ${executor.action}: created`);
    }
  }
}

async function upsertChannel(api, body, log) {
  const found = await api.expectOk("GET", `/notification/channel?nrn=${encodeURIComponent(body.nrn)}`);
  const existing = (found.body?.results ?? []).find((item) => item.type === body.type && sameJson(item.filters, body.filters) && sameJson(item.source, body.source));
  if (existing) {
    await api.expectOk("PATCH", `/notification/channel/${existing.id}`, { description: body.description, configuration: body.configuration, filters: body.filters, source: body.source });
    log(`channel: updated (${existing.id})`);
  } else {
    const created = await api.expectOk("POST", "/notification/channel", body);
    log(`channel: created (${created.body?.id ?? "<channel id>"})`);
  }
}

async function seedEntities(api, { nrn, specifications, dryRun }, log) {
  const applications = new Map();
  const services = new Map();
  for (let offset = 0; ; offset += PAGE) {
    const page = await api.expectOk("GET", `/link?nrn=${encodeURIComponent(nrn)}&show_descendants=true&limit=${PAGE}&offset=${offset}`);
    if (dryRun) {
      log("seed: a dry run sends no reads, so the links (and the entities to create) cannot be listed");
      return { created: 0, existing: 0 };
    }
    const links = page.body?.results ?? [];
    for (const link of links) {
      const application = applicationOf(link.entity_nrn);
      if (!application || link.service_id === undefined || link.service_id === null) continue;
      if (!services.has(link.service_id)) {
        const service = await api.expectOk("GET", `/service/${link.service_id}`);
        const specification = service.body?.specification_id ? await api.expectOk("GET", `/service_specification/${service.body.specification_id}`) : { body: {} };
        services.set(link.service_id, matchesSpecification(specification.body?.slug, specifications));
      }
      if (services.get(link.service_id)) applications.set(application.application_id, application);
    }
    if (links.length < PAGE) break;
  }
  let created = 0;
  let existing = 0;
  for (const application of applications.values()) {
    const result = await api.expectOk("POST", `/catalog/instances/${SPECIFICATION_SLUG}`, application, [409]);
    if (result.status === 409) existing += 1;
    else created += 1;
  }
  log(`seed: ${applications.size} application(s) with an S3 link; ${created} entit${created === 1 ? "y" : "ies"} created, ${existing} already there`);
  return { created, existing };
}

/** The whole install; `fetchImpl`, `log` and `env` are injected so it can run against fakes. */
export async function install({ env, flags, fetchImpl = fetch, log = console.log, files = here }) {
  const missing = ["NP_API_KEY", "NRN", ...(flags.skipChannel ? [] : ["AGENT_API_KEY"])].filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing ${missing.join(", ")}\n${USAGE}`);
  if (!/^organization=\d+(:account=\d+)?$/.test(env.NRN)) throw new Error(`NRN must be an organization (or account) NRN, got ${env.NRN}`);
  const read = async (name) => JSON.parse(await readFile(join(files, name), "utf8"));
  const specification = await read("s3_browser.specification.json");
  const executors = await read("s3_browser.executors.json");
  const template = await read("s3_browser.channel.example.json");
  const specifications = (env.S3_BROWSER_SPECIFICATIONS ?? "aws-s3-bucket*").split(",").map((item) => item.trim()).filter(Boolean);

  const api = createClient({ apiUrl: env.NP_API_URL || "https://api.nullplatform.com", apiKey: env.NP_API_KEY, fetchImpl, dryRun: flags.dryRun, log });
  const specificationId = await upsertSpecification(api, specification, log, flags.allowDestructive);
  await upsertExecutors(api, specificationId, executors, log);
  if (!flags.skipChannel) await upsertChannel(api, channelBody(template, { nrn: env.NRN, agentApiKey: env.AGENT_API_KEY }), log);
  const seeded = flags.skipSeed ? { created: 0, existing: 0 } : await seedEntities(api, { nrn: env.NRN, specifications, dryRun: flags.dryRun }, log);
  return { specificationId, seeded };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const major = Number(process.versions.node.split(".")[0]);
  if (!process.versions.bun && major < 20) {
    console.error(`Node >= 20 required (found ${process.versions.node})`);
    process.exit(1);
  }
  try {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.help) console.log(USAGE);
    else await install({ env: process.env, flags });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
