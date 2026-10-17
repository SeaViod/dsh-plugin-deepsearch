/**
 * dsh-plugin-deepsearch — browser half: the Settings -> Built-in plugins -> "DeepSeek
 * Search" tab and a sidebar footer switch.
 *
 * Hand-written client bundle in the same shape as the official artifacts:
 *   window.__ModuleLoader__.load({ id: <package name>, factory: (require) => { ... } })
 * The only require-able module used here is `react` (no build step, no external CSS).
 *
 * Host half (index.js) serves four same-origin plugin routes on the webserver:
 *   GET  /deepsearch/state
 *   POST /deepsearch/mode    { mode: "on" | "off" }
 *   POST /deepsearch/check   {}
 *   POST /deepsearch/key     { action: "save" | "clear", key?: string }
 *
 * Every user-visible string lives in the ZH/EN dictionaries below. They are registered
 * once under the `dsh-plugin-deepsearch` locale namespace, and components translate
 * through the host locale service (or a defensive navigator-based translator when the
 * locale service is missing).
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-deepsearch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Locale namespace for our dictionaries and slot metadata. */
		const NS = "dsh-plugin-deepsearch";

		/** Slots for the UI seats; locale so the host re-renders us on language change. */
		const inject = ["slots", "locale"];

		/** Route candidates: document-relative first (frontend-static sets <base href="./">), then root-absolute. */
		const CANDIDATES = ["deepsearch/state", "/deepsearch/state"];
		let resolvedBase = null;

		// ---------------------------------------------------------------------------
		// Bilingual dictionaries. Both objects must keep exactly the same key set.
		// All user-visible copy lives here; `en` values must stay CJK-free.
		// `{placeholder}` tokens are interpolated by format().
		// ---------------------------------------------------------------------------

		const ZH = {
			"common.unknown": "未知",
			"common.none": "—",
			"term.webSearch": "web_search",
			"settings.title": "DeepSeek 搜索",
			"settings.introBefore": "开关决定 ",
			"settings.introAfter": " 走哪条检索路线：关闭 = DSH 默认（DeepSeek 账号服务端搜索，一次搜索是一个模型轮次）；打开 = DeepSeek Search API（POST /v1/tools/search，按成功请求计费）。切换立即生效，不用重启。",
			"settings.switchAria": "内置搜索走 DeepSeek Search API",
			"settings.runningOn": "内置 web_search 的搜索结果由 Search API 提供",
			"settings.runningOff": "内置 web_search 保持 DSH 默认路线",
			"settings.testEndpoint": "测试接口",
			"status.primaryOnOk": "已打开：内置搜索走 DeepSeek Search API",
			"status.primaryOnNoKey": "已打开，但还缺 API Key",
			"status.primaryOff": "已关闭：走 DSH 默认搜索",
			"status.secondaryOnOk": "路由：{provider} ← 内置 web_search 走 {endpoint}",
			"status.secondaryOnNoKey": "尚未配置 API Key —— 搜索会回退到默认搜索提供方（开关仍是打开状态）",
			"status.secondaryOff": "路由：{provider}（DSH 默认搜索路线）",
			"last.none": "还没有调用记录",
			"last.kind.search": "搜索",
			"last.kind.fetch": "抓取",
			"last.kind.fallback": "回退搜索",
			"last.failed": "{at} {kind} 失败{code}：{error}",
			"last.success": "{at} {kind}{metrics} · {target}",
			"last.ms": "{ms}ms",
			"last.count": "{count} 条",
			"details.mode": "开关",
			"details.modeOn": "已打开（走 Search API）",
			"details.modeOff": "已关闭（走 DSH 默认搜索）",
			"details.provider": "生效提供方",
			"details.key": "API Key",
			"details.keyConfigured": "已配置（来源：{source}）",
			"details.keyMissing": "未配置",
			"details.searchEndpoint": "Search 接口",
			"details.fetchEndpoint": "Fetch 接口",
			"details.count": "单次条数",
			"details.lastCall": "最近一次调用",
			"details.lastError": "最近错误",
			"key.label": "API Key",
			"key.placeholder": "粘贴 DeepSeek API Key",
			"key.save": "保存",
			"key.clear": "清除",
			"key.saved": "API Key 已保存。",
			"key.cleared": "API Key 已清除。",
			"key.empty": "请先输入 API Key。",
			"hint.noKey": "还没有 API Key：把 DeepSeek 官方 key 写到 {file} 的第一行，或设置环境变量 {env}，或在「设置 → 内置插件 → 网页搜索」中保存（本插件复用同一个凭据）。开关打开时，搜索会自动回退到账号搜索。",
			"warnings.label": "接线告警：",
			"errors.api": "接口错误：{message}",
			"errors.key": "Key 更新失败：{message}",
			"errors.unreachable": "无法访问宿主接口：插件路由可能还没有就绪。",
			"check.ok": "接口正常：HTTP {httpStatus}，{ms}ms，key 来源 {keySource}",
			"check.example": " · 示例：{title} {url}",
			"check.failed": "接口检查失败{code}：{error}",
			"footer.on": "搜索：API",
			"footer.off": "搜索：内置",
			"footer.titleOnConfigured": "搜索路线：DeepSeek Search API（key 已配置，点击关闭）",
			"footer.titleOnNoKey": "搜索路线：DeepSeek Search API（缺 key，会回退到账号搜索；点击关闭）",
			"footer.titleOff": "搜索路线：DSH 默认（点击打开 DeepSeek Search API 路线）",
		};

		const EN = {
			"common.unknown": "unknown",
			"common.none": "—",
			"term.webSearch": "web_search",
			"settings.title": "DeepSeek Search",
			"settings.introBefore": "The switch decides which route ",
			"settings.introAfter": " uses: off = DSH default (DeepSeek account server-side search; one search is one model turn); on = DeepSeek Search API (POST /v1/tools/search, billed per successful request). Changes take effect immediately, no restart.",
			"settings.switchAria": "Route the built-in search through the DeepSeek Search API",
			"settings.runningOn": "Built-in web_search results are served by the Search API",
			"settings.runningOff": "Built-in web_search keeps the DSH default route",
			"settings.testEndpoint": "Test endpoint",
			"status.primaryOnOk": "On: built-in search uses the DeepSeek Search API",
			"status.primaryOnNoKey": "On, but the API key is missing",
			"status.primaryOff": "Off: DSH default search",
			"status.secondaryOnOk": "Route: {provider} ← built-in web_search uses {endpoint}",
			"status.secondaryOnNoKey": "No API key yet — search falls back to the default search provider (the switch stays on).",
			"status.secondaryOff": "Route: {provider} (DSH default search route)",
			"last.none": "No calls yet",
			"last.kind.search": "Search",
			"last.kind.fetch": "Fetch",
			"last.kind.fallback": "Fallback search",
			"last.failed": "{at} {kind} failed{code}: {error}",
			"last.success": "{at} {kind}{metrics} · {target}",
			"last.ms": "{ms}ms",
			"last.count": "{count} results",
			"details.mode": "Switch",
			"details.modeOn": "On (Search API route)",
			"details.modeOff": "Off (DSH default search)",
			"details.provider": "Effective provider",
			"details.key": "API key",
			"details.keyConfigured": "Configured (source: {source})",
			"details.keyMissing": "Not configured",
			"details.searchEndpoint": "Search endpoint",
			"details.fetchEndpoint": "Fetch endpoint",
			"details.count": "Results per call",
			"details.lastCall": "Last call",
			"details.lastError": "Last error",
			"key.label": "API key",
			"key.placeholder": "Paste a DeepSeek API key",
			"key.save": "Save",
			"key.clear": "Clear",
			"key.saved": "API key saved.",
			"key.cleared": "API key cleared.",
			"key.empty": "Enter an API key first.",
			"hint.noKey": "No API key yet: write the DeepSeek key to the first line of {file}, set the environment variable {env}, or save it under Settings → Built-in plugins → Web Search (this plugin reuses the same credential). Search falls back to account search while the switch is on.",
			"warnings.label": "Wiring warnings:",
			"errors.api": "Request failed: {message}",
			"errors.key": "Key update failed: {message}",
			"errors.unreachable": "Could not reach the host routes: the plugin routes may not be ready yet.",
			"check.ok": "Endpoint OK: HTTP {httpStatus}, {ms}ms, key source {keySource}",
			"check.example": " · example: {title} {url}",
			"check.failed": "Endpoint check failed{code}: {error}",
			"footer.on": "Search: API",
			"footer.off": "Search: builtin",
			"footer.titleOnConfigured": "Search route: DeepSeek Search API (key configured, click to turn off)",
			"footer.titleOnNoKey": "Search route: DeepSeek Search API (no key, falls back to account search; click to turn off)",
			"footer.titleOff": "Search route: DSH default (click to route through the DeepSeek Search API)",
		};

		/** Dictionaries keyed by language code, shared with the tests. */
		const dictionaries = { zh: ZH, en: EN };

		const COLORS = {
			label: "var(--dsw-alias-label-primary, #1f2329)",
			secondary: "var(--dsw-alias-label-tertiary, #8a8f99)",
			border: "var(--dsw-alias-border-l2, rgba(0,0,0,.12))",
			ok: "#22a06b",
			bad: "#e5484d",
			warn: "#d97706",
			chip: "var(--dsw-alias-bg-l2, rgba(0,0,0,.04))",
		};

		const CSS = {
			page: { maxWidth: 760, display: "flex", flexDirection: "column", gap: 14, color: COLORS.label },
			row: { display: "flex", alignItems: "center", gap: 12 },
			column: { display: "flex", flexDirection: "column", gap: 2 },
			title: { margin: 0, fontSize: 18, fontWeight: 600 },
			intro: { margin: 0, fontSize: 13, color: COLORS.secondary, lineHeight: "20px" },
			card: { border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 },
			switch: (on, busy) => ({
				position: "relative", width: 44, height: 24, borderRadius: 999, flex: "0 0 auto",
				border: `1px solid ${on ? COLORS.ok : COLORS.border}`,
				background: on ? COLORS.ok : "transparent",
				cursor: busy ? "wait" : "pointer", padding: 0, transition: "background .15s ease",
			}),
			knob: (on) => ({
				position: "absolute", top: 2, left: on ? 22 : 2, width: 18, height: 18, borderRadius: "50%",
				background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.25)", transition: "left .15s ease",
			}),
			dot: (color) => ({ width: 9, height: 9, borderRadius: "50%", background: color, flex: "0 0 auto" }),
			button: (busy) => ({
				border: `1px solid ${COLORS.border}`, background: "transparent", color: COLORS.label,
				borderRadius: 8, padding: "5px 12px", fontSize: 13, cursor: busy ? "wait" : "pointer",
			}),
			kv: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 13, margin: 0 },
			key: { color: COLORS.secondary, whiteSpace: "nowrap" },
			val: { margin: 0, wordBreak: "break-all" },
			error: { color: COLORS.bad, fontSize: 13, margin: 0 },
			primary: { fontSize: 14, fontWeight: 600 },
			small: { fontSize: 12, color: COLORS.secondary, margin: 0 },
			statusLine: { fontSize: 13, flex: 1, margin: 0 },
			keyBox: { display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${COLORS.border}`, paddingTop: 10 },
			input: {
				flex: 1, minWidth: 0, padding: "6px 10px", fontSize: 13, borderRadius: 8,
				border: `1px solid ${COLORS.border}`, background: "transparent", color: COLORS.label,
			},
			footerButton: (busy) => ({
				display: "flex", alignItems: "center", gap: 8, width: "100%", minHeight: 30,
				border: 0, background: "transparent", color: COLORS.label,
				cursor: busy ? "wait" : "pointer", padding: "5px 8px", borderRadius: 8, fontSize: 13,
			}),
		};

		// ---------------------------------------------------------------------------
		// i18n helpers
		// ---------------------------------------------------------------------------

		/** Replace `{name}` tokens in a dictionary template with string values. */
		function format(template, params) {
			if (typeof template !== "string") return "";
			if (params === undefined || params === null) return template;
			return template.replace(/\{(\w+)\}/gu, (match, name) => {
				const value = params[name];
				return value === undefined || value === null ? "" : String(value);
			});
		}

		/** Pick a dictionary value, falling back to the key itself. */
		function lookup(dict, key) {
			const value = dict[key];
			return typeof value === "string" ? value : key;
		}

		/** Browser language for the defensive translator (used when no locale service). */
		function navigatorLanguage() {
			try {
				const nav = globalThis.navigator;
				const label = nav !== null && nav !== undefined && typeof nav.language === "string" ? nav.language : "";
				return /^zh/iu.test(label) ? "zh" : "en";
			} catch {
				return "en";
			}
		}

		/** Defensive translator: dictionaries + navigator.language, no host service needed. */
		function fallbackT(key, params) {
			return format(lookup(navigatorLanguage() === "zh" ? ZH : EN, key), params);
		}

		/** Active translator. Replaced with the bound host locale service inside apply(). */
		let translate = fallbackT;

		/** Wrap a bound translator so `{placeholder}` interpolation works in every host. */
		function wrapTranslator(bound) {
			return (key, params) => {
				let text;
				try {
					text = bound(key);
				} catch {
					text = key;
				}
				return format(typeof text === "string" ? text : lookup(EN, key), params);
			};
		}

		/** Effective translator for a component render: `props.t ?? t`. */
		function translatorFor(props) {
			const bound = props !== null && props !== undefined && typeof props.t === "function" ? props.t : translate;
			return wrapTranslator(bound);
		}

		/** Bind the host locale service, keeping the defensive translator as fallback. */
		function resolveTranslator(ctx) {
			try {
				const locale = ctx !== null && ctx !== undefined ? ctx.locale : undefined;
				if (locale !== null && locale !== undefined && typeof locale.bind === "function") {
					const bound = locale.bind(NS);
					if (typeof bound === "function") return wrapTranslator(bound);
				}
			} catch (error) {
				console.error("[deepsearch] failed to bind the locale service", error);
			}
			return fallbackT;
		}

		/** Latest effect disposer for the dictionary registration, when the host returns one. */
		let dictionaryDisposer = null;

		/** Register the ZH/EN dictionaries once through the host locale service. */
		function registerDictionaries(ctx) {
			const locale = ctx !== null && ctx !== undefined ? ctx.locale : undefined;
			if (locale === null || locale === undefined || typeof locale.register !== "function") return undefined;
			const register = () => locale.register(NS, { zh: ZH, en: EN });
			try {
				if (typeof ctx.effect === "function") return ctx.effect(register);
				const disposer = register();
				return typeof disposer === "function" ? disposer : undefined;
			} catch (error) {
				console.error("[deepsearch] failed to register locale dictionaries", error);
				return undefined;
			}
		}

		// ---------------------------------------------------------------------------
		// Status text helpers (pure: they never depend on host-localized strings)
		// ---------------------------------------------------------------------------

		/** Whether a snapshot reports a configured API key. */
		function keyConfigured(snapshot) {
			return snapshot !== null && snapshot !== undefined && snapshot.key !== null && snapshot.key !== undefined && snapshot.key.configured === true;
		}

		/** Turn the switch state plus key availability into colored status lines. */
		function summarize(input, t) {
			const tx = translatorFor({ t });
			const modeOn = input !== null && input !== undefined && input.mode === "on";
			const configured = keyConfigured(input);
			const activeProvider = input !== null && input !== undefined && typeof input.activeProvider === "string" && input.activeProvider !== "" ? input.activeProvider : null;
			const searchEndpoint = input !== null && input !== undefined && input.endpoint !== null && input.endpoint !== undefined && typeof input.endpoint.search === "string" && input.endpoint.search !== "" ? input.endpoint.search : null;
			const provider = activeProvider !== null ? activeProvider : tx("common.unknown");
			const endpoint = searchEndpoint !== null ? searchEndpoint : tx("common.unknown");

			if (!modeOn) {
				return {
					color: COLORS.secondary,
					primary: tx("status.primaryOff"),
					secondary: tx("status.secondaryOff", { provider }),
				};
			}
			if (configured) {
				return {
					color: COLORS.ok,
					primary: tx("status.primaryOnOk"),
					secondary: tx("status.secondaryOnOk", { provider, endpoint }),
				};
			}
			return {
				color: COLORS.warn,
				primary: tx("status.primaryOnNoKey"),
				secondary: tx("status.secondaryOnNoKey"),
			};
		}

		/** Human readable form of any thrown value. */
		function describeCause(cause) {
			if (cause instanceof Error && typeof cause.message === "string") return cause.message;
			if (typeof cause === "string") return cause;
			return "";
		}

		/** One-line readable form of the last recorded call. */
		function describeLast(input, t) {
			const tx = translatorFor({ t });
			const last = input !== null && input !== undefined ? input.lastResult : null;
			if (last === null || last === undefined) return tx("last.none");
			const kind = last.kind === "fetch" ? tx("last.kind.fetch") : last.kind === "provider.fallback" ? tx("last.kind.fallback") : tx("last.kind.search");
			const isFetch = last.kind === "fetch";
			const target = isFetch ? (typeof last.url === "string" ? last.url : "") : (typeof last.query === "string" ? last.query : "");
			const at = typeof last.at === "string" ? last.at.replace("T", " ").slice(0, 19) : "";
			if (last.ok === false) {
				const code = typeof last.code === "string" && last.code !== "" ? ` [${last.code}]` : "";
				const errorText = typeof last.error === "string" ? last.error : "";
				return tx("last.failed", { at, kind, code, error: errorText });
			}
			const metrics = [];
			if (typeof last.ms === "number") metrics.push(tx("last.ms", { ms: last.ms }));
			if (typeof last.count === "number") metrics.push(tx("last.count", { count: last.count }));
			if (typeof last.route === "string" && last.route !== "") metrics.push(last.route);
			return tx("last.success", {
				at,
				kind,
				metrics: metrics.length > 0 ? ` · ${metrics.join(" · ")}` : "",
				target,
			});
		}

		/** Localized text for a failed request; raw host/network messages are kept as-is. */
		function describeRequestError(cause, tx) {
			if (cause !== null && typeof cause === "object" && cause.deepsearchUnreachable === true) return tx("errors.unreachable");
			const message = describeCause(cause);
			return tx("errors.api", { message: message !== "" ? message : tx("common.unknown") });
		}

		/** Localized one-line result of the "test endpoint" action. */
		function describeCheck(check, tx) {
			if (check === null || check === undefined) return null;
			if (check.ok === true) {
				const first = check.first !== null && check.first !== undefined && typeof check.first === "object" ? check.first : null;
				const title = first !== null && typeof first.title === "string" ? first.title : "";
				const url = first !== null && typeof first.url === "string" ? first.url : "";
				const example = title !== "" || url !== "" ? tx("check.example", { title, url }) : "";
				return tx("check.ok", {
					httpStatus: check.httpStatus !== undefined && check.httpStatus !== null ? check.httpStatus : tx("common.unknown"),
					ms: check.ms !== undefined && check.ms !== null ? check.ms : tx("common.unknown"),
					keySource: typeof check.keySource === "string" && check.keySource !== "" ? check.keySource : tx("common.unknown"),
				}) + example;
			}
			const code = check.code !== undefined && check.code !== null && check.code !== "" ? ` [${check.code}]` : "";
			const errorText = typeof check.error === "string" && check.error !== "" ? check.error : tx("common.unknown");
			return tx("check.failed", { code, error: errorText });
		}

		// ---------------------------------------------------------------------------
		// Host HTTP client
		// ---------------------------------------------------------------------------

		/**
		 * Call one host route, resolving the route prefix on the first call.
		 * Tries the document-relative candidate first, then the root-absolute one.
		 * Every request is `cache: "no-store"` and POSTs are same-origin JSON.
		 */
		async function api(path, init) {
			const bases = resolvedBase === null ? CANDIDATES : [resolvedBase];
			let lastError;
			for (const base of bases) {
				const prefix = base.slice(0, base.length - "state".length);
				try {
					const response = await fetch(`${prefix}${path}`, { cache: "no-store", ...init });
					if (!response.ok) {
						lastError = new Error(`HTTP ${response.status}`);
						continue;
					}
					const body = await response.json();
					resolvedBase = base;
					return body;
				} catch (cause) {
					lastError = cause;
				}
			}
			if (lastError !== undefined) throw lastError;
			const unreachable = new Error();
			unreachable.deepsearchUnreachable = true;
			throw unreachable;
		}

		// ---------------------------------------------------------------------------
		// Settings page
		// ---------------------------------------------------------------------------

		/** Settings tab: route switch, status, endpoint test, details and the key editor. */
		function DeepSearchPanel(props) {
			const tx = translatorFor(props);
			const [snapshot, setSnapshot] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [check, setCheck] = React.useState(null);
			const [keyInput, setKeyInput] = React.useState("");
			const [keyBusy, setKeyBusy] = React.useState(false);
			const [keyNotice, setKeyNotice] = React.useState(null);

			const refresh = React.useCallback(async () => {
				try {
					const state = await api("state");
					setSnapshot(state);
					setError(null);
				} catch (cause) {
					setError(cause);
				}
			}, []);

			React.useEffect(() => {
				let alive = true;
				const tick = () => {
					if (alive) void refresh();
				};
				tick();
				const timer = setInterval(tick, 5000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [refresh]);

			const on = snapshot !== null && snapshot.mode === "on";
			const configured = keyConfigured(snapshot);
			const status = summarize(snapshot, tx);

			const toggle = async () => {
				if (busy || snapshot === null) return;
				setBusy(true);
				try {
					const result = await api("mode", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ mode: on ? "off" : "on" }),
					});
					if (result !== null && result !== undefined && result.state !== undefined) setSnapshot(result.state);
					else await refresh();
					if (result !== null && result !== undefined && result.ok === false) setError(new Error(String(result.error ?? tx("common.unknown"))));
					else setError(null);
				} catch (cause) {
					setError(cause);
				} finally {
					setBusy(false);
				}
			};

			const runCheck = async () => {
				if (busy) return;
				setBusy(true);
				setCheck(null);
				try {
					const result = await api("check", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
					});
					if (result !== null && result !== undefined && result.state !== undefined) setSnapshot(result.state);
					if (result !== null && result !== undefined && result.ok === false) {
						setError(new Error(String(result.error ?? tx("common.unknown"))));
						setCheck(null);
					} else {
						setError(null);
						setCheck(result !== null && result !== undefined ? (result.check ?? null) : null);
					}
				} catch (cause) {
					setError(cause);
				} finally {
					setBusy(false);
				}
			};

			const saveKey = async () => {
				if (keyBusy) return;
				const value = typeof keyInput === "string" ? keyInput : "";
				if (value.trim() === "") {
					setKeyNotice({ ok: false, message: tx("key.empty") });
					return;
				}
				setKeyBusy(true);
				setKeyNotice(null);
				try {
					const result = await api("key", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ action: "save", key: value }),
					});
					if (result !== null && result !== undefined && result.ok === false) {
						setKeyNotice({ ok: false, message: typeof result.error === "string" ? result.error : "" });
						return;
					}
					setKeyInput("");
					setKeyNotice({ ok: true, key: "key.saved" });
					if (result !== null && result !== undefined && result.key !== undefined) {
						setSnapshot((current) => (current === null ? current : { ...current, key: result.key }));
					}
					await refresh();
				} catch (cause) {
					setKeyNotice({ ok: false, cause });
				} finally {
					setKeyBusy(false);
				}
			};

			const clearKey = async () => {
				if (keyBusy) return;
				setKeyBusy(true);
				setKeyNotice(null);
				try {
					const result = await api("key", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ action: "clear" }),
					});
					if (result !== null && result !== undefined && result.ok === false) {
						setKeyNotice({ ok: false, message: typeof result.error === "string" ? result.error : "" });
						return;
					}
					setKeyInput("");
					setKeyNotice({ ok: true, key: "key.cleared" });
					await refresh();
				} catch (cause) {
					setKeyNotice({ ok: false, cause });
				} finally {
					setKeyBusy(false);
				}
			};

			const keySource = snapshot !== null && snapshot.key !== null && snapshot.key !== undefined && typeof snapshot.key.source === "string" && snapshot.key.source !== "" ? snapshot.key.source : tx("common.unknown");
			const keyFile = snapshot !== null && snapshot.paths !== null && snapshot.paths !== undefined && typeof snapshot.paths.keyFile === "string" && snapshot.paths.keyFile !== "" ? snapshot.paths.keyFile : snapshot !== null && snapshot.key !== null && snapshot.key !== undefined && typeof snapshot.key.keyFile === "string" ? snapshot.key.keyFile : "";
			const envVar = snapshot !== null && snapshot.key !== null && snapshot.key !== undefined && typeof snapshot.key.envVar === "string" ? snapshot.key.envVar : "";
			const hint = snapshot !== null && !configured
				? tx("hint.noKey", {
					file: keyFile !== "" ? keyFile : tx("common.none"),
					env: envVar !== "" ? envVar : tx("common.unknown"),
				})
				: null;
			const warnings = snapshot !== null && snapshot.diag !== null && snapshot.diag !== undefined && Array.isArray(snapshot.diag.errors) && snapshot.diag.errors.length > 0
				? snapshot.diag.errors.map((item) => String(item)).join("; ")
				: null;
			const checkText = describeCheck(check, tx);
			let keyNoticeText = null;
			let keyNoticeOk = false;
			if (keyNotice !== null && keyNotice !== undefined) {
				keyNoticeOk = keyNotice.ok === true;
				if (keyNoticeOk) keyNoticeText = tx(keyNotice.key);
				else if (keyNotice.cause !== undefined && keyNotice.cause !== null) keyNoticeText = describeRequestError(keyNotice.cause, tx);
				else keyNoticeText = tx("errors.key", { message: keyNotice.message !== undefined && keyNotice.message !== "" ? keyNotice.message : tx("common.unknown") });
			}

			return h("div", { style: CSS.page },
				h("h2", { style: CSS.title }, tx("settings.title")),
				h("p", { style: CSS.intro },
					tx("settings.introBefore"),
					h("strong", null, tx("term.webSearch")),
					tx("settings.introAfter"),
				),

				h("div", { style: CSS.card },
					h("div", { style: CSS.row },
						h("button", {
							type: "button",
							role: "switch",
							"aria-checked": on,
							"aria-label": tx("settings.switchAria"),
							disabled: busy || snapshot === null,
							onClick: toggle,
							style: CSS.switch(on, busy || snapshot === null),
						}, h("span", { style: CSS.knob(on) })),
						h("div", { style: CSS.column },
							h("span", { style: CSS.primary }, status.primary),
							h("span", { style: CSS.small }, on ? tx("settings.runningOn") : tx("settings.runningOff")),
						),
					),
					h("div", { style: CSS.row },
						h("span", { style: CSS.dot(status.color) }),
						h("span", { style: CSS.statusLine }, status.secondary),
						h("button", { type: "button", onClick: runCheck, disabled: busy, style: CSS.button(busy) }, tx("settings.testEndpoint")),
					),
					checkText !== null
						? h("p", { style: check !== null && check.ok === true ? CSS.small : CSS.error, role: "status", "aria-live": "polite" }, checkText)
						: null,
				),

				h("div", { style: CSS.card },
					h("dl", { style: CSS.kv },
						h("dt", { style: CSS.key }, tx("details.mode")),
						h("dd", { style: CSS.val }, snapshot === null ? tx("common.none") : on ? tx("details.modeOn") : tx("details.modeOff")),
						h("dt", { style: CSS.key }, tx("details.provider")),
						h("dd", { style: CSS.val }, snapshot !== null && typeof snapshot.activeProvider === "string" && snapshot.activeProvider !== "" ? snapshot.activeProvider : tx("common.none")),
						h("dt", { style: CSS.key }, tx("details.key")),
						h("dd", { style: CSS.val }, configured ? tx("details.keyConfigured", { source: keySource }) : tx("details.keyMissing")),
						h("dt", { style: CSS.key }, tx("details.searchEndpoint")),
						h("dd", { style: CSS.val }, snapshot !== null && snapshot.endpoint !== null && snapshot.endpoint !== undefined && typeof snapshot.endpoint.search === "string" && snapshot.endpoint.search !== "" ? snapshot.endpoint.search : tx("common.none")),
						h("dt", { style: CSS.key }, tx("details.fetchEndpoint")),
						h("dd", { style: CSS.val }, snapshot !== null && snapshot.endpoint !== null && snapshot.endpoint !== undefined && typeof snapshot.endpoint.fetch === "string" && snapshot.endpoint.fetch !== "" ? snapshot.endpoint.fetch : tx("common.none")),
						h("dt", { style: CSS.key }, tx("details.count")),
						h("dd", { style: CSS.val }, snapshot !== null && snapshot.count !== undefined && snapshot.count !== null ? snapshot.count : tx("common.none")),
						h("dt", { style: CSS.key }, tx("details.lastCall")),
						h("dd", { style: CSS.val }, describeLast(snapshot, tx)),
						h("dt", { style: CSS.key }, tx("details.lastError")),
						h("dd", { style: CSS.val }, snapshot !== null && snapshot.lastError !== null && snapshot.lastError !== undefined && snapshot.lastError.message !== undefined && snapshot.lastError.message !== null ? snapshot.lastError.message : tx("common.none")),
					),
					snapshot !== null
						? h("div", { style: CSS.keyBox },
							h("div", { style: CSS.row },
								h("label", { style: CSS.key }, tx("key.label")),
								h("input", {
									type: "password",
									value: keyInput,
									placeholder: tx("key.placeholder"),
									autoComplete: "off",
									spellCheck: false,
									"aria-label": tx("key.label"),
									disabled: busy || keyBusy,
									onChange: (event) => setKeyInput(String(event !== null && event !== undefined && event.target !== null && event.target !== undefined && event.target.value !== undefined ? event.target.value : "")),
									style: CSS.input,
								}),
								h("button", { type: "button", disabled: busy || keyBusy, onClick: saveKey, style: CSS.button(busy || keyBusy) }, tx("key.save")),
								configured
									? h("button", { type: "button", disabled: busy || keyBusy, onClick: clearKey, style: CSS.button(busy || keyBusy) }, tx("key.clear"))
									: null,
							),
							keyNoticeText !== null
								? h("p", { role: "status", "aria-live": "polite", style: keyNoticeOk ? CSS.small : CSS.error }, keyNoticeText)
								: null,
						)
						: null,
					hint !== null ? h("p", { style: CSS.intro }, hint) : null,
					warnings !== null ? h("p", { style: CSS.small }, tx("warnings.label"), " ", warnings) : null,
				),

				error !== null ? h("p", { style: CSS.error }, describeRequestError(error, tx)) : null,
			);
		}

		// ---------------------------------------------------------------------------
		// Sidebar footer switch
		// ---------------------------------------------------------------------------

		/** Sidebar footer: current route at a glance, one click to toggle it. */
		function DeepSearchFooter(props) {
			const tx = translatorFor(props);
			const [snapshot, setSnapshot] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			React.useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const state = await api("state");
						if (alive) setSnapshot(state);
					} catch {
						/* the host may not be reachable yet; the next poll corrects the view */
					}
				};
				void load();
				const timer = setInterval(load, 8000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);

			const on = snapshot !== null && snapshot.mode === "on";
			const configured = keyConfigured(snapshot);
			const color = on ? (configured ? COLORS.ok : COLORS.warn) : COLORS.secondary;
			const wide = props === undefined || props === null || props.wide !== false;
			const title = on ? (configured ? tx("footer.titleOnConfigured") : tx("footer.titleOnNoKey")) : tx("footer.titleOff");

			return h("button", {
				type: "button",
				title,
				"aria-label": title,
				disabled: busy,
				onClick: async () => {
					if (busy || snapshot === null) return;
					setBusy(true);
					try {
						const result = await api("mode", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ mode: on ? "off" : "on" }),
						});
						if (result !== null && result !== undefined && result.state !== undefined) setSnapshot(result.state);
					} catch {
						/* the next poll corrects the view */
					} finally {
						setBusy(false);
					}
				},
				style: CSS.footerButton(busy),
			},
				h("span", { style: CSS.dot(color) }),
				wide ? h("span", null, on ? tx("footer.on") : tx("footer.off")) : null,
			);
		}

		// ---------------------------------------------------------------------------
		// Plugin entry point
		// ---------------------------------------------------------------------------

		/**
		 * Register the settings tab and the sidebar footer action. Both seats are declared
		 * by other plugins; slots.inject waits for the declaration, so load order does not
		 * matter. Registration failures are logged but never thrown: apply() must not break
		 * plugin loading.
		 * @param ctx - browser plugin context.
		 */
		function apply(ctx) {
			if (ctx === null || ctx === undefined) return;
			const disposer = registerDictionaries(ctx);
			if (typeof disposer === "function") dictionaryDisposer = disposer;
			translate = resolveTranslator(ctx);

			try {
				ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
					name: "settings.plugins.tab",
					id: "deepsearch",
					order: 55,
					label: () => translate("settings.title"),
					locale: NS,
					inject: () => ({ t: translate }),
				}, DeepSearchPanel));
			} catch (error) {
				console.error("[deepsearch] failed to register the settings tab", error);
			}

			try {
				ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
					name: "sidebar.footer.action",
					id: "deepsearch-switch",
					order: 61,
					locale: NS,
					inject: () => ({ t: translate }),
				}, DeepSearchFooter));
			} catch (error) {
				console.error("[deepsearch] failed to register the sidebar switch", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		// Test-only internals: pure status helpers, palette and dictionaries.
		exports.__internals = { summarize, describeLast, keyConfigured, COLORS, dictionaries, NS };
		return module.exports;
	}
});
