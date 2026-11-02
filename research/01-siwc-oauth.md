# SIWC — "Sign in with ChatGPT" plan-usage OAuth: implementation-ready spec

Status: research deliverable for the DSH Codex/SIWC plugin. Verified 2026-11-03.
Scope: the **official open-source/local-client** SIWC flow that lets an app use an eligible
ChatGPT Plus/Pro plan for `https://api.openai.com/v1` Responses API calls. This is **not**
Codex CLI credential sharing and **not** an API-key provider.

> Network note: on this machine, direct egress is in a region OpenAI blocks
> (`403 {"error":{"code":"unsupported_country_region_territory"}}` for every
> `auth.openai.com` and `developers.openai.com` URL). All official pages below were fetched
> successfully through the machine's system HTTP/HTTPS proxy (`scutil --proxy` →
> `127.0.0.1:12348`). This is a runtime requirement for the plugin, not just for research.

---

## 0. Evidence sources

Primary (official docs; fetched as Markdown through the system proxy on 2026-11-03):

| Page | URL |
|---|---|
| Overview / client vs agent host | `https://developers.openai.com/siwc/token-sharing-open-source.md` |
| Registration and sign-in | `https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md` |
| Accounts and sessions (refresh, revoke) | `https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions.md` |
| Token reference (fields, lifetimes, claims) | `https://developers.openai.com/siwc/token-sharing-open-source/token-reference.md` |
| Errors and recovery | `https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery.md` |
| Models and inference | `https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md` |
| Preview limitations | `https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md` |
| Codex app-server (alternative transport) | `https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server.md` |
| UI/UX guidelines | `https://developers.openai.com/siwc/ui-ux-guidelines.md` |
| Website-flow reference (Node `jose` snippets) | `https://developers.openai.com/siwc/website.md` |
| OIDC discovery | `https://auth.openai.com/.well-known/openid-configuration` |

Secondary (independent implementations, used only to cross-check):

- MIT reference in this repo: `research/ref/chatgpt_plan_auth/` (extracted from Home Assistant
  core `openai_conversation/chatgpt_auth.py`; docstring cites the official SIWC docs).
- `https://github.com/HackForJoy/dsh-openai-siwc` — community DSH SIWC plugin + protocol notes
  (`docs/research/openai-siwc-protocol.md`, dated 2026-10-28) and Node implementation
  (`src/oauth.ts`). Matches the official docs on every constant below.
- `https://github.com/opencoredev/login-with-chatgpt` (MIT, unofficial JS SDK, same flow).
- ServiceStack `OpenAiAuth` README (independent implementation; prefers
  `127.0.0.1:1455/auth/callback`).
- `https://loginwith.ai/developers/chatgpt` — independent guide checked against the docs
  2026-09-29. Useful, but **wrong on one point**: it shows `/callback`; the official docs
  explicitly say `/callback` does not match `/auth/callback`.

---

## 1. Copy-paste constants

```ts
// OIDC issuer / endpoints (also in the discovery document)
const ISSUER          = "https://auth.openai.com";
const DISCOVERY_URL   = "https://auth.openai.com/.well-known/openid-configuration";
const AUTHORIZE_URL   = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL       = "https://auth.openai.com/api/accounts/oauth/token";
const REVOKE_URL      = "https://auth.openai.com/api/accounts/oauth/revoke";
const JWKS_URL        = "https://auth.openai.com/.well-known/jwks.json";
const USERINFO_URL    = "https://auth.openai.com/api/accounts/oauth/userinfo"; // not needed

// API + OAuth resource
const RESOURCE        = "https://api.openai.com/v1";
const MODELS_URL      = "https://api.openai.com/v1/models";
const RESPONSES_URL   = "https://api.openai.com/v1/responses";

// Dynamic registration
const DYNAMIC_CLIENT_ID = "dynamic_agent_client"; // first registration only, never stored
const CLIENT_ID_PREFIX  = "oaiapp_";              // shape of the issued client id
const HOST_ID_SCHEME    = "urn:uuid:";            // generate UUIDv4 once per host

// Scopes (single space-separated string). Identity + plan usage.
const SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";

// Loopback callback: scheme/host/path are FIXED; only the port may vary.
const REDIRECT_HOST = "127.0.0.1";     // never "localhost"
const REDIRECT_PATH = "/auth/callback"; // not "/callback"
const PREFERRED_PORT = 1455;            // example/stable choice; any available port is allowed
// redirect_uri = `http://127.0.0.1:${actualPort}/auth/callback`
// The exact same string must be used in the authorize request and the code exchange.

