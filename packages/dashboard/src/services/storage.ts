/// <reference types="vite/client" />

import { useMemo } from 'react'
import { getApiBase } from './config'
import { tdFetch, type ApiContext } from './http'
import { useApiContext } from './api-context'

export interface BucketInfo {
  type: 'storage' | 'static'
  name: string
  label: string
  bucket: string
  region: string
  cdnDomain: string
  customDomain?: string
  isPublic: boolean
}

export interface FileInfo {
  key: string
  name: string
  size: number
  lastModified: string
  isDir: boolean
  fileId?: string // 云存储: cloud://envId/xxx
  publicUrl?: string // 静态托管: https://cdnDomain/xxx
}

export class StorageAPI {
  private base: string
  private ctx: ApiContext

  constructor(ctx: ApiContext, base = getApiBase()) {
    this.ctx = ctx
    this.base = base
  }

  async getBuckets(): Promise<BucketInfo[]> {
    const r = await tdFetch(this.ctx, `${this.base}/storage/buckets`)
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  }

  async listFiles(prefix = '', bucket: BucketInfo): Promise<FileInfo[]> {
    const p = new URLSearchParams({
      prefix,
      bucketType: bucket.type,
      cdnDomain: bucket.cdnDomain,
    })
    const r = await tdFetch(this.ctx, `${this.base}/storage/files?${p}`)
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  }

  async getDownloadUrl(path: string): Promise<string> {
    const p = new URLSearchParams({ path })
    const r = await tdFetch(this.ctx, `${this.base}/storage/url?${p}`)
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()
    return data.url
  }

  async deleteFile(path: string, bucketType: 'storage' | 'static'): Promise<void> {
    const r = await tdFetch(this.ctx, `${this.base}/storage/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, bucketType }),
    })
    if (!r.ok) throw new Error(await r.text())
  }

  /**
   * 取后端为当前用户解析好的临时凭证（已限定到该用户的 envId / cos tag）。
   * 直接用此凭证走 cos-js-sdk 上传即可。后端不会暴露永久密钥。
   */
  async getUploadCredential(): Promise<{
    tmpSecretId: string
    tmpSecretKey: string
    sessionToken: string
    expiredTime: number
    envId: string
  }> {
    const r = await tdFetch(this.ctx, `${this.base}/storage/upload-credential`, {
      method: 'POST',
    })
    const data = await r.json()
    if (!r.ok || data.error) {
      const reqId = data.requestId ? ` (RequestId: ${data.requestId})` : ''
      const code = data.code ? ` [${data.code}]` : ''
      throw new Error(`${data.error || '签发失败'}${code}${reqId}`)
    }
    return data
  }
}

export function useStorageAPI(): StorageAPI {
  const ctx = useApiContext()
  return useMemo(() => new StorageAPI(ctx), [ctx])
}
