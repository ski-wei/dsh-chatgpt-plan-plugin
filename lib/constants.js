/**
 * Fixed facts of the ChatGPT-plan route.
 *
 * Everything here is a public contract documented by OpenAI. Nothing in this
 * file may be overridden from plugin configuration: changing an endpoint,
 * scope, resource, or redirect path would silently change the billing and
 * consent path, which is exactly what this provider must not do.
 */

export const PROVIDER_ID = 'openai-chatgpt-plan'
export const PROVIDER_NAME = 'ChatGPT Plan'
export const CREDENTIAL_SCOPE = 'openai-chatgpt-plan'

/** Credential-record ids. Both are lowercase hyphenated identifiers. */
export const STATE_RECORD_ID = 'state'
export const AUTH_RECEIPT_RECORD_ID = 'auth'

export const AUTH_ORIGIN = 'https://auth.openai.com'
export const DISCOVERY_URL = `${AUTH_ORIGIN}/.well-known/openid-configuration`
export const AUTHORIZE_URL = `${AUTH_ORIGIN}/api/accounts/authorize`
export const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`

export const API_ORIGIN = 'https://api.openai.com'
export const API_BASE_URL = `${API_ORIGIN}/v1`
export const MODELS_URL = `${API_BASE_URL}/models`
export const RESPONSES_URL = `${API_BASE_URL}/responses`
export const RESOURCE = API_BASE_URL

/** The official open-source registration placeholder. Never stored as an issued id. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'

export const SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
])

/** Only a token whose actual response scope contains this may use the plan route. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'

export const REDIRECT_PATH = '/auth/callback'
export const CALLBACK_HOST = '127.0.0.1'

export const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000
export const OAUTH_ABORT_GRACE_MS = 5 * 1000
export const MAX_PENDING_LOGINS = 4
export const START_RATE_LIMIT = 10
export const START_RATE_WINDOW_MS = 60 * 1000

export const ACCESS_REFRESH_SKEW_MS = 3 * 60 * 1000
export const DEFAULT_ACCESS_TTL_MS = 60 * 60 * 1000
export const REFRESH_TIMEOUT_MS = 30 * 1000
export const TOKEN_TIMEOUT_MS = 30 * 1000
export const REVOKE_TIMEOUT_MS = 10 * 1000
export const DISCOVERY_TIMEOUT_MS = 15 * 1000
export const CATALOG_TIMEOUT_MS = 20 * 1000

export const CATALOG_TTL_MS = 5 * 60 * 1000
export const DEFAULT_CONTEXT_WINDOW = 272000
export const DEFAULT_MAX_TOKENS = 128000

export const REQUEST_TIMEOUT_MS = 120 * 1000
export const STREAM_IDLE_TIMEOUT_MS = 120 * 1000

export const USER_AGENT_PRODUCT = 'deepseek-harness'

/** Refresh errors that mean the grant is gone and the account must sign in again. */
export const REAUTH_REFRESH_CODES = Object.freeze([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

export const RETRYABLE_HTTP_STATUS = Object.freeze([408, 425, 429, 500, 502, 503, 504])
