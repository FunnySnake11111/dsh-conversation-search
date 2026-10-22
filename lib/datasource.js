/**
 * dsh-conversation-search — 数据源层（0.5.0）。
 *
 * 0.5.0 起 search 的数据源从 sessionQuery 换为「直读会话日志文件」：
 *  - 路径 ~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd
 *    （DSH 自身按目录组织，listSessions 的 id = 目录名，已实证一致）；
 *  - v4 日志为「逐帧追加 zstd」：按魔数 0xFD2FB528 切帧，逐帧解压后拼接
 *    （zstdDecompressSync 只解第一帧且不报错，必须切帧——重复对话调查实证）；
 *  - 每会话解析一次，按 (mtimeMs,size) 缓存于内存；活动会话增长后 mtime
 *    变化自动失效重建。
 *
 * 索引内容（内存，只有可搜索面）：
 *  - entries: [{seq,type,time,text}]（仅 user/message 与 assistant/message，
 *    text 只取 type==="text" 可见块——思考链不进搜索，0.2.6 语义）；
 *  - turnStarts: [{seq,turn}]（turn/start 事件的 (seq,data.turn) 升序），
 *    命中回合由 seq 二分求区间归属（0.3.0 语义，数据源直读后天然准确）；
 *  - totalEvents：会话全事件数（seqFraction 用）。
 *
 * 只读；任何单会话解析失败都不影响其它会话（错误记入该会话条目）。
 * DSH_CSEARCH_SESSIONS_ROOT 环境变量可重定向根目录（功能测试用）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Worker } from "node:worker_threads";

/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/** 单条命中文本存储上限：与 regexSearchIndex 的 64KB 输入截断对齐。 */
const MAX_INDEX_TEXT = 65536;

/** 索引缓存条目数上限（LRU）：超出淘汰最久未用的会话索引。 */
const MAX_INDEXED_SESSIONS = 80;

export function sessionsRoot() {
	return process.env.DSH_CSEARCH_SESSIONS_ROOT || join(homedir(), ".dsh", "sessions");
}

/** 缓存：path → { mtimeMs, size, entries, turnStarts, totalEvents, lastUsed, error } */
const indexCache = new Map();

function evictLru() {
	if (indexCache.size <= MAX_INDEXED_SESSIONS) return;
	let oldestKey = null;
	let oldestAt = Infinity;
	for (const [key, value] of indexCache) {
		if (value.lastUsed < oldestAt) {
			oldestAt = value.lastUsed;
			oldestKey = key;
		}
	}
	if (oldestKey !== null) indexCache.delete(oldestKey);
}

function cachePut(file, sessionId, index) {
	index.lastUsed = Date.now();
	index.mtimeMs = file.mtimeMs;
	index.size = file.size;
	index.sessionId = sessionId;
	indexCache.set(file.path, index);
	evictLru();
}

// ---------------------------------------------------------------------------
// 后台 worker（0.5.1）：zstd 解压 + JSONL 解析是 CPU 密集活（最大单会话实测
// ~2.8s 纯 CPU），在宿主主进程同步跑会拖死整个 DSH 事件循环（0.5.0 教训：
// 启动与搜索「奇慢无比」）。全部解析进 worker_threads 后台线程；worker 不可
// 用（DSH_CSEARCH_NO_WORKER=1 / 启动失败 / 崩溃）时才回退主进程同步解析。
// ---------------------------------------------------------------------------
const INDEX_TIMEOUT_MS = 30000;
let worker = null;
let workerBroken = process.env.DSH_CSEARCH_NO_WORKER === "1";
const WORKER_MAX_RESTARTS = 3;
const WORKER_RESTART_BASE_MS = 2000;
let workerRestarts = 0;
let workerRetryAt = 0;
let reqSeq = 0;
const pendingReqs = new Map(); // reqId → { resolve, results, expected, timer }

/**
 * worker 退出/报错处理（0.5.3）：不再一次性永久降级主线程同步解析——主线程
 * 解析单文件实测 2.6s，会卡死宿主事件循环。改为有限次重启（指数退避），
 * 超过 WORKER_MAX_RESTARTS 才永久降级。
 */
