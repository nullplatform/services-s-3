/**
 * The little this backend reads from nullplatform: the service the plugin is looking at and its
 * specification. Reads run with the backend's own API key, never with anything from the browser,
 * and are cached briefly because a directory listing is many requests for one page.
 */
export class NullplatformError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'NullplatformError';
    this.status = status;
  }
}

/** `organization=4:account=17:namespace=36` → `{ organization: '4', account: '17', namespace: '36' }` */
export function parseNrn(nrn) {
  const out = {};
  for (const part of String(nrn ?? '').split(':')) {
    const [key, value] = part.split('=');
    if (key && value) out[key] = value;
  }
  return out;
}

export function createNullplatformClient({ baseUrl = 'https://api.nullplatform.com', apiKey, staticToken, fetchImpl = fetch, cacheTtlMs = 60_000, specificationTtlMs = 3_600_000, now = Date.now }) {
  if (!apiKey && !staticToken) throw new Error('NP_API_KEY (or NP_TOKEN) is required');
  const base = baseUrl.replace(/\/$/, '');
  let session = null; // { token, expiresAt }
  const cache = new Map(); // key → { value, expiresAt }

  async function token() {
    if (staticToken) return staticToken;
    if (session && session.expiresAt > now() + 60_000) return session.token;
    const response = await fetchImpl(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apikey: apiKey }) });
    if (!response.ok) throw new NullplatformError(`token exchange failed: HTTP ${response.status}`);
    const body = await response.json();
    const expiresIn = Number(body.expires_in ?? 3600) * 1000;
    session = { token: body.access_token ?? body.token, expiresAt: now() + expiresIn };
    if (!session.token) throw new NullplatformError('token exchange returned no access token');
    return session.token;
  }

  async function get(path, ttlMs) {
    const cached = cache.get(path);
    if (cached && cached.expiresAt > now()) return cached.value;
    const response = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: 'application/json' } });
    if (response.status === 404) throw new NullplatformError(`${path} not found`, 404);
    if (!response.ok) throw new NullplatformError(`${path} answered HTTP ${response.status}`);
    const value = await response.json();
    cache.set(path, { value, expiresAt: now() + ttlMs });
    return value;
  }

  return {
    getService: (id) => get(`/service/${encodeURIComponent(id)}`, cacheTtlMs),
    getSpecification: (id) => get(`/service_specification/${encodeURIComponent(id)}`, specificationTtlMs),
    /** Drops cached reads (tests, or after a service update). */
    reset: () => cache.clear(),
  };
}

/**
 * `aws-s3-bucket*` accepts every flavour of the specification (`aws-s3-bucket`,
 * `aws-s3-bucket-agent-k8s`, ...); a bare slug must match exactly.
 */
export function matchesSpecification(slug, patterns) {
  return patterns.some((pattern) => (pattern.endsWith('*') ? String(slug ?? '').startsWith(pattern.slice(0, -1)) : slug === pattern));
}

/**
 * Resolves the bucket a service points at, after checking the caller may look at it: the
 * service must belong to the caller's organization and be an instance of an allowed
 * specification. Returns `{ service, specification, bucket, region }`.
 */
export async function resolveBucket(np, { serviceId, caller, specifications }) {
  const service = await np.getService(serviceId);
  const owner = parseNrn(service.entity_nrn).organization;
  if (!caller.dev && (!caller.org || owner !== caller.org)) throw new NullplatformError(`service ${serviceId} is not in organization ${caller.org}`, 403);
  const specification = await np.getSpecification(service.specification_id);
  if (!matchesSpecification(specification.slug, specifications)) throw new NullplatformError(`service ${serviceId} is a ${specification.slug}, not an S3 bucket`, 400);
  const attributes = service.attributes ?? {};
  const bucket = attributes.bucket_name;
  if (!bucket) throw new NullplatformError(`service ${serviceId} has no bucket yet (status ${service.status})`, 409);
  return { service, specification, bucket, region: attributes.bucket_region || undefined };
}

/**
 * Local development without platform credentials: `DEV_SERVICES="<service id>=<bucket>[@region],..."`
 * answers those services from memory (as `aws-s3-bucket` instances of the dev caller's
 * organization) and everything else through the real client, when one is configured.
 */
export function parseDevServices(spec) {
  const out = new Map();
  for (const entry of String(spec ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const [id, target] = entry.split('=');
    const [bucket, region] = String(target ?? '').split('@');
    if (!id || !bucket) throw new Error(`DEV_SERVICES entry "${entry}" must look like <service id>=<bucket>[@region]`);
    out.set(id, { bucket, region: region || undefined });
  }
  return out;
}

export function withDevServices(np, devServices, { org } = {}) {
  if (!devServices.size) return np;
  const spec = { id: 'dev-aws-s3-bucket', slug: 'aws-s3-bucket', name: 'AWS S3 Bucket (dev)' };
  const missing = () => {
    throw new NullplatformError('no nullplatform credentials configured (NP_API_KEY or NP_TOKEN) and the service is not in DEV_SERVICES', 404);
  };
  return {
    getService: async (id) => {
      const dev = devServices.get(id);
      if (!dev) return np ? np.getService(id) : missing();
      return { id, slug: `dev-${id}`, name: `dev-${id}`, status: 'active', specification_id: spec.id, entity_nrn: org ? `organization=${org}` : '', attributes: { bucket_name: dev.bucket, bucket_region: dev.region } };
    },
    getSpecification: async (id) => (id === spec.id ? spec : np ? np.getSpecification(id) : missing()),
    reset: () => np?.reset(),
  };
}
