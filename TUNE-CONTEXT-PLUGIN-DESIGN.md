# Tune Context Plugin — 技术实现方案

## 概述

自研轻量级 context 管理 plugin，替代 `@tarquinen/opencode-dcp`，专门适配 **DeepSeek V4 Flash**（1M context window）。

设计原则：
- **最小可用**：只保留压缩必需的功能，不做额外抽象
- **无外部依赖**：不依赖 Anthropic tokenizer、XML 标签机制等 Claude 生态组件
- **DeepSeek 优先**：所有 API 调用、字段映射、指令格式以 DeepSeek V4 Flash 为准
- **API 对齐**：仅使用 opencode 公开文档中确认存在的 hooks

### API 限制现状

opencode 公开文档中**不存在**以下 hooks：
- `experimental.chat.system.transform` — 无法在 system prompt 注入额外指令
- `experimental.chat.messages.transform` — 无法在消息发送前修改消息内容
- `experimental.text.complete` — 存在但非公开

**同时 SDK 文档已确认** `client.session.messages()` 为只读接口，无写回消息的 API。因此 compress tool **无法**将旧消息替换为摘要。

因此 Tune Context Plugin 的设计无法做到 DCP 级别的"主动修改消息流注入 nudge / mXXXX ID / 替换压缩块"。核心机制改为**被动响应 + 压缩策略提示**。

---

## 一、项目结构

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
    ├── index.ts              # 插件入口，注册 hooks + tools
    ├── config.ts             # 配置加载和默认值
    ├── state.ts              # Session 状态类型和工厂函数
    ├── persistence.ts        # 状态持久化（读/写 JSON 文件）
    ├── prompts.ts            # 提示词常量（compaction 注入 + tool description）
    ├── token-tracker.ts      # Token 用量追踪（多格式兼容）
    ├── compress.ts           # compress tool 定义和实现
    └── session-hooks.ts      # session.created + session.updated +
                              # experimental.session.compacting 实现
```

---

## 二、各模块详细设计

### 2.1 插件入口 (`src/index.ts`)

**职责**：初始化各子系统，返回 Hooks 对象注册到 opencode。

```
初始化流程：
1. 加载配置（优先读取 ~/.config/opencode/tune-context.jsonc）
2. 创建 plugin 级别的状态管理器（Map<sessionId, SessionState>）
3. 创建 logger（debug 模式由配置控制）
4. 注册 hooks:
   - session.created        → session-hooks.ts
   - session.updated        → session-hooks.ts
   - experimental.session.compacting → session-hooks.ts
5. 注册 tool:
   - compress               → compress.ts
```

**注意事项**：
- `compress` tool 的条件注册：如果配置中 `permission: "deny"`，则不注册
- 多个 session 共享插件实例，通过 `state.sessionId` 区分
- 不在 `session.created` 中拦截或修改 session 创建流程，仅初始化状态

### 2.2 配置加载 (`src/config.ts`)

**配置来源**：`~/.config/opencode/tune-context.jsonc`

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/.../tune-context.schema.json",

  // 【必须】compress tool 权限控制
  "permission": "allow",          // "ask" | "allow" | "deny"

  // 【必须】Token 阈值（绝对数值，不依赖 modelContextLimit）
  "maxTokens": 950000,            // 超过此值 compacting 时提示紧急压缩
  "minTokens": 800000,            // 超过此值 compacting 时提示常规压缩

  // 【可选】Turn protection：保护最近 N 轮 tool 不被压缩
  "turnProtection": 8,

  // 【可选】compacting 提示频率（每隔 N 次 compacting 提示一次）
  "compactionHintFrequency": 3,

  // 【可选】调试日志
  "debug": false
}
```

**默认值**（当配置不存在或字段缺失时使用）：
- permission: "allow"
- maxTokens: 950000
- minTokens: 800000
- turnProtection: 8
- compactionHintFrequency: 3
- debug: false

### 2.3 Session 状态 (`src/state.ts`)

**状态类型定义**：

