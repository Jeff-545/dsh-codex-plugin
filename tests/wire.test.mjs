/**
 * Verification of the plan-usage request builder and SSE translation.
 *
 * Covers the plan-route constraints (store/stream, forbidden parameters,
 * system folding, tool conversion) and the chunk sequence the assembler needs
 * for text, reasoning, tool calls, usage, and a terminal finish.
 */
import { createAuthorizationRequest, parseCallbackUrl } from '../bundle/lib/siwc.js'
import { buildRequestBody, planStream } from '../bundle/lib/responses.js'

// 1. authorization URL
const req = createAuthorizationRequest({ extAgentHostId: 'urn:uuid:test-host', redirectUri: 'http://127.0.0.1:1456/auth/callback' })
const u = new URL(req.url)
const need = ['response_type','client_id','redirect_uri','scope','resource','state','nonce','code_challenge','code_challenge_method','ext_agent_host_id','agent_name_hint']
const missing = need.filter(k => !u.searchParams.get(k))
console.log('AUTH URL params ok:', missing.length === 0, '| registration:', req.registration, '| missing:', missing)
console.log('client_id =', u.searchParams.get('client_id'), '| scope =', u.searchParams.get('scope'))
console.log('redirect =', u.searchParams.get('redirect_uri'))
console.log('parseCallback:', parseCallbackUrl('http://127.0.0.1:1456/auth/callback?code=abc&state=s1&client_id=oaiapp_x'))

// 2. request body
const options = {
  provider: 'chatgpt-plan', model: 'gpt-6.1-sol', reasoningEffort: 'high', maxTokens: 1234, temperature: 0.4,
  system: 'SYS-PROMPT',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'HIST-LEADING-SYSTEM' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    ] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'a.txt' }], source: { kind: 'tool' } },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ],
  tools: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
}
const body = buildRequestBody(options, new Map())
console.log('\nBODY =', JSON.stringify(body, null, 1))
for (const banned of ['temperature','max_output_tokens','store','stream']) {
  if (banned === 'store' || banned === 'stream') { if (body[banned] !== (banned==='stream')) throw new Error(`${banned} wrong`); continue }
  if (banned in body) throw new Error(`rejected param present: ${banned}`)
}

// 3. SSE translation
const sse = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.added', item: { id: 'item_1', type: 'reasoning' } },
  { type: 'response.reasoning_summary_text.delta', item_id: 'item_1', delta: 'plan ' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'item_1', delta: 'the code' },
  { type: 'response.output_item.done', item: { id: 'item_1', type: 'reasoning' } },
  { type: 'response.output_item.added', item: { id: 'item_2', type: 'message' } },
  { type: 'response.output_text.delta', item_id: 'item_2', delta: 'Hello' },
  { type: 'response.output_text.delta', item_id: 'item_2', delta: ', world!' },
  { type: 'response.output_item.done', item: { id: 'item_2', type: 'message', content: [] } },
  { type: 'response.output_item.added', item: { id: 'item_3', type: 'function_call', call_id: 'call_9', name: 'bash' } },
  { type: 'response.function_call_arguments.delta', item_id: 'item_3', delta: '{"command"' },
  { type: 'response.function_call_arguments.delta', item_id: 'item_3', delta: ':"ls"}' },
  { type: 'response.output_item.done', item: { id: 'item_3', type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' } },
  { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 5 } }, output: [{ type: 'function_call' }] } },
]
const payload = sse.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const fakeFetch = async () => new Response(new ReadableStream({
  start(controller) {
    const bytes = new TextEncoder().encode(payload)
    controller.enqueue(bytes.slice(0, 40)); controller.enqueue(bytes.slice(40)); controller.close()
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const chunks = []
for await (const c of planStream({ accessToken: 'tok', body, fetchImpl: fakeFetch })) chunks.push(c)
console.log('\nCHUNKS:')
for (const c of chunks) console.log(JSON.stringify(c))
