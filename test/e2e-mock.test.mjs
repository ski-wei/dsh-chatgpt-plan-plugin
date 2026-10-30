import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { AccountStore } from '../lib/accounts.js'
import { ModelCatalog } from '../lib/catalog.js'
import { OAuthCoordinator } from '../lib/coordinator.js'
import { IdTokenVerifier } from '../lib/id-token.js'
import { OAuthClient } from '../lib/oauth.js'
import {
  FakeAuthorization,
  jsonResponse,
  makeClock,
  makeFetch,
  makeJwt,
  MemoryCredentials,
  publicJwk,
  sseResponse,
} from './helpers.mjs'

const DISCOVERY = 'https://auth.test/.well-known/openid-configuration'
const JWKS = 'https://auth.test/jwks'
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token'
const MODELS = 'https://api.openai.com/v1/models'
const RESPONSES = 'https://api.openai.com/v1/responses'

function harness() {
  const clock = makeClock()
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicJwk(publicKey, 'kid-1')
  const scenario = {
    clientId: 'issued-client-1',
    subject: 'subject-1',
    nonce: 'unset',
    idTokenNonce: undefined,
    scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
    access: 'access-1',
    refresh: 'refresh-1',
    version: 1,
  }
  let revokeCalls = 0
  let tokenCalls = 0
  const credentials = new MemoryCredentials()
  const fetch = makeFetch([
    [DISCOVERY, async () => jsonResponse({ issuer: 'https://auth.test', jwks_uri: JWKS, revocation_endpoint: 'https://auth.test/revoke' })],
    [JWKS, async () => jsonResponse({ keys: [jwk] })],
    [TOKEN, async (options) => {
      tokenCalls += 1
      const form = new URLSearchParams(options.body)
      assert.equal(form.get('resource'), 'https://api.openai.com/v1')
      if (form.get('grant_type') === 'refresh_token') {
        assert.equal(form.get('client_id'), scenario.clientId)
        return jsonResponse({
          access_token: `refreshed-${tokenCalls}`,
          refresh_token: `refreshed-refresh-${tokenCalls}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: scenario.scopes.join(' '),
        })
      }
      const now = Math.floor(clock.now() / 1000)
      const idToken = makeJwt(privateKey, {
        iss: 'https://auth.test',
        aud: scenario.clientId,
        sub: scenario.subject,
        exp: now + 600,
        iat: now - 5,
        nonce: scenario.idTokenNonce ?? scenario.nonce,
        email: scenario.subject === 'subject-1' ? 'a@example.com' : 'b@example.com',
      }, { kid: 'kid-1' })
      return jsonResponse({
        access_token: scenario.access,
        refresh_token: scenario.refresh,
        id_token: idToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: scenario.scopes.join(' '),
      })
    }],
    ['https://auth.test/revoke', async () => {
      revokeCalls += 1
      return new Response(null, { status: 200 })
    }],
    [MODELS, async () => jsonResponse({ models: [{ slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list' }] })],
    [RESPONSES, async () => sseResponse([
      { type: 'response.created', response: { id: 'resp-1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'hello' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [{ type: 'output_text', text: 'hello' }] } },
      { type: 'response.completed', response: { id: 'resp-1', status: 'completed', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ])],
  ])
  const verifier = new IdTokenVerifier({ fetchImpl: fetch, now: clock.now, discoveryUrl: DISCOVERY })
  const oauth = new OAuthClient({ fetchImpl: fetch, now: clock.now, verifier })
  const accounts = new AccountStore({ credentials, oauth, now: clock.now, config: {} })
  const catalog = new ModelCatalog({ accounts, config: {}, fetchImpl: fetch, now: clock.now, userAgent: 'test/1.0' })
  const authorization = new FakeAuthorization(credentials)
  const coordinator = new OAuthCoordinator({
    accounts,
    oauth,
    verifier,
    config: { agentNameHint: 'DeepSeek Harness' },
    transactionTtlMs: 40,
    getAuthorization: () => authorization,
    now: clock.now,
  })
  return {
    clock, scenario, credentials, fetch, verifier, oauth, accounts, catalog, authorization, coordinator,
    get tokenCalls() { return tokenCalls },
    get revokeCalls() { return revokeCalls },
  }
}

async function startNew(h) {
  const started = await h.coordinator.start({ newAccount: true }, { origin: 'http://127.0.0.1:3080' })
  const url = new URL(started.url)
  h.scenario.nonce = url.searchParams.get('nonce')
  h.scenario.idTokenNonce = undefined
  return { started, url, state: url.searchParams.get('state') }
}

async function startReauth(h, accountId) {
  const started = await h.coordinator.start({ accountId }, { origin: 'http://127.0.0.1:3080' })
  const url = new URL(started.url)
  h.scenario.nonce = url.searchParams.get('nonce')
  h.scenario.idTokenNonce = undefined
  return { started, url, state: url.searchParams.get('state') }
}

test('new registration stores an issued client grant and lists the account model', async () => {
  const h = harness()
  const { url, state } = await startNew(h)
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('agent_name_hint'), 'DeepSeek Harness')
  assert.equal(url.searchParams.get('ext_agent_host_id').startsWith('urn:uuid:'), true)
  const completed = await h.coordinator.completeCallback({ state, code: 'code-1', client_id: 'issued-client-1' })
  assert.equal(completed.ok, true, JSON.stringify(completed))
  const status = await h.accounts.status()
  assert.equal(status.signedIn, true)
  assert.equal(status.accounts.length, 1)
  assert.equal(status.accounts[0].email, 'a@example.com')
  const record = await h.accounts.readAccountById(status.activeAccountId)
  assert.equal(record.clientId, 'issued-client-1')
  assert.equal(record.subject, 'subject-1')
  assert.equal(record.planEnabled, true)
  assert.equal(record.refreshToken, 'refresh-1')
  const models = await h.catalog.listModels('openai-chatgpt-plan')
  assert.deepEqual(models.map((model) => model.id), ['gpt-5.4'])
  assert.equal(h.coordinator.pendingCount(), 0)
})

test('re-authorization reuses the issued client id, omits the registration hint, and keeps one record', async () => {
  const h = harness()
  const first = await startNew(h)
  await h.coordinator.completeCallback({ state: first.state, code: 'code-1', client_id: 'issued-client-1' })
  const accountId = (await h.accounts.status()).activeAccountId
  const before = await h.accounts.readAccountById(accountId)
  h.scenario.access = 'access-2'
  h.scenario.refresh = 'refresh-2'
  const again = await startReauth(h, accountId)
  assert.equal(again.url.searchParams.get('client_id'), 'issued-client-1')
  assert.equal(again.url.searchParams.get('agent_name_hint'), null)
  assert.equal(again.url.searchParams.get('ext_agent_host_id'), null)
  assert.equal(again.url.searchParams.get('id_token_hint'), before.idToken)
  const completed = await h.coordinator.completeCallback({ state: again.state, code: 'code-2' })
  assert.equal(completed.ok, true, JSON.stringify(completed))
  const after = await h.accounts.readAccountById(accountId)
  assert.equal(after.accessToken, 'access-2')
  assert.equal(after.generation, 2)
  assert.equal((await h.accounts.status()).accounts.length, 1)
})

test('a duplicate new login for the same issued relation does not overwrite or duplicate the account', async () => {
  const h = harness()
  const first = await startNew(h)
  await h.coordinator.completeCallback({ state: first.state, code: 'code-1', client_id: 'issued-client-1' })
  const accountId = (await h.accounts.status()).activeAccountId
  const before = await h.accounts.readAccountById(accountId)
  h.scenario.access = 'access-duplicate'
  h.scenario.refresh = 'refresh-duplicate'
  const second = await startNew(h)
  const completed = await h.coordinator.completeCallback({ state: second.state, code: 'code-2', client_id: 'issued-client-1' })
  assert.equal(completed.ok, false)
  assert.equal(completed.code, 'ACCOUNT_EXISTS')
  const after = await h.accounts.readAccountById(accountId)
  assert.equal(after.accessToken, before.accessToken)
  assert.equal((await h.accounts.status()).accounts.length, 1)
})

test('callback validation rejects a missing issued client id and leaves the previous account untouched', async () => {
  const h = harness()
  const first = await startNew(h)
  await h.coordinator.completeCallback({ state: first.state, code: 'code-1', client_id: 'issued-client-1' })
  const accountId = (await h.accounts.status()).activeAccountId
  const before = await h.accounts.readAccountById(accountId)
  const second = await startNew(h)
  const completed = await h.coordinator.completeCallback({ state: second.state, code: 'code-2' })
  assert.equal(completed.ok, false)
  assert.equal(completed.code, 'CALLBACK_CLIENT')
  const after = await h.accounts.readAccountById(accountId)
  assert.equal(after.accessToken, before.accessToken)
  assert.equal((await h.accounts.status()).accounts.length, 1)
})

test('a mismatched ID-token nonce or subject does not overwrite the account', async () => {
  const h = harness()
  const first = await startNew(h)
  await h.coordinator.completeCallback({ state: first.state, code: 'code-1', client_id: 'issued-client-1' })
  const accountId = (await h.accounts.status()).activeAccountId
  const before = await h.accounts.readAccountById(accountId)

  const nonceAttempt = await startNew(h)
  h.scenario.idTokenNonce = 'wrong-nonce'
  const nonceResult = await h.coordinator.completeCallback({ state: nonceAttempt.state, code: 'code-2', client_id: 'issued-client-1' })
  assert.equal(nonceResult.ok, false)
  assert.equal(nonceResult.code, 'ID_TOKEN_NONCE')
  assert.equal((await h.accounts.readAccountById(accountId)).accessToken, before.accessToken)

  const subjectAttempt = await startReauth(h, accountId)
  h.scenario.subject = 'other-subject'
  const subjectResult = await h.coordinator.completeCallback({ state: subjectAttempt.state, code: 'code-3' })
  assert.equal(subjectResult.ok, false)
  assert.equal(subjectResult.code, 'ID_TOKEN_SUBJECT_MISMATCH')
  assert.equal((await h.accounts.readAccountById(accountId)).subject, 'subject-1')
  h.scenario.subject = 'subject-1'
})

test('two accounts remain isolated across switch and sign-out', async () => {
  const h = harness()
  const a = await startNew(h)
  await h.coordinator.completeCallback({ state: a.state, code: 'code-a', client_id: 'issued-client-1' })
  const idA = (await h.accounts.status()).activeAccountId

  h.scenario.clientId = 'issued-client-2'
  h.scenario.subject = 'subject-2'
  h.scenario.access = 'access-b'
  h.scenario.refresh = 'refresh-b'
  const b = await startNew(h)
  await h.coordinator.completeCallback({ state: b.state, code: 'code-b', client_id: 'issued-client-2' })
  let status = await h.accounts.status()
  assert.equal(status.accounts.length, 2)
  const idB = status.accounts.find((account) => account.id !== idA).id
  assert.equal(status.activeAccountId, idB)

  await h.accounts.selectAccount(idA)
  status = await h.accounts.status()
  assert.equal(status.activeAccountId, idA)
  assert.equal((await h.accounts.readAccountById(idB)).accessToken, 'access-b')

  const signedOut = await h.accounts.signOut(idB)
  assert.equal(signedOut.remoteRevoked, true)
  assert.equal(h.revokeCalls, 1)
  status = await h.accounts.status()
  assert.equal(status.accounts.length, 1)
  assert.equal(status.activeAccountId, idA)
})

test('sign-out during re-authorization prevents the late login from resurrecting the account', async () => {
  const h = harness()
  const first = await startNew(h)
  await h.coordinator.completeCallback({ state: first.state, code: 'code-1', client_id: 'issued-client-1' })
  const accountId = (await h.accounts.status()).activeAccountId
  const reauth = await startReauth(h, accountId)
  await h.accounts.signOut(accountId)
  const completed = await h.coordinator.completeCallback({ state: reauth.state, code: 'code-2' })
  assert.equal(completed.ok, false)
  assert.equal(completed.code, 'ACCOUNT_CHANGED')
  assert.equal(await h.accounts.readAccountById(accountId), undefined)
  assert.equal((await h.accounts.status()).accounts.length, 0)
})

test('an unanswered attempt times out, clears pending, and cannot be completed later', async () => {
  const h = harness()
  const { state } = await startNew(h)
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(h.coordinator.pendingCount(), 0)
  assert.equal(h.coordinator.lastError?.code, 'OAUTH_TIMEOUT')
  const late = await h.coordinator.completeCallback({ state, code: 'code-late', client_id: 'issued-client-1' })
  assert.equal(late.status, 400)
  assert.equal((await h.accounts.status()).signedIn, false)
})

test('an explicit cancel settles the attempt and rejects a late callback', async () => {
  const h = harness()
  const { state } = await startNew(h)
  await h.coordinator.cancelAll('cancelled')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(h.coordinator.pendingCount(), 0)
  assert.equal(h.coordinator.lastError?.code, 'OAUTH_DENIED')
  const late = await h.coordinator.completeCallback({ state, code: 'code-late', client_id: 'issued-client-1' })
  assert.equal(late.status, 400)
  assert.equal((await h.accounts.status()).signedIn, false)
})

test('unknown callback state and a denied callback settle without committing', async () => {
  const h = harness()
  const missing = await h.coordinator.completeCallback({ state: 'unknown', code: 'x' })
  assert.equal(missing.status, 400)
  assert.equal(missing.code, 'CALLBACK_STATE')

  const attempt = await startNew(h)
  const denied = await h.coordinator.completeCallback({ state: attempt.state, error: 'access_denied' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'OAUTH_DENIED')
  assert.equal((await h.accounts.status()).signedIn, false)
  assert.equal(h.coordinator.pendingCount(), 0)
})
