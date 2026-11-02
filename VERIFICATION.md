# Verification record

Environment: DeepSeek Harness desktop v0.2.1-rc.5, profile `desktop`, macOS arm64,
ChatGPT account with plan usage (`chatgpt.tokens.use.direct`), egress through the
machine's system proxy `127.0.0.1:12348` (direct egress is region-blocked).

## Evidence

| Check | Method | Result |
| --- | --- | --- |
| Plugin installed and activated | `plugin_manager` row `include:chatgpt-plan`, fiber phase | `active` |
| Settings page registered | `cordis_inspect_query` client `Slots.listSubTree` → `settings.section` occupants | `{ id: 'chatgpt-plan', order: 40, active: true }` |
| Settings page renders + connect flow | user screenshot of Settings → ChatGPT; flow started from the running Host | page renders, Connect runs |
| Web sign-in completes | SIWC browser authorization completed by the account holder | credential record written with `oaiapp_…` client id, `sub`, `email`, plan scope |
| Plan scope granted | stored `scopes` + status route | includes `chatgpt.tokens.use.direct`; `planEnabled: true` |
| Desktop host sees the plugin | authenticated `GET /plugins/dsh-chatgpt-plan/status` against the running desktop process (cookie minted from the profile's browser-session secret) | `connected: true`, `build: 0.1.1-json-safe` |
| Model catalog exposes the route | `POST /api/session/modelCatalog` on the running desktop Host | group `chatgpt-plan` / "ChatGPT Plan" with 9 plan models; no provider failures |
| **End-to-end inference in the desktop app** | `scripts/desktop-turn.mjs`: `session/create` → `session/selectModel(chatgpt-plan, gpt-6.1-sol)` → `session/prompt` → persisted log | assistant reply `GUI-E2E-OK`; `request/header` confirms `{"provider":"chatgpt-plan","model":"gpt-6.1-sol"}`; usage 7635→10; `turn/end: completed` |
| **Refresh-token rotation** | stored token forced coherently expired (expiry and `earliest_refresh_at` in the past), then a token request was made from the running Host | `rotated: true`; access token, refresh token, `expiresAt` (+60 min) and `earliestRefreshAt` (+54 min) all replaced and persisted; the next desktop turn answered `REFRESH-E2E-OK` |
| Rotation gating | set only `expiresAt` in the past while `earliest_refresh_at` stayed future | plugin correctly refused to refresh before the gate instead of provoking a fatal token-endpoint error |
| Glass-box flow tests | `node tests/flow.test.mjs` | 26 checks pass: dynamic registration, reauth reuse, state mismatch, missing plan scope, JSON-safe commit (`extAgentHostId` included) |
| Wire tests | `node tests/wire.test.mjs` | request body folds system into `instructions`, omits forbidden params, converts tools; SSE yields reasoning/text/tool-call blocks, usage, one terminal finish |
| Route trust fence | unauthenticated probes | 401; state-changing POST without the plugin header/valid cookie refused |
| Diagnostic route removed after verification | probe of the temporary route | 404 |

## Notes

- The first sign-in attempt failed at commit (`payload holds a value JSON cannot
  represent`) because the credential payload carried `undefined` for the missing
  `extAgentHostId`; the request object did not return it. The fix is covered by
  the JSON-safety check in `tests/flow.test.mjs`, and the plugin was hot-reloaded
  (no app restart needed) before the successful attempt.
- The plan credential lives in `~/.dsh/.credentials.yaml` under
  `chatgpt-plan/credential` (tokens) and `chatgpt-plan/registration`
  (non-secret host id + issued client id). No Codex CLI credential, cache, or
  session was read or reused.
- Verification sessions created in the desktop app were archived afterwards.
- Scratch verification profiles (`codex-e2e`, `web-e2e`) were removed after use;
  `bundle/README.md` documents how to recreate one.
