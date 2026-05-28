# `@cloudbase/open-agent-kernel` — 备用方案设计（基于 OpenAI Agents SDK）

> **本文档定位（2026-05-21 调整）**：**备用方案 / Plan B**。
>
> **主方案**：[`open-agent-kernel-design.md`](./open-agent-kernel-design.md)（基于 Claude Agent SDK）。
>
> **本方案的价值**：作为 Plan B 储备方案存在。如果主方案的 Claude Agent SDK 在生产环境出现真正阻塞的闭源限制问题（具体触发场景见主方案附录 B），可在 1-2 周内切换到本方案。**用户代码零改动**（两份方案的公共 API 协议中立、完全一致）。
>
> **历史背景**：本方案原为 v1.0 主方案候选，因 2026-05-21 关键事实澄清（CloudBase 网关 Anthropic 协议已就绪 / 法务确认无风险 / 闭源 bug 排查初期可接受 + tcb-headless-copilot 已有实战经验）后，主方案确定为 Claude Agent SDK，本方案降级为备用。
>
> **下文保留原"v1.0 定稿"语气**，便于在真正切换时直接用作工程实施依据。阅读时请将"定稿"理解为"Plan B 启用时的定稿"。

---

## 原文档（v1.0 定稿，作为 Plan B 启用时的工程依据）

# `@cloudbase/open-agent-kernel` SDK 设计文档（OpenAI Agents SDK 路线）

> 版本：**v1.0**（Plan B 定稿）
> 状态：备用方案就绪
> 目标：交付一个**给 CloudBase 平台开发者用的服务端 agentic agent SDK**，开箱集成 CloudBase 资源（数据库 / 存储 / 沙箱 / 模型网关 / 凭证），让开发者用 5 分钟搭出一个 agent。
>
> 本版本是 Plan B 设计的**最终决议**。

---

## 0. TL;DR

| 维度 | 决定 |
|---|---|
| **形态定位** | A 形态（服务端 kernel SDK，跟用户业务代码同进程，纯库 import）。C 形态（cloudbase-managed-agent）会 import 我们 |
| **底层引擎** | **OpenAI Agents SDK**（`@openai/agents`，MIT，Anthropic Managed schema 的事实工业标准） |
| **模型路由** | 用户配置 `model: 'hunyuan-t1-latest'` → kernel 内部转化为 `apiBaseUrl` 指向 CloudBase 网关（OpenAI 协议，已就绪） |
| **资源托管** | 只对接 CloudBase（envId 锚定），kernel 自动派生数据库 / 存储 / 沙箱 / 网关 URL |
| **持久化** | 实现 OpenAI Agents SDK 的 `Session` 接口为 `CloudBaseSession`（落 CloudBase 数据库） |
| **沙箱** | 实现 OpenAI Agents SDK 的 `SandboxClient` 接口为 `CloudBaseSandboxClient`（接现有 SCF 沙箱镜像 HTTP API） |
| **HITL** | 用 OpenAI Agents SDK 的 `ToolApprovalItem` + `RunState.toJSON()` 序列化方案，跨节点 resume 走 DB（不依赖 Redis） |
| **agentic 能力** | plan / subagent / skills / compaction / memory / sandbox 全部走 OpenAI Agents SDK 自带（不手撸） |
| **MCP 集成** | CloudBase MCP 通过 OpenAI Agents SDK 的 `mcpServers` 注入 |
| **Hooks** | 通过 OpenAI Agents SDK 的 lifecycle hooks（如 `onToolStart`/`onToolEnd`）暴露，封装为友好的 kernel API |
| **协议中立** | kernel 公开 API 不绑任何客户端协议（ACP / AG-UI / SSE），用户拿到事件流后自己接 |
| **分包策略** | 新建 `packages/open-agent-kernel/`，`packages/server` 保持不动 |
| **License** | MIT（kernel 自身），依赖 OpenAI Agents SDK（MIT）—— 全栈干净 |

---

## 1. 决策演进备忘（精简）

> 以下是历史决策的精简记录，便于团队成员理解"为什么是这个方案"，**不再展开论证**。详细论证保存在 git 历史中。

| 阶段 | 候选方案 | 否决理由 |
|---|---|---|
| 阶段 1 | OpenCode CLI + ACP | 跟 cloudbase-managed-agent 协议同源是优势，但 ACP 本身是 IDE 嵌入协议，不适合通用 agent SDK；CloudBase 网关 OpenAI 协议优先就绪 |
| 阶段 2 | Mastra | plan/skills/compaction 不是一等公民，违反"agentic 自带"硬约束 |
| 阶段 3 | deepagentsjs | 真纯库 + virtual fs 可插拔很优秀，但绑定 LangChain 生态（你倾向不绑） |
| 阶段 4 | Claude Agent SDK | 闭源（minified `cli.js` + `sdk.mjs`，9.6MB bundle，Anthropic Commercial Terms），bug 难定位、法律风险 |
| **阶段 5（决定）** | **OpenAI Agents SDK** | **MIT 开源 + plan/skills/compaction/sandbox/memory 全自带（2026-04-15 大版本更新后）+ CloudBase 网关 OpenAI 协议已就绪 + RunState 序列化 HITL 设计优雅** |

---

## 2. 用户视角：5 分钟上手

### 2.1 最小可运行示例（< 20 行）

