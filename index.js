/**
 * dsh-plugin-deepsearch — host half.
 *
 * Adds a switch that routes DSH's built-in `web_search` tool through the
 * DeepSeek Search API (POST /v1/tools/search, plus /v1/tools/fetch for page
 * text) instead of DeepSeek's server-side account search. The switch is
 * persisted in `$DSH_HOME/deepsearch-mode.json` and can be flipped from the
 * settings page, the sidebar footer, or the `deepsearch` model tool.
 *
 * What this half does:
 *   1. Registers a `ctx.web` search provider whose id comes from config
 *      (default `deepseek-search-api`) and calls the Search API.
 *   2. Routes `ctx.web.searchProviderId` to that provider when the switch is
 *      ON, and back to the previously active provider (never a hardcoded id)
 *      when it is OFF.
 *   3. Registers the `deepsearch` model tool: status / on / off / search /
 *      fetch / check.
 *   4. Registers same-origin JSON routes under `/deepsearch/*` for the client
 *      half: state, mode, check and key.
 *
 * Safety design:
 *   - Missing key / API failure falls back to the captured account-search
 *     provider inside `search()`, so the built-in `web_search` never becomes
 *     unavailable because of this plugin. Cancellation never falls back.
 *   - Page routes bypass DSH connection auth, so they enforce method, same
 *     Origin/Host, `Sec-Fetch-Site` and JSON content-type themselves. The
 *     webserver should keep listening on 127.0.0.1 only.
 *   - The API key is resolved from config / credentials / env / key file /
 *     `$DSH_HOME/.env`, is never echoed, logged or persisted except by the
 *     explicit `/deepsearch/key` save route (mode 0600, best effort).
 *   - `apply()` never throws: a failing plugin would otherwise abort DSH
 *     startup. Wire-up problems are recorded in
 *     `$DSH_HOME/deepsearch-diag.json` instead.
 *
 * Zero runtime dependencies: only `node:` builtins and the global `fetch`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name (stable, unchanged from 0.1.x). */
export const name = 'deepsearch'

/** The `tools` service is required; web / webServer / credentials / shellEnv are optional enhancements. */
export const inject = ['tools']

/** npm package name, used for `status.name` and the User-Agent. */
const PLUGIN_ID = 'dsh-plugin-deepsearch'
const PACKAGE_NAME = 'dsh-plugin-deepsearch'

/** Fallback used only when package.json cannot be read (should never happen at runtime). */
const FALLBACK_VERSION = '0.0.0'

/** Default search provider id; config may override it. */
const DEFAULT_PROVIDER_ID = 'deepseek-search-api'

/** Exported route paths, shared by registration and diagnostics. */
const ROUTE_PATHS = ['/deepsearch/state', '/deepsearch/mode', '/deepsearch/check', '/deepsearch/key']

/** Accepted values for `config.language` ('auto' resolves from the environment). */
const LANGUAGES = ['auto', 'en', 'zh']

/** Env-var name validation for `config.apiKeyEnv`. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Provider-id validation for `config.providerId`. */
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** Key-file save validation (single token, 8..512 chars, no whitespace). */
const KEY_TOKEN_RE = /^\S{8,512}$/u

/** Package identity is read once at module load; package.json stays the single version source. */
function readPackageMeta() {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return {
      name: typeof parsed?.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : PACKAGE_NAME,
      version: typeof parsed?.version === 'string' && parsed.version.trim() !== '' ? parsed.version.trim() : FALLBACK_VERSION,
    }
  } catch {
    return { name: PACKAGE_NAME, version: FALLBACK_VERSION }
  }
}

export const packageMeta = readPackageMeta()

/** Config defaults; every value is normalised before use (see `normaliseConfig`). */
const DEFAULT_CONFIG = {
  apiKey: '',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
  searchPath: '/v1/tools/search',
  fetchPath: '/v1/tools/fetch',
  keyFile: '',
  count: 8,
  needContent: false,
  timeoutMs: 30000,
  retryCount: 1,
  retryDelayMs: 1200,
  maxFetchChars: 20000,
  providerId: DEFAULT_PROVIDER_ID,
  fallbackProvider: '',
  fallbackOnError: true,
  language: 'auto',
  checkQuery: 'DeepSeek',
}

/**
 * Mutable runtime state shared by the tool and the HTTP routes.
 * `previousProviderId` is captured from `web.searchProviderId` at wire-up
 * time; there is deliberately no hardcoded default provider id.
 */
const runtime = {
  mode: 'off',
  previousProviderId: '',
  providerRegistered: false,
  routeApplied: false,
  providerObject: null,
  disposeProvider: null,
  /** Provider ids this plugin has registered during this process (HMR-safe). */
  ownProviderIds: new Set(),
  lastResult: null,
  lastError: null,
  updatedAt: null,
  services: { web: false, webServer: false, credentials: false, shellEnv: false },
  diag: {
    name: packageMeta.name,
    version: packageMeta.version,
    tool: false,
    provider: false,
    routes: [],
    errors: [],
  },
}

// ---------------------------------------------------------------------------
// Paths and small utilities
// ---------------------------------------------------------------------------

/** DSH home directory: `$DSH_HOME`, else `~/.dsh`. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

/** Env file read as the last key source. */
function envFilePath() {
  return join(dshHome(), '.env')
}

/** Persisted switch state. */
function modeFilePath() {
  return join(dshHome(), 'deepsearch-mode.json')
}

/** Startup/wire-up diagnostics. */
function diagFilePath() {
  return join(dshHome(), 'deepsearch-diag.json')
}

/** Effective key file: normalised config value (default `$DSH_HOME/deepsearch-key.txt`). */
function keyFilePath() {
  return cfg.keyFile
}

function nowIso() {
  return new Date().toISOString()
}

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Build an Error with a machine-routable `code` (same shape as DSH WebError). */
function makeError(code, message, cause) {
  const error = new Error(message)
  error.name = 'WebError'
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError'
}

/** Cancellation/timeout is not an API failure: it must never trigger a fallback search. */
function isCancellation(error, signal) {
  return signal?.aborted === true || error?.code === 'WEB_ABORTED' || isAbortError(error)
}

/** Parse an integer and clamp it into [min, max]; invalid input falls back to `fallback`. */
function clampInt(value, min, max, fallback = min) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function normaliseString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Strip at most one wrapping pair of quotes from a key-looking string. */
function normaliseKey(value) {
  if (typeof value !== 'string') return undefined
  let text = value.trim()
  if (text === '') return undefined
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim()
  }
  return text === '' ? undefined : text
}

// ---------------------------------------------------------------------------
// Config normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise `config.keyFile`:
 *   ''        -> `$DSH_HOME/deepsearch-key.txt`
 *   `~/...`   -> expanded against the home directory
 *   relative  -> resolved under `$DSH_HOME`
 *   absolute  -> used as-is
 */
function normaliseKeyFile(value) {
  try {
    const home = dshHome()
    const raw = normaliseString(value)
    if (raw === '') return join(home, 'deepsearch-key.txt')
    if (raw === '~') return homedir()
    if (/^~[\\/]/u.test(raw)) return join(homedir(), raw.slice(2))
    if (isAbsolute(raw)) return resolve(raw)
    return resolve(home, raw)
  } catch {
    return join(dshHome(), 'deepsearch-key.txt')
  }
}