function breakWorker() {
	worker = null;
	workerRestarts += 1;
	if (workerRestarts >= WORKER_MAX_RESTARTS) workerBroken = true;
	else workerRetryAt = Date.now() + WORKER_RESTART_BASE_MS * 2 ** (workerRestarts - 1);
	for (const entry of pendingReqs.values()) {
		clearTimeout(entry.timer);
		entry.resolve(null);
	}
	pendingReqs.clear();
}

function ensureWorker() {
	if (worker || workerBroken) return worker;
	if (Date.now() < workerRetryAt) return null; // 退避窗口内：本次走同步回退
	try {
		worker = new Worker(new URL("./datasource.worker.js", import.meta.url), {
			workerData: { root: sessionsRoot() },
		});
		worker.on("message", (msg) => {
			const entry = pendingReqs.get(msg && msg.reqId);
			if (!entry || !msg) return;
			if (msg.done === true) {
				// worker 因 deadline 提前停止：已到的结果照常交付（0.5.3）。
				pendingReqs.delete(msg.reqId);
				clearTimeout(entry.timer);
				entry.resolve([...entry.results.values()]);
				if (pendingReqs.size === 0 && worker) worker.unref();
				return;
			}
			if (typeof msg.sessionId !== "string") return;
			entry.results.set(msg.sessionId, msg);
			if (entry.results.size >= entry.expected) {
				pendingReqs.delete(msg.reqId);
				clearTimeout(entry.timer);
				entry.resolve([...entry.results.values()]);
				if (pendingReqs.size === 0) worker.unref(); // 空闲不占事件循环
			}
		});
		worker.on("error", breakWorker);
		worker.on("exit", () => {
			if (pendingReqs.size > 0) breakWorker();
			else {
				// 空闲自动退出（unref 后）属正常：允许下次懒重建，不计故障。
				worker = null;
			}
		});
		// 不让 worker 阻止进程退出（宿主进程常驻无感；独立测试进程可正常收尾）。
		worker.unref();
	} catch {
		workerBroken = true;
		worker = null;
	}
	return worker;
}

/**
 * 向 worker 提交一批文件解析。返回结果数组 [{sessionId,ok,index|error},…]
 * （按到达数聚合）；超时/worker 崩溃返回已到的部分（可能为空数组）或 null。
 * 超时不算失败：索引缺失由调用方按「本次跳过、下次缓存补齐」处理。
 *
 * 0.5.3：新增 deadline（epoch ms）。worker 每解析完一个文件检查一次，
 * 超时即停并发 {done:true}，避免「等 350s 才返回、调用方预算早已过期」
 * 的旧行为（首搜 0 命中根因）。
 */
function requestIndexes(list, timeoutMs, deadline) {
	const w = ensureWorker();
	if (!w) return Promise.resolve(null);
	const reqId = ++reqSeq;
	// 定时器不晚于 deadline 太多：deadline 到期后只留给在跑的那个文件收尾。
	const budget = deadline > 0 ? Math.max(1500, Math.min(timeoutMs, deadline - Date.now() + 2000)) : timeoutMs;
	return new Promise((resolve) => {
		const entry = {
			resolve: null,
			results: new Map(),
			expected: list.length,
			timer: null,
		};
		entry.timer = setTimeout(() => {
			pendingReqs.delete(reqId);
			entry.resolve([...entry.results.values()]);
			if (worker && pendingReqs.size === 0) worker.unref(); // 空闲不占事件循环
		}, budget);
		if (typeof entry.timer.unref === "function") entry.timer.unref();
		entry.resolve = resolve;
		pendingReqs.set(reqId, entry);
		w.postMessage({ reqId, list, deadline: deadline > 0 ? deadline : 0 });
		w.ref(); // 在途请求期间保活（测试等短生命周期进程依赖它等回复）
	});
}

/**
 * 枚举所有会话日志文件。返回 [{sessionId, path, mtimeMs, size}]；
 * 枚举失败（无 ~/.dsh/sessions 等）返回空数组，不抛错。
 *
 * 0.5.9：不再只认 `session-` 前缀目录 + `session.v4.jsonl.zstd` 单一名——
 * 本机实测 124 个会话目录里有 3 个 `import-*`、11 个裸 UUID，且日志文件名
 * 还有 v3 / 旧版 `session.jsonl.zstd`，旧实现只覆盖 53 个，表现为「某些
 * 老会话怎么都搜不到」。现在任何包含可用日志的目录都收，目录名即 sessionId。
 */
