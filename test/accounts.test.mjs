import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccountStore, accountKey, stateKey } from '../lib/accounts.js'
import { OAuthError } from '../lib/errors.js'
import { makeClock, MemoryCredentials } from './helpers.mjs'
import { delay } from '../lib/util.js'

function makeOAuth(clock, overrides = {}) {
  const calls = { refresh: 0, revoke: 0 }
  return {
    calls,
    async refresh(input) {
      calls.refresh += 1
      if (overrides.refresh) return overrides.refresh(input, calls.refresh)
      await delay(5)
      return {
        accessToken: `access-${calls.refresh}`,
        refreshToken: `refresh-${calls.refresh}`,
        idToken: undefined,
        tokenType: 'Bearer',
        expiresAt: clock.now() + 60 * 60 * 1000,
        scopes: ['openid', 'chatgpt.tokens.use.direct'],
      }
    },
    async revoke(input) {
      calls.revoke += 1
      if (overrides.revoke) return overrides.revoke(input, calls.revoke)
      return true
    },
  }
}

function makeStore(clock, oauth, credentials = new MemoryCredentials()) {
  return new AccountStore({ credentials, oauth, now: clock.now, config: {} })
}

async function addAccount(accounts, credentials, input = {}) {
  const now = input.now ?? Date.now()
  const recordId = input.recordId ?? accounts.newRecordId()
  const id = input.id ?? `acct-${recordId.slice(-8)}`
  const email = input.email ?? 'user@example.com'
  const account = await accounts.buildAccountPayload({
    id,
    recordId,
    label: email,
    email,
    issuer: 'https://auth.test',
    subject: input.subject ?? `subject-${id}`,
    clientId: input.clientId ?? 'client-issued-1',
    idToken: 'id-token',
    tokens: {
      accessToken: input.accessToken ?? 'access-0',
      refreshToken: input.refreshToken ?? 'refresh-0',
      tokenType: 'Bearer',
      expiresAt: input.expiresAt ?? now + 60 * 60 * 1000,
    },
    scopes: input.scopes ?? ['openid', 'chatgpt.tokens.use.direct'],
    planEnabled: input.planEnabled ?? true,
    addedAt: now,
    generation: 1,
  })
  await credentials.modifyRecord(accounts.accountKey(recordId), async () => ({ kind: 'grant', payload: account }))
  await accounts.preparePendingAccount(account)
  await accounts.commitAccount(account, { makeActive: input.makeActive ?? true })
  return account
}

test('host id is a stable UUIDv4 persisted in the owner grant', async () => {
  const clock = makeClock()
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, makeOAuth(clock), credentials)
  const first = await accounts.ensureHostId()
  const second = await accounts.ensureHostId()
  assert.match(first, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert.equal(second, first)
  const state = await accounts.readState()
  assert.equal(state.hostId, first)
  assert.equal(credentials.store.records.size, 1)
})

test('account id is stable for one issued relation and changes with the client id', () => {
  const clock = makeClock()
  const accounts = makeStore(clock, makeOAuth(clock))
  const one = accounts.accountIdFor('https://auth.test', 'sub', 'client-a')
  const two = accounts.accountIdFor('https://auth.test', 'sub', 'client-a')
  const three = accounts.accountIdFor('https://auth.test', 'sub', 'client-b')
  assert.equal(one, two)
  assert.notEqual(one, three)
  assert.match(one, /^acct-[0-9a-f]{24}$/u)
})

test('multiple accounts stay isolated and switching active does not rewrite tokens', async () => {
  const clock = makeClock()
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, makeOAuth(clock), credentials)
  const a = await addAccount(accounts, credentials, { id: 'acct-a', email: 'a@example.com', clientId: 'client-a', subject: 'sub-a' })
  const b = await addAccount(accounts, credentials, { id: 'acct-b', email: 'b@example.com', clientId: 'client-b', subject: 'sub-b' })
  let state = await accounts.readState()
  assert.equal(state.activeAccountId, 'acct-b')
  await accounts.selectAccount('acct-a')
  state = await accounts.readState()
  assert.equal(state.activeAccountId, 'acct-a')
  assert.equal((await accounts.readAccountById('acct-a')).accessToken, a.accessToken)
  assert.equal((await accounts.readAccountById('acct-b')).accessToken, b.accessToken)
})

