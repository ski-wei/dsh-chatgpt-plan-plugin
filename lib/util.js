import { createHash, randomBytes } from 'node:crypto'
import { ChatGptPlanError } from './errors.js'

export function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

export function sha256(value) {
  return createHash('sha256').update(value).digest()
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function randomHex(bytes = 8) {
  return randomBytes(bytes).toString('hex')
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function requireNonEmptyString(value, message) {
  if (!isNonEmptyString(value)) throw new ChatGptPlanError(message, 'INVALID_REQUEST')
  return value
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function nowSeconds(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000)
}

export function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
  }
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  const delayMs = date - Date.now()
  return delayMs > 0 ? delayMs : undefined
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Read a small JSON request body. The caller keeps the write path closed. */
export async function readJsonBody(req, limitBytes = 16 * 1024) {
  let total = 0
  const chunks = []
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += bytes.length
    if (total > limitBytes) {
      throw new ChatGptPlanError('request body is too large', 'REQUEST_TOO_LARGE', { status: 413 })
    }
    chunks.push(bytes)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = safeJsonParse(text)
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    throw new ChatGptPlanError('request body must be a JSON object', 'INVALID_JSON', { status: 400 })
  }
  return parsed.value
}

export function contentTypeIsJson(req) {
  const raw = req.headers?.['content-type']
  if (typeof raw !== 'string') return false
  return raw.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

export function sendHtml(res, status, html) {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(html)
}

export function headerValue(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : undefined
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string') return value
  }
  return undefined
}

export function providerRequestId(headers) {
  return (
    headerValue(headers, 'x-request-id') ??
    headerValue(headers, 'openai-request-id') ??
    headerValue(headers, 'request-id')
  )
}

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Remove undefined object properties before a strict JSON-value credential store write. */
export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value))
}
