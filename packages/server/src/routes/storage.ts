import { Hono } from 'hono'
import { requireUserEnv, type AppEnv } from '../middleware/auth.js'
import type { CloudBaseCredentials } from '../cloudbase/database.js'
import {
  getBuckets,
  listStorageFiles,
  listHostingFiles,
  getDownloadUrl,
  deleteFile,
  deleteHostingFile,
} from '../cloudbase/storage.js'
import { createManager } from '../cloudbase/database.js'
import CloudBaseManager from '@cloudbase/manager-node'
// @ts-ignore — COS SDK has no bundled types in some versions
import COS from 'cos-nodejs-sdk-v5'

const router = new Hono<AppEnv>()

function getCreds(c: any): CloudBaseCredentials {
  const { envId, credentials } = c.get('userEnv')!
  return {
    envId,
    secretId: credentials.secretId,
    secretKey: credentials.secretKey,
    sessionToken: credentials.sessionToken,
  }
}

router.get('/buckets', requireUserEnv, async (c) => {
  try {
    return c.json(await getBuckets(getCreds(c)))
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

router.get('/files', requireUserEnv, async (c) => {
  try {
    const prefix = c.req.query('prefix') || ''
    const bucketType = c.req.query('bucketType') || 'storage'
    const cdnDomain = c.req.query('cdnDomain') || ''
    const creds = getCreds(c)

    const files =
      bucketType === 'static' ? await listHostingFiles(creds, prefix, cdnDomain) : await listStorageFiles(creds, prefix)

    return c.json(files)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

router.get('/url', requireUserEnv, async (c) => {
  try {
    const path = c.req.query('path') || ''
    if (!path) return c.json({ error: '缺少 path 参数' }, 400)
    return c.json({ url: await getDownloadUrl(getCreds(c), path) })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

router.delete('/files', requireUserEnv, async (c) => {
  try {
    const { path, bucketType } = await c.req.json()
    if (!path) return c.json({ error: '缺少 path 参数' }, 400)
    const creds = getCreds(c)
    if (bucketType === 'static') {
      await deleteHostingFile(creds, path)
    } else {
      await deleteFile(creds, path)
    }
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ---------------------------------------------------------------------------
// GET /api/storage/presign?key=xxx&bucketType=static|storage
// Generate a presigned PUT URL for COS bucket (static hosting or cloud storage).
// Returns: { presignedUrl, cdnUrl }
// ---------------------------------------------------------------------------
router.get('/presign', requireUserEnv, async (c) => {
  try {
    const key = c.req.query('key')
    const bucketType = c.req.query('bucketType') || 'storage'
    if (!key) return c.json({ error: 'key is required' }, 400)

    const creds = getCreds(c)
    const manager = createManager(creds)

    let bucket: string
    let region: string
    let cdnDomain = ''

    if (bucketType === 'static') {
      const hostingInfo = await manager.hosting.getInfo().catch(() => null)
      const hosting = hostingInfo?.[0]
      if (!hosting?.Bucket) return c.json({ error: 'Static hosting not configured' }, 404)
      bucket = hosting.Bucket as string
      region = (hosting as any).Regoin as string
      cdnDomain = hosting.CdnDomain as string
    } else {
      const { EnvInfo } = await manager.env.getEnvInfo()
      const storage = EnvInfo?.Storages?.[0]
      if (!storage?.Bucket) return c.json({ error: 'Cloud storage not configured' }, 404)
      bucket = storage.Bucket
      region = storage.Region ?? ''
      cdnDomain = (storage as any).CdnDomain || ''
    }

    const cos = new COS({
      SecretId: creds.secretId,
      SecretKey: creds.secretKey,
      ...(creds.sessionToken ? { SecurityToken: creds.sessionToken } : {}),
    })

    const presignedUrl = await new Promise<string>((resolve, reject) => {
      cos.getObjectUrl(
        { Bucket: bucket, Region: region, Key: key, Method: 'PUT', Sign: true, Expires: 1800 },
        (err: any, data: any) => (err ? reject(err) : resolve(data.Url)),
      )
    })

    const cdnUrl = cdnDomain ? `https://${cdnDomain}/${key}` : presignedUrl
    return c.json({ presignedUrl, cdnUrl })
  } catch (e: any) {
    console.error('[storage/presign] error:', e)
    return c.json({ error: e.message }, 500)
  }
})

// ---------------------------------------------------------------------------
// POST /api/storage/upload-credential
//
// 给前端 cos-js-sdk 直传用的临时凭证。
//
// 实现：用一份"永久密钥"调 STS GetFederationToken 现签一份新鲜的临时凭证（duration
// = 1800s），下发给前端。永久密钥来源优先级：
//   1. 当前 userEnv 是永久密钥（camSecretId/Key）—— 直接用
//   2. 否则用支撑账号 (TCB_SECRET_ID/KEY)
//
// 为什么不直接下发 userEnv 的临时凭证：那份临时凭证可能已经接近过期，且无法
// 再向下 grant cos（GrantOtherResource）。
// 永远不直接把永久密钥下发给前端。
// ---------------------------------------------------------------------------
router.post('/upload-credential', requireUserEnv, async (c) => {
  try {
    const { credentials, envId } = c.get('userEnv')!

    // 选 grant-capable 永久密钥
    let signerSecretId: string
    let signerSecretKey: string
    if (!credentials.sessionToken && credentials.secretId && credentials.secretKey) {
      // 用户级永久密钥
      signerSecretId = credentials.secretId
      signerSecretKey = credentials.secretKey
    } else if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY) {
      // 支撑账号永久密钥
      signerSecretId = process.env.TCB_SECRET_ID
      signerSecretKey = process.env.TCB_SECRET_KEY
    } else {
      return c.json({ error: '没有可用的永久密钥用于签发临时凭证' }, 500)
    }

    const app = new CloudBaseManager({
      secretId: signerSecretId,
      secretKey: signerSecretKey,
      envId,
    })

    const result: any = await app.commonService('sts', '2018-08-13').call({
      Action: 'GetFederationToken',
      Param: {
        Name: 'dashboard-upload',
        DurationSeconds: 1800,
        // 限定到 cos:*（凭证不会比签发账号本身更宽）
        Policy: JSON.stringify({
          version: '2.0',
          statement: [{ action: ['cos:*'], effect: 'allow', resource: ['*'] }],
        }),
      },
    })

    const creds = result?.Credentials
    if (!creds?.TmpSecretId || !creds?.TmpSecretKey || !creds?.Token) {
      return c.json({ error: 'STS 未返回临时凭证', requestId: result?.RequestId }, 500)
    }

    return c.json({
      tmpSecretId: creds.TmpSecretId,
      tmpSecretKey: creds.TmpSecretKey,
      sessionToken: creds.Token,
      expiredTime: result?.ExpiredTime,
      envId,
      requestId: result?.RequestId,
    })
  } catch (e: any) {
    const requestId = e?.requestId || e?.original?.RequestId
    const code = e?.code || e?.original?.Code
    return c.json({ error: e?.message || '签发失败', code, requestId }, 500)
  }
})

export default router