const LOG_CANDIDATES = ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"];

/** 在会话目录内挑一个可用日志：优先新格式，回退目录内任意非备份 *.jsonl.zstd。 */
function resolveSessionLog(dirPath) {
	for (const name of LOG_CANDIDATES) {
		const file = join(dirPath, name);
		try {
			const st = statSync(file);
			if (st.isFile() && st.size > 0) return { path: file, mtimeMs: st.mtimeMs, size: st.size };
		} catch {
			/* 试下一个候选名 */
		}
	}
	let names;
	try {
		names = readdirSync(dirPath);
	} catch {
		return null;
	}
	let best = null;
	for (const name of names) {
		// 备份文件名是 `session.jsonl.zstd.desktop-v0-...backup...`，不以 .jsonl.zstd 结尾，不会误收。
		if (!name.endsWith(".jsonl.zstd")) continue;
		const file = join(dirPath, name);
		try {
			const st = statSync(file);
			if (!st.isFile() || st.size === 0) continue;
			if (!best || st.mtimeMs > best.mtimeMs) best = { path: file, mtimeMs: st.mtimeMs, size: st.size };
		} catch {
			/* 跳过读不到的文件 */
		}
	}
	return best;
}

export function listSessionFiles() {
	const root = sessionsRoot();
	const out = [];
	let workspaces;
	try {
		workspaces = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ws of workspaces) {
		if (!ws.isDirectory()) continue;
		const wsPath = join(root, ws.name);
		let sessions;
		try {
			sessions = readdirSync(wsPath, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const sess of sessions) {
			if (!sess.isDirectory()) continue;
			const log = resolveSessionLog(join(wsPath, sess.name));
			if (!log) continue; // 新会话/未落盘：跳过
			out.push({ sessionId: sess.name, path: log.path, mtimeMs: log.mtimeMs, size: log.size });
		}
	}
	return out;
}

/** 切帧：按魔数定位帧边界，返回原始帧 Buffer 数组。 */
function splitZstdFrames(buf) {
	const marks = [];
	for (let pos = 0; pos + 4 <= buf.length; pos += 1) {
		if (buf.readUInt32LE(pos) === ZSTD_MAGIC) marks.push(pos);
	}
	const frames = [];
	for (let i = 0; i < marks.length; i += 1) {
		const start = marks[i];
		const end = i + 1 < marks.length ? marks[i + 1] : buf.length;
		frames.push(buf.subarray(start, end));
	}
	return frames;
}

/**
 * 逐帧解压后拼接为完整 JSONL 文本。
 *
 * 0.5.3 修正：旧实现遇到假魔数（压缩数据内巧合出现帧魔数）时，会把
 * 「从假魔数起」的残段 pending 与后续每一帧拼接，之后每次都从帧中途开始
 * 解压 → 必然抛 ZSTD_error_prefix_unknown，级联到 EOF，整个会话后半段
 * 静默消失。现在合并仍失败时**丢弃残段起点**、单独重试当前帧：最多损失
 * 被假魔数截断的那一帧尾部，后续帧（各自起始正确）仍能解码。
 * 截断的尾帧（活动会话正在追加）由 zstd 自身返回部分内容，不抛错。
 */
function decodeFrames(buf) {
	const frames = splitZstdFrames(buf);
	// 0.5.3：解出空内容也视为「这不是合法帧起点」。zstd 对截断/残缺输入可能
	// 不抛错而静默返回空 buffer——只看异常会漏判，导致后续帧被当成它的续段。
	const tryDecode = (chunk) => {
		try {
			const out = zstdDecompressSync(chunk);
			return out && out.length > 0 ? out : null;
		} catch {
			return null;
		}
	};
	const pieces = [];
	let pending = null;
	let dropped = 0;
	for (const frame of frames) {
		if (pending !== null) {
			const merged = tryDecode(Buffer.concat([pending, frame]));
			if (merged) {
				pieces.push(merged);
				pending = null;
				continue;
			}
			// 合并失败 = pending 起点是假魔数（帧中途）：丢掉它，本帧单独再试。
			pending = null;
			dropped += 1;
		}
		const alone = tryDecode(frame);
		if (alone) pieces.push(alone);
		// 本帧也失败：留待与下一帧合并（可能是被假魔数截断的帧）。
		else pending = frame;
	}
	// 0.5.9：收尾还剩 pending = 末帧单独解不出来（活动会话正在追加的半帧）。
	// 旧实现只记 mid-stream 丢弃，尾帧丢失恒为 droppedFrames=0（审查 B5）。
	if (pending !== null) dropped += 1;
	decodeFrames.dropped = dropped;
	// 拼接时补行分隔：帧边界未必恰在换行处（最后一行可能无结尾 \n），
	// 直接 concat 会把下一帧首行粘到上一帧末行（测试 0.5.0 丢数据根因）。
	// 0.5.4：改成收集 chunk 数组后一次 join——旧实现 `text += chunk` 再配
	// `text.endsWith("\n")`，每帧都要把已累积的整个字符串压平复制，9000+ 帧
	// 的会话因此退化成 O(n²)（实测 10.8MB 文件解析 68s，其中 decodeFrames
	// 45s + GC 18s）。
	const chunks = [];
	let needSeparator = false;
	for (const piece of pieces) {
		const chunk = piece.toString("utf8");
		if (chunk.length === 0) continue;
		if (needSeparator) chunks.push("\n");
		chunks.push(chunk);
		needSeparator = !chunk.endsWith("\n");
	}
	return chunks.join("");
}

/**
 * 可见文本提取（0.2.6 语义，与旧 index.js visibleTextOf 相同）：
 * user/message 与 assistant/message 的 data.message.content 数组里只取
 * type==="text" 的块；content 为字符串/消息为字符串时直取；结构不可识别返回 null。
 */
export function visibleTextOf(event) {
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
	return null;
}

/** 解析单个会话文件 → 索引。文件读取/解压失败抛错（调用方记入条目 error）。 */
export function parseSessionFile(path) {
	const buf = readFileSync(path);
	const text = decodeFrames(buf);
	const entries = [];
	const turnStarts = [];
	// 0.5.10：会话标题/摘录（见下方 session/title 分支与函数尾部的摘录计算）。
	let logTitle = "";
	let totalEvents = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		let event;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue; // 半行/脏行跳过
		}
		totalEvents += 1;
		const type = typeof event?.type === "string" ? event.type : "";
		const seq = Number(event?.seq);
		if (type === "turn/start") {
			const turn = Number(event?.data?.turn);
			if (Number.isFinite(turn) && Number.isFinite(seq)) turnStarts.push({ seq, turn });
			continue;
		}
		if (type === "session/title") {
			// 0.5.10：标题生成器把结果写进日志的 session/title 事件（data.title），
			// 这是磁盘上唯一可靠的标题来源——宿主 readTitleSnapshots 对未加载会话
			// 常返回空标题，旧实现于是退化成 cwd 目录名，看起来像「把工作区名当成
			// 对话名」。取最后一条（标题可能被重新生成）。
			const t = event?.data?.title;
			if (typeof t === "string" && t.trim().length > 0) logTitle = t.replace(/s+/gu, " ").trim();
			continue;
		}
		if (type !== "user/message" && type !== "assistant/message") continue;
		const text2 = visibleTextOf(event);
		if (text2 === null || text2.trim().length === 0) continue;
		// 0.5.2：记录消息来源。user/message 的 data.source.kind 区分真实用户输入
		// ("user") 与 DSH 注入的上下文（agent-instructions / plugin:记忆 /
		// runtime-context / skill-catalog / time-context / user-approval 等）；
		// assistant/message 统一记 "assistant"。旧日志缺 source 时按 "user" 兜底，
		// 保证老会话不会因为字段缺失而被整体过滤掉。
		const rawKind = event?.data?.source?.kind;
		const source =
			type === "assistant/message"
				? "assistant"
				: typeof rawKind === "string" && rawKind.length > 0
					? rawKind
					: "user";
		entries.push({
			seq: Number.isFinite(seq) ? seq : 0,
			type,
			source,
			time: typeof event?.time === "number" ? event.time : null,
			text: text2.length > MAX_INDEX_TEXT ? text2.slice(0, MAX_INDEX_TEXT) : text2,
		});
	}
	entries.sort((a, b) => a.seq - b.seq);
	turnStarts.sort((a, b) => a.seq - b.seq);
	// 0.5.10：无标题时的摘录——首条真实用户消息前 40 字（比 cwd 目录名更能
	// 说明「这是哪个会话」）。
	let excerpt = "";
	for (const entry of entries) {
		if (entry.source !== "user") continue;
		excerpt = entry.text.replace(/s+/gu, " ").trim();
		if (excerpt.length > 40) excerpt = excerpt.slice(0, 40) + "…";
		break;
	}
	// 0.5.3：droppedFrames > 0 表示切帧时丢弃过假魔数残段（数据可能不完整），
	// 仅作诊断信号，不阻断搜索。
	const droppedFrames = decodeFrames.dropped || 0;
	return { entries, turnStarts, totalEvents, droppedFrames, title: logTitle, excerpt };
}