```ts
import { createAgent } from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId: 'my-env-123',
  model: 'hunyuan-t1-latest',
  systemPrompt: 'You are a helpful CloudBase assistant.',
})

const session = await agent.startSession({ userId: 'user-1' })

for await (const event of session.send('帮我列出数据库 users 集合的前 5 条记录')) {
  if (event.type === 'message_delta') process.stdout.write(event.text)
}
```

发生了什么：
- `createAgent` 用 `envId` 派生所有 CloudBase 资源（数据库 / 沙箱 / 网关）
- 模型走 CloudBase 网关（OpenAI 协议代理 hunyuan）
- 内置注入 CloudBase MCP server，agent 自动获得操作数据库 / 存储 / 沙箱的能力
- 流式事件直接 `for await` 消费

### 2.2 启用 agentic 完整能力

```ts
const agent = createAgent({
  envId: 'my-env-123',
  model: 'hunyuan-t1-latest',
  systemPrompt: '...',

  // ── 启用 sandbox + 全套 agentic capabilities ──────
  sandbox: {
    scope: 'session',         // 'user' | 'session' | 'shared'
    capabilities: {
      filesystem: true,        // OpenAI SDK 的 Filesystem()
      shell: true,             // OpenAI SDK 的 Shell()
      skills: true,            // OpenAI SDK 的 Skills()
      memory: true,            // OpenAI SDK 的 Memory()
      compaction: true,        // OpenAI SDK 的 Compaction()
    },
  },

  // ── 自定义工具 ────────────────────────────────
  tools: [
    {
      name: 'get_user_profile',
      description: '...',
      parameters: z.object({ userId: z.string() }),
      execute: async ({ userId }) => ({ name: 'Alice' }),
    },
  ],

  // ── 子 agent ──────────────────────────────────
  handoffs: [reviewerAgent, writerAgent],

  // ── 工具审批（HITL）─────────────────────────
  permissions: {
    requireApproval: ['filesystem.write', 'shell.run'],
  },

  // ── 业务钩子 ──────────────────────────────────
  hooks: {
    onToolStart: async (ctx) => { /* 审计 */ },
    onToolEnd: async (ctx) => { /* 计费 */ },
  },
})
```

### 2.3 HITL（工具审批）+ 跨节点 resume

```ts
const session = await agent.startSession({ userId: 'u1' })

for await (const event of session.send('删除生产数据库的 logs 集合')) {
  if (event.type === 'tool_approval_required') {
    // 把 state 持久化（任意位置），UI 上展示卡片
    await store.save(event.runStateJson)
    return  // 当前进程可以退出
  }
  if (event.type === 'message_delta') process.stdout.write(event.text)
}

// 后续（可能是另一个 pod / 另一台机器，几小时后）
const stateJson = await store.load()
const session2 = await agent.resumeSession(stateJson)

for await (const event of session2.respondApproval({ toolUseId, approved: true })) {
  // ... 继续处理
}
```

→ **跨节点 resume 通过 `RunState.toJSON()`（几 KB 字符串）实现，零外部存储依赖**（除了 kernel 默认用的 CloudBase 数据库做 message 持久化）。

---

## 3. 公共 TypeScript 类型签名

```ts
// === Agent / Session ===

export function createAgent(config: AgentConfig): Agent

export interface Agent {
  readonly id: string
  readonly name?: string
  startSession(opts: SessionStartOptions): Promise<Session>
  resumeSession(stateJsonOrConversationId: string): Promise<Session>
  sessions: {
    list(opts?: { userId?: string; limit?: number }): Promise<SessionSummary[]>
    delete(conversationId: string): Promise<void>
  }
}

export interface Session {
  readonly id: string
  send(input: string | SessionInput): AsyncIterable<SessionEvent>
  respondApproval(opts: { toolUseId: string; approved: boolean; message?: string }): AsyncIterable<SessionEvent>
  getHistory(opts?: { limit?: number }): Promise<MessageRecord[]>
  getState(): Promise<string>     // RunState.toJSON()
  abort(): Promise<void>
}

// === Config ===

export interface AgentConfig {
  // 元信息
  name?: string
  description?: string
  metadata?: Record<string, unknown>

  // 资源
  envId: string
  resources?: ResourceConfig

  // 模型
  model: string | ModelSpec
  systemPrompt?: string

  // 能力
  tools?: ToolDefinition[]
  mcpServers?: McpServerConfig[]
  handoffs?: Agent[]                              // 子 agent
  sandbox?: SandboxConfig
  permissions?: PermissionConfig

  // 钩子
  hooks?: AgentHooks
}

export interface SandboxConfig {
  scope: 'user' | 'session' | 'shared'
  ttl?: number
  idleTimeout?: number
  capabilities?: {
    filesystem?: boolean
    shell?: boolean
    skills?: boolean | { sources: string[] }      // 文件路径或 SKILL.md 路径
    memory?: boolean
    compaction?: boolean | CompactionConfig
  }
}

export interface PermissionConfig {
  requireApproval?: string[]                       // 通配符匹配工具名
  canUseTool?: (ctx: ToolContext) => Promise<{ allow: boolean; message?: string }>
}

export interface AgentHooks {
  onUserMessage?: (ctx: UserMessageContext) => Promise<void | { modifiedPrompt?: string }>
  onToolStart?: (ctx: ToolContext) => Promise<void>
  onToolEnd?: (ctx: ToolEndContext) => Promise<void | { updatedOutput?: unknown }>
  onAgentMessage?: (ctx: AgentMessageContext) => Promise<void>
  onSessionStart?: (ctx: SessionContext) => Promise<void>
  onSessionEnd?: (ctx: SessionContext) => Promise<void>
}

// === Events ===

export type SessionEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'message_complete'; text: string }
  | { type: 'tool_call'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: unknown }
  | { type: 'tool_approval_required'; toolUseId: string; toolName: string; input: unknown; runStateJson: string }
  | { type: 'handoff'; fromAgent: string; toAgent: string }
  | { type: 'session_idle'; reason: 'completed' | 'requires_action' | 'aborted' }
  | { type: 'error'; error: Error }

export type SessionInput =
  | string
  | { type: 'message'; content: string }
  | { type: 'tool_result'; toolUseId: string; output: unknown }   // 客户端工具结果回灌（v0.2+）

// === Tool ===

export interface ToolDefinition<TInput = any, TOutput = any> {
  name: string
  description: string
  parameters: ZodSchema<TInput>
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>
}

// 类型省略：MessageRecord / SessionSummary / ResourceConfig / ModelSpec / McpServerConfig / ToolContext / etc.
// （会在源码里完整定义，这里仅展示主干）
```

