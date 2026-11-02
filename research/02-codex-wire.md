# 02 (superseded) — Codex backend wire notes: `chatgpt.com/backend-api/codex/responses`

> **SUPERSEDED (2026-11-03).** The user selected the official **Sign in with ChatGPT (SIWC) open-source
> plan-usage route**, which is a *different* contract: the plan token is a bearer token against
> `https://api.openai.com/v1/responses`. The implementable contract is in **`research/02-siwc-wire.md`**.
>
> This file preserves the Codex-backend research (task-2's original scope) so it is not lost and so the
> "differences vs Codex backend" section of the SIWC doc has a citable source. Do not implement from this
> file unless the SIWC route proves unusable and a Codex-login fallback is chosen.
>
> Evidence: vendored Codex 0.153.4 binaries
> (`/Users/jeff/.dsh/profiles/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`),
> upstream `openai/codex` main (`codex-rs/codex-api`, `codex-rs/core/src/client.rs`,
> `codex-rs/model-provider*`, `codex-rs/login`, `codex-rs/http-client`), live `~/.codex/models_cache.json`
> (client 0.166.0) and `~/.codex/sessions/*.jsonl` rollouts. No live calls were made; no tokens printed.

## Endpoint

- Base URL constant: `CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"` (`codex-rs/model-provider-info/src/lib.rs`).
- Streaming Responses: `POST https://chatgpt.com/backend-api/codex/responses` (path `/responses` on that base).
- pi-ai's independent implementation confirms the same: `DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api"`,
  `resolveCodexUrl()` appends `/codex/responses`.
- WebSocket variant exists (`wss://chatgpt.com/backend-api/codex/responses`), `OpenAI-Beta: responses_websockets=2026-02-06`,
  frames `{type:"response.create", ...body}`. SSE alone is sufficient for a port.

## Required headers (SSE)

| Header | Value |
|---|---|
| `Authorization` | `Bearer <ChatGPT OAuth access token>` |
| `chatgpt-account-id` | account id from the token's `https://api.openai.com/auth` JWT claim (`chatgpt_account_id`); pi-ai extracts it client-side with `extractAccountId()` |
| `originator` | `codex_cli_rs` (default), `codex_work_desktop` (desktop app), `codex-tui`, `codex_vscode`, `pi` (pi-ai) |
| `version` | Codex CLI version, e.g. `0.166.0` (provider `http_headers: [("version", env!("CARGO_PKG_VERSION"))]`) |
| `OpenAI-Beta` | `responses=experimental` (pi-ai SSE path); websocket value differs |
| `accept` | `text/event-stream` |
| `content-type` | `application/json` |
| `session-id` | Codex session id (pi-ai also sets `x-client-request-id`) |
| `thread-id` | thread id (Codex `build_session_headers`); `x-client-request-id` = thread id |
| `x-codex-turn-state` | sticky-routing token echoed from the previous response's `x-codex-turn-state` header |
| `x-openai-subagent` | only for sub-agents (`review`, `compact`, `memory_consolidation`, `collab_spawn`) |
| `x-openai-internal-codex-responses-lite` | `true` when the model has `use_responses_lite` (live catalog: **all current models do**) |
| `x-codex-beta-features` | optional comma-separated feature keys |
| `content-encoding: zstd` | optional request compression; the backend decodes zstd (pi-ai compresses level 3) |

Response headers the client consumes: `openai-model` (server may route to a different safety model),
`x-reasoning-included`, `x-codex-turn-state`, `x-request-id`, `X-Models-Etag`, plus the rate-limit family
`x-codex-primary-{-used-percent,-window-minutes,-reset-at}`, `x-codex-secondary-*`, `x-codex-credits-{has-credits,unlimited,balance}`,
`x-codex-promo-message`, `x-codex-rate-limit-reached-type`.

## Request body (Codex 0.166 `ResponsesApiRequest`, verbatim field order)

```jsonc
{
  "model": "<catalog slug>",
  "stream": true,
  "service_tier": "priority",              // optional; from model.service_tiers
  "input": [ /* ResponseItem[] */ ],
  "tools": [ /* flat function tools */ ],  // optional; omitted for responses-lite models
  "tool_choice": "auto",
  "parallel_tool_calls": true,             // false for responses-lite
  "reasoning": { "effort": "low", "summary": "auto", "context": "all_turns" }, // context only for lite
  "store": false,
  "stream_options": { "reasoning_summary_delivery": "sequential_cutoff" },     // optional
  "include": ["reasoning.encrypted_content"],   // + "output.encrypted_content" when enabled
  "prompt_cache_key": "<session-derived>",
  "text": { "verbosity": "low", "format": { "type": "json_schema", "strict": true, "schema": {}, "name": "" } }, // optional
  "client_metadata": { /* x-codex-turn-metadata etc. */ }
}
```

- **No top-level `instructions` in Codex 0.166**: the base instructions are prepended as a developer
  `message` input item with id `msg_<uuid5(thread_id, instructions-text)>`. pi-ai's client for the same
  endpoint instead sends `instructions` and no developer item — both accepted by the backend.
- `use_responses_lite` models: tools move into an `additional_tools` input item (`{type:"additional_tools",
  role:"developer", tools:[...]}`), `parallel_tool_calls` is forced `false`, `reasoning.context="all_turns"`,
  and the `x-openai-internal-codex-responses-lite: true` header is added.
- Input item shapes (`ResponseItem`, `codex-rs/codex-protocol`): `message` (roles `developer`/`user`/`assistant`,
  content parts `input_text`/`input_image`/`output_text`, optional `phase` `commentary`/`final_answer`),
  `function_call` (`{type, name, arguments, call_id, id, namespace?, encrypted_function_args?}`),
  `function_call_output` (`{type, call_id, output}`), `reasoning` (`{type:"reasoning", id, summary, content?,
  encrypted_content}`), `custom_tool_call`/`custom_tool_call_output` (freeform/grammar tools), `local_shell_call`,
  `tool_search_call`/`tool_search_output`, `additional_tools`, `compaction`, `image_generation_call`,
  `web_search_call`, `agent_message`.
- Static replay: `store:false` + `include:["reasoning.encrypted_content"]`; the full conversation (including
  `reasoning` items with `encrypted_content`) is re-sent every turn. `previous_response_id` is used only as a
  WebSocket continuation optimization (connection-scoped), not for the SSE path.

## SSE events Codex handles (`codex-api/src/sse/responses.rs`)

Events mapped to behavior: `response.created` (response id), `response.output_item.added` /
`response.output_item.done` (ResponseItem; reasoning/message/function_call finalized), `response.output_text.delta`,
`response.reasoning_summary_text.delta`, `response.reasoning_summary_text.done`, `response.reasoning_text.delta`,
`response.reasoning_summary_part.added`, `response.custom_tool_call_input.delta`,
`response.function_call_arguments.{delta,done}` (parsed but unhandled → tool args come from the item),
`response.completed` / `response.incomplete` (usage; `incomplete_details.reason`), `response.failed` (typed error),
`error` (code → terminal provider error), `response.metadata` (guardian assessment, model verifications,
moderation metadata, safety buffering), `codex.response.metadata`, `response.content_part.*`,
`response.output_text.done`, `response.in_progress`, `responsesapi.websocket_timing` (ignored).
Unknown `*.delta` events are ignored; unknown events are debug-logged. Stream ends at `response.completed`;
EOF before it is `stream closed before response.completed` (retryable).

Usage in `response.completed.response.usage`:

```json
{ "input_tokens": 100, "input_tokens_details": { "cached_tokens": 40, "cache_write_tokens": 60 },
  "output_tokens": 10, "output_tokens_details": { "reasoning_tokens": 5 }, "total_tokens": 110,
  "codex_rollout_budget_units": 2.5 }
```

## Errors / auth refresh (Codex)

- `401` → refresh ChatGPT tokens once (`auth.openai.com/oauth/token`, rotating refresh token), replay once;
  second failure → `CodexErr::RefreshTokenFailed` → re-login. Serialized by the auth manager.
- `response.failed` / `error` codes: `context_length_exceeded`, `insufficient_quota`, `credit_balance_exhausted`,
  `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `usage_not_included`, `cyber_policy`,
  `bio_policy`, `misalignment_policy_violation`, `invalid_prompt`, `policy_capacity_unavailable`,
  `server_is_overloaded`, `rate_limit_exceeded`, `slow_down`, `flex_unavailable`, `model_not_found`.
  Retry delays are parsed from `try again in N s|ms` messages and error `headers.retry_after`.
- Default retry budgets: `request_max_retries=4`, `stream_max_retries=5`, idle timeout 300 s.

## Models

- Live catalog is fetched from the Codex backend (`/models`), cached at `~/.codex/models_cache.json`;
  the file on this machine is client_version `0.166.0` and lists 10 models with `slug`,
  `supported_in_api`, `context_window` (272 000 / 500 000), `max_context_window` (872 000),
  `effective_context_window_percent: 95`, `default_reasoning_level`, `supported_reasoning_levels`
  (low/medium/high/xhigh/max/ultra), `service_tiers` (`priority` = "Fast"), `use_responses_lite: true`,
  truncation policy (10 000 tokens), input modalities (text+image), `tool_mode: "code_mode_only"`.
- Slugs: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-reserve`, `gpt-6-luna`,
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `codex-auto-review`.
- Context window = `context_window` (272k/500k); `max_context_window` 872k is the compaction ceiling;
  95% is the effective fraction used by Codex auto-compaction.

## Why this route was superseded for the plugin

Using this route requires a **Codex/ChatGPT login token** (`~/.codex/auth.json`) and Codex-specific
headers, and its model catalog/limits are Codex-managed; the user asked for the official open-source
SIWC plan-usage route with the token used against the standard Responses API instead. See
`research/02-siwc-wire.md` for the implemented contract and the side-by-side differences table.
