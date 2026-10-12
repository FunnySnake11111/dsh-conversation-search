/**
 * dsh-conversation-search — Host half.
 *
 * 单一 Loader 行（见 cordis.patch.yml）挂载本模块，职责：
 *  1. 经可选注入的 `sessionQuery` 服务（官方 @deepseek-ai/dsh-session-query）做
 *     会话历史的字面文本扫描：live 优先、官方负责 zstd/JSONL 解析与语义文本提取；
 *  2. `search()`：listSessions → 逐会话 filterEvents（surface=current + text 过滤），
 *     批量并发、总时长预算、limit 早停、readTitleSnapshots 补会话标题；
 *     exact=true 时对宽松命中做「区分大小写 + 整词边界 + 连续字面」后置精筛；
 *  3. 经 `ctx.provide('conversationSearch', service)` + typertRemote 绑定把 search
 *     暴露给浏览器半（client 经 remote.conversationSearch.* 调用，见 lib/typert.host.js）。
 *
 * 设计约束：只读；不写会话；不解析会话文件格式（全部交给官方服务）；服务缺失时
 * （inject 未满足）插件保持 inactive 而非崩溃。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 提取文本与片段的长度上限（字符）。 */
const MAX_TEXT = 2000;
const SNIPPET_CHARS = 240;
/** 默认与上限返回条数。 */
const DEFAULT_LIMIT = 500;   // 0.2.9：默认不再只回 30 条（用户要求去掉「仅显示前 30 条」）
const MAX_LIMIT = 5000;      // 安全上限：防病态查询撑爆 UI/IPC
/** 一次 search() 的总扫描时长预算（毫秒），超出即截断并报告。 */
const SCAN_BUDGET_MS = 8000;
/** filterEvents 的并发批量大小。 */
const SCAN_BATCH = 6;

/**
 * 服务名（ctx.conversationSearch / remote.conversationSearch）。
 * 修改必须同步 lib/typert.host.js 与 lib/client.js。
 */
const SERVICE_KEY = "conversationSearch";

/**
 * 宿主半自身版本（读包内 package.json），随 search 结果回传。
 * client 在状态栏回显它，用于识别「宿主半未随页面刷新而重载」的陈旧状态：
 * typert 宿主模块只在 DSH 进程启动时加载一次，改代码只刷页面不会生效。
 */
const HOST_VERSION = (() => {
	try {
		const manifest = JSON.parse(
			readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
		);
		return typeof manifest.version === "string" ? manifest.version : "unknown";
	} catch {
		return "unknown";
	}
})();

export const inject = ["sessionQuery"];

export function apply(ctx) {
	const service = createService(ctx);
	Object.defineProperty(service, "typertRemote", {
		configurable: false,
		enumerable: false,
		writable: false,
		value: { service, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY },
	});
	ctx.provide(SERVICE_KEY, service);

	// 手动注册 typert 清单，不声明 ./typert 导出、不走 typert-loader 发现：
	// loader 对声明 ./typert 的包 fail-loud（导入/校验失败会聚合抛出、拖垮宿主
	// 启动，0.1.0 的 zod 解析失败即属此列），link: 安装的包也可能被
	// pluginPackages 解析器跳过。手动注册 + dynamic import + 全捕获之后，
	// 任何失败都只降级本插件（面板提示搜索服务不可用），绝不影响宿主启动。
	ctx.inject(["typert"], (typertCtx) => {
		import("./typert.host.js")
			.then((mod) => {
				try {
					const dispose = typertCtx.typert.register(mod.TYPERT);
					ctx.effect(
						() => () => {
							try {
								dispose();
							} catch {
								// 幂等清理：清单已随上下文卸载时忽略。
							}
						},
						SERVICE_KEY + ": typert manifest",
					);
				} catch (error) {
					console.error("[dsh-conversation-search] typert manifest registration failed:", error);
				}
			})
			.catch((error) => {
				console.error("[dsh-conversation-search] typert manifest import failed:", error);
			});
	});

	return () => {};
}