---

## 4. 内部模块划分

```
packages/open-agent-kernel/
├── package.json                              # MIT + 依赖 @openai/agents
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                              # 公共 API 收口
│   │
│   ├── public/                               # 对外 export
│   │   ├── types.ts                          # 全部公共类型
│   │   ├── create-agent.ts                   # createAgent() 工厂
│   │   ├── agent.ts                          # Agent 实现
│   │   └── session.ts                        # Session 实现
│   │
│   ├── runtime/                              # OpenAI Agents SDK 的薄封装
│   │   ├── agent-builder.ts                  # AgentConfig → @openai/agents 的 Agent 实例
│   │   ├── event-translator.ts               # @openai/agents 流式事件 → SessionEvent
│   │   ├── hook-bridge.ts                    # AgentHooks → @openai/agents 的 hooks
│   │   └── permission-bridge.ts              # PermissionConfig → @openai/agents 的 needsApproval
│   │
│   ├── resources/                            # CloudBase 资源接入
│   │   ├── name-resolver.ts                  # envId → 资源命名派生（数据库 / 沙箱 / 网关 URL）
│   │   ├── credential-provider.ts            # CloudBase 凭证获取（manager-node）
│   │   ├── model-gateway.ts                  # model 字符串 → apiBaseUrl 派生
│   │   └── client-factory.ts                 # CloudBase node-sdk client 工厂
│   │
│   ├── session-store/                        # 实现 @openai/agents 的 Session 接口
│   │   ├── cloudbase-session.ts              # CloudBaseSession（落数据库）
│   │   ├── compaction-decorator.ts           # OpenAIResponsesCompactionSession 包装
│   │   └── name-mapper.ts                    # session_id ↔ conversationId
│   │
│   ├── sandbox/                              # 实现 @openai/agents 的 SandboxClient 接口
│   │   ├── cloudbase-sandbox-client.ts       # CloudBaseSandboxClient（HTTP 转发到 SCF 沙箱镜像）
│   │   ├── scf-sandbox-manager.ts            # 复制自 packages/server，沙箱 SCF 函数 lifecycle
│   │   └── sandbox-fs-bridge.ts              # filesystem capability → 沙箱 HTTP API
│   │
│   ├── mcp/                                  # CloudBase MCP 集成
│   │   ├── cloudbase-mcp-server.ts           # 进程内 InMemory MCP server（CloudBase 工具）
│   │   ├── policy-augment.ts                 # 复制自 packages/server，业务 policy
│   │   └── credential-injector.ts            # 凭证注入到 MCP 工具调用
│   │
│   └── internal/
│       ├── errors.ts                         # 错误码
│       ├── logger.ts                         # 静态字符串日志（遵循 AGENTS.md）
│       └── version.ts                        # SDK 版本
│
├── examples/                                 # 包内 examples（5 个起步）
│   ├── 01-quickstart.ts                      # 最小 demo（§2.1）
│   ├── 02-with-sandbox.ts                    # 启用 sandbox capabilities
│   ├── 03-hitl-approval.ts                   # 工具审批 + 跨节点 resume
│   ├── 04-custom-tool.ts                     # 自定义业务工具
│   └── 05-handoff.ts                         # 子 agent
│
└── tests/
    └── ...
```

### 4.1 关键模块边界

- **`runtime/`**：唯一接触 `@openai/agents` 类型的模块。其他模块只用 kernel 自己的类型
- **`resources/`**：唯一接触 CloudBase 凭证 / OpenAPI 的模块
- **`session-store/` 和 `sandbox/`**：实现 OpenAI Agents SDK 的 `Session` / `SandboxClient` 协议，通过 `runtime/agent-builder.ts` 注入
- **`public/`**：用户唯一会 import 的入口

---

## 5. agentic 能力实现矩阵（基于源码事实）

本节回答一个核心问题：**每个 must-have agentic 能力，是 OpenAI Agents SDK 自带、kernel 自补、还是依赖其他模块？**

### 5.1 总览矩阵

