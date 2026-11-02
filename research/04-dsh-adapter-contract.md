# 04 — DSH host contract for the `chatgpt-plan` plugin (LlmAdapter + AuthorizationFlow + bundle)

**Owner:** dsh-contract (task-4). **Target:** installed desktop **v0.2.1-rc.5**, profile `/Users/jeff/.dsh/profiles/desktop`.
**Read-only research:** nothing installed, no profile/settings written. The only file written is this one.

This document is the implementation checklist for our plain-JS ESM Host plugin: an `LlmAdapter`
route `chatgpt-plan`, our own SIWC `AuthorizationFlow`, its credential storage through
`ctx.credentials`, and the optional Client half. It also reviews the code that already exists in
`bundle/lib/` (`siwc.js`, `oauth.js`, `store.js`, `responses.js`, `models.js`, `adapter.js`) and lists
the concrete contract violations to fix before bundling.

## Evidence labels

| Label | Meaning |
|---|---|
| **LIVE** | Read from the running rc.5 host through `cordis_inspect_query` (Host `Service`), or extracted verbatim from the installed build inside `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` (that asar was parsed with a byte-offset reader; `lib/index.js` / `lib/client.js` / package manifests were read directly — this is the code the running app executes). |
| **SOURCE(α.3)** | `/Users/jeff/Documents/DEV/deepseek-harness` (v0.2.1-alpha.3). Type/algorithm evidence, re-verified against the installed build wherever the difference matters. |
| **PRIOR ART** | Published third-party plugin `dsh-codex@0.3.2` at `/Users/jeff/.dsh/profiles/web/node_modules/dsh-codex` (peers `^0.2.0-rc.1`). Working reference, **not** a DSH API contract. |
| **LOCAL** | Our in-progress modules `/Users/jeff/Documents/DEV/dsh-codex-plugin/bundle/lib/*.js`. |

Environment limitation: Client inspect providers (`Slots`, `Builtin`, `Theme`) timed out for the whole
session ("Open or reconnect the Harness page"). Client slot facts below come from the installed
`dsh-client-ui-*/lib/client.js` bundles (the artifacts the page loads), not from live Slot inspection.

---

## 0. Headline decisions (read this first)

1. **Route name must be `chatgpt-plan` (or any name that is not `openai-codex`).** The desktop
   profile already configures `llm-pi-ai` with `providers: { openai-codex: {} }`
   (`/Users/jeff/.dsh/profiles/desktop/cordis.patch.yml`), so another adapter registering
   `openai-codex` fails `registerAdapter` with `DUPLICATE_ADAPTER`
   (**SOURCE(α.3)** `packages/llm/llm/src/index.ts:401-459`). Keep the SIWC plugin on its own route.
2. **Duck-typing the adapter is fine — but only if it implements the whole structural surface.**
   The registry/runtime never checks `instanceof LlmAdapter`; it calls methods directly. A duck class
   **must** implement `providerInfo`, `providerRetryPolicy`, `listModels`, `resolveModel`,
   `prepareCall`, `stream` and should implement `imageRequestPricing` / `imageRequestTarget`.
   The current `bundle/lib/adapter.js` is missing `providerRetryPolicy` and `prepareCall` (fatal:
   registration throws and the agent loop's `prepareCall` throws) and both image methods (token-meter
   calls one per measurement). §4 gives the exact patch.
3. **A linked dev install needs `peerDependencies` for every Harness package the Host half imports.**
   The rc.5 resolver answers a linked importer's bare Harness import **only** for names that the
   importer's package.json declares as peers (installed resolver `readPeerNames` /
   `routeLinked`; **SOURCE(α.3)** `.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.md`
   §3 and Table 3). Dependencies do **not** enable interception — a `dependencies` entry would install a
   second copy and break class identity/singletons. A zero-import Host half needs no peers at all.
4. **The Host half can be zero-import ESM.** Our current modules import only `node:*` built-ins. That
   is the cheapest path: no peers, no duplicate modules, no build step. Add `@deepseek-ai/schemastery`
   (+ peer) only if we want `export const Config`; everything else is structural `ctx` access.
5. **Stream protocol:** emit `block-start` before deltas, deltas by index, one authoritative
   `block-end` per block, `usage` before the single terminal `finish`, nothing after `finish`
   (**SOURCE(α.3)** `packages/llm/llm/src/types.ts:462-482`, `assembler.ts:38-208`). In-band
   `finish` failures bypass runtime normalization, so their `failure.code` must be canonical
   (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, `AUTH`, `MISSING_CREDENTIAL`, …)
   or `llm-retry` will not retry (**SOURCE(α.3)** `retry-policy.ts:14-24`).
6. **Credentials:** `ctx.credentials.modifyRecord(key, mutate)` is the only write path; a refresh is
   read-decide-replace **under the store lock** and must happen inside `mutate` (the current
   `store.js` refreshes outside the lock and only single-flights in-process). Records live at
   `<scope>/<id>` with `^[a-z][a-z0-9-]*$` segments (**SOURCE(α.3)** `packages/credentials/credentials/src/index.ts:19-92`).
   Our key `chatgpt-plan/credential` is valid; keep one definition.
7. **AuthorizationFlow owns the browser conversation; nothing in rc.5 starts it for us.** There is no
   generic OAuth UI and `ctx.authorization` has no `@Remote` methods (**LIVE**). Our own same-origin
   HTTP routes must call `ctx.authorization.begin()` and implement the interaction; the flow's
   `run(session)` does SIWC and calls `session.commit({kind:'grant', payload})` **during** the attempt
   (the seam verifies the write, **SOURCE(α.3)** `packages/credentials/authorization/src/index.ts:361-447`).
8. **Client half is optional but needed for Settings UX.** `settings.section` is a stable list slot in
   rc.5; the client artifact is a hand-written classic script in the
   `window.__ModuleLoader__.load({id, factory})` format, `id` = package name; no build step
   (**LIVE** installed `dsh-client-ui-settings-general/lib/client.js`; `templates/decoration/client.js`).
   Host↔Client data travels over our own `ctx.webServer.register` routes guarded by
   `ctx.connection.requestRejection({headers})` (**LIVE** `webServer`/`connection` contracts).
9. **Retry policy:** `providerRetryPolicy()` may return `undefined` → normal defaults:
   `maxRetries: 5`, codes `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT`,
   backoff `500ms…10s`, jitter `0.1` (**LIVE** rc.5 `dsh-llm` build; **SOURCE(α.3)** `retry-policy.ts:14-24`).
   It is captured at registration; change it only by re-registering. `llm-retry` is mounted in base
   (**SOURCE(α.3)** `packages/bundle/base/cordis.patch.yml:99-100`), so codes matter.
10. **Don't make `chatgpt-plan` the profile default model in the bundle patch.** The route is
    registered at mount and always advertises a fallback catalog, so it is selectable; but forcing
    `agent-default-model` from a bundle that can be disabled leaves a broken default. Let the user
    select it (or set it in the user patch once signed in).

---

## 1. Runtime, package resolution, and what "imports" mean for our bundle

### 1.1 Runtime facts (**LIVE**)

- Installed app: `/Applications/DeepSeek Harness.app`, runtime package
  `@deepseek-ai/dsh-desktop-runtime` version **0.2.1-rc.5** (asar `dsh/package.json`).
- Profile: `/Users/jeff/.dsh/profiles/desktop` (`package.json` bundles base + web-app +
  experimental-auto-review + subagent-codex + agent-team-profile; `cordis.patch.yml` user layer).
- The shared runtime layer is `/Users/jeff/.dsh/profiles/node_modules` (244 `@deepseek-ai/*`
  entries); `apps.asar` holds the same packages under `dsh/node_modules`.
- Base composition already mounts `llm`, `llm-retry`, `authorization`, `credentials`
  (`dsh-credentials-local`), `webServer`, `connection`, `token-meter`, `spill-policy`
  (**SOURCE(α.3)** `packages/bundle/base/cordis.patch.yml:99-127,348-349,414-415`; **LIVE** Service
  catalog lists all of them).

### 1.2 How a profile-installed bundle's imports resolve

The launcher installs one **immutable runtime resolution** into Node's ESM/CJS resolvers before any
profile row mounts (**SOURCE(α.3)** `packages/boot/app-boot/README.md` "One runtime resolution";
`.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.md`).

Two installation shapes behave differently:

| Shape | Where the package lives | Bare `@deepseek-ai/dsh-*` import from our code |
|---|---|---|
| **Copied into the profile** (registry tarball, `file:` tarball) | `<profile>/node_modules/<pkg>` (layer ②) | Resolves at the interception layer ③ `$DSH_HOME/profiles/node_modules`; Node reaches it by ordinary ancestor lookup |
| **Linked directory** (`pnpm add /abs/path` → `link:`, i.e. `plugin_manager install_bundle` with our checkout) | symlink to `/Users/jeff/Documents/DEV/dsh-codex-plugin` (a "linked root") | **Only** names declared in our package.json `peerDependencies` and present in the runtime table are answered; otherwise Node looks in the checkout's real ancestors and fails |

Installed rc.5 resolver evidence (asar `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`):
`findInterceptionLayer()` returns `{kind:'linked'}` for a path inside a recorded linked root, and
`routeLinked()` does, for each ancestor `node_modules` position `D/node_modules`:
`if (ancestorSet.has(searchPath) && readPeerNames(dirname(searchPath)).has(name)) → interception`.
`readPeerNames()` reads `D/package.json.peerDependencies`; `dependencies`/`devDependencies` do not
participate.

Consequences for us:

- Our project directory is linked → declare peers for every Harness package the **Host** half really
  imports; or keep the Host half zero-import (recommended, and true today).
- `@deepseek-ai/schemastery` is also in the runtime table (`dsh-desktop-runtime` dependency), so a
  peer declaration resolves it the same way.
- `node:` built-ins and relative imports are unaffected.
- Import **specifiers and extensions**: in installed packages everything is built ESM `lib/*.js`;
  our source is already `bundle/lib/*.js` with explicit `.js` relative specifiers — that is exactly
  what a Node ESM `"type": "module"` package loads. Do **not** write `.ts` specifiers; there is no
  transpile step at runtime for profile bundles.
- Compatibility preflight: rc.5 prefers an own `engines.dsh` range and ignores peers when present;
  otherwise every `@deepseek-ai/dsh*` peer must satisfy `0.2.1-rc.5` (`includePrerelease: true`)
  (**LIVE** installed app-boot `unmetRequirements`; **SOURCE(α.3)** `packages/boot/app-boot/src/plugin-compatibility.ts:84-125`).
  A failing bundle is skipped (`skippedBundles`) or a row is denied; declare `engines.dsh` to be
  explicit and keep peers only for resolution.

### 1.3 Imports that are safe at runtime

