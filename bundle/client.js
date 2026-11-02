/**
 * Browser half: the ChatGPT plan settings page.
 *
 * Registered as a dynamic client module (no build step): React comes from the
 * page's module table, and sign-in state travels over this plugin's own
 * same-origin routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chatgpt-plan',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PREFIX = '/plugins/dsh-chatgpt-plan'
    const MANAGE_USAGE = 'https://chatgpt.com/settings/usage'
    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')
    const L = zh
      ? {
        page: 'ChatGPT',
        title: 'ChatGPT 套餐',
        lead: '使用你的 ChatGPT Plus/Pro 套餐额度运行模型请求。登录由 OpenAI 官方的“Sign in with ChatGPT”流程完成；本插件只保存这次授权产生的令牌。',
        connect: '连接 ChatGPT',
        reconnect: '重新连接',
        connecting: '正在等待浏览器完成登录…',
        connected: '已连接',
        notConnected: '未连接',
        planOn: '已授予套餐调用权限',
        planOff: '未授予套餐调用权限（chatgpt.tokens.use.direct）',
        account: '账号',
        expires: '访问令牌到期',
        disconnect: '断开连接',
        cancel: '取消登录',
        manage: '管理用量',
        openLink: '打开登录页面',
        refresh: '刷新',
        loading: '正在读取状态…',
        usageNote: '使用 ChatGPT 套餐时，请求会计入你套餐的 ChatGPT Work 与 Codex 用量；每周上限由你在 ChatGPT 中设置。',
        errorPrefix: '操作失败',
      }
      : {
        page: 'ChatGPT',
        title: 'ChatGPT plan',
        lead: 'Run model requests on your ChatGPT Plus/Pro plan. Sign-in uses OpenAI\u2019s official Sign in with ChatGPT flow; this plugin only stores the tokens that authorization issues.',
        connect: 'Connect ChatGPT',
        reconnect: 'Reconnect',
        connecting: 'Waiting for the browser to finish signing in…',
        connected: 'Connected',
        notConnected: 'Not connected',
        planOn: 'Plan usage granted',
        planOff: 'Plan usage not granted (chatgpt.tokens.use.direct)',
        account: 'Account',
        expires: 'Access token expires',
        disconnect: 'Disconnect',
        cancel: 'Cancel sign-in',
        manage: 'Manage usage',
        openLink: 'Open sign-in page',
        refresh: 'Refresh',
        loading: 'Reading status…',
        usageNote: 'Requests on the ChatGPT plan count toward your plan\u2019s ChatGPT Work and Codex usage; the per-app weekly limit is set in ChatGPT.',
        errorPrefix: 'Action failed',
      }

    const card = {
      border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))',
      borderRadius: 10,
      padding: '16px 18px',
      marginTop: 14,
      background: 'var(--dsh-color-surface, transparent)',
    }
    const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }
    const muted = { opacity: 0.72, fontSize: '0.92em' }
    const button = {
      appearance: 'none',
      border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
      background: 'var(--dsh-color-surface-raised, rgba(127,127,127,0.08))',
      color: 'inherit',
      borderRadius: 8,
      padding: '7px 14px',
      font: 'inherit',
      cursor: 'pointer',
    }
    const primary = { ...button, background: 'var(--dsh-color-accent, #2f6fed)', borderColor: 'transparent', color: '#fff' }
    const dot = connected => ({
      display: 'inline-block', width: 9, height: 9, borderRadius: 9, marginRight: 8,
      background: connected ? 'var(--dsh-color-success, #2e9e5b)' : 'var(--dsh-color-warning, #c98a2b)',
    })

    async function call(path, method) {
      const response = await fetch(`${PREFIX}${path}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-dsh-plugin-request': '1' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
        credentials: 'same-origin',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`)
      return body
    }

    function formatTime(value) {
      if (typeof value !== 'number') return null
      try { return new Date(value).toLocaleString() } catch { return null }
    }

    function Page() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const next = await call('/status', 'GET')
          setSnapshot(next)
          if (next.error !== null && next.error !== undefined) setError(`${next.error.message}`)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        load()
        const timer = setInterval(() => { if (alive) load() }, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      const act = async (path) => {
        setBusy(true)
        setError(null)
        try {
          await call(path, 'POST')
          await load()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const connected = snapshot?.connected === true
      const planEnabled = snapshot?.planEnabled === true
      const pending = snapshot?.pending ?? null
      const expires = formatTime(snapshot?.expiresAt)

      return h('section', { style: { maxWidth: 720, margin: '0 auto' } },
        h('h1', { style: { fontSize: '1.35rem', margin: '0 0 8px' } }, L.title),
        h('p', { style: { ...muted, margin: '0 0 4px', lineHeight: 1.55 } }, L.lead),
        h('div', { style: card },
          h('div', { style: row },
            h('div', null,
              h('div', { style: { fontWeight: 600 } },
                h('span', { style: dot(connected) }),
                connected ? L.connected : L.notConnected),
              h('div', { style: { ...muted, marginTop: 4 } },
                connected
                  ? (planEnabled ? L.planOn : L.planOff)
                  : (pending === null ? L.notConnected : L.connecting))),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              pending !== null
                ? h('button', { style: button, disabled: busy, onClick: () => act('/cancel') }, L.cancel)
                : h('button', {
                  style: primary,
                  disabled: busy,
                  onClick: () => act('/connect'),
                }, connected ? L.reconnect : L.connect),
              connected
                ? h('button', { style: button, disabled: busy, onClick: () => act('/logout') }, L.disconnect)
                : null)),
          pending !== null && pending.url
            ? h('div', { style: { marginTop: 12 } },
              h('div', { style: muted }, pending.notice ?? L.connecting),
              h('a', {
                href: pending.url,
                target: '_blank',
                rel: 'noreferrer',
                style: { display: 'inline-block', marginTop: 6, color: 'var(--dsh-color-accent, #2f6fed)' },
              }, L.openLink))
            : null,
          connected
            ? h('dl', { style: { margin: '14px 0 0', display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 18px', fontSize: '0.95em' } },
              h('dt', { style: muted }, L.account),
              h('dd', { style: { margin: 0 } }, snapshot?.email ?? snapshot?.subject ?? '—'),
              expires === null ? null : h('dt', { style: muted }, L.expires),
              expires === null ? null : h('dd', { style: { margin: 0 } }, expires),
              h('dt', { style: muted }, L.manage),
              h('dd', { style: { margin: 0 } },
                h('a', { href: MANAGE_USAGE, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsh-color-accent, #2f6fed)' } }, L.manage)))
            : null),
        h('p', { style: { ...muted, marginTop: 12, lineHeight: 1.5 } }, L.usageNote),
        error === null ? null : h('div', {
          role: 'alert',
          style: { ...card, borderColor: 'var(--dsh-color-danger, #c94a4a)', color: 'var(--dsh-color-danger, #c94a4a)' },
        }, `${L.errorPrefix}: ${error}`),
        h('div', { style: { marginTop: 12 } },
          h('button', { style: button, onClick: () => load() }, L.refresh)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'chatgpt-plan',
          order: 40,
          label: L.page,
        }, Page))
      },
    }
  },
})
