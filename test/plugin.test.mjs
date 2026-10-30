import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccountStore, accountKey, stateKey } from '../lib/accounts.js'
import { apply } from '../index.js'
import { makeClock, MemoryCredentials, makeWebServer } from './helpers.mjs'

function makeCtx(credentials, webServer) {
  const effects = []
  const events = new Map()
  const emitted = []
  let registered
  let disposed = 0
  const llm = {
    registerAdapter(providers, adapter) {
      assert.deepEqual(providers, ['openai-chatgpt-plan'])
      let active = true
      registered = { providers, adapter, active: () => active }
      const handle = () => {
        if (!active) return
        active = false
        disposed += 1
      }
      handle.replace = () => {}
      return handle
    },
    listProviders: () => [],
  }
  const child = {
    webServer,
    effect(callback) {
      const cleanup = callback()
      effects.push(cleanup)
      return cleanup
    },
    on(name, callback) {
      if (!events.has(name)) events.set(name, [])
      events.get(name).push(callback)
      return () => {}
    },
    get(name) {
      return name === 'authorization' ? undefined : undefined
    },
  }
  const ctx = {
    credentials,
    llm,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    get: (name) => (name === 'authorization' ? undefined : undefined),
    effect(callback) {
      const cleanup = callback()
      effects.push(cleanup)
      return cleanup
    },
    on(name, callback) {
      if (!events.has(name)) events.set(name, [])
      events.get(name).push(callback)
      return () => {}
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback(child)
    },
    emit(name) {
      emitted.push(name)
    },
  }
  return {
    ctx,
    effects,
    events,
    emitted,
    get registered() { return registered },
    get disposed() { return disposed },
  }
}

async function seedAccount(credentials, clock) {
  const oauth = { refresh: async () => { throw new Error('not used') }, revoke: async () => true }
  const accounts = new AccountStore({ credentials, oauth, now: clock.now, config: {} })
  const recordId = 'pending-test'
  const account = {
    version: 1, kind: 'chatgpt-plan-account', id: 'acct-test', recordId, label: 'a@example.com', email: 'a@example.com',
    issuer: 'https://auth.test', subject: 'sub', clientId: 'client', idToken: 'id', accessToken: 'access', refreshToken: 'refresh',
    tokenType: 'Bearer', expiresAt: clock.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'], planEnabled: true,
    reauthRequired: false, addedAt: clock.now(), lastRefreshAt: clock.now(), generation: 1,
  }
  credentials.seed(accountKey(recordId), { kind: 'grant', payload: account })
  credentials.seed(stateKey(), {
    kind: 'grant',
    payload: {
      version: 1,
      hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      activeAccountId: 'acct-test',
      accounts: { 'acct-test': { id: 'acct-test', recordId, label: 'a@example.com', email: 'a@example.com', planEnabled: true, reauthRequired: false, expiresAt: account.expiresAt, addedAt: account.addedAt } },
      epoch: 0,
      updatedAt: clock.now(),
    },
  })
  return accounts
}

test('plugin registers only after a usable account exists and releases on dispose', async () => {
  const clock = makeClock()
  const credentials = new MemoryCredentials()
  const webServer = makeWebServer()
  const h = makeCtx(credentials, webServer)
  apply(h.ctx, { enabled: true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(h.registered, undefined)
  assert.ok(webServer.routes.has('exact:/chatgpt-plan/status'))
  assert.ok(webServer.routes.has('exact:/auth/callback'))

  await seedAccount(credentials, clock)
  const handler = h.events.get('credentials/record-updated')?.[0]
  assert.ok(handler)
  handler(stateKey())
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(h.registered)
  assert.equal(h.registered.adapter.providerInfo('openai-chatgpt-plan').id, 'openai-chatgpt-plan')
  assert.equal(h.emitted.includes('llm/adapters-updated'), true)

  for (const cleanup of h.effects.reverse()) {
    if (typeof cleanup === 'function') cleanup()
  }
  assert.equal(h.disposed, 1)
})

test('disabled config performs no registrations', async () => {
  const credentials = new MemoryCredentials()
  const webServer = makeWebServer()
  const h = makeCtx(credentials, webServer)
  apply(h.ctx, { enabled: false })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(h.registered, undefined)
  assert.equal(webServer.routes.size, 0)
})
