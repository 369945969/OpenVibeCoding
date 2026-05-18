import { Hono } from 'hono'
import { requireUserEnv } from '../middleware/auth.js'
import CloudBase from '@cloudbase/manager-node'
import type { AppEnv } from '../middleware/auth.js'

const router = new Hono<AppEnv>()

// 通用腾讯云 API 代理 — 使用登录用户身份
// POST /api/capi
// Body: { service: 'tcb', action: 'DescribeEnvs', params: { EnvId } }
//
// 路由流程：
// 1. preMiddleware: 先 sniff body 提取 params.EnvId 设到 envIdHint，再走 requireUserEnv
//    这样 middleware 能按这个 envId 反查正确的 user_resource（task 级或 user 级）解析凭证
// 2. handler: 直接用 c.userEnv.credentials 调 CloudBase API
router.post(
  '/',
  async (c, next) => {
    try {
      const body = (await c.req.json().catch(() => null)) as { params?: Record<string, unknown>; envId?: string } | null
      const hint =
        (body?.params?.EnvId as string | undefined) ??
        (body?.params?.envId as string | undefined) ??
        body?.envId ??
        undefined
      if (hint) c.set('envIdHint', hint)
    } catch {
      // 解析失败不影响主流程
    }
    return next()
  },
  requireUserEnv,
  async (c) => {
    const { envId, credentials } = c.get('userEnv')!

    let body: { service?: string; version?: string; action?: string; params?: Record<string, unknown> }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: '无效的请求体' }, 400)
    }

    const { service, version, action, params = {} } = body

    if (!service || !action) {
      return c.json({ error: '缺少 service / action 参数' }, 400)
    }

    try {
      const app = new CloudBase({
        secretId: credentials.secretId,
        secretKey: credentials.secretKey,
        token: credentials.sessionToken || '',
        envId,
      })

      // 透传前端传入的 version；不传则走 manager-node 内置默认
      const result = await app.commonService(service, version).call({
        Action: action,
        Param: params,
      })

      // manager-node 返回的就是腾讯云 Response 体（含 RequestId），把它顶到外层方便前端排障
      const requestId = (result as any)?.RequestId
      return c.json({ result, requestId })
    } catch (e: any) {
      // CloudBaseError 会带 requestId / code，一并透出
      const requestId = e?.requestId || e?.original?.RequestId
      const code = e?.code || e?.original?.Code
      return c.json({ error: e.message, code, requestId }, 500)
    }
  },
)

export default router
