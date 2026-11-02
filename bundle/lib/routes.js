/**
 * Same-origin HTTP routes backing the plugin's Settings page.
 *
 * These routes are registered on the harness web server so the browser half can
 * read sign-in state and start or cancel a sign-in without any code generation.
 * A route only answers same-origin plugin requests: browsers cannot read the
 * response cross-origin, and the custom request header makes a cross-origin
 * write require a preflight the server never allows.
 *
 * @module dsh-chatgpt-plan/routes
 */

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/plugins/dsh-chatgpt-plan'
/** Header every state-changing request must carry. */
const REQUEST_HEADER = 'x-dsh-plugin-request'

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @returns {void}
 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/**
 * Decide whether one request may reach this plugin's handlers.
 *
 * The connection service owns the trust decision (signed session cookie,
 * cross-site fence, DNS-rebinding host check). The custom header is a second,
 * cheap guard for state-changing calls: a browser cannot send it cross-origin
 * without a preflight this server never approves.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} status - refusal status to write when rejected.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {boolean} mutating - whether the method changes state.
 * @returns {string | undefined} a rejection reason, or undefined to proceed.
 */
function rejection(ctx, req, res, mutating) {
  const connection = ctx.get('connection')
  if (connection !== undefined) {
    const refused = connection.requestRejection({ headers: req.headers })
    if (refused !== undefined) {
      res.statusCode = refused
      res.end()
      return 'untrusted connection'
    }
  }
  if (mutating && req.headers[REQUEST_HEADER] !== '1') return `missing ${REQUEST_HEADER} header`
  return undefined
}

/**
 * Read and parse a small JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {number} [limit] - maximum accepted bytes.
 * @returns {Promise<Record<string, unknown>>} the parsed object, or an empty object.
 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null ? value : {}
  } catch {
    return {}
  }
}

/**
 * Register the plugin's HTTP surface.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying `webServer`.
 * @param {{ status: () => Promise<object>, begin: () => Promise<object>, cancel: () => void, logout: () => Promise<void> }} controller - the sign-in controller.
 * @returns {void}
 */
export function registerRoutes(ctx, controller) {
  const server = ctx.get('webServer')
  if (server === undefined) return
  const route = (path, methods, handler) => {
    ctx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}${path}`,
      handler: async (req, res) => {
        const mutating = req.method !== 'GET' && req.method !== 'HEAD'
        const rejected = rejection(ctx, req, res, mutating)
        if (rejected !== undefined) {
          if (!res.writableEnded) json(res, 403, { error: 'forbidden', message: rejected })
          return
        }
        if (!methods.includes(req.method ?? 'GET')) {
          json(res, 405, { error: 'method_not_allowed' })
          return
        }
        try {
          await handler(req, res)
        } catch (error) {
          json(res, 500, { error: 'internal', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }), `chatgpt-plan: route ${path}`)
  }

  route('/status', ['GET'], async (req, res) => {
    json(res, 200, await controller.status())
  })

  route('/connect', ['POST'], async (req, res) => {
    await readJsonBody(req)
    json(res, 200, await controller.begin())
  })

  route('/cancel', ['POST'], async (req, res) => {
    await readJsonBody(req)
    controller.cancel()
    json(res, 200, await controller.status())
  })

  route('/logout', ['POST'], async (req, res) => {
    await readJsonBody(req)
    await controller.logout()
    json(res, 200, await controller.status())
  })
}