| 能力 | SDK 自带可用？ | kernel 工作量 | 用户感知复杂度 | 依赖 |
|---|---|---|---|---|
| Agent loop / Tool calling / MCP | ✅ 完全自带 | 0 行 | 无 | — |
| Handoffs / Subagent | ✅ 完全自带 | 0 行 | 无 | — |
| Plan / Todo（提示工程 + Sandbox 工具） | ✅ 完全自带 | 0 行 | 无 | 推荐配 sandbox |
| HITL（RunState.toJSON + ToolApprovalItem） | ✅ 完全自带 | 0 行 | 一个 `permission` 回调 | — |
| Sessions / 持久化 | ✅ 接口自带 | ~150 行（CloudBaseSession） | 无 | CloudBase DB |
| Sandbox（Filesystem / Shell） | ✅ 接口自带 | ~200 行（CloudBaseSandboxSession） | 无 | CloudBase SCF |
| **Skills** | ✅ 完全自带 | 0 行（开 sandbox 时） | 1 行配置 | **依赖 sandbox** |
| **Compaction** | ❌ 静默失效 | ~100 行（Session 装饰器调主模型摘要） | 1 个布尔 | 主模型 |
| **Memory** | ⚠️ 默认配置不对 | ~30 行（kernel 内置 model 工厂） | 1 个布尔 | 主模型 |

**纯"补丁"工作量：~130 行**（Compaction + Memory 配置工厂）。其余皆为本来就要写的 kernel 核心模块。

### 5.2 三项关键能力的实现细节

#### 5.2.1 Skills（依赖 sandbox）

**SDK 行为**（已验证源码 `sandbox/capabilities/skills.js`）：

- `Skills({ from: [...] })`（eager）：启动时写入 sandbox manifest，物化到 workspace 的 `.agents/<skill-name>/`
- `Skills({ lazyFrom })`（lazy，推荐）：把 skill **索引**（name + description）注入到 system prompt，并暴露 `load_skill` tool；agent 调用时才物化 SKILL.md 到沙箱

**完全协议无关**：依赖 system prompt 注入 + 标准 tool calling + sandbox 文件系统。**不依赖** OpenAI 任何平台扩展端点。

**kernel 用户视角**：

```ts
sandbox: {
  capabilities: {
    skills: { from: './skills' },  // 一行
  },
}
```

**取舍**：Skills capability **耦合 sandbox**。如果用户没开 sandbox（纯对话 agent 场景），kernel 自动降级为"system prompt markdown 注入"（fallback 约 30 行，按需添加，**v0.1 MVP 不做**）。

#### 5.2.2 Compaction（kernel 自补）

**SDK 行为**（已验证源码 `sandbox/capabilities/compaction.js` 第 72-88 行 + `transport.js`）：

```js
// transport.js
return !constructorName.includes('ChatCompletions');
// → 用 ChatCompletions transport 时 supportsResponsesCompactionTransport = false

// compaction.js
samplingParams(...) {
  if (!supportsResponsesCompactionTransport(...)) {
    return {};   // ← 直接返回空对象，capability 静默失效
  }
  return { context_management: [{ type: 'compaction', ... }] };
}
```

**SDK 自带的 compaction 在我们场景（CloudBase 网关 OpenAI 协议 = ChatCompletions transport）下完全失效**。

**kernel 自补方案**（约 100 行）：