- Host: `node:crypto`, `node:http`, `node:child_process`, `node:fs/promises`, `node:path`,
  `node:url`, `node:os`, and global `fetch`/`AbortController`/`TextDecoder` (Node 22+).
- Host, if peers declared: `@deepseek-ai/dsh-llm` (verified rc.5 export list includes `LlmAdapter`,
  `LlmError`, `HarnessError`, `attributionHeaders`, `resolveRetryPolicy`, `RetryPolicySchema`),
  `@deepseek-ai/dsh-credentials` (`credentialKey`, `isCredentialKeySegment`, `parseCredentialKey`,
  `credentialKeyScope` — verified exports), `@deepseek-ai/schemastery`.
- Client half: **only** the browser module table — `require('react')`, `require('react-dom')`,
  `require('react/jsx-runtime')` (baseline). No `@deepseek-ai/*` client package may be required
  directly (prior art's client bundle requires exactly those three; **PRIOR ART** `lib/client.js`).

---

## 2. Bundle scaffolding

### 2.1 Manifest, host-only (no Client half)

```json
{
  "name": "dsh-chatgpt-plan",
  "version": "0.1.0",
  "private": true,
  "description": "ChatGPT plan-usage model route for DeepSeek Harness (SIWC OAuth).",
  "type": "module",
  "exports": {
    ".": "./bundle/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["bundle", "cordis.patch.yml"],
  "engines": { "dsh": ">=0.2.1-rc.5" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `dsh.bundle.patch` may be one path or an ordered array of paths
  (**SOURCE(α.3)** `packages/boot/app-boot/README.md` "Profiles").
- `exports` must expose the package root; the Loader row `name` imports it.
- `engines.dsh` is checked alone when present; `peerDependencies` are only needed for linked
  resolution of imported Harness packages.
- `files` only matters for packed installs; a linked directory ignores it (skill reference
  `references/host-plugin.md`).

### 2.2 Manifest, host + Client half

```json
{
  "name": "dsh-chatgpt-plan",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "bundle/index.js",
  "exports": {
    ".": "./bundle/index.js",
    "./client": "./bundle/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["bundle", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "engines": { "dsh": ">=0.2.1-rc.5" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-settings-general"],
      "immediately": true
    }
  }
}
```

- `dsh.client.platform` is required; `inject`/`external`/`immediately` are optional and validated by
  `parseDshClient` (**LIVE** installed `dsh-client-modules`; **SOURCE(α.3)**
  `packages/client/modules/src/client/manifest.ts:150-190`).
- A package declaring `dsh.client` **must** export `./client`, or composition fails loudly
  (**SOURCE(α.3)** `packages/client/modules/src/index.ts:847`).
- The client **id must equal the package name**; the graph row is keyed by package name.
- Display metadata (locale `meta.title`/`meta.description`, icon) is read without activating the
  plugin; complete it before install (skill `references/host-plugin.md` §Display metadata).

### 2.3 `cordis.patch.yml` (bundle patch)

```yaml
# Our one Host row. The bundle patch may also override existing rows by id, but must not
# rewrite another bundle's row unless it must (a matching override replaces the whole config).
- insert:
    - id: chatgpt-plan
      name: dsh-chatgpt-plan
      config: {}
```

- No second row: the bundle package installs once; the same row serves the adapter/flow/routes and
  (via `dsh.client`) the browser half.
- Do **not** add a second row that also registers the flow (would throw `DUPLICATE_FLOW`).
- Do **not** patch `agent-default-model` here (see §0.10). A user can set it in the profile patch
  after sign-in:
  `- id: agent-default-model { provider: chatgpt-plan, model: gpt-6-sol }`.
- Do **not** repurpose `llm-pi-ai`'s `openai-codex` route; if the team wants only one ChatGPT route,
  remove that provider config from the user patch as a separate decision.

### 2.4 Install / enable / restart (**LIVE** skill + app-boot behavior)

- Install with `plugin_manager` `install_bundle` targeting the absolute package directory; it runs
  `pnpm add <link>` and selects the bundle. Do not hand-edit the profile.
- A new bundle can activate through HMR; replacing an installed package or changing linked JS
  requires **restart** (module roots are opt-in; profile HMR `root: []`).
- The client artifact is served by `dsh-client-modules` after the Host row exists; a page hard-reload
  (and usually an app restart for a new package/renamed path) is required.

---

## 3. Plugin entry: `apply(ctx, config)` contract

### 3.1 Exports the Loader expects

A function plugin named-exports `name`, `inject`, `Config`, `apply`; mixing with a default export
makes the Loader discard the namespace (**SOURCE(α.3)** `packages/AGENTS.md`). Plain JS:

```js
// bundle/index.js
export const name = 'chatgpt-plan'          // diagnostics + credential-scope convention
export const inject = ['llm']               // hard dependency; ctx.llm is available
// export const Config = ...                // optional, Schemastery (§11)

export function apply(ctx, config) { /* registrations only, all through ctx.effect/ctx.inject */ }
```

### 3.2 Registration rules

- Everything registered in `apply` is an **effect of the plugin fiber**: `ctx.llm.registerAdapter`
  and `ctx.authorization.registerFlow` internally use `ctx.effect` and dispose with the fiber
  (**SOURCE(α.3)** `llm/src/index.ts:401-459`, `authorization/src/index.ts:209-225`).
- Optional services must be reached with `ctx.inject([...], child => …)` (so the feature exists only
  where the service is mounted) and optional **reads** with `ctx.get(name)`; `ctx.<name>` property
  access is topology-sensitive (repo postmortem; pi-ai uses `ctx.get('credentials')`).
- Use `ctx.inject(['authorization'], …)` for the flow, `ctx.inject(['webServer', 'connection'], …)`
  for the HTTP surface, `ctx.inject(['attachments'], …)` is not needed (read via `ctx.get`).
- Give every `ctx.effect` a label and return its disposer array for composite registrations.

### 3.3 Skeleton (validated against the live service contracts)

```js
// bundle/index.js
import { ChatGptPlanAdapter } from './lib/adapter.js'
import { registerPlanFlow } from './lib/oauth.js'
import { registerPlanRoutes } from './lib/http.js'
import { FLOW_KEY, readCredential } from './lib/store.js'

export const name = 'chatgpt-plan'
export const inject = ['llm']

const DEFAULT_PROVIDER = 'chatgpt-plan'
const DEFAULT_DISPLAY_NAME = 'ChatGPT (plan)'

export function apply(ctx, config = {}) {
  const provider = typeof config.provider === 'string' && config.provider.length > 0
    ? config.provider
    : DEFAULT_PROVIDER
  const displayName = typeof config.displayName === 'string' && config.displayName.length > 0
    ? config.displayName
    : DEFAULT_DISPLAY_NAME

  // Fail loud and early if another plugin owns this route name (DUPLICATE_ADAPTER is thrown
  // by registerAdapter itself, but the error names the route only after a stack trace).
  if (ctx.llm.listProviders().some(row => row.id === provider)) {
    ctx.logger.warn(`chatgpt-plan: provider route "${provider}" already has an adapter; not registering`)
    return
  }

  const adapter = new ChatGptPlanAdapter(ctx, { provider, displayName })
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter), 'chatgpt-plan: adapter')

  // Optional seams: the plugin stays useful in a composition that mounts neither.
  ctx.inject(['authorization'], authorized => {
    ctx.effect(
      () => authorized.authorization.registerFlow({
        key: FLOW_KEY,                       // 'chatgpt-plan/credential'
        label: 'ChatGPT plan',
        methods: [{ id: 'browser', label: 'Sign in with ChatGPT' }],
        async run(session) {
          const { runLoginFlow } = await import('./lib/oauth.js')
          await runLoginFlow(ctx, session)   // session.commit({kind:'grant',payload})
        },
      }),
      'chatgpt-plan: authorization flow',
    )
  })

  ctx.inject(['webServer', 'connection'], infra => {
    registerPlanRoutes(infra, ctx, { provider, isSignedIn: () => readCredential(ctx) })
  })

  // Optional human command trigger for headless/CLI use (service may be absent).
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'chatgpt-plan-login',
      description: 'Sign in with ChatGPT for the chatgpt-plan model route',
      async handler(invocation) {
        const authorization = ctx.get('authorization')
        if (authorization === undefined) return { kind: 'error', text: 'authorization service is not mounted' }
        void authorization.begin({
          key: FLOW_KEY,
          interaction: {
            notify: notice => ctx.logger.info(`chatgpt-plan: ${notice.message}${notice.url ? ` ${notice.url}` : ''}`),
            prompt: prompt => Promise.reject(new Error(`chatgpt-plan: unexpected authorization prompt: ${prompt.message}`)),
          },
          signal: invocation.signal,
        })
        return { kind: 'success', text: 'A browser window will open to finish the ChatGPT sign-in.' }
      },
    }), 'chatgpt-plan: login command')
  }
}
```

Notes:

- `ctx.llm.listProviders()` is the reliable route-collision pre-check; `registerAdapter` throws
  `LlmError` `DUPLICATE_ADAPTER` (all-or-nothing) otherwise.
- The `.js`-static `import` at top is fine; the dynamic `import('./lib/oauth.js')` in the example is
  unnecessary — use a static import (kept explicit here only to show the flow module boundary).
- If the flow is registered but never started, nothing is written; the adapter still works with a
  credential that a previous session/process stored.

---

## 4. `LlmAdapter` for route `chatgpt-plan`

### 4.1 Subclass or duck-type?

The live `LlmAdapter` is a class with defaults (**LIVE** contract; **SOURCE(α.3)**
`packages/llm/llm/src/index.ts:208-303`):

| Method | Default? | Called by |
|---|---|---|
| `providerInfo(provider)` | default `{id: provider, name: provider}` | `registerAdapter` validates **id === provider** and non-empty name (`index.ts:445-448`) |
| `providerRetryPolicy(provider)` | default `undefined` → normal defaults | called **unconditionally** at registration (`index.ts:450-456`) |
| `imageRequestPricing(provider, model)` | default `undefined` | `llm.imageRequestPricing` (`index.ts:681-683`), called by token-meter per measurement and spill-policy |
| `imageRequestTarget(provider, model, image)` | default preserves normalized dims | `llm.imageRequestTarget` (`index.ts:692-694`), called by computer-use |
| `listModels(provider)` | default `[]` | `llm.listModels` validates each row (`index.ts:718-745`) |
| `resolveModel(provider, model, signal)` | default `{provider,id,name}` | `resolveModelInfo`/`resolveCallConfig`/`prepareCall`; validated (`index.ts:756-882`) |
| `prepareCall(provider, model, signal)` | default wraps `resolveModel` + `stream` | `LlmRuntime.prepareCall` (`index.ts:956-1014`) and `adapterStream` (`index.ts:1064-1153`) |
| `stream(options)` | **abstract** | the agent loop |

**The registry never checks `instanceof LlmAdapter`** — it calls the methods. So duck-typing works,
but a duck class must supply everything in the table (except that image methods may be omitted only if
no mounted consumer calls them; both `token-meter` and `spill-policy` are mounted in base, so implement
them). There is no inheritance-based auto-fill for a duck object: a missing `prepareCall` is a
`TypeError` at `LlmRuntime.prepareCall`, which the agent loop treats as fatal (it only tolerates
`LlmError` `NO_ADAPTER`, **SOURCE(α.3)** `packages/core/agent-loop/src/agent.ts:600-616`), and a
missing `providerRetryPolicy` is a `TypeError` during `registerAdapter`.

**Recommendation:** keep the current zero-import duck class (it already keeps the Host half free of
peer declarations) and add the missing members below. Subclass `LlmAdapter` only if we accept
`@deepseek-ai/dsh-llm` as a peer for the linked install; the subclass skeleton is given for
completeness in §4.6.

### 4.2 Required duck-type surface (patch for `bundle/lib/adapter.js`)

```js
export class ChatGptPlanAdapter {
  constructor(ctx, route) { this.ctx = ctx; this.route = route }

