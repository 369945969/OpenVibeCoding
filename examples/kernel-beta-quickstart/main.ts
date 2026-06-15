/**
 * 使用 npm 发布的 @cloudbase/open-agent-kernel@beta 构建 Agent 的最小示例。
 *
 * 准备：
 *   cp config.example.json config.local.json
 *   # 填入 envId / model / tcbApiKey
 *
 * 运行：
 *   pnpm install
 *   pnpm start              # 最简：仅模型对话
 *   pnpm start:full         # 完整：带 credentials（启用默认 DB / Storage）
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgent, VERSION } from '@cloudbase/open-agent-kernel'

interface LocalConfig {
  envId: string
  model?: string
  tcbApiKey: string
  credentials?: {
    secretId: string
    secretKey: string
    sessionToken?: string
  }
}

const configPath = resolve(dirname(fileURLToPath(import.meta.url)), 'config.local.json')

function loadConfig(): LocalConfig {
  if (!existsSync(configPath)) {
    throw new Error('config.local.json is required. Copy config.example.json to config.local.json first.')
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as LocalConfig
  if (!config.envId || !config.tcbApiKey) {
    throw new Error('config.local.json: envId and tcbApiKey are required')
  }
  return config
}

async function main(): Promise<void> {
  const config = loadConfig()
  const useFull = process.argv.includes('--full')

  process.env.TCB_API_KEY = config.tcbApiKey

  console.log('[kernel-beta-quickstart] SDK version:', VERSION)
  console.log('[kernel-beta-quickstart] mode:', useFull ? 'full (with credentials)' : 'minimal')

  const agent = createAgent({
    envId: config.envId,
    model: config.model ?? 'glm-5.1',
    ...(useFull && config.credentials
      ? {
          credentials: {
            secretId: config.credentials.secretId,
            secretKey: config.credentials.secretKey,
            ...(config.credentials.sessionToken
              ? { sessionToken: config.credentials.sessionToken }
              : {}),
          },
        }
      : {}),
    systemPrompt: 'You are a helpful CloudBase assistant. Reply concisely in Chinese.',
  })

  const session = await agent.startSession({ userId: 'beta-demo-user' })

  const prompt = '你好，请用一句话介绍你自己，并说明你是否了解 CloudBase。'
  console.log(`User: ${prompt}\n`)
  process.stdout.write('Assistant: ')

  for await (const event of session.send(prompt)) {
    switch (event.type) {
      case 'message_delta':
        process.stdout.write(event.text)
        break
      case 'message_complete':
        break
      case 'session_idle':
        console.log(`\n\n[session_idle] reason=${event.reason}`)
        break
      case 'error':
        console.error(`\n[error] ${event.error.message}`)
        break
      default:
        break
    }
  }
}

main().catch((err) => {
  console.error('[kernel-beta-quickstart] fatal:', err)
  process.exit(1)
})
