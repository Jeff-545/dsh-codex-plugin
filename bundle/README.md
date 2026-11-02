# ChatGPT Plan for DeepSeek Harness

Run DeepSeek Harness model requests on an eligible ChatGPT plan (Plus/Pro) through
OpenAI's official **Sign in with ChatGPT** (SIWC) open-source flow.

This plugin implements the protocol itself; it never reads, copies, or shares the
credentials of the Codex CLI or of any other application on the machine. The only
tokens it stores are the ones issued to *this* installation after *you* approve it
in the browser.

## What it adds

| Surface | Behavior |
| --- | --- |
| Model provider | `chatgpt-plan` route, streamed `POST https://api.openai.com/v1/responses` calls with the plan-usage access token |
| Sign-in | `chatgpt-plan/credential` authorization flow: OAuth 2.0 + PKCE, `state`/`nonce`, dynamic client registration (`client_id=dynamic_agent_client` → issued `oaiapp_…`), 127.0.0.1 loopback callback |
| Settings page | **Settings → ChatGPT**: connect, live progress link, account + plan-scope status, Manage usage, disconnect |
| Commands | `/chatgpt-plan-login`, `/chatgpt-plan-logout`, `/chatgpt-plan-status` |

## Install

```sh
# from the Harness UI: Plugins → install bundle, target this directory
```

Or via the plugin manager API with `target` set to this package directory. The
bundle inserts one Host row (`chatgpt-plan`) and loads its `dsh.client` half as
the ChatGPT settings section.

## Use

1. Open **Settings → ChatGPT** and choose **Connect ChatGPT** (or run
   `/chatgpt-plan-login`). A browser window opens on
   `auth.openai.com`; finish the sign-in and approve plan usage for this app.
2. The page shows the connected account and whether the
   `chatgpt.tokens.use.direct` plan scope was granted.
3. Pick a **ChatGPT Plan** model in the composer model selector.
4. **Disconnect** revokes the stored refresh token at OpenAI
   (`/api/accounts/oauth/revoke`) and then deletes the local record. If the
   revocation cannot be confirmed, the local tokens are still removed and the
   page reports it; remove the app in ChatGPT settings (Settings → Usage) to
   finish the job account-side.

## Plan-usage constraints this adapter honors

The ChatGPT plan route is a subset of the Responses API. The adapter:

- always sends `store: false` and `stream: true`;
- folds the system prompt into `instructions` and never sends `system` input items;
- never sends the rejected parameters (`temperature`, `max_output_tokens`,
  `metadata`, `service_tier`, `prompt_cache_key`, `truncation`, …);
- drops hosted tools the route does not provide (`file_search`,
  `code_interpreter`, `image_generation`, `mcp`, `tool_search`) while sending
  function tools flat;
- maps provider errors to harness failures: `QUOTA`
  (`subscription_sharing_usage_limit_exceeded`), `AUTH`
  (`subscription_sharing_user_not_eligible`, `subscription_sharing_invalid_user`,
  401), `RATE_LIMIT` (429), `INVALID_REQUEST` (400/404/422).

Success requires the `response.completed` stream event; a stream that ends
earlier reports an error instead of a partial success.

## Token handling

- Tokens live only in the harness credential store
  (`~/.dsh/.credentials.yaml`, file mode 0600) under the plugin's own records
  `chatgpt-plan/credential` and `chatgpt-plan/registration`.
- The registration record holds only the non-secret `ext_agent_host_id` and the
  issued client id, so signing out keeps the app registration.
- The access token lives one hour; the refresh token lives 30 days and rotates on
  every refresh. Rotation is persisted immediately, guarded by an in-process
  single flight so concurrent requests cannot consume one refresh token twice.
- No token ever reaches the browser: the settings page reads status, never the
  credential payload.

## Model catalog

`GET https://api.openai.com/v1/models` with the plan token is authoritative and
is cached for five minutes. Before sign-in, or when that read fails, the picker
falls back to the bundled slug list so the route stays selectable. Context
windows, display names, and reasoning choices come from `lib/models.js`.

