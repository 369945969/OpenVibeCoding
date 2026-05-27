# Open Agent Kernel — 主方案设计 v1.0（基于 Claude Agent SDK）

> **本文档定位**：**v1.0 主方案，定稿**。基于 `@anthropic-ai/claude-agent-sdk` 实现 CloudBase Open Agent Kernel。
>
> **备用方案**：[`open-agent-kernel-design-openai-sdk-alternative.md`](./open-agent-kernel-design-openai-sdk-alternative.md)（基于 OpenAI Agents SDK）。两份方案共用相同的公共 API（协议中立），未来如需替换底层 runtime 可在 1-2 周内完成切换，用户代码零改动。

---

## 0. TL;DR

**1 句话产品定位**：给 CloudBase 开发者一个 5 分钟上手的 server-side agentic agent SDK，CloudBase 资源（沙箱、数据库、存储、网关）开箱即用。

**Runtime**：`@anthropic-ai/claude-agent-sdk`（Anthropic 官方）。

**协议**：模型走 CloudBase 网关的 **Anthropic 协议**（已适配），SDK 通过 `apiBaseUrl` / `apiKey` 重定向到网关。

**为什么选 Claude Agent SDK**（基于 2026-05-21 关键事实澄清）：

| 关键事实 | 影响 |
|---|---|
| CloudBase 网关 Anthropic 协议**已就绪** | 协议适配 0 阻塞 |
| Anthropic 商业条款 + 网关重定向**法务已确认无风险** | License 合规通过 |
| 闭源 minified bundle bug 排查**初期可接受**（已有 tcb-headless-copilot 经验） | bug 排查不阻塞 |
| `tcb-headless-service/copilot` 模块已用 Claude SDK 跑通 SessionStore + 大体积 transcript 场景 | 持久化体积问题已实战验证可接受 |

**Claude SDK 在能力维度的真实优势**：

| 维度 | 优势 |
|---|---|
| Plan 模式 | ✅ `permissionMode: 'plan'` 一档 |
| Skills | ✅ 原生 `SKILL.md` frontmatter 协议 |
| Compaction | ✅ 真自带（客户端实现，协议无关，0 行 kernel 代码） |
| Memory | ✅ CLAUDE.md 层级，自动注入 system prompt |
| Subagent | ✅ `agents` 配置 + Task 工具 |
| Hooks | ✅ 19 种事件（业界最丰富） |
| HITL | ✅ `canUseTool` 同步回调 + SessionStore 异步持久化 |
| File Checkpointing | ✅ 自带（可选启用） |
| Coding agent 调优深度 | ✅ Claude Code 是行业最强 coding agent，agent loop 调优深度领先 |
| prompt 质量 | ✅ Anthropic 自己研究的 prompt 工程结果直接享受 |
| Anthropic Managed Agents schema 对齐 | ✅ 同源天然对齐（虽不是第一优先级，是免费优势） |

**已接受的代价**：

| 代价 | 用户已确认接受 |
|---|---|
| 闭源 minified bundle，bug 排查只能读 9.6 MB 压缩代码或等 release | ✅ 初期可接受 |
| 持久化体积 MB 级（vs OpenAI SDK 的 KB 级 RunState） | ✅ 不敏感 |
| 模型协议绑死 Anthropic（无法接 OpenAI/Gemini 协议原生模型） | ✅ 跟"卖腾讯资源"商业模式契合，平台网关已适配 |

---

## 1. 决策演进备忘（精简）

| 版本 | 选型 | 决策驱动 | 结果 |
|---|---|---|---|
| v0.1~v0.4 草案 | OpenCode CLI + ACP | 复用 OpenVibeCoding 现有 70% 代码 | ⚠️ 被否决：ACP 协议绑定、subagent 弱、不够 agentic |
| v0.5 草案 | Claude Agent SDK | Anthropic 原厂调优 + agentic 能力完整 | ⚠️ 短暂回退：因法务/网关/源码三重担忧 |
| v0.6 草案 | OpenAI Agents SDK | MIT 开源 + 法务干净 + 网关 OpenAI 协议已就绪 + RunState KB 级 | ⚠️ 选型确认后发现"agentic 自带"承诺打折：Compaction 在 ChatCompletions 静默失效需 kernel 自补 ~100 行 |
| **v1.0 定稿（本方案）** | **Claude Agent SDK** | 三个关键事实澄清：①网关 Anthropic 协议**已适配** ②法务**已确认无风险** ③闭源 bug 排查**初期可接受**（tcb-headless-copilot 已有实战经验） | ✅ 选定 |

**v1.0 决策核心逻辑**：
- 之前推 OpenAI Agents SDK 的 3 条核心理由（法律风险 / 网关未就绪 / 源码可读）经事实澄清后**2 条消失、1 条降级为可接受**
- 与此同时，Claude SDK 在 agentic 能力深度（plan/skills/compaction/memory/19 hooks/subagent 全部 0 行 kernel 代码自带）和 coding agent 调优深度上的优势保持不变
- 决策回归 Claude Agent SDK

**协议中立护城河**：两版方案的公共 API（`AgentConfig` / `SessionEvent` / `Session` / `Agent`）完全一致。若 Claude SDK 未来出现真正阻塞的闭源限制问题，可在 1-2 周内切换到备用方案（OpenAI Agents SDK），**用户代码零改动**。

### 选型基本盘