```
SessionState:
  sessionId: string | null
  lastTokenUsage: number | null       # 上次探测到的 token 数
  tokenFieldFormat: string | null     # 探测到的 token 字段格式
  totalCompressedTokens: number       # 已被压缩的 token 总量
  lastCompactionHintAt: number | null # 上次 compacting 提示的 session 时间戳
  stats:
    compressCallCount: number
    totalCompressedTokens: number
```

**注意**：原设计中的压缩块记录（blocksById、byMessageId）和 nudge anchors 被移除。原因是：
- 无法在消息中注入 mXXXX ID 和替换压缩块 → 无需维护这些映射
- 无法注入 nudge → 无需 anchors 追踪

### 2.4 状态持久化 (`src/persistence.ts`)

**存储路径**：`~/.local/share/opencode/storage/plugin/tune-context/{sessionId}.json`

**序列化格式**：

```json
{
  "version": 2,
  "lastTokenUsage": 420000,
  "tokenFieldFormat": "deepseek",
  "totalCompressedTokens": 80000,
  "lastCompactionHintAt": null,
  "stats": {
    "compressCallCount": 3,
    "totalCompressedTokens": 80000
  },
  "lastUpdated": "2026-05-19T00:00:00.000Z"
}
```

**保存时机**：
- `session.updated` 探测到 token 字段后（更新用量）
- compress tool 执行后
- `experimental.session.compacting` 执行后

### 2.5 提示词系统 (`src/prompts.ts`)

不采用 DCP 的 custom prompts 文件系统。所有提示词直接在代码中定义常量。

#### 2.5.1 Compacting 注入文本（通过 `experimental.session.compacting` 注入）

当 token 用量超过 minTokens 且达到 compactionHintFrequency 间隔时注入：

```
## Context Management Notice
Current context window usage: {usage}% ({usedTokens}/{maxTokens} tokens).
If the session is approaching the 1M token limit, consider using the `compress` tool
to summarize older resolved conversation segments and free up context.
```

`{usage}` / `{usedTokens}` / `{maxTokens}` 在运行时替换。

#### 2.5.2 Compress Tool Description

```
Summarize older conversation segments to free up context window space.

Use this when the conversation has grown long and earlier messages are no longer actively needed.
The tool will read the current session messages, generate a detailed summary of the specified
range, and return the result.

Parameters:
- topic: Short label for the content to compress (3-5 words, e.g. "auth flow discussion")
- approximateRange: Description of the content to compress (e.g. "discussion about token refresh
  between the initial setup and the current implementation")
- preserveKeys: Optional list of key topics, function names, or file paths that MUST be preserved
  in the summary

Summary requirements:
- EXHAUSTIVE: Capture file paths, function signatures, decisions, constraints, findings
- LEAN: Remove noise (failed attempts, verbose output, repetition)
- Preserve user intent: Keep the user's requirements and instructions intact

Note: This tool generates a summary for your reference. The original messages remain in context
until session compaction. Use the summary to focus your attention on what matters.
```

**关键设计点**：参数不使用 mXXXX ID（不注入消息中），改为按内容语义描述。

### 2.6 Token 追踪 (`src/token-tracker.ts`)

（与原始设计一致，无需改动）

**核心函数**：

```
function getCurrentTokenUsage(messages, tokenFieldFormat?) → number
```

**逻辑**：

1. 从消息列表中找到最后一条 `role === "assistant"` 且 token 字段非空的消息
2. 读取其 token 字段：
   - 如果 `tokenFieldFormat` 已缓存 → 直接按格式读取
   - 如果缓存为空（首次运行）→ 自动探测 3 种格式
3. 如果已压缩过（`totalCompressedTokens > 0`），返回值中排除压缩块的 token 计数

**自动探测流程**：

```
首次调用：
  1. 获取最后一条 assistant 消息的 token 字段
  2. 按优先级探测: total_tokens → prompt_tokens+completion_tokens → input+output
  3. 成功则缓存格式到 state.tokenFieldFormat
```

### 2.7 compress Tool 实现 (`src/compress.ts`)

**工具参数**（Zod schema）：

```typescript
args: {
  topic: z.string().describe("Short label for the content to compress"),
  approximateRange: z.string().describe("Description of the content to compress"),
  preserveKeys: z.array(z.string()).optional().describe("Key topics to preserve")
}
```

