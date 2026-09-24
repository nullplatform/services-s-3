import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createPluginTokenVerifier } from '../src/auth.mjs';

const ISSUER = 'https://ui-plugins.test';
const HOST = 's3-browser.example.com';

async function issuer() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', use: 'sig', alg: 'RS256' };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims, { key = privateKey, kid = 'k1', ttl = 60 } = {}) =>
    new SignJWT({ user_id: '1234', email: 'dev@example.com', org: '4', nrn: 'organization=4:account=17:namespace=36:application=1', plugin: 's3-browser', version: '0.1.0', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(claims.iss ?? ISSUER)
      .setAudience(claims.aud ?? HOST)
      .setSubject('1234')
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .setJti('j1')
      .sign(key);
  return { keySet, sign, privateKey };
}

describe('plugin call token verification', () => {
  it('accepts a token minted for this host by the platform and exposes the caller', async () => {
    const { keySet, sign } = await issuer();
    const verify = createPluginTokenVerifier({ keySet, issuer: ISSUER, audience: HOST, plugin: 's3-browser' });
    const caller = await verify(`Bearer ${await sign({})}`);
    assert.deepEqual(caller, { userId: '1234', email: 'dev@example.com', org: '4', nrn: 'organization=4:account=17:namespace=36:application=1', plugin: 's3-browser', version: '0.1.0', jti: 'j1', dev: false });
  });

  it('rejects a missing header, a token for another host, another issuer, another plugin, an expired one and a foreign key', async () => {
    const { keySet, sign } = await issuer();
    const verify = createPluginTokenVerifier({ keySet, issuer: ISSUER, audience: HOST, plugin: 's3-browser' });
    await assert.rejects(verify(undefined), { status: 401 });
    await assert.rejects(verify('Basic abc'), { status: 401 });
    await assert.rejects(verify(`Bearer ${await sign({ aud: 'other.example.com' })}`), { status: 401 });
    await assert.rejects(verify(`Bearer ${await sign({ iss: 'https://evil.example' })}`), { status: 401 });
    await assert.rejects(verify(`Bearer ${await sign({ plugin: 'finops' })}`), { status: 403 });
    await assert.rejects(verify(`Bearer ${await sign({}, { ttl: -120 })}`), { status: 401 });
    const foreign = await issuer();
    await assert.rejects(verify(`Bearer ${await foreign.sign({})}`), { status: 401 });
  });

  it('accepts the development token only when configured, as a fixed identity', async () => {
    const { keySet } = await issuer();
    const strict = createPluginTokenVerifier({ keySet, issuer: ISSUER, audience: HOST });
    await assert.rejects(strict('Bearer letmein'), { status: 401 });
    const dev = createPluginTokenVerifier({ keySet, issuer: ISSUER, audience: HOST, devToken: 'letmein', devIdentity: { userId: 'me', org: '4', nrn: 'organization=4' } });
    assert.deepEqual(await dev('Bearer letmein'), { userId: 'me', org: '4', nrn: 'organization=4', plugin: undefined, dev: true });
  });
});
