import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccountStore } from '../lib/accounts.js'
import { ModelCatalog } from '../lib/catalog.js'
import { makeClock, makeFetch, jsonResponse, MemoryCredentials } from './helpers.mjs'

function setup({ allowUnknownModels = false, models = [], fetchStatus = 200 } = {}) {
  const clock = makeClock()
  const credentials = new MemoryCredentials()
  let refreshCalls = 0
  let revokeCalls = 0
  const oauth = {
    calls: { get refresh() { return refreshCalls }, get revoke() { return revokeCalls } },
    async refresh() {
      refreshCalls += 1
      return {
        accessToken: `access-${refreshCalls + 1}`,
        refreshToken: `refresh-${refreshCalls + 1}`,
        tokenType: 'Bearer',
        expiresAt: clock.now() + 60 * 60 * 1000,
        scopes: ['chatgpt.tokens.use.direct'],
      }
    },
    async revoke() {
      revokeCalls += 1
      return true
    },
  }
  const accounts = new AccountStore({ credentials, oauth, now: clock.now, config: {} })
  const account = {
    version: 1, kind: 'chatgpt-plan-account', id: 'acct-a', recordId: 'pending-a', label: 'a@example.com', email: 'a@example.com',
    issuer: 'https://auth.test', subject: 'sub', clientId: 'client', idToken: 'id', accessToken: 'access-0', refreshToken: 'refresh-0',
    tokenType: 'Bearer', expiresAt: clock.now() + 60 * 60 * 1000, scopes: ['chatgpt.tokens.use.direct'], planEnabled: true,
    reauthRequired: false, addedAt: clock.now(), lastRefreshAt: clock.now(), generation: 1,
  }
  credentials.seed(accounts.stateKey, {
    kind: 'grant',
    payload: { version: 1, hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', activeAccountId: 'acct-a', accounts: { 'acct-a': { id: 'acct-a', recordId: 'pending-a', label: 'a@example.com', email: 'a@example.com', planEnabled: true, reauthRequired: false, expiresAt: account.expiresAt, addedAt: account.addedAt } }, epoch: 0, updatedAt: clock.now() },
  })
  credentials.seed(`openai-chatgpt-plan/pending-a`, { kind: 'grant', payload: account })
  const fetch = makeFetch([[/\/models$/u, async () => jsonResponse({ models }, { status: fetchStatus })]])
  const catalog = new ModelCatalog({ accounts, config: { allowUnknownModels, catalogTtlMs: 300000, defaultContextWindow: 1000, defaultMaxTokens: 200 }, fetchImpl: fetch, now: clock.now, userAgent: 'test/1.0' })
  return { clock, credentials, accounts, account, fetch, catalog, oauth }
}

test('catalog keeps visible known models and hides unknown or non-list entries', async () => {
  const { catalog, account } = setup({
    models: [
      { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list' },
      { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 mini', visibility: 'list' },
      { slug: 'gpt-5', display_name: 'old' },
      { slug: 'gpt-6.1-sol', display_name: 'sol', visibility: 'hidden' },
    ],
  })
  const models = await catalog.getModels(account)
  assert.deepEqual(models.map((model) => model.id), ['gpt-5.4', 'gpt-5.4-mini'])
  assert.equal(models[0].contextWindow, 272000)
  assert.equal(models[0].reasoning, true)
})

test('allowUnknownModels exposes an unknown slug but denies unverified tools', async () => {
  const { catalog, account, fetch } = setup({ allowUnknownModels: true, models: [{ id: 'mystery-model', name: 'Mystery' }] })
  const models = await catalog.getModels(account)
  assert.equal(models.length, 1)
  assert.equal(models[0].known, false)
  assert.deepEqual(catalog.capabilitiesFor('mystery-model').additionalTools, false)
  assert.equal(fetch.calls.length, 1)
})

test('catalog uses the account token, caches for the TTL, and maps provider identity', async () => {
  const { catalog, account, fetch } = setup({ models: [{ slug: 'gpt-5.4', display_name: 'GPT-5.4' }] })
  const first = await catalog.getModels(account)
  const second = await catalog.getModels(account)
  assert.equal(first, second)
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].options.headers.authorization, 'Bearer access-0')
  assert.equal(fetch.calls[0].options.headers['user-agent'], 'test/1.0')
  const listed = await catalog.listModels('openai-chatgpt-plan')
  assert.deepEqual(listed, [{ provider: 'openai-chatgpt-plan', id: 'gpt-5.4', name: 'GPT-5.4', inputModalities: ['text'] }])
  const resolved = await catalog.resolveModel('openai-chatgpt-plan', 'gpt-5.4')
  assert.equal(resolved.context.contextWindow, 272000)
  assert.equal(resolved.reasoning.defaultEffort, 'medium')
})

test('a 401 refreshes once and retries; a second 401 marks re-auth and returns no stale catalog', async () => {
  const { catalog, account, accounts, oauth, fetch } = setup({ models: [{ slug: 'gpt-5.4' }], fetchStatus: 401 })
  await assert.rejects(() => catalog.getModels(account), (error) => error.code === 'AUTH')
  assert.equal(oauth.calls.refresh, 1)
  assert.equal(fetch.calls.length, 2)
  assert.equal((await accounts.readAccountById(account.id)).reauthRequired, true)
  assert.deepEqual(catalog.peek(account.id), [])
})

test('unknown model resolution is an explicit UNKNOWN_MODEL error', async () => {
  const { catalog, account } = setup({ models: [{ slug: 'gpt-5.4' }] })
  await assert.rejects(() => catalog.resolveModel('openai-chatgpt-plan', 'not-listed'), (error) => error.code === 'UNKNOWN_MODEL')
})
