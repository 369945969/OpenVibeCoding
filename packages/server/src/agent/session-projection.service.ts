import type { SessionInfo } from '@coder/shared'
import type { Task } from '../db/types.js'

/**
 * 把 task DB 记录投影成 ACP `session/list` 期望的 SessionInfo。
 *
 * Task 是产品层概念（含 PR、分支、沙箱、资源等字段），SessionInfo 是 ACP 协议
 * 层的轻量视图。本 helper 让 session/list 不必内联映射，避免 task ↔ session 字段
 * 关系散落在多处。
 */
export function toSessionInfo(task: Task): SessionInfo {
  return {
    sessionId: task.id,
    title: task.title || task.prompt?.slice(0, 100) || '',
    updatedAt: task.updatedAt,
    _meta: {
      status: task.status,
      createdAt: task.createdAt,
    },
  }
}
