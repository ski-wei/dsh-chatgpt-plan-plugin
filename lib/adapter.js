import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import {
  PROVIDER_NAME,
  REQUEST_TIMEOUT_MS,
  RESPONSES_URL,
  STREAM_IDLE_TIMEOUT_MS,
} from './constants.js'
import { ChatGptPlanError, authError, isAbortError } from './errors.js'
import { buildResponsesRequest } from './serializer.js'
import { parseSse } from './sse.js'
import { RequestErrorStore } from './request-errors.js'
import { headerValue, parseRetryAfter, providerRequestId, safeJsonParse } from './util.js'

const RETRYABLE_CODES = Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])

/** Human sentence for a provider-requested delay, with no untrusted text. */
function retryHint(retryAfterMs) {
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return 'Retry shortly.'
  return `Retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`
}

function failureOf(error) {
  if (error instanceof LlmError) return error.failure
  if (error instanceof ChatGptPlanError) {
    return {
      message: error.message,
      code: error.code,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(typeof error.requestId === 'string' ? { requestId: error.requestId } : {}),
      ...(typeof error.retryAfterMs === 'number' ? { providerRetryAfterMs: error.retryAfterMs } : {}),
    }
  }
  return { message: 'ChatGPT-plan request failed', code: 'INTERNAL' }
}

function toLlmError(error) {
  if (error instanceof LlmError) return error
  if (error instanceof ChatGptPlanError) {
    return new LlmError(error.message, error.code, {
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(typeof error.requestId === 'string' ? { requestId: error.requestId } : {}),
      ...(typeof error.retryAfterMs === 'number' ? { providerRetryAfterMs: error.retryAfterMs } : {}),
      cause: error,
    })
  }
  return error
}

function providerCodeOf(body) {
  if (body === null || typeof body !== 'object') return undefined
  if (typeof body.code === 'string') return body.code
  if (body.error && typeof body.error === 'object') {
    if (typeof body.error.code === 'string') return body.error.code
    if (typeof body.error.type === 'string') return body.error.type
  }
  if (typeof body.error === 'string') return body.error
  return undefined
}

function providerParamOf(body) {
  if (body === null || typeof body !== 'object') return undefined
  if (body.error && typeof body.error === 'object' && typeof body.error.param === 'string') return body.error.param
  if (typeof body.param === 'string') return body.param
  return undefined
}

