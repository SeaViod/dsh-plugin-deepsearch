/**
 * Client-half mock tests: no browser, no DSH. A fake window.__ModuleLoader__, a tiny
 * fake React renderer, fake slots/locale services and a mocked global fetch cover the
 * bundle evaluation, slot registration, both languages, status helpers, static renders
 * and the state/mode/key/check request flows.
 *
 * Run: node test/client.test.mjs
 */

import { readFileSync } from 'node:fs'

const failures = []
function check(name, condition, detail) {
  if (condition === true) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`)
  }
}

const CJK = /[\u3400-\u9fff]/u
const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Fake browser shell: capture the bundle entry, replace timers (polling must not
// keep the process alive) and provide a minimal React renderer whose hook state
// survives re-renders so async interaction handlers can be asserted afterwards.
// ---------------------------------------------------------------------------

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

const timers = []
globalThis.setInterval = (fn, ms) => {
  const timer = { fn, ms, cleared: false }
  timers.push(timer)
  return timer
}
globalThis.clearInterval = (timer) => {
  if (timer !== null && timer !== undefined) timer.cleared = true
}

const hookStores = new WeakMap()
const mounted = new Set()
let renderingComponent = null

function hookStore(component) {
  let store = hookStores.get(component)
  if (store === undefined) {
    store = { cursor: 0, states: [], cleanups: [], mounted: false }
    hookStores.set(component, store)
  }
  return store
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) {
    const store = hookStore(renderingComponent)
    const index = store.cursor
    store.cursor += 1
    if (!(index in store.states)) store.states[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      store.states[index] = typeof next === 'function' ? next(store.states[index]) : next
    }
    return [store.states[index], set]
  },
  useEffect(effect) {
    const store = hookStore(renderingComponent)
    if (store.mounted) return
    store.mounted = true
    const cleanup = effect()
    if (typeof cleanup === 'function') store.cleanups.push(cleanup)
  },
  useCallback: (fn) => fn,
}

function render(component, props) {
  const store = hookStore(component)
  store.cursor = 0
  renderingComponent = component
  mounted.add(component)
  try {
    return component(props)
  } finally {
    renderingComponent = null
  }
}

function unmount(component) {
  mounted.delete(component)
  const store = hookStores.get(component)
  if (store === undefined) return
  for (const cleanup of store.cleanups) {
    try {
      cleanup()
    } catch {
      /* ignore cleanup failures */
    }
  }
  hookStores.delete(component)
}

async function flush(rounds = 8) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// Fake slots + locale services
// ---------------------------------------------------------------------------

let lang = 'zh'
let dictionaryTable = { zh: null, en: null }
let registeredLocale = null
let localeRegisterCalls = 0
let localeEffectRuns = 0

function makeLocale() {
  return {
    register(namespace, value) {
      localeRegisterCalls += 1
      registeredLocale = { namespace, value }
      dictionaryTable = { zh: value?.zh ?? null, en: value?.en ?? null }
      return () => {
        registeredLocale = null
      }
    },
    bind(namespace) {
      return (key) => {
        const table = lang === 'zh' ? dictionaryTable.zh : dictionaryTable.en
        const value = table !== null && table !== undefined ? table[key] : undefined
        return typeof value === 'string' ? value : key
      }
    },
    subscribe: () => () => {},
    getSnapshot: () => ({ active: lang }),
  }
}

function wrapEffect(callback) {
  localeEffectRuns += 1
  return callback()
}

const registrations = []

function makeSlots() {
  return {
    inject(name, callback) {
      callback()
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
  }
}

function applyBundle(bundle, options = {}) {
  registrations.length = 0
  const ctx = { slots: options.slots ?? makeSlots(), locale: options.locale ?? makeLocale() }
  if (options.effect !== false) ctx.effect = wrapEffect
  bundle.apply(ctx)
  const settings = registrations.find((entry) => entry.spec.name === 'settings.plugins.tab')
  const footer = registrations.find((entry) => entry.spec.name === 'sidebar.footer.action')
  return { settings, footer, all: registrations.slice() }
}

let importCounter = 0
async function loadBundle() {
  importCounter += 1
  captured = null
  await import(new URL(`../client.js?case=${importCounter}`, import.meta.url).href)
  const requireStub = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }
  return captured.factory(requireStub)
}

// ---------------------------------------------------------------------------
// Mocked host routes and fetch
// ---------------------------------------------------------------------------

const requests = []
let routeHandler = async () => {
  throw new Error('no mock route installed')
}

globalThis.fetch = async (url, init = {}) => {
  const request = {
    url: String(url),
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    body: init.body,
    cache: init.cache,
  }
  requests.push(request)
  const response = await routeHandler(request)
  const status = response.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => response.body,
  }
}

const DEEPSEEK_SEARCH = 'https://api.deepseek.com/v1/tools/search'
const DEEPSEEK_FETCH = 'https://api.deepseek.com/v1/tools/fetch'
const KEY_FILE = '/tmp/dsh-home/deepsearch-key.txt'
const ENV_VAR = 'DEEPSEEK_API_KEY'

function keyState(configured) {
  return configured
    ? { configured: true, source: 'env', envVar: ENV_VAR, keyFile: KEY_FILE, kind: 'env' }
    : { configured: false, source: 'none', envVar: ENV_VAR, keyFile: KEY_FILE, kind: null }
}

function snapshotFixture(overrides = {}) {
  return {
    ok: true,
    name: 'dsh-plugin-deepsearch',
    version: 'test-version',
    mode: 'off',
    route: 'builtin',
    providerId: 'deepseek-search-api',
    activeProvider: 'deepseek-account',
    previousProviderId: 'deepseek-account',
    endpoint: {
      baseURL: 'https://api.deepseek.com',
      searchPath: '/v1/tools/search',
      fetchPath: '/v1/tools/fetch',
      search: DEEPSEEK_SEARCH,
      fetch: DEEPSEEK_FETCH,
    },
    count: 8,
    needContent: false,
    language: 'en',
    key: keyState(false),
    config: {
      baseURL: 'https://api.deepseek.com',
      searchPath: '/v1/tools/search',
      fetchPath: '/v1/tools/fetch',
      providerId: 'deepseek-search-api',
      fallbackProvider: '',
      fallbackOnError: true,
      count: 8,
      needContent: false,
      timeoutMs: 30000,
      retryCount: 1,
      retryDelayMs: 1200,
      maxFetchChars: 20000,
      language: 'auto',
      checkQuery: 'DeepSeek',
    },
    lastResult: null,
    lastError: null,
    updatedAt: '2026-10-17T09:00:00.000Z',
    services: { web: true, webServer: true, credentials: false, shellEnv: false },
    diag: { tool: true, provider: true, routes: ['/deepsearch/state'], errors: [] },
    paths: {
      keyFile: KEY_FILE,
      modeFile: '/tmp/dsh-home/deepsearch-mode.json',
      diagFile: '/tmp/dsh-home/deepsearch-diag.json',
      envFile: '/tmp/dsh-home/.env',
    },
    ...overrides,
  }
}

function createHost(options = {}) {
  const host = {
    state: options.state ?? snapshotFixture(),
    modeBodies: [],
    keyBodies: [],
    checkBodies: [],
    failStateCount: options.failStateCount ?? 0,
    checkResult: options.checkResult ?? {
      ok: true,
      httpStatus: 200,
      ms: 42,
      keySource: 'env',
      first: { title: 'DeepSeek', url: 'https://www.deepseek.com' },
    },
  }
  requests.length = 0
  routeHandler = async (request) => {
    if (request.url.endsWith('deepsearch/state')) {
      if (host.failStateCount > 0) {
        host.failStateCount -= 1
        throw new TypeError('fetch failed')
      }
      return { status: 200, body: host.state }
    }
    if (request.url.endsWith('deepsearch/mode')) {
      const payload = JSON.parse(String(request.body))
      host.modeBodies.push(payload)
      const mode = payload.mode === 'on' ? 'on' : 'off'
      const route = mode === 'on' ? 'deepseek-api' : 'builtin'
      host.state = { ...host.state, mode, route }
      return {
        status: 200,
        body: { ok: true, mode, route, activeProvider: host.state.activeProvider, switch: { ok: true }, state: host.state },
      }
    }
    if (request.url.endsWith('deepsearch/key')) {
      const payload = JSON.parse(String(request.body))
      host.keyBodies.push(payload)
      host.state = { ...host.state, key: payload.action === 'clear' ? keyState(false) : keyState(true) }
      return { status: 200, body: { ok: true, key: host.state.key } }
    }
    if (request.url.endsWith('deepsearch/check')) {
      host.checkBodies.push(JSON.parse(String(request.body)))
      return { status: 200, body: { ok: true, check: host.checkResult, state: host.state } }
    }
    throw new Error(`unexpected mock route: ${request.url}`)
  }
  return host
}

// ---------------------------------------------------------------------------
// Element tree helpers
// ---------------------------------------------------------------------------

function collectText(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (node === null || typeof node !== 'object') return out
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

function textOf(node) {
  return collectText(node).join('')
}

function findNode(node, predicate) {
  if (node === null || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found !== null) return found
  }
  return null
}

function hasStrongText(node, wanted) {
  if (node === null || typeof node !== 'object') return false
  if (node.type === 'strong' && (node.children ?? []).includes(wanted)) return true
  return (node.children ?? []).some((child) => hasStrongText(child, wanted))
}

function switchNode(tree) {
  return findNode(tree, (node) => node.type === 'button' && node.props.role === 'switch')
}

function passwordInput(tree) {
  return findNode(tree, (node) => node.type === 'input' && node.props.type === 'password')
}

function buttonByText(tree, label) {
  return findNode(tree, (node) => node.type === 'button' && textOf(node).includes(label))
}

function dictT(code) {
  return (key) => {
    const table = mainBundle.__internals.dictionaries[code]
    const value = table[key]
    return typeof value === 'string' ? value : key
  }
}

// ---------------------------------------------------------------------------
// Bundle + registration
// ---------------------------------------------------------------------------

const mainBundle = await loadBundle()
const internals = mainBundle.__internals
const dictionaries = internals.dictionaries

check('bundle registers through window.__ModuleLoader__', captured !== null && captured.id === 'dsh-plugin-deepsearch', captured?.id)
check('bundle exposes a factory function', typeof captured?.factory === 'function')
check('exports apply', typeof mainBundle.apply === 'function')
check('inject is exactly [slots, locale]', Array.isArray(mainBundle.inject) && mainBundle.inject.length === 2 && mainBundle.inject[0] === 'slots' && mainBundle.inject[1] === 'locale', mainBundle.inject)
check('namespace is dsh-plugin-deepsearch', internals.NS === 'dsh-plugin-deepsearch')
check(
  'test internals are exported',
  typeof internals.summarize === 'function' && typeof internals.describeLast === 'function' && typeof internals.keyConfigured === 'function' && typeof internals.COLORS === 'object' && typeof dictionaries === 'object',
  Object.keys(internals),
)

const zhKeys = Object.keys(dictionaries.zh).sort()
const enKeys = Object.keys(dictionaries.en).sort()
check('dictionary key sets are identical', zhKeys.length > 20 && JSON.stringify(zhKeys) === JSON.stringify(enKeys), { zh: zhKeys.length, en: enKeys.length })
check('every dictionary value is a non-empty string', [dictionaries.zh, dictionaries.en].every((table) => Object.values(table).every((value) => typeof value === 'string' && value !== '')))
check('en dictionary has no CJK characters', Object.values(dictionaries.en).every((value) => !CJK.test(value)))
check('zh dictionary is actually Chinese', CJK.test(dictionaries.zh['settings.title']) && CJK.test(dictionaries.zh['status.primaryOnOk']))

const main = applyBundle(mainBundle)
check('dictionaries registered under the plugin namespace', registeredLocale !== null && registeredLocale.namespace === internals.NS, registeredLocale?.namespace)
check('registered dictionaries are the exported ones', registeredLocale.value.zh === dictionaries.zh && registeredLocale.value.en === dictionaries.en)
check('dictionary registration happens once, inside ctx.effect', localeRegisterCalls === 1 && localeEffectRuns === 1, { registers: localeRegisterCalls, effects: localeEffectRuns })
check('both slot seats are registered', main.settings !== undefined && main.footer !== undefined, main.all.map((entry) => entry.spec.name))

const settingsSpec = main.settings.spec
const footerSpec = main.footer.spec
check('settings slot metadata matches the contract', settingsSpec.name === 'settings.plugins.tab' && settingsSpec.id === 'deepsearch' && settingsSpec.order === 55 && settingsSpec.locale === internals.NS, settingsSpec)
check('footer slot metadata matches the contract', footerSpec.name === 'sidebar.footer.action' && footerSpec.id === 'deepsearch-switch' && footerSpec.order === 61 && footerSpec.locale === internals.NS, footerSpec)
check('both slots expose an inject thunk returning t', typeof settingsSpec.inject === 'function' && typeof settingsSpec.inject().t === 'function' && typeof footerSpec.inject === 'function' && typeof footerSpec.inject().t === 'function')

lang = 'zh'
check('settings label resolves in zh', settingsSpec.label() === dictionaries.zh['settings.title'], settingsSpec.label())
lang = 'en'
check('settings label resolves in en', settingsSpec.label() === dictionaries.en['settings.title'], settingsSpec.label())
const thunkT = settingsSpec.inject().t
lang = 'zh'
const thunkZh = thunkT('settings.title')
lang = 'en'
const thunkEn = thunkT('settings.title')
check('inject thunk t follows the active language', thunkZh === dictionaries.zh['settings.title'] && thunkEn === dictionaries.en['settings.title'], { thunkZh, thunkEn })
check('both registered seats carry components', typeof main.settings.component === 'function' && typeof main.footer.component === 'function')

// ---------------------------------------------------------------------------
// Status helpers (pure, localized, host-independent)
// ---------------------------------------------------------------------------

const enT = dictT('en')
const zhT = dictT('zh')
const onInput = { mode: 'on', key: { configured: true }, activeProvider: 'deepseek-search-api', endpoint: { search: DEEPSEEK_SEARCH } }
const onNoKeyInput = { mode: 'on', key: { configured: false }, activeProvider: 'deepseek-search-api', endpoint: { search: DEEPSEEK_SEARCH } }
const offInput = { mode: 'off', key: { configured: true }, activeProvider: 'acme-official' }

const onOkEn = internals.summarize(onInput, enT)
check('summarize(en): on + key is green and says on', onOkEn.color === internals.COLORS.ok && onOkEn.primary === dictionaries.en['status.primaryOnOk'], onOkEn)
check('summarize(en): secondary names provider and endpoint', onOkEn.secondary.includes('deepseek-search-api') && onOkEn.secondary.includes(DEEPSEEK_SEARCH) && !/[{}]/.test(onOkEn.secondary), onOkEn.secondary)
const onNoKeyEn = internals.summarize(onNoKeyInput, enT)
check('summarize(en): on without key warns instead of succeeding', onNoKeyEn.color === internals.COLORS.warn && onNoKeyEn.primary === dictionaries.en['status.primaryOnNoKey'], onNoKeyEn)
const offEn = internals.summarize(offInput, enT)
check('summarize(en): off is neutral and names the provider', offEn.color === internals.COLORS.secondary && offEn.primary === dictionaries.en['status.primaryOff'] && offEn.secondary.includes('acme-official'), offEn)
check('summarize(en): tolerates a null snapshot', internals.summarize(null, enT).primary === dictionaries.en['status.primaryOff'])
const onOkZh = internals.summarize(onInput, zhT)
const onNoKeyZh = internals.summarize(onNoKeyInput, zhT)
const offZh = internals.summarize(offInput, zhT)
check('summarize(zh): all three states are localized', onOkZh.primary === dictionaries.zh['status.primaryOnOk'] && onNoKeyZh.primary === dictionaries.zh['status.primaryOnNoKey'] && offZh.primary === dictionaries.zh['status.primaryOff'])
check('summarize(zh): colors are unchanged across languages', onOkZh.color === internals.COLORS.ok && onNoKeyZh.color === internals.COLORS.warn && offZh.color === internals.COLORS.secondary)
check('summarize(zh): provider and endpoint interpolated', onOkZh.secondary.includes('deepseek-search-api') && onOkZh.secondary.includes(DEEPSEEK_SEARCH) && CJK.test(onOkZh.secondary))

check('describeLast(en): empty history', internals.describeLast(null, enT) === dictionaries.en['last.none'])
check('describeLast(zh): empty history', internals.describeLast({ lastResult: null }, zhT) === dictionaries.zh['last.none'])
const lastAt = '2026-10-12T09:47:00.000Z'
const searchLastEn = internals.describeLast({ lastResult: { at: lastAt, kind: 'search', ok: true, ms: 120, count: 3, query: 'deepseek' } }, enT)
check('describeLast(en): search success', searchLastEn.includes('Search') && searchLastEn.includes('120ms') && searchLastEn.includes('3 results') && searchLastEn.includes('deepseek') && !/[{}]/.test(searchLastEn), searchLastEn)
const fetchLastEn = internals.describeLast({ lastResult: { at: lastAt, kind: 'fetch', ok: true, url: 'https://example.com/doc' } }, enT)
check('describeLast(en): fetch success', fetchLastEn.includes('Fetch') && fetchLastEn.includes('https://example.com/doc'), fetchLastEn)
const fallbackLastEn = internals.describeLast({ lastResult: { at: lastAt, kind: 'provider.fallback', ok: true, query: 'fallback query', count: 2 } }, enT)
check('describeLast(en): provider fallback', fallbackLastEn.includes('Fallback search') && fallbackLastEn.includes('fallback query'), fallbackLastEn)
const failedLastEn = internals.describeLast({ lastResult: { at: lastAt, kind: 'search', ok: false, code: 'HTTP_401', error: 'unauthorized' } }, enT)
check('describeLast(en): failure keeps the code and message', failedLastEn.includes('failed') && failedLastEn.includes('[HTTP_401]') && failedLastEn.includes('unauthorized'), failedLastEn)
const searchLastZh = internals.describeLast({ lastResult: { at: lastAt, kind: 'search', ok: true, ms: 120, count: 3, query: 'deepseek' } }, zhT)
check('describeLast(zh): search success localized', searchLastZh.includes(dictionaries.zh['last.kind.search']) && searchLastZh.includes('3 条') && CJK.test(searchLastZh), searchLastZh)
check('describeLast(zh): fetch and fallback kinds localized', internals.describeLast({ lastResult: { kind: 'fetch', ok: true, url: 'u' } }, zhT).includes(dictionaries.zh['last.kind.fetch']) && internals.describeLast({ lastResult: { kind: 'provider.fallback', ok: true, query: 'q' } }, zhT).includes(dictionaries.zh['last.kind.fallback']))
check('describeLast(zh): failure localized', internals.describeLast({ lastResult: { kind: 'search', ok: false, code: 'E', error: 'boom' } }, zhT).includes('失败'))

check('keyConfigured is unchanged in behavior', internals.keyConfigured({ key: { configured: true } }) === true && internals.keyConfigured({ key: { configured: false } }) === false && internals.keyConfigured(null) === false && internals.keyConfigured({}) === false)

// ---------------------------------------------------------------------------
// Settings page: static render in both languages, details, key hint
// ---------------------------------------------------------------------------

const panel = main.settings.component
const footer = main.footer.component

let host = createHost()
unmount(panel)
const panelTimerMark = timers.length
lang = 'zh'
let settingsTree = null
let renderFailure = null
try {
  settingsTree = render(panel)
} catch (cause) {
  renderFailure = cause
}
check('settings page renders before the first state response', renderFailure === null && settingsTree !== null, renderFailure !== null ? String(renderFailure) : undefined)
const panelTimers = timers.slice(panelTimerMark)
check('settings page polls state every 5000ms', panelTimers.some((timer) => timer.ms === 5000 && timer.cleared === false), panelTimers.map((timer) => timer.ms))
await flush()
settingsTree = render(panel)
let texts = collectText(settingsTree)
check('settings page title comes from the zh dictionary', texts.includes(dictionaries.zh['settings.title']))
check('settings page contains no literal markdown asterisks', texts.every((text) => !text.includes('**')))
check('settings page emphasizes web_search with a <strong> node', hasStrongText(settingsTree, dictionaries.zh['term.webSearch']))
lang = 'en'
settingsTree = render(panel)
texts = collectText(settingsTree)
check('settings page renders in en without CJK', texts.includes(dictionaries.en['settings.title']) && texts.every((text) => !CJK.test(text)), texts.filter((text) => CJK.test(text)))
check(
  'details grid labels are localized',
  ['details.mode', 'details.provider', 'details.key', 'details.searchEndpoint', 'details.fetchEndpoint', 'details.count', 'details.lastCall', 'details.lastError'].every((key) => texts.includes(dictionaries.en[key])),
)
check('details grid renders endpoint, provider and count values', texts.includes(DEEPSEEK_SEARCH) && texts.includes(DEEPSEEK_FETCH) && texts.includes('deepseek-account') && texts.includes('8'))
const expectedHint = dictionaries.en['hint.noKey'].replace('{file}', KEY_FILE).replace('{env}', ENV_VAR)
check('key hint is localized with snapshot.paths.keyFile and key.envVar', texts.includes(expectedHint), texts.filter((text) => text.includes('No API key')))
check('key hint mentions Settings -> Built-in plugins -> Web Search', expectedHint.includes('Settings → Built-in plugins → Web Search'))
const switchControl = switchNode(settingsTree)
check('switch is accessible with role="switch" and aria state', switchControl !== null && switchControl.props['aria-checked'] === false && switchControl.props['aria-label'] === dictionaries.en['settings.switchAria'])
const initialInput = passwordInput(settingsTree)
check('key editor shows an empty password input', initialInput !== null && initialInput.props.value === '' && initialInput.props.type === 'password')
check('key editor shows Save but no Clear while no key is configured', buttonByText(settingsTree, dictionaries.en['key.save']) !== null && buttonByText(settingsTree, dictionaries.en['key.clear']) === null)

lang = 'zh'
const propsOverrideTree = render(panel, { t: dictT('en') })
check('components prefer props.t when the host injects one', collectText(propsOverrideTree).includes(dictionaries.en['settings.title']))
lang = 'en'

// ---------------------------------------------------------------------------
// Mode toggle flow (mocked POST /deepsearch/mode)
// ---------------------------------------------------------------------------

host = createHost({ state: snapshotFixture({ mode: 'off', key: keyState(true) }) })
unmount(panel)
render(panel)
await flush()
let toggleTree = render(panel)
check('switch reflects the off snapshot', switchNode(toggleTree).props['aria-checked'] === false)
await switchNode(toggleTree).props.onClick()
await flush()
toggleTree = render(panel)
const modeRequest = requests.filter((request) => request.url.endsWith('deepsearch/mode')).pop()
check('toggle POSTs {mode:"on"} to the mode route', host.modeBodies.length === 1 && host.modeBodies[0].mode === 'on', host.modeBodies)
check('mode POST is same-origin JSON with cache:no-store', modeRequest !== undefined && modeRequest.method === 'POST' && modeRequest.headers['content-type'] === 'application/json' && modeRequest.cache === 'no-store' && modeRequest.url === 'deepsearch/mode', modeRequest)
check('switch flips to on after the mode response', switchNode(toggleTree).props['aria-checked'] === true)
check('status primary is localized after the toggle', collectText(toggleTree).includes(dictionaries.en['status.primaryOnOk']))
await switchNode(toggleTree).props.onClick()
await flush()
toggleTree = render(panel)
check('toggling again POSTs {mode:"off"}', host.modeBodies.length === 2 && host.modeBodies[1].mode === 'off', host.modeBodies)
check('switch flips back to off', switchNode(toggleTree).props['aria-checked'] === false)

// ---------------------------------------------------------------------------
// Test-endpoint flow (mocked POST /deepsearch/check)
// ---------------------------------------------------------------------------

const checkButton = buttonByText(toggleTree, dictionaries.en['settings.testEndpoint'])
check('test-endpoint button exists', checkButton !== null)
await checkButton.props.onClick()
await flush()
const checkTree = render(panel)
const checkRequest = requests.filter((request) => request.url.endsWith('deepsearch/check')).pop()
check('test endpoint POSTs to the check route', host.checkBodies.length === 1 && Object.keys(host.checkBodies[0]).length === 0, host.checkBodies)
check('check POST is JSON with cache:no-store', checkRequest !== undefined && checkRequest.method === 'POST' && checkRequest.headers['content-type'] === 'application/json' && checkRequest.cache === 'no-store')
const expectedCheck = dictionaries.en['check.ok'].replace('{httpStatus}', '200').replace('{ms}', '42').replace('{keySource}', 'env') + dictionaries.en['check.example'].replace('{title}', 'DeepSeek').replace('{url}', 'https://www.deepseek.com')
check('check result line is localized', collectText(checkTree).includes(expectedCheck), collectText(checkTree).filter((text) => text.includes('HTTP')))

// ---------------------------------------------------------------------------
// Key editor flow (mocked POST /deepsearch/key)
// ---------------------------------------------------------------------------

host = createHost()
unmount(panel)
lang = 'en'
render(panel)
await flush()
let keyTree = render(panel)
const keyInputNode = passwordInput(keyTree)
check('key input starts empty', keyInputNode.props.value === '')
const secret = 'sk-test-0123456789abcdef'
keyInputNode.props.onChange({ target: { value: secret } })
keyTree = render(panel)
check('key input keeps the typed value', passwordInput(keyTree).props.value === secret)
const saveButton = buttonByText(keyTree, dictionaries.en['key.save'])
check('save button exists', saveButton !== null)
await saveButton.props.onClick()
await flush()
keyTree = render(panel)
const saveRequest = requests.filter((request) => request.url.endsWith('deepsearch/key')).pop()
check('save POSTs {action:"save", key} to the key route', host.keyBodies.length === 1 && host.keyBodies[0].action === 'save' && host.keyBodies[0].key === secret, host.keyBodies)
check('key save uses the document-relative candidate path', saveRequest.url === 'deepsearch/key', saveRequest.url)
check('the key value never appears in a request URL', requests.every((request) => !request.url.includes(secret)))
check('key save is a same-origin JSON POST with cache:no-store', saveRequest.method === 'POST' && saveRequest.headers['content-type'] === 'application/json' && saveRequest.cache === 'no-store')
check('state is refreshed after saving the key', requests.filter((request) => request.url.endsWith('deepsearch/state')).length >= 2)
check('key input is cleared after a successful save', passwordInput(keyTree).props.value === '')
check('save confirmation is localized', collectText(keyTree).includes(dictionaries.en['key.saved']))
check('the saved key is never rendered', collectText(keyTree).every((text) => !text.includes(secret)))
check('Clear appears once a key is configured', buttonByText(keyTree, dictionaries.en['key.clear']) !== null)
const clearButton = buttonByText(keyTree, dictionaries.en['key.clear'])
await clearButton.props.onClick()
await flush()
keyTree = render(panel)
const clearBody = host.keyBodies[1]
check('clear POSTs only {action:"clear"}', host.keyBodies.length === 2 && clearBody.action === 'clear' && clearBody.key === undefined, clearBody)
check('clear confirmation is localized', collectText(keyTree).includes(dictionaries.en['key.cleared']))
check('Clear disappears once the key is cleared', buttonByText(keyTree, dictionaries.en['key.clear']) === null)
check('the no-key hint returns after clearing', collectText(keyTree).includes(expectedHint))

// ---------------------------------------------------------------------------
// Details: diagnostics warnings, last call and last error lines
// ---------------------------------------------------------------------------

host = createHost({
  state: snapshotFixture({
    mode: 'on',
    lastResult: { at: lastAt, kind: 'search', ok: true, ms: 120, count: 3, query: 'deepseek' },
    lastError: { message: 'connect ECONNREFUSED' },
    diag: { tool: true, provider: true, routes: ['/deepsearch/state'], errors: ['shell env unavailable'] },
  }),
})
unmount(panel)
lang = 'en'
render(panel)
await flush()
const detailTree = render(panel)
const detailTexts = collectText(detailTree)
check('diagnostics warnings show a localized label and raw messages', detailTexts.includes(dictionaries.en['warnings.label']) && detailTexts.includes('shell env unavailable'), detailTexts.filter((text) => text.includes('Wiring') || text.includes('shell')))
check('last call line is localized', detailTexts.some((text) => text.includes('Search') && text.includes('120ms') && text.includes('3 results')), detailTexts.filter((text) => text.includes('Search')))
check('last error message is shown as-is', detailTexts.includes('connect ECONNREFUSED'))
unmount(panel)

// ---------------------------------------------------------------------------
// Defensive render: a minimal snapshot must not throw
// ---------------------------------------------------------------------------

host = createHost({ state: { ok: true, mode: 'on' } })
unmount(panel)
let minimalFailure = null
let minimalTree = null
try {
  render(panel)
  await flush()
  minimalTree = render(panel)
} catch (cause) {
  minimalFailure = cause
}
check('settings page tolerates a minimal snapshot', minimalFailure === null && minimalTree !== null && collectText(minimalTree).includes(dictionaries.en['settings.title']), minimalFailure !== null ? String(minimalFailure) : undefined)
unmount(panel)

// ---------------------------------------------------------------------------
// Sidebar footer: label, tooltip, wide prop, 8000ms poll
// ---------------------------------------------------------------------------

host = createHost({ state: snapshotFixture({ mode: 'off', key: keyState(true) }) })
unmount(footer)
const footerTimerMark = timers.length
lang = 'en'
let footerTree = render(footer)
const footerPoll = timers.slice(footerTimerMark).find((timer) => timer.ms === 8000)
check('footer polls state every 8000ms', footerPoll !== undefined && footerPoll.cleared === false)
await flush()
footerTree = render(footer)
check('footer shows the localized builtin label', collectText(footerTree).includes(dictionaries.en['footer.off']), collectText(footerTree))
check('footer tooltip is localized', footerTree.props.title === dictionaries.en['footer.titleOff'], footerTree.props.title)
await findNode(footerTree, (node) => node.type === 'button').props.onClick()
await flush()
footerTree = render(footer)
check('footer toggle POSTs mode on', host.modeBodies.length === 1 && host.modeBodies[0].mode === 'on', host.modeBodies)
check('footer shows the API label and tooltip once on', collectText(footerTree).includes(dictionaries.en['footer.on']) && footerTree.props.title === dictionaries.en['footer.titleOnConfigured'])
const narrowTree = render(footer, { wide: false })
check('footer hides the short label when wide === false', textOf(narrowTree) === '' && typeof narrowTree.props.title === 'string', textOf(narrowTree))
unmount(footer)
check('footer clears its poll on unmount', footerPoll.cleared === true)

// ---------------------------------------------------------------------------
// Candidate URL fallback + sticky route prefix (fresh bundle, fresh resolvedBase)
// ---------------------------------------------------------------------------

const fallbackBundle = await loadBundle()
const fallbackBundleContext = applyBundle(fallbackBundle)
host = createHost({ failStateCount: 1, state: snapshotFixture({ mode: 'off', key: keyState(true) }) })
unmount(fallbackBundleContext.footer.component)
lang = 'en'
render(fallbackBundleContext.footer.component)
await flush()
const stateRequests = requests.filter((request) => request.url.endsWith('deepsearch/state'))
check('state fetch falls back from relative to absolute route', stateRequests.length === 2 && stateRequests[0].url === 'deepsearch/state' && stateRequests[1].url === '/deepsearch/state', stateRequests.map((request) => request.url))
const fallbackTree = render(fallbackBundleContext.footer.component)
check('footer renders after the fallback route succeeds', collectText(fallbackTree).includes(dictionaries.en['footer.off']))
await findNode(fallbackTree, (node) => node.type === 'button').props.onClick()
await flush()
const fallbackModeRequest = requests.filter((request) => request.url.endsWith('deepsearch/mode')).pop()
check('the resolved route prefix is reused by later calls', fallbackModeRequest !== undefined && fallbackModeRequest.url === '/deepsearch/mode', fallbackModeRequest?.url)
unmount(fallbackBundleContext.footer.component)

// ---------------------------------------------------------------------------
// Failing state fetch: both candidates tried, localized error rendered
// ---------------------------------------------------------------------------

const failingBundle = await loadBundle()
const failingContext = applyBundle(failingBundle)
host = createHost({ failStateCount: 2 })
const failingPanel = failingContext.settings.component
unmount(failingPanel)
lang = 'en'
render(failingPanel)
await flush()
const failingTree = render(failingPanel)
const failingTexts = collectText(failingTree)
check('a failing state fetch shows a localized error', failingTexts.some((text) => text.startsWith('Request failed:') && text.includes('fetch failed')), failingTexts.filter((text) => text.includes('Request')))
check('the failing fetch tried both route candidates', requests.filter((request) => request.url.endsWith('deepsearch/state')).length === 2)
lang = 'zh'
const failingTreeZh = render(failingPanel)
check('the request error is localized in zh', collectText(failingTreeZh).some((text) => text.startsWith('接口错误：')), collectText(failingTreeZh).filter((text) => CJK.test(text)))
lang = 'en'
unmount(failingPanel)

// ---------------------------------------------------------------------------
// apply() robustness: slot failures, missing locale service, missing context
// ---------------------------------------------------------------------------

const robustBundle = await loadBundle()
const consoleErrors = []
const realConsoleError = console.error
console.error = (...args) => {
  consoleErrors.push(args)
}
let applyThrew = null
try {
  robustBundle.apply({ slots: { inject() { throw new Error('slots unavailable') } } })
} catch (cause) {
  applyThrew = cause
} finally {
  console.error = realConsoleError
}
check('apply never throws when slot registration fails', applyThrew === null, applyThrew !== null ? String(applyThrew) : undefined)
check('slot registration failures are logged in English', consoleErrors.length === 2 && consoleErrors.every((args) => typeof args[0] === 'string' && args[0].includes('failed to register') && !CJK.test(args[0])), consoleErrors.map((args) => args[0]))
let missingContextThrew = null
try {
  robustBundle.apply(undefined)
} catch (cause) {
  missingContextThrew = cause
}
check('apply tolerates a missing context', missingContextThrew === null)

createHost()
registrations.length = 0
const robustLocale = makeLocale()
const localeRegisterMark = localeRegisterCalls
robustBundle.apply({ slots: makeSlots(), locale: robustLocale })
const robustSettings = registrations.find((entry) => entry.spec.name === 'settings.plugins.tab')
check('dictionaries register even without ctx.effect', localeRegisterCalls === localeRegisterMark + 1 && registeredLocale !== null && registeredLocale.namespace === internals.NS)
check(
  'without a bound locale service the label falls back to the navigator dictionary',
  [dictionaries.zh['settings.title'], dictionaries.en['settings.title']].includes(robustSettings.spec.label()),
  robustSettings.spec.label(),
)
const robustTree = render(robustSettings.component)
check('components render without a locale service', robustTree !== null && collectText(robustTree).length > 0)
unmount(robustSettings.component)

// ---------------------------------------------------------------------------
// Source-level contract guards
// ---------------------------------------------------------------------------

check('bundle keeps the hand-written loader format', CLIENT_SOURCE.includes('window.__ModuleLoader__.load({') && CLIENT_SOURCE.includes('factory: (require) =>'))
const requiredModules = [...CLIENT_SOURCE.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1])
check('bundle requires only react', requiredModules.length === 1 && requiredModules[0] === 'react', requiredModules)
check('bundle contains no local machine paths', !/C:\\Users|23564|E:\\Openhanao|dsh-runtimes/u.test(CLIENT_SOURCE))
check('bundle contains no old version literal', !CLIENT_SOURCE.includes('0.1.1'))
check('bundle contains no hardcoded official provider id', !CLIENT_SOURCE.includes('deepseek-official'))
check('bundle never logs user input', !/console\.log\(/u.test(CLIENT_SOURCE))
const zhStart = CLIENT_SOURCE.indexOf('const ZH = ')
const enStart = CLIENT_SOURCE.indexOf('const EN = ')
check(
  'CJK characters appear only inside the zh dictionary',
  zhStart > 0 && enStart > zhStart && !CJK.test(CLIENT_SOURCE.slice(0, zhStart)) && CJK.test(CLIENT_SOURCE.slice(zhStart, enStart)) && !CJK.test(CLIENT_SOURCE.slice(enStart)),
)
check('bundle keeps the 5000ms/8000ms polling intervals', CLIENT_SOURCE.includes('5000') && CLIENT_SOURCE.includes('8000'))

// ---------------------------------------------------------------------------
// Cleanup: every mounted component is unmounted, every poll timer cleared
// ---------------------------------------------------------------------------

for (const component of [...mounted]) unmount(component)
check('all polling timers are cleared on unmount', timers.every((timer) => timer.cleared === true), timers.filter((timer) => !timer.cleared).map((timer) => timer.ms))

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s): ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\nclient tests passed')
}
