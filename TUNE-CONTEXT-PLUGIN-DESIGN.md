# Tune Context Plugin — 技术实现方案 v3

## 概述

轻量级 context 管理插件，核心思路是 **Part 级选择性修剪**：保留高价值信号（用户意图、决策依据、代码变更），修剪低价值噪音（tool 输出原文、LLM 思考链、文件快照）。

### 设计原则

- **信号保留**：不产生新的压缩摘要文本，只对已存在的 Parts 做分类取舍
- **多模型兼容**：依赖 `model.limit.context` 动态计算阈值，按 context 大小分档自适应
- **无外部依赖**：不依赖 Anthropic tokenizer、XML 标签机制等外部组件
- **API 对齐**：仅使用 `@opencode-ai/plugin` 的 `Hooks` 接口中确认存在的 hooks

### 关键约束：UI 与 LLM 视图分离

`messages.transform` 修改的是**本轮 LLM 调用发送的消息内容**，会话数据库中的原始消息不受影响。这意味着：

```
UI / 会话记录：✅ 始终保存完整内容，用户回看无变化
LLM 推理输入：   被修剪后的版本，节省 token
compress tool 读取（client.session.messages()）：完整内容
```

这一约束使得修剪对用户完全透明——用户永远看到完整会话，只有 LLM 看到缩略版。

### API 约束与事实基础

| Hook / API | 状态 | 用途 |
|-----------|------|------|
| `event` | ✅ 可用 | 监听 session.created / session.updated / session.compacted |
| `experimental.chat.messages.transform` | ✅ 可用 | 修改 `output.messages[]` — 对 Parts 做修剪 |
| `experimental.chat.system.transform` | ✅ 可用 | 注入修剪策略到 system prompt；`input.model.limit.context` 可用 |
| `experimental.session.compacting` | ✅ 可用 | 注入 context 使用率提示；可覆盖 `output.prompt` |
| `compress` tool | ✅ 可用 | LLM 手动触发定性压缩 |
| `client.session.messages({ sessionID })` | ✅ 只读 | 用于 compress tool 读取完整消息列表 |
| `client.session.prompt({ sessionID, parts })` | ✅ 可用 | compress tool 调用 LLM 生成摘要 |

### 行为总览

```
event (session.created)              → 闭包缓存 sessionId + parentID
event (session.updated)              → token 追踪（可选）+ 模型变更检测
experimental.chat.system.transform   → 注入修剪策略告知 + 缓存 model.limit.context
experimental.chat.messages.transform → 自动修剪低价值 Parts（有频率控制）
experimental.session.compacting      → 注入 context 使用率提示
compress tool                        → 按语义范围生成摘要
```

---

## 一、Part 分类与修剪策略（核心设计）

### 1.1 分类矩阵

