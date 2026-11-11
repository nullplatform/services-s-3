/**
 * The little link mode reads from nullplatform: the catalog's record of the execution, the link,
 * its service and the service's specification. Reads use the agent's API key (NP_API_KEY,
 * injected at spawn), so the worker can only ever see its own organization — that is the tenancy
 * check.
 */
export class PlatformError extends Error {
  constructor(message: string, readonly status = 502, readonly code = "PLATFORM") {
    super(message);
    this.name = "PlatformError";
  }
}

export interface Service {
  id: string;
  slug?: string;
  status?: string;
  specification_id?: string;
  entity_nrn?: string;
  attributes?: Record<string, unknown>;
}

/** A service link; in link mode its attributes carry the IAM keys (or the IAM role) S3 is opened with. */
export interface Link {
  id: string | number;
  status?: string;
  service_id?: string | number;
  entity_nrn?: string;
  attributes?: Record<string, unknown>;
}

export interface Specification {
  id: string;
  slug?: string;
  name?: string;
}

export interface Platform {
  getService(id: string): Promise<Service>;
  getSpecification(id: string): Promise<Specification>;
  /** Reads a link, including its secret attributes unless `secrets` is false. Never cached. */
  getLink(id: string, options?: { secrets?: boolean }): Promise<Link>;
  /** The catalog's record of an action execution (`GET /catalog/actions/{slug}/executions/{id}`). Never cached. */
  getExecution(specificationSlug: string, id: string): Promise<CatalogExecution>;
  /** A catalog entity (`GET /catalog/instances/{slug}/{id}`). Never cached. */
  getEntity(specificationSlug: string, id: string): Promise<CatalogEntity>;
}

/** An action execution record as catalog-entities-api serializes it. */
export interface CatalogExecution {
  id?: string;
  entity_id?: string;
  entity_specification_id?: string;
  action?: string;
  status?: string;
  input?: Record<string, unknown> | null;
  actor_type?: string | null;
  actor_id?: string | null;
  /** The NRN the catalog authorized the execution against (the entity's); null when it has none. */
  entity_nrn?: string | null;
}

/** A catalog entity read: the formatted data, flat (`application_id`, `nrn`, timestamps). */
export interface CatalogEntity {
  nrn?: string;
  application_id?: string | number;
  [field: string]: unknown;
}

interface Options {
  apiUrl?: string;
  apiKey?: string;
  /** Query string that makes `GET /link/{id}` return secret attributes (S3_BROWSER_LINK_SECRETS_QUERY). */
  linkSecretsQuery?: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  specificationTtlMs?: number;
  now?: () => number;
}

export const DEFAULT_LINK_SECRETS_QUERY = "include_secret_attributes=true";

