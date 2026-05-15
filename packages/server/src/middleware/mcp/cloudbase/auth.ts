/**
 * Policy: auth
 *
 * 当 AI 调 auth(action='start_auth') 时，绕过原 mcporter，直接重新注入凭证。
 * 其他 action 透传到 mcporter。
 *
 * 历史背景：原本在 sandbox-mcp-proxy.ts 中硬编码（line 311-325）。
 */

import type { McpPolicy } from './_index.js'

export const policy: McpPolicy = {
  description: 'Re-inject CloudBase credentials when AI requests start_auth',

  async use(ctx, next) {
    if (ctx.input.action !== 'start_auth') return next()

    const inject = ctx.extra.injectCredentials
    if (!inject) {
      // 没注入入口，按原流程走（避免破坏 OpenCode HTTP 路径）
      return next()
    }

    try {
      await inject()
      return JSON.stringify({ ok: true, message: 'Credentials refreshed' })
    } catch (e: any) {
      return JSON.stringify({ ok: false, message: e.message })
    }
  },
}