```ts
// session-store/cloudbase-session-with-compaction.ts
export class CloudBaseSessionWithCompaction implements Session {
  constructor(
    private underlying: Session,             // 已实现的 CloudBaseSession
    private summarizerModel: Model,           // 由 kernel 注入（同 cloudbaseClient）
    private opts: { threshold?: number; keepRecent?: number } = {},
  ) {}

  async addItems(items: AgentInputItem[]) {
    await this.underlying.addItems(items)
    const all = await this.underlying.getItems()
    const threshold = this.opts.threshold ?? 30
    const keepRecent = this.opts.keepRecent ?? 10
    if (all.length < threshold) return

    const toSummarize = all.slice(0, all.length - keepRecent)
    const recent = all.slice(-keepRecent)
    const summary = await callModelForSummary(this.summarizerModel, toSummarize)

    await this.underlying.clearSession()
    await this.underlying.addItems([
      { role: 'system', content: `## Conversation summary\n${summary}` },
      ...recent,
    ])
  }
  // 其余方法 passthrough underlying
}
```

**kernel 用户视角**（1 个布尔）：

```ts
sandbox: {
  capabilities: { compaction: true },
}
```

kernel 内部自动把 `summarizerModel` 设为主 agent 同款 model（同 baseURL + apiKey），开发者完全无感。

#### 5.2.3 Memory（kernel 配置默认值 + 凭证消化）

**SDK 行为**（已验证源码 `sandbox/capabilities/memory.js`）：

- `phaseOneModel` / `phaseTwoModel` 默认值是 `'gpt-5.4-mini'` / `'gpt-5.4'`（OpenAI 模型字符串）
- 支持两种类型：**string**（走全局 ModelProvider 解析）或 **Model 实例**（自带 client）
- `normalizeMemoryModel` 对非字符串原样返回（透传 Model 实例）

**问题**：默认值 = OpenAI 模型字符串 + 全局环境变量解析凭证。

**kernel 自补方案**（约 30 行）：

```ts
// runtime/memory-capability-factory.ts
function buildMemoryCapability(agentConfig: AgentConfig, cloudbaseClient: OpenAI) {
  if (!agentConfig.sandbox?.capabilities?.memory) return null

  const cfg = agentConfig.sandbox.capabilities.memory
  const summarizerModelName =
    (typeof cfg === 'object' && cfg.summarizerModel) || agentConfig.model

  // 关键：用 kernel 已经构造好的 cloudbaseClient（同 baseURL + apiKey）+ 模型名
  const summarizerModel = new OpenAIChatCompletionsModel(
    cloudbaseClient,
    summarizerModelName,
  )

  return memory({
    generate: {
      enabled: true,
      phaseOneModel: summarizerModel,
      phaseTwoModel: summarizerModel,
    },
  })
}
```

**用户视角**：

| 场景 | 用法 | 凭证暴露 |
|---|---|---|
| 默认 | `memory: true` | 无（kernel 内部用主 agent 同款 client） |
| 用便宜小模型摘要 | `memory: { summarizerModel: 'hunyuan-lite' }` | 无（同上 client，仅换模型名） |
| 用外部模型（极端） | `memory: { summarizerModel: new OpenAIChatCompletionsModel(externalClient, ...) }` | 用户自己管 |

99% 用户走前两条，**凭证全部由 kernel 内部消化**，不暴露任何 baseURL/apiKey 复杂度。

### 5.3 凭证流转架构（统一封装）

```
┌─────────────────────────────────────────────────────────────────┐
│ kernel 内部 `resources/credential-factory.ts`                     │
│                                                                  │
│ envId  ─┐                                                        │
│         ├──→  @cloudbase/manager-node                            │
│         │    issueTempCredentials() → { secretId, secretKey,     │
│         │                                token, ownerUin }       │
│         │                                                        │
│         └──→  build OpenAI client（统一工厂）                     │
│              new OpenAI({                                        │
│                baseURL: cloudbaseGatewayUrl(envId),              │
│                apiKey: ephemeralToken,                           │
│                defaultHeaders: { 'X-CB-Env': envId, ... },       │
│              })                                                  │
│                                                                  │
│              ↓ 在 kernel 内部多处复用                              │
│                                                                  │
│  ┌─────────────────┬─────────────────┬─────────────────────┐    │
│  │  主 agent model  │ memory 摘要 model│ compaction 摘要 model │    │
│  └─────────────────┴─────────────────┴─────────────────────┘    │
│                                                                  │
│  统一的 client → 统一的 baseURL/apiKey → 用户零感知                │
└─────────────────────────────────────────────────────────────────┘
```

**核心原则**：**所有"调模型"的能力，在 kernel 内部都通过同一个 `cloudbaseClient` 工厂**。这是 kernel 的核心基础设施，影响：

- 主 agent 推理
- Memory 摘要（phase1 + phase2）
- Compaction 摘要
- 未来任何需要调模型的子能力（如自动 plan 整理、handoff 路由判断等）

**唯一 30 行真正的"基础设施代码"**，但价值是消除所有"用户感知 apiKey/baseURL"的复杂度。

### 5.4 沙箱在能力体系中的角色

OpenVibeCoding 已有的沙箱（`packages/server/src/sandbox/`）= **agent 的云端可执行环境**：

| 沙箱组件 | 在 kernel 中的作用 |
|---|---|
| `scf-sandbox-manager` | kernel 内部按 envId/conversationId 创建 SCF 沙箱实例 |
| `tool-override` 协议（HTTP `POST /api/tools/{tool}`） | **直接复用作 `CloudBaseSandboxSession` 的传输层**，零协议改动 |
| `sandbox-mcp-proxy`（CloudBase MCP 走 mcporter） | 包装为 InMemory MCP server，注入到 agent `mcpServers` |
| `git-archive` | （MVP 不做，v0.2+ 作为 `archiveWorkspace` API 暴露） |

**关键对齐**：OpenAI Agents SDK 的 `SandboxSession` 接口（`readFile/writeFile/execCommand/materializeEntry/pathExists`）**恰好覆盖了 tool-override 现有 HTTP 协议**（`read/write/edit/glob/grep/bash`）。`CloudBaseSandboxSession` 实现只是一层薄翻译，约 200 行。

→ Skills / Memory / Compaction 三个能力**都依赖沙箱基础设施**，但沙箱是 OpenVibeCoding 已有资产，**复用零成本**。

---

## 6. CloudBase 资源接入路径

### 6.1 envId → 资源派生规则

```
envId = 'my-env-123'

→ 数据库集合：
  conversations: '{prefix}_conversations'    （默认 prefix = 'agent'）
  messages:      '{prefix}_messages'

→ 模型网关：
  apiBaseUrl: 'https://{envId}.api.tcloudbasegateway.com/v1/openai'

→ 凭证：
  通过 @cloudbase/manager-node 自动获取临时密钥（ownerUin / 短期 token）

→ 沙箱：
  SCF 函数：'agent-sandbox'（envId 维度）
  沙箱 HTTP base：从 SCF 函数返回值动态获取
```

用户可以 `resources` 字段覆盖任一项。

### 6.2 CloudBase 资源 → OpenAI Agents SDK 注入路径

```
┌──────────────────────────────────────────────────────────────────┐
│ kernel createAgent(config) 内部                                    │
│                                                                    │
│ 1. resources/name-resolver:  envId → 派生所有资源 URL/名称          │
│ 2. resources/model-gateway:  config.model → apiBaseUrl + apiKey     │
│ 3. session-store/cloudbase-session:  实现 @openai/agents Session    │
│                                       接口，落 CloudBase DB          │
│ 4. sandbox/cloudbase-sandbox-client:  实现 SandboxClient 协议       │
│                                        转发到 CloudBase SCF 沙箱      │
│ 5. mcp/cloudbase-mcp-server:  进程内 InMemory MCP server           │
│                                提供 CloudBase 数据库/存储/SCF 工具    │
│ 6. runtime/agent-builder:  把 1~5 拼装成 @openai/agents 的 Agent    │
│                                                                    │
│ 7. 返回 kernel 自己的 Agent 类（包装 @openai/agents 实例）          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. HITL 实现路径（无 Redis）

