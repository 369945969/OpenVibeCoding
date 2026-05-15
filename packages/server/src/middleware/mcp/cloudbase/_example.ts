/**
 * CloudBase MCP Policy 示例
 *
 * ⚠️ 默认不生效：文件名以 `_` 开头，loader 会跳过。
 *
 * 启用方法：把这个文件**复制**成 `<工具名>.ts`（去掉 `_` 前缀，文件名换成你
 * 想拦截/新增的工具名），然后按需删减/调整 `policy.use` 里的逻辑。
 *
 * 例如：
 *   cp _example.ts manageFunctions.ts    # 拦截 manageFunctions 工具
 *   cp _example.ts myCustomTool.ts       # 新增一个虚拟工具
 *
 * 一个 `<工具名>.ts` 文件 = 对一个工具的一份 policy（必须 export 一个名为
 * `policy` 的对象）。
 *
 * 本文件用一个 policy 演示所有支持的能力：
 *   - 改入参（next 之前修改 ctx.input）
 *   - 改输出（next 之后修改返回值）
 *   - 副作用（fire-and-forget 通知/审计）
 *   - 完全接管（不调 next，自己返回结果）
 *   - 抛错拒绝（policy 主动拒绝调用）
 *   - 调用其他工具（ctx.callOriginal 组合）
 *   - 新增虚拟工具（augment 字段）
 *   - 动态隐藏（hidden 函数式）
 *
 * 实际写 policy 时，**只挑你需要的一两条逻辑**即可，不需要全用上。
 */

import type { McpPolicy } from './_index.js'

export const policy: McpPolicy = {
  description: 'Example policy — demonstrates all supported hooks',

  // ── 动态隐藏（可选） ─────────────────────────────────────────────
  // - 静态：hidden: true / false
  // - 动态：函数返回 boolean，可基于 ctx.userId / ctx.sessionId 判断
  // 隐藏后 AI 完全看不到这个工具
  hidden: (_ctx) => false,

  // ── 新增虚拟工具（可选） ─────────────────────────────────────────
  // 仅在原 MCP **没有**这个工具时才需要 augment 字段。
  // 设置 augment 后，必须在 use 里自己返回结果（next 会抛错，因为没有原生兜底）。
  // 如果是拦截既有工具，整个 augment 字段删掉即可。
  //
  // augment: {
  //   description: 'AI 看到的工具描述',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {
  //       name: { type: 'string', description: '...' },
  //     },
  //     required: ['name'],
  //   },
  // },

  // ── 主体逻辑 ────────────────────────────────────────────────────
  async use(ctx, next) {
    // ── 1. 完全接管 / 选择性 fallback ────────────────────────────
    // 不调 next() 就是接管；想"特定情况自己处理，其他透传"就提前 return next()
    if (ctx.input.action === 'no-op') {
      return JSON.stringify({ ok: true, source: 'policy' })
    }

    // ── 2. 抛错拒绝 ──────────────────────────────────────────────
    // 抛出的错误会作为工具错误返回给 AI
    if (ctx.input.dangerous === true) {
      throw new Error('Operation rejected by policy')
    }

    // ── 3. 改入参（next 之前） ──────────────────────────────────
    // 直接修改 ctx.input，next() 会用修改后的版本调用真实 MCP
    ctx.input = {
      ...ctx.input,
      injectedField: 'value-from-policy',
    }

    // ── 4. 调用其他工具组合（可选） ────────────────────────────
    // ctx.callOriginal(name, input) 调用任意原生工具，绕开它们的 policy。
    // 适合"先查依赖资源，再调主工具"的场景。
    // const dep = await ctx.callOriginal('envQuery', { action: 'list' })

    // ── 5. 调用真实 MCP ─────────────────────────────────────────
    const output = await next()

    // ── 6. 改输出（next 之后） ──────────────────────────────────
    // 拿到结果，按需过滤/重写
    let result = output
    try {
      const parsed = JSON.parse(output)
      // 例如：脱敏、过滤数组、改字段
      result = JSON.stringify(parsed)
    } catch {
      // 非 JSON，直接透传
    }

    // ── 7. 副作用（fire-and-forget，不阻塞） ────────────────────
    // 用 void 起一个异步任务，调用方不等待
    void notifyExternal({
      toolName: ctx.toolName,
      userId: ctx.userId,
      output: result.slice(0, 256),
    })

    return result
  },
}

// ── 辅助函数（按需实现） ─────────────────────────────────────────
async function notifyExternal(payload: unknown): Promise<void> {
  const url = process.env.CLOUDBASE_DEPLOY_WEBHOOK
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // 静默失败，不影响主流程
  }
}
