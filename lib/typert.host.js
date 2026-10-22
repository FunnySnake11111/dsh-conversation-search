/**
 * dsh-conversation-search 的 Host 面 Typert 清单。
 * Hand-written manifest, structurally identical to the @deepseek-ai/dsh-typert-generator
 * output: `./typert` exports TYPERT; strict codecs carry both the schema and a
 * `create()` factory. Bare zod schemas are rejected by typert-loader, so every
 * parameter/result codec is wrapped by `strictCodec`.
 */

import { z } from 'zod'

const num = z.number()
const int = z.number().int()

/** 搜索请求：query 为字面子串（宽松模式大小写不敏感、空白弹性，多词 AND）；scope 决定扫描范围；offset 支持分段继续扫描；exact 为 0.1.x 兼容位；mode 三态（loose 宽松 / exact 精确 / regex 正则）优先于 exact；includeInjected 为 true 时把 DSH 注入的上下文（记忆、技能清单、运行时上下文等）也纳入搜索；caseSensitive / wholeWord 只作用于 exact 模式（默认不区分大小写、开启整词边界）。 */
export const searchRequestSchema = z.object({
  query: z.string().min(1).max(200),
  scope: z.enum(['current', 'all']).default('all'),
  sessionId: z.string().min(1).max(160).optional(),
  limit: int.min(1).max(5000).optional(),
  offset: int.min(0).max(100000).optional(),
  exact: z.boolean().optional(),
  mode: z.enum(['loose', 'exact', 'regex']).optional(),
  includeInjected: z.boolean().optional(),
  // 0.5.5：精确匹配（mode === 'exact'）的大小写与整词边界开关。
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
})

/** 单条命中：seq 为会话日志内事件序号，text/snippet 已截断。 */
export const searchHitSchema = z.object({
  sessionId: z.string().min(1).max(160),
  seq: int.min(0),
  type: z.string().max(96),
  time: z.union([num, z.null()]).optional(),
  surface: z.enum(['current', 'shadowed', 'log-only']),
  text: z.string().max(2200),
  snippet: z.string().max(340),
  title: z.string().max(220),
  seqFraction: num.min(0).max(1).optional(),
  turn: int.min(1).optional(),
  turnSeq: int.min(0).optional(),
})

export const searchResultSchema = z.object({
  hits: z.array(searchHitSchema),
  scanned: int.min(0),
  truncated: z.boolean(),
  elapsedMs: int.min(0),
  hostVersion: z.string().max(32).optional(),
})

/** 0.3.1 诊断回传：client 半定位链路日志行（已含 ISO 时间戳与级别前缀）。 */
export const diagPayloadSchema = z.object({
  lines: z.array(z.string().min(1).max(4000)).min(1).max(400),
})
export const diagResultSchema = z.object({
  written: int.min(0),
  // 0.4.1：写失败时携带具体错误（写权限/网关拒绝），证据链不静默。
  error: z.string().max(300).optional(),
})

const strictCodec = (name, schema) => ({
  mode: 'strict',
  typeSymbol: 'dsh-conversation-search#' + name,
  schema,
  create: () => schema,
})
const _searchRequest$codec = strictCodec('SearchRequest', searchRequestSchema)
const _searchResult$codec = strictCodec('SearchResult', searchResultSchema)
const _diagPayload$codec = strictCodec('DiagPayload', diagPayloadSchema)
const _diagResult$codec = strictCodec('DiagResult', diagResultSchema)

export const TYPERT = {
  package: 'dsh-conversation-search',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-conversation-search#conversationSearch/search',
      service: 'conversationSearch',
      namespace: 'conversationSearch',
      method: 'search',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'request', wire: 'request', source: 'json', codec: _searchRequest$codec },
      ],
      result: _searchResult$codec,
    },
    {
      // 0.3.1：诊断回传（client 渲染进程 console 不可达，落盘供 AI 直读）。
      id: 'dsh-conversation-search#conversationSearch/pushDiag',
      service: 'conversationSearch',
      namespace: 'conversationSearch',
      method: 'pushDiag',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'payload', wire: 'payload', source: 'json', codec: _diagPayload$codec },
      ],
      result: _diagResult$codec,
    },
  ],
  model: {
    services: [
      {
        description: 'dsh-conversation-search 搜索服务(ctx.conversationSearch)：跨会话字面文本搜索。Search service (ctx.conversationSearch): cross-session literal-text search.',
        summary: 'dsh-conversation-search 搜索服务 (dsh-conversation-search search service)。',
        tags: [],
        jsDoc: '/** dsh-conversation-search 搜索服务(ctx.conversationSearch)。dsh-conversation-search search service (ctx.conversationSearch). */',
        key: 'conversationSearch',
        exportName: 'ConversationSearchService',
        members: [
          {
            kind: 'method',
            name: 'search',
            signature: 'search(request: SearchRequest): Promise<SearchResult>',
            summary: '字面文本搜索会话历史，返回命中列表与扫描统计。Literal-text search over session history returning hits and scan stats.',
            jsDoc: '/**\n * 字面文本搜索会话历史。\n * @param request - query/scope/sessionId/limit/offset/exact。\n * @returns 命中列表（含会话标题与片段）、已扫会话数与截断标记。\n * Literal-text search over session history.\n * @param request - query/scope/sessionId/limit/offset/exact.\n * @returns Hits (with session titles and snippets), scanned session count and a truncation flag.\n */',
          },
          {
            kind: 'method',
            name: 'pushDiag',
            signature: 'pushDiag(payload: DiagPayload): Promise<DiagResult>',
            summary: '接收 client 半诊断日志行并追加写入 .diag.log（诊断通道，失败静默）。Receive client-side diagnostic log lines and append them to .diag.log (diagnostics channel, silent on failure).',
            jsDoc: '/**\n * 接收 client 半诊断日志行并追加写入插件根 .diag.log。\n * @param payload - lines: 日志行数组（已含时间戳）。\n * @returns 实际写入行数。\n * Receive client diagnostic log lines and append to .diag.log.\n */',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
