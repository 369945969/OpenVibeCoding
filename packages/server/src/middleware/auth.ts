import { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { decryptJWE } from '../lib/session'
import { getDb } from '../db/index.js'
import CloudBaseManager from '@cloudbase/manager-node'
import { buildStsInlinePolicyStatements } from '../cloudbase/provision.js'
import { getProvisionMode } from '../lib/provision-config'

export interface SessionUser {
  id: string
  username: string
  email: string | undefined
  avatar: string
  name?: string
}

export interface AppSession {
  created: number
  authProvider: 'github' | 'local' | 'cloudbase' | 'api-key'
  user: SessionUser
}

/** 下游通过 c.get('userEnv') 获取，凭证已解析好，可直接使用 */
export interface UserEnv {
  envId: string
  userId: string
  /** 已解析的凭证（永久密钥或临时密钥） */
  credentials: {
    secretId: string
    secretKey: string
    sessionToken?: string
  }
}

export type AppEnv = {
  Variables: {
    session: AppSession | undefined
    userEnv: UserEnv | undefined
    /** Scopes from Server API Key auth, undefined for cookie auth */
    apiKeyScopes: string[] | undefined
    /** Admin user info, set by requireAdmin middleware */
    adminUser: any
    /**
     * 上游 middleware 提示当前请求归属的 task。requireUserEnv 会优先按它解析 task 级 envId。
     * ACP 路由从 JSON-RPC body 的 params.conversationId/sessionId 提取后写入此变量。
     */
    taskIdHint: string | undefined
    /**
     * 上游 middleware 提示当前请求要操作的 envId（与凭证强绑定）。
     * 用于客户端显式指定操作哪个 env（如 /api/capi 的 params.EnvId）的场景：
     * requireUserEnv 会按此 envId 反查 user_resources 解析对应凭证（避免凭证/envId 错配）。
     */
    envIdHint: string | undefined
  }
}

const SESSION_COOKIE_NAME = 'nex_session'

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  // 1. Try Bearer token (Server API Key: sak_xxx)
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer sak_')) {
    try {
      const plainKey = authHeader.slice(7) // Remove "Bearer "
      // apiKey stored as plaintext (rotatable, admin-visible).
      const db = getDb()
      const user = await db.users.findByApiKey(plainKey)
      if (user) {
        c.set('session', {
          created: Date.now(),
          authProvider: 'api-key' as AppSession['authProvider'],
          user: {
            id: user.id,
            username: user.username,
            email: user.email || undefined,
            avatar: user.avatarUrl || '',
            name: user.name || undefined,
          },
        })
        c.set('apiKeyScopes', ['acp'])
      }
    } catch {
      // Invalid API key, continue without auth
    }
    return next()
  }

  // 2. Try session cookie
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME)
  if (sessionCookie) {
    try {
      const session = await decryptJWE<AppSession>(sessionCookie)
      c.set('session', session)
    } catch (e) {
      // Invalid session, continue without auth
    }
  }
  await next()
}

