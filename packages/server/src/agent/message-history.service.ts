import { readFileSync } from 'node:fs'
import type { HistoryMessage, HistoryMessagePart, UnifiedMessageRecord } from '@coder/shared'
import { persistenceService } from './persistence.service.js'

export interface LoadTaskMessagesPageOptions {
  taskId: string
  envId: string
  userId: string
  limit?: number
  cursor?: string | null
  sort?: 'ASC' | 'DESC'
  /**
   * 保持旧 `/api/tasks/:id/messages` 行为：若历史开头是 assistant，丢到第一条 user 之前。
   */
  trimLeadingAssistant?: boolean
}

export async function loadTaskMessagesPage({
  taskId,
  envId,
  userId,
  limit = 50,
  cursor,
  sort = 'DESC',
  trimLeadingAssistant = false,
}: LoadTaskMessagesPageOptions): Promise<{ messages: HistoryMessage[]; nextCursor: string | null }> {
  const { records, nextCursor } = await persistenceService.loadDBMessagesPage(taskId, envId, userId, {
    limit,
    cursor,
    sort,
  })
  const validRecords = trimLeadingAssistant ? trimRecordsBeforeFirstUser(records) : records
  return {
    messages: validRecords.map((record) => toHistoryMessage(record, taskId)),
    nextCursor,
  }
}

export function toHistoryMessage(record: UnifiedMessageRecord, taskId: string): HistoryMessage {
  const parts = (record.parts || []).map(toHistoryMessagePart).flat()
  const textContent = parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')

  return {
    id: record.recordId,
    taskId,
    role: record.role === 'user' ? 'user' : 'agent',
    content: textContent,
    parts,
    status: record.status,
    createdAt: record.createTime || Date.now(),
  }
}

function trimRecordsBeforeFirstUser(records: UnifiedMessageRecord[]): UnifiedMessageRecord[] {
  const firstUserIdx = records.findIndex((record) => record.role === 'user')
  return firstUserIdx >= 0 ? records.slice(firstUserIdx) : records
}

function toHistoryMessagePart(part: UnifiedMessageRecord['parts'][number]): HistoryMessagePart | HistoryMessagePart[] {
  if (part.contentType === 'text') {
    // contentBlocks may be in metadata (TypeScript model) or directly on p
    // when CloudBase flattens nested metadata on read-back.
    const contentBlocks = ((part.metadata as any)?.contentBlocks ?? (part as any).contentBlocks) as any[] | undefined
    if (contentBlocks) {
      const imageParts: HistoryMessagePart[] = []
      for (const block of contentBlocks) {
        if (block.type === 'image_blob_ref') {
          try {
            const data = readFileSync(block.blob_path as string).toString('base64')
            imageParts.push({ type: 'image', data, mimeType: block.mime as string })
          } catch {
            // ignore unreadable local blob refs during history replay
          }
        }
      }
      if (imageParts.length > 0) return [...imageParts, { type: 'text', text: part.content || '' }]
    }
    return { type: 'text', text: part.content || '' }
  }

  if (part.contentType === 'reasoning') {
    return { type: 'thinking', text: part.content || '' }
  }

  if (part.contentType === 'tool_call') {
    return {
      type: 'tool_call',
      toolCallId: part.toolCallId || part.partId,
      toolName: (part.metadata?.toolCallName as string) || (part.metadata?.toolName as string) || 'tool',
      input: part.content || part.metadata?.input,
      status: (part.metadata?.status as string) || undefined,
      parentToolCallId: (part.metadata?.parentToolCallId as string) || undefined,
    }
  }

  if (part.contentType === 'tool_result') {
    return {
      type: 'tool_result',
      toolCallId: part.toolCallId || part.partId,
      toolName: (part.metadata?.toolName as string) || undefined,
      content: part.content || '',
      isError: part.metadata?.isError as boolean | undefined,
      status: (part.metadata?.status as string) || undefined,
      parentToolCallId: (part.metadata?.parentToolCallId as string) || undefined,
    }
  }

  if (part.contentType === 'image') {
    return {
      type: 'image',
      data: part.content || '',
      mimeType: (part.metadata?.mimeType as string) || 'image/png',
    }
  }

  return { type: 'text', text: part.content || '' }
}
