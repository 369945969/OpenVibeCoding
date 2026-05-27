# 对接 chat-playground 的 ACP server 协议规范

> 本文档列出第三方 ACP server 要被 `@coder/chat-playground` 直接消费需要满足的协议契约。  
> 来源：`packages/shared/src/types/{agent,acp}.ts` + `packages/server/src/routes/acp.ts`。

## 1. Transport

- 单一入口（POST）：`<acpBaseUrl>` → JSON-RPC 2.0
- 单一流式入口（GET）：`<observeBaseUrl>/:sessionId?turnId=...` → SSE（断流后 reconnect 用，可选实现）
- playground 默认从 `acpBaseUrl` 推导 observe：`/acp` 后缀替换为 `/observe`；不一致时调用方可显式配置
- 客户端会在每个请求 URL 上追加查询参数 `?i=<method>`（仅用于 devtools 过滤，server 可忽略）

> 部署适配：cloudbase 网关代理路径如 `POST /v1/aibot/bots/:botId/acp` 等也可作为 `acpBaseUrl` 直接使用。这是部署形态，不是协议规定。

## 2. 必须实现的方法

| 方法 | 形态 | 必填 | 说明 |
|---|---|---|---|
| `initialize` | RPC | ✅ | 协议握手 + capability 声明 |
| `session/new` | RPC | ✅ | 创建新会话 |
| `session/list` | RPC | ✅ | 列出当前用户/凭证可见的会话 |
| `session/load` | RPC（普通）+ SSE（replay 模式）| ✅ | 加载会话；带 `replay=true` 时返回 SSE 流 |
| `session/prompt` | SSE | ✅ | 单次对话轮次，按 `session/update` 推送增量事件 |
| `session/cancel` | RPC（notification）| ✅ | 取消进行中的轮次 |
| `session/delete` | RPC | ✅ | 删除会话（ACP spec 扩展，幂等） |

## 3. 通用响应

成功：

```json
{ "jsonrpc": "2.0", "id": <id>, "result": <T> }
```

错误：

```json
{ "jsonrpc": "2.0", "id": <id>, "error": { "code": <number>, "message": "..." } }
```

错误码沿用 JSON-RPC 标准（`-32600 Invalid Request` / `-32601 Method not found` / `-32602 Invalid params` / `-32000 Server error`）。

## 4. 各方法详解

### 4.1 `initialize`

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "protocolVersion": 1 }
}
```

**响应**（关键字段必填）：

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {
      "image": false,
      "audio": false,
      "embeddedContext": false
    },
    "sessionCapabilities": {
      "list": true
    }
  },
  "agentInfo": {
    "name": "your-agent",
    "title": "Your Agent",
    "version": "0.1.0"
  },
  "authMethods": [],
  "supportedModels": []
}
```

⚠️ **playground 当前未严格校验 capability 字段**，但建议如实声明，便于以后做能力探测。

### 4.2 `session/new`

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "conversationId": "<可选 uuid，不传则 server 生成>",
    "meta": {
      "title": "...",
      "selectedAgent": "claude",
      "selectedModel": "...",
      "selectedRuntime": "...",
      "mode": "default",
      "repoUrl": "...",
      "installDependencies": false,
      "maxDuration": 300,
      "keepAlive": false,
      "enableBrowser": false
    }
  }
}
```

`meta` 字段全部可选；server 应该用白名单挑选关心的字段，未知字段忽略。
playground 当前传入的是 `{ meta: { title } }`。

**响应**：

```json
{
  "sessionId": "<server 生成或回显>",
  "hasHistory": false
}
```

行为约定：
- `conversationId` 已存在 → 复用，返回 `hasHistory: <根据已有消息数>`
- 不存在 → 创建一条轻量会话记录，`hasHistory: false`
- 已存在但归属其他用户/凭证 → 返回 `error.code: -32600`

### 4.3 `session/list`

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/list",
  "params": {
    "cursor": "...",        // 可选
    "orderBy": "createdAt", // 可选，'createdAt' | 'updatedAt'
    "cwd": "..."            // 可选，本实现忽略
  }
}
```

