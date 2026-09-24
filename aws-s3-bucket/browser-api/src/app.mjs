/**
 * The HTTP surface the S3 browser plugin calls. Every request:
 *   1. carries a plugin call token for this host (or the local dev token);
 *   2. names a service; the backend resolves its bucket and checks the caller's organization;
 *   3. reads S3 with the backend's own credentials.
 *
 * Bodies are JSON both ways: the plugin bridge sends JSON and cannot follow redirects, so a
 * download is a presigned URL in a JSON answer, not a 302.
 */
import { NullplatformError, resolveBucket } from './nullplatform.mjs';
import { s3ErrorStatus } from './s3.mjs';

const MAX_KEY = 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, `body over ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

function keyParam(url) {
  const key = url.searchParams.get('key') ?? '';
  if (!key || key.length > MAX_KEY || key.startsWith('/') || key.includes('\0')) throw new HttpError(400, 'key is required');
  return key;
}

function prefixParam(url) {
  const prefix = url.searchParams.get('prefix') ?? '';
  if (prefix.length > MAX_KEY || prefix.startsWith('/') || prefix.includes('\0')) throw new HttpError(400, 'invalid prefix');
  return prefix;
}

/**
 * @param {object} deps
 * @param {(authorization: string) => Promise<object>} deps.verify
 * @param {object} deps.np           nullplatform client (`getService`, `getSpecification`)
 * @param {object} deps.s3           see `createS3`
 * @param {object} [deps.config]     `{ specifications, allowWrites, maxUploadBytes, allowedOrigins, logger }`
 */
export function createApp({ verify, np, s3, config = {} }) {
  const specifications = config.specifications ?? ['aws-s3-bucket'];
  const allowWrites = Boolean(config.allowWrites);
  const maxUploadBytes = config.maxUploadBytes ?? 5 * 1024 * 1024;
  const allowedOrigins = config.allowedOrigins ?? ['*'];
  const log = config.logger ?? console;

  function cors(req, res) {
    const origin = req.headers.origin;
    const allowed = allowedOrigins.includes('*') ? '*' : origin && allowedOrigins.includes(origin) ? origin : null;
    if (!allowed) return false;
    res.setHeader('access-control-allow-origin', allowed);
    res.setHeader('access-control-allow-methods', 'GET,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('access-control-max-age', '600');
    if (allowed !== '*') res.setHeader('vary', 'origin');
    return true;
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const started = Date.now();
    try {
      cors(req, res);
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      if (url.pathname === '/health') return json(res, 200, { status: 'ok' });

      const route = /^\/services\/([^/]+)\/objects(?:\/(meta|download))?$/.exec(url.pathname);
      if (!route) throw new HttpError(404, 'not found');
      const serviceId = decodeURIComponent(route[1]);
      const sub = route[2];

      const caller = await verify(req.headers.authorization);
      const { bucket, region } = await resolveBucket(np, { serviceId, caller, specifications });
      const target = { bucket, region };

      if (req.method === 'GET' && !sub) {
        const result = await s3.list({ ...target, prefix: prefixParam(url), token: url.searchParams.get('token') ?? undefined, limit: url.searchParams.get('limit') ?? undefined });
        return json(res, 200, { ...result, region: region ?? null });
      }
      if (req.method === 'GET' && sub === 'meta') return json(res, 200, await s3.head({ ...target, key: keyParam(url) }));
      if (req.method === 'GET' && sub === 'download') return json(res, 200, await s3.downloadUrl({ ...target, key: keyParam(url) }));

      if (!allowWrites) throw new HttpError(405, 'writes are disabled on this browser');
      if (req.method === 'PUT' && !sub) {
        const key = keyParam(url);
        const body = await readJson(req, Math.ceil(maxUploadBytes * 1.4) + 4096);
        if (typeof body.content_base64 !== 'string') throw new HttpError(400, 'content_base64 is required');
        const bytes = Buffer.from(body.content_base64, 'base64');
        if (bytes.length > maxUploadBytes) throw new HttpError(413, `object over ${maxUploadBytes} bytes`);
        log.info?.(`put ${bucket}/${key} (${bytes.length} bytes) by ${caller.userId}`);
        return json(res, 201, await s3.put({ ...target, key, body: bytes, contentType: typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream' }));
      }
      if (req.method === 'DELETE' && !sub) {
        const key = keyParam(url);
        log.info?.(`delete ${bucket}/${key} by ${caller.userId}`);
        return json(res, 200, await s3.remove({ ...target, key }));
      }
      throw new HttpError(405, 'method not allowed');
    } catch (error) {
      const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : s3ErrorStatus(error);
      if (status >= 500) log.error?.(`${req.method} ${url.pathname} failed: ${error.message}`);
      return json(res, status, { error: error.name ?? 'Error', message: status >= 500 && !(error instanceof NullplatformError) ? 'the bucket could not be read' : error.message });
    } finally {
      log.debug?.(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };
}
