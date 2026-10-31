/**
 * Last inference failure, kept for the Models footer.
 *
 * DSH renders a turn failure from the adapter's `message` and `code`; a panel
 * cannot rewrite that row. This store gives the plugin its own localized,
 * persistent surface for the same failure, and it is deliberately limited to
 * whitelisted, non-secret fields.
 */

const ALLOWED_CODES = new Set([
  'AUTH',
  'AUTH_REJECTED',
  'PLAN_INELIGIBLE',
  'PLAN_DISABLED',
  'REAUTH_REQUIRED',
  'MISSING_CREDENTIAL',
  'QUOTA',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'INVALID_REQUEST',
  'UNSUPPORTED_CAPABILITY',
  'UNSUPPORTED_CONTENT',
  'MALFORMED_RESPONSE',
  'STREAM_CLOSED',
  'EMPTY_RESPONSE',
  'INTERNAL',
])

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
}

/**
 * One sanitized failure. `message` is produced by this plugin and never
 * contains a token, an authorization URL, or a raw provider body.
 */
export class RequestErrorStore {
  #now
  #entry

  constructor(options = {}) {
    this.#now = options.now ?? Date.now
  }

  record(entry) {
    if (entry === undefined || entry === null || typeof entry !== 'object') return
    const code = typeof entry.code === 'string' && ALLOWED_CODES.has(entry.code) ? entry.code : 'INTERNAL'
    const message = typeof entry.message === 'string' && entry.message.length > 0 ? entry.message : 'ChatGPT-plan request failed.'
    const status = finiteNonNegative(entry.status)
    const retryAfterMs = finiteNonNegative(entry.retryAfterMs)
    const providerCode = typeof entry.providerCode === 'string' && entry.providerCode.length > 0 ? entry.providerCode : undefined
    const requestId = typeof entry.requestId === 'string' && entry.requestId.length > 0 ? entry.requestId : undefined
    this.#entry = {
      code,
      message,
      ...(status === undefined ? {} : { status }),
      ...(providerCode === undefined ? {} : { providerCode }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(requestId === undefined ? {} : { requestId }),
      at: this.#now(),
    }
  }

  clear() {
    this.#entry = undefined
  }

  get() {
    return this.#entry
  }
}
