/**
 * Verification of the SIWC sign-in flow against a fake token endpoint.
 *
 * Reproduces the real harness shape (credential records, authorization session,
 * loopback callback) and asserts the committed payload is exactly what the
 * credential store admits: JSON-safe, with the installation's host id.
 */
import { runLoginFlow } from '/Users/jeff/Documents/DEV/dsh-codex-plugin/bundle/lib/oauth.js'
import { nodeFetch } from '/Users/jeff/Documents/DEV/dsh-codex-plugin/bundle/lib/http.js'

const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${detail}`}`) }
}
function b64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function jwt(claims) { return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.sig` }
function deepJsonSafe(value, path = 'payload') {
  if (value === undefined) return `${path} is undefined`
  if (typeof value === 'number' && !Number.isFinite(value)) return `${path} is non-finite`
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return `${path} is ${typeof value}`
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return `${path} has a non-plain prototype`
    for (const [key, nested] of Object.entries(value)) {
      const problem = deepJsonSafe(nested, `${path}.${key}`)
      if (problem !== undefined) return problem
    }
  }
  return undefined
}
function makeStore(initial = new Map()) {
  const records = new Map(initial)
  return {
    records,
    service: {
      async readRecord(key) { return records.get(key) },
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return records.get(key)
      },
      async deleteRecord(key) { records.delete(key) },
    },
  }
}
const ctxFor = store => ({ get: name => (name === 'credentials' ? store.service : undefined), logger: { info() {}, warn() {} } })
const tokenBody = (clientId, nonce, overrides = {}) => ({
  access_token: 'access-token-value',
  refresh_token: 'refresh-token-value',
  id_token: jwt({ iss: 'https://auth.openai.com', aud: clientId, exp: Math.floor(Date.now() / 1000) + 3600, nonce, sub: 'account-subject', email: 'user@example.com' }),
  token_type: 'Bearer',
  expires_in: 3600,
  scope: SCOPE,
  ...overrides,
})
function fakeFetch(state) {
  return async () => {
    const body = tokenBody(state.clientId, state.nonce, state.overrides)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    }
  }
}

/** Run one flow attempt, answering the loopback callback with `answer`. */
async function attempt({ store, answer, overrides }) {
  const ctx = ctxFor(store)
  const state = { nonce: undefined, clientId: overrides?.callbackClientId ?? 'oaiapp_test123', overrides: overrides?.token }
  let committed
  let notified
  const controller = new AbortController()
  const session = {
    signal: controller.signal,
    notify: notice => { if (notice?.url) notified = notice },
    commit: async record => { committed = record },
  }
  const running = runLoginFlow(ctx, session, { fetchImpl: fakeFetch(state) })
  running.catch(() => { /* asserted by callers through rejection */ })
  const deadline = Date.now() + 5000
  while (notified === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (notified === undefined) throw new Error('flow never notified an authorization URL')
  const authorize = new URL(notified.url)
  state.nonce = authorize.searchParams.get('nonce')
  const redirect = authorize.searchParams.get('redirect_uri')
  const query = new URLSearchParams({ code: 'authorization-code', state: answer?.state ?? authorize.searchParams.get('state') })
  const callbackClientId = answer?.omitClientId === true ? undefined : state.clientId
  if (callbackClientId !== undefined) query.set('client_id', callbackClientId)
  const landing = await nodeFetch(`${redirect}?${query.toString()}`)
  let error
  try { await running } catch (caught) { error = caught }
  return { authorize, landing, committed, error, records: store.records, notified }
}

console.log('scenario: first sign-in performs dynamic client registration')
{
  const store = makeStore()
  const result = await attempt({ store })
  check('authorization URL uses the dynamic registration client', result.authorize.searchParams.get('client_id') === 'dynamic_agent_client', result.authorize.searchParams.get('client_id'))
  check('agent_name_hint sent on the registration request', result.authorize.searchParams.get('agent_name_hint') === 'DeepSeek Harness')
  check('requested scope includes plan usage', (result.authorize.searchParams.get('scope') ?? '').includes(PLAN_SCOPE))
  check('resource parameter names the Responses API root', result.authorize.searchParams.get('resource') === 'https://api.openai.com/v1')
  check('redirect uses the 127.0.0.1 loopback callback', (result.authorize.searchParams.get('redirect_uri') ?? '').startsWith('http://127.0.0.1:'))
  check('flow resolved without error', result.error === undefined, result.error?.message)
  check('callback landing page served', result.landing.status === 200)
  const registration = result.records.get('chatgpt-plan/registration')
  const payload = result.committed?.payload
  check('registration record keeps the issued client id', registration?.payload?.clientId === 'oaiapp_test123', JSON.stringify(registration?.payload))
  check('registration record keeps a urn:uuid host id', String(registration?.payload?.extAgentHostId ?? '').startsWith('urn:uuid:'))
  check('credential committed as a grant record', result.committed?.kind === 'grant')
  const problem = deepJsonSafe(payload)
  check('credential payload is JSON-safe (the store invariant)', problem === undefined, problem)
  check('credential carries the installation host id', payload?.extAgentHostId === registration?.payload?.extAgentHostId, String(payload?.extAgentHostId))
  check('credential carries the issued client id and tokens', payload?.clientId === 'oaiapp_test123' && payload?.accessToken === 'access-token-value' && payload?.refreshToken === 'refresh-token-value')
  check('credential records the granted plan scope', payload?.planEnabled === true && Array.isArray(payload?.scopes) && payload.scopes.includes(PLAN_SCOPE))
  check('credential identifies the account', payload?.sub === 'account-subject' && payload?.email === 'user@example.com')
  check('access-token expiry is in the future', typeof payload?.expiresAt === 'number' && payload.expiresAt > Date.now())
}

console.log('scenario: re-authorization reuses the saved registration')
{
  const store = makeStore(new Map([['chatgpt-plan/registration', {
    kind: 'grant',
    payload: { extAgentHostId: 'urn:uuid:saved-host', clientId: 'oaiapp_saved' },
  }]]))
  const result = await attempt({ store, overrides: { callbackClientId: 'oaiapp_saved' }, answer: { omitClientId: true } })
  check('reuse sends the saved client id', result.authorize.searchParams.get('client_id') === 'oaiapp_saved', result.authorize.searchParams.get('client_id'))
  check('reuse sends no agent_name_hint', result.authorize.searchParams.get('agent_name_hint') === null)
  check('reuse keeps the saved host id', result.authorize.searchParams.get('ext_agent_host_id') === 'urn:uuid:saved-host')
  check('reuse committed with the saved client id', result.committed?.payload?.clientId === 'oaiapp_saved', result.committed?.payload?.clientId)
  check('reuse committed JSON-safely', deepJsonSafe(result.committed?.payload) === undefined)
}

console.log('scenario: state mismatch is refused')
{
  const store = makeStore()
  const result = await attempt({ store, answer: { state: 'tampered-state' } })
  check('flow rejects a mismatched callback state', result.error !== undefined && /state mismatch/i.test(result.error.message), result.error?.message)
  check('nothing committed after the refusal', result.committed === undefined)
}

console.log('scenario: missing plan scope still signs in but disables plan usage')
{
  const store = makeStore()
  const result = await attempt({ store, overrides: { token: { scope: 'openid profile email offline_access resource.invoke' } } })
  check('payload marks plan usage disabled', result.committed?.payload?.planEnabled === false, String(result.committed?.payload?.planEnabled))
  check('payload still JSON-safe', deepJsonSafe(result.committed?.payload) === undefined)
}

console.log(failures === 0 ? '\nALL FLOW CHECKS PASSED' : `\n${failures} FLOW CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