**执行流程**：

```
execute(args, toolCtx):
  1. 通过 client.session.messages({path: {id: toolCtx.sessionID}}) 获取 session 消息列表
  2. 在消息列表中找到与 approximateRange 语义匹配的消息范围
  3. 构建摘要 prompt：要求 LLM 对这部分内容生成详细摘要
  4. 通过 LLM 调用（openCode SDK client）生成摘要
  5. 返回生成的摘要文本 + token 使用情况
     → SDK 确认 client.session.messages 为只读，无法替换旧消息
     → 模型自行决定如何使用这份摘要来聚焦注意力
  6. 更新 state.stats
  7. 返回结果字符串，包含:
     - 压缩内容的 topic
     - 摘要文本
     - 预估节省的 token 数
     - 当前 context 使用率
```

**关于消息替换能力的说明**：

SDK 文档已确认无写回消息的 API。compress tool 生成的摘要仅供模型参考，旧消息仍占用 context window。在 1M context window 下，除非极长 session，否则通常不触发限制。Learning Plugin 的 `experimental.session.compacting` 可在 compaction 时保留上下文，与 compress tool 互补。

### 2.8 Session Hooks 实现 (`src/session-hooks.ts`)

#### `session.created`

```
handler(input, output):
  1. 获取 sessionId
  2. 加载或创建该 session 的状态
  3. 初始化 tokenFieldFormat（默认为 null，首次 token 追踪时探测）
```

**注意**：不在 session.created 中主动读取任何消息或执行校验。读取在 session.updated 中延迟执行。

#### `session.updated`

```
handler(input, output):
  1. 获取 sessionId → 加载 state
  2. 从 session 的最新消息中读取 token 字段
  3. 如果 tokenFieldFormat 未探测到，尝试自动探测
  4. 更新 state.lastTokenUsage
  5. 保存状态
```

**用途**：持续追踪 token 用量变化，供 compacting 时判断是否应提示压缩。

#### `experimental.session.compacting`

```
handler(input, output):
  1. 获取 sessionId → 加载 state
  2. 获取当前 token 用量（从 state 或重新计算）
  3. 如果 token 用量 >= config.minTokens：
     a. 检查距离上次提示是否达到 compactionHintFrequency 间隔
     b. 如果达到，从 prompts.ts 获取 compacting 文本
     c. 替换占位符（usage / usedTokens / maxTokens）
     d. output.context.push(compacting 文本)
     e. 更新 state.lastCompactionHintAt
  4. 保存状态
```

**与 Learning Plugin 的兼容**：两者各自 `push` 到 `output.context` 数组，互不干扰。

---

## 三、DeepSeek V4 Flash 专项适配对照表

| 适配点 | DCP 的做法 | 我们的做法 |
|--------|-----------|-----------|
| Token 字段 | 固定 `tokens.input` + `tokens.output` | 自动探测 3 种格式（total_tokens / prompt_tokens / input） |
| Context window | 依赖 `input.model.limit.context` | 硬编码为 1M（与 DeepSeek V4 Flash 一致） |
| 阈值 | 百分比 `"75%"`（需 modelContextLimit 支持） | 绝对数值 `950000` / `800000` |
| Tokenizer | `@anthropic-ai/tokenizer` | 不使用，只依赖 API 报告的值 |
| 消息注入 | `messages.transform` 注入 ID + nudge | **不支持**（无此 hook） |
| System prompt 注入 | `system.transform` | **不支持**（无此 hook） |
| Compress 替换消息 | tool + messages.transform 配合 | ✗（无写消息 API） |
| Turn protection | 内置，默认 4 轮 | 内置，默认 8 轮（仅 compress tool 内检查） |
| 自定义 prompts | 复杂文件系统 | 不支持，所有提示词硬编码 |

---

## 四、与 DCP 的直接对比

