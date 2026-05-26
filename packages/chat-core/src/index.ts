/**
 * @coder/chat-core — 对话 UI 与 ACP 协议核心
 *
 * 包含：
 * - <TaskChat /> 主对话容器及其全部子组件
 * - useChatStream() SSE 流处理 hook 与 applySessionUpdate 分发器
 * - AcpClient JSON-RPC + SSE 客户端
 * - 对话相关的类型与 jotai atoms
 *
 * 内置最小 shadcn UI 子集（button/card/input/badge/textarea/dropdown-menu），
 * 自包含；消费方无需提供这些组件。
 */

// ─── Top-level Component ──────────────────────────────────────────────
export { TaskChat } from './components/task-chat'
export { AcpChat } from './components/acp-chat'
export type { AcpChatProps } from './components/acp-chat'

// ─── Chat Subcomponents (供独立复用) ───────────────────────────────────
export { ThinkingBlock } from './components/chat/thinking-block'
export { ToolCallCard } from './components/chat/tool-call-card'
export { SubagentCard } from './components/chat/subagent-card'
export { AskUserForm } from './components/chat/ask-user-form'
export { InterruptionCard } from './components/chat/interruption-card'
export { PlanModeCard } from './components/chat/plan-mode-card'
export { AgentStatusIndicator } from './components/chat/agent-status-indicator'
export { TaskListPanel, deriveTasks } from './components/chat/task-list-panel'
export type { DerivedTask } from './components/chat/task-list-panel'
export { MarkdownBlock, mdComponents } from './components/chat/markdown-block'
export { extractPlanContent } from './components/chat/plan-content'

// ─── Tool Renderers ───────────────────────────────────────────────────
export { TOOL_RENDERERS, getToolRenderer, defaultRenderer } from './components/chat/tool-renderers'
export type { ToolRenderer, ToolRenderContext } from './components/chat/tool-renderers'

// ─── Hooks & State Machine ────────────────────────────────────────────
export { useChatStream } from './hooks/use-chat-stream'
export type { ChatStreamReturn } from './hooks/use-chat-stream'
export { applySessionUpdate } from './hooks/apply-session-update'
export type { AgentPhaseInfo, ApplySessionUpdateCtx } from './hooks/apply-session-update'

// ─── ACP Protocol Client ──────────────────────────────────────────────
export { AcpClient, AcpStreamError, fetchWithRetry } from './lib/acp'
export type { AcpClientOptions, RetryConfig } from './lib/acp'

// ─── Atoms (jotai) ────────────────────────────────────────────────────
export { taskChatInputAtomFamily } from './lib/atoms/chat-input'
export { planModeAtomFamily } from './lib/atoms/plan-mode'
export type { PlanModeState } from './lib/atoms/plan-mode'

// ─── Types ────────────────────────────────────────────────────────────
export type {
  TaskMessage,
  MessagePart,
  AskUserQuestionData,
  ToolConfirmData,
  TaskChatProps,
  PRComment,
  CheckRun,
  DeploymentInfo,
  ArtifactInfo,
} from './types/task-chat'
