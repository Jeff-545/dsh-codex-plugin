/**
 * Durable state of the ChatGPT plan route: the plan credential and the
 * installation's SIWC registration.
 *
 * Both live in the harness credential plane, addressed by this plugin's own
 * scope. The credential record holds refreshable OAuth tokens; the registration
 * record holds only the non-secret host id and issued client id, so signing out
 * can forget the tokens while keeping the registration for a faster re-auth.
 *
 * @module dsh-chatgpt-plan/store
 */
import { refreshCredentials, SiwcTokenError, TOKEN_EXPIRY_MARGIN_MS } from './siwc.js'

/** This plugin's credential scope, matching its registered plugin name. */
export const CREDENTIAL_SCOPE = 'chatgpt-plan'
/** Record holding the plan OAuth tokens. */
export const CREDENTIAL_KEY = `${CREDENTIAL_SCOPE}/credential`
/** Record holding the installation's SIWC registration (non-secret). */
export const REGISTRATION_KEY = `${CREDENTIAL_SCOPE}/registration`

/** A failure with a stable code the LLM and HTTP surfaces route on. */
export class PlanError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - actionable, user-facing detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ChatGptPlanError'
    this.code = code
  }
}

/**
 * The live credential service, or a loud failure naming what is missing.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns the credential provider.
 * @throws {PlanError} `NO_CREDENTIAL_STORE` when the composition mounts none.
 */
export function credentialStore(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new PlanError(
      'NO_CREDENTIAL_STORE',
      'chatgpt-plan: this composition mounts no credentials service, so ChatGPT sign-in has nowhere to store its tokens.',
    )
  }
  return credentials
}

/**
 * Read the stored plan credential payload.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {Promise<object | undefined>} the payload, or undefined when signed out.
 */
export async function readCredential(ctx) {
  const record = await credentialStore(ctx).readRecord(CREDENTIAL_KEY)
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || typeof payload.accessToken !== 'string') return undefined
  return payload
}

/**
 * Replace the stored plan credential payload.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} payload - the credential payload to persist.
 * @returns {Promise<void>} after the write is durable.
 */
export async function writeCredential(ctx, payload) {
  await credentialStore(ctx).modifyRecord(CREDENTIAL_KEY, () => ({ kind: 'grant', payload }))
}

/**
 * Forget the stored plan credential, keeping the registration record.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {Promise<void>} after the record is gone.
 */
export async function deleteCredential(ctx) {
  await credentialStore(ctx).deleteRecord(CREDENTIAL_KEY)
}

/**
 * Read the installation's SIWC registration.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {Promise<{ extAgentHostId?: string, clientId?: string }>} stored facts, or an empty object.
 */
export async function readRegistration(ctx) {
  const record = await credentialStore(ctx).readRecord(REGISTRATION_KEY)
  if (record === undefined || record.kind !== 'grant') return {}
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return {}
  return {
    ...(typeof payload.extAgentHostId === 'string' && payload.extAgentHostId.length > 0
      ? { extAgentHostId: payload.extAgentHostId }
      : {}),
    ...(typeof payload.clientId === 'string' && payload.clientId.length > 0 ? { clientId: payload.clientId } : {}),
  }
}

/**
 * Store the installation's SIWC registration facts.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ extAgentHostId: string, clientId?: string }} facts - facts to persist.
 * @returns {Promise<void>} after the write is durable.
 */
export async function writeRegistration(ctx, facts) {
  const payload = {
    extAgentHostId: facts.extAgentHostId,
    ...(typeof facts.clientId === 'string' && facts.clientId.length > 0 ? { clientId: facts.clientId } : {}),
  }
  await credentialStore(ctx).modifyRecord(REGISTRATION_KEY, () => ({ kind: 'grant', payload }))
}

/** In-process single flight per record key, so one refresh rotates one token. */
const inflight = new Map()