| Part 类型 | 价值评级 | 修剪策略 | 理由 |
|-----------|---------|---------|------|
| `TextPart` (user) | **保留** | 保持完整 | 用户意图、需求、checklist、memo 的唯一载体 |
| `TextPart` (assistant) | **保留** | 保持完整 | AI 分析结论、决策依据，内容紧凑，体积小 |
| `PatchPart` | **保留** | 保持完整 | 文件变更记录，体积不大，后续决策需要参考 |
| `ReasoningPart` | **丢弃** | **直接删除** | LLM 每次重新推理，旧的思考链无复用价值；UI-only 层，API 调用不带 |
| `ToolPart` (read) | **修剪** | 截断 `state.output`，保留路径+行数摘要 | 文件内容已加载到 LLM 上下文一次，后续无需重复 |
| `ToolPart` (bash) | **修剪** | 截断 `state.output`，保留 exit code + 关键行 | 测试日志、构建输出在确认结果后即失效 |
| `ToolPart` (webfetch) | **修剪** | 截断 `state.output`，保留 URL + 摘要 | 类似 read，获取的远程内容仅在首次有用 |
| `ToolPart` (grep) | **保留** | 保持完整 | 匹配位置信息可能在后续被引用 |
| `ToolPart` (glob) | **保留** | 保持完整 | 文件路径结果可能在后续被引用 |
| `ToolPart` (websearch) | **保留** | 保持完整 | 搜索结果可能被后续引用 |
| `ToolPart` (edit) | **保留** | 保持完整 | output 天然简短（如"Applied edit to xxx.ts"），trim 收益为零 |
| `ToolPart` (write) | **保留** | 保持完整 | output 简短，trim 收益为零 |
| `ToolPart` (list) | **丢弃** | **直接删除** | 目录列表无长期价值 |
| `ToolPart` (apply_patch) | **丢弃** | **直接删除** | patch 应用后 output 无价值 |
| `ToolPart` (skill) | **保留** | 保持完整 | skill 内容可能被引用 |
| `ToolPart` (todowrite) | **保留** | 保持完整 | 任务列表 |
| `ToolPart` (question) | **保留** | 保持完整 | 用户问答 |
| `ToolPart` (task) | **保留** | 保持完整 | subagent 任务结果 |
| `ToolPart` (lsp) | **保留** | 保持完整 | LSP 代码智能结果 |
| `FilePart`（关联已完成 read 工具） | **丢弃** | **直接删除** | 内容已由 read 加载到上下文 |
| `FilePart`（独立/用户上传） | **保留** | 保持完整 | 用户主动 attach 的文件需要保留 |
| `SnapshotPart` | **丢弃** | **直接删除** | 体积大，仅用于回滚，当前推理不需要 |
| `StepStartPart` | **保留** | 保持完整 | step 边界信号，含 `snapshot?` |
| `StepFinishPart` | **保留** | 保持完整 | 含 `reason`, `cost`, `tokens`，步骤小结 |
| `RetryPart` | **保留** | 保持完整 | 重试记录含 `attempt`, `error` |
| `CompactionPart` | **保留** | 保持完整 | 携带上次 compaction 的信息 |
| `AgentPart` | **保留** | 保持完整 | subagent 执行结果，可能包含重要产出 |
| `SubtaskPart` | **保留** | 保持完整 | 子任务信息 |

### 1.2 修剪触发条件

```
token 使用率 >= thresholds.warn  →  修剪"保护轮次之外"的消息 Parts
token 使用率 >= thresholds.critical → 扩大修剪范围（减少保护轮次）
```

**频率控制**（防止高频无意义触发）：
- 每次触发时计算当前 token 总量
- 与上次修剪时的 token 量对比
- 增长 < 5% → 跳过，直接返回
- 增长 >= 5% → 执行修剪

**保护规则**：
- 前 `turnProtection` 轮不修剪，保护进行中的上下文
- "完成轮次"定义：该消息之后已有至少 2 轮后续消息，且关联 tool 均已返回 completed
- subagent session 的 turnProtection 减半

### 1.3 修剪 vs 压缩

```
修剪（prune）：从 Parts 中删除/截断低价值类型，保留原文。
               无信息失真，仅降低 token 总数。

压缩（compress）：LLM 生成摘要文本，替换原文。
                 有信息取舍，但可处理跨轮次的上下文关联。
```

两者互补：
- **修剪**：自动运行在 `messages.transform`，做保守的去噪
- **压缩**：LLM 通过 `compress` tool 手动触发，做激进的提炼

---

## 二、项目结构

```
tune-context-plugin/
├── package.json
│   - name: "@tune/context-plugin"
│   - dependencies: { "@opencode-ai/plugin": "^1.14.48" }
│   - main: "dist/index.js"
│
├── tsconfig.json
│   - target: ES2022
│   - module: ES2022
│   - outDir: dist
│   - strict: true
│
└── src/
    ├── index.ts                # 插件入口，注册 hooks + tools
    ├── config.ts               # 配置加载和默认值
    ├── state.ts                # Session 状态类型
    ├── persistence.ts          # 状态持久化
    ├── prompts.ts              # 提示词常量
    ├── token-tracker.ts        # Token 用量追踪
    ├── part-classifier.ts      # Part 分类器
    ├── part-trimmer.ts         # Part 修剪器
    ├── messages-transform.ts   # messages.transform hook 实现
    ├── system-transform.ts     # system.transform hook 实现
    ├── compacting-hook.ts      # compacting hook 实现
    ├── compress.ts             # compress tool 定义和实现
    └── session-events.ts       # event 钩子（session.created/updated）
```