| 项 | 决策 |
|---|---|
| Runtime | `@anthropic-ai/claude-agent-sdk`（最新 stable） |
| 模型协议 | Anthropic Messages API（走 CloudBase 网关） |
| 模型路由 | `apiBaseUrl: https://{envId}.api.tcloudbasegateway.com/v1/anthropic` |
| License | kernel 用 MIT（依赖 Anthropic 商业条款，法务已确认无风险） |
| 商业模式 | 卖 CloudBase 资源（envId 锚定） |
| 持久化 | CloudBase DB，实现 SDK `SessionStore` 接口 |
| 沙箱 | 复用 OpenVibeCoding 的 SCF sandbox，通过 `createSdkMcpServer` 包装工具 |
| HITL | `canUseTool` 同步回调 + `SessionStore.append/load` 异步持久化（无 Redis） |
| 协议中立 | kernel 输出协议中立 `SessionEvent`，不绑 ACP/AG-UI |

---

## 2. 用户视角：5 分钟上手

### 2.1 最小可运行示例

```ts
import { createAgent } from '@cloudbase/open-agent-kernel'

const agent = createAgent({
  envId: 'my-env-123',
  model: 'claude-sonnet-4-5',  // 走 CloudBase 网关的 Anthropic 协议
})

const session = await agent.startSession()
for await (const event of session.send('hello')) {
  if (event.type === 'text_chunk') process.stdout.write(event.text)
}
```

**与备用方案的差异**：
- 包名相同（都是主包 `@cloudbase/open-agent-kernel`，备用方案在 Plan B 切换时会保持包名，仅替换内部 runtime 实现）
- model 字符串走 Anthropic 模型语义（`claude-sonnet-4-5` / `hunyuan-xxx` 等通过网关适配的 Anthropic 协议模型）

### 2.2 启用 agentic 完整能力

```ts
const agent = createAgent({
  envId: 'my-env-123',
  model: 'claude-sonnet-4-5',
  sandbox: {
    capabilities: {
      filesystem: true,     // SDK 内置 read/write/edit
      bash: true,           // SDK 内置 Bash
      skills: { from: './skills' },  // SDK 原生 Skills（CLAUDE.md/SKILL.md 风格）
      memory: true,         // CLAUDE.md 层级
      compaction: true,     // SDK 真自带（客户端实现）
    },
  },
  cloudbaseMcp: true,
  agents: {
    dbAgent: {
      description: '数据库专家 agent，处理 schema/查询/migration',
      tools: ['mcp__cloudbase__writeNoSqlDatabaseStructure', '...'],
      prompt: 'You are a database expert...',
    },
  },
  hooks: {
    preToolUse: [/* ... */],
    postToolUse: [/* ... */],
  },
})
```

**关键差异（vs OpenAI Agents SDK）**：

- subagent 用 SDK 原生 `agents` 配置 + `Task` 工具（Claude Code 同款语义）
- Skills 用 SDK 原生 `Skills`（基于 `~/.claude/skills/<name>/SKILL.md`，frontmatter 协议）
- Hooks 19 种事件直接透传（PreToolUse / PostToolUse / SubagentStart / PlanModeStart / 等）

### 2.3 HITL（工具审批）+ 跨节点 resume

```ts
const session = await agent.startSession({ conversationId: 'conv-xyz' })

for await (const event of session.send('删除 logs 集合')) {
  if (event.type === 'approval_required') {
    // 持久化到 CloudBase DB 后断开
    await db.update('conv-xyz', {
      pendingApproval: { approvalId: event.approvalId, tool: event.tool, args: event.args },
    })
    return  // 客户端展示审批 UI，等待用户决策
  }
}

// ─── 任意时间后，可能是另一个 pod ───
const session2 = await agent.resumeSession('conv-xyz')
await session2.resolveApproval(approvalId, 'allow')
for await (const event of session2) { /* 继续输出 */ }
```

**与主方案差异**：
- 主方案：`RunState.toJSON()` 序列化为 KB 级 JSON 存到 DB
- 本方案：依赖 SDK `SessionStore` 接口，整个 transcript 增量落 DB（MB 级，按对话长度增长）
- 体积差异已被用户确认"不敏感"，可接受

---

## 3. 公共 TypeScript 类型签名

跟主方案**完全相同**（协议中立的承诺）。kernel 公共 API 不暴露任何 Claude SDK 内部类型，开发者从 OpenAI SDK 方案迁移到 Claude SDK 方案**应该零代码改动**（除了包名和 model 字符串）。

```ts
export interface AgentConfig {
  envId: string
  model: string
  resources?: ResourceOverrides
  sandbox?: SandboxConfig
  cloudbaseMcp?: boolean | CloudbaseMcpConfig
  agents?: Record<string, SubagentConfig>
  tools?: CustomTool[]
  mcpServers?: McpServerConfig[]
  hooks?: HookConfig
  permission?: PermissionConfig
  systemPrompt?: string
}

export type SessionEvent =
  | { type: 'agent_started'; agent: AgentRef }
  | { type: 'agent_switched'; from: AgentRef; to: AgentRef }
  | { type: 'tool_call'; agent: AgentRef; tool: string; args: unknown; toolCallId: string }
  | { type: 'tool_output'; agent: AgentRef; output: unknown; toolCallId: string }
  | { type: 'approval_required'; agent: AgentRef; tool: string; args: unknown; approvalId: string }
  | { type: 'text_chunk'; agent: AgentRef; text: string }
  | { type: 'thinking_chunk'; agent: AgentRef; text: string }
  | { type: 'plan_chunk'; agent: AgentRef; text: string }
  | { type: 'done'; finalAgent: AgentRef }

// ... 其余类型与主方案一致
```

→ **未来用户从 Claude SDK 方案切到 OpenAI SDK 方案（或反过来）只需换包名 + 调整 model 字符串**。kernel 的公共 API 是协议护城河。

---

## 4. 内部模块划分

跟主方案结构一致，唯一差异在 `runtime/`：