export function createPlatform({ apiUrl = "https://api.nullplatform.com", apiKey, linkSecretsQuery = DEFAULT_LINK_SECRETS_QUERY, fetchImpl = fetch, cacheTtlMs = 60_000, specificationTtlMs = 3_600_000, now = Date.now }: Options): Platform {
  const base = apiUrl.replace(/\/$/, "");
  let session: { token: string; expiresAt: number } | null = null;
  const cache = new Map<string, { value: unknown; expiresAt: number }>();

  async function token(): Promise<string> {
    if (!apiKey) throw new PlatformError("NP_API_KEY is not set on this worker; the agent injects it at spawn", 500, "NO_CREDENTIALS");
    if (session && session.expiresAt > now() + 60_000) return session.token;
    const response = await fetchImpl(`${base}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apikey: apiKey }) });
    if (!response.ok) throw new PlatformError(`token exchange failed: HTTP ${response.status}`);
    const body = (await response.json()) as { access_token?: string; token?: string; expires_in?: number };
    const value = body.access_token ?? body.token;
    if (!value) throw new PlatformError("token exchange returned no access token");
    session = { token: value, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
    return value;
  }

  async function get<T>(path: string, ttlMs: number): Promise<T> {
    const cached = cache.get(path);
    if (cached && cached.expiresAt > now()) return cached.value as T;
    const response = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: "application/json" } });
    if (response.status === 404) throw new PlatformError(`${path} not found`, 404, "NOT_FOUND");
    if (response.status === 403) throw new PlatformError(`${path} is not visible to this worker`, 403, "FORBIDDEN");
    if (!response.ok) throw new PlatformError(`${path} answered HTTP ${response.status}`);
    const value = (await response.json()) as T;
    cache.set(path, { value, expiresAt: now() + ttlMs });
    return value;
  }

  /** A read that is never cached: it decides whether this request is genuine. */
  async function fresh<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: "application/json" } });
    if (response.status === 404) throw new PlatformError(`${path} not found`, 404, "NOT_FOUND");
    if (response.status === 403) throw new PlatformError(`${path} is not visible to this worker`, 403, "FORBIDDEN");
    if (!response.ok) throw new PlatformError(`${path} answered HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  /**
   * A link read: never cached (its keys must not outlive the request), 404 is LINK_NOT_FOUND.
   * `secrets: false` leaves the secrets query out, so the services API masks secret attributes.
   */
  async function getLink(id: string, { secrets = true }: { secrets?: boolean } = {}): Promise<Link> {
    const path = `/link/${encodeURIComponent(id)}`;
    const query = secrets ? linkSecretsQuery.replace(/^\?/, "") : "";
    const response = await fetchImpl(`${base}${path}${query ? `?${query}` : ""}`, { headers: { authorization: `Bearer ${await token()}`, accept: "application/json" } });
    if (response.status === 404) throw new PlatformError(`link ${id} not found`, 404, "LINK_NOT_FOUND");
    if (response.status === 403) throw new PlatformError(`link ${id} is not visible to this worker${secrets ? " (its API key may lack service:link:read-secrets)" : ""}`, 403, "FORBIDDEN");
    if (!response.ok) throw new PlatformError(`${path} answered HTTP ${response.status}`);
    return (await response.json()) as Link;
  }

  return {
    getService: (id) => get<Service>(`/service/${encodeURIComponent(id)}`, cacheTtlMs),
    getSpecification: (id) => get<Specification>(`/service_specification/${encodeURIComponent(id)}`, specificationTtlMs),
    getLink,
    getExecution: (slug, id) => fresh<CatalogExecution>(`/catalog/actions/${encodeURIComponent(slug)}/executions/${encodeURIComponent(id)}`),
    getEntity: (slug, id) => fresh<CatalogEntity>(`/catalog/instances/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`),
  };
}

/** `aws-s3-bucket*` accepts every flavour of the specification; a bare slug must match exactly. */
export function matchesSpecification(slug: string | undefined, patterns: string[]): boolean {
  return patterns.some((pattern) => (pattern.endsWith("*") ? String(slug ?? "").startsWith(pattern.slice(0, -1)) : slug === pattern));
}

export interface ResolvedBucket {
  service: Service;
  specification: Specification;
  bucket: string;
  region: string | undefined;
}

/** The bucket a service points at, after checking it is an S3 bucket at all. */
export async function resolveBucket(platform: Platform, serviceId: string, specifications: string[]): Promise<ResolvedBucket> {
  const service = await platform.getService(serviceId);
  if (!service.specification_id) throw new PlatformError(`service ${serviceId} has no specification`, 400, "NOT_A_BUCKET");
  const specification = await platform.getSpecification(service.specification_id);
  if (!matchesSpecification(specification.slug, specifications)) throw new PlatformError(`service ${serviceId} is a ${specification.slug}, not an S3 bucket`, 400, "NOT_A_BUCKET");
  const attributes = service.attributes ?? {};
  const bucket = attributes.bucket_name;
  if (typeof bucket !== "string" || !bucket) throw new PlatformError(`service ${serviceId} has no bucket yet (status ${service.status ?? "unknown"})`, 409, "NO_BUCKET");
  const region = typeof attributes.bucket_region === "string" && attributes.bucket_region ? attributes.bucket_region : undefined;
  return { service, specification, bucket, region };
}
