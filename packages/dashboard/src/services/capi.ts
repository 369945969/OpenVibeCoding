/// <reference types="vite/client" />

import { useMemo } from 'react'
import { getApiBase } from './config'
import { tdFetch, type ApiContext } from './http'
import { useApiContext } from './api-context'

interface CapiRequest {
  service: string
  version: string
  action: string
  params?: Record<string, unknown>
  region?: string
}

export class CapiClient {
  private base: string
  private ctx: ApiContext

  constructor(ctx: ApiContext, base = getApiBase()) {
    this.ctx = ctx
    this.base = base
  }

  async call<T = any>(req: CapiRequest): Promise<T> {
    const r = await tdFetch(this.ctx, `${this.base}/capi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
    const data = await r.json()
    if (!r.ok || data.error) {
      // 把 requestId / code 拼进 message，便于 toast 后排障
      const reqId = data.requestId ? ` (RequestId: ${data.requestId})` : ''
      const code = data.code ? ` [${data.code}]` : ''
      throw new Error(`${data.error || '请求失败'}${code}${reqId}`)
    }
    return data.result
  }

  tcb<T = any>(action: string, params?: Record<string, unknown>, region = 'ap-shanghai') {
    return this.call<T>({ service: 'tcb', version: '2018-06-08', action, params, region })
  }

  cam<T = any>(action: string, params?: Record<string, unknown>) {
    return this.call<T>({ service: 'cam', version: '2019-01-16', action, params, region: '' })
  }

  sts<T = any>(action: string, params?: Record<string, unknown>) {
    return this.call<T>({ service: 'sts', version: '2018-08-13', action, params, region: '' })
  }
}

export function useCapiClient(): CapiClient {
  const ctx = useApiContext()
  // ctx 引用稳定（来自 useStableApiContext），CapiClient 也跟着稳定
  return useMemo(() => new CapiClient(ctx), [ctx])
}
