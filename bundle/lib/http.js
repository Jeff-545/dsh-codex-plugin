/**
 * Minimal HTTPS transport with HTTP-CONNECT proxy support.
 *
 * Node's global fetch does not use the macOS system proxy or the conventional
 * proxy environment variables, and this deployment reaches `auth.openai.com`
 * and `api.openai.com` only through a system proxy (`127.0.0.1:12348` here).
 * This module therefore issues requests with `node:https` and, when a proxy is
 * configured, tunnels through it with `CONNECT` and TLS — the shape Node's
 * fetch-compatible surface needs from this plugin, and nothing more.
 *
 * @module dsh-chatgpt-plan/http
 */
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

/** Hosts that must never be proxied: the local loopback callback and the harness server. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Parse one proxy specification into host and port.
 * @param {string | undefined} value - proxy URL or `host:port`.
 * @returns {{ host: string, port: number } | undefined} the proxy endpoint.
 */
function parseProxy(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const text = value.includes('://') ? value.trim() : `http://${value.trim()}`
  try {
    const url = new URL(text)
    const port = url.port.length > 0 ? Number(url.port) : 8080
    if (!Number.isFinite(port) || port <= 0) return undefined
    return { host: url.hostname, port }
  } catch {
    return undefined
  }
}

/**
 * Whether a host is excluded by `NO_PROXY`.
 * @param {string} host - target hostname.
 * @param {string | undefined} noProxy - comma-separated exclusions.
 * @returns {boolean} true when the request must go direct.
 */
function bypassed(host, noProxy) {
  const lowered = host.toLowerCase()
  if (LOOPBACK.has(lowered)) return true
  if (typeof noProxy !== 'string') return false
  return noProxy.split(',').some(entry => {
    const pattern = entry.trim().toLowerCase()
    if (pattern.length === 0) return false
    if (pattern === '*') return true
    const bare = pattern.startsWith('.') ? pattern.slice(1) : pattern
    return lowered === bare || lowered.endsWith(`.${bare}`)
  })
}

/**
 * Read the macOS system HTTPS proxy from `scutil`.
 * @returns {{ host: string, port: number } | undefined} the configured proxy.
 */
function darwinSystemProxy() {
  if (process.platform !== 'darwin') return undefined
  let output
  try {
    output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 })
  } catch {
    return undefined
  }
  const enabled = /HTTPSEnable\s*:\s*1/.test(output)
  if (!enabled) return undefined
  const host = /HTTPSProxy\s*:\s*(\S+)/.exec(output)?.[1]
  const port = Number(/HTTPSPort\s*:\s*(\d+)/.exec(output)?.[1] ?? '')
  if (typeof host !== 'string' || host.length === 0 || !Number.isFinite(port)) return undefined
  return { host, port }
}

let cachedProxy
let cachedProxyAt = 0
/** Refresh the resolved proxy at most this often, so a network change is picked up. */
const PROXY_CACHE_MS = 30_000

/**
 * Resolve the proxy to use for one target host.
 *
 * `DSH_CHATGPT_PLAN_PROXY` wins, then `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`
 * (respecting `NO_PROXY`), then the macOS system proxy.
 * @param {string} host - target hostname.
 * @returns {{ host: string, port: number } | undefined} the proxy, or undefined for a direct request.
 */
export function resolveProxy(host) {
  if (bypassed(host, process.env.NO_PROXY ?? process.env.no_proxy)) return undefined
  const explicit = parseProxy(process.env.DSH_CHATGPT_PLAN_PROXY)
  if (explicit !== undefined) return explicit
  const fromEnv = parseProxy(
    process.env.HTTPS_PROXY ?? process.env.https_proxy
    ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    ?? process.env.ALL_PROXY ?? process.env.all_proxy,
  )
  if (fromEnv !== undefined) return fromEnv
  const now = Date.now()
  if (cachedProxy !== undefined || now - cachedProxyAt > PROXY_CACHE_MS) {
    cachedProxy = darwinSystemProxy()
    cachedProxyAt = now
  }
  return cachedProxy
}

/** Tunnel agents keyed by `proxy|host:port`. */
const agents = new Map()

/**
 * An HTTPS agent that establishes a TCP `CONNECT` tunnel and then TLS.
 */
class TunnelAgent extends https.Agent {
  /**
   * @param {{ host: string, port: number }} proxy - the HTTP proxy endpoint.
   */
  constructor(proxy) {
    super({ keepAlive: true, maxSockets: 8 })
    this.proxy = proxy
  }

