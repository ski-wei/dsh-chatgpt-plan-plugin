import {
  CATALOG_TTL_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  REQUEST_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
} from './constants.js'

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  displayName: 'ChatGPT Plan',
  agentNameHint: 'DeepSeek Harness',
  allowUnknownModels: false,
  catalogTtlMs: CATALOG_TTL_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
})

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Validate the non-secret policy config. Unknown keys are rejected so a typo
 * cannot silently fall back to the fixed official route.
 */
export function normalizeConfig(input) {
  if (input === undefined || input === null) return { ...DEFAULT_CONFIG }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('openai-chatgpt-plan: config must be an object')
  }
  const known = new Set(Object.keys(DEFAULT_CONFIG))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new Error(`openai-chatgpt-plan: unknown config key "${key}"`)
  }
  return {
    enabled: boolean(input.enabled, DEFAULT_CONFIG.enabled),
    displayName: nonEmptyString(input.displayName, DEFAULT_CONFIG.displayName),
    agentNameHint: nonEmptyString(input.agentNameHint, DEFAULT_CONFIG.agentNameHint),
    allowUnknownModels: boolean(input.allowUnknownModels, DEFAULT_CONFIG.allowUnknownModels),
    catalogTtlMs: positiveInteger(input.catalogTtlMs, DEFAULT_CONFIG.catalogTtlMs),
    requestTimeoutMs: positiveInteger(input.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs),
    streamIdleTimeoutMs: positiveInteger(input.streamIdleTimeoutMs, DEFAULT_CONFIG.streamIdleTimeoutMs),
    defaultContextWindow: positiveInteger(input.defaultContextWindow, DEFAULT_CONFIG.defaultContextWindow),
    defaultMaxTokens: positiveInteger(input.defaultMaxTokens, DEFAULT_CONFIG.defaultMaxTokens),
  }
}