function mapHttpFailure(status, body, headers) {
  const providerCode = providerCodeOf(body)
  const param = providerParamOf(body)
  const requestId = providerRequestId(headers)
  const retryAfterMs = parseRetryAfter(headerValue(headers, 'retry-after'))
  const suffix = providerCode === undefined ? '' : ` (${providerCode})`
  const paramSuffix = param === undefined ? '' : ` at ${param}`

  if (providerCode === 'subscription_sharing_user_not_eligible') {
    return new ChatGptPlanError(
      `This ChatGPT account is not eligible for the plan route${suffix}. Check the plan subscription or sign in with another account.`,
      'PLAN_INELIGIBLE',
      { status, providerCode, requestId },
    )
  }
  if (providerCode === 'subscription_sharing_usage_limit_exceeded') {
    return new ChatGptPlanError(
      `The ChatGPT plan usage limit was reached${suffix}. Wait for it to reset or check the plan.`,
      'QUOTA',
      { status, providerCode, requestId },
    )
  }
  if (providerCode === 'subscription_sharing_usage_unavailable') {
    return new ChatGptPlanError(
      `ChatGPT plan usage is temporarily unavailable${suffix}. ${retryHint(retryAfterMs)}`,
      'RATE_LIMIT',
      { status, providerCode, requestId, retryAfterMs, retryable: true },
    )
  }
  if (providerCode === 'subscription_sharing_unsupported_capability') {
    return new ChatGptPlanError(
      `The ChatGPT-plan route rejected this capability${suffix}${paramSuffix}.`,
      'INVALID_REQUEST',
      { status, providerCode, requestId },
    )
  }
  if (providerCode === 'subscription_sharing_route_not_supported') {
    return new ChatGptPlanError(
      `The ChatGPT-plan route is not supported${suffix}.`,
      'INVALID_REQUEST',
      { status, providerCode, requestId },
    )
  }
  if (providerCode === 'subscription_sharing_invalid_user') {
    return new ChatGptPlanError(
      `The ChatGPT account is no longer valid${suffix}. Sign in again from Settings → Models → ChatGPT Plan.`,
      'AUTH_REJECTED',
      { status, providerCode, requestId },
    )
  }
  if (status === 401) {
    return new ChatGptPlanError(
      'The ChatGPT plan credential was rejected. Sign in again from Settings → Models → ChatGPT Plan.',
      'AUTH_REJECTED',
      { status, providerCode, requestId },
    )
  }
  if (status === 403) {
    return new ChatGptPlanError(
      `The ChatGPT plan request was denied${suffix}. Check this account's plan entitlement.`,
      'AUTH_REJECTED',
      { status, providerCode, requestId },
    )
  }
  if (status === 404) {
    return new ChatGptPlanError('The ChatGPT-plan endpoint was not found.', 'INVALID_REQUEST', {
      status,
      providerCode,
      requestId,
    })
  }
  if (status === 400 || status === 413 || status === 422) {
    return new ChatGptPlanError(
      `The ChatGPT-plan request was rejected${suffix}${paramSuffix}.`,
      'INVALID_REQUEST',
      { status, providerCode, requestId },
    )
  }
  if (status === 429) {
    return new ChatGptPlanError(`The ChatGPT plan is rate limited. ${retryHint(retryAfterMs)}`, 'RATE_LIMIT', {
      status,
      providerCode,
      requestId,
      retryAfterMs,
      retryable: true,
    })
  }
  if (status >= 500) {
    return new ChatGptPlanError(
      `The ChatGPT plan service returned HTTP ${status}. ${retryHint(retryAfterMs)}`,
      'SERVER',
      { status, providerCode, requestId, retryAfterMs, retryable: true },
    )
  }
  return new ChatGptPlanError(`The ChatGPT-plan request failed with HTTP ${status}.`, `HTTP_${status}`, {
    status,
    providerCode,
    requestId,
    retryAfterMs,
  })
}

function usageOf(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const input = Number.isSafeInteger(raw.input_tokens) ? raw.input_tokens : 0
  const output = Number.isSafeInteger(raw.output_tokens) ? raw.output_tokens : 0
  const inputDetails = raw.input_tokens_details !== null && typeof raw.input_tokens_details === 'object'
    ? raw.input_tokens_details
    : undefined
  const outputDetails = raw.output_tokens_details !== null && typeof raw.output_tokens_details === 'object'
    ? raw.output_tokens_details
    : undefined
  const cached = Number.isSafeInteger(inputDetails?.cached_tokens) ? inputDetails.cached_tokens : 0
  const cacheWrite = Number.isSafeInteger(inputDetails?.cache_write_tokens) ? inputDetails.cache_write_tokens : 0
  const reasoning = Number.isSafeInteger(outputDetails?.reasoning_tokens) ? outputDetails.reasoning_tokens : 0
  return {
    inputTokens: Math.max(0, input - cached - cacheWrite),
    outputTokens: output,
    ...(Number.isSafeInteger(raw.total_tokens) ? { totalTokens: raw.total_tokens } : {}),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

const STREAM_FAILURE_CODES = Object.freeze({
  subscription_sharing_user_not_eligible: 'PLAN_INELIGIBLE',
  subscription_sharing_usage_limit_exceeded: 'QUOTA',
  subscription_sharing_usage_unavailable: 'RATE_LIMIT',
  subscription_sharing_unsupported_capability: 'INVALID_REQUEST',
  subscription_sharing_route_not_supported: 'INVALID_REQUEST',
  subscription_sharing_invalid_user: 'AUTH_REJECTED',
  rate_limit_exceeded: 'RATE_LIMIT',
  invalid_request_error: 'INVALID_REQUEST',
  authentication_error: 'AUTH_REJECTED',
})

const STREAM_FAILURE_HINTS = Object.freeze({
  PLAN_INELIGIBLE: 'Check the plan subscription or sign in with another account.',
  QUOTA: 'Wait for the plan usage limit to reset or check the plan.',
  AUTH_REJECTED: 'Sign in again from Settings → Models → ChatGPT Plan.',
  RATE_LIMIT: 'Retry shortly.',
})

function streamFailure(message, providerCode, requestId) {
  const code = providerCode === undefined ? 'SERVER' : STREAM_FAILURE_CODES[providerCode] ?? 'SERVER'
  const hint = STREAM_FAILURE_HINTS[code]
  return new ChatGptPlanError(hint === undefined ? message : `${message}. ${hint}`, code, {
    status: 200,
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(requestId === undefined ? {} : { requestId }),
  })
}

function isTerminalStatus(status) {
  return status === 'completed' || status === 'incomplete' || status === 'failed' || status === 'cancelled'
}

/**
 * One safe machine code for an unexpected transport failure. The raw message
 * may contain URLs or TLS details; the code is enough to tell a reset from a
 * certificate or DNS failure and is still safe to store in the session log.
 */
function transportCauseCode(error) {
  const candidates = [error?.cause?.code, error?.code, error?.cause?.name, error?.name]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/u.test(candidate)) return candidate
  }
  return undefined
}

