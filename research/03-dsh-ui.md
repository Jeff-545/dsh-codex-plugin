# 03 — Web-UI surface for the `openai-codex` (ChatGPT) provider + browser login

**Owner:** dsh-ui (task-3). **Target:** installed DeepSeek Harness desktop **v0.2.1-rc.5**, Web GUI `http://127.0.0.1:61493`, profile `/Users/jeff/.dsh/profiles/desktop`.
**Read-only research:** no bundle installed, no profile/settings written; the only file written is this one.

## Evidence labels

| Label | Meaning |
|---|---|
| **LIVE** | Read from the running rc.5 host through `cordis_inspect_query` (Host `Service`/`Config`), or read from the installed build's own files inside `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` (that asar is readable with a byte-offset reader, so installed `lib/index.js` + `lib/client.js` were parsed directly; this is exactly the code the running page executes). |
| **SOURCE(α.3)** | Read from the local source checkout `/Users/jeff/Documents/DEV/deepseek-harness` (v0.2.1-alpha.3). Type/contract evidence only; rc.5 was re-verified where the difference matters. |
| **PRIOR ART** | Published third-party plugin `dsh-codex@0.3.2` installed at `/Users/jeff/.dsh/profiles/web/node_modules/dsh-codex` (peer range `^0.2.0-rc.1`). Working reference implementation, **not** a DSH API contract. |

Environment limitation: **Client** inspect queries (`Slots.listSubTree`, `Builtin.listBuiltins`, `Theme.listTokens`) timed out after 10 s ("Open or reconnect the Harness page") for the whole session, so live Slot topology could not be queried. Compensating evidence: the installed `dsh-client-ui-*` `/lib/client.js` bundles were extracted and their slot **declarations and registrations** read verbatim (these are the exact artifacts the page loads). Every slot label below marked **LIVE** comes from those bundles. Re-run `Slots.listSubTree` once the page answers (see §9).

All claims that changed the design are called out in **§0** so the Lead can act without reading the full trace.

---

## 0. Headline findings (read this first)

1. **The model picker needs no UI work.** A newly registered `llm` adapter route appears in the composer picker automatically: the client asks the Host for `session/modelCatalog`, which is built from `ctx.llm.listProviders()` → `ctx.llm.listModels()` → `resolveModelInfo`; the client invalidates on the forwarded `llm/adapters-updated` event. **LIVE** (§1).
2. **No generic authorization UI exists in rc.5.** No `ui-*authorization*` client package exists (all 308 `@deepseek-ai/*` packages in the installed asar were enumerated); the `ctx.authorization` host Service exposes **no `@Remote` methods** (**LIVE** contract), so a browser half cannot call it at all. The only sign-in UI is the first-party DeepSeek account page, bound to the DeepSeek provider. **LIVE** (§2).
3. **The OAuth flow we need is already registered in the installed build.** `@deepseek-ai/dsh-llm-pi-ai` registers one `ctx.authorization` flow per installed pi-ai provider with a login, and the installed pi-ai (`^1.1.0`) ships an `openai-codex` provider with `auth.oauth = { name: "OpenAI (ChatGPT Plus/Pro)", isSubscription: true }`. `UNSERVED_OAUTH` excludes only `openai` (needs a device id), **not** `openai-codex`. So the credential key `llm-pi-ai/openai-codex` already has a flow whose `run()` does PKCE + `http://localhost:1455/auth/callback` + token exchange, with a device-code method and a "paste redirect URL" fallback. **LIVE** (§2.3, §6). Consequence: the plugin's job on the host is a **trigger + status projection**, not an OAuth implementation — unless the team's SIWC research decides pi-ai's legacy Codex flow must be replaced; the UI contract in this document is identical either way.
4. **One shipping pattern for a client half without Typert codegen**: `package.json` `dsh.client` + `exports["./client"]` → host row in `cordis.patch.yml` → the browser bundle is served by `dsh-client-modules` and executed as `window.__ModuleLoader__.load({ id, factory })`. Host↔Client data goes over **plugin-owned `ctx.webServer.register` routes + same-origin `fetch`**, guarded by the first-party `ctx.connection.requestRejection(...)` (**LIVE** host Service). Plain JS with no build step is possible; JSX needs a build step. **LIVE + PRIOR ART + SOURCE(α.3)** (§4, §5).
5. **The settings page Slot is `settings.section`** — a `list` slot at `root` scope, declared by `ui-settings-general` as a child of `sidebar.settings`; registration options `{ name, id, order, label, locale, inject }`, component gets the derived slot props. **LIVE** (§3.1, §6.4).
6. **Desktop is not a file:// page for the main window**: the desktop host loads `ctx.connection.authenticatedUrl("http://127.0.0.1:<port>")` into the window (`apps/desktop-host/src/index.ts:103`), which is why the GUI here is `http://127.0.0.1:61493`. Relative `fetch("/plugins/...")` therefore works in the desktop app and carries the `dsh-auth-*` session cookie. **SOURCE(α.3)** + **LIVE** URL.
7. **The `webServer` has no server-wide auth or origin policy** — route owners must enforce their own. Use `ctx.connection.requestRejection`, not a hand-rolled allowlist. **LIVE** service + README **SOURCE(α.3)** (§5.3).

---

## 1. How the composer model picker discovers providers (LIVE)

### 1.1 Trace

```
Client (composer / popup)
  packages/client/ui-model-selection/src/client/ModelSelect.tsx
    └─ ctx.modelDirectories.directoryFor(sessionId)         (Client service `modelDirectories`)
        └─ ModelCatalogDirectory.load()     ← ctx.remote.session.modelCatalog()      [LIVE client.js:752]
Host
  @deepseek-ai/dsh-api-session-controller  SessionController
    └─ @Remote('modelCatalog') modelCatalog() → buildModelCatalog(ctx)               [LIVE]
        ├─ ctx.llm.listProviders()                       (LIVE `llm` contract: @Remote)
        ├─ ctx.llm.listModels(provider.id)               (per-provider, awaited)
        ├─ ctx.llm.resolveModelInfo(provider.id, model)  (reasoning metadata)
        └─ returns { default, routableProviders, groups, failures }; empty groups are filtered out
```