/**
 * 取指定会话的索引（mtime/size 校验失效重建）。异步：优先走后台 worker
 * （zstd 解压是 CPU 密集活，主进程同步跑会拖死 DSH 事件循环），worker 不可用
 * 时回退主进程同步解析。返回：
 *  - { index: {entries,turnStarts,totalEvents} } 或
 *  - { error: "…" }（文件缺失/解析失败/超时——调用方按无索引处理）。
 */
export async function getSessionIndex(path, mtimeMs, size, sessionId) {
	const cached = indexCache.get(path);
	if (cached && !cached.error && cached.mtimeMs === mtimeMs && cached.size === size) {
		cached.lastUsed = Date.now();
		return { index: cached };
	}
	if (cached && cached.error && cached.mtimeMs === mtimeMs && cached.size === size) {
		return { error: cached.error }; // 同一文件反复失败不重试（除非文件变化）
	}
	const file = { path, mtimeMs, size };
	if (!workerBroken) {
		const results = await requestIndexes([{ path, mtimeMs, size, sessionId }], INDEX_TIMEOUT_MS);
		const msg = results && results.find((m) => m.sessionId === sessionId);
		if (msg && msg.ok) {
			cachePut(file, sessionId, msg.index);
			return { index: msg.index };
		}
		if (msg && !msg.ok) {
			indexCache.set(path, { error: msg.error, mtimeMs, size, lastUsed: Date.now() });
			return { error: msg.error };
		}
		// 0.5.9：null 的含义分两种——workerBroken（永久降级）走下面的主线程
		// 同步回退；仅退避窗口内（breakWorker 刚发生、workerRetryAt 未到）则
		// **不解析也不缓存**，等 worker 重启后重试。旧实现在这里把 workerBroken
		// 置真，等于第一次退避就把「有限重启」整条路掐死（审查 B1）。
		if (results === null) {
			if (workerBroken) {
				// 落到下面同步回退
			} else {
				return { error: "worker restarting", retryable: true };
			}
		} else if (results.length === 0) {
			return { error: "indexing timeout", retryable: true };
		}
	}
	try {
		const index = parseSessionFile(path);
		cachePut(file, sessionId, index);
		return { index };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		indexCache.set(path, { error: message, mtimeMs, size, lastUsed: Date.now() });
		return { error: message };
	}
}

