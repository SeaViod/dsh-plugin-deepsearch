/**
 * Host-half tests for dsh-plugin-deepsearch.
 *
 * Runs `index.js` against a fake Cordis environment and a mocked global
 * `fetch`: no DSH process, no real network, no third-party test framework.
 *
 * Coverage follows CONTRACT 5.1:
 *   exports/version, default wiring, switch routing (no hardcoded provider id),
 *   route-off heuristics, key resolution order, fallbackOnError/cancellation,
 *   retries and error mapping, custom endpoints/limits, i18n render, HTTP route
 *   guards and the POST /deepsearch/key save/clear route.
 *
 * Run from the plugin directory: node test/host.test.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')
const testHome = join(pluginDir, '.test-home-host')

// Isolate the plugin from the real DSH home and from the developer's key.
const ENV_KEYS = ['DSH_HOME', 'DEEPSEEK_API_KEY', 'DSH_LANGUAGE', 'DSH_LOCALE', 'LANG', 'LC_ALL']
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
rmSync(testHome, { recursive: true, force: true })
mkdirSync(testHome, { recursive: true })
process.env.DSH_HOME = testHome
for (const key of ENV_KEYS) {
  if (key !== 'DSH_HOME') delete process.env[key]
}

const failures = []
function check(name, condition, detail) {
  if (condition === true) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
}

const packageJson = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const plugin = await import('../index.js')
const internals = plugin.__internals
const runtime = internals.runtime

// ---------------------------------------------------------------------------
// Paths used by the plugin inside the isolated test home
// ---------------------------------------------------------------------------
const paths = {
  modeFile: join(testHome, 'deepsearch-mode.json'),
  diagFile: join(testHome, 'deepsearch-diag.json'),
  keyFile: join(testHome, 'deepsearch-key.txt'),
  envFile: join(testHome, '.env'),
  customKeyFile: join(testHome, 'custom', 'key.txt'),
}

function clearStateFiles() {
  for (const file of [paths.modeFile, paths.diagFile, paths.keyFile, paths.envFile, paths.customKeyFile]) {
    rmSync(file, { force: true })
  }
}

function resetEnv() {
  for (const key of ENV_KEYS) {
    if (key !== 'DSH_HOME') delete process.env[key]
  }
  world.credentialsValue = undefined
}

// ---------------------------------------------------------------------------
// Fake Cordis environment
// ---------------------------------------------------------------------------
const world = {
  tool: null,
  registeredProviders: [],
  routes: new Map(),
  shellFacts: [],
  effects: [],
  credentialsValue: undefined,
}

const providerCalls = { fallback: 0, beta: 0 }

const acmeProvider = {
  id: 'acme-official',
  available: () => true,
  search: async () => {
    providerCalls.fallback += 1
    return { sources: [{ url: 'https://fallback.example/x', title: 'fallback result' }], truncated: false }
  },
}

const betaProvider = {
  id: 'beta-official',
  available: () => true,
  search: async () => {
    providerCalls.beta += 1
    return { sources: [{ url: 'https://beta.example/y', title: 'beta result' }], truncated: false }
  },
}

// Simulates an unavailable provider so the route-off heuristic can skip it.
const unavailableProvider = {
  id: 'gamma-official',
  available: () => false,
  search: async () => ({ sources: [], truncated: false }),
}

const web = {
  searchProviderId: 'acme-official',
  searchProviders: new Map(),
  registerSearchProvider(provider) {
    world.registeredProviders.push(provider)
    this.searchProviders.set(provider.id, provider)
    return () => this.searchProviders.delete(provider.id)
  },
}

function setProviders(list) {
  const map = new Map()
  for (const provider of list) map.set(provider.id, provider)
  if (runtime.providerObject !== null) map.set(runtime.providerObject.id, runtime.providerObject)
  web.searchProviders = map
}

const webServer = {
  register(route) {
    world.routes.set(route.path, route.handler)
    return () => world.routes.delete(route.path)
  },
}

const credentials = {
  resolve: async () => (world.credentialsValue === undefined ? undefined : { value: world.credentialsValue }),
  describe: async () => ({ configured: world.credentialsValue !== undefined, writable: true }),
}

const shellEnv = {
  register(fact) {
    world.shellFacts.push(fact)
  },
}

const services = { web, webServer, credentials, shellEnv }

function makeScope(deps) {
  const scope = {}
  for (const dep of deps) {
    scope[dep] = services[dep]
    if (scope[dep] === undefined) return undefined
  }
  scope.effect = fakeCtx.effect
  return scope
}

const fakeCtx = {
  tools: {
    register(tool) {
      world.tool = tool
      return () => {
        if (world.tool === tool) world.tool = null
      }
    },
  },
  inject(deps, callback) {
    const scope = makeScope(deps)
    if (scope === undefined) return
    callback(scope)
  },
  get(name) {
    return services[name]
  },
  effect(fn) {
    const dispose = fn()
    world.effects.push(dispose)
    return dispose
  },
  logger: { warn() {}, error() {}, info() {} },
}

// ---------------------------------------------------------------------------
// Mocked fetch: queue specific responses, otherwise return canned success data
// ---------------------------------------------------------------------------
const fetchCalls = []
let fetchQueue = []

const defaultResults = [
  {
    rerank_score: 2.4,
    title: 'DeepSeek V4 released',
    url: 'https://example.com/a',
    snippet: 'Short snippet A',
    summary: 'Long summary A',
    content: '',
    site_name: 'Example News',
    date: '2026-06-01T00:00:00+00:00',
    authority: 3,
  },
  {
    rerank_score: 1.6,
    title: 'Article B',
    url: 'https://example.com/b',
    snippet: 'Short snippet B',
    summary: 'Long summary B',
    date: null,
    authority: -1,
  },
]

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function searchOk(results = defaultResults) {
  return () => jsonResponse({ results })
}

function httpError(status) {
  return () => jsonResponse({ error: { message: `upstream HTTP ${status}`, type: 'error' } }, status)
}

function pageOk(title, content) {
  return () => jsonResponse({ title, content })
}

function defaultResponder(url) {
  if (String(url).includes('/fetch')) return jsonResponse({ title: 'Page title', content: '# hello\n\nworld' })
  return searchOk()()
}

// Keep the event loop alive while retry delays (unref'd timers in the plugin)
// are pending; otherwise Node can exit with an unsettled top-level await.
const keepAlive = setInterval(() => {}, 500)

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init })
  if (init?.signal?.aborted === true) {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
  const responder = fetchQueue.length > 0 ? fetchQueue.shift() : defaultResponder
  return typeof responder === 'function' ? responder(String(url), init) : responder
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset mode + persistent files + provider map, then run a fresh apply(). */
function applyFresh(config = {}) {
  runtime.mode = 'off'
  clearStateFiles()
  resetEnv()
  web.searchProviderId = 'acme-official'
  setProviders([acmeProvider, betaProvider, unavailableProvider])
  plugin.apply(fakeCtx, config)
  return world.registeredProviders.at(-1)
}

