/**
 * Error vocabulary for the ChatGPT-plan provider.
 *
 * A thrown error never carries a token, an authorization code, a client id,
 * a subject, or a raw provider response body. Diagnostics keep the provider's
 * machine code, HTTP status, and request id only; those are the facts an
 * operator needs and the facts that cannot be replayed as a credential.
 */

export class ChatGptPlanError extends Error {
  /**
   * @param {string} message short human-readable summary with no secrets
   * @param {string} code stable machine code
   * @param {object} [options]
   * @param {number} [options.status] HTTP status observed at the provider
   * @param {string} [options.providerCode] provider-issued machine code
   * @param {string} [options.requestId] provider request id
   * @param {number} [options.retryAfterMs] provider-requested delay
   * @param {boolean} [options.retryable] whether a bounded retry may help
   * @param {unknown} [options.cause] underlying error, never surfaced verbatim
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ChatGptPlanError'
    this.code = code
    this.status = options.status
    this.providerCode = options.providerCode
    this.requestId = options.requestId
    this.retryAfterMs = options.retryAfterMs
    this.retryable = options.retryable === true
  }
}

export class OAuthError extends ChatGptPlanError {
  constructor(message, code, options = {}) {
    super(message, code, options)
    this.name = 'OAuthError'
  }
}

export class IdTokenError extends ChatGptPlanError {
  constructor(message, code, options = {}) {
    super(message, code, options)
    this.name = 'IdTokenError'
  }
}

export const AUTH_ERROR_CODES = new Set([
  'AUTH',
  'AUTH_REJECTED',
  'PLAN_INELIGIBLE',
  'MISSING_CREDENTIAL',
  'ACCOUNT_NOT_FOUND',
  'PLAN_DISABLED',
  'REAUTH_REQUIRED',
  'INVALID_CLIENT',
])

export function authError(message, code = 'AUTH', options = {}) {
  return new ChatGptPlanError(message, code, options)
}

/** Strip an arbitrary thrown value down to safe, serializable diagnostics. */
export function errorDiagnostics(error) {
  if (error instanceof ChatGptPlanError) {
    return {
      code: error.code,
      message: error.message,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(typeof error.providerCode === 'string' ? { providerCode: error.providerCode } : {}),
      ...(typeof error.requestId === 'string' ? { requestId: error.requestId } : {}),
    }
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL', message: error.name }
  }
  return { code: 'INTERNAL', message: 'unknown error' }
}

export function errorSummary(error) {
  const details = errorDiagnostics(error)
  return details.providerCode === undefined ? details.code : `${details.code}/${details.providerCode}`
}

/** One-line safe message for the Models footer. */
export function publicErrorMessage(error) {
  const details = errorDiagnostics(error)
  switch (details.code) {
    case 'OAUTH_DENIED':
      return 'Sign-in was cancelled.'
    case 'OAUTH_TIMEOUT':
      return 'Sign-in timed out. Start again.'
    case 'TOO_MANY_PENDING':
      return 'Too many sign-in attempts are pending. Cancel them and try again.'
    case 'LOGIN_IN_PROGRESS':
    case 'ALREADY_IN_FLIGHT':
      return 'A sign-in is already in progress. Finish or cancel it first.'
    case 'ID_TOKEN_INVALID':
      return 'The sign-in response could not be verified.'
    case 'CALLBACK_STATE':
      return 'The sign-in callback did not match this attempt.'
    case 'CALLBACK_CLIENT':
      return 'The sign-in callback named a different client registration.'
    case 'REAUTH_REQUIRED':
      return 'The ChatGPT plan sign-in expired. Reconnect it in Settings → Models → ChatGPT Plan.'
    case 'PLAN_DISABLED':
      return 'This account lacks the ChatGPT plan scope. Sign in with an eligible account in Settings → Models → ChatGPT Plan.'
    case 'PLAN_INELIGIBLE':
      return 'This ChatGPT account is not eligible for the plan route. Check the plan or sign in with another account.'
    case 'AUTH':
    case 'AUTH_REJECTED':
    case 'MISSING_CREDENTIAL':
      return 'No usable ChatGPT-plan credential. Sign in again from Settings → Models → ChatGPT Plan.'
    case 'QUOTA':
      return 'The ChatGPT plan usage limit was reached. Wait for it to reset or check the plan.'
    case 'RATE_LIMIT':
      return 'The ChatGPT plan is temporarily rate limited. Retry shortly.'
    case 'TRANSPORT':
      return 'Network error reaching the ChatGPT plan. Check the local proxy/VPN and retry.'
    case 'TIMEOUT':
      return 'The ChatGPT plan request timed out. Retry; if it persists, check the local proxy/VPN.'
    case 'SERVER':
      return 'The ChatGPT plan service failed. Retry shortly.'
    case 'EMPTY_RESPONSE':
      return 'The ChatGPT plan returned no content. Retry.'
    case 'MALFORMED_RESPONSE':
    case 'STREAM_CLOSED':
      return 'The ChatGPT plan stream ended unexpectedly. Retry.'
    default:
      return details.message
  }
}

export function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

export function isTimeoutError(error) {
  return (
    (error instanceof Error && (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT')) ||
    (error instanceof ChatGptPlanError && error.code === 'TIMEOUT')
  )
}