- **LIVE** `llm` service contract includes `@Remote listProviders(): LlmProviderInfo[]`, `@Remote listConfigurableProviders()`, `@Remote('discoverModels')`, and `listModels(provider)` / `resolveModelInfo(provider, model)` (host-only). An adapter route is registered with `registerAdapter(providers, adapter)`.
- **LIVE** installed `dsh-api-session-controller/lib/index.js`: `async function buildModelCatalog(ctx, …)` iterates `ctx.llm.listProviders()`, awaits `ctx.llm.listModels(provider.id)`, `ctx.llm.resolveModelInfo(...)`, pushes `routableProviders: groups.map(g => g.id)`, and records per-provider `failures`.
- **LIVE** installed `dsh-client-ui-model-selection/lib/client.js`: `this.ctx.remote.session.modelCatalog()` (line 752); catalog re-load on forwarded events `llm/adapters-updated` (line 1006), `settings/document-updated`, `credentials/record-updated`, `credentials/reference-updated`, and on `connection/reset`.
- **LIVE** selectability/submittability rule (same bundle, line 968):
  ```js
  const routable = catalog.value.groups.some(group =>
    group.id === selection.provider && group.models.some(model => model.id === selection.model))
  ```
  So the picker lists whatever `listModels()` returns, and the current selection is "routable" iff it is present in that catalog. Nothing else (no settings entry, no configurable-provider registration, no credential check) gates the picker.

### 1.2 Consequence

An adapter route registered with `ctx.llm.registerAdapter(['openai-codex'], adapter)` where `adapter.listModels('openai-codex')` returns the Codex model ids **appears in the composer picker automatically**, and becomes "routable" as soon as it is registered. `registerAdapter` publishes `llm/adapters-updated` (**SOURCE(α.3)** `packages/llm/llm/src/index.ts:371`), which the client already subscribes to, so no reload is needed. This is exactly what the prior-art plugin relies on: `dsh-codex` only does `ctx.llm.registerAdapter([OPENAI_CODEX_PROVIDER], …)` and lets its `cordis.patch.yml` set `agent-default-model` to `openai-codex / gpt-5.6-sol` (**PRIOR ART** `src/index.ts:312`, `cordis.patch.yml`).

Two practical notes:
- The picker orders providers with `deepseek-account` first, `deepseek-official` second, everything else after (**LIVE** `orderModelProviders`). Our provider therefore lands after the DeepSeek groups — acceptable.
- `buildModelCatalog` has a **default selection** (`agentDefaultModel.currentSelection()`); if that default names a route that is not registered, the picker still lists the catalog but the default shows as non-routable. A profile patch that sets `agent-default-model: { provider: openai-codex, model: … }` is only safe once the route is registered from the same composition (prior art does exactly that).

### 1.3 The Models *settings* page is a different directory (and is optional for us)

`ui-settings-models` builds its provider rows from `ctx.llm.listConfigurableProviders()` joined with settings namespaces (**LIVE** `dsh-client-ui-settings-models/lib/client.js`, store lines ~246–280): a row needs a directory entry carrying `settingsNs`/`settingsPath`, and its editor needs a resolved settings namespace schema. A route that only exists as an adapter registration does **not** get a Models-page row. Our settings page therefore lives in its own `settings.section`; no Models-page integration is required for the MVP (§3.3).

---

## 2. Is there an existing authorization UI we can reuse? (LIVE — no)

### 2.1 Host side

**LIVE** host `Service` catalog: `authorization` exists with
`registerFlow(flow)`, `list()`, `describe(key)`, `cancel(key)`, `begin(request)` — **none of them carries `@Remote`**. The contract renders `@Remote` as a marker in the signature (compare `agentPresets`: `@Remote('list') async remoteExportList()`), and `authorization` has none. There is therefore **no `ctx.remote.authorization` namespace**; a browser half cannot begin a flow directly.

The seam (`packages/credentials/authorization/src/index.ts`, **SOURCE(α.3)**, mounted **LIVE** as `include:authorization`) is deliberately transport-neutral: `begin({ key, method?, interaction: { notify, prompt }, signal? })` where the **caller supplies the human surface**. Notices are `{ message, url?, code? }`; prompts are `{ kind: 'select' | 'secret' | 'text', message, options?, placeholder?, signal? }`. One attempt per key at a time; commit is verified through `credentials/record-updated`; terminal failures are typed `AuthorizationError` codes (`NO_FLOW`, `UNKNOWN_METHOD`, `ALREADY_IN_FLIGHT`, `NOT_COMMITTED`).

### 2.2 Browser side

- Enumerated every package in the installed asar: 55 `dsh-client-ui-*` packages, **none** for authorization/OAuth. The only sign-in surfaces are inside `dsh-client-ui-settings-account` (DeepSeek account).
- That package registers into `settings.models.sign-in`, but that hole is declared by `ui-settings-models` **as a child of `settings.onboarding`**, and is only rendered inside the first-party **DeepSeek onboarding modal** when the `deepseek-official` row is `credential-missing`; it receives `{ complete, useApiKey }` with an API-key editor as fallback (**LIVE** `dsh-client-ui-settings-models/lib/client.js:2968`, declaration at `:4508`). It is not a generic per-provider sign-in slot and cannot be used for another provider.
- `ui-settings-account`'s own sign-in flow is account-specific: `ctx.remote.account.startSignIn(...)` → `AccountView.attempt.authorizeUrl` → poll/`watch` (`grep '@Remote'` in `@deepseek-ai/dsh-api-account-controller`, **SOURCE(α.3)** + **LIVE** `accountController` name in the Config directory). Its *pattern* is the one to copy (§6), its *namespace* is not extensible by another package.

Verdict: **a Client half is required** for the requested UX (Connect / status / Manage usage / Disconnect). The seam's own docs even use `llm-pi-ai / openai-codex` as the canonical example of a registered flow — but the surface that renders it was never built.

### 2.3 The flow already exists for our key (LIVE)

**LIVE** installed `dsh-llm-pi-ai/lib/index.js`:

```js
2450  * stable UUID that the app supplies through `LoginOptions.getDeviceId`, and it
2454 const UNSERVED_OAUTH = new Set(["openai"]);
...
2563 for (const providerId of catalogProviderIds()) {
2569   const oauth = provider === void 0 || UNSERVED_OAUTH.has(provider.id) ? void 0 : provider.auth.oauth;
2578   ctx.authorization.registerFlow({ key: recordKeyFor(providerId), label: provider.name, methods: [first, ...rest], async run(session) { ... models.login(providerId, type, { signal, notify, prompt }) } })
```

`recordKeyFor(id) = credentialKey('llm-pi-ai', id)` (**LIVE** same bundle / **SOURCE(α.3)** `src/auth.ts`). The installed pi-ai catalog includes the provider (**LIVE** installed `@earendil-works/pi-ai`):

- `dist/providers/all.js:109` → `openaiCodexProvider()`
- `dist/providers/openai-codex.js`: `id: "openai-codex"`, `name: "OpenAI Codex (legacy)"`, `baseUrl: "https://chatgpt.com/backend-api"`, `auth.oauth = lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", isSubscription: true })`, `api: openaiCodexResponsesApi()`
- `dist/auth/oauth/openai-codex.js`: PKCE S256 against `${AUTH_BASE_URL}/oauth/authorize`, `REDIRECT_URI = "http://localhost:1455/auth/callback"`, token exchange + refresh, a device-code method, and a "port 1455 taken → paste redirect URL" fallback prompt.
- `dsh-llm-pi-ai/lib/index.js` `PROVIDER_DATA["openai-codex"] = { env: [], defaultBaseURL: "https://chatgpt.com/backend-api" }` → **keyless** native auth (the Models page hides the API-key field for such a route: `keylessNativeAuth = nativeAuth?.env.length === 0 && nativeAuth.oauth`, **LIVE** `ui-settings-models/lib/client.js`).