  // 1) registration metadata: id MUST equal the route; name non-empty.
  providerInfo(provider) { return { id: provider, name: this.route.displayName } }

  // 2) retry policy captured at registration. undefined => normal defaults
  //    (maxRetries 5, retryableCodes EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT,
  //     backoff 500..10000ms, jitter 0.1 — retry-policy.ts:14-24).
  providerRetryPolicy(_provider) { return undefined }

  // 3) image request pricing: return undefined (route declares none). MUST exist:
  //    token-meter calls llm.imageRequestPricing per measurement.
  imageRequestPricing(_provider, _model) { return undefined }

  // 4) image projection target: preserve normalized dimensions (the visible default).
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  // 5) catalog rows: provider must equal the route, ids unique, names non-empty.
  async listModels(provider) { /* ... as today ... */ }

  // 6) exact model metadata: provider/id MUST echo the request; context positive int;
  //    reasoning.efforts non-empty, ids unique, defaultEffort ∈ efforts.
  resolveModel(provider, model) { /* ... as today ... */ }

  // 7) bind model metadata and dispatch generation for one call (REQUIRED here).
  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: options => this.stream(options),
    }
  }

  // 8) abstract: the only truly required stream entry.
  async *stream(options) { /* ... as today ... */ }
}
```

`prepareCall` may also be used to snapshot volatile config (prior art overrides it to bind a pi-ai
collection); our route reads config once at `apply`, so the simple wrapper is enough.

### 4.3 `listModels` / catalog rules

- Validation is strict and throws `LlmError` `INVALID_CATALOG` on: `provider !== requested provider`,
  empty id, duplicate id, non-string/empty name (`index.ts:718-745`).
- A throwing `listModels` removes the route from the composer catalog and records a per-provider
  failure; it is **not** fatal. Still, keep it non-throwing (current implementation catches catalog
  read failures and falls back — good). Never throw `MISSING_CREDENTIAL` from `listModels`: the
  fallback catalog is what lets the user see the route and sign in.
- The composer picker and submission gate use only `listProviders()` + `listModels()` +
  `resolveModelInfo()` (**SOURCE(α.3)** `packages/api/session-controller/src/catalog.ts:20-62,78-92`;
  **PRIOR ART** verified the same in rc.5 client bundle). `registerConfigurableProviders` is **not**
  needed for selectability; it only adds a row to the *Models settings* page, which is a different
  directory (`joinProviderDirectory` in `packages/client/ui-settings-models/src/client/store.ts:45-77`).
  Our settings UX lives in our own `settings.section`, so skip the directory (also avoids having to
  invent a settings namespace/config schema).
- `registerModelDiscovery` is also unnecessary for us (it serves Models-page "fetch models" for
  configurable providers).

### 4.4 `resolveModel` metadata for this route

- `context: { contextWindow }` — positive safe integer (`INVALID_MODEL_CONTEXT` otherwise).
- `inputModalities: ['text', 'image']` — declaring `image` keeps image blocks in `messages` and lets
  the adapter upload them (our `resolveImages`); declaring only `text` would make the runtime replace
  images with placeholder text (`llm/src/index.ts:1101-1105`).
- `reasoning: { efforts: [{id,name}, …], defaultEffort }` — ids are branded strings at runtime;
  the validator requires non-empty unique ids/names and a `defaultEffort` among them
  (`index.ts:839-881`). Current `models.js` satisfies this for every known and unknown slug.
- **Do not set `defaultMaxTokens`.** `resolveCallConfig` would materialize `maxTokens` into the
  request config, but the plan-usage route rejects `max_output_tokens`
  (**LOCAL** `responses.js:15-19`). Omitting it keeps the runtime from advertising a cap it never sends.
- Leave `systemPromptUpdate` and `toolUpdate` absent: the runtime then collapses system prompt to the
  leading system message and strips `deferredLoading`/developer tool-update messages before dispatch
  (`llm/src/index.ts:1096-1117`; `content.ts:424-491`). Our request converter already moves the leading
  system message into `instructions`.

### 4.5 `stream` obligations (beyond §6)

- Signature `stream(options): AsyncIterable<StreamChunk>`; `async *stream` is fine — the body must not
  do I/O before the first `next()`, because the runtime constructs the iterable then immediately
  iterates. Current code satisfies this (all awaits inside the generator).
- Honor `options.signal` (combine with any internal timeout via `AbortSignal.any`).
- Never mutate `options`, `options.messages`, `options.tools` — loop-built requests are deep-frozen
  and mutation throws (`llm/src/index.ts:57-78` `llm/stream` JSDoc).
- Read credentials per call (`ensureAccessToken`) — never cache tokens across calls; the credential
  seam's per-operation read is what makes a changed/rotated token reach the next request.
- On a 401 from the route: force one refresh and retry once (current behavior is right); if the retry
  still fails, emit a terminal `finish` with `AUTH` (or throw `LlmError`; §7).
- Put a bounded idle/timeout on the HTTP request (e.g. `AbortSignal.timeout(300_000)`); map the
  timeout to `TIMEOUT` so `llm-retry` handles it.

### 4.6 Subclass skeleton (only if we take the peer)

```js
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

export class ChatGptPlanAdapter extends LlmAdapter {
  constructor(ctx, route) { super(); this.ctx = ctx; this.route = route }
  providerInfo(provider) { return { id: provider, name: this.route.displayName } }
  providerRetryPolicy(_provider) {
    return resolveRetryPolicy(this.route.retryPolicy, 'chatgpt-plan.retryPolicy')
  }
  imageRequestPricing() { return undefined }
  imageRequestTarget(_p, _m, image) { return { width: image.width, height: image.height, maxBytes: image.bytes } }
  listModels(provider) { /* ... */ }
  resolveModel(provider, model, _signal) { /* ... */ }
  prepareCall(provider, model, signal) {
    return Promise.resolve(this.resolveModel(provider, model, signal)).then(model => ({
      model, stream: options => this.stream(options),
    }))
  }
  stream(options) { /* ... */ }
}
```

---

## 5. `GenerateOptions` at runtime — what the adapter actually receives

**SOURCE(α.3)** `packages/llm/llm/src/types.ts:528-571`; **LIVE** contract mirrors it.

| Field | Runtime value |
|---|---|
| `provider` / `model` | the registered route and the exact model id the user selected (core routing does not require catalog membership) |
| `messages` | `Message[]` (`role` ∈ `system` \| `developer` \| `user` \| `assistant` \| `tool`) plus identity-free `RequestUserInput` `{role:'user', content}` for hand-built calls. Each message has `id`, `content: readonly ContentBlock[]`, and `source` (`{kind:'user'}` / `{kind:'model',provider,model,replayState?}` / `{kind:'tool',callId}` / `{kind:'system-prompt'}`); tool results also carry `toolCallId` and optional `isError`. |
| content blocks | `text`, `reasoning`, `image`, `file`, `tool-call`, and in developer messages `tool-addition` / `tool-removal` (`types.ts:61-150`). **Files never reach the adapter structured**: the runtime projects them to deterministic handle text (`llm/src/index.ts:1096-1100`). |
| `system` | only for hand-built one-shot callers; loop-built requests put the prompt in a leading `system` message and leave this undefined (`types.ts:535-546`). Our converter must support **both** (§4.4 patch note for `responses.js`). |
| `tools` | final `ToolSchema[]` `{name, description, parameters}` after route projection (`types.ts:491-502`). `deferLoading` is stripped for routes without `toolUpdate`. |
| `toolHistory` | session-folded declarations/updates; it is only an input to the runtime's projection — the adapter can ignore it. |
| `temperature` / `maxTokens` / `stop` | caller knobs; this route rejects `temperature`/`max_output_tokens` (LOCAL `UNSUPPORTED_PARAMS`), so ignore or throw `UNSUPPORTED_OPTION` like pi-ai does for `stop`. |
| `signal` | `AbortSignal`; must be honored. |
| `sessionId` | `SessionId` branded string, set by the loop. Available for transport metadata/headers (§8 of task). The plan route rejects `prompt_cache_key`, so do not send it; a header such as `session_id` is a wire-team decision. |
| `purpose` | `'compaction' \| 'session-title'` for auxiliary calls; ordinary turns omit it. Compaction calls must still work (they will include the compaction prompt as user/leading-system content). |

**Deep-frozen**: requests built by the agent loop are deep-frozen; read only. Projection ordering
inside `LlmRuntime.adapterStream`:
1. materialize adapter-configured defaults into `resolvedOptions`
   (`maxTokens`, `reasoningEffort`; `index.ts:1074-1095`),
2. project files to text (`index.ts:1096-1100`),
3. project images to placeholder text when the model declares no `image` modality (`index.ts:1101-1105`),
4. project tool updates per `toolUpdate` and drop developer messages when absent (`index.ts:1106-1117`),
5. strip unusable `replayState` for another adapter instance (`index.ts:1022-1037`).

---

## 6. `StreamChunk` protocol and what the assembler requires

**SOURCE(α.3)** `packages/llm/llm/src/types.ts:462-482`, `assembler.ts:38-208`; **LIVE** contract identical.

### 6.1 Rules

1. Chunk types: `block-start{index,blockType}`, `text-delta{index,text}`,
   `reasoning-delta{index,text}`, `tool-call-delta{index,id,name?,argumentsDelta}`,
   `block-end{index,block}`, `usage{usage}`, `finish{reason,replayState?}`.
2. `index` correlates interleaved blocks; allocate in **first-seen order** and reuse it for every
   delta/end of that block. The assembler's `order` array is the first `block-start`/first delta order,
   so indexes need not be contiguous but must be unique per block.
3. `block-end` carries the **authoritative** `ContentBlock`; the assembler uses it verbatim
   (`assembler.ts:77-84`). Emitting only deltas is tolerated (assembler synthesizes text/reasoning and
   a tool call with generated id `call-<index>` if no `block-end` arrived), but a `tool-call` without
   `block-end` loses `name` if no delta carried it. Always send `block-end` with the final block.
4. Tool calls: the first `tool-call-delta` for an index must carry `id`; `name` is optional in the type
   but required by the assembler to produce a usable call (`assembler.ts:69-76,108-121`). Our
   `responses.js` sends both on the opening delta — keep that.
5. `usage` must arrive **before** the terminal `finish`; nothing may follow `finish`. `TokenUsage`
   counts are **disjoint**: `inputTokens` = uncached input only; `cacheReadTokens`/`cacheWriteTokens`
   separate; optional `totalTokens`; optional `reasoningTokens` (`types.ts:167-189`). Current
   `responses.js` `usageChunk` puts raw `input_tokens` (which includes cached) into `inputTokens` —
   fix: `inputTokens = max(0, input_tokens - cached_tokens)`.
6. Exactly one `finish`. `FinishReason` kinds: `stop`, `tool-calls`, `max-tokens`,
   `aborted{failure}`, `error{failure}` (`types.ts:156-165`). The assembler defaults to `stop` when a
   stream ends without one, so a missing `finish` is silently accepted — don't rely on it.
7. `replayState?: ReplayEnvelope` (`types.ts:448-460`): `{response: unknown, blocks?: unknown[]}`.
   `blocks`, when present, must have one entry per emitted block in first-seen order; if the lengths
   disagree, assembly discards the whole envelope. We do not persist provider reasoning items today;
   omit `replayState` (v1) and treat it as a later enhancement if reasoning continuity becomes a
   problem. Omitting it is legal.
8. Assembler-post processing: on `finish.kind === 'max-tokens'` it drops every `tool-call` block
   (`assembler.ts:135-150`); `interruptedBlocks()` keeps only non-blank text/reasoning when the stream
   is cancelled (`assembler.ts:169-179`). So an adapter must not emit a tool call and then a
   `max-tokens` finish expecting the call to survive.
9. Error delivery has two sanctioned styles:
   - **throw** from the iterable: `LlmRuntime.adapterStream` normalizes the value into one terminal
     `finish` with `{kind:'error'|'aborted', failure}` (`llm/src/index.ts:1184-1192`);
   - **in-band** terminal `finish` (pi-ai's style): the runtime passes it through untouched
     (`llm/src/index.ts:1125-1153`), so the failure object must already be valid `LlmFailure`.
   Our adapter uses in-band style. Keep it, but make every emitted `failure` canonical (§7).
10. Empty success: a `stop` with zero blocks yields an empty assistant message and silently ends the
    turn. The canonical classification is `EMPTY_RESPONSE` (`llm/src/error.ts:42`), which is in the
    default retry set. Add the check: if the stream ends `stop` with no emitted block, emit
    `finish{kind:'error', failure:{code:'EMPTY_RESPONSE', …}}` (or throw `LlmError`).
11. Abort: when `options.signal.aborted`, the runtime turns a thrown failure into
    `{kind:'aborted'}` (`index.ts:1184-1192`). In-band, emit `{kind:'aborted', failure}` yourself.
    Do not emit a normal finish after the caller cancelled.
12. SSE sentinel: `data: [DONE]` is a clean end-of-stream marker, not content; a stream that closes
    without a terminal event (`response.completed`/`response.incomplete`/`failed`) is a **transport
    truncation**, which must become a terminal `TRANSPORT` failure (retryable), never a `stop`
    (`research/02-siwc-wire.md` §3 event mapping; LOCAL `responses.js` currently falls back to
    `PROVIDER_ERROR` — change it).

### 6.2 Reference emission order (per block, first-seen interleaving allowed)

```
block-start(index=n, blockType='text'|'reasoning'|'tool-call')
  …text-delta / reasoning-delta / tool-call-delta(index=n)…
