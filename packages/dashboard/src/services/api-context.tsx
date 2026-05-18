import { createContext, useContext, useMemo } from 'react'
import type { ApiContext } from './http'

const Ctx = createContext<ApiContext | null>(null)

export const ApiContextProvider = Ctx.Provider

/** 必须在 ApiContextProvider 内部使用。返回当前 envId/taskId。 */
export function useApiContext(): ApiContext {
  const value = useContext(Ctx)
  if (!value) throw new Error('useApiContext must be used within ApiContextProvider')
  return value
}

/** 便捷 hook：稳定的对象引用，可以直接传给 service 方法。 */
export function useStableApiContext(envId: string, taskId?: string): ApiContext {
  return useMemo(() => ({ envId, taskId }), [envId, taskId])
}