---

## 三、各模块详细设计

### 3.1 插件入口 (`src/index.ts`)

```
初始化流程：
1. 加载配置
   - 项目级 .opencode/tune-context.json（优先）
   - 全局 ~/.config/opencode/tune-context.json（fallback）
2. 创建 plugin 级别的状态管理器（Map<sessionId, SessionState>）
3. 注册 hooks:
   - event                              → session-events.ts
   - experimental.chat.messages.transform → messages-transform.ts
   - experimental.chat.system.transform   → system-transform.ts
   - experimental.session.compacting      → compacting-hook.ts
4. 注册 tool:
   - compress                           → compress.ts
```

**sessionId 闭包捕获**：
- `event` hook 在 session.created 时得到 `properties.info.id`
- 存入 `Map<sessionId, SessionState>` 的 key
- `messages.transform` 从 `output.messages[0].info.sessionID` 或闭包取 sessionId

**subagent 识别**：
- `session.created` 事件中检查 `properties.info.parentID`
- 若存在，标记为 subagent 并记录父 session ID
- subagent 状态独立存储，但有独立配置段

### 3.2 配置加载 (`src/config.ts`)

**配置来源**：`~/.config/opencode/tune-context.json`，可选项目级 `.opencode/tune-context.json`

```json
{
  "thresholds": {
    "warn": null,
    "critical": null,
    "autoPrune": true
  },

  "turnProtection": null,

  "subagent": {
    "thresholds": { "warn": 0.60, "critical": 0.80 },
    "turnProtection": 4
  },

  "models": {
    "deepseek/deepseek-v4-flash": {
      "thresholds": { "warn": 0.80, "critical": 0.95 },
      "turnProtection": 10
    }
  },

  "compactionHintFrequency": 3,

  "permission": "allow",

  "debug": false
}
```

**默认阈值自动选择**（当 `null` 时）：

| Context limit | 模型示例 | warn | critical | turnProtection |
|--------------|---------|------|---------|---------------|
| ≤ 200K | GPT-4o-mini, GPT-4o, Claude Haiku | 0.60 | 0.80 | 4 |
| 200K-1M | Claude Sonnet, GPT-4.1 | 0.75 | 0.90 | 8 |
| ≥ 1M | DeepSeek V4, Gemini 2.5 Pro | 0.80 | 0.95 | 10 |

subagent 始终使用独立配置段（默认为 warn=0.60 / critical=0.80 / turnProtection=4）。

**context limit 解析优先级**：
1. `system.transform` 的 `input.model.limit.context`（运行时自动获取）
2. 配置中 per-model 的 contextLimit 覆盖值
3. 硬编码默认值 1M（fallback，需做 `<= 0` 保护）

**配置文件名**：使用 `.json` 而非 `.jsonc`。JSONC 需自行 strip comments，增加无谓复杂度。

### 3.3 Session 状态 (`src/state.ts`)

```typescript
interface SessionState {
  sessionId: string | null
  parentSessionId: string | null       // subagent 时记录父 session
  modelId: string | null
  contextLimit: number | null
  lastTokenUsage: number | null
  lastPruneTokenUsage: number | null   // 上次修剪时的 token 量（频率控制）
  totalPrunedTokens: number
  totalCompressedTokens: number
  lastCompactionHintAt: number | null
  compressedRanges: {
    topic: string
    startMessageId: string
    endMessageId: string
    compressed: boolean
  }[]
  stats: {
    pruneCallCount: number
    compressCallCount: number
    totalPrunedTokens: number
    totalCompressedTokens: number
  }
}
```

### 3.4 状态持久化 (`src/persistence.ts`)

