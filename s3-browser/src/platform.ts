/**
 * The little this worker reads from nullplatform: the service the browser is looking at and
 * its specification. Reads use the agent's API key (NP_API_KEY, injected at spawn), so the
 * worker can only ever see services of its own organization — that is the tenancy check.
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

export interface Specification {
  id: string;
  slug?: string;
  name?: string;
}

export interface Platform {
  getService(id: string): Promise<Service>;
  getSpecification(id: string): Promise<Specification>;
}

interface Options {
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  specificationTtlMs?: number;
  now?: () => number;
}

export function createPlatform({ apiUrl = "https://api.nullplatform.com", apiKey, fetchImpl = fetch, cacheTtlMs = 60_000, specificationTtlMs = 3_600_000, now = Date.now }: Options): Platform {
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

  return {
    getService: (id) => get<Service>(`/service/${encodeURIComponent(id)}`, cacheTtlMs),
    getSpecification: (id) => get<Specification>(`/service_specification/${encodeURIComponent(id)}`, specificationTtlMs),
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
