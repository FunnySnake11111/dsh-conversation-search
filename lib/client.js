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
				looseTip: "宽松模式：仅用户/助手消息 · 大小写不敏感 · 空白弹性多词",
				exactTip: "精确搜索模式：仅用户/助手消息 · 区分大小写 · 整词边界（npm 不再命中 npmjs）· 空白不弹性",
				regexTip: "正则模式：仅用户/助手消息 · 对消息文本执行你输入的正则表达式（区分大小写），语法错误会在状态栏提示",
				rpcUnavailable: "搜索服务不可用（宿主半未就绪，可稍后重试）",
				foldedApprox: "可能被折叠",
				foldedApproxTip: "该对话可能被折叠，需要展开后查看；以实际定位结果为准",
				autoLoadEarlier: "正在自动加载更早的上下文…",
				autoLoadDone: "已自动加载并定位",
				autoLoadEmpty: "已加载全部更早内容，未找到该对话",
				autoLoadTimeout: "自动加载超时，已停在估算位置",
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
				looseTip: "Loose mode: user/assistant messages only · case-insensitive · whitespace-flexible multi-word",
				exactTip: "Exact match: user/assistant messages only · case-sensitive · whole-word (npm no longer matches npmjs) · literal whitespace",
				regexTip: "Regex mode: user/assistant messages only · runs your regex against message text (case-sensitive); invalid patterns show an error in the status bar",
				rpcUnavailable: "Search service unavailable (host half not ready; try again shortly)",
				foldedApprox: "folded",
				foldedApproxTip: "This message may be folded — expand to view; actual locate result overrides this",
				autoLoadEarlier: "Auto-loading earlier context…",
				autoLoadDone: "Loaded earlier context and located the hit",
				autoLoadEmpty: "All earlier context loaded; hit not found",
				autoLoadTimeout: "Auto-load timed out; staying at the estimated position",
			},
		};

		// 语言状态：跟随宿主 locale 服务动态切换（0.1.11）。t 为稳定引用，
		// 每次调用按 localeRef.current 取词——面板订阅 locale 变更后重渲染即生效。
		var CLIENT_VERSION = "0.2.24";
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

		/** 行匹配器：正则模式用表达式本身，其余模式用词序列顺序匹配。 */
		function makeRowMatcher(locateMode, rawPattern, words) {
			if (locateMode === "regex" && rawPattern) {
				var re = null;
				try { re = new RegExp(rawPattern, "u"); } catch (e) { re = null; }
				if (re) {
					return function (row) {
						try { return re.test(row.textContent); } catch (e2) { return false; }
					};
				}
			}
			return function (row) { return rowMatches(row, words); };
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
			var t = String(row.textContent || "").trim();
			// 0.2.10：正则兜底收窄（审查 P3）——「展开.*上下文」会误伤
			// 「展开上下文看看」一类正常消息；真实摘要条由上面的 asar 实证签名兜住。
			return t.length > 0 && t.length <= 120 && /^(已折叠|折叠的上下文|collapsed)/i.test(t);
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
			if (hitFp && hitFp.length >= 16) {
				for (var a = 0; a < visible.length; a++) {
					if (fingerprintKey(visible[a].textContent).indexOf(hitFp) >= 0) {
						console.info("[dsh-conversation-search] row matched by hit-text fingerprint");
						return visible[a];
					}
				}
			}
			var best = null;
			var bestScore = -1;
			for (var b = 0; b < visible.length; b++) {
				if (!matchRow(visible[b])) continue;
				var score = hitFp ? commonPrefixLen(fingerprintKey(visible[b].textContent), hitFp) : 0;
				if (score > bestScore) {
					best = visible[b];
					bestScore = score;
				}
			}
			if (best && (bestScore >= 12 || !hitFp)) {
				console.info("[dsh-conversation-search] row matched by word matcher, score=" + bestScore);
				return best;
			}
			if (best) console.info("[dsh-conversation-search] word-match rejected (score=" + bestScore + " < 12), keep scanning");
			return null;
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
				var text = String(allRows[i].textContent || "");
				liveRows.push(allRows[i]);
				projections.push(text.length === 0 ? "" : fingerprintKey(text));
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
		}

		/** 定位代次：新的定位开始后，旧的异步定位循环自行中止，避免扫错会话。 */
		var locateSeq = 0;

		async function locateHit(ctx, hit, words, locateMode, rawPattern) {
			var token = ++locateSeq;
			var started = Date.now();
			var matchRow = makeRowMatcher(locateMode, rawPattern, words);
			// 命中原文指纹（0.2.10）：投影去标点后取前 120 个密集字符；过短不足以
			// 唯一定位（<16），置空走词匹配兜底。
			var hitFp = fingerprintKey(hit.text || "");
			if (hitFp.length < 16) hitFp = "";
			else if (hitFp.length > 120) hitFp = hitFp.slice(0, 120);
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
			// 2) 等待任一会话行渲染（0.2.3：页面上可能并存多个 [data-chat-flow] 容器，
			//    querySelector 第一个常是空/非活动容器——0.2.2 的定位因此全空转）。
			//    改为等「任一会话行渲染」，容器按含行数×可见性选取，行扫描全文档，
			//    滚动定位用从行向上溯的真滚动容器。
			var flow = null;
			var scroller = null;
			while (Date.now() - started < 4000) {
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				var probeRow = null;
				var candidates = document.querySelectorAll("[data-chat-flow-kind]");
				for (var ci = 0; ci < candidates.length; ci++) {
					if (candidates[ci].getClientRects().length > 0) { probeRow = candidates[ci]; break; }
					if (!probeRow) probeRow = candidates[ci];
				}
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
			console.info("[dsh-conversation-search] locate hit=" + hit.sessionId + "#" + hit.seq
				+ " type=" + (hit.type || "?") + " fraction=" + (typeof hit.seqFraction === "number" ? hit.seqFraction.toFixed(3) : "MISSING")
				+ " flowRows=" + (flow ? flow.querySelectorAll("[data-chat-flow-kind]").length : -1)
				+ " scroller=" + (scroller ? scroller.tagName + "." + String(scroller.className || "").split(" ")[0] : "null"));
			console.info("[dsh-conversation-search] flow ready (after " + (Date.now() - started) + "ms), scanning");

			// 3) 比例落点（0.2.7）：直接按「滚动区间 × seqFraction」落点，再在目标
			//    邻域双向扫描。0.2.6 的 data-index 节点推导在本机构建下不成立——
			//    跳底后 max(data-index)+1=35（虚拟窗口内索引，非全局行号），
			//    「fraction × 总节点数」的整段数学失真，故放弃节点推导。
			if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
				var span = scroller.scrollHeight - scroller.clientHeight;
				var fraction = typeof hit.seqFraction === "number" ? Math.min(1, Math.max(0, hit.seqFraction)) : 0.5;
				var targetTop = Math.max(0, Math.min(span, fraction * span - scroller.clientHeight * 0.4));
				console.info("[dsh-conversation-search] proportional locate: fraction=" + fraction.toFixed(3)
					+ " span=" + Math.round(span) + " scrollTop->" + Math.round(targetTop));
				try { scroller.scrollTop = targetTop; } catch (e) { /* 忽略 */ }
				await sleep(260);
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				if (Math.abs(scroller.scrollTop - targetTop) > 4 && scroller.parentElement) {
					// 赋值没生效：该元素不是真滚动容器 → 沿祖先找真正会动的那个。
					var alt = findRealScroller(scroller.parentElement);
					if (alt && alt !== scroller) {
						console.info("[dsh-conversation-search] scroller fallback: "
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
				// 邻域双向扫描：±2 屏（比例落点有误差，命中行可能就在隔壁一两屏）。
				// 0.2.13：从 ±4 收窄——来回滚太多屏在用户眼里就是「乱跳」。
				for (var probe = 1; probe <= 2 && !foundRow && Date.now() - started < 9000; probe++) {
					if (token !== locateSeq) return { ok: false, reason: "superseded" };
					for (var dir = 0; dir < 2 && !foundRow; dir++) {
						var nextTop = scroller.scrollTop + (dir === 0 ? 1 : -1) * probe * scroller.clientHeight * 0.8;
						if (nextTop < 0 || nextTop > span) continue;
						try { scroller.scrollTop = nextTop; } catch (e) { /* 忽略 */ }
						await sleep(150);
						if (token !== locateSeq) return { ok: false, reason: "superseded" };
						foundRow = findHitRowDoc(matchRow, hitFp);
					}
				}
				if (token !== locateSeq) return { ok: false, reason: "superseded" };
				if (foundRow) { highlightRow(foundRow); return { ok: true }; }
			}

			// 4) 兜底（0.2.8）：目标比已加载窗口更老时，DOM 里根本没有目标行。
			//    0.2.21：改为直接点宿主的「加载更早」按钮（asar 实证
			//    scroll.loadEarlier = cancel+beginPaging+pauseFollowing+loadOlder，
			//    是宿主自己的分页触发器，比滚到顶可靠；按钮 disabled = 正在加载）。
			//    每页载入后立即扫描，全程 toast 提示进度。0.2.13：预算 25s、
			//    停滞 7.5s（深处历史要翻几十页，太早放弃会「不命中早期对话」）。
			if (scroller) {
				try { scroller.scrollTop = 0; } catch (e) { /* 忽略 */ }
				var lastHeight = scroller.scrollHeight;
				var stalls = 0;
				var pages = 0;
				var pagingDeadline = Date.now() + 25000;
				showToast(t("autoLoadEarlier"), true);
				while (Date.now() < pagingDeadline) {
					if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
					// 0.2.10：翻页期间 React 可能重建滚动容器——失联就重新定位
					//（旧实现全程持有开局 scroller，脱接后 scrollHeight 冻结、误判到顶，审查 P2）。
					if (!scroller || !scroller.isConnected) {
						var anchorRow = document.querySelector("[data-chat-flow-kind]");
						scroller = findRealScroller(anchorRow) || scrollerOf(anchorRow) || scroller;
						if (!scroller) break;
					}
					var row2 = findHitRowDoc(matchRow, hitFp);
					if (row2) {
						highlightRow(row2);
						hideToast();
						if (pages > 0) showToast(t("autoLoadDone"), false);
						return { ok: true };
					}
					var olderBtn = findLoadOlderButton();
					if (olderBtn && !olderBtn.disabled) {
						try { olderBtn.click(); pages += 1; } catch (e) { /* 点击失败退化为等待高度变化 */ }
					}
					await sleep(280);
					if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
					var grew = scroller.scrollHeight !== lastHeight;
					if (grew) {
						stalls = 0;
						lastHeight = scroller.scrollHeight;
					} else {
						stalls += 1;
						if (stalls >= 25) break; // ~7.5s 无新页：已到最早内容
					}
					// 0.2.22：每加载约 6 页把比例估算位置拉起来扫一遍——估算随
					// scrollHeight 增长逐步逼近目标，比原地只扫视口收敛快得多
					//（用户实测：一直加载但最后停在加载前最旧的可见行）。
					if (pages > 0 && pages % 6 === 0 && grew) {
						var frac2 = typeof hit.seqFraction === "number" ? Math.min(1, Math.max(0, hit.seqFraction)) : null;
						if (frac2 !== null) {
							try {
								var span3 = scroller.scrollHeight - scroller.clientHeight;
								scroller.scrollTop = Math.max(0, Math.min(span3, frac2 * span3 - scroller.clientHeight / 2));
							} catch (e) { /* 忽略 */ }
							await sleep(200);
							if (token !== locateSeq) { hideToast(); return { ok: false, reason: "superseded" }; }
							var row3 = findHitRowDoc(matchRow, hitFp);
							if (row3) {
								highlightRow(row3);
								hideToast();
								showToast(t("autoLoadDone"), false);
								console.info("[dsh-conversation-search] located via estimate sweep after " + pages + " pages");
								return { ok: true };
							}
						}
					}
					if (pages > 0) showToast(t("autoLoadEarlier") + " · " + pages, true);
				}
				hideToast();
				if (stalls >= 25) showToast(t("autoLoadEmpty"), false);
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
					var row5 = findHitRowDoc(matchRow, hitFp);
					if (row5) {
						highlightRow(row5);
						showToast(t("autoLoadDone"), false);
						console.info("[dsh-conversation-search] located at final estimate position");
						return { ok: true };
					}
					console.info("[dsh-conversation-search] locate: positioned by fraction (row text not in DOM)");
					return { ok: true, approximate: true };
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
			// 0.2.14：「≈ 折叠区」标记表（key=sessionId#seq）+ 重渲染计数。
			// 定位只到大纲位置（approximate）的命中打标，精确命中清除；
			// 新一次搜索重置（标记只属于当前结果列表）。
			var approxRef = React.useRef({});
			var approxTickState = React.useState(0);
			var setApproxTick = approxTickState[1];

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
					limit: 500,
					offset: offset || 0,
					mode: rawMode,
					exact: rawMode === "exact",
				}).then(function (value) {
					if (seq !== searchSeqRef.current) return;
					scannedOffsetRef.current = (offset || 0) + (value.scanned || 0);
					var hits = (value.hits || []).map(function (hitItem) {
						// 0.2.10：命中自带搜索参数快照——定位用命中当时的 mode/正则，
						// 不用当前输入框的（正则模式下点旧结果会用新正则错配，审查 P2）。
						return Object.assign({}, hitItem, { words: words, hitMode: rawMode, hitPattern: rawQuery.trim().slice(0, 200) });
					});
					var next = {
						hits: hits,
						scanned: value.scanned || 0,
						truncated: !!value.truncated,
						elapsedMs: value.elapsedMs || 0,
					};
					approxRef.current = {};
					setResult(next);
					setSelected(hits.length > 0 ? 0 : -1);
					// 0.2.15：搜索即预判「≈ 折叠区」（只读探针，下一帧跑，不滚动不点击）。
					// 实际定位结果会覆盖预判：精确命中清标、approximate 确保打标。
					setTimeout(function () {
						if (seq !== searchSeqRef.current) return;
						var predicted = probeFoldedHits(ctx, next.hits, rawMode, rawQuery.trim().slice(0, 200), words);
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
					// 诊断细节在 DevTools console 的 [dsh-conversation-search] 行。
					console.info("[dsh-conversation-search] locate failed:", outcome && outcome.reason);
				}).catch(function (error) {
					// 0.2.10：漏网异常不再成为 unhandled rejection（审查 P3）。
					console.warn("[dsh-conversation-search] locate threw", error);
				});
			};

			var onInputKeyDown = function (event) {
				if (event.key === "Enter") {
					event.preventDefault();
					// 0.2.10：回车前清掉防抖定时器——320ms 窗口内回车会让延迟搜索
					// 再跑一次，重置选中行并清掉刚算好的折叠徽标（审查 P2）。
					if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
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
									approxRef.current[hitItem.sessionId + "#" + hitItem.seq]
										? h("span", {
											style: {
												flex: "none", marginLeft: "6px", padding: "0 6px",
												borderRadius: "8px", fontSize: "10px", lineHeight: "16px",
												color: "#e08a3c", border: "1px solid rgba(224,138,60,0.55)",
												background: "rgba(224,138,60,0.12)",
											},
											title: t("foldedApproxTip"),
										}, "≈ " + t("foldedApprox"))
										: null,
									time ? h("span", { style: { color: T.textTertiary, flex: "none" } }, time) : null,
								),
								h("div", { style: hitSnippetStyle }, renderSnippet(hitItem.snippet, hitItem.words || [])),
							);
						}),
				),
				// 底栏
				h("div", { style: footerStyle },
					h("span", null, t("hint") + " · c" + CLIENT_VERSION),
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
