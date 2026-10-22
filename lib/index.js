/**
 * dsh-conversation-search — Host half.
 *
 * 职责：
 *  1. 0.5.0 起文本数据源 = 直读 ~/.dsh/sessions 的 session.v4.jsonl.zstd
 *     自建索引（lib/datasource.js）：内存索引 + mtime 缓存 + 激活期后台预热，
 *     搜索不再依赖 sessionQuery 的 filterEvents/searchSessions（宿主装载敏感、
 *     FTS5 召回有缺口、readSession 全量投影三重瓶颈的根治）；
 *  2. sessionQuery 仅保留两个轻量职责：listSessions（会话枚举 + subagent
 *     排除 + cwd 元数据）与 readTitleSnapshots（标题补全）；
 *  3. search()：全量收集 → time 降序 → offset/limit 截断（0.2.7/0.2.8/0.2.10
 *     语义不变）；loose/exact/regex 三态匹配语义不变（exactMatchIndex 整词
 *     边界、regexSearchIndex 64KB 截断、isCatastrophicRegex 静态拒绝）；
 *  4. pushDiag：client 定位链路诊断落盘（0.3.1 语义不变）。
 *
 * 设计约束：只读；单会话解析失败不影响整体；sessionQuery 缺失时抛错
 * （inject 未满足则插件 inactive 而非崩溃）。
 */

import { appendFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureIndexes, indexStats, listSessionFiles, preindexAll } from "./datasource.js";

/** 提取文本与片段的长度上限（字符）。 */
const MAX_TEXT = 2000;
const SNIPPET_CHARS = 240;
// 0.5.9：正则模式单条输入的截断长度（见 regexSearchIndex 注释）。
const REGEX_INPUT_MAX = 16 * 1024;
/** 默认与上限返回条数。 */
const DEFAULT_LIMIT = 500;   // 0.2.9：默认不再只回 30 条（用户要求去掉「仅显示前 30 条」）
const MAX_LIMIT = 5000;      // 安全上限：防病态查询撑爆 UI/IPC
/** 一次 search() 的总时长预算（毫秒），超出即截断并报告。可用 DSH_CSEARCH_BUDGET_MS 覆盖（测试/诊断）。 */
const SCAN_BUDGET_MS = Number(process.env.DSH_CSEARCH_BUDGET_MS) > 0 ? Number(process.env.DSH_CSEARCH_BUDGET_MS) : 8000;

/**
 * 服务名（ctx.conversationSearch / remote.conversationSearch）。
 * 修改必须同步 lib/typert.host.js 与 lib/client.js。
 */
const SERVICE_KEY = "conversationSearch";

/**
 * 宿主半自身版本（代码内常量），随 search 结果回传。
 * 0.3.2 起**不再读 package.json**——旧进程加载的模块读磁盘会拿到新版本号，
 * 造成「状态栏显示 v0.3.1、实际跑旧代码」的假象；常量随模块加载固化，
 * 显示什么就真的是什么。typert 宿主模块只在 DSH 进程启动时加载一次，
 * 改代码只刷页面不会生效——版本号变了就必须完全重启 DSH。
 */