| 特性 | DCP v3.1.12 | Tune Context Plugin |
|------|-------------|-------------------|
| System prompt 注入 | ✓ | ✗（无此 hook） |
| 消息 ID 注入 (mXXXX) | ✓ | ✗（无此 hook） |
| Nudge 主动注入 | ✓ | ✗（改为 compacting 被动提示） |
| Compress tool | ✓ | ✓（简化版，按语义匹配范围） |
| 消息替换（压缩块） | ✓ | ✗（SDK 确认无写消息 API） |
| Token 追踪 | ✓ | ✓ |
| Session 持久化 | ✓ | ✓ |
| Turn protection | ✓ | ✓（compress tool 内实现） |
| Deduplication | ✓ | ✗ |
| Per-model 配置 | ✓ | ✗（只适配 DeepSeek V4 Flash） |
| Subagent 支持 | ✓ | ✗ |
| Anthropic tokenizer | ✓ | ✗ |
| XML tag 依赖 | ✓ | ✗ |
| 对非 DeepSeek 模型兼容 | 通用 | 不兼容 |

### 与 Learning Plugin 的冲突矩阵

```
                    Learning Plugin    Tune Context Plugin
                    ───────────────    ────────────────────
session.created     ✅ 静默校验          ✅ session 状态初始化
session.updated     —                   ✅ token 用量追踪
experimental.       ✅ 注入上下文         ✅ 注入压缩策略提示
session.compacting  (output.context     (output.context push,
                     push, 不冲突)        不冲突)
tool.execute.before ✅ 版本切换 prepend  —
file.edited         ✅ 三层保持          —
自定义工具           3 个工具             1 个 compress 工具
```

**结论：完全无冲突。** 唯一共用的 `experimental.session.compacting` 各自 `push` 不同内容，互不干扰。

---

## 五、实现步骤

```
Phase 1 — 核心骨架
  Step 1: 创建项目结构（package.json, tsconfig.json, 目录）
  Step 2: 实现 config.ts（配置加载 + 验证）
  Step 3: 实现 state.ts（状态类型 + 工厂函数）
  Step 4: 实现 persistence.ts（JSON 读写）
  Step 5: 实现 prompts.ts（所有提示词常量）
  Step 6: 实现 index.ts（插件入口）
  ✓ 插件可以被 opencode 加载

Phase 2 — Token 追踪 + Compacting 提示
  Step 7: 实现 token-tracker.ts（DeepSeek 兼容 token 追踪）
  Step 8: 实现 session-hooks.ts（session.created + updated + compacting）
  ✓ 插件可以追踪 token 使用、在 compacting 时提示

Phase 3 — Compress Tool
  Step 9: 研究 client.session 是否有写回能力
  Step 10: 实现 compress.ts（compress tool）
  ✓ 插件可以按语义范围压缩内容

Phase 4 — 集成测试
  Step 11: 与 Learning Plugin 同时加载，验证无冲突
  Step 12: 测试各种 token 字段格式
  Step 13: 调优 compacting 提示频率和阈值
```

---

## 六、部署方式

插件作为本地 npm package，通过 `opencode.json` 的 `plugin` 字段加载。

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "plugin": [
    "./path/to/learning-plugin",
    "./path/to/tune-context-plugin"
  ]
}
```

本地路径指向 `dist/index.js`（编译后的 JS 入口）。

**与 DCP 的冲突处理**：部署前务必从 `opencode.json` 的 `plugin` 数组中移除 `@tarquinen/opencode-dcp@latest`。

---

## 七、风险与待确认项

1. ~~**`client.session.messages` 是否可写回**~~ — **已确认：SDK 文档仅提供只读的消息查询 API，无写接口。** compress tool 无法替换旧消息。此设计方向已关闭，compress tool 仅返回文本摘要供模型参考。

2. **`experimental.session.compacting` 的触发频率** — 不确定 opencode 在什么情况下触发 compaction。如果触发不频繁，压缩策略的提示时机可能不够及时。

3. **`client.session.messages` 返回的消息 token 字段结构** — 需要在真实 session 中打印确认 DeepSeek 的具体字段名。

4. **DeepSeek V4 Flash 的 1M context window 是否包含 reasoning tokens** — 如果 reasoning tokens 单独计数，阈值计算需要调整。

5. **`session.updated` 的触发条件和频率** — 需要确认该 hook 在什么场景下触发，是否足够频繁用于 token 用量追踪。