**响应**：

```json
{
  "sessions": [
    {
      "sessionId": "...",
      "title": "...",          // 可选；缺失时 playground 显示 "(无标题)"
      "updatedAt": 1730000000000, // 毫秒时间戳，可选
      "_meta": {
        "status": "created",   // 可选；用于 status badge
        "createdAt": 1730000000000
      }
    }
  ],
  "nextCursor": null   // 可选；null/undefined 表示没有下一页
}
```

playground 期望按"最近更新"倒序展示，建议 server 默认 `desc` 排序，返回最近 20 条。

### 4.4 `session/load`

#### 4.4.1 不带 replay（轻量校验）

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/load",
  "params": { "sessionId": "..." }
}
```

**响应**：

```json
{ "sessionId": "..." }
```

playground 在 `useChatStream.initializeSession()` 时调；session 不存在应返回 `error.code: -32602`，playground 会自动 fallback 到 `session/new`。

#### 4.4.2 带 replay（历史分页加载）⭐ playground 加载历史的入口

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/load",
  "params": {
    "sessionId": "...",
    "replay": true,
    "limit": 100,        // 可选，默认 50，最大 100
    "cursor": "0",       // 可选，本实现是 offset 字符串
    "sort": "DESC"       // 可选，'ASC' | 'DESC'，默认 'DESC'
  }
}
```

**响应必须是 SSE**（`Content-Type: text/event-stream`），按顺序推：

1. **一条 history_page 通知**：

```
data: {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{"sessionUpdate":"history_page","messages":[...],"cursor":"0","nextCursor":"100"}}}\n\n
```

2. **最终 RPC result**：

```
data: {"jsonrpc":"2.0","id":5,"result":{"sessionId":"...","nextCursor":"100"}}\n\n
```

3. **结束标记**：

```
data: [DONE]\n\n
```

**`messages[i]` 形状**（参考 `HistoryMessage`）：

```ts
{
  id: string;                    // 服务端 messageId
  taskId: string;                // == sessionId
  role: 'user' | 'agent';        // 注意是 'agent' 不是 'assistant'
  content: string;               // 纯文本聚合
  parts?: HistoryMessagePart[];
  status?: string;               // 'done' | 'error' | 'cancel' | 'pending' | 'streaming'
  createdAt: number;             // 毫秒时间戳
}
```

**`HistoryMessagePart`** 5 种：

```ts
| { type: 'text'; text: string }
| { type: 'thinking'; text: string }
| { type: 'image'; data: string; mimeType: string }   // data: base64
| {
    type: 'tool_call';
    toolCallId: string;
    toolName: string;
    input?: unknown;
    status?: string;
    parentToolCallId?: string;   // 子代理（Task 工具）才用
  }
| {
    type: 'tool_result';
    toolCallId: string;
    toolName?: string;
    content: string;
    isError?: boolean;
    status?: string;             // 'incomplete' 表示中断态，UI 会重建 InterruptionCard
    parentToolCallId?: string;
  }
```

> 历史 part 顺序应保持时间序：`tool_call` 在前，对应的 `tool_result` 在后；`thinking` / `text` 按生成顺序穿插。