/**
 * 为主搜索建索引：目标 id 列表 + 扫描预算。优先一次批量提交给后台 worker
 * （主进程零阻塞；超时/预算内未解完的会话不返回条目，searchUncached 据此记
 * truncated，下次搜索靠缓存补齐）。worker 不可用时回退逐会话同步解析
 * （会话间让出事件循环）。返回 Map<sessionId, {index}|{error}>。
 */
export async function ensureIndexes(targetIds, deadline) {
	if (!Array.isArray(targetIds) || targetIds.length === 0) return new Map();
	const files = listSessionFiles();
	const byId = new Map(files.map((f) => [f.sessionId, f]));
	const out = new Map();
	const targets = [];
	for (const sessionId of targetIds) {
		const file = byId.get(sessionId);
		if (!file) {
			// 0.5.9：目录缺失/无可用日志——显式记一条 error，好让上层区分
			// 「没扫到（预算耗尽）」与「扫了但没内容」（审查 B3）。
			out.set(sessionId, { error: "session log not found", missing: true });
			continue;
		}
		const cached = indexCache.get(file.path);
		if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
			if (cached.error) out.set(sessionId, { error: cached.error });
			else {
				cached.lastUsed = Date.now();
				out.set(sessionId, { index: cached });
			}
			continue;
		}
		targets.push({ path: file.path, mtimeMs: file.mtimeMs, size: file.size, sessionId });
	}
	if (targets.length === 0 || Date.now() > deadline) return out;
	if (!workerBroken) {
		// 冷缓存全量批：worker 顺序解压（大文件 ~3s/个）。0.5.3：deadline 透传进
		// worker，超出预算即停（已解完的照常返回），不再等 30s+5s×N。
		const results = await requestIndexes(targets, INDEX_TIMEOUT_MS, deadline);
		if (results && results.length > 0) {
			const bySid = new Map(targets.map((t) => [t.sessionId, t]));
			for (const msg of results) {
				const file = bySid.get(msg.sessionId);
				if (!file) continue;
				if (msg.ok) {
					cachePut(file, msg.sessionId, msg.index);
					out.set(msg.sessionId, { index: msg.index });
				} else {
					indexCache.set(file.path, { error: msg.error, mtimeMs: file.mtimeMs, size: file.size, lastUsed: Date.now() });
					out.set(msg.sessionId, { error: msg.error });
				}
			}
			return out;
		}
		// results === null = worker 不可用（构造失败/退避窗口/崩溃已计数）；
		// results 为空数组 = worker 到点也没交出任何会话（0.5.4：预热队列堵住
		// worker 时实测如此——旧实现把它当「本批没有可搜会话」直接返回空 Map，
		// 于是搜索「已扫描 0 个会话 + 8s 后空结果」）。两种情况都退到主线程
		// 同步解析，预算仍由下面的 deadline 检查兜住。
	}
	// 同步回退：逐会话解析，会话之间让出事件循环（大文件 ~3s 连续占用）。
	for (const item of targets) {
		if (Date.now() > deadline) break;
		out.set(item.sessionId, await getSessionIndex(item.path, item.mtimeMs, item.size, item.sessionId));
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	return out;
}

