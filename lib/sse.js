import { ChatGptPlanError, isAbortError } from './errors.js'

const MAX_FRAME_BYTES = 2 * 1024 * 1024

/**
 * Decode Server-Sent Events from a fetch body.
 *
 * The decoder is incremental: a UTF-8 sequence, a CRLF pair, or a JSON frame
 * may be split across arbitrary transport chunks. Complete frames are emitted
 * only at a blank line, with an unterminated final frame emitted at EOF for
 * servers that omit the trailing blank line.
 */
export async function* parseSse(body, options = {}) {
  if (body === null || typeof body.getReader !== 'function') {
    throw new ChatGptPlanError('Response has no readable SSE body', 'EMPTY_RESPONSE')
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const signal = options.signal
  const onActivity = options.onActivity
  const read = async () => {
    const pending = reader.read()
    if (signal === undefined) return pending
    if (signal.aborted) {
      pending.catch(() => {})
      throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([pending, aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  let buffer = ''
  let eventName
  let id
  let data = []

  const dispatch = () => {
    if (data.length === 0) {
      eventName = undefined
      id = undefined
      return undefined
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
      throw new ChatGptPlanError('SSE frame is too large', 'MALFORMED_RESPONSE')
    }
    const frame = {
      ...(eventName === undefined ? {} : { event: eventName }),
      ...(id === undefined ? {} : { id }),
      data: data.join('\n'),
    }
    eventName = undefined
    id = undefined
    data = []
    return frame
  }

  try {
    while (true) {
      if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const { value, done } = await read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_FRAME_BYTES) {
        throw new ChatGptPlanError('SSE frame is too large', 'MALFORMED_RESPONSE')
      }
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length === 0) {
          const frame = dispatch()
          if (frame !== undefined) yield frame
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let valueText = colon === -1 ? '' : line.slice(colon + 1)
        if (valueText.startsWith(' ')) valueText = valueText.slice(1)
        if (field === 'event') eventName = valueText
        else if (field === 'data') data.push(valueText)
        else if (field === 'id') id = valueText
        // `retry` is intentionally ignored: retry policy belongs to DSH.
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      let line = buffer
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length > 0 && !line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let valueText = colon === -1 ? '' : line.slice(colon + 1)
        if (valueText.startsWith(' ')) valueText = valueText.slice(1)
        if (field === 'event') eventName = valueText
        else if (field === 'data') data.push(valueText)
        else if (field === 'id') id = valueText
      }
    }
    const last = dispatch()
    if (last !== undefined) yield last
  } catch (error) {
    if (isAbortError(error) || signal?.aborted === true) {
      throw signal?.reason ?? new DOMException('Aborted', 'AbortError')
    }
    throw error
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The connection may already be closed.
    }
  }
}
