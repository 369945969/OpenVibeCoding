/**
 * Provision mode configuration helper.
 *
 * Reads the platform-wide provision mode from the database (system setting),
 * falling back to the TCB_PROVISION_MODE environment variable, then to 'shared'.
 *
 * Three modes:
 *  - 'shared'   : All users share a single CloudBase environment (TCB_ENV_ID)
 *  - 'isolated' : Each user gets an independent CloudBase environment (created at registration)
 *  - 'task'     : Each task gets an independent CloudBase environment (created at task start)
 */

import { getDb } from '../db/index.js'

export type ProvisionMode = 'shared' | 'isolated' | 'task'

const VALID_MODES: ProvisionMode[] = ['shared', 'isolated', 'task']

/**
 * Resolve the current provision mode.
 * Priority: DB system setting > env var TCB_PROVISION_MODE > 'shared'
 */
export async function getProvisionMode(): Promise<ProvisionMode> {
  try {
    const setting = await getDb().settings.findSystemSetting('provision_mode')
    if (setting?.value) {
      return normalizeMode(setting.value)
    }
  } catch {
    // DB not available — fall through to env var
  }

  const envVal = process.env.TCB_PROVISION_MODE || 'shared'
  return normalizeMode(envVal)
}

function normalizeMode(val: string): ProvisionMode {
  if (VALID_MODES.includes(val as ProvisionMode)) return val as ProvisionMode
  return 'shared'
}

export function isValidProvisionMode(val: string): val is ProvisionMode {
  return VALID_MODES.includes(val as ProvisionMode)
}