So at runtime `ctx.authorization.describe(credentialKey('llm-pi-ai','openai-codex'))` should return `{ key, label: "OpenAI Codex (legacy)", methods: [{ id: "oauth", label: "OpenAI (ChatGPT Plus/Pro)" }], inFlight }`. **Verify this at plugin apply time** (one `logger.info` is enough) — it is the assumption this recommendation rests on, and it is cheap to assert.

---

## 3. Slot options for the new UI (LIVE topology)

### 3.1 `settings.section` — the Settings page (recommended home)

Declaration (**LIVE** `dsh-client-ui-settings-general/lib/client.js`): a child of the `sidebar.settings` registration.

```js
ctx.slots.register({
  name: "sidebar.settings",
  children: {
    "settings.launcher":  { kind: "single", scope: "root" },
    "settings.trigger":   { kind: "single", scope: "root" },
    "settings.header":    { kind: "single", scope: "root" },
    "settings.action":    { kind: "list",   scope: "root" },
    "settings.close":     { kind: "single", scope: "root" },
    "settings.section":   { kind: "list",   scope: "root" },
    "settings.onboarding":{ kind: "list",   scope: "root" },
  }, inject: shellInjected
}, SettingsRoot)
```

Shipped occupants (**LIVE**, extracted from installed bundles) show the exact registration shape:

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'models',                 // stable occupant id, unique per slot
  order: 10,                    // nav order; general = 0, models = 10, plugins = 15, agent-presets = 20, account = -10
  label: () => t('nav'),        // localized nav label (required for a section)
  locale: NS,                   // optional: binds the `t` seat to this locale namespace
  inject: injected,             // optional: plain data/callbacks from the apply closure
  children: { … },              // optional: child slots the section itself renders
}, ModelsSection))              // a React component
```

Props: the component receives the framework's derived shares (owner data, `renderSlot`/`renderFactorySlot`, store, inject face) plus, when `locale` is set, the localized `t` seat. In practice: `function MySection({ t, ...inject })` — **PRIOR ART** `dsh-codex/src/client/OpenAICodexSettings.tsx` consumes exactly `{ t }`, registered with `inject: () => ({ t })`.

**This is the slot to use.** It gives a top-level "ChatGPT (Codex)" nav entry in Settings where Connect / status / Manage usage / Disconnect all fit, and it is stable across the versions we can see (present in both 0.2.0-rc.1-era prior art and installed rc.5).

### 3.2 `settings.models.provider-card` / `settings.models.footer` — Models page (not recommended as the home)

`ui-settings-models` declares exactly two children (**LIVE** installed bundle `:4491`):

| Slot | Kind/scope | Props passed by parent | When rendered |
|---|---|---|---|
| `settings.models.provider-card` | `keyed`, `root`; `entryKey = row.entry.settingsNs` | `{ provider: LlmConfigurableProvider, configured, keyConfigured }` | only inside the "needs setup" card and the add-provider panel |
| `settings.models.footer` | `list`, `root` | `{}` | always, at the bottom of the Models section |

Both are available to a plugin without patching the shipped package. But: the keyed card needs a row that only exists for a **configurable provider** (settings namespace + schema), and the footer is a page-wide strip, not a per-provider account surface. Neither yields the requested SIWC UX (plan indicator + usage link + disconnect). Use them at most for a single "Sign in" affordance if the provider is also registered as configurable.

### 3.3 Composer indicator slot

`conversation.input.right` is `{ kind: 'list', scope: 'session' }`, declared by `ui-conversation` as a child of the composer slot (**LIVE** installed `ui-conversation/lib/client.js`). Its occupants receive `inject(sessionId)` data; `ui-settings-account`-style and prior-art quota chips register here. **PRIOR ART** `dsh-codex/src/client/OpenAICodexQuotaIndicator.tsx` registers `conversation.input.right` with `inject: (sessionId) => ({ directory: scope.modelDirectories.directoryFor(sessionId).store })` and shows a weekly-quota chip only when the session's current model is `openai-codex`. This is the natural home for the **"Using your ChatGPT plan" indicator**; the full account actions stay in the Settings section.

---

## 4. What a Client half needs (LIVE bundle format + PRIOR ART + skill reference)

The installed page loads client plugins through `dsh-client-modules` (**LIVE** host `clientModules` service; **SOURCE(α.3)** `packages/client/modules/src/index.ts`).

### 4.1 Manifest — one host row, no separate client row

`package.json`:

```json
{
  "name": "@acme/dsh-codex",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-api-gateway"
      ]
    }
  }
}
```

- `dsh.client.platform` **must** be `"web"`; `inject` is **informational only** (preflight display + HMR diff, not activation order) — **SOURCE(α.3)** `packages/util/package-manifest/src/types.ts:81` and `packages/client/AGENTS.md`.
- `dsh.client` requires an `exports["./client"]` (string or `{ default }`); without it composition fails loudly — **LIVE** `client-modules` error text `declares dsh.client but exports no "./client" bundle`.
- `external` is only for non-baseline module-table requests. Baseline modules are implicit (**LIVE**/**SOURCE(α.3)** `packages/client/web/src/platform.ts`): `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`. We request none.
- One Loader row is enough for both halves: the row mounts the Host plugin, and the same package's `dsh.client` declaration makes `client-modules` emit the browser row (id = package name).

### 4.2 Bundle format — a classic script registering a lazy CJS factory

`lib/client.js` is **not** an ESM module. It is a classic script that calls the page-global loader; the factory body is CommonJS and receives the module-table `require`. Verified identical shape in shipped bundles and the prior art:

```js
window.__ModuleLoader__.load({
  id: "@acme/dsh-codex",              // MUST equal the package name (graph row id)
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // side effects happen here, at materialization, never at script execution
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    /* … components, apply() … */
    exports.name = "dsh-codex-client";
    exports.inject = ["slots", "locale"];
    exports.apply = apply;
    return module.exports;
  }
});
```

- Serving: `client-modules` registers one `{ kind: 'prefix', path: '/plugins', handler }` route and serves `/plugins/<id>/client.js` plus `/plugins/<id>/client.js.map`; the boot graph is injected into `index.html` as `window.__DSH_BOOT__` (**LIVE** client `clientModules` service members `graph()`, `clientPath(id)`, `fetchBundle`, `onRebuilt`; **SOURCE(α.3)** `packages/client/modules/src/index.ts:311`, `:649`).
- **Plain JS with no build step is possible** for our settings page: write the wrapper above by hand and build elements with `React.createElement` / `jsx(...)`. JSX is *not* available without a transform; CSS Modules are not available, but inline style objects and `--dsw-*` theme tokens in `style` work. A bundler (tsdown, as in the prior art) is optional — needed only when we want JSX/CSS Modules. **Recommendation: hand-written plain JS for the first version** (zero build, zero `external` config, one file to review); promote to tsdown later if the page grows.
- Locale strings: the section registration's `locale` gives the component a `t` seat; the strings come from `ctx.locale.register(ns, { en, zh })` in `apply` (**LIVE** `dsh-client-locale` row + **PRIOR ART** `dsh-codex/src/client/index.tsx:42`). Copy is locale-owned; no hardcoded product strings in components (`packages/client/AGENTS.md`). For a hand-written JS MVP we can still register a tiny dictionary through the same API.

### 4.3 CSS / theme

Feature components must consume semantic aliases (`var(--dsw-alias-*)`) through CSS Modules; a hand-written bundle can use inline styles with those same tokens. Token names are inspectable with `Theme.listTokens` once the client inspect provider answers; the prior art uses `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-border-l2`, `--dsw-alias-bg-module-platform`, `--dsw-alias-bg-layer-1`, `--dsw-alias-button-primary-fill`, `--dsw-alias-state-error-primary` — copy those names, they are **PRIOR ART**, not verified.

### 4.4 HMR / build implications

- `include:client-hmr` (`@deepseek-ai/dsh-client-hmr`) is mounted (**LIVE** Config directory) and `clientModules` exposes `artifactBaseline(id)` / `rebuilt(id)` / `onRebuilt`, so served bundles can be invalidated when their bytes change (**LIVE** service members). For a **profile-installed** bundle the reliable loop is still: edit `lib/client.js` → restart the app / reload the page. Negative verdicts and package metadata are cached per entry until restart (**SOURCE(α.3)** header comment), so a *new* package or a *renamed* path will not appear without a restart.
- Host code changes follow the normal Loader path (`hmr` row is present, **LIVE**), but a changed package set still needs a profile reload; `plugin_manager install_bundle` performs the profile update.
- Do not promise hot reload in review notes; promise "restart or reload after install".

---

## 5. Host↔Client data path (recommended: web routes, not a custom Typert Remote)

### 5.1 Why not a generated `@Remote` namespace

A custom `@Remote` namespace is *technically* possible without the codegen pipeline, but it is not the smallest stable surface:

- Host side: a service extending `TypertRemoteService` with `@Remote` methods is discovered by the gateway through **SRC markers** (`collectSrcClaims`), and invokable with weak descriptors derived from JS parameter names — the gateway supports this explicitly (**SOURCE(α.3)** `packages/api/gateway/src/index.ts:384-399`, `:1609-1630`).
- Client side: `ctx.remote.$mount(contribution)` requires a `TypertRemoteContribution { package, descriptors }`, and every descriptor's **parameter codecs must be strict** (`requireStrictInputs` → "has no strict codec", **SOURCE(α.3)** `packages/api/gateway/src/client/index.ts:803-817`). Strict codecs are normally emitted by `@deepseek-ai/dsh-typert-generator` into `lib/typert.host.js` + `lib/typert.remote-client.js` (45 KB of zod for the small account namespace — measured from the installed build). Hand-writing them is possible but couples us to generator internals, and the alternative build path (`typertPlugin` in a tsdown workspace) assumes the monorepo's project layout.
- Also: stream methods (needed if we wanted to push the auth URL) add uplink/frame plumbing; and a **withdrawn strict definition forbids SRC fallback** — i.e. version skew can turn a working call into a hard error.

**Conclusion: do not ship a custom Remote namespace for this plugin.** It buys nothing a same-origin route does not already provide, and it is the most version-fragile piece we could add.

### 5.2 Why same-origin routes are supported (and how)

`ctx.webServer.register` is a first-class host service (**LIVE** `webServer` with `register(route)`, `registerUpgrade`, `registerFallback`, `tapIndex`, `renderIndex`, `getOrigin`); the prior art uses it for its whole settings surface (**PRIOR ART** `dsh-codex/src/auth-routes.ts:874-1147`, paths `"/plugins/dsh-openai-codex/auth/{status,login,cancel,logout}"`).

- **Route shape**: `{ kind: 'exact' | 'prefix', path: '<absolute pathname, no trailing slash>', handler(req, res) }`; returns a disposer; duplicate path in the same table throws (**LIVE**/**SOURCE(α.3)** `packages/host/webserver/src/index.ts:47`, README "Registering routes"). Matching: exact over the whole table, then longest prefix, then fallback.
- **Path prefix rules**: none enforced beyond being an absolute pathname. Use our own namespace, e.g. `/plugins/dsh-codex/auth/*` (the `/plugins` prefix is already used by the bundle route, but prefix matching is longest-first, so `/plugins/<pkg>/...` is fine and is what the prior art does). Avoid `/api` (Connection's shared channel) and `/connect`.
- **Origin / auth / CSRF**: the webserver enforces **nothing** — README states "**No server-wide authentication or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy" (**SOURCE(α.3)** `packages/host/webserver/README.md:130`). The first-party guard to reuse is:

  ```ts
  const rejection = ctx.connection.requestRejection({ headers: req.headers })  // 401 | 403 | undefined
  if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
  ```

  **LIVE** `connection` host Service carries `requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection`; it applies "Connection's Host/Origin checks and browser authentication to another Web route" (**SOURCE(α.3)** `packages/client/connection/src/rpc.ts:228-233`). This covers the DNS-rebinding Host fence, the cross-site fence (`Sec-Fetch-Site`, Origin), and the signed `dsh-auth-*` browser-session cookie — i.e. exactly the guard a plugin route needs, without reimplementing the prior art's own allowlist sidecar.
  Additionally: require `content-type: application/json` on POST, cap body size, use `cache-control: no-store`, and never echo tokens.
- **Client discovery**: there is none — the path is a build-time constant shared by both halves (prior art keeps them in `src/auth-paths.ts` and mirrors them in the client). Keep one `lib/paths.js` module imported by both halves (Node ESM for host; a literal copy in the client bundle, or generate the client bundle).

### 5.3 Minimal code sketch — host routes

```js
// lib/index.js  (Host half; plain ESM, no build)
import { credentialKey } from '@deepseek-ai/dsh-credentials'

export const name = 'dsh-codex-ui'
export const inject = ['webServer']
const LOGIN = '/plugins/dsh-codex/auth/login'
const STATUS = '/plugins/dsh-codex/auth/status'
const CANCEL = '/plugins/dsh-codex/auth/cancel'
const LOGOUT = '/plugins/dsh-codex/auth/logout'

export function apply(ctx) {
  const account = new CodexAccount(ctx)           // §6.1
  ctx.effect(() => () => account.dispose(), 'codex: account lifetime')

  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(value))
  }
  const guarded = handler => async (req, res) => {
    const rejection = ctx.connection.requestRejection({ headers: req.headers })
    if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
    try { await handler(req, res) } catch (error) { json(res, 500, { error: 'internal' }) }
  }

  ctx.effect(() => {
    const dispose = [
      ctx.webServer.register({ kind: 'exact', path: STATUS, handler: guarded(async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        json(res, 200, await account.status())
      })}),
      ctx.webServer.register({ kind: 'exact', path: LOGIN, handler: guarded(async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        json(res, 200, await account.startSignIn())
      })}),
      ctx.webServer.register({ kind: 'exact', path: CANCEL, handler: guarded(async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        account.cancel(); json(res, 200, { ok: true })
      })}),
      ctx.webServer.register({ kind: 'exact', path: LOGOUT, handler: guarded(async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        await account.signOut(); json(res, 200, { ok: true })
      })}),
    ]
    return () => { for (const d of dispose) d() }
  }, 'codex: web routes')
}
```

The same file also registers the provider (§6.5) — the UI service and the adapter are independent.

---

## 6. Recommended architecture (ONE approach) and the login end-to-end

### 6.1 Recommendation

**A small Host service + four same-origin JSON routes + one plain-JS client half registering `settings.section`.** The Host service drives the *already-registered* `ctx.authorization` flow for `credentialKey('llm-pi-ai', 'openai-codex')`; the client half renders Connect / status / Manage usage / Disconnect and polls for progress. No Typert codegen, no `@Remote`, no build step, no Models-page patching.

Why this is the smallest stable surface:
- The model picker already works from the adapter route (§1) — zero UI effort there.
- The authorization seam + the pi-ai flow already exist in the installed build (§2.3) — we add the trigger and the projection, not OAuth.
- `settings.section` is a stable, documented list slot present in both the prior art's peer version and installed rc.5 (§3.1).
- Same-origin routes + `requestRejection` are first-party host APIs (webserver + connection), with a working third-party precedent.
- The whole client artifact is one hand-written file in a documented loader format (§4.2), so there is no build pipeline to keep aligned with 0.2.1-rc.5.

### 6.2 Host service — state and orchestration

```js
// lib/account.js (Host half)
import { credentialKey } from '@deepseek-ai/dsh-credentials'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')   // flow registered by dsh-llm-pi-ai
const QUIET = () => {}

export class CodexAccount {
  constructor(ctx) {
    this.ctx = ctx
    this.attempt = undefined           // { phase, url?, code?, expiresAt?, error? }
    this.timer = undefined
  }

  /** Value returned by GET status; never contains a token. */
  async status() {
    const record = await this.ctx.credentials.describeRecord(KEY)
    const attempt = this.attempt
    if (attempt?.phase === 'signing-in') {
      return { status: 'signing-in', method: attempt.method,
        ...(attempt.url ? { url: attempt.url } : {}),
        ...(attempt.code ? { code: attempt.code } : {}),
        ...(attempt.prompt ? { prompt: attempt.prompt } : {}) }
    }
    if (!record.configured) {
      return attempt?.phase === 'failed'
        ? { status: 'error', message: attempt.error ?? 'sign-in failed' }
        : { status: 'signed-out' }
    }
    const usage = await this.readUsage().catch(error => ({ error: String(error?.message ?? error) }))
    return { status: 'signed-in', usage }
  }

  /**
   * @param method - the seam flow method to run (`oauth`, from describe().methods)
   * @param loginMethod - pi-ai's login method the clicked button chose (`browser` | `device-code`)
   */
  async startSignIn(method = 'oauth', loginMethod = 'browser') {
    if (this.attempt?.phase === 'signing-in') return this.attemptView()
    const controller = new AbortController()
    this.attempt = { phase: 'signing-in', method, loginMethod }
    // The flow is the one dsh-llm-pi-ai registered; interaction is ours.
    this.running = this.ctx.authorization.begin({
      key: KEY, method, signal: controller.signal,
      interaction: {
        // The flow's neutral notices carry exactly what the page needs.
        notify: (notice) => this.publish({ ...notice }),
        prompt: (prompt) => this.prompt(prompt),
      },
    }).then((outcome) => {
      this.publish({ phase: outcome.status === 'authorized' ? 'signed-in' : 'cancelled' })
    }, (error) => {
      this.publish({ phase: 'failed', error: String(error?.message ?? error) })
    }).finally(() => { this.running = undefined })
    return this.attemptView()
  }

  cancel() { this.ctx.authorization.cancel(KEY) }
  async signOut() { this.ctx.authorization.cancel(KEY); await this.ctx.credentials.deleteRecord(KEY) }

  /** Notices update the polled state; a URL/code becomes visible within one poll tick. */
  publish(notice) {
    const current = this.attempt ?? { phase: 'signing-in' }
    this.attempt = { ...current, ...notice, phase: notice.phase ?? current.phase }
  }

  /** Selection prompt (login method) answers from the request; text fallback isolates here. */
  async prompt(prompt) {
    // AuthorizationPromptOption is { id, label, description? }; select answers with the option id.
    if (prompt.kind === 'select') {
      const wanted = this.attempt?.loginMethod === 'device-code' ? 'device_code' : 'browser'
      const option = prompt.options.find(o => o.id === wanted) ?? prompt.options[0]
      return option.id
    }
    // v1: a pasted-redirect-URL fallback is surfaced, not answered; the page shows
    // "port 1455 is busy — free it and retry" instead of a hidden dead end.
    this.publish({ prompt: { message: prompt.message } })
    throw new Error('authorization needs manual input')
  }
}
```

Notes:
- **`begin()` is fire-and-forget by design.** Precedent: installed `@deepseek-ai/dsh-deepseek-account-platform` calls `ctx.authorization.begin({... interaction: { notify: () => undefined, prompt: () => Promise.reject(...) } }).then(...)` and exposes progress through its own `AccountView.attempt` state that the UI polls (**SOURCE(α.3)** `packages/credentials/deepseek-account-platform/src/index.ts:414-455`; **LIVE** `llm-deepseek-account`/`accountController` rows). We do the same, except our `notify` *forwards* the notice (URL/code) into the polled state instead of dropping it.
- **One attempt per key** is enforced by the seam (`ALREADY_IN_FLIGHT`), so a second click is a no-op rather than two OAuth attempts.
- **Commit verification** is the seam's job: the pi-ai flow persists through its own credential-store adapter, `begin()` confirms a record write within the attempt and rejects with `NOT_COMMITTED` otherwise (`packages/credentials/authorization/src/index.ts:435-446`).
- **Credential refresh** stays on the pi-ai side (the `openai-codex` provider's `oauth.refresh`), so we must not copy or re-write the token; only `deleteRecord(KEY)` on Disconnect.
- **Usage fetch** (`usage`) reads `https://chatgpt.com/backend-api/wham/usage` server-side with the stored access token (PRIOR ART `dsh-codex/src/usage.ts:9`), caches for ~60 s, and returns only numbers — the token never crosses to the browser.

