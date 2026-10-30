import {
  AUTHORIZE_URL,
  DEFAULT_ACCESS_TTL_MS,
  DYNAMIC_CLIENT_ID,
  RESOURCE,
  REVOKE_TIMEOUT_MS,
  SCOPES,
  TOKEN_TIMEOUT_MS,
  TOKEN_URL,
} from './constants.js'
import { OAuthError } from './errors.js'
import {
  delay,
  headerValue,
  isNonEmptyString,
  isPlainObject,
  providerRequestId,
  safeJsonParse,
} from './util.js'

const OAUTH_USER_AGENT = 'deepseek-harness-chatgpt-plan/0.1.0'

function parseRetryAfterMs(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Math.round(Number(value) * 1000)
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  const ms = date - Date.now()
  return ms > 0 ? ms : undefined
}

function providerErrorCode(body) {
  if (!isPlainObject(body)) return undefined
  if (typeof body.error === 'string') return body.error
  if (isPlainObject(body.error) && typeof body.error.code === 'string') return body.error.code
  if (typeof body.error_code === 'string') return body.error_code
  if (typeof body.code === 'string') return body.code
  return undefined
}

function statusIsRetryable(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function normalizeScopes(value) {
  if (typeof value === 'string') return value.split(/\s+/u).filter((item) => item.length > 0)
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
  }
  return []
}

function parseTokenResponse(body, now, options = {}) {
  if (!isPlainObject(body)) {
    throw new OAuthError('OAuth token response is not an object', 'OAUTH_MALFORMED')
  }
  if (!isNonEmptyString(body.access_token)) {
    throw new OAuthError('OAuth token response has no access token', 'OAUTH_MALFORMED')
  }
  if (options.requireIdToken !== false && !isNonEmptyString(body.id_token)) {
    throw new OAuthError('OAuth token response has no ID token', 'OAUTH_MALFORMED')
  }
  if (body.id_token !== undefined && !isNonEmptyString(body.id_token)) {
    throw new OAuthError('OAuth token response has an invalid ID token', 'OAUTH_MALFORMED')
  }
  if (body.token_type !== undefined && typeof body.token_type !== 'string') {
    throw new OAuthError('OAuth token response has an invalid token type', 'OAUTH_MALFORMED')
  }
  if (body.expires_in !== undefined && (!Number.isFinite(body.expires_in) || body.expires_in <= 0)) {
    throw new OAuthError('OAuth token response has an invalid expiry', 'OAUTH_MALFORMED')
  }
  const expiresInMs = body.expires_in === undefined ? DEFAULT_ACCESS_TTL_MS : Math.round(body.expires_in * 1000)
  return {
    accessToken: body.access_token,
    refreshToken: isNonEmptyString(body.refresh_token) ? body.refresh_token : undefined,
    idToken: isNonEmptyString(body.id_token) ? body.id_token : undefined,
    tokenType: isNonEmptyString(body.token_type) ? body.token_type : 'Bearer',
    scopes: normalizeScopes(body.scope),
    scopeRaw: typeof body.scope === 'string' ? body.scope : undefined,
    expiresAt: now() + expiresInMs,
    earliestRefreshAt:
      Number.isFinite(body.earliest_refresh_at) && body.earliest_refresh_at > 0
        ? body.earliest_refresh_at * 1000
        : undefined,
  }
}

function decodeErrorBody(text) {
  const parsed = safeJsonParse(text)
  return parsed.ok ? parsed.value : undefined
}

/**
 * One OAuth transport shared by sign-in, refresh, and revocation.
 *
 * The caller supplies the HTTP implementation and clock so tests can run the
 * exact production path without a network or a real account. No method ever
 * puts a token, code, client id, or subject into an error message.
 */
export class OAuthClient {
  #fetch
  #now
  #verifier
  #timeoutMs
  #revokeTimeoutMs