// App identity shown to the user during dynamic registration.
// Real name, identical across installations; only on the registration request.
const AGENT_NAME_HINT = "DeepSeek Harness";
```

Authorize query parameters (all values URL-encoded; open in the **system browser**):

| Param | Value |
|---|---|
| `client_id` | `dynamic_agent_client` on first registration; the issued `oaiapp_…` id on every later sign-in |
| `agent_name_hint` | App's real name, **registration request only**; omit on reauthorization |
| `ext_agent_host_id` | Required; stable opaque per-host id (`urn:uuid:<uuidv4>`), generated/persisted before first sign-in |
| `id_token_hint` | Optional reauth hint: retained ID token (may be expired); omit after sign-out |
| `login_hint` | Optional reauth hint: saved validated email |
| `response_type` | `code` |
| `redirect_uri` | `http://127.0.0.1:<actual-port>/auth/callback` (exact string reused in exchange) |
| `scope` | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| `resource` | `https://api.openai.com/v1` |
| `state` | Fresh random per attempt (bound to the attempt; validated on callback) |
| `nonce` | Fresh random per attempt (validated inside the returned ID token) |
| `code_challenge_method` | `S256` (only supported method) |
| `code_challenge` | `base64url(SHA-256(verifier))`, no padding |

OIDC discovery (fetched 200 on 2026-11-03) confirms: `authorization_endpoint`,
`token_endpoint`, `revocation_endpoint`, `jwks_uri`, `userinfo_endpoint`;
`response_types_supported: ["code"]`; `code_challenge_methods_supported: ["S256"]`;
`grant_types_supported: ["authorization_code","refresh_token"]`;
`id_token_signing_alg_values_supported: ["RS256"]`;
`token_endpoint_auth_methods_supported` and `revocation_endpoint_auth_methods_supported`
include `"none"` (public client, no secret). Note `scopes_supported` only lists
`openid profile email offline_access` — the plan scopes are documented separately, not in
discovery, and are accepted.

---

## 2. Dynamic client registration (the part that differs from normal OAuth)

There is **no registration endpoint**. Registration happens implicitly on the first
authorization request and is returned on the loopback callback:

1. Before the first sign-in, generate and persist a stable per-host
   `ext_agent_host_id`. Accepted formats: `urn:ietf:params:oauth:jwk-thumbprint:…`
   (preferred by docs), `urn:uuid:<UUIDv4>` (supported, simplest — no keys), or
   `did:key:<key>`. It is **not** a credential and must not contain user identifiers.
2. First sign-in sends `client_id=dynamic_agent_client` plus `agent_name_hint` and
   `ext_agent_host_id`.
3. The new-registration callback carries `code`, `state`, the **issued `client_id`**
   (e.g. `oaiapp_…`), and usually `scope`.
4. Persist the issued client id with the validated account (keyed by its ID-token `sub`)
   and reuse it for every later sign-in to that account on any host. `dynamic_agent_client`
   must never be stored or used for token exchange.
5. Reauthorization sends the issued `client_id`, **no** `agent_name_hint`; keeps the same
   `ext_agent_host_id`; may add `id_token_hint`/`login_hint`.
6. If a new-registration callback lacks an issued client id, treat registration as
   incomplete (do not exchange). On reauth, a missing `client_id` means "use the saved
   one"; a *different* returned `client_id` must be rejected.

Registrations are per (ChatGPT user × workspace) and one issued client may be shared by
several hosts of that user/workspace, each with its own host id. Signing out and back in
does not create a new client. Losing the issued id means re-registering (a new client);
the docs do not define cleanup of an orphaned registration — see Uncertainties.