```
agent.run('删除 logs 集合')
  ↓
@openai/agents loop 调到一个 needsApproval 的工具
  ↓
SDK 抛出 ToolApprovalItem，整个 RunState 暂停
  ↓
kernel runtime/event-translator 把 ToolApprovalItem 翻译为：
  { type: 'tool_approval_required', toolUseId, toolName, input,
    runStateJson: state.toJSON() }
  ↓
用户业务代码消费事件：
  - 把 runStateJson 存到 CloudBase DB (acp_sessions.pending_state)
  - UI 展示审批卡片
  - 当前请求/进程结束（无任何驻留状态）
  ↓
（任意时间后，可能是另一个 pod）
  ↓
session2 = await agent.resumeSession(sessionId)
  ↓ 内部从 DB 拉 runStateJson，RunState.fromJSON()
  ↓
session2.respondApproval({ toolUseId, approved: true })
  ↓ 内部 state.approve(toolUseId) → Runner.run(agent, state)
  ↓
继续输出事件流
```

**关键**：状态体积仅 KB 级，CloudBase DB 一行记录就够。**完全不需要 Redis**，跟 tcb-headless-copilot 现有方案对比，砍掉一个外部依赖。

### 7.1 subagent 场景的事件归属（基于 SDK 源码）

#### 关键事实

| 事实 | 出处 |
|---|---|
| 每个 `RunItem` 都带 `agent: Agent` 字段（事件归属明确） | `@openai/agents-core` `items.d.ts` |
| `RunToolApprovalItem` 同样带 `agent: Agent` 字段 | 同上 |
| 流事件 `RunAgentUpdatedStreamEvent` 专门通知"换 agent 了" | `events.d.ts` |
| `result.interruptions: RunToolApprovalItem[]` 每个 item 自带 agent 标记 | `result.d.ts` |
| `StreamedRunResult.currentAgent` 暴露当前活跃 agent | `result.d.ts` |

#### Handoff vs Agent-as-Tool 的 HITL 语义差异（**重要**）

OpenAI Agents SDK 的 "subagent" 不是统一概念，是两种独立机制：

| 模式 | 实现方式 | run loop 处理 | HITL 触发归属 |
|---|---|---|---|
| **A. Handoff** | `new Agent({ handoffs: [subAgent] })` | run 切到 subagent，后续事件标记新 agent | subagent 触发，subagent 是 currentAgent |
| **B. Agent-as-Tool** | `tools: [subAgent.asTool(...)]` | 主 agent 调一个普通 tool，tool 内部独立跑 `Runner.run(subAgent)` | **子 Runner 的 HITL 不会冒泡到外层** ⚠️ |

→ **kernel 设计决策**：

- **首推 Handoff 形态**：HITL 流归属干净，跨 agent 中断/resume 语义清晰
- **asTool 形态**：可用，但子 agent 内**不能触发 HITL**（必须 auto-approve），kernel 文档需明确这一约束

#### Handoff 形态完整事件流

```
1. RunAgentUpdatedStreamEvent  { agent: orchestrator }   ← run 开始
2. RunRawModelStreamEvent      { ...orchestrator 流 }
3. RunItemStreamEvent          { name: 'handoff_requested',  item: { agent: orchestrator } }
4. RunItemStreamEvent          { name: 'handoff_occurred',   item: { ... } }
5. RunAgentUpdatedStreamEvent  { agent: dbAgent }        ← agent 切换通知
6. RunRawModelStreamEvent      { ...dbAgent 流 }
7. RunItemStreamEvent          { name: 'tool_approval_requested',
                                 item: RunToolApprovalItem {
                                   agent: dbAgent,        ← 审批 item 标记 dbAgent
                                   rawItem: { name: 'dropCollection', ... },
                                 } }
                                                          ← run 中断
                                                          ← result.currentAgent === dbAgent
                                                          ← result.interruptions = [此 item]
```

#### kernel 公共 API 的对应保证

`SessionEvent` 每个事件都带 `agent: { name, id }`（已在 §3 公共类型签名中）：

```ts
type SessionEvent =
  | { type: 'agent_started'; agent: AgentRef }
  | { type: 'agent_switched'; from: AgentRef; to: AgentRef }
  | { type: 'tool_call'; agent: AgentRef; tool: string; args: unknown; toolCallId: string }
  | { type: 'tool_output'; agent: AgentRef; output: unknown; toolCallId: string }
  | { type: 'approval_required'; agent: AgentRef; tool: string; args: unknown; approvalId: string }
  | { type: 'text_chunk'; agent: AgentRef; text: string }
  | { type: 'done'; finalAgent: AgentRef }
```

`permission` 回调签名带 `agent`：

```ts
permission: async ({ tool, args, agent }) => 'allow' | 'deny' | 'always_allow'
```

#### RunState resume 在 subagent 场景下的保证

`RunState.fromJSON(rawJson, mainAgent)` 第二个参数传**主 agent**，SDK 自己通过 agent name 从主 agent 的 handoffs 图里递归找到中断时的 subagent。

**前提（kernel 在 createAgent 时校验）**：
- 所有 subagent 在主 agent 的 handoffs 图里传递可达
- 全部 agent name 全局唯一

### 7.2 CloudBase MCP 工具审批的默认策略

**核心机制（复用 OpenVibeCoding 现有方案）**：工具名归一化 + 写工具白名单 + session 内 allow_always 缓存。

#### 复用资产