  constructor(options = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#now = options.now ?? Date.now
    this.#verifier = options.verifier
    this.#timeoutMs = options.timeoutMs ?? TOKEN_TIMEOUT_MS
    this.#revokeTimeoutMs = options.revokeTimeoutMs ?? REVOKE_TIMEOUT_MS
    if (typeof this.#fetch !== 'function') throw new TypeError('OAuthClient needs fetch')
    if (this.#verifier === undefined || typeof this.#verifier.discover !== 'function') {
      throw new TypeError('OAuthClient needs an IdTokenVerifier for discovery')
    }
  }

  /**
   * Build the exact official authorize URL. New registration and re-login are
   * deliberately different shapes; mixing the two is what loses an issued
   * client id or registers a second client for the same account.
   */
  buildAuthorizeUrl(input) {
    const {
      newAccount,
      clientId,
      hostId,
      redirectUri,
      state,
      nonce,
      challenge,
      agentNameHint,
      idTokenHint,
      loginHint,
    } = input
    if (typeof redirectUri !== 'string' || !redirectUri.startsWith('http://127.0.0.1:')) {
      throw new OAuthError('redirect_uri must be a loopback HTTP URL', 'OAUTH_REDIRECT')
    }
    const url = new URL(AUTHORIZE_URL)
    const params = url.searchParams
    params.set('response_type', 'code')
    params.set('client_id', newAccount ? DYNAMIC_CLIENT_ID : clientId)
    params.set('redirect_uri', redirectUri)
    params.set('resource', RESOURCE)
    params.set('scope', SCOPES.join(' '))
    params.set('state', state)
    params.set('nonce', nonce)
    params.set('code_challenge', challenge)
    params.set('code_challenge_method', 'S256')
    if (newAccount) {
      if (!isNonEmptyString(agentNameHint)) {
        throw new OAuthError('new registration needs an agent name hint', 'OAUTH_PARAMS')
      }
      params.set('agent_name_hint', agentNameHint)
      params.set('ext_agent_host_id', hostId)
    } else {
      if (!isNonEmptyString(clientId)) {
        throw new OAuthError('re-authorization needs the issued client id', 'OAUTH_PARAMS')
      }
      if (isNonEmptyString(idTokenHint)) params.set('id_token_hint', idTokenHint)
      if (isNonEmptyString(loginHint)) params.set('login_hint', loginHint)
    }
    return url.toString()
  }

  async #postForm(url, form, { signal, timeoutMs, allowEmpty = false, parse = true }) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const body = new URLSearchParams(form).toString()
    let response
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: combined,
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': OAUTH_USER_AGENT,
        },
        body,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) {
        throw new OAuthError('OAuth endpoint timed out', 'OAUTH_TIMEOUT', { retryable: true, cause: error })
      }
      throw new OAuthError('OAuth endpoint is unreachable', 'OAUTH_NETWORK', { retryable: true, cause: error })
    }
    const text = await response.text()
    if (!response.ok) {
      const parsed = decodeErrorBody(text)
      const providerCode = providerErrorCode(parsed)
      throw new OAuthError(
        providerCode === undefined ? 'OAuth endpoint rejected the request' : `OAuth endpoint rejected the request (${providerCode})`,
        response.status >= 500 ? 'OAUTH_SERVER' : 'OAUTH_HTTP',
        {
          status: response.status,
          providerCode,
          requestId: providerRequestId(response.headers),
          retryAfterMs: parseRetryAfterMs(headerValue(response.headers, 'retry-after')),
          retryable: statusIsRetryable(response.status),
        },
      )
    }
    if (allowEmpty && text.trim().length === 0) return undefined
    if (!parse) return undefined
    const parsed = safeJsonParse(text)
    if (!parsed.ok) throw new OAuthError('OAuth endpoint returned malformed JSON', 'OAUTH_MALFORMED')
    return parsed.value
  }

  async exchangeCode(input) {
    if (!isNonEmptyString(input.code) || !isNonEmptyString(input.codeVerifier)) {
      throw new OAuthError('authorization code exchange is missing code or verifier', 'OAUTH_PARAMS')
    }
    if (!isNonEmptyString(input.clientId)) {
      throw new OAuthError('authorization code exchange needs the issued client id', 'OAUTH_PARAMS')
    }
    const body = await this.#postForm(
      TOKEN_URL,
      {
        grant_type: 'authorization_code',
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        resource: RESOURCE,
      },
      { signal: input.signal, timeoutMs: this.#timeoutMs },
    )
    return parseTokenResponse(body, this.#now)
  }

  async refresh(input) {
    if (!isNonEmptyString(input.clientId) || !isNonEmptyString(input.refreshToken)) {
      throw new OAuthError('refresh needs the issued client id and refresh token', 'OAUTH_PARAMS')
    }
    const body = await this.#postForm(
      TOKEN_URL,
      {
        grant_type: 'refresh_token',
        client_id: input.clientId,
        refresh_token: input.refreshToken,
        resource: RESOURCE,
      },
      { signal: input.signal, timeoutMs: this.#timeoutMs },
    )
    return parseTokenResponse(body, this.#now, { requireIdToken: false })
  }

  /**
   * Revoke the refresh token at the discovery-declared endpoint.
   * @returns true only when the provider accepted the revocation.
   */
  async revoke(input) {
    const discovery = await this.#verifier.discover({ signal: input.signal })
    if (!isNonEmptyString(discovery.revocationEndpoint)) {
      throw new OAuthError('OpenID discovery declares no revocation endpoint', 'REVOKE_UNAVAILABLE')
    }
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.#postForm(
          discovery.revocationEndpoint,
          {
            token: input.token,
            token_type_hint: 'refresh_token',
            client_id: input.clientId,
          },
          { signal: input.signal, timeoutMs: this.#revokeTimeoutMs, allowEmpty: true, parse: false },
        )
        void response
        return true
      } catch (error) {
        lastError = error
        if (!(error instanceof OAuthError) || !error.retryable || attempt === 2) throw error
        await delay(500 * 2 ** attempt)
      }
    }
    throw lastError
  }
}

export { normalizeScopes as __normalizeScopesForTests, parseTokenResponse as __parseTokenResponseForTests }