```
packages/open-agent-kernel/
├── src/
│   ├── index.ts                          # 公共 API
│   ├── public/
│   │   ├── types.ts                      # 与主方案完全一致
│   │   └── create-agent.ts
│   ├── internal/
│   │   └── errors.ts
│   ├── runtime/                          # ← 唯一接触 @anthropic-ai/claude-agent-sdk 的模块
│   │   ├── agent-builder.ts              # 把 AgentConfig 拼装成 SDK `query()` 调用
│   │   ├── event-translator.ts           # SDK SDKMessage / SDKAssistantMessage → SessionEvent
│   │   ├── hook-bridge.ts                # kernel hooks → SDK hooks 19 种事件
│   │   ├── permission-bridge.ts          # kernel permission → SDK canUseTool
│   │   └── credential-factory.ts         # envId → Anthropic 协议 client 配置
│   ├── resources/                        # 与主方案一致
│   ├── session-store/                    # ← 关键差异：实现 SDK SessionStore 接口
│   │   └── cloudbase-session-store.ts
│   ├── sandbox/                          # 与主方案一致
│   ├── mcp/                              # CloudBase MCP via createSdkMcpServer
│   └── perms/                            # 复用主方案的 WRITE_TOOLS + normalizeToolName
└── package.json
```

### 关键模块边界

- **`runtime/`**：唯一接触 `@anthropic-ai/claude-agent-sdk` 类型的模块
- **`session-store/`**：实现 SDK 的 `SessionStore` 接口（`append/load/listSessions/delete/listSubkeys`），落 CloudBase DB
- **`sandbox/`**：把 OpenVibeCoding 沙箱 HTTP 协议包装为多个 `createSdkMcpServer` 注册的工具（read/write/edit/bash/glob/grep）

---

## 5. agentic 能力实现矩阵（基于 Claude SDK 源码事实）

> ⚠️ Claude Agent SDK 是闭源 minified bundle。本节"源码事实"部分基于：
> - 官方公开文档（https://code.claude.com/docs/en/agent-sdk/typescript）
> - 已发布的 d.ts 类型声明
> - 社区调研（DeepSeek/DeepInfra/aihubmix 等 Anthropic 协议适配验证）
>
> 与主方案"完整源码可读"不同，本方案的部分能力细节**只能依赖官方文档承诺**。

### 5.1 总览矩阵

| 能力 | SDK 自带可用？ | kernel 工作量 | 用户感知复杂度 | 依赖 |
|---|---|---|---|---|
| Agent loop / Tool calling | ✅ 完全自带 | 0 行 | 无 | — |
| MCP（http/sse/stdio + `createSdkMcpServer`） | ✅ 完全自带 | 0 行 | 无 | — |
| Subagent (`agents` + Task 工具) | ✅ 完全自带 | 0 行 | 一个配置块 | — |
| Plan 模式 (`permissionMode: 'plan'`) | ✅ 完全自带 | 0 行 | 一个枚举 | — |
| HITL (`canUseTool`) | ✅ 完全自带 | 0 行 | 一个回调 | — |
| Sessions / 持久化 (`SessionStore` 接口) | ✅ 接口自带 | ~200 行 CloudBaseSessionStore | 无 | CloudBase DB |
| Sandbox（read/write/edit/bash 工具） | ⚠️ SDK 内置工具默认走本机 | ~250 行 SDK MCP server 包装到 CloudBase 沙箱 | 无 | CloudBase SCF |
| **Skills** | ✅ 完全自带（`~/.claude/skills/<name>/SKILL.md`） | ⚠️ 需把 skills 文件投递到 SDK 期望的目录或 settingSources 注入 | 1 行配置 | 文件系统 |
| **Compaction** | ✅ 真自带（客户端实现） | 0 行 | 一个布尔 | — |
| **Memory（CLAUDE.md）** | ✅ 自带，但默认读本地 `~/.claude/CLAUDE.md` | ⚠️ 需把 memory 内容通过 settingSources 注入 | 1 行配置 | 文件系统 |
| Hooks 19 种事件 | ✅ 完全自带 | ~50 行翻译 hookConfig → SDK hooks | 一个配置块 | — |
| File Checkpointing | ✅ 完全自带 | 可选启用 | 一个布尔 | 本地 FS（需绕过） |

**总工作量：~500-600 行 kernel 内部代码**（其中 250 行是 sandbox MCP server，200 行是 SessionStore，跟主方案规模相近）。

### 5.2 三项关键能力的实现细节

#### 5.2.1 Skills

**SDK 行为**：
- 默认读 `~/.claude/skills/<name>/SKILL.md`（frontmatter + markdown 内容）
- 通过 `settingSources` 控制扫描哪些路径
- Skill 内容是注入 system prompt 还是按需懒加载，由 SDK 内部决定（黑盒）

**kernel 实现**：

```ts
// 用户配置
sandbox: { capabilities: { skills: { from: './skills' } } }

// kernel 内部行为：
//  ① 启动时把 ./skills/<name>/SKILL.md 内容复制/链接到 SDK 期望的目录
//     （例如临时目录 + 设置 settingSources: [path] 显式指定）
//  ② 启用 SDK Skills 能力
//  ③ 无 sandbox 时 fallback 为 system prompt markdown 注入（约 30 行）
```

**与主方案差异**：
- 主方案 Skills 注入到沙箱 workspace 的 `.agents/<skill-name>/`，跟"agent 的可执行环境"天然契合
- 本方案 Skills 注入到 SDK 期望的本机路径（或通过 settingSources 显式指定），**有"本地文件依赖"** —— 需要 kernel 自己解决"无本地文件运行环境"问题（用临时目录 + 跑完清理）

#### 5.2.2 Compaction —— **本方案的真正优势**

