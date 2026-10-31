import {
  CALLBACK_HOST,
  DEFAULT_ACCESS_TTL_MS,
  DYNAMIC_CLIENT_ID,
  MAX_PENDING_LOGINS,
  OAUTH_TRANSACTION_TTL_MS,
  PLAN_SCOPE,
  REDIRECT_PATH,
} from './constants.js'
import { ChatGptPlanError, OAuthError, authError, errorDiagnostics, publicErrorMessage } from './errors.js'
import { createPkce } from './pkce.js'
import { randomToken } from './util.js'

const URL_WAIT_MS = 15 * 1000
const CALLBACK_SETTLE_MS = 30 * 1000

function isAbort(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

function redirectOf(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    throw new OAuthError('The Web origin is not a URL', 'CALLBACK_ORIGIN')
  }
  if (url.protocol !== 'http:' || url.hostname !== CALLBACK_HOST) {
    throw new OAuthError('Sign in requires the loopback HTTP Web origin', 'CALLBACK_ORIGIN')
  }
  return `${url.origin}${REDIRECT_PATH}`
}

/**
 * The OAuth coordinator owns one attempt's state/nonce/PKCE transaction, the
 * authorization flow that is registered for that attempt's grant key, and the
 * callback hand-off. It never stores a token in memory beyond the flow that
 * commits it, and it never exposes a URL or state through status.
 */
export class OAuthCoordinator {
  #accounts
  #oauth
  #verifier
  #config
  #logger
  #now
  #transactionTtlMs
  #getAuthorization
  #onAuthorized
  #transactions = new Map()
  #attempts = new Map()
  #lastError

  constructor(options) {
    if (!options?.accounts) throw new TypeError('OAuthCoordinator needs AccountStore')
    if (!options?.oauth) throw new TypeError('OAuthCoordinator needs OAuthClient')
    if (!options?.verifier) throw new TypeError('OAuthCoordinator needs IdTokenVerifier')
    this.#accounts = options.accounts
    this.#oauth = options.oauth
    this.#verifier = options.verifier
    this.#config = options.config ?? {}
    this.#logger = options.logger
    this.#now = options.now ?? Date.now
    this.#transactionTtlMs = options.transactionTtlMs ?? OAUTH_TRANSACTION_TTL_MS
    this.#getAuthorization = options.getAuthorization ?? (() => undefined)
    this.#onAuthorized = options.onAuthorized
  }

  get lastError() {
    return this.#lastError
  }

  pendingCount() {
    this.#pruneExpired()
    return this.#attempts.size
  }

  /**
   * Drop attempts whose transaction window elapsed but whose authorization
   * settlement did not run (a suspended timer, a clock jump, or a flow the
   * service never settled). The per-attempt timer normally removes them; this
   * keeps the capacity check honest and lets a user retry without restarting.
   */
  #pruneExpired() {
    const cutoff = this.#now() - (this.#transactionTtlMs + 5 * 1000)
    for (const [key, attempt] of [...this.#attempts]) {
      if (attempt.createdAt > cutoff) continue
      this.#attempts.delete(key)
      clearTimeout(attempt.timer)
      const timeout = new OAuthError('Sign-in timed out', 'OAUTH_TIMEOUT')
      attempt.controller.abort(timeout)
      if (!attempt.urlResolved) attempt.rejectUrl(timeout)
      try {
        attempt.dispose()
      } catch {
        // The flow's own finally already removed it.
      }
    }
  }

