# dsh-plugin-deepsearch

[![npm](https://img.shields.io/npm/v/dsh-plugin-deepsearch)](https://www.npmjs.com/package/dsh-plugin-deepsearch)
[![GitHub](https://img.shields.io/badge/github-SeaViod%2Fdsh--plugin--deepsearch-181717?logo=github)](https://github.com/SeaViod/dsh-plugin-deepsearch)

Switch DSH's built-in `web_search` between the **DeepSeek Search API** (`POST /v1/tools/search`) and DSH's default account search — with automatic fallback, a settings page, a sidebar switch and a model-facing tool.

English | [中文说明](README.zh.md)

- **ON (`deepseek-api`)** — the built-in `web_search` tool is served by the DeepSeek Search API. This is a paid API: successful requests are billed by DeepSeek; check the current pricing in your DeepSeek console before enabling it.
- **OFF (`builtin`)** — the default DSH route: server-side account search (one search consumes one model turn).
- Switching is **immediate** and survives restarts: the mode is persisted in `$DSH_HOME/deepsearch-mode.json`.
- **It never makes search unavailable.** With no key, a 401, a network error, or 429/5xx retries exhausted, the provider falls back to the previous (or another available) search provider and reports the reason in `lastError`.
- **Zero runtime dependencies** — only `node:` builtins and the global `fetch`. No build step.
- Settings page and sidebar switch are localized in **English and Chinese**.

## What it does

The plugin has two halves that work together:

| Half | File | Responsibility |
|---|---|---|
| Host | `index.js` | Registers the model tool `deepsearch`, registers a search provider (default id `deepseek-search-api`), routes `web.searchProviderId` on/off, exposes four HTTP routes under `/deepsearch/`, and resolves the API key. |
| Browser | `client.js` | Hand-written bundle loaded through `window.__ModuleLoader__.load(...)`: the settings tab and the sidebar footer switch. |

`cordis.patch.yml` is the bundle patch: a `dsh plugin add` or plugin-market install puts the package into the profile's `node_modules` (recorded in the profile `package.json` under `dsh.profile.bundles`), and the bundle layer applies this patch at boot — you do not need to edit the profile patch by hand.

## Three entry points

| Entry point | Where | What it is for |
|---|---|---|
| Settings page | **Settings → Built-in plugins → DeepSeek Search** | switch, status details, endpoint test, API key editor |
| Sidebar switch | Footer of the left sidebar | one-click toggle that shows the current route (`API` / `builtin`) |
| Model tool | `deepsearch` (`status` / `on` / `off` / `search` / `fetch` / `check`) | toggle the route or run a search from a conversation |

## Install

### From the plugin market

Search for **dsh-plugin-deepsearch** (or "DeepSeek Search") in the DSH plugin market and install it. The storefront uses the package's `dsh.bundle.patch`, so the host half is registered automatically. After installing, the new settings tab appears under **Settings → Built-in plugins → DeepSeek Search**; a browser page reload may be needed the first time so the client bundle is picked up.

### From the command line

```pwsh
# Install into the default profile
dsh plugin add dsh-plugin-deepsearch

# Or target a profile explicitly: `web` for a `dsh web` server
dsh plugin --profile web add dsh-plugin-deepsearch
```

Installing for the **Desktop app** uses the desktop profile / the in-app plugin market UI (the Desktop app keeps its profile under its own DSH home; no user-home path has to be typed by hand). The plugin's browser half declares `dsh.client.platform: "web"`, which is what the desktop shell also loads.

If you are installing from a checkout rather than the registry, `npm pack` the folder and `dsh plugin add` the resulting tarball.

### Upgrading from 0.1.x

0.1.x had no bundle patch; it was installed by hand with one insert row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: deepsearch
      name: dsh-plugin-deepsearch
```

0.2.0 ships `dsh.bundle.patch` (`cordis.patch.yml` at the package root). A `dsh plugin add` or plugin-market install does **not** write an insert row into the profile patch: it installs the package into the profile's `node_modules`, records it in the profile's `package.json` under `dsh.profile.bundles`, and the bundle layer applies the package's own `cordis.patch.yml` at boot. **Remove the old hand-written insert row before installing 0.2.0 as a bundle** — a leftover hand-written row plus a bundle install would load the plugin twice. Mode and key files under `$DSH_HOME` are kept, so the switch state and the key file survive the upgrade.

The profile name depends on the client: use `dsh plugin --profile web add dsh-plugin-deepsearch` for a `dsh web` server; the Desktop app uses the `desktop` profile and its plugin-market UI. Do not type a full profile path — let `dsh plugin` resolve it.

### Uninstall

Remove the package from the profile (or uninstall it from the plugin market). The plugin does not add other files to the profile. The state file `$DSH_HOME/deepsearch-mode.json`, the diagnostics file `$DSH_HOME/deepsearch-diag.json` and the optional key file `$DSH_HOME/deepsearch-key.txt` can be deleted, or left in place if you plan to reinstall.

## Configuration

Configuration is read from the `config` block of the plugin's entry in the profile patch, and is normalized so that invalid values fall back to the defaults instead of throwing:

```yaml
- insert:
    - id: deepsearch
      name: dsh-plugin-deepsearch
      config:
        apiKeyEnv: DEEPSEEK_API_KEY
        count: 8
        retryCount: 1
```

All keys are optional. The table below matches the host config schema; the `config` block is also what a bundle install can carry.

| Key | Default | Normalisation / meaning |
|---|---|---|
| `apiKey` | `''` | API key given inline. String, trimmed; empty means "unset". Not recommended: it stays in the patch file. Never echoed back by any route. |
| `apiKeyEnv` | `'DEEPSEEK_API_KEY'` | Name of the credentials reference / environment variable to resolve. Must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, otherwise the default is used. |
| `baseURL` | `'https://api.deepseek.com'` | API base URL. Trimmed; must parse as an `http(s)` URL; trailing slashes are stripped. |
| `searchPath` | `'/v1/tools/search'` | Search endpoint path (appended to `baseURL`). Trimmed, forced to start with `/`; a `?` or `#` rejects the value; empty falls back to the default. |
| `fetchPath` | `'/v1/tools/fetch'` | Page-fetch endpoint path (same rules as `searchPath`). |
| `keyFile` | `''` | Key file for the file-based key. `''` means `$DSH_HOME/deepsearch-key.txt`; `~/...` expands to the home directory; a relative path resolves under `$DSH_HOME`; anything else is used as an absolute path. |
| `count` | `8` | Number of search results. Integer, clamped to 1..50. |
| `needContent` | `false` | Ask the search API for page content (direct `deepsearch search` calls only). Only a strict `true` enables it. |
| `timeoutMs` | `30000` | Timeout per HTTP attempt. Integer, clamped to 1000..120000. |
| `retryCount` | `1` | Extra attempts after the first one (on 408/429/5xx). Integer, clamped to 0..3. |
| `retryDelayMs` | `1200` | Delay between retry attempts. Integer, clamped to 100..10000. |
| `maxFetchChars` | `20000` | Maximum characters returned by `fetch`/the `search` tool when content is requested. Integer, clamped to 1000..200000. |
| `providerId` | `'deepseek-search-api'` | Search provider id to register. Must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` and must not collide with an existing provider, except for the plugin's own re-registration. |
| `fallbackProvider` | `''` | Preferred fallback provider id used when switching OFF. Empty means auto-detect (the previously active provider, then the first available provider that is not ours). |
| `fallbackOnError` | `true` | When the Search API call fails, fall back to another provider. Only a strict `true` enables it. |
| `language` | `'auto'` | `auto` / `en` / `zh`. `auto` resolves from `DSH_LANGUAGE`, `DSH_LOCALE`, `LANG`, `LC_ALL` (Chinese locales map to `zh`, everything else to `en`). |
| `checkQuery` | `'DeepSeek'` | Query used by the "test endpoint" button. Trimmed, non-empty, at most 128 characters. |

The normalized `config` is exposed read-only through the plugin status (and the `deepsearch` tool's `status` action) **without** `apiKey`. The key itself is never part of diagnostics, logs or any response body.

## API key

The Search API needs a DeepSeek API key. Keys are resolved in this order, first match wins:

1. **`apiKey`** in the patch `config` (inline; not recommended).
2. **DSH credentials** for `apiKeyEnv` (default `DEEPSEEK_API_KEY`) — the same credentials reference DSH's own **Settings → Built-in plugins → Web Search** page saves into. This plugin reuses it.
3. **Environment variable** `process.env[apiKeyEnv]`.
4. **Key file** (`keyFile`, default `$DSH_HOME/deepsearch-key.txt`, first line is the key). The plugin's settings page can save and clear this file for you.
5. **`$DSH_HOME/.env`** — a line `DEEPSEEK_API_KEY=sk-...` (the variable name follows `apiKeyEnv`).

Check the result in the settings page or with `deepsearch status`: `key.configured` tells you whether a key was found, `key.kind` is one of `config`, `credentials`, `env`, `file`, `env-file`, and `key.source` carries the exact origin (env-var name or file path). `key.hint` gives the same information in the current UI language.

Key handling rules:

- The key is only read when a request is made; it is never printed, logged, put into the diag file or returned by a route.
- The plugin settings page has a password input with **Save** / **Clear** buttons. Saving writes the key to the configured key file with best-effort file mode `0600`; the value is never rendered back after saving.
- **No key does not break search.** The switch can stay ON, and the provider will fall back to the default account search, reporting the reason.

## Switching and fallback

- Turning the switch **ON** records the currently active search provider (if it is not this plugin's) as `previousProviderId`, then sets `web.searchProviderId` to this plugin's provider.
- Turning it **OFF** restores, in order: the remembered previous provider (if it is still registered), the configured `fallbackProvider`, the first registered provider that is not ours and is not marked unavailable, and finally the remembered previous provider as a best guess. If no other provider exists, the current provider is kept and the switch reports an error instead of setting an empty id. The plugin never hardcodes `deepseek-official`.
- **Provider error fallback:** if `fallbackOnError` is true and the Search API call fails (missing key, 401, network error, retries exhausted), the same resolution picks another provider and returns its result. The report records `kind: 'provider.fallback'`. With `fallbackOnError: false` the original structured error is thrown.
- **Cancellation and timeouts never fall back** — once the caller aborts or the request times out, no hidden account search is started.
- The provider's `available()` always returns `true`, so a missing key or an API outage never makes the built-in `web_search` disappear; it degrades to the fallback instead.

## Settings page and sidebar switch

- **Settings → Built-in plugins → DeepSeek Search**: switch (`role="switch"` with ARIA attributes), status lines, a "test endpoint" button, a details grid (mode, active provider, key source, search/fetch endpoints, result count, last call, last error), the API key editor, a hint when no key is configured, and wiring warnings from diagnostics. The page polls the state every 5 seconds.
- **Sidebar footer switch**: a one-click toggle that shows whether the `API` route or the `builtin` route is active, with a localized tooltip. It polls every 8 seconds.

All page copy comes from the plugin's own `dsh-plugin-deepsearch` locale dictionary (Chinese and English), so it follows the DSH language automatically.

## Model tool

The host registers one model-facing tool named `deepsearch`:

| Action | What it does |
|---|---|
| `status` | Returns the current mode, provider routing, key status (without the key), endpoints, last result/error. |
| `on` / `off` | Toggles the route through the same logic as the UI switch. |
| `search` | Calls the Search API directly with `{ query, count?, needContent? }`; falls back on error when enabled. |
| `fetch` | Fetches one URL through `/v1/tools/fetch` and returns truncated content plus metadata. |
| `check` | One minimal endpoint check (a single query), used by the "test endpoint" button and as a smoke test. |

You can simply ask the agent to "enable DeepSeek search" / "关闭 DeepSeek 搜索"; the tool description tells the model where the settings page lives and that configuration belongs in the profile patch.

## HTTP routes

The browser half talks to the host over four routes under `/deepsearch/`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/deepsearch/state` | Status snapshot (never contains the key). |
| `POST` | `/deepsearch/mode` | Set the mode: `{ "mode": "on" }` / `{ "mode": "off" }`. |
| `POST` | `/deepsearch/check` | Single-flighted endpoint check. |
| `POST` | `/deepsearch/key` | Save or clear the key file: `{ "action": "save", "key": "..." }` / `{ "action": "clear" }`. Never echoes the key. |

These routes are not covered by DSH connection authentication, so the host guards them itself: only the expected method is accepted, POSTs must be `content-type: application/json` and same-origin (`Origin`/`Host`), `Sec-Fetch-Site: cross-site` is rejected, and `/check` is single-flighted. This blocks ordinary CSRF but is not a substitute for authentication — keep the DSH web server bound to localhost.

## Security and reliability

- `apply()` never throws; broken configuration is normalized instead of crashing the host.
- API keys are never logged, echoed, persisted by routes or included in the state snapshot; the only write is the explicit save action (file mode `0600`, best effort on Windows).
- Cancellation/timeouts never trigger a fallback search, and a fallback failure ends in a structured error rather than a silent retry elsewhere.
- Retries are limited to `retryCount` extra attempts on `408`/`429`/`5xx` with a configurable delay; `401` maps to a credentials error, not a retry loop.
- `lastError` is recorded with an English scope string and cleared by the next successful call, so the page does not show a stale error forever.
- Zero runtime dependencies and no build step: only Node builtins and global `fetch`.

## Compatibility

- **DSH:** `>=0.1.7-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0-0` (declared as `engines.dsh` in `package.json`). The explicit prerelease branches are what make hosts such as `0.2.0-rc.2` resolve; a single broad range would silently exclude them.
- **Node:** `>=20` for the host half and the test suite (verified on Node 24).
- **Profiles:** `web` (browser-served DSH) and the Desktop app; the browser half declares `dsh.client.platform: "web"`.
- **No third-party packages**, no post-install scripts, no `allowBuilds`-style build approval needed.

## Development and tests

The repository is a plain ESM package with zero dependencies; nothing has to be installed to run the tests. All test files are plain Node scripts that print `ok`/`FAIL` and exit non-zero on failure (no test framework), and the suite is offline — host/client tests mock `fetch`.

```sh
node test/package.test.mjs   # manifest, bundle patch, docs and version consistency
node test/host.test.mjs      # host half, with a fake Cordis context and mocked fetch
node test/client.test.mjs    # client bundle, with a fake module loader/react/locale
```

Or run all three in order:

```sh
npm test
```

`npm publish` runs the same suite through `prepublishOnly`. CI should run `npm test` on Node 20/22/24 with no `npm install` step; that is enough to keep the package marketplace-ready (see [PUBLISHING.md](PUBLISHING.md)).

## Files

| File | Purpose |
|---|---|
| `index.js` | Host half: `deepsearch` tool, search provider, route switching, HTTP routes, key resolution. |
| `client.js` | Browser half: settings tab + sidebar switch (hand-written bundle, no build step). |
| `cordis.patch.yml` | Bundle patch that registers the host half on `dsh plugin add`. |
| `package.json` | Package manifest, `dsh.bundle` / `dsh.client` metadata, version source of truth. |
| `README.md` / `README.zh.md` | English / Chinese documentation (this file and its translation). |
| `CHANGELOG.md` | Version history. |
| `PUBLISHING.md` | Maintainer checklist: repo identity, npm publish, marketplace submission. |
| `LICENSE` | MIT. |
| `icon.svg` | Square icon used by the plugin market. |
| `test/` | Packaging, host and client test suites. |

## License

[MIT](LICENSE). Copyright (c) 2026 SeaViod.

Questions or bug reports: [open an issue](https://github.com/SeaViod/dsh-plugin-deepsearch/issues).
