/**
 * The ChatGPT plan sign-in flow: browser authorization with a loopback
 * callback, driven through the harness authorization seam.
 *
 * The flow writes one credential record and keeps the non-secret registration
 * facts (`ext_agent_host_id` and the issued `oaiapp_…` client id) in a second
 * record so re-authorization can skip dynamic client registration.
 *
 * @module dsh-chatgpt-plan/oauth
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  REDIRECT_PATH,
  REDIRECT_PORT,
  SiwcTokenError,
  createAuthorizationRequest,
  createExtAgentHostId,
  exchangeCode,
  revokeCredentials,
} from './siwc.js'
import { CREDENTIAL_KEY, PlanError, readRegistration, writeRegistration } from './store.js'

/** Stable credential key this flow writes; the store owns the literal. */
export const FLOW_KEY = CREDENTIAL_KEY
/** Label shown by any surface listing this flow. */
export const FLOW_LABEL = 'ChatGPT plan'
/** Callback ports tried in order; the redirect URI carries whichever binds. */
export const CALLBACK_PORTS = [REDIRECT_PORT, 1456, 1457, 1458, 1459, 1460]
/** How long one attempt waits for the human to finish in the browser. */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Open a URL in the OS browser without blocking the Host.
 * @param {string} url - the authorization URL.
 * @returns {boolean} whether a launcher was spawned.
 */
export function openBrowser(url) {
  // Automated verification sets this so the flow can be exercised without
  // taking over the user's default browser.
  if (process.env.DSH_CHATGPT_PLAN_NO_BROWSER === '1') return false
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => { /* the caller still shows the URL */ })
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Render the loopback landing page shown after the browser callback.
 * @param {boolean} ok - whether a code was received.
 * @returns {string} a tiny self-contained HTML document.
 */