**存储路径**：`~/.local/share/opencode/storage/plugins/tune-context/{sessionId}.json`

**保存时机**：
- `session.updated` 事件后（更新 token 用量）
- `messages.transform` 执行修剪后
- `compress` tool 执行后
- `compacting` hook 执行后

### 3.5 Part 分类器 (`src/part-classifier.ts`)

```typescript
type PartValue = "keep" | "trim" | "drop"

function classifyPart(
  part: Part,
  context: {
    messageRole: "user" | "assistant"
    turnIndex: number
    // 仅 ToolPart 时可用：关联的 FilePart ID 列表
    // 用于判断 FilePart 是否是 read 工具附带
    readAttachedFileIds?: Set<string>
  }
): PartValue
```

**分类逻辑**：

```
固定规则（按 Part type 判别）：
  type === "reasoning"                              → drop
  type === "snapshot"                               → drop
  type === "compaction"                             → keep
  type === "patch"                                  → keep
  type === "agent"                                  → keep
  type === "step-start"                             → keep
  type === "step-finish"                            → keep
  type === "retry"                                  → keep

  type === "subtask"                                → keep

  type === "file":
    part 存在于 read 工具的 attachments 中            → drop
    否则                                               → keep

  type === "text":
    messageRole === "user"                           → keep
    messageRole === "assistant"                      → keep

  type === "tool":
    state.status !== "completed"                      → keep（未完成工具不修剪）
    tool ∈ ["read", "bash", "webfetch"]              → trim（截断 output）
    tool ∈ ["list", "apply_patch"]                    → drop
    tool ∈ ["edit", "write", "grep", "glob",
            "websearch", "skill", "todowrite",
            "question", "task", "lsp"]               → keep

  default → keep（保守原则：不能识别的类型保留不动）
```

### 3.6 Part 修剪器 (`src/part-trimmer.ts`)

```typescript
function trimPart(part: ToolPart): ToolPart {
  // ToolState 是联合类型，需要先 narrow 到 ToolStateCompleted
  if (part.state.status !== "completed") return part

  switch (part.tool) {
    case "read": {
      // 从 state.title 提取文件路径（如 "Read /src/cart.ts"）
      // 从 output 中提取行数信息
      part.state.output = summarizeReadOutput(part.state.output, part.state.title)
      return part
    }
    case "bash": {
      // 保留 exit code + 最后 20 行（通常含错误信息或结论）
      part.state.output = trimToLastLines(part.state.output, 20)
      return part
    }
    case "webfetch": {
      // 保留 URL + 内容摘要
      part.state.output = summarizeWebfetchOutput(part.state.output, part.state.title)
      return part
    }
  }
}
```

注意事项：
- `summarizeReadOutput` 从 `title` (如 `Read /src/cart.ts`) 和 output 中提取文件路径和行数
- `trimToLastLines` 保留 exit code 和最后 N 行（通常是错误信息或结论）
- 截断后添加 `[trimmed by tune-context-plugin]` 标记，便于 system prompt 告知 LLM
- `ToolPart.state` 是联合类型，必须先用 `state.status === "completed"` 做类型收窄

### 3.7 Messages Transform (`src/messages-transform.ts`)

```
handler(input, output):
  1. 获取 sessionId（从 output.messages[0].info.sessionID 或闭包 Map）
  2. 加载该 session 的 state + config
  3. 计算当前 token 总量（通过 token-tracker）

  4. 频率控制：
     - 如果 state.lastPruneTokenUsage 存在
     - 且 token 增长 < 5%
     → 跳过修剪，直接返回

  5. 如果使用率 < thresholds.warn → 不处理，返回

  6. 确定修剪范围：
     a. 根据 context 大小计算 turnProtection
     b. subagent → 使用 subagent 配置
     c. 构建已完成 read 工具 → FilePart ID 映射表
        （用于判断 FilePart 是否可 drop）
     d. 遍历保护轮次之外的所有消息
     e. 对每条消息，获取 messageRole（msg.info.role）
     f. 对每条消息的 parts 执行 classify(part, { messageRole, turnIndex })
        → 按策略处理

  7. 如果使用率 >= thresholds.critical：
     - 减少保护轮次
     - 扩大修剪范围

  8. 更新 state：
     - state.lastPruneTokenUsage = currentTokenUsage
     - state.totalPrunedTokens
     - stats

  9. 返回修改后的 output.messages
```