**SDK 行为**：
- Claude Agent SDK 的 compaction 是**客户端实现**（不依赖 Anthropic 平台扩展端点）
- 走任何 Anthropic 协议适配的模型都能用（hunyuan-xxx 通过 CloudBase 网关、Claude 官方、aihubmix 等）

**kernel 实现**：

```ts
// 用户配置
sandbox: { capabilities: { compaction: true } }

// kernel 内部行为：
//  ① 直接启用 SDK 自带的 compaction 选项
//  ② 0 行装饰器代码
```

**与主方案对比**：
- 主方案 OpenAI Agents SDK `compaction()` 在 ChatCompletions 时静默失效，需 kernel 自补 ~100 行装饰器
- **本方案 0 行**，这是 Claude SDK 在 agentic 能力深度上的真实优势

#### 5.2.3 Memory（CLAUDE.md）

**SDK 行为**：
- SDK 默认扫描 `~/.claude/CLAUDE.md`（用户级）+ `<project>/CLAUDE.md`（项目级）+ `<project>/.claude/CLAUDE.md`
- 内容自动拼到 system prompt 头部

**kernel 实现挑战**：
- 我们是云服务，没有"用户级 ~/.claude/" 或 "项目级 <project>/"
- 必须用 `settingSources` 显式指定路径，把"逻辑上的 Memory"物化到临时目录

```ts
// 用户配置
sandbox: { capabilities: { memory: true } }

// kernel 内部行为：
//  ① 从 CloudBase DB 读 conversationId 的 memory 内容（如有）
//  ② 写到临时目录 /tmp/<sessionId>/CLAUDE.md
//  ③ 启动 SDK 时 settingSources: ['/tmp/<sessionId>']
//  ④ run 结束后清理临时目录
//  ⑤ 若 agent 在运行中修改 CLAUDE.md（自学习场景），run 结束时把内容写回 CloudBase DB
```

**与主方案对比**：
- 主方案 OpenAI SDK Memory 是 capability，用沙箱 workspace 的 `memories/` 目录 + 两阶段提取流程，**调模型做摘要**
- 本方案 Claude SDK Memory 是"自动注入文件内容到 system prompt"，**不调额外模型**，但需要 kernel 解决"无本地文件运行环境"问题
- 两者抽象不同，工作量相当

### 5.3 凭证流转架构

```
┌─────────────────────────────────────────────────────────────────┐
│ kernel 内部 `resources/credential-factory.ts`                     │
│                                                                  │
│ envId  ─┐                                                        │
│         ├──→  @cloudbase/manager-node                            │
│         │    issueTempCredentials() → 临时凭证                    │
│         │                                                        │
│         └──→  Anthropic 协议 client 配置                          │
│              {                                                   │
│                apiBaseUrl: 'https://{envId}.api.tcloudbasegateway │
│                             .com/v1/anthropic',                  │
│                apiKey: ephemeralAnthropicKey,                    │
│                customHeaders: { 'X-CB-Env': envId, ... },        │
│              }                                                   │
│                                                                  │
│              ↓ 注入 SDK query() 的 options                        │
│                                                                  │
│  ┌─────────────────┬──────────────────┬─────────────────────┐   │
│  │  主 agent model  │ compaction 用同款 │ subagent 共享 client │   │
│  └─────────────────┴──────────────────┴─────────────────────┘   │
│                                                                  │
│  统一的 client → 统一的 apiBaseUrl/apiKey → 用户零感知              │
└─────────────────────────────────────────────────────────────────┘
```

**与主方案差异**：
- 主方案：`new OpenAI({ baseURL, apiKey })` 构造一个 client，分发给主 model / memory / compaction 各处
- 本方案：Claude SDK 没有"暴露 client 实例给用户"的概念，所有配置都通过 `query()` 的 `options` 透传；envId 派生的 `apiBaseUrl`/`apiKey` 注入到 options，SDK 内部自己用

---

## 6. CloudBase 资源接入路径

### 6.1 envId → 资源派生规则

```
envId = 'my-env-123'

→ 数据库集合：
  conversations: '{prefix}_conversations'    （默认 prefix = 'agent'）
  messages:      '{prefix}_messages'
  sessions:      '{prefix}_sessions'          ← Claude SDK SessionStore 用

→ 模型网关：
  apiBaseUrl: 'https://{envId}.api.tcloudbasegateway.com/v1/anthropic'
                                              ↑ 与主方案 /v1/openai 的差异

→ 凭证：
  通过 @cloudbase/manager-node 自动获取临时密钥

→ 沙箱：
  SCF 函数：'agent-sandbox'（envId 维度）
  沙箱 HTTP base：从 SCF 函数返回值动态获取
```

### 6.2 CloudBase 资源 → Claude Agent SDK 注入路径

```
┌──────────────────────────────────────────────────────────────────┐
│ kernel createAgent(config) 内部                                    │
│                                                                    │
│ 1. resources/name-resolver:  envId → 派生所有资源 URL/名称          │
│ 2. resources/model-gateway:  config.model → apiBaseUrl + apiKey     │
│ 3. session-store/CloudBaseSessionStore:                             │
│    实现 SDK SessionStore 接口（append/load/...），落 CloudBase DB    │
│ 4. sandbox/sandbox-mcp-factory:                                     │
│    用 createSdkMcpServer 包装 read/write/edit/bash/glob/grep 工具，  │
│    内部转发到 CloudBase SCF 沙箱 HTTP API                            │
│ 5. mcp/cloudbase-mcp-server:                                        │
│    用 createSdkMcpServer 把 CloudBase MCP 工具包装为 SDK MCP server   │
│ 6. runtime/agent-builder:                                           │
│    拼装 query() 的 options：                                         │
│      - apiBaseUrl + apiKey                                          │
│      - sessionStore: CloudBaseSessionStore                          │
│      - mcpServers: [sandboxMcp, cloudbaseMcp, ...]                  │
│      - hooks: 翻译自 kernel hookConfig                               │
│      - canUseTool: 翻译自 kernel permission                          │
│      - agents: 透传 subagent 配置                                    │
│      - settingSources: [] + strictMcpConfig: true                   │
│           ↑ 关键：禁用本地文件读取                                    │
│                                                                    │
│ 7. 返回 kernel 自己的 Agent 类（包装 SDK query() 调用）              │
└──────────────────────────────────────────────────────────────────┘
```

