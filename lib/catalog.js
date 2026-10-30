import {
  CATALOG_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  MODELS_URL,
} from './constants.js'
import { ChatGptPlanError, authError } from './errors.js'
import { providerRequestId, safeJsonParse } from './util.js'

/**
 * Models verified against the plan route's request shape:
 * reasoning models that accept a developer message and `additional_tools`.
 * A slug outside this table is hidden unless the operator explicitly allows
 * unknown models; even then tools are refused because their wire capability
 * has not been verified.
 */
const MODEL_RULES = Object.freeze([
  { test: /^gpt-5\.4(?:$|-)/u, contextWindow: 272000, maxTokens: 128000 },
  { test: /^gpt-5\.5(?:$|-)/u, contextWindow: 272000, maxTokens: 128000 },
  { test: /^gpt-5\.6(?:$|-)/u, contextWindow: 272000, maxTokens: 128000 },
  { test: /^gpt-6(?:$|\.|-)/u, contextWindow: 272000, maxTokens: 128000 },
])

const REASONING_EFFORTS = Object.freeze([
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
])

function ruleFor(modelId) {
  return MODEL_RULES.find((rule) => rule.test.test(modelId))
}

function modelFromWire(item, config) {
  const id = typeof item.slug === 'string' ? item.slug : typeof item.id === 'string' ? item.id : undefined
  if (id === undefined || id.length === 0) return undefined
  if (item.visibility !== undefined && item.visibility !== 'list') return undefined
  const rule = ruleFor(id)
  if (rule === undefined && config.allowUnknownModels !== true) return undefined
  const name =
    (typeof item.display_name === 'string' && item.display_name.length > 0 ? item.display_name : undefined) ??
    (typeof item.name === 'string' && item.name.length > 0 ? item.name : undefined) ??
    id
  return {
    id,
    name,
    known: rule !== undefined,
    contextWindow: rule?.contextWindow ?? config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: rule?.maxTokens ?? config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    inputModalities: ['text'],
    reasoning: rule !== undefined,
    efforts: rule === undefined ? [] : REASONING_EFFORTS,
  }
}

/**
 * Per-account model catalog.
 *
 * The list is fetched with the same account credential that will make the
 * inference request; it is never a hard-coded provider catalog. A 401 forces
 * one refresh and one replay, then marks the account for re-authorization.
 */
export class ModelCatalog {
  #fetch
  #now
  #config
  #accounts
  #logger
  #userAgent
  #cache = new Map()