/**
 * Native DSH model adapter for the ChatGPT-plan route.
 *
 * It speaks the Responses API directly instead of delegating to a Codex
 * process or to a generic OpenAI request builder: the request fields, tool
 * declaration shape, and attribution are exactly this route's contract.
 */
export class ChatGptPlanAdapter extends LlmAdapter {
  #accounts
  #catalog
  #config
  #logger
  #fetch
  #errors
  #warnedOmissions = new Set()

  constructor(options) {
    super()
    if (!options?.accounts) throw new TypeError('ChatGptPlanAdapter needs AccountStore')
    if (!options?.catalog) throw new TypeError('ChatGptPlanAdapter needs ModelCatalog')
    this.#accounts = options.accounts
    this.#catalog = options.catalog
    this.#config = options.config ?? {}
    this.#logger = options.logger
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#errors = options.errors ?? new RequestErrorStore()
    if (typeof this.#fetch !== 'function') throw new TypeError('ChatGptPlanAdapter needs fetch')
  }

  /** Last sanitized inference failure for the Models footer, or undefined. */
  get lastRequestError() {
    return this.#errors.get()
  }

  providerInfo(provider) {
    return { id: provider, name: this.#config.displayName ?? PROVIDER_NAME }
  }

  providerRetryPolicy(_provider) {
    return {
      mode: 'normal',
      // Network resets through a local proxy are often transient and cluster;
      // five attempts over roughly 15 s survive a short outage without making a
      // genuinely unreachable endpoint hang much longer than a request timeout.
      maxRetries: 4,
      retryableCodes: [...RETRYABLE_CODES],
      initialDelayMs: 1000,
      maxDelayMs: 15000,
      jitterRatio: 0.2,
    }
  }

  async listModels(provider) {
    return this.#catalog.listModels(provider)
  }

  async resolveModel(provider, model, signal) {
    try {
      return await this.#catalog.resolveModel(provider, model, signal)
    } catch (error) {
      throw toLlmError(error)
    }
  }

  #warnOmission(model, controls) {
    const key = `${model}:${controls.join(',')}`
    if (this.#warnedOmissions.has(key)) return
    this.#warnedOmissions.add(key)
    const message =
      `openai-chatgpt-plan: omitting unsupported request controls (${controls.join(', ')}) for "${model}"; ` +
      'the plan route does not accept them.'
    if (this.#logger?.warn) this.#logger.warn(message)
  }

  #sendRequest(token, body, signal) {
    return this.#fetch(RESPONSES_URL, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  async *stream(options) {
    const state = {
      settled: false,
      blocks: 0,
      toolCalls: 0,
      usageEmitted: false,
      aborted: false,
    }
    const abortController = new AbortController()
    let idleController
    let idleTimer
    let requestTimeout
    const cleanup = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      abortController.abort()
    }
    const resetIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => idleController?.abort(new DOMException('idle', 'TimeoutError')), this.#config.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS)
    }
    const isAborted = () => options.signal?.aborted === true || state.aborted

    try {
      if (isAborted()) {
        state.aborted = true
        state.settled = true
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'The ChatGPT-plan request was cancelled', code: 'ABORTED' } },
        }
        return
      }
      const account = await this.#accounts.getActiveAccount()
      if (account === undefined) throw authError('No ChatGPT plan account is signed in. Open Settings → Models → ChatGPT Plan and sign in.', 'MISSING_CREDENTIAL')
      if (account.planEnabled !== true) throw authError('This account lacks the ChatGPT plan scope. Sign in with an eligible account in Settings → Models → ChatGPT Plan.', 'PLAN_DISABLED')
      if (account.reauthRequired === true) throw authError('The ChatGPT plan sign-in expired. Reconnect it in Settings → Models → ChatGPT Plan.', 'REAUTH_REQUIRED')
      await this.#catalog.resolveModel(options.provider, options.model, options.signal)
      const capabilities = this.#catalog.capabilitiesFor(options.model)
      const built = buildResponsesRequest(options, { modelId: options.model, capabilities })
      if (built.omitted.length > 0) this.#warnOmission(options.model, built.omitted)

      let token = await this.#accounts.resolveAccessToken(account.id)
      idleController = new AbortController()
      resetIdle()
      requestTimeout = AbortSignal.timeout(this.#config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
      const combined = AbortSignal.any([
        options.signal ?? abortController.signal,
        abortController.signal,
        idleController.signal,
        requestTimeout,
      ])

      let response = await this.#sendRequest(token, built.body, combined)
      if (response.status === 401) {
        await this.#accounts.refreshAccount(account.id, { force: true })
        token = await this.#accounts.resolveAccessToken(account.id)
        response = await this.#sendRequest(token, built.body, combined)
      }
      if (!response.ok) {
        const text = await response.text()
        const parsed = safeJsonParse(text)
        const failure = mapHttpFailure(response.status, parsed.ok ? parsed.value : undefined, response.headers)
        if (failure.code === 'AUTH' || failure.code === 'AUTH_REJECTED') {
          await this.#accounts.markReauth(account.id, failure.providerCode ?? 'request_unauthorized')
        }
        throw failure
      }
      if (response.body === null) throw new ChatGptPlanError('The ChatGPT plan returned no response body. Retry.', 'EMPTY_RESPONSE')
      yield* this.#consume(response, options, state, resetIdle, combined)
    } catch (error) {
      if (state.settled) return
      const userAborted = options.signal?.aborted === true || state.aborted
      if (userAborted) {
        state.aborted = true
        state.settled = true
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'The ChatGPT-plan request was cancelled', code: 'ABORTED' } },
        }
        return
      }
      const timeout =
        idleController?.signal.aborted === true ||
        requestTimeout?.aborted === true
      if (timeout) {
        state.settled = true
        const failure = {
          message: 'The ChatGPT plan request timed out. Retry; if it persists, check the local proxy/VPN.',
          code: 'TIMEOUT',
        }
        this.#errors.record(failure)
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      if (isAbortError(error)) {
        state.aborted = true
        state.settled = true
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { message: 'The ChatGPT-plan request was cancelled', code: 'ABORTED' } },
        }
        return
      }
      state.settled = true
      const known = error instanceof ChatGptPlanError || error instanceof LlmError
      const cause = known ? undefined : transportCauseCode(error)
      if (!known && this.#logger?.warn) {
        this.#logger.warn('openai-chatgpt-plan: transport failure (%s)', cause ?? 'UNKNOWN')
      }
      const failure = known
        ? failureOf(error)
        : {
            message: `The ChatGPT-plan transport failed${cause === undefined ? '' : ` (${cause})`}. Check the local proxy/VPN and retry.`,
            code: 'TRANSPORT',
          }
      this.#errors.record({
        ...failure,
        ...(error instanceof ChatGptPlanError && typeof error.providerCode === 'string' ? { providerCode: error.providerCode } : {}),
        ...(typeof failure.providerRetryAfterMs === 'number' ? { retryAfterMs: failure.providerRetryAfterMs } : {}),
      })
      yield {
        type: 'finish',
        reason: { kind: 'error', failure },
      }
    } finally {
      cleanup()
    }
  }

  async *#consume(response, options, state, resetIdle, signal) {
    const slots = new Map()
    let nextIndex = 0
    let responseId
    let sawTerminal = false
    let terminalStatus
    let terminalResponse
    let lastError

    const ensureSlot = (outputIndex, item) => {
      if (slots.has(outputIndex)) return slots.get(outputIndex)
      const type = item?.type
      let kind
      if (type === 'message') kind = 'text'
      else if (type === 'reasoning') kind = 'reasoning'
      else if (type === 'function_call') kind = 'tool-call'
      else if (type === 'custom_tool_call') throw new ChatGptPlanError('Custom tools are not supported on this route', 'UNSUPPORTED_CONTENT')
      else return undefined
      const slot = {
        kind,
        index: nextIndex++,
        outputIndex,
        text: '',
        arguments: '',
        callId: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : undefined,
        name: typeof item.name === 'string' ? item.name : undefined,
        ended: false,
        started: false,
        sawDelta: false,
      }
      slots.set(outputIndex, slot)
      state.blocks += 1
      if (kind === 'tool-call') state.toolCalls += 1
      return slot
    }

    const startSlot = (slot) => {
      if (slot === undefined) return []
      if (slot.started === true) return []
      slot.started = true
      const chunks = [
        { type: 'block-start', index: slot.index, blockType: slot.kind === 'tool-call' ? 'tool-call' : slot.kind },
      ]
      if (slot.kind === 'tool-call') {
        if (typeof slot.callId !== 'string' || slot.callId.length === 0) {
          throw new ChatGptPlanError('A tool call arrived without a call id', 'MALFORMED_RESPONSE')
        }
        chunks.push({
          type: 'tool-call-delta',
          index: slot.index,
          id: slot.callId,
          ...(slot.name === undefined ? {} : { name: slot.name }),
          argumentsDelta: '',
        })
      }
      return chunks
    }

    const finalize = (outputIndex, item) => {
      const slot = slots.get(outputIndex) ?? ensureSlot(outputIndex, item)
      if (slot === undefined || slot.ended === true) return []
      if (slot.kind === 'reasoning') {
        // A reasoning item can arrive with no summary text at all. Resolve the
        // final text before announcing a block, and drop a genuinely empty one:
        // an empty reasoning card is noise, and a stream with only that item is
        // an empty response, not content.
        if (slot.text.length === 0 && item !== undefined) {
          slot.text = (item.summary ?? []).map((part) => part.text ?? '').join('\n\n') || (item.content ?? []).map((part) => part.text ?? '').join('\n\n')
        }
        if (slot.text.length === 0) {
          slot.ended = true
          slots.delete(outputIndex)
          if (slot.started !== true) {
            state.blocks -= 1
            return []
          }
          // Defensive only: a block announced before its text must still close.
          return [{ type: 'block-end', index: slot.index, block: { type: 'reasoning', text: '' } }]
        }
      }
      const chunks = []
      if (slot.started !== true) chunks.push(...startSlot(slot))
      slot.ended = true
      if (slot.kind === 'text') {
        if (slot.text.length === 0 && Array.isArray(item?.content)) {
          slot.text = item.content.map((part) => part.text ?? part.refusal ?? '').join('')
        }
        slots.delete(outputIndex)
        chunks.push({ type: 'block-end', index: slot.index, block: { type: 'text', text: slot.text } })
        return chunks
      }
      if (slot.kind === 'reasoning') {
        slots.delete(outputIndex)
        chunks.push({ type: 'block-end', index: slot.index, block: { type: 'reasoning', text: slot.text } })
        return chunks
      }
      if (slot.kind === 'tool-call') {
        if (typeof item?.arguments === 'string') {
          if (slot.arguments.length === 0) {
            slot.arguments = item.arguments
          } else if (item.arguments.startsWith(slot.arguments)) {
            const rest = item.arguments.slice(slot.arguments.length)
            slot.arguments = item.arguments
            if (rest.length > 0) {
              chunks.push({
                type: 'tool-call-delta',
                index: slot.index,
                id: slot.callId,
                ...(slot.name === undefined ? {} : { name: slot.name }),
                argumentsDelta: rest,
              })
            }
          } else if (item.arguments !== slot.arguments) {
            throw new ChatGptPlanError('Tool call argument fragments disagree with their terminal frame', 'MALFORMED_RESPONSE')
          }
        }
        if (typeof item?.call_id === 'string' && item.call_id.length > 0) slot.callId = item.call_id
        if (typeof item?.name === 'string' && item.name.length > 0) slot.name = item.name
        if (typeof slot.callId !== 'string' || slot.callId.length === 0 || typeof slot.name !== 'string' || slot.name.length === 0) {
          throw new ChatGptPlanError('A tool call is missing its call id or name', 'MALFORMED_RESPONSE')
        }
        try {
          const parsed = JSON.parse(slot.arguments.length === 0 ? '{}' : slot.arguments)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not an object')
          }
        } catch {
          throw new ChatGptPlanError('Tool call arguments are not a JSON object', 'MALFORMED_RESPONSE')
        }
        slots.delete(outputIndex)
        chunks.push({
          type: 'block-end',
          index: slot.index,
          block: { type: 'tool-call', id: slot.callId, name: slot.name, arguments: slot.arguments.length === 0 ? '{}' : slot.arguments },
        })
        return chunks
      }
      return chunks
    }

    try {
      for await (const frame of parseSse(response.body, {
        signal,
        onActivity: resetIdle,
      })) {
        if (frame.data === '[DONE]') break
        const parsed = safeJsonParse(frame.data)
        if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
          throw new ChatGptPlanError('The ChatGPT-plan SSE frame is not JSON', 'MALFORMED_RESPONSE')
        }
        const event = parsed.value
        const type = typeof event.type === 'string' ? event.type : frame.event
        if (type === 'response.created') {
          if (typeof event.response?.id === 'string') responseId = event.response.id
          continue
        }
        if (type === 'response.output_item.added') {
          const slot = ensureSlot(event.output_index, event.item)
          // Reasoning starts only when it has text; an item header alone must
          // not create an empty thinking block.
          if (slot !== undefined && slot.kind !== 'reasoning') {
            for (const chunk of startSlot(slot)) yield chunk
          }
          continue
        }
        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
          const slot = ensureSlot(event.output_index, { type: 'message' })
          if (slot === undefined) continue
          if (slot.ended === true) continue
          for (const chunk of startSlot(slot)) yield chunk
          const delta = typeof event.delta === 'string' ? event.delta : ''
          slot.text += delta
          slot.sawDelta = true
          yield { type: 'text-delta', index: slot.index, text: delta }
          continue
        }
        if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
          const delta = typeof event.delta === 'string' ? event.delta : ''
          if (delta.length === 0) continue
          const slot = ensureSlot(event.output_index, { type: 'reasoning' })
          if (slot === undefined || slot.ended === true) continue
          for (const chunk of startSlot(slot)) yield chunk
          slot.text += delta
          slot.sawDelta = true
          yield { type: 'reasoning-delta', index: slot.index, text: delta }
          continue
        }
        if (type === 'response.function_call_arguments.delta') {
          const slot = ensureSlot(event.output_index, { type: 'function_call' })
          if (slot === undefined || slot.ended === true) continue
          for (const chunk of startSlot(slot)) yield chunk
          const delta = typeof event.delta === 'string' ? event.delta : ''
          slot.arguments += delta
          slot.sawDelta = true
          yield {
            type: 'tool-call-delta',
            index: slot.index,
            id: slot.callId,
            ...(slot.name === undefined ? {} : { name: slot.name }),
            argumentsDelta: delta,
          }
          continue
        }
        if (type === 'response.function_call_arguments.done') {
          const slot = ensureSlot(event.output_index, { type: 'function_call' })
          if (slot === undefined || slot.ended === true) continue
          for (const chunk of startSlot(slot)) yield chunk
          const full = typeof event.arguments === 'string' ? event.arguments : undefined
          if (full !== undefined) {
            if (slot.arguments.length === 0) {
              slot.arguments = full
              if (full.length > 0) yield { type: 'tool-call-delta', index: slot.index, id: slot.callId, ...(slot.name === undefined ? {} : { name: slot.name }), argumentsDelta: full }
            } else if (full.startsWith(slot.arguments)) {
              const rest = full.slice(slot.arguments.length)
              slot.arguments = full
              if (rest.length > 0) yield { type: 'tool-call-delta', index: slot.index, id: slot.callId, ...(slot.name === undefined ? {} : { name: slot.name }), argumentsDelta: rest }
            } else if (full !== slot.arguments) {
              throw new ChatGptPlanError('Tool call argument fragments disagree with their terminal frame', 'MALFORMED_RESPONSE')
            }
          }
          continue
        }
        if (type === 'response.output_item.done') {
          for (const chunk of finalize(event.output_index, event.item)) yield chunk
          continue
        }
        if (type === 'response.completed' || type === 'response.incomplete') {
          sawTerminal = true
          terminalStatus = event.response?.status ?? (type === 'response.completed' ? 'completed' : 'incomplete')
          terminalResponse = event.response
          for (const [outputIndex, slot] of [...slots.entries()]) {
            const item = Array.isArray(terminalResponse?.output)
              ? (typeof slot.callId === 'string' && slot.callId.length > 0
                  ? terminalResponse.output.find((candidate) => candidate?.call_id === slot.callId || candidate?.id === slot.callId)
                  : undefined) ?? terminalResponse.output[outputIndex]
              : undefined
            for (const chunk of finalize(outputIndex, item)) yield chunk
          }
          if (terminalStatus === 'failed') {
            lastError = streamFailure('The ChatGPT-plan response failed', terminalResponse?.error?.code, responseId)
            break
          }
          const usage = usageOf(terminalResponse?.usage)
          if (usage !== undefined) {
            state.usageEmitted = true
            yield { type: 'usage', usage }
          }
          if (state.blocks === 0) throw new ChatGptPlanError('The ChatGPT plan returned no content. Retry.', 'EMPTY_RESPONSE')
          const incompleteReason = terminalResponse?.incomplete_details?.reason
          const reason =
            state.toolCalls > 0
              ? { kind: 'tool-calls' }
              : terminalStatus === 'incomplete' && incompleteReason === 'max_output_tokens'
                ? { kind: 'max-tokens' }
                : terminalStatus === 'incomplete'
                  ? { kind: 'error', failure: { message: `The ChatGPT plan response was incomplete (${String(incompleteReason ?? 'unknown')}). Retry.`, code: 'MALFORMED_RESPONSE' } }
                  : { kind: 'stop' }
          if (reason.kind === 'error') this.#errors.record(reason.failure)
          else this.#errors.clear()
          state.settled = true
          yield { type: 'finish', reason }
          return
        }
        if (type === 'response.failed') {
          sawTerminal = true
          terminalStatus = 'failed'
          terminalResponse = event.response
          const code = event.response?.error?.code ?? 'SERVER'
          lastError = streamFailure('The ChatGPT-plan response failed', code, responseId)
          break
        }
        if (type === 'error') {
          sawTerminal = true
          lastError = streamFailure(
            'The ChatGPT-plan stream reported an error',
            typeof event.code === 'string' ? event.code : undefined,
            responseId,
          )
          break
        }
        // Unknown events are ignored so a future additive stream event does not
        // break a working request.
      }
      if (lastError !== undefined) throw lastError
      if (!sawTerminal || !isTerminalStatus(terminalStatus)) {
        throw new ChatGptPlanError('The ChatGPT-plan stream ended before a terminal response event', 'STREAM_CLOSED')
      }
    } finally {
      for (const slot of slots.values()) {
        if (slot.kind === 'tool-call' && slot.arguments.length > 0) {
          try {
            JSON.parse(slot.arguments)
          } catch {
            // The caller receives the terminal stream error emitted by #stream.
          }
        }
      }
    }
  }
}