/** True when `id` is already owned by another plugin (HMR re-registration of our own id is fine). */
function isForeignProviderId(id, web) {
  try {
    if (!(web?.searchProviders instanceof Map)) return false
    const existing = web.searchProviders.get(id)
    if (existing === undefined || existing === null) return false
    if (existing === runtime.providerObject) return false
    if (existing.__deepsearchPlugin === true) return false
    return true
  } catch {
    return false
  }
}

/**
 * Normalise `config.providerId` and avoid clobbering a provider owned by
 * another plugin. Our own id from an earlier apply (HMR) is not a conflict.
 */
function normaliseProviderId(value, web) {
  const raw = normaliseString(value)
  let candidate = PROVIDER_ID_RE.test(raw) ? raw : DEFAULT_PROVIDER_ID
  if (!(web?.searchProviders instanceof Map)) return candidate
  if (!isForeignProviderId(candidate, web)) return candidate
  if (candidate !== DEFAULT_PROVIDER_ID && !isForeignProviderId(DEFAULT_PROVIDER_ID, web)) return DEFAULT_PROVIDER_ID
  // Both ids are taken by other plugins: pick a deterministic free suffix.
  for (let index = 2; index < 100; index += 1) {
    const suffixed = `${DEFAULT_PROVIDER_ID}-${index}`
    if (!isForeignProviderId(suffixed, web)) return suffixed
  }
  return candidate
}

/** `baseURL`: http(s) URL with trailing slashes stripped, else the default. */
function normaliseBaseURL(value) {
  const raw = normaliseString(value)
  if (raw === '') return DEFAULT_CONFIG.baseURL
  const stripped = raw.replace(/\/+$/u, '')
  try {
    const parsed = new URL(stripped)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_CONFIG.baseURL
  } catch {
    return DEFAULT_CONFIG.baseURL
  }
  return stripped
}

/** API path: forced to start with `/`; values containing `?`/`#` or empty fall back. */
function normaliseApiPath(value, fallback) {
  const raw = normaliseString(value)
  if (raw === '' || raw.includes('?') || raw.includes('#')) return fallback
  return raw.startsWith('/') ? raw : `/${raw}`
}

/** Booleans use strict `=== true`; a missing value keeps the documented default. */
function normaliseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback
  return value === true
}

/**
 * Build the effective config from an arbitrary profile-patch object.
 * Never throws for malformed values.
 */
function normaliseConfig(input, web) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const read = (key) => {
    try {
      return source[key]
    } catch {
      return undefined
    }
  }
  const apiKeyEnvRaw = normaliseString(read('apiKeyEnv'))
  const checkQueryRaw = normaliseString(read('checkQuery'))
  const languageRaw = normaliseString(read('language'))
  return {
    apiKey: normaliseString(read('apiKey')),
    apiKeyEnv: ENV_NAME_RE.test(apiKeyEnvRaw) ? apiKeyEnvRaw : DEFAULT_CONFIG.apiKeyEnv,
    baseURL: normaliseBaseURL(read('baseURL')),
    searchPath: normaliseApiPath(read('searchPath'), DEFAULT_CONFIG.searchPath),
    fetchPath: normaliseApiPath(read('fetchPath'), DEFAULT_CONFIG.fetchPath),
    keyFile: normaliseKeyFile(read('keyFile')),
    count: clampInt(read('count'), 1, 50, DEFAULT_CONFIG.count),
    needContent: normaliseBoolean(read('needContent'), DEFAULT_CONFIG.needContent),
    timeoutMs: clampInt(read('timeoutMs'), 1000, 120000, DEFAULT_CONFIG.timeoutMs),
    retryCount: clampInt(read('retryCount'), 0, 3, DEFAULT_CONFIG.retryCount),
    retryDelayMs: clampInt(read('retryDelayMs'), 100, 10000, DEFAULT_CONFIG.retryDelayMs),
    maxFetchChars: clampInt(read('maxFetchChars'), 1000, 200000, DEFAULT_CONFIG.maxFetchChars),
    providerId: normaliseProviderId(read('providerId'), web),
    fallbackProvider: normaliseString(read('fallbackProvider')),
    fallbackOnError: normaliseBoolean(read('fallbackOnError'), DEFAULT_CONFIG.fallbackOnError),
    language: LANGUAGES.includes(languageRaw) ? languageRaw : DEFAULT_CONFIG.language,
    checkQuery: checkQueryRaw === '' ? DEFAULT_CONFIG.checkQuery : checkQueryRaw.slice(0, 128),
  }
}

/** Effective config; replaced wholesale on every `apply()`. */
let cfg = normaliseConfig({})

/** Cordis context, used by tool execution and the HTTP routes after `apply()`. */
let hostCtx = null

// ---------------------------------------------------------------------------
// Language resolution and host-side strings
// ---------------------------------------------------------------------------

/**
 * Resolve the display language:
 *   1. explicit `config.language` ('en' / 'zh');
 *   2. otherwise the first non-empty of DSH_LANGUAGE / DSH_LOCALE / LANG / LC_ALL;
 *   3. `zh` when that value starts with "zh" (case-insensitive), else English.
 */
function resolveLanguage() {
  if (cfg.language === 'en' || cfg.language === 'zh') return cfg.language
  for (const envName of ['DSH_LANGUAGE', 'DSH_LOCALE', 'LANG', 'LC_ALL']) {
    const raw = process.env[envName]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    return /^zh/iu.test(raw.trim()) ? 'zh' : 'en'
  }
  return 'en'
}

/**
 * Host-side user-facing strings. The model tool's `render` and error text,
 * the key hint and route-switch errors follow the resolved language; HTTP
 * bodies stay English + machine codes.
 */
