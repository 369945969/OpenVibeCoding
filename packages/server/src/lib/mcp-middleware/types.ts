/**
 * 通用 MCP Policy Middleware 框架 - 类型定义
 *
 * 与具体 MCP 后端无关。CloudBase 之外的 MCP（如 GitHub MCP / Linear MCP）
 * 也可以复用这个框架，只需传入自己的 extra 上下文。
 *
 * 风格参考 Hono / koa：
 *   policy.use(ctx, next):
 *     - 调 next()        → 走默认实现（最终调真实 MCP）
 *     - 不调 next()      → 完全接管，自行返回结果
 *     - next() 前改 ctx.input  → 改入参
 *     - 拿 next() 的结果再加工 → 改输出
 *     - 抛错             → 拒绝调用，错误返回 AI
 */

/** 调用上下文。Extra 由调用方按 MCP 后端注入（如 sandboxUrl/auth、token 等） */
export interface McpContext<Extra = Record<string, unknown>> {
  /** MCP 工具名 */
  toolName: string
  /** 当前调用的入参（可在 middleware 里就地修改） */
  input: Record<string, unknown>
  /** 当前会话用户 ID */
  userId: string
  /** 当前会话 ID（== conversationId） */
  sessionId: string
  /** 在 middleware 之间传值的便签纸（一次调用内有效） */
  scratch: Record<string, unknown>
  /** 后端特定字段（如 cloudbase 的 sandboxUrl/sandboxAuth） */
  extra: Extra
  /**
   * 调用其他同后端 MCP 工具（用于组合多个 tool）。
   * 不会再次触发对方的 policy（避免环），直接走原始实现。
   */
  callOriginal: (toolName: string, input: Record<string, unknown>) => Promise<string>
}

/** Middleware 函数签名 */
export type McpMiddleware<Extra = Record<string, unknown>> = (
  ctx: McpContext<Extra>,
  next: () => Promise<string>,
) => Promise<string>

/** Policy 文件导出的对象 */
export interface McpPolicy<Extra = Record<string, unknown>> {
  /** 是否对 AI 隐藏（不注册到 MCP server，AI 看不见） */
  hidden?:
    | boolean
    | ((ctx: Omit<McpContext<Extra>, 'input' | 'scratch' | 'callOriginal'>) => boolean | Promise<boolean>)
  /** 中间件函数 */
  use?: McpMiddleware<Extra>
  /** 描述（仅供 review） */
  description?: string

  /**
   * 标记本 policy 为**新增工具**而非拦截既有工具。
   *
   * - 不设置：本 policy 拦截**已有**的同名工具（默认）
   * - 设置：注册一个**新工具**到 MCP server。需要同时提供：
   *   - `description`（必填）：工具说明，AI 会看到
   *   - `inputSchema`（必填）：JSON Schema，描述参数
   *   - `use`（必填）：实现。`next()` 会抛错（无原始实现）
   */
  augment?: {
    /** 工具描述（覆盖顶层 description） */
    description: string
    /** JSON Schema（与 mcporter 输出格式一致） */
    inputSchema: {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
    }
  }
}