function createService(ctx) {
	/** 短 TTL 结果缓存：防抖重复输入不重复全量扫描。 */
	let cache = null; // { key, at, promise } — 0.2.10 单飞：缓存 Promise 而非结果
	const CACHE_TTL_MS = 3000;

	// 0.2.10：参数解析抽出（search 薄壳与扫描体共用），缓存层做 Promise 单飞。
	function parseSearchRequest(request) {
		const query = String(request?.query ?? "").trim();
		const limit = clampInt(request?.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
		const scope = request?.scope === "current" ? "current" : "all";
		const offset = Math.max(0, clampInt(request?.offset, 0, 100000, 0));
		// 搜索模式：mode 优先，exact 布尔为陈旧宿主兼容位（0.2.0 起三态）。
		const mode =
			request?.mode === "exact" || request?.mode === "regex"
				? request.mode
				: request?.exact === true
					? "exact"
					: "loose";
		const requestedSessionId =
			typeof request?.sessionId === "string" && request.sessionId.length > 0
				? request.sessionId
				: undefined;
		return { query, limit, scope, offset, mode, requestedSessionId };
	}

	async function search(request) {
		const parsed = parseSearchRequest(request);
		if (parsed.query.length === 0) {
			return { hits: [], scanned: 0, truncated: false, elapsedMs: 0, hostVersion: HOST_VERSION };
		}
		const cacheKey = JSON.stringify([
			parsed.query, parsed.scope, parsed.requestedSessionId ?? "", parsed.limit, parsed.offset, parsed.mode,
		]);
		if (cache && cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL_MS) {
			return cache.promise; // 并发同 key 请求共享同一次扫描（旧实现各扫各的）
		}
		const promise = searchUncached(parsed).then(
			(value) => {
				// at 取完成时刻：>3s 的长扫描写入即过期的问题（审查 P2）。
				cache = { key: cacheKey, at: Date.now(), promise };
				return value;
			},
			(error) => {
				cache = null; // 失败不缓存，下次调用重扫
				throw error;
			},
		);
		cache = { key: cacheKey, at: Date.now(), promise };
		return promise;
	}

	async function searchUncached(parsed) {
		const { query, limit, scope, offset, mode, requestedSessionId } = parsed;

		const sessionQuery = ctx.sessionQuery;
		if (!sessionQuery || typeof sessionQuery.listSessions !== "function") {
			throw new Error("sessionQuery service is unavailable on this profile");
		}

		const startedAt = Date.now();
		const deadline = startedAt + SCAN_BUDGET_MS;

		// 正则预编译（模式长度限制 + 语法错误显式化 + 灾难性回溯静态拒绝）。
		let regex = null;
		if (mode === "regex") {
			if (query.length > 200) throw new Error("regex pattern too long (max 200 chars)");
			if (isCatastrophicRegex(query)) {
				// (a+)+ / (.*)* 型嵌套量词在长文本上不可被 SCAN_BUDGET_MS 抢占
				// （exec 在主进程同步执行），直接拒绝——0.2.10 审查 P1-②。
				throw new Error("invalid regex: nested quantifier rejected (catastrophic backtracking risk)");
			}
			try {
				regex = new RegExp(query, "u");
			} catch (error) {
				throw new Error("invalid regex: " + (error instanceof Error ? error.message : String(error)));
			}
		} else if (query.length > 200) {
			throw new Error("query too long (max 200 chars)");
		}

		// 目标会话集合：
		//  - scope=current：只查当前会话；
		//  - 宽松/精确 + FTS5 可用：searchSessions 毫秒级找候选会话（短语分词匹配），
		//    只对候选拿做字面精扫——字面语义不变、速度大幅提升。候选为空且查询含
		//    多个词时回退字面全量（短语召回对「词距很远的字面命中」有损失，此处兜底；
		//    单词查询的「词中词」边缘损失为已知权衡）；
		//  - 正则模式 / FTS5 不可用：字面全量扫描。
		// 子代理会话（header.origin === "subagent"，Agent Teams 成员/子代理分身）
		// 不能作为主会话在对话区打开——宿主拒绝加载（session/agent-busy），
		// 因此从可搜索范围排除，避免出现点了无法跳转的命中。
		let sessionIds;
		let viaFtsCandidates = false;
		if (scope === "current" && !requestedSessionId) {
			// scope=current 但无 sessionId（陈旧客户端/异常调用）→ 不再静默退化（审查 P3）。
			console.warn("[conversationSearch] scope=current without sessionId; falling back to full scan");
		}
		if (scope === "current" && requestedSessionId) {
			sessionIds = [requestedSessionId];
		} else if (mode !== "regex" && typeof sessionQuery.searchSessions === "function") {
			try {
				const wordCount = query.split(/\s+/u).filter(Boolean).length;
				const candidates = [];
				let cursor;
				for (let pageIndex = 0; pageIndex < 5 && candidates.length < 500; pageIndex += 1) {
					if (Date.now() > deadline) break;
					const page = await sessionQuery.searchSessions({
						query,
						eventFilters: [{ kind: "surface", values: ["current"] }],
						limit: 100,
						...(cursor === undefined ? {} : { cursor }),
					});
					for (const item of page?.items ?? []) {
						const header = item?.header;
						if (!header || header.origin === "subagent") continue;
						candidates.push(header.id);
					}
					cursor = page?.nextCursor;
					if (cursor === undefined) break;
				}
				if (candidates.length > 0 || wordCount <= 1) {
					// 0.2.10：offset 不再切会话列表——全量收集后统一 kept.slice(offset,…)，
					// 与全局降序语义一致（旧实现先切会话再全局排序，页间有条件性空洞）。
					viaFtsCandidates = true;
					sessionIds = candidates;
				}
			} catch (error) {
				// FTS5 不可用/禁用（openAt never）/索引错误 → 回退字面全量扫描。
				console.warn("[conversationSearch] FTS5 candidate search failed; falling back to full scan:", error);
			}
		}
		if (!viaFtsCandidates && sessionIds === undefined) {
			const sessions = await sessionQuery.listSessions();
			sessionIds = sessions
				.filter((record) => record.header?.origin !== "subagent")
				.map((record) => record.header.id);
		}

		// 0.2.5：三种模式都只搜用户/助手消息（用户明确反馈工具调用/结果是噪音；
		// 且 tool/* 行在 DOM 渲染折叠摘要、参数不在行文本里，文本匹配必然失败、
		// 连累定位——「搜 ref 跳不动」的根源）。「对话搜索」只搜对话内容，
		// tool/call、tool/result、step/* 一律不进命中。
		// surface=current 只搜当前模型可见的语义文本（跳过被替换遮蔽的历史版本）。
		// 官方 text 过滤固定为「大小写不敏感 + 空白弹性」；精确模式追加宿主侧
		// 后置精筛；正则模式取全部消息文档后逐条正则匹配。
		const filters = [
			{ kind: "surface", values: ["current"] },
			{ kind: "type", values: ["user/message", "assistant/message"] },
		];
		if (mode !== "regex") {
			filters.push({ kind: "text", text: query });
		}

		const hits = [];
		let scanned = 0;
		let truncated = false;

		for (let i = 0; i < sessionIds.length; i += SCAN_BATCH) {
			// 0.2.10：只按预算早停——0.2.8 只删了 doc 循环里的两处 hits.length>=limit，
			// 这里这处漏了，多会话扫描下「全量收集→降序」仍未生效（审查 P1-①）。
			if (Date.now() > deadline) {
				truncated = i < sessionIds.length;
				break;
			}
			const chunk = sessionIds.slice(i, i + SCAN_BATCH);
			const settled = await Promise.all(
				chunk.map(async (sessionId) => {
					try {
						return [sessionId, await sessionQuery.filterEvents(sessionId, filters)];
					} catch (error) {
						// 单会话损坏/读取失败不影响整体扫描，但不再静默（审查 P3）。
						console.warn("[conversationSearch] filterEvents failed for session", sessionId, error);
						return [sessionId, []];
					}
				}),
			);
			for (const [sessionId, documents] of settled) {
				scanned += 1;
				// 0.2.8 收集不设限：过滤按 seq 升序返回，旧代码在这里按 limit
				// 提前 break——只收集到最旧的 30 条，0.2.7 的降序排序排的从来
				// 都是「最旧 30 条」，最新命中根本没进管线。改为全量收集 →
				// 思考链剔除 → 降序排序 → 末尾统一截断 limit。
				for (const doc of documents) {
					const docText = String(doc.text ?? "");
					let matchAt = -1;
					if (mode === "exact") {
						matchAt = exactMatchIndex(docText, query);
						if (matchAt < 0) continue;
					} else if (mode === "regex") {
						matchAt = regexSearchIndex(docText, regex);
						if (matchAt < 0) continue;
					}
					hits.push({
						sessionId: typeof doc.sessionId === "string" ? doc.sessionId : sessionId,
						seq: Number(doc.seq) || 0,
						type: clip(typeof doc.type === "string" ? doc.type : "", 96),
						time: typeof doc.time === "number" ? doc.time : null,
						surface: doc.surface === "shadowed" || doc.surface === "log-only" ? doc.surface : "current",
						text: clip(docText, MAX_TEXT),
						snippet:
							matchAt >= 0
								? snippetAt(docText, matchAt, SNIPPET_CHARS)
								: snippetOf(docText, query, SNIPPET_CHARS),
						title: "",
					});
				}
			}
		}

		// 命中位置比例（0.2.2）+ 思考链剔除（0.2.6）：listEvents 逐命中会话取原始
		// 事件（filterEvents 已触发会话加载，listEvents 命中 prepared 缓存，成本可控）。
		// assistant/message 的 content 块分 type:"reasoning"（思考链）与 type:"text"
		//（可见文本）——官方提取器把两者都拼进 doc.text，用户不想搜到思考链；
		// 这里按原始事件重建可见文本、重算匹配与片段，纯思考链命中直接丢弃。
		function visibleTextOf(event) {
			const data = event && typeof event === "object" ? event.data ?? event : undefined;
			const message = data && typeof data === "object" ? data.message ?? data : undefined;
			const content = message && typeof message === "object" ? message.content : undefined;
			if (Array.isArray(content)) {
				const visible = content
					.filter((block) => block && block.type === "text" && typeof block.text === "string")
					.map((block) => block.text)
					.join("\n");
				return visible.trim().length > 0 ? visible : "";
			}
			if (typeof content === "string") return content;
			if (typeof message === "string") return message;
			return null; // 结构无法识别 → 保留官方提取文本
		}
		const uniqueHitSessions = [...new Set(hits.map((hit) => hit.sessionId))];
		const kept = [];
		// 0.2.10：listEvents 限并发 4 + 预算检查——旧实现逐会话串行 await，
		// 命中会话多时此阶段完全不受 SCAN_BUDGET_MS 约束（审查 P2）。
		for (let li = 0; li < uniqueHitSessions.length; li += 4) {
			if (Date.now() > deadline) break; // 预算耗尽：剩余会话保留官方提取文本
			const chunk = uniqueHitSessions.slice(li, li + 4);
			const lists = await Promise.all(
				chunk.map(async (sessionId) => {
					try {
						if (typeof sessionQuery.listEvents !== "function") return [sessionId, []];
						return [sessionId, await sessionQuery.listEvents(sessionId)];
					} catch {
						return [sessionId, []];
					}
				}),
			);
			for (const [sessionId, rawList] of lists) {
				const totalEvents = Array.isArray(rawList) ? rawList.length : 0;
				const rawBySeq = new Map(rawList.map((event) => [Number(event?.seq) || 0, event]));
				for (const hit of hits) {
					if (hit.sessionId !== sessionId) continue;
					if (totalEvents > 0) {
						hit.seqFraction = Math.min(1, Math.max(0, (Number(hit.seq) || 0) / totalEvents));
					}
					const event = rawBySeq.get(hit.seq);
					const clean = event ? visibleTextOf(event) : null;
					if (clean === null) {
						kept.push(hit); // 原始结构不可识别 → 保留官方提取结果
						continue;
					}
					let at = -1;
					if (mode === "exact") {
						at = exactMatchIndex(clean, query);
					} else if (mode === "regex") {
						at = regexSearchIndex(clean, regex);
					} else {
						// 0.2.10：无序 AND——与 FTS5 分词召回语义一致；旧实现要求词按
						// 查询顺序出现（有序子串），乱序命中在此被静默丢弃（审查 P2）。
						const words = query.split(/\s+/u).filter(Boolean);
						const lower = clean.toLowerCase();
						let ok = words.length > 0;
						for (const word of words) {
							const i = lower.indexOf(word.toLowerCase());
							if (i < 0) { ok = false; break; }
							if (at < 0 || i < at) at = i;
						}
					}
					if (at < 0) continue; // 剔除思考链后不再命中（纯思考链命中）→ 丢弃
					hit.text = clip(clean, MAX_TEXT);
					hit.snippet = mode === "loose" ? snippetOf(clean, query, SNIPPET_CHARS) : snippetAt(clean, at, SNIPPET_CHARS);
					kept.push(hit);
				}
			}
		}
		// 0.2.7 排序：最新命中优先（时间降序，同刻按 seq 降序）——截断 limit
		// 时保住的是最新的命中而非最早的；scope=all 时不同会话的命中也按
		// 时间交织，最新活跃的对话自然排在最前。
		kept.sort((a, b) => {
			const ta = Number(a.time) || 0;
			const tb = Number(b.time) || 0;
			if (tb !== ta) return tb - ta;
			return (Number(b.seq) || 0) - (Number(a.seq) || 0);
		});
		hits.length = 0;
		hits.push(...kept.slice(offset, offset + limit));
		// 0.2.10：truncated 改为真实信号——收集窗口外还有命中即截断
		//（客户端据此显示「仅显示前 N 条」，不再用 hits.length 猜）。
		if (kept.length > offset + limit) truncated = true;

		// 标题补全：readTitleSnapshots 对请求 id 逐个返回 fulfilled/rejected。
		const uniqueIds = [...new Set(hits.map((hit) => hit.sessionId))];
		if (uniqueIds.length > 0) {
			try {
				const snapshots = await sessionQuery.readTitleSnapshots(uniqueIds);
				for (let i = 0; i < uniqueIds.length; i += 1) {
					const entry = snapshots[i];
					if (!entry || entry.status !== "fulfilled") continue;
					const value = entry.value ?? {};
					const candidate =
						value.title ??
						value.snapshot?.title ??
						value.header?.title ??
						value.session?.title;
					let title =
						typeof candidate === "string"
							? candidate
							: candidate && typeof candidate.text === "string"
								? candidate.text
								: "";
					// 标题兜底：折叠标题/header.title 缺失时用会话 cwd 的目录名
					// （readTitleSnapshots 的 value.session 即 header 克隆，含 cwd）。
					// 会话标题由 LLM 异步生成，新建/短会话常常还没有。
					if (title.trim().length === 0) {
						const cwd = typeof value.session?.cwd === "string" ? value.session.cwd : "";
						const segments = cwd.split(/[\\/]/).filter(Boolean);
						title = segments.length > 0 ? segments[segments.length - 1] : "";
					}
					title = title.replace(/\s+/gu, " ").trim();
					for (const hit of hits) {
						if (hit.sessionId === uniqueIds[i]) hit.title = clip(title, 220);
					}
				}
			} catch (error) {
				// 标题失败不阻断结果返回，但留下诊断痕迹（审查 P3）。
				console.warn("[conversationSearch] readTitleSnapshots failed:", error);
			}
		}

		const result = {
			hits: hits.slice(0, limit),
			scanned,
			truncated,
			elapsedMs: Date.now() - startedAt,
			hostVersion: HOST_VERSION,
		};
		return result;
	}

	return { search };
}

/** 数值收敛：非法/缺省回退默认值。 */
function clampInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clip(text, max) {
	return text.length <= max ? text : text.slice(0, max);
}

/**
 * 精确匹配定位（0.1.4 精确模式）：区分大小写的连续字面匹配 + 整词边界。
 * 边界规则只对 ASCII 词字符生效——查询首尾是词字符时，紧邻字符不得同为词字符
 * （"npm" 不命中 "npmjs"）；中文等非 ASCII 相邻不算破坏边界（"插件" 仍命中
 * "这个插件很好"）。返回首个匹配下标，无匹配返回 -1。
 */
function exactMatchIndex(text, query) {
	if (query.length === 0 || text.length === 0) return -1;
	const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);
	const headWord = isWordChar(query[0]);
	const tailWord = isWordChar(query[query.length - 1]);
	let from = 0;
	for (;;) {
		const at = text.indexOf(query, from);
		if (at < 0) return -1;
		const before = at > 0 ? text[at - 1] : "";
		const after = at + query.length < text.length ? text[at + query.length] : "";
		if ((!headWord || !isWordChar(before)) && (!tailWord || !isWordChar(after))) return at;
		from = at + 1;
	}
}

