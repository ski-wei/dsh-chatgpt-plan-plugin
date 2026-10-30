import { sign as cryptoSign } from 'node:crypto'
import { Readable } from 'node:stream'

export function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

export function jsonResponse(data, options = {}) {
  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
}

export function textResponse(text, options = {}) {
  return new Response(text, {
    status: options.status ?? 200,
    headers: { 'content-type': 'text/plain', ...(options.headers ?? {}) },
  })
}

export function sseResponse(events, options = {}) {
  const pieces = []
  for (const event of events) {
    if (typeof event === 'string') {
      pieces.push(event)
      continue
    }
    if (event.event !== undefined) pieces.push(`event: ${event.event}\n`)
    pieces.push(`data: ${JSON.stringify(event.data ?? event)}\n\n`)
  }
  const body = pieces.join('')
  const split = options.splitAt ?? []
  const chunks = []
  let offset = 0
  for (const point of split) {
    const end = Math.max(offset, Math.min(body.length, point))
    if (end > offset) chunks.push(body.slice(offset, end))
    offset = end
  }
  if (offset < body.length) chunks.push(body.slice(offset))
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: options.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(options.headers ?? {}) },
  })
}

export async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

export function makeClock(start = Date.now()) {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
    set: (value) => {
      now = value
    },
  }
}

export function fakeLogger() {
  const warnings = []
  return {
    warnings,
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    info: () => {},
    debug: () => {},
  }
}

function assertJsonValue(value, path = '$') {
  if (value === undefined) throw new TypeError(`undefined at ${path}`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`)
    return
  }
  throw new TypeError(`non-JSON value at ${path}`)
}

class SharedStore {
  constructor() {
    this.records = new Map()
    this.tail = Promise.resolve()
    this.notifications = []
  }

  run(task) {
    const next = this.tail.then(task, task)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

/** In-memory implementation of the public Credentials record half. */
export class MemoryCredentials {
  constructor(store = new SharedStore()) {
    this.store = store
  }

  async readRecord(key) {
    return this.store.run(() => structuredClone(this.store.records.get(String(key))))
  }

  async modifyRecord(key, mutate) {
    return this.store.run(async () => {
      const current = structuredClone(this.store.records.get(String(key)))
      const next = await mutate(current)
      if (next === undefined) return structuredClone(current)
      assertJsonValue(next, String(key))
      this.store.records.set(String(key), structuredClone(next))
      this.store.notifications.push(String(key))
      return structuredClone(next)
    })
  }

  async deleteRecord(key) {
    return this.store.run(() => {
      this.store.records.delete(String(key))
      this.store.notifications.push(String(key))
    })
  }

  async listRecords() {
    return this.store.run(() =>
      [...this.store.records.keys()].map((key) => ({
        key,
        kind: this.store.records.get(key)?.kind,
      })),
    )
  }

  async describeRecord(key) {
    return this.store.run(() => ({
      configured: this.store.records.has(String(key)),
      kind: this.store.records.get(String(key))?.kind,
      writable: true,
    }))
  }

  seed(key, record) {
    this.store.records.set(String(key), structuredClone(record))
  }
}

export class FakeAuthorization {
  constructor(credentials) {
    this.credentials = credentials
    this.flows = new Map()
    this.running = new Map()
    this.events = []
  }

  registerFlow(flow) {
    if (this.flows.has(flow.key)) {
      const error = new Error('DUPLICATE_FLOW')
      error.code = 'DUPLICATE_FLOW'
      throw error
    }
    this.flows.set(flow.key, flow)
    return () => this.flows.delete(flow.key)
  }

  list() {
    return [...this.flows.values()].map((flow) => ({
      key: flow.key,
      label: flow.label,
      methods: flow.methods,
      inFlight: this.running.has(flow.key),
    }))
  }

  describe(key) {
    return this.list().find((entry) => entry.key === key)
  }

  cancel(key) {
    this.running.get(key)?.controller.abort(new Error('cancelled'))
  }

  async begin(request) {
    const flow = this.flows.get(request.key)
    if (flow === undefined) throw new Error('NO_FLOW')
    if (this.running.has(request.key)) {
      const error = new Error('ALREADY_IN_FLIGHT')
      error.code = 'ALREADY_IN_FLIGHT'
      throw error
    }
    const method = request.method ?? flow.methods[0].id
    const controller = new AbortController()
    let committed = false
    const abandon = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abandon, { once: true })
    this.running.set(request.key, { controller })
    try {
      await flow.run({
        method,
        signal: controller.signal,
        commit: async (record) => {
          controller.signal.throwIfAborted()
          await this.credentials.modifyRecord(request.key, () => record)
          committed = true
        },
        notify: (notice) => request.interaction.notify(notice),
        prompt: (prompt) => request.interaction.prompt(prompt),
      })
      if (controller.signal.aborted) return { status: 'cancelled' }
      if (!committed) throw new Error('NOT_COMMITTED')
      this.events.push({ key: request.key, status: 'authorized' })
      return { status: 'authorized' }
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        this.events.push({ key: request.key, status: 'cancelled' })
        return { status: 'cancelled' }
      }
      this.events.push({ key: request.key, status: 'failed', error })
      throw error
    } finally {
      request.signal?.removeEventListener('abort', abandon)
      this.running.delete(request.key)
    }
  }
}

export function makeJwt(privateKey, claims, options = {}) {
  const header = { alg: options.alg ?? 'RS256', typ: 'JWT', ...(options.kid === undefined ? {} : { kid: options.kid }) }
  const encodedHeader = base64url(JSON.stringify(header))
  const encodedPayload = base64url(JSON.stringify(claims))
  const data = Buffer.from(`${encodedHeader}.${encodedPayload}`)
  const signature = cryptoSign(options.alg === 'ES256' ? 'sha256' : 'RSA-SHA256', data, privateKey)
  return `${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`
}

export function publicJwk(publicKey, kid, alg = 'RS256') {
  return { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg }
}

export function makeFetch(routes) {
  const calls = []
  const fetch = async (url, options = {}) => {
    const href = typeof url === 'string' ? url : url.url
    calls.push({ url: href, options, body: options.body })
    for (const [matcher, handler] of routes) {
      const matches = typeof matcher === 'string' ? href === matcher : matcher instanceof RegExp ? matcher.test(href) : matcher(href)
      if (matches) return handler(options, href)
    }
    throw new Error(`unexpected fetch: ${href}`)
  }
  fetch.calls = calls
  return fetch
}

export function makeWebServer(origin = 'http://127.0.0.1:3080') {
  const routes = new Map()
  return {
    getOrigin: () => origin,
    register(route) {
      const key = `${route.kind}:${route.path}`
      if (routes.has(key)) throw new Error(`duplicate route ${key}`)
      routes.set(key, route)
      return () => routes.delete(key)
    },
    registerUpgrade() {
      throw new Error('not used')
    },
    registerFallback() {
      throw new Error('not used')
    },
    routes,
  }
}

export function makeReq({ method = 'GET', url = '/', headers = {}, body = undefined } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

export function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(value = '') {
      this.body += value
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}