### 6.3 Client half — one file, two registrations

```js
// lib/client.js (plain JS, no build step)
window.__ModuleLoader__.load({
  id: '@acme/dsh-codex',
  factory: (require) => {
    var module = { exports: {} }, exports = module.exports
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const h = React.createElement

    const STATUS = '/plugins/dsh-codex/auth/status'
    const LOGIN  = '/plugins/dsh-codex/auth/login'
    const LOGOUT = '/plugins/dsh-codex/auth/logout'
    const USAGE_PAGE = 'https://chatgpt.com/settings/usage'

    async function request(path, method = 'GET', body) {
      const response = await fetch(path, {
        method,
        headers: { accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        credentials: 'same-origin',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const value = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`)
      return value
    }

    function CodexSettings({ t }) {
      const [state, setState] = React.useState({ status: 'loading' })
      const [busy, setBusy] = React.useState(false)
      const refresh = React.useCallback(() => {
        request(STATUS).then(setState, error => setState({ status: 'error', message: String(error.message ?? error) }))
      }, [])
      React.useEffect(refresh, [refresh])
      React.useEffect(() => {
        const every = state.status === 'signing-in' ? 1000 : state.status === 'signed-in' ? 60000 : 0
        if (every === 0) return
        const timer = setInterval(refresh, every)
        return () => clearInterval(timer)
      }, [refresh, state.status])

      const connect = async () => { setBusy(true); try { setState(await request(LOGIN, 'POST')); refresh() } finally { setBusy(false) } }
      const disconnect = async () => { setBusy(true); try { await request(LOGOUT, 'POST'); refresh() } finally { setBusy(false) } }

      const rows = [
        h('h2', { key: 'title', style: title }, t('title')),
        h('p', { key: 'plan', style: muted }, t('planUsing')),                 // "Using your ChatGPT plan"
        h('div', { key: 'status', style: row }, [
          h('span', { key: 's' }, label(state)),                                // Signed out / Waiting for browser… / Signed in
          h('div', { key: 'b' }, [
            state.status === 'signed-in'
              ? h('button', { key: 'out', onClick: disconnect, disabled: busy }, t('disconnect'))
              : h('button', { key: 'in', onClick: connect, disabled: busy }, t('connect')),
          ]),
        ]),
        state.url ? h('p', { key: 'url', style: row }, [
          h('a', { key: 'a', href: state.url, target: '_blank', rel: 'noopener noreferrer' }, t('openBrowser')),
        ]) : null,
        state.code ? h('p', { key: 'code' }, [t('codeHint'), ' ', h('code', { key: 'c' }, state.code)]) : null,
        state.status === 'signed-in' && state.usage
          ? h('p', { key: 'usage' }, [t('usage'), ': ', String(state.usage.weeklyPercent ?? '—'), '%'])
          : null,
        h('p', { key: 'manage' }, h('a', { href: USAGE_PAGE, target: '_blank', rel: 'noopener noreferrer' }, t('manageUsage'))),
        state.status === 'error' ? h('p', { key: 'err', role: 'alert', style: error }, state.message) : null,
      ]
      return h('div', { style: page }, rows)
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('settings.openai-codex', { en, zh }), 'codex: copy')
      const t = ctx.locale.bind('settings.openai-codex')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'openai-codex',
        order: 15,
        label: () => t('nav'),
        locale: 'settings.openai-codex',
      }, CodexSettings))
    }

    exports.name = 'dsh-codex-client'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  }
})
```

That is the **exact minimal registration**: one `settings.section` occupant, no children, no store, no hooks compartment (the poll is component-local state — allowed, since it is not a shared subscription), no cross-package imports.

### 6.4 Login end-to-end (browser login)

```
[User] Settings → "ChatGPT (Codex)" → Connect
   │
   ├─ POST /plugins/dsh-codex/auth/login   (same-origin, cookie, JSON)
   │     client → webServer route → CodexAccount.startSignIn()
   │        └─ ctx.authorization.begin({ key: llm-pi-ai/openai-codex, method: 'oauth', interaction })
   │             └─ pi-ai flow run(): PKCE S256 → authorize URL
   │                  └─ session.notify({ message, url }) ──→ our interaction.notify → attempt.publish({url})
   │                  └─ (device-code method: notify({ message, url, code }) → publish code)
   │             [begin() stays pending; one attempt per key]
   ├─ 200 { status: 'signing-in', method: 'oauth' }
   │
   ├─ page polls GET status every 1000 ms while signing-in
   │     └─ first tick: { status: 'signing-in', url: 'https://auth.openai.com/...' }
   │        → render as a real <a target="_blank" rel="noopener noreferrer"> link
   │          (NOT window.open: popup blockers, and the prior art does the same)
   │
   ├─ User approves in the browser
   │     pi-ai flow: loopback callback http://localhost:1455/auth/callback → exchange code
   │       (if 1455 is busy, the flow asks a text prompt for the pasted redirect URL —
   │        v1 surfaces the prompt and tells the user to free the port; v2 can add an answer route)
   │       → session.commit(record) → ctx.credentials writes llm-pi-ai/openai-codex
   │       → begin() returns { status: 'authorized' }
   │
   ├─ our .then(): attempt.phase = signed-in
   ├─ next poll: { status: 'signed-in', usage } → page switches to Disconnect + usage + Manage usage
   └─ credentials/record-updated is a forwarded Client event (LIVE): the composer model
      catalog and the Models page both refresh without reload, so the Codex models become
      usable immediately after sign-in.