**关键差异（vs 主方案）**：
- Claude SDK 默认读 `~/.claude` 等本地文件，必须显式 `settingSources: []` + `strictMcpConfig: true` 关掉
- Claude SDK 的 file checkpointing 默认开启写本地文件，需要评估是否要关闭（影响 file_checkpointing hook 的可用性）
- 所有工具配置走 `mcpServers`（不是 OpenAI SDK 的 `tools` 数组）

---

## 7. HITL 实现路径（无 Redis）

### 7.0 基础流程

```
agent.run('删除 logs 集合')
  ↓
@anthropic-ai/claude-agent-sdk 调用 canUseTool 回调
  ↓
kernel 的 canUseTool 实现（permission-bridge.ts）：
  ① 检查 sessionPermissions（已 allow_always）→ allow
  ② normalize 工具名 → 命中 WRITE_TOOLS → 触发审批
  ③ emit kernel SessionEvent { type: 'approval_required', approvalId, ... }
  ④ 返回 { behavior: 'deny', interrupt: true }
  ↓
SDK 抛出 ExecutionError("Permission denied for tool(s): ...")
  ↓
kernel 捕获该 error，把当前 session 状态通过 SessionStore.append 落 DB
  ↓
当前请求结束，无任何驻留状态
  ↓
（任意时间后，可能是另一个 pod）
  ↓
session2 = await agent.resumeSession(sessionId)
  ↓ 内部 CloudBaseSessionStore.load(sessionId) → SDK 拿回 transcript
  ↓
session2.resolveApproval(approvalId, 'allow')
  ↓ 内部更新 sessionPermissions + 触发 SDK 重启 turn
  ↓
继续输出事件流
```

**与主方案的关键差异**：

| 项 | 主方案 (OpenAI SDK) | 本方案 (Claude SDK) |
|---|---|---|
| 中断状态体积 | `RunState.toJSON()` ~KB | 整个 transcript ~MB |
| 恢复语义 | `state.approve(item)` + 续跑（从中断点接） | SDK 重新执行被 deny 的 turn（不是断点续传） |
| 多次审批的实现 | 每次 approve 都 resume 1 次，状态精确 | SDK 重启 turn，可能多次调模型（轻微 token 浪费） |

→ 这是 Claude SDK 的"轻微设计代价"。用户层面感受不到差异。

### 7.1 subagent 场景的事件归属

**关键问题**：Claude Agent SDK 的 subagent 通过 `agents` 配置 + `Task` 工具触发，事件流上**默认事件不带 agent 归属字段**（社区调研结论，需要再验证）。

**kernel 实现策略**：
- 监听 `SubagentStart` / `SubagentStop` hook 事件
- 维护当前活跃 agent 的栈状态
- 在翻译 SDK 事件为 SessionEvent 时，从栈顶取 agent name 注入

```ts
// runtime/event-translator.ts 伪代码
const agentStack: AgentRef[] = [mainAgent]

sdkHooks.SubagentStart = ({ subagent }) => {
  agentStack.push({ name: subagent.name, id: subagent.id })
  emitSessionEvent({ type: 'agent_switched', from: agentStack[length-2], to: agentStack[length-1] })
}
sdkHooks.SubagentStop = () => {
  const popped = agentStack.pop()
  emitSessionEvent({ type: 'agent_switched', from: popped, to: agentStack[length-1] })
}

// 翻译每个 SDK 事件时
function translate(sdkEvent) {
  const currentAgent = agentStack[agentStack.length - 1]
  return { ...sdkEvent, agent: currentAgent }
}
```

**与主方案对比**：
- 主方案 OpenAI SDK 每个 `RunItem.agent` 字段一等公民，归属天生确定
- 本方案 Claude SDK 需要 kernel 自己维护 agent 栈，约 50 行实现

### 7.2 CloudBase MCP 工具审批的默认策略

**与主方案完全一致**（设计哲学不变，只是底层翻译到 SDK 不同）：

```ts
function buildCanUseTool(config: AgentConfig) {
  const writeTools = new Set([
    'writeNoSqlDatabaseStructure',
    // ...（与主方案相同的 WRITE_TOOLS）
  ])

  return async (toolName, input, _options) => {
    const normalized = normalizeToolName(toolName)
    if (kernelPermissions.isAllowed(sessionId, normalized)) {
      return { behavior: 'allow' }
    }
    if (writeTools.has(normalized)) {
      emitSessionEvent({ type: 'approval_required', tool: toolName, args: input, approvalId })
      return { behavior: 'deny', message: '等待用户审批', interrupt: true }
    }
    return { behavior: 'allow' }
  }
}
```

**复用 OpenVibeCoding 资产清单**（与主方案一致）：

| OpenVibeCoding 资产 | kernel 角色 |
|---|---|
| `normalizeToolName` | ✅ 直接复用 |
| `WRITE_TOOLS` | ✅ 直接复用 |
| `SessionPermissionsManager` | ✅ 直接复用 |
| `registerPending / resolvePending` 跨进程挂起 | ❌ 被 SessionStore 替代 |

### 7.3 实际落地（PR #7.0 + PR #7.1）