**注意事项**：
- TextPart 的 role 来自其所属 Message（msg.info.role），非 Part 自身字段
- 跳过已被 `compress` tool 标记为已压缩的消息范围
- 如果已压缩范围被自动修剪触及，保留压缩摘要所在消息的 TextPart
- 不修改 `event` hook 收到的 `session.updated` 中的消息（只读事件）

### 3.8 System Transform (`src/system-transform.ts`)

```
handler(input, output):
  1. 从 input.model 获取 context limit + modelId
     → model.limit.context: number（需做 <= 0 容错）
     → model.id + model.providerID
  2. 缓存到 state（如果变更则重新计算阈值）
  3. 根据 context 大小选择告知文案：

     大 context (≥1M) → 强调注意力质量：
     "This session uses automatic context pruning to keep your
      attention focused. Older tool outputs, reasoning traces,
      and fetched web content are trimmed when context exceeds {warn}%.
      Your instructions, decisions, and file changes are preserved.
      Use the 'compress' tool to summarize resolved topics."

     小 context (≤200K) → 强调防止崩溃：
     "Context space is limited. Automatic pruning removes old tool
      outputs and reasoning traces when usage exceeds {warn}% to
      prevent hitting the context limit.
      Key information from previous steps is preserved.
      Re-read files if you need full content again."

  4. 文末统一追加：
     "Trimmed content is marked with [trimmed by tune-context-plugin]."

  5. 如果 autoPrune === false，使用替代文案：
     "Context pruning is disabled. Run the 'compress' tool before
      the session runs out of space."
```

### 3.9 Compacting Hook (`src/compacting-hook.ts`)

```
handler(input, output):
  1. 获取 sessionId → 加载 state
  2. 获取当前 token 用量（从 state 中读取）
  3. 如果达到 compactingHintFrequency 间隔 → 注入提示
  4. output.context.push(
       "Context: {usage}% ({usedTokens}/{contextLimit}).
        Next auto-prune will trigger at {warnThreshold}%
        ({warnThresholdAbsolute} tokens)."
     )
```

### 3.10 Compress Tool (`src/compress.ts`)

```
Summarize a resolved conversation segment to save context space.

Use this when you've finished discussing a topic and want to free
up context without waiting for auto-prune to kick in.

The tool reads the full session messages, generates a detailed
summary of the specified range, and marks it as compressed so
auto-prune will preserve the summary text instead of trimming it.

Parameters:
- topic: Short label (3-5 words, e.g. "auth flow discussion")
- approximateRange: Description of the content to compress
- preserveKeys: Optional list of key topics to preserve in summary
```

**执行流程**：

```
execute(args, toolCtx):
  1. 通过 client.session.messages({ sessionID }) 获取完整消息列表
     （注意：参数格式为 { sessionID }，非无参调用）
  2. 在消息列表中找到与 approximateRange 语义匹配的范围
  3. 构建摘要 prompt，要求生成详细摘要
  4. 调用 LLM 生成摘要：
     - 使用 client.session.prompt({
         sessionID,
         parts: [summaryRequestParts],
         noReply: true,
         model: ...  // 可选，指定压缩用的模型
       })
     - 返回 { info: AssistantMessage, parts: Part[] }
     - 从中提取 summary text
  5. 标记 state.compressedRanges
  6. 更新 state.stats
  7. 返回摘要文本 + 节省 token 估算
```

### 3.11 Token 追踪 (`src/token-tracker.ts`)

从 `AssistantMessage.tokens` 读取（v2 新增 `total?` 可选字段）：

