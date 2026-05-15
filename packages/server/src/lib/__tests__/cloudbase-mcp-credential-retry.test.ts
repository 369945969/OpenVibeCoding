/**
 * 凭证重注入流程测试
 *
 * 直接测 lib 导出的 withCredentialRetry —— 它是 registerCloudbasePolicies 内部
 * 用来包 mcporterCall 的 retry decorator，两条 runtime 共用。
 */

import { describe, it, expect, vi } from 'vitest'
import { isCredentialError, withCredentialRetry } from '../cloudbase-mcp.js'

describe('isCredentialError', () => {
  it('detects all known credential error patterns', () => {
    expect(isCredentialError('Error: AUTH_REQUIRED at line ...')).toBe(true)
    expect(isCredentialError('error: The SecretId is not found')).toBe(true)
    expect(isCredentialError('SecretId is not found in account')).toBe(true)
    expect(isCredentialError('InvalidParameter.SecretIdNotFound')).toBe(true)
    expect(isCredentialError('AuthFailure.SignatureExpire')).toBe(true)
  })

  it('does not match normal mcporter output', () => {
    expect(isCredentialError('{ "success": true, "data": [] }')).toBe(false)
    expect(isCredentialError('Function created: my-fn')).toBe(false)
    expect(isCredentialError('')).toBe(false)
  })
})

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('withCredentialRetry', () => {
  it('returns immediately when first call succeeds', async () => {
    const mcporter = vi.fn().mockResolvedValue('{"success": true}')
    const inject = vi.fn()
    const call = withCredentialRetry(mcporter, inject, silentLogger)
    const out = await call('listFunctions', {})

    expect(out).toBe('{"success": true}')
    expect(mcporter).toHaveBeenCalledTimes(1)
    expect(inject).not.toHaveBeenCalled()
  })

  it('retries once after AUTH_REQUIRED and returns success', async () => {
    const mcporter = vi.fn().mockResolvedValueOnce('Error: AUTH_REQUIRED').mockResolvedValueOnce('{"success": true}')
    const inject = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const call = withCredentialRetry(mcporter, inject, logger)
    const out = await call('listFunctions', {})

    expect(out).toBe('{"success": true}')
    expect(mcporter).toHaveBeenCalledTimes(2)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('re-injecting'))
  })

  it('does not retry when injectCredentials is undefined (no envId)', async () => {
    const mcporter = vi.fn().mockResolvedValue('AUTH_REQUIRED')
    const call = withCredentialRetry(mcporter, undefined, silentLogger)
    const out = await call('listFunctions', {})

    // 没法重注入，直接返回原始错误（让 AI 看到）
    expect(out).toBe('AUTH_REQUIRED')
    expect(mcporter).toHaveBeenCalledTimes(1)
  })

  it('annotates output when re-inject fails', async () => {
    const mcporter = vi.fn().mockResolvedValue('AUTH_REQUIRED')
    const inject = vi.fn().mockRejectedValue(new Error('STS quota exceeded'))
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const call = withCredentialRetry(mcporter, inject, logger)
    const out = await call('listFunctions', {})

    expect(out).toContain('AUTH_REQUIRED')
    expect(out).toContain('Credential re-injection attempted but failed')
    expect(mcporter).toHaveBeenCalledTimes(1) // 注入失败 → 不再 retry
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('re-inject failed'))
  })

  it('annotates output when retry still returns AUTH_REQUIRED', async () => {
    const mcporter = vi
      .fn()
      .mockResolvedValueOnce('Error: AUTH_REQUIRED 1st')
      .mockResolvedValueOnce('Error: AUTH_REQUIRED 2nd')
    const inject = vi.fn().mockResolvedValue(undefined)
    const call = withCredentialRetry(mcporter, inject, silentLogger)
    const out = await call('listFunctions', {})

    expect(out).toContain('AUTH_REQUIRED 2nd')
    expect(out).toContain('Credential re-injection attempted but error persists')
    expect(mcporter).toHaveBeenCalledTimes(2)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('only retries once even if AUTH_REQUIRED keeps coming', async () => {
    const mcporter = vi.fn().mockResolvedValue('AUTH_REQUIRED')
    const inject = vi.fn().mockResolvedValue(undefined)
    const call = withCredentialRetry(mcporter, inject, silentLogger)
    await call('listFunctions', {})

    // 不会无限循环
    expect(mcporter).toHaveBeenCalledTimes(2)
    expect(inject).toHaveBeenCalledTimes(1)
  })
})