> 实际实现里，本节 7.0 描述的 `canUseTool` 路径**没有采用**。原因：Claude Agent SDK
> 的 `canUseTool` 是父进程内的 await Promise，发起 send 与收到决策的进程必须是
> 同一个，违反 kernel"任意运行时部署"原则。最终落地走"流终止 + resume"范式
> （OpenAI Agents SDK / LangGraph / Vercel AI SDK 同款）。详见
> `packages/open-agent-kernel/README.md` 的"HITL 工具审批 / 分布式审批"章节。

#### PR #7.0 范式

```
session.send(prompt)
  ↓
PreToolUse Hook（permissions/hooks.ts）：
  ① compileRequireApprovalPredicate 命中 → 写 PendingApproval 到 PermissionStore
  ② 返回 deny + sentinel JSON（__OAK_INTERRUPT__）
  ↓
SDK 把 deny + sentinel 当作普通 tool_result 流出
  ↓
Event translator（runtime/event-translator.ts）识别 sentinel：
  ① 吐 SessionEvent { type: 'tool_approval_required', toolUseId, toolName, input }
  ② 吃掉假 deny 的 tool_result
  ③ 吐 SessionEvent { type: 'session_idle', reason: 'requires_action' }
  ↓
async generator 自然结束 —— 当前请求结束，无任何驻留 Promise
  ↓
（任意时间后，可能在另一个进程 / 另一节点）
  ↓
session.respondApproval({ toolUseId, decision })
  ① 把 decision 写回 PermissionStore（按 conversationId + toolUseId 的旧 entry）
  ② 起一轮新 SDK query：resume=conversationId + 引导 prompt
  ↓
模型从 transcript 重新发起工具调用（新 toolUseId 但同 toolName）
  ↓
PreToolUse Hook 再次触发：
  ① 先按 toolUseId 查 store —— 命中（首选路径）
  ② miss 则按 conversationId + toolName 兜底 scanRecent —— 命中（resume 主路径）
  ③ 读 decision.kind：'allow' → 放行；'deny' → 返回 deny + reason
  ↓
工具正常执行 → tool_result → 模型继续输出 → session_idle: completed
```

#### PR #7.1 分布式落地

PR #7.0 的"流终止 + resume"已经把分布式所需状态全部外置到接口（`PermissionStore` + `SessionStore`），PR #7.1 只需把这两个接口的默认 InMemory 实现替换成 CloudBase DB driver：

| 接口 | InMemory 实现（默认） | CloudBase DB 实现（PR #7.1） |
|---|---|---|
| `SessionStore`（transcript） | `CloudBaseSessionStore({ driver: new InMemoryDriver() })` | `CloudBaseSessionStore({ driver: new CloudBaseDbDriver(), projectKey: envId })` |
| `PermissionStore`（审批状态） | `new InMemoryPermissionStore()` | `new CloudBasePermissionStore({ driver: new CloudBaseDbPermissionDriver(), projectKey: envId })` |

**单集合 `oak_permissions`**：

- 主键查询索引：`(projectKey, conversationId, toolUseId)`
- `scanRecent` 加速索引：`(projectKey, conversationId, toolName, createdAt desc)`
- `decision: null` 表 pending；非 null 即 `ApprovalDecision`

**`put` 用 remove+add replace 语义**（绕开 CloudBase DB `update` 对嵌套对象字段的"点路径合并"陷阱：当原行 `decision: null` 时，`update({ decision: {kind, scope} })` 被 SDK 转换为 `$set: { 'decision.kind': ..., 'decision.scope': ... }` 报错"Cannot create field 'kind' in element {decision: null}"）。

**Driver 模式与 SessionStore 同构**：业务可自实现 `PermissionStoreDriver` 接口落 Postgres / Redis / Mongo 等任意后端，`CloudBasePermissionStore` 自动注入 `projectKey: envId` 做多租户隔离，driver 实现只关心 KV 存取。

完整 e2e 演示：[`packages/open-agent-kernel/examples/13-hitl-distributed-cloudbase.ts`](../packages/open-agent-kernel/examples/13-hitl-distributed-cloudbase.ts)（同进程构造两个独立 createAgent 实例模拟跨节点：A `send` → B `respondApproval`，共享 CloudBase DB）。

---

## 8. 与现有 OpenVibeCoding 项目的关系

### 8.1 复用清单

跟主方案完全相同：

| 模块 | 复用价值 |
|---|---|
| `scf-sandbox-manager` | ✅ 直接复用（沙箱 SCF 函数管理） |
| `tool-override` HTTP 协议 | ✅ 作为沙箱工具传输层（不变） |
| `sandbox-mcp-proxy` cloudbase MCP 集成 | ✅ 直接复用（包装为 `createSdkMcpServer`） |
| `normalizeToolName` + `WRITE_TOOLS` | ✅ 直接复用 |
| `SessionPermissionsManager` | ✅ 直接复用 |

### 8.2 不复用

| 模块 | 不复用原因 |
|---|---|
| OpenVibeCoding `MessagePersistenceService`（800 行 JSONL 双向同步） | 用 SDK 官方 `SessionStore` 接口取代 |
| `registerPending / resolvePending` | 被 SessionStore.append/load 取代 |
| `OpenCode ACP runtime` | runtime 换成 Claude SDK |
| `pendingPermissionRegistry` | 同上 |

### 8.3 PR 拆分

