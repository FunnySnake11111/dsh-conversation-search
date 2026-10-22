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
				modeLoose: "宽松匹配",
				modeExact: "精确匹配",
				modeRegex: "正则匹配",
				looseTip: "宽松模式：仅用户/助手消息 · 大小写不敏感 · 空白弹性多词 · 可勾选含注入上下文",
				exactTip: "精确搜索模式：默认不区分大小写、整词边界开启（两项均可在设置里改）· 空白不弹性 · 仅用户/助手消息 · 可勾选含注入上下文",
				regexTip: "正则模式：仅用户/助手消息 · 对消息文本执行你输入的正则表达式（区分大小写），语法错误会在状态栏提示 · 可勾选含注入上下文",
				rpcUnavailable: "搜索服务不可用（宿主半未就绪，可稍后重试）",
				rpcTimeout: "搜索超时（宿主半无响应），可重试或切到全部会话",
				showMore: "显示更多结果",
				foldedApprox: "可能被折叠",
				foldedApproxTip: "该对话可能被折叠，需要展开后查看；以实际定位结果为准",
				autoLoadEarlier: "正在自动加载更早的上下文…",
				autoLoadDone: "已自动加载并定位",
				autoLoadEmpty: "已加载全部更早内容，未找到该对话",
				autoLoadTimeout: "自动加载超时，已停在估算位置",
				autoLoadPartial: "已自动加载 {pages} 页，未到目标——再次点击该结果将继续加载定位",
				turnLoading: "正在定位第 {turn} 轮（装载历史中，远消息需数十秒）…",
				settings: "设置",
				autoLoadBudget: "自动加载时长（秒）",
				autoLoadBudgetHint: "定位较早消息时自动翻页的最长时间，15–120 秒，改动即时生效",
				expandFolded: "自动展开折叠的上下文（定位收尾时展开目标附近的折叠区）",
				releaseBeforeLocate: "定位前释放已装载的历史（切会话重置装载窗口，减轻宿主负担）",
				includeInjected: "包含注入的上下文",
				includeInjectedHint: "默认只搜真实对话消息；勾选后把记忆注入、工作区指令、运行环境、技能目录等 DSH 注入内容也纳入命中",
				caseSensitive: "区分大小写（仅精确匹配）",
				caseSensitiveHint: "默认不区分大小写：搜 npm 也会命中 NPM / Npm；勾选后严格按输入的大小写匹配",
				wholeWord: "整词边界（仅精确匹配）",
				wholeWordHint: "默认开启：搜 npm 不会命中 npmjs / npmrc；关闭后退化为连续字面匹配（仍不区分大小写、空白不弹性）",
				roleUser: "你",
				roleAssistant: "助手",
				roleContext: "上下文",
				roleContextTip: "DSH 注入的上下文消息（工作区指令、记忆注入、运行环境、技能目录等）",
				groupCount: "{n} 条",
				close: "关闭",
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
				modeLoose: "Loose match",
				modeExact: "Exact match",
				modeRegex: "Regex match",
				looseTip: "Loose mode: user/assistant messages only · case-insensitive · whitespace-flexible multi-word · injected context optional via Settings",
				exactTip: "Exact match: case-insensitive and whole-word by default (both configurable in Settings) · literal whitespace · user/assistant messages only · injected context optional",
				regexTip: "Regex mode: user/assistant messages only · runs your regex against message text (case-sensitive); invalid patterns show an error in the status bar · injected context optional via Settings",
				rpcUnavailable: "Search service unavailable (host half not ready; try again shortly)",
				rpcTimeout: "Search timed out (host half unresponsive); retry or switch to All sessions",
				showMore: "Show more results",
				foldedApprox: "folded",
				foldedApproxTip: "This message may be folded — expand to view; actual locate result overrides this",
				autoLoadEarlier: "Auto-loading earlier context…",
				autoLoadDone: "Loaded earlier context and located the hit",
				autoLoadEmpty: "All earlier context loaded; hit not found",
				autoLoadTimeout: "Auto-load timed out; staying at the estimated position",
				autoLoadPartial: "Auto-loaded {pages} pages, target not reached yet; click the hit again to continue",
				turnLoading: "Locating turn {turn} (loading history; distant messages can take tens of seconds)…",
				settings: "Settings",
				autoLoadBudget: "Auto-load budget (s)",
				autoLoadBudgetHint: "Max time for auto-loading earlier history when locating old hits, 15\u2013120 s, applies immediately",
				expandFolded: "Auto-expand folded context near the hit when locating finishes",
				releaseBeforeLocate: "Release loaded history before locating (resets the load window by toggling sessions)",
				includeInjected: "Include injected context",
				includeInjectedHint: "Off: real conversation messages only. On: also match DSH-injected text (memory dumps, workspace instructions, runtime context, skill catalog).",
				caseSensitive: "Case-sensitive (exact match only)",
				caseSensitiveHint: "Off by default: npm also matches NPM / Npm. On: match the exact casing you typed.",
				wholeWord: "Whole-word boundary (exact match only)",
				wholeWordHint: "On by default: npm does not match npmjs / npmrc. Off: plain substring match (still case-insensitive, whitespace still literal).",
				roleUser: "You",
				roleAssistant: "Assistant",
				roleContext: "Context",
				roleContextTip: "DSH-injected context message (workspace instructions, memory dump, runtime context, skill catalog, …)",
				groupCount: "{n} hits",
				close: "Close",
			},
		};

		// 语言状态：跟随宿主 locale 服务动态切换（0.1.11）。t 为稳定引用，
		// 每次调用按 localeRef.current 取词——面板订阅 locale 变更后重渲染即生效。
		var CLIENT_VERSION = "0.5.12";
		// 0.2.38：上一轮定位是否触发过历史装载（翻页/rail loadThrough）。置位后
		// 下一次定位开始时切会话重置装载窗口（releaseLoadedHistory）。
		var pendingRelease = false;

		// ------------------------------------------------------------------
		// 设置（0.2.27）：localStorage 持久化，client-only，不动宿主半。
		// 目前只有自动加载预算；读取容错（隐私模式/损坏 JSON 一律回默认）。
		// ------------------------------------------------------------------
		var SETTINGS_KEY = "dsh-conversation-search:settings";
		function loadSettings() {
			try {
				var raw = window.localStorage.getItem(SETTINGS_KEY);
				var parsed = raw ? JSON.parse(raw) : {};
				var seconds = parseInt(parsed.autoLoadBudgetSeconds, 10);
				if (!(seconds >= 15 && seconds <= 120)) seconds = 80; // 0.2.34：默认 60→80s（用户要求）
				return {
					autoLoadBudgetSeconds: seconds,
					expandFolded: parsed.expandFolded !== false,
					releaseBeforeLocate: parsed.releaseBeforeLocate !== false,
					// 0.5.2：默认关——只搜真实对话消息，注入上下文需显式勾选。
					includeInjected: parsed.includeInjected === true,
					// 0.5.5：精确匹配默认不区分大小写 + 保留整词边界（用户反馈"太精确"）。
					caseSensitive: parsed.caseSensitive === true,
					wholeWord: parsed.wholeWord !== false,
				};
			} catch (e) {
				return {
					autoLoadBudgetSeconds: 80, expandFolded: true, releaseBeforeLocate: true, includeInjected: false,
					caseSensitive: false, wholeWord: true,
				};
			}
		}
		function saveSettings(settings) {
			try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 静默：无 localStorage 时用默认值 */ }
		}
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

		/** 行文本按「词序列顺序出现」匹配（与官方 text 过滤的空白弹性语义一致）。
		 * 0.2.36：接受调用方传入的缓存文本，避免重复读 textContent。 */
		function rowMatches(row, words, cachedText) {
			var text = normalizeText(cachedText != null ? cachedText : rowText(row));
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
			position: "relative",
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

		var closeBtnStyle = {
			flex: "none", width: "24px", height: "24px", padding: "0",
			display: "flex", alignItems: "center", justifyContent: "center",
			borderRadius: "6px", border: T.borderSoft, background: "transparent",
			color: T.textTertiary, fontSize: "14px", lineHeight: "1", cursor: "pointer",
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
			cursor: "text",
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

		// 0.5.6：预览限 2 行（超出裁切），配合 windowSnippet 把命中前移到前两行内。
		var hitSnippetStyle = {
			fontSize: "13px",
			lineHeight: "1.5",
			color: T.textPrimary,
			wordBreak: "break-word",
			display: "-webkit-box",
			WebkitLineClamp: 2,
			WebkitBoxOrient: "vertical",
			overflow: "hidden",
		};

		// 0.5.6：角色徽标——命中自带 type（user/message、assistant/message）。
		var roleBadgeBase = {
			flex: "none", padding: "0 5px", borderRadius: "6px", fontSize: "10px",
			lineHeight: "16px", border: "1px solid transparent",
		};
		var roleUserStyle = Object.assign({}, roleBadgeBase, {
			color: "#4a9eff", borderColor: "rgba(74,158,255,0.5)", background: "rgba(74,158,255,0.12)",
		});
		var roleAssistantStyle = Object.assign({}, roleBadgeBase, {
			color: "#4bbf73", borderColor: "rgba(75,191,115,0.5)", background: "rgba(75,191,115,0.12)",
		});
		var roleContextStyle = Object.assign({}, roleBadgeBase, {
			color: T.textTertiary, borderColor: T.borderSoft,
		});
		function roleOf(type) {
			var s = String(type == null ? "" : type);
			if (s === "assistant/message") return "assistant";
			if (s === "user/message") return "user";
			return "context";
		}
		function roleBadge(type) {
			var role = roleOf(type);
			if (role === "assistant") return h("span", { style: roleAssistantStyle }, t("roleAssistant"));
			if (role === "user") return h("span", { style: roleUserStyle }, t("roleUser"));
			return h("span", { style: roleContextStyle, title: t("roleContextTip") }, t("roleContext"));
		}

		/** 0.5.6：把预览窗口挪到首个命中词附近（前留 LEAD 字），避免命中落在裁切线外。
		 * snippet 本身由宿主按命中位置生成（前 1/3），这里再收一次是为 2 行裁切服务。 */
		function windowSnippet(snippet, words) {
			var text = String(snippet == null ? "" : snippet);
			if (text.length === 0 || !Array.isArray(words) || words.length === 0) return text;
			var lower = text.toLowerCase();
			var at = -1;
			for (var i = 0; i < words.length; i++) {
				var w = String(words[i] || "").toLowerCase();
				if (w.length === 0) continue;
				var idx = lower.indexOf(w);
				if (idx >= 0 && (at < 0 || idx < at)) at = idx;
			}
			if (at < 0) return text;
			var LEAD = 12;
			if (at <= LEAD) return text;
			var cut = at - LEAD;
			var space = text.lastIndexOf(" ", cut);
			if (space > cut - 12) cut = space + 1;
			return "…" + text.slice(cut);
		}

		// 0.5.6：会话分组头（仅「全部会话」模式）。
		var groupHeaderStyle = {
			display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
			padding: "6px 14px", fontSize: "11px", color: T.textSecondary,
			background: "rgba(127,127,127,0.07)", borderBottom: T.borderSoft,
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

		/** 0.2.38：定位前释放已装载历史。宿主 rail 跳转的本质是 loadThrough(seq)
		 * （asar lib-client.js:4199-4211 实证）——从当前窗口一路装载到目标 seq，
		 * 且没有任何卸载/裁剪机制，装载页全部留在 store，越跳越重。插件侧唯一
		 * 的重置手段：切到另一会话再切回，会话视图卸载重建、装载窗口重置回
		 * 默认（最近一窗）。副作用：视口回尾部——释放发生在「下一次定位开始」，
		 * 新定位本来就要跳走，无实际损失。单会话用户无可切目标，静默跳过。 */
		async function releaseLoadedHistory(ctx, sessionId) {
			try {
				var sessions = getService(ctx, "sessions");
				var list = sessions && sessions.list ? sessions.list.getSnapshot() : null;
				if (!list || !list.byId) return false;
				var other = null;
				var rows = Object.values(list.byId);
				for (var i = 0; i < rows.length; i++) {
					var row = rows[i];
					if (!row || !row.id || row.id === sessionId) continue;
					other = row.id;
					break;
				}
				if (!other) return false;
				var workspace = getService(ctx, "uiWorkspace");
				if (!workspace || typeof workspace.openSession !== "function") return false;
				await workspace.openSession(other);
				await sleep(350);
				await workspace.openSession(sessionId);
				await sleep(350);
				return true;
			} catch (e) {
				dwarn("release loaded history failed", e);
				return false;
			}
		}

		/**
		 * 0.5.3：RPC 超时保护。旧实现只有 searchSeq 丢弃过期响应，网关挂起时
		 * 会永久停在「搜索中…」（连「继续扫描」都不出现）。超时映射为可重试错误。
		 */
		var RPC_TIMEOUT_MS = 12000;
		function withTimeout(promise, ms, label) {
			return new Promise(function (resolve, reject) {
				var timer = setTimeout(function () {
					reject(new Error("RPC_TIMEOUT " + label));
				}, ms);
				promise.then(
					function (value) { clearTimeout(timer); resolve(value); },
					function (error) { clearTimeout(timer); reject(error); },
				);
			});
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
		// 0.3.1 诊断回传：渲染进程 console 不落盘、DSH 也未开 CDP 调试端口
		// （已核实进程命令行），靠用户截图转发日志太低效。定位链路日志写入
		// 环形缓冲，定位结束后经 typert pushDiag 由宿主半追加写插件根
		// .diag.log，AI 直接读文件。RPC 不可用时静默降级：只 console。
		// ------------------------------------------------------------------
		var DIAG_MAX = 400;
		var diagBuf = [];
		var diagFlushing = false;
		// 双保险：只有一次成功的 search RPC 证明网关往返可用后才允许冲刷，
		// 任何情况下都不可能在 web boot 期间发出诊断 RPC。
		var diagChannelProven = false;
		function diagFmt(args) {
			var parts = [];
			for (var i = 0; i < args.length; i++) {
				var a = args[i];
				if (typeof a === "string") { parts.push(a); continue; }
				try {
					parts.push(a instanceof Error ? (a.stack || String(a)) : JSON.stringify(a));
				} catch (e) { parts.push("[unserializable]"); }
			}
			return parts.join(" ");
		}
		function dlog() {
			var msg = diagFmt(arguments);
			if (msg.length > 3800) msg = msg.slice(0, 3800) + "…(truncated)";
			diagBuf.push(new Date().toISOString() + " [info] " + msg);
			if (diagBuf.length > DIAG_MAX) diagBuf.splice(0, diagBuf.length - DIAG_MAX);
			console.info("[dsh-conversation-search] " + msg);
		}
		function dwarn() {
			var msg = diagFmt(arguments);
			if (msg.length > 3800) msg = msg.slice(0, 3800) + "…(truncated)";
			diagBuf.push(new Date().toISOString() + " [warn] " + msg);
			if (diagBuf.length > DIAG_MAX) diagBuf.splice(0, diagBuf.length - DIAG_MAX);
			console.warn("[dsh-conversation-search] " + msg);
		}
		/** 定位结束后冲刷诊断缓冲（fire-and-forget，失败放回缓冲下次再试）。 */
		function flushDiag(ctx) {
			if (diagBuf.length === 0 || diagFlushing || !diagChannelProven) return;
			var svc = null;
			try {
				svc = ctx.get ? ctx.get("remote." + SEARCH_NS) : (ctx.remote ? ctx.remote[SEARCH_NS] : undefined);
			} catch (e) { return; }
			if (!svc || typeof svc.pushDiag !== "function") return;
			var lines = diagBuf.splice(0, diagBuf.length);
			// 0.4.2：冲刷前再截断一次——宿主 strict codec 对 >4000 字符的行整包
			// 拒收，超长行混进缓冲会成为毒丸（拒收 → 放回 → 重试 → 永远失败，
			// diag 文件永远不出现）。
			for (var li = 0; li < lines.length; li++) {
				if (lines[li].length > 3900) lines[li] = lines[li].slice(0, 3900) + "…(truncated)";
			}
			diagFlushing = true;
			callRemote(svc, "pushDiag", { payload: { lines: lines } }).then(function (value) {
				diagFlushing = false;
				// 0.4.1：证据链闭环——落盘成功/失败都在诊断与 console 可见，
				// 不再两头静默（宿主写失败此前只进不可见的宿主 console）。
				if (value && typeof value === "object" && value.error) {
					dwarn("diag write failed on host: " + value.error);
				} else {
					console.info("[dsh-conversation-search] diag flushed: " + lines.length + " line(s) -> ~/.dsh/conversation-search.diag.log");
				}
			}, function (error) {
				diagFlushing = false;
				dwarn("diag flush RPC failed", error);
				for (var i = lines.length - 1; i >= 0; i--) diagBuf.unshift(lines[i]);
				if (diagBuf.length > DIAG_MAX) diagBuf.splice(DIAG_MAX);
			});
		}

		// ------------------------------------------------------------------
		// DOM 定位：向下扫到 floor → 渐进向上（触发 paging）扫到顶
		// ------------------------------------------------------------------
		function sleep(ms) {
			return new Promise(function (resolve) { setTimeout(resolve, ms); });
		}

		/** 行匹配器：正则模式用表达式本身，其余模式用词序列顺序匹配。 */
		function makeRowMatcher(locateMode, rawPattern, words) {
			if (locateMode === "regex" && rawPattern) {
				var re = null;
				try { re = new RegExp(rawPattern, "u"); } catch (e) { re = null; }
				if (re) {
					return function (row, cachedText) {
						try { return re.test(cachedText != null ? cachedText : rowText(row)); } catch (e2) { return false; }
					};
				}
			}
			return function (row, cachedText) { return rowMatches(row, words, cachedText); };
		}

		/**
		 * 0.2.3 关键修复：页面上可能同时存在多个 [data-chat-flow]（多会话保留渲染），
		 * querySelector 抓到的第一个往往是空的/非活动容器——0.2.2 的定位因此全空转
		 * （console 无 proportional 行、totalNodes=0）。改为按「含行数 × 可见性」选
		 * 最优容器；行与 data-index 的匹配也改为全文档查询。
		 */
		function pickFlow() {
			var flows = document.querySelectorAll("[data-chat-flow]");
			var best = null, bestScore = -1;
			for (var i = 0; i < flows.length; i++) {
				var f = flows[i];
				var rowCount = f.querySelectorAll("[data-chat-flow-kind]").length;
				var visible = f.getClientRects().length > 0 && f.getBoundingClientRect().height > 10;
				var score = rowCount * (visible ? 10 : 1);
				if (rowCount > 0 && score > bestScore) { bestScore = score; best = f; }
			}
			return best;
		}

		/** 指纹投影（0.2.10）：去掉全部标点/Markdown 符号，只留字母数字与中文。
		 * 宿主提取的 hit.text 是 Markdown 源码文本（带 # * ` 等），行渲染后的
		 * textContent 没有这些符号——逐字符比对必失配；两侧都投影后再比对。 */
		function fingerprintKey(text) {
			return normalizeText(text).replace(/[^0-9A-Za-z\u4e00-\u9fff]+/g, "");
		}

		/** 0.2.36：行文本/投影缓存——findHitRowDoc 在翻页循环与时间二分里反复全量
		 * 重扫，textContent 读取本身会触发样式/布局同步，行数大时每次 30–100ms。
		 * WeakMap 以行元素为键：React 重建元素后旧键自动被 GC，缓存无需手动清理。
		 * 已知边界：流式生成中的行内容会变，缓存返回旧文本——定位场景影响可忽略。 */
		var rowTextCache = new WeakMap();
		var rowProjCache = new WeakMap();
		function rowText(row) {
			var t = rowTextCache.get(row);
			if (t === undefined) {
				t = String(row.textContent || "");
				rowTextCache.set(row, t);
			}
			return t;
		}
		function rowProj(row) {
			var p = rowProjCache.get(row);
			if (p === undefined) {
				p = fingerprintKey(rowText(row));
				rowProjCache.set(row, p);
			}
			return p;
		}
		/** 0.2.36：视口相交判定——overscan 行有盒子但不该参与扫描/采样。 */
		function rowInViewport(row) {
			try {
				var r = row.getBoundingClientRect();
				return r.bottom > 0 && r.top < (window.innerHeight || 800);
			} catch (e) { return true; }
		}

		/** 公共前缀长度（指纹打分用）。 */
		function commonPrefixLen(a, b) {
			var n = Math.min(a.length, b.length);
			for (var i = 0; i < n; i++) {
				if (a[i] !== b[i]) return i;
			}
			return n;
		}

		/**
		 * 全文档扫描命中行（0.2.10 两遍打分制）：
		 * 第一遍=指纹包含：行文本投影包含命中原文投影前缀（≥16 个密集字符）即目标行
		 * ——唯一标识，与搜索词是否出现在多条消息无关。
		 * 第二遍=词匹配候选中取「与命中原文公共前缀最长」者——目标消息与自己的
		 * hit.text 相似度必然最高，引述/同词的邻近消息都赢不了它（0.2.8/0.2.9 按
		 * DOM 顺序取首个含词行，会落在更早的同词消息上）。
		 * 0.2.11：指纹存在但最高分 <12 时拒收词匹配落点（console 实测出现过 score=0
		 * ——与命中原文毫无共同之处的纯巧合含词行被直接高亮，造成乱跳），让调用方
		 * 继续翻页寻找真目标。
		 * 0.2.13：折叠摘要条不作候选——条内嵌被折叠内容的开头预览，投影会与
		 * hit.text 共享前缀，实测抢走过指纹/词匹配（score=35 高亮到条上）。
		 * 0.2.17：摘要条签名改为 asar 实证——CompactionItem（dsh-client-ui-chat
		 * lib/client.js CompactionItem）渲染 div.compactionRow > button >
		 * span[data-compaction-icon="context"] + span[data-compaction-disclosure=
		 * "expanded"|"collapsed"] + span.compactionSummary；正则猜测（已折叠/…开头）
		 * 与真实条文本不符，是 0.2.13-0.2.16 误判的根源。保留正则作兜底。
		 */
		function isFoldStripLike(row) {
			try {
				if (row.querySelector('[data-compaction-disclosure],[data-compaction-icon="context"]')) return true;
			} catch (e) { /* 选择器异常按非条处理 */ }
			var t = rowText(row).trim();
			// 0.2.10：正则兜底收窄（审查 P3）——「展开.*上下文」会误伤
			// 「展开上下文看看」一类正常消息；真实摘要条由上面的 asar 实证签名兜住。
			return t.length > 0 && t.length <= 120 && /^(已折叠|折叠的上下文|collapsed)/i.test(t);
		}
		/** 0.2.37：宿主回合大纲 rail（TurnNavigator）的全部 mark，turn 升序。
		 * asar 实证（lib-client.js:3605-3632）：mark = button[type=button]，aria-label
		 * 内嵌 turn 号——zh「跳转到第 N 轮/加载并跳转到第 N 轮」(:5451)、en
		 * "Jump to turn N/Load and jump to turn N" (:5640)。aria-label 与 aria-current
		 * 是稳定属性（CSS module 类名带运行时哈希不可靠——b33 教训）。 */
		function railMarks() {
			var buttons = document.querySelectorAll('button[type="button"][aria-label]');
			var marks = [];
			for (var i = 0; i < buttons.length; i++) {
				var m = (buttons[i].getAttribute("aria-label") || "").match(
					/^(?:加载并跳转到第|跳转到第)\s*(\d+)\s*轮$|^(?:Load and jump to|Jump to) turn (\d+)$/
				);
				if (m) marks.push({ el: buttons[i], turn: parseInt(m[1] || m[2], 10) });
			}
			marks.sort(function (a, b) { return a.turn - b.turn; });
			return marks;
		}
		/** 0.2.37：当前激活（视口所在）回合号——aria-current="true" 的 mark（:3617）。 */
		function activeRailTurn() {
			var buttons = document.querySelectorAll('button[type="button"][aria-label]');
			for (var i = 0; i < buttons.length; i++) {
				if (buttons[i].getAttribute("aria-current") === "true") {
					var m = (buttons[i].getAttribute("aria-label") || "").match(/(\d+)/);
					return m ? parseInt(m[1], 10) : null;
				}
			}
			return null;
		}
		/** 0.2.36：单轮行匹配（指纹包含 + 词匹配打分）——从 findHitRowDoc 提取，
		 * 支持两段式（先视口内后全量）复用；text/proj 全部走缓存。 */
		function scanRows(list, matchRow, hitFp) {
			if (hitFp && hitFp.length >= 16) {
				for (var a = 0; a < list.length; a++) {
					if (rowProj(list[a]).indexOf(hitFp) >= 0) {
						dlog("row matched by hit-text fingerprint");
						return list[a];
					}
				}
			}
			var best = null;
			var bestScore = -1;
			for (var b = 0; b < list.length; b++) {
				var t = rowText(list[b]);
				if (!matchRow(list[b], t)) continue;
				var score = hitFp ? commonPrefixLen(rowProj(list[b]), hitFp) : 0;
				if (score > bestScore) {
					best = list[b];
					bestScore = score;
				}
			}
			if (best && (bestScore >= 12 || !hitFp)) {
				dlog("row matched by word matcher, score=" + bestScore);
				return best;
			}
			return null;
		}
		function findHitRowDoc(matchRow, hitFp) {
			var rows = document.querySelectorAll("[data-chat-flow-kind]");
			var visible = [];
			var firstInvisible = null;
			for (var i = 0; i < rows.length; i++) {
				if (isFoldStripLike(rows[i])) continue;
				if (rows[i].getClientRects().length > 0) visible.push(rows[i]);
				else if (firstInvisible === null) firstInvisible = rows[i];
			}
			// 0.2.36：两段式——先只扫视口相交的行（目标大概率就在当前窗口或紧邻
			// overscan），未命中再全量。text/proj 有缓存，第二轮的重复读几乎零成本，
			// 常见路径（目标在视口附近）的匹配成本从全量降到一窗。
			var viewportRows = [];
			for (var v = 0; v < visible.length; v++) {
				if (rowInViewport(visible[v])) viewportRows.push(visible[v]);
			}
			var hit = scanRows(viewportRows, matchRow, hitFp);
			if (hit) return hit;
			hit = scanRows(visible, matchRow, hitFp);
			if (hit) return hit;
			if (hitFp && hitFp.length >= 16) {
				dlog("word-match rejected, keep scanning");
			}
			return null;
		}

		/** 0.4.0：回合锚定行查找。行属性 data-chat-turn（asar lib-client.js:1766/:2351，
		 * 宿主自身 outline 跳转同用 :4685/:4712）直接定位命中所属回合的行——回合归属
		 * 来自宿主日志 seq 映射，不依赖行文本；KaTeX/Markdown 渲染差异导致的
		 * 指纹/词匹配双失配不再让「已到正确回合」被判未中。 */
		function findTurnRow(turn, kindHint) {
			if (typeof turn !== "number" || !isFinite(turn)) return null;
			var rows = document.querySelectorAll('[data-chat-turn="' + turn + '"]');
			var visible = [];
			for (var i = 0; i < rows.length; i++) {
				if (isFoldStripLike(rows[i])) continue;
				if (rows[i].getClientRects().length > 0) visible.push(rows[i]);
			}
			if (visible.length === 0) return null;
			if (kindHint) {
				var hint = String(kindHint);
				var prefix = hint.split("/")[0]; // user/message → user，assistant/message → assistant
				for (var e = 0; e < visible.length; e++) {
					if ((visible[e].getAttribute("data-chat-flow-kind") || "") === hint) return visible[e];
				}
				for (var f = 0; f < visible.length; f++) {
					if ((visible[f].getAttribute("data-chat-flow-kind") || "").split("/")[0] === prefix) return visible[f];
				}
			}
			return visible[0];
		}

		/** 0.2.15：搜索结果的「≈ 折叠区」预判——只读探针，不滚动、不点击、不展开。
		 * 0.2.16 两处校准（用户实测「判断不完全准确」）：
		 * ① 不再只看视口可见行——折叠行可能被 CSS 压成近零高但仍带全文，
		 *    收编 loaded flow 内全部行（排除摘要条），可见/隐藏一视同仁；
		 * ② 判定与 locateHit 的两遍接受逻辑完全一致（指纹包含，或词匹配且
		 *    与命中原文公共前缀 ≥12）——只要 locate 现在能找到，就不打标，
		 *    消除「Markdown 渲染差异导致指纹不包含」的误标。
		 * 0.2.17 第三处校准（asar 实证后）：移除 seqFraction≥0.6 门槛——
		 * 折叠的是会话「早期」（低 fraction），旧门槛恰好把真正的折叠区
		 * 命中挡在探针外（用户实测「被打上折叠标签的明显变少了」）；同时
		 * isFoldStripLike 换上真实签名（data-compaction-disclosure），摘要条
		 * 不再被当成普通行骗过探针。
		 * 0.2.18 第四处校准（用户实测「手动折叠步骤组后命中不打标」）：
		 * 收回 0.2.16 的「全部行」——手动折叠的步骤组（已完成/执行 N 次思考）
		 * 行仍在 DOM 但 display:none，探针「找到」了 locate 根本不会接受的
		 * 隐藏行 → 两套判定不一致 → 该打标的不打。探针的接受集合必须与
		 * findHitRowDoc 完全一致 = getClientRects().length>0 的可见行。
		 * 0.2.19 并集语义（用户选定）：打标 = ①locate 接受的行不存在
		 * （跳转大概率落到估算位置）或 ②该行处于手动折叠的回合组内
		 * （点跳转能到但内容收着，需展开才能看到）。折叠回合用 asar 实证
		 * 签名判定：TurnProcessNodeView 回合头 button[data-turn-process=<turn>]
		 * 展开带 data-open、折叠时无（lib-client.js:6245）；行→回合用
		 * 行属性 data-chat-turn。另修 0.2.16 起的索引错位 bug：projections
		 * 跳过摘要条/隐藏行，词匹配第二遍却用未过滤的 rows[k]——一直拿错行。 */
		/** 0.2.21：「加载更早」按钮发现（asar 实证：ChatView hasMore 分支渲染
		 * div.chat-older > button[onClick=scroll.loadEarlier]，loadingOlder 时
		 * disabled、文案切「加载中」；CSS module 哈希类保留 _older 后缀，
		 * 故用 [class$="_older"] 后缀匹配）。按钮整个不渲染 = 更早历史已全部
		 * 加载（hasMore=false），可作翻页循环的自然终止条件。 */
		function findLoadOlderButton() {
			try {
				var holders = document.querySelectorAll('div[class$="_older"]');
				for (var i = 0; i < holders.length; i++) {
					var btn = holders[i].querySelector('button[type="button"]');
					if (btn && btn.getClientRects().length > 0) return btn;
				}
			} catch (e) { /* 查询异常按无按钮处理 */ }
			return null;
		}

		/** 0.2.31：从行文本解析宿主 formatMessageClock 时间标签（lib-client.js:1057）：
		 * 当年非当天 "M/D HH:mm"、当天 "HH:mm"。跨年行走 clock.ymd 模板（含年份）
		 * 不匹配——二分仅在当年内保证正确，可接受。返回本地 epoch ms；NaN=无时间。 */
		function parseRowClock(text, nowYear) {
			var m = text.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
			if (m) {
				return new Date(nowYear, parseInt(m[1], 10) - 1, parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)).getTime();
			}
			var c = text.match(/(?:^|\s)(\d{1,2}):(\d{2})(?:\s|$)/);
			if (c) {
				var d0 = new Date();
				return new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), parseInt(c[1], 10), parseInt(c[2], 10)).getTime();
			}
			return NaN;
		}

		/** 0.2.32：保守展开定位目标附近的折叠区。0.2.11/0.2.12 的教训：盲目反复
		 * 点击 → React 重建元素使已点标记失效 → 同一行开合翻转 + 高度变化干扰
		 * 翻页循环（0.2.13 整体移除 expandFoldedRows）。本次三条纪律：
		 * ① 只在定位收尾（翻页/扫描循环全部结束）后执行，绝不进循环；
		 * ② 只点「确认折叠态」的控件——回合头 button[data-turn-process] 无
		 *    data-open（b19 asar 实证）、CompactionItem 摘要条 button（b17 asar
		 *    实证，条本身只在折叠态渲染）；去重按 data-turn 号/摘要文本——
		 *    值不随 React 重建变，比 WeakSet 元素引用可靠；
		 * ③ 上限 6 个、只碰可见的（视口附近），点后由调用方 sleep 让渲染收敛。 */
		var expandTriedTurns = null;
		var expandTriedStrips = null;
		function resetExpandMemo() {
			expandTriedTurns = new Set();
			expandTriedStrips = new Set();
		}
		function expandFoldedNear() {
			var expanded = 0;
			var headsFound = 0;
			var stripsFound = 0;
			try {
				if (!expandTriedTurns) resetExpandMemo();
				var heads = document.querySelectorAll('button[data-turn-process]:not([data-open])');
				headsFound = heads.length;
				for (var i = 0; i < heads.length && expanded < 6; i++) {
					if (heads[i].getClientRects().length === 0) continue;
					var turnKey = heads[i].getAttribute("data-turn-process") || String(i);
					if (expandTriedTurns.has(turnKey)) continue;
					expandTriedTurns.add(turnKey);
					try { heads[i].click(); expanded += 1; } catch (e) { /* 忽略单个失败 */ }
				}
				// 0.2.33：改用 data 属性定位摘要条——b17 源码里的 "compactionRow" 是
				// CSS module 的 key，运行时类名可能被哈希（[class*=] 匹配不到 =
				// 0.2.32 「展开未生效」的头号嫌疑）；data-compaction-icon 是真实
				// data 属性，不参与哈希。按钮 = span 的最近 button 祖先。
				var icons = document.querySelectorAll('span[data-compaction-icon="context"]');
				stripsFound = icons.length;
				for (var j = 0; j < icons.length && expanded < 6; j++) {
					var stripBtn = icons[j].closest ? icons[j].closest("button") : null;
					if (!stripBtn || stripBtn.getClientRects().length === 0) continue;
					var row = stripBtn.closest('div');
					var stripKey = (row && row.textContent ? row.textContent.trim().slice(0, 40) : "") || String(j);
					if (expandTriedStrips.has(stripKey)) continue;
					expandTriedStrips.add(stripKey);
					try { stripBtn.click(); expanded += 1; } catch (e) { /* 忽略单个失败 */ }
				}
			} catch (e) { /* 展开失败不影响定位主流程 */ }
			dlog("expand: turnHeads=" + headsFound + " compactionStrips=" + stripsFound + " clicked=" + expanded);
			return { clicked: expanded, headsFound: headsFound, stripsFound: stripsFound };
		}

		/** 0.2.21：轻量 toast（固定底部居中，sticky=常驻直到 hideToast/下次
		 * 非 sticky 调用；失败静默——toast 不允许影响定位主流程）。 */
		var toastEl = null;
		var toastTimer = null;
		function showToast(text, sticky) {
			try {
				if (!toastEl) {
					toastEl = document.createElement("div");
					toastEl.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(24,24,28,0.94);color:#e8e8ec;padding:9px 16px;border-radius:10px;font-size:13px;line-height:18px;box-shadow:0 6px 24px rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.08);pointer-events:none;transition:opacity .2s;max-width:60vw";
					document.body.appendChild(toastEl);
				}
				toastEl.textContent = text;
				toastEl.style.opacity = "1";
				if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
				if (!sticky) toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = "0"; }, 2600);
			} catch (e) { /* toast 失败不影响定位 */ }
		}
		function hideToast() {
			try { if (toastEl) toastEl.style.opacity = "0"; } catch (e) { /* 忽略 */ }
		}

		function foldedTurnSet() {
			var set = {};
			try {
				var heads = document.querySelectorAll("button[data-turn-process]:not([data-open])");
				for (var i = 0; i < heads.length; i++) {
					var tv = heads[i].getAttribute("data-turn-process");
					if (tv !== null) set[tv] = true;
				}
			} catch (e) { /* 查询异常按空集处理 */ }
			return set;
		}
		function probeFoldedHits(ctx, hits, locateMode, rawPattern, words) {
			var currentId = currentSessionId(ctx);
			if (!currentId) return {};
			var matchRow = makeRowMatcher(locateMode, rawPattern, words);
			var allRows = document.querySelectorAll("[data-chat-flow-kind]");
			var liveRows = [];
			var projections = [];
			for (var i = 0; i < allRows.length; i++) {
				if (isFoldStripLike(allRows[i])) continue;
				if (allRows[i].getClientRects().length === 0) continue;
				var text = rowText(allRows[i]); // 0.2.36：缓存化——探针每次搜索都全量跑
				liveRows.push(allRows[i]);
				projections.push(text.length === 0 ? "" : rowProj(allRows[i]));
			}
			var folded = foldedTurnSet();
			var map = {};
			for (var j = 0; j < hits.length; j++) {
				var hitItem = hits[j];
				if (hitItem.sessionId !== currentId) continue;
				var key = hitItem.sessionId + "#" + hitItem.seq;
				var fp = fingerprintKey(hitItem.text || "");
				if (fp.length > 120) fp = fp.slice(0, 120);
				if (fp.length < 16) fp = ""; // 与 locateHit 一致：短指纹走纯词匹配（审查 P2）
				var located = -1;
				if (fp.length >= 16) {
					for (var k = 0; k < projections.length; k++) {
						if (projections[k].indexOf(fp) >= 0) { located = k; break; }
					}
					if (located < 0) {
						for (var w2 = 0; w2 < projections.length; w2++) {
							if (matchRow(liveRows[w2]) && commonPrefixLen(projections[w2], fp) >= 12) { located = w2; break; }
						}
					}
				} else {
					// 短/空指纹：locate 的 findHitRowDoc 无条件接受首个词匹配行——探针同语义，
					// 旧实现直接视为「找不到」→ 短指纹命中全被打「≈折叠」标（审查 P2）。
					for (var w3 = 0; w3 < liveRows.length; w3++) {
						if (matchRow(liveRows[w3])) { located = w3; break; }
					}
				}
				var unfoldedTarget = false;
				if (located >= 0) {
					var turnAttr = liveRows[located].getAttribute("data-chat-turn");
					unfoldedTarget = !(turnAttr !== null && folded[turnAttr]);
				}
				if (!unfoldedTarget) map[key] = true;
			}
			return map;
		}

		/** 从元素向上找真正的滚动容器（scrollHeight 明显大于 clientHeight）。 */
		function scrollerOf(el) {
			var node = el;
			while (node && node !== document.body) {
				if (node.scrollHeight > node.clientHeight + 4 && node.clientHeight > 100) return node;
				node = node.parentElement;
			}
			return null;
		}

		/**
		 * 真滚动容器验证（0.2.7）：scrollerOf 只看几何条件，可能选中「看起来可滚
		 * 但赋值 scrollTop 不生效」的元素（本机构建的虚拟列表容器就出现过——
		 * 跳底后 data-index 仍是 0..34，滚动完全没发生）。这里对候选逐个做
		 * 「赋值→读回→还原」实测，返回第一个真的会动的元素。
		 */
		function findRealScroller(el) {
			var node = el;
			while (node && node !== document.body) {
				if (node.scrollHeight > node.clientHeight + 10 && node.clientHeight > 100) {
					try {
						var before = node.scrollTop;
						node.scrollTop = before + 40;
						var moved = Math.abs(node.scrollTop - before) > 1;
						node.scrollTop = before;
						if (moved) return node;
					} catch (e) { /* 忽略 */ }
				}
				node = node.parentElement;
			}
			return null;
		}

		/** WAAPI 关键帧不接受 var()（无效值被静默丢弃、动画等于空转）——先把主题 token 解析成实色。 */
		function resolveToken(name, fallback) {
			try {
				var value = getComputedStyle(document.documentElement).getPropertyValue(name);
				return value && value.trim().length > 0 ? value.trim() : fallback;
			} catch (e) {
				return fallback;
			}
		}


		/**
		 * 0.5.11：落点守卫。
		 * 跨会话定位的实测形态：native jump → 宿主 loadThrough 装载完成（9.8s）→
		 * 我们 scrollIntoView 一次 → 宿主在装载收尾的 reconcile / 跟随尾部
		 * 把滚动重置回底部 → 用户看到「历史加载了，但没跳过去」。
		 * highlightRow 只滚一次且立刻返回 ok，无从得知落点被覆盖。
		 * 这里做被动复核：定位后 4.5s 内每 200ms 检查目标行是否还在视口，
		 * 被推走就重滚；用户一旦自己滚轮/触摸/按键就立即让位（不抢用户意图）。
		 */
		function scrollContainerForRow(row) {
			if (!row || !row.isConnected) return null;
			return findRealScroller(row) || scrollerOf(row) || null;
		}

		/** 行是否在滚动容器可视区内（留 8px 边距，避免「贴边算可见」的抖动）。 */
		function isRowInViewport(row, sc) {
			if (!row || !row.isConnected) return false;
			var rr = row.getBoundingClientRect();
			if (rr.height <= 0) return false;
			if (!sc || typeof sc.getBoundingClientRect !== "function") return true;
			var sr = sc.getBoundingClientRect();
			if (sr.height <= 0) return true;
			return rr.top < sr.bottom - 8 && rr.bottom > sr.top + 8;
		}

		function guardLanding(row, token) {
			// 0.5.12：窗口 4.5s → 10s（装载收尾的 reconcile 可能比落地晚）；
			// 行失联时按同一匹配规则重解析，而不是直接放弃。
			var deadline = Date.now() + 10000;
			var reasserts = 0;
			var rebuilds = 0;
			var misses = 0;
			var stopped = false;
			// 用户主动操作即让位；监听器在守卫结束/让位时全部摘除，避免多次定位堆积。
			var stop = function () { stopped = true; };
			var detach = function () {
				window.removeEventListener("wheel", stop);
				window.removeEventListener("touchstart", stop);
				window.removeEventListener("keydown", stop);
			};
			window.addEventListener("wheel", stop, { passive: true });
			window.addEventListener("touchstart", stop, { passive: true });
			window.addEventListener("keydown", stop);
			var step = function () {
				if (stopped || token !== locateSeq) {
					detach();
					return;
				}
				if (!row || !row.isConnected) {
					var rebuilt = typeof locateResolve === "function" ? locateResolve() : null;
					if (rebuilt) { row = rebuilt; rebuilds++; } else { misses++; }
				}
				if (row && row.isConnected) {
					misses = 0;
					var sc = scrollContainerForRow(row);
					if (!isRowInViewport(row, sc)) {
						try { row.scrollIntoView({ block: "center" }); reasserts++; } catch (e) { /* 忽略 */ }
					}
				}
				if (Date.now() < deadline) {
					setTimeout(step, 200);
					return;
				}
				detach();
				dlog("landing guard done: re-asserted=" + reasserts + " rebuilt=" + rebuilds
					+ " misses=" + misses + " (window 10s)");
			};
			setTimeout(step, 200);
		}

		function highlightRow(row) {
			try {
				row.scrollIntoView({ block: "center" });
			} catch (e) { /* 旧引擎无 options */ }
			try {
				var accent = resolveToken("--dsw-alias-brand-primary", "#247bbf");
				row.animate(
					[
						{ outline: "3px solid " + accent, outlineOffset: "-3px", backgroundColor: "rgba(224,138,60,0.20)" },
						{ outline: "3px solid " + accent, outlineOffset: "-3px", backgroundColor: "rgba(224,138,60,0.20)", offset: 0.6 },
						{ outline: "3px solid transparent", outlineOffset: "-3px", backgroundColor: "rgba(224,138,60,0)" },
					],
					{ duration: 2600, easing: "ease-out" },
				);
			} catch (e) { /* 无 WAAPI 时仅滚动定位 */ }
			guardLanding(row, locateSeq);
		}

		/** 定位代次：新的定位开始后，旧的异步定位循环自行中止，避免扫错会话。 */
		var locateSeq = 0;
		// 0.5.12：当前定位的「行解析器」。落点守卫不能用元素引用守——宿主在装载收尾
		// 会重建行（元素失联），旧实现 row.isConnected === false 就静默放弃了。
		// 这里改成每次按同一套匹配规则重新解析目标行，行重建也能继续守。
		var locateResolve = null;

		/**
		 * 0.5.9：定位出口兜底（审查 C2）——locateHit 内部有 20+ 个 return 分支，
		 * 常驻 toast（turnLoading/autoLoadEarlier/autoLoadPartial）在异常/提前返回
		 * 的支路上会残留。用 try/finally 统一收口：token 仍是最新则收 toast；
		 * 已被更新的一轮顶替则交给那一轮管。
		 */
		async function locateHit(ctx, hit, words, locateMode, rawPattern) {
			var token = locateSeq + 1;
			try {
				return await locateHitInner(ctx, hit, words, locateMode, rawPattern);
			} finally {
				if (token === locateSeq) hideToast();
			}
		}
		async function locateHitInner(ctx, hit, words, locateMode, rawPattern) {
			var token = ++locateSeq;
			resetExpandMemo(); // 0.2.32：单次定位的展开去重从零开始（跨会话 turn 号会撞）
			var started = Date.now();
			var matchRow = makeRowMatcher(locateMode, rawPattern, words);
			// 命中原文指纹（0.2.10）：投影去标点后取前 120 个密集字符；过短不足以
			// 唯一定位（<16），置空走词匹配兜底。
			var hitFp = fingerprintKey(hit.text || "");
			if (hitFp.length < 16) hitFp = "";
			else if (hitFp.length > 120) hitFp = hitFp.slice(0, 120);
			locateResolve = function () {
				var byText = findHitRowDoc(matchRow, hitFp);
				if (byText) return byText;
				if (typeof hit.turn === "number") return findTurnRow(hit.turn, hit.type);
				return null;
			};
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
			dlog(
				"locate: target=" + hit.sessionId +
				" current=" + (currentId || "none") +
				" inClientList=" + inClientList +
				" workspace=" + (workspace && typeof workspace.openSession === "function" ? "ok" : "MISSING"),
			);
			if ((!currentId || currentId !== hit.sessionId) && workspace && typeof workspace.openSession === "function") {
				try {
					await workspace.openSession(hit.sessionId);
					dlog("openSession resolved (after " + (Date.now() - started) + "ms)");
				} catch (e) {
					dwarn("openSession failed", e);
					return { ok: false, reason: "open-failed" };
				}
			}
			// 0.2.38：释放上一轮装载的历史（设置可关）。pendingRelease 由翻页/
			// rail 装载置位；切走再切回让会话视图卸载重建、装载窗口重置回默认。
			// 0.4.0：智能释放——翻页装载置 "heavy"（必然大窗口）无条件释放；
			// rail 装载置 true，仅当前 flow 行数 >2500 才释放。小窗口的 turn 直达
			// 不再付 ~700ms 切走切回 + 视图重建税。
			if (pendingRelease && loadSettings().releaseBeforeLocate !== false) {
				var heavyRelease = pendingRelease === "heavy";
				var flowRowsNow = 0;
				try {
					var fl0 = pickFlow();
					if (fl0) flowRowsNow = fl0.querySelectorAll("[data-chat-flow-kind]").length;
				} catch (e) { /* 忽略 */ }
				if (heavyRelease || flowRowsNow > 2500) {
					pendingRelease = false;
					var released = await releaseLoadedHistory(ctx, hit.sessionId);
					dlog("release loaded history: " + (released ? "done (rows=" + flowRowsNow + ")" : "skipped (no other session)"));
				} else {
					dlog("release skipped: light rail window (rows=" + flowRowsNow + ")");
				}
			}
			// 2) 等待任一会话行渲染（0.2.3：页面上可能并存多个 [data-chat-flow] 容器，
			//    querySelector 第一个常是空/非活动容器——0.2.2 的定位因此全空转）。
			//    改为等「任一会话行渲染」，容器按含行数×可见性选取，行扫描全文档，
			//    滚动定位用从行向上溯的真滚动容器。
			var flow = null;
			var scroller = null;
			while (Date.now() - started < 4000) {
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				var probeRow = null;
				var hiddenProbe = null;
				var candidates = document.querySelectorAll("[data-chat-flow-kind]");
				for (var ci = 0; ci < candidates.length; ci++) {
					if (candidates[ci].getClientRects().length > 0) { probeRow = candidates[ci]; break; }
					if (!hiddenProbe) hiddenProbe = candidates[ci];
				}
				// 0.5.11：切换会话时旧容器可能尚未卸载（getClientRects 为空）——优先等可见
				// 容器，1.2s 后仍只有不可见行才接受残留，避免在旧视图里扫描和高亮。
				if (!probeRow && hiddenProbe && Date.now() - started > 1200) probeRow = hiddenProbe;
				if (probeRow) {
					flow = pickFlow() || probeRow.closest("[data-chat-flow]") || probeRow.parentElement;
					// 0.2.7：滚动容器必须与选中的 flow 同源——从 flow 内的行/flow 本身
					// 向上做「实测验证」找真滚动容器，避免抓到嵌套/陈旧视图的容器。
					var inFlowRow = flow && flow.querySelector ? flow.querySelector("[data-chat-flow-kind]") : null;
					scroller = findRealScroller(inFlowRow || flow) || scrollerOf(inFlowRow || probeRow) || flow;
					break;
				}
				await sleep(120);
			}
			if (!flow) return { ok: false, reason: "no-flow" };
			dlog("locate hit=" + hit.sessionId + "#" + hit.seq
				+ " type=" + (hit.type || "?") + " fraction=" + (typeof hit.seqFraction === "number" ? hit.seqFraction.toFixed(3) : "MISSING")
				+ " turn=" + (typeof hit.turn === "number" ? hit.turn : "MISSING")
				+ " flowRows=" + (flow ? flow.querySelectorAll("[data-chat-flow-kind]").length : -1)
				+ " scroller=" + (scroller ? scroller.tagName + "." + String(scroller.className || "").split(" ")[0] : "null"));
			dlog("flow ready (after " + (Date.now() - started) + "ms), scanning");

			// 3a) 0.3.0：视口快查——目标行已在当前窗口时零滚动直达。旧实现先滚
			//     比例落点再扫描，可见目标反被滚走（「乱跳」感知来源之一）。
			//     0.4.0：文本匹配未中但目标回合的行可见时，回合锚定直接命中
			//    （渲染差异不再影响「就在眼前」的目标）。
			var immediate = findHitRowDoc(matchRow, hitFp);
			if (!immediate && typeof hit.turn === "number") {
				immediate = findTurnRow(hit.turn, hit.type);
				if (immediate) dlog("viewport hit via turn-anchor (turn " + hit.turn + ", no scroll)");
			}
			if (token !== locateSeq) return { ok: false, reason: "superseded" };
			if (immediate) {
				dlog("located in current viewport (no scroll)");
				highlightRow(immediate);
				return { ok: true };
			}

			// 3b) 0.3.0：turn 直达——宿主半已按 (seq→turn/start) 映射给出精确
			//     hit.turn（seq 二分所属回合）。rail 含该 mark 时一次点击即宿主
			//     原生 navigateToTurn → loadThrough(seq) 一程装载（无裁剪），
			//     替代 0.2.37 的「比例估 mark + 分程修正」。mark 不存在（outline
			//     缺段）或点击未命中 → 落到下方比例落点/分程/翻页兜底。
			var turnDirectTried = false;
			if (typeof hit.turn !== "number") {
				dlog("turn-direct skipped: hit.turn MISSING"
					+ " — hit.turn 缺失（宿主半过旧或该会话日志无 turn/start）— 走估算+rail 兜底");
			} else if (scroller) {
				// 0.4.3：原生跳转补丁优先——window.__DSH_CSEARCH_JUMP__ 由 asar
				// 定点注入提供（合成 rail item 走宿主 navigateToTurn：loadThrough
				// → reconcile 续装 → scrollToTurn 精确落地），不依赖 rail/outline。
				// hook 不存在（未打补丁/破坏性升级）→ 静默落到下方 mark 点击路径。
				var nativeJump = null;
				try { nativeJump = (typeof window !== "undefined" && window.__DSH_CSEARCH_JUMP__) || null; } catch (e) { nativeJump = null; }
				if (typeof nativeJump === "function") {
					turnDirectTried = true;
					var jr = null;
					try { jr = nativeJump(hit.turn, hit.seq); } catch (e0) { jr = { ok: false, reason: String(e0 && e0.message || e0) }; }
					if (jr && jr.ok) {
						pendingRelease = true; // 宿主 loadThrough 已装载历史，下次定位先释放
						showToast(t("turnLoading", { turn: hit.turn }), true);
						dlog("native jump accepted: turn=" + hit.turn + " seq=" + hit.seq);
						var njDeadline = Date.now() + 30000;
						var njCalm = 0;
						var njTopPrev = -1;
						while (Date.now() < njDeadline) {
							await sleep(250);
							if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
							if (!scroller.isConnected) break;
							var rowN = findHitRowDoc(matchRow, hitFp) || findTurnRow(hit.turn, hit.type);
							if (rowN) {
								hideToast();
								dlog("located via native jump (turn " + hit.turn + ", " + (Date.now() - started) + "ms)");
								highlightRow(rowN);
								return { ok: true };
							}
							// 宿主落地后滚动会静止；连续静止仍未见行 = 落点渲染差异
							// （KaTeX/折叠），不再空等满 30s。
							var njTop = scroller.scrollTop;
							if (njTop === njTopPrev) { njCalm++; } else { njCalm = 0; njTopPrev = njTop; }
							if (njCalm >= 12) break; // ~3s 滚动静止
						}
						hideToast();
						// 宿主已把视图跳到正确回合——接受 approximate，绝不落比例
						// 落点（正确回合被估算再滚走 = 乱跳来源）。
						dlog("native jump landed on turn " + hit.turn + " but row unmatched — accept approximate, " + (Date.now() - started) + "ms");
						return { ok: true, approximate: true };
					}
					dlog("native jump rejected: " + (jr && jr.reason) + " — 落到 rail mark 路径");
				}
				var railD = railMarks();
				var markD = null;
				for (var dm = 0; dm < railD.length; dm++) {
					if (railD[dm].turn === hit.turn) { markD = railD[dm]; break; }
				}
				if (!markD) {
					dlog("turn-direct skipped: turn " + hit.turn
						+ " not in rail (" + railD.length + " marks) — outline 缺段，走兜底");
				}
				if (markD) {
					turnDirectTried = true;
					dlog("turn-direct: turn=" + hit.turn
						+ " turnSeq=" + (typeof hit.turnSeq === "number" ? hit.turnSeq : "?") + " marks=" + railD.length);
					// 0.4.1：远回合 loadThrough 单次装载千级事件（10–30s），给明确预期。
					showToast(t("turnLoading", { turn: hit.turn }), true);
					try { markD.el.click(); pendingRelease = true; } catch (e) { /* 点击失败走兜底 */ }
					var calmD = 0;
					var topPrevD = scroller.scrollTop;
					// 0.4.1：预算 12s→30s——装载中的定位不该被误杀（aria-busy 期间
					// 不计 calm 的既有逻辑保证不空转，预算只是上限）。
					var directDeadline = Date.now() + 30000;
					while (Date.now() < directDeadline) {
						await sleep(250);
						if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
						if (!scroller.isConnected) break;
						var foundD = findHitRowDoc(matchRow, hitFp);
						if (foundD) {
							hideToast();
							dlog("located via turn-direct fingerprint/word (turn " + hit.turn + ", " + (Date.now() - started) + "ms)");
							highlightRow(foundD);
							return { ok: true };
						}
						// 0.4.0：回合锚定——文本匹配失败（KaTeX/Markdown 渲染差异）不放弃：
						// 命中回合的行只要渲染出来就直接接受（行归属由宿主日志映射保证）。
						var anchoredD = findTurnRow(hit.turn, hit.type);
						if (anchoredD) {
							hideToast();
							dlog("located via turn-anchored row (turn " + hit.turn + ", " + (Date.now() - started) + "ms)");
							highlightRow(anchoredD);
							return { ok: true };
						}
						// 0.4.0：宿主装载会重建 rail——mark 元素失联时按 turn 号重找，
						// 避免 aria-busy 判断落空导致 calm 永远不成立、空转到超时。
						if (!markD.el.isConnected) {
							var railR = railMarks();
							markD = null;
							for (var rr = 0; rr < railR.length; rr++) {
								if (railR[rr].turn === hit.turn) { markD = railR[rr]; break; }
							}
							if (!markD) break;
						}
						var busyD = markD.el.getAttribute("aria-busy") === "true";
						var topNowD = scroller.scrollTop;
						if (!busyD && topNowD === topPrevD) calmD++;
						else calmD = 0;
						topPrevD = topNowD;
						if (calmD >= 3) break;
					}
					// 0.4.0：turn-direct 终态化。宿主确认已跳到目标回合（active mark =
					// hit.turn）而文本仍未中 → 视口 ±1 屏再扫，仍未中就接受 approximate
					// ——绝不落 3c 比例落点（正确回合被 fraction 估算再滚走 = 乱跳来源）。
					var activeD = activeRailTurn();
					if (activeD === hit.turn) {
						var anchoredEnd = findTurnRow(hit.turn, hit.type) || findHitRowDoc(matchRow, hitFp);
						if (!anchoredEnd) {
							var spanD = scroller.scrollHeight - scroller.clientHeight;
							for (var nd = 0; nd < 4 && !anchoredEnd; nd++) {
								var dirD = nd < 2 ? 1 : -1;
								try { scroller.scrollTop = Math.max(0, Math.min(spanD, scroller.scrollTop + dirD * scroller.clientHeight)); } catch (e) { break; }
								await sleep(280);
								if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
								anchoredEnd = findTurnRow(hit.turn, hit.type) || findHitRowDoc(matchRow, hitFp);
							}
						}
						hideToast();
						if (anchoredEnd) {
							dlog("located via turn-anchor nudge (turn " + hit.turn + ", " + (Date.now() - started) + "ms)");
							highlightRow(anchoredEnd);
							return { ok: true };
						}
						dlog("turn-direct landed on turn " + hit.turn + " but row unmatched — accept approximate (no proportional fallback), " + (Date.now() - started) + "ms");
						return { ok: true, approximate: true };
					}
					hideToast();
					dlog("turn-direct missed (active=" + activeD + "), falling back");
				}
			}

			// 3c) 比例落点（0.2.7）：直接按「滚动区间 × seqFraction」落点后扫描一次。
			//     0.2.6 的 data-index 节点推导在本机构建下不成立——
			//     跳底后 max(data-index)+1=35（虚拟窗口内索引，非全局行号），
			//     「fraction × 总节点数」的整段数学失真，故放弃节点推导。
			//     0.3.0：删 ±2 屏邻域循环（来回滚多屏在用户眼里就是「乱跳」，
			//     且 turn 直达未中时邻域大概率同样未中）——未中直接进兜底链。
			//     0.4.0：只有 turn 直达未参与（无 turn / rail 缺 mark / 点击后宿主
			//     未跳转）才会到这里；确认落在目标回合的路径已在 3b 终态返回。
			if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
				var span = scroller.scrollHeight - scroller.clientHeight;
				var fraction = typeof hit.seqFraction === "number" ? Math.min(1, Math.max(0, hit.seqFraction)) : 0.5;
				var targetTop = Math.max(0, Math.min(span, fraction * span - scroller.clientHeight * 0.4));
				dlog("proportional locate: fraction=" + fraction.toFixed(3)
					+ " span=" + Math.round(span) + " scrollTop->" + Math.round(targetTop));
				try { scroller.scrollTop = targetTop; } catch (e) { /* 忽略 */ }
				await sleep(260);
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				if (Math.abs(scroller.scrollTop - targetTop) > 4 && scroller.parentElement) {
					// 赋值没生效：该元素不是真滚动容器 → 沿祖先找真正会动的那个。
					var alt = findRealScroller(scroller.parentElement);
					if (alt && alt !== scroller) {
						dlog("scroller fallback: "
							+ scroller.tagName + "." + String(scroller.className || "").split(" ")[0]
							+ " -> " + alt.tagName + "." + String(alt.className || "").split(" ")[0]);
						scroller = alt;
						span = scroller.scrollHeight - scroller.clientHeight;
						targetTop = Math.max(0, Math.min(span, fraction * span - scroller.clientHeight * 0.4));
						try { scroller.scrollTop = targetTop; } catch (e) { /* 忽略 */ }
						await sleep(260);
						if (token !== locateSeq) return { ok: false, reason: "superseded" };
					}
				}
				var foundRow = findHitRowDoc(matchRow, hitFp);
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				if (foundRow) { highlightRow(foundRow); return { ok: true }; }
			}

			// 4) 兜底（0.2.8）：目标比已加载窗口更老时，DOM 里根本没有目标行。
			//    0.2.21：改为直接点宿主的「加载更早」按钮（asar 实证
			//    scroll.loadEarlier = cancel+beginPaging+pauseFollowing+loadOlder，
			//    是宿主自己的分页触发器，比滚到顶可靠；按钮 disabled = 正在加载）。
			//    每页载入后立即扫描，全程 toast 提示进度。0.2.13：预算 25s、
			//    停滞 7.5s（深处历史要翻几十页，太早放弃会「不命中早期对话」）。
			// 0.2.28：历史已全部加载的会话（此前定位翻完过页，宿主 hasMore=false 且
			// 已加载内容仍保留在 store）——跳过整个翻页循环，直接走终局全量扫描。
			// 第二次定位同一会话：60s 翻页 → 几秒扫描。首次定位照旧翻页。
			var fullHistoryReady = false;
			if (scroller) {
				try { fullHistoryReady = !findLoadOlderButton(); } catch (e) { fullHistoryReady = false; }
			}
			// 0.2.37：宿主回合大纲 rail 导航——不动宿主的「装载并跳转」通道。
			// rail 是全量 known turn 的固定间距 mark 列表（含未装载回合，asar :3851
			// 「unloaded marks page history in first」）。点击未装载 mark：宿主原生
			// navigateToTurn → request(jump{turn,seq})（:4105-4127）按 outline seq
			// 精确装载并落地——带宿主自己的分页背压，远快于插件逐页点「加载更早」。
			// 目标 turn 以 seqFraction 在 mark 序列上的比例估计（turn 与 seq 大体
			// 单调），点击后读 active mark 修正，≤3 轮；未中再走翻页+时间二分兜底。
			// 0.3.0：turn 直达已尝试且未中（mark 存在但落点没扫到行）→ 跳过分程
			//（分程会按比例估再点别的 mark，反而偏离已确认的目标回合）→ 直接翻页。
			// turn 缺失（旧宿主）或 rail 无该 mark → 0.2.37 比例估 + 分程修正保留。
			if (scroller && !turnDirectTried && typeof hit.seqFraction === "number") {
				var rail0 = railMarks();
				if (rail0.length >= 2) {
					dlog("rail navigate: marks=" + rail0.length + " fraction=" + hit.seqFraction.toFixed(3));
					var frac = Math.min(1, Math.max(0, hit.seqFraction));
					var wantIdx = frac * (rail0.length - 1);
					// 0.2.38：分程导航。loadThrough 一次性装到目标 seq，超远目标单程
					// 装载上千事件 = 假死峰值；每程最多走 rail 的 35%，落地后用 active
					// mark 校准再走下一程（≤4 程）。首程从当前 active mark 出发
					//（读不到才直接点比例位置）。
					var maxStep = Math.max(2, Math.floor(rail0.length * 0.35));
					var railIdx = -1;
					var startTurn0 = activeRailTurn();
					if (startTurn0 !== null) {
						for (var st0 = 0; st0 < rail0.length; st0++) {
							if (rail0[st0].turn === startTurn0) { railIdx = st0; break; }
						}
					}
					if (railIdx < 0) railIdx = Math.round(wantIdx);
					else {
						var firstDelta = Math.round(wantIdx - railIdx);
						if (Math.abs(firstDelta) > maxStep) firstDelta = firstDelta > 0 ? maxStep : -maxStep;
						railIdx = railIdx + firstDelta;
					}
					for (var ra = 0; ra < 2; ra++) {
						if (token !== locateSeq) return { ok: false, reason: "superseded" };
						if (Date.now() - started > 30000) break;
						var rail2 = railMarks(); // 宿主装载会重建 mark 元素：按 turn 号重找
						if (rail2.length < 2) break;
						var wantTurn = rail0[Math.max(0, Math.min(rail0.length - 1, railIdx))].turn;
						var mark = null;
						for (var rm = 0; rm < rail2.length; rm++) {
							if (rail2[rm].turn === wantTurn) { mark = rail2[rm]; break; }
						}
						if (!mark) mark = rail2[Math.max(0, Math.min(rail2.length - 1, Math.round(frac * (rail2.length - 1))))];
						try { mark.el.click(); pendingRelease = true; } catch (e) { break; }
						// 等宿主装载落地并轮询扫描（≤8s）。aria-busy=装载中（:3618）；
						// 落地后视口稳定（scrollTop 连续 3 轮不变）即撤，目标不在此窗口。
						var calm = 0;
						var topPrev = scroller.scrollTop;
						var railDeadline = Date.now() + 6000;
						while (Date.now() < railDeadline) {
							await sleep(250);
							if (token !== locateSeq) return { ok: false, reason: "superseded" };
							if (!scroller.isConnected) break;
							// 0.4.0：装载窗口若已包含目标回合的行，回合锚定直接接受。
							var foundR = findHitRowDoc(matchRow, hitFp) || findTurnRow(hit.turn, hit.type);
							if (foundR) {
								dlog("located via turn rail (turn " + wantTurn + ", " + (Date.now() - started) + "ms)");
								highlightRow(foundR);
								return { ok: true };
							}
							var busyNow = mark.el.getAttribute("aria-busy") === "true" || !mark.el.isConnected;
							var topNow = scroller.scrollTop;
							if (!busyNow && topNow === topPrev) calm++;
							else calm = 0;
							topPrev = topNow;
							if (calm >= 3) break;
						}
						var activeTurn = activeRailTurn();
						if (activeTurn === null) break;
						var ai = -1;
						for (var ra2 = 0; ra2 < rail2.length; ra2++) {
							if (rail2[ra2].turn === activeTurn) { ai = ra2; break; }
						}
						if (ai < 0) break;
						var delta = Math.round(wantIdx - ai);
						if (delta === 0) break; // 比例位置恰好激活仍未中：交给翻页/时间二分兜底
						var maxStep2 = Math.max(2, Math.floor(rail2.length * 0.35));
						if (Math.abs(delta) > maxStep2) delta = delta > 0 ? maxStep2 : -maxStep2;
						railIdx = ai + delta;
					}
				}
			}
			if (scroller && !fullHistoryReady) {
				try { scroller.scrollTop = 0; } catch (e) { /* 忽略 */ }
				var lastHeight = scroller.scrollHeight;
				var stalls = 0;
				var pages = 0;
				// 0.2.27：预算可在面板设置区自定义（localStorage，15–120s，0.2.34 起默认 80s）。
				var pagingStarted = Date.now();
				var pagingDeadline = pagingStarted + loadSettings().autoLoadBudgetSeconds * 1000;
				// 0.2.29：单次定位的翻页上限。连续翻几十页会让宿主持续重渲染
				// Markdown 行（每行 5–50ms）+ 插件滚动扫描，主线程打满 → 心跳超时
				// → DSH 假死断连。改为「单次 ≤30 页，未到目标提示再次点击继续」：
				// 已加载内容保留在 store，下次定位从断点续翻，成本分摊到多次点击。
				// 0.2.35：单次上限 30→15 页——用户实测 30 页（约上千事件装载）仍会
				// 触发 DSH 假死重连（第 4 次）。装载负担减半，到达率靠「再次点击
				// 续翻」补（已加载内容保留在 store，每次点击从断点续翻 15 页）。
				var MAX_AUTOLOAD_PAGES = 15;
				var stopReason = "";
				showToast(t("autoLoadEarlier"), true);
				while (Date.now() < pagingDeadline) {
					if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
					if (pages >= MAX_AUTOLOAD_PAGES) { stopReason = "maxPages"; break; }
					// 0.2.10：翻页期间 React 可能重建滚动容器——失联就重新定位
					//（旧实现全程持有开局 scroller，脱接后 scrollHeight 冻结、误判到顶，审查 P2）。
					if (!scroller || !scroller.isConnected) {
						var anchorRow = document.querySelector("[data-chat-flow-kind]");
						scroller = findRealScroller(anchorRow) || scrollerOf(anchorRow) || scroller;
						if (!scroller) break;
					}
					var row2 = null;
					if (pages % 2 === 0) {
						// 0.2.30：每轮全文档扫描 → 隔页扫——行数大时单次 30–100ms，
						// 翻页期间连续扫叠加宿主渲染加剧假死；浅层目标 2 页内必进 DOM。
						// 0.4.0：回合锚定并入（hit.turn 非数字时 findTurnRow 自返回 null）。
						row2 = findHitRowDoc(matchRow, hitFp) || findTurnRow(hit.turn, hit.type);
					}
					if (row2) {
						highlightRow(row2);
						hideToast();
						if (pages > 0) showToast(t("autoLoadDone"), false);
						return { ok: true };
					}
					var olderBtn = findLoadOlderButton();
					if (olderBtn && !olderBtn.disabled) {
						try { olderBtn.click(); pages += 1; pendingRelease = "heavy"; } catch (e) { /* 点击失败退化为等待高度变化 */ }
						// 0.2.27：自适应等待——每 80ms 查一次高度/按钮，新页渲染完立即翻
						// 下一页，替代固定 280ms 空转；翻页节奏由宿主每页耗时决定，
						// 插件侧不再垫固定时间（约 2–3 倍提速，页越大提速越明显）。
						var waited = 0;
						while (waited < 3000) {
							// 0.2.30：80→150ms——每轮 scrollHeight/getClientRects 都是
							// 强制同步布局，宿主每页渲染期间高频轮询火上浇油。
							await sleep(150); waited += 150;
							if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
							if (!scroller.isConnected) break;
							if (scroller.scrollHeight !== lastHeight) break; // 新页已进 DOM
							var btn2 = findLoadOlderButton();
							if (btn2 && !btn2.disabled) break; // 宿主已就绪（加载极快或已到顶）
						}
					} else {
						await sleep(120); // 无按钮/正在加载：短轮询等状态变化
					}
					if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
					var grew = scroller.scrollHeight !== lastHeight;
					if (grew) {
						stalls = 0;
						lastHeight = scroller.scrollHeight;
					} else if (olderBtn) {
						// 0.2.25：按钮存在（含 disabled=正在加载）= 宿主确认还有更多内容，
						// 高度暂时不变只是这一页加载慢——不算停滞（大历史单页 >7.5s 会
						// 被旧判定误判「到顶」提前放弃：自动加载了却定位失败的直接原因之一）。
						stalls = 0;
					} else {
						stalls += 1;
						if (stalls >= 10) { stopReason = "loadedAll"; break; } // 按钮已消失仍无高度变化：已到最早内容
					}
					if (pages > 0) showToast(t("autoLoadEarlier") + " · " + pages + " · " + Math.max(0, Math.ceil((pagingDeadline - Date.now()) / 1000)) + "s", true);
				}
				hideToast();
				dlog("autoload end: pages=" + pages + " stalls=" + stalls +
					" elapsed=" + (Date.now() - pagingStarted) + "ms" +
					" scrollH=" + (scroller ? scroller.scrollHeight : -1) + " top=" + (scroller ? Math.round(scroller.scrollTop) : -1));
				// 0.2.30：终局「低滚动」检查。旧的全量步进扫描（0.2.26/0.2.28）会强迫
				// 宿主渲染整个已加载历史——每跳一屏渲染一窗 Markdown 行（100ms+），
				// 几十屏就是数秒到数十秒连续主线程占用 = 超时后假死断连的元凶。
				// 改为：比例估算落点一次 + ±5 屏双向扩展（每屏 300ms 喘息），找不到
				// 就停在估算位置打「≈」标，引导再次点击续翻（把渲染成本分摊到多次）。
				if (scroller && (fullHistoryReady || pages > 0)) {
					var found4 = null;
					// 0.2.33：时间校准二分。0.2.30 的估算落点 ±5 屏已删——能进终局的命中
					// 都在已加载窗口之外（窗口内的早被比例/邻域阶段命中），折叠压缩让
					// fraction×span 对它们必偏几十屏，±5 屏纯浪费 3–5s。改用行内时间标签
					// 导航：读当前窗口可见行的时间范围，向目标时间方向跳（步长加倍/减半），
					// 窗口覆盖目标时间后细扫。每步一窗渲染 + 250ms 喘息，≤12 步，远小于
					// 全量扫描（几十窗）；加载完全部历史后目标行必然能被导航到。
					if (hit.time) {
						var targetMs = new Date(hit.time).getTime();
						if (!isNaN(targetMs)) {
							var nowYear = new Date().getFullYear();
							var calStep = 6; // 0.2.33：初值 4→6，大跨度会话更快进入目标邻域
							var calDir = 0; // -1 向上（更早） 1 向下（更晚） 0 未知
							var calDeadline = Date.now() + 10000;
							for (var ci = 0; ci < 12 && !found4 && Date.now() < calDeadline; ci++) {
								if (token !== locateSeq) return { ok: false, reason: "superseded" };
								var minT = Infinity, maxT = -Infinity;
								var cRows = scroller.querySelectorAll("[data-chat-flow-kind]");
								for (var cj = 0; cj < cRows.length; cj++) {
									if (!rowInViewport(cRows[cj])) continue; // 0.2.36：只采视口内行的时间
									var cts = parseRowClock(rowText(cRows[cj]), nowYear);
									if (!isNaN(cts)) {
										if (cts < minT) minT = cts;
										if (cts > maxT) maxT = cts;
									}
								}
								if (maxT === -Infinity) {
									if (calDir === 0) break; // 无样本且无方向：放弃二分
								} else if (targetMs >= minT && targetMs <= maxT) {
									// 目标时间已落进当前窗口：细扫 + 上下各 1 屏
									found4 = findHitRowDoc(matchRow, hitFp) || findTurnRow(hit.turn, hit.type);
									for (var ck = 1; ck <= 2 && !found4; ck++) {
										var spanC = scroller.scrollHeight - scroller.clientHeight;
										try { scroller.scrollTop = Math.max(0, Math.min(spanC, scroller.scrollTop + (ck === 1 ? 1 : -1) * scroller.clientHeight)); } catch (e) { /* 忽略 */ }
										await sleep(300);
										if (token !== locateSeq) return { ok: false, reason: "superseded" };
										found4 = findHitRowDoc(matchRow, hitFp) || findTurnRow(hit.turn, hit.type);
									}
									break;
								} else {
									var wantDir = targetMs < minT ? -1 : 1;
									if (calDir !== 0 && wantDir !== calDir) calStep = Math.max(1, Math.floor(calStep / 2));
									else if (calDir === wantDir) calStep = Math.min(12, calStep * 2);
									calDir = wantDir;
									var spanC2 = scroller.scrollHeight - scroller.clientHeight;
									try { scroller.scrollTop = Math.max(0, Math.min(spanC2, scroller.scrollTop + calDir * calStep * scroller.clientHeight)); } catch (e) { break; }
								}
								await sleep(300);
							}
							if (found4) dlog("located via time-calibrated bisect");
						}
					}
					// 0.2.32：自动展开折叠上下文（用户设置可关）。二分把窗口带到附近仍没
					// 命中——目标可能藏在你收起的步骤组或宿主摘要条里（手动折叠的行在
					// DOM 但 display:none，findHitRowDoc 只收可见行）。展开视口附近的
					// 折叠控件 → 轮询重扫（大折叠组渲染慢，0.2.33 固定 350ms 改 3×400ms）。
					if (!found4 && loadSettings().expandFolded !== false) {
						var expandResult = expandFoldedNear();
						if (expandResult.clicked > 0) {
							for (var ew = 0; ew < 3 && !found4; ew++) {
								await sleep(400);
								if (token !== locateSeq) return { ok: false, reason: "superseded" };
								found4 = findHitRowDoc(matchRow, hitFp) || findTurnRow(hit.turn, hit.type);
							}
							if (found4) dlog("located after expanding " + expandResult.clicked + " folded block(s)");
						}
					}
					if (found4) {
						highlightRow(found4);
						showToast(t("autoLoadDone"), false);
						return { ok: true };
					}
				}
				if (stopReason === "loadedAll" || fullHistoryReady) showToast(t("autoLoadEmpty"), false);
				else if (stopReason === "maxPages") showToast(t("autoLoadPartial", { pages: pages }), true);
				else showToast(t("autoLoadTimeout"), false);
			}
			// 5) 全部未中：留在比例估算位置（0.2.3 起不回弹——tool/* 行渲染折叠摘要、
			//    参数 JSON 不在行文本里，文本匹配必失败；回弹让用户觉得完全没跳）。
			if (scroller && !scroller.isConnected) {
				// 0.2.10：翻页可能重建了滚动容器，收尾前重新定位（审查 P2）。
				scroller = findRealScroller(document.querySelector("[data-chat-flow-kind]")) || scroller;
			}
			if (scroller) {
				var frac = typeof hit.seqFraction === "number" ? Math.min(1, Math.max(0, hit.seqFraction)) : null;
				if (frac !== null) {
					try {
						var span2 = scroller.scrollHeight - scroller.clientHeight;
						scroller.scrollTop = Math.max(0, Math.min(span2, frac * span2 - scroller.clientHeight / 2));
					} catch (e) { /* 忽略 */ }
					await sleep(260);
					if (token !== locateSeq) return { ok: false, reason: "superseded" };
					// 0.2.22：停在估算位置后再扫一遍——翻页可能已把目标页载入，
					// 估算位置常与目标同屏，这里兜住「加载到了但循环里没扫到」的收尾。
					var row5 = findHitRowDoc(matchRow, hitFp) || findTurnRow(hit.turn, hit.type);
					if (row5) {
						highlightRow(row5);
						showToast(t("autoLoadDone"), false);
						dlog("located at final estimate position");
						return { ok: true };
					}
					dlog("locate: positioned by fraction (row not matched by fingerprint/word — approximate)");
					return { ok: true, approximate: true };
				}
			}
			dlog("locate gave up after " + (Date.now() - started) + "ms");
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
			var setOpenRaw = openState[1];
			// 0.2.10：组件内关闭（Esc/遮罩点击）同步回 holder——否则插槽重挂载时
			// holder.open 仍为 true，面板会意外自动弹出（审查 P3）。
			var setOpen = function (value) {
				holder.open = value === true;
				setOpenRaw(value);
			};

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

			// 0.5.2：默认搜索模式改为精确（只改初始默认，不做持久化——用户仍可临时切换）。
			var modeState = React.useState("exact");
			var mode = modeState[0];
			var setMode = modeState[1];

			// 0.2.27：设置（localStorage 持久化）+ 面板内设置区展开状态。
			var settingsState = React.useState(loadSettings());
			var settings = settingsState[0];
			var setSettings = settingsState[1];
			var expandState = React.useState(loadSettings().expandFolded !== false);
			var releaseState = React.useState(loadSettings().releaseBeforeLocate !== false);
			var expandFolded = expandState[0];
			var setExpandFolded = expandState[1];
			var setReleaseState = releaseState[1];
			var showSettingsState = React.useState(false);
			var showSettings = showSettingsState[0];
			var setShowSettings = showSettingsState[1];

			// 0.5.2：搜索请求用的开关快照（每次渲染同步；切换时同步改 ref 再重搜，
			// 避免 setState 未生效时用旧值发请求）。
			var includeInjectedRef = React.useRef(loadSettings().includeInjected === true);
			includeInjectedRef.current = settings.includeInjected === true;
			// 0.5.5：精确匹配的两个可选项快照（同上，切换时先改 ref 再重搜）。
			var caseSensitiveRef = React.useRef(loadSettings().caseSensitive === true);
			caseSensitiveRef.current = settings.caseSensitive === true;
			var wholeWordRef = React.useRef(loadSettings().wholeWord !== false);
			wholeWordRef.current = settings.wholeWord !== false;

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
			// 0.5.9（审查 C3）：一次只允许一个搜索在飞——「继续扫描」连点会并发
			// 追加同一 offset，命中重复且 scanned 抖动。
			var busyRef = React.useRef(false);
			var scannedOffsetRef = React.useRef(0);
			var resultRef = React.useRef(result);
			resultRef.current = result;
			// 0.5.3：结果列表分批渲染（旧实现一次渲染 500 行 + 每次搜索后做
			// O(hits×rows) 指纹探针，长会话明显卡顿）。
			var RENDER_PAGE = 120;
			var PROBE_MAX = 120;
			var renderLimitState = React.useState(RENDER_PAGE);
			var renderLimit = renderLimitState[0];
			var setRenderLimit = renderLimitState[1];
			// 0.2.14：「≈ 折叠区」标记表（key=sessionId#seq）+ 重渲染计数。
			// 定位只到大纲位置（approximate）的命中打标，精确命中清除；
			// 新一次搜索重置（标记只属于当前结果列表）。
			var approxRef = React.useRef({});
			var approxTickState = React.useState(0);
			var setApproxTick = approxTickState[1];

			// 0.5.7：面板可拖动（顶栏＝输入行，按住非按钮区域拖动）+ 右上角关闭按钮。
			// 位置不持久化：每次打开回到居中；拖动量只看本次会话内的 state。
			var panelRef = React.useRef(null);
			var dragOffsetState = React.useState({ x: 0, y: 0 });
			var dragOffset = dragOffsetState[0];
			var setDragOffset = dragOffsetState[1];
			var dragOffsetRef = React.useRef({ x: 0, y: 0 });
			dragOffsetRef.current = dragOffset;
			var dragRef = React.useRef({ active: false, moved: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });
			/** 把拖动量夹到视口内：面板默认贴顶（paddingTop 11vh）水平居中，这里按
			 * 面板尺寸与窗口尺寸算可行区间，避免拖出屏幕后再拖不回来。 */
			function clampDragOffset(x, y) {
				var el = panelRef.current;
				if (!el) return { x: x, y: y };
				var halfSlack = Math.max(0, (window.innerWidth - el.offsetWidth) / 2 - 8);
				var minY = -Math.max(0, window.innerHeight * 0.11 - 8);
				var maxY = Math.max(0, window.innerHeight - el.offsetHeight - 8) - Math.max(0, window.innerHeight * 0.11);
				return {
					x: Math.max(-halfSlack, Math.min(halfSlack, x)),
					y: Math.max(minY, Math.min(Math.max(minY, maxY), y)),
				};
			}
			function onTitleMouseDown(event) {
				if (event.button !== 0) return;
				var target = event.target;
				// 按钮/关闭键交给各自点击处理；输入框允许拖动（超过阈值才算拖，
				// 单击仍能聚焦）。
				if (target && target.closest && target.closest("button")) return;
				dragRef.current = {
					active: true, moved: false,
					startX: event.clientX, startY: event.clientY,
					baseX: dragOffsetRef.current.x, baseY: dragOffsetRef.current.y, blurred: false,
				};
			}
			function closePanel() {
				// 0.5.9：三处关闭（Esc / × / 遮罩）统一走这里——作废在飞的定位循环
				// 并收掉常驻 toast。旧实现只有 Esc 做了，点 × 或遮罩后滚动/加载
				// 链仍在跑，还会继续弹 toast（审查 C1）。
				locateSeq += 1;
				hideToast();
				setDragOffset({ x: 0, y: 0 });
				dragRef.current.active = false;
				setOpen(false);
			}
			React.useEffect(function () {
				function onMove(event) {
					var d = dragRef.current;
					if (!d.active) return;
					var dx = event.clientX - d.startX;
					var dy = event.clientY - d.startY;
					if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
					d.moved = true;
					try { window.getSelection().removeAllRanges(); } catch (e) { /* 无选区服务时忽略 */ }
					// 0.5.9（审查 C4）：真拖动时先失焦输入框——否则拖完松手仍把焦点留在
					// 输入框，后续打字会直接改查询词（用户以为在挪窗口）。
					if (!d.blurred) {
						d.blurred = true;
						try {
							var ae = document.activeElement;
							if (ae && ae !== document.body && typeof ae.blur === "function") ae.blur();
						} catch (e) { /* 无焦点服务时忽略 */ }
					}
					setDragOffset(clampDragOffset(d.baseX + dx, d.baseY + dy));
				}
				function onUp() {
					var d = dragRef.current;
					if (!d.active) return;
					d.active = false;
					document.body.style.userSelect = "";
				}
				// 0.5.9（审查 C4）：窗口尺寸变化后把已偏移的面板夹回可见区
				// （旧实现只在拖动时 clamp，改窗口尺寸后面板可能整个跑到屏外）。
				function onResize() {
					if (!panelRef.current) return;
					setDragOffset(function (cur) { return clampDragOffset(cur.x, cur.y); });
				}
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				window.addEventListener("resize", onResize);
				return function () {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
					window.removeEventListener("resize", onResize);
					document.body.style.userSelect = "";
				};
			}, []);

			// 外部 holder（快捷键）→ 组件状态同步。
			React.useEffect(function () {
				var listener = function (value) { setOpen(value); };
				holder.listeners.add(listener);
				// 0.2.10：卸载时收掉常驻 toast 并复位 holder.open（审查 P3）。
				return function () {
					holder.listeners.delete(listener);
					hideToast();
					holder.open = false;
				};
			}, []);

			// 0.5.7：位置不持久化——每次打开都从居中位置开始。
			React.useEffect(function () {
				if (open) setDragOffset({ x: 0, y: 0 });
			}, [open]);

			// Esc 关闭（capture；仅在面板打开时拦截）。
			React.useEffect(function () {
				if (!open) return;
				var onKey = function (event) {
					if (event.key === "Escape") {
						event.stopPropagation();
						// 0.5.9：与 × / 遮罩同一条关闭路径（作废定位 + 收 toast）。
						closePanel();
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
				// 0.5.9（审查 C3）：一次只允许一个搜索在飞——「继续扫描」连点会并发追加
				// 同一 offset。必须在递增 searchSeq 之前拦截：否则被拦下的点击会把
				// 在飞请求的 seq 顶掉，那次结果回来后被丢弃，面板永远停在「搜索中…」。
				if (busyRef.current) return;
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
				// 0.5.3：新搜索作废一切在飞的定位循环（旧实现 Esc/新搜索都不递增
				// locateSeq，滚动循环无法取消）。
				locateSeq += 1;
				busyRef.current = true;
				setStatus({ kind: "loading", text: t("searching") });
				var sessionId = rawScope === "current" ? currentSessionId(ctx) : undefined;
				if (rawScope === "current" && !sessionId) {
					setStatus({ kind: "error", text: t("noResults") });
					return;
				}
				withTimeout(callRemote(holder.getSearchSvc(), "search", {
					query: rawQuery.trim().slice(0, 200),
					scope: rawScope,
					sessionId: sessionId,
					limit: 500,
					offset: offset || 0,
					mode: rawMode,
					exact: rawMode === "exact",
					includeInjected: includeInjectedRef.current === true,
					caseSensitive: caseSensitiveRef.current === true,
					wholeWord: wholeWordRef.current !== false,
				}), RPC_TIMEOUT_MS, "search").then(function (value) {
					if (seq !== searchSeqRef.current) return;
					var pageHits = (value.hits || []).map(function (hitItem) {
						// 0.2.10：命中自带搜索参数快照——定位用命中当时的 mode/正则，
						// 不用当前输入框的（正则模式下点旧结果会用新正则错配，审查 P2）。
						return Object.assign({}, hitItem, { words: words, hitMode: rawMode, hitPattern: rawQuery.trim().slice(0, 200) });
					});
					// 0.5.3：「继续扫描」改为追加。旧实现用新页整体替换，第一页命中
					// 会从列表消失；offset 也按命中条数推进（宿主 offset 是 kept 数组
					// 切片，与 scanned 无关）。
					var isAppend = (offset || 0) > 0;
					var hits = pageHits;
					if (isAppend) {
						// 0.5.9（审查 C3）：宿主 offset 按命中条数切片，并发/重试时同一批
						// 命中会被追加两次——按 sessionId#seq 去重。
						var seenKeys = {};
						var oldHits = resultRef.current.hits || [];
						for (var oi = 0; oi < oldHits.length; oi++) seenKeys[oldHits[oi].sessionId + "#" + oldHits[oi].seq] = true;
						var appended = [];
						for (var pi2 = 0; pi2 < pageHits.length; pi2++) {
							var key2 = pageHits[pi2].sessionId + "#" + pageHits[pi2].seq;
							if (seenKeys[key2]) continue;
							seenKeys[key2] = true;
							appended.push(pageHits[pi2]);
						}
						hits = oldHits.concat(appended);
					}
					scannedOffsetRef.current = (offset || 0) + pageHits.length;
					var next = {
						hits: hits,
						scanned: value.scanned || 0,
						truncated: isAppend && pageHits.length === 0 ? false : !!value.truncated,
						elapsedMs: value.elapsedMs || 0,
						searchQuery: rawQuery.trim(),
						searchMode: rawMode,
						searchScope: rawScope,
					};
					approxRef.current = {};
					setResult(next);
					if (!isAppend) setRenderLimit(RENDER_PAGE);
					if (!isAppend) setSelected(hits.length > 0 ? 0 : -1);
					// 0.2.15：搜索即预判「≈ 折叠区」（只读探针，下一帧跑，不滚动不点击）。
					// 实际定位结果会覆盖预判：精确命中清标、approximate 确保打标。
					// 0.5.3：探针只跑前 PROBE_MAX 条（O(hits×rows) 指纹比对，500 条
					// × 上千行会让长会话明显卡顿）；超出部分靠定位时的实际结果打标。
					setTimeout(function () {
						if (seq !== searchSeqRef.current) return;
						var probeHits = next.hits.length > PROBE_MAX ? next.hits.slice(0, PROBE_MAX) : next.hits;
						var predicted = probeFoldedHits(ctx, probeHits, rawMode, rawQuery.trim().slice(0, 200), words);
						var keys = Object.keys(predicted);
						for (var pi = 0; pi < keys.length; pi++) approxRef.current[keys[pi]] = true;
						if (keys.length > 0) setApproxTick(function (v) { return v + 1; });
					}, 60);
					var label = t("scanned", { scanned: next.scanned, ms: next.elapsedMs });
					// 0.2.10：用宿主 truncated 真实信号，不再用 hits.length>=500 猜
					//（恰好 500 条真实命中会误报截断，审查 P3）。
					if (next.truncated) label += " " + t("moreHits", { limit: next.hits.length });
					if (rawMode === "exact") label += " · " + t("modeExact");
					else if (rawMode === "regex") label += " · " + t("modeRegex");
					label += " · v" + (value.hostVersion || "?");
					diagChannelProven = true; // search RPC 往返成功，诊断通道可用
					dlog("search ok: hits=" + next.hits.length + " scanned=" + next.scanned
						+ " ms=" + next.elapsedMs + " mode=" + rawMode
						+ " host=" + (value.hostVersion || "?") + " client=c" + CLIENT_VERSION);
					setStatus({ kind: next.hits.length === 0 ? "empty" : "done", text: label });
				}).catch(function (error) {
					if (seq !== searchSeqRef.current) return;
					dwarn("search failed", error);
					var raw = String(error && error.message ? error.message : error);
					var text = raw.indexOf("RPC_UNAVAILABLE") === 0
						? t("rpcUnavailable")
						: raw.indexOf("RPC_TIMEOUT") === 0
							? t("rpcTimeout")
							: raw;
					if (raw.indexOf("RPC_UNAVAILABLE") === 0 && holder.mountError) text += " · " + holder.mountError;
					setStatus({ kind: "error", text: text });
				}).then(function () {
					// 0.5.9：本轮结束（成功/失败都走这里）——释放 in-flight 闸门。
					busyRef.current = false;
					// 0.3.1：搜索失败等诊断也冲刷（RPC 不可用时静默跳过）。
					flushDiag(ctx);
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
				locateHit(ctx, hitItem, hitItem.words || queryWords(query), hitItem.hitMode || mode, hitItem.hitPattern || query).then(function (outcome) {
					if (outcome && outcome.ok) {
						// 0.2.14：命中落在折叠区（只到大纲位置）→ 打「≈ 折叠区」标，
						// 精确命中 → 清标；重开面板即可看到哪些命中在大致位置。
						var key = hitItem.sessionId + "#" + hitItem.seq;
						var changed = false;
						if (outcome.approximate) {
							if (!approxRef.current[key]) { approxRef.current[key] = true; changed = true; }
						} else if (approxRef.current[key]) {
							delete approxRef.current[key];
							changed = true;
						}
						if (changed) setApproxTick(function (v) { return v + 1; });
						return;
					}
					// 0.1.9：定位失败不再自动弹回面板（用户反馈被打扰），
					// 0.3.1 起诊断细节落盘 .diag.log，AI 直接读文件。
					dlog("locate failed:", outcome && outcome.reason);
				}).catch(function (error) {
					// 0.2.10：漏网异常不再成为 unhandled rejection（审查 P3）。
					dwarn("locate threw", error);
				}).then(function () {
					// 0.3.1：定位链路日志冲刷到宿主 .diag.log（无论成败都冲刷）。
					flushDiag(ctx);
				});
			};

			var onInputKeyDown = function (event) {
				// 0.5.3：中文输入法（及任何 IME）组字期间不劫持按键——旧实现下
				// 选词按 Enter 会 preventDefault 并触发搜索/跳转，↑↓ 也被吃掉。
				var composing = event.isComposing === true
					|| event.keyCode === 229
					|| (event.nativeEvent && event.nativeEvent.isComposing === true);
				if (composing) return;
				if (event.key === "Enter") {
					event.preventDefault();
					// 0.2.10：回车前清掉防抖定时器——320ms 窗口内回车会让延迟搜索
					// 再跑一次，重置选中行并清掉刚算好的折叠徽标（审查 P2）。
					if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
					var hits = resultRef.current.hits;
					// 0.5.3：结果必须与当前输入/模式/范围一致，否则回车要重新搜索。
					// 旧实现直接用旧 hits[selected] 跳转，新查询永远不发出。
					var fresh = resultRef.current.searchQuery === query.trim()
						&& resultRef.current.searchMode === mode
						&& resultRef.current.searchScope === scope;
					if (fresh && selected >= 0 && hits[selected]) locateSelected(hits[selected]);
					else { scannedOffsetRef.current = 0; runSearch(query, scope, 0, mode); }
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
			var busy = status.kind === "loading";
			var scopeCurrentId = currentSessionId(ctx);

			return h("div", {
				style: overlayStyle,
				// 0.5.9：遮罩点击同样走 closePanel（原来直接 setOpen(false)，
				// 在飞的定位循环与常驻 toast 都留了下来）。
				onMouseDown: function () { closePanel(); },
			}, h("div", {
				ref: panelRef,
				style: Object.assign({}, panelStyle, {
					transform: "translate(" + dragOffset.x + "px, " + dragOffset.y + "px)",
				}),
				onMouseDown: function (event) { event.stopPropagation(); },
			},
				// 输入行
				h("div", {
					style: Object.assign({}, inputRowStyle, { cursor: "move" }),
					onMouseDown: onTitleMouseDown,
				},
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
					// 0.5.7：右上角关闭（Esc / 点遮罩仍可用）。
					h("button", {
						style: closeBtnStyle,
						title: t("close"),
						onClick: closePanel,
					}, "×"),
				),
				// 状态行
				h("div", { style: statusBarStyle }, status.text),
				// 结果列表
				h("div", { style: resultListStyle },
					hits.length === 0
						? h("div", { style: { padding: "18px 14px", color: T.textTertiary, fontSize: "12px" } },
							status.kind === "loading" ? t("searching") : status.kind === "empty" || status.kind === "done" ? t("noResults") : "")
						: (function () {
							var rows = hits.slice(0, renderLimit);
							// 单行渲染（0.5.6）：meta 行 = 角色徽标 + 时间 + 折叠预判；
							// 会话标题只出现在分组头，行内不再重复。
							function renderRow(hitItem, index) {
								var time = formatTime(hitItem.time);
								var folded = approxRef.current[hitItem.sessionId + "#" + hitItem.seq];
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
										roleBadge(hitItem.type),
										time ? h("span", { style: { color: T.textTertiary, flex: "none" } }, time) : null,
										folded
											? h("span", {
												style: {
													flex: "none", marginLeft: "auto", padding: "0 6px",
													borderRadius: "8px", fontSize: "10px", lineHeight: "16px",
													color: "#e08a3c", border: "1px solid rgba(224,138,60,0.55)",
													background: "rgba(224,138,60,0.12)",
												},
												title: t("foldedApproxTip"),
											}, "≈ " + t("foldedApprox"))
											: null,
									),
									h("div", { style: hitSnippetStyle }, renderSnippet(windowSnippet(hitItem.snippet, hitItem.words || []), hitItem.words || [])),
								);
							}
							// 当前会话：无需会话名，直接平铺。
							if (scope !== "all") return rows.map(renderRow);
							// 全部会话：按会话分组（保持宿主下发的时间降序，组按首次出现排序）。
							var groups = [];
							var byId = {};
							rows.forEach(function (hitItem, index) {
								var key = hitItem.sessionId || "";
								if (!byId[key]) {
									byId[key] = { sessionId: key, title: hitItem.title || "", items: [] };
									groups.push(byId[key]);
								}
								byId[key].items.push({ hitItem: hitItem, index: index });
							});
							return groups.map(function (group, gi) {
								var groupTitle = group.title && group.title.length > 0 ? clipText(group.title, 60) : t("untitled");
								return h("div", { key: "group-" + group.sessionId + "-" + gi },
									h("div", { style: groupHeaderStyle },
										h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, groupTitle),
										h("span", { style: { flex: "none", color: T.textTertiary } }, t("groupCount", { n: group.items.length })),
									),
									group.items.map(function (row) { return renderRow(row.hitItem, row.index); }),
								);
							});
						})()
				),
				// 底栏（0.2.27：加 ⚙ 设置开关）
				h("div", { style: footerStyle },
					h("div", { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 } },
						h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t("hint") + " · c" + CLIENT_VERSION),
						h("button", {
							style: continueBtnStyle,
							title: t("settings"),
							onClick: function () { setShowSettings(function (v) { return !v; }); },
						}, "\u2699"),
					),
					hits.length > renderLimit
						? h("button", {
							style: continueBtnStyle,
							onClick: function () { setRenderLimit(renderLimit + RENDER_PAGE); },
						}, t("showMore") + " (" + (hits.length - renderLimit) + ")")
						: null,
					result.truncated
						? h("button", {
							style: continueBtnStyle,
							style: Object.assign({}, continueBtnStyle, busy ? { opacity: 0.5, cursor: "default" } : {}),
							onClick: function () { if (!busy) runSearch(query, scope, scannedOffsetRef.current, mode); },
						}, t("continueScan"))
						: null,
				),
				// 0.2.27：设置区（面板内折叠区块；保存即时生效，无需重启/刷新）
				showSettings ? h("div", {
					style: {
						padding: "10px 14px", borderTop: T.borderSoft,
						fontSize: "11px", color: T.textPrimary,
					},
				},
					h("div", { style: { marginBottom: "8px", fontWeight: "600", color: T.textTertiary } }, t("settings")),
					h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
						h("label", { style: { flex: "none" } }, t("autoLoadBudget")),
						h("input", {
							type: "number", min: 15, max: 120, step: 5,
							// 0.5.3：非受控 + 失焦/回车才提交。旧实现 value 受控且逐键 clamp：
							// 敲 "4" 立刻变 15、再敲 "5" 得 "155"→120，根本打不出 45；
							// 而且写回只带 autoLoadBudgetSeconds，把整份设置覆盖成只剩它。
							defaultValue: settings.autoLoadBudgetSeconds,
							key: "autoLoadBudget-" + settings.autoLoadBudgetSeconds,
							style: {
								width: "64px", padding: "2px 6px", fontSize: "11px",
								color: T.textPrimary, background: "transparent",
								border: T.borderSoft, borderRadius: "4px",
							},
							onKeyDown: function (event) {
								if (event.key === "Enter") { event.preventDefault(); event.target.blur(); }
							},
							onBlur: function (event) {
								var element = event.target;
								var seconds = parseInt(element.value, 10);
								if (isNaN(seconds)) { element.value = String(settings.autoLoadBudgetSeconds); return; }
								seconds = Math.max(15, Math.min(120, seconds));
								element.value = String(seconds);
								if (seconds === settings.autoLoadBudgetSeconds) return;
								// 合并写回：只改这一个字段，其余设置原样保留。
								var next = loadSettings();
								next.autoLoadBudgetSeconds = seconds;
								setSettings(next);
								saveSettings(next);
							},
						}),
						h("span", { style: { color: T.textTertiary, flex: "1 1 160px" } }, t("autoLoadBudgetHint")),
					),
					h("label", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", cursor: "pointer" } },
						h("input", {
							type: "checkbox",
							checked: expandFolded,
							onChange: function (event) {
								var next = loadSettings();
								next.expandFolded = event.target.checked === true;
								setExpandFolded(next.expandFolded);
								saveSettings(next);
							},
						}),
						h("span", { style: { color: T.textTertiary } }, t("expandFolded")),
					),
					h("label", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", cursor: "pointer" } },
						h("input", {
							type: "checkbox",
							checked: releaseState[0],
							onChange: function (event) {
								var next = loadSettings();
								next.releaseBeforeLocate = event.target.checked === true;
								setReleaseState(next.releaseBeforeLocate);
								saveSettings(next);
							},
						}),
						h("span", { style: { color: T.textTertiary } }, t("releaseBeforeLocate")),
					),
					h("label", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", cursor: "pointer" } },
						h("input", {
							type: "checkbox",
							checked: settings.includeInjected === true,
							onChange: function (event) {
								var next = loadSettings();
								next.includeInjected = event.target.checked === true;
								setSettings(next);
								saveSettings(next);
								// 开关即时生效：同步 ref 后按当前查询重搜（空查询不动）。
								includeInjectedRef.current = next.includeInjected;
								if (queryWords(query).length > 0 || mode === "regex") {
									runSearch(query, scope, 0, mode);
								}
							},
						}),
						h("span", { style: { color: T.textTertiary } }, t("includeInjected")),
					),
					h("div", { style: { margin: "4px 0 0 22px", color: T.textTertiary, fontSize: "10px", lineHeight: "1.5" } }, t("includeInjectedHint")),
					// 0.5.5：精确匹配的两个可选项（仅 mode === "exact" 生效；切换后立即重搜）。
					h("label", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", cursor: "pointer" } },
						h("input", {
							type: "checkbox",
							checked: settings.caseSensitive === true,
							onChange: function (event) {
								var next = loadSettings();
								next.caseSensitive = event.target.checked === true;
								setSettings(next);
								saveSettings(next);
								caseSensitiveRef.current = next.caseSensitive;
								if (mode === "exact" && queryWords(query).length > 0) runSearch(query, scope, 0, mode);
							},
						}),
						h("span", { style: { color: T.textTertiary } }, t("caseSensitive")),
					),
					h("div", { style: { margin: "4px 0 0 22px", color: T.textTertiary, fontSize: "10px", lineHeight: "1.5" } }, t("caseSensitiveHint")),
					h("label", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", cursor: "pointer" } },
						h("input", {
							type: "checkbox",
							checked: settings.wholeWord !== false,
							onChange: function (event) {
								var next = loadSettings();
								next.wholeWord = event.target.checked === true;
								setSettings(next);
								saveSettings(next);
								wholeWordRef.current = next.wholeWord;
								if (mode === "exact" && queryWords(query).length > 0) runSearch(query, scope, 0, mode);
							},
						}),
						h("span", { style: { color: T.textTertiary } }, t("wholeWord")),
					),
					h("div", { style: { margin: "4px 0 0 22px", color: T.textTertiary, fontSize: "10px", lineHeight: "1.5" } }, t("wholeWordHint")),
				) : null,
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
				{
					// 0.3.1：诊断回传（fire-and-forget，仅插件自身的日志行）。
					id: "dsh-conversation-search#conversationSearch/pushDiag",
					service: SEARCH_NS,
					namespace: SEARCH_NS,
					method: "pushDiag",
					invocation: { kind: "direct" },
					parameters: [clientParam("payload", "DiagPayload")],
					result: clientCodec("DiagResult"),
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
					// 0.3.1 教训：挂载期绝不能发起 RPC（flushDiag 也不行）——
					// web boot 期间网关握手未完成，挂起中的调用会拖住启动
					//（2026-10-13 12:01 两次 "entry did not activate" web-boot crash，
					// 用户被迫禁用插件）。诊断冲刷只发生在用户搜索/定位之后。
					ctx.effect(function () {
						return function () {
							try { disposeRemote(); } catch (e) { /* 已卸载 */ }
						};
					}, "conversation-search: remote contribution");
				} else {
					holder.mountError = "ctx.remote.$mount unavailable";
					dwarn("ctx.remote.$mount unavailable; search calls will fail until it appears");
				}
			} catch (error) {
				holder.mountError = String(error && error.message ? error.message : error);
				dwarn("remote mount failed:", error);
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