`agent_name_hint` is display-only: the user can edit the name before approving. Send the
same app name on every installation.

---

## 3. End-to-end flow

1. **Start the loopback listener first** on `127.0.0.1`, port `1455` if free else any
   available port. The redirect URI is `http://127.0.0.1:<port>/auth/callback`; scheme,
   host, and path are fixed and only the port may vary. Do not use `localhost`.
2. Generate fresh `state`, OIDC `nonce`, and PKCE verifier/challenge (S256) for this
   attempt; retain state + verifier + nonce + exact redirect URI until the callback.
3. Build the authorize URL and open it in the **system browser**.
4. User signs in / selects workspace / approves the app and ChatGPT plan usage.
5. Browser returns to the loopback callback with `code`, `state`, optional `scope`, and
   (registration) the issued `client_id`. If `error=access_denied` (or any `error`),
   validate `state`, stop, do not exchange.
6. Validate `state` (constant-time); resolve the client id:
   new registration → callback `client_id` (must be present and not `dynamic_agent_client`);
   reauth → saved client id, reject a conflicting returned one.
7. **Code exchange** — `POST` form-encoded to
   `https://auth.openai.com/api/accounts/oauth/token`:
   `grant_type=authorization_code`, issued `client_id`, `code`, `code_verifier`,
   the exact `redirect_uri`, `resource=https://api.openai.com/v1`. No client secret.
   On `invalid_grant`, discard the code and restart authorization with the retained issued
   client id.
8. **Token response** (HTTP 200): `access_token`, `refresh_token` (when `offline_access`
   granted), `id_token`, `token_type`, `expires_in`, `scope`, `earliest_refresh_at`.
9. **Validate the ID token** (section 6) and check the granted `scope` contains
   `chatgpt.tokens.use.direct`. A valid ID token without that scope = signed in, but plan
   usage disabled (offer re-consent or another billing path; do not call Responses).
10. Persist a protected credential record (section 7) and use `access_token` as
    `Authorization: Bearer` against `https://api.openai.com/v1`.
11. Inference: `POST https://api.openai.com/v1/responses` with `store: false`,
    `stream: true`; success only after a `response.completed` event.

---

## 4. Token endpoint contract

### Code exchange
```http
POST https://auth.openai.com/api/accounts/oauth/token
accept: application/json
content-type: application/x-www-form-urlencoded

grant_type=authorization_code
&client_id=<issued oaiapp_ client id>
&code=<authorization code>
&code_verifier=<PKCE verifier>
&redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Fauth%2Fcallback
&resource=https%3A%2F%2Fapi.openai.com%2Fv1
```

Response JSON fields: `access_token`, `refresh_token`, `id_token`, `token_type`,
`expires_in`, `scope`, `earliest_refresh_at`.
Access tokens live **1 hour** (`expires_in: 3600`); refresh tokens **30 days**.

### Refresh
```http
POST https://auth.openai.com/api/accounts/oauth/token
accept: application/json
content-type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id=<issued client id, NOT dynamic_agent_client>
&refresh_token=<current refresh token>
&resource=https%3A%2F%2Fapi.openai.com%2Fv1
# omit scope — omission preserves the existing grant
```
- Every successful refresh returns HTTP 200 with a **new access token and a replacement
  refresh token** (rotation, fresh 30-day lifetime, no fixed limit of successive refreshes).
  The response may also include a new `id_token` (observed in real deployments); treat it
  as optional and revalidate identity if present.
- **Rotate atomically**: store access token, expiry, scopes, and new refresh token together.
  Persist a replacement before/at first use; never keep using an old refresh token.
- **Serialize refreshes per session** (cross-process lock) so two processes cannot race the
  rotating token — the loser would present an already-used token.
- Refresh proactively shortly before `exp` (e.g. 5 min margin); if
  `earliest_refresh_at` is present, do not attempt earlier than it (format undocumented).

Refresh error handling (documented codes):
- Unusable token → `invalid_grant`, `invalid_refresh_token`, `token_expired`,
  `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused`:
  clear tokens, re-run OAuth with the saved issued client id.