| PR | 范围 | 验证 |
|---|---|---|
| **#1** | 建骨架 (`packages/open-agent-kernel/`) | `pnpm install` + `pnpm build` 通过 |
| **#2** | 实现 `runtime/` (Claude Agent SDK 薄封装) | minimal example 跑通 hello world |
| **#3** | 实现 `resources/` (envId 派生) | 单元测试 |
| **#4** | 实现 `session-store/` (CloudBaseSessionStore + 13 个 conformance test) | 跨实例 resume 集成测试 |
| **#5** | 实现 `mcp/` (CloudBase MCP via createSdkMcpServer) | agent 调用数据库工具 e2e |
| **#6** | 实现 `sandbox/` (read/write/edit/bash via createSdkMcpServer) | filesystem/shell 操作 e2e |
| **#7.0** | 实现 `permissions/` HITL：`requireApproval` + `respondApproval` + 流终止 + resume + `InMemoryPermissionStore` | example 11 (CLI) + example 12 (ACP 适配) e2e |
| **#7.1** | `CloudBasePermissionStore` + `CloudBaseDbPermissionDriver`（落 CloudBase DB） | example 13 跨实例 e2e（A `send` → B `respondApproval`） |
| **#8** | examples/ + README | 手动验收 |

---

## 9. package.json 草案

```json
{
  "name": "@cloudbase/open-agent-kernel",
  "version": "0.1.0-alpha.0",
  "description": "CloudBase Open Agent Kernel (Claude SDK variant)",
  "license": "MIT",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^1.0.0",
    "@modelcontextprotocol/sdk": "^1.x"
  },
  "peerDependencies": {
    "@cloudbase/node-sdk": "^3.x",
    "@cloudbase/manager-node": "^4.x"
  }
}
```

⚠️ **法律合规备注**：依赖 `@anthropic-ai/claude-agent-sdk` 受 Anthropic Commercial Terms 约束。kernel 本身 MIT，但**通过 kernel 间接使用 Anthropic CLI 是否符合 Anthropic 商业条款（尤其当模型走 CloudBase 网关时）需要法务确认**。这是本方案相对主方案的**关键法律风险**。

---

## 10. MVP 不做的事

跟主方案一致：

- 客户端 SDK（浏览器 / RN）
- ACP / AG-UI 协议适配层
- 内置控制台 / 管理 UI
- Multi-runtime（同时支持 Claude / OpenAI SDK）
- 用户自定义 storage adapter
- 用户自定义 sandbox provider
- 资源消耗查询
- 配置加载（YAML / base64）

---

## 11. 与 cloudbase-managed-agent（C 形态）的关系

- kernel 是底座，cloudbase-managed-agent 内部 import 我们
- kernel 公开类型与 cloudbase-managed-agent 的 yaml schema 一对一映射
- ACP HTTP 等客户端协议由 C 形态自己适配
- **本方案的额外优势**：因为 Claude SDK 本身就是 Anthropic 生态，kernel 公开类型**自然对齐 Anthropic Managed Agents schema**（虽然你确认这不是第一优先级）

---

## 12. 与 ACP 协议的关系

跟主方案完全一致：kernel 协议中立，ACP 适配是上层 / 未来扩展包的职责。

**唯一差异**：Claude Agent SDK 的事件类型（SDKMessage / SDKAssistantMessage / SDKResultMessage 等）需要翻译到 kernel SessionEvent。翻译层规模与 OpenAI Agents SDK 相当。

---

## 13. 与主方案对比的优劣总结

### 本方案（Claude SDK）的相对优势

| 项 | 优势 |
|---|---|
| **Compaction** | 真自带（客户端实现），0 行 kernel 代码 |
| **Anthropic Managed Agents schema 对齐** | 同源天然对齐（虽然不是第一优先级） |
| **Hooks 数量** | 19 种事件，业界最丰富 |
| **Coding agent 调优** | Claude Code 是行业最强 coding agent，agent loop 调优深度领先 |
| **prompt 质量** | Anthropic 自己研究的 prompt 工程结果直接享受 |
| **Skills 设计哲学** | SKILL.md frontmatter 是 Anthropic 原创设计 |

### 本方案（Claude SDK）的相对劣势

| 项 | 劣势 |
|---|---|
| **License** | Anthropic Commercial Terms（**法律合规风险**，尤其网关重定向场景） |
| **源码可读** | 9.6 MB minified bundle，bug 排查困难 |
| **网关协议就绪度** | Anthropic 协议适配中（vs OpenAI 协议已就绪） |
| **持久化体积** | transcript MB 级（vs RunState KB 级） |
| **subagent 事件归属** | 需 kernel 自己维护栈（vs OpenAI SDK 每个 RunItem 带 agent） |
| **本地文件依赖** | SDK 默认读 `~/.claude` 等，需 `settingSources: []` 显式关闭 |
| **5 分钟上手** | 同样优秀，但用户对 OpenAI 协议更熟悉，迁移成本略低 |

### 在本场景下的综合判断

主方案最终选 OpenAI Agents SDK 的核心理由（详见主方案 §1）：

1. ✅ MIT 开源 + 源码可读
2. ✅ 法律合规干净
3. ✅ CloudBase 网关 OpenAI 协议**已就绪**
4. ✅ HITL 状态体积小
5. ✅ subagent 事件归属一等公民
6. ⚠️ Compaction / Memory 需 kernel 补 ~130 行（可控成本）

本方案适用场景：

- 当 CloudBase 网关 Anthropic 协议完整就绪后
- 且法务对 Anthropic Commercial Terms + 网关重定向的兼容性给出明确放行
- 且团队接受闭源 SDK 的 bug 排查方式（读 minified bundle）
- 此时本方案才有"换装"价值

→ **不推荐立即采用本方案**，本文档作为**未来评估"如果重选会怎样"的对照基线**保留。

---

## 14. 已确认决策一览表（本方案版本）

