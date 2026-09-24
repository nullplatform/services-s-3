import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.mjs';
import { AuthError } from '../src/auth.mjs';
import { createNullplatformClient, matchesSpecification, parseDevServices, parseNrn, resolveBucket, withDevServices } from '../src/nullplatform.mjs';
import { createS3 } from '../src/s3.mjs';

const SERVICE = { id: 'svc-1', slug: 'assets', name: 'assets', specification_id: 'spec-s3', entity_nrn: 'organization=4:account=17:namespace=36', status: 'active', attributes: { bucket_name: 'np-assets-abc', bucket_arn: 'arn:aws:s3:::np-assets-abc', bucket_region: 'eu-west-1' } };
const OTHER = { ...SERVICE, id: 'svc-2', specification_id: 'spec-rds', attributes: {} };
const FOREIGN = { ...SERVICE, id: 'svc-3', entity_nrn: 'organization=9:account=1' };
const SPECS = { 'spec-s3': { id: 'spec-s3', slug: 'aws-s3-bucket' }, 'spec-rds': { id: 'spec-rds', slug: 'rds-postgres' } };

const np = {
  async getService(id) {
    const found = [SERVICE, OTHER, FOREIGN].find((item) => item.id === id);
    if (!found) throw Object.assign(new Error('not found'), { status: 404, name: 'NullplatformError' });
    return found;
  },
  async getSpecification(id) {
    return SPECS[id];
  },
};

/** A fake S3 client that records commands and answers like the real one. */
function fakeS3() {
  const sent = [];
  const objects = [
    { Key: 'docs/', Size: 0 },
    { Key: 'docs/readme.md', Size: 120, LastModified: new Date('2026-09-01T10:00:00Z'), StorageClass: 'STANDARD', ETag: '"e1"' },
    { Key: 'docs/notes.txt', Size: 4, LastModified: new Date('2026-09-02T10:00:00Z'), StorageClass: 'STANDARD', ETag: '"e2"' },
  ];
  const clientFactory = (region) => ({
    region,
    async send(command) {
      sent.push({ region, name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: objects, CommonPrefixes: [{ Prefix: 'docs/images/' }], IsTruncated: true, NextContinuationToken: 'next-1' };
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        if (command.input.Key === 'missing') throw Object.assign(new Error('nope'), { name: 'NotFound' });
        return { ContentLength: 120, ContentType: 'text/markdown', LastModified: new Date('2026-09-01T10:00:00Z'), ETag: '"e1"', Metadata: { owner: 'docs' } };
      }
      return {};
    },
  });
  const presign = async (client, command, { expiresIn }) => `https://${command.input.Bucket}.s3.${client.region}.amazonaws.com/${command.input.Key}?X-Amz-Expires=${expiresIn}`;
  return { s3: createS3({ clientFactory, presign, downloadTtlSeconds: 300 }), sent };
}

