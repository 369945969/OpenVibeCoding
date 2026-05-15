/**
 * Policy 调度器：经典 koa/Hono 风格 middleware dispatch。
 *
 * 调用方传入 PolicyLoader（决定从哪里取 policy）和默认实现（决定 next() 兜底是什么），
 * 框架负责 chain 编排。
 */

import type { McpContext, McpMiddleware, McpPolicy } from './types.js'
import type { PolicyLoader } from './loader.js'

export async function isToolHidden<Extra>(
  loader: PolicyLoader<Extra>,
  toolName: string,
  base: Omit<McpContext<Extra>, 'toolName' | 'input' | 'scratch' | 'callOriginal'>,
): Promise<boolean> {
  const policy = loader.getPolicy(toolName)
  if (!policy?.hidden) return false
  if (typeof policy.hidden === 'function') {
    try {
      return !!(await policy.hidden({ ...base, toolName }))
    } catch (err) {
      console.error('[mcp-middleware] hidden() threw, treating as not hidden:', toolName, err)
      return false
    }
  }
  return policy.hidden === true
}

/**
 * 执行一次工具调用：policy.use（如果有） → defaultImpl。
 *
 * @param loader        PolicyLoader
 * @param ctxBase       上下文基础字段
 * @param defaultImpl   兜底实现：通常调真实 MCP（mcporter / HTTP 等）
 * @param callOriginal  组合调用入口，传给 ctx.callOriginal
 */
export async function runWithPolicy<Extra>(
  loader: PolicyLoader<Extra>,
  ctxBase: Omit<McpContext<Extra>, 'scratch' | 'callOriginal'>,
  defaultImpl: (input: Record<string, unknown>) => Promise<string>,
  callOriginal: (toolName: string, input: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  const policy: McpPolicy<Extra> | undefined = loader.getPolicy(ctxBase.toolName)

  const ctx: McpContext<Extra> = {
    ...ctxBase,
    scratch: {},
    callOriginal,
  }

  const fallback: McpMiddleware<Extra> = async (c) => defaultImpl(c.input)

  const chain: McpMiddleware<Extra>[] = []
  if (policy?.use) chain.push(policy.use)
  chain.push(fallback)

  return dispatch(ctx, chain, 0)
}

/**
 * 执行一次"新增工具"的调用（policy.augment 已设置）。
 *
 * - 必须有 policy.use（augmented 工具没有原生兜底）
 * - next() 会抛错（明确告知开发者：augmented 工具必须自己返回）
 * - callOriginal 仍可调用其他原生工具（组合实现）
 */
export async function runAugmentedTool<Extra>(
  loader: PolicyLoader<Extra>,
  ctxBase: Omit<McpContext<Extra>, 'scratch' | 'callOriginal'>,
  callOriginal: (toolName: string, input: Record<string, unknown>) => Promise<string>,
): Promise<string> {
  const policy = loader.getPolicy(ctxBase.toolName)
  if (!policy?.augment || !policy.use) {
    throw new Error(`Augmented tool '${ctxBase.toolName}' missing augment+use definition`)
  }

  const ctx: McpContext<Extra> = {
    ...ctxBase,
    scratch: {},
    callOriginal,
  }

  // augmented 工具没有原生 fallback；显式给个抛错的兜底
  const noopFallback: McpMiddleware<Extra> = async () => {
    throw new Error(
      `Augmented tool '${ctx.toolName}' called next() but no native implementation exists. ` +
        `Either return a result directly, or use ctx.callOriginal('<other-tool>', input) instead.`,
    )
  }

  return dispatch(ctx, [policy.use, noopFallback], 0)
}

/** 经典 middleware 调度器 */
function dispatch<Extra>(ctx: McpContext<Extra>, chain: McpMiddleware<Extra>[], i: number): Promise<string> {
  if (i >= chain.length) {
    return Promise.reject(new Error('mcp middleware chain exhausted without returning'))
  }
  const mw = chain[i]
  let called = false
  return Promise.resolve(
    mw(ctx, () => {
      if (called) return Promise.reject(new Error('next() called multiple times'))
      called = true
      return dispatch(ctx, chain, i + 1)
    }),
  )
}