| OpenVibeCoding 资产 | kernel 角色 |
|---|---|
| `normalizeToolName` | 直接复用（剥 `mcp__cloudbase__` 前缀） |
| `WRITE_TOOLS` 写工具白名单 | 直接复用作 kernel 默认审批策略 |
| `SessionPermissionsManager` | 直接复用（session 内 "allow_always" 白名单） |
| `registerPending / resolvePending` 跨进程挂起 | **不复用**（被 `RunState.toJSON()` 取代） |

#### kernel 默认 needsApproval 实现

```ts
// kernel 内部，注入到 SDK Agent
function buildNeedsApproval(config: AgentConfig) {
  const writeTools = new Set([
    'writeNoSqlDatabaseStructure',
    'writeNoSqlDatabaseContent',
    'executeWriteSQL',
    'modifyDataModel',
    'createFunction',
    'updateFunctionCode',
    'updateFunctionConfig',
    'invokeFunction',
    // ... 用户在 config.permission.extraWriteTools 里追加
  ])

  return ({ toolName, sessionId }) => {
    const normalized = normalizeToolName(toolName)
    if (kernelPermissions.isAllowed(sessionId, normalized)) return false  // 已 allow_always
    if (writeTools.has(normalized)) return true                            // 命中白名单
    return false                                                           // 默认放行
  }
}
```

#### 用户视角（开箱即用）

```ts
// 什么都不配 → CloudBase 写工具自动弹审批
const agent = createAgent({ envId, model, cloudbaseMcp: true })
```

#### 用户视角（进阶配置）

```ts
const agent = createAgent({
  envId,
  model,
  cloudbaseMcp: true,
  permission: {
    cloudbaseWriteTools: 'auto',           // 'auto' | 'never' | 'always'
    extraWriteTools: ['myCustomTool'],     // 额外要审批的工具
    onRequest: async ({ tool, args, agent }) => {
      // 自定义策略（叠加在默认策略之上）
      if (tool === 'invokeFunction' && args.name === 'safe-fn') return 'allow'
      return 'pending'                     // 走 SDK 默认中断流程
    },
  },
})
```

kernel 内部把"CloudBase 写工具白名单" + "用户 onRequest" 合并成一个 `needsApproval` 函数注入到 SDK，**用户不需要关心 SDK 的 `RunToolApprovalItem` 概念**。

---

## 8. 与现有 OpenVibeCoding 项目的关系

### 8.1 原则

- 新建 `packages/open-agent-kernel/`，**完全不修改 `packages/server`**
- 复制粘贴的代码做必要改造（不是 in-place 重构）

### 8.2 复制对象

| 来源（packages/server） | 去向（kernel） | 说明 |
|---|---|---|
| `src/sandbox/scf-sandbox-manager.ts` | `src/sandbox/scf-sandbox-manager.ts` | 沙箱 SCF 函数 lifecycle，**核心复用** |
| `src/sandbox/sandbox-mcp-proxy.ts` | `src/mcp/cloudbase-mcp-server.ts` 参考 | InMemory MCP server 模式，**改造重写** |
| `src/lib/cloudbase-mcp.ts` | `src/mcp/cloudbase-mcp-server.ts` 参考 | CloudBase 工具发现 + policy 增强 |
| `src/middleware/mcp/cloudbase/` | `src/mcp/policies/` | 业务 policy 文件 |

### 8.3 不复用的部分

- `src/agent/runtime/opencode-acp-runtime.ts` — 整个 OpenCode + ACP 路径，**不复用**
- `src/agent/runtime/codebuddy-runtime.ts` — 同上
- `src/agent/runtime/acp-transport.ts` — 同上
- `src/lib/pending-permission-registry.ts` — kernel 用 `RunState.toJSON()` 替代

### 8.4 实施 PR 拆分

| PR | 范围 | 验证 |
|---|---|---|
| **#1** | 建骨架（package.json / tsconfig / 公共类型 / README / errors） | `pnpm install` + `pnpm -F @cloudbase/open-agent-kernel build` 通过 |
| **#2** | 实现 `runtime/`（OpenAI Agents SDK 的薄封装） | minimal example：`createAgent({envId, model})` 跑通一个 hello world |
| **#3** | 实现 `resources/`（envId 派生 + 凭证 + 网关 URL） | 单元测试 |
| **#4** | 实现 `session-store/`（CloudBaseSession） | 跨实例 resume 集成测试 |
| **#5** | 实现 `mcp/`（CloudBase MCP server） | agent 调用数据库工具 e2e |
| **#6** | 实现 `sandbox/`（SandboxClient） | filesystem/shell capability e2e |
| **#7** | 实现 `permission-bridge` + `hook-bridge`（HITL + hooks） | 工具审批 + 跨节点 resume e2e |
| **#8** | examples/ 5 个 + README 完善 | 手动验收 |

---

## 9. package.json 草案

```json
{
  "name": "@cloudbase/open-agent-kernel",
  "version": "0.1.0-alpha.0",
  "description": "CloudBase Open Agent Kernel — server-side agentic agent SDK with built-in CloudBase resources",
  "license": "MIT",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "@openai/agents": "^0.11.4",
    "@modelcontextprotocol/sdk": "^1.x"
  },
  "peerDependencies": {
    "@cloudbase/node-sdk": "^3.x",
    "@cloudbase/manager-node": "^4.x",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "~5.7.0"
  }
}
```