```

Disconnect: `POST /logout` → `ctx.authorization.cancel(KEY)` + `ctx.credentials.deleteRecord(KEY)` → same forwarded event refreshes the catalog. Cancel: `POST /cancel` → `ctx.authorization.cancel(KEY)`; the page returns to signed-out.

Method choice: the pi-ai flow accepts `session.method === 'oauth' ? 'oauth' : 'api_key'`; the two *login methods* (browser vs device code) are chosen inside the flow through a `select` prompt answered by our `prompt()` handler. Our own `startSignIn(method)` maps the UI button (`browser` / `device-code`) into that select answer. If the team's SIWC research replaces the pi-ai flow, register our own flow on the same key — the UI, routes, polling, and notices are unchanged; only `run()` differs.

### 6.5 Provider registration (so the picker shows Codex models)

Two options, both UI-invariant:

- **A — reuse the shipped pi-ai route (least code):** in our bundle patch, override the `llm-pi-ai` row's config:
  ```yaml
  - id: llm-pi-ai
    config:
      providers:
        openai-codex: {}          # endpoint, protocol, catalog, OAuth + refresh come from pi-ai
  ```
  Then `openai-codex` shows "OpenAI Codex (legacy)" in the picker (route `displayName` can override), Models page shows a keyless row, and the flow we drive is exactly the one this plugin registered. Note: `/models` on that route depends on the team's wire research (the `openai-codex-responses` API in installed pi-ai may already implement it).
- **B — own adapter (team task dsh-contract):** `ctx.llm.registerAdapter(['openai-codex'], adapter)` returning the Codex model list, reading the same `llm-pi-ai/openai-codex` credential record and reusing pi-ai's refresh (or implementing it). More control, more code, and it must not double-write the record.

Either way §1 holds: the picker appears automatically; §6.2–6.4 hold unchanged.

### 6.6 "Using your ChatGPT plan" + Manage usage

- **Settings section (`settings.section`)** — the full account surface: a "Using your ChatGPT plan" line under the title, the connection status, Connect / Cancel / Disconnect, the current weekly usage, and a **Manage usage** link to `https://chatgpt.com/settings/usage` (`target="_blank" rel="noopener noreferrer"`).
- **Composer indicator (v2, optional)** — `conversation.input.right` (`list`, `session` scope) renders a compact chip *only when the session's current model belongs to the `openai-codex` provider* (read the injected `modelDirectories.directoryFor(sessionId).store`, as the prior-art quota chip does) with the remaining weekly percent and a "Using your ChatGPT plan" tooltip that also links to the usage page. Keep the action buttons in Settings; the composer chip is an indicator, not a control panel.
- **Models page** — optional; if the provider is also registered as a configurable provider, `settings.models.footer` is available for a "Sign in to ChatGPT" row. Not required: the picker path is adapter-driven, and the `nativeAuth` keyless rule already removes the misleading API-key field.