  #recordError(error) {
    this.#lastError = {
      ...errorDiagnostics(error),
      message: error instanceof ChatGptPlanError ? publicErrorMessage(error) : 'Sign-in failed.',
      at: this.#now(),
    }
    if (this.#logger?.warn) {
      this.#logger.warn(
        'openai-chatgpt-plan: sign-in failed (%s)',
        error instanceof ChatGptPlanError ? error.code : 'INTERNAL',
      )
    }
  }

  #clearError() {
    this.#lastError = undefined
  }

  /**
   * Register an attempt-specific flow and begin it. The returned URL is the
   * first notice emitted by the flow, so no browser window is opened before
   * the callback transaction exists.
   */
  async start(input = {}, options = {}) {
    const authorization = this.#getAuthorization()
    if (authorization === undefined || typeof authorization.begin !== 'function') {
      throw new OAuthError('The Host authorization service is unavailable', 'AUTH_UNAVAILABLE')
    }
    this.#pruneExpired()
    if (this.#attempts.size >= MAX_PENDING_LOGINS) {
      throw new OAuthError('Too many sign-in attempts are pending', 'TOO_MANY_PENDING')
    }
    const origin = options.origin
    if (typeof origin !== 'string') throw new OAuthError('The Web origin is unavailable', 'CALLBACK_ORIGIN')
    if (input.newAccount === true && input.accountId !== undefined) {
      throw new OAuthError('newAccount and accountId are mutually exclusive', 'INVALID_REQUEST')
    }
    const redirectUri = redirectOf(origin)

    let intent
    if (input.newAccount === true || (input.accountId === undefined && input.newAccount !== false)) {
      const recordId = this.#accounts.newRecordId()
      intent = { kind: 'new', recordId }
    } else if (typeof input.accountId === 'string') {
      const state = await this.#accounts.readState()
      const entry = state.accounts[input.accountId]
      if (entry !== undefined) {
        const account = await this.#accounts.readAccount(entry.recordId)
        if (account === undefined) throw authError('The ChatGPT-plan account is incomplete', 'ACCOUNT_NOT_FOUND')
        intent = {
          kind: 'reauth',
          accountId: input.accountId,
          recordId: entry.recordId,
          expectedSubject: account.subject,
          expectedClientId: account.clientId,
          expectedGeneration: account.generation,
          idTokenHint: account.idToken,
          loginHint: account.email,
        }
      } else {
        // A signed-out account keeps a non-secret tombstone. Reconnect reuses
        // that issued registration instead of creating a second dynamic client.
        const tombstone = await this.#accounts.readTombstone(input.accountId)
        if (tombstone === undefined) throw authError('No such ChatGPT-plan account', 'ACCOUNT_NOT_FOUND')
        intent = {
          kind: 'reconnect',
          accountId: input.accountId,
          recordId: this.#accounts.reconnectRecordId(input.accountId),
          expectedSubject: tombstone.subject,
          expectedClientId: tombstone.clientId,
          loginHint: tombstone.email,
          previousEmail: tombstone.email,
          previousLabel: tombstone.label,
        }
      }
    } else {
      throw new OAuthError('Specify a new account or an existing account id', 'INVALID_REQUEST')
    }
    intent.redirectUri = redirectUri

    const flowKey = this.#accounts.accountKey(intent.recordId)
    const method = intent.kind === 'new' ? 'sign-in' : intent.kind === 'reconnect' ? 'reconnect' : 'reauth'
    const flowLabel = intent.kind === 'new' ? 'Sign in with ChatGPT' : intent.kind === 'reconnect' ? 'Reconnect ChatGPT' : 'Sign in again'
    const flow = {
      key: flowKey,
      label: 'ChatGPT Plan',
      methods: [{ id: method, label: flowLabel }],
      run: (session) => this.#runFlow(session, intent),
    }
    let dispose
    try {
      dispose = authorization.registerFlow(flow)
    } catch (error) {
      throw new OAuthError('A sign-in for this account is already in progress', 'LOGIN_IN_PROGRESS', { cause: error })
    }

    const attempt = {
      flowKey,
      intent,
      method,
      dispose,
      controller: new AbortController(),
      urlResolved: false,
      createdAt: this.#now(),
      timer: undefined,
      beginPromise: undefined,
    }
    attempt.urlPromise = new Promise((resolve, reject) => {
      attempt.resolveUrl = resolve
      attempt.rejectUrl = reject
    })
    this.#attempts.set(flowKey, attempt)
    attempt.timer = setTimeout(() => {
      const timeout = new OAuthError('Sign-in timed out', 'OAUTH_TIMEOUT')
      this.#recordError(timeout)
      attempt.controller.abort(timeout)
      if (!attempt.urlResolved) attempt.rejectUrl(timeout)
    }, this.#transactionTtlMs + 5 * 1000)

    const interaction = {
      notify: (notice) => {
        if (typeof notice?.url === 'string' && !attempt.urlResolved) {
          attempt.urlResolved = true
          attempt.resolveUrl(notice.url)
        }
      },
      prompt: async () => {
        throw new OAuthError('This sign-in method does not accept interactive prompts', 'OAUTH_PROMPT')
      },
    }

    let beginResult
    try {
      beginResult = authorization.begin({
        key: flowKey,
        method,
        interaction,
        signal: attempt.controller.signal,
      })
    } catch (error) {
      clearTimeout(attempt.timer)
      this.#attempts.delete(flowKey)
      try {
        dispose()
      } catch {
        // already disposed
      }
      throw error
    }
    attempt.beginPromise = beginResult
      .then(
        (outcome) => {
          attempt.outcome = outcome
          if (!attempt.urlResolved) {
            attempt.rejectUrl(new OAuthError('Sign-in ended before a browser URL was issued', 'OAUTH_FAILED'))
          }
        },
        (error) => {
          if (!attempt.urlResolved) attempt.rejectUrl(error)
          else this.#recordError(error)
        },
      )
      .finally(() => {
        clearTimeout(attempt.timer)
        this.#attempts.delete(flowKey)
        try {
          dispose()
        } catch {
          // The owning plugin may already be disposed.
        }
      })

    let urlTimer
    try {
      const url = await Promise.race([
        attempt.urlPromise,
        new Promise((_, reject) => {
          urlTimer = setTimeout(
            () => reject(new OAuthError('Sign-in did not produce a browser URL', 'OAUTH_TIMEOUT')),
            URL_WAIT_MS,
          )
        }),
      ])
      this.#clearError()
      return {
        url,
        method,
        ...(intent.kind === 'new' ? {} : { accountId: intent.accountId }),
      }
    } catch (error) {
      this.#recordError(error)
      attempt.controller.abort(error)
      await attempt.beginPromise.catch(() => {})
      throw error
    } finally {
      clearTimeout(urlTimer)
    }
  }

  #authorizeUrl(intent, hostId, state, nonce, challenge) {
    if (intent.kind === 'new') {
      return this.#oauth.buildAuthorizeUrl({
        newAccount: true,
        clientId: DYNAMIC_CLIENT_ID,
        hostId,
        redirectUri: intent.redirectUri,
        state,
        nonce,
        challenge,
        agentNameHint: this.#config.agentNameHint,
      })
    }
    return this.#oauth.buildAuthorizeUrl({
      newAccount: false,
      clientId: intent.expectedClientId,
      redirectUri: intent.redirectUri,
      state,
      nonce,
      challenge,
      // Reconnect has no surviving ID token; re-authorization does.
      idTokenHint: intent.idTokenHint,
      loginHint: intent.loginHint,
    })
  }

  async #runFlow(session, intent) {
    const hostId = await this.#accounts.ensureHostId()
    const state = randomToken()
    const nonce = randomToken()
    const pkce = createPkce()
    const transaction = {
      state,
      nonce,
      verifier: pkce.verifier,
      intent,
      session,
      createdAt: this.#now(),
      consumed: false,
      settled: false,
      timer: undefined,
      resolve: undefined,
      reject: undefined,
      completionResolve: undefined,
    }
    const callbackPromise = new Promise((resolve, reject) => {
      transaction.resolve = resolve
      transaction.reject = reject
    })
    const completionPromise = new Promise((resolve) => {
      transaction.completionResolve = resolve
    })
    transaction.completion = completionPromise
    this.#transactions.set(state, transaction)
    transaction.timer = setTimeout(() => {
      const timeout = new OAuthError('Sign-in timed out', 'OAUTH_TIMEOUT')
      this.#recordError(timeout)
      transaction.reject(timeout)
    }, this.#transactionTtlMs)
    session.signal.addEventListener(
      'abort',
      () => {
        transaction.reject(session.signal.reason ?? new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )

    let committedAccount
    let flowError
    try {
      const url = this.#authorizeUrl(intent, hostId, state, nonce, pkce.challenge)
      session.notify({ message: 'Continue in your browser', url })
      const callback = await callbackPromise
      if (callback.error !== undefined) {
        throw new OAuthError(
          callback.error === 'access_denied' ? 'Sign-in was cancelled' : 'Sign-in was refused',
          'OAUTH_DENIED',
          { providerCode: callback.error },
        )
      }
      if (typeof callback.code !== 'string' || callback.code.length === 0) {
        throw new OAuthError('The callback has no authorization code', 'CALLBACK_CODE')
      }
      const callbackClientId = callback.clientId
      let issuedClientId
      if (intent.kind === 'new') {
        if (
          typeof callbackClientId !== 'string' ||
          callbackClientId.length === 0 ||
          callbackClientId === DYNAMIC_CLIENT_ID
        ) {
          throw new OAuthError('New registration did not return an issued client id', 'CALLBACK_CLIENT')
        }
        issuedClientId = callbackClientId
      } else {
        if (callbackClientId !== undefined && callbackClientId !== intent.expectedClientId) {
          throw new OAuthError('The callback named a different client registration', 'CALLBACK_CLIENT')
        }
        issuedClientId = intent.expectedClientId
      }

      const tokens = await this.#oauth.exchangeCode({
        code: callback.code,
        codeVerifier: transaction.verifier,
        redirectUri: intent.redirectUri,
        clientId: issuedClientId,
        signal: session.signal,
      })
      const identity = await this.#verifier.verify(tokens.idToken, {
        clientId: issuedClientId,
        nonce,
        // Re-authorization and reconnect must land on the same subject.
        ...(intent.kind === 'new' ? {} : { subject: intent.expectedSubject }),
        signal: session.signal,
      })
      const scopes = tokens.scopes
      const planEnabled = scopes.includes(PLAN_SCOPE)
      const accountId = this.#accounts.accountIdFor(identity.issuer, identity.subject, issuedClientId)
      if (intent.kind !== 'new' && accountId !== intent.accountId) {
        throw new OAuthError('The re-authorized identity is not the selected account', 'ACCOUNT_MISMATCH')
      }
      if (intent.kind === 'new') {
        const currentState = await this.#accounts.readState()
        const existing = currentState.accounts[accountId]
        if (existing !== undefined && existing.recordId !== intent.recordId) {
          throw new OAuthError('This ChatGPT plan account is already connected; use Sign in again', 'ACCOUNT_EXISTS')
        }
      }
      if (intent.kind === 'reconnect') {
        const currentState = await this.#accounts.readState()
        if (currentState.accounts[accountId] !== undefined) {
          throw new OAuthError('The account was connected again while reconnect was in progress', 'ACCOUNT_CHANGED')
        }
      }

      let previous
      if (intent.kind === 'reauth') {
        previous = await this.#accounts.readAccount(intent.recordId)
        if (
          previous === undefined ||
          previous.id !== intent.accountId ||
          previous.generation !== intent.expectedGeneration
        ) {
          throw new OAuthError('The account changed while sign-in was in progress', 'ACCOUNT_CHANGED')
        }
      }
      const fallbackLabel = previous?.label ?? intent.previousLabel
      const label = identity.email ?? previous?.email ?? intent.previousEmail ?? fallbackLabel ?? 'ChatGPT plan account'
      const account = await this.#accounts.buildAccountPayload({
        id: accountId,
        recordId: intent.recordId,
        label,
        email: identity.email ?? previous?.email ?? intent.previousEmail,
        issuer: identity.issuer,
        subject: identity.subject,
        clientId: issuedClientId,
        idToken: tokens.idToken,
        tokens: {
          ...tokens,
          expiresAt: tokens.expiresAt ?? this.#now() + DEFAULT_ACCESS_TTL_MS,
        },
        scopes,
        planEnabled,
        sid: identity.sid,
        addedAt: previous?.addedAt ?? this.#now(),
        generation: (previous?.generation ?? 0) + 1,
      })
      // A new account and a reconnect both write a fresh grant at a fresh key.
      // A re-authorization overwrites the existing account's own grant.
      if (intent.kind !== 'reauth') {
        await this.#accounts.preparePendingAccount(account)
      }
      try {
        await session.commit({ kind: 'grant', payload: account })
      } catch (error) {
        if (intent.kind !== 'reauth') await this.#accounts.removePendingAccount(accountId)
        throw error
      }
      committedAccount = account
      if (intent.kind !== 'reauth') {
        try {
          await this.#accounts.commitAccount(account, { makeActive: true })
        } catch (error) {
          if (this.#logger?.warn) this.#logger.warn('openai-chatgpt-plan: grant committed but index update failed (%s)', error.code ?? 'UNKNOWN')
        }
      } else {
        try {
          await this.#accounts.updateIndex(account)
        } catch (error) {
          if (this.#logger?.warn) this.#logger.warn('openai-chatgpt-plan: grant committed but index update failed (%s)', error.code ?? 'UNKNOWN')
        }
      }
      if (this.#onAuthorized !== undefined) {
        try {
          await this.#onAuthorized(account)
        } catch (error) {
          if (this.#logger?.warn) this.#logger.warn('openai-chatgpt-plan: post-sign-in refresh failed (%s)', error.code ?? 'UNKNOWN')
        }
      }
      this.#clearError()
      session.notify({ message: 'Signed in' })
    } catch (error) {
      flowError = error
      if (intent.kind !== 'reauth' && committedAccount === undefined) {
        const stateRecord = await this.#accounts.readState().catch(() => undefined)
        const accountId = stateRecord === undefined
          ? undefined
          : Object.keys(stateRecord.accounts).find((id) => stateRecord.accounts[id]?.recordId === intent.recordId)
        if (accountId !== undefined) await this.#accounts.removePendingAccount(accountId).catch(() => {})
      }
      this.#recordError(error)
      throw error
    } finally {
      clearTimeout(transaction.timer)
      transaction.settled = true
      this.#transactions.delete(state)
      transaction.completionResolve({ ok: committedAccount !== undefined, account: committedAccount, error: flowError })
    }
  }

  /**
   * Hand one callback query to the waiting flow and wait for its terminal
   * result. The returned object is intended for the HTML responder; it never
   * contains the code, state, token, or client id.
   */
  async completeCallback(query) {
    const state = typeof query.state === 'string' ? query.state : ''
    const transaction = this.#transactions.get(state)
    if (transaction === undefined) {
      return { ok: false, status: 400, code: 'CALLBACK_STATE', message: 'This sign-in attempt is unknown or already finished.' }
    }
    if (transaction.consumed === true) {
      return { ok: false, status: 400, code: 'CALLBACK_REPLAY', message: 'This sign-in callback was already used.' }
    }
    transaction.consumed = true
    if (typeof query.error === 'string') {
      const error = new OAuthError('Sign-in was cancelled', 'OAUTH_DENIED', { providerCode: query.error })
      this.#recordError(error)
      transaction.resolve({ error: query.error })
      if (query.error === 'access_denied') {
        const attempt = this.#attempts.get(this.#accounts.accountKey(transaction.intent.recordId))
        attempt?.controller.abort(error)
      }
      const completion = await this.#awaitCompletion(transaction)
      return {
        ok: false,
        status: 200,
        code: 'OAUTH_DENIED',
        message: 'Sign-in was cancelled. You can close this window.',
        completion,
      }
    }
    if (typeof query.code !== 'string' || query.code.length === 0) {
      transaction.resolve({ error: 'missing_code' })
      const completion = await this.#awaitCompletion(transaction)
      return {
        ok: false,
        status: 400,
        code: 'CALLBACK_CODE',
        message: 'The sign-in callback did not include an authorization code.',
        completion,
      }
    }
    transaction.resolve({
      code: query.code,
      clientId: typeof query.client_id === 'string' ? query.client_id : undefined,
    })
    const completion = await this.#awaitCompletion(transaction)
    if (completion.ok === true) {
      return { ok: true, status: 200, code: 'SIGNED_IN', message: 'Signed in. You can close this window.' }
    }
    const error = completion.error
    return {
      ok: false,
      status: 400,
      code: error instanceof ChatGptPlanError ? error.code : 'OAUTH_FAILED',
      message: publicErrorMessage(error ?? new OAuthError('Sign-in failed', 'OAUTH_FAILED')),
    }
  }

  async #awaitCompletion(transaction) {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: new OAuthError('Sign-in did not settle', 'OAUTH_TIMEOUT') }), CALLBACK_SETTLE_MS)
    })
    try {
      return await Promise.race([transaction.completion, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Cancel every pending attempt; used by the UI Cancel button and dispose. */
  async cancelAll(reason = 'cancelled') {
    const error = new OAuthError('Sign-in was cancelled', reason === 'timeout' ? 'OAUTH_TIMEOUT' : 'OAUTH_DENIED')
    for (const transaction of this.#transactions.values()) {
      this.#recordError(error)
      transaction.resolve({ error: 'access_denied' })
    }
    for (const attempt of this.#attempts.values()) {
      attempt.controller.abort(error)
      if (!attempt.urlResolved) attempt.rejectUrl(error)
    }
  }

  dispose() {
    for (const transaction of this.#transactions.values()) {
      clearTimeout(transaction.timer)
      transaction.reject(new OAuthError('The plugin was disposed', 'OAUTH_DISPOSED'))
    }
    this.#transactions.clear()
    for (const attempt of this.#attempts.values()) {
      clearTimeout(attempt.timer)
      attempt.controller.abort(new OAuthError('The plugin was disposed', 'OAUTH_DISPOSED'))
      try {
        attempt.dispose()
      } catch {
        // already disposed by its own finally
      }
    }
    this.#attempts.clear()
  }
}

export { redirectOf as __redirectOfForTests, isAbort as __isAbortForTests }
