/**
 * Sign in with ChatGPT (SIWC) open-source plan-usage OAuth.
 *
 * Implements the flow documented at
 * https://developers.openai.com/siwc/token-sharing-open-source/ for locally
 * hosted open-source apps: dynamic client registration, authorization code +
 * PKCE with a 127.0.0.1 loopback callback, state/nonce checks, token exchange,
 * refresh-token rotation, and the plan-scope gate on
 * `chatgpt.tokens.use.direct`.
 *
 * Nothing here reads or shares another application's credentials; the tokens
 * this module handles come only from the user completing this plugin's own
 * browser authorization.
 *
 * @module dsh-chatgpt-plan/siwc
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { nodeFetch } from './http.js'

/** OIDC issuer of every token this flow handles. */
export const ISSUER = 'https://auth.openai.com'
/** Authorization endpoint for the open-source SIWC flow. */
export const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
/** Token endpoint for code exchange, refresh, and (implicitly) rotation. */
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
/** Revocation endpoint used by Disconnect. */
export const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`
/** Resource that the plan-usage access token is issued for. */
export const RESOURCE = 'https://api.openai.com/v1'
/** Model catalog endpoint read with a plan-usage access token. */
export const MODELS_URL = `${RESOURCE}/models`
/** Responses endpoint called with a plan-usage access token. */
export const RESPONSES_URL = `${RESOURCE}/responses`
/** Loopback callback: HTTP on 127.0.0.1, path `/auth/callback`; only the port may vary. */
export const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback'
/** Fixed callback port, matching the registered loopback redirect URI. */
export const REDIRECT_PORT = 1455
/** Fixed callback path. */
export const REDIRECT_PATH = '/auth/callback'
/** First-time registration entrypoint; never persisted as a client id. */
export const DYNAMIC_AGENT_CLIENT = 'dynamic_agent_client'
/** Prefix of the client id issued by dynamic registration. */
export const CLIENT_ID_PREFIX = 'oaiapp_'
/** Requested scopes: identity, offline refresh, plan-usage inference, and the API resource. */
export const SCOPE = `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`
/** Granted scope that must be present before the plan may be used for inference. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
/** Refresh this long before the one-hour access token expires. */
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000
/** Scheme of the per-installation host id the flow registers. */
export const EXT_AGENT_HOST_ID_SCHEME = 'urn:uuid:'

/** Token-endpoint error codes meaning the stored refresh token can never work again. */
export const FATAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'invalid_refresh_token',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'token_expired',
])

/** Model slugs to offer when the plan catalog cannot be read. */
export const MODEL_SUGGESTIONS = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6.1-terra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
]

/**
 * A new stable host id for this installation.
 *
 * The id identifies the host the app runs on rather than the signed-in
 * account; a UUID is a documented alternative to a JWK thumbprint URI.
 * @returns the `urn:uuid:`-scheme host id to persist.
 */
export function createExtAgentHostId() {
  return `${EXT_AGENT_HOST_ID_SCHEME}${randomUUID()}`
}

/**
 * Create a PKCE verifier and its S256 challenge.
 * @returns the verifier to keep and the challenge to send.
 */
export function createPkce() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Decode a JWT payload without verifying its signature.
 *
 * The token is received directly from the TLS-authenticated token endpoint in
 * the same response as the code exchange, so issuer, audience, expiry and
 * nonce are checked here but the signature is not.
 * @param token - the compact JWT.
 * @returns the claims object.
 * @throws {Error} when the value is not a three-part JWT of JSON claims.
 */
export function decodeJwtClaims(token) {
  const parts = String(token).split('.')
  if (parts.length !== 3) throw new Error('invalid ID token: not a JWT')
  let json
  try {
    json = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch (error) {
    throw new Error(`invalid ID token: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('invalid ID token: claims are not an object')
  }
  return json
}

/**
 * Validate the ID token of one code exchange.
 * @param idToken - the ID token returned by the token endpoint.
 * @param clientId - the client id the code was exchanged with.
 * @param nonce - the nonce of this authorization attempt.
 * @returns the validated claims.
 * @throws {Error} on issuer, audience, expiry, or nonce mismatch.
 */
export function validateIdToken(idToken, { clientId, nonce }) {
  const claims = decodeJwtClaims(idToken)
  if (claims.iss !== ISSUER) throw new Error(`invalid ID token: unexpected issuer ${String(claims.iss)}`)
  const audience = claims.aud
  const audiences = Array.isArray(audience) ? audience : [audience]
  if (!audiences.includes(clientId)) throw new Error('invalid ID token: audience does not name this client')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error('invalid ID token: expired')
  if (claims.nonce !== nonce) throw new Error('invalid ID token: nonce mismatch')
  return claims
}

/**
 * Build one authorization request.
 *
 * `client_id=dynamic_agent_client` registers this installation on the first
 * attempt; the callback then returns the issued `oaiapp_…` client id, which
 * every later attempt uses and the code exchange must use too.
 * @param options - current registration facts and the product name hint.
 * @returns the URL to open, this attempt's secrets, and whether it registers.
 */