- `invalid_client`: fix client configuration.
- Network/5xx: keep credentials, bounded backoff. Never erase credentials for a transient
  failure.

---

## 5. Revocation / logout / disconnect

The revocation endpoint comes from OIDC discovery:
`https://auth.openai.com/api/accounts/oauth/revoke`.

```http
POST https://auth.openai.com/api/accounts/oauth/revoke
content-type: application/x-www-form-urlencoded

token=<refresh_token>
&token_type_hint=refresh_token
&client_id=<issued client id>
```
- Empty **HTTP 200** = success, including for an already-invalid token.
- Retry network failures/5xx with backoff while the refresh token is still usable.
- Sign-out order: stop requests → attempt revocation → clear local access/refresh/ID tokens
  → **retain** the account↔client mapping and the host id for the next sign-in.
- If local sign-out finishes without confirmed revocation, tell the user remote revocation
  was not confirmed; they can disconnect the app in ChatGPT Settings.
- Revoking the session does **not** delete the registered client.
- **OpenAI does not notify the app when a user disconnects it in ChatGPT settings.** The
  app discovers it when a request or refresh fails (`subscription_sharing_invalid_user`
  on the API, or a terminal refresh error). Do not delete credentials on transient errors.
- There is no documented "delete registration/client" API for open-source clients.

---

## 6. ID token validation

Requirements (official): verify signature against OpenAI JWKS, then check issuer, audience,
expiration, and the per-attempt `nonce`.

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json"));
const { payload } = await jwtVerify(idToken, jwks, {
  issuer: "https://auth.openai.com",
  audience: <issued client id>,
  algorithms: ["RS256"],
  clockTolerance: 5,
});
if (payload.nonce !== expectedNonce) throw new Error("nonce mismatch");
if (typeof payload.sub !== "string" || !payload.sub) throw new Error("missing sub");
```

- `iss` must exactly equal `https://auth.openai.com`.
- `aud` must include the **issued client id**.
- Use the validated `sub` as the stable account id; email is display metadata only.
- Keep the ID token for later `id_token_hint` (it may be expired when reused).
- The official docs require signature verification. The MIT HA reference skips the
  signature with an explicit rationale (token received over TLS directly from the token
  endpoint) and still checks iss/aud/exp/nonce. For DSH, prefer real JWKS verification
  (`jose` is small and bundles cleanly); if JWKS cannot be reached through the user's proxy,
  fail closed or surface a clear error rather than silently accepting.
- `nonce` is only for the authorization-code response; refresh responses (if they carry an
  ID token) are validated with iss/aud/exp, not nonce.

Access-token claims (documented): `sub`, `aud` (= `https://api.openai.com/v1`), `client_id`,
`scope`, `https://api.openai.com/auth` `{per_user_salt, encrypted_auth_metadata}`, `iss`,
`iat`, `exp`, `jti`, `nbf`. There is **no `chatgpt_account_id` requirement in SIWC** (that
claim belongs to Codex OAuth tokens — do not rely on it). Treat the auth metadata as opaque.

---

## 7. Credential record shape (keys only — never log values)

Official example of the per-registration record:

```json
{
  "email": "user@example.com",
  "issuer": "https://auth.openai.com",
  "subject": "<validated ID-token sub>",
  "client_id": "<issued oaiapp_ client id>",
  "ext_agent_host_id": "urn:uuid:...",
  "id_token": "<retained for id_token_hint>",
  "access_token": "<bearer for api.openai.com/v1>",
  "refresh_token": "<rotating>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scopes": ["chatgpt.tokens.use.direct", "email", "offline_access", "openid", "profile", "resource.invoke"],
  "saved_at": "<UTC timestamp when the response was received>"
}
```

Store per (issued client id × validated account identity), separate even when emails match.
Use an app-defined protected path/store, atomic writes, `0600` on Unix. Keep tokens out of
browser storage, source control, logs, analytics, and support transcripts; never put
access/refresh tokens in URLs. An authorization URL containing `id_token_hint` must be
redacted from logs/diagnostics. Add an app-side `expires_at` (now + `expires_in`) and, if
present, parsed `earliest_refresh_at`.

---