block-end(index=n, block=<final ContentBlock>)
…
usage({inputTokens, outputTokens, cacheReadTokens?, reasoningTokens?, totalTokens?})
finish({kind:'stop'|'tool-calls'|'max-tokens'|'error'|'aborted', failure?, replayState?})   // last
```

Reference implementations: **SOURCE(α.3)** `packages/llm/llm-deepseek/src/translate.ts:104-165`
(emit at content_block_start/delta/stop, usage then finish) and
`packages/llm/llm-pi-ai/src/stream.ts:142-234` (text/reasoning/toolcall start-delta-end then usage+finish).

---

## 7. Failures: `LlmError`, canonical codes, and normalization

### 7.1 The two normalization paths (**LIVE** rc.5 `dsh-llm`)

- **Thrown from the adapter** → `normalizeLlmFailure(value)`:
  `HarnessError`/`LlmError` takes its `code`; any other `Error` becomes `code:'UNKNOWN'`
  **unless** the value carries its own `failure` data property that validates and whose `.code`
  equals its own `code` property (`packages/llm/llm/src/adapter-failure.ts:16-107`). Practical fix if
  a plugin error must survive: set both own properties, e.g.

  ```js
  const failure = Object.freeze({ message, code, ...(status === undefined ? {} : { status }) })
  const error = new Error(message)
  error.code = code
  error.failure = failure
  throw error
  ```

  (That is the documented cross-package duck-typing path. `PlanError` currently sets only `code`, so
  if it ever escapes the adapter it becomes `UNKNOWN`.)
- **In-band `finish`** → used as-is. So the in-band `failure` must satisfy `LlmFailure`:
  non-empty `message` string, non-empty `code` string, optional integer `status` 100–599, optional
  positive finite `providerRetryAfterMs`, optional `requestId`, optional positive `offloadImages`.

### 7.2 Canonical codes for this route (**SOURCE(α.3)** `llm/src/error.ts`, transport mapping in
`packages/llm/llm-deepseek/src/transport.ts:22-44`, pi-ai classifier
`packages/llm/llm-pi-ai/src/stream.ts:42-68`)

| Situation | Code | Retried by default? |
|---|---|---|
| No stored sign-in / credential record absent | `MISSING_CREDENTIAL` | no |
| Stored record malformed (wrong kind, missing token, non-JSON) | `INVALID_CREDENTIAL` | no |
| 401/403, revoked grant, ineligible account | `AUTH` | no |
| 429 | `RATE_LIMIT` (+ `providerRetryAfterMs` from `retry-after`) | **yes** |
| 5xx / provider unavailable | `SERVER` | **yes** |
| Network/socket/fetch failure, stream truncated mid-response | `TRANSPORT` | **yes** |
| Request/stream timeout | `TIMEOUT` | **yes** |
| Completed response with no blocks | `EMPTY_RESPONSE` | **yes** |
| Plan quota/usage exhausted | `QUOTA` (or `ACCOUNT_QUOTA` for first-party billing pages) | no |
| Context window exceeded | `CONTEXT_WINDOW_EXCEEDED` | no |
| SSE closed before a terminal event, or `[DONE]` without completion | `TRANSPORT` | **yes** |
| 400/404/413/422 rejected request body | `INVALID_REQUEST` | no |
| Plan-scope permission not granted (our own gate) | `AUTH` (message says re-authorize) — do **not** invent a retryable code | no |

Current `responses.js` `failureFromHttp` maps 5xx to `PROVIDER_ERROR`, so a transient OpenAI 5xx is
never retried by `llm-retry`. Map the fallback branch by status:
`status >= 500 → SERVER`; `429 → RATE_LIMIT`; `401/403 → AUTH`; `402 → QUOTA`; else
`INVALID_REQUEST`/`PROVIDER_ERROR`. Also keep `status` and `providerRetryAfterMs` in the failure.

`LlmError` constructor validates `message`/`code` non-empty, `status` 100–599, positive
`providerRetryAfterMs` (`llm/src/index.ts:96-131`) — matching duck-typed failure constraints.

### 7.3 Retry policy (**LIVE** rc.5, **SOURCE(α.3)** `retry-policy.ts`)

- `providerRetryPolicy()` returns a `ResolvedRetryPolicy` or `undefined`; undefined → normal defaults
  above. It is resolved and frozen inside `registerAdapter` (`llm/src/index.ts:450-456`), so a
  `Config`-driven change needs a re-registration (or a `registration.replace`).
- `llm-retry` is mounted in base and executes the policy on the agent's failed-step extension point
  (only after a terminal failure finish chunk, i.e. our in-band failures are the input).
- For a tunneled/proxied ChatGPT route, a longer policy can help (prior art uses 5 retries,
  1s..30s, jitter 0.2 — **PRIOR ART** `src/adapter.ts:415-422`); expose it via `Config` if we add
  Schemastery (`RetryPolicySchema` is a public `dsh-llm` export — verified in the installed build).

---

## 8. Credential storage through `ctx.credentials`

### 8.1 Key grammar (**SOURCE(α.3)** `packages/credentials/credentials/src/index.ts:19-92`)

- `credentialKey(scope, id)` → branded `` `${scope}/${id}` ``; each segment must match
  `^[a-z][a-z0-9-]*$`; `isCredentialKeySegment` is the predicate for externally-supplied segments;
  `parseCredentialKey` validates a stored joined key.
- The scope should be the owning plugin's registered name. Our bundle: plugin `name = 'chatgpt-plan'`,
  key `chatgpt-plan/credential` (LOCAL `store.js:15-19`) — valid; use one exported constant for the
  adapter, the flow key, and the routes (currently `oauth.js` repeats the literal — derive it from
  `store.js` to prevent drift).
- `credentials-local` rejects a stored document whose record key cannot be parsed, so an invalid
  segment silently stored by other means would break the whole credentials file on next boot.
- The key space is disjoint from env-var references (`CredentialRef`); never pass a record key to
  `resolve`/`describe`.

### 8.2 Records

- `CredentialRecord = ApiKeyRecord | GrantRecord`; our OAuth tokens go in
  `{ kind: 'grant', payload: <JSON> }` (payload opaque to the seam, owner-defined format).
- The local store validates the payload is a **JSON round-trip value**: no `undefined`, no `Date`,
  no class instances, no non-finite numbers, no cycles (**SOURCE(α.3)**
  `packages/credentials/credentials-local/src/index.ts:392-418,678-712`). Current
  `siwc.js:credentialsFromToken` produces plain objects/strings/numbers/booleans/null — valid, but do
  not start putting `undefined` members in it.
- Write path is only `modifyRecord(key, async current => nextRecord | undefined)`; returning
  `undefined` leaves the record untouched and returns the current one. It is serialized **across
  processes** by the local store's file lock; `deleteRecord` removes; `readRecord` returns the stored
  payload verbatim; `describeRecord` gives `{configured, kind, writable}` without the value.
- Events: `credentials/record-updated(key)` fires after a committed change (the seam and the client
  both consume it to invalidate the model catalog/credentials badge).

### 8.3 Refresh: read-decide-replace under the lock (fix for `bundle/lib/store.js`)

The seam's stated contract: "a token refresh is read-decide-replace under one lock" and
"exclusion holds across processes where the backing store supports it"
(**SOURCE(α.3)** `credentials/src/index.ts:236-251`, `credentials-local/src/index.ts:678-712`).
The current implementation reads, refreshes over the network, then writes through a second
`modifyRecord` call, and only serializes in-process (`singleFlight`). Two Harness processes (desktop +
CLI/web) signing the same account can rotate the same refresh token and lose one rotation.

Preferred shape:

```js
async function ensureAccessToken(ctx, signal) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new PlanError('NO_CREDENTIAL_STORE', '…')
  const now = Date.now()
  const current = await readCredential(ctx)
  if (current === undefined) throw new PlanError('MISSING_CREDENTIAL', '…')
  if (current.planEnabled !== true) throw new PlanError('AUTH', '…plan scope not granted…')
  if (now < current.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return { payload: current, accessToken: current.accessToken }

  // ONE serialized read-modify-write: the network refresh runs inside the lock so another
  // process cannot rotate the same refresh token between our read and our write.
  const stored = await credentials.modifyRecord(CREDENTIAL_KEY, async (record) => {
    if (record === undefined || record.kind !== 'grant') throw new PlanError('MISSING_CREDENTIAL', '…')
    const latest = record.payload
    if (typeof latest.expiresAt === 'number' && Date.now() < latest.expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
      return undefined                       // another holder refreshed it; keep it
    }
    let next
    try { next = await refreshCredentials(latest, { signal }) }
    catch (error) {
      if (error instanceof SiwcTokenError && error.fatal) {
        throw new PlanError('AUTH', '…sign in again…')   // surface revocation
      }
      throw error
    }
    return { kind: 'grant', payload: next }
  })
  const payload = stored?.kind === 'grant' ? stored.payload : undefined
  if (payload === undefined) throw new PlanError('MISSING_CREDENTIAL', '…')
  return { payload, accessToken: payload.accessToken }
}
```

Notes:

- Keep the in-process `singleFlight` around the whole `modifyRecord` as an optimization (avoid queueing
  N callers); the cross-process lock is the correctness guarantee.
- Never log or copy the token; errors thrown by the token endpoint must be sanitized (prior art's
  `safeMessage` redacts JWTs and `code=`/`token=` — **PRIOR ART** `src/auth-routes.ts:121-133`).
- Force-refresh on a 401: same `modifyRecord` shape, but skip the expiry check and refuse second
  refreshes within `earliestRefreshAt` (current `refreshNow` has the right idea; move the write inside
  the lock).
- Sign-out: `credentials.deleteRecord(FLOW_KEY)` (keeps the non-secret registration record).

### 8.4 Error mapping for the credential half

- No record → `MISSING_CREDENTIAL` (message names the Settings page/command).
- Record but wrong kind / unparsable payload → `INVALID_CREDENTIAL` (fix the stored value; never
  retried).
- Fatal refresh codes (`invalid_grant`, `invalid_client`, `invalid_refresh_token`,
  `refresh_token_expired/invalidated/reused`, `token_expired` — LOCAL `siwc.js:51-60`) → `AUTH`
  ("sign in again"); non-fatal token-endpoint failures (`http_5xx`, network) → rethrow/`TRANSPORT`/
  `SERVER` so retry policy can act.
- `NO_CREDENTIAL_STORE` when the composition mounts no `credentials` service: refuse writes loudly,
  but reads may answer "nothing stored" (matches pi-ai's store adapter, **SOURCE(α.3)**
  `packages/llm/llm-pi-ai/src/auth.ts:102-122`).

---

## 9. `AuthorizationFlow`: registration, begin, commit, and our own surface

### 9.1 Live contract (**LIVE**; matches **SOURCE(α.3)** `packages/credentials/authorization/src/index.ts:90-143`)

```
registerFlow({
  key: CredentialKey,                 // the record this flow writes
  label: string,                      // user-facing
  methods: [AuthorizationMethod, ...],// non-empty; [{id,label}, …]
  run(session): Promise<void>,        // must commit the record during the attempt
})
begin({ key, method?, interaction: { notify, prompt }, signal? }): Promise<{status:'authorized'|'cancelled'}>
```

- `session`: `{ method, signal, commit(record), notify({message,url?,code?}), prompt({kind:'text'|'secret'|'select', message, options?, placeholder?, signal?}) }`.
- `begin` throws typed `AuthorizationError` codes: `NO_FLOW`, `UNKNOWN_METHOD`,
  `ALREADY_IN_FLIGHT`, `NOT_COMMITTED`; declined prompts settle the attempt as `cancelled`.
- The seam watches `credentials/record-updated` during the attempt; `run()` resolving without a
  committed record for `key` → `NOT_COMMITTED`. `session.commit()` is the sanctioned write
  (`modifyRecord` under the hood) and it flips `committing` so `cancel()` waits.
- One flow per key; a duplicate registration throws `DUPLICATE_FLOW`. Flow disposer also cancels a
  running attempt.
- **There is no generic surface that calls `begin()`** in rc.5: `authorization` has no `@Remote`
  methods, no client package exists for it, and the Models page's `settings.models.sign-in` slot is
  only rendered inside the first-party DeepSeek onboarding modal (**LIVE**; §0.7). Our plugin must own
  the trigger.

### 9.2 Registration skeleton (`bundle/lib/oauth.js` addition)

```js
import { CREDENTIAL_KEY } from './store.js'
export const FLOW_KEY = CREDENTIAL_KEY          // one definition, one flow
export function registerPlanFlow(ctx) {
  return ctx.authorization.registerFlow({
    key: FLOW_KEY,
    label: 'ChatGPT plan',
    methods: [{ id: 'browser', label: 'Sign in with ChatGPT' }],
    async run(session) {
      // SIWC: PKCE + dynamic client registration + loopback callback + code exchange.
      const credentials = await runLoginFlow(ctx, session) // existing implementation
      await session.commit({ kind: 'grant', payload: credentials })
    },
  })
}
```

- Keep `run()` entirely inside the `session.signal` lifetime; close the loopback server in `finally`
  (current `runLoginFlow` does).
- `notify` at least once before blocking so a polling surface can show the URL; `prompt` only if the
  flow really needs input (our browser flow does not; if all callback ports are busy, fail with a
  clear message instead of a hidden prompt — v1).
- The non-secret registration record (`chatgpt-plan/registration`) is written through plain
  `ctx.credentials.modifyRecord` **outside** `session.commit` (only the flow's `key` is the committed
  record). Current `runLoginFlow` does this correctly.

### 9.3 How `begin()` gets called (Host-owned interaction)

Implement a tiny per-plugin account controller and four same-origin routes; the routes are the
"surface" the seam expects:

```js
// bundle/lib/http.js  (plain ESM; hosted by ctx.webServer)
const BASE = '/plugins/dsh-chatgpt-plan'
const STATUS = `${BASE}/auth/status`
const LOGIN = `${BASE}/auth/login`
const CANCEL = `${BASE}/auth/cancel`
const LOGOUT = `${BASE}/auth/logout`