test('ten concurrent refreshes for one expired account call the network once', async () => {
  const clock = makeClock()
  const oauth = makeOAuth(clock)
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, oauth, credentials)
  const account = await addAccount(accounts, credentials, { expiresAt: clock.now() - 1000 })
  const results = await Promise.all(Array.from({ length: 10 }, () => accounts.refreshAccount(account.id, { force: true })))
  assert.equal(oauth.calls.refresh, 1)
  assert.equal(results[0].accessToken, 'access-1')
  const stored = await accounts.readAccountById(account.id)
  assert.equal(stored.refreshToken, 'refresh-1')
  assert.equal(stored.generation, 2)
})

test('two stores sharing a credential file rotate a refresh token only once', async () => {
  const clock = makeClock()
  const oauth = makeOAuth(clock)
  const credentials = new MemoryCredentials()
  const accountsA = makeStore(clock, oauth, credentials)
  const accountsB = makeStore(clock, oauth, new MemoryCredentials(credentials.store))
  const account = await addAccount(accountsA, credentials, { expiresAt: clock.now() - 1000 })
  const [a, b] = await Promise.all([
    accountsA.refreshAccount(account.id, { force: true }),
    accountsB.refreshAccount(account.id, { force: true }),
  ])
  assert.equal(oauth.calls.refresh, 1)
  assert.equal(a.accessToken, 'access-1')
  assert.equal(b.accessToken, 'access-1')
})

test('invalid_grant marks only the target account for re-auth and clears its tokens', async () => {
  const clock = makeClock()
  const oauth = makeOAuth(clock, {
    refresh: async () => {
      throw new OAuthError('refresh rejected', 'OAUTH_HTTP', { status: 400, providerCode: 'invalid_grant' })
    },
  })
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, oauth, credentials)
  const a = await addAccount(accounts, credentials, { id: 'acct-a', clientId: 'client-a', subject: 'sub-a', expiresAt: clock.now() - 1000 })
  const b = await addAccount(accounts, credentials, { id: 'acct-b', clientId: 'client-b', subject: 'sub-b', expiresAt: clock.now() - 1000 })
  await assert.rejects(() => accounts.refreshAccount(a.id, { force: true }), (error) => error.code === 'REAUTH_REQUIRED')
  const storedA = await accounts.readAccountById(a.id)
  const storedB = await accounts.readAccountById(b.id)
  assert.equal(storedA.reauthRequired, true)
  assert.equal(storedA.accessToken, undefined)
  assert.equal(storedA.refreshToken, undefined)
  assert.equal(storedB.reauthRequired, false)
  assert.equal(storedB.accessToken, b.accessToken)
})

test('a retryable refresh failure keeps the existing tokens for a later attempt', async () => {
  const clock = makeClock()
  const oauth = makeOAuth(clock, {
    refresh: async () => {
      throw new OAuthError('server down', 'OAUTH_SERVER', { status: 503, retryable: true })
    },
  })
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, oauth, credentials)
  const a = await addAccount(accounts, credentials, { expiresAt: clock.now() - 1000 })
  await assert.rejects(() => accounts.refreshAccount(a.id, { force: true }), (error) => error.retryable === true && error.code === 'SERVER')
  const stored = await accounts.readAccountById(a.id)
  assert.equal(stored.accessToken, 'access-0')
  assert.equal(stored.refreshToken, 'refresh-0')
  assert.equal(stored.reauthRequired, false)
})