async function serve(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const verifyAs = (caller) => async (authorization) => {
  if (authorization !== 'Bearer ok') throw new AuthError('bad token');
  return caller;
};
const ORG4 = { userId: '1', org: '4', nrn: 'organization=4:account=17:namespace=36:application=1', dev: false };

describe('s3 browser api', () => {
  it('lists a folder level with folders, objects and a continuation token, in the bucket region', async () => {
    const { s3, sent } = fakeS3();
    const { base, close } = await serve(createApp({ verify: verifyAs(ORG4), np, s3 }));
    try {
      const response = await fetch(`${base}/services/svc-1/objects?prefix=docs/&limit=50`, { headers: { authorization: 'Bearer ok', origin: 'http://localhost:3001' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      const body = await response.json();
      assert.equal(body.bucket, 'np-assets-abc');
      assert.equal(body.region, 'eu-west-1');
      assert.deepEqual(body.folders, [{ prefix: 'docs/images/', name: 'images' }]);
      assert.deepEqual(body.objects.map((item) => item.name), ['readme.md', 'notes.txt']);
      assert.equal(body.next_token, 'next-1');
      assert.equal(sent[0].region, 'eu-west-1');
      assert.deepEqual(sent[0].input, { Bucket: 'np-assets-abc', Prefix: 'docs/', Delimiter: '/', ContinuationToken: undefined, MaxKeys: 50 });
    } finally {
      await close();
    }
  });

  it('answers head and a presigned download as JSON, never a redirect', async () => {
    const { s3 } = fakeS3();
    const { base, close } = await serve(createApp({ verify: verifyAs(ORG4), np, s3 }));
    try {
      const meta = await (await fetch(`${base}/services/svc-1/objects/meta?key=docs/readme.md`, { headers: { authorization: 'Bearer ok' } })).json();
      assert.deepEqual(meta, { key: 'docs/readme.md', size: 120, content_type: 'text/markdown', last_modified: '2026-09-01T10:00:00.000Z', etag: '"e1"', metadata: { owner: 'docs' } });
      const download = await fetch(`${base}/services/svc-1/objects/download?key=docs/readme.md`, { headers: { authorization: 'Bearer ok' }, redirect: 'error' });
      assert.equal(download.status, 200);
      const body = await download.json();
      assert.match(body.url, /^https:\/\/np-assets-abc\.s3\.eu-west-1\.amazonaws\.com\/docs\/readme\.md\?X-Amz-Expires=300$/);
      assert.ok(body.expires_at);
      const missing = await fetch(`${base}/services/svc-1/objects/meta?key=missing`, { headers: { authorization: 'Bearer ok' } });
      assert.equal(missing.status, 404);
    } finally {
      await close();
    }
  });

  it('refuses without a valid token, across organizations, for non-S3 services, unknown services and bad keys', async () => {
    const { s3 } = fakeS3();
    const { base, close } = await serve(createApp({ verify: verifyAs(ORG4), np, s3 }));
    try {
      const status = async (path, headers = { authorization: 'Bearer ok' }) => (await fetch(`${base}${path}`, { headers })).status;
      assert.equal(await status('/services/svc-1/objects', {}), 401);
      assert.equal(await status('/services/svc-3/objects'), 403);
      assert.equal(await status('/services/svc-2/objects'), 400);
      assert.equal(await status('/services/nope/objects'), 404);
      assert.equal(await status('/services/svc-1/objects/meta'), 400);
      assert.equal(await status('/services/svc-1/objects/meta?key=/etc/passwd'), 400);
      assert.equal(await status('/somewhere'), 404);
    } finally {
      await close();
    }
  });

  it('keeps writes off unless enabled, then accepts small base64 uploads and deletes', async () => {
    const { s3, sent } = fakeS3();
    const closed = await serve(createApp({ verify: verifyAs(ORG4), np, s3 }));
    try {
      const put = await fetch(`${closed.base}/services/svc-1/objects?key=docs/new.txt`, { method: 'PUT', headers: { authorization: 'Bearer ok', 'content-type': 'application/json' }, body: JSON.stringify({ content_base64: Buffer.from('hi').toString('base64') }) });
      assert.equal(put.status, 405);
    } finally {
      await closed.close();
    }
    const open = await serve(createApp({ verify: verifyAs(ORG4), np, s3, config: { allowWrites: true, maxUploadBytes: 8, logger: {} } }));
    try {
      const put = await fetch(`${open.base}/services/svc-1/objects?key=docs/new.txt`, { method: 'PUT', headers: { authorization: 'Bearer ok', 'content-type': 'application/json' }, body: JSON.stringify({ content_base64: Buffer.from('hi').toString('base64'), content_type: 'text/plain' }) });
      assert.equal(put.status, 201);
      assert.deepEqual(await put.json(), { key: 'docs/new.txt', size: 2 });
      assert.equal(sent.at(-1).name, 'PutObjectCommand');
      assert.equal(sent.at(-1).input.ContentType, 'text/plain');
      const big = await fetch(`${open.base}/services/svc-1/objects?key=docs/big.bin`, { method: 'PUT', headers: { authorization: 'Bearer ok', 'content-type': 'application/json' }, body: JSON.stringify({ content_base64: Buffer.alloc(64).toString('base64') }) });
      assert.equal(big.status, 413);
      const del = await fetch(`${open.base}/services/svc-1/objects?key=docs/new.txt`, { method: 'DELETE', headers: { authorization: 'Bearer ok' } });
      assert.equal(del.status, 200);
      assert.equal(sent.at(-1).name, 'DeleteObjectCommand');
    } finally {
      await open.close();
    }
  });

  it('honours an origin allow-list on CORS and answers preflight', async () => {
    const { s3 } = fakeS3();
    const { base, close } = await serve(createApp({ verify: verifyAs(ORG4), np, s3, config: { allowedOrigins: ['https://app.nullplatform.io'] } }));
    try {
      const preflight = await fetch(`${base}/services/svc-1/objects`, { method: 'OPTIONS', headers: { origin: 'https://app.nullplatform.io' } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.nullplatform.io');
      assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
      const other = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
      assert.equal(other.headers.get('access-control-allow-origin'), null);
    } finally {
      await close();
    }
  });
});

describe('nullplatform client', () => {
  it('matches specification slugs exactly, or by prefix with a trailing *', () => {
    assert.equal(matchesSpecification('aws-s3-bucket', ['aws-s3-bucket']), true);
    assert.equal(matchesSpecification('aws-s3-bucket-agent-k8s', ['aws-s3-bucket']), false);
    assert.equal(matchesSpecification('aws-s3-bucket-agent-k8s', ['aws-s3-bucket*']), true);
    assert.equal(matchesSpecification('rds-postgres', ['aws-s3-bucket*', 'minio']), false);
    assert.equal(matchesSpecification(undefined, ['aws-s3-bucket*']), false);
  });

  it('exchanges the api key once, caches reads, and resolves the bucket with the organization check', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 });
      if (url.endsWith('/service/svc-1')) return new Response(JSON.stringify(SERVICE), { status: 200 });
      if (url.endsWith('/service_specification/spec-s3')) return new Response(JSON.stringify(SPECS['spec-s3']), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const client = createNullplatformClient({ baseUrl: 'https://api.test', apiKey: 'k', fetchImpl });
    const first = await resolveBucket(client, { serviceId: 'svc-1', caller: ORG4, specifications: ['aws-s3-bucket'] });
    assert.deepEqual({ bucket: first.bucket, region: first.region }, { bucket: 'np-assets-abc', region: 'eu-west-1' });
    await resolveBucket(client, { serviceId: 'svc-1', caller: ORG4, specifications: ['aws-s3-bucket'] });
    assert.deepEqual(calls, ['POST https://api.test/token', 'GET https://api.test/service/svc-1', 'GET https://api.test/service_specification/spec-s3']);
    await assert.rejects(resolveBucket(client, { serviceId: 'svc-1', caller: { ...ORG4, org: '5' }, specifications: ['aws-s3-bucket'] }), { status: 403 });
    await assert.rejects(resolveBucket(client, { serviceId: 'svc-1', caller: ORG4, specifications: ['rds-postgres'] }), { status: 400 });
    assert.deepEqual(parseNrn('organization=4:account=17'), { organization: '4', account: '17' });
  });

  it('a development caller skips the organization check but not the specification check', async () => {
    await assert.doesNotReject(resolveBucket(np, { serviceId: 'svc-3', caller: { userId: 'dev', dev: true }, specifications: ['aws-s3-bucket'] }));
    await assert.rejects(resolveBucket(np, { serviceId: 'svc-2', caller: { userId: 'dev', dev: true }, specifications: ['aws-s3-bucket'] }), { status: 400 });
  });
});

describe('dev services', () => {
  it('parses <id>=<bucket>[@region] entries', () => {
    const map = parseDevServices('svc-a=bucket-a@eu-west-1, svc-b=bucket-b');
    assert.deepEqual([...map.entries()], [['svc-a', { bucket: 'bucket-a', region: 'eu-west-1' }], ['svc-b', { bucket: 'bucket-b', region: undefined }]]);
    assert.throws(() => parseDevServices('svc-a'), /must look like/);
  });

  it('answers listed services from memory and defers the rest to the platform client', async () => {
    const platform = { getService: async (id) => ({ id, entity_nrn: 'organization=4', specification_id: 'spec-real', attributes: { bucket_name: 'real' } }), getSpecification: async () => ({ slug: 'aws-s3-bucket' }), reset: () => {} };
    const np = withDevServices(platform, parseDevServices('svc-dev=dev-bucket@us-east-1'), { org: '4' });
    const dev = await resolveBucket(np, { serviceId: 'svc-dev', caller: { userId: 'dev', org: '4', dev: true }, specifications: ['aws-s3-bucket*'] });
    assert.deepEqual({ bucket: dev.bucket, region: dev.region }, { bucket: 'dev-bucket', region: 'us-east-1' });
    const real = await resolveBucket(np, { serviceId: 'svc-real', caller: { userId: 'u', org: '4' }, specifications: ['aws-s3-bucket*'] });
    assert.equal(real.bucket, 'real');
    const offline = withDevServices(null, parseDevServices('svc-dev=dev-bucket'));
    await assert.rejects(offline.getService('svc-other'), { status: 404 });
  });
});
