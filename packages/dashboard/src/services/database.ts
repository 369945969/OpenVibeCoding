/// <reference types="vite/client" />

import { useMemo } from 'react'
import { getApiBase } from './config'
import { tdFetch, type ApiContext } from './http'
import { useApiContext } from './api-context'

export interface CollectionInfo {
  CollectionName: string
  Count?: number
  Size?: number
}

export interface DocumentQueryResult {
  documents: any[]
  total: number
  page: number
  pageSize: number
}

export interface InferredColumn {
  key: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'null'
  width?: number
}

export class DatabaseAPI {
  private baseUrl: string
  private ctx: ApiContext

  constructor(ctx: ApiContext, baseUrl: string = getApiBase()) {
    this.ctx = ctx
    this.baseUrl = baseUrl
  }

  async getCollections(): Promise<CollectionInfo[]> {
    const response = await tdFetch(this.ctx, `${this.baseUrl}/database/collections`)
    if (!response.ok) throw new Error(`Failed to fetch collections: ${response.statusText}`)
    return response.json()
  }

  async createCollection(name: string): Promise<void> {
    const response = await tdFetch(this.ctx, `${this.baseUrl}/database/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) throw new Error(`Failed to create collection: ${response.statusText}`)
  }

  async deleteCollection(name: string): Promise<void> {
    const response = await tdFetch(this.ctx, `${this.baseUrl}/database/collections/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
    if (!response.ok) throw new Error(`Failed to delete collection: ${response.statusText}`)
  }

  async getDocuments(
    collectionName: string,
    page: number = 1,
    pageSize: number = 50,
    search?: string,
  ): Promise<DocumentQueryResult> {
    const params = new URLSearchParams({ page: page.toString(), pageSize: pageSize.toString() })
    if (search?.trim()) params.set('search', search.trim())
    const response = await tdFetch(
      this.ctx,
      `${this.baseUrl}/database/collections/${encodeURIComponent(collectionName)}/documents?${params}`,
    )
    if (!response.ok) throw new Error(`Failed to fetch documents: ${response.statusText}`)
    return response.json()
  }

  async createDocument(collectionName: string, data: any): Promise<any> {
    const response = await tdFetch(
      this.ctx,
      `${this.baseUrl}/database/collections/${encodeURIComponent(collectionName)}/documents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
    )
    if (!response.ok) throw new Error(`Failed to create document: ${response.statusText}`)
    return response.json()
  }

  async updateDocument(collectionName: string, documentId: string, data: any): Promise<any> {
    const response = await tdFetch(
      this.ctx,
      `${this.baseUrl}/database/collections/${encodeURIComponent(collectionName)}/documents/${encodeURIComponent(documentId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
    )
    if (!response.ok) throw new Error(`Failed to update document: ${response.statusText}`)
    return response.json()
  }

  async deleteDocument(collectionName: string, documentId: string): Promise<void> {
    const response = await tdFetch(
      this.ctx,
      `${this.baseUrl}/database/collections/${encodeURIComponent(collectionName)}/documents/${encodeURIComponent(documentId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) throw new Error(`Failed to delete document: ${response.statusText}`)
  }
}

// inferColumns / 类型推断逻辑是纯函数，不依赖 ctx
export function inferColumns(documents: any[]): InferredColumn[] {
  if (documents.length === 0) return []

  const columnTypes: Record<string, Set<string>> = {}

  documents.forEach((doc) => {
    Object.entries(doc).forEach(([key, value]) => {
      if (!columnTypes[key]) columnTypes[key] = new Set()

      if (value === null || value === undefined) {
        columnTypes[key].add('null')
      } else if (typeof value === 'boolean') {
        columnTypes[key].add('boolean')
      } else if (typeof value === 'number') {
        if (isTimestamp(value)) {
          columnTypes[key].add('date')
        } else {
          columnTypes[key].add('number')
        }
      } else if (typeof value === 'string') {
        if (isDate(value)) {
          columnTypes[key].add('date')
        } else {
          columnTypes[key].add('text')
        }
      } else if (typeof value === 'object') {
        columnTypes[key].add('json')
      }
    })
  })

  return Object.entries(columnTypes).map(([key, types]) => ({
    key,
    type: resolveType([...types]) as InferredColumn['type'],
  }))
}

function isTimestamp(n: number): boolean {
  if (n >= 946684800 && n <= 4102444800) return true
  if (n >= 946684800000 && n <= 4102444800000) return true
  return false
}

function isDate(str: string): boolean {
  const datePatterns = [/^\d{4}-\d{2}-\d{2}$/, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, /^\d{1,2}\/\d{1,2}\/\d{4}$/]
  return datePatterns.some((pattern) => pattern.test(str))
}

function resolveType(types: string[]): string {
  if (types.length === 0) return 'text'
  const nonNull = types.filter((t) => t !== 'null')
  if (nonNull.length === 0) return 'null'
  return nonNull[0]
}

export function useDatabaseAPI(): DatabaseAPI {
  const ctx = useApiContext()
  return useMemo(() => new DatabaseAPI(ctx), [ctx])
}