const HOST_TEXT = {
  en: {
    keyHint: (keyFile, envVar) =>
      `No DeepSeek Search API key found. Save one in Settings → Built-in plugins → DeepSeek Search, write sk-... on the first line of ${keyFile}, or set the environment variable ${envVar}.`,
    invalidKey: 'The API key must be a single 8-512 character token without whitespace.',
    routeWebUnavailable: 'The web service is unavailable, so the search route was not changed.',
    routeWebUnavailableOff: 'The web service is unavailable; the saved switch state will be applied once it is ready.',
    routeNoFallback: 'No fallback search provider is available; the active provider was left unchanged.',
    toolUnknownError: 'unknown error',
    toolFailure: (action, code, error) => `deepsearch ${action} failed${code === null ? '' : ` [${code}]`}: ${error}`,
    toolSearchHeader: (value) =>
      `DeepSeek Search API returned ${value.count} result(s) for "${value.query}" (${value.ms}ms, HTTP ${value.httpStatus}, key source: ${value.keySource}${value.modeAtCall === 'on' ? '' : '; note: the switch is currently OFF'})`,
    toolNoResults: '(no results)',
    toolUntitled: '(untitled)',
    toolScoreLabel: 'score',
    toolAuthorityLabel: 'authority',
    toolContentMeta: (chars) => `content: ${chars} chars (need_content=true)`,
    toolTruncated: '\n\n(content truncated)',
    toolCheckOk: (value) =>
      `Search API OK: HTTP ${value.httpStatus}, ${value.ms}ms, key source: ${value.keySource}${value.first === null || value.first === undefined ? '' : `, first result: ${value.first.title} ${value.first.url}`}`,
    toolCheckFail: (value) => `Search API check failed${value.code ? ` [${value.code}]` : ''}: ${value.error}`,
    toolErrorMissingKey: 'No DeepSeek API key is available.',
    toolErrorAborted: 'The request was cancelled or timed out.',
    toolErrorRoute: 'Failed to switch the built-in search route.',
    toolErrorProvider: 'The DeepSeek Search API request failed.',
  },
  zh: {
    keyHint: (keyFile, envVar) =>
      `没有找到 DeepSeek Search API Key。可以在「设置 → 插件 → DeepSeek 搜索」里保存，或把 sk-... 写到 ${keyFile} 的第一行，或设置环境变量 ${envVar}。`,
    invalidKey: 'API Key 必须是 8~512 个不含空白的字符。',
    routeWebUnavailable: 'web 服务不可用，搜索路由没有改变。',
    routeWebUnavailableOff: 'web 服务不可用，保存的开关状态会在服务就绪后生效。',
    routeNoFallback: '没有可用的回退搜索提供方，当前路由保持不变。',
    toolUnknownError: '未知错误',
    toolFailure: (action, code, error) => `deepsearch ${action} 失败${code === null ? '' : ` [${code}]`}：${error}`,
    toolSearchHeader: (value) =>
      `已用 DeepSeek Search API 搜索「${value.query}」：${value.count} 条（${value.ms}ms，HTTP ${value.httpStatus}，key 来源 ${value.keySource}${value.modeAtCall === 'on' ? '' : '；注意：开关当前是关闭状态'}）`,
    toolNoResults: '(没有搜索到结果)',
    toolUntitled: '(无标题)',
    toolScoreLabel: '相关度',
    toolAuthorityLabel: '权威度',
    toolContentMeta: (chars) => `正文 ${chars} 字符（need_content=true）`,
    toolTruncated: '\n\n（正文已截断）',
    toolCheckOk: (value) =>
      `Search API 正常：HTTP ${value.httpStatus}，${value.ms}ms，key 来源 ${value.keySource}${value.first === null || value.first === undefined ? '' : `，示例结果：${value.first.title} ${value.first.url}`}`,
    toolCheckFail: (value) => `Search API 检查失败${value.code ? ` [${value.code}]` : ''}：${value.error}`,
    toolErrorMissingKey: '没有可用的 DeepSeek API Key。',
    toolErrorAborted: '请求被取消或超时。',
    toolErrorRoute: '切换内置搜索路由失败。',
    toolErrorProvider: 'DeepSeek Search API 请求失败。',
  },
}

function hostText() {
  return HOST_TEXT[resolveLanguage()]
}

/** Localised prefix for errors returned by the model tool, plus the raw detail. */
function describeToolError(error) {
  const dict = hostText()
  const detail = describeError(error)
  const code = error?.code ?? null
  const prefix = code === 'WEB_PROVIDER_CREDENTIAL_MISSING'
    ? dict.toolErrorMissingKey
    : code === 'WEB_ABORTED'
      ? dict.toolErrorAborted
      : code === 'ROUTE_SWITCH_FAILED'
        ? dict.toolErrorRoute
        : code === 'WEB_PROVIDER_ERROR'
          ? dict.toolErrorProvider
          : null
  if (prefix === null) return detail
  return `${prefix} ${detail}`
}

// ---------------------------------------------------------------------------
// File helpers (never throw to the caller)
// ---------------------------------------------------------------------------

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function readJsonSafe(file) {
  const text = readTextSafe(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Create the parent directory of `file` (best effort; the write itself decides success). */
function ensureParentDir(file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // Ignore: writeFileSync below records a real error if it fails.
  }
}

function writeJsonSafe(file, value) {
  try {
    ensureParentDir(file)
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch (error) {
    recordError(`write ${file}`, error)
    return false
  }
}

function recordError(scope, error) {
  runtime.diag.errors.push(`${scope}: ${describeError(error)}`)
  if (runtime.diag.errors.length > 40) runtime.diag.errors.splice(0, runtime.diag.errors.length - 40)
}

function writeDiag(extra) {
  writeJsonSafe(diagFilePath(), {
    ...runtime.diag,
    at: nowIso(),
    mode: runtime.mode,
    previousProviderId: runtime.previousProviderId,
    providerRegistered: runtime.providerRegistered,
    routeApplied: runtime.routeApplied,
    services: { ...runtime.services },
    lastError: runtime.lastError,
    lastResult: runtime.lastResult,
    ...(extra !== null && typeof extra === 'object' ? extra : {}),
  })
}

// ---------------------------------------------------------------------------
// Key resolution: config.apiKey → credentials → env → keyFile → $DSH_HOME/.env
// Key values are never printed, logged or persisted unless explicitly saved.
// ---------------------------------------------------------------------------

function getService(serviceName) {
  try {
    if (hostCtx !== null && typeof hostCtx.get === 'function') return hostCtx.get(serviceName)
  } catch {
    // A missing service is not an error here.
  }
  return undefined
}

function keyFromKeyFile() {
  const text = readTextSafe(keyFilePath())
  if (text === undefined) return undefined
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const value = normaliseKey(trimmed)
    if (value !== undefined) return value
  }
  return undefined
}

function keyFromEnvFile() {
  const text = readTextSafe(envFilePath())
  if (text === undefined) return undefined
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (match === null || match[1] !== cfg.apiKeyEnv) continue
    return normaliseKey(match[2])
  }
  return undefined
}

/**
 * Resolve the effective API key.
 * @returns {Promise<{value: string, source: string, kind: string} | undefined>}
 *          The value must never be printed or persisted.
 */
async function resolveKey() {
  const literal = normaliseKey(cfg.apiKey)
  if (literal !== undefined) return { value: literal, source: 'config.apiKey', kind: 'config' }

  const credentials = getService('credentials')
  if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(cfg.apiKeyEnv)
      const value = normaliseKey(hit?.value)
      if (value !== undefined) return { value, source: `credentials:${cfg.apiKeyEnv}`, kind: 'credentials' }
    } catch (error) {
      recordError('credentials.resolve', error)
    }
  }

  const fromEnv = normaliseKey(process.env[cfg.apiKeyEnv])
  if (fromEnv !== undefined) return { value: fromEnv, source: `env:${cfg.apiKeyEnv}`, kind: 'env' }

  const fromKeyFile = keyFromKeyFile()
  if (fromKeyFile !== undefined) return { value: fromKeyFile, source: `file:${keyFilePath()}`, kind: 'file' }

  const fromEnvFile = keyFromEnvFile()
  if (fromEnvFile !== undefined) return { value: fromEnvFile, source: `file:${envFilePath()}`, kind: 'env-file' }

  return undefined
}

/** Key status for the page/tool; never includes the key value. */
async function describeKey() {
  const resolved = await resolveKey()
  const base = { envVar: cfg.apiKeyEnv, keyFile: keyFilePath() }
  if (resolved !== undefined) return { configured: true, source: resolved.source, ...base, kind: resolved.kind }
  return {
    configured: false,
    source: null,
    ...base,
    kind: null,
    hint: hostText().keyHint(keyFilePath(), cfg.apiKeyEnv),
  }
}

