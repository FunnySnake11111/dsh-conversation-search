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
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
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
	let cache = null; // { key, at, value }
	const CACHE_TTL_MS = 3000;

	async function search(request) {
		const query = String(request?.query ?? "").trim();
		const limit = clampInt(request?.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
		const scope = request?.scope === "current" ? "current" : "all";
		const offset = Math.max(0, clampInt(request?.offset, 0, 100000, 0));
		// 搜索模式：mode 优先，exact 布尔为陈旧宿主兼容位（0.2.0 起三态）。
		// 求值必须在 cacheKey 之前（0.1.4 曾把它声明在 cacheKey 之后，
		// const TDZ 导致 search() 每次调用都抛 ReferenceError）。
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

		if (query.length === 0) {
			return { hits: [], scanned: 0, truncated: false, elapsedMs: 0, hostVersion: HOST_VERSION };
		}

		const cacheKey = JSON.stringify([query, scope, requestedSessionId ?? "", limit, offset, mode]);
		const now = Date.now();
		if (cache && cache.key === cacheKey && now - cache.at < CACHE_TTL_MS) {
			return cache.value;
		}

		const sessionQuery = ctx.sessionQuery;
		if (!sessionQuery || typeof sessionQuery.listSessions !== "function") {
			throw new Error("sessionQuery service is unavailable on this profile");
		}

		const startedAt = Date.now();
		const deadline = startedAt + SCAN_BUDGET_MS;

		// 正则预编译（模式长度限制 + 语法错误显式化；灾难性回溯由总预算兜底）。
		let regex = null;
		if (mode === "regex") {
			if (query.length > 200) throw new Error("regex pattern too long (max 200 chars)");
			try {
				regex = new RegExp(query, "u");
			} catch (error) {
				throw new Error("invalid regex: " + (error instanceof Error ? error.message : String(error)));
			}
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
					viaFtsCandidates = true;
					sessionIds = candidates;
					if (offset > 0) sessionIds = sessionIds.slice(offset);
				}
			} catch {
				// FTS5 不可用/禁用（openAt never）/索引错误 → 回退字面全量扫描。
			}
		}
		if (!viaFtsCandidates && sessionIds === undefined) {
			const sessions = await sessionQuery.listSessions();
			sessionIds = sessions
				.filter((record) => record.header?.origin !== "subagent")
				.map((record) => record.header.id);
			if (offset > 0) sessionIds = sessionIds.slice(offset);
		}

		// surface=current 只搜当前模型可见的语义文本（跳过被替换遮蔽的历史版本）。
		// 官方 text 过滤固定为「大小写不敏感 + 空白弹性」的宽松匹配；精确模式追加
		// 事件类型收窄（仅用户/助手消息）+ 宿主侧后置精筛；正则模式无法用 text
		// 预过滤，取全部 current 文档后逐条正则匹配。
		const filters = [{ kind: "surface", values: ["current"] }];
		if (mode === "exact") {
			filters.push({ kind: "type", values: ["user/message", "assistant/message"] });
		}
		if (mode !== "regex") {
			filters.push({ kind: "text", text: query });
		}

		const hits = [];
		let scanned = 0;
		let truncated = false;

		for (let i = 0; i < sessionIds.length; i += SCAN_BATCH) {
			if (hits.length >= limit || Date.now() > deadline) {
				truncated = i < sessionIds.length;
				break;
			}
			const chunk = sessionIds.slice(i, i + SCAN_BATCH);
			const settled = await Promise.all(
				chunk.map(async (sessionId) => {
					try {
						return [sessionId, await sessionQuery.filterEvents(sessionId, filters)];
					} catch {
						// 单会话损坏/读取失败不影响整体扫描。
						return [sessionId, []];
					}
				}),
			);
			for (const [sessionId, documents] of settled) {
				scanned += 1;
				for (const doc of documents) {
					if (hits.length >= limit) break;
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
						type: typeof doc.type === "string" ? doc.type : "",
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
				if (hits.length >= limit) break;
			}
		}

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
			} catch {
				// 标题失败不阻断结果返回。
			}
		}

		const result = {
			hits: hits.slice(0, limit),
			scanned,
			truncated,
			elapsedMs: Date.now() - startedAt,
			hostVersion: HOST_VERSION,
		};
		cache = { key: cacheKey, at: now, value: result };
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
	const match = regex.exec(text);
	return match ? match.index : -1;
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
