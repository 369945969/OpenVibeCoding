/**
 * Provision mode configuration helper.
 *
 * 优先级（高 → 低）：
 *   1. DB system setting `provision_mode`（admin UI 可改、可重置）
 *   2. 环境变量 TCB_PROVISION_MODE（部署时配置，作为默认值）
 *   3. 内置默认 'shared'
 *
 * Three modes:
 *  - 'shared'   : All users share a single CloudBase environment (TCB_ENV_ID)
 *  - 'isolated' : Each user gets an independent CloudBase environment (created at registration)
 *  - 'task'     : Each task gets an independent CloudBase environment (created at task start)
 */

import { getDb } from '../db/index.js'

export type ProvisionMode = 'shared' | 'isolated' | 'task'

/** 值的来源（用于 admin UI 展示） */
export type ProvisionModeSource = 'db' | 'env' | 'default'

const VALID_MODES: ProvisionMode[] = ['shared', 'isolated', 'task']
const BUILTIN_DEFAULT: ProvisionMode = 'shared'

/**
 * 解析当前生效的 provision mode（不带来源信息）。
 * 调用方只需"用"这个值时使用。
 */
export async function getProvisionMode(): Promise<ProvisionMode> {
  return (await resolveProvisionMode()).value
}

/**
 * 解析当前 provision mode + 来源 + env 默认值。
 * admin UI 用这个 API 展示标签和"重置到 env 默认"按钮。
 */
export async function resolveProvisionMode(): Promise<{
  value: ProvisionMode
  source: ProvisionModeSource
  envDefault: ProvisionMode
}> {
  const envDefault = normalizeMode(process.env.TCB_PROVISION_MODE || BUILTIN_DEFAULT)

  try {
    const setting = await getDb().settings.findSystemSetting('provision_mode')
    if (setting?.value) {
      return { value: normalizeMode(setting.value), source: 'db', envDefault }
    }
  } catch {
    // DB 不可用 → 走 env / default
  }

  if (process.env.TCB_PROVISION_MODE) {
    return { value: envDefault, source: 'env', envDefault }
  }
  return { value: BUILTIN_DEFAULT, source: 'default', envDefault }
}

function normalizeMode(val: string): ProvisionMode {
  if (VALID_MODES.includes(val as ProvisionMode)) return val as ProvisionMode
  return BUILTIN_DEFAULT
}

export function isValidProvisionMode(val: string): val is ProvisionMode {
  return VALID_MODES.includes(val as ProvisionMode)
}