const HOST_VERSION = "0.5.12";

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

	// 0.5.0：后台预热索引（fire-and-forget：低优先级逐会话解析，会话间让出
	// 事件循环；失败静默——搜索路径本就有 mtime 缓存 + deadline 截断兜底）。
	try {
		preindexAll();
	} catch {
		// 预热失败不影响服务。
	}

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
		// 0.5.2：默认只搜真实对话消息；true 时才把 DSH 注入的上下文
		//（工作区指令、记忆注入、运行环境、技能目录、时间戳、审批通知）也纳入。
		const includeInjected = request?.includeInjected === true;
		// 0.5.5：精确匹配的两个可选项（只作用于 mode === "exact"）：
		//  - caseSensitive: 默认 false（不区分大小写；用户要求"精确匹配太精确"）
		//  - wholeWord: 默认 true（保留整词边界，搜 npm 不命中 npmjs）
		const caseSensitive = request?.caseSensitive === true;
		const wholeWord = request?.wholeWord !== false;
		return { query, limit, scope, offset, mode, requestedSessionId, includeInjected, caseSensitive, wholeWord };
	}

	/**
	 * 是否「真实对话消息」：assistant/message，或 source.kind === "user" 的
	 * user/message（含旧日志缺 source 时的 "user" 兜底）。
	 */
	function isConversationEntry(entry) {
		return entry.source === "assistant" || entry.source === "user" || entry.source === undefined;
	}

	async function search(request) {
		const parsed = parseSearchRequest(request);
		if (parsed.query.length === 0) {
			return { hits: [], scanned: 0, truncated: false, elapsedMs: 0, hostVersion: HOST_VERSION };
		}
		const cacheKey = JSON.stringify([
			parsed.query, parsed.scope, parsed.requestedSessionId ?? "", parsed.limit, parsed.offset, parsed.mode,
			parsed.includeInjected === true, parsed.caseSensitive, parsed.wholeWord,
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
		const { query, limit, scope, offset, mode, requestedSessionId, includeInjected, caseSensitive, wholeWord } = parsed;

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
				// 0.5.9：`.*alpha.*` / `^.*alpha` 这类前导 `.*` 对「是否命中」零影响，
				// 但在长文本上会把 exec 拖成 O(n²)（实测 64KB 4.5s）。等价化简后再编译。
				regex = new RegExp(stripLeadingDotStar(query), "u");
			} catch (error) {
				throw new Error("invalid regex: " + (error instanceof Error ? error.message : String(error)));
			}
			// 0.5.8：静态形态检查只能拦已知家族，交替分支（(a|aa)+$）等漏网
			// 形态会让 exec 在宿主主进程指数级爆炸（实测 ^(\w+\s?)*$ 对 64KB
			// 输入 >60s 不返回，而 client 是 320ms 防抖自动执行）。补一道经验
			// 探测：拿逐步加长的对抗样本实测耗时，超阈值即判灾难性回溯。
			if (probeRegexCost(regex)) {
				throw new Error(
					"invalid regex: catastrophic backtracking on adversarial input (avoid nested or alternating quantifiers)",
				);
			}
		} else if (query.length > 200) {
			throw new Error("query too long (max 200 chars)");
		}

		// 会话枚举与元数据仍走 sessionQuery（轻量：一次 listSessions）：
		//  - subagent 会话（header.origin === "subagent"，Agent Teams 成员/子代理
		//    分身）不能作为主会话在对话区打开——宿主拒绝加载（session/agent-busy），
		//    从可搜索范围排除，避免出现点了无法跳转的命中；
		//  - cwd 兜底标题用（readTitleSnapshots 失败时的回退）。
		const sessionQuery = ctx.sessionQuery;
		if (!sessionQuery || typeof sessionQuery.listSessions !== "function") {
			throw new Error("sessionQuery service is unavailable on this profile");
		}
		if (scope === "current" && !requestedSessionId) {
			// scope=current 但无 sessionId（陈旧客户端/异常调用）→ 不再静默退化（审查 P3）。
			console.warn("[conversationSearch] scope=current without sessionId; falling back to full scan");
		}
		// 0.5.3：listSessions 失败不再让整次搜索抛错（旧实现连带已缓存索引的
		// 结果一起丢掉）。回退到会话目录扫描：拿得到 id 就够了，标题退化为
		// cwd 目录名（readTitleSnapshots 那条路径本来就有兜底）。
		let sessions = [];
		try {
			sessions = await sessionQuery.listSessions();
		} catch (error) {
			console.warn("[conversationSearch] listSessions failed, falling back to session files:", error);
			sessions = [];
		}
		const meta = new Map(); // id → { cwd }
		for (const record of sessions) {
			const header = record?.header;
			if (!header || header.origin === "subagent") continue;
			meta.set(header.id, { cwd: typeof header.cwd === "string" ? header.cwd : "" });
		}
		if (meta.size === 0) {
			// 兜底路径：无法识别 subagent 标记（可能多出不可跳转的命中），
			// 但总比「一次搜索完全失败」好——命中日期/标题仍可用。
			for (const file of listSessionFiles()) {
				if (!meta.has(file.sessionId)) meta.set(file.sessionId, { cwd: "" });
			}
		}
		const targets =
			scope === "current" && requestedSessionId ? [requestedSessionId] : [...meta.keys()];

		// 0.5.0 数据源：直读 .zstd 自建索引。ensureIndexes 逐会话解析（mtime/size
		// 缓存命中为零成本）、会话间让出事件循环、deadline 截断——预算耗尽的
		// 会话不在返回 Map 里，计入 truncated（真实信号，客户端显示截断提示）。
		const indexes = await ensureIndexes(targets, deadline);
		const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
		const kept = [];
		let scanned = 0;
		// 0.5.10：会话日志自带的标题与首条用户消息摘录（标题解析见 datasource）。
		const titleBySession = new Map();
		// 0.5.3：未拿到索引的会话 = 预算耗尽 / worker 未覆盖，计入截断信号。
		// 旧实现还会在下面循环里按 deadline 逐条跳过——而 worker 等待本身
		// 就会把 deadline 拖过（冷缓存 64 会话 ≈ 350s），于是**所有已就绪的
		// 索引**都被丢弃，首搜返回 0 命中。现在循环不再看表，拿到什么搜什么。
		// 0.5.9：区分三种「没搜到」——预算内没轮到（notScanned，算截断）、
		// 日志文件缺失（missing，不是截断）、解析失败（failed，不是截断）。
		// 旧实现把三者混成「truncated 恒真」（审查 B3）。
		const notScanned = Math.max(0, targets.length - indexes.size);
		let failedSessions = 0;
		let missingSessions = 0;
		for (const [sessionId, got] of indexes) {
			if (got.error || !got.index) {
				if (got.missing) missingSessions += 1;
				else if (!got.index) failedSessions += 1;
				continue;
			}
			scanned += 1;
			const { entries, turnStarts, totalEvents } = got.index;
			titleBySession.set(sessionId, {
				title: typeof got.index.title === "string" ? got.index.title : "",
				excerpt: typeof got.index.excerpt === "string" ? got.index.excerpt : "",
			});
			for (const entry of entries) {
				// 0.5.2：默认跳过 DSH 注入的上下文条目（agent-instructions /
				// plugin:记忆 / runtime-context / skill-catalog / time-context /
				// user-approval）——它们不是「对话内容」，会把结果列表灌满噪声。
				if (!includeInjected && !isConversationEntry(entry)) continue;
				const text = entry.text;
				let at = -1;
				if (mode === "exact") {
					// 精确模式：区分大小写 + ASCII 整词边界 + 连续字面（0.1.4 语义）。
					at = exactMatchIndex(text, query, caseSensitive, wholeWord);
				} else if (mode === "regex") {
					at = regexSearchIndex(text, regex);
				} else {
					// 宽松模式：无序 AND——与 FTS5 分词召回语义一致（0.2.10 审查 P2）。
					const lower = text.toLowerCase();
					let ok = words.length > 0;
					for (const word of words) {
						const i = lower.indexOf(word);
						if (i < 0) { ok = false; break; }
						if (at < 0 || i < at) at = i;
					}
					if (!ok) continue;
				}
				if (at < 0) continue;
				const hit = {
					sessionId,
					seq: entry.seq,
					type: clip(entry.type, 96),
					time: entry.time,
					surface: "current",
					text: clip(text, MAX_TEXT),
					snippet: snippetAt(text, at, SNIPPET_CHARS),
					title: "",
				};
				if (totalEvents > 0) {
					hit.seqFraction = Math.min(1, Math.max(0, entry.seq / totalEvents));
				}
				// 命中所属回合（0.3.0 语义）：seq 落入的最后一个 turn/start 区间；
				// 会话头部事件（permission/preset 等）在首个 turn/start 之前 → 无 turn。
				if (turnStarts.length > 0 && Number.isFinite(entry.seq)) {
					let lo = 0;
					let hi = turnStarts.length - 1;
					let found = -1;
					while (lo <= hi) {
						const mid = (lo + hi) >> 1;
						if (turnStarts[mid].seq <= entry.seq) {
							found = mid;
							lo = mid + 1;
						} else {
							hi = mid - 1;
						}
					}
					if (found >= 0) {
						hit.turn = turnStarts[found].turn;
						hit.turnSeq = turnStarts[found].seq;
					}
				}
				kept.push(hit);
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
		const hits = kept.slice(offset, offset + limit);
		// 0.2.10：truncated 为真实信号——收集窗口外还有命中、或预算内没扫完
		// 的会话，都算截断（客户端据此显示「仅显示前 N 条」）。
		const truncated = kept.length > offset + limit || notScanned > 0;
		if (failedSessions > 0) {
			// 0.5.9：解析失败不再静默——进宿主日志，并作为结果字段回给 client。
			console.warn(
				"[conversationSearch] " + failedSessions + " session(s) failed to parse and were dropped"
					+ (missingSessions > 0 ? "; " + missingSessions + " without a usable log" : ""),
			);
		}

		// 标题补全（0.5.10）：按可靠性排序，逐级兜底——
		//  1) 会话日志里的 session/title（标题生成器写入，磁盘上最可靠，且
		//     不依赖宿主是否加载过该会话）；
		//  2) 宿主 readTitleSnapshots（未加载/未生成时常返回空标题）；
		//  3) 首条真实用户消息前 40 字（至少能认出「这是哪个会话」）；
		//  4) 最后才退回会话 cwd 的目录名，并标「· 未命名」，避免看起来像
		//     正常的对话标题（旧实现直接把工作区目录名当标题，引发误解）。
		const uniqueIds = [...new Set(hits.map((hit) => hit.sessionId))];
		if (uniqueIds.length > 0) {
			const titles = new Map();
			for (const id of uniqueIds) {
				const logTitle = titleBySession.get(id)?.title ?? "";
				if (logTitle.length > 0) titles.set(id, logTitle);
			}
			try {
				const pending = uniqueIds.filter((id) => !titles.has(id));
				if (pending.length > 0) {
					const snapshots = await sessionQuery.readTitleSnapshots(pending);
					for (let i = 0; i < pending.length; i += 1) {
						const entry = snapshots[i];
						if (!entry || entry.status !== "fulfilled") continue;
						const value = entry.value ?? {};
						const candidate =
							value.title ??
							value.snapshot?.title ??
							value.header?.title ??
							value.session?.title;
						const title =
							typeof candidate === "string"
								? candidate
								: candidate && typeof candidate.text === "string"
									? candidate.text
									: "";
						if (title.replace(/s+/gu, " ").trim().length > 0) {
							titles.set(pending[i], title.replace(/s+/gu, " ").trim());
						}
					}
				}
			} catch (error) {
				// 标题失败不阻断结果返回：下面还有摘录/cwd 兜底（审查 P3）。
				console.warn("[conversationSearch] readTitleSnapshots failed:", error);
			}
			for (const id of uniqueIds) {
				const current = titles.get(id);
				if (typeof current === "string" && current.length > 0) continue;
				const excerpt = titleBySession.get(id)?.excerpt ?? "";
				if (excerpt.length > 0) {
					titles.set(id, excerpt);
					continue;
				}
				const cwd = meta.get(id)?.cwd ?? "";
				const segments = cwd.split(/[\/]/).filter(Boolean);
				const base = segments.length > 0 ? segments[segments.length - 1] : "";
				titles.set(id, base.length > 0 ? base + " · 未命名" : "");
			}
			for (const hit of hits) {
				hit.title = clip(titles.get(hit.sessionId) ?? "", 220);
			}
		}

		return {
			hits,
			scanned,
			truncated,
			notScanned,
			failedSessions,
			missingSessions,
			elapsedMs: Date.now() - startedAt,
			hostVersion: HOST_VERSION,
		};
	}

	// indexStats 留作诊断出口（当前未被 search 使用；pushDiag 通道可后续接入）。
	void indexStats;

	// ------------------------------------------------------------------
	// 0.3.1 诊断回传：client 半渲染进程 console 不落盘、DSH 未开 CDP 调试
	// 端口（已核实进程命令行），用户截图转发太低效。client 定位链路日志经
	// typert pushDiag 落盘（512KB 轮转 .1），AI 直接读文件。
	// 0.4.1：主路径改 ~/.dsh/——插件宿主半从未成功写过 G:\ 工作区（.diag.log
	// 全盘缺席、失败只进不可见的宿主 console），DSH 自有沙箱很可能不放行
	// 工作区写；~/.dsh 是 DSH 自己的会话存储目录，必然可写。G:\ 插件根保留
	// 为 best-effort 镜像（AI 侧读起来近）。失败写入返回值，证据链不静默。
	// ------------------------------------------------------------------
	const DIAG_LOG = join(homedir(), ".dsh", "conversation-search.diag.log");
	const DIAG_LOG_MIRROR = join(dirname(fileURLToPath(import.meta.url)), "..", ".diag.log");
	const DIAG_LOG_MAX_BYTES = 512 * 1024;
	async function pushDiag(payload) {
		const lines = Array.isArray(payload?.lines) ? payload.lines : [];
		let out = "";
		for (const line of lines) {
			if (typeof line === "string" && line.length > 0 && line.length <= 4000) out += line + "\n";
		}
		if (out.length === 0) return { written: 0 };
		try {
			try {
				if (statSync(DIAG_LOG).size > DIAG_LOG_MAX_BYTES) renameSync(DIAG_LOG, DIAG_LOG + ".1");
			} catch {
				// 文件不存在 = 无需轮转。
			}
			appendFileSync(DIAG_LOG, out, "utf8");
			try {
				// 0.5.3：镜像也轮转（旧实现只轮转主日志，G:\ 侧可无限增长）。
				try {
					if (statSync(DIAG_LOG_MIRROR).size > DIAG_LOG_MAX_BYTES) renameSync(DIAG_LOG_MIRROR, DIAG_LOG_MIRROR + ".1");
				} catch {
					// 镜像不存在 = 无需轮转。
				}
				appendFileSync(DIAG_LOG_MIRROR, out, "utf8");
			} catch { /* 镜像失败忽略 */ }
			return { written: lines.length };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn("[conversationSearch] diag log write failed:", message);
			return { written: 0, error: message };
		}
	}

	return { search, pushDiag };
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
function exactMatchIndex(text, query, caseSensitive = false, wholeWord = true) {
	if (query.length === 0 || text.length === 0) return -1;
	// 0.5.5：大小写与整词边界都可配（仅精确模式）。大小写不敏感时对原文与
	// 查询一起 toLowerCase——ASCII 与常见 CJK 场景长度不变，返回的下标可直接
	// 用于原文切片（个别 Unicode 大小写折叠会改长度的情形不支持，按原样处理）。
	const haystack = caseSensitive ? text : text.toLowerCase();
	const needle = caseSensitive ? query : query.toLowerCase();
	const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);
	const headWord = wholeWord && isWordChar(needle[0]);
	const tailWord = wholeWord && isWordChar(needle[needle.length - 1]);
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) return -1;
		const before = at > 0 ? haystack[at - 1] : "";
		const after = at + needle.length < haystack.length ? haystack[at + needle.length] : "";
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
	// 单次调用；把输入截断，即使漏网的慢模式，最坏耗时也有界。
	// 0.5.9：64KB → 16KB。多项式回溯（如 `.*alpha.*` 在 64KB 上实测 4.5s）
	// 不会被经验探测拦下（样本才几十字节），只能靠输入长度把最坏耗时压到
	// 秒级以下：16KB 时同一模式约 0.3s，且仍在 SCAN_BUDGET_MS 量级内。
	const clipped = text.length > REGEX_INPUT_MAX ? text.slice(0, REGEX_INPUT_MAX) : text;
	const match = regex.exec(clipped);
	return match ? match.index : -1;
}

