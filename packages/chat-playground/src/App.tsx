/**
 * Chat Playground 主应用
 *
 * 极简对话调试器：
 * - 左侧：session 列表（来自 ACP `session/list`）+ 顶部 "+" 按钮（调 ACP `session/new`）
 * - 右侧：选中 session 的 <TaskChat />
 *
 * 不做：登录页、环境管理、文件浏览、PR/部署 —— 这些是 web 主应用的事。
 *
 * 认证：与本仓库的 server 同源，复用 web 已建立的 cookie；未登录或 session
 * 过期时拉列表会拿到 401，UI 提示去 web 登录即可。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AcpClient, TaskChat, useChatStream } from '@coder/chat-core'
import type { SessionInfo, Task } from '@coder/shared'
import { Plus, Loader2, AlertTriangle, MessageSquare, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

const ACP_BASE_URL = '/api/agent/acp'

export default function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const refreshSessions = useCallback(async () => {
    setLoadingList(true)
    setListError(null)
    try {
      const result = await AcpClient.listSessions(ACP_BASE_URL)
      setSessions(result.sessions)
    } catch (err) {
      setListError((err as Error).message)
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  // 默认打开列表第一个会话
  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[0].sessionId)
    }
  }, [sessions, activeSessionId])

  const handleCreate = useCallback(async () => {
    setCreating(true)
    try {
      const result = await AcpClient.createSession(ACP_BASE_URL, {
        meta: { title: '新会话 ' + new Date().toLocaleString() },
      })
      await refreshSessions()
      setActiveSessionId(result.sessionId)
      toast.success('会话已创建')
    } catch (err) {
      toast.error('创建失败: ' + (err as Error).message)
    } finally {
      setCreating(false)
    }
  }, [refreshSessions])

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground dark">
      {/* 左侧 session 列表 */}
      <aside className="w-72 shrink-0 border-r border-border flex flex-col">
        <header className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h1 className="text-sm font-semibold">Chat Playground</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={refreshSessions}
              disabled={loadingList}
              className="p-1.5 rounded hover:bg-muted disabled:opacity-50"
              title="刷新列表"
            >
              <RefreshCw className={'h-3.5 w-3.5 ' + (loadingList ? 'animate-spin' : '')} />
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="p-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              title="新建会话"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loadingList && sessions.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-xs">
              <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
              加载中...
            </div>
          ) : listError ? (
            <div className="p-4 text-xs">
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">无法加载会话</div>
                  <div className="text-muted-foreground mt-1 break-words">{listError}</div>
                  <div className="text-muted-foreground mt-2">
                    提示：playground 复用 web 的登录 cookie，请先到{' '}
                    <a
                      href="http://localhost:5174"
                      target="_blank"
                      rel="noreferrer"
                      className="underline text-foreground"
                    >
                      web (5174)
                    </a>{' '}
                    登录。
                  </div>
                </div>
              </div>
            </div>
          ) : sessions.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-xs">暂无会话。点右上角 + 创建。</div>
          ) : (
            <ul className="py-1">
              {sessions.map((s) => (
                <SessionItem
                  key={s.sessionId}
                  session={s}
                  active={s.sessionId === activeSessionId}
                  onSelect={() => setActiveSessionId(s.sessionId)}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground">
          ACP endpoint: {ACP_BASE_URL}
        </footer>
      </aside>

      {/* 右侧对话区 */}
      <main className="flex-1 min-w-0 flex flex-col">
        {activeSessionId ? (
          <SessionChat key={activeSessionId} sessionId={activeSessionId} onTaskUpdated={refreshSessions} />
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  )
}

// ─── 列表项 ──────────────────────────────────────────────────────

function SessionItem({ session, active, onSelect }: { session: SessionInfo; active: boolean; onSelect: () => void }) {
  const time = session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''
  const status = session._meta?.status as string | undefined

  return (
    <li>
      <button
        onClick={onSelect}
        className={
          'w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors border-l-2 ' +
          (active ? 'bg-muted border-primary' : 'border-transparent')
        }
      >
        <div className="flex items-center gap-2 mb-0.5">
          <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" />
          <div className="text-sm truncate flex-1">{session.title || '(无标题)'}</div>
          {status && <StatusBadge status={status} />}
        </div>
        <div className="text-[10px] text-muted-foreground pl-5 truncate">
          {time}
          <span className="mx-1.5">·</span>
          <code className="text-[9px]">{session.sessionId.slice(0, 8)}</code>
        </div>
      </button>
    </li>
  )
}

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, string> = {
    created: 'bg-muted text-muted-foreground',
    pending: 'bg-amber-500/20 text-amber-400',
    processing: 'bg-blue-500/20 text-blue-400',
    streaming: 'bg-blue-500/20 text-blue-400',
    completed: 'bg-emerald-500/20 text-emerald-400',
    stopped: 'bg-muted text-muted-foreground',
    error: 'bg-destructive/20 text-destructive',
  }
  const cls = palette[status] || 'bg-muted text-muted-foreground'
  return <span className={'text-[9px] px-1.5 py-0.5 rounded ' + cls}>{status}</span>
}

// ─── 空态 ────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="text-center max-w-sm space-y-2">
        <MessageSquare className="h-10 w-10 mx-auto opacity-30" />
        <p className="text-sm">选择左侧会话，或点击 + 创建新会话</p>
      </div>
    </div>
  )
}

// ─── 单个会话的对话视图 ──────────────────────────────────────────

function SessionChat({ sessionId, onTaskUpdated }: { sessionId: string; onTaskUpdated: () => void }) {
  const [task, setTask] = useState<Task | null>(null)
  const [taskError, setTaskError] = useState<string | null>(null)

  // chatStream 提升到此处，避免 TaskChat remount 丢状态（与 web 的 task-details 一致）
  const chatStream = useChatStream(sessionId, {})

  // 拉完整 task 详情
  const refreshTask = useCallback(async () => {
    setTaskError(null)
    try {
      const res = await fetch('/api/tasks/' + sessionId, { credentials: 'include' })
      if (!res.ok) {
        throw new Error('HTTP ' + res.status)
      }
      const data = (await res.json()) as { task: Task }
      setTask(data.task)
    } catch (err) {
      setTaskError((err as Error).message)
    }
  }, [sessionId])

  // sessionId 切换时重新拉
  const lastFetchedRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastFetchedRef.current === sessionId) return
    lastFetchedRef.current = sessionId
    setTask(null)
    refreshTask()
  }, [sessionId, refreshTask])

  const handleStreamComplete = useCallback(() => {
    refreshTask()
    onTaskUpdated()
  }, [refreshTask, onTaskUpdated])

  if (taskError) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <div className="max-w-sm space-y-2">
          <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
          <div className="text-sm font-medium">加载会话失败</div>
          <div className="text-xs text-muted-foreground break-words">{taskError}</div>
        </div>
      </div>
    )
  }

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  return (
    <TaskChat
      taskId={sessionId}
      task={task}
      chatStream={chatStream}
      historyMode="acp"
      onStreamComplete={handleStreamComplete}
    />
  )
}
