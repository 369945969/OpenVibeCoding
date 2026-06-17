# OpenCode ACP Runtime 重构测试计划

> 将 tool_confirm / askUser 从"进程 hang 住"改为"abort 子进程 + DB 隐式 pending state + 新进程 resume"
> 对齐 CodeBuddy runtime 的 interrupt + resume 模式

## 背景

### 改动前（hang 模式）
- `requestPermission` handler 内存 Promise hang 住子进程
- `/internal/ask-user` HTTP response hang 住子进程
- pending state 在进程内存（`PendingPermissionRegistry` / `PendingQuestionRegistry`）
- 不支持分布式，server 重启丢 state

### 改动后（abort 模式）
- interrupt 时发事件 → abort 子进程 → assistant record `status='pending'`（隐式 state）
- resume 时从 DB 恢复 → `updateToolResult` → spawn 新子进程
- 天然支持分布式（state 在 DB）

## 测试环境

```
模型：MiMo V2.5 Pro (mimo/mimo-v2.5-pro)
端点：https://token-plan-sgp.xiaomimimo.com/v1
配置：.opencode/opencode.json
env：packages/server/.env 中 OPENAI_API_KEY + OPENAI_API_ENDPOINT
启动：pnpm dev
```

---

## 测试用例

### 一、Tool Confirm（工具确认）

#### TC-1.1 基本确认流程
**步骤：**
1. 前端选择 OpenCode runtime，发送 prompt："在当前目录创建一个 hello.txt 文件，写入 hello world"
2. 等待 agent 调用写文件工具

**预期：**
- [ ] agent 触发 `requestPermission`（写文件需要确认）
- [ ] 前端收到 `tool_confirm` SSE 事件，显示确认卡片
- [ ] 子进程被杀（不是 hang 住），SSE 流正常结束
- [ ] assistant record `status='pending'`（DB 中可见）
- [ ] `tool_confirm` 事件写入 `vibe_agent_stream_events`（DB 中可见）

**续：**
3. 用户点"允许"

**预期：**
- [ ] 新 SSE 流建立，新 opencode 子进程启动
- [ ] 对话继续，模型输出正常
- [ ] 最终 assistant record `status='done'`，parts 中有 tool_call + tool_result

#### TC-1.2 拒绝确认
**步骤：**
1. 触发需要确认的操作
2. 用户点"拒绝"

**预期：**
- [ ] 新进程启动，模型收到"用户拒绝了此操作"
- [ ] 模型不重试被拒绝的工具
- [ ] 对话正常继续

#### TC-1.3 连续多次确认
**步骤：**
1. 发送会触发多个写操作的 prompt（如"创建 a.txt 和 b.txt"）
2. 逐个确认

**预期：**
- [ ] 每次 interrupt 后子进程被杀
- [ ] 每次 resume 都能从 DB 正确恢复上下文
- [ ] 最终两个文件都被创建

---

### 二、AskUser（主动提问）

#### TC-2.1 基本提问流程
**步骤：**
1. 发送 prompt："请问我一个问题，关于我想用什么编程语言"

**预期：**
- [ ] 模型调用 `AskUserQuestion` 工具
- [ ] `/internal/ask-user` 立即返回（不 hang），返回 `{ ok: true, status: 'aborted_pending_user_answer' }`
- [ ] 前端收到 `ask_user` SSE 事件，显示问答卡片
- [ ] 子进程被杀，SSE 流正常结束

**续：**
2. 用户回答问题

**预期：**
- [ ] 新进程启动，模型拿到用户回答
- [ ] 模型基于回答继续推理

#### TC-2.2 带选项的提问
**步骤：**
1. 发送 prompt："请我选择一个数据库：MySQL、PostgreSQL 或 MongoDB"

**预期：**
- [ ] 问答卡片显示三个选项
- [ ] 用户选择后，模型基于选择继续

---

### 三、Resume 上下文完整性

#### TC-3.1 历史消息恢复
**步骤：**
1. 完成一次 interrupt + resume 循环
2. 检查 resume 后模型的行为