async function runTool(args, exec = {}) {
  return world.tool.execute(args, exec)
}

async function snapshot() {
  return runTool({ action: 'status' })
}

function renderTool(args, value) {
  return world.tool.output.render(args, value)
}

function renderText(args, value) {
  const parts = renderTool(args, value)
  return Array.isArray(parts) && parts[0] && typeof parts[0].text === 'string' ? parts[0].text : ''
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

/**
 * Fake node:http request. It dispatches data/end asynchronously when a payload
 * is supplied, mirroring the real server behavior closely enough for the routes.
 */
function makeReq({ method = 'POST', headers = {}, payload } = {}) {
  const listeners = {}
  const req = {
    method,
    url: '/deepsearch/test',
    headers: { host: '127.0.0.1:58583', ...headers },
    on(event, callback) {
      ;(listeners[event] ??= []).push(callback)
      return req
    },
    destroy() {},
  }
  if (payload !== undefined) {
    queueMicrotask(() => {
      for (const callback of listeners.data ?? []) callback(Buffer.from(JSON.stringify(payload)))
      for (const callback of listeners.end ?? []) callback()
    })
  }
  return req
}

async function callRoute(path, options = {}) {
  const handler = world.routes.get(path)
  if (typeof handler !== 'function') throw new Error(`route is not registered: ${path}`)
  const res = makeRes()
  await handler(makeReq(options), res)
  let body
  try {
    body = JSON.parse(res.body)
  } catch {
    body = undefined
  }
  return { res, body }
}

const JSON_HEADERS = { 'content-type': 'application/json' }

console.log(`node ${process.version}; isolated DSH_HOME: ${testHome}`)

try {
  // -------------------------------------------------------------------------
  // 1. Module surface, package version, DEFAULT_CONFIG (CONTRACT 3.9 / 5.1.1)
  // -------------------------------------------------------------------------
  console.log('\n# module surface and package version')
  check('exports name = deepsearch', plugin.name === 'deepsearch', plugin.name)
  check('exports inject includes tools', Array.isArray(plugin.inject) && plugin.inject.includes('tools'), plugin.inject)
  check('exports apply function', typeof plugin.apply === 'function')

  const requiredInternals = [
    'DEFAULT_CONFIG', 'PLUGIN_ID', 'PACKAGE_NAME', 'normaliseConfig', 'resolveLanguage',
    'searchEndpoint', 'fetchEndpoint', 'searchApi', 'fetchApiPage', 'toSource', 'makeProvider',
    'applyMode', 'snapshotState', 'resolveKey', 'keyFilePath', 'modeFilePath', 'diagFilePath',
    'runtime', 'cfg', 'setCtx', 'packageMeta',
  ]
  check('__internals exports every required helper', requiredInternals.every((key) => key in internals), Object.keys(internals))
  check('__internals no longer exports DEFAULT_PREVIOUS_PROVIDER', 'DEFAULT_PREVIOUS_PROVIDER' in internals === false)

  const expectedDefaults = {
    apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com',
    searchPath: '/v1/tools/search', fetchPath: '/v1/tools/fetch', keyFile: '',
    count: 8, needContent: false, timeoutMs: 30000, retryCount: 1, retryDelayMs: 1200,
    maxFetchChars: 20000, providerId: 'deepseek-search-api', fallbackProvider: '',
    fallbackOnError: true, language: 'auto', checkQuery: 'DeepSeek',
  }
  const defaultKeys = Object.keys(internals.DEFAULT_CONFIG).sort()
  check(
    'DEFAULT_CONFIG matches CONTRACT 3.1',
    JSON.stringify(defaultKeys) === JSON.stringify(Object.keys(expectedDefaults).sort())
      && Object.entries(expectedDefaults).every(([key, value]) => internals.DEFAULT_CONFIG[key] === value),
    internals.DEFAULT_CONFIG,
  )

  const indexSource = readFileSync(join(pluginDir, 'index.js'), 'utf8')
  check('index.js reads the version from package.json', indexSource.includes('package.json'))
  check('index.js contains no 0.1.1 version literal', indexSource.includes('0.1.1') === false)
  check('index.js does not hardcode deepseek-official', indexSource.includes('deepseek-official') === false)

  // -------------------------------------------------------------------------
  // 2. Default wiring + snapshot shape (CONTRACT 3.6 / 5.1.2)
  // -------------------------------------------------------------------------
  console.log('\n# default wiring and status snapshot')
  clearStateFiles()
  resetEnv()
  web.searchProviderId = 'acme-official'
  setProviders([acmeProvider, betaProvider, unavailableProvider])
  plugin.apply(fakeCtx, {})

  check('registers the deepsearch tool', world.tool !== null && world.tool.name === 'deepsearch')
  const defaultProvider = world.registeredProviders.at(-1)
  check('registers the provider with the default id', defaultProvider?.id === 'deepseek-search-api', defaultProvider?.id)
  check('provider available() stays true', defaultProvider.available() === true)
  check('auto-captures the active non-default provider id', runtime.previousProviderId === 'acme-official', runtime.previousProviderId)
  check('mode defaults to off', runtime.mode === 'off', runtime.mode)
  check('registers four page routes', ['/deepsearch/state', '/deepsearch/mode', '/deepsearch/check', '/deepsearch/key'].every((pathName) => world.routes.has(pathName)), [...world.routes.keys()])
  check('registers the shell fact', world.shellFacts.length >= 1 && world.shellFacts.at(-1).name === 'deepsearch-route')
  check('writes the diag file', existsSync(paths.diagFile))
  const diagFile = JSON.parse(readFileSync(paths.diagFile, 'utf8'))
  check('diag name/version come from package.json', diagFile.name === packageJson.name && diagFile.version === packageJson.version, diagFile)

  const status = await snapshot()
  check('status.ok', status.ok === true)
  check('status.name', status.name === 'dsh-plugin-deepsearch', status.name)
  check('status.version equals package.json version', status.version === packageJson.version, { status: status.version, pkg: packageJson.version })
  check('status.mode = off and route = builtin', status.mode === 'off' && status.route === 'builtin', { mode: status.mode, route: status.route })
  check('status.providerId = default', status.providerId === 'deepseek-search-api', status.providerId)
  check('status.activeProvider = captured provider', status.activeProvider === 'acme-official', status.activeProvider)
  check('status.previousProviderId = captured provider', status.previousProviderId === 'acme-official', status.previousProviderId)
  check(
    'status.endpoint shape and defaults',
    status.endpoint.baseURL === 'https://api.deepseek.com'
      && status.endpoint.searchPath === '/v1/tools/search'
      && status.endpoint.fetchPath === '/v1/tools/fetch'
      && status.endpoint.search === 'https://api.deepseek.com/v1/tools/search'
      && status.endpoint.fetch === 'https://api.deepseek.com/v1/tools/fetch',
    status.endpoint,
  )
  check('status count / needContent defaults', status.count === 8 && status.needContent === false, { count: status.count, needContent: status.needContent })
  check('status.language defaults to en', status.language === 'en', status.language)
  check(
    'status.key reports no key with localized hint',
    status.key.configured === false
      && status.key.source === null
      && status.key.kind === null
      && status.key.envVar === 'DEEPSEEK_API_KEY'
      && status.key.keyFile === paths.keyFile
      && typeof status.key.hint === 'string'
      && status.key.hint.includes(paths.keyFile),
    status.key,
  )
  check('status.config never exposes apiKey', status.config.apiKey === undefined && Object.keys(status.config).includes('apiKey') === false, Object.keys(status.config))
  check(
    'status.config has exactly the documented keys',
    JSON.stringify(Object.keys(status.config).sort())
      === JSON.stringify(['baseURL', 'searchPath', 'fetchPath', 'providerId', 'fallbackProvider', 'fallbackOnError', 'count', 'needContent', 'timeoutMs', 'retryCount', 'retryDelayMs', 'maxFetchChars', 'language', 'checkQuery'].sort()),
    Object.keys(status.config),
  )
  check('status.services reports wired services', status.services.web === true && status.services.webServer === true && status.services.credentials === true && status.services.shellEnv === true, status.services)
  check('status.diag reports tool/provider/routes', status.diag.tool === true && status.diag.provider === true && JSON.stringify(status.diag.routes) === JSON.stringify(['/deepsearch/state', '/deepsearch/mode', '/deepsearch/check', '/deepsearch/key']), status.diag)
  check(
    'status.paths point inside the isolated DSH_HOME',
    status.paths.keyFile === paths.keyFile
      && status.paths.modeFile === paths.modeFile
      && status.paths.diagFile === paths.diagFile
      && status.paths.envFile === paths.envFile,
    status.paths,
  )
  check('status.lastResult/lastError are initially null', status.lastResult === null && status.lastError === null)

  // -------------------------------------------------------------------------
  // 3. HMR re-apply and malformed config (CONTRACT 3.1 / 3.3)
  // -------------------------------------------------------------------------
  console.log('\n# HMR re-apply and malformed config')
  const providerCountBefore = world.registeredProviders.length
  let applyThrew = false
  try {
    plugin.apply(fakeCtx, {})
  } catch {
    applyThrew = true
  }
  check('re-apply (HMR) does not throw', applyThrew === false)
  check('re-apply registers a provider again', world.registeredProviders.length === providerCountBefore + 1, world.registeredProviders.length)
  check('web provider map keeps the last registration', web.searchProviders.get('deepseek-search-api') === runtime.providerObject)
  check('tool is still registered after re-apply', world.tool !== null && world.tool.name === 'deepsearch')

  applyThrew = false
  try {
    plugin.apply(fakeCtx, {
      apiKey: 42,
      apiKeyEnv: 'not a valid env name',
      baseURL: 'not a url',
      searchPath: 'has?query',
      fetchPath: 'has#hash',
      keyFile: 7,
      count: 'abc',
      needContent: 'yes',
      timeoutMs: 1,
      retryCount: 99,
      retryDelayMs: -5,
      maxFetchChars: 999999,
      providerId: '!!bad provider!!',
      fallbackProvider: 12,
      fallbackOnError: 'yes',
      language: 'fr',
      checkQuery: '   ',
    })
  } catch {
    applyThrew = true
  }
  check('apply never throws on malformed config', applyThrew === false)
  const malformed = await snapshot()
  check(
    'malformed config is normalised to documented fallbacks',
    malformed.config.baseURL === 'https://api.deepseek.com'
      && malformed.config.searchPath === '/v1/tools/search'
      && malformed.config.fetchPath === '/v1/tools/fetch'
      && malformed.config.count === 8
      && malformed.config.timeoutMs === 1000
      && malformed.config.retryCount === 3
      && malformed.config.retryDelayMs === 100
      && malformed.config.maxFetchChars === 200000
      && malformed.config.providerId === 'deepseek-search-api'
      && malformed.config.fallbackProvider === ''
      && malformed.config.fallbackOnError === false
      && malformed.config.language === 'auto'
      && malformed.config.checkQuery === 'DeepSeek'
      && malformed.config.needContent === false
      && malformed.paths.keyFile === paths.keyFile,
    malformed.config,
  )

  // Restore sane config before the next scenario.
  applyFresh()

  // -------------------------------------------------------------------------
  // 4. Switch on/off and auto-capture of a custom provider id (5.1.3)
  // -------------------------------------------------------------------------
  console.log('\n# switch on/off with a custom captured provider id')
  const on = await runTool({ action: 'on' })
  check('on: mode/route/active provider', on.mode === 'on' && on.route === 'deepseek-api' && on.activeProvider === 'deepseek-search-api', on)
  check('on: previous provider is the captured custom id', on.switch?.previous === 'acme-official', on.switch)
  check('on: live route points at our provider', web.searchProviderId === 'deepseek-search-api', web.searchProviderId)
  check('on: mode persisted', JSON.parse(readFileSync(paths.modeFile, 'utf8')).mode === 'on')
  check('on: route routeApplied', runtime.routeApplied === true)

  const off = await runTool({ action: 'off' })
  check('off: mode/route/active provider', off.mode === 'off' && off.route === 'builtin' && off.activeProvider === 'acme-official', off)
  check('off: live route restored to captured provider', web.searchProviderId === 'acme-official', web.searchProviderId)
  check('off: mode persisted', JSON.parse(readFileSync(paths.modeFile, 'utf8')).mode === 'off')

  // -------------------------------------------------------------------------
  // 5. Route-off fallback heuristics (CONTRACT 3.3 / 5.1.4)
  // -------------------------------------------------------------------------
  console.log('\n# route-off fallback heuristics')

  // 5a. Remembered previous provider wins when registered.
  internals.routeOn()
  runtime.previousProviderId = 'beta-official'
  const offRegistered = internals.routeOff()
  check('route-off prefers the registered previous provider', offRegistered.ok === true && web.searchProviderId === 'beta-official', { result: offRegistered, active: web.searchProviderId })

  // 5b. Previous missing -> configured fallbackProvider.
  applyFresh({ fallbackProvider: 'beta-official' })
  internals.routeOn()
  runtime.previousProviderId = 'gone-official'
  const offConfigured = internals.routeOff()
  check('route-off falls back to config.fallbackProvider', offConfigured.ok === true && web.searchProviderId === 'beta-official', { result: offConfigured, active: web.searchProviderId })

  // 5c. No configured fallback -> first registered provider whose available() is not false.
  applyFresh({ fallbackProvider: '' })
  internals.routeOn()
  runtime.previousProviderId = 'gone-official'
  const offFirst = internals.routeOff()
  check('route-off picks the first available other provider', offFirst.ok === true && web.searchProviderId === 'acme-official', { result: offFirst, active: web.searchProviderId })

  // 5d. Nothing usable -> {ok:false} and the current provider is untouched.
  applyFresh({ fallbackProvider: '' })
  setProviders([unavailableProvider])
  runtime.previousProviderId = ''
  web.searchProviderId = 'deepseek-search-api'
  const offNone = internals.routeOff()
  check('route-off returns ok:false when no fallback exists', offNone.ok === false && typeof offNone.error === 'string', offNone)
  check('route-off never clears the active provider', web.searchProviderId === 'deepseek-search-api', web.searchProviderId)

  // 5e. Unregistered previous id is still used as the best guess.
  setProviders([])
  runtime.previousProviderId = 'gone-official'
  web.searchProviderId = 'deepseek-search-api'
  const offGuess = internals.routeOff()
  check('route-off uses the remembered id as a best guess', offGuess.ok === true && web.searchProviderId === 'gone-official', { result: offGuess, active: web.searchProviderId })

  // 5f. The same heuristic is used for provider-level error fallback.
  const providerForFallback = applyFresh({ retryCount: 0 })
  setProviders([betaProvider, unavailableProvider])
  runtime.previousProviderId = 'beta-official'
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  fetchQueue.push(httpError(500))
  const fallbackResult = await providerForFallback.search({ query: 'hello', maxResults: 5 }, undefined)
  check('provider error fallback calls the resolved fallback provider', fallbackResult.sources?.[0]?.url === 'https://beta.example/y', fallbackResult)
  check('provider fallback records lastResult kind', runtime.lastResult?.kind === 'provider.fallback', runtime.lastResult)

  // -------------------------------------------------------------------------
  // 6. Key resolution order (CONTRACT 3.1 / 5.1.5)
  // -------------------------------------------------------------------------
  console.log('\n# key resolution order')
  applyFresh()
  runtime.previousProviderId = 'acme-official'

  check('no key resolves to undefined', await internals.resolveKey() === undefined)
  const noKeyStatus = await snapshot()
  check('no key: status key hint mentions key file', noKeyStatus.key.configured === false && noKeyStatus.key.hint.includes(paths.keyFile), noKeyStatus.key)

  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  const envKey = await internals.resolveKey()
  check('env key resolution and kind', envKey?.kind === 'env' && envKey?.source === 'env:DEEPSEEK_API_KEY', envKey)

  world.credentialsValue = 'sk-credentials-key-1234567890'
  const credentialsKey = await internals.resolveKey()
  check('credentials take precedence over env', credentialsKey?.kind === 'credentials' && credentialsKey?.source === 'credentials:DEEPSEEK_API_KEY', credentialsKey)

  applyFresh({ apiKey: 'sk-config-key-1234567890' })
  const configKey = await internals.resolveKey()
  check('config.apiKey takes precedence over credentials/env', configKey?.kind === 'config' && configKey?.source === 'config.apiKey', configKey)
  const configKeyStatus = await snapshot()
  check('status key configured from config without leaking value', configKeyStatus.key.configured === true && JSON.stringify(configKeyStatus).includes('sk-config-key') === false, configKeyStatus.key)

  delete process.env.DEEPSEEK_API_KEY
  world.credentialsValue = undefined
  applyFresh({ keyFile: paths.customKeyFile })
  mkdirSync(dirname(paths.customKeyFile), { recursive: true })
  writeFileSync(paths.customKeyFile, 'sk-file-key-1234567890\n', 'utf8')
  const fileKey = await internals.resolveKey()
  check('custom keyFile resolves and is surfaced in status', fileKey?.kind === 'file' && fileKey?.source === `file:${paths.customKeyFile}`, fileKey)
  const fileKeyStatus = await snapshot()
  check('status.key.keyFile is the custom path', fileKeyStatus.key.keyFile === paths.customKeyFile, fileKeyStatus.key)

  applyFresh()
  writeFileSync(paths.envFile, 'DEEPSEEK_API_KEY=sk-envfile-key-1234567890\n', 'utf8')
  const envFileKey = await internals.resolveKey()
  check('$DSH_HOME/.env is the last key source', envFileKey?.kind === 'env-file' && envFileKey?.source === `file:${paths.envFile}`, envFileKey)

  // No key at all: the provider falls back to the captured provider.
  applyFresh()
  runtime.previousProviderId = 'acme-official'
  providerCalls.fallback = 0
  const callsBeforeNoKey = fetchCalls.length
  const provider = world.registeredProviders.at(-1)
  const noKeyProviderResult = await provider.search({ query: 'hello', maxResults: 5 }, undefined)
  check('no key: provider searches through the captured provider', noKeyProviderResult.sources?.[0]?.url === 'https://fallback.example/x', noKeyProviderResult)
  check('no key: captured provider was actually called', providerCalls.fallback === 1, providerCalls.fallback)
  const afterFallbackStatus = await snapshot()
  check('no key: status lastResult is provider.fallback', afterFallbackStatus.lastResult?.kind === 'provider.fallback', afterFallbackStatus.lastResult)
  check('no key: status lastError records the credential error', afterFallbackStatus.lastError?.code === 'WEB_PROVIDER_CREDENTIAL_MISSING', afterFallbackStatus.lastError)
  check('no key: no HTTP request was attempted', fetchCalls.length === callsBeforeNoKey, fetchCalls.length - callsBeforeNoKey)

  // -------------------------------------------------------------------------
  // 7. fallbackOnError and cancellation (CONTRACT 3.3 / 5.1.6)
  // -------------------------------------------------------------------------
  console.log('\n# fallbackOnError and cancellation')
  applyFresh({ fallbackOnError: false, retryCount: 0 })
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  providerCalls.fallback = 0
  fetchQueue.push(httpError(500))
  let propagated = null
  try {
    await world.registeredProviders.at(-1).search({ query: 'fail please', maxResults: 3 }, undefined)
  } catch (error) {
    propagated = error
  }
  check('fallbackOnError=false propagates the provider error', propagated?.code === 'WEB_PROVIDER_ERROR', propagated?.code)
  check('fallbackOnError=false never calls the fallback provider', providerCalls.fallback === 0, providerCalls.fallback)

  applyFresh({ retryCount: 0 })
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  providerCalls.fallback = 0
  const abortController = new AbortController()
  abortController.abort()
  let abortFailure = null
  try {
    await world.registeredProviders.at(-1).search({ query: 'cancel me', maxResults: 3 }, abortController.signal)
  } catch (error) {
    abortFailure = error
  }
  check('cancellation surfaces WEB_ABORTED', abortFailure?.code === 'WEB_ABORTED', abortFailure?.code)
  check('cancellation never triggers a fallback search', providerCalls.fallback === 0, providerCalls.fallback)

  // fallbackOnError=true (default) does fall back on a real API failure.
  providerCalls.fallback = 0
  runtime.previousProviderId = 'acme-official'
  fetchQueue.push(httpError(500))
  const recovered = await world.registeredProviders.at(-1).search({ query: 'recover', maxResults: 3 }, undefined)
  check('fallbackOnError=true recovers through the fallback provider', recovered.sources?.[0]?.url === 'https://fallback.example/x', recovered)
  check('recovery called the fallback provider', providerCalls.fallback === 1, providerCalls.fallback)

  // -------------------------------------------------------------------------
  // 8. Retries, error mapping and User-Agent (CONTRACT 3.4 / 5.1.7)
  // -------------------------------------------------------------------------
  console.log('\n# retries, error mapping and User-Agent')
  applyFresh({ retryCount: 2, retryDelayMs: 1 })
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  fetchQueue.push(httpError(500), httpError(500), searchOk())
  let callsBefore = fetchCalls.length
  const retried = await runTool({ action: 'search', query: 'retry me' })
  check('retries 5xx with retryCount extra attempts and then succeeds', retried.ok === true && fetchCalls.length - callsBefore === 3, { ok: retried.ok, calls: fetchCalls.length - callsBefore })
  check('User-Agent embeds package name and package version', fetchCalls.at(-1).init.headers['user-agent'] === `dsh-plugin-deepsearch/${packageJson.version}`, fetchCalls.at(-1).init.headers['user-agent'])

  applyFresh({ retryCount: 2, retryDelayMs: 1 })
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  fetchQueue.push(httpError(429), searchOk())
  callsBefore = fetchCalls.length
  const retried429 = await runTool({ action: 'search', query: 'retry 429' })
  check('retries 429 and then succeeds', retried429.ok === true && fetchCalls.length - callsBefore === 2, { ok: retried429.ok, calls: fetchCalls.length - callsBefore })

  applyFresh({ retryCount: 1, retryDelayMs: 1 })
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  fetchQueue.push(httpError(503), httpError(503))
  callsBefore = fetchCalls.length
  const exhausted = await runTool({ action: 'search', query: 'retry exhausted' })
  check('retries are exhausted and the error surfaces', exhausted.ok === false && exhausted.code === 'WEB_PROVIDER_ERROR' && fetchCalls.length - callsBefore === 2, { result: exhausted, calls: fetchCalls.length - callsBefore })

  applyFresh({ retryCount: 2, retryDelayMs: 1 })
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  fetchQueue.push(httpError(401))
  callsBefore = fetchCalls.length
  const unauthorized = await runTool({ action: 'search', query: 'unauthorized' })
  check('401 maps to a credential error without retrying', unauthorized.ok === false && unauthorized.code === 'WEB_PROVIDER_CREDENTIAL_MISSING' && fetchCalls.length - callsBefore === 1, { result: unauthorized, calls: fetchCalls.length - callsBefore })

  applyFresh({ retryCount: 0 })
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  fetchQueue.push(httpError(500))
  callsBefore = fetchCalls.length
  const noRetry = await runTool({ action: 'search', query: 'no retry' })
  check('retryCount=0 performs a single attempt', noRetry.ok === false && fetchCalls.length - callsBefore === 1, { result: noRetry, calls: fetchCalls.length - callsBefore })

  // -------------------------------------------------------------------------
  // 9. Custom endpoints / limits / provider id (CONTRACT 3.1 / 3.4 / 5.1.8)
  // -------------------------------------------------------------------------
  console.log('\n# custom endpoints and config overrides')
  fetchQueue.length = 0
  applyFresh({
    baseURL: 'https://search.example.test/api/',
    searchPath: 'custom/search',
    fetchPath: 'custom/fetch',
    providerId: 'acme-search-api',
    count: 3,
    maxFetchChars: 1000,
    apiKey: 'sk-config-key-1234567890',
    retryCount: 0,
  })
  const customStatus = await snapshot()
  check('custom baseURL trailing slashes are stripped', customStatus.endpoint.baseURL === 'https://search.example.test/api', customStatus.endpoint.baseURL)
  check('custom paths are forced to start with /', customStatus.endpoint.searchPath === '/custom/search' && customStatus.endpoint.fetchPath === '/custom/fetch', customStatus.endpoint)
  check('custom providerId is registered', web.searchProviders.has('acme-search-api') && web.searchProviders.get('acme-search-api') === runtime.providerObject, [...web.searchProviders.keys()])
  check('old provider id was disposed on re-registration', web.searchProviders.has('deepseek-search-api') === false, [...web.searchProviders.keys()])

  callsBefore = fetchCalls.length
  const customSearch = await runTool({ action: 'search', query: 'custom endpoint' })
  check('custom search endpoint is used', customSearch.ok === true && fetchCalls.at(-1).url === 'https://search.example.test/api/custom/search', { result: customSearch, url: fetchCalls.at(-1)?.url })
  check('config count is used by default', JSON.parse(fetchCalls.at(-1).init.body).count === 3, JSON.parse(fetchCalls.at(-1).init.body))

  fetchQueue.push(pageOk('Big page', 'x'.repeat(2000)))
  const bigFetch = await runTool({ action: 'fetch', url: 'https://example.com/big' })
  check('custom fetch endpoint is used', fetchCalls.at(-1).url === 'https://search.example.test/api/custom/fetch', fetchCalls.at(-1)?.url)
  check('maxFetchChars truncates fetched content', bigFetch.ok === true && bigFetch.truncated === true && bigFetch.content.length === 1000, { ok: bigFetch.ok, truncated: bigFetch.truncated, length: bigFetch.content?.length })

  applyFresh({ needContent: true, apiKey: 'sk-config-key-1234567890', retryCount: 0 })
  const needContentSearch = await runTool({ action: 'search', query: 'with content' })
  check('config needContent sends need_content=true', needContentSearch.ok === true && JSON.parse(fetchCalls.at(-1).init.body).need_content === true, JSON.parse(fetchCalls.at(-1).init.body))

  // A provider id owned by another plugin is never clobbered.
  applyFresh({ providerId: 'acme-official' })
  check('foreign provider id is not overwritten', web.searchProviders.get('acme-official') === acmeProvider, web.searchProviders.get('acme-official'))
  check('conflicting providerId falls back to the default id', (await snapshot()).providerId === 'deepseek-search-api', (await snapshot()).providerId)

  // -------------------------------------------------------------------------
  // 10. Language resolution and localized tool render (CONTRACT 3.2 / 5.1.9)
  // -------------------------------------------------------------------------
  console.log('\n# language resolution and tool render')
  fetchQueue.length = 0
  applyFresh({ language: 'en' })
  check('explicit language=en is reported', (await snapshot()).language === 'en')
  const checkValue = { ok: true, httpStatus: 200, ms: 12, keySource: 'env:DEEPSEEK_API_KEY', first: null }
  const enRender = renderText({ action: 'check' }, checkValue)
  check('en render of check is English and CJK-free', enRender.includes('Search API OK') && /[\u3400-\u9fff]/u.test(enRender) === false, enRender)
  const enFailure = renderText({ action: 'search' }, { ok: false, code: 'WEB_PROVIDER_ERROR', error: 'boom' })
  check('en render of a failure is localized', enFailure.includes('failed') && enFailure.includes('WEB_PROVIDER_ERROR'), enFailure)
  const enFetchRender = renderText({ action: 'fetch' }, { ok: true, url: 'https://example.com/a', title: 'T', content: 'body', truncated: true })
  check('en render of fetch includes the truncation note', enFetchRender.includes('content truncated'), enFetchRender)

  applyFresh({ language: 'zh' })
  check('explicit language=zh is reported', (await snapshot()).language === 'zh')
  const zhRender = renderText({ action: 'check' }, checkValue)
  check('zh render of check contains CJK', /[\u3400-\u9fff]/u.test(zhRender), zhRender)
  const zhFailure = renderText({ action: 'search' }, { ok: false, code: 'WEB_PROVIDER_ERROR', error: 'boom' })
  check('zh render of a failure contains CJK', /[\u3400-\u9fff]/u.test(zhFailure), zhFailure)

  delete process.env.DSH_LANGUAGE
  delete process.env.DSH_LOCALE
  delete process.env.LANG
  delete process.env.LC_ALL
  applyFresh({})
  check('auto language defaults to en', (await snapshot()).language === 'en')
  process.env.DSH_LANGUAGE = 'zh-CN'
  check('auto language detects zh from DSH_LANGUAGE', (await snapshot()).language === 'zh')
  process.env.DSH_LANGUAGE = 'en-US'
  check('auto language detects en from DSH_LANGUAGE', (await snapshot()).language === 'en')
  delete process.env.DSH_LANGUAGE
  process.env.DSH_LOCALE = 'zh_TW'
  check('auto language falls through to DSH_LOCALE', (await snapshot()).language === 'zh')
  delete process.env.DSH_LOCALE
  process.env.DSH_LANGUAGE = 'zh-CN'
  applyFresh({ language: 'en' })
  process.env.DSH_LANGUAGE = 'zh-CN'
  check('explicit language wins over the environment', (await snapshot()).language === 'en')
  delete process.env.DSH_LANGUAGE

  // The tool description/parameter schema stay English.
  check('tool description is English', /[A-Za-z]/u.test(world.tool.description) && /[\u3400-\u9fff]/u.test(world.tool.description) === false)
  check('tool parameter schema actions are stable', JSON.stringify(world.tool.parameters.properties.action.enum) === JSON.stringify(['status', 'on', 'off', 'search', 'fetch', 'check']))
  check('tool presentCall shape is stable', world.tool.presentCall({ action: 'search' })?.card === 'generic')

  // -------------------------------------------------------------------------
  // 11. HTTP route guards, mode/check routes (CONTRACT 3.5 / 5.1.11)
  // -------------------------------------------------------------------------
  console.log('\n# HTTP route guards and mode/check routes')
  fetchQueue.length = 0
  applyFresh()
  runtime.previousProviderId = 'acme-official'

  const stateRoute = await callRoute('/deepsearch/state', { method: 'GET' })
  check('GET /deepsearch/state returns JSON', stateRoute.res.status === 200 && stateRoute.body?.ok === true && stateRoute.body?.mode === 'off', stateRoute.body)
  check('state JSON contains no key value', JSON.stringify(stateRoute.body).includes('sk-test-key') === false)

  let modeGet = await callRoute('/deepsearch/mode', { method: 'GET' })
  check('GET /deepsearch/mode is rejected with 405', modeGet.res.status === 405, modeGet.res.status)
  check('rejected GET did not change the route', web.searchProviderId === 'acme-official', web.searchProviderId)

  let statePost = await callRoute('/deepsearch/state', { method: 'POST', headers: JSON_HEADERS, payload: {} })
  check('POST /deepsearch/state is rejected with 405', statePost.res.status === 405, statePost.res.status)

  modeGet = await callRoute('/deepsearch/mode', { method: 'POST', headers: { 'content-type': 'text/plain' }, payload: { mode: 'on' } })
  check('text/plain POST is rejected with 415', modeGet.res.status === 415, modeGet.res.status)
  check('non-JSON POST did not change the route', web.searchProviderId === 'acme-official', web.searchProviderId)

  modeGet = await callRoute('/deepsearch/mode', {
    method: 'POST',
    headers: { ...JSON_HEADERS, origin: 'http://evil.example' },
    payload: { mode: 'on' },
  })
  check('cross-origin POST is rejected with 403', modeGet.res.status === 403, modeGet.res.status)
  check('cross-origin POST did not change the route', web.searchProviderId === 'acme-official', web.searchProviderId)

  modeGet = await callRoute('/deepsearch/mode', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' },
    payload: { mode: 'on' },
  })
  check('Sec-Fetch-Site cross-site POST is rejected with 403', modeGet.res.status === 403, modeGet.res.status)

  const modeOn = await callRoute('/deepsearch/mode', {
    method: 'POST',
    headers: { ...JSON_HEADERS, origin: 'http://127.0.0.1:58583' },
    payload: { mode: 'on' },
  })
  check('same-origin JSON POST /deepsearch/mode works', modeOn.res.status === 200 && modeOn.body?.ok === true && modeOn.body?.state?.mode === 'on', modeOn.body)
  check('mode response keeps stable route string', modeOn.body?.route === 'deepseek-api', modeOn.body?.route)
  check('mode response keeps switch details', modeOn.body?.switch?.ok === true, modeOn.body?.switch)
  check('mode route actually switched the provider', web.searchProviderId === 'deepseek-search-api', web.searchProviderId)

  const modeOff = await callRoute('/deepsearch/mode', { method: 'POST', headers: JSON_HEADERS, payload: { mode: 'off' } })
  check('mode off keeps stable route string', modeOff.body?.route === 'builtin' && modeOff.body?.state?.mode === 'off', modeOff.body)
  check('mode off restored the captured provider', web.searchProviderId === 'acme-official', web.searchProviderId)

  const checkGet = await callRoute('/deepsearch/check', { method: 'GET' })
  check('GET /deepsearch/check is rejected with 405', checkGet.res.status === 405, checkGet.res.status)

  // The check route performs a real (mocked) request, so give it a key.
  process.env.DEEPSEEK_API_KEY = 'sk-env-key-1234567890'
  callsBefore = fetchCalls.length
  const checkPost = await callRoute('/deepsearch/check', { method: 'POST', headers: JSON_HEADERS, payload: {} })
  check('POST /deepsearch/check works with a key', checkPost.body?.ok === true && checkPost.body?.check?.ok === true, checkPost.body)
  check('check route issues exactly one search with count=1', fetchCalls.length - callsBefore === 1 && JSON.parse(fetchCalls.at(-1).init.body).count === 1, fetchCalls.length - callsBefore)

  // The check route is single-flighted.
  const checkHandler = world.routes.get('/deepsearch/check')
  const slowResA = makeRes()
  const pendingA = checkHandler(makeReq({ method: 'POST', headers: JSON_HEADERS }), slowResA)
  const slowResB = makeRes()
  await checkHandler(makeReq({ method: 'POST', headers: JSON_HEADERS }), slowResB)
  await pendingA
  check('check route is single-flighted (429)', slowResB.status === 429, slowResB.status)
  check('single-flight response is JSON', JSON.parse(slowResB.body)?.ok === false)

  // -------------------------------------------------------------------------
  // 12. POST /deepsearch/key (CONTRACT 3.5 / 5.1.10)
  // -------------------------------------------------------------------------
  console.log('\n# key route and CSRF guards')
  fetchQueue.length = 0
  applyFresh()
  runtime.previousProviderId = 'acme-official'
  rmSync(paths.keyFile, { force: true })

  const keyGet = await callRoute('/deepsearch/key', { method: 'GET' })
  check('GET /deepsearch/key is rejected with 405', keyGet.res.status === 405, keyGet.res.status)
  const keyText = await callRoute('/deepsearch/key', { method: 'POST', headers: { 'content-type': 'text/plain' }, payload: { action: 'save', key: 'sk-should-not-be-saved' } })
  check('text/plain key POST is rejected with 415', keyText.res.status === 415, keyText.res.status)
  check('rejected key POST did not write the file', existsSync(paths.keyFile) === false)
  const keyCrossOrigin = await callRoute('/deepsearch/key', { method: 'POST', headers: { ...JSON_HEADERS, origin: 'http://evil.example' }, payload: { action: 'save', key: 'sk-should-not-be-saved' } })
  check('cross-origin key POST is rejected with 403', keyCrossOrigin.res.status === 403, keyCrossOrigin.res.status)
  const keyCrossSite = await callRoute('/deepsearch/key', { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, payload: { action: 'save', key: 'sk-should-not-be-saved' } })
  check('cross-site key POST is rejected with 403', keyCrossSite.res.status === 403, keyCrossSite.res.status)
  check('rejected key POSTs did not write the file', existsSync(paths.keyFile) === false)

  const saveResult = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { action: 'save', key: 'sk-test-key-abcdef' } })
  check('save key responds ok', saveResult.res.status === 200 && saveResult.body?.ok === true, saveResult.body)
  check('save key reports configured metadata', saveResult.body?.key?.configured === true && saveResult.body?.key?.kind === 'file', saveResult.body?.key)
  check('save key never echoes the key', JSON.stringify(saveResult.body).includes('sk-test-key-abcdef') === false, saveResult.body)
  check('save key writes only the key plus newline', existsSync(paths.keyFile) && readFileSync(paths.keyFile, 'utf8') === 'sk-test-key-abcdef\n', readFileSync(paths.keyFile, 'utf8'))

  const stateAfterSave = await callRoute('/deepsearch/state', { method: 'GET' })
  check('state after save reports configured key', stateAfterSave.body?.key?.configured === true, stateAfterSave.body?.key)
  check('state after save never contains the key', JSON.stringify(stateAfterSave.body).includes('sk-test-key-abcdef') === false)
  check('key value never appears in the path fields', JSON.stringify(stateAfterSave.body?.paths).includes('sk-test-key-abcdef') === false)
  check('diag file never records the key', readFileSync(paths.diagFile, 'utf8').includes('sk-test-key-abcdef') === false)

  // Clear deletes the file and is idempotent.
  const clearResult = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { action: 'clear' } })
  check('clear key responds ok and deletes the file', clearResult.body?.ok === true && existsSync(paths.keyFile) === false, clearResult.body)
  const clearAgain = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { action: 'clear' } })
  check('clear key is idempotent', clearAgain.body?.ok === true)

  // action defaults to save.
  const defaultSave = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { key: 'sk-default-action-key' } })
  check('missing action defaults to save', defaultSave.body?.ok === true && existsSync(paths.keyFile), defaultSave.body)
  rmSync(paths.keyFile, { force: true })

  // Invalid keys never write.
  const shortKey = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { action: 'save', key: 'short' } })
  check('too-short key is rejected with ok:false', shortKey.body?.ok === false && typeof shortKey.body?.error === 'string', shortKey.body)
  check('too-short key did not write the file', existsSync(paths.keyFile) === false)
  const spacedKey = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { action: 'save', key: 'sk-invalid key-with-space' } })
  check('key containing whitespace is rejected', spacedKey.body?.ok === false && existsSync(paths.keyFile) === false, spacedKey.body)
  const unsupportedAction = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { action: 'delete', key: 'sk-test-key-abcdef' } })
  check('unsupported key action is rejected', unsupportedAction.body?.ok === false, unsupportedAction.body)

  // A custom keyFile is honored by the save route.
  applyFresh({ keyFile: paths.customKeyFile })
  const customSave = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { action: 'save', key: 'sk-custom-file-key' } })
  check('save route honors the custom keyFile', customSave.body?.ok === true && existsSync(paths.customKeyFile) && readFileSync(paths.customKeyFile, 'utf8') === 'sk-custom-file-key\n', customSave.body)
  const customClear = await callRoute('/deepsearch/key', { method: 'POST', headers: JSON_HEADERS, payload: { action: 'clear' } })
  check('clear route honors the custom keyFile', customClear.body?.ok === true && existsSync(paths.customKeyFile) === false)

  // -------------------------------------------------------------------------
  // 13. No real network was ever used by the suite.
  // -------------------------------------------------------------------------
  console.log('\n# network safety')
  check(
    'all fetch calls targeted the configured API hosts',
    fetchCalls.every((call) => call.url.startsWith('https://api.deepseek.com') || call.url.startsWith('https://search.example.test')),
    fetchCalls.map((call) => call.url),
  )
} catch (error) {
  failures.push('unexpected exception')
  console.log(`  FAIL unexpected exception :: ${error?.stack ?? error}`)
} finally {
  clearInterval(keepAlive)
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(testHome, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\nhost tests passed')
}