export function registerPlanRoutes(infra, ctx, { isSignedIn }) {
  let attempt = { phase: 'idle' }      // {phase, url?, code?, message?, startedAt?}
  let controller

  const status = async () => {
    if (attempt.phase === 'signing-in') {
      return { status: 'signing-in', ...(attempt.url ? { url: attempt.url } : {}),
               ...(attempt.code ? { code: attempt.code } : {}), ...(attempt.message ? { message: attempt.message } : {}) }
    }
    const payload = await isSignedIn()
    if (payload !== undefined) {
      return { status: 'signed-in', planEnabled: payload.planEnabled === true,
               ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
               expiresAt: payload.expiresAt }
    }
    return attempt.phase === 'failed' ? { status: 'error', message: attempt.message } : { status: 'signed-out' }
  }

  const start = () => {
    if (attempt.phase === 'signing-in') return status()
    const authorization = ctx.get('authorization')
    const on = ctx.get('credentials')
    if (authorization === undefined || on === undefined) throw new Error('authorization or credentials service is not mounted')
    controller = new AbortController()
    attempt = { phase: 'signing-in', startedAt: Date.now() }
    void authorization.begin({
      key: FLOW_KEY,
      method: 'browser',
      signal: controller.signal,
      interaction: {
        notify: notice => { attempt = { ...attempt, ...notice, phase: 'signing-in' } },
        // The browser flow never needs input; a prompt here would be a bug.
        prompt: prompt => Promise.reject(new Error(`chatgpt-plan: unexpected authorization prompt: ${prompt.message}`)),
      },
    }).then(
      outcome => { attempt = outcome.status === 'authorized' ? { phase: 'idle' } : { phase: 'idle' } },
      error => { attempt = { phase: 'failed', message: String(error?.message ?? error) } },
    )
    return status()
  }

  const guard = handler => async (req, res) => {
    const rejection = ctx.connection.requestRejection({ headers: req.headers })   // 401 | 403 | undefined
    if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
    try { await handler(req, res) }
    catch (error) {
      // Never let a route throw: an uncaught handler exception is fatal to the app process.
      if (!res.headersSent) json(res, 500, { error: 'internal' })
    }
  }
  /* json() sets 200/4xx with content-type application/json; cache-control: no-store;
     x-content-type-options: nosniff; never includes a token. */

  return [
    infra.webServer.register({ kind: 'exact', path: STATUS, handler: guard(async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
      json(res, 200, await status())
    })}),
    infra.webServer.register({ kind: 'exact', path: LOGIN, handler: guard(async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'unsupported content type' })
      json(res, 202, await start())
    })}),
    infra.webServer.register({ kind: 'exact', path: CANCEL, handler: guard(async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      controller?.abort(new Error('cancelled by user'))
      try { ctx.get('authorization')?.cancel(FLOW_KEY) } catch { /* absent seam */ }
      attempt = { phase: 'idle' }
      json(res, 200, { ok: true })
    })}),
    infra.webServer.register({ kind: 'exact', path: LOGOUT, handler: guard(async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      controller?.abort(new Error('signed out'))
      try { ctx.get('authorization')?.cancel(FLOW_KEY) } catch { /* absent seam */ }
      await ctx.get('credentials')?.deleteRecord(FLOW_KEY)
      attempt = { phase: 'idle' }
      json(res, 200, { ok: true })
    })}),
  ]
}
```

Register the returned disposers inside one `ctx.effect` (the routes are not disposer-free):
`ctx.effect(() => { const ds = registerPlanRoutes(...); return () => ds.forEach(d => d()) })`.
Route registration: duplicate `(kind,path)` throws; a route must be an absolute pathname with no
trailing slash; the prefix `/plugins` is owned by `dsh-client-modules` but exact routes under it are
fine (**LIVE** `webServer` contract; **SOURCE(α.3)** `packages/host/webserver/src/index.ts:47-53`).
Also impose a Host-side attempt timeout (the loopback server already has 10 min; add a
`setTimeout` that aborts `controller` and clears in the effect disposer).

### 9.4 Browser opening and the loopback callback

- Open the OS browser from the Host with `node:child_process.spawn` (current `oauth.js` `openBrowser`):
  `open` (macOS), `cmd /c start ""` (Windows), `xdg-open` (Linux), `{detached:true, stdio:'ignore'}`,
  `child.unref()`, swallow spawn errors because the URL is also shown to the human.
  `ctx.subprocess` exists (**LIVE**) but adds a sandbox/service dependency for no benefit here.
- Loopback listener: `node:http` `createServer` on `127.0.0.1`, path `/auth/callback`, one-shot state.
  The SIWC reference implementation states the callback **must** be an HTTP loopback address on
  `127.0.0.1` and **only the port may vary** (`research/ref/chatgpt_plan_auth/chatgpt_plan_auth/const.py:18-20`),
  so bind a free port and put the actual port in `redirect_uri` (current `oauth.js` does this; the prior
  art's fixed 1455 + paste fallback is another valid shape — **PRIOR ART** `src/oauth-browser.ts:36-127`).
- **Fatal-Exception trap:** an exception escaping the `request` handler becomes an uncaught exception,
  which app-boot treats as fatal (it disposes the app and exits nonzero — **SOURCE(α.3)**
  `packages/boot/app-boot/README.md` failure table). Wrap the whole handler in try/catch, parse
  `req.url` safely, always write a response, and never throw from `res.end`.
- The callback page should be a tiny self-contained HTML ("you can close this tab"); reply
  `Cache-Control: no-store`; on invalid/missing code reply 400 and keep waiting (do not settle).
- The flow's `session.signal` cancellation must clear the timeout timer and close the server exactly
  once (current `finish()` is idempotent).
- After the code: exchange with the PKCE verifier + the client id (dynamic registration returns
  `oaiapp_…` in the callback query), validate `state`, validate the ID token (issuer, audience,
  nonce, exp), persist registration facts, enforce the plan scope (`chatgpt.tokens.use.direct`), then
  `session.commit`.
- `DUPLICATE_FLOW` avoidance: our key is unique (`chatgpt-plan/credential`); the shipped pi-ai plugin
  registers `llm-pi-ai/openai-codex` (**LIVE**; **PRIOR ART** dsh-ui doc §2.3) — different key, no
  collision. Never reuse `llm-pi-ai/<provider>` as our scope, and do not register our flow from more
  than one bundle row.

---

## 10. Bundle Client half and browser surface

### 10.1 Registration format (no build step)

`bundle/client.js` is a **classic script** (not ESM) that registers a lazy factory:

```js
window.__ModuleLoader__.load({
  id: 'dsh-chatgpt-plan',                    // MUST equal package.json name
  factory(require) {
    const React = require('react')           // baseline modules only
    const h = React.createElement
    // components + apply(); no side effects at script execution time
    function ChatGPTPlanSection({ t }) { /* fetch status/login/logout, poll 1s while signing-in */ }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('settings.chatgpt-plan', { en, zh }), 'chatgpt-plan: copy')
      const t = ctx.locale.bind('settings.chatgpt-plan')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'chatgpt-plan',
        order: 16,
        label: () => t('nav'),
        locale: 'settings.chatgpt-plan',
      }, ChatGPTPlanSection))
    }
    return { name: 'dsh-chatgpt-plan-client', inject: ['slots', 'locale'], apply }
  },
})
```

- Format evidence: **PRIOR ART** `lib/client.js` (`window.__ModuleLoader__.load({id, factory})`,
  `require('react')`, `require('react-dom')`, `require('react/jsx-runtime')` only) and installed
  bundles; template `templates/decoration/client.js` is the minimal plain-JS form.
- `settings.section` is a **list** slot at `root` scope declared by the settings shell; registration
  options `{name, id, order, label, locale, inject}`; the component receives `{close}` plus the
  `inject` face and the locale `t` seat (**LIVE** installed
  `dsh-client-ui-settings-general/lib/client.js`).
- The client artifact is served at `/plugins/<package-name>/client.js` by `dsh-client-modules`; the
  `dsh.client` declaration must exist or the browser half is never loaded.
- Locale copy belongs to `ctx.locale.register`; no hardcoded product strings in components (repo
  client policy). Plain-JS styles: inline style objects with `--dsw-alias-*` tokens (copy the prior
  art's token names; re-verify with `Theme.listTokens` when client inspect answers).
- No `require('@deepseek-ai/*')` — that is exactly the practice the skill forbids for client halves;
  only baseline modules (react family, cordis, zod, client-store, slots/primitives/dockkit) are in the
  module table (**SOURCE(α.3)** `packages/client/web/src/platform.ts`; **PRIOR ART**).
- After install, the page must be reloaded; a new package/renamed path needs an app restart.

### 10.2 Host↔Client data path

Use the same-origin routes from §9.3 from the client with
`fetch(path, { method, headers, credentials: 'same-origin' })` and JSON bodies. Do **not** add a
custom Typert `@Remote` namespace: strict-codec descriptors are generated, hand-writing them couples
us to generator internals (**PRIOR ART** dsh-ui doc §5.1). Guard every route with
`ctx.connection.requestRejection({ headers: req.headers })` — it applies the Host/Origin fences and
browser-session authentication that the webserver itself does not (**LIVE** `connection` contract;
**SOURCE(α.3)** `packages/client/connection/src/rpc.ts:98-104,228-240`).

### 10.3 Host-only vs host+client

- Host-only bundle: header row + adapter + flow + routes-if-webServer-mounted. Settings UX absent;
  login can be triggered by the optional `/chatgpt-plan-login` command (headless/CLI) or by a user
  command in the Web composer.
- Host+client bundle: adds `dsh.client`, `exports['./client']`, `bundle/client.js`, locale/icon.
  Same package, same row; no second Loader row.
- The UI is only a view of Host state (status/notice/poll); never hold tokens in the browser.

---

## 11. Config schema (Schemastery) — optional but recommended

Only if we accept `@deepseek-ai/schemastery` as a peer (linked install requires the peer declaration;
see §1.2). Without `Config`, `apply(ctx, config)` still receives the raw YAML object; the plugin must
validate it itself.

```js
import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'   // also a peer import

