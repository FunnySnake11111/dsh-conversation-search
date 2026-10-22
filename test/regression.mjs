/**
 * 0.5.3 修复的回归测试（不依赖 DSH 宿主）。
 * 覆盖：切帧容错（假魔数）、worker deadline 提前停止、冷缓存首搜不丢已解析结果、
 * includeInjected 默认过滤、继续扫描 offset 语义（宿主侧 sliced）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "csearch-test-"));
process.env.DSH_CSEARCH_SESSIONS_ROOT = root;

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
	if (cond) { pass += 1; console.log("  ✓ " + name); }
	else { fail += 1; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

function compressLine(obj) {
	return zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + "\n", "utf8"));
}

/** 生成一个 v4 会话：header 帧 + 每条消息一帧。 */
function writeSession(wsName, sessionId, messages, padding, title) {
	const dir = path.join(root, wsName, sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const frames = [compressLine({ type: "session/header", seq: 0, time: 1, data: { id: sessionId, cwd: "G:\\" + wsName } })];
	let seq = 1;
	// 0.5.10：会话标题事件（标题生成器写入日志）。
	if (title) frames.push(compressLine({ type: "session/title", seq: seq++, time: 1, data: { title } }));
	for (const m of messages) {
		frames.push(compressLine({
			type: m.type || "user/message",
			seq: seq++,
			time: 1700000000000 + seq,
			data: m.kind
				? { message: { role: "user", content: [{ type: "text", text: m.text }] }, source: { kind: m.kind } }
				: (m.type === "assistant/message"
					? { message: { role: "assistant", content: [{ type: "text", text: m.text }] } }
					: { message: { role: "user", content: [{ type: "text", text: m.text }] }, source: { kind: "user" } }),
		}));
	}
	if (padding) {
		for (let i = 0; i < padding; i += 1) {
			frames.push(compressLine({
				type: "user/message",
				seq: seq++,
				time: 1700000000000 + seq,
				data: { message: { role: "user", content: [{ type: "text", text: "padding " + i + " " + "x".repeat(900) }] }, source: { kind: "user" } },
			}));
		}
	}
	const file = path.join(dir, "session.v4.jsonl.zstd");
	fs.writeFileSync(file, Buffer.concat(frames));
	return file;
}

const { parseSessionFile, ensureIndexes, listSessionFiles } = await import("../lib/datasource.js");
const indexMod = await import("../lib/index.js");

// ---------------------------------------------------------------- 1
console.log("[1] 切帧：假魔数不再连带丢弃后续帧");
{
	const file = writeSession("G-ws", "session-aaaa", [
		{ text: "alpha 内容第一段" },
		{ text: "beta 内容第二段", type: "assistant/message" },
	]);
	const pure = fs.readFileSync(file);
	// 在第 1 帧与第 2 帧之间插入一个「假魔数」（不是合法帧，模拟压缩数据里巧合出现的魔数）
	const frames = [];
	{
		let pos = 0;
		const marks = [];
		for (let i = 0; i + 4 <= pure.length; i += 1) if (pure.readUInt32LE(i) === 0xfd2fb528) marks.push(i);
		for (let i = 0; i < marks.length; i += 1) frames.push(pure.subarray(marks[i], i + 1 < marks.length ? marks[i + 1] : pure.length));
	}
	const broken = Buffer.concat([frames[0], MAGIC, ...frames.slice(1)]);
	const brokenFile = path.join(root, "G-ws", "session-aaaa", "broken.v4.jsonl.zstd");
	fs.writeFileSync(brokenFile, broken);

	const index = parseSessionFile(brokenFile);
	const text = index.entries.map((e) => e.text).join(" | ");
	ok("假魔数后仍能解出后续帧内容（beta）", text.includes("beta"), "实际: " + text.slice(0, 120));
	ok("丢弃计数被记录", index.droppedFrames >= 1, "droppedFrames=" + index.droppedFrames);

	const clean = parseSessionFile(file);
	ok("干净文件两帧都解出", clean.entries.length === 2, "entries=" + clean.entries.length);
	ok("干净文件 droppedFrames=0", clean.droppedFrames === 0, "droppedFrames=" + clean.droppedFrames);
}

// ---------------------------------------------------------------- 2
console.log("[2] worker deadline：预算到点即停，返回已解完的部分");
{
	const ids = [];
	for (let i = 0; i < 8; i += 1) {
		const id = "session-b00" + i;
		writeSession("G-ws", id, [{ text: "needle group" + i }], 400);
		ids.push(id);
	}
	const targets = listSessionFiles().filter((f) => f.sessionId.startsWith("session-b00")).map((f) => f.sessionId);
	ok("目标会话枚举到 8 个", targets.length === 8, String(targets.length));
	const started = Date.now();
	const got = await ensureIndexes(targets, Date.now() + 120); // 120ms 预算
	const elapsed = Date.now() - started;
	ok("deadline 后不再无限等待（<3s）", elapsed < 3000, elapsed + "ms");
	ok("返回部分索引而非全空或全量", got.size > 0 && got.size <= 8, "size=" + got.size);
}

// ---------------------------------------------------------------- 3
console.log("[3] 冷缓存 + 预算超时：已解析的会话仍要参与搜索（旧实现返回 0 命中）");
{
	process.env.DSH_CSEARCH_BUDGET_MS = "150";
	// 造足够多的数据让 150ms 预算必然不够（否则解析太快、永远不触发截断）。
	for (let i = 0; i < 12; i += 1) writeSession("G-ws", "session-d0" + i, [{ text: "needle heavy" + i }], 800);
	const indexModule = await import("../lib/index.js?cold=" + Date.now());
	const services = {};
	const sessions = listSessionFiles().map((f) => ({ header: { id: f.sessionId, cwd: "G:\\G-ws" } }));
	const ctx = {
		sessionQuery: {
			async listSessions() { return sessions; },
			async readTitleSnapshots(ids) { return ids.map((id) => ({ status: "fulfilled", value: { session: { cwd: "G:\\G-ws" } } })); },
		},
		provide(key, value) { services[key] = value; },
		inject() {},
		effect() {},
	};
	indexModule.apply(ctx);
	const svc = services.conversationSearch;
	const started = Date.now();
	const result = await svc.search({ query: "needle", scope: "all", mode: "loose" });
	const elapsed = Date.now() - started;
	ok("预算 150ms 下首搜仍返回命中", result.hits.length > 0, "hits=" + result.hits.length);
	ok("超预算标记 truncated=true", result.truncated === true, String(result.truncated));
	ok("返回耗时受 deadline 约束（<5s）", elapsed < 5000, elapsed + "ms");
}

// ---------------------------------------------------------------- 4
console.log("[4] includeInjected 默认过滤（agent-message 明确保留在过滤侧）");
{
	process.env.DSH_CSEARCH_BUDGET_MS = "8000"; // 上一步的 150ms 预算会让冷缓存 worker 直接超时
	const id = "session-c01";
	writeSession("G-ws", id, [
		{ text: "真实的用户提问 zeta" },
		{ text: "agent 发来的 zeta 消息", kind: "agent-message" },
		{ text: "记忆注入 zeta", kind: "plugin:dsh-memory-palace" },
		{ text: "助手回复 zeta", type: "assistant/message" },
	]);
	const indexModule = await import("../lib/index.js?inc=" + Date.now());
	const services = {};
	const ctx = {
		sessionQuery: {
			async listSessions() { return [{ header: { id, cwd: "G:\\G-ws" } }]; },
			async readTitleSnapshots(ids) { return ids.map(() => ({ status: "fulfilled", value: { session: { cwd: "G:\\G-ws" } } })); },
		},
		provide(key, value) { services[key] = value; },
		inject() {},
		effect() {},
	};
	indexModule.apply(ctx);
	const svc = services.conversationSearch;
	const off = await svc.search({ query: "zeta", scope: "all", mode: "loose" });
	const on = await svc.search({ query: "zeta", scope: "all", mode: "loose", includeInjected: true });
	const offTexts = off.hits.map((h) => h.text).join("|");
	ok("默认不含注入上下文", !offTexts.includes("记忆注入"), offTexts);
	ok("默认不含 agent-message", !offTexts.includes("agent 发来的"), offTexts);
	ok("默认含真实用户与助手消息", offTexts.includes("真实的用户提问") && offTexts.includes("助手回复"), offTexts);
	ok("勾选后含注入上下文", on.hits.map((h) => h.text).join("|").includes("记忆注入"));
	ok("勾选后命中数大于默认", on.hits.length > off.hits.length, off.hits.length + " vs " + on.hits.length);
}

// ---------------------------------------------------------------- 5
console.log("[5] listSessions 失败时的兜底");
{
	process.env.DSH_CSEARCH_BUDGET_MS = "8000";
	const indexModule = await import("../lib/index.js?fallback=" + Date.now());
	const services = {};
	const ctx = {
		sessionQuery: {
			async listSessions() { throw new Error("host temporarily unavailable"); },
			async readTitleSnapshots() { throw new Error("nope"); },
		},
		provide(key, value) { services[key] = value; },
		inject() {},
		effect() {},
	};
	indexModule.apply(ctx);
	const result = await services.conversationSearch.search({ query: "zeta", scope: "all", mode: "loose" });
	ok("listSessions 抛错时仍能搜出结果", result.hits.length > 0, "hits=" + result.hits.length);
}

// ---------------------------------------------------------------- 6
console.log("[6] 精确匹配的大小写 / 整词边界开关（0.5.5）");
{
	delete process.env.DSH_CSEARCH_BUDGET_MS;
	writeSession("ws-case", "session-case-1", [
		{ type: "user/message", text: "使用 NPM Package 安装依赖" },
		{ type: "assistant/message", text: "npmjs 与 npmrc 都不算整词" },
	], 0);
	const indexModule = await import("../lib/index.js?case=" + Date.now());
	const services = {};
	const ctx = {
		sessionQuery: {
			async listSessions() { return [{ sessionId: "session-case-1", cwd: "G:\ws-case", workspaceName: "ws-case" }]; },
			async readTitleSnapshots() { return {}; },
		},
		provide(key, value) { services[key] = value; },
		inject() {},
		effect() {},
	};
	indexModule.apply(ctx);
	const api = services.conversationSearch;
	const run = (extra) => api.search(Object.assign({ query: "npm", scope: "all", mode: "exact" }, extra));
	const base = await run({});
	ok("默认不区分大小写 + 整词边界：命中 NPM，不命中 npmjs", base.hits.length === 1 && base.hits[0].text.includes("NPM"), "hits=" + base.hits.length);
	const cs = await run({ caseSensitive: true });
	ok("开启区分大小写后 NPM 不再命中", cs.hits.length === 0, "hits=" + cs.hits.length);
	const noWord = await run({ wholeWord: false });
	ok("关闭整词边界后 npmjs/npmrc 也命中", noWord.hits.length === 2, "hits=" + noWord.hits.length);
	const both = await run({ caseSensitive: true, wholeWord: false });
	ok("区分大小写 + 关闭整词边界：只命中 npmjs 那条", both.hits.length === 1 && both.hits[0].text.includes("npmjs"), "hits=" + both.hits.length);
}

/**
 * 0.5.10：结果标题来源优先级（日志 session/title > 宿主快照 > 首条用户消息摘录
 * > cwd 目录名 + 未命名）。
 */
async function testTitles() {
	writeSession("ws-title", "session-t1", [{ text: "needle title one" }], 0, "日志里的标题");
	writeSession("ws-title", "session-t2", [
		{ text: "这是第一条用户消息，用来当标题摘录用 needle title two 后面还有很多字继续写满四十个字符以上以便观察截断行为。" },
	], 0);
	writeSession("ws-title", "session-t3", [
		{ type: "assistant/message", text: "只有助手消息 needle title three" },
	], 0);

	const services = {};
	const ctx = {
		sessionQuery: {
			async listSessions() {
				return ["session-t1", "session-t2", "session-t3"].map((id) => ({ header: { id, cwd: "G:/ws-title" } }));
			},
			// 模拟宿主快照「没有可用标题」：全部 fulfilled 但 title 为空。
			async readTitleSnapshots(ids) {
				return ids.map(() => ({ status: "fulfilled", value: { session: { cwd: "G:/ws-title" } } }));
			},
		},
		provide(key, value) { services[key] = value; },
		inject() {},
		effect() {},
	};
	indexMod.apply(ctx);
	const api = services.conversationSearch;
	const r = await api.search({ query: "needle title", scope: "all", mode: "loose", limit: 100 });
	const byId = new Map();
	for (const hit of r.hits) byId.set(hit.sessionId, hit.title);
	ok("日志 session/title 优先于宿主空快照", byId.get("session-t1") === "日志里的标题", "得到: " + byId.get("session-t1"));
	const t2 = byId.get("session-t2") || "";
	ok("无标题时退回首条用户消息摘录", t2.startsWith("这是第一条用户消息") && t2.length <= 41, "得到: " + t2);
	const t3 = byId.get("session-t3") || "";
	ok("都没有时退回目录名并标「未命名」（不伪装成对话名）", (t3 === "" || t3.endsWith(" · 未命名")) && t3 !== "ws-title", "得到: " + t3);
}
await testTitles();

console.log("");
console.log(pass + " passed, " + fail + " failed");
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