**预期：**
- [ ] 模型能看到之前的完整对话（包括 tool_call 和 tool_result）
- [ ] 模型理解"用户已批准/回答"的语义
- [ ] 输出连贯，不重复已做过的操作

#### TC-3.2 多轮 interrupt
**步骤：**
1. 第一次 interrupt + resume（tool_confirm）
2. 第二次 interrupt + resume（askUser）
3. 第三次 interrupt + resume（tool_confirm）

**预期：**
- [ ] 每轮上下文都正确恢复
- [ ] 三轮的 tool_call + tool_result 都在 history 中
- [ ] 最终输出正确

---

### 四、SSE 事件流

#### TC-4.1 中断后 SSE 正常结束
**步骤：**
1. 触发 interrupt，观察 SSE 流

**预期：**
- [ ] `tool_confirm` / `ask_user` 事件正常推送
- [ ] SSE 流正常发 `[DONE]` 结束
- [ ] 无报错日志

#### TC-4.2 Reconnect 恢复
**步骤：**
1. 触发 interrupt
2. 断开 SSE 连接
3. 重新连接 `/observe/:sessionId`

**预期：**
- [ ] 能从 `vibe_agent_stream_events` 恢复 `tool_confirm` / `ask_user` 事件
- [ ] 前端 UI 正确显示确认/问答卡片

---

### 五、异常场景

#### TC-5.1 Interrupt 后直接发新消息
**步骤：**
1. 触发 interrupt（前端显示确认卡片）
2. 用户不点确认，直接发新消息

**预期：**
- [ ] 不报错
- [ ] 新消息正常处理（旧 interrupt 被忽略或自动拒绝）

#### TC-5.2 Server 重启恢复
**步骤：**
1. 触发 interrupt
2. 重启 server
3. 前端 reconnect

**预期：**
- [ ] 前端从 stream_events 恢复 UI（显示确认卡片）
- [ ] 用户可以继续操作（确认/回答）

#### TC-5.3 Abort（取消任务）
**步骤：**
1. 触发 interrupt
2. 用户取消任务

**预期：**
- [ ] 清理正常，无孤儿进程
- [ ] assistant record `status='cancel'`

---

### 六、回归测试

#### TC-6.1 CodeBuddy Runtime 不受影响
**步骤：**
1. 切换到 CodeBuddy runtime
2. 执行 TC-1.1 和 TC-2.1 的步骤

**预期：**
- [ ] CodeBuddy 的 tool_confirm 流程正常
- [ ] CodeBuddy 的 askUser 流程正常

#### TC-6.2 OpenCode 普通对话
**步骤：**
1. 不触发任何 interrupt，进行普通多轮对话

**预期：**
- [ ] 对话正常
- [ ] 工具调用（无需确认的）正常
- [ ] 消息持久化到 DB 正常
- [ ] 多轮上下文正常

---

## 验证命令

```bash
# 类型检查
npx tsc --noEmit

# 启动 server
pnpm dev

# 查看 DB 中的 pending records
# CloudBase 控制台 → vibe_agent_messages 集合 → 按 conversationId 查询

# 查看 stream events
# CloudBase 控制台 → vibe_agent_stream_events 集合 → 按 conversationId 查询

# 调试日志
OPENCODE_ACP_DEBUG=1 pnpm dev
```

## 关键检查点

| 检查项 | 怎么查 |
|--------|--------|
| 子进程是否被杀 | `ps aux | grep opencode` — interrupt 后应无残留 |
| assistant record status | CloudBase DB → vibe_agent_messages → 按 conversationId 查 |
| tool_confirm 事件 | CloudBase DB → vibe_agent_stream_events → 按 conversationId 查 |
| updateToolResult 写入 | CloudBase DB → vibe_agent_messages → 检查 parts 中 tool_result 内容 |
| 新进程 history 完整性 | `OPENCODE_ACP_DEBUG=1` 日志中看 contextPrompt |