/** Persist a key supplied by the explicit POST /deepsearch/key save route. */
function saveKeyFile(rawKey) {
  const candidate = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (!KEY_TOKEN_RE.test(candidate)) return { ok: false, error: hostText().invalidKey }
  try {
    ensureParentDir(keyFilePath())
    writeFileSync(keyFilePath(), `${candidate}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(keyFilePath(), 0o600)
    } catch {
      // Best effort: Windows has no POSIX mode bits and may ignore chmod.
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

/** Remove the saved key file, if any. */
function clearKeyFile() {
  try {
    if (existsSync(keyFilePath())) unlinkSync(keyFilePath())
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

// ---------------------------------------------------------------------------
// Endpoints and HTTP
// ---------------------------------------------------------------------------

function endpointBase() {
  return cfg.baseURL
}

/** Full Search API endpoint (`baseURL + searchPath`). */
function searchEndpoint() {
  return `${endpointBase()}${cfg.searchPath}`
}

/** Full Fetch API endpoint (`baseURL + fetchPath`). */
function fetchEndpoint() {
  return `${endpointBase()}${cfg.fetchPath}`
}

function errorDetail(parsed) {
  if (parsed === null || typeof parsed !== 'object') return ''
  if (typeof parsed.error === 'string') return parsed.error
  if (parsed.error !== null && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') return parsed.error.message
  if (typeof parsed.message === 'string') return parsed.message
  return ''
}

/** Merge the caller's abort signal with our timeout into one AbortSignal. */
function combineSignals(external, timeoutMs) {
  const controller = new AbortController()
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CONFIG.timeoutMs
  const timer = setTimeout(() => {
    try {
      controller.abort(new Error(`Request timed out (${timeout}ms)`))
    } catch {
      // Ignore abort races.
    }
  }, timeout)
  if (typeof timer.unref === 'function') timer.unref()
  const onAbort = () => {
    try {
      controller.abort(external?.reason)
    } catch {
      // Ignore abort races.
    }
  }
  if (external !== undefined && external !== null) {
    if (external.aborted === true) onAbort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (external !== undefined && external !== null) external.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * POST JSON to the configured API. Retries 408/429/5xx up to `config.retryCount`
 * extra attempts with `config.retryDelayMs` between attempts.
 * @returns {Promise<{status: number, body: any, keySource: string, endpoint: string}>}
 */
async function postJson(url, body, options = {}) {
  const key = await resolveKey()
  if (key === undefined) {
    throw makeError(
      'WEB_PROVIDER_CREDENTIAL_MISSING',
      `No DeepSeek API key is available to call ${url}. Write the key on the first line of ${keyFilePath()}, set the environment variable ${cfg.apiKeyEnv}, or save it in Settings → Built-in plugins → DeepSeek Search.`,
    )
  }

  const payload = JSON.stringify(body)
  const attempts = 1 + clampInt(cfg.retryCount, 0, 3, DEFAULT_CONFIG.retryCount)
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const combined = combineSignals(options.signal, options.timeoutMs ?? cfg.timeoutMs)
    let retry = false
    try {
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${key.value}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': `${PACKAGE_NAME}/${packageMeta.version}`,
          },
          body: payload,
          signal: combined.signal,
        })
      } catch (networkError) {
        if (isAbortError(networkError) || combined.signal.aborted === true) {
          throw makeError('WEB_ABORTED', `The request was cancelled or timed out: ${describeError(networkError)}`, networkError)
        }
        throw makeError('WEB_PROVIDER_ERROR', `Cannot reach ${url}: ${describeError(networkError)}`, networkError)
      }

      const text = await response.text().catch(() => '')
      let parsed
      try {
        parsed = text === '' ? null : JSON.parse(text)
      } catch {
        parsed = undefined
      }

      if (response.ok === true) {
        return { status: response.status, body: parsed, keySource: key.source, endpoint: url }
      }

      const detail = errorDetail(parsed) || (text === '' ? '' : text.slice(0, 240))
      const message = `DeepSeek Search API returned HTTP ${response.status}${detail === '' ? '' : `: ${detail}`} (${url})`
      const code = response.status === 401 || response.status === 402 ? 'WEB_PROVIDER_CREDENTIAL_MISSING' : 'WEB_PROVIDER_ERROR'
      const error = makeError(code, message)
      error.httpStatus = response.status

      const retryable = response.status === 429 || response.status === 408 || response.status >= 500
      if (attempt + 1 < attempts && retryable) {
        lastError = error
        retry = true
      } else {
        throw error
      }
    } finally {
      combined.dispose()
    }
    if (retry === true) await sleep(cfg.retryDelayMs)
  }

  throw lastError ?? makeError('WEB_PROVIDER_ERROR', `The search request failed (${url})`)
}

// ---------------------------------------------------------------------------
// Search / Fetch calls
// ---------------------------------------------------------------------------

/** Remember the latest call so `status` and the page can show it. Success clears lastError. */
function rememberLastResult(value) {
  runtime.lastResult = { at: nowIso(), ...value }
  if (value.ok === false) {
    runtime.lastError = { at: runtime.lastResult.at, message: value.error ?? 'unknown error', code: value.code ?? null }
  } else {
    runtime.lastError = null
  }
}

/**
 * Call the Search API once.
 * @returns {Promise<object>} structured result including `results[]`.
 */
async function searchApi(query, options = {}) {
  const q = String(query ?? '').trim()
  if (q === '') throw makeError('WEB_PROVIDER_ERROR', 'query must be a non-empty string')
  const count = clampInt(options.count ?? cfg.count, 1, 50, cfg.count)
  const needContent = options.needContent === undefined ? cfg.needContent === true : options.needContent === true
  const body = { query: q, count }
  if (needContent) body.need_content = true
  const oriQuestion = typeof options.oriQuestion === 'string' ? options.oriQuestion.trim() : ''
  if (oriQuestion !== '') body.ori_question = oriQuestion

  const endpoint = searchEndpoint()
  const startedAt = Date.now()
  try {
    const response = await postJson(endpoint, body, { signal: options.signal })
    const results = Array.isArray(response.body?.results) ? response.body.results : []
    const value = {
      ok: true,
      kind: 'search',
      endpoint,
      query: q,
      requested: count,
      count: results.length,
      needContent,
      ms: Date.now() - startedAt,
      httpStatus: response.status,
      keySource: response.keySource,
      modeAtCall: runtime.mode,
    }
    rememberLastResult(value)
    return { ...value, results }
  } catch (error) {
    rememberLastResult({
      ok: false,
      kind: 'search',
      endpoint,
      query: q,
      ms: Date.now() - startedAt,
      code: error?.code ?? null,
      error: describeError(error),
    })
    throw error
  }
}

/**
 * Call the Fetch API once and return Markdown text.
 * Content is truncated to `config.maxFetchChars`.
 */
async function fetchApiPage(targetUrl, options = {}) {
  const url = String(targetUrl ?? '').trim()
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw makeError('WEB_PROVIDER_ERROR', `Not a valid URL: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw makeError('WEB_PROVIDER_ERROR', `Only http(s) URLs are supported: ${url}`)
  }

  const endpoint = fetchEndpoint()
  const startedAt = Date.now()
  try {
    const response = await postJson(endpoint, { url }, { signal: options.signal })
    const title = typeof response.body?.title === 'string' ? response.body.title : ''
    const content = typeof response.body?.content === 'string' ? response.body.content : ''
    const maxChars = clampInt(cfg.maxFetchChars, 1000, 200000, DEFAULT_CONFIG.maxFetchChars)
    const value = {
      ok: true,
      kind: 'fetch',
      endpoint,
      url,
      title,
      truncated: content.length > maxChars,
      content: content.slice(0, maxChars),
      ms: Date.now() - startedAt,
      httpStatus: response.status,
      keySource: response.keySource,
      modeAtCall: runtime.mode,
    }
    rememberLastResult({ ...value, content: undefined })
    return value
  } catch (error) {
    rememberLastResult({
      ok: false,
      kind: 'fetch',
      endpoint,
      url,
      ms: Date.now() - startedAt,
      code: error?.code ?? null,
      error: describeError(error),
    })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Search provider + routing (no hardcoded default provider id)
// ---------------------------------------------------------------------------

/** Map one Search API result item to the `ctx.web` source shape. */
function toSource(item) {
  if (item === null || typeof item !== 'object') return null
  const url = typeof item.url === 'string' ? item.url : ''
  if (url === '') return null
  const source = { url }
  if (typeof item.title === 'string' && item.title !== '') source.title = item.title
  const snippet = typeof item.snippet === 'string' && item.snippet !== ''
    ? item.snippet
    : (typeof item.summary === 'string' ? item.summary : '')
  if (snippet !== '') source.snippet = snippet.slice(0, 300)
  if (typeof item.date === 'string' && item.date !== '') source.publishedAt = item.date
  return source
}

function getWebService() {
  const web = getService('web')
  return web !== undefined && web !== null ? web : undefined
}

/** Remember whatever provider is currently active, as long as it is not ours. */
function capturePreviousProvider(web) {
  const active = web?.searchProviderId
  if (typeof active === 'string' && active.trim() !== '' && !isOwnProviderId(active)) {
    runtime.previousProviderId = active
  }
}

/** True when `id` is our current id or an id we registered earlier in this process. */
function isOwnProviderId(id) {
  return id === cfg.providerId || runtime.ownProviderIds.has(id)
}

/** True when `provider` is this plugin's registration. */
function isOurProvider(provider) {
  if (provider === null || provider === undefined) return false
  if (provider === runtime.providerObject) return true
  return typeof provider.id === 'string' && isOwnProviderId(provider.id)
}

/**
 * Resolve the fallback provider object using the documented order:
 *   1. `runtime.previousProviderId` if registered and not ours;
 *   2. `config.fallbackProvider` if registered and not ours;
 *   3. the first registered provider not ours whose `available()` is not `false`.
 * The unregistered-previous best guess (step 4) only applies to routing, not
 * to an actual fallback call, so it is handled in `resolveOffTargetId()`.
 */
function findFallbackProvider(web) {
  const providers = web?.searchProviders
  if (!(providers instanceof Map)) return undefined
  const pick = (id) => {
    if (typeof id !== 'string' || id === '' || isOwnProviderId(id)) return undefined
    const provider = providers.get(id)
    if (provider === undefined || provider === null || isOurProvider(provider)) return undefined
    return provider
  }
  const captured = pick(runtime.previousProviderId)
  if (captured !== undefined) return captured
  const configured = pick(cfg.fallbackProvider)
  if (configured !== undefined) return configured
  for (const provider of providers.values()) {
    if (provider === null || provider === undefined || isOurProvider(provider)) continue
    if (typeof provider.available === 'function' && provider.available() === false) continue
    return provider
  }
  return undefined
}

/**
 * Search provider backing the built-in `web_search`.
 * `available()` is always true: a missing key or API failure falls back inside
 * `search()` instead of making the built-in tool unavailable.
 */
function makeProvider() {
  return {
    id: cfg.providerId,
    __deepsearchPlugin: true,
    available: () => true,
    search: async (request, signal) => {
      const query = String(request?.query ?? '')
      const maxResults = typeof request?.maxResults === 'number' ? request.maxResults : cfg.count
      try {
        // The web source shape has no page text, so never pay for need_content here.
        const result = await searchApi(query, { count: maxResults, needContent: false, signal })
        return {
          sources: result.results.map(toSource).filter((source) => source !== null),
          truncated: false,
        }
      } catch (error) {
        if (isCancellation(error, signal)) throw error
        rememberLastResult({
          ok: false,
          kind: 'provider.search',
          query,
          code: error?.code ?? null,
          error: describeError(error),
        })
        if (cfg.fallbackOnError !== true) throw error

        const web = getWebService()
        const fallback = web !== undefined ? findFallbackProvider(web) : undefined
        if (fallback === undefined || typeof fallback.search !== 'function') throw error

        try {
          const value = await fallback.search(request, signal)
          runtime.lastResult = {
            at: nowIso(),
            kind: 'provider.fallback',
            ok: true,
            route: `fallback:${fallback.id}`,
            query,
            reason: `${error?.code ?? 'ERROR'}: ${describeError(error)}`,
          }
          return value
        } catch (fallbackError) {
          if (isCancellation(fallbackError, signal)) throw fallbackError
          const combined = makeError(
            'WEB_PROVIDER_ERROR',
            `Search API failed: ${describeError(error)}; fallback to ${fallback.id} also failed: ${describeError(fallbackError)}`,
            error,
          )
          rememberLastResult({ ok: false, kind: 'provider.search', query, code: combined.code, error: combined.message })
          throw combined
        }
      }
    },
  }
}

/**
 * Register the search provider. Re-registration is tolerated (HMR): a previous
 * registration is disposed first, and a throwing duplicate registration is
 * recorded but never propagated.
 */
function registerProvider(scope) {
  try {
    const web = scope?.web ?? getWebService()
    if (web === undefined || typeof web.registerSearchProvider !== 'function') {
      runtime.providerRegistered = false
      recordError('web.registerSearchProvider', new Error('the web service is unavailable'))
      writeDiag()
      return
    }
    // Re-normalise in case the web service only became available after apply()
    // and a provider id from config is already owned by another plugin.
    if (web.searchProviders instanceof Map) {
      cfg = { ...cfg, providerId: normaliseProviderId(cfg.providerId, web) }
    }
    if (typeof runtime.disposeProvider === 'function') {
      try {
        runtime.disposeProvider()
      } catch {
        // A stale disposer must not break re-registration.
      }
      runtime.disposeProvider = null
    }
    runtime.providerObject = makeProvider()
    runtime.ownProviderIds.add(runtime.providerObject.id)
    const dispose = web.registerSearchProvider(runtime.providerObject)
    runtime.disposeProvider = typeof dispose === 'function' ? dispose : null
    runtime.providerRegistered = true
    runtime.diag.provider = true
  } catch (error) {
    // Duplicate registration is tolerated: the registry keeps the last one.
    runtime.providerRegistered = false
    recordError('web.registerSearchProvider', error)
  }
  writeDiag()
}

/** Switch ON: remember the current provider (if not ours), then select ours. */
function routeOn() {
  const web = getWebService()
  if (web === undefined) {
    runtime.routeApplied = false
    return { ok: false, error: hostText().routeWebUnavailable }
  }
  capturePreviousProvider(web)
  web.searchProviderId = cfg.providerId
  runtime.routeApplied = true
  return { ok: true, active: web.searchProviderId, previous: runtime.previousProviderId }
}

/** Resolve the provider id that "off" should restore (steps 1-4 of CONTRACT 3.3). */
function resolveOffTargetId(web) {
  const fallback = findFallbackProvider(web)
  if (fallback !== undefined && typeof fallback.id === 'string' && fallback.id !== '') return fallback.id
  // Step 4: best guess even if the remembered provider is no longer registered.
  if (runtime.previousProviderId !== '' && !isOwnProviderId(runtime.previousProviderId)) return runtime.previousProviderId
  return undefined
}

/** Switch OFF: restore the captured provider (or the documented fallback heuristic). */
function routeOff() {
  const web = getWebService()
  runtime.routeApplied = false
  if (web === undefined) return { ok: false, error: hostText().routeWebUnavailableOff }
  const targetId = resolveOffTargetId(web)
  if (targetId === undefined) return { ok: false, error: hostText().routeNoFallback }
  web.searchProviderId = targetId
  return { ok: true, active: web.searchProviderId, previous: targetId }
}

function currentActiveProvider() {
  const web = getWebService()
  return web !== undefined && typeof web.searchProviderId === 'string' ? web.searchProviderId : null
}

function saveModeState() {
  runtime.updatedAt = nowIso()
  return writeJsonSafe(modeFilePath(), {
    mode: runtime.mode,
    previousProviderId: runtime.previousProviderId,
    updatedAt: runtime.updatedAt,
  })
}

function loadModeState() {
  const saved = readJsonSafe(modeFilePath())
  if (saved === null || typeof saved !== 'object') return
  if (saved.mode === 'on') runtime.mode = 'on'
  if (typeof saved.previousProviderId === 'string' && saved.previousProviderId !== '' && !isOwnProviderId(saved.previousProviderId)) {
    runtime.previousProviderId = saved.previousProviderId
  }
  if (typeof saved.updatedAt === 'string') runtime.updatedAt = saved.updatedAt
}

/** Apply the switch: persist it and change the live route immediately. */
function applyMode(nextMode) {
  runtime.mode = nextMode === 'on' ? 'on' : 'off'
  const route = runtime.mode === 'on' ? routeOn() : routeOff()
  if (route.ok !== true) {
    runtime.lastError = { at: nowIso(), message: route.error ?? 'route switch failed', code: 'ROUTE_SWITCH_FAILED' }
  }
  saveModeState()
  writeDiag()
  return { mode: runtime.mode, route, activeProvider: currentActiveProvider() }
}

/** Stable switch result for the client and the tool: `route` is the compatibility string. */
function modeResult(applied, state) {
  const routeOk = applied.route?.ok !== false
  return {
    ok: routeOk,
    mode: applied.mode,
    route: applied.mode === 'on' ? 'deepseek-api' : 'builtin',
    activeProvider: applied.activeProvider,
    switch: applied.route,
    ...(routeOk ? {} : { error: applied.route?.error ?? 'failed to switch the built-in search route' }),
    ...(state === undefined ? {} : { state }),
  }
}

// ---------------------------------------------------------------------------
// Status snapshot (tool `status`, page polling and the check button share it)
// ---------------------------------------------------------------------------

async function snapshotState() {
  return {
    ok: true,
    name: PACKAGE_NAME,
    version: packageMeta.version,
    mode: runtime.mode,
    route: runtime.mode === 'on' ? 'deepseek-api' : 'builtin',
    providerId: cfg.providerId,
    activeProvider: currentActiveProvider(),
    previousProviderId: runtime.previousProviderId,
    endpoint: {
      baseURL: endpointBase(),
      searchPath: cfg.searchPath,
      fetchPath: cfg.fetchPath,
      search: searchEndpoint(),
      fetch: fetchEndpoint(),
    },
    count: cfg.count,
    needContent: cfg.needContent === true,
    language: resolveLanguage(),
    key: await describeKey(),
    // Never expose apiKey here.
    config: {
      baseURL: cfg.baseURL,
      searchPath: cfg.searchPath,
      fetchPath: cfg.fetchPath,
      providerId: cfg.providerId,
      fallbackProvider: cfg.fallbackProvider,
      fallbackOnError: cfg.fallbackOnError === true,
      count: cfg.count,
      needContent: cfg.needContent === true,
      timeoutMs: cfg.timeoutMs,
      retryCount: cfg.retryCount,
      retryDelayMs: cfg.retryDelayMs,
      maxFetchChars: cfg.maxFetchChars,
      language: cfg.language,
      checkQuery: cfg.checkQuery,
    },
    lastResult: runtime.lastResult,
    lastError: runtime.lastError,
    updatedAt: runtime.updatedAt,
    services: { ...runtime.services },
    diag: {
      tool: runtime.diag.tool,
      provider: runtime.providerRegistered,
      routes: [...runtime.diag.routes],
      errors: runtime.diag.errors.slice(-10),
    },
    paths: {
      keyFile: keyFilePath(),
      modeFile: modeFilePath(),
      diagFile: diagFilePath(),
      envFile: envFilePath(),
    },
  }
}

/** Minimal 1-result search used to validate key / endpoint / network. */
async function checkAction(options = {}) {
  const startedAt = Date.now()
  const query = typeof options.query === 'string' && options.query.trim() !== ''
    ? options.query.trim()
    : cfg.checkQuery
  try {
    const result = await searchApi(query, { count: 1, signal: options.signal })
    const first = result.results[0]
    return {
      ok: true,
      query: result.query,
      ms: Date.now() - startedAt,
      httpStatus: result.httpStatus,
      keySource: result.keySource,
      first: first !== undefined ? { title: first.title ?? '', url: first.url ?? '' } : null,
    }
  } catch (error) {
    return {
      ok: false,
      query,
      ms: Date.now() - startedAt,
      code: error?.code ?? null,
      error: describeError(error),
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP routes
//
// Plugin routes do not go through DSH connection auth, so they enforce:
//   - the expected HTTP method;
//   - POST bodies use application/json (blocks form/text cross-site requests);
//   - when a browser sends Origin it must be same-origin with Host, and
//     `Sec-Fetch-Site: cross-site` is rejected;
//   - /check allows one in-flight request at a time.
// This prevents CSRF; it does not replace authentication. The webserver should
// keep listening on 127.0.0.1 only.
// ---------------------------------------------------------------------------

function readJsonBody(req, limit = 65536) {
  return new Promise((resolveBody, rejectBody) => {
    const parts = []
    let size = 0
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) {
        rejectBody(new Error('request body is too large'))
        req.destroy()
        return
      }
      parts.push(buffer)
    })
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8').trim()
      if (text === '') {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(text))
      } catch (error) {
        rejectBody(new Error(`request body is not JSON: ${describeError(error)}`))
      }
    })
    req.on('error', rejectBody)
  })
}

