import { credentialKey, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import {
  ACCESS_REFRESH_SKEW_MS,
  CREDENTIAL_SCOPE,
  PLAN_SCOPE,
  REAUTH_REFRESH_CODES,
  REFRESH_TIMEOUT_MS,
  REVOKE_TIMEOUT_MS,
  STATE_RECORD_ID,
} from './constants.js'
import { ChatGptPlanError, OAuthError, authError } from './errors.js'
import { createHostId, isHostId } from './host-id.js'
import { jsonSafe, randomHex, sha256Hex } from './util.js'

const STATE_VERSION = 1
const ACCOUNT_VERSION = 1
const ACCOUNT_KIND = 'chatgpt-plan-account'

function stateKey() {
  return credentialKey(CREDENTIAL_SCOPE, STATE_RECORD_ID)
}

function accountKey(recordId) {
  return credentialKey(CREDENTIAL_SCOPE, recordId)
}

function emptyState() {
  return {
    version: STATE_VERSION,
    hostId: undefined,
    activeAccountId: undefined,
    accounts: {},
    tombstones: {},
    epoch: 0,
    updatedAt: 0,
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseStateRecord(record) {
  if (record === undefined) return emptyState()
  if (!isPlainRecord(record) || record.kind !== 'grant' || !isPlainRecord(record.payload)) {
    throw new ChatGptPlanError('Stored ChatGPT-plan state is not a grant record', 'STATE_CORRUPT')
  }
  const payload = record.payload
  if (payload.version !== STATE_VERSION) {
    throw new ChatGptPlanError('Stored ChatGPT-plan state has an unsupported version', 'STATE_CORRUPT')
  }
  if (payload.hostId !== undefined && !isHostId(payload.hostId)) {
    throw new ChatGptPlanError('Stored ChatGPT-plan host id is invalid', 'STATE_CORRUPT')
  }
  if (!isPlainRecord(payload.accounts)) {
    throw new ChatGptPlanError('Stored ChatGPT-plan account index is invalid', 'STATE_CORRUPT')
  }
  if (payload.tombstones !== undefined && !isPlainRecord(payload.tombstones)) {
    throw new ChatGptPlanError('Stored ChatGPT-plan tombstone index is invalid', 'STATE_CORRUPT')
  }
  for (const [id, entry] of Object.entries(payload.accounts)) {
    if (!isPlainRecord(entry) || entry.id !== id || typeof entry.recordId !== 'string') {
      throw new ChatGptPlanError('Stored ChatGPT-plan account index has an invalid entry', 'STATE_CORRUPT')
    }
  }
  return {
    version: STATE_VERSION,
    hostId: payload.hostId,
    activeAccountId: typeof payload.activeAccountId === 'string' ? payload.activeAccountId : undefined,
    accounts: { ...payload.accounts },
    tombstones: { ...(payload.tombstones ?? {}) },
    epoch: Number.isSafeInteger(payload.epoch) ? payload.epoch : 0,
    updatedAt: Number.isSafeInteger(payload.updatedAt) ? payload.updatedAt : 0,
  }
}

function parseAccountRecord(record) {
  if (record === undefined) return undefined
  if (!isPlainRecord(record) || record.kind !== 'grant' || !isPlainRecord(record.payload)) {
    throw new ChatGptPlanError('Stored ChatGPT-plan account is not a grant record', 'ACCOUNT_CORRUPT')
  }
  const payload = record.payload
  if (payload.version !== ACCOUNT_VERSION || payload.kind !== ACCOUNT_KIND) {
    throw new ChatGptPlanError('Stored ChatGPT-plan account has an unsupported version', 'ACCOUNT_CORRUPT')
  }
  if (typeof payload.id !== 'string' || typeof payload.recordId !== 'string') {
    throw new ChatGptPlanError('Stored ChatGPT-plan account identity is invalid', 'ACCOUNT_CORRUPT')
  }
  return payload
}

function indexEntryOf(account) {
  return {
    id: account.id,
    recordId: account.recordId,
    label: account.label,
    email: account.email,
    planEnabled: account.planEnabled === true,
    reauthRequired: account.reauthRequired === true,
    expiresAt: account.expiresAt,
    addedAt: account.addedAt,
    ...(account.pending === true ? { pending: true } : {}),
  }
}

function entryMatches(entry, account) {
  if (entry === undefined) return false
  return (
    entry.recordId === account.recordId &&
    entry.label === account.label &&
    entry.email === account.email &&
    entry.planEnabled === (account.planEnabled === true) &&
    entry.reauthRequired === (account.reauthRequired === true) &&
    entry.expiresAt === account.expiresAt &&
    entry.addedAt === account.addedAt &&
    (entry.pending === true) === (account.pending === true)
  )
}

function accountIsUsable(account, now, skewMs) {
  return (
    account !== undefined &&
    account.planEnabled === true &&
    account.reauthRequired !== true &&
    typeof account.accessToken === 'string' &&
    account.accessToken.length > 0 &&
    typeof account.expiresAt === 'number' &&
    account.expiresAt - now > skewMs
  )
}

/**
 * Account and grant storage on the public Credentials seam.
 *
 * Each account lives in its own grant record. That is what makes a login
 * commit atomic and per-account: a re-authorization overwrites exactly one
 * account, never another account's tokens. The state record is only an index
 * and is always changed through `modifyRecord`, so sign-out and account
 * switching cannot lose a rotated token.
 */
export class AccountStore {
  #credentials
  #oauth
  #now
  #config
  #refreshes = new Map()
  #hostIdCache

  constructor(options) {
    if (!options?.credentials) throw new TypeError('AccountStore needs credentials')
    if (!options?.oauth) throw new TypeError('AccountStore needs an OAuthClient')
    this.#credentials = options.credentials
    this.#oauth = options.oauth
    this.#now = options.now ?? Date.now
    this.#config = options.config ?? {}
  }

  get stateKey() {
    return stateKey()
  }

  get accountKey() {
    return accountKey
  }

  /** Read the index, returning an empty state only when no record exists yet. */
  async readState() {
    return parseStateRecord(await this.#credentials.readRecord(stateKey()))
  }

  async #writeState(mutate) {
    let nextState
    await this.#credentials.modifyRecord(stateKey(), async (current) => {
      const state = parseStateRecord(current)
      const next = await mutate(state)
      if (next === undefined) return undefined
      nextState = {
        version: STATE_VERSION,
        ...(next.hostId === undefined ? {} : { hostId: next.hostId }),
        ...(next.activeAccountId === undefined ? {} : { activeAccountId: next.activeAccountId }),
        accounts: next.accounts ?? {},
        tombstones: next.tombstones ?? {},
        epoch: next.epoch ?? 0,
        updatedAt: this.#now(),
      }
      return { kind: 'grant', payload: jsonSafe(nextState) }
    })
    return nextState
  }

  /** Persist the stable host id before the first registration. */
  async ensureHostId() {
    if (this.#hostIdCache !== undefined) return this.#hostIdCache
    let hostId
    const state = await this.readState()
    if (state.hostId !== undefined) {
      this.#hostIdCache = state.hostId
      return state.hostId
    }
    await this.#writeState((current) => {
      if (current.hostId === undefined) current.hostId = createHostId()
      hostId = current.hostId
      return current
    })
    this.#hostIdCache = hostId
    return hostId
  }

  /** Stable account id for one (issuer, subject, issued client id) relation. */
  accountIdFor(issuer, subject, clientId) {
    return `acct-${sha256Hex(`${issuer}\u0000${subject}\u0000${clientId}`).slice(0, 24)}`
  }

  newRecordId() {
    return `pending-${randomHex(8)}`
  }

  async readAccount(recordId) {
    return parseAccountRecord(await this.#credentials.readRecord(accountKey(recordId)))
  }

  async readAccountById(accountId) {
    const state = await this.readState()
    const entry = state.accounts[accountId]
    if (entry === undefined) return undefined
    return this.readAccount(entry.recordId)
  }

  async listAccountRecords() {
    const records = await this.#credentials.listRecords()
    const accounts = []
    for (const record of records) {
      if (credentialKeyScope(record.key) !== CREDENTIAL_SCOPE) continue
      let account
      try {
        account = parseAccountRecord(await this.#credentials.readRecord(record.key))
      } catch {
        continue
      }
      if (account !== undefined) accounts.push(account)
    }
    return accounts
  }

  async buildAccountPayload(input) {
    const now = this.#now()
    return jsonSafe({
      version: ACCOUNT_VERSION,
      kind: ACCOUNT_KIND,
      id: input.id,
      recordId: input.recordId,
      label: input.label,
      email: input.email,
      issuer: input.issuer,
      subject: input.subject,
      clientId: input.clientId,
      idToken: input.idToken,
      accessToken: input.tokens.accessToken,
      ...(input.tokens.refreshToken === undefined ? {} : { refreshToken: input.tokens.refreshToken }),
      tokenType: input.tokens.tokenType ?? 'Bearer',
      expiresAt: input.tokens.expiresAt,
      ...(input.tokens.earliestRefreshAt === undefined ? {} : { earliestRefreshAt: input.tokens.earliestRefreshAt }),
      scopes: [...input.scopes],
      planEnabled: input.planEnabled === true,
      reauthRequired: input.reauthRequired === true,
      addedAt: input.addedAt ?? now,
      lastRefreshAt: input.lastRefreshAt ?? now,
      generation: input.generation ?? 1,
      ...(input.sid === undefined ? {} : { sid: input.sid }),
    })
  }

  /**
   * Publish the account only after the flow's atomic grant commit, or publish a
   * pending index entry before it. The pending entry is hidden from status and
   * is removed on failure.
   */
  async preparePendingAccount(account) {
    await this.#writeState((state) => {
      const entry = { ...indexEntryOf({ ...account, pending: true }), pending: true }
      state.accounts[account.id] = entry
      delete state.tombstones[account.id]
      return state
    })
  }

  async commitAccount(account, options = {}) {
    await this.#writeState((state) => {
      const previous = state.accounts[account.id]
      state.accounts[account.id] = indexEntryOf(account)
      delete state.tombstones[account.id]
      if (
        options.makeActive === true ||
        state.activeAccountId === undefined ||
        previous === undefined ||
        state.accounts[state.activeAccountId] === undefined
      ) {
        state.activeAccountId = account.id
      }
      return state
    })
  }

  async removePendingAccount(accountId) {
    const state = await this.readState()
    const entry = state.accounts[accountId]
    if (entry === undefined) return
    const next = await this.#writeState((current) => {
      const candidate = current.accounts[accountId]
      if (candidate === undefined || candidate.pending !== true) return undefined
      delete current.accounts[accountId]
      if (current.activeAccountId === accountId) current.activeAccountId = undefined
      return current
    })
    if (next === undefined) return
    try {
      await this.#credentials.deleteRecord(accountKey(entry.recordId))
    } catch {
      // The index entry is gone; an orphan record is inert and readable next start.
    }
  }

  async updateIndex(account) {
    if (account === undefined) return
    await this.#writeState((state) => {
      const current = state.accounts[account.id]
      // Never resurrect an account removed by sign-out from a stale refresh.
      if (current === undefined) return undefined
      delete state.tombstones[account.id]
      if (entryMatches(current, account)) return undefined
      state.accounts[account.id] = indexEntryOf(account)
      return state
    })
  }

  async getActiveAccount() {
    const state = await this.readState()
    let accountId = state.activeAccountId
    if (accountId === undefined || state.accounts[accountId] === undefined) {
      accountId = Object.keys(state.accounts).find((id) => state.accounts[id]?.pending !== true)
    }
    if (accountId === undefined) return undefined
    const entry = state.accounts[accountId]
    if (entry === undefined) return undefined
    return this.readAccount(entry.recordId)
  }

  async selectAccount(accountId) {
    const state = await this.readState()
    if (state.accounts[accountId] === undefined) {
      throw authError('No such ChatGPT-plan account', 'ACCOUNT_NOT_FOUND')
    }
    await this.#writeState((current) => {
      if (current.accounts[accountId] === undefined) {
        throw authError('No such ChatGPT-plan account', 'ACCOUNT_NOT_FOUND')
      }
      current.activeAccountId = accountId
      return current
    })
    return this.getActiveAccount()
  }

  async markReauth(accountId, reason) {
    const state = await this.readState()
    const entry = state.accounts[accountId]
    if (entry === undefined) return
    let updated
    await this.#credentials.modifyRecord(accountKey(entry.recordId), async (current) => {
      const account = parseAccountRecord(current)
      if (account === undefined || account.id !== accountId) return undefined
      updated = {
        ...account,
        reauthRequired: true,
        generation: account.generation + 1,
        lastError: reason,
      }
      return { kind: 'grant', payload: jsonSafe(updated) }
    })
    if (updated !== undefined) await this.updateIndex(updated)
  }

  /**
   * Refresh under the record's cross-process write lock. A network call inside
   * `modifyRecord` is deliberate: it is the only way the second process sees
   * the rotated token and declines to rotate again.
   */
  async refreshAccount(accountId, options = {}) {
    const force = options.force === true
    const existing = this.#refreshes.get(accountId)
    if (existing !== undefined) {
      try {
        await existing
      } catch {
        // The caller below re-checks the current grant.
      }
      if (!force) return this.readAccountById(accountId)
      const current = await this.readAccountById(accountId)
      if (accountIsUsable(current, this.#now(), ACCESS_REFRESH_SKEW_MS)) return current
    }
    const promise = this.#refreshInsideLock(accountId, force)
    this.#refreshes.set(accountId, promise)
    promise.finally(() => {
      if (this.#refreshes.get(accountId) === promise) this.#refreshes.delete(accountId)
    }).catch(() => {})
    return promise
  }

  async #refreshInsideLock(accountId, force) {
    const initial = await this.readAccountById(accountId)
    if (initial === undefined) throw authError('No such ChatGPT-plan account', 'ACCOUNT_NOT_FOUND')
    if (initial.reauthRequired === true) {
      throw authError('This ChatGPT-plan account must sign in again', 'REAUTH_REQUIRED')
    }
    if (initial.planEnabled !== true) {
      throw authError('This account does not have the ChatGPT-plan scope', 'PLAN_DISABLED')
    }
    if (!force && accountIsUsable(initial, this.#now(), ACCESS_REFRESH_SKEW_MS)) return initial
    if (typeof initial.refreshToken !== 'string' || initial.refreshToken.length === 0) {
      await this.markReauth(accountId, 'missing_refresh_token')
      throw authError('This ChatGPT-plan account has no refresh token', 'REAUTH_REQUIRED')
    }

    const expectedGeneration = initial.generation
    let outcome
    await this.#credentials.modifyRecord(accountKey(initial.recordId), async (current) => {
      const account = parseAccountRecord(current)
      if (account === undefined || account.id !== accountId) {
        outcome = { stale: true }
        return undefined
      }
      if (account.generation !== expectedGeneration) {
        outcome = { stale: true, account }
        return undefined
      }
      if (account.reauthRequired === true) {
        outcome = { reauth: true, account }
        return undefined
      }
      if (!force && accountIsUsable(account, this.#now(), ACCESS_REFRESH_SKEW_MS)) {
        outcome = { fresh: true, account }
        return undefined
      }
      try {
        const tokens = await this.#oauth.refresh({
          clientId: account.clientId,
          refreshToken: account.refreshToken,
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        })
        const scopes = tokens.scopes.length > 0 ? tokens.scopes : account.scopes
        const next = {
          ...account,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? account.refreshToken,
          idToken: tokens.idToken ?? account.idToken,
          tokenType: tokens.tokenType,
          expiresAt: tokens.expiresAt,
          ...(tokens.earliestRefreshAt === undefined ? {} : { earliestRefreshAt: tokens.earliestRefreshAt }),
          scopes,
          planEnabled: scopes.includes(PLAN_SCOPE),
          reauthRequired: false,
          lastRefreshAt: this.#now(),
          generation: account.generation + 1,
        }
        outcome = { ok: true, account: next }
        return { kind: 'grant', payload: jsonSafe(next) }
      } catch (error) {
        if (error instanceof OAuthError && error.retryable === true) {
          outcome = { error, account }
          return undefined
        }
        const code = error instanceof OAuthError ? error.providerCode : undefined
        if (code !== undefined && REAUTH_REFRESH_CODES.includes(code)) {
          const next = {
            ...account,
            accessToken: undefined,
            refreshToken: undefined,
            reauthRequired: true,
            generation: account.generation + 1,
            lastError: code,
          }
          outcome = { reauth: true, account: next, error }
          return { kind: 'grant', payload: jsonSafe(next) }
        }
        // invalid_client and every non-retryable protocol failure stop the loop
        // but keep an unexpired access token usable until it expires.
        const next = {
          ...account,
          reauthRequired: true,
          generation: account.generation + 1,
          lastError: code ?? 'refresh_failed',
        }
        outcome = { config: true, account: next, error }
        return { kind: 'grant', payload: jsonSafe(next) }
      }
    })

    if (outcome?.account !== undefined) await this.updateIndex(outcome.account)
    if (outcome?.ok === true) return outcome.account
    if (outcome?.fresh === true) return outcome.account
    if (outcome?.stale === true) {
      const current = await this.readAccountById(accountId)
      if (current === undefined) throw authError('The account was signed out', 'ACCOUNT_NOT_FOUND')
      return current
    }
    if (outcome?.reauth === true) {
      throw authError('This ChatGPT-plan account must sign in again', 'REAUTH_REQUIRED', {
        providerCode: outcome.error?.providerCode,
      })
    }
    if (outcome?.config === true) {
      throw authError('The ChatGPT-plan client configuration was rejected', 'AUTH', {
        providerCode: outcome.error?.providerCode,
      })
    }
    if (outcome?.error instanceof OAuthError) {
      const error = outcome.error
      const code =
        error.code === 'OAUTH_TIMEOUT'
          ? 'TIMEOUT'
          : error.status === 429
            ? 'RATE_LIMIT'
            : error.status !== undefined && error.status >= 500
              ? 'SERVER'
              : 'TRANSPORT'
      throw new ChatGptPlanError('The ChatGPT-plan token refresh temporarily failed', code, {
        status: error.status,
        providerCode: error.providerCode,
        requestId: error.requestId,
        retryAfterMs: error.retryAfterMs,
        retryable: true,
        cause: error,
      })
    }
    throw outcome?.error ?? authError('The ChatGPT-plan token refresh failed', 'AUTH')
  }

  async resolveAccessToken(accountId) {
    const account = await this.readAccountById(accountId)
    if (account === undefined) {
      const state = await this.readState()
      if (state.accounts[accountId] === undefined) throw authError('No such ChatGPT-plan account', 'ACCOUNT_NOT_FOUND')
      throw authError('The ChatGPT-plan account is incomplete', 'AUTH')
    }
    if (account.planEnabled !== true) {
      throw authError('This account does not have the ChatGPT-plan scope', 'PLAN_DISABLED')
    }
    if (account.reauthRequired === true) {
      throw authError('This ChatGPT-plan account must sign in again', 'REAUTH_REQUIRED')
    }
    if (accountIsUsable(account, this.#now(), ACCESS_REFRESH_SKEW_MS)) return account.accessToken
    if (typeof account.refreshToken !== 'string' || account.refreshToken.length === 0) {
      await this.markReauth(accountId, 'missing_refresh_token')
      throw authError('This ChatGPT-plan account has no refresh token', 'REAUTH_REQUIRED')
    }
    const refreshed = await this.refreshAccount(accountId, { force: true })
    if (refreshed === undefined || typeof refreshed.accessToken !== 'string') {
      throw authError('This ChatGPT-plan account has no usable access token', 'REAUTH_REQUIRED')
    }
    return refreshed.accessToken
  }

  /**
   * Sign out one account. The token is captured and the grant is marked
   * signing-out under one lock, so a concurrent refresh either finishes first
   * (and its rotated token is the one revoked) or sees the signing-out
   * generation and writes nothing.
   */
  async signOut(accountId) {
    const state = await this.readState()
    const entry = state.accounts[accountId]
    if (entry === undefined) throw authError('No such ChatGPT-plan account', 'ACCOUNT_NOT_FOUND')
    let captured
    await this.#credentials.modifyRecord(accountKey(entry.recordId), async (current) => {
      const account = parseAccountRecord(current)
      if (account === undefined || account.id !== accountId) {
        captured = { missing: true }
        return undefined
      }
      captured = {
        refreshToken: account.refreshToken,
        clientId: account.clientId,
        generation: account.generation + 1,
      }
      return {
        kind: 'grant',
        payload: jsonSafe({
          ...account,
          signingOut: true,
          accessToken: undefined,
          refreshToken: undefined,
          reauthRequired: true,
          generation: account.generation + 1,
          lastError: 'signed_out',
        }),
      }
    })

    let remoteRevoked = false
    let revokeError
    if (captured?.refreshToken !== undefined && captured.clientId !== undefined) {
      try {
        remoteRevoked = await this.#oauth.revoke({
          clientId: captured.clientId,
          token: captured.refreshToken,
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        })
      } catch (error) {
        revokeError = error
      }
    }

    this.#refreshes.delete(accountId)
    try {
      await this.#credentials.deleteRecord(accountKey(entry.recordId))
    } catch (error) {
      throw authError('The local ChatGPT-plan grant could not be removed', 'STORE_ERROR', { cause: error })
    }
    await this.#writeState((current) => {
      delete current.accounts[accountId]
      current.tombstones[accountId] = this.#now()
      if (current.activeAccountId === accountId) {
        current.activeAccountId = Object.keys(current.accounts).find(
          (id) => current.accounts[id]?.pending !== true,
        )
      }
      current.epoch += 1
      return current
    })
    return {
      accountId,
      remoteRevoked,
      ...(revokeError === undefined ? {} : { revokeError: revokeError.providerCode ?? revokeError.code }),
    }
  }

  /**
   * Reconcile crash leftovers without overwriting a corrupt index. Complete
   * grants become visible; pending entries without a grant and signing-out
   * grants are removed; a missing active id falls back to the first account.
   */
  async reconcile() {
    const records = await this.listAccountRecords()
    const byId = new Map()
    for (const account of records) {
      if (account.signingOut === true) {
        try {
          await this.#credentials.deleteRecord(accountKey(account.recordId))
        } catch {
          // An undeletable signing-out grant stays hidden; it is never used.
        }
        continue
      }
      byId.set(account.id, account)
    }
    let snapshot
    await this.#writeState((current) => {
      let changed = false
      for (const [id, account] of byId) {
        if (current.tombstones?.[id] !== undefined) continue
        if (account.pending === true && current.accounts[id] === undefined) continue
        if (!entryMatches(current.accounts[id], account)) {
          current.accounts[id] = indexEntryOf(account)
          changed = true
        }
      }
      for (const id of Object.keys(current.accounts)) {
        if (!byId.has(id) || current.tombstones?.[id] !== undefined) {
          delete current.accounts[id]
          changed = true
        }
      }
      if (current.activeAccountId === undefined || current.accounts[current.activeAccountId] === undefined) {
        const next = Object.keys(current.accounts).find((id) => current.accounts[id]?.pending !== true)
        if (next !== current.activeAccountId) {
          current.activeAccountId = next
          changed = true
        }
      }
      snapshot = current
      return changed ? current : undefined
    })
    return snapshot ?? this.readState()
  }

  /** Sanitized view for the Host HTTP status route and the Client panel. */
  async status() {
    let state
    try {
      state = await this.reconcile()
    } catch (error) {
      return {
        signedIn: false,
        activeAccountId: undefined,
        accounts: [],
        stateError: error instanceof ChatGptPlanError ? error.code : 'STATE_CORRUPT',
      }
    }
    const accounts = []
    for (const entry of Object.values(state.accounts)) {
      if (entry?.pending === true) continue
      if (state.tombstones?.[entry.id] !== undefined) continue
      accounts.push({
        id: entry.id,
        label: entry.label,
        email: entry.email,
        planEnabled: entry.planEnabled === true,
        reauthRequired: entry.reauthRequired === true,
        expiresAt: entry.expiresAt,
      })
    }
    return {
      signedIn: accounts.length > 0,
      activeAccountId: state.activeAccountId,
      accounts,
    }
  }
}

export { accountKey, stateKey, parseStateRecord, parseAccountRecord }
