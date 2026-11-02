/**
 * Responses API wire code for the ChatGPT plan-usage route.
 *
 * The route is the standard Responses API with plan-usage constraints: the
 * request must set `store: false` together with `stream: true`, system input
 * items are rejected (the prompt travels in `instructions`), and a documented
 * set of parameters and hosted tools is refused. This module builds that body,
 * consumes the SSE stream, and maps it onto the harness chunk protocol.
 *
 * @module dsh-chatgpt-plan/responses
 */
import { nodeFetch } from './http.js'
import { RESPONSES_URL } from './siwc.js'

/** Parameters the plan-usage route rejects; they are never sent. */
export const UNSUPPORTED_PARAMS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation',
  'multi_agent', 'prompt', 'prompt_cache_key', 'prompt_cache_options', 'prompt_cache_retention',
  'safety_identifier', 'service_tier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user',
]

/** Hosted tools the plan-usage route does not provide. */
export const UNSUPPORTED_TOOL_TYPES = new Set([
  'code_interpreter', 'file_search', 'image_generation', 'mcp', 'tool_search',
])

/** A provider refusal carrying the neutral failure a finish chunk reports. */
export class PlanProtocolError extends Error {
  /**
   * @param {{ code: string, message: string, status?: number, providerRetryAfterMs?: number }} failure - neutral failure.
   */
  constructor(failure) {
    super(failure.message)
    this.name = 'ChatGptPlanProtocolError'
    this.failure = failure
  }
}

/**
 * Map one HTTP refusal of the subscription route to a neutral failure.
 * @param {number} status - HTTP status.
 * @param {string} text - response body text.
 * @param {Headers | undefined} headers - response headers, for retry hints.
 * @returns {{ code: string, message: string, status: number, providerRetryAfterMs?: number }} the failure.
 */
export function failureFromHttp(status, text, headers) {
  let code
  let message
  try {
    const body = JSON.parse(text)
    const error = body?.error
    code = typeof error === 'object' && error !== null ? error.code ?? error.type : typeof error === 'string' ? error : body?.code
    message = typeof error === 'object' && error !== null ? error.message : body?.message
  } catch {
    // A non-JSON body still carries the status; the message stays the raw excerpt.
    code = undefined
    message = undefined
  }
  const retryAfterMs = headers?.get('retry-after-ms')
  const retryAfter = headers?.get('retry-after')
  const providerRetryAfterMs = retryAfterMs !== null && retryAfterMs !== undefined && Number.isFinite(Number(retryAfterMs))
    ? Number(retryAfterMs)
    : retryAfter !== null && retryAfter !== undefined && Number.isFinite(Number(retryAfter))
      ? Number(retryAfter) * 1000
      : undefined

  const detail = typeof message === 'string' && message.length > 0 ? message : (text || '').slice(0, 400)
  const withSuffix = (base) => (detail.length > 0 ? `${base}: ${detail}` : base)
  const extra = providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }

  if (code === 'subscription_sharing_usage_limit_exceeded') {
    return {
      code: 'QUOTA',
      message: 'ChatGPT plan usage limit reached. Manage the plan usage in ChatGPT settings → Usage, or select another model route.',
      status,
      ...extra,
    }
  }
  if (code === 'subscription_sharing_user_not_eligible') {
    return {
      code: 'AUTH',
      message: 'This ChatGPT account is not eligible to use its plan with this app. Check the plan in ChatGPT settings.',
      status,
      ...extra,
    }
  }
  if (code === 'subscription_sharing_invalid_user' || status === 401) {
    return {
      code: 'AUTH',
      message: withSuffix('ChatGPT sign-in is no longer valid; sign in with ChatGPT again from Settings → ChatGPT'),
      status,
      ...extra,
    }
  }
  if (status === 402) return { code: 'QUOTA', message: withSuffix('ChatGPT plan usage is not available for this request'), status, ...extra }
  if (status === 403) return { code: 'AUTH', message: withSuffix('OpenAI refused this request for this account'), status, ...extra }
  if (status === 429) return { code: 'RATE_LIMIT', message: withSuffix('OpenAI rate limited the request'), status, ...extra }
  if (status === 400 || status === 404 || status === 422) {
    return { code: 'INVALID_REQUEST', message: withSuffix('OpenAI rejected the request'), status, ...extra }
  }
  if (status >= 500) return { code: 'SERVER', message: withSuffix(`OpenAI request failed (${status})`), status, ...extra }
  return { code: 'PROVIDER_ERROR', message: withSuffix(`OpenAI request failed (${status})`), status, ...extra }
}

/**
 * Join the text of a content block list.
 * @param {readonly object[]} blocks - content blocks.
 * @returns the concatenated non-empty text.
 */