---

## 7. Risks and open items

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Seam assumption**: this recommendation relies on `llm-pi-ai`'s `openai-codex` flow being registered and servable in rc.5. | Assert at apply: `ctx.authorization.describe(credentialKey('llm-pi-ai','openai-codex'))` and log/throw if absent. If the SIWC research rejects the legacy flow, register our own flow on the same key — everything else in this document is unchanged. |
| 2 | **Peers are stale-ish**: prior art peers `^0.2.0-rc.1`, installed is `0.2.1-rc.5`. | Only documented host APIs are used (`llm`, `credentials`, `authorization`, `webServer`, `connection`, `locale`, `slots`). Re-verify `settings.section` + `conversation.input.right` with `Slots.listSubTree` once the client inspect provider answers. |
| 3 | **No server-wide auth**: an unguarded plugin route is reachable from any local page (CSRF) and by DNS rebinding. | Every route calls `ctx.connection.requestRejection({ headers: req.headers })` first; POSTs require `application/json`; `no-store`; never leak tokens; bind stays loopback in the desktop profile. |
| 4 | **Token handling**: a browser-login flow produces a long-lived grant. | Token never leaves the Host. Status returns derived usage only. Disconnect deletes the record; do not log notice/message payloads beyond redacted text. |
| 5 | **`begin()` is long-running**: up to 10–16 min in the prior art; a crashed page leaves an attempt pending. | The seam keeps one attempt per key; add a Host-side timeout (e.g. 10 min) + `cancel()` in the service disposer; status exposes `signing-in` so the page can offer Cancel. |
| 6 | **Paste-URL fallback prompt** when port 1455 is taken. | v1 surfaces the prompt and instructs the user to free the port; v2 adds `POST /answer` writing the pasted value into the prompt resolver. Do not silently reject (that turns a recoverable case into a dead end). |
| 7 | **Plain-JS bundle vs project tooling**: no TypeScript checking, no CSS Modules, no JSX. | Keep the bundle tiny and reviewed by hand; if the page grows, promote to tsdown with the prior-art layout. Bundle `id` must equal the package name; a mismatch yields no browser plugin and no visible error beyond console. |
| 8 | **Loader caches package metadata until restart**; negative verdicts never expire. | Treat install/rename as restart-required; document "restart the app, then hard-reload the page". |
| 9 | **Profile mismatch**: prior art is installed in profile `web`; our target is profile `desktop`. | Do not assume the prior art's rows/settings exist in `desktop`; the `dsh-codex` sources are evidence only. |
| 10 | **Default model**: `agent-default-model` patch forces `openai-codex` even before sign-in, which can leave a non-routable default (or a refusal from `saveSelection`). | Ship the patch only after the route exists; prefer letting the user select the model after signing in, or set the default from the plugin after the first successful sign-in. |
| 11 | **Client inspect provider timed out** in this session, so Slot props were taken from built bundles. | Re-run `Slots.listSubTree` (`root: 'settings.section'`) after the page reconnects; confirm registrant options (`id/order/label/locale/inject`) and the props share. |

