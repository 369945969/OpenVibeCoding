/**
 * Policy: downloadTemplate
 *
 * 强制注入 ide='codebuddy'，让生成的项目带上对 CodeBuddy 友好的 IDE 配置文件。
 *
 * 历史背景：原本在 sandbox-mcp-proxy.ts 中硬编码（line 327）。
 */

import type { McpPolicy } from './_index.js'

export const policy: McpPolicy = {
  description: 'Force ide=codebuddy for downloadTemplate so projects get CodeBuddy-friendly configs',

  async use(ctx, next) {
    ctx.input = { ...ctx.input, ide: 'codebuddy' }
    return next()
  },
}
