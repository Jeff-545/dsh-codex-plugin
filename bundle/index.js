/**
 * ChatGPT plan (Sign in with ChatGPT) for DeepSeek Harness.
 *
 * The Host half registers:
 *  - one LLM provider route (`chatgpt-plan`) that streams Responses API calls
 *    with the ChatGPT plan-usage access token;
 *  - one authorization flow that runs the official SIWC open-source OAuth
 *    browser sign-in and commits the credential record;
 *  - the `chatgpt-plan-*` human commands;
 *  - same-origin HTTP routes consumed by the settings page.
 *
 * @module dsh-chatgpt-plan
 */
import { ChatGptPlanAdapter } from './lib/adapter.js'
import { FLOW_KEY, FLOW_LABEL, runLoginFlow, runLogout } from './lib/oauth.js'
import { PlanError, readCredential } from './lib/store.js'
import { registerRoutes } from './lib/routes.js'

export const name = 'chatgpt-plan'
export const inject = ['llm']

/** Build marker surfaced by the status route, so verification can tell which
 * module generation the running Host loaded. */
const BUILD = '0.1.1-json-safe'

/** Provider route this plugin owns. */
const PROVIDER = 'chatgpt-plan'
/** Label shown by model selectors. */
const DISPLAY_NAME = 'ChatGPT Plan'
/** Where the user manages plan usage in ChatGPT. */
const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage'

/**
 * Drive one sign-in attempt at a time and expose its live state to the routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {{ status: () => Promise<object>, begin: () => Promise<object>, cancel: () => void, logout: () => Promise<void> }} the controller.
 */
function createController(ctx) {
  let attempt = { settled: true, controller: undefined, url: null, notice: null, error: null, status: null, promise: undefined }

  const begin = async () => {
    if (!attempt.settled) return { started: true, url: attempt.url }
    const authorization = ctx.get('authorization')
    if (authorization === undefined) {
      throw new PlanError('NO_AUTHORIZATION', 'chatgpt-plan: this composition mounts no authorization service, so browser sign-in is unavailable.')
    }
    const current = { settled: false, controller: new AbortController(), url: null, notice: null, error: null, status: null, promise: undefined }
    attempt = current
    const interaction = {
      notify: notice => {
        if (typeof notice?.url === 'string' && notice.url.length > 0 && current.url === null) current.url = notice.url
        if (typeof notice?.message === 'string' && notice.message.length > 0) current.notice = notice.message
      },
      prompt: async () => {
        throw new PlanError('UNSUPPORTED_INTERACTION', 'chatgpt-plan: the sign-in flow asked for input that this surface cannot collect.')
      },
    }
    current.promise = authorization
      .begin({ key: FLOW_KEY, method: 'browser', interaction, signal: current.controller.signal })
      .then(outcome => { current.status = outcome.status })
      .catch(error => {
        current.error = { code: typeof error?.code === 'string' ? error.code : 'ERROR', message: error instanceof Error ? error.message : String(error) }
      })
      .finally(() => { current.settled = true })
    return { started: true }
  }

  const cancel = () => {
    if (attempt.settled) return
    attempt.controller?.abort()
    try { ctx.get('authorization')?.cancel(FLOW_KEY) } catch { /* the attempt may already be gone */ }
  }

  const logout = async () => {
    cancel()
    await runLogout(ctx)
    attempt = { settled: true, controller: undefined, url: null, notice: null, error: null, status: null, promise: undefined }
  }

  const status = async () => {
    const credential = await readCredential(ctx).catch(() => undefined)
    const pending = attempt.settled ? null : { url: attempt.url, notice: attempt.notice }
    const error = attempt.settled && attempt.error !== null
      && attempt.error.code !== 'CANCELLED' ? attempt.error : null
    return {
      build: BUILD,
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      connected: credential !== undefined,
      planEnabled: credential?.planEnabled === true,
      email: credential?.email ?? null,
      subject: credential?.sub ?? null,
      scopes: credential?.scopes ?? [],
      expiresAt: typeof credential?.expiresAt === 'number' ? credential.expiresAt : null,
      pending,
      error,
      manageUsageUrl: MANAGE_USAGE_URL,
    }
  }

  return { status, begin, cancel, logout }
}