---

## 8. Answer summary (for the Lead)

1. **Model-picker discovery path**: composer → `ctx.modelDirectories` → `remote.session.modelCatalog()` → Host `buildModelCatalog` over `llm.listProviders/listModels/resolveModelInfo`; selectable iff present in a non-empty group; refreshed by the forwarded `llm/adapters-updated`. A new adapter route with models appears automatically — **no UI work, no configurable-provider entry needed**.
2. **Generic authorization UI**: **none** in rc.5 (no client package; no `@Remote` on the `authorization` service). A client half is required. The *flow* for `llm-pi-ai/openai-codex` already exists in the installed build (pi-ai's ChatGPT OAuth, browser + device-code); only the trigger/status surface is missing.
3. **Exact slot + registration**: `settings.section` (`list`, `root`) with `{ name: 'settings.section', id: 'openai-codex', order: 15, label: () => t('nav'), locale: 'settings.openai-codex' }` and a component `({ t })`. Composer indicator later at `conversation.input.right` (`list`, `session`). Models-page holes exist (`settings.models.provider-card` keyed / `settings.models.footer` list) but are the wrong home.
4. **Remote-call mechanism**: **not** a Typert `@Remote` (needs generated strict-codec descriptors or hand-written ones; generator assumes the monorepo). Use `ctx.webServer.register({ kind: 'exact', path, handler })` + same-origin `fetch(path, { credentials: 'same-origin' })`, guarded by `ctx.connection.requestRejection({ headers })`. Client discovers endpoints by shared path constants.
5. **Login progress**: poll `GET …/auth/status` (1 s while `signing-in`, 60 s while `signed-in` for usage); the auth URL / device code are published from `authorization.begin`'s `notify` into the polled state and rendered as a link/code. SSE is possible (the route handler owns the response) but unnecessary.
6. **SIWC UX**: "Using your ChatGPT plan" + Manage usage (`https://chatgpt.com/settings/usage`) belong primarily on the Settings section; a compact plan/quota chip in the composer belongs at `conversation.input.right`, gated on the session's provider being `openai-codex`.

---

## 9. Verification checklist for the implementation phase

1. `cordis_inspect_query` client `Slots.listSubTree` with `root: 'settings.section'` → confirm the slot is live and the registration options match §3.1 (this session's client inspect timed out).
2. In the plugin's Host `apply`, log `ctx.authorization.list()` → confirm `{ key: 'llm-pi-ai/openai-codex', methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }] }` before wiring the Connect button.
3. `curl` the four routes with and without the `dsh-auth-*` cookie → expect 401/403 from `requestRejection` without it, JSON with it, and 403 for a cross-site `Origin`.
4. After install: Settings → ChatGPT (Codex) is visible; "Connect" yields a URL within ~1 s; completing the browser flow flips the row to signed-in; the composer picker lists the Codex models without a reload; "Disconnect" removes the credential record and the models disappear after the catalog refresh.
5. Confirm no token appears in the status response, page DOM, or Host logs.

---

## 10. Final recommendation — ONE approach (slot + registration + login, end to end)

**Ship a Host-side route/status service plus one plain-JS client half registered into `settings.section`. Drive the `ctx.authorization` flow that the installed `dsh-llm-pi-ai` already registers for `llm-pi-ai/openai-codex`. No Typert `@Remote`, no codegen, no build step, no Models-page patching, no adapter-specific UI.**

### 10.1 Exact artifacts

```jsonc
// package.json (excerpt) — one Loader row serves both halves
{
  "name": "@acme/dsh-codex",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale"] }
  }
}
```

```yaml
# cordis.patch.yml — insert the Host row; optionally pin the default model
- insert:
    - id: openai-codex-ui
      name: "@acme/dsh-codex"
# Only once the openai-codex route is registered by the same composition:
# - id: agent-default-model
#   config: { provider: openai-codex, model: <codex-model-id> }
```

```js
// lib/client.js — the exact minimal client registration (plain JS, loader-wrapped CJS)
window.__ModuleLoader__.load({
  id: '@acme/dsh-codex',                         // MUST equal the package name
  factory: (require) => {
    var module = { exports: {} }, exports = module.exports

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('settings.openai-codex', { en, zh }), 'codex: copy')
      const t = ctx.locale.bind('settings.openai-codex')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',                // LIVE: list slot, root scope, child of sidebar.settings
        id: 'openai-codex',                      // stable occupant id
        order: 15,                               // after models (10) / plugins (15), before agent-presets (20)
        label: () => t('nav'),                   // localized nav label
        locale: 'settings.openai-codex',          // binds the component's `t` seat
      }, CodexSettings))                          // React component; polls GET /plugins/dsh-codex/auth/status
    }

    exports.name = 'dsh-codex-client'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  }
})
```

```js
// lib/index.js — the exact minimal Host registration
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { CodexAccount } from './account.js'                 // §6.2 state holder + authorization.begin driver

const KEY = credentialKey('llm-pi-ai', 'openai-codex')       // flow registered by dsh-llm-pi-ai
const PATHS = {
  status: '/plugins/dsh-codex/auth/status',
  login:  '/plugins/dsh-codex/auth/login',
  cancel: '/plugins/dsh-codex/auth/cancel',
  logout: '/plugins/dsh-codex/auth/logout',
}

export const name = 'dsh-codex-ui'
export const inject = ['webServer']

export function apply(ctx) {
  const account = new CodexAccount(ctx)                      // §6.2: begin/cancel/status/usage
  ctx.effect(() => () => account.dispose(), 'codex: account lifetime')
  const json = (res, s, v) => { res.writeHead(s, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)) }
  const route = (path, handler) => ctx.webServer.register({
    kind: 'exact', path,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection({ headers: req.headers })   // 401/403/undefined
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
      try { await handler(req, res) } catch { json(res, 500, { error: 'internal' }) }
    },
  })
  ctx.effect(() => {
    const dispose = [
      route(PATHS.status, async (req, res) => json(res, 200, await account.status())),
      route(PATHS.login,  async (req, res) => json(res, 200, await account.startSignIn())),
      route(PATHS.cancel, async (req, res) => { account.cancel(); json(res, 200, { ok: true }) }),
      route(PATHS.logout, async (req, res) => { await account.signOut(); json(res, 200, { ok: true }) }),
    ]
    return () => { for (const d of dispose) d() }
  }, 'codex: web routes')
  // Provider registration is independent (option A: patch llm-pi-ai providers.openai-codex;
  // option B: ctx.llm.registerAdapter(['openai-codex'], adapter)) — the UI above is unchanged.
}
```

### 10.2 End-to-end login (browser login, exactly the requested path)

1. **Click** Settings → ChatGPT (Codex) → **Connect**. Client `POST /plugins/dsh-codex/auth/login` (`credentials: 'same-origin'`).
2. **Route** → `CodexAccount.startSignIn()` → `ctx.authorization.begin({ key: 'llm-pi-ai/openai-codex', method: 'oauth', interaction })`. `notify` publishes into the polled attempt state; `prompt` answers the flow's method `select` from the clicked button.
3. **Flow** (installed pi-ai) builds the PKCE authorize URL and calls `session.notify({ message, url })` → visible as `{ status: 'signing-in', url }` on the next 1 s poll → rendered as `<a target="_blank" rel="noopener noreferrer">` (device-code method publishes `{ url, code }` instead).
4. **User approves in the browser**; the flow receives `http://localhost:1455/auth/callback`, exchanges the code, and `session.commit(record)` writes the credential record for `llm-pi-ai/openai-codex`; `begin()` resolves `authorized`.
5. **Page** next poll → `{ status: 'signed-in', usage }`: shows signed-in state, weekly usage, **Manage usage** → `https://chatgpt.com/settings/usage`, and **Disconnect**.
6. **Model picker** needs nothing: `credentials/record-updated` is a forwarded Client event, so `ctx.modelDirectories` refreshes, `session/modelCatalog` re-reads `llm.listProviders/listModels`, and the Codex models become routable without a reload.
7. **Disconnect** → `ctx.authorization.cancel(KEY)` + `ctx.credentials.deleteRecord(KEY)` → same refresh path removes the models.

### 10.3 Why this is minimal and stable

- The only new browser surface is one `settings.section` occupant (one list-slot registration, no children, no store, no hooks compartment, no cross-package value imports).
- The only new Host surface is four JSON routes on the first-party webserver plus a small state-holder service; the OAuth protocol, credential format, and token refresh stay owned by the installed `dsh-llm-pi-ai`/pi-ai, and the authorization seam owns attempt locking and commit confirmation.
- Everything version-sensitive (`settings.section`, `conversation.input.right`, `connection.requestRejection`, `authorization.begin`, forwarded `credentials/record-updated`) was confirmed present in the installed rc.5 build; nothing depends on generated Typert artifacts or on patching a shipped package.
