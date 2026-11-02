/**
 * Verification helper: authenticated GET against the running desktop Harness.
 *
 * The Web GUI authenticates with a signed `dsh-auth-<sha256(authority)>` cookie
 * whose HMAC key is the `client-connection/browser-session` secret in the
 * profile's credential document. This script reads that secret, mints the
 * cookie the running process would accept, and performs one request, so
 * verification does not depend on taking over the user's window.
 *
 * Usage: node scripts/desktop-probe.mjs <origin> <path> [METHOD]
 *   e.g. node scripts/desktop-probe.mjs http://127.0.0.1:64152 /plugins/dsh-chatgpt-plan/status
 *        node scripts/desktop-probe.mjs http://127.0.0.1:64152 /plugins/dsh-chatgpt-plan/connect POST
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2]
const path = process.argv[3] ?? '/plugins/dsh-chatgpt-plan/status'
const method = (process.argv[4] ?? 'GET').toUpperCase()
if (origin === undefined) {
  console.error('usage: node scripts/desktop-probe.mjs <origin> [path]')
  process.exit(2)
}

/**
 * Read the browser-session signing secret out of the credential document.
 * @returns {string} the base64url secret.
 */
function readBrowserSessionSecret() {
  const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
  const text = readFileSync(file, 'utf8')
  const block = /client-connection\/browser-session:\s*\n(?:[ \t].*\n)*?[ \t]+secret:\s*([A-Za-z0-9_-]+)/.exec(text)
  if (block === null) throw new Error('no client-connection/browser-session secret in the credential document')
  return block[1]
}

/**
 * Encode one buffer as unpadded base64url.
 * @param {Buffer} value - bytes to encode.
 * @returns {string} the encoding.
 */
function b64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const url = new URL(origin)
const authority = url.host
const secret = Buffer.from(readBrowserSessionSecret(), 'base64url')
const issuedAt = Date.now()
const expiresAt = issuedAt + 60 * 60 * 1000
const payload = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
const signature = b64url(createHmac('sha256', secret).update(payload).digest())
const cookieName = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
const cookie = `${cookieName}=v1.${payload}.${signature}`

const response = await fetch(new URL(path, origin), {
  method,
  headers: {
    cookie,
    accept: 'application/json',
    ...method === 'POST'
      ? { 'content-type': 'application/json', 'x-dsh-plugin-request': '1' }
      : {},
  },
  body: method === 'POST' ? '{}' : undefined,
  redirect: 'manual',
})
const body = await response.text()
console.log(`HTTP ${response.status}`)
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2))
} catch {
  console.log(body.slice(0, 1200))
}