export function createAuthorizationRequest({ clientId, extAgentHostId, agentName = 'DeepSeek Harness', redirectUri = REDIRECT_URI } = {}) {
  const registration = typeof clientId !== 'string' || clientId.length === 0
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const { verifier, challenge } = createPkce()
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: registration ? DYNAMIC_AGENT_CLIENT : clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ext_agent_host_id: extAgentHostId,
  })
  if (registration) params.set('agent_name_hint', agentName)
  return {
    url: `${AUTHORIZE_URL}?${params.toString()}`,
    state,
    nonce,
    verifier,
    registration,
    redirectUri,
    extAgentHostId,
    clientId: registration ? DYNAMIC_AGENT_CLIENT : clientId,
  }
}

/**
 * Parse the query of the URL a browser ended on.
 * @param url - the pasted or captured callback URL.
 * @returns its query parameters as a plain object.
 */
export function parseCallbackUrl(url) {
  const out = {}
  try {
    const parsed = new URL(String(url).trim())
    for (const [key, value] of parsed.searchParams) out[key] = value
  } catch (error) {
    const query = String(url ?? '').split('?')[1] ?? ''
    for (const [key, value] of new URLSearchParams(query)) out[key] = value
    if (Object.keys(out).length === 0) throw error
  }
  return out
}

/** Tokens live one hour, but a response may omit or round `expires_in`. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600

/**
 * Parse an optional ISO-8601 or epoch-millisecond timestamp.
 * @param value - candidate timestamp.
 * @returns epoch milliseconds, or undefined.
 */
function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * Turn a token endpoint response into the credential payload this plugin stores.
 * @param token - the token response JSON.
 * @param facts - registration fields the response does not repeat.
 * @returns the credential payload to persist.
 */
export function credentialsFromToken(token, { clientId, extAgentHostId, previous, sub, email }) {
  const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : (previous?.scopes ?? [])
  const expiresIn = typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
    ? token.expires_in
    : DEFAULT_EXPIRES_IN_SECONDS
  const payload = {
    type: 'oauth',
    provider: 'siwc',
    clientId: clientId ?? '',
    extAgentHostId: extAgentHostId ?? '',
    sub: sub ?? previous?.sub ?? '',
    email: email ?? previous?.email ?? null,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? previous?.refreshToken ?? '',
    idToken: token.id_token ?? previous?.idToken ?? '',
    expiresAt: Date.now() + expiresIn * 1000,
    scopes,
    planEnabled: scopes.includes(PLAN_SCOPE),
    earliestRefreshAt: parseTimestamp(token.earliest_refresh_at) ?? previous?.earliestRefreshAt ?? null,
    obtainedAt: Date.now(),
  }
  // The credential store admits only values that survive a JSON round trip and
  // hands the payload back verbatim, so the record is built as its own JSON
  // image exactly once, here, rather than risking an `undefined` member or a
  // class instance reaching the writer.
  return JSON.parse(JSON.stringify(payload))
}

/**
 * POST one form-encoded grant to the SIWC token endpoint.
 * @param data - grant parameters.
 * @param options - abort signal and whether refresh-fatal errors are fatal.
 * @returns the parsed token response.
 * @throws {SiwcTokenError} carrying the OAuth error code when the endpoint refuses.
 */
async function tokenRequest(data, { signal, fetchImpl = nodeFetch } = {}) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(data).toString(),
  }
  if (signal !== undefined) init.signal = signal
  const response = await fetchImpl(TOKEN_URL, init)
  const text = await response.text()
  let body
  try { body = text.length === 0 ? {} : JSON.parse(text) } catch { body = undefined }
  if (!response.ok) {
    const code = body?.error?.code ?? body?.error ?? body?.code ?? `http_${response.status}`
    const message = body?.error?.message ?? body?.error_description ?? body?.error?.error_description ?? text.slice(0, 300)
    throw new SiwcTokenError(String(code), String(message || `token request failed (${response.status})`), response.status)
  }
  if (body === undefined) throw new Error('invalid token response from OpenAI: not JSON')
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error('invalid token response from OpenAI: missing access_token')
  }
  return body
}

/** A token endpoint refusal carrying its OAuth error code. */
export class SiwcTokenError extends Error {
  /**
   * @param {string} code - OAuth error code returned by the endpoint.
   * @param {string} message - human-readable detail.
   * @param {number} status - HTTP status of the refusal.
   */
  constructor(code, message, status) {
    super(`Sign in with ChatGPT token request failed (${code}): ${message}`)
    this.name = 'SiwcTokenError'
    this.code = code
    this.status = status
  }

  /** Whether the stored refresh token can never be used again. */
  get fatal() {
    return FATAL_REFRESH_ERRORS.has(this.code)
  }
}

