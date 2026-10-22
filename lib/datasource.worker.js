/**
 * dsh-conversation-search — 索引后台线程（0.5.1）。
 *
 * 由 lib/datasource.js 经 worker_threads 启动（workerData.root = 会话根目录）。
 * 职责单一：逐文件读取 + 切帧解压 + JSONL 解析（parseSessionFile），把索引
 * 回传给主进程。zstd 解压是 CPU 密集活（最大单会话 ~2.8s），放这里跑，
 * DSH 主进程事件循环零阻塞（0.5.0 在主进程同步预热导致启动/搜索卡顿的教训）。
 *
 * 协议：收到 {reqId, list:[{path,mtimeMs,size,sessionId}]}，逐条回传
 * {reqId, sessionId, ok:true, index} 或 {reqId, sessionId, ok:false, error}。
 */
import { parentPort } from "node:worker_threads";
import { parseSessionFile } from "./datasource.js";

parentPort.on("message", (msg) => {
	const reqId = msg && msg.reqId;
	const list = msg && Array.isArray(msg.list) ? msg.list : [];
	const deadline = msg && Number(msg.deadline) > 0 ? Number(msg.deadline) : 0;
	for (const item of list) {
		// 0.5.3：每文件边界检查调用方预算——超时立即停，把「已解完的」交回去，
		// 而不是像旧实现那样把整批跑完（64 会话 ≈ 350s）后调用方已过 deadline。
		if (deadline > 0 && Date.now() > deadline) {
			parentPort.postMessage({ reqId, done: true });
			return;
		}
		let out;
		try {
			const index = parseSessionFile(item.path);
			out = { reqId, sessionId: item.sessionId, ok: true, index };
		} catch (error) {
			out = {
				reqId,
				sessionId: item.sessionId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		parentPort.postMessage(out);
	}
	parentPort.postMessage({ reqId, done: true });
});
