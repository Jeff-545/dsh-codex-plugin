# 02 — SIWC wire contract: ChatGPT plan usage via `api.openai.com/v1`

**Deliverable for task-2 (pivoted).** Route: **Sign in with ChatGPT (SIWC) open-source token sharing** —
the plan OAuth access token is used as a bearer token against the **standard Responses API**
`https://api.openai.com/v1`, under plan-usage ("subscription sharing") constraints.

This supersedes the earlier `research/02-codex-wire.md` topic (`chatgpt.com/backend-api/codex`).
The Codex-backend findings are preserved in `research/02-codex-wire.md` as an appendix; they are
**not** this contract and must not be mixed into it.

Status: **read-only research. No live API calls were made with the user's credentials.** All token /
account values below are placeholders.

---

## 0. Evidence map

| # | Evidence | What it establishes |
|---|---|---|
| E1 | `research/ref/chatgpt_plan_auth/chatgpt_plan_auth/const.py`, `requests.py`, `catalog.py`, `client.py`, `auth.py`, `_compat.py` — MIT reference implementation (v1.0.2, extracted from Home Assistant core `openai_conversation/chatgpt_auth.py`) | SIWC endpoints, scopes, client registration, token refresh; **rejected params/tools**; required `store:false` + `stream:true`; system-prompt folding into `instructions`; catalog shape; error codes; 401 refresh-once behavior |
| E2 | `METADATA` of the same wheel | README: docs URL `https://developers.openai.com/siwc/token-sharing-open-source/`; "access token is used as the bearer token against `https://api.openai.com/v1` instead of an API key"; catalog can be unavailable (HTTP 520 observed) |
| E3 | Installed DSH bundle (`read` tool, app.asar paths): `dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js` + `openai-responses-shared.js` | Production request builder and **SSE→event mapping** for the public Responses API, including an explicit `isChatGPTSignIn()` branch that omits fields the ChatGPT sign-in route rejects |
| E4 | Installed DSH bundle: `dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js` | SSE parser/framing robustness; terminal-event and `[DONE]` handling patterns (Codex route, same event vocabulary) |
| E5 | Installed DSH bundle: `dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js` (`toStreamChunks`, `mapUsage`, `mapStopReason`, `toPiReplayState`, `readReplayState`) | The **exact DSH `StreamChunk` vocabulary** this adapter must emit, plus how replay state is carried across turns |
| E6 | Installed DSH bundle: `dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/assembler.js`, `assistant-stream.js` | Authoritative chunk shapes and assembly semantics (`block-start/end`, delta-only tolerance, `usage`, `finish` shapes) |
| E7 | openai-node `src/resources/responses/responses.ts` (raw.githubusercontent.com, `master`) | Authoritative public Responses API event names/payloads, `Response`, `ResponseUsage`, tool/content/input-item interfaces |
| E8 | openai-node `src/client.ts`, `src/core/streaming.ts` | SDK header defaults (`Accept: application/json` even for streams; bearer auth injected), `[DONE]` sentinel, in-band `error`/`data.error` handling |
| E9 | `~/.codex/models_cache.json` (0.166.0) | **Hints only** for model slugs / context windows / reasoning levels (Codex catalog, not the SIWC catalog) |

Docs pages (`developers.openai.com/siwc/...`, `platform.openai.com/docs/...`) returned HTTP 403 from this
environment; the reference implementation (E1) is treated as the authoritative encoding of the route's
constraints, cross-checked against E7/E8 for the underlying API.

---

## 1. Transport

### 1.1 Endpoint

```
POST https://api.openai.com/v1/responses
```

Streaming response, `Content-Type: text/event-stream` (SSE). **No other endpoint** is part of this
contract for inference. (The Codex `chatgpt.com/backend-api/codex/responses` endpoint is a different
route with different auth headers — do not target it.)

Model catalog (picker / availability):

```
GET https://api.openai.com/v1/models
Authorization: Bearer <plan access token>
```

### 1.2 Required headers

```
Authorization: Bearer <chatgpt-plan access token>   # required; this is NOT an sk- API key
Content-Type: application/json
Accept: text/event-stream                            # recommended for SSE; SDK actually sends application/json and works
```

Optional / default-only headers (do **not** add Codex-specific ones):

| Header | Send? | Note |
|---|---|---|
| `User-Agent` | optional | any stable product string; not validated by the contract |
| `OpenAI-Beta` | **no** | Codex-route header (`responses=experimental`); not part of public Responses API |
| `chatgpt-account-id` | **no** | Codex-route header; the plan route derives identity from the bearer token |
| `session-id` / `thread-id` / `x-client-request-id` | **no** | Codex-route cache/routing headers; no conversation affinity exists here |
| `x-stainless-*`, `OpenAI-Organization`, `OpenAI-Project` | **no** | SDK metadata; irrelevant and safe to omit |
| `OpenAI-Organization`/`Project` | no | do not send; plan credential is not an org/project key |

Evidence: E1 `client.py` builds a stock `AsyncOpenAI` (only `Authorization` is added per-request by the
httpx auth flow in `_compat.py`); E8 shows the SDK's own defaults. There is no SIWC-specific header.

### 1.3 Auth lifecycle (the only "refresh contract")

- Token = OAuth **access token** from the SIWC code exchange; used verbatim as `Bearer`.
- Access tokens live ~1 h; refresh tokens ~30 days; refresh **rotates** the refresh token on every use.
- Refresh endpoint: `POST https://auth.openai.com/api/accounts/oauth/token`
  form-encoded:
  `grant_type=refresh_token&client_id=<oaiapp_...>&refresh_token=<rt>&resource=https://api.openai.com/v1`
- Refresh **5 min before expiry** (`TOKEN_EXPIRY_MARGIN`), and again on a 401.
- On HTTP **401**: refresh once, replay the request **once** with the new token; if the refresh fails with
  a fatal code (`invalid_grant`, `invalid_client`, `invalid_refresh_token`, `refresh_token_expired`,
  `refresh_token_invalidated`, `refresh_token_reused`, `token_expired`) the stored credential is dead →
  surface `AUTH` to the user and re-run SIWC sign-in. Transient refresh failures are retryable.