/**
 * Run one refresh at a time for a record key.
 * @param {string} key - record key to serialize on.
 * @param {() => Promise<unknown>} run - the refresh work.
 * @returns the refresh result.
 */
function singleFlight(key, run) {
  const existing = inflight.get(key)
  if (existing !== undefined) return existing
  const pending = run().finally(() => { inflight.delete(key) })
  inflight.set(key, pending)
  return pending
}

/**
 * Return a usable access token, refreshing it shortly before it expires.
 *
 * A rotated refresh token is persisted immediately through `modifyRecord`, so a
 * crash between the response and the next request cannot strand the old token.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<{ payload: object, accessToken: string }>} the credential and its token.
 * @throws {PlanError} when signed out, when the plan scope is missing, or when the grant is dead.
 */
export async function ensureAccessToken(ctx, signal) {
  const current = await readCredential(ctx)
  if (current === undefined) {
    throw new PlanError('MISSING_CREDENTIAL', 'chatgpt-plan: no ChatGPT plan sign-in is stored. Sign in with ChatGPT from Settings → ChatGPT, or run the chatgpt-plan-login command.')
  }
  if (current.planEnabled !== true) {
    throw new PlanError(
      'PLAN_SCOPE_MISSING',
      'chatgpt-plan: this ChatGPT sign-in did not grant plan usage (scope "chatgpt.tokens.use.direct"). Re-authorize and allow the plan-usage permission, or check the app limit in ChatGPT settings → Usage.',
    )
  }
  const now = Date.now()
  const usable = typeof current.expiresAt === 'number' && now < current.expiresAt - TOKEN_EXPIRY_MARGIN_MS
  const early = typeof current.earliestRefreshAt === 'number' && now < current.earliestRefreshAt
  if (usable || early) return { payload: current, accessToken: current.accessToken }
  const payload = await singleFlight(CREDENTIAL_KEY, () => rotateLocked(ctx, signal, false))
  return { payload, accessToken: payload.accessToken }
}

/**
 * Force one refresh, e.g. after the API rejected a still-unexpired token.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<object>} the replaced credential payload.
 */
export async function refreshNow(ctx, signal) {
  return singleFlight(CREDENTIAL_KEY, () => rotateLocked(ctx, signal, true))
}

/**
 * Rotate the stored credential inside the credential store's own lock.
 *
 * The read, the token-endpoint call, and the replacement happen in one
 * `modifyRecord` mutation, so a concurrent writer in this process or another
 * one cannot resurrect a refresh token this rotation already consumed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {boolean} force - rotate even when the current access token is fresh.
 * @returns {Promise<object>} the payload in force afterwards.
 */
async function rotateLocked(ctx, signal, force) {
  let resolved
  await credentialStore(ctx).modifyRecord(CREDENTIAL_KEY, async current => {
    if (current === undefined || current.kind !== 'grant'
      || typeof current.payload !== 'object' || current.payload === null) {
      throw new PlanError('MISSING_CREDENTIAL', 'chatgpt-plan: no ChatGPT plan sign-in is stored.')
    }
    const latest = current.payload
    const now = Date.now()
    const fresh = typeof latest.expiresAt === 'number' && now < latest.expiresAt - TOKEN_EXPIRY_MARGIN_MS
    const early = !force && typeof latest.earliestRefreshAt === 'number' && now < latest.earliestRefreshAt
    if (fresh || early) {
      resolved = latest
      return undefined
    }
    try {
      resolved = await refreshCredentials(latest, { signal })
    } catch (error) {
      if (error instanceof SiwcTokenError && error.fatal) {
        throw new PlanError(
          'AUTH',
          'chatgpt-plan: the ChatGPT sign-in was revoked or expired. Sign in with ChatGPT again from Settings → ChatGPT.',
        )
      }
      throw error
    }
    return { kind: 'grant', payload: resolved }
  })
  if (resolved === undefined) throw new PlanError('MISSING_CREDENTIAL', 'chatgpt-plan: no ChatGPT plan sign-in is stored.')
  return resolved
}