/**
 * Exchange one authorization code for credentials.
 * @param code - code from the callback query.
 * @param request - the authorization request this code answers.
 * @param options - callback client id/state, abort signal, fetch implementation.
 * @returns the credential payload.
 */
export async function exchangeCode(code, request, { callbackClientId, callbackState, signal, fetchImpl = nodeFetch } = {}) {
  if (typeof callbackState === 'string' && callbackState.length > 0 && callbackState !== request.state) {
    throw new Error('Sign in with ChatGPT failed: state mismatch')
  }
  if (!request.registration && typeof callbackClientId === 'string' && callbackClientId.length > 0
    && callbackClientId !== request.clientId) {
    throw new Error('Sign in with ChatGPT failed: the callback named a different client registration than this installation.')
  }
  const clientId = typeof callbackClientId === 'string' && callbackClientId.length > 0 ? callbackClientId : request.clientId
  const token = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: request.verifier,
    redirect_uri: request.redirectUri ?? REDIRECT_URI,
    resource: RESOURCE,
  }, { signal, fetchImpl })

  let sub
  let email
  if (typeof token.id_token === 'string' && token.id_token.length > 0) {
    const claims = validateIdToken(token.id_token, { clientId, nonce: request.nonce })
    if (typeof claims.sub === 'string') sub = claims.sub
    if (typeof claims.email === 'string') email = claims.email
  }
  return credentialsFromToken(token, {
    clientId,
    extAgentHostId: request.extAgentHostId,
    sub,
    email,
  })
}

/**
 * Exchange a stored refresh token for rotated credentials.
 * @param credentials - the current credential payload.
 * @param options - abort signal and fetch implementation.
 * @returns the replaced credential payload.
 */
export async function refreshCredentials(credentials, { signal, fetchImpl = nodeFetch } = {}) {
  const token = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: credentials.clientId,
    refresh_token: credentials.refreshToken,
    resource: RESOURCE,
  }, { signal, fetchImpl })
  return credentialsFromToken(token, {
    clientId: credentials.clientId,
    extAgentHostId: credentials.extAgentHostId,
    previous: credentials,
  })
}

/**
 * Read the model catalog the account's plan offers.
 *
 * The plan catalog is not the public `/v1/models` body: it is a `models` list
 * of objects carrying a `slug` (and, when present, display and capability
 * fields). The public `data[].id` shape is accepted as a fallback so a future
 * unification does not break the picker.
 * @param accessToken - a plan-usage access token.
 * @param options - abort signal and fetch implementation.
 * @returns catalog entries in provider order, hidden entries removed.
 */
export async function fetchPlanCatalog(accessToken, { signal, fetchImpl = nodeFetch } = {}) {
  const init = { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
  if (signal !== undefined) init.signal = signal
  const response = await fetchImpl(MODELS_URL, init)
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.text()).slice(0, 300) } catch { /* body is optional */ }
    throw new Error(`model catalog request failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const payload = await response.json()
  const rows = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : []
  const entries = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const slug = typeof row.slug === 'string' ? row.slug : typeof row.id === 'string' ? row.id : undefined
    if (slug === undefined || slug.length === 0) continue
    const efforts = Array.isArray(row.supported_reasoning_levels)
      ? row.supported_reasoning_levels.map(level => level?.effort).filter(effort => typeof effort === 'string')
      : undefined
    entries.push({
      slug,
      ...typeof row.display_name === 'string' && row.display_name.length > 0 ? { name: row.display_name } : {},
      ...typeof row.visibility === 'string' ? { visibility: row.visibility } : {},
      ...Number.isFinite(row.context_window) ? { contextWindow: row.context_window } : {},
      ...efforts !== undefined && efforts.length > 0 ? { efforts } : {},
      ...typeof row.default_reasoning_level === 'string' ? { defaultEffort: row.default_reasoning_level } : {},
      ...Array.isArray(row.input_modalities) ? { inputModalities: row.input_modalities.filter(value => typeof value === 'string') } : {},
    })
  }
  const listed = entries.filter(entry => entry.visibility === undefined || entry.visibility === 'list')
  return listed.length > 0 ? listed : entries
}

/**
 * Revoke one stored refresh token at OpenAI.
 *
 * Best effort: a network failure must not block the local Disconnect, but a
 * successful revoke means the token can never be replayed from this machine.
 * @param credentials - the stored credential payload.
 * @param options - abort signal and fetch implementation.
 * @returns {Promise<boolean>} whether OpenAI confirmed the revoke.
 */
export async function revokeCredentials(credentials, { signal, fetchImpl = nodeFetch } = {}) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      token: credentials.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: credentials.clientId,
    }).toString(),
  }
  if (signal !== undefined) init.signal = signal
  try {
    const response = await fetchImpl(REVOKE_URL, init)
    // An already-invalid token answers the same empty 200; both mean "gone".
    return response.ok
  } catch {
    return false
  }
}
