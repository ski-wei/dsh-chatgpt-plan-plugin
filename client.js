window.__ModuleLoader__.load({
  id: '@local/dsh-chatgpt-plan',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'openai-chatgpt-plan'

    const EN = {
      title: 'ChatGPT plan',
      description: 'Sign in with ChatGPT to use an eligible plan as a native DSH model provider.',
      loading: 'Loading account status…',
      signedOut: 'No ChatGPT plan account is connected.',
      continue: 'Continue with ChatGPT',
      addAccount: 'Add account',
      signInAgain: 'Sign in again',
      signOut: 'Sign out',
      cancel: 'Cancel sign-in',
      active: 'Active',
      use: 'Use',
      planReady: 'Plan route enabled',
      identityOnly: 'Signed in, but this account lacks the plan scope',
      reauth: 'Sign in again required',
      expires: 'Access expires',
      unknownExpiry: 'unknown',
      waiting: 'Complete the sign-in in the browser window…',
      popupBlocked: 'The browser blocked the sign-in window; continuing in this tab.',
      loginUnavailable: 'Sign-in is unavailable on this Web origin. The callback route may be occupied or the origin is not loopback HTTP.',
      signOutConfirm: 'Sign out this ChatGPT plan account?',
      remoteRevokeFailed: 'Signed out locally, but the remote revocation was not confirmed.',
      disconnected: 'Disconnected accounts',
      reconnect: 'Reconnect',
      reconnectHint: "Reconnect reuses this account's existing ChatGPT registration. Add account creates a new one.",
      signedOutAt: 'Signed out',
      error: 'Sign-in error',
      requestErrorTitle: 'Last ChatGPT Plan request failed',
      requestErrorQuota: 'The ChatGPT plan usage limit was reached. Wait for it to reset or check the plan.',
      requestErrorIneligible: 'This account is not eligible for the plan route. Check the plan or sign in with another account.',
      requestErrorAuth: 'The credential was rejected. Sign in again.',
      requestErrorReauth: 'The sign-in expired. Reconnect this account.',
      requestErrorPlanDisabled: 'This account lacks the plan scope. Sign in with an eligible account.',
      requestErrorRateLimit: 'The plan is rate limited. Retry shortly.',
      requestErrorNetwork: 'Network error reaching the ChatGPT plan. Check the local proxy/VPN and retry.',
      requestErrorTimeout: 'The request timed out. Retry; if it persists, check the local proxy/VPN.',
      requestErrorServer: 'The plan service failed. Retry shortly.',
      requestErrorMalformed: 'The response stream ended unexpectedly. Retry.',
      requestErrorUnsupported: 'This request used an unsupported capability or content.',
      requestErrorGeneric: 'The request failed.',
      requestErrorDismiss: 'Dismiss',
      stateBroken: 'Stored account state is unreadable; it was not overwritten.',
      refresh: 'Refresh',
      select: 'Use this account',
    }

    const ZH = {
      title: 'ChatGPT 计划',
      description: '使用 ChatGPT 账号登录，将符合条件的计划作为 DSH 原生模型提供方。',
      loading: '正在读取账号状态…',
      signedOut: '尚未连接 ChatGPT 计划账号。',
      continue: '使用 ChatGPT 登录',
      addAccount: '添加账号',
      signInAgain: '重新登录',
      signOut: '退出登录',
      cancel: '取消登录',
      active: '当前',
      use: '切换',
      planReady: '计划路线已启用',
      identityOnly: '已登录，但该账号没有计划调用 scope',
      reauth: '需要重新登录',
      expires: '访问令牌到期',
      unknownExpiry: '未知',
      waiting: '请在浏览器窗口中完成登录…',
      popupBlocked: '浏览器拦截了登录窗口，改在当前标签页继续。',
      loginUnavailable: '当前 Web origin 无法登录；回调路由可能已被占用，或 origin 不是 loopback HTTP。',
      signOutConfirm: '退出这个 ChatGPT 计划账号？',
      remoteRevokeFailed: '本地已退出，但未能确认远端撤销。',
      disconnected: '已退出的账号',
      reconnect: '重新连接',
      reconnectHint: '重新连接会复用该账号已有的 ChatGPT 注册；添加账号会创建新的注册。',
      signedOutAt: '退出时间',
      error: '登录错误',
      requestErrorTitle: '最近一次 ChatGPT 计划请求失败',
      requestErrorQuota: '计划额度已用尽。等待额度重置或检查计划状态。',
      requestErrorIneligible: '该账号不符合计划路线资格。检查订阅，或改用其他账号登录。',
      requestErrorAuth: '凭据被拒绝，请重新登录。',
      requestErrorReauth: '登录已过期，请重新连接该账号。',
      requestErrorPlanDisabled: '该账号缺少计划调用 scope，请改用符合条件的账号登录。',
      requestErrorRateLimit: '计划请求被限流，请稍后重试。',
      requestErrorNetwork: '连接 ChatGPT 计划失败。检查本机代理/VPN 后重试。',
      requestErrorTimeout: '请求超时。请重试；若持续失败，检查本机代理/VPN。',
      requestErrorServer: '计划服务端故障，请稍后重试。',
      requestErrorMalformed: '响应流意外结束，请重试。',
      requestErrorUnsupported: '该请求使用了不支持的输入或能力。',
      requestErrorGeneric: '请求失败。',
      requestErrorDismiss: '忽略',
      stateBroken: '已保存的账号状态无法读取；系统没有覆盖它。',
      refresh: '刷新',
      select: '使用此账号',
    }

    async function request(path, body) {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(data.message || data.error || `HTTP ${response.status}`)
        error.code = data.error || `HTTP_${response.status}`
        error.data = data
        throw error
      }
      return data
    }

    function formatExpiry(value, t, locale) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('unknownExpiry')
      try {
        return new Date(value).toLocaleString(locale)
      } catch {
        return String(value)
      }
    }

    /** Localized panel text for the last inference failure; the Chat row is DSH-owned. */
    function requestErrorText(error, t) {
      switch (error?.code) {
        case 'QUOTA':
          return t('requestErrorQuota')
        case 'PLAN_INELIGIBLE':
          return t('requestErrorIneligible')
        case 'AUTH':
        case 'AUTH_REJECTED':
        case 'MISSING_CREDENTIAL':
          return t('requestErrorAuth')
        case 'REAUTH_REQUIRED':
          return t('requestErrorReauth')
        case 'PLAN_DISABLED':
          return t('requestErrorPlanDisabled')
        case 'RATE_LIMIT':
          return t('requestErrorRateLimit')
        case 'TRANSPORT':
          return t('requestErrorNetwork')
        case 'TIMEOUT':
          return t('requestErrorTimeout')
        case 'SERVER':
          return t('requestErrorServer')
        case 'MALFORMED_RESPONSE':
        case 'STREAM_CLOSED':
        case 'EMPTY_RESPONSE':
          return t('requestErrorMalformed')
        case 'UNSUPPORTED_CONTENT':
        case 'UNSUPPORTED_CAPABILITY':
          return t('requestErrorUnsupported')
        default:
          return t('requestErrorGeneric')
      }
    }

    function createAccountPanel(ctx) {
      function AccountPanel() {
      const t = React.useMemo(() => ctx.locale.bind(NS), [])
      const locale = ctx.locale.getSnapshot().active ?? 'en'
      const [status, setStatus] = React.useState(undefined)
      const [pendingLocal, setPendingLocal] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState()
      const [dismissedRequestErrorAt, setDismissedRequestErrorAt] = React.useState(-1)
      const [, setLocaleRevision] = React.useState(0)
      // The Host owns pending attempts: after a reload the component's local
      // flag is gone, but status.loginPending still describes the same attempt.
      const pending = pendingLocal || status?.loginPending === true

      React.useEffect(() => {
        if (typeof ctx.locale.subscribe !== 'function') return undefined
        return ctx.locale.subscribe(() => setLocaleRevision((value) => value + 1))
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          setStatus(await request('/chatgpt-plan/status'))
        } catch (cause) {
          setError(cause.message)
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        const onFocus = () => void refresh()
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [refresh])

      React.useEffect(() => {
        if (!pending) return undefined
        let stopped = false
        const tick = async () => {
          if (stopped) return
          try {
            const next = await request('/chatgpt-plan/status')
            setStatus(next)
            if (next.loginPending !== true) {
              setPendingLocal(false)
              stopped = true
            }
          } catch {
            // A transient status failure does not end the interactive attempt.
          }
        }
        const timer = setInterval(tick, 2000)
        const timeout = setTimeout(() => {
          setPendingLocal(false)
          stopped = true
        }, 10 * 60 * 1000)
        return () => {
          stopped = true
          clearInterval(timer)
          clearTimeout(timeout)
        }
      }, [pending])

      const start = async (body) => {
        setBusy(true)
        setError(undefined)
        let popup
        try {
          popup = window.open('about:blank', 'dsh-chatgpt-plan', 'width=520,height=720')
          const data = await request('/chatgpt-plan/start', body)
          if (popup !== null && popup !== undefined) {
            popup.location.replace(data.url)
          } else {
            setError(t('popupBlocked'))
            window.location.assign(data.url)
            return
          }
          setPendingLocal(true)
        } catch (cause) {
          if (popup !== null && popup !== undefined) popup.close()
          setError(cause.message)
          // A refused start (for example TOO_MANY_PENDING) still has to expose
          // the Host's pending attempts so the Cancel action appears.
          await refresh()
        } finally {
          setBusy(false)
        }
      }

      const signOut = async (accountId) => {
        if (!window.confirm(t('signOutConfirm'))) return
        setBusy(true)
        setError(undefined)
        try {
          const next = await request('/chatgpt-plan/signout', { accountId })
          setStatus(next)
          if (next.remoteRevoked === false) setError(t('remoteRevokeFailed'))
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const select = async (accountId) => {
        setBusy(true)
        setError(undefined)
        try {
          setStatus(await request('/chatgpt-plan/select', { accountId }))
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const cancel = async () => {
        setBusy(true)
        try {
          setStatus(await request('/chatgpt-plan/cancel', {}))
          setPendingLocal(false)
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const card = {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '14px 16px',
        marginTop: 12,
        display: 'grid',
        gap: 10,
      }
      const muted = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }
      const button = {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '6px 10px',
        cursor: busy ? 'default' : 'pointer',
        font: 'inherit',
        opacity: busy ? 0.6 : 1,
      }
      const primary = {
        ...button,
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      }
      const row = {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        paddingTop: 10,
      }
      const badge = (text, color) => ({
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 12,
        whiteSpace: 'nowrap',
      })

      if (status === undefined) {
        return h('section', { style: card }, h('strong', null, t('title')), h('div', { style: muted }, t('loading')))
      }

      const accounts = Array.isArray(status.accounts) ? status.accounts : []
      const reconnectable = Array.isArray(status.reconnectable) ? status.reconnectable : []
      const lastError = error ?? status.lastError?.message
      const disabled = busy || status.callbackAvailable === false
      // While the Host holds a pending attempt, starting another one only
      // consumes the bounded attempt slots; the Cancel action stays available.
      const actionDisabled = disabled || pending
      const nothingConnected = accounts.length === 0 && reconnectable.length === 0
      const requestError = status.lastRequestError
      const requestErrorVisible =
        requestError !== undefined &&
        requestError !== null &&
        (requestError.at ?? 0) !== dismissedRequestErrorAt
      const requestErrorMeta =
        requestError === undefined || requestError === null
          ? ''
          : [
              requestError.code,
              requestError.status === undefined ? undefined : `HTTP ${requestError.status}`,
              requestError.retryAfterMs === undefined ? undefined : `retry ${Math.ceil(requestError.retryAfterMs / 1000)}s`,
            ]
              .filter(Boolean)
              .join(' · ')

      const accountRows = accounts.map((account) =>
        h('div', { key: account.id, style: row },
          h('div', { style: { display: 'grid', gap: 2, minWidth: 180, flex: '1 1 220px' } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('strong', null, account.label || account.email || account.id),
              account.id === status.activeAccountId ? h('span', { style: badge(t('active'), 'var(--dsw-alias-brand-primary)') }, t('active')) : null,
              account.reauthRequired ? h('span', { style: badge(t('reauth'), 'var(--dsw-alias-state-warn-primary)') }, t('reauth')) : null,
              !account.planEnabled ? h('span', { style: badge(t('identityOnly'), 'var(--dsw-alias-state-idle-primary)') }, t('identityOnly')) : null,
            ),
            h('div', { style: muted }, `${t('expires')}: ${formatExpiry(account.expiresAt, t, locale)}`),
          ),
          account.id === status.activeAccountId
            ? null
            : h('button', { type: 'button', style: button, disabled: actionDisabled, onClick: () => void select(account.id) }, t('select')),
          h('button', { type: 'button', style: button, disabled: actionDisabled, onClick: () => void start({ accountId: account.id }) }, t('signInAgain')),
          h('button', { type: 'button', style: button, disabled: actionDisabled, onClick: () => void signOut(account.id) }, t('signOut')),
        ),
      )

      const reconnectRows = reconnectable.length === 0
        ? null
        : h('div', { style: { display: 'grid', gap: 10 } },
            h('div', { style: { ...muted, fontWeight: 600 } }, t('disconnected')),
            h('div', { style: muted }, t('reconnectHint')),
            reconnectable.map((entry) =>
              h('div', { key: entry.id, style: row },
                h('div', { style: { display: 'grid', gap: 2, minWidth: 180, flex: '1 1 220px' } },
                  h('strong', null, entry.label || entry.email || entry.id),
                  h('div', { style: muted }, `${t('signedOutAt')}: ${formatExpiry(entry.signedOutAt, t, locale)}`),
                ),
                h('button', { type: 'button', style: primary, disabled: actionDisabled, onClick: () => void start({ accountId: entry.id }) }, t('reconnect')),
              ),
            ),
          )

      return h(
        'section',
        { style: card, 'aria-label': t('title') },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' } },
          h('strong', null, t('title')),
          h('span', { style: badge('', status.signedIn ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)') },
            status.signedIn ? t('planReady') : t('signedOut')),
        ),
        h('div', { style: muted }, t('description')),
        lastError === undefined ? null : h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } }, `${t('error')}: ${lastError}`),
        requestErrorVisible
          ? h(
              'div',
              { role: 'status', style: { border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 8, padding: '8px 10px', display: 'grid', gap: 4 } },
              h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, fontWeight: 600 } }, t('requestErrorTitle')),
              h('div', { style: { fontSize: 13 } }, requestErrorText(requestError, t)),
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' } },
                h('code', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, requestErrorMeta),
                h('button', { type: 'button', style: button, onClick: () => setDismissedRequestErrorAt(requestError.at ?? 0) }, t('requestErrorDismiss')),
              ),
            )
          : null,
        status.callbackAvailable === false ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 13 } }, t('loginUnavailable')) : null,
        h('div', { style: { display: 'grid', gap: 10 } },
          accountRows,
          reconnectRows,
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            nothingConnected
              ? h('button', { type: 'button', style: primary, disabled: actionDisabled, onClick: () => void start({ newAccount: true }) }, t('continue'))
              : h('button', { type: 'button', style: button, disabled: actionDisabled, onClick: () => void start({ newAccount: true }) }, t('addAccount')),
            h('button', { type: 'button', style: button, disabled, onClick: () => void refresh() }, t('refresh')),
            pending ? h('button', { type: 'button', style: button, disabled, onClick: () => void cancel() }, t('cancel')) : null,
          ),
          pending
            ? h('div', { style: muted },
                status.pendingSignIns > 1 ? `${t('waiting')} (${status.pendingSignIns})` : t('waiting'))
            : null,
        ),
      )
      }
      return AccountPanel
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const AccountPanel = createAccountPanel(ctx)
        ctx.effect(() => ctx.locale.register(NS, 'en', EN))
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH))
        ctx.effect(() =>
          ctx.slots.inject('settings.models.footer', () =>
            ctx.slots.register(
              { name: 'settings.models.footer', id: 'openai-chatgpt-plan-account', order: 10 },
              AccountPanel,
            ),
          ),
        )
      },
    }
  },
})