  constructor(options) {
    if (!options?.accounts) throw new TypeError('ModelCatalog needs AccountStore')
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#now = options.now ?? Date.now
    this.#config = options.config ?? {}
    this.#accounts = options.accounts
    this.#logger = options.logger
    this.#userAgent = options.userAgent ?? 'deepseek-harness-chatgpt-plan/0.1.0'
    if (typeof this.#fetch !== 'function') throw new TypeError('ModelCatalog needs fetch')
  }

  invalidate(accountId) {
    if (accountId === undefined) this.#cache.clear()
    else this.#cache.delete(accountId)
  }

  peek(accountId) {
    const cached = this.#cache.get(accountId)
    if (cached === undefined) return []
    return cached.models
  }

  async #requestModels(accountId, token, signal) {
    const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response
    try {
      response = await this.#fetch(MODELS_URL, {
        method: 'GET',
        redirect: 'error',
        signal: combined,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'user-agent': this.#userAgent,
        },
      })
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) {
        throw new ChatGptPlanError('Model catalog request timed out', 'TIMEOUT', { retryable: true, cause: error })
      }
      throw new ChatGptPlanError('Model catalog request failed', 'TRANSPORT', { retryable: true, cause: error })
    }
    const text = await response.text()
    return { response, text }
  }

  async getModels(account, options = {}) {
    const now = this.#now()
    const cached = this.#cache.get(account.id)
    if (options.force !== true && cached !== undefined && cached.expiresAt > now) return cached.models
    if (account.planEnabled !== true) {
      throw authError('This account does not have the ChatGPT-plan scope', 'PLAN_DISABLED')
    }

    let token = await this.#accounts.resolveAccessToken(account.id)
    let result = await this.#requestModels(account.id, token, options.signal)
    if (result.response.status === 401) {
      await this.#accounts.refreshAccount(account.id, { force: true })
      token = await this.#accounts.resolveAccessToken(account.id)
      result = await this.#requestModels(account.id, token, options.signal)
    }
    if (result.response.status === 401) {
      await this.#accounts.markReauth(account.id, 'catalog_unauthorized')
      throw authError('The model catalog rejected this account', 'AUTH', {
        status: 401,
        requestId: providerRequestId(result.response.headers),
      })
    }
    if (!result.response.ok) {
      throw new ChatGptPlanError('Model catalog request was rejected', 'CATALOG_HTTP', {
        status: result.response.status,
        requestId: providerRequestId(result.response.headers),
        retryable: result.response.status >= 500 || result.response.status === 429,
      })
    }
    const parsed = safeJsonParse(result.text)
    if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
      throw new ChatGptPlanError('Model catalog is not JSON', 'MALFORMED_RESPONSE')
    }
    const rows = Array.isArray(parsed.value.models)
      ? parsed.value.models
      : Array.isArray(parsed.value.data)
        ? parsed.value.data
        : undefined
    if (rows === undefined) {
      throw new ChatGptPlanError('Model catalog has no models array', 'MALFORMED_RESPONSE')
    }
    const seen = new Set()
    const models = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const model = modelFromWire(row, this.#config)
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    this.#cache.set(account.id, {
      models,
      fetchedAt: now,
      expiresAt: now + (this.#config.catalogTtlMs ?? 5 * 60 * 1000),
    })
    return models
  }

  capabilitiesFor(modelId) {
    for (const cached of this.#cache.values()) {
      const model = cached.models.find((candidate) => candidate.id === modelId)
      if (model !== undefined) {
        return {
          known: model.known === true,
          additionalTools: model.known === true,
          reasoning: model.known === true,
          efforts: model.efforts,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }
      }
    }
    return { known: false, additionalTools: false, reasoning: false, efforts: [] }
  }

  async listModels(provider) {
    try {
      const account = await this.#accounts.getActiveAccount()
      if (account === undefined || account.planEnabled !== true || account.reauthRequired === true) return []
      const models = await this.getModels(account)
      return models.map((model) => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: ['text'],
      }))
    } catch (error) {
      if (this.#logger !== undefined) {
        this.#logger.warn(
          'openai-chatgpt-plan: model catalog unavailable (%s)',
          error instanceof ChatGptPlanError ? error.code : 'UNKNOWN',
        )
      }
      return []
    }
  }

  async resolveModel(provider, modelId, signal) {
    const account = await this.#accounts.getActiveAccount()
    if (account === undefined) throw authError('No ChatGPT-plan account is signed in', 'MISSING_CREDENTIAL')
    if (account.planEnabled !== true) throw authError('This account does not have the ChatGPT-plan scope', 'PLAN_DISABLED')
    if (account.reauthRequired === true) throw authError('This ChatGPT-plan account must sign in again', 'REAUTH_REQUIRED')
    let models = await this.getModels(account, { signal })
    let model = models.find((candidate) => candidate.id === modelId)
    if (model === undefined) {
      models = await this.getModels(account, { force: true, signal })
      model = models.find((candidate) => candidate.id === modelId)
    }
    if (model === undefined) {
      throw new ChatGptPlanError(`Model "${modelId}" is not eligible on the ChatGPT-plan route`, 'UNKNOWN_MODEL')
    }
    return {
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ['text'],
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...(model.reasoning
        ? {
            reasoning: {
              efforts: model.efforts,
              defaultEffort: 'medium',
            },
          }
        : {}),
    }
  }
}

export { MODEL_RULES, modelFromWire as __modelFromWireForTests, REASONING_EFFORTS }