test('sign-out revokes the captured token, deletes the grant, and a stale refresh cannot resurrect it', async () => {
  const clock = makeClock()
  let releaseRefresh
  const gate = new Promise((resolve) => { releaseRefresh = resolve })
  const oauth = makeOAuth(clock, {
    refresh: async (input, count) => {
      await gate
      return {
        accessToken: `rotated-${count}`,
        refreshToken: `rotated-refresh-${count}`,
        tokenType: 'Bearer',
        expiresAt: clock.now() + 60 * 60 * 1000,
        scopes: ['openid', 'chatgpt.tokens.use.direct'],
      }
    },
  })
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, oauth, credentials)
  const account = await addAccount(accounts, credentials, { expiresAt: clock.now() - 1000 })
  const refreshing = accounts.refreshAccount(account.id, { force: true })
  await delay(5)
  const signedOut = accounts.signOut(account.id)
  releaseRefresh()
  await refreshing.catch(() => {})
  const result = await signedOut
  assert.equal(result.remoteRevoked, true)
  assert.equal(oauth.calls.revoke, 1)
  assert.equal(await accounts.readAccountById(account.id), undefined)
  const state = await accounts.readState()
  assert.equal(state.accounts[account.id], undefined)
  assert.equal(await credentials.readRecord(accountKey(account.recordId)), undefined)
  await assert.rejects(() => accounts.refreshAccount(account.id, { force: true }), (error) => error.code === 'ACCOUNT_NOT_FOUND')
})

test('a tombstone keeps a stale account record from reappearing in status', async () => {
  const clock = makeClock()
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, makeOAuth(clock), credentials)
  const account = await addAccount(accounts, credentials)
  await accounts.signOut(account.id)
  credentials.seed(accountKey(account.recordId), { kind: 'grant', payload: account })
  const status = await accounts.status()
  assert.equal(status.signedIn, false)
  assert.equal(status.accounts.length, 0)
  const state = await accounts.readState()
  assert.equal(state.accounts[account.id], undefined)
  assert.equal(typeof state.tombstones[account.id], 'number')
})

test('sign-out deletes local state even when remote revocation fails', async () => {
  const clock = makeClock()
  const oauth = makeOAuth(clock, { revoke: async () => { throw new Error('network down') } })
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, oauth, credentials)
  const account = await addAccount(accounts, credentials)
  const result = await accounts.signOut(account.id)
  assert.equal(result.remoteRevoked, false)
  assert.equal(await accounts.readAccountById(account.id), undefined)
})

test('corrupt state is reported and never overwritten', async () => {
  const clock = makeClock()
  const credentials = new MemoryCredentials()
  credentials.seed(stateKey(), { kind: 'grant', payload: { version: 99 } })
  const before = JSON.stringify(credentials.store.records.get(stateKey()))
  const accounts = makeStore(clock, makeOAuth(clock), credentials)
  await assert.rejects(() => accounts.readState(), (error) => error.code === 'STATE_CORRUPT')
  await assert.rejects(() => accounts.ensureHostId(), (error) => error.code === 'STATE_CORRUPT')
  assert.equal(JSON.stringify(credentials.store.records.get(stateKey())), before)
})

test('status is redacted and hides pending entries', async () => {
  const clock = makeClock()
  const credentials = new MemoryCredentials()
  const accounts = makeStore(clock, makeOAuth(clock), credentials)
  const account = await addAccount(accounts, credentials, { id: 'acct-status' })
  await accounts.preparePendingAccount({ ...account, id: 'acct-pending', recordId: 'pending-abc', label: 'pending' })
  const status = await accounts.status()
  assert.equal(status.signedIn, true)
  assert.equal(status.activeAccountId, 'acct-status')
  assert.equal(status.accounts.some((entry) => entry.id === 'acct-pending'), false)
  const serialized = JSON.stringify(status)
  for (const secret of ['access-0', 'refresh-0', 'id-token', 'client-issued-1', 'subject-acct-status']) {
    assert.equal(serialized.includes(secret), false)
  }
})