## 8. Model catalog and inference

**Model catalog** — same access token as inference:

```bash
curl https://api.openai.com/v1/models -H "Authorization: Bearer $ACCESS_TOKEN"
```
Response contains a `models` array. Keep entries with `visibility == "list"`, preserve the
server's ordering, show `display_name`, and send `slug` as `model`. Refresh the list when the
active ChatGPT account changes. This shape (`models[].slug`) is **different** from API-key
`/v1/models` (`data[].id`) — do not mix parsers.

Official docs document only `slug`, `display_name`, `visibility`. A community plugin
observed ~50 fields on real accounts, including `description`, `input_modalities`,
`context_window`, `supported_reasoning_levels[{effort, description}]`, and
`default_reasoning_level`; treat unknown fields as optional and never hardcode model ids.

**Inference** — `POST https://api.openai.com/v1/responses`,
`Authorization: Bearer <access_token>`, `store: false`, `stream: true`, full context in
`input`. Success is only `response.completed`. Unsupported: system-role input items (use
`instructions`/developer messages), `temperature`, `top_p`, `max_output_tokens`,
`metadata`, `background`, `conversation`, `truncation`, `user`, `previous_response_id`
over HTTP, hosted tools (image gen, file search, Code Interpreter, hosted MCP, tool_search),
audio/video, Files uploads.

---

## 9. Headers, 400/403 pitfalls, and network

Headers:
- Authorize is a browser navigation (no special headers).
- Token/revoke: `content-type: application/x-www-form-urlencoded` and, per official Node
  example, `accept: application/json`. **No client secret** in the OSS flow. No
  `User-Agent`/`originator` requirement is documented; do not invent one.
- On auth failures, preserve `openai-request-id` / `x-request-id` for diagnostics (never log
  tokens).

Pitfalls:
- **Region / egress:** from this machine's direct CN egress every OpenAI endpoint returns
  `403 {"error":{"code":"unsupported_country_region_territory",...}}`. The plugin must send
  auth + API calls through the user's proxy (macOS system proxy via `scutil --proxy`, or
  `HTTPS_PROXY`). **Node 22 `fetch` does not honor the macOS system proxy or proxy env by
  default** — use an explicit `undici` `ProxyAgent`/`EnvHttpProxyAgent` (respect
  `NO_PROXY` for `127.0.0.1` so the loopback callback never goes through the proxy).
- Redirect URI must match character-for-character between authorize and token exchange;
  `localhost` instead of `127.0.0.1`, or a different port, will fail. Listener must be
  running before the browser opens.
- `code` is one-time. A failed/duplicated exchange returns `invalid_grant`; restart auth,
  keep the issued client id.
- `dynamic_agent_client` used for exchange → failure. Missing/incorrect `resource` or
  `scope`/PKCE mismatch → 400. Only `S256` is accepted.
- Account not eligible (e.g. ChatGPT Free): observed at the **code exchange** as HTTP 400
  `invalid_grant` (occasionally without `error_description`) even though the docs only
  document `access_denied` for authorization and eligibility errors for inference. Surface
  a clear "account not eligible" hint and keep the issued client id for a later retry.
- Never force consent on ordinary sign-in. `prompt=consent` only when the user explicitly
  enables plan usage after a decline; `force_reconsent=true` only after OpenAI confirms it
  for the integration.
- Token endpoint errors may be JSON `{"error":{"code","message"}}` or OAuth
  `{"error","error_description"}`; handle both.

---

## 10. Is there an official JS/Node SDK?

**No.** The official docs ship copy-paste Node.js snippets (`node:crypto` for PKCE/state and
`jose` for JWKS verification) and a Python SDK example for *inference* only (`openai` client
with `api_key = <OAuth access token>`). The OAuth flow itself is implemented by the app.

Options for the plugin:
1. Implement the minimal flow directly (recommended — the MIT reference in
   `research/ref/chatgpt_plan_auth/` is ~500 lines of Python; the community DSH plugin's
   `src/oauth.ts` is the same in TypeScript) and bundle `jose` for ID-token verification.
