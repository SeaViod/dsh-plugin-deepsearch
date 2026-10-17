# Changelog

All notable changes to `dsh-plugin-deepsearch` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-17

Marketplace-ready and generalized release. The package now installs as a DSH bundle, no
longer assumes a specific built-in search provider, and ships a bilingual UI. `0.1.x`
installs were manual and must be migrated (see below).

### Added

- **Bundle install support.** `dsh.bundle.patch` in `package.json` plus a root
  `cordis.patch.yml`, so `dsh plugin add` / plugin-market installs are installable: the package is
  recorded under `dsh.profile.bundles` in the profile `package.json` and the bundle layer applies
  the patch at boot. Declaring only `dsh.client` is treated as "not installable" by the
  awesome-dsh-plugin registry; the bundle patch fixes that.
- **Full configuration schema** (profile patch `config` block or bundle config): inline or
  referenced API key, `apiKeyEnv`, `baseURL`, `searchPath`, `fetchPath`, `keyFile`,
  `count`, `needContent`, `timeoutMs`, `retryCount`, `retryDelayMs`, `maxFetchChars`,
  `providerId`, `fallbackProvider`, `fallbackOnError`, `language`, `checkQuery`. Invalid
  values are normalized instead of throwing.
- **`POST /deepsearch/key`** and a password key editor in the settings page: save writes the
  key file with best-effort mode `0600`, clear deletes it; the key is never echoed back,
  logged or exposed in the state snapshot.
- **Bilingual client UI** (English / Chinese) through the `dsh-plugin-deepsearch` locale
  namespace: settings tab, sidebar switch, status helpers and host tool rendering follow the
  resolved language (`language` config, then `DSH_LANGUAGE` / `DSH_LOCALE` / `LANG` /
  `LC_ALL`, then English).
- **Configurable endpoints, provider id and retry policy**; the HTTP client's
  `User-Agent` now uses the package version.
- `engines.dsh` with explicit prerelease branches
  (`>=0.1.7-rc.1 <0.2.0 || >=0.2.0-rc.1 <0.3.0-0`), so hosts such as `0.2.0-rc.2` resolve
  instead of being silently excluded.
- Package metadata for the registry and npm: `keywords`, `icon`, `repository`, `homepage`,
  `bugs`, `publishConfig` (`access: public`, npmjs registry) and a `files` allowlist;
  `private` removed so the package can be published.
- Project documentation and repo hygiene: English `README.md` + `README.zh.md`,
  `CHANGELOG.md`, `PUBLISHING.md` (maintainer/marketplace checklist), MIT `LICENSE`,
  `.gitignore`, `icon.svg`.
- `test/package.test.mjs`: manifest, bundle patch, docs, no-local-paths and version
  consistency checks (pure Node, no YAML dependency).

### Changed

- **Provider routing no longer hardcodes `deepseek-official`.** The previously active
  provider is captured when routing ON and restored when routing OFF, with a heuristic
  fallback (`fallbackProvider`, then the first available other provider). Turning OFF
  never sets an empty provider id; if no fallback exists it reports an error and keeps the
  current provider.
- Provider-level error fallback resolves its target the same way (excluding this plugin's
  provider) and records `kind: 'provider.fallback'`; with `fallbackOnError: false` the
  original structured error propagates. Cancellation and timeouts still never fall back.
- **Version has a single source of truth** in `package.json`; the host reads it at load time
  and falls back to `0.0.0`. No version literals in code or docs.
- Retry loop honors `retryCount` on `408`/`429`/`5xx` with `retryDelayMs` between attempts.
- Tests rebuilt: host suite against a fake Cordis environment with mocked `fetch`, client
  suite against a fake module loader / React / locale, and the new packaging suite.
- All code comments are English; the `__internals` test surface was extended
  (`DEFAULT_CONFIG`, `normaliseConfig`, `resolveLanguage`, endpoints, key path helpers,
  `packageMeta`, ...) and `DEFAULT_PREVIOUS_PROVIDER` was removed.

### Fixed

- A repo that only declared `dsh.client` was rejected by the marketplace as not installable;
  the package now declares `dsh.bundle.patch` and ships the root `cordis.patch.yml`.
- Retries were limited to a hardcoded two-attempt loop; they now follow the configured
  retry policy.
- Diagnostics/state could drift from the package version; both now derive name and version
  from `package.json`.

### Upgrade notes

- **0.1.x → 0.2.0 (manual installs):** remove the hand-written insert row
  (`id: deepsearch`, `name: dsh-plugin-deepsearch`) from the profile's `cordis.patch.yml`
  before installing 0.2.0 as a bundle. A leftover hand-written row plus a bundle install would
  load the plugin twice; the bundle install itself is recorded in the profile `package.json`
  under `dsh.profile.bundles` and applies the package's own `cordis.patch.yml` at boot. Mode/key
  files under `$DSH_HOME` are preserved.
- `web` profile installs use `dsh plugin --profile web add dsh-plugin-deepsearch`; the
  Desktop app uses the desktop profile / plugin-market UI.

## [0.1.1] - prior release

Initial published version, installed manually with one insert row in the profile's
`cordis.patch.yml`.

### Added

- Switch for DSH's built-in `web_search` between the DeepSeek Search API
  (`POST /v1/tools/search`) and the default account search, with immediate effect and mode
  persistence in `$DSH_HOME/deepsearch-mode.json`.
- Search provider `deepseek-search-api` with automatic fallback on errors (missing key,
  401, network errors, exhausted retries); cancellation and timeouts never fall back.
- Settings page under Settings → Built-in plugins with a switch, status details, endpoint test and
  hints, plus a sidebar footer switch.
- Model tool `deepsearch` with `status`, `on`, `off`, `search`, `fetch` and `check` actions.
- Key resolution from the patch config, DSH credentials, environment variables, a key file
  or `$DSH_HOME/.env`; key values never logged or echoed.
- CSRF-guarded local routes under `/deepsearch/` (`state`, `mode`, `check`), a diagnostics
  file at `$DSH_HOME/deepsearch-diag.json`, and zero runtime dependencies.

[0.2.0]: #020---2026-10-17
[0.1.1]: #011---prior-release
