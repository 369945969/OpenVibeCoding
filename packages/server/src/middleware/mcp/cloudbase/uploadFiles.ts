/**
 * Policy: uploadFiles
 *
 * 上传完成后从 mcporter 输出中提取部署 URL，触发 artifact 让前端展示链接。
 *
 * 历史背景：原本在 sandbox-mcp-proxy.ts 中硬编码（line 559-574）。
 */

import { extractDeployUrl } from '../../../agent/runtime/base-runtime.js'
import type { McpPolicy } from './_index.js'

function isFilePath(localPath: string): boolean {
  const basename = localPath.replace(/\/+$/, '').split('/').pop() || ''
  return /\.[a-zA-Z0-9]+$/.test(basename)
}

export const policy: McpPolicy = {
  description: 'After upload success, emit a link artifact with the deploy URL',

  async use(ctx, next) {
    const output = await next()

    const onArtifact = ctx.extra.onArtifact
    if (!onArtifact || !output) return output

    try {
      const localPath = String(ctx.input.localPath ?? '')
      const deployUrl = extractDeployUrl(output, isFilePath(localPath))
      if (deployUrl) {
        onArtifact({
          title: 'Web 应用已部署',
          contentType: 'link',
          data: deployUrl,
          metadata: { deploymentType: 'web' },
        })
      }
    } catch {
      // 提取失败不影响主流程
    }

    return output
  },
}