### 4.5 `session/prompt`

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "session/prompt",
  "params": {
    "sessionId": "...",
    "prompt": [
      { "type": "image", "data": "<base64>", "mimeType": "image/png" },
      { "type": "text", "text": "user input" }
    ],
    "permissionMode": "default",  // 可选，'default' | 'plan' | 'acceptAll'
    "askAnswers": { "<assistantMessageId>": { "toolCallId": "...", "answers": { "<question>": "<value>" } } }, // resume AskUserQuestion 用
    "toolConfirmation": { "interruptId": "...", "payload": { "action": "allow" | "allow_always" | "deny" | "reject_and_exit_plan" } } // resume tool confirm 用
  }
}
```

**响应必须是 SSE**，每条事件：

```
data: <jsonrpc 帧>\n\n
```

支持的 `session/update` 事件类型：

| sessionUpdate | 何时发 | playground 行为 |
|---|---|---|
| `agent_message_chunk` | 流式输出文本 | 追加到当前 agent 消息的 text part |
| `agent_thought_chunk` | （可选）模型 reasoning | 追加到 thinking part |
| `thinking` | 内部 thinking 文本 | 等同 `agent_thought_chunk` |
| `tool_call` | 工具被调用前 | 创建 tool_call part；UI 渲染 ToolCallCard |
| `tool_call_update` | 工具状态变化（input 增量、result 到达、失败）| 更新 tool_call status / 创建 tool_result |
| `ask_user` | 模型调 AskUserQuestion 工具 | 渲染 AskUserForm，等用户回答 |
| `tool_confirm` | 需用户审批的写工具/Plan | 渲染 InterruptionCard，等用户决策 |
| `agent_phase` | 阶段变化（preparing / model_responding / tool_executing / compacting / idle） | 渲染状态 indicator |
| `log` | 日志（info / error / success / command） | 暂未渲染但解析 |
| `task_progress` | 进度 | 暂未渲染 |
| `artifact` | 产物（image/link/json） | 渲染到 artifact 区 |

**字段细节**（最常用 4 类）：

```ts
// agent_message_chunk
{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '...' } }

// tool_call
{
  sessionUpdate: 'tool_call',
  toolCallId: 'tc_xxx',
  title: 'Bash',                 // 工具显示名
  kind: 'function',
  status: 'in_progress',
  input: { /* 工具入参 */ }
}

// tool_call_update（结果到达）
{
  sessionUpdate: 'tool_call_update',
  toolCallId: 'tc_xxx',
  status: 'completed',           // 'in_progress' | 'completed' | 'failed'
  result: '...',                 // 字符串或 unknown
  error: { message: '...' }      // 失败时
}