/** 以已知匹配下标为中心取片段（精确/正则模式用，位置已确定无需再找）。 */
function snippetAt(text, index, max) {
	if (index < 0) return clip(text, max);
	const start = Math.max(0, index - Math.floor(max / 3));
	const end = Math.min(text.length, start + max);
	const head = start > 0 ? "…" : "";
	const tail = end < text.length ? "…" : "";
	return head + text.slice(start, end) + tail;
}

/** 正则首处匹配下标（regex 对象不带 g 标志，exec 恒为首个匹配）。 */
function regexSearchIndex(text, regex) {
	if (!regex) return -1;
	// ReDoS 防线（0.2.10）：exec 在宿主主进程同步执行，SCAN_BUDGET_MS 管不到
	// 单次调用；把输入截到 64KB，即使漏网的慢模式，最坏耗时也有界。
	const clipped = text.length > 65536 ? text.slice(0, 65536) : text;
	const match = regex.exec(clipped);
	return match ? match.index : -1;
}

/**
 * 灾难性回溯静态拒绝（0.2.10）：识别「组内以量词结尾 + 组外再跟量词」的
 * 嵌套量词形态（(a+)+、(\d*)* 等）。启发式、宁漏勿错杀——漏网的慢模式由
 * regexSearchIndex 的 64KB 输入截断兜底。
 */
function isCatastrophicRegex(pattern) {
	return /(?:[+*]|\{\d+(?:,\d*)?\})\s*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/u.test(pattern);
}

/**
 * 命中片段：定位查询词最早出现处，向前扩一点，截 SNIPPET_CHARS。
 * 查询词在 text 中按「任意空白分隔的多词」处理（与官方 text 过滤语义一致）。
 */
function snippetOf(text, query, max) {
	if (text.length === 0) return "";
	const words = query.split(/\s+/u).filter(Boolean);
	const lower = text.toLowerCase();
	let index = -1;
	for (const word of words) {
		const at = lower.indexOf(word.toLowerCase());
		if (at >= 0 && (index < 0 || at < index)) index = at;
	}
	if (index < 0) return clip(text, max);
	const start = Math.max(0, index - Math.floor(max / 3));
	const end = Math.min(text.length, start + max);
	const head = start > 0 ? "…" : "";
	const tail = end < text.length ? "…" : "";
	return head + text.slice(start, end) + tail;
}