  /**
   * Open one tunneled TLS connection for `https.request`.
   * @param {object} options - connection options supplied by the agent.
   * @param {(error: Error | null, socket?: import('node:stream').Duplex) => void} callback - completion callback.
   * @returns {void}
   */
  createConnection(options, callback) {
    const targetHost = options.host
    const targetPort = Number(options.port ?? 443)
    const socket = net.connect({ host: this.proxy.host, port: this.proxy.port })
    let buffer = ''
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      socket.destroy()
      callback(error)
    }
    socket.setNoDelay(true)
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
      const onData = chunk => {
        buffer += chunk.toString('latin1')
        const boundary = buffer.indexOf('\r\n\r\n')
        if (boundary === -1) return
        socket.removeListener('data', onData)
        const statusLine = buffer.slice(0, buffer.indexOf('\r\n'))
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
          fail(new Error(`proxy CONNECT refused: ${statusLine}`))
          return
        }
        const leftover = buffer.slice(boundary + 4)
        if (leftover.length > 0) socket.unshift(Buffer.from(leftover, 'latin1'))
        const secure = tls.connect({ socket, servername: targetHost, ALPNProtocols: ['http/1.1'] })
        secure.once('error', fail)
        secure.once('secureConnect', () => {
          if (settled) return
          settled = true
          callback(null, secure)
        })
      }
      socket.on('data', onData)
    })
  }
}

/**
 * Return the caching tunnel agent for one proxy and target.
 * @param {{ host: string, port: number }} proxy - the HTTP proxy endpoint.
 * @returns {TunnelAgent} the agent.
 */
function agentFor(proxy) {
  const key = `${proxy.host}:${proxy.port}`
  let agent = agents.get(key)
  if (agent === undefined) {
    agent = new TunnelAgent(proxy)
    agents.set(key, agent)
  }
  return agent
}

/** Error thrown when the caller's signal aborts a request. */
function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Issue one HTTPS request with a fetch-compatible result.
 *
 * The result exposes `status`, `ok`, `headers.get`, `text()`, `json()`, and an
 * async-iterable `body`, which is what this plugin's callers consume.
 * @param {string} url - absolute http(s) URL.
 * @param {object} [init] - request options.
 * @param {string} [init.method] - HTTP method.
 * @param {Record<string, string>} [init.headers] - request headers.
 * @param {string} [init.body] - request body.
 * @param {AbortSignal} [init.signal] - cancellation.
 * @returns {Promise<object>} the response facade.
 */
export function nodeFetch(url, init = {}) {
  const target = new URL(url)
  const secure = target.protocol !== 'http:'
  const host = target.hostname
  const port = target.port.length > 0 ? Number(target.port) : secure ? 443 : 80
  const signal = init.signal
  if (signal?.aborted === true) return Promise.reject(abortError(signal))
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = { 'accept-encoding': 'identity', ...(init.headers ?? {}) }
  const body = typeof init.body === 'string' ? init.body : undefined
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
  const proxy = resolveProxy(host)
  const options = {
    method,
    hostname: host,
    port,
    path: `${target.pathname}${target.search}`,
    headers,
    ...proxy === undefined || !secure ? {} : { agent: agentFor(proxy) },
  }
  const transport = secure ? https : http
  return new Promise((resolve, reject) => {
    let settled = false
    const request = transport.request(options, response => {
      const status = response.statusCode ?? 0
      const collect = async () => {
        const chunks = []
        for await (const chunk of response) chunks.push(chunk)
        return Buffer.concat(chunks)
      }
      const result = {
        status,
        ok: status >= 200 && status < 300,
        headers: {
          /**
           * Read one response header.
           * @param {string} name - lower-case header name.
           * @returns {string | null} the header value.
           */
          get(name) {
            const value = response.headers[String(name).toLowerCase()]
            if (Array.isArray(value)) return value.join(', ')
            return value ?? null
          },
        },
        async text() {
          return (await collect()).toString('utf8')
        },
        async json() {
          return JSON.parse((await collect()).toString('utf8'))
        },
        body: {
          /**
           * Stream response bytes.
           * @returns {AsyncGenerator<Uint8Array>} the body chunks.
           */
          async *[Symbol.asyncIterator]() {
            for await (const chunk of response) yield chunk
          },
        },
      }
      settled = true
      resolve(result)
    })
    request.on('error', error => {
      if (settled) return
      settled = true
      reject(signal?.aborted === true ? abortError(signal) : error)
    })
    request.on('timeout', () => {
      request.destroy(new Error('request timed out'))
    })
    if (signal !== undefined) {
      signal.addEventListener('abort', () => {
        request.destroy(abortError(signal))
      }, { once: true })
    }
    if (body !== undefined) request.write(body)
    request.end()
  })
}

/** Reset resolved proxy state; used by tests. */
export function resetProxyCache() {
  cachedProxy = undefined
  cachedProxyAt = 0
  agents.clear()
}
