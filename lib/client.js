// dsh-conversation-search — browser half.
//
// 注册两件东西：
//   1. shell.overlay slot：全局搜索面板（React 组件，主题 token 配色，浅/深色自适应）；
//   2. conversation.composer.dock slot：放大镜按钮（唯一触发入口，0.1.3 起移除快捷键）；
//   3. host.call 通道：经 remote.conversationSearch.search 调宿主半的搜索。
//
// 定位：点击结果 → uiWorkspace.openSession(sessionId)（对当前会话幂等）→ 等待
// [data-chat-flow] → 先向下扫到 floor，再渐进向上（触发宿主 paging）扫到顶，
// 命中行 scrollIntoView 居中 + Web Animations 高亮；失败时回退展示上下文。
//
// 纯 DOM 锚点（data-chat-flow / data-chat-flow-kind），不碰 React 内部、
// 不 require 任何宿主私有模块，跨版本稳定性与 dsh-desktop-context-menu 同级。

window.__ModuleLoader__.load({
	id: "dsh-conversation-search",
	factory: (require) => {
		var React = require("react");
		var h = React.createElement;

		// ------------------------------------------------------------------
		// i18n（内嵌字典；locale/zh.json 仅用于插件卡片的展示元数据）
		// ------------------------------------------------------------------
		var DICTS = {
			zh: {
				placeholder: "搜索对话内容…",
				scopeCurrent: "当前会话",
				scopeAll: "全部会话",
				searching: "搜索中…",
				noResults: "没有匹配的消息",
				scanned: "已扫描 {scanned} 个会话 · {ms}ms",
				moreHits: "（仅显示前 {limit} 条）",
				continueScan: "继续扫描",
				locateFailed: "未能滚动到该消息（可能在折叠的过程区）",
				locateNoFlow: "会话视图尚未就绪",
				hint: "Enter 搜索/定位 · ↑↓ 选择 · Esc 关闭",
				shortcutLabel: "搜索对话内容",
				untitled: "（无标题会话）",
				emptyQuery: "输入至少 1 个字符",
				modeLoose: "宽松",
				modeExact: "精确搜索模式",
				modeRegex: "正则",
				looseTip: "宽松模式：大小写不敏感 · 空白弹性多词 · 全事件类型（含工具调用与结果）",
				exactTip: "精确搜索模式：仅搜索用户/助手消息（排除工具调用与结果）· 区分大小写 · 整词边界（npm 不再命中 npmjs）· 空白不弹性",
				regexTip: "正则模式：对会话文本执行你输入的正则表达式（区分大小写、覆盖全部事件类型），语法错误会在状态栏提示",
				rpcUnavailable: "搜索服务不可用（宿主半未就绪，可稍后重试）",
			},
			en: {
				placeholder: "Search conversation text…",
				scopeCurrent: "Current session",
				scopeAll: "All sessions",
				searching: "Searching…",
				noResults: "No matching messages",
				scanned: "Scanned {scanned} sessions · {ms}ms",
				moreHits: "(showing first {limit})",
				continueScan: "Continue scanning",
				locateFailed: "Could not scroll to the message (it may live in a collapsed process area)",
				locateNoFlow: "Conversation view not ready",
				hint: "Enter search/locate · ↑↓ select · Esc close",
				shortcutLabel: "Search conversation text",
				untitled: "(untitled session)",
				emptyQuery: "Type at least 1 character",
				modeLoose: "Loose",
				modeExact: "Exact match",
				modeRegex: "Regex",
				looseTip: "Loose mode: case-insensitive · whitespace-flexible multi-word · all event types (including tool calls and results)",
				exactTip: "Exact match: user/assistant messages only (tool calls and results excluded) · case-sensitive · whole-word (npm no longer matches npmjs) · literal whitespace",
				rpcUnavailable: "Search service unavailable (host half not ready; try again shortly)",
			},
		};

		// 语言状态：跟随宿主 locale 服务动态切换（0.1.11）。t 为稳定引用，
		// 每次调用按 localeRef.current 取词——面板订阅 locale 变更后重渲染即生效。
		var localeRef = { current: "en" };
		function t(key, params) {
			var dict = DICTS[localeRef.current] || DICTS.en;
			var s = dict[key] != null ? dict[key] : DICTS.en[key] || key;
			if (params) {
				for (var k in params) s = s.split("{" + k + "}").join(String(params[k]));
			}
			return s;
		}
		function currentLocaleOf(localeSvc) {
			try {
				// 信号 1：LocaleRuntime.resolveActive()——实时真值（显式偏好 ?? 浏览器探测），
				// 服务对象即 LocaleRuntime 实例，方法直接可用。
				if (localeSvc && typeof localeSvc.resolveActive === "function") {
					var resolved = localeSvc.resolveActive();
					if (resolved === "zh" || resolved === "en") return resolved;
				}
				// 信号 2：快照 active
				var active = localeSvc && localeSvc.getSnapshot ? localeSvc.getSnapshot().active : undefined;
				if (active === "zh") return "zh";
				if (active === "en") return "en";
			} catch (e) { /* 继续下一信号 */ }
			return "en";
		}

		// ------------------------------------------------------------------
		// 文本工具
		// ------------------------------------------------------------------
		function normalizeText(value) {
			return String(value == null ? "" : value).replace(/\s+/g, " ").toLowerCase().trim();
		}

		function queryWords(query) {
			return normalizeText(query).split(" ").filter(Boolean);
		}

		/** 行文本按「词序列顺序出现」匹配（与官方 text 过滤的空白弹性语义一致）。 */
		function rowMatches(row, words) {
			var text = normalizeText(row.textContent);
			if (text.length === 0) return false;
			var at = 0;
			for (var i = 0; i < words.length; i++) {
				var found = text.indexOf(words[i], at);
				if (found < 0) return false;
				at = found + words[i].length;
			}
			return true;
		}

		function clipText(value, max) {
			var s = String(value == null ? "" : value);
			return s.length <= max ? s : s.slice(0, max);
		}

		function formatTime(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
			try {
				var d = new Date(ms);
				var now = new Date();
				var sameDay = d.toDateString() === now.toDateString();
				if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
				return d.toLocaleDateString([], { month: "2-digit", day: "2-digit" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			} catch (e) {
				return "";
			}
		}

		/** snippet 中高亮命中词（纯文本拆分，React mark 节点）。 */
		function renderSnippet(snippet, words) {
			var text = String(snippet == null ? "" : snippet);
			if (text.length === 0 || words.length === 0) return text;
			var lower = text.toLowerCase();
			var ranges = [];
			for (var i = 0; i < words.length; i++) {
				var word = words[i];
				var from = 0;
				for (;;) {
					var at = lower.indexOf(word, from);
					if (at < 0) break;
					ranges.push([at, at + word.length]);
					from = at + word.length;
					if (ranges.length > 24) break;
				}
				if (ranges.length > 24) break;
			}
			if (ranges.length === 0) return text;
			ranges.sort(function (a, b) { return a[0] - b[0]; });
			var merged = [];
			for (var j = 0; j < ranges.length; j++) {
				var last = merged[merged.length - 1];
				if (last && ranges[j][0] <= last[1]) last[1] = Math.max(last[1], ranges[j][1]);
				else merged.push([ranges[j][0], ranges[j][1]]);
			}
			var nodes = [];
			var cursor = 0;
			for (var k = 0; k < merged.length; k++) {
				if (merged[k][0] > cursor) nodes.push(text.slice(cursor, merged[k][0]));
				nodes.push(h("mark", { key: k, style: SNIPPET_MARK_STYLE }, text.slice(merged[k][0], merged[k][1])));
				cursor = merged[k][1];
			}
			if (cursor < text.length) nodes.push(text.slice(cursor));
			return nodes;
		}

		// ------------------------------------------------------------------
		// 主题 token（--dsw-alias-*：跟随宿主浅/深色；字面色仅美术用途）
		// ------------------------------------------------------------------
		var T = {
			overlayBg: "rgba(0,0,0,0.32)",
			panelBg: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #fff))",
			border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))",
			borderSoft: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08))",
			textPrimary: "var(--dsw-alias-label-primary, inherit)",
			textSecondary: "var(--dsw-alias-label-secondary, inherit)",
			textTertiary: "var(--dsw-alias-label-tertiary, inherit)",
			brand: "var(--dsw-alias-brand-primary, #247bbf)",
			brandText: "var(--dsw-alias-brand-text, #247bbf)",
			hoverBg: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))",
			shadow: "var(--dsw-shadow-lv2, 0 12px 32px rgba(0,0,0,0.18))",
			focusRing: "var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #247bbf))",
		};

		var SNIPPET_MARK_STYLE = {
			background: "transparent",
			color: T.brandText,
			fontWeight: "600",
			padding: "0",
		};

		var overlayStyle = {
			position: "fixed",
			inset: "0",
			zIndex: "9999",
			background: T.overlayBg,
			display: "flex",
			alignItems: "flex-start",
			justifyContent: "center",
			paddingTop: "11vh",
			fontSize: "13px",
			color: T.textPrimary,
		};

		var panelStyle = {
			width: "min(640px, calc(100vw - 48px))",
			maxHeight: "72vh",
			display: "flex",
			flexDirection: "column",
			background: T.panelBg,
			border: T.border,
			borderRadius: "12px",
			boxShadow: T.shadow,
			overflow: "hidden",
		};

		var inputRowStyle = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			padding: "10px 12px",
			borderBottom: T.borderSoft,
		};

		var inputStyle = {
			flex: "1",
			minWidth: "0",
			fontSize: "14px",
			padding: "7px 10px",
			borderRadius: "8px",
			border: T.borderSoft,
			outline: "none",
			background: "transparent",
			color: T.textPrimary,
		};

		var scopeBtnBase = {
			fontSize: "12px",
			padding: "5px 10px",
			borderRadius: "999px",
			border: T.borderSoft,
			background: "transparent",
			color: T.textSecondary,
			cursor: "pointer",
			whiteSpace: "nowrap",
		};

		function scopeBtnStyle(active) {
			var s = Object.assign({}, scopeBtnBase);
			if (active) {
				// 选中态用品牌色描边 + 品牌色文字，不用实心填充——某些主题的
				// --dsw-alias-brand-primary 接近白色，实心填充会糊成一团。
				s.borderColor = T.brand;
				s.color = T.brandText;
			} else {
				s.borderColor = "transparent";
			}
			return s;
		}

		var statusBarStyle = {
			padding: "6px 14px",
			fontSize: "12px",
			color: T.textTertiary,
			borderBottom: T.borderSoft,
			minHeight: "26px",
			display: "flex",
			alignItems: "center",
			gap: "8px",
		};

		var resultListStyle = {
			overflowY: "auto",
			flex: "1 1 auto",
			minHeight: "120px",
		};

		var hitRowStyle = {
			padding: "8px 14px",
			cursor: "pointer",
			borderBottom: T.borderSoft,
		};

		function hitRowStyleFor(selected) {
			var s = Object.assign({}, hitRowStyle);
			if (selected) s.background = T.hoverBg;
			return s;
		}

		var hitTitleStyle = {
			display: "flex",
			alignItems: "baseline",
			gap: "8px",
			fontSize: "12px",
			color: T.textSecondary,
			marginBottom: "3px",
		};

		var hitSnippetStyle = {
			fontSize: "13px",
			lineHeight: "1.5",
			color: T.textPrimary,
			wordBreak: "break-word",
		};

		var footerStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "8px",
			padding: "7px 14px",
			borderTop: T.borderSoft,
			fontSize: "11px",
			color: T.textTertiary,
		};

		var continueBtnStyle = {
			fontSize: "11px",
			padding: "3px 10px",
			borderRadius: "999px",
			border: T.borderSoft,
			background: "transparent",
			color: T.brandText,
			cursor: "pointer",
		};

		// ------------------------------------------------------------------
		// 宿主服务访问
		// ------------------------------------------------------------------
		function getService(ctx, name) {
			try {
				var svc = ctx.get ? ctx.get(name) : ctx[name];
				return svc;
			} catch (e) {
				return undefined;
			}
		}

		function currentSessionId(ctx) {
			try {
				var sessions = getService(ctx, "sessions");
				var list = sessions && sessions.list ? sessions.list.getSnapshot() : null;
				if (!list || !list.byId) return undefined;
				var rows = Object.values(list.byId);
				for (var i = 0; i < rows.length; i++) {
					var retained = rows[i] && rows[i].retainedBy ? rows[i].retainedBy.mainView : 0;
					if ((retained ?? 0) > 0) return rows[i].id;
				}
			} catch (e) { /* 服务不可用时不阻塞搜索 */ }
			return undefined;
		}

		function callRemote(svc, method, args) {
			if (!svc || typeof svc[method] !== "function") {
				return Promise.reject(new Error("RPC_UNAVAILABLE remote.conversationSearch." + method));
			}
			return Promise.resolve(svc[method](args)).then(function (answered) {
				if (answered && typeof answered === "object" && "ok" in answered) {
					if (answered.ok) return answered.value;
					var message = answered.error && answered.error.message ? answered.error.message : "rpc failed";
					throw new Error(message);
				}
				return answered;
			});
		}

		// ------------------------------------------------------------------
		// DOM 定位：向下扫到 floor → 渐进向上（触发 paging）扫到顶
		// ------------------------------------------------------------------
		function sleep(ms) {
			return new Promise(function (resolve) { setTimeout(resolve, ms); });
		}

		function findHitRow(flow, words) {
			var rows = flow.querySelectorAll("[data-chat-flow-kind]");
			for (var i = 0; i < rows.length; i++) {
				if (rowMatches(rows[i], words)) return rows[i];
			}
			return null;
		}

		function highlightRow(row) {
			try {
				row.scrollIntoView({ block: "center" });
			} catch (e) { /* 旧引擎无 options */ }
			try {
				row.animate(
					[
						{ outline: "2px solid " + T.brand, outlineOffset: "-2px", backgroundColor: T.hoverBg },
						{ outline: "2px solid " + T.brand, outlineOffset: "-2px", backgroundColor: T.hoverBg, offset: 0.65 },
						{ outline: "0px solid transparent", outlineOffset: "0px", backgroundColor: "transparent" },
					],
					{ duration: 2600, easing: "ease-out" },
				);
			} catch (e) { /* 无 WAAPI 时仅滚动定位 */ }
		}

		/** 定位代次：新的定位开始后，旧的异步定位循环自行中止，避免扫错会话。 */
		var locateSeq = 0;

		async function locateHit(ctx, hit, words) {
			var token = ++locateSeq;
			var started = Date.now();
			// 1) 会话切换（幂等）：非当前会话才显式打开。全程输出诊断日志，
			//    便于用 DevTools console 定位「落到新会话页」一类问题。
			var currentId = currentSessionId(ctx);
			var workspace = getService(ctx, "uiWorkspace");
			var inClientList = false;
			try {
				var sessionsSvc = getService(ctx, "sessions");
				var snap = sessionsSvc && sessionsSvc.list ? sessionsSvc.list.getSnapshot() : null;
				inClientList = !!(snap && snap.byId && snap.byId[hit.sessionId]);
			} catch (e) { /* 诊断失败不影响定位 */ }
			console.info(
				"[dsh-conversation-search] locate: target=" + hit.sessionId +
				" current=" + (currentId || "none") +
				" inClientList=" + inClientList +
				" workspace=" + (workspace && typeof workspace.openSession === "function" ? "ok" : "MISSING"),
			);
			if ((!currentId || currentId !== hit.sessionId) && workspace && typeof workspace.openSession === "function") {
				try {
					await workspace.openSession(hit.sessionId);
					console.info("[dsh-conversation-search] openSession resolved (after " + (Date.now() - started) + "ms)");
				} catch (e) {
					console.warn("[dsh-conversation-search] openSession failed", e);
					return { ok: false, reason: "open-failed" };
				}
			}
			// 2) 等待会话流容器出现（4s 上限；被更新的定位取代则中止）。
			var flow = null;
			while (Date.now() - started < 4000) {
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				flow = document.querySelector("[data-chat-flow]");
				if (flow) break;
				await sleep(120);
			}
			if (!flow) return { ok: false, reason: "no-flow" };
			console.info("[dsh-conversation-search] flow ready (after " + (Date.now() - started) + "ms), scanning");

			// 3) 当前视口向下扫到 floor。
			for (var step = 0; step < 6 && Date.now() - started < 9000; step++) {
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				var row = findHitRow(flow, words);
				if (row) {
					highlightRow(row);
					return { ok: true };
				}
				if (flow.scrollTop + flow.clientHeight >= flow.scrollHeight - 2) break;
				flow.scrollTop += flow.clientHeight;
				await sleep(180);
			}

			// 4) 渐进向上：滚动触发虚拟列表渲染与宿主 paging（顶部等待新内容）。
			var lastHeight = flow.scrollHeight;
			var stalls = 0;
			while (Date.now() - started < 9000) {
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				var row2 = findHitRow(flow, words);
				if (row2) {
					highlightRow(row2);
					return { ok: true };
				}
				if (flow.scrollTop > 0) {
					flow.scrollTop = Math.max(0, flow.scrollTop - flow.clientHeight * 0.85);
					await sleep(200);
					lastHeight = flow.scrollHeight;
					stalls = 0;
				} else {
					await sleep(260);
					if (flow.scrollHeight === lastHeight) {
						stalls += 1;
						if (stalls >= 5) break;
					} else {
						stalls = 0;
						lastHeight = flow.scrollHeight;
					}
				}
			}
			console.info("[dsh-conversation-search] locate gave up after " + (Date.now() - started) + "ms");
			return { ok: false, reason: "not-found" };
		}

		// ------------------------------------------------------------------
		// 面板组件
		// ------------------------------------------------------------------
		function SearchPanel(props) {
			var ctx = props.ctx;
			var holder = props.holder;
			var t = props.t;

			var openState = React.useState(holder.open);
			var open = openState[0];
			var setOpen = openState[1];

			var queryState = React.useState(holder.query || "");
			var query = queryState[0];
			var setQuery = queryState[1];

			var scopeState = React.useState("current");
			var scope = scopeState[0];
			var setScope = scopeState[1];

			var resultState = React.useState({ hits: [], scanned: 0, truncated: false, elapsedMs: 0 });
			var result = resultState[0];
			var setResult = resultState[1];

			var statusState = React.useState({ kind: "idle", text: "" });
			var status = statusState[0];
			var setStatus = statusState[1];

			var selectedState = React.useState(-1);
			var selected = selectedState[0];
			var setSelected = selectedState[1];

			// 悬停只做视觉高亮，绝不改 selected——0.1.2 里 onMouseEnter 直接
			// setSelected，上下文区高度随“加载中/已就绪”变化 → 列表位移 → 光标下
			// 变成另一行 → 再次触发悬停，形成不停乱闪的反馈死循环。
			var hoverState = React.useState(-1);
			var hover = hoverState[0];
			var setHover = hoverState[1];

			var modeState = React.useState("loose");
			var mode = modeState[0];
			var setMode = modeState[1];

			// 语言跟随宿主（0.1.11）：locale 变更 → 更新词表引用 + 强制重渲染，
			// 面板内所有 t() 文案即时切换，无需刷新页面。
			// 0.2.1 关键修复：挂载时补读一次当前语言——apply 在 client 激活早期执行，
			// 那时 locale 服务可能尚未挂载（读到 undefined → 误判 en），而订阅只在
			// 语言「变更」时触发，初始错误值会一直留到下次切换前。
			var localeTickState = React.useState(0);
			var setLocaleVersion = localeTickState[1];
			React.useEffect(function () {
				var localeSvc = getService(ctx, "locale");
				if (!localeSvc || typeof localeSvc.subscribe !== "function") return function () {};
				localeRef.current = currentLocaleOf(localeSvc);
				setLocaleVersion(function (v) { return v + 1; });
				return localeSvc.subscribe(function () {
					localeRef.current = currentLocaleOf(localeSvc);
					setLocaleVersion(function (v) { return v + 1; });
				});
			}, []);

			var inputRef = React.useRef(null);
			var debounceRef = React.useRef(null);
			var searchSeqRef = React.useRef(0);
			var scannedOffsetRef = React.useRef(0);
			var resultRef = React.useRef(result);
			resultRef.current = result;

			// 外部 holder（快捷键）→ 组件状态同步。
			React.useEffect(function () {
				var listener = function (value) { setOpen(value); };
				holder.listeners.add(listener);
				return function () { holder.listeners.delete(listener); };
			}, []);

			// Esc 关闭（capture；仅在面板打开时拦截）。
			React.useEffect(function () {
				if (!open) return;
				var onKey = function (event) {
					if (event.key === "Escape") {
						event.stopPropagation();
						setOpen(false);
					}
				};
				window.addEventListener("keydown", onKey, true);
				return function () { window.removeEventListener("keydown", onKey, true); };
			}, [open]);

			// 打开时聚焦输入框。
			React.useEffect(function () {
				if (!open) return;
				var handle = setTimeout(function () {
					if (inputRef.current) inputRef.current.focus();
				}, 30);
				return function () { clearTimeout(handle); };
			}, [open]);

			var runSearch = React.useCallback(function (rawQuery, rawScope, offset, rawMode) {
				var words = queryWords(rawQuery);
				var seq = ++searchSeqRef.current;
				if (words.length === 0 && rawMode !== "regex") {
					setResult({ hits: [], scanned: 0, truncated: false, elapsedMs: 0 });
					setStatus({ kind: "idle", text: t("emptyQuery") });
					return;
				}
				if (rawMode === "regex" && normalizeText(rawQuery).length === 0) {
					setResult({ hits: [], scanned: 0, truncated: false, elapsedMs: 0 });
					setStatus({ kind: "idle", text: t("emptyQuery") });
					return;
				}
				setStatus({ kind: "loading", text: t("searching") });
				var sessionId = rawScope === "current" ? currentSessionId(ctx) : undefined;
				if (rawScope === "current" && !sessionId) {
					setStatus({ kind: "error", text: t("noResults") });
					return;
				}
				callRemote(holder.getSearchSvc(), "search", {
					query: rawQuery.trim().slice(0, 200),
					scope: rawScope,
					sessionId: sessionId,
					limit: 30,
					offset: offset || 0,
					mode: rawMode,
					exact: rawMode === "exact",
				}).then(function (value) {
					if (seq !== searchSeqRef.current) return;
					scannedOffsetRef.current = (offset || 0) + (value.scanned || 0);
					var hits = (value.hits || []).map(function (hitItem) {
						return Object.assign({}, hitItem, { words: words });
					});
					var next = {
						hits: hits,
						scanned: value.scanned || 0,
						truncated: !!value.truncated,
						elapsedMs: value.elapsedMs || 0,
					};
					setResult(next);
					setSelected(hits.length > 0 ? 0 : -1);
					var label = t("scanned", { scanned: next.scanned, ms: next.elapsedMs });
					if (next.hits.length >= 30) label += " " + t("moreHits", { limit: 30 });
					if (rawMode === "exact") label += " · " + t("modeExact");
					else if (rawMode === "regex") label += " · " + t("modeRegex");
					label += " · v" + (value.hostVersion || "?");
					setStatus({ kind: next.hits.length === 0 ? "empty" : "done", text: label });
				}).catch(function (error) {
					if (seq !== searchSeqRef.current) return;
					console.warn("[dsh-conversation-search] search failed", error);
					var raw = String(error && error.message ? error.message : error);
					var text = raw.indexOf("RPC_UNAVAILABLE") === 0 ? t("rpcUnavailable") : raw;
					if (raw.indexOf("RPC_UNAVAILABLE") === 0 && holder.mountError) text += " · " + holder.mountError;
					setStatus({ kind: "error", text: text });
				});
			}, [ctx, holder, t]);

			// 输入防抖自动搜索。
			React.useEffect(function () {
				if (!open) return;
				if (debounceRef.current) clearTimeout(debounceRef.current);
				if (normalizeText(query).length === 0) {
					setResult({ hits: [], scanned: 0, truncated: false, elapsedMs: 0 });
					setStatus({ kind: "idle", text: "" });
					return;
				}
				debounceRef.current = setTimeout(function () {
					scannedOffsetRef.current = 0;
					runSearch(query, scope, 0, mode);
				}, 320);
				return function () { clearTimeout(debounceRef.current); };
			}, [query, scope, mode, open, runSearch]);

			var selectRelative = function (delta) {
				var hits = resultRef.current.hits;
				if (hits.length === 0) return;
				setSelected(function (prev) {
					var next = prev + delta;
					if (next < 0) next = 0;
					if (next > hits.length - 1) next = hits.length - 1;
					return next;
				});
			};

			var locateSelected = function (hitItem) {
				if (!hitItem) return;
				setOpen(false);
				locateHit(ctx, hitItem, hitItem.words || queryWords(query)).then(function (outcome) {
					if (outcome.ok) return;
					// 0.1.9：定位失败不再自动弹回面板（用户反馈被打扰），
					// 诊断细节在 DevTools console 的 [dsh-conversation-search] 行。
					console.info("[dsh-conversation-search] locate failed:", outcome.reason);
				});
			};

			var onInputKeyDown = function (event) {
				if (event.key === "Enter") {
					event.preventDefault();
					var hits = resultRef.current.hits;
					if (selected >= 0 && hits[selected]) locateSelected(hits[selected]);
					else runSearch(query, scope, 0, mode);
				} else if (event.key === "ArrowDown") {
					event.preventDefault();
					selectRelative(1);
				} else if (event.key === "ArrowUp") {
					event.preventDefault();
					selectRelative(-1);
				}
			};

			if (!open) return null;

			var hits = result.hits;
			var scopeCurrentId = currentSessionId(ctx);

			return h("div", {
				style: overlayStyle,
				onMouseDown: function () { setOpen(false); },
			}, h("div", {
				style: panelStyle,
				onMouseDown: function (event) { event.stopPropagation(); },
			},
				// 输入行
				h("div", { style: inputRowStyle },
					h("input", {
						ref: inputRef,
						style: inputStyle,
						value: query,
						placeholder: t("placeholder"),
						onChange: function (event) {
							setQuery(event.target.value);
							holder.query = event.target.value;
						},
						onKeyDown: onInputKeyDown,
						spellCheck: false,
					}),
					h("button", {
						style: scopeBtnStyle(scope === "current"),
						title: scopeCurrentId ? t("scopeCurrent") : t("scopeAll"),
						onClick: function () {
							if (scopeCurrentId) setScope(scope === "current" ? "all" : "current");
						},
					}, t("scopeCurrent")),
					h("button", {
						style: scopeBtnStyle(scope === "all"),
						onClick: function () { setScope("all"); },
					}, t("scopeAll")),
					h("button", {
						style: scopeBtnStyle(mode === "loose"),
						title: t("looseTip"),
						onClick: function () { setMode("loose"); },
					}, t("modeLoose")),
					h("button", {
						style: scopeBtnStyle(mode === "exact"),
						title: t("exactTip"),
						onClick: function () { setMode("exact"); },
					}, t("modeExact")),
					h("button", {
						style: scopeBtnStyle(mode === "regex"),
						title: t("regexTip"),
						onClick: function () { setMode("regex"); },
					}, t("modeRegex")),
				),
				// 状态行
				h("div", { style: statusBarStyle }, status.text),
				// 结果列表
				h("div", { style: resultListStyle },
					hits.length === 0
						? h("div", { style: { padding: "18px 14px", color: T.textTertiary, fontSize: "12px" } },
							status.kind === "loading" ? t("searching") : status.kind === "empty" || status.kind === "done" ? t("noResults") : "")
						: hits.map(function (hitItem, index) {
							var title = hitItem.title && hitItem.title.length > 0 ? clipText(hitItem.title, 60) : t("untitled");
							var time = formatTime(hitItem.time);
							return h("div", {
								key: hitItem.sessionId + "#" + hitItem.seq + "#" + index,
								style: hitRowStyleFor(index === selected || index === hover),
								onMouseEnter: function () { setHover(index); },
								onMouseLeave: function () {
									setHover(function (prev) { return prev === index ? -1 : prev; });
								},
								onClick: function () { locateSelected(hitItem); },
							},
								h("div", { style: hitTitleStyle },
									h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "380px" } }, title),
									time ? h("span", { style: { color: T.textTertiary, flex: "none" } }, time) : null,
								),
								h("div", { style: hitSnippetStyle }, renderSnippet(hitItem.snippet, hitItem.words || [])),
							);
						}),
				),
				// 底栏
				h("div", { style: footerStyle },
					h("span", null, t("hint")),
					result.truncated
						? h("button", {
							style: continueBtnStyle,
							onClick: function () { runSearch(query, scope, scannedOffsetRef.current, mode); },
						}, t("continueScan"))
						: null,
				),
			));
		}

		// ------------------------------------------------------------------
		// client 侧 remote 贡献描述符 + apply：slots（面板 + 按钮）
		// ------------------------------------------------------------------
		// client 网关校验分两层：api-gateway 只查 mode==="strict"，但
		// typert-registry 的 validateCodec 要求 typeSymbol + create() 函数
		// （0.1.1 缺 create 导致 $mount 抛 "no create() factory"、命名空间未
		// 建立——面板报“搜索服务不可用”）。client 传输只走 JSON，真正校验在
		// 宿主侧；create 返回透传校验器供反射/目录类调用方安全取用。
		var SEARCH_NS = "conversationSearch";
		function clientCodec(name) {
			return {
				mode: "strict",
				typeSymbol: "dsh-conversation-search#" + name,
				create: function () {
					return {
						parse: function (value) { return value; },
						safeParse: function (value) { return { success: true, data: value }; },
					};
				},
			};
		}
		function clientParam(name, type) {
			return { name: name, wire: name, source: "json", codec: clientCodec(type) };
		}
		var CLIENT_MOUNT = {
			package: "dsh-conversation-search",
			descriptors: [
				{
					id: "dsh-conversation-search#conversationSearch/search",
					service: SEARCH_NS,
					namespace: SEARCH_NS,
					method: "search",
					invocation: { kind: "direct" },
					parameters: [clientParam("request", "SearchRequest")],
					result: clientCodec("SearchResult"),
				},
			],
		};

		async function apply(ctx) {
			// 语言初值跟随宿主 locale 服务（动态切换由面板内订阅完成，0.1.11）。
			localeRef.current = currentLocaleOf(getService(ctx, "locale"));

			// 面板开关 holder：快捷键与组件共享。remote 服务在调用时惰性解析
			//（$mount 完成后 remote.conversationSearch 才存在）。
			var holder = {
				open: false,
				query: "",
				listeners: new Set(),
				getSearchSvc: function () {
					try {
						var viaGet = ctx.get ? ctx.get("remote." + SEARCH_NS) : undefined;
						if (viaGet) return viaGet;
						return ctx.remote ? ctx.remote[SEARCH_NS] : undefined;
					} catch (e) {
						return undefined;
					}
				},
			};
			function setOpen(value) {
				holder.open = value;
				holder.listeners.forEach(function (listener) { listener(value); });
			}

			// client 侧 remote 贡献：$mount 创建 remote.conversationSearch 命名空间。
			// 0.1.0 曾把该命名空间误声明进 inject —— 永远 pending，web boot 直接
			// 以 "entry did not activate" 崩溃（2026-10-10 11:34 crash）。挂载失败
			// 只降级本插件（面板报“搜索服务不可用”），绝不影响页面启动。
			try {
				var remoteSvc = ctx.get ? ctx.get("remote") : ctx.remote;
				if (remoteSvc && typeof remoteSvc.$mount === "function") {
					var disposeRemote = await remoteSvc.$mount(CLIENT_MOUNT);
					ctx.effect(function () {
						return function () {
							try { disposeRemote(); } catch (e) { /* 已卸载 */ }
						};
					}, "conversation-search: remote contribution");
				} else {
					holder.mountError = "ctx.remote.$mount unavailable";
					console.warn("[dsh-conversation-search] ctx.remote.$mount unavailable; search calls will fail until it appears");
				}
			} catch (error) {
				holder.mountError = String(error && error.message ? error.message : error);
				console.warn("[dsh-conversation-search] remote mount failed:", error);
			}

			// shell.overlay：全局搜索面板。
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "conversation-search",
					order: 90,
				}, function SearchOverlay() {
					return h(SearchPanel, { ctx: ctx, holder: holder, t: t });
				});
			});

			// conversation.composer.dock：面板触发入口（放大镜按钮，唯一入口）。
			// 自持样式：中性描边按钮，不依赖皮肤，浅/深主题下都不突兀。
			ctx.slots.inject("conversation.composer.dock", function () {
				return ctx.slots.register({
					name: "conversation.composer.dock",
					id: "conversation-search",
					order: 15,
				}, function SearchDockButton() {
					return h("button", {
						title: t("shortcutLabel"),
						"aria-label": t("shortcutLabel"),
						onClick: function () { setOpen(true); },
						style: {
							width: "26px",
							height: "26px",
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
							borderRadius: "7px",
							background: "transparent",
							color: "var(--dsw-alias-label-secondary, #9aa0a6)",
							cursor: "pointer",
							padding: "0",
						},
					}, h("svg", {
						viewBox: "0 0 20 20",
						width: "14",
						height: "14",
						"aria-hidden": true,
					},
						h("circle", { cx: "9", cy: "9", r: "5.5", fill: "none", stroke: "currentColor", strokeWidth: "1.6" }),
						h("path", { d: "m13.2 13.2 3.3 3.3", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" })));
				});
			});
		}

		/**
		 * 服务依赖只保留核心必然提供的 "remote"/"slots"；触发入口 = composer.dock
		 * 的放大镜按钮（0.1.3 起应用户要求移除快捷键注册）。remote.conversationSearch
		 * 由 apply 内 $mount 创建（绝不能进 inject）；sessions/uiWorkspace/locale
		 * 经 ctx.get 按需读取，不进入 inject。
		 */
		return {
			inject: ["remote", "slots"],
			apply: apply,
		};
	},
});