## Network and proxy

Node's global `fetch` ignores the macOS system proxy and the conventional proxy
environment variables, and this deployment reaches `auth.openai.com` and
`api.openai.com` only through a proxy. The plugin therefore ships its own
`node:https` transport with HTTP `CONNECT` tunneling (`lib/http.js`):

1. `DSH_CHATGPT_PLAN_PROXY` (`host:port` or URL), then
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (respecting `NO_PROXY`), then
3. the macOS system proxy read from `scutil --proxy`.

`127.0.0.1`, `localhost`, and the loopback callback are always direct. A browser
authorization page opened by the OS browser uses that browser's own proxy
configuration.

Diagnose reachability with:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://auth.openai.com/.well-known/openid-configuration
```

`403` with `unsupported_country_region_territory` means the request went direct;
the plugin reports a transport failure instead of hanging.

## Verification

Two suites run without any sign-in or network access:

```sh
node tests/flow.test.mjs   # OAuth flow: dynamic registration, reauth reuse,
                           # state mismatch, plan-scope gating, JSON-safe commit
node tests/wire.test.mjs   # request builder + SSE -> StreamChunk translation
```

An installed profile can be checked without the GUI by pointing the one-shot
headless app at a plan model:

```sh
# throwaway profile: shipped headless app + this bundle, with the interactive
# credential services the headless bundle disables re-enabled
dsh codex-e2e --from-default-profile headless --help
dsh plugin --profile codex-e2e add "$PWD/bundle"
printf -- '- id: credentials\n  disabled: false\n- id: authorization\n  disabled: false\n' \
  > ~/.dsh/profiles/codex-e2e/cordis.patch.yml
dsh codex-e2e --patch e2e-model.yml "Reply with exactly: OK"
# before sign-in: MISSING_CREDENTIAL: chatgpt-plan: no ChatGPT plan sign-in is stored.
# after  sign-in: OK
```

`e2e-model.yml` only sets `agent-default-model` to `chatgpt-plan` / a plan model.
The one-shot runner shares the desktop profile's credential file
(`~/.dsh/.credentials.yaml`), so it exercises the same sign-in.

A recorded run against the installed desktop app (catalog, GUI-path turn,
refresh-token rotation, and the bug found during the first sign-in) is in
[`../VERIFICATION.md`](../VERIFICATION.md).

The running Web/desktop Host can also be probed over its own authenticated
routes: `scripts/desktop-probe.mjs` mints the `dsh-auth-*` cookie from the
profile's browser-session secret and reads `/plugins/dsh-chatgpt-plan/status`
(or the model catalog through `/api/session/modelCatalog`).

### Automated control-path check

`DSH_CHATGPT_PLAN_NO_BROWSER=1` makes the flow skip launching the browser, so a
test can start a real harness composition, `POST /connect`, read the pending
authorization URL from `/status`, `POST /cancel`, and `POST /logout` without
taking over the desktop browser. The callback listener is bound for real, which
also proves the port-fallback path is released between attempts.

## Security notes

- The settings routes live under `/plugins/dsh-chatgpt-plan/` and are guarded by
  the harness connection trust check (`ctx.connection.requestRejection`) plus a
  custom request header on state-changing calls.
- The loopback listener accepts exactly the authorization callback path, checks
  `state` before exchanging the code, and verifies the ID token's issuer,
  audience, expiry, and nonce.
- Browser launch is best-effort; the settings page always shows the authorization
  URL as a link as well.

## Limitations

- Only a Plus/Pro plan that is eligible for app usage works; the plugin reports
  ineligibility rather than retrying.
- Reasoning summaries are not requested, so reasoning text may not appear in the
  transcript even though the model reasons internally.
- No encrypted reasoning is replayed across turns (`store: false`); visible text,
  tool calls, and tool results are replayed in full every request.
- The route does not support `max_output_tokens`, so the harness's output cap is
  not transmitted.
