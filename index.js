import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import {
  CREDENTIAL_SCOPE,
  PROVIDER_ID,
  PROVIDER_NAME,
} from './lib/constants.js'
import { normalizeConfig } from './lib/config.js'
import { IdTokenVerifier } from './lib/id-token.js'
import { OAuthClient } from './lib/oauth.js'
import { AccountStore } from './lib/accounts.js'
import { ModelCatalog } from './lib/catalog.js'
import { ChatGptPlanAdapter } from './lib/adapter.js'
import { OAuthCoordinator } from './lib/coordinator.js'
import { createWebRoutes } from './lib/web-routes.js'

export const name = 'openai-chatgpt-plan'
export const inject = ['llm', 'credentials']

/**
 * Host half of the ChatGPT-plan provider.
 *
 * DSH keeps the agent loop, tool execution, approval policy, session log, and
 * memory. This plugin contributes one LLM route, the account/credential flow,
 * the model catalog, and the small Models-footer HTTP surface.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (config.enabled !== true) return

  const runtime = { callbackAvailable: true, loginAvailable: true }
  const verifier = new IdTokenVerifier({
    fetchImpl: globalThis.fetch,
  })
  const oauth = new OAuthClient({
    fetchImpl: globalThis.fetch,
    verifier,
  })
  const accounts = new AccountStore({
    credentials: ctx.credentials,
    oauth,
    config,
  })
  const catalog = new ModelCatalog({
    accounts,
    config,
    logger: ctx.logger,
    userAgent: attributionHeaders()['user-agent'],
  })
  const adapter = new ChatGptPlanAdapter({
    accounts,
    catalog,
    config,
    logger: ctx.logger,
  })

  let registration
  let syncChain = Promise.resolve()
  let disposed = false

  const emitUpdated = () => {
    try {
      ctx.emit('llm/adapters-updated')
    } catch (error) {
      ctx.logger?.warn?.('openai-chatgpt-plan: adapter update notification failed (%s)', error.code ?? 'UNKNOWN')
    }
  }

  const doSync = async () => {
    if (disposed) return false
    let active
    try {
      active = await accounts.getActiveAccount()
    } catch (error) {
      ctx.logger?.warn?.('openai-chatgpt-plan: account state is unreadable (%s)', error.code ?? 'UNKNOWN')
      active = undefined
    }
    if (disposed) return false
    const shouldRegister = active !== undefined && active.planEnabled === true && active.reauthRequired !== true
    if (shouldRegister && registration === undefined) {
      registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
      emitUpdated()
    } else if (!shouldRegister && registration !== undefined) {
      const release = registration
      registration = undefined
      try {
        release()
      } catch {
        // The registry already released this fiber.
      }
      emitUpdated()
    }
    return shouldRegister
  }

  const syncRegistration = () => {
    syncChain = syncChain.then(doSync, doSync)
    return syncChain
  }

  const coordinator = new OAuthCoordinator({
    accounts,
    oauth,
    verifier,
    config,
    logger: ctx.logger,
    getAuthorization: () => ctx.get('authorization'),
    onAuthorized: async (account) => {
      catalog.invalidate(account.id)
      await syncRegistration()
    },
  })

  const getStatus = async () => {
    const accountStatus = await accounts.status()
    let modelCount = 0
    let active
    try {
      active = await accounts.getActiveAccount()
      if (active?.planEnabled === true) modelCount = catalog.peek(active.id).length
    } catch {
      active = undefined
    }
    const lastError =
      coordinator.lastError ??
      (accountStatus.stateError === undefined
        ? undefined
        : {
            code: accountStatus.stateError,
            message: 'Stored ChatGPT-plan account state is unreadable; it was not overwritten.',
          })
    return {
      signedIn: accountStatus.signedIn === true,
      activeAccountId: accountStatus.activeAccountId,
      accounts: accountStatus.accounts ?? [],
      providerRegistered: registration !== undefined,
      modelCount,
      callbackAvailable: runtime.callbackAvailable === true && runtime.loginAvailable === true,
      loginPending: coordinator.pendingCount() > 0,
      ...(lastError === undefined ? {} : { lastError }),
    }
  }

  const onAccountsChanged = async () => {
    catalog.invalidate()
    await syncRegistration()
    emitUpdated()
  }

  ctx.effect(() => {
    return () => {
      disposed = true
      coordinator.dispose()
      if (registration !== undefined) {
        const release = registration
        registration = undefined
        try {
          release()
        } catch {
          // already released
        }
      }
    }
  })

  ctx.on('credentials/record-updated', (key) => {
    try {
      if (credentialKeyScope(key) !== CREDENTIAL_SCOPE) return
    } catch {
      return
    }
    catalog.invalidate()
    // The event can fire during our own writes; coalesce a read-only sync.
    queueMicrotask(() => {
      syncRegistration().catch((error) => {
        ctx.logger?.warn?.('openai-chatgpt-plan: account sync failed (%s)', error.code ?? 'UNKNOWN')
      })
    })
  })

  ctx.inject(['webServer'], (child) => {
    const routes = createWebRoutes({
      webServer: child.webServer,
      coordinator,
      accounts,
      getStatus,
      onAccountsChanged,
      logger: ctx.logger,
      runtime,
    })
    child.effect(() => routes.register())
  })

  syncRegistration().catch((error) => {
    ctx.logger?.warn?.('openai-chatgpt-plan: initial account sync failed (%s)', error.code ?? 'UNKNOWN')
  })
}

export { PROVIDER_NAME }