/**
 * 后台预热：逐个会话提交给 worker（**串行**，等上一个返回再提交下一个）。
 * 0.5.4：旧实现一次把全部会话的消息灌进 worker 队列，用户随后触发的搜索
 * 请求排在几十个预热任务之后，8s 预算内 worker 一个都没轮到 → 搜索返回
 * 「已扫描 0 个会话」（实测复现）。串行 + 有在途请求时让路，保证搜索最多
 * 等一个文件的解析时间。fire-and-forget 永不抛错。
 */
const preindexState = { running: false };
export function preindexAll() {
	if (preindexState.running) return;
	preindexState.running = true;
	const run = async () => {
		const files = listSessionFiles();
		for (const file of files) {
			if (workerBroken) return;
			// 有在途请求（通常是用户搜索）：先让路，等它交付后再继续预热。
			while (pendingReqs.size > 0) await new Promise((resolve) => setTimeout(resolve, 50));
			const cached = indexCache.get(file.path);
			if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) continue;
			const results = await requestIndexes([{ path: file.path, mtimeMs: file.mtimeMs, size: file.size, sessionId: file.sessionId }], 120000).catch(() => null);
			const msg = results && results[0];
			if (msg && msg.ok) cachePut(file, file.sessionId, msg.index);
		}
	};
	run()
		.catch(() => {
			/* 预热失败不影响服务 */
		})
		.finally(() => {
			preindexState.running = false;
		});
}

/** 诊断：当前索引缓存状态。 */
export function indexStats() {
	let indexed = 0;
	let errored = 0;
	for (const value of indexCache.values()) {
		if (value.error) errored += 1;
		else indexed += 1;
	}
	return { indexed, errored, root: sessionsRoot() };
}