/**
 * Run one sign-in attempt for a human command, returning its settled outcome.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('@deepseek-ai/dsh-commands').CommandInvocation} invocation - the command invocation.
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>} the command result.
 */
async function loginCommand(ctx, invocation) {
  const authorization = ctx.get('authorization')
  if (authorization === undefined) {
    return { kind: 'error', text: 'chatgpt-plan: this composition mounts no authorization service, so browser sign-in is unavailable.' }
  }
  let lastUrl
  const interaction = {
    notify: notice => {
      if (typeof notice?.url === 'string' && notice.url.length > 0) lastUrl = notice.url
      ctx.logger.info('chatgpt-plan: %s', notice?.message ?? 'signing in')
    },
    prompt: async () => {
      throw new PlanError('UNSUPPORTED_INTERACTION', 'chatgpt-plan: the sign-in flow asked for input that a command cannot collect.')
    },
  }
  try {
    const outcome = await authorization.begin({ key: FLOW_KEY, method: 'browser', interaction, signal: invocation.signal })
    if (outcome.status !== 'authorized') return { kind: 'error', text: 'ChatGPT sign-in was cancelled.' }
    const credential = await readCredential(ctx)
    const who = credential?.email ?? credential?.sub ?? 'your ChatGPT account'
    const plan = credential?.planEnabled === true
      ? 'ChatGPT plan usage is enabled for this app.'
      : 'ChatGPT plan usage was not granted; allow plan usage for this app in ChatGPT settings and sign in again.'
    return { kind: 'success', text: `Signed in to ChatGPT as ${who}. ${plan}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `${message}${lastUrl === undefined ? '' : `\nIf the browser did not open, visit:\n${lastUrl}`}` }
  }
}

/**
 * Register the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const adapter = new ChatGptPlanAdapter(ctx, { provider: PROVIDER, displayName: DISPLAY_NAME })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'chatgpt-plan: model route')

  ctx.inject(['authorization'], authorized => {
    ctx.effect(() => authorized.authorization.registerFlow({
      key: FLOW_KEY,
      label: FLOW_LABEL,
      methods: [{ id: 'browser', label: 'Sign in with ChatGPT (browser)' }],
      run: session => runLoginFlow(ctx, session),
    }), 'chatgpt-plan: sign-in flow')
  })

  const controller = createController(ctx)
  // Routes need the web carrier, which activates independently of this row:
  // bind through the injection scope instead of reading it eagerly at apply.
  ctx.inject(['webServer'], scoped => {
    registerRoutes(scoped, controller)
  })

  ctx.inject(['commands'], commands => {
    ctx.effect(() => commands.commands.register({
      name: 'chatgpt-plan-login',
      description: 'Sign in with ChatGPT so this session can use your ChatGPT plan as a model provider.',
      handler: invocation => loginCommand(ctx, invocation),
    }), 'chatgpt-plan: login command')
    ctx.effect(() => commands.commands.register({
      name: 'chatgpt-plan-logout',
      description: 'Forget the stored ChatGPT plan sign-in on this harness.',
      handler: async () => {
        await controller.logout()
        return { kind: 'success', text: 'ChatGPT plan sign-in removed. The ChatGPT app connector can still be removed in ChatGPT settings.' }
      },
    }), 'chatgpt-plan: logout command')
    ctx.effect(() => commands.commands.register({
      name: 'chatgpt-plan-status',
      description: 'Show whether a ChatGPT plan sign-in is stored for this harness.',
      handler: async () => {
        const snapshot = await controller.status()
        if (!snapshot.connected) return { kind: 'success', text: 'No ChatGPT plan sign-in is stored. Run /chatgpt-plan-login to connect one.' }
        const plan = snapshot.planEnabled ? 'plan usage enabled' : 'plan usage NOT granted'
        return {
          kind: 'success',
          text: `ChatGPT plan sign-in: ${snapshot.email ?? snapshot.subject ?? 'unknown account'} (${plan}). Manage usage: ${MANAGE_USAGE_URL}`,
        }
      },
    }), 'chatgpt-plan: status command')
  })
}