function landingPage(ok) {
  const title = ok ? 'Sign-in complete' : 'Sign-in failed'
  const body = ok
    ? 'ChatGPT sign-in finished. You can close this tab and return to DeepSeek Harness.'
    : 'DeepSeek Harness did not receive a valid authorization code. Return to the app and try again.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f1115;color:#e8eaed}main{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.25rem}</style>'
    + `</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
}

/**
 * Bind one loopback listener.
 * @param {number} port - candidate port.
 * @returns {Promise<{ server?: import('node:http').Server, error?: Error }>} the listener or the bind error.
 */
function listen(port) {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', error => {
      try { server.close() } catch { /* never listened */ }
      resolve({ error })
    })
    server.listen(port, '127.0.0.1', () => resolve({ server }))
  })
}

/**
 * Bind a loopback callback listener on the first free candidate port.
 *
 * A loopback redirect may use any port, so a busy 1455 falls through instead of
 * failing the sign-in.
 * @param {object} [options] - attempt bounds.
 * @param {number} [options.timeoutMs] - how long to wait for the callback.
 * @param {AbortSignal} [options.signal] - attempt cancellation.
 * @returns {Promise<{ redirectUri: string, port: number, wait: Promise<{ code: string, state?: string, client_id?: string }>, close: () => void }>} the listener and its pending callback.
 * @throws {PlanError} `CALLBACK_UNAVAILABLE` when no candidate port binds.
 */
export async function startCallbackServer({ timeoutMs = LOGIN_TIMEOUT_MS, signal } = {}) {
  let lastError
  for (const port of CALLBACK_PORTS) {
    const outcome = await listen(port)
    if (outcome.error !== undefined) {
      lastError = outcome.error
      continue
    }
    const server = outcome.server
    let settled = false
    let settleResolve
    let settleReject
    const wait = new Promise((resolve, reject) => {
      settleResolve = resolve
      settleReject = reject
    })
    const close = () => {
      try { server.close() } catch { /* already closed */ }
    }
    const onAbort = () => {
      finish(new PlanError('CANCELLED', 'Sign in with ChatGPT was cancelled.'), true)
    }
    const timer = setTimeout(() => {
      finish(new PlanError('LOGIN_TIMEOUT', 'Sign in with ChatGPT timed out waiting for the browser callback. Try again.'), true)
    }, timeoutMs)
    /**
     * Settle the pending callback exactly once.
     * @param {object | Error} value - the result or the rejection.
     * @param {boolean} [isError] - whether the value rejects.
     */
    function finish(value, isError = false) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      close()
      if (isError) settleReject(value)
      else settleResolve(value)
    }
    if (signal?.aborted === true) {
      finish(new PlanError('CANCELLED', 'Sign in with ChatGPT was cancelled.'), true)
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    server.on('request', (req, res) => {
      // Never let a malformed request throw out of this handler: an uncaught
      // exception fails the whole Host boot.
      try {
        let url
        try {
          url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('bad request')
          return
        }
        if (url.pathname !== REDIRECT_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
          return
        }
        const query = Object.fromEntries(url.searchParams)
        const ok = typeof query.code === 'string' && query.code.length > 0
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(landingPage(ok))
        if (ok) finish({ code: query.code, state: query.state, client_id: query.client_id })
      } catch {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' })
          res.end('internal error')
        } catch { /* response already gone */ }
      }
    })
    return { redirectUri: `http://127.0.0.1:${port}${REDIRECT_PATH}`, port, wait, close }
  }
  throw new PlanError(
    'CALLBACK_UNAVAILABLE',
    `chatgpt-plan: could not bind a loopback callback port (tried ${CALLBACK_PORTS.join(', ')}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/**
 * Run one browser sign-in attempt.
 *
 * The human completes the flow in the browser; this function waits for the
 * loopback callback, validates state and the ID token, persists the
 * registration, and commits the credential record through the authorization
 * session so the attempt is observed as authorized.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ signal: AbortSignal, notify: Function, commit: Function }} session - the authorization attempt.
 * @param {{ fetchImpl?: typeof fetch }} [options] - transport override used by verification.
 * @returns {Promise<object>} the committed credential payload.
 */
export async function runLoginFlow(ctx, session, options = {}) {
  const registration = await readRegistration(ctx)
  const extAgentHostId = registration.extAgentHostId ?? createExtAgentHostId()
  const callback = await startCallbackServer({ timeoutMs: LOGIN_TIMEOUT_MS, signal: session.signal })
  try {
    const request = createAuthorizationRequest({
      clientId: registration.clientId,
      extAgentHostId,
      redirectUri: callback.redirectUri,
    })
    session.notify({
      message: 'A browser window will open to finish the ChatGPT sign-in. If it does not open, visit the address below.',
      url: request.url,
    })
    openBrowser(request.url)
    const callbackResult = await callback.wait
    let credentials
    try {
      credentials = await exchangeCode(callbackResult.code, request, {
        callbackClientId: callbackResult.client_id,
        callbackState: callbackResult.state,
        signal: session.signal,
        ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
      })
    } catch (error) {
      if (error instanceof SiwcTokenError && error.code === 'invalid_grant') {
        throw new PlanError(
          'AUTH',
          'ChatGPT refused the sign-in code (invalid_grant). The authorization may have expired, or this account is not eligible for ChatGPT plan usage with this app; start the sign-in again from Settings → ChatGPT.',
        )
      }
      throw error
    }
    await writeRegistration(ctx, { extAgentHostId, clientId: credentials.clientId })
    await session.commit({ kind: 'grant', payload: credentials })
    if (credentials.planEnabled !== true) {
      session.notify({
        message: 'Signed in, but the ChatGPT plan usage permission was not granted. Allow plan usage for this app in ChatGPT settings, then sign in again.',
      })
    }
    return credentials
  } finally {
    callback.close()
  }
}

/**
 * Disconnect: revoke the refresh token at OpenAI, then forget it locally.
 *
 * A failed revoke never blocks the local removal; the caller reports whether
 * the account-side revocation was confirmed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {Promise<boolean>} whether OpenAI confirmed the revocation.
 */
export async function runLogout(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return false
  const record = await credentials.readRecord(FLOW_KEY).catch(() => undefined)
  const payload = record !== undefined && record.kind === 'grant' ? record.payload : undefined
  let revoked = false
  if (payload !== undefined && typeof payload.refreshToken === 'string' && payload.refreshToken.length > 0) {
    revoked = await revokeCredentials(payload, { signal: AbortSignal.timeout(10_000) })
  }
  await credentials.deleteRecord(FLOW_KEY)
  return revoked
}
