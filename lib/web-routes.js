import { CALLBACK_HOST, REDIRECT_PATH, START_RATE_LIMIT, START_RATE_WINDOW_MS } from './constants.js'
import { ChatGptPlanError, publicErrorMessage } from './errors.js'
import {
  contentTypeIsJson,
  escapeHtml,
  readJsonBody,
  sendHtml,
  sendJson,
} from './util.js'

function routeErrorStatus(error) {
  if (error instanceof ChatGptPlanError && typeof error.status === 'number') return error.status
  return 400
}

function callbackPage(result, origin) {
  const ok = result.ok === true
  const title = ok ? 'Signed in' : 'Sign-in did not complete'
  const color = ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)'
  const back = origin === undefined ? '/' : `${origin}/settings/models`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--dsw-alias-bg-base, #111); color: var(--dsw-alias-label-primary, #eee); font: 15px/1.5 system-ui, sans-serif; }
main { width: min(28rem, calc(100vw - 3rem)); padding: 1.5rem; border: 1px solid var(--dsw-alias-border-l1, #333); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #1b1b1b); }
h1 { margin: 0 0 .5rem; font-size: 1.15rem; color: ${color}; }
p { margin: 0 0 1rem; color: var(--dsw-alias-label-secondary, #aaa); }
a { color: var(--dsw-alias-brand-primary, #69b9ff); }
code { color: var(--dsw-alias-label-primary, #eee); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(result.message ?? '')}</p>
<p><a href="${escapeHtml(back)}">Return to DSH</a></p>
${ok ? '<script>setTimeout(function(){window.close()},300)</script>' : ''}
</main>
</body>
</html>`
}

/**
 * Host HTTP routes for sign-in, status, account switching, and sign-out.
 *
 * Every mutating route requires the exact same origin and a JSON body. The
 * callback is an exact loopback route because that is the only redirect the
 * official registration permits; a collision disables sign-in instead of
 * silently changing the path.
 */
export function createWebRoutes(options) {
  const { webServer, coordinator, accounts, getStatus, onAccountsChanged, logger, runtime } = options
  if (!webServer) throw new TypeError('createWebRoutes needs webServer')
  if (!coordinator) throw new TypeError('createWebRoutes needs coordinator')
  if (!accounts) throw new TypeError('createWebRoutes needs accounts')
  const state = runtime ?? { callbackAvailable: true, loginAvailable: true }
  const starts = []
  let origin
  let originError

  try {
    origin = new URL(webServer.getOrigin()).origin
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' || parsed.hostname !== CALLBACK_HOST) {
      state.loginAvailable = false
      state.callbackAvailable = false
      originError = 'Sign in requires the loopback HTTP Web origin'
    } else {
      state.loginAvailable = true
    }
  } catch (error) {
    state.loginAvailable = false
    state.callbackAvailable = false
    originError = 'The Web origin is unavailable'
  }

  const checkOrigin = (req, res) => {
    if (origin === undefined || req.headers.origin !== origin) {
      sendJson(res, 403, { error: 'origin_rejected' })
      return false
    }
    return true
  }

  const requireJson = (req, res) => {
    if (!contentTypeIsJson(req)) {
      sendJson(res, 415, { error: 'json_required' })
      return false
    }
    return true
  }

  const rateLimited = () => {
    const now = Date.now()
    while (starts.length > 0 && now - starts[0] > START_RATE_WINDOW_MS) starts.shift()
    if (starts.length >= START_RATE_LIMIT) return true
    starts.push(now)
    return false
  }

  const status = async () => {
    const value = await getStatus()
    return {
      signedIn: value.signedIn === true,
      activeAccountId: value.activeAccountId,
      accounts: Array.isArray(value.accounts)
        ? value.accounts.map((account) => ({
            id: account.id,
            label: account.label,
            email: account.email,
            planEnabled: account.planEnabled === true,
            reauthRequired: account.reauthRequired === true,
            expiresAt: account.expiresAt,
          }))
        : [],
      providerRegistered: value.providerRegistered === true,
      modelCount: Number.isSafeInteger(value.modelCount) ? value.modelCount : 0,
      callbackAvailable: state.callbackAvailable === true && state.loginAvailable === true,
      loginPending: value.loginPending === true,
      ...(value.lastError === undefined ? {} : { lastError: value.lastError }),
    }
  }

  const handlers = {
    async status(req, res) {
      sendJson(res, 200, await status())
    },

    async start(req, res) {
      if (!checkOrigin(req, res)) return
      if (!requireJson(req, res)) return
      if (state.callbackAvailable !== true || state.loginAvailable !== true) {
        sendJson(res, 503, { error: 'login_unavailable', message: originError ?? 'Sign in is unavailable' })
        return
      }
      if (rateLimited()) {
        sendJson(res, 429, { error: 'rate_limited' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, routeErrorStatus(error), { error: error.code ?? 'invalid_request' })
        return
      }
      if (body.newAccount === true && body.accountId !== undefined) {
        sendJson(res, 400, { error: 'new_account_conflicts_with_account_id' })
        return
      }
      if (body.accountId !== undefined && typeof body.accountId !== 'string') {
        sendJson(res, 400, { error: 'invalid_account_id' })
        return
      }
      if (body.newAccount !== undefined && typeof body.newAccount !== 'boolean') {
        sendJson(res, 400, { error: 'invalid_new_account' })
        return
      }
      try {
        const result = await coordinator.start(body, { origin })
        sendJson(res, 200, result)
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : error instanceof ChatGptPlanError ? error.code : 'OAUTH_FAILED'
        const httpStatus =
          code === 'ACCOUNT_NOT_FOUND'
            ? 404
            : code === 'LOGIN_IN_PROGRESS' || code === 'TOO_MANY_PENDING' || code === 'ALREADY_IN_FLIGHT'
              ? 409
              : 400
        if (logger?.warn) logger.warn('openai-chatgpt-plan: sign-in start failed (%s)', code)
        sendJson(res, httpStatus, { error: code, message: publicErrorMessage(error) })
      }
    },

    async callback(req, res) {
      let query
      try {
        query = new URL(req.url, origin ?? `http://${CALLBACK_HOST}`).searchParams
      } catch {
        sendHtml(res, 400, callbackPage({ ok: false, message: 'The callback URL is invalid.' }, origin))
        return
      }
      let result
      try {
        result = await coordinator.completeCallback({
          state: query.get('state') ?? undefined,
          code: query.get('code') ?? undefined,
          error: query.get('error') ?? undefined,
          error_description: query.get('error_description') ?? undefined,
          client_id: query.get('client_id') ?? undefined,
        })
      } catch (error) {
        result = { ok: false, status: 400, code: 'CALLBACK_FAILED', message: publicErrorMessage(error) }
      }
      sendHtml(res, result.status ?? 400, callbackPage(result, origin))
    },

    async signout(req, res) {
      if (!checkOrigin(req, res)) return
      if (!requireJson(req, res)) return
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, routeErrorStatus(error), { error: error.code ?? 'invalid_request' })
        return
      }
      let accountId = body.accountId
      if (accountId === undefined) {
        const current = await status()
        accountId = current.activeAccountId
      }
      if (typeof accountId !== 'string') {
        sendJson(res, 400, { error: 'account_required' })
        return
      }
      try {
        const result = await accounts.signOut(accountId)
        await onAccountsChanged?.()
        sendJson(res, 200, { ...(await status()), remoteRevoked: result.remoteRevoked === true, ...(result.revokeError === undefined ? {} : { revokeError: result.revokeError }) })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : error instanceof ChatGptPlanError ? error.code : 'SIGNOUT_FAILED'
        sendJson(res, code === 'ACCOUNT_NOT_FOUND' ? 404 : 500, { error: code, message: publicErrorMessage(error) })
      }
    },

    async select(req, res) {
      if (!checkOrigin(req, res)) return
      if (!requireJson(req, res)) return
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, routeErrorStatus(error), { error: error.code ?? 'invalid_request' })
        return
      }
      if (typeof body.accountId !== 'string') {
        sendJson(res, 400, { error: 'account_required' })
        return
      }
      try {
        await accounts.selectAccount(body.accountId)
        await onAccountsChanged?.()
        sendJson(res, 200, await status())
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : error instanceof ChatGptPlanError ? error.code : 'SELECT_FAILED'
        sendJson(res, code === 'ACCOUNT_NOT_FOUND' ? 404 : 400, { error: code, message: publicErrorMessage(error) })
      }
    },

    async cancel(req, res) {
      if (!checkOrigin(req, res)) return
      if (!requireJson(req, res)) return
      await coordinator.cancelAll('cancelled')
      sendJson(res, 200, await status())
    },
  }

  const register = () => {
    const disposers = []
    disposers.push(webServer.register({ kind: 'exact', path: '/chatgpt-plan/status', handler: handlers.status }))
    disposers.push(webServer.register({ kind: 'exact', path: '/chatgpt-plan/start', handler: handlers.start }))
    disposers.push(webServer.register({ kind: 'exact', path: '/chatgpt-plan/signout', handler: handlers.signout }))
    disposers.push(webServer.register({ kind: 'exact', path: '/chatgpt-plan/select', handler: handlers.select }))
    disposers.push(webServer.register({ kind: 'exact', path: '/chatgpt-plan/cancel', handler: handlers.cancel }))
    if (state.loginAvailable === true) {
      try {
        disposers.push(webServer.register({ kind: 'exact', path: REDIRECT_PATH, handler: handlers.callback }))
        state.callbackAvailable = true
      } catch (error) {
        state.callbackAvailable = false
        if (logger?.warn) logger.warn('openai-chatgpt-plan: %s is already registered; sign-in is disabled', REDIRECT_PATH)
      }
    } else {
      state.callbackAvailable = false
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // already released
        }
      }
    }
  }

  return { register, handlers, state, origin: () => origin }
}

export { callbackPage as __callbackPageForTests }
