import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { IdTokenVerifier } from '../lib/id-token.js'
import { base64url, makeClock, makeFetch, makeJwt, jsonResponse, publicJwk } from './helpers.mjs'

const DISCOVERY = 'https://auth.test/.well-known/openid-configuration'
const JWKS = 'https://auth.test/jwks'

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicJwk(publicKey, 'kid-1')
  return { privateKey, publicKey, jwk }
}

function verifier(fetch, clock = makeClock()) {
  return new IdTokenVerifier({ fetchImpl: fetch, now: clock.now, discoveryUrl: DISCOVERY })
}

function discoveryResponse() {
  return jsonResponse({ issuer: 'https://auth.test', jwks_uri: JWKS, revocation_endpoint: 'https://auth.test/revoke' })
}

function claims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: 'https://auth.test',
    aud: 'client-1',
    sub: 'subject-1',
    exp: now + 600,
    iat: now - 10,
    nonce: 'nonce-1',
    sid: 'session-1',
    email: 'user@example.com',
    ...overrides,
  }
}

test('valid ID token verifies and returns the identity', async () => {
  const { privateKey, jwk } = fixture()
  const fetch = makeFetch([
    [DISCOVERY, async () => discoveryResponse()],
    [JWKS, async () => jsonResponse({ keys: [jwk] })],
  ])
  const v = verifier(fetch)
  const token = makeJwt(privateKey, claims(), { kid: 'kid-1' })
  const identity = await v.verify(token, { clientId: 'client-1', nonce: 'nonce-1' })
  assert.equal(identity.subject, 'subject-1')
  assert.equal(identity.sid, 'session-1')
  assert.equal(identity.email, 'user@example.com')
})

test('wrong signature, issuer, audience, expiry, nonce, subject, and sid all reject', async () => {
  const { privateKey, publicKey, jwk } = fixture()
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const fetch = makeFetch([
    [DISCOVERY, async () => discoveryResponse()],
    [JWKS, async () => jsonResponse({ keys: [jwk] })],
  ])
  const v = verifier(fetch)
  const base = { clientId: 'client-1', nonce: 'nonce-1' }

  await assert.rejects(
    () => v.verify(makeJwt(other, claims(), { kid: 'kid-1' }), base),
    (error) => error.code === 'ID_TOKEN_SIGNATURE',
  )
  await assert.rejects(
    () => v.verify(makeJwt(privateKey, claims({ iss: 'https://evil.test' }), { kid: 'kid-1' }), base),
    (error) => error.code === 'ID_TOKEN_ISSUER',
  )
  await assert.rejects(
    () => v.verify(makeJwt(privateKey, claims({ aud: 'other-client' }), { kid: 'kid-1' }), base),
    (error) => error.code === 'ID_TOKEN_AUDIENCE',
  )
  await assert.rejects(
    () => v.verify(makeJwt(privateKey, claims({ exp: Math.floor(Date.now() / 1000) - 30 }), { kid: 'kid-1' }), base),
    (error) => error.code === 'ID_TOKEN_EXPIRED',
  )
  await assert.rejects(
    () => v.verify(makeJwt(privateKey, claims({ nonce: 'other' }), { kid: 'kid-1' }), base),
    (error) => error.code === 'ID_TOKEN_NONCE',
  )
  await assert.rejects(
    () => v.verify(makeJwt(privateKey, claims(), { kid: 'kid-1' }), { ...base, subject: 'other' }),
    (error) => error.code === 'ID_TOKEN_SUBJECT_MISMATCH',
  )
  await assert.rejects(
    () => v.verify(makeJwt(privateKey, claims({ sid: 42 }), { kid: 'kid-1' }), base),
    (error) => error.code === 'ID_TOKEN_SID',
  )
  await assert.rejects(
    () => v.verify(makeJwt(privateKey, claims({ sub: '' }), { kid: 'kid-1' }), base),
    (error) => error.code === 'ID_TOKEN_SUBJECT',
  )
  void publicKey
})

test('ES256 raw JWT signatures verify after DER conversion', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'ec-1', use: 'sig', alg: 'ES256' }
  const fetch = makeFetch([
    [DISCOVERY, async () => discoveryResponse()],
    [JWKS, async () => jsonResponse({ keys: [jwk] })],
  ])
  const v = verifier(fetch)
  const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'ec-1' }))
  const body = base64url(JSON.stringify(claims()))
  const signer = createSign('sha256')
  signer.update(`${header}.${body}`)
  const raw = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
  const token = `${header}.${body}.${raw.toString('base64url')}`
  const identity = await v.verify(token, { clientId: 'client-1', nonce: 'nonce-1' })
  assert.equal(identity.subject, 'subject-1')
})

test('discovery and JWKS are cached, and an unknown kid forces one refresh', async () => {
  const { privateKey, jwk } = fixture()
  let discoveryCalls = 0
  let jwksCalls = 0
  const newKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const newJwk = publicJwk(newKeyPair.publicKey, 'kid-2')
  const fetch = makeFetch([
    [DISCOVERY, async () => {
      discoveryCalls += 1
      return discoveryResponse()
    }],
    [JWKS, async () => {
      jwksCalls += 1
      return jsonResponse({ keys: jwksCalls === 1 ? [jwk] : [jwk, newJwk] })
    }],
  ])
  const v = verifier(fetch)
  await v.verify(makeJwt(privateKey, claims(), { kid: 'kid-1' }), { clientId: 'client-1', nonce: 'nonce-1' })
  await v.verify(makeJwt(privateKey, claims(), { kid: 'kid-1' }), { clientId: 'client-1', nonce: 'nonce-1' })
  assert.equal(discoveryCalls, 1)
  assert.equal(jwksCalls, 1)
  await v.verify(makeJwt(newKeyPair.privateKey, claims(), { kid: 'kid-2' }), { clientId: 'client-1', nonce: 'nonce-1' })
  assert.equal(jwksCalls, 2)
})

test('unsupported algorithms and malformed tokens are rejected before key use', async () => {
  const { privateKey, jwk } = fixture()
  const fetch = makeFetch([
    [DISCOVERY, async () => discoveryResponse()],
    [JWKS, async () => jsonResponse({ keys: [jwk] })],
  ])
  const v = verifier(fetch)
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.`
  await assert.rejects(() => v.verify(none, { clientId: 'client-1', nonce: 'nonce-1' }), (error) => error.code === 'ID_TOKEN_ALG')
  await assert.rejects(() => v.verify('not-a-jwt', { clientId: 'client-1', nonce: 'nonce-1' }), (error) => error.code === 'ID_TOKEN_MALFORMED')
  const hs = makeJwt(privateKey, claims(), { kid: 'kid-1', alg: 'RS256' }).replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'kid-1' })).toString('base64url'))
  await assert.rejects(() => v.verify(hs, { clientId: 'client-1', nonce: 'nonce-1' }), (error) => error.code === 'ID_TOKEN_ALG')
})