function sendJson(res, status, value) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    body = JSON.stringify({ ok: false, error: 'state is not serializable' })
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Validate method, browser same-origin and POST content-type; writes the error response itself. */
function guardRouteRequest(req, res, expectedMethod) {
  const method = String(req?.method ?? '').toUpperCase()
  if (method !== expectedMethod) {
    sendJson(res, 405, { ok: false, error: `only ${expectedMethod} is allowed` })
    return false
  }

  const headers = req?.headers ?? {}
  const origin = typeof headers.origin === 'string' ? headers.origin.trim() : ''
  if (origin !== '') {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      parsed = undefined
    }
    const host = typeof headers.host === 'string' ? headers.host : ''
    if (parsed === undefined || host === '' || parsed.host !== host) {
      sendJson(res, 403, { ok: false, error: 'only same-origin page requests are allowed' })
      return false
    }
  }
  if (headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { ok: false, error: 'only same-origin page requests are allowed' })
    return false
  }

  if (expectedMethod === 'POST') {
    const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'].toLowerCase() : ''
    if (!contentType.startsWith('application/json')) {
      sendJson(res, 415, { ok: false, error: 'POST requests must use application/json' })
      return false
    }
  }
  return true
}

/** Register the four client routes and return a disposer. */
function registerRoutes(webServer) {
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    throw new Error('the web server service is unavailable')
  }
  let checkInFlight = false

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: '/deepsearch/state',
      handler: async (req, res) => {
        if (!guardRouteRequest(req, res, 'GET')) return
        try {
          sendJson(res, 200, await snapshotState())
        } catch (error) {
          sendJson(res, 200, { ok: false, error: describeError(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/deepsearch/mode',
      handler: async (req, res) => {
        if (!guardRouteRequest(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const result = applyMode(body?.mode === 'on' ? 'on' : 'off')
          sendJson(res, 200, modeResult(result, await snapshotState()))
        } catch (error) {
          sendJson(res, 200, { ok: false, error: describeError(error), state: await snapshotState().catch(() => undefined) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/deepsearch/check',
      handler: async (req, res) => {
        if (!guardRouteRequest(req, res, 'POST')) return
        if (checkInFlight) {
          sendJson(res, 429, { ok: false, error: 'a check request is already in flight' })
          return
        }
        checkInFlight = true
        try {
          sendJson(res, 200, { ok: true, check: await checkAction(), state: await snapshotState() })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: describeError(error), state: await snapshotState().catch(() => undefined) })
        } finally {
          checkInFlight = false
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/deepsearch/key',
      handler: async (req, res) => {
        if (!guardRouteRequest(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const action = typeof body?.action === 'string' && body.action.trim() !== '' ? body.action.trim() : 'save'
          if (action === 'save') {
            const saved = saveKeyFile(body?.key)
            if (saved.ok !== true) {
              sendJson(res, 200, { ok: false, action, error: saved.error })
              return
            }
            // Never echo the key value: describeKey() only returns status metadata.
            sendJson(res, 200, { ok: true, action, key: await describeKey() })
            return
          }
          if (action === 'clear') {
            const cleared = clearKeyFile()
            if (cleared.ok !== true) {
              sendJson(res, 200, { ok: false, action, error: cleared.error })
              return
            }
            sendJson(res, 200, { ok: true, action, key: await describeKey() })
            return
          }
          sendJson(res, 200, { ok: false, error: `unsupported key action: ${action}` })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: describeError(error) })
        }
      },
    }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Ignore disposal races.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Model tool
// ---------------------------------------------------------------------------

const deepsearchTool = {
  name: 'deepsearch',
  description:
    'Route DSH\'s built-in web_search through the DeepSeek Search API (POST {searchPath}, default /v1/tools/search; the Fetch API is available as action="fetch") instead of DeepSeek\'s server-side account search. The user controls a switch in Settings → Built-in plugins → DeepSeek Search (English UI) and in the sidebar footer; while it is ON the built-in web_search is served by the Search API, so keep using web_search normally. Plugin options (API base URL, search/fetch paths, provider id, fallback provider, language, retry policy, key file) live in this plugin\'s entry in the DSH profile patch. Actions: "status" = switch mode + active route + whether an API key is configured + last search/fetch + last error (call it before claiming the route works, and after any search failure); "on"/"off" = flip the switch (no restart needed); "search" = one direct Search API query, returns structured results (title/url/summary/date/authority) — use it only when the user explicitly wants the Search API directly or web_search is broken; "fetch" = retrieve one http(s) URL as Markdown; "check" = minimal 1-result search to verify key/endpoint/network (costs one request). When the switch is ON but no API key resolves, the provider silently falls back to the captured account-search provider — report that from status instead of assuming the API works. Never print the API key.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'on', 'off', 'search', 'fetch', 'check'],
        description: 'status = current switch/route/key state; on/off = flip the switch; search = direct Search API query (needs query); fetch = fetch one URL as Markdown (needs url); check = minimal probe of key + endpoint.',
      },
      query: {
        type: 'string',
        description: 'Search query for action=search (1-128 chars), or the probe query for action=check (default comes from config, "DeepSeek").',
      },
      url: {
        type: 'string',
        description: 'Required for action=fetch: the http(s) URL to retrieve.',
      },
      count: {
        type: 'integer',
        description: 'Optional result count for action=search (1-50, default from config).',
      },
      oriQuestion: {
        type: 'string',
        description: 'Optional original user question for action=search — helps the search intent.',
      },
      needContent: {
        type: 'boolean',
        description: 'Optional: include full page text in results (need_content=true). Usually false.',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        mode: { type: 'string' },
        route: { type: 'string' },
        activeProvider: { type: 'string' },
        providerId: { type: 'string' },
        previousProviderId: { type: 'string' },
        language: { type: 'string' },
        code: { type: 'string' },
        error: { type: 'string' },
        query: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        results: {},
        state: {},
        key: {},
        check: {},
      },
    },
    render: (args, value) => {
      const language = resolveLanguage()
      return [{ type: 'text', text: renderToolText(language, args, value) }]
    },
  },
  execute: async (args, exec) => {
    const action = String(args?.action ?? 'status')
    const signal = exec?.signal
    try {
      if (action === 'status') return jsonSafe(await snapshotState())
      if (action === 'on' || action === 'off') {
        const applied = applyMode(action)
        return jsonSafe({
          action,
          ...modeResult(applied, await snapshotState()),
        })
      }
      if (action === 'search') {
        return jsonSafe({ action, ...(await searchApi(args.query, { count: args.count, oriQuestion: args.oriQuestion, needContent: args.needContent, signal })) })
      }
      if (action === 'fetch') {
        return jsonSafe({ action, ...(await fetchApiPage(args.url, { signal })) })
      }
      if (action === 'check') return jsonSafe({ action, ...(await checkAction({ query: args.query, signal })) })
      throw makeError('WEB_PROVIDER_ERROR', `unknown action: ${action}`)
    } catch (error) {
      return jsonSafe({
        ok: false,
        action,
        code: error?.code ?? null,
        error: describeToolError(error),
      })
    }
  },
  presentCall: (args) => ({
    card: 'generic',
    title: `deepsearch ${String(args?.action)}`,
    kind: args?.action === 'status' || args?.action === 'on' || args?.action === 'off' ? 'other' : 'read',
  }),
}

/** Tool results must be lossless JSON: drop values JSON cannot represent. */
function jsonSafe(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : JSON.parse(text)
  } catch {
    return null
  }
}

/** Model-facing text for a search result, localised and including summaries. */
function formatSearchValue(value, language) {
  const dict = HOST_TEXT[language]
  const lines = [dict.toolSearchHeader(value)]
  const results = Array.isArray(value.results) ? value.results : []
  results.forEach((item, index) => {
    const title = typeof item?.title === 'string' && item.title !== '' ? item.title : dict.toolUntitled
    const summary = typeof item?.summary === 'string' && item.summary !== ''
      ? item.summary
      : (typeof item?.snippet === 'string' ? item.snippet : '')
    const meta = []
    if (typeof item?.site_name === 'string' && item.site_name !== '') meta.push(item.site_name)
    if (typeof item?.date === 'string' && item.date !== '') meta.push(item.date)
    if (typeof item?.rerank_score === 'number') meta.push(`${dict.toolScoreLabel} ${item.rerank_score}`)
    if (typeof item?.authority === 'number' && item.authority >= 0) meta.push(`${dict.toolAuthorityLabel} ${item.authority}`)
    lines.push(`\n${index + 1}. ${title}`)
    lines.push(`   ${item?.url ?? ''}`)
    if (meta.length > 0) lines.push(`   ${meta.join(' · ')}`)
    if (summary !== '') lines.push(`   ${summary.slice(0, 600).replace(/\s+/gu, ' ')}`)
    if (typeof item?.content === 'string' && item.content !== '') lines.push(`   ${dict.toolContentMeta(item.content.length)}`)
  })
  if (results.length === 0) lines.push(`\n${dict.toolNoResults}`)
  return lines.join('\n')
}

/** Localised text for the tool's `render` hook. */
function renderToolText(language, args, value) {
  const dict = HOST_TEXT[language]
  const failed = value === null || value === undefined || value.ok === false
  if (failed === true) {
    const code = value?.code ?? null
    return dict.toolFailure(String(args?.action), code, value?.error ?? dict.toolUnknownError)
  }
  if (args?.action === 'search') return formatSearchValue(value, language)
  if (args?.action === 'fetch') {
    return `# ${value.title !== '' ? value.title : value.url}\n${value.url}\n\n${value.content ?? ''}${value.truncated === true ? dict.toolTruncated : ''}`
  }
  if (args?.action === 'check') return value.ok === true ? dict.toolCheckOk(value) : dict.toolCheckFail(value)
  return JSON.stringify(value, null, 2)
}

// ---------------------------------------------------------------------------
// Optional service wiring (all failures only record diagnostics)
// ---------------------------------------------------------------------------

function injectOptional(ctx, deps, callback) {
  try {
    if (typeof ctx.inject !== 'function') return false
    ctx.inject(deps, callback)
    return true
  } catch (error) {
    recordError(`inject(${deps.join(',')})`, error)
    return false
  }
}

function tryImmediate(ctx, serviceName, callback) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
    if (service !== undefined && service !== null) {
      callback({ [serviceName]: service })
      return true
    }
  } catch (error) {
    recordError(`get(${serviceName})`, error)
  }
  return false
}

/** Expose the active route to shell commands (optional enhancement). */
function registerShellFact(scope) {
  try {
    const shellEnv = scope?.shellEnv
    if (shellEnv === undefined || shellEnv === null || typeof shellEnv.register !== 'function') return
    shellEnv.register({
      name: 'deepsearch-route',
      variables: {
        DSH_DEEPSEARCH_ROUTE: {
          description: 'deepseek-api = the built-in web_search is routed through the DeepSeek Search API; builtin = the default DSH account search. Controlled by Settings → Built-in plugins → DeepSeek Search and the sidebar footer switch.',
        },
      },
      resolve: () => ({ DSH_DEEPSEARCH_ROUTE: runtime.mode === 'on' ? 'deepseek-api' : 'builtin' }),
    })
    runtime.services.shellEnv = true
  } catch (error) {
    recordError('shellEnv.register', error)
  }
}

// ---------------------------------------------------------------------------
// Cordis entry point
// ---------------------------------------------------------------------------

/**
 * Register the deepsearch tool, Search API provider, HTTP routes and shell fact.
 * This function NEVER throws: DSH startup is all-or-nothing, so a failing plugin
 * could abort the whole process. Wire-up failures are stored in the diag file.
 * @param ctx - Cordis context (injects `tools`).
 * @param config - plugin entry config from the profile patch.
 */
export function apply(ctx, config) {
  try {
    hostCtx = ctx
    cfg = normaliseConfig(config, getWebService())
    loadModeState()

    // 1) Model tool.
    try {
      if (ctx === null || ctx === undefined || ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
        throw new Error('the tools service is unavailable')
      }
      const disposeTool = ctx.tools.register(deepsearchTool)
      if (typeof ctx.effect === 'function' && typeof disposeTool === 'function') {
        ctx.effect(() => () => {
          try {
            disposeTool()
          } catch {
            // Ignore disposal races.
          }
        })
      }
      runtime.diag.tool = true
    } catch (error) {
      runtime.diag.tool = false
      recordError('tools.register', error)
    }

    // 2) Search provider and routing (the web service is required for the main feature,
    //    but its absence must not throw).
    const wireWeb = (scope) => {
      try {
        runtime.services.web = true
        const web = scope?.web ?? getWebService()
        if (web === undefined) {
          runtime.diag.errors.push('web: service is not available')
          writeDiag()
          return
        }
        // Capture the current provider before we touch the route; this is what
        // "off" restores and what error fallback uses. Never hardcoded.
        capturePreviousProvider(web)
        registerProvider(scope)
        if (runtime.mode === 'on') {
          const route = routeOn()
          if (route.ok !== true) recordError('routeOn', route.error ?? 'unknown')
        }
      } catch (error) {
        recordError('web wiring', error)
      }
      writeDiag()
    }
    if (injectOptional(ctx, ['web'], wireWeb) === false) {
      if (tryImmediate(ctx, 'web', wireWeb) === false) {
        runtime.diag.errors.push('web: service not ready yet; waiting for the ctx.inject callback')
      }
    }

    // 3) Page routes.
    const wireRoutes = (scope) => {
      try {
        const webServer = scope?.webServer ?? getService('webServer')
        const disposeRoutes = registerRoutes(webServer)
        if (scope !== null && scope !== undefined && typeof scope.effect === 'function') {
          scope.effect(() => disposeRoutes)
        }
        runtime.services.webServer = true
        runtime.diag.routes = [...ROUTE_PATHS]
      } catch (error) {
        recordError('webServer.register', error)
      }
      writeDiag()
    }
    if (injectOptional(ctx, ['webServer'], wireRoutes) === false) {
      tryImmediate(ctx, 'webServer', wireRoutes)
    }

    // 4) Optional: credentials service (so a key saved in the Web Search settings
    //    page can be reused) and the shell fact.
    injectOptional(ctx, ['credentials'], (scope) => {
      runtime.services.credentials = scope?.credentials !== undefined
    })
    if (injectOptional(ctx, ['shellEnv'], registerShellFact) === false) {
      tryImmediate(ctx, 'shellEnv', registerShellFact)
    }

    // 5) Write a startup self-check immediately, so a restart/HMR can be verified
    //    from the diag file alone.
    writeDiag()
  } catch (error) {
    // Last resort: never let plugin loading take DSH down.
    try {
      recordError('apply', error)
      writeDiag()
    } catch {
      // Ignore diagnostics failures.
    }
    try {
      if (typeof ctx?.logger?.error === 'function') ctx.logger.error('[deepsearch] apply failed but was ignored to keep DSH alive:', error)
    } catch {
      // Ignore logger failures.
    }
  }
}

// ---------------------------------------------------------------------------
// Test-only internals (mocked Cordis environments import these directly)
// ---------------------------------------------------------------------------

export const __internals = {
  // Config and identity
  DEFAULT_CONFIG,
  PLUGIN_ID,
  PACKAGE_NAME,
  packageMeta,
  normaliseConfig,
  resolveLanguage,
  // Endpoints / HTTP
  endpointBase,
  searchEndpoint,
  fetchEndpoint,
  postJson,
  searchApi,
  fetchApiPage,
  // Provider / routing
  toSource,
  makeProvider,
  routeOn,
  routeOff,
  findFallbackProvider,
  applyMode,
  modeResult,
  // Status / checks
  snapshotState,
  checkAction,
  describeKey,
  // Keys and paths
  resolveKey,
  saveKeyFile,
  clearKeyFile,
  keyFilePath,
  modeFilePath,
  diagFilePath,
  envFilePath,
  // State
  runtime,
  cfg: () => cfg,
  setCtx: (next) => {
    hostCtx = next
  },
}