| # | 项 | 决策 |
|---|---|---|
| 1 | Runtime | **Claude Agent SDK** |
| 2 | License | kernel MIT（依赖商业条款 SDK） |
| 3 | 商业模式 | 卖 CloudBase 资源（envId 锚定） |
| 4 | 分包 | `packages/open-agent-kernel/` |
| 5 | 模型路由 | Anthropic 协议走 CloudBase 网关 |
| 6 | 持久化 | CloudBase DB（实现 SDK `SessionStore` 接口） |
| 7 | 沙箱 | 复用 OpenVibeCoding SCF sandbox，工具通过 `createSdkMcpServer` 注入 |
| 8 | HITL | `canUseTool` 同步回调 + SessionStore.append 持久化（无 Redis） |
| 9 | 协议中立 | kernel 输出协议中立 SessionEvent |
| 10 | 公共 API | 与主方案完全一致（可互换） |
| 11 | 凭证 | 内部统一 envId → apiBaseUrl/apiKey factory |
| 12 | 法务 | ⚠️ **必须法务确认** Anthropic Commercial Terms + 网关重定向兼容性 |
| 13 | 本地文件 | 显式 `settingSources: []` + `strictMcpConfig: true` 关闭 SDK 本地依赖 |
| 14 | Skills/Memory 物化 | kernel 内部用临时目录 + 跑完清理（无本地文件长期依赖） |

---

## 附录 A：Plan B 切换路径（主方案 → 备用方案 OpenAI Agents SDK）

若 Claude SDK 出现真正阻塞的闭源限制（具体场景见附录 B），切换到备用方案 [`open-agent-kernel-design-openai-sdk-alternative.md`](./open-agent-kernel-design-openai-sdk-alternative.md)：

| 改动模块 | 改动范围 | 预估工作量 |
|---|---|---|
| `package.json` 依赖 | `@anthropic-ai/claude-agent-sdk` → `@openai/agents` | 1 行 |
| `resources/model-gateway.ts` | apiBaseUrl 后缀 `/v1/anthropic` → `/v1/openai` | 几行 |
| `runtime/agent-builder.ts` | 完全重写：调用 SDK 方式不同 | 高（~300 行） |
| `runtime/event-translator.ts` | 完全重写：SDK 事件类型不同 | 高（~200 行） |
| `runtime/hook-bridge.ts` | 完全重写：Claude SDK 19 种 hooks → OpenAI SDK lifecycle hooks 映射 | 中（~150 行） |
| `runtime/permission-bridge.ts` | 改写：canUseTool → needsApproval | 中（~80 行） |
| `session-store/cloudbase-session-store.ts` | 改写：SessionStore 接口 → 自实现 RunState DB 存取 | 中（~150 行） |
| `sandbox/` 工具包装 | 中等：`createSdkMcpServer` → `SandboxClient` 接口 | 中（~200 行） |
| `mcp/` CloudBase MCP | 几乎不变 | 低 |
| `perms/` (WRITE_TOOLS / normalizeToolName / SessionPermissionsManager) | **不变** | 0 |
| `public/` 公共 API | **不变**（协议中立护城河） | 0 |

**总切换工作量**：~1100 行代码重写，AI 辅助下 **1-2 周完成**。

**用户视角**：包名不变（仍是 `@cloudbase/open-agent-kernel`），公共类型签名不变，**用户代码零改动**。

→ kernel 设计的协议中立承诺保证了**双方案可互换**，没有"runtime 锁死"风险。

---

## 附录 B：可能触发 Plan B 切换的场景

下列任一场景出现且无法通过 kernel 层规避，应启动 Plan B 切换：

| # | 触发场景 | 说明 |
|---|---|---|
| T1 | Claude SDK 内部 bug 在生产环境频繁触发，Anthropic 修复周期 > 2 周 | 闭源 SDK 无法 fork |
| T2 | Claude SDK 升级引入 breaking change，且我们已重度依赖被改动的 API | 跟随 Anthropic 版本节奏的代价过高 |
| T3 | Claude SDK 与 CloudBase 网关 Anthropic 适配层有冲突，且双方都不愿迁就 | 协议层不可控 |
| T4 | 持久化 transcript 体积在实际场景下成为性能瓶颈（单次 resume > 1s 延迟） | tcb-headless-copilot 已有经验，初期接受，需持续监控 |
| T5 | 法务后续审查反复，Anthropic 商业条款解读变化 | 当前已确认无风险 |
| T6 | 闭源 bug 排查成本随时间累积，团队明确反馈不可持续 | "初期可接受" → "长期不可接受"的拐点 |

**监控指标（应纳入运维看板）**：

- Claude SDK 版本升级频率 + breaking change 比例
- 跨节点 resume 平均延迟 / P95 延迟
- 内部 bug 排查工时 / 月

---

## 附录 C：本方案的关键开放问题（需调研/确认）

> 注：原文档中的 Q2（网关协议就绪）、Q3（法务）已被 2026-05-21 用户确认解决，从开放问题列表移除。

| # | 问题 | 影响 |
|---|---|---|
| Q1 | Claude SDK 的 `SessionStore` 接口在 TS SDK 上的最新 stable 版本号、conformance test 实际状态 | 决定 PR #4 何时可启动 |
| Q4 | Claude SDK 的 file checkpointing 能否完全关闭（避免本地文件依赖） | 决定是否需要额外的"无本地文件运行"hack |
| Q5 | Claude SDK 的 subagent 事件流是否带 agent 归属信息（实测，而非文档承诺） | 决定 kernel agent stack 维护层是否必要 |
| Q6 | Claude SDK 的 Skills 加载是否支持完全程序化注入（不依赖文件系统） | 决定 Skills 实现复杂度 |
| Q7 | Claude SDK bug 修复响应速度（社区反馈周期）| 决定 kernel 维护风险，与附录 B T1 关联 |
| Q8 | tcb-headless-copilot 模块已踩过的"持久化体积"和"闭源排查"两类坑的具体经验复盘 | 直接复用经验避免重蹈覆辙 |