export const Config = z.object({
  provider: z.string().default('chatgpt-plan'),
  displayName: z.string().default('ChatGPT (plan)'),
  // Models offered before the live plan catalog is readable; the live catalog wins when present.
  fallbackModels: z.array(z.string()).default([
    'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
  ]),
  contextWindow: z.number().step(1).min(1).default(272_000),   // only for uncatalogued slugs
  requestTimeoutMs: z.number().step(1).min(1).default(300_000),
  streamIdleTimeoutMs: z.number().step(1).min(1).default(300_000),
  retryPolicy: RetryPolicySchema,                               // resolved at registration
})
```

Notes:

- `Config` is validated by the Loader at activation; `Config.listConfigs` exposes the JSON Schema
  (skill reference). Keep every deployment-varying value here (route name, display name, fallback
  models, timeouts, retry policy); protocol constants stay in code (repo convention:
  "no hardcoded tunables in plugins").
- If any field is `.volatile()`, `apply` receives a `Volatile<T>` accessor (`.get()`), not a plain
  value; prior art handles both with a `liveValue` helper (**PRIOR ART** `src/index.ts:255-266`).
  Avoid volatiles for `provider` (a route rename must re-register the adapter); `loader/volatile-update`
  can refresh model/timeout reads.
- **Zero-import variant:** omit `Config` entirely; then the bundle needs no peer declarations and the
  linked-install resolution surface shrinks to zero. Document accepted keys in the README and
  validate in `apply` with a clear `LlmError`/`Error`.

---

## 12. Prior art: `dsh-codex@0.3.2` (`/Users/jeff/.dsh/profiles/web/node_modules/dsh-codex`)

A published third-party bundle (peers `^0.2.0-rc.1`, installed copy, profile `web`) that ships the
same product idea: ChatGPT OAuth, Codex models, settings page, usage, extra tools. What it establishes
and what not to copy:

### 12.1 What to copy

- **Manifest shape for host+client**: `package.json` `dsh.bundle.patch` + `dsh.client`
  `{inject:[…], platform:'web'}` + `exports['./client']`; row inserted by `cordis.patch.yml` with
  `name: dsh-codex` and `id: llm-openai-codex` (`package.json`, `cordis.patch.yml`).
- **One Loader row, both halves**: client entry `id` = package name (`lib/client.js`
  `window.__ModuleLoader__.load`); host entry is built ESM with bare imports resolved by the runtime.
- **Same-origin HTTP surface**: `ctx.webServer.register({kind:'exact', path, handler})` for
  status/login/cancel/logout, wrapped in one `ctx.effect` whose cleanup disposes every route and the
  auth controller (`src/auth-routes.ts:834-1154`). The client half fetches the same paths
  (`src/client/OpenAICodexSettings.tsx:23-36,660-690`).
- **Loopback browser login**: PKCE S256, `state`, loopback `127.0.0.1:1455/auth/callback`, browser
  spawn, manual paste fallback, validate callback, exchange, refresh (`src/oauth-browser.ts`,
  `src/oauth-provider.ts`).
- **Settings page**: `settings.section` registration with `id/order/label/locale/inject`
  (`src/client/index.tsx:70-76`) and polling status/usage.
- **Usage page**: `https://chatgpt.com/settings/usage` link and server-side usage fetch
  (`src/usage.ts`).
- **Error redaction** before crossing to the browser (`safeMessage` in `src/auth-routes.ts:121-133`).

### 12.2 What not to copy for this task

- **Its credential storage**: own owner-only JSON file at `$DSH_HOME/.openai-codex-auth.json`
  (`src/store.ts`), not the `ctx.credentials` seam. Our requirement is the seam (grant record,
  `modifyRecord`, cross-process lock, `credentials/record-updated`). Its `CredentialStore` implements
  pi-ai's interface and writes files directly; adopting it would bypass the seam and create a second
  writer for the same account.
- **Its pi-ai dependency chain**: it subclasses `PiAiAdapter` and overrides a pi-ai `Provider`
  (`src/adapter.ts:527-674`), so it imports `@deepseek-ai/dsh-llm-pi-ai`, `@earendil-works/pi-ai`,
  `undici` and pins those peers. Our direction is a self-contained Responses client (LOCAL
  `responses.js`), which removes that whole dependency and its version coupling.