- A token endpoint may return `earliest_refresh_at`: do not refresh before it.

Evidence: E1 `const.py` (`TOKEN_EXPIRY_MARGIN`, `FATAL_REFRESH_ERRORS`, `TOKEN_URL`, `RESOURCE`),
`auth.py` (`ChatGPTAuth.async_get_access_token`, `async_handle_authentication_error`, `_async_refresh`),
`_compat.py` (`_SubscriptionAuth.async_auth_flow` = attach → 401 → refresh → replay once), `client.py`
(`max_retries` bounded to 1).

---

## 2. Request body contract

### 2.1 Field matrix

**Required** (route rejects the request without them):

```jsonc
{
  "model": "<catalog slug>",
  "input": [ /* items, see §2.3 */ ],
  "stream": true,
  "store": false
}
```

**Allowed optional fields** (present in the public Responses API, not in the route's rejection list):

| Field | Shape | Recommendation |
|---|---|---|
| `instructions` | string (system/developer prompt) | **Send the whole DSH system prompt here** (see §2.2) |
| `tools` | array of function tools and/or `{ "type": "web_search" }` | §3 |
| `tool_choice` | literal `"auto"` \| `"none"` \| `"required"` | omit (server default `auto`); **never** send the object form |
| `parallel_tool_calls` | boolean | omit (server default true) or `true`; never `false`-gate DSH parallelism via this field |
| `reasoning` | `{ "effort": "low"\|"medium"\|"high"\|"xhigh"\|..., "summary": "auto"\|"concise"\|"detailed"\|null }` | `{effort, summary:"auto"}` when the user picked a level; omit entirely for "off" |
| `text` | `{ "verbosity": "low"\|"medium"\|"high" }` | optional; DSH `textVerbosity` maps directly |
| `include` | `["reasoning.encrypted_content"]` | **uncertain for this route** — only send if reasoning replay is enabled and a probe shows it is accepted (§6.3, U1) |

**Forbidden — must never be sent** (route rejects them; `SUBSCRIPTION_UNSUPPORTED_PARAMS` in E1):
`background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`,
`multi_agent`, `prompt`, `prompt_cache_key`, `prompt_cache_options`, `prompt_cache_retention`,
`safety_identifier`, `service_tier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`.

Also absent/forbidden because they require stored state: `previous_response_id`, `conversation`.
`stream_options` is **not** in the rejection list, but it is unnecessary → omit (U4).

`include` note: no `prompt_cache_key` means no explicit cache routing; the route may still reuse its own
prefix cache implicitly. Do not rely on `cached_tokens > 0`.

### 2.2 System/developer prompt rule (the #1 naive-port bug)

The route **does not accept an explicit `system`-role input item**. DSH gives the adapter
`options.system` (rendered system prompt) plus a `messages` array whose leading entries may be
`role: 'system'` (and developer messages can occur mid-history — `createDeveloperMessage` in
`dsh-llm/lib/types/message.js`).

Builder rule (mirrors E1 `shape_request_for_subscription`):

1. `instructions` = `options.system` text.
2. Walk `messages` from index 0 while the role is `system` (and, defensively, `developer`):
   append each message's flattened text to `instructions` with `"\n\n"` separators, and do not emit it
   as an input item.
3. For any later `system` item: either fold it into `instructions` the same way (safest; loses position)
   or rewrite the role to `developer` (E1's exact behavior; developer items are accepted). Recommended:
   fold — the model then sees one coherent instruction block and we never risk a `system` item.
4. Every remaining message becomes an input item (§2.3). **Never emit `role: "system"`.**
5. If `instructions` is empty, omit the field (or send a trivial default; omitting is closer to the API's
   normal behavior).

### 2.3 Input item shapes (stateless, `store:false`)

All conversation state is re-sent **in full** on every turn. The adapter builds `input` from the DSH
message list in order.

**User message** (text and/or images):

```json
{ "role": "user", "content": [ { "type": "input_text", "text": "..." } ] }
```

```json
{ "role": "user", "content": [
  { "type": "input_text",  "text": "what is this?" },
  { "type": "input_image", "detail": "auto", "image_url": "data:image/png;base64,<...>" }
] }
```

- `content` may also be a plain string (valid per `EasyInputMessage`), but the parts form is uniform and
  required as soon as there is an image.
- `input_image` needs either `image_url` (fully-qualified URL or base64 data URL) or `file_id`;
  DSH images are request-prepped then inlined as `data:<mime>;base64,<...>`. `detail` ∈
  `high|low|auto|original`.
- Tool-result images become `input_text` + `input_image` parts inside the `function_call_output`
  `output` array (same shapes as E3's `convertToolResultOutput`).

**Assistant message** (replayed text):

```json
{ "role": "assistant",
  "content": [ { "type": "output_text", "text": "..." } ] }
```

- `output_text` (not `input_text`) is the part type used when replaying assistant output; E3 emits exactly
  this with `annotations: []` (annotations are optional on input).
- Optional `"phase": "commentary" | "final_answer"` on assistant messages: current models use it to mark
  intermediate vs final answers and the API notes it should be preserved on follow-ups. Carry it through
  the replay envelope when the streaming item reported it (`U6`).
- Do **not** include empty text parts or empty messages (drop them; the API rejects empty content arrays).

**Function call** (model action replayed for the tool result that follows):

```json
{ "type": "function_call", "call_id": "call_...", "name": "shell",
  "arguments": "{\"cmd\":\"ls\"}", "id": "fc_..." }
```

- `call_id` is the key that pairs the call with its `function_call_output`; `id` (the `fc_...` server item
  id) is optional on replay — include it if the adapter captured it, since some backends treat item id
  pairing strictly. Keep `arguments` as the **JSON string** exactly as the model produced it (do not
  reserialize if digits/formatting matter is not an issue, but keep it valid JSON).

**Function call output** (tool result):

```json
{ "type": "function_call_output", "call_id": "call_...",
  "output": "total 0\n..." }
```

- `output` is a string, or an array of content parts (`{type:"input_text",text}`, `{type:"input_image",...}`)
  when the tool returned images.
- `call_id` **must** equal the `call_id` of the preceding `function_call` item (DSH guarantees this: it
  enforces the id by using the tool-call block id as `message.toolCallId` — see
  `dsh-agent-loop/lib/index.js` `appendToolResult` / `executeToolCalls`).
- Mark tool errors in-band in the text (e.g. prefix the result with an error line); there is no error flag
  on this item shape.

**Reasoning item** (only if reasoning replay is enabled — §6.3):

```json
{ "type": "reasoning", "id": "rs_...", "summary": [ {"type":"summary_text","text":"..."} ],
  "encrypted_content": "<opaque>", "content": [] }
```

Ordering: replay items in the **original provider output order** (reasoning item(s) first, then the
assistant message and/or function calls), then the following user/tool items. This is exactly what E3's
`convertResponsesMessages` does when walking assistant content blocks (`thinking` → `text` → `toolCall`).

### 2.4 Minimal working request (streaming, one user turn, one function tool)

```json
{
  "model": "gpt-6.1-sol",
  "instructions": "You are a helpful agent working in the user's workspace. ...",
  "input": [
    { "role": "user", "content": [ { "type": "input_text", "text": "List the files in the repo." } ] }
  ],
  "tools": [
    { "type": "function", "name": "shell",
      "description": "Run a shell command.",
      "parameters": {
        "type": "object",
        "properties": { "cmd": { "type": "string", "description": "Command line to execute" } },
        "required": ["cmd"],
        "additionalProperties": false
      } }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": { "effort": "medium", "summary": "auto" },
  "text": { "verbosity": "low" },
  "stream": true,
  "store": false
}
```

Second turn (after the tool ran) — same fields, full history, call/output pair replayed:

```json
{
  "model": "gpt-6.1-sol",
  "instructions": "You are a helpful agent working in the user's workspace. ...",
  "input": [
    { "role": "user", "content": [ { "type": "input_text", "text": "List the files in the repo." } ] },
    { "type": "function_call", "call_id": "call_abc", "name": "shell",
      "arguments": "{\"cmd\":\"ls\"}", "id": "fc_abc" },
    { "type": "function_call_output", "call_id": "call_abc", "output": "README.md\nsrc\n" }
  ],
  "tools": [ { "type": "function", "name": "shell", "description": "Run a shell command.",
               "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } },
                               "required": ["cmd"], "additionalProperties": false } } ],
  "stream": true,
  "store": false
}
```

Do **not** add `max_output_tokens`, `temperature`, `prompt_cache_key`, `service_tier`, `metadata`,
`truncation`, `user`, `conversation`, `previous_response_id`, `background` on any turn.

---

## 3. Tools

### 3.1 DSH tool → Responses function tool

DSH hands the adapter tools shaped `{ name, description, parameters /* JSON Schema */, deferLoading? }`
(evidence: E5 `piTool`/`toolsOf` in `dsh-llm-pi-ai/lib/index.js`).

Emit **flat** function tools (the Responses function tool is flat — `name`/`description`/`parameters` are
top-level, not nested under a `function` object):

```json
{ "type": "function", "name": "<tool name>", "description": "<tool description>",
  "parameters": { "type": "object", "properties": { }, "required": [], "additionalProperties": false } }
```

- `parameters` = the DSH JSON Schema as-is.
- `strict`: optional boolean. Only set `true` if the schema is strict-compatible (object at root,
  `additionalProperties:false`, every property listed in `required`). DSH schemas are generally not
  normalized for that, so **omit `strict`** (server default false) — this matches E3, which sends
  `strict` only when the model compat flag and the schema resolution say so.
- Do not send tool names/descriptions beyond what DSH provides; no `output_schema`, `allowed_callers`,
  `defer_loading` fields on this route.

Built-in tools:

- `web_search` is the **only** hosted tool the route can offer (subject to plan/policy):
  `{"type": "web_search"}` (optionally `{"type":"web_search_2025_08_26"}`; `search_context_size`,
  `filters`, `external_web_access` optional). Expose it only if the plugin decides to surface a
  web-search capability; otherwise omit.
- Never send `code_interpreter`, `file_search`, `image_generation`, `mcp`, `tool_search`
  (`SUBSCRIPTION_UNSUPPORTED_TOOL_TYPES`); a request carrying them fails with
  `subscription_sharing_unsupported_capability` (or 400) — strip them defensively before send.
- DSH tools with `deferLoading: true` (harness-owned, not model-callable declarations) are not sent
  (E5 filters them out).

### 3.2 tool_choice / parallel_tool_calls

- `tool_choice`: only the literals `"auto"`, `"none"`, `"required"`. A **named object**
  (`{"type":"function","name":"shell"}`) is not accepted → drop it (E1 does exactly this). DSH's
  `GenerateOptions` does not expose a tool choice, so the simplest correct behavior is to omit the field.
- `parallel_tool_calls`: not rejected; omit and let the server default (true) apply. DSH's agent loop
  already schedules tool calls concurrently (evidence: `dsh-agent-loop` tool-call scheduler), so do not
  send `false`. Never send `max_tool_calls` (rejected).
- If a tool call is truncated mid-stream, do not emit its block-end and do not execute it; DSH's
  assembler drops an unfinished tool-call block at max-token finish (`assembler.js` `assembled()`).

---

## 4. SSE stream contract

### 4.1 Framing

```
event: response.output_text.delta
data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_...","delta":"Hel","sequence_number":42,...}

data: [DONE]

```

Client rules:

1. Split on `\n\n`; for each frame collect `data:` lines (may be multi-line), join with `\n`.
2. Parse the JSON from the `data:` payload. **Switch on the `type` field of the JSON, not on the
   `event:` line** (both agree in practice; E4's parser ignores `event:` lines, E8 yields the JSON and
   only special-cases the `event` name for `error`).
3. `data: [DONE]` is end-of-stream (E8). Treat it like a clean transport end; it must be preceded by a
   terminal response event in a healthy stream.
4. EOF/connection close **before** a terminal event (`response.completed` / `response.incomplete` /
   `response.failed` / `error`) is a **transport error** (retryable) — do not emit a `stop` finish.
5. Unknown event types and unknown fields are ignored (forward compatibility). Do not throw on them.
6. In-band API errors can arrive as `{"type":"error", ...}` or as a data payload containing `{"error": {...}}`
   (E8 throws on both). Treat both as terminal failures.

### 4.2 Event table (public Responses API; E7 types, E3 handling)

`output_index` keys a stream slot; `content_index`/`summary_index` are sub-indices inside that item.
DSH block index = slot ordinal assigned when the item is first created (0,1,2,… in stream order), **not**
`output_index` (E3 `createSlot`/`getOrCreateSlot`).

| SSE `type` | Payload fields we consume | Action on the DSH stream |
|---|---|---|
| `response.created` | `response.id`, `response.model`, `response.status` | none (store `responseId` for replay state / logs) |
| `response.in_progress`, `response.queued` | `response` | ignore |
| `response.output_item.added` | `output_index`, `item` (`type`: `reasoning` \| `message` \| `function_call` \| `web_search_call` \| …) | create slot: `reasoning`→`block-start {index, blockType:"reasoning"}`; `message`→`block-start {index, blockType:"text"}`; `function_call`→`block-start {index, blockType:"tool-call"}` (capture `item.call_id`, `item.name`, `item.id`); `web_search_call`→ignore (or surface as UI activity, never as content) |
| `response.content_part.added` | `output_index`, `content_index`, `item_id`, `part` | ignore (slot already created; part type only matters at `output_item.done`) |
| `response.output_text.delta` | `output_index`, `content_index`, `delta`, `item_id` | `text-delta {index, text: delta}`; accumulate |
| `response.refusal.delta` | `output_index`, `content_index`, `delta` | `text-delta {index, text: delta}`; accumulate (E3 maps refusal deltas into the same text block) |
| `response.output_text.done` / `response.refusal.done` | `text` | ignore (final text comes from `output_item.done`) |
| `response.reasoning_summary_part.added` | `output_index`, `summary_index`, `part` | ignore (or separator bookkeeping) |
| `response.reasoning_summary_text.delta` | `output_index`, `summary_index`, `delta` | `reasoning-delta {index, text: delta}`; accumulate |
| `response.reasoning_summary_part.done` | `output_index`, `summary_index` | optional: emit `reasoning-delta {index, text:"\n\n"}` separator (E3 does) |
| `response.reasoning_summary_text.done` | `text`, `summary_index` | ignore (authoritative text at `output_item.done`) |
| `response.reasoning_text.delta` | `output_index`, `content_index`, `delta` | `reasoning-delta {index, text: delta}` (raw reasoning content, only when the model emits it) |
| `response.reasoning_text.done` | `text` | ignore |
| `response.function_call_arguments.delta` | `output_index`, `delta`, `item_id` | `tool-call-delta {index, id, name?, argumentsDelta: delta}`; accumulate the raw JSON string |
| `response.function_call_arguments.done` | `output_index`, `arguments` (full string) | reconcile: replace the accumulated buffer with `arguments`; if `arguments` starts with the prior buffer, emit the remaining suffix as one `tool-call-delta` (E3 does) |
| `response.output_item.done` | `output_index`, `item` | **finalize the slot** (see §4.3): `block-end` with the completed block, then release the slot |
| `response.web_search_call.{in_progress,searching,completed}` | `output_index`, `item_id` | ignore (optional: map to a UI activity indicator; no DSH chunk type) |
| `response.completed` | `response` (full object: `id`, `status:"completed"`, `output[]`, `usage`, `incomplete_details:null`, …) | finalize: usage + `finish {reason}`; if any function call was finalized → `reason:{kind:"tool-calls"}`, else `{kind:"stop"}` (unless empty-content rule below) |
| `response.incomplete` | `response.status:"incomplete"`, `response.incomplete_details.reason` (`max_output_tokens` \| `max_messages` \| `content_filter` \| `steered`), `response.usage` | finalize: usage + finish. `max_output_tokens`/`max_messages` → `{kind:"max-tokens"}`; `content_filter` → error `CONTENT_FILTER`; `steered` → treat as stop only if a complete assistant message exists, else error |
| `response.failed` | `response.status:"failed"`, `response.error.{code,message,param,type}`, `response.incomplete_details` | terminal error: `finish {kind:"error", failure:{message, code}}` — do not retry in-place (401/429 handling belongs to the transport layer) |
| `error` | `code`, `message`, `param` (top level) | terminal error, same mapping as `response.failed` |
| everything else (`response.output_text.annotation.added`, `response.file_search_call.*`, `response.image_generation_call.*`, `response.mcp_*`, `response.audio.*`, …) | — | ignore |

Note: there is **no** `response.done` event on the public API (that is Codex-route only, E4). Terminal
events are `response.completed` / `response.incomplete` / `response.failed` / `error`.

### 4.3 Finalizing slots at `response.output_item.done`

This is where the DSH block-end content comes from. Mirror E3 `processResponsesStream`:

**`item.type === "reasoning"`** (slot is a reasoning block):
- `text` = `item.summary?.map(s => s.text).join("\n\n")` if non-empty, else
  `item.content?.map(c => c.text).join("\n\n")`, else the accumulated delta text.
- emit `block-end {index, block:{type:"reasoning", text}}`.
- **persist the whole `item` object** (at minimum `{id, type:"reasoning", summary, encrypted_content}`)
  as the block's `thinkingSignature` for replay; `encrypted_content` is only complete here (E7
  `ResponseReasoningItem` doc: the `added` copy may be incomplete).

**`item.type === "message"`** (slot is a text block):
- `text` = `item.content?.map(c => c.type === "output_text" ? c.text : c.refusal).join("")`.
- emit `block-end {index, block:{type:"text", text}}`.
- persist `item.id` and `item.phase` (`commentary`/`final_answer`) for replay.

**`item.type === "function_call"`** (slot is a tool-call block):
- `arguments` = `item.arguments` if present, else the accumulated delta buffer; parse to an object **for
  DSH** (DSH tool-call blocks carry `arguments` as a JSON **string**; the agent loop parses it —
  `executeToolCalls` calls `parseArguments(block.arguments)`).
- emit `block-end {index, block:{type:"tool-call", id: <call_id>, name: <name>,
  arguments: <JSON string>}}`.
- If no `output_item.done` arrived for a function call, do not emit its block-end; the stream did not
  deliver a complete call (E3 refuses to hand over unfinished tool calls).
- `id` choice: use the provider `call_id` as the DSH block id. DSH then records the same string as
  `toolCallId` on the tool-result message, so replay is a 1:1 `{type:"function_call", call_id}` ↔
  `{type:"function_call_output", call_id}` mapping with no `|`-concatenation convention needed.

**`item.type === "web_search_call"`**: ignore (it is a server-side tool; the model may later emit a
`message` summarizing it).

**Backfill**: if a reasoning item's `encrypted_content` is still missing after `output_item.done`, look it
up in `response.completed.response.output[]` and patch the stored signature (E3
`backfillReasoningSignatures`). This matters because `store:false` replay depends on it when enabled.

### 4.4 Usage

`response.usage` (E7 `ResponseUsage`):

```json
{ "input_tokens": 1234, "input_tokens_details": { "cached_tokens": 900, "cache_write_tokens": 0 },
  "output_tokens": 210,  "output_tokens_details": { "reasoning_tokens": 60 },
  "total_tokens": 1444 }
```

Map to the DSH `usage` chunk exactly like E5 `mapUsage` (which reads E3's normalized usage):

| DSH field | Value |
|---|---|
| `inputTokens` | `input_tokens - cached_tokens - cache_write_tokens` (clamp at 0; OpenAI's `input_tokens` includes cached/cache-write tokens, pi-ai subtracts both) |
| `outputTokens` | `output_tokens` (includes reasoning tokens; DSH has no separate reasoning field) |
| `totalTokens` | `total_tokens` |
| `cacheReadTokens` | `cached_tokens` (include only when > 0) |
| `cacheWriteTokens` | `cache_write_tokens` (include only when > 0) |

Emit `usage` immediately before `finish`, once per attempt. On abort/error emit `usage` with whatever was
known (E5 emits `mapUsage(event.error.usage)` for error events; zeros are acceptable).

### 4.5 `finish` mapping (`reason` → DSH finish kinds)

Evidence: E5 `mapStopReason`, E6 `assembler.js`/`assistant-stream.js`.

| Provider terminal state | DSH `finish.reason` |
|---|---|
| `status:"completed"`, assistant text/reasoning only | `{kind:"stop"}` |
| `status:"completed"`, ≥1 completed function-call block | `{kind:"tool-calls"}` |
| `status:"completed"` but **no** content blocks at all | `{kind:"error", failure:{code:"EMPTY_RESPONSE", message:"model returned a completed response with no content"}}` |
| `status:"incomplete"`, reason `max_output_tokens`/`max_messages` | `{kind:"max-tokens"}` |
| `status:"incomplete"`, reason `content_filter` | `{kind:"error", failure:{code:"CONTENT_FILTER", message:"response stopped by content filter"}}` |
| `status:"incomplete"`, reason `steered` | `{kind:"stop"}` if a completed message exists, else error |
| `status:"failed"` / `error` event / `response.failed` | `{kind:"error", failure:{message, code}}` — map `code` to DSH taxonomy: `AUTH` (401), `QUOTA_EXCEEDED` (429 usage limit), `RATE_LIMIT` (other 429), `INVALID_REQUEST` (400), `SERVER` (5xx), `TRANSPORT` (stream ended early / socket), `TIMEOUT`, `CONTEXT_WINDOW_EXCEEDED` (`context_length_exceeded`), else `SIWC_ERROR` |
| caller aborted (`AbortSignal`) | `{kind:"aborted", failure:{code:"ABORTED", message}}`; close the fetch reader, do not emit a `stop` |

Also apply E5's overflow guard: if `stop` usage exceeds the model's context window, report
`CONTEXT_WINDOW_EXCEEDED`; `stop` with no content → `EMPTY_RESPONSE`.

### 4.6 Reasoning/encryption notes for the stream

- Reasoning summaries stream through `response.reasoning_summary_text.delta`; raw reasoning content (when
  the model emits it) through `response.reasoning_text.delta`. Both land in the same DSH reasoning block;
  a reasoning item has one block regardless of how many summary parts it has.
- `encrypted_content` is only trustworthy on `response.output_item.done`; keep the whole item.
- If the route never emits a reasoning item (non-reasoning model / effort omitted), the stream simply has
  no `response.output_item.added` with `item.type:"reasoning"`.

---

## 5. DSH `StreamChunk` contract this adapter must emit

Authoritative shapes: E6 (`assembler.js` `push`, `assistant-stream.js`) and E5 (`toStreamChunks`).
Indices are the adapter's own slot ordinals; deltas may arrive before any `block-start` (assembler is
delta-tolerant), but always emit `block-start` on `output_item.added` and `block-end` exactly once.

```ts
// one attempt, in stream order:
{ type: "block-start", index: number, blockType: "text" | "reasoning" | "tool-call" }
{ type: "text-delta", index: number, text: string }
{ type: "reasoning-delta", index: number, text: string }
{ type: "tool-call-delta", index: number, id: string, name?: string, argumentsDelta: string }
{ type: "block-end", index: number, block: ContentBlock }
//   text:      { type:"text", text }
//   reasoning: { type:"reasoning", text }
//   tool-call: { type:"tool-call", id, name, arguments /* JSON string */ }
{ type: "usage", usage: { inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens? } }
{ type: "finish",
  reason: { kind: "stop" }
        | { kind: "max-tokens" }
        | { kind: "tool-calls" }
        | { kind: "error", failure: { message, code, status?, providerRetryAfterMs?, requestId? } }
        | { kind: "aborted", failure: { message, code } },
  replayState?: <adapter-private envelope, §6> }
```

Rules that matter for correctness (all from E6):

- `block-end` wins: the first `block-end` for an index closes it; later deltas for that index are ignored.
  Emit exactly one per slot.
- Do not emit `block-start` for an item you never finalize (e.g. a failed/aborted tool call) *and then*
  `block-end` it — either finalize or drop; an open text/reasoning block assembles from its deltas, an
  open unknown block with no `block-end` throws at assembly.
- `tool-call-delta.id` must be non-empty; it is stored on the block even before `name` arrives. The block-end
  `tool-call` block is authoritative for dispatch.
- Usage and finish are always the last two chunks; finish carries the replay envelope.
- Error delivery style: like E5, prefer `finish {kind:"error"|"aborted"}` over throwing mid-stream; throw
  only for adapter programming errors before any chunk is emitted.

---

## 6. Statelessness and replay

### 6.1 No server-side conversation

- `store:false` ⇒ nothing is retained server-side; the next turn must send **the whole conversation**
  again (there is no `previous_response_id` path that works under `store:false`, and `conversation` /
  `prompt_cache_key` are rejected).
- The DSH session log is the source of truth: every turn rebuilds `instructions` + full `input` from
  `options.messages` plus the adapter replay state carried on assistant messages.
- Tool call/result pairs are re-sent as `function_call` + `function_call_output`; the pairing key is
  `call_id` (DSH's `toolCallId` is the tool-call block id, which we set to the provider `call_id`).

### 6.2 Replay envelope (adapter-private, `finish.replayState`)

DSH stores the envelope on the assistant message's `source.replayState` and only hands it back to the
adapter that owns that route (evidence: `dsh-llm/lib/index.js` `forAdapter()` filters replay state by
registered adapter; E5 `readReplayState` validates versioned envelopes). Suggested schema:

```json
{
  "response": {
    "kind": "chatgpt-siwc", "version": 1,
    "provider": "chatgpt", "model": "<requested slug>",
    "responseId": "resp_...", "responseModel": "gpt-6.1-sol",
    "stopReason": "stop"
  },
  "blocks": [
    { "type": "reasoning", "item": { "type": "reasoning", "id": "rs_...", "summary": [], "encrypted_content": "..." } },
    { "type": "text", "itemId": "msg_...", "phase": "final_answer" },
    { "type": "tool-call", "callId": "call_...", "itemId": "fc_..." }
  ]
}
```

- `blocks` aligns 1:1 with the assistant message's content blocks, in order. On the next turn, while
  converting each assistant message, push the input items described by its blocks **in order**
  (reasoning item, message, function calls), then the following tool results/user turns.
- `readReplayState`-style validation is the adapter's job: wrong/absent kind/version ⇒ ignore the envelope
  and replay only text + tool calls (degraded but valid).
- Never let one route's replay state leak into another adapter's request (DSH already filters by adapter;
  also check `source.provider`).

### 6.3 Reasoning replay policy (route-dependent, flagged)

`store:false` + reasoning items is the public API's **documented** stateless pattern: send
`include:["reasoning.encrypted_content"]`, capture `encrypted_content` from `output_item.done`, and replay
the `reasoning` items before the assistant output on the next request (E7 `ResponseReasoningItem` doc).
E3 does exactly this for public OpenAI models.

For the **SIWC plan route** this is *unverified*: `include` and reasoning items are not in the rejection
list (E1 only rejects the 18 params and the 5 hosted tool types), so they are presumably accepted, but
the route is explicitly a capability subset and may not return `encrypted_content` or may reject
reasoning items. Recommended implementation:

1. Config flag `reasoningReplay` (default **on** if `include` is sent, off otherwise), plus a one-shot
   automatic downgrade: if a request returns 400 with a message mentioning `reasoning`, `include`,
   `encrypted_content`, or `unsupported`, retry once without `include` and with reasoning items stripped
   from `input`; remember the downgrade for the session.
2. If the previous turn's stream produced no reasoning item, there is nothing to replay — skip silently.
3. Reasoning text (summary) may always be replayed as plain assistant text if reasoning-item replay is
   unavailable (worst case the model loses exact reasoning tokens but sees its conclusions).

---

## 7. Model catalog, ids and context windows

### 7.1 Catalog endpoint

```
GET https://api.openai.com/v1/models
Authorization: Bearer <plan access token>
```

**Non-standard body shape** (E1 `catalog.py`): a top-level `models` array of objects each carrying `slug`:

```json
{ "models": [ { "slug": "gpt-6.1-sol", "...": "..." }, { "slug": "gpt-6-astra", "...": "..." } ] }
```

- E1 only reads `slug`; it is documented as "a non-standard catalog body … which the OpenAI SDK cannot
  parse", so do not assume the public `/v1/models` `{object:"list", data:[{id:...}]}` shape, but parse
  both defensively (`payload.models[].slug`, else `payload.data[].id`).
- The catalog can be temporarily unavailable (E2: an HTTP **520** was observed). Provide a static fallback.
- `401`/`403` from this endpoint = auth problem → refresh/re-auth, not "no models".

### 7.2 Slugs

Catalog is authoritative. Fallback suggestions observed for a plan account (E1
`SUBSCRIPTION_MODEL_SUGGESTIONS`):

`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-reserve`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, `gpt-daybreak-blue-latest`, `gpt-5.5`, `codex-auto-review`

Hint-only additions from the local Codex cache (E9; slugs are shared across OpenAI catalogs, but the
SIWC catalog must still be the gate for what the picker lists): `gpt-6.1-terra`, `gpt-5.3-codex-spark`.

Picker rule: list whatever the SIWC catalog returns; if the catalog fails, offer the fallback list;
keep the model field editable (E1 keeps it editable), and on `subscription_sharing_unsupported_capability`
or `model_not_found` surface "model not available on this plan" rather than silently retrying.

### 7.3 Context windows / reasoning levels (hints from `~/.codex/models_cache.json`)

The SIWC catalog does **not** document context windows or reasoning capabilities (E1 reads only slugs).
Use the local Codex catalog purely as a **hint table**; be prepared for it to be wrong for the plan route.

| Slug | context_window (hint) | max_context_window (hint) | reasoning efforts (hint) |
|---|---|---|---|
| `gpt-6.1-sol` | 500 000 | 872 000 | low, medium, high, xhigh, max, ultra |
| `gpt-6-astra` | 272 000 | 872 000 | low, medium, high, xhigh, max, ultra |
| `gpt-6.1-terra` | 500 000 | 872 000 | low, medium, high, xhigh, max, ultra |
| `gpt-6-sol` | 272 000 | 872 000 | low, medium, high, xhigh, max, ultra |
| `gpt-reserve` | 272 000 | 872 000 | low, medium, high, xhigh, max |
| `gpt-6-luna` | 272 000 | 872 000 | low, medium, high, xhigh, max |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | 272 000 | 872 000 | low, medium, high, xhigh, max (± ultra) |
| `gpt-5.5` | 272 000 (pi-ai catalog) | — | low … xhigh |
| `gpt-5.3-codex-spark` | 128 000 (pi-ai catalog) | — | low, medium, high, xhigh |
| `codex-auto-review` | 272 000 | 872 000 | low … max |

Policy for the adapter:

- `resolveModel()`/`listModels()` should report `contextWindow` = hint (default 272 000 if unknown) and
  `maxOutputTokens` = hint only (Codex cache/pi-ai say 128 000) — but **never send `max_output_tokens`**
  (rejected). Truncation has to be handled client-side by DSH context management.
- Reasoning effort: send exactly the strings above; clamp a DSH level the model doesn't support. For
  "off", omit `reasoning` entirely (do not send `effort:"none"` unless a probe shows it accepted).
- `effective_context_window_percent: 95` and `max_context_window` in the Codex cache are **Codex
  compaction knobs**, not API limits — do not enforce them as request limits.

---

## 8. Errors, usage limits and retry behavior

### 8.1 Shape

HTTP-level error body is a standard OpenAI error object:

```json
{ "error": { "code": "subscription_sharing_usage_limit_exceeded",
             "message": "...", "param": null, "type": "invalid_request_error" } }
```

In-stream: `error` event `{code,message,param}` or `response.failed` with
`response.error:{code,message,param,type}`. Map by `error.code` first, HTTP status second.

### 8.2 SIWC subscription errors (E1 `const.py`)

| `error.code` | Meaning | HTTP (observed/inferred) | Handling |
|---|---|---|---|
| `subscription_sharing_usage_limit_exceeded` | Plan usage limit reached (shared across apps) | 429 | **terminal**; do not blind-retry. Surface a usage-limit message + settings usage URL; honor `retry_after`/`Retry-After` if present |
| `subscription_sharing_user_not_eligible` | Account not eligible for plan usage with this app | 403 | terminal; tell user to check plan/eligibility |
| `subscription_sharing_invalid_user` | Sign-in no longer valid | 401 | refresh token once; if still invalid → re-auth (fatal) |
| `subscription_sharing_usage_unavailable` | Plan usage temporarily unavailable | 429/5xx | transient; bounded backoff |
| `subscription_sharing_route_not_supported` | Request shape/route unsupported | 400/404 | terminal for this request; check for forbidden params/tools |
| `subscription_sharing_unsupported_capability` | Uses a capability the route doesn't have (e.g. hosted tool) | 400/403 | terminal; strip the offending tool/param and do not auto-retry blindly |

Also standard codes: `context_length_exceeded` → `CONTEXT_WINDOW_EXCEEDED` (terminal, compact history);
`model_not_found` → pick another model.

### 8.3 Retry contract

- `429` transient (not a usage-limit code), `5xx`, and transport failures: retry with backoff, bounded
  (E1 client uses **`max_retries = 1`** deliberately, because the route's degraded edge returns 5xx +
  `retry_after` ~60 s and the SDK default of 2 retries would wait minutes). Honor `Retry-After` /
  `retry_after`; cap the delay (E3 cap: 60 s; anything larger should be reported, not slept on).
- `400` / `403` / usage-limit `429`: **no** retry.
- `401`: refresh token once, replay once (E1 `_SubscriptionAuth`). A second 401 is fatal → re-auth.
- Never rotate/consume the refresh token speculatively; serialize refreshes (E1 uses a lock) and persist
  the rotated tokens before making the request.
- There are no `x-codex-*` rate-limit headers on this route; if `x-ratelimit-*` appear, treat them as
  advisory only (U8).

---

## 9. Differences vs the Codex backend route (don't mix them up)

| Aspect | SIWC plan route (this doc) | Codex backend route (`chatgpt.com/backend-api/codex`) |
|---|---|---|
| Endpoint | `https://api.openai.com/v1/responses` | `https://chatgpt.com/backend-api/codex/responses` |
| Auth | `Authorization: Bearer <plan access token>` only | Bearer + `chatgpt-account-id`, `originator`, `OpenAI-Beta`, session/thread headers |
| Conversation | stateless, full input, `store:false` | stateless too, but with `prompt_cache_key`, `include:['reasoning.encrypted_content']`, optional WS `previous_response_id` continuation |
| System prompt | top-level `instructions`; **no** system input items | base instructions as a developer `message` item (Codex 0.166) / `instructions` (pi-ai) |
| Sampling knobs | `temperature`, `max_output_tokens`, `prompt_cache_key`, `service_tier`, `top_p`, `truncation`, `metadata`, `user`, … all **rejected** | many accepted (`text.verbosity`, `service_tier`, `prompt_cache_key`, `stream_options`, …) |
| Hosted tools | only `web_search` | broader set (web_search, plus Codex-specific additional_tools / tool_search) |
| Catalog | `GET https://api.openai.com/v1/models` → `{"models":[{"slug":…}]}` | `GET …/codex/models` → Codex `ModelInfo` with context windows, reasoning levels, `use_responses_lite`, service tiers |
| Transport | SSE only | SSE + Responses WebSocket (`OpenAI-Beta: responses_websockets=2026-02-06`) |
| Extra events | none | `response.metadata`, `response.done`, `codex.response.metadata`, `responsesapi.websocket_timing`, rate-limit headers |
| Reasoning replay | uncertain whether `include:['reasoning.encrypted_content']` works | supported and required for stateless replay |

A naive port that reuses Codex headers (`chatgpt-account-id`, `originator`, `OpenAI-Beta`, `session-id`),
sends `prompt_cache_key`, folds the system prompt into a `developer`/`system` input item, or forwards
`max_output_tokens`/`temperature` will fail on this route.

---

## 10. Uncertainties (verify in this order before/while implementing)

| # | Question | Why it matters | Cheap verification |
|---|---|---|---|
| U1 | Does the SIWC route accept `include:["reasoning.encrypted_content"]` and return `encrypted_content` on reasoning items? Does it accept replayed `reasoning` input items? | Determines whether reasoning token replay works at all; otherwise degraded (summary-as-text) replay | One probe request on a reasoning model with `include`, inspect `response.output_item.done.item.encrypted_content`; then a second request replaying it |
| U2 | Does `GET /v1/models` (plan route) return anything besides `slug` (context window, reasoning levels, display name)? | Picker metadata + context-window policy; E1 only parses `slug` | Fetch the catalog with a plan token, dump keys of one entry |
| U3 | Exact HTTP status for each `subscription_sharing_*` code | Error taxonomy/retry decisions | Trigger 401/403/429 scenarios (or inspect SDK error status from a live run) |
| U4 | Are `parallel_tool_calls`, `text`, `reasoning`, `stream_options` accepted? | Only `include`/`tools`/`instructions` are positively evidenced; the others are inferred from the rejection list | Probe one field at a time; the route's 400 names the offending field |
| U5 | Is `web_search` actually offered to a given plan/account? | If not, exposing it in DSH yields a terminal unsupported-capability error | Send `tools:[{"type":"web_search"}]` once, or check plan docs/settings |
| U6 | Is `phase` accepted on replayed assistant messages, and is it needed? | E7 says preserve it for newer models; harmless to omit if unknown | Compare request with/without `phase`; API 400 vs 200 |
| U7 | Assistant-message replay part type: `output_text` vs `input_text` | Wrong part type is a 400 risk (E3 uses `output_text` and works on public API) | One request with an assistant message replayed |
| U8 | Rate-limit/`retry-after` headers on this route | Backoff quality | Inspect response headers on 429 |
| U9 | Does the plan route cap output tokens implicitly (and can `response.incomplete.reason=max_output_tokens` fire without us sending `max_output_tokens`)? | `max-tokens` finish handling | Long-output probe, read `incomplete_details` |
| U10 | Is `instructions` allowed as an array, or only a string? | Build simplicity | Send string (safe path); array probe optional |
| U11 | Mid-conversation `developer` input items: accepted? | Whether mid-history developer messages can be position-preserving instead of folded | Probe a developer item after a user message |
| U12 | Does the plan route serve Responses over WebSocket? | Transport choice (we implement SSE only) | Out of scope per plan; assume no |

---

## 11. Implementation checklist (plain-JS SSE client)

1. **Auth layer**: load plan credentials (`access_token`, `refresh_token`, `client_id`, `expires_at`,
   `earliest_refresh_at`); refresh 5 min early and on 401, serialized, persist rotated tokens; fatal refresh
   → AUTH → re-auth flow.
2. **Catalog**: `GET /v1/models` with bearer; parse `models[].slug` (fallback `data[].id`); static fallback
   list; never cache across accounts.
3. **Request builder**:
   - `instructions` = `options.system` + leading system/developer messages (folded, `\n\n`-joined);
   - `input` = messages minus leading system/developer, items per §2.3, including replayed function
     calls/outputs and (optionally) reasoning items from replay state;
   - tools = flat function tools (skip `deferLoading`), optional `{"type":"web_search"}`;
   - whitelist fields exactly: `model`, `instructions?`, `input`, `tools?`, `tool_choice?` (string only),
     `parallel_tool_calls?`, `reasoning?`, `text?`, `include?`, `stream:true`, `store:false`;
   - hard-assert the 18 forbidden params and 5 forbidden tool types are absent (defense in depth).
4. **Transport**: `fetch(POST, headers, body, signal)`; non-2xx → read JSON error, map per §8; SSE reader
   with `\n\n` framing, `data:` join, `[DONE]`, JSON `type` switch.
5. **Stream mapper**: slot table keyed by `output_index` → `{type, contentIndex, buffers}`; emit
   `block-start` on `output_item.added`, deltas, `block-end` on `output_item.done`; terminal handling per
   §4.5; emit `usage` then `finish` with replay envelope; aborted signal → `{kind:"aborted"}`.
6. **Replay envelope**: persist per assistant message (`source.replayState`); validate kind/version on read;
   drop foreign/corrupt envelopes; block-to-item conversion per §6.2.
7. **Errors**: `AUTH`, `QUOTA_EXCEEDED`, `RATE_LIMIT`, `INVALID_REQUEST`, `SERVER`, `TRANSPORT`, `TIMEOUT`,
   `CONTEXT_WINDOW_EXCEEDED`, `EMPTY_RESPONSE`, `SIWC_ERROR`; usage-limit 429 terminal and user-visible.
8. **Never** log the bearer token, refresh token, or full authorization headers; redact to `Bearer <redacted>`.

---

## 12. File references

- Reference implementation (MIT, read-only): `research/ref/chatgpt_plan_auth/chatgpt_plan_auth/{const,requests,catalog,client,auth,_compat}.py`
- Installed pi-ai (inside `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/`):
  - `@earendil-works/pi-ai/dist/api/openai-responses.js` — `isChatGPTSignIn`, `buildParams`, SSE entry
  - `@earendil-works/pi-ai/dist/api/openai-responses-shared.js` — `convertResponsesMessages` (L63–268),
    `convertResponsesTools` (L272–305), `processResponsesStream` (L321–673)
  - `@earendil-works/pi-ai/dist/api/openai-codex-responses.js` — SSE parser framing (L582–644), request
    builder reference (L373–431)
  - `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` — `toStreamChunks`, `mapUsage`, `mapStopReason`,
    `toPiReplayState`, `readReplayState`, `piTool`/`toolsOf`, `splitSystemPrompt`
  - `@deepseek-ai/dsh-llm/lib/types/assembler.js` — chunk semantics; `@deepseek-ai/dsh-llm/lib/types/assistant-stream.js` — chunk vocabulary
- openai-node types (public API ground truth): `src/resources/responses/responses.ts`, `src/client.ts`,
  `src/core/streaming.ts` (fetched from `raw.githubusercontent.com/openai/openai-node/master`)
- Hints only: `~/.codex/models_cache.json`
- Superseded Codex-route notes: `research/02-codex-wire.md`
