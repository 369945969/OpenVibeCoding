/// <reference types="vite/client" />

import { useMemo } from 'react'
import { getApiBase } from './config'
import { tdFetch, type ApiContext } from './http'
import { useApiContext } from './api-context'

export interface FunctionInfo {
  name: string
  runtime: string
  status: string
  codeSize: number
  description: string
  addTime: string
  modTime: string
  memSize: number
  timeout: number
  type: string
}

export class FunctionsAPI {
  private ctx: ApiContext

  constructor(ctx: ApiContext) {
    this.ctx = ctx
  }

  async list(): Promise<FunctionInfo[]> {
    const r = await tdFetch(this.ctx, `${getApiBase()}/functions`)
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  }

  async invoke(name: string, data?: any): Promise<any> {
    const r = await tdFetch(this.ctx, `${getApiBase()}/functions/${encodeURIComponent(name)}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  }
}

export function useFunctionsAPI(): FunctionsAPI {
  const ctx = useApiContext()
  return useMemo(() => new FunctionsAPI(ctx), [ctx])
}
