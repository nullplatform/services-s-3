/**
 * Plugin call tokens: what the dashboard attaches when a UI plugin calls this backend.
 *
 * The plugin API mints them (`POST /plugin_tokens`) for a user, an NRN and a package whose
 * manifest declares this host under `permissions.http`. RS256, 60 seconds, audience-bound to
 * this host. Never the user's nullplatform token, never AWS credentials.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function bearer(authorization) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization ?? '').trim());
  return match ? match[1].trim() : null;
}

/**
 * @param {object} options
 * @param {string} [options.jwksUrl]      the plugin API's `/.well-known/plugin-jwks.json`
 * @param {Function} [options.keySet]     a jose key resolver (tests, or a pinned local JWKS)
 * @param {string} options.issuer         must equal the plugin API's `PLUGIN_TOKEN_ISSUER`
 * @param {string} options.audience       this backend's public host, exactly as the manifest declares it
 * @param {string} [options.plugin]       accept tokens minted for this package slug only
 * @param {string} [options.devToken]     a shared secret accepted as a fixed identity (local development only)
 * @param {object} [options.devIdentity]  `{ userId, org, nrn }` used with `devToken`
 */
export function createPluginTokenVerifier({ jwksUrl, keySet, issuer, audience, plugin, clockTolerance = 5, devToken, devIdentity }) {
  if (!issuer || !audience) throw new Error('issuer and audience are required');
  const keys = keySet ?? (jwksUrl ? createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 }) : null);
  if (!keys) throw new Error('jwksUrl or keySet is required');

  return async function verify(authorization) {
    const token = bearer(authorization);
    if (!token) throw new AuthError('missing bearer token');
    if (devToken && token === devToken) return { userId: 'dev', org: undefined, nrn: undefined, plugin, ...devIdentity, dev: true };

    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'], clockTolerance }));
    } catch (error) {
      throw new AuthError(`invalid plugin token: ${error.code ?? error.message}`);
    }
    if (plugin && payload.plugin !== plugin) throw new AuthError(`token issued for plugin ${payload.plugin}, not ${plugin}`, 403);
    return {
      userId: String(payload.sub ?? payload.user_id ?? ''),
      email: payload.email,
      org: payload.org !== undefined ? String(payload.org) : undefined,
      nrn: payload.nrn,
      plugin: payload.plugin,
      version: payload.version,
      jti: payload.jti,
      dev: false,
    };
  };
}
