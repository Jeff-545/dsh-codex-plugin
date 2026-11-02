/**
 * Verification helper: run one real desktop turn over the same RPC the Web UI
 * uses — create a session, select the `chatgpt-plan` model, prompt, and read
 * the persisted assistant message.
 *
 * Usage: node scripts/desktop-turn.mjs http://127.0.0.1:<gui-port>
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const origin = process.argv[2]
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const secret = Buffer.from(/client-connection\/browser-session:\s*\n(?:[ \t].*\n)*?[ \t]+secret:\s*([A-Za-z0-9_-]+)/.exec(readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8'))[1], 'base64url')
const b64 = value => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const authority = new URL(origin).host
const issuedAt = Date.now()
const body = b64(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 3600000 }), 'utf8'))
const cookie = `dsh-auth-${b64(createHash('sha256').update(authority).digest())}=v1.${body}.${b64(createHmac('sha256', secret).update(body).digest())}`
let counter = 0
async function rpc(method, args) {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin, accept: 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `turn-${++counter}`, method, payload: { args } }),
  })
  const envelope = await response.json()
  if (envelope.result?.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(envelope.result)}`)
  return envelope.result.value
}
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function readEvents(file) {
  const bytes = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= bytes.length; i++) if (bytes.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  let text = ''
  for (let f = 0; f < starts.length; f++) {
    try { text += zlib.zstdDecompressSync(bytes.subarray(starts[f], starts[f + 1] ?? bytes.length)).toString('utf8') } catch { break }
  }
  return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return undefined } }).filter(Boolean)
}
function findSessionLog(sessionId) {
  const stack = [join(DSH_HOME, 'sessions')]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name === sessionId) {
        for (const file of readdirSync(full)) if (file.endsWith('.zstd')) return join(full, file)
      }
      stack.push(full)
    }
  }
  return undefined
}

const created = await rpc('session/create', { request: { cwd: '/Users/jeff/Documents/DEV' } })
const sessionId = created.sessionId
console.log('session:', sessionId)
await rpc('session/selectModel', { request: { sessionId, provider: 'chatgpt-plan', model: 'gpt-6.1-sol', reasoningEffort: 'medium' } })
await rpc('session/prompt', {
  request: { sessionId, requestId: `turn-request-${Date.now()}`, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly: REFRESH-E2E-OK' }], clientTimeZone: 'Asia/Shanghai' },
})
const deadline = Date.now() + 240_000
let reply, usage, ended, header
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 2500))
  const file = findSessionLog(sessionId)
  if (file === undefined) continue
  let events
  try { events = readEvents(file) } catch { continue }
  const assistant = [...events].reverse().find(event => event.type === 'assistant/message')
  if (assistant !== undefined) {
    reply = (assistant.data?.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
    usage = assistant.data?.usage
  }
  header ??= events.find(event => event.type === 'request/header')?.data?.header?.config
  const end = events.find(event => event.type === 'turn/end')
  const failure = events.find(event => event.type === 'turn/error')
  if (end !== undefined || failure !== undefined) { ended = end?.data?.reason ?? failure?.data; break }
}
console.log('turn ended:', JSON.stringify(ended))
console.log('assistant reply:', JSON.stringify(reply))
console.log('usage:', JSON.stringify(usage ?? null))
console.log('provider/model used:', JSON.stringify(header ?? null))
console.log('session for cleanup:', sessionId)
