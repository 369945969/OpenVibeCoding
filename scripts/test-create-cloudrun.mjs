#!/usr/bin/env node
/**
 * 测试 CreateCloudRunServer API 的 Items 参数格式
 * 用法：node scripts/test-create-cloudrun.mjs
 */

import { fileURLToPath } from 'url'
import { resolve, dirname } from 'path'
import fs from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 读 packages/server/.env
const envPath = resolve(__dirname, '../packages/server/.env')
const envContent = fs.readFileSync(envPath, 'utf-8')
const env = {}
for (const line of envContent.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) env[m[1].trim()] = m[2].trim()
}

const envId = env.TCB_ENV_ID
if (!envId) {
  console.error('TCB_ENV_ID not found in .env')
  process.exit(1)
}

console.log(`[test] EnvId: ${envId}`)
console.log(`[test] SecretId: ${env.TCB_SECRET_ID ? '***' + env.TCB_SECRET_ID.slice(-4) : 'not set'}`)

// 初始化 @cloudbase/manager-node
const { default: CloudBaseManager } = await import('@cloudbase/manager-node')

const app = new CloudBaseManager({
  secretId: env.TCB_SECRET_ID,
  secretKey: env.TCB_SECRET_KEY,
  token: env.TCB_TOKEN || '',
  envId,
})

const SERVICE_NAME = 'sandbox-base-image-test'

// 1. 检查服务是否存在
console.log('\n[test] Step 1: DescribeCloudRunServers...')
const existResult = await app.commonService('tcbr', '2022-02-17').call({
  Action: 'DescribeCloudRunServers',
  Param: { EnvId: envId, ServerName: SERVICE_NAME },
})
console.log('[test] Exist result:', JSON.stringify(existResult, null, 2))
const exists = existResult.ServerList?.length > 0

if (exists) {
  console.log(`[test] 服务 ${SERVICE_NAME} 已存在，跳过预创建`)
  console.log('[test] 如需测试预创建，请先在云托管控制台删除该服务')
  } else {
  // 2. 预创建服务（MinNum=0, MaxNum=0）
  console.log('\n[test] Step 2: CreateCloudRunServer with Items...')
  try {
    const createResult = await app.commonService('tcbr', '2022-02-17').call({
      Action: 'CreateCloudRunServer',
      Param: {
        EnvId: envId,
        ServerName: SERVICE_NAME,
        DeployInfo: { DeployType: 'code' },
        Items: [
          { Key: 'Port', IntValue: 9000 },
          { Key: 'MinNum', IntValue: 0 },
          { Key: 'MaxNum', IntValue: 1 },
        ],
      },
    })
    console.log('[test] Create result:', JSON.stringify(createResult, null, 2))
    console.log('\n[test] ✅ CreateCloudRunServer 成功！Items 格式正确。')

    // 3. 清理：删除测试服务
    console.log('\n[test] Step 3: 清理测试服务...')
    try {
      await app.commonService('tcbr', '2022-02-17').call({
        Action: 'DestroyCloudRunServer',
        Param: { EnvId: envId, ServerName: SERVICE_NAME },
      })
      console.log('[test] 测试服务已删除')
    } catch (delErr) {
      console.warn('[test] 删除测试服务失败（可手动清理）:', delErr.message)
    }
  } catch (err) {
    console.error('\n[test] ❌ CreateCloudRunServer 失败！')
    console.error('[test] Error:', err.message)
    console.error('[test] Code:', err.code)
    console.error('[test] RequestId:', err.requestId)
    console.error('\n[test] 完整错误对象:', JSON.stringify(err, null, 2))
  }
}
