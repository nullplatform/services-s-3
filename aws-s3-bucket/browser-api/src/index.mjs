import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createPluginTokenVerifier } from './auth.mjs';
import { createNullplatformClient, parseDevServices, withDevServices } from './nullplatform.mjs';
import { createS3 } from './s3.mjs';

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`${name} is required`);
  return env[name];
};

const port = Number(env.PORT ?? 8080);
const publicHost = required('PUBLIC_HOST'); // exactly what the plugin manifest declares under permissions.http
const devToken = env.DEV_TOKEN;
if (devToken && env.NODE_ENV === 'production') throw new Error('DEV_TOKEN must not be set in production');

const verify = createPluginTokenVerifier({
  jwksUrl: required('PLUGIN_JWKS_URL'),
  issuer: env.PLUGIN_TOKEN_ISSUER ?? 'https://ui-plugins.nullplatform.io',
  audience: publicHost,
  plugin: env.PLUGIN_SLUG ?? 's3-browser',
  devToken,
  devIdentity: devToken ? { userId: 'dev', org: env.DEV_ORG, nrn: env.DEV_NRN } : undefined,
});

// NP_API_KEY (exchanged for a token, the normal way) or NP_TOKEN (a bearer, local development).
// DEV_SERVICES (dev only) answers listed services from memory, so the backend runs against a
// bucket of yours with no platform credentials at all.
const devServices = parseDevServices(env.DEV_SERVICES);
if (devServices.size && !devToken) throw new Error('DEV_SERVICES requires DEV_TOKEN (development only)');
const hasCredentials = Boolean(env.NP_API_KEY || env.NP_TOKEN);
if (!hasCredentials && !devServices.size) required('NP_API_KEY');
const platform = hasCredentials ? createNullplatformClient({ baseUrl: env.NP_API_URL ?? 'https://api.nullplatform.com', apiKey: env.NP_API_KEY, staticToken: env.NP_TOKEN }) : null;
const np = withDevServices(platform, devServices, { org: env.DEV_ORG });
const s3 = createS3({ defaultRegion: env.AWS_REGION, downloadTtlSeconds: Number(env.DOWNLOAD_TTL_SECONDS ?? 900) });

const app = createApp({
  verify,
  np,
  s3,
  config: {
    specifications: (env.SERVICE_SPECIFICATIONS ?? 'aws-s3-bucket*').split(',').map((item) => item.trim()).filter(Boolean),
    allowWrites: env.ALLOW_WRITES === '1',
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '*').split(',').map((item) => item.trim()).filter(Boolean),
    logger: { info: console.log, error: console.error, debug: env.LOG_LEVEL === 'debug' ? console.log : undefined },
  },
});

// TLS is normally terminated in front of the service; locally the plugin bridge only calls https
// hosts, so a self-signed pair makes https://localhost:<port> a legal destination.
const tls = env.TLS_CERT_FILE && env.TLS_KEY_FILE ? { cert: readFileSync(env.TLS_CERT_FILE), key: readFileSync(env.TLS_KEY_FILE) } : null;
const server = tls ? createHttpsServer(tls, app) : createHttpServer(app);
// A browser that rejects the certificate shows up here, not in the request log.
server.on('tlsClientError', (error, socket) => console.error(`tls handshake failed from ${socket.remoteAddress}: ${error.code ?? error.message}`));
server.listen(port, () => {
  console.log(`s3-browser-api listening on ${tls ? 'https' : 'http'}://0.0.0.0:${port} for ${publicHost}${devToken ? ' (dev token enabled)' : ''}`);
});