// Helper to require authentication
export function requireAuth(c: Context<AppEnv>) {
  const session = c.get('session')
  if (!session?.user?.id) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

// ─── 临时密钥签发 ──────────────────────────────────────────────────────

// 缓存：`${userId}:${envId}` -> { credentials, expireTime }
// key 必须包含 envId，因为 issueTempCredentials 签出的临时凭证 policy 是按 envId
// 锁死的；同一用户访问不同 envId（user-level / task-level）必须分别签发，否则会
// 用错 token 触发 "SecretId is not found" 之类错。
const tempCredentialCache = new Map<
  string,
  { credentials: { secretId: string; secretKey: string; sessionToken: string }; expireTime: number }
>()

/**
 * 兜底：用支撑密钥签发临时凭证
 *
 * ⚠️ 见 buildStsInlinePolicyStatements 注释 —— 当前 inline policy 用 [*] on [*]
 * （子账号支撑密钥的腾讯云限制下唯一可用形态），实际权限 = 支撑密钥本身权限的子集，
 * **没有 envId 隔离**。生产环境应优先使用 user_resources.camSecretId/Key 永久密钥
 * （provision 已按 envId/cosTag 隔离），这里只是没有永久密钥时的兜底。
 */
export async function issueTempCredentials(
  envId: string,
  userId: string,
): Promise<{ secretId: string; secretKey: string; sessionToken: string } | undefined> {
  const cacheKey = `${userId}:${envId}`
  // 检查缓存（提前 5 分钟过期）
  const cached = tempCredentialCache.get(cacheKey)
  if (cached && cached.expireTime > Date.now() / 1000 + 300) {
    return cached.credentials
  }

  const systemSecretId = process.env.TCB_SECRET_ID
  const systemSecretKey = process.env.TCB_SECRET_KEY
  const systemEnvId = process.env.TCB_ENV_ID

  if (!systemSecretId || !systemSecretKey || !systemEnvId) return undefined

  // inline policy 与 envId/region/cosTag/ownerUin 无关（见函数注释），传空也无妨
  const policyStatements = buildStsInlinePolicyStatements({
    envId,
    region: '',
    ownerUin: '',
    cosTagValue: '',
  })

  try {
    const app = new CloudBaseManager({ secretId: systemSecretId, secretKey: systemSecretKey, envId: systemEnvId })

    const result = await app.commonService('sts', '2018-08-13').call({
      Action: 'GetFederationToken',
      Param: {
        Name: `vibe-user-${userId.slice(0, 8)}`,
        DurationSeconds: 7200,
        Policy: JSON.stringify({
          version: '2.0',
          statement: policyStatements,
        }),
      },
    })

    const creds = (result as any)?.Credentials
    if (creds?.TmpSecretId && creds?.TmpSecretKey && creds?.Token) {
      const credentials = {
        secretId: creds.TmpSecretId,
        secretKey: creds.TmpSecretKey,
        sessionToken: creds.Token,
      }
      tempCredentialCache.set(cacheKey, {
        credentials,
        expireTime: (result as any)?.ExpiredTime || Date.now() / 1000 + 7200,
      })
      return credentials
    }
    console.error('[Auth] issueTempCredentials: unexpected response', JSON.stringify(result))
  } catch (err: any) {
    console.error('[Auth] issueTempCredentials failed', {
      envId,
      userId,
      message: err?.message,
      code: err?.code || err?.original?.Code,
      requestId: err?.requestId || err?.original?.RequestId,
    })
  }
  return undefined
}

// ─── requireUserEnv 中间件 ─────────────────────────────────────────────

/**
 * 中间件：校验登录 + 环境就绪 + 解析凭证
 * 下游通过 c.get('userEnv') 获取 { envId, userId, credentials }
 *
 * 解析路径按 provision mode 分支：
 *   - shared   → 直接用支撑账号 TCB_SECRET_ID/KEY + TCB_ENV_ID，不查 user_resources
 *   - isolated → user_resources(scope='user') 永久密钥 + user-level envId
 *   - task     → 优先 taskId hint 命中 task 级 resource；否则 envId hint；最后 user-level fallback
 */
export async function requireUserEnv(c: Context<AppEnv>, next: Next) {
  const authErr = requireAuth(c)
  if (authErr) return authErr

  const session = c.get('session')!
  const userId = session.user.id

  // shared 模式：所有用户共享支撑账号 env，不走 user_resources
  const mode = await getProvisionMode()
  if (mode === 'shared') {
    const envId = process.env.TCB_ENV_ID
    const secretId = process.env.TCB_SECRET_ID
    const secretKey = process.env.TCB_SECRET_KEY
    if (!envId || !secretId || !secretKey) {
      return c.json({ error: 'TCB_ENV_ID / TCB_SECRET_ID / TCB_SECRET_KEY not configured (shared mode)' }, 500)
    }
    c.set('userEnv', { envId, userId, credentials: { secretId, secretKey } })
    return next()
  }

  // isolated / task：从 user_resources 解析
  // 1. 先尝试按 taskId 查 task 级资源
  // taskId 来源（按优先级）：URL :taskId param > X-Task-Id header > query taskId > c.var.taskIdHint
  const taskId =
    c.req.param('taskId') ??
    c.req.header('X-Task-Id') ??
    new URL(c.req.url).searchParams.get('taskId') ??
    c.get('taskIdHint') ??
    null
  let resource: Awaited<ReturnType<ReturnType<typeof getDb>['userResources']['findByUserId']>> | null = null
  let resolvedFrom: 'task' | 'env' | 'user' = 'user'
  if (taskId) {
    try {
      const taskResource = await getDb().userResources.findByTaskId(taskId)
      if (taskResource && taskResource.userId === userId && taskResource.status === 'success' && taskResource.envId) {
        resource = taskResource
        resolvedFrom = 'task'
      }
    } catch (err) {
      console.warn('[requireUserEnv] findByTaskId threw', (err as Error).message)
      // 找不到/不属于当前用户：fallback 到 envId 解析
    }
  }

  // 2. 没匹配到 task 级时，尝试按 envIdHint 反查 user_resources（dashboard / capi 显式指定 envId 的场景）
  if (!resource) {
    // envId 来源：URL :envId param > X-Env-Id header > query envId > c.var.envIdHint
    const envIdHint =
      c.req.param('envId') ??
      c.req.header('X-Env-Id') ??
      new URL(c.req.url).searchParams.get('envId') ??
      c.get('envIdHint') ??
      null
    if (envIdHint) {
      try {
        const all = await getDb().userResources.findAllByUserId(userId)
        const match = all.find((r) => r.envId === envIdHint && r.status === 'success')
        if (match) {
          resource = match
          resolvedFrom = 'env'
        }
      } catch (err) {
        console.warn('[requireUserEnv] findAllByUserId threw', (err as Error).message)
      }
    }
  }

  // 3. fallback：user-level resource
  if (!resource) {
    resource = await getDb().userResources.findByUserId(userId)
    console.log('[requireUserEnv] fallback to user-level', { userId, envId: resource?.envId })
  }

  if (!resource?.envId) {
    return c.json({ error: 'User environment not ready' }, 400)
  }

  const envId = resource.envId

  // 解析凭证：优先永久密钥，否则签发临时密钥
  let credentials: UserEnv['credentials'] | undefined

  if (resource.camSecretId && resource.camSecretKey) {
    credentials = { secretId: resource.camSecretId, secretKey: resource.camSecretKey }
  } else {
    credentials = await issueTempCredentials(envId, userId)
  }

  if (!credentials) {
    return c.json({ error: 'Failed to obtain user credentials' }, 500)
  }

  c.set('userEnv', { envId, userId, credentials })

  await next()
}