- **Its credential key**: `llm-pi-ai/openai-codex` — that key belongs to the pi-ai plugin's flow; it
  would collide with `DUPLICATE_FLOW` if our plugin tried to use it.
- **Its route name**: `openai-codex` collides with the desktop profile's configured pi-ai route
  (`DUPLICATE_ADAPTER`). Use `chatgpt-plan`.
- **Its auth endpoint**: `https://chatgpt.com/backend-api/codex/responses` with Codex CLI headers
  (`src/responses.ts:23-24,459-475`). SIWC plan usage targets
  `https://api.openai.com/v1` with plan-usage scopes (LOCAL `siwc.js:26-30`); the wire team owns the
  exact wire contract, so do not copy the Codex endpoint.
- **Its Models-page coupling** (`dsh.client.inject` list includes many UI packages) — informational
  only, but a smaller list is safer.

---

## 13. Implementation checklist (ordered; each item is acceptance-testable)

### Phase 1 — Host contract compliance (no UI)

- [ ] Add the missing adapter members (`providerRetryPolicy`, `prepareCall`, `imageRequestPricing`,
      `imageRequestTarget`) to `bundle/lib/adapter.js` per §4.2 and verify `registerAdapter` succeeds.
- [ ] Map `failureFromHttp` 5xx → `SERVER`, 429 → `RATE_LIMIT`, 402 → `QUOTA`, 401/403 → `AUTH`;
      keep `status` + `providerRetryAfterMs`; fallback messages non-empty (§7.2).
- [ ] Map a stream that closes before a terminal event (and `[DONE]` without completion) to
      `TRANSPORT`, not `PROVIDER_ERROR`, so `llm-retry` retries it (§6.1.12, §7.2).
- [ ] Fix `usageChunk`: `inputTokens = max(0, input_tokens - cached_tokens)` (disjoint counts §6.1.5).
- [ ] Add `EMPTY_RESPONSE` when a `stop`/`completed` response produced zero blocks (§6.1.10).
- [ ] `buildRequestBody`: honor `options.system` (hand-built callers) as `instructions` fallback (§5).
- [ ] Accept `\r\n\r\n` SSE frame boundaries, flush a trailing frame, bound the frame buffer; route
      401 → one refresh + one retry (existing), then terminal `AUTH`.
- [ ] `store.js`: move refresh inside `credentials.modifyRecord(key, mutate)` and derive/import one
      key constant; keep the non-secret registration record outside the flow key (§8.3).
- [ ] `oauth.js`: derive `FLOW_KEY` from `store.js`; wrap the callback request handler in try/catch and
      never throw from it (uncaught route exceptions are fatal, §9.4); clear timers on abort; keep the
      landing page and `no-store`.
- [ ] Add `bundle/index.js` (plugin entry) and a static `registerPlanFlow`; register under
      `ctx.inject(['authorization'], …)` with an effect (`registerFlow` returns a disposer).
- [ ] Verify with `cordis_inspect_query` after install that `llm.listProviders()` shows the route,
      `listModels` returns the fallback/live catalog, and the picker lists it.
- [ ] Select the route in the composer and run one turn: capture the chunk stream (session log /
      assistant-stream) and confirm block indexes, `usage` before `finish`, exactly one finish, and
      no `UNKNOWN` failure codes on provider errors.

### Phase 2 — Login trigger (Host routes) and credential commit

- [ ] Add `bundle/lib/http.js` with the four routes, `ctx.connection.requestRejection` guard, JSON
      content-type check, no-store, no token leakage, single in-flight attempt, Host-side timeout.
- [ ] Register the routes under `ctx.inject(['webServer','connection'], …)` with an effect disposer;
      register the optional `/chatgpt-plan-login` command under `ctx.get('commands')`.
- [ ] End-to-end: POST login → flow runs → browser opens → callback commits
      `chatgpt-plan/credential` record → `begin()` returns `authorized` → `status` reports
      signed-in and `planEnabled`; Cancel and Logout behave (disconnect deletes the record).
- [ ] Assert `ctx.credentials.describeRecord(FLOW_KEY).configured` and parse the payload after login;
      confirm `credentials/record-updated` fired (adapter next request uses the new token).
- [ ] Force-expiry test: tamper the stored `expiresAt` (on a scratch profile) and confirm refresh
      rotates the refresh token through `modifyRecord` and the next request succeeds.

### Phase 3 — Bundle install and display metadata

- [ ] Write `package.json` (name `dsh-chatgpt-plan`, `engines.dsh`, optional peers), `cordis.patch.yml`
      with one insert row, `locale/en.json` + `locale/zh.json` (`meta.title`/`meta.description`),
      `icon.svg`, and a README documenting config keys and the SIWC consent.
- [ ] Install with `plugin_manager` `install_bundle` and read `application`/`warnings`; confirm the row
      is live via `cordis_inspect_query` (`Config.listConfigs` by `name`), not just `list_plugins`.
- [ ] Restart the app after code changes; confirm that a broken import/config fails the row visibly
      (startup audit) and does not kill unrelated rows.

### Phase 4 — Client half (Settings)

- [ ] Add `dsh.client` + `exports['./client']` + `bundle/client.js` in the exact loader format (§10.1);
      `id` = package name; `settings.section` registration with localized label.
- [ ] The section shows: "Using your ChatGPT plan", status (signed-out / waiting / signed-in / error),
      Connect / Cancel / Disconnect, the auth URL as a real `<a target="_blank" rel="noopener noreferrer">`
      (never `window.open`), optional usage link, and a Manage usage link.
- [ ] Polling: 1 s while signing-in, 60 s while signed-in; stop polling on unmount.
- [ ] Reload the page after install; verify the section appears with locale text. Re-run
      `Slots.listSubTree` once Client inspect answers to confirm the slot props/options.

### Phase 5 — Decision cleanup