2. Third-party (not official): `@opencoredev/loginwithchatgpt-*` (MIT), or study the
   community DSH plugin. Do not treat either as an officially supported dependency.

---

## 11. DSH Host implementation notes

- **Callback server:** `node:http` on `127.0.0.1`; try `1455`, else ephemeral port (`listen(0)`).
  Bind before opening the browser. Handle exactly `GET /auth/callback`; reject wrong
  method/path/Host (400/404/405), validate `state` in constant time, handle `error` params,
  resolve only once (409/ignore duplicates), HTML success page, timers + abort cleanup,
  10-minute timeout.
- **Browser:** macOS `open <url>`; on failure show the URL for manual copy (but never log it
  if it contains `id_token_hint`; use `login_hint`/no hint when possible).
- **Proxy:** required here — read macOS system proxy or honor `HTTPS_PROXY`; use `undici`
  ProxyAgent for all `auth.openai.com` / `api.openai.com` calls; bypass for `127.0.0.1`.
- **Storage:** DSH credential store (`~/.dsh/.credentials.yaml`, 0600, atomic) with two
  records: `registry` (host id + accounts: client_id, sub, email) and `session` (tokens,
  scopes, expires_at, earliest_refresh_at). Cross-process lock around refresh.
- **Logout:** revoke refresh token, then delete tokens; keep registry/host id; report
  unconfirmed revocation.
- **Plan-usage disabled path:** valid ID token without `chatgpt.tokens.use.direct` keeps
  sign-in; inference button disabled with a "Continue with ChatGPT" re-consent or API-key
  alternative.
- **UI strings (official guidelines):** "Continue with ChatGPT" button; first-usage modal
  "You're using your ChatGPT plan" + "Got it"; "Using ChatGPT plan" near the model picker;
  "Manage usage" → `https://chatgpt.com/settings/usage`; usage-limit error makes "Manage
  usage" the primary action.

---

## 12. Related but different: Codex OAuth / DSH `openai-codex`

Do not mix the two protocols:

| | SIWC (this doc) | Codex CLI OAuth (built-in provider) |
|---|---|---|
| client id | dynamically issued `oaiapp_…` per registration | fixed `app_EMoamEEZ73f0CkXaXp7hrann` |
| authorize/token | `…/api/accounts/authorize`, `…/api/accounts/oauth/token` | `…/oauth/authorize`, `…/oauth/token` |
| identity | ID-token `sub` + issued client id | Codex JWT claims incl `chatgpt_account_id` |
| inference | public `https://api.openai.com/v1/responses` with `store:false,stream:true` | ChatGPT `backend-api`/Codex Responses path |
| refresh body | form-encoded | Codex sends JSON |
| credential store | app-defined SIWC record | `~/.codex/auth.json` |

The plugin must not read, copy, or reuse Codex CLI credentials.

---

## 13. Uncertainties / open items

1. `earliest_refresh_at` format and exact semantics are undocumented. Community observation:
   a Unix-seconds timestamp ~6 minutes before access-token expiry; treat as optional
   (number epoch s/ms or ISO-8601), never block refresh on its absence.
2. Does a refresh response always include a new `id_token`? Docs only promise a new access
   token and replacement refresh token; real deployments returned one. Handle optional.
3. Registration cleanup: if the issued client id is lost (reinstall/reset), re-registering
   with the same host id creates a new client. The docs do not document deduplication or
   revocation of the orphaned registration.
4. Exact error for ineligible accounts at code exchange is not documented; observed
   `invalid_grant` (400). Authorization may instead return `access_denied`.
5. `force_reconsent=true` is gated on OpenAI confirming deployment for the integration;
   until then only `prompt=consent` on explicit user action is safe.
6. Model catalog extra fields (capabilities/context window/reasoning levels) are not
   documented for SIWC; only `slug`/`display_name`/`visibility` are contractual.
7. Rate limits/quotas for the plan route are plan- and app-scoped (weekly caps, shared
   Plus 5-hour window); the API exposes errors, not a reliable reset time. Do not infer one.
8. OIDC discovery/`jwks` reachability depends on the user's proxy; verify at runtime and
   fail closed with an actionable message if unreachable.
