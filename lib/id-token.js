import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import {
  DISCOVERY_TIMEOUT_MS,
  DISCOVERY_URL,
} from './constants.js'
import { IdTokenError } from './errors.js'
import { isNonEmptyString, safeJsonParse } from './util.js'

const ALGORITHMS = new Map([
  ['RS256', 'sha256'],
  ['RS384', 'sha384'],
  ['RS512', 'sha512'],
  ['ES256', 'sha256'],
  ['ES384', 'sha384'],
  ['ES512', 'sha512'],
])

const CLOCK_TOLERANCE_SECONDS = 5
const DISCOVERY_TTL_MS = 60 * 60 * 1000
const JWKS_TTL_MS = 60 * 60 * 1000

function decodeSegment(segment, label) {
  if (!isNonEmptyString(segment)) throw new IdTokenError(`ID token has an empty ${label}`, 'ID_TOKEN_MALFORMED')
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  } catch {
    throw new IdTokenError(`ID token ${label} is not valid JSON`, 'ID_TOKEN_MALFORMED')
  }
}

function parseJwt(token) {
  if (!isNonEmptyString(token)) throw new IdTokenError('ID token is missing', 'ID_TOKEN_MISSING')
  const parts = token.split('.')
  if (parts.length !== 3) throw new IdTokenError('ID token is not a compact JWS', 'ID_TOKEN_MALFORMED')
  const header = decodeSegment(parts[0], 'header')
  const payload = decodeSegment(parts[1], 'payload')
  const signature = Buffer.from(parts[2], 'base64url')
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new IdTokenError('ID token header is not an object', 'ID_TOKEN_MALFORMED')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new IdTokenError('ID token payload is not an object', 'ID_TOKEN_MALFORMED')
  }
  if (header.crit !== undefined || header.b64 !== undefined) {
    throw new IdTokenError('ID token uses an unsupported JWS header', 'ID_TOKEN_MALFORMED')
  }
  if (typeof header.alg !== 'string' || !ALGORITHMS.has(header.alg)) {
    throw new IdTokenError('ID token uses an unsupported signature algorithm', 'ID_TOKEN_ALG')
  }
  if (header.kid !== undefined && !isNonEmptyString(header.kid)) {
    throw new IdTokenError('ID token header kid is empty', 'ID_TOKEN_MALFORMED')
  }
  return { header, payload, signature, signed: Buffer.from(`${parts[0]}.${parts[1]}`) }
}

function audienceMatches(audience, clientId) {
  if (typeof audience === 'string') return audience === clientId
  if (Array.isArray(audience)) return audience.some((item) => item === clientId)
  return false
}


/** JWT ECDSA signatures are raw r||s; Node's verifier expects DER. */
function derEcdsaSignature(signature, alg) {
  const size = alg === 'ES256' ? 32 : alg === 'ES384' ? 48 : alg === 'ES512' ? 66 : 0
  if (size === 0 || signature.length !== size * 2) return signature
  const encodeInteger = (value) => {
    let offset = 0
    while (offset < value.length - 1 && value[offset] === 0) offset += 1
    let bytes = value.subarray(offset)
    if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes])
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes])
  }
  const r = encodeInteger(signature.subarray(0, size))
  const s = encodeInteger(signature.subarray(size))
  const body = Buffer.concat([r, s])
  const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length])
  return Buffer.concat([Buffer.from([0x30]), length, body])
}

function normalizeKey(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return undefined
  if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') return undefined
  if (jwk.use !== undefined && jwk.use !== 'sig') return undefined
  if (jwk.key_ops !== undefined && Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) return undefined
  try {
    return createPublicKey({ key: jwk, format: 'jwk' })
  } catch {
    return undefined
  }
}

function keyMatches(jwk, header) {
  if (jwk.kid !== undefined && jwk.kid !== header.kid) return false
  if (jwk.alg !== undefined && jwk.alg !== header.alg) return false
  return true
}

/**
 * Verify the ID token against the issuer's live discovery document and JWKS.
 *
 * The discovery and key-set caches are intentionally owned by one verifier
 * instance: a plugin restart re-reads them rather than trusting browser or
 * process state. Unknown kids force one cache refresh, which is what makes
 * normal key rotation work without turning a bad token into an unbounded
 * network loop.
 */
