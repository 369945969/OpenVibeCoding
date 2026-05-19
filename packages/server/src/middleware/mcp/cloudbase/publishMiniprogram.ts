/**
 * Augmented tool: publishMiniprogram
 *
 * 完全新增的工具（原 mcporter 没有）。负责调用沙箱 /api/miniprogram/deploy 接口
 * 完成小程序预览/上传，并触发 artifact 给前端展示二维码。
 *
 * 历史背景：原本在 sandbox-mcp-proxy.ts 中硬编码（line 374-505 PUBLISH_MP_*）。
 */

import type { McpPolicy } from './_index.js'

export const policy: McpPolicy = {
  description: 'Deploy WeChat miniprogram (preview / upload)',

  augment: {
    description:
      '小程序发布/预览工具。支持预览（preview）和上传（upload）两种操作。' +
      '预览会生成二维码供扫码体验，上传会将代码提交到微信后台。' +
      '部署可能耗时较长，若超过 60s 未完成会返回 async=true 和 jobId，请使用 getDeployJobStatus 工具查询结果。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['preview', 'upload'], description: '操作类型：preview=预览, upload=上传' },
        projectPath: { type: 'string', description: '小程序项目路径（沙箱内的绝对路径）' },
        appId: { type: 'string', description: '微信小程序 AppId' },
        version: { type: 'string', description: '版本号（upload 时建议提供，如 "1.0.0"）' },
        description: { type: 'string', description: '版本描述' },
        robot: { type: 'number', description: 'CI 机器人编号（1-30），默认 1' },
      },
      required: ['action', 'projectPath', 'appId'],
    },
  },

  async use(ctx) {
    const args = ctx.input as {
      action: 'preview' | 'upload'
      projectPath: string
      appId: string
      version?: string
      description?: string
      robot?: number
    }

    const getMpDeployCredentials = ctx.extra.getMpDeployCredentials
    if (!getMpDeployCredentials) {
      return JSON.stringify({ error: true, message: 'miniprogram deploy not available in this runtime' })
    }

    const creds = await getMpDeployCredentials(args.appId)
    if (!creds?.privateKey) {
      return JSON.stringify({
        error: true,
        message: `未找到 appId ${args.appId} 的部署密钥，请先在小程序管理中关联该 appId`,
      })
    }

    try {
      const res = await ctx.extra.sandboxFetch('/api/miniprogram/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appid: args.appId,
          privateKey: creds.privateKey,
          action: args.action,
          projectPath: args.projectPath,
          version: args.version,
          description: args.description,
          robot: args.robot,
        }),
        signal: AbortSignal.timeout(120_000),
      })

      const body = (await res.json().catch(() => null)) as any

      if (!res.ok || !body) {
        return JSON.stringify({
          error: true,
          status: res.status,
          message: body?.error || body?.message || `HTTP ${res.status}`,
        })
      }

      if (body.async) {
        return JSON.stringify({
          async: true,
          jobId: body.jobId,
          message: '部署仍在进行中，请稍后使用 getDeployJobStatus 工具查询结果',
        })
      }

      if (!body.success) {
        return JSON.stringify({
          error: true,
          message: body.error || body.result?.errMsg || 'Deploy failed',
          result: body.result,
        })
      }

      // 成功 → artifact
      const onArtifact = ctx.extra.onArtifact
      if (onArtifact) {
        if (body.result?.qrcode) {
          const qrcode = `data:${body.result.qrcode.mimeType || 'image/png'};base64,${body.result.qrcode.base64}`
          onArtifact({
            title: '小程序预览二维码',
            contentType: 'image',
            data: qrcode,
            metadata: { deploymentType: 'miniprogram', ...body },
          })
        } else if (args.action === 'upload') {
          onArtifact({
            title: '小程序上传成功',
            contentType: 'json',
            data: JSON.stringify(body),
            metadata: { deploymentType: 'miniprogram', appId: args.appId },
          })
        }
      }

      return JSON.stringify(body)
    } catch (e: any) {
      return JSON.stringify({ error: true, message: e.message })
    }
  },
}