- [ ] Decide whether the desktop profile keeps the `llm-pi-ai/openai-codex` route and its flow. Two
      ChatGPT sign-ins (pi-ai key vs ours) would be confusing; if ours is canonical, remove that
      provider profile from the user patch (separate, explicit decision — do not rewrite another
      bundle's row from ours).
- [ ] Do not ship `agent-default-model` overrides from the bundle; document how to set it after
      sign-in.

---

## 14. Runtime pitfalls checklist

1. **Deep-frozen requests**: never mutate `options`, `messages`, `tools`; build new objects (loop
   requests are frozen and mutation throws).
2. **AsyncIterable laziness**: `stream()` must not perform I/O before the first `next()`; all awaits
   inside the generator body.
3. **Abort signals**: combine caller + timeout with `AbortSignal.any`; check `signal.aborted` before
   and after awaits; emit `aborted` finish or let the runtime normalize a throw.
4. **Exactly one terminal finish**, after `usage`; nothing after `finish`.
5. **Canonical failure codes** — a non-retryable code silently disables retries; an invalid in-band
   `failure` object is stored as-is by the assistant stream.
6. **Empty response** — a completed empty turn must become `EMPTY_RESPONSE`, not an empty message.
7. **No `instanceof` assumptions** across package copies: a duck-typed error must carry own `code`
   **and** own `failure` to keep its code through `normalizeLlmFailure`; if the adapter emits in-band
   failures instead, no normalization happens at all.
8. **Do not register routes/adapters/flows twice**; every registration is an effect of the plugin
   fiber and must dispose. Re-apply after config update is safe only because the old fiber disposed.
9. **Uncaught exceptions inside HTTP handlers, timers, streams are fatal to the app process**
   (app-boot fails loud) — wrap handlers, `unref()` timers you own, and catch fire-and-forget
   promises.
10. **Credential store**: only `modifyRecord` writes; refresh inside the mutate callback; payload must
    be JSON-round-trip-safe; never log secrets; key segments must match `^[a-z][a-z0-9-]*$`.
11. **Linked install**: bare Harness imports need `peerDependencies` (not `dependencies`); a second
    copy breaks singleton/class identity. `engines.dsh` is the compatibility knob rc.5 prefers.
12. **Client bundle**: classic script + `window.__ModuleLoader__.load`, `id` = package name, only
    baseline `require`s, no side effects at script execution, no DOM outside React, locale-owned copy.
13. **Restart/reload**: new/renamed packages and changed JS in a linked package need a restart;
    profile HMR does not reload module roots by default.
14. **Route collision**: `chatgpt-plan` must not equal an existing route (`openai-codex` is taken by
    the desktop patch's pi-ai provider); `DUPLICATE_ADAPTER` fails the row.
15. **Flow collision**: one flow per credential key; `DUPLICATE_FLOW` otherwise; keep our own scope.
16. **Commit contract**: `session.commit()` inside `run()` (not a later background write), or the seam
    reports `NOT_COMMITTED` and the UI shows a failed sign-in even though a token was stored.
17. **Callback port availability**: any loopback port is acceptable for SIWC; bind the first free one
    and put it in `redirect_uri`; a fixed port that is busy must not dead-end the flow.
18. **Retry `providerRetryAfterMs`** must be positive and finite; providers send odd headers.
19. **Images**: declaring `inputModalities:['image']` keeps image blocks in `messages`, so the adapter
    must resolve them through `ctx.get('attachments')`; declaring text-only makes the runtime replace
    them with placeholder text (do not do both).
20. **`sessionId` is available** (`GenerateOptions.sessionId`) for transport metadata; do not send
    parameters the plan route rejects (`prompt_cache_key`, `safety_identifier`, `service_tier`, …).

---

## 15. Citations

### Live rc.5 contracts (via `cordis_inspect_query` host `Service.listService`)

- `llm`: `registerAdapter(providers, adapter)`, `registerConfigurableProviders(entries)`,
  `providerRetryPolicy(provider)`, `imageRequestPricing/Target`, `listModels`, `resolveModelInfo`,
  `resolveCallConfig`, `prepareCall`, `stream`; referenced types `LlmAdapter`, `GenerateOptions`,
  `StreamChunk`, `TokenUsage`, `FinishReason`, `ReplayEnvelope`, `LlmFailure`,
  `ResolvedRetryPolicy`, `LlmConfigurableProvider`.
- `credentials`: `resolve/describe/set/unset`, `readRecord/describeRecord/listRecords`,
  `modifyRecord/deleteRecord`; types `CredentialKey`, `CredentialRecord`, `ApiKeyRecord`,
  `GrantRecord`, `CredentialRef`.
- `authorization`: `registerFlow/list/describe/cancel/begin`; types `AuthorizationFlow`,
  `AuthorizationSession`, `AuthorizationInteraction`, `AuthorizationRequest/Outcome`.
- `webServer`: `register({kind,path,handler})`, `registerUpgrade`, `registerFallback`, `getOrigin`;
  `connection.requestRejection({headers})` → `401|403|undefined`.
- Installed asar (rc.5) verified exports: `dsh-llm` `lib/index.js` exports `LlmAdapter`, `LlmError`,
  `HarnessError`, `attributionHeaders`, `resolveRetryPolicy`, `RetryPolicySchema`, `BlockAssembler`;
  `dsh-credentials` exports `credentialKey`, `isCredentialKeySegment`, `parseCredentialKey`,
  `credentialKeyScope`, `credentialKeyId`, `credentialRef`; retry defaults 5 / 500 / 10000 / 0.1.

### SOURCE(α.3) — `/Users/jeff/Documents/DEV/deepseek-harness`

- `packages/llm/llm/src/index.ts:208-303` (`LlmAdapter` defaults), `:401-459` (`registerAdapter`
  validation + retry capture), `:495-548` (`registerConfigurableProviders`), `:668-694`
  (`providerRetryPolicy`, `imageRequestPricing`, `imageRequestTarget`), `:718-745` (`listModels`
  validation), `:756-882` (`resolveModelInfo` validation), `:894-1014` (`resolveCallConfig`,
  `prepareCall`), `:1022-1037` (replay filtering), `:1064-1153` (`adapterStream` projection + failure
  chunk), `:1184-1192` (`adapterFailureChunk`).
- `packages/llm/llm/src/types.ts:462-482` (`StreamChunk`), `:528-571` (`GenerateOptions`),
  `:61-150` (content blocks), `:167-189` (`TokenUsage`), `:156-165` (`FinishReason`),
  `:448-460` (`ReplayEnvelope`), `:428-439` (`LlmResolvedModelInfo`), `:491-526` (`ToolSchema`,
  `ToolHistory`).
- `packages/llm/llm/src/assembler.ts:38-208` (assembly rules; max-tokens pruning at `:135-150`;
  interrupted blocks at `:169-179`).
- `packages/llm/llm/src/error.ts:13-51` (`HarnessError`, `EMPTY_RESPONSE`, `INVALID_CREDENTIAL`,
  `QUOTA`).
- `packages/llm/llm/src/adapter-failure.ts:16-107` (`normalizeLlmFailure`, duck-typed `failure`+`code`
  path).
- `packages/llm/llm/src/retry-policy.ts:14-24` (defaults), `:149-195` (`resolveRetryPolicy`).
- `packages/llm/llm/src/attribution.ts:46-68` (`attributionHeaders`, required on provider requests).
- `packages/credentials/authorization/src/index.ts:90-143` (session/flow interfaces),
  `:189-225` (`registerFlow`, `DUPLICATE_FLOW`), `:283-323` (`begin`), `:361-447` (commit
  verification, `NOT_COMMITTED`).
- `packages/credentials/authorization/src/types.ts:10-91` (notices/prompts entries).
- `packages/credentials/credentials/src/index.ts:19-92` (key/ref grammar and helpers),
  `:171-305` (service methods and notifications).
- `packages/credentials/credentials/src/types.ts:29-60` (`CredentialKey`, `GrantRecord`).
- `packages/credentials/credentials-local/src/index.ts:345-357` (grant parse), `:392-418`
  (JSON-round-trip validation), `:660-740` (`modifyRecord`/`deleteRecord` file lock).
- `packages/llm/llm-deepseek/src/adapter.ts:22-59` (adapter shape + dispatch), `:65-89` (stream
  wrapper/abort), `:138-150` (headers incl. session id).
- `packages/llm/llm-deepseek/src/translate.ts:104-165` (chunk emission order).
- `packages/llm/llm-pi-ai/src/adapter.ts:231-458` (adapter lifecycle, `prepareCall`, `stream`),
  `:291-312` (`providerRetryPolicy`, `listModels` credential rule).
- `packages/llm/llm-pi-ai/src/auth.ts:29-38` (`recordKeyFor`), `:102-186` (credential store mapping).
- `packages/llm/llm-pi-ai/src/login.ts:131-171` (`registerFlow` working example).
- `packages/llm/llm-deepseek-api-key/src/index.ts` (minimal plugin: directory + adapter + credential).
- `packages/core/agent-loop/src/agent.ts:453` (`preparedCall.stream` / `llm.stream`), `:600-616`
  (`prepareCall` and only-`NO_ADAPTER` tolerance), `:449-483` (chunk loop + `throwIfAborted`).
- `packages/core/agent-loop/src/assistant-stream.ts:19-20,66-84` (`BlockAssembler` consumption).
- `packages/api/session-controller/src/catalog.ts:20-62` (`buildModelCatalog`), `:78-92`
  (`modelAvailable`).
- `packages/client/ui-settings-models/src/client/store.ts:45-77` (`joinProviderDirectory`).
- `packages/core/agent-default-model/src/index.ts:51-94` (`currentSelection`, `saveSelection`).
- `packages/client/modules/src/client/manifest.ts:40-190` (`dsh.client` schema), `:199` (the
  `./client` export requirement); `packages/client/modules/src/index.ts:556-585` (ModuleLoader
  protocol), `:847` (missing `./client` error).
- `packages/client/web/src/platform.ts` (baseline browser module table).
- `packages/bundle/base/cordis.patch.yml:99-127` (`llm-retry`, `authorization`, `credentials`),
  `:348-349` (`token-meter`), `:414-415` (`spill-policy`).
- `packages/boot/app-boot/src/plugin-compatibility.ts:84-125` (engines-vs-peers preflight).
- `packages/boot/app-boot/README.md` ("One runtime resolution", failure table, bundle loading);
  `.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.md` §1-§3 and
  Table 3 (linked-root peer interception).
- `packages/client/connection/src/rpc.ts:98-104,228-240` (`requestRejection`).
- `packages/host/webserver/src/index.ts:47-53` (`WebRoute`, duplicate-path throw).

### Installed rc.5 build — `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`

- `dsh/package.json` (runtime `0.2.1-rc.5`; dependency table).
- `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` (`findInterceptionLayer`,
  `readPeerNames`, `routeLinked`, `unmetRequirements`).
- `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`
  (`settings.section` list/root declaration, section label/order/props).
- `dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`
  (`settings.models.sign-in` only inside DeepSeek onboarding; no generic sign-in UI).
- `dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`, `dsh-credentials/lib/index.js`,
  `dsh-authorization/lib/index.js` (export lists and retry defaults quoted above).

### PRIOR ART — `/Users/jeff/.dsh/profiles/web/node_modules/dsh-codex`

- `package.json` (bundle + `dsh.client` + peers), `cordis.patch.yml` (rows),
  `lib/index.js` + `lib/client.js` (built entry points and import surface).
- `src/index.ts:94-96,268-366` (name/inject/apply, adapter registration at `:312-325`).
- `src/adapter.ts:527-674` (`PiAiAdapter` subclass, response runtime, retry policy `:415-422`).
- `src/store.ts` (own credential file store), `src/oauth-browser.ts:36-127` (PKCE/loopback/paste
  fallback), `src/oauth-provider.ts` (pi-ai provider override/refresh), `src/usage.ts` (usage
  endpoint), `src/responses.ts:23-24,459-475` (Codex endpoint + headers), `src/auth-routes.ts`
  (`webServer` routes `:834-1154`, origin guard `:485-512`, redaction `:121-133`),
  `src/client/index.tsx:70-104` (settings section registration),
  `src/client/OpenAICodexSettings.tsx:23-36,660-690` (polling/fetch pattern).

### LOCAL — `/Users/jeff/Documents/DEV/dsh-codex-plugin/bundle/lib`

- `siwc.js` — SIWC constants/endpoints (`:20-60`), PKCE (`createPkce`), authorization request
  (`createAuthorizationRequest`), callback parsing, token exchange (`exchangeCode`), refresh
  (`refreshCredentials`), plan model catalog (`fetchPlanModels`).
- `oauth.js` — `FLOW_KEY`, `openBrowser`, loopback `startCallbackServer`, `runLoginFlow`
  (`notify` → browser → callback → exchange → registration → `session.commit`), `runLogout`.
- `store.js` — `CREDENTIAL_SCOPE/KEY`, `REGISTRATION_KEY`, `PlanError`, record read/write helpers,
  `singleFlight`, `ensureAccessToken`, `refreshNow` (fix per §8.3).
- `responses.js` — `UNSUPPORTED_PARAMS`, `failureFromHttp` (fix codes per §7.2), `buildRequestBody`
  (add `options.system`), `StreamState` (chunk mapping), `planStream` (SSE parse; fix CRLF boundary,
  empty-response, usage disjoint counts).
- `models.js` — `KNOWN_MODELS`, `modelInfo`, `fallbackModels`, `orderModels` (validator-compliant).
- `adapter.js` — duck-typed adapter; add `providerRetryPolicy`, `prepareCall`,
  `imageRequestPricing`, `imageRequestTarget` per §4.2.

### Reference implementation + adjacent team research

- `/Users/jeff/Documents/DEV/dsh-codex-plugin/research/ref/chatgpt_plan_auth/chatgpt_plan_auth/`
  (MIT, v1.0.2 — the Home Assistant SIWC port): `const.py:18-20` (loopback `127.0.0.1`, only the port
  may vary; SIWC endpoints/scopes/error codes), `requests.py`/`client.py` (forbidden params,
  `store:false`+`stream:true`, system→`instructions` folding, 401 refresh-once), `catalog.py`
  (`payload.models[].slug` non-standard catalog body).
- `/Users/jeff/Documents/DEV/dsh-codex-plugin/research/02-siwc-wire.md` — SIWC wire contract
  (`POST https://api.openai.com/v1/responses`, SSE event table, `response.failed`/`[DONE]`,
  forbidden params/tools, reasoning replay caveats, error-code mapping).
- `/Users/jeff/Documents/DEV/dsh-codex-plugin/research/03-dsh-ui.md` — client half, slots, HTTP route
  pattern, and the "no generic authorization UI in rc.5" finding.

---

## 16. Open questions for the Lead / wire team

1. Exact SIWC wire contract: now documented in `research/02-siwc-wire.md` (endpoint
   `POST https://api.openai.com/v1/responses`, SSE events, `store:false`+`stream:true`, forbidden
   params/tools, `response.failed`/`[DONE]` handling, plan scope). The adapter/chunk contract in
   §4-§7 is wire-agnostic; re-check the wire doc for any item this document predates.
2. Whether to keep `llm-pi-ai`'s `openai-codex` route in the desktop profile once our route works
   (double sign-in UX; profile patch currently enables it).
3. Whether the Client half ships in the same bundle now or after the Host flow is verified (host-only
   is installable today; the Settings page is additive).
4. Whether to take `@deepseek-ai/schemastery` (+ peers) for `Config`, or stay zero-import and document
   plain config keys.
5. Usage/quota display source (prior art reads `https://chatgpt.com/backend-api/wham/usage` with
   Codex tokens; plan-usage tokens may or may not be accepted there — this is wire-team territory and
   optional for v1).