```typescript
function getTokenUsage(messages: Message[]): number {
  return messages
    .filter((m): m is AssistantMessage => m.role === "assistant")
    .reduce((sum, m) => {
      // total 可选存在时优先使用，避免重复计算
      if (m.tokens.total !== undefined) return sum + m.tokens.total
      return sum + m.tokens.input + m.tokens.output
    }, 0)
}

function getRawTokenBreakdown(messages: Message[]): TokenBreakdown {
  // 细化追踪：input / output / reasoning / cache 各多少
}
```

**fallback**：若 `tokens` 字段完全不存在（极低概率），回退到字符数 × 系数估算（字符数 / 3.5）。

### 3.12 Session 事件 (`src/session-events.ts`)

```
event handler:
  case "session.created":
    → 获取 properties.info.id → 初始化 session state
    → 检查 properties.info.parentID（存在 = subagent）
      - 是 subagent → 标记 isSubagent + 记录 parentId
      - 不是 → 普通 session
    → contextLimit 留空（等 system.transform 填充）

  case "session.updated":
    → 获取 properties.sessionID → 更新 token 用量
      (properties.info.tokens? 可选存在)
    → 若 modelId 变更 → 重新计算阈值
    → subagent 的更新也正常追踪

  case "session.compacted":
    → properties.sessionID（注意：非 properties.info.id）
    → 更新 state，记录 compaction 事件
    → subagent 的 compaction 同样处理
```

---

## 四、多模型兼容与 Subagent 支持

### 4.1 Context 大小分档策略

| 档位 | Context 范围 | 代表模型 | 默认 warn | 默认 critical | 默认 turnProtection | 价值主张 |
|------|-------------|---------|-----------|--------------|-------------------|---------|
| 小 | ≤ 200K | GPT-4o-mini, GPT-4o, Claude Haiku | 0.60 | 0.80 | 4 | **防止崩溃**：小 context 很容易跑满，及时修剪是刚需 |
| 标准 | 200K-1M | Claude Sonnet, GPT-4.1 | 0.75 | 0.90 | 8 | **平衡**：兼顾 token 节省和上下文完整性 |
| 超大 | ≥ 1M | DeepSeek V4, Gemini 2.5 Pro | 0.80 | 0.95 | 10 | **注意力质量**：不易爆 limit，修剪提升回复精准度 |

用户可通过 `config.models.<modelId>` 覆盖特定模型的任意参数。

### 4.2 Token 字段兼容

```typescript
// v2 SDK AssistantMessage.tokens
tokens: {
  total?: number      // 新增，可选存在时优先使用
  input: number       // 必填
  output: number      // 必填
  reasoning: number   // DeepSeek 专用，其他模型可能为 0，独立于 input
  cache: {
    read: number
    write: number
  }
}
```

**fallback**：若字段不存在，回退到字符数 × 系数估算（字符数 / 3.5）。

### 4.3 Subagent 支持

**检测方式**：`session.created` 事件的 `properties.info.parentID` 非空即为 subagent。

**独立状态**：每个 subagent session 有独立 `SessionState`，通过 `parentSessionId` 关联。

**独立配置**：subagent 使用 `config.subagent` 段（默认 warn=0.60 / critical=0.80 / turnProtection=4）。

**更激进的修剪**：
- subagent 的任务通常单一聚焦，完成后不再回溯
- turnProtection 更短（3-4 轮）
- 对 read/bash/webfetch 的 ToolPart 更早修剪

**父 session 视角**：
- subagent 返回的内容以 `AgentPart` / `TextPart` 形式进入主 session
- 主 session 对这些 Parts 按通用规则分类（keep），不特殊处理
- subagent 压缩的结果传回主 session 后自然成为主 session context 的一部分

---

## 五、实现步骤