function textOf(blocks) {
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
    .map(block => block.text)
    .join('')
}

/**
 * Turn an image attachment block into an `input_image` part.
 * @param {object} block - image content block.
 * @param {Map<string, { mediaType: string, data: string }>} images - resolved request images by attachment id.
 * @returns the Responses input part.
 */
function imagePart(block, images) {
  const id = block?.attachment?.attachmentId
  const image = id === undefined ? undefined : images.get(id)
  if (image === undefined) {
    throw new PlanProtocolError({
      code: 'INVALID_REQUEST',
      message: 'chatgpt-plan: an image in the request could not be resolved for upload',
    })
  }
  return { type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}` }
}

/**
 * Serialize the harness conversation into Responses input items.
 * @param {readonly object[]} messages - request messages, in order.
 * @param {Map<string, { mediaType: string, data: string }>} images - resolved request images.
 * @returns {{ instructions: string | undefined, input: object[] }} the prompt and item list.
 */
function convertMessages(messages, images, system) {
  const instructions = []
  if (typeof system === 'string' && system.length > 0) instructions.push(system)
  const input = []
  let index = 0
  while (index < messages.length && messages[index].role === 'system') {
    const text = textOf(messages[index].content ?? [])
    if (text.length > 0) instructions.push(text)
    index += 1
  }
  for (; index < messages.length; index += 1) {
    const message = messages[index]
    const content = Array.isArray(message.content) ? message.content : []
    if (message.role === 'system' || message.role === 'developer') {
      const parts = []
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          parts.push({ type: 'input_text', text: block.text })
        }
        // Tool additions/removals are already reflected by the tools list this
        // request declares; the route has no in-place tool-change item.
      }
      if (parts.length > 0) input.push({ type: 'message', role: 'developer', content: parts })
      continue
    }
    if (message.role === 'user') {
      const parts = content.flatMap(block => {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          return [{ type: 'input_text', text: block.text }]
        }
        if (block.type === 'image') return [imagePart(block, images)]
        return []
      })
      if (parts.length > 0) input.push({ type: 'message', role: 'user', content: parts })
      continue
    }
    if (message.role === 'tool') {
      const text = textOf(content)
      const imageParts = content.filter(block => block.type === 'image').map(block => imagePart(block, images))
      const output = imageParts.length === 0
        ? text
        : [
          ...(text.length > 0 ? [{ type: 'input_text', text }] : []),
          ...imageParts,
        ]
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output })
      continue
    }
    // Assistant turns: visible text and tool calls are replayed; reasoning
    // blocks are not, because the plan route stores no response objects and
    // this plugin persists no encrypted reasoning to re-reference.
    let pendingText = ''
    const flushText = () => {
      if (pendingText.length === 0) return
      input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: pendingText }] })
      pendingText = ''
    }
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') pendingText += block.text
      else if (block.type === 'reasoning') continue
      else if (block.type === 'tool-call') {
        flushText()
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
      }
    }
    flushText()
  }
  return { instructions: instructions.length > 0 ? instructions.join('\n\n') : undefined, input }
}

/**
 * Convert harness tool schemas into Responses function tools.
 * @param {readonly object[] | undefined} tools - declared tools.
 * @returns the wire tools, or undefined when none survive.
 */
function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const converted = tools
    .filter(tool => typeof tool?.name === 'string' && tool.name.length > 0)
    .map(tool => ({
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: typeof tool.parameters === 'object' && tool.parameters !== null ? tool.parameters : { type: 'object', properties: {} },
    }))
  return converted.length > 0 ? converted : undefined
}

/**
 * Build the plan-usage request body.
 * @param {object} options - the harness generate options.
 * @param {Map<string, { mediaType: string, data: string }>} images - resolved request images.
 * @returns {object} the JSON body to POST.
 */
export function buildRequestBody(options, images) {
  const { instructions, input } = convertMessages(options.messages ?? [], images, options.system)
  const tools = convertTools(options.tools)
  const body = {
    model: options.model,
    input,
    store: false,
    stream: true,
    ...instructions === undefined ? {} : { instructions },
    ...tools === undefined ? {} : { tools },
    ...options.reasoningEffort === undefined ? {} : { reasoning: { effort: options.reasoningEffort, summary: 'auto' } },
  }
  for (const unsupported of UNSUPPORTED_PARAMS) delete body[unsupported]
  return body
}

/**
 * One in-flight response's block bookkeeping.
 */
class StreamState {
  constructor() {
    /** @type {Map<string, { index: number, type: string, text: string, args: string, callId?: string, name?: string }>} */
    this.blocks = new Map()
    this.nextIndex = 0
    this.toolCalls = 0
    this.opened = 0
    this.usage = undefined
    this.done = false
  }

  /**
   * Open one block for a streamed output item.
   * @param {object} item - the output item.
   * @returns {object[]} chunks to emit.
   */
  open(item) {
    const id = item?.id ?? item?.item_id
    if (typeof id !== 'string' || this.blocks.has(id)) return []
    const type = item.type === 'function_call'
      ? 'tool-call'
      : item.type === 'reasoning' || item.type === 'reasoning_summary'
        ? 'reasoning'
        : item.type === 'message'
          ? 'text'
          : undefined
    if (type === undefined) return []
    const block = {
      index: this.nextIndex++,
      type,
      text: '',
      args: '',
      ...item.type === 'function_call'
        ? { callId: typeof item.call_id === 'string' ? item.call_id : id, name: typeof item.name === 'string' ? item.name : '' }
        : {},
    }
    this.blocks.set(id, block)
    this.opened += 1
    if (type === 'tool-call') this.toolCalls += 1
    const chunks = [{ type: 'block-start', index: block.index, blockType: type }]
    if (type === 'tool-call') {
      if (typeof item.arguments === 'string' && item.arguments.length > 0) block.args = item.arguments
      chunks.push({
        type: 'tool-call-delta',
        index: block.index,
        id: block.callId,
        name: block.name,
        argumentsDelta: block.args,
      })
    }
    return chunks
  }

  /**
   * Find the open block for one item id.
   * @param {unknown} itemId - the event's item id.
   * @returns {object | undefined} the block state.
   */
  block(itemId) {
    return typeof itemId === 'string' ? this.blocks.get(itemId) : undefined
  }

  /**
   * Append a text-like delta.
   * @param {unknown} itemId - item id.
   * @param {string} delta - appended text.
   * @param {'text' | 'reasoning'} kind - which delta kind to emit.
   * @returns {object[]} chunks to emit.
   */
  delta(itemId, delta, kind) {
    const block = this.block(itemId)
    if (block === undefined || typeof delta !== 'string' || delta.length === 0) return []
    block.text += delta
    return [{ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: delta }]
  }

  /**
   * Close the block for one finished output item.
   * @param {object} item - the finished output item.
   * @returns {object[]} chunks to emit.
   */
  close(item) {
    const id = item?.id ?? item?.item_id
    const block = this.block(id)
    if (block === undefined) return []
    this.blocks.delete(id)
    if (block.type === 'tool-call') {
      const argumentsText = typeof item?.arguments === 'string' && item.arguments.length > 0 ? item.arguments : block.args
      if (argumentsText !== block.args) {
        const suffix = argumentsText.slice(block.args.length)
        if (suffix.length > 0) {
          block.args = argumentsText
          return [
            { type: 'tool-call-delta', index: block.index, id: block.callId, argumentsDelta: suffix },
            { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.callId, name: block.name, arguments: argumentsText } },
          ]
        }
      }
      return [{
        type: 'block-end',
        index: block.index,
        block: { type: 'tool-call', id: block.callId, name: block.name, arguments: block.args || argumentsText },
      }]
    }
    if (block.type === 'reasoning') {
      return [{ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }]
    }
    const text = block.text.length > 0 ? block.text : textOf(item?.content ?? [])
    return [{ type: 'block-end', index: block.index, block: { type: 'text', text } }]
  }

  /**
   * Close every block still open when the stream ends early.
   * @returns {object[]} remaining block-end chunks.
   */
  closeAll() {
    const chunks = []
    for (const [id, block] of [...this.blocks.entries()]) {
      chunks.push(...this.close({ id }))
    }
    return chunks
  }

  /**
   * Read usage from one response object.
   * @param {object} response - a completed/incomplete response.
   * @returns {object | undefined} the usage chunk.
   */
  usageChunk(response) {
    const usage = response?.usage
    if (typeof usage !== 'object' || usage === null) return undefined
    const totalInput = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0
    const output = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0
    const cached = Number.isFinite(usage.input_tokens_details?.cached_tokens) ? usage.input_tokens_details.cached_tokens : 0
    const cacheWrite = Number.isFinite(usage.input_tokens_details?.cache_write_tokens) ? usage.input_tokens_details.cache_write_tokens : 0
    const reasoning = Number.isFinite(usage.output_tokens_details?.reasoning_tokens) ? usage.output_tokens_details.reasoning_tokens : undefined
    // The Responses API folds cached input into `input_tokens`; the harness
    // counts cache reads and writes beside a non-cached input count.
    const input = Math.max(0, totalInput - cached - cacheWrite)
    return {
      type: 'usage',
      usage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : totalInput + output,
        ...cached > 0 ? { cacheReadTokens: cached } : {},
        ...cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
        ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
      },
    }
  }
}

/**
 * Split one raw SSE frame into its event name and JSON data.
 * @param {string} frame - one frame's text without the terminating blank line.
 * @returns {{ event: string | undefined, data: object | undefined }} the parsed frame.
 */
function parseFrame(frame) {
  let event
  const dataLines = []
  for (const line of frame.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim()
    else if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trimStart())
  }
  if (dataLines.length === 0) return { event, data: undefined }
  const raw = dataLines.join('\n')
  if (raw === '[DONE]') return { event, data: undefined }
  try {
    return { event, data: JSON.parse(raw) }
  } catch {
    return { event, data: undefined }
  }
}

/**
 * Stream one Responses API call and translate it into harness chunks.
 *
 * The generator throws {@link PlanProtocolError} when the route refuses the
 * request outright; in-stream `error`/`response.failed` events become a
 * terminal error finish chunk instead.
 * @param {object} request - the call.
 * @param {string} request.accessToken - plan-usage access token.
 * @param {object} request.body - request body from {@link buildRequestBody}.
 * @param {AbortSignal | undefined} request.signal - caller cancellation.
 * @param {typeof fetch} [request.fetchImpl] - injectable fetch.
 * @yields {object} harness stream chunks.
 */
export async function* planStream({ accessToken, body, signal, fetchImpl = nodeFetch }) {
  const init = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  }
  if (signal !== undefined) init.signal = signal
  const response = await fetchImpl(RESPONSES_URL, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new PlanProtocolError(failureFromHttp(response.status, text, response.headers))
  }
  if (response.body === null) {
    throw new PlanProtocolError({ code: 'PROVIDER_ERROR', message: 'chatgpt-plan: OpenAI returned no response stream' })
  }
  const state = new StreamState()
  const decoder = new TextDecoder()
  let buffer = ''
  let finishedWithError
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      const { event, data } = parseFrame(frame)
      if (data === undefined) continue
      switch (data.type ?? event) {
        case 'response.output_item.added': {
          for (const emitted of state.open(data.item)) yield emitted
          break
        }
        case 'response.output_text.delta': {
          for (const emitted of state.delta(data.item_id, data.delta, 'text')) yield emitted
          break
        }
        case 'response.refusal.delta': {
          for (const emitted of state.delta(data.item_id, data.delta, 'text')) yield emitted
          break
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          for (const emitted of state.delta(data.item_id, data.delta, 'reasoning')) yield emitted
          break
        }
        case 'response.function_call_arguments.delta': {
          const block = state.block(data.item_id)
          if (block !== undefined && typeof data.delta === 'string' && data.delta.length > 0) {
            block.args += data.delta
            yield { type: 'tool-call-delta', index: block.index, id: block.callId, argumentsDelta: data.delta }
          }
          break
        }
        case 'response.output_item.done': {
          for (const emitted of state.close(data.item)) yield emitted
          break
        }
        case 'response.completed':
        case 'response.incomplete': {
          for (const emitted of state.closeAll()) yield emitted
          const usage = state.usageChunk(data.response)
          if (usage !== undefined) yield usage
          if (data.type === 'response.incomplete') {
            const reason = data.response?.incomplete_details?.reason
            if (reason === 'content_filter') {
              yield {
                type: 'finish',
                reason: { kind: 'error', failure: { code: 'CONTENT_FILTER', message: 'OpenAI refused to finish this response because of a content filter.' } },
              }
            } else {
              yield { type: 'finish', reason: { kind: 'max-tokens' } }
            }
            state.done = true
            return
          }
          const hasToolCall = state.toolCalls > 0
            || (data.response?.output ?? []).some(item => item?.type === 'function_call')
          if (hasToolCall) {
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          } else if (state.opened === 0) {
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: { code: 'EMPTY_RESPONSE', message: 'OpenAI completed the response without any visible content.' },
              },
            }
          } else {
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
          state.done = true
          return
        }
        case 'response.failed': {
          for (const emitted of state.closeAll()) yield emitted
          const error = data.response?.error
          finishedWithError = failureFromHttp(
            typeof error?.status === 'number' ? error.status : 500,
            JSON.stringify({ error: { code: error?.code, message: error?.message } }),
            response.headers,
          )
          break
        }
        case 'error': {
          for (const emitted of state.closeAll()) yield emitted
          finishedWithError = failureFromHttp(
            typeof data.status === 'number' ? data.status : 500,
            JSON.stringify({ error: { code: data.code, message: data.message } }),
            response.headers,
          )
          break
        }
        default:
          break
      }
      if (finishedWithError !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure: finishedWithError } }
        state.done = true
        return
      }
    }
  }
  for (const emitted of state.closeAll()) yield emitted
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { code: 'TRANSPORT', message: 'chatgpt-plan: the response stream ended before response.completed' },
    },
  }
}
