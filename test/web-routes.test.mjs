import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWebRoutes } from '../lib/web-routes.js'
import { makeReq, makeRes, makeWebServer } from './helpers.mjs'

function harness(origin = 'http://127.0.0.1:3080') {
  const webServer = makeWebServer(origin)
  const calls = { start: 0, signOut: 0, select: 0, cancel: 0 }
  const coordinator = {
    lastError: undefined,
    pendingCount: () => 0,
    async start(body) {
      calls.start += 1
      if (body.accountId === 'missing') { const e = new Error('no account'); e.code = 'ACCOUNT_NOT_FOUND'; throw e }
      return { url: 'https://auth.openai.com/api/accounts/authorize?state=hidden', method: 'sign-in' }
    },
    async completeCallback(query) {
      if (query.state === 'known' && query.error === undefined) return { ok: true, status: 200, code: 'SIGNED_IN', message: 'Signed in. You can close this window.' }
      return { ok: false, status: 400, code: 'CALLBACK_STATE', message: 'This sign-in attempt is unknown or already finished.' }
    },
    async cancelAll() { calls.cancel += 1 },
  }
  const accounts = {
    async signOut(id) { calls.signOut += 1; if (id === 'missing') { const e = new Error('no account'); e.code = 'ACCOUNT_NOT_FOUND'; throw e } return { accountId: id, remoteRevoked: true } },
    async selectAccount(id) { calls.select += 1; if (id === 'missing') { const e = new Error('no account'); e.code = 'ACCOUNT_NOT_FOUND'; throw e } },
  }
  const runtime = { callbackAvailable: true, loginAvailable: true }
  let changed = 0
  const routes = createWebRoutes({
    webServer,
    coordinator,
    accounts,
    runtime,
    logger: { warn: () => {} },
    getStatus: async () => ({
      signedIn: true,
      activeAccountId: 'acct-a',
      accounts: [{ id: 'acct-a', label: 'a@example.com', email: 'a@example.com', planEnabled: true, reauthRequired: false, expiresAt: 123, accessToken: 'SECRET', refreshToken: 'SECRET', clientId: 'SECRET', subject: 'SECRET' }],
      providerRegistered: true,
      modelCount: 1,
      loginPending: false,
      lastError: { code: 'AUTH', message: 'Sign in again' },
      callbackAvailable: true,
    }),
    onAccountsChanged: async () => { changed += 1 },
  })
  routes.register()
  return { webServer, routes, calls, runtime, get changed() { return changed } }
}

function handler(h, path) {
  const route = h.webServer.routes.get(`exact:${path}`)
  assert.ok(route, `missing route ${path}`)
  return route.handler
}

test('status is whitelisted and never exposes token-shaped fields', async () => {
  const h = harness()
  const res = makeRes()
  await handler(h, '/chatgpt-plan/status')(makeReq({ url: '/chatgpt-plan/status' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = res.json()
  assert.equal(body.accounts[0].accessToken, undefined)
  assert.equal(body.accounts[0].refreshToken, undefined)
  assert.equal(body.accounts[0].clientId, undefined)
  assert.equal(body.accounts[0].subject, undefined)
  assert.equal(JSON.stringify(body).includes('SECRET'), false)
  assert.equal(body.loginPending, false)
})

test('start enforces same origin, JSON, and account validation', async () => {
  const h = harness()
  const start = handler(h, '/chatgpt-plan/start')
  let res = makeRes()
  await start(makeReq({ method: 'POST', url: '/chatgpt-plan/start', headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: {} }), res)
  assert.equal(res.statusCode, 403)
  res = makeRes()
  await start(makeReq({ method: 'POST', url: '/chatgpt-plan/start', headers: { origin: 'http://127.0.0.1:3080' }, body: {} }), res)
  assert.equal(res.statusCode, 415)
  res = makeRes()
  await start(makeReq({ method: 'POST', url: '/chatgpt-plan/start', headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }, body: { accountId: 'missing' } }), res)
  assert.equal(res.statusCode, 404)
  res = makeRes()
  await start(makeReq({ method: 'POST', url: '/chatgpt-plan/start', headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }, body: { newAccount: true } }), res)
  assert.equal(res.statusCode, 200)
  assert.match(res.json().url, /^https:\/\/auth\.openai\.com/u)
  assert.equal(h.calls.start, 2)
})

test('callback renders a safe page and rejects unknown state without reflecting the code', async () => {
  const h = harness()
  const callback = handler(h, '/auth/callback')
  let res = makeRes()
  await callback(makeReq({ url: '/auth/callback?state=known&code=SECRET_CODE&client_id=issued' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.includes('SECRET_CODE'), false)
  assert.equal(res.body.includes('Signed in.'), true)
  res = makeRes()
  await callback(makeReq({ url: '/auth/callback?state=unknown&code=SECRET_CODE' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.includes('SECRET_CODE'), false)
})

test('signout and select enforce origin, JSON, and known accounts', async () => {
  const h = harness()
  const signout = handler(h, '/chatgpt-plan/signout')
  let res = makeRes()
  await signout(makeReq({ method: 'POST', url: '/chatgpt-plan/signout', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: { accountId: 'acct-a' } }), res)
  assert.equal(res.statusCode, 403)
  res = makeRes()
  await signout(makeReq({ method: 'POST', url: '/chatgpt-plan/signout', headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }, body: { accountId: 'missing' } }), res)
  assert.equal(res.statusCode, 404)
  res = makeRes()
  await signout(makeReq({ method: 'POST', url: '/chatgpt-plan/signout', headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }, body: { accountId: 'acct-a' } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().remoteRevoked, true)
  assert.equal(h.changed, 1)

  const select = handler(h, '/chatgpt-plan/select')
  res = makeRes()
  await select(makeReq({ method: 'POST', url: '/chatgpt-plan/select', headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }, body: { accountId: 'acct-a' } }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(h.calls.select, 1)
})

test('a callback collision disables login instead of changing the official path', async () => {
  const h = harness()
  for (const key of [...h.webServer.routes.keys()]) h.webServer.routes.delete(key)
  h.webServer.register({ kind: 'exact', path: '/auth/callback', handler: () => {} })
  h.routes.register()
  assert.equal(h.routes.state.callbackAvailable, false)
  const res = makeRes()
  await h.routes.handlers.start(makeReq({ method: 'POST', url: '/chatgpt-plan/start', headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' }, body: { newAccount: true } }), res)
  assert.equal(res.statusCode, 503)
})

test('a non-loopback Web origin disables sign-in', async () => {
  const h = harness('https://example.com')
  assert.equal(h.routes.state.loginAvailable, false)
  assert.equal(h.routes.state.callbackAvailable, false)
  const res = makeRes()
  await h.routes.handlers.start(makeReq({ method: 'POST', url: '/chatgpt-plan/start', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: { newAccount: true } }), res)
  assert.equal(res.statusCode, 503)
})