/**
 * 0.5.9：剥掉模式开头的「任意字符任意次」子式（`.*`、`.*?`、`[\s\S]*`）。
 * 它们不影响「是否命中」的判定，却是 `.*alpha.*` 在长文本上退化成 O(n²)
 * 的元凶（64KB 实测 4.5s）。只处理无锚定 `^` 的前缀——`^.*x` 受 `.` 不跨行
 * 影响，语义不等价，保持原样（由 16KB 输入上限兜底）。
 */
function stripLeadingDotStar(source) {
	let out = source;
	for (;;) {
		const match = /^(?:\.\*\??|\[\s\S\]\*\??)/u.exec(out);
		if (!match || match[0].length === 0) return out;
		const next = out.slice(match[0].length);
		if (next.length === 0) return source; // 整个模式就是 .*：保持原样
		out = next;
	}
}

/**
 * 灾难性回溯静态拒绝（0.2.10）：识别「组内以量词结尾 + 组外再跟量词」的
 * 嵌套量词形态（(a+)+、(\d*)* 等）。启发式、宁漏勿错杀——漏网的慢模式由
 * regexSearchIndex 的 64KB 输入截断兜底。
 */
function isCatastrophicRegex(pattern) {
	// ① 组内以量词结尾 + 组外再跟量词：(a+)+ / (\d*)*
	if (/(?:[+*]|\{\d+(?:,\d*)?\})\s*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/u.test(pattern)) return true;
	// ② 交替分支可重叠 + 外层量词：(a|aa)+$ / (\w|\w\w)* —— 0.5.8 补，
	//    这类形态的爆炸来自分支间可重叠匹配，与 ① 的嵌套量词无关。
	//    判定用「分支最小长度不一致」近似可重叠：(a|aa) 与 (foo|foobar) 命中，
	//    而 (a|b)+、(cat|dog)+ 这类等长分支（不重叠、安全）放行，避免误杀。
	if (hasOverlappingAlternation(pattern)) return true;
	return false;
}