// ask_user
{
  sessionUpdate: 'ask_user',
  toolCallId: 'tc_xxx',
  assistantMessageId: 'msg_xxx',
  questions: [{
    question: '使用哪个端口？',
    header: '端口选择',
    options: [{ label: '3000', description: '默认' }, { label: '8080', description: '备选' }],
    multiSelect: false
  }]
}
```

**结束流程**：

1. 全部事件发完后发一条最终 RPC result：

```
data: {"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}\n\n
```

`stopReason`：`end_turn` | `cancelled` | `error`

2. 然后 `data: [DONE]\n\n` 关闭流。

**重连支持**（可选但推荐）：  
如果 server 把 sessionId 同时绑定到一个内存 / DB 流缓冲区，playground 在断流后会用 `GET <observeBaseUrl>/:sessionId?turnId=<id>` 重连。不实现也能正常工作，只是断流后用户必须手动刷新历史。

### 4.6 `session/cancel`

**请求**（无 id，notification 风格）：

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": { "sessionId": "..." }
}
```

**响应**：HTTP 200/204 即可。同时 server 应中断对应 sessionId 的进行中流。

### 4.7 `session/delete`（ACP spec 扩展）

ACP 标准没有定义删除方法；本协议扩展用于让 playground 在列表项 hover 出现的删除按钮工作。

**请求**：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session/delete",
  "params": { "sessionId": "..." }
}
```

**响应**：

```json
{
  "sessionId": "...",
  "deleted": true
}
```

行为约定：
- `sessionId` 缺失 → `error.code: -32602`
- session 不存在或不归属当前凭证 → 返回 `{ sessionId, deleted: false }`（**幂等，不报错**）
- session 存在 → 删除（建议软删，便于审计）→ `{ sessionId, deleted: true }`
- 同时清理该 session 的持久化消息（实现可异步进行）

## 5. Headers / 认证

playground 默认 `credentials: 'include'`（带 cookie）；用户可在配置面板里追加任意 headers，例如：

```
Authorization: Bearer <token>
X-Tenant-Id: t-001
```

server 可以选用以下任一方式做用户隔离：
- Cookie session（同源场景）
- `Authorization: Bearer ...`
- 自定义 header（如 `X-API-Key`）

⚠️ **session/list 必须按当前凭证范围过滤**，否则会泄露其他用户的 session 标题。

## 6. CORS

playground 通常和 server 不同源，server 必须返回：

```
Access-Control-Allow-Origin: <playground origin 或 *（不含 cookie 时）>
Access-Control-Allow-Credentials: true   // 仅当用 cookie
Access-Control-Allow-Headers: Content-Type, Authorization, X-Task-Id, ...
Access-Control-Allow-Methods: POST, GET, OPTIONS
```

## 7. SSE 帧格式

playground 解析的是行级 SSE：

```
data: <一行 JSON>\n
\n
```

注意：
- 必须 `Content-Type: text/event-stream`
- 每条事件 `data: ...\n` 后跟一个空行 `\n` 作为帧分隔
- `data: [DONE]\n\n` 作为流结束标记
- 非 SSE 错误（如鉴权失败）应返回 `application/json` + 标准 JSON-RPC error，playground 会识别并 toast 错误

## 8. 必要的实现清单（Checklist）

- [ ] `POST <acpBaseUrl>` 路由
- [ ] `initialize` 返回正确 capability
- [ ] `session/new` 支持 `params.meta`，至少能存 `meta.title`
- [ ] `session/list` 按凭证过滤，按 createdAt/updatedAt 倒序
- [ ] `session/load` 不带 `replay` 时 RPC 返回，带 `replay` 时 SSE 推一条 `history_page` + result + `[DONE]`
- [ ] `session/prompt` 用 SSE 推 `agent_message_chunk` / `tool_call` / `tool_call_update` / 最终 result + `[DONE]`
- [ ] `session/cancel` 中断当前流
- [ ] `session/delete` 幂等删除会话
- [ ] CORS 允许 playground 域名（含 credentials 时不能用 `*`）
- [ ] 至少支持 cookie 或 Bearer 二者之一作为身份
- [ ] 所有 SSE 错误以 JSON-RPC error 帧形式发出，避免 HTTP 500 让 playground 卡死

## 9. 不必实现的部分

playground 当前不会发起这些请求（即使你不实现也不影响联调）：
- 任何 REST 路径（`GET /sessions` / `DELETE /sessions/:id` 等）—— 全部走 JSON-RPC 即可
- `session/resume` —— playground 走 `session/load` 兼容
- `available_commands_update` —— 没 UI 渲染
- ACP `prompt` 中除 `text` / `image` 外的 content block —— 当前 UI 不构造

## 10. 完整 happy path 示例

```text
1. POST /acp { method: "initialize" }
   → { protocolVersion: 1, agentCapabilities: {...} }

2. POST /acp { method: "session/list" }
   → { sessions: [...], nextCursor: null }

3. 用户点 "+":
   POST /acp { method: "session/new", params: { meta: { title: "新会话 ..." } } }
   → { sessionId: "s1", hasHistory: false }

4. 用户选中 s1，进入对话视图（playground 内部）：
   POST /acp { method: "initialize" }       // AcpClient 内部 doInitialize
   POST /acp { method: "session/load", params: { sessionId: "s1" } }
   → 200/error → 不存在则 fallback session/new

   POST /acp { method: "session/load", params: { sessionId: "s1", replay: true, limit: 100, sort: "DESC" } }
   → SSE: history_page → result → [DONE]

5. 用户输入 "hi" 后：
   POST /acp { method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } }
   → SSE: agent_message_chunk* → result(end_turn) → [DONE]
```
