# dsh-conversation-search

DeepSeek Harness 桌面版**会话搜索插件**：在聊天界面内搜索当前与全部历史会话的消息文本，点击结果**自动切换会话、滚动定位到命中消息并高亮**。

Conversation search plugin for DeepSeek Harness Desktop: search the current and all historical sessions, click a hit to auto-navigate, scroll to and highlight the matching message.

## 功能特性

- **搜索模式三态**（单选 chip，覆盖不同精度需求）：
  - **宽松**（默认）：大小写不敏感、空白弹性多词 AND、全事件类型召回（含工具调用与结果）；
  - **精确搜索模式**：仅用户/助手消息（排除工具调用参数 JSON 等结构性事件）；区分大小写；整词边界（`npm` 不命中 `npmjs`，中文子串不受影响）；空白不弹性；
  - **正则**：对会话文本执行你输入的正则表达式（区分大小写、模式 ≤200 字符、语法错误在状态栏提示）；
- **跨会话定位**：点击结果自动切换到目标会话，渐进滚动（含向上翻页加载）到命中消息并高亮 2.6 秒；
- **FTS5 候选快速路径**：「全部会话」范围下自动用官方 SQLite 全文索引毫秒级筛出候选会话，再对候选拿做字面精扫——字面语义不变，速度大幅提升；
- **范围切换**：当前会话（默认）/ 全部会话；
- **细节**：面板语言跟随宿主中/英文即时切换；状态栏回显宿主半版本号（识别陈旧宿主）；浅/深主题自适应；子代理会话自动排除（无法独立打开，点击只会得到错误页）。

## 安装

```powershell
# 方式一：本地源码 link 安装（开发/本机使用，DSH 桌面完全退出后运行）
git clone https://github.com/FunnySnake11111/dsh-conversation-search.git
dsh plugin --profile desktop add link:<克隆目录>

# 方式二：使用仓库自带脚本（在克隆目录内运行；含宿主运行检测、BOM 自愈、profile 备份）
.\install.ps1
# 回滚：
.\rollback.ps1
```

安装后**完全重启 DSH** 生效（宿主半只在进程启动时加载一次，只刷新页面不够——面板状态栏的版本号可用来确认宿主半是否已重载）。

## 使用

1. 点输入框旁工具栏的**放大镜按钮**打开搜索面板（唯一入口，无快捷键）；
2. 选择范围与搜索模式（默认：当前会话 + 宽松）；
3. 输入关键词自动搜索（320ms 防抖），↑↓ 选择、Enter 定位，或直接点击结果；
4. Esc 关闭面板；命中数达 30 条上限或扫描超时（8s）时点「继续扫描」续扫。

> 提示：状态栏显示扫描统计、当前模式名（非宽松时）与宿主半版本号（如 `v0.2.1`）。

## 工作原理

| 部分 | 说明 |
|---|---|
| host 半 `lib/index.js` | 经可选注入的官方 `ctx.sessionQuery` 服务做扫描（核心 bundle 已挂载 SQLite FTS5 后端）；`ctx.provide('conversationSearch')` + 手动 `ctx.typert.register()` 注册清单；三态搜索 + FTS5 候选快速路径（`searchSessions` 找候选 → `filterEvents` 字面精扫）；子代理会话（`header.origin === "subagent"`）排除 |
| client 半 `lib/client.js` | `shell.overlay` slot 注册面板 + `conversation.composer.dock` slot 注册触发按钮；typert 贡献经 `ctx.remote.$mount(描述符)` 建立命名空间；面板语言跟随宿主 locale 服务动态切换 |
| 定位 | `uiWorkspace.openSession`（幂等）→ 等待 `[data-chat-flow]` → 当前视口向下扫 → 渐进向上（触发宿主 paging）→ 命中行 `scrollIntoView` 居中 + Web Animations 高亮；新定位自动中止旧定位 |

设计原则：纯官方 ctx API + 纯 DOM 锚点（`data-chat-flow` / `data-chat-flow-kind`），不碰 React 内部、不解析会话文件格式；任何插件内失败只降级自身，绝不影响宿主启动。

## 已知边界

- 子代理会话（Agent Teams 成员、子代理分身）不能作为主会话在对话区打开（宿主拒绝 `session/agent-busy`），故不在搜索范围；
- FTS5 候选按分词短语匹配：多词查询中「词距很远」、单词查询中「词中词」（npm 只出现在 pnpm 内部）的极端会话可能不在候选内——多词零候选自动回退全量扫描，正则模式始终全量；
- 命中位于折叠的过程区时，DOM 定位可能失败（诊断在 DevTools console 的 `[dsh-conversation-search]` 行）；
- 命中数上限 30 条 / 单次扫描预算 8 秒，超出用「继续扫描」续扫。

## 更新记录

- **0.2.1** 语言跟随修复：面板挂载时补读当前语言 + `resolveActive()` 多信号取值（修复 client 激活早期 locale 服务未挂载导致的英文误判）。
- **0.2.0** 搜索模式三态（宽松/精确/正则）；FTS5 候选快速路径（`searchSessions` 候选 + 字面精扫）；排除子代理会话；多词零候选自动回退全量扫描。
- **0.1.11** 面板语言跟随宿主动态切换。
- **0.1.9** 定位诊断日志；定位失败不再弹回面板；过期定位自动中止。
- **0.1.8** 精确模式收窄到用户/助手消息。
- **0.1.4–0.1.7** 精确模式引入与修复（TDZ、版本回显、标题兜底）。
- **0.1.0–0.1.2** 首个版本：搜索面板、跨会话定位、主题适配。

## License

[MIT](LICENSE)