export class IdTokenVerifier {
  #fetch
  #now
  #discoveryUrl
  #discoveryTtlMs
  #jwksTtlMs
  #timeoutMs
  #discoveryCache
  #jwksCache
  #discoveryInflight
  #jwksInflight

  constructor(options = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#now = options.now ?? Date.now
    this.#discoveryUrl = options.discoveryUrl ?? DISCOVERY_URL
    this.#discoveryTtlMs = options.discoveryTtlMs ?? DISCOVERY_TTL_MS
    this.#jwksTtlMs = options.jwksTtlMs ?? JWKS_TTL_MS
    this.#timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS
    if (typeof this.#fetch !== 'function') throw new TypeError('IdTokenVerifier needs fetch')
  }

  async #fetchJson(url, signal) {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new IdTokenError('OpenID discovery request failed', 'DISCOVERY_TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      throw new IdTokenError('OpenID discovery request was rejected', 'DISCOVERY_HTTP', {
        status: response.status,
      })
    }
    const text = await response.text()
    const parsed = safeJsonParse(text)
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      throw new IdTokenError('OpenID discovery document is not JSON', 'DISCOVERY_MALFORMED')
    }
    return parsed.value
  }

  /** Read the issuer metadata, caching it for one hour. */
  async discover(options = {}) {
    const now = this.#now()
    if (!options.force && this.#discoveryCache && this.#discoveryCache.expiresAt > now) {
      return this.#discoveryCache.value
    }
    if (this.#discoveryInflight !== undefined) return this.#discoveryInflight
    this.#discoveryInflight = (async () => {
      const document = await this.#fetchJson(this.#discoveryUrl, options.signal)
      if (!isNonEmptyString(document.issuer)) {
        throw new IdTokenError('OpenID discovery has no issuer', 'DISCOVERY_MALFORMED')
      }
      if (!isNonEmptyString(document.jwks_uri)) {
        throw new IdTokenError('OpenID discovery has no jwks_uri', 'DISCOVERY_MALFORMED')
      }
      if (document.revocation_endpoint !== undefined && !isNonEmptyString(document.revocation_endpoint)) {
        throw new IdTokenError('OpenID discovery revocation_endpoint is invalid', 'DISCOVERY_MALFORMED')
      }
      const value = {
        issuer: document.issuer,
        jwksUri: document.jwks_uri,
        revocationEndpoint: document.revocation_endpoint,
      }
      this.#discoveryCache = { value, expiresAt: this.#now() + this.#discoveryTtlMs }
      return value
    })().finally(() => {
      this.#discoveryInflight = undefined
    })
    return this.#discoveryInflight
  }

  async #jwks(discovery, options = {}) {
    const now = this.#now()
    if (!options.force && this.#jwksCache && this.#jwksCache.expiresAt > now) {
      return this.#jwksCache.value
    }
    if (this.#jwksInflight !== undefined) return this.#jwksInflight
    this.#jwksInflight = (async () => {
      const document = await this.#fetchJson(discovery.jwksUri, options.signal)
      if (!Array.isArray(document.keys)) {
        throw new IdTokenError('JWKS document has no keys array', 'JWKS_MALFORMED')
      }
      const keys = document.keys.filter((jwk) => normalizeKey(jwk) !== undefined)
      if (keys.length === 0) throw new IdTokenError('JWKS document has no usable keys', 'JWKS_MALFORMED')
      this.#jwksCache = { value: keys, expiresAt: this.#now() + this.#jwksTtlMs }
      return keys
    })().finally(() => {
      this.#jwksInflight = undefined
    })
    return this.#jwksInflight
  }

  async #verifySignature(jwt, discovery, options) {
    let keys = await this.#jwks(discovery, options)
    const candidates = keys.filter((jwk) => keyMatches(jwk, jwt.header))
    const tryCandidates = () => {
      for (const jwk of candidates) {
        const key = normalizeKey(jwk)
        if (key === undefined) continue
        try {
          const signature = jwt.header.alg.startsWith('ES')
            ? derEcdsaSignature(jwt.signature, jwt.header.alg)
            : jwt.signature
          if (cryptoVerify(ALGORITHMS.get(jwt.header.alg), jwt.signed, key, signature)) return true
        } catch {
          // A structurally valid but incompatible key simply does not verify.
        }
      }
      return false
    }
    if (tryCandidates()) return
    // One refresh handles ordinary key rotation; a second failure is final.
    if (!options.force) {
      keys = await this.#jwks(discovery, { ...options, force: true })
      const refreshed = keys.filter((jwk) => keyMatches(jwk, jwt.header))
      for (const jwk of refreshed) {
        const key = normalizeKey(jwk)
        if (key === undefined) continue
        try {
          const signature = jwt.header.alg.startsWith('ES')
            ? derEcdsaSignature(jwt.signature, jwt.header.alg)
            : jwt.signature
          if (cryptoVerify(ALGORITHMS.get(jwt.header.alg), jwt.signed, key, signature)) return
        } catch {
          // fall through to the final rejection
        }
      }
    }
    throw new IdTokenError('ID token signature is invalid', 'ID_TOKEN_SIGNATURE')
  }

  /**
   * @param {string} token compact JWS
   * @param {object} expected
   * @param {string} expected.clientId issued client id (JWT audience)
   * @param {string} expected.nonce exact nonce sent in the authorize request
   * @param {string} [expected.subject] required subject for re-authorization
   * @param {AbortSignal} [expected.signal]
   */
  async verify(token, expected) {
    if (!isNonEmptyString(expected?.clientId)) {
      throw new IdTokenError('ID token verification needs the issued client id', 'ID_TOKEN_EXPECTATION')
    }
    if (!isNonEmptyString(expected?.nonce)) {
      throw new IdTokenError('ID token verification needs the attempt nonce', 'ID_TOKEN_EXPECTATION')
    }
    const jwt = parseJwt(token)
    const discovery = await this.discover({ signal: expected.signal })
    await this.#verifySignature(jwt, discovery, { signal: expected.signal })

    const payload = jwt.payload
    const now = Math.floor(this.#now() / 1000)
    if (payload.iss !== discovery.issuer) {
      throw new IdTokenError('ID token issuer does not match discovery', 'ID_TOKEN_ISSUER')
    }
    if (!audienceMatches(payload.aud, expected.clientId)) {
      throw new IdTokenError('ID token audience does not match the issued client id', 'ID_TOKEN_AUDIENCE')
    }
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw new IdTokenError('ID token has no expiry', 'ID_TOKEN_EXPIRY')
    }
    if (payload.exp + CLOCK_TOLERANCE_SECONDS < now) {
      throw new IdTokenError('ID token has expired', 'ID_TOKEN_EXPIRED')
    }
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
      throw new IdTokenError('ID token has no issued-at time', 'ID_TOKEN_ISSUED_AT')
    }
    if (payload.iat - CLOCK_TOLERANCE_SECONDS > now) {
      throw new IdTokenError('ID token issued-at time is in the future', 'ID_TOKEN_ISSUED_AT')
    }
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)) {
        throw new IdTokenError('ID token has an invalid not-before time', 'ID_TOKEN_NBF')
      }
      if (payload.nbf - CLOCK_TOLERANCE_SECONDS > now) {
        throw new IdTokenError('ID token is not valid yet', 'ID_TOKEN_NBF')
      }
    }
    if (typeof payload.nonce !== 'string' || payload.nonce !== expected.nonce) {
      throw new IdTokenError('ID token nonce does not match this attempt', 'ID_TOKEN_NONCE')
    }
    if (!isNonEmptyString(payload.sub)) {
      throw new IdTokenError('ID token has no subject', 'ID_TOKEN_SUBJECT')
    }
    if (payload.sid !== undefined && !isNonEmptyString(payload.sid)) {
      throw new IdTokenError('ID token session id is not a non-empty string', 'ID_TOKEN_SID')
    }
    if (payload.email !== undefined && payload.email !== null && !isNonEmptyString(payload.email)) {
      throw new IdTokenError('ID token email is not a non-empty string', 'ID_TOKEN_EMAIL')
    }
    if (expected.subject !== undefined && payload.sub !== expected.subject) {
      throw new IdTokenError('ID token subject does not match the account being re-authorized', 'ID_TOKEN_SUBJECT_MISMATCH')
    }
    if (Array.isArray(payload.aud) && payload.azp !== undefined && payload.azp !== expected.clientId) {
      throw new IdTokenError('ID token authorized party does not match the issued client id', 'ID_TOKEN_AZP')
    }

    return {
      claims: payload,
      subject: payload.sub,
      sid: payload.sid,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      issuer: payload.iss,
      audience: expected.clientId,
      expiresAt: payload.exp * 1000,
      issuedAt: payload.iat * 1000,
    }
  }
}

export { parseJwt as __parseJwtForTests }
