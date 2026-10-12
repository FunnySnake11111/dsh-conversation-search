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

/** 搜索请求：query 为字面子串（大小写不敏感、空白弹性，多词 AND）；scope 决定扫描范围；offset 支持分段继续扫描；exact 为 0.1.x 兼容位；mode 三态（loose 宽松 / exact 精确 / regex 正则）优先于 exact。 */
export const searchRequestSchema = z.object({
  query: z.string().min(1).max(200),
  scope: z.enum(['current', 'all']).default('all'),
  sessionId: z.string().min(1).max(160).optional(),
  limit: int.min(1).max(5000).optional(),
  offset: int.min(0).max(100000).optional(),
  exact: z.boolean().optional(),
  mode: z.enum(['loose', 'exact', 'regex']).optional(),
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
})

export const searchResultSchema = z.object({
  hits: z.array(searchHitSchema),
  scanned: int.min(0),
  truncated: z.boolean(),
  elapsedMs: int.min(0),
  hostVersion: z.string().max(32).optional(),
})

const strictCodec = (name, schema) => ({
  mode: 'strict',
  typeSymbol: 'dsh-conversation-search#' + name,
  schema,
  create: () => schema,
})
const _searchRequest$codec = strictCodec('SearchRequest', searchRequestSchema)
const _searchResult$codec = strictCodec('SearchResult', searchResultSchema)

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
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