```
Phase 1 — 核心骨架
  Step 1: 项目初始化（package.json, tsconfig.json, 目录）
  Step 2: config.ts — 百分比阈值 + 分档策略 + subagent 配置
  Step 3: state.ts — 包含 compressedRanges + frequency control 字段
  Step 4: persistence.ts — JSON 持久化
  Step 5: index.ts — 插件入口（注册 hooks + tools）

Phase 2 — Session 事件 + Token 追踪
  Step 6: session-events.ts — event 钩子（created/updated/compacted）
          → 闭包捕获 sessionId + subagent 检测
          → session.compacted 使用 properties.sessionID
  Step 7: token-tracker.ts — 读 token 字段（处理 total? 可选）
          → type narrowing: AssistantMessage | UserMessage

Phase 3 — Part 分类 + 修剪引擎
  Step 8: part-classifier.ts — Part 价值分类
          → 接收 messageRole 参数（TextPart role 来自 msg.info.role）
          → 覆盖全部 12 种 Part 类型
          → 工具名基于 v3 实际清单
          → FilePart 区分 read 附着 vs 独立上传
  Step 9: part-trimmer.ts — 各类 Part 的截断/删除实现
          → ToolState 需先 narrow 到 ToolStateCompleted

Phase 4 — 自动修剪
  Step 10: messages-transform.ts — auto-prune + 频率控制
  Step 11: system-transform.ts — 系统指令注入（含分档文案）
  Step 12: compacting-hook.ts — compaction 提示注入

Phase 5 — 手动压缩
  Step 13: compress.ts — compress tool
          → client.session.messages({ sessionID }) 读取
          → client.session.prompt({ sessionID, parts }) 生成摘要

Phase 6 — 集成与调试
  Step 14: 与 Learning Plugin 同时加载验证无冲突
  Step 15: 测试多模型字段兼容性（total?/reasoning 字段行为）
  Step 16: 调优修剪阈值和频率控制参数
```

---

## 六、部署方式

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "plugin": [
    "./path/to/tune-context-plugin"
  ]
}
```

配置在项目级 `.opencode/tune-context.json` 或全局 `~/.config/opencode/tune-context.json`。

---

## 七、风险与待确认项

### 已分析并明确的事项

| 此前风险 | 分析结论 | 设计应对 |
|---------|---------|---------|
| `messages.transform` input 为空 | 可解：从 `output.messages[0].info.sessionID` 或闭包 | 见 §3.7 |
| `ReasoningPart` 删除是否安全 | 安全：UI-only 层，API 调用不包含 | 见 §1.1 |
| edit/write 的 ToolPart output 去重 | redundant 收益为零，改为 keep | 见 §1.1 |
| `session.updated` 触发频率 | 足够，且 token 计算可内联到 messages.transform | 见 §3.12 |
| `session.compacted` 字段差异 | `properties.sessionID`（非 `properties.info.id`） | 见 §3.12 |
| `ToolPart.state` 联合类型 | 必须 `state.status === "completed"` 收窄 | 见 §3.6 |
| `AssistantMessage.tokens.total` | v2 新增可选字段，优先使用 | 见 §3.11 |
| TextPart 不携带 role | 从 parent Message 的 `info.role` 获取 | 见 §3.7 |
| FilePart 区分策略 | 仅 drop read 工具附带的，独立文件 keep | 见 §1.1 |

### 待实测确认

1. **`messages.transform` 触发频率** — 推测为每次 LLM 调用前触发。频率控制（增长 < 5% 跳过）可将性能影响降到最低。

2. **DeepSeek reasoning tokens 的计数方式** — `tokens.reasoning` 是否包含在 `tokens.input` 中，还是单独计数。影响阈值计算精度。

3. **ToolPart output 截断后 LLM 的 re-read 行为** — system prompt 告知后，LLM 是否会主动重新 read 文件。需要在实测中观察。

4. **`client.session.prompt()` 的同步/流式行为** — compress tool 中调用后是否能直接拿到完整响应正文，还是需要等待流式完成。需要在真实 session 中打印确认。

### 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | — | 初始设计 |
| v2 | — | API 对齐审查，闭包捕获策略 |
| v3 | 2026-05-20 | 基于 v2 SDK 类型验证：修正工具名清单（16 个实际工具名）、事件字段名、classifyPart 签名、FilePart 区分策略、新增 Part 类型覆盖、ToolState type narrowing、compress 实现路径 |
