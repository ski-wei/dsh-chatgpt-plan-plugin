import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { OAuthClient } from '../lib/oauth.js'
import { createPkce } from '../lib/pkce.js'
import { jsonResponse, makeFetch } from './helpers.mjs'

function client(fetchImpl) {
  return new OAuthClient({
    fetchImpl,
    verifier: { discover: async () => ({ issuer: 'https://auth.openai.com', jwksUri: 'https://auth.openai.com/jwks', revocationEndpoint: 'https://auth.openai.com/revoke' }) },
  })
}

test('new registration authorize URL carries dynamic client, host id, and PKCE', () => {
  const oauth = client(async () => { throw new Error('no network') })
  const pkce = createPkce()
  assert.equal(pkce.method, 'S256')
  assert.equal(
    pkce.challenge,
    createHash('sha256').update(pkce.verifier).digest('base64url'),
  )
  const url = new URL(oauth.buildAuthorizeUrl({
    newAccount: true,
    clientId: 'dynamic_agent_client',
    hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    redirectUri: 'http://127.0.0.1:3080/auth/callback',
    state: 'state-1',
    nonce: 'nonce-1',
    challenge: pkce.challenge,
    agentNameHint: 'DeepSeek Harness',
  }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize')
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('agent_name_hint'), 'DeepSeek Harness')
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:11111111-1111-4111-8111-111111111111')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge)
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3080/auth/callback')
  assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1')
  assert.equal(url.searchParams.get('state'), 'state-1')
  assert.equal(url.searchParams.get('nonce'), 'nonce-1')
  assert.equal(url.searchParams.get('id_token_hint'), null)
})

test('re-authorization URL reuses the issued client id and omits new-registration hints', () => {
  const oauth = client(async () => { throw new Error('no network') })
  const url = new URL(oauth.buildAuthorizeUrl({
    newAccount: false,
    clientId: 'client_issued_123',
    redirectUri: 'http://127.0.0.1:3080/auth/callback',
    state: 'state-2',
    nonce: 'nonce-2',
    challenge: 'challenge-2',
    agentNameHint: 'must-not-be-sent',
    idTokenHint: 'header.payload.signature',
    loginHint: 'user+tag@example.com',
  }))
  assert.equal(url.searchParams.get('client_id'), 'client_issued_123')
  assert.equal(url.searchParams.get('agent_name_hint'), null)
  assert.equal(url.searchParams.get('ext_agent_host_id'), null)
  assert.equal(url.searchParams.get('id_token_hint'), 'header.payload.signature')
  assert.equal(url.searchParams.get('login_hint'), 'user+tag@example.com')
  assert.equal(url.searchParams.get('nonce'), 'nonce-2')
})

test('authorize URL rejects non-loopback redirects and missing issued client id', () => {
  const oauth = client(async () => { throw new Error('no network') })
  assert.throws(() => oauth.buildAuthorizeUrl({
    newAccount: true, clientId: 'dynamic_agent_client', hostId: 'urn:uuid:x', redirectUri: 'http://localhost:3080/auth/callback',
    state: 's', nonce: 'n', challenge: 'c', agentNameHint: 'x',
  }), /loopback/u)
  assert.throws(() => oauth.buildAuthorizeUrl({
    newAccount: false, clientId: '', redirectUri: 'http://127.0.0.1:3080/auth/callback',
    state: 's', nonce: 'n', challenge: 'c',
  }), /issued client id/u)
})

test('code exchange posts the official form fields and parses actual scopes', async () => {
  const calls = []
  const fetch = makeFetch([[ /oauth\/token$/u, async (options) => {
    calls.push(options)
    return jsonResponse({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      id_token: 'id-1',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    })
  }]])
  const oauth = client(fetch)
  const tokens = await oauth.exchangeCode({
    code: 'code-1', codeVerifier: 'verifier-1', redirectUri: 'http://127.0.0.1:3080/auth/callback', clientId: 'issued-1',
  })
  assert.equal(tokens.accessToken, 'access-1')
  assert.equal(tokens.refreshToken, 'refresh-1')
  assert.equal(tokens.idToken, 'id-1')
  assert.equal(tokens.scopes.includes('chatgpt.tokens.use.direct'), true)
  const body = new URLSearchParams(calls[0].body)
  assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('client_id'), 'issued-1')
  assert.equal(body.get('code'), 'code-1')
  assert.equal(body.get('code_verifier'), 'verifier-1')
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:3080/auth/callback')
  assert.equal(body.get('resource'), 'https://api.openai.com/v1')
})

test('refresh posts the saved issued client id, no scope, and can preserve an absent id token', async () => {
  const calls = []
  const fetch = makeFetch([[ /oauth\/token$/u, async (options) => {
    calls.push(options)
    return jsonResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 60, scope: 'openid email' })
  }]])
  const oauth = client(fetch)
  const tokens = await oauth.refresh({ clientId: 'issued-1', refreshToken: 'refresh-1' })
  assert.equal(tokens.accessToken, 'access-2')
  assert.equal(tokens.idToken, undefined)
  const body = new URLSearchParams(calls[0].body)
  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('client_id'), 'issued-1')
  assert.equal(body.get('refresh_token'), 'refresh-1')
  assert.equal(body.has('scope'), false)
})

test('OAuth error classification keeps provider codes and retryability', async () => {
  const fetch = makeFetch([[ /oauth\/token$/u, async () => jsonResponse({ error: 'invalid_grant' }, { status: 400 }) ]])
  const oauth = client(fetch)
  await assert.rejects(
    () => oauth.refresh({ clientId: 'c', refreshToken: 'r' }),
    (error) => error.providerCode === 'invalid_grant' && error.retryable === false,
  )
})