**说明**：
- `@cloudbase/node-sdk` / `@cloudbase/manager-node` / `zod` 作为 peerDependency（与 monorepo 既有 `@coder/shared` 一致）
- `@openai/agents@0.11.4` 要求 `zod ^4.0.0`
- 构建工具用 `tsup`（与 `@coder/shared` 一致，monorepo 习惯）

---

## 10. MVP 不做的事

| 功能 | 不做原因 |
|---|---|
| 客户端 SDK（浏览器 / RN） | C 形态由 cloudbase-managed-agent 负责 |
| ACP / AG-UI 协议适配层 | 协议中立，用户拿事件流后自己接（v0.2+ 可加 adapter 包） |
| 内置控制台 / 管理 UI | 不在 kernel 范围 |
| Multi-runtime（同时支持 OpenCode / Claude SDK） | 锁定 OpenAI Agents SDK，未来需要再说 |
| 用户自定义 storage adapter | 默认绑定 CloudBase（卖资源），不留可插拔接口 |
| 用户自定义 sandbox provider | 同上 |
| 资源消耗查询（`getUsage`） | v0.2+ |
| 配置加载（YAML / base64） | 是 C 形态 CLI 职责，kernel 只接受 TS 对象 |

---

## 11. 与 cloudbase-managed-agent（C 形态）的关系

参考前期对齐结论（保留要点）：

- kernel 是底座，cloudbase-managed-agent 内部 import 我们
- kernel 公开类型（`AgentConfig` / `SessionEvent` / `SessionInput`）跟 cloudbase-managed-agent 的 yaml schema 一对一映射
- ACP HTTP 等客户端协议由 C 形态自己适配，**kernel 不提供**

---

## 12. 与 ACP 协议的关系

### 事实

- ACP（Agent Client Protocol，Zed 推动）是 LSP 风格的 RPC 协议：server→client 推 `sessionUpdate`，client→server 调 `requestPermission` 等
- OpenAI Agents SDK **跟 ACP 完全无关**，输出是自己的 `RunStreamEvent`
- OpenVibeCoding 现状中 ACP 实际承担两个角色：
  - **A. Node 后端 ↔ OpenCode CLI 子进程的 IPC**（迁移到 OpenAI Agents SDK 后，runtime 跟后端同进程，这层 ACP 不再需要）
  - **B. 后端 ↔ 客户端的前端事件协议**（Zed 等外部 ACP 客户端的需求，迁移后仍然有价值）

### kernel 的定位

**ACP 协议适配不属于 kernel 范畴**（已在 §10 「MVP 不做的事」声明）。理由：

- kernel 输出**协议中立**的 `SessionEvent` 流
- ACP / AG-UI / SSE / WebSocket 是客户端协议选择，由上层（C 形态 / B 形态用户应用）按需适配

### 适配映射（OpenAI Agents SDK 事件 → ACP 协议）

| kernel SessionEvent | ACP 协议消息 |
|---|---|
| `agent_started / agent_switched` | `sessionUpdate { agent_message_chunk }`（agent 标识注入到 message 元数据） |
| `text_chunk` | `sessionUpdate { agent_message_chunk, content: { type: 'text' } }` |
| `tool_call` | `sessionUpdate { tool_call, toolCallId, status: 'in_progress' }` |
| `tool_output` | `sessionUpdate { tool_call_update, status: 'completed', content }` |
| `approval_required` | server→client RPC `requestPermission { options: [allow_once, allow_always, deny] }` |
| 用户决策（client→server 续传） | kernel `session.resolveApproval(approvalId, outcome)` |
| `done` | `sessionUpdate { stop }` |

→ 适配难度低，纯薄翻译。未来由 cloudbase-managed-agent 或独立的 `@cloudbase/open-agent-kernel-acp-adapter` 包提供（约 200 行）。

### 对 kernel 设计的约束

`SessionEvent` 必须保留 ACP 适配所需的所有信息（已在 §3 公共类型签名中）：

- `agent: { name, id }` — agent 归属
- `toolCallId` — ACP `tool_call` 与 `tool_call_update` 关联
- `approvalId` — ACP `requestPermission` 响应关联

→ kernel 协议中立的设计**不影响 ACP 适配可行性**，反而比"ACP 锁定的 OpenCode + ACP 方案"更灵活（同时支持 ACP / AG-UI / 自定义协议）。

---

## 13. 已确认决策一览表

| # | 项 | 决策 |
|---|---|---|
| 1 | Runtime | **OpenAI Agents SDK** |
| 2 | License | MIT |
| 3 | 商业模式 | 卖 CloudBase 资源（envId 锚定） |
| 4 | 分包 | 新建 `packages/open-agent-kernel/`，server 不动 |
| 5 | 模型路由 | OpenAI 协议走 CloudBase 网关 |
| 6 | 持久化 | CloudBase DB（实现 SDK Session 接口） |
| 7 | 沙箱 | CloudBase SCF（实现 SDK SandboxClient 接口） |
| 8 | HITL | RunState.toJSON 序列化，DB 中转，无 Redis |
| 9 | agentic 能力 | plan/skills/compaction/memory 全走 SDK 自带 |
| 10 | MCP | CloudBase MCP 走进程内 InMemory MCP server |
| 11 | 协议 | kernel 公开 API 协议中立，不绑 ACP/AG-UI |
| 12 | examples | `packages/open-agent-kernel/examples/` 5 个起步 |
| 13 | 默认 collection | `agent_conversations` / `agent_messages`（envId 维度，可覆盖） |
| 14 | 配置加载 | 不进 kernel，C 形态 CLI 负责 YAML 解析 |

---

**v1.0 定稿，开工 PR #1。**