/** 按顶层 `|` 切分（跳过转义、字符类与嵌套组）。 */
function splitTopLevel(inner) {
	const parts = [];
	let depth = 0;
	let inClass = false;
	let cur = "";
	for (let i = 0; i < inner.length; i += 1) {
		const ch = inner[i];
		if (ch === "\\") {
			cur += ch + (inner[i + 1] || "");
			i += 1;
			continue;
		}
		if (ch === "[") inClass = true;
		else if (ch === "]") inClass = false;
		if (!inClass && ch === "(") depth += 1;
		else if (!inClass && ch === ")") depth -= 1;
		if (!inClass && depth === 0 && ch === "|") {
			parts.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	parts.push(cur);
	return parts;
}

/** 分支的最短可匹配宽度（量词按 0/1 个计，字符类与转义算 1）——近似值。 */
function minWidth(branch) {
	let width = 0;
	for (let i = 0; i < branch.length; i += 1) {
		const ch = branch[i];
		if (ch === "\\") {
			width += 1;
			i += 1;
			continue;
		}
		if (ch === "[") {
			const end = branch.indexOf("]", i + 1);
			width += 1;
			i = end < 0 ? branch.length : end;
			continue;
		}
		if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
			const end = ch === "{" ? branch.indexOf("}", i) : i;
			if (ch === "+") width += 0; // `+` 前一个原子至少 1 次，已被计入
			i = ch === "{" ? (end < 0 ? branch.length : end) : i;
			continue;
		}
		if (ch === "(" || ch === ")" || ch === "^" || ch === "$" || ch === ".") continue;
		width += 1;
	}
	return width;
}

function hasOverlappingAlternation(pattern) {
	const re = /\(((?:[^()\\]|\\.)*)\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/gu;
	let match;
	while ((match = re.exec(pattern)) !== null) {
		const inner = match[1];
		if (inner.indexOf("|") < 0) continue;
		const parts = splitTopLevel(inner);
		if (parts.length < 2) continue;
		const lens = parts.map(minWidth);
		if (lens.some((len) => len !== lens[0])) return true;
	}
	return false;
}

/**
 * 0.5.8：正则耗时经验探测。
 *
 * 静态检查是形态白名单，天然漏掉「非典型但同样指数」的写法；而 regex.exec
 * 在宿主主进程同步执行，SCAN_BUDGET_MS 抢不回来——一次爆炸就是整进程假死。
 * 这里用几组由易到难的对抗样本实测单次 exec 耗时：真·指数模式在样本还只有
 * 几十个字符时就会露出数量级，命中即拒绝。总预算 120ms，最坏情况只多花
 * 一次「已超阈值的样本」的耗时（约 ≤100ms）。
 */
function probeRegexCost(regex) {
	const makers = [
		(n) => "a".repeat(n) + "!",
		(n) => "ab ".repeat(n) + "#",
		(n) => "1".repeat(n) + "x0",
		(n) => "_".repeat(n) + "-",
		(n) => "aaaa ".repeat(n) + "?",
	];
	const deadline = Date.now() + 120;
	for (let n = 8; n <= 192; n *= 2) {
		for (const make of makers) {
			const sample = make(n);
			const at = Date.now();
			try {
				regex.exec(sample);
			} catch {
				return false; // 样本不合法（如带 u 标志的怪模式）：交给调用方处理
			}
			// 单样本 25ms 已远超正常正则的量级（正常 <1ms），判为爆炸。
			if (Date.now() - at > 25) return true;
		}
		if (Date.now() > deadline) return false; // 探测预算耗尽且未见爆炸 → 放行
	}
	return false;
}
