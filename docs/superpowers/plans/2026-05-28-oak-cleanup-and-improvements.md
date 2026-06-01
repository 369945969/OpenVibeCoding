# OAK Cleanup & Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up deprecated history-store module, optimize getHistory pagination, fix deleteSessionMessages cascade bug, and persist userId to oak_sessions table.

**Architecture:** All changes are within `packages/open-agent-kernel/src/`. Tasks are independent — no ordering dependencies. Each task modifies 2-4 files and can be committed separately.

**Tech Stack:** TypeScript (ESM, strict mode), Claude Agent SDK, CloudBase Node SDK (peer dep)

---

## Task 1: Remove history-store module (deprecated by dual-write)

**Context:** The `history-store/` module only has a `drivers/types.ts` interface definition. PR #4.6's dual-write mechanism in SessionStore already covers the same use case (front-end message retrieval via `getHistory()`). This module is dead code.

**Files:**
- Delete: `src/history-store/drivers/types.ts`
- Delete: `src/history-store/` (entire directory)

- [ ] **Step 1: Delete the history-store directory**

```bash
rm -rf packages/open-agent-kernel/src/history-store
```

- [ ] **Step 2: Verify no imports reference history-store**

```bash
grep -r "history-store" packages/open-agent-kernel/src/ --include="*.ts"
grep -r "HistoryStoreDriver" packages/open-agent-kernel/src/ --include="*.ts"
```

Expected: No results (no other file imports from this module).

- [ ] **Step 3: Run type-check to confirm nothing breaks**

```bash
pnpm --filter @cloudbase/open-agent-kernel type-check
```

Expected: PASS with no errors.

- [ ] **Step 4: Commit**

```bash
git add -A packages/open-agent-kernel/src/history-store
git commit -m "chore(oak): remove unused history-store module

The dual-write mechanism in SessionStore (PR #4.6) already provides
front-end message retrieval via getHistory(). The history-store module
only had an interface definition and was never implemented."
```

---

## Task 2: Optimize getHistory pagination (avoid full entry scan)

**Context:** Current `getHistory()` in `create-agent.ts` calls `driver.loadEntries()` which loads the **entire** session transcript into memory, then does in-memory Map lookup. For sessions with hundreds of entries this is wasteful. We already have `querySessionMessages()` with pagination — the issue is loading all entries just to find the matching ones.

**Solution:** Add a `loadEntriesByMessageIds(key, messageIds)` method to SessionStoreDriver that loads only entries matching specific messageIds. This avoids the full scan.

**Files:**
- Modify: `src/session-store/drivers/types.ts` (add interface method)
- Modify: `src/session-store/drivers/in-memory-driver.ts` (implement)
- Modify: `src/session-store/drivers/cloudbase-db-driver.ts` (implement)
- Modify: `src/public/create-agent.ts` (use new method in getHistory)

- [ ] **Step 1: Add `loadEntriesByMessageIds` to SessionStoreDriver interface**

In `src/session-store/drivers/types.ts`, add after `loadEntries`:

```typescript
  /**
   * 加载指定 messageId 列表对应的 entries（用于 getHistory 分页优化）。
   *
   * 比 loadEntries 高效：只拉匹配的 entries，不扫描整个 session。
   * messageId 对应 entry.message.id 或 entry.uuid。
   *
   * @returns 按写入顺序排列的 entries（seq 升序）；未找到的 messageId 静默跳过。
   */
  loadEntriesByMessageIds(
    key: SessionKey,
    messageIds: string[],
  ): Promise<SessionStoreEntry[]>
```

- [ ] **Step 2: Implement in InMemoryDriver**

In `src/session-store/drivers/in-memory-driver.ts`, add method:

```typescript
  async loadEntriesByMessageIds(key: SessionKey, messageIds: string[]): Promise<SessionStoreEntry[]> {
    const record = this.sessions.get(encodeSessionKey(key))
    if (!record) return []
    const idSet = new Set(messageIds)
    return record.entries.filter((entry) => {
      const msgId = (entry as any).message?.id || entry.uuid
      return typeof msgId === 'string' && idSet.has(msgId)
    })
  }
```

- [ ] **Step 3: Implement in CloudBaseDbDriver**

In `src/session-store/drivers/cloudbase-db-driver.ts`, add method:

```typescript
  async loadEntriesByMessageIds(key: SessionKey, messageIds: string[]): Promise<SessionStoreEntry[]> {
    if (messageIds.length === 0) return []
    const sessionKey = encodeSessionKey(key)
    const entriesCol = await this.getCollection('session_entries')

    // CloudBase DB 的 in 查询：需要 db.command.in
    const app = await this.getApp()
    const db = app.database() as unknown as { command: { in(arr: string[]): unknown } }

    // CloudBase in 查询单次上限 20，分批查询
    const BATCH_SIZE = 20
    const allEntries: SessionStoreEntry[] = []
    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE)
      const { data } = await entriesCol
        .where({ sessionKey, uuid: db.command.in(batch) })
        .orderBy('seq', 'asc')
        .limit(batch.length)
        .get()
      for (const row of data) {
        const entry = row['entry']
        if (entry && typeof entry === 'object') {
          allEntries.push(entry as SessionStoreEntry)
        }
      }
    }
    return allEntries
  }
```

- [ ] **Step 4: Refactor getHistory to use loadEntriesByMessageIds**

In `src/public/create-agent.ts`, replace the `getHistory` method body:

```typescript
    async getHistory(opts): Promise<MessageRecord[]> {
      const store = config.session?.store
      if (!store) return []

      const driver = (
        store as { getDriver?: () => SessionStoreDriver }
      ).getDriver?.()
      if (!driver) return []

      const projectKey = config.session?.projectKey ?? config.envId

      // 1. 查询 session_messages 元数据（已分页）
      const metas = await driver.querySessionMessages(projectKey, conversationId, {
        limit: opts?.limit,
        before: opts?.before,
      })
      if (metas.length === 0) return []

      // 2. 只加载匹配的 entries（分页优化：不再全量扫描）
      const messageIds = metas.map((m) => m.messageId)
      const entries = await driver.loadEntriesByMessageIds(
        { projectKey, sessionId: conversationId },
        messageIds,
      )
      if (entries.length === 0) return []

      // 3. 构建 messageId → entry 映射
      const entryMap = new Map<string, Record<string, unknown>>()
      for (const entry of entries) {
        const sdkMsg = entry as Record<string, unknown>
        if (!sdkMsg || typeof sdkMsg !== 'object') continue
        const messageId = (sdkMsg.message as { id?: string })?.id || (entry as any).uuid
        if (messageId) {
          entryMap.set(messageId, sdkMsg)
        }
      }

      if (process.env.OAK_DEBUG === '1') {
        console.error('[oak][getHistory] entryMap size:', entryMap.size, ', metas:', metas.length)
      }

      // 4. 用元数据顺序组装 MessageRecord
      const result: MessageRecord[] = []
      for (const meta of metas) {
        const sdkMsg = entryMap.get(meta.messageId)
        if (!sdkMsg) continue

        const parts = extractMessageParts(sdkMsg)
        if (parts.length === 0) continue

        result.push({
          id: meta.messageId,
          conversationId,
          role: meta.role,
          parts,
          status: meta.status,
          createdAt: meta.createdAt,
        })
      }

      // metas 是 desc 排序，返回给用户改为 asc（时间正序）
      result.reverse()
      return result
    },
```

- [ ] **Step 5: Add import for SessionStoreDriver type (if needed)**

In `src/public/create-agent.ts`, ensure this import exists at the top:

```typescript
import type { SessionStoreDriver } from '../session-store/drivers/types.js'
```

- [ ] **Step 6: Run type-check**

```bash
pnpm --filter @cloudbase/open-agent-kernel type-check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/open-agent-kernel/src/session-store/drivers/types.ts \
  packages/open-agent-kernel/src/session-store/drivers/in-memory-driver.ts \
  packages/open-agent-kernel/src/session-store/drivers/cloudbase-db-driver.ts \
  packages/open-agent-kernel/src/public/create-agent.ts
git commit -m "perf(oak): optimize getHistory to avoid full entry scan

Add loadEntriesByMessageIds to SessionStoreDriver. getHistory now only
loads entries matching the paginated messageIds from querySessionMessages,
instead of loading the entire session transcript into memory."
```

---

## Task 3: Fix deleteSessionMessages cascade in session deletion

**Context:** `CloudBaseDbDriver.deleteSession()` already calls `messagesCol.where(...).remove()` for `session_messages`. However, the **public API** path `Agent.sessions.delete(conversationId)` in `create-agent.ts` calls `store.delete()` which maps to `CloudBaseSessionStore.delete()` → `driver.deleteSession()`. Looking at `CloudBaseDbDriver.deleteSession()`, it already handles `session_messages` deletion (line 335). 

The real issue: `InMemoryDriver.deleteSession()` also already handles it (line 125). So the cascade is actually working at the driver level. 

The gap is: **`CloudBaseSessionStore.delete()` does not call `driver.deleteSessionMessages()` explicitly** — but it doesn't need to because `driver.deleteSession()` in both implementations already handles message deletion internally.

**Real fix needed:** Expose a `clearHistory(conversationId)` method on `Session` that only clears message metadata without deleting the full session (transcript stays for SDK resume). This gives users finer-grained control.

**Files:**
- Modify: `src/public/types.ts` (add `clearHistory` to Session interface)
- Modify: `src/public/create-agent.ts` (implement `clearHistory`)

- [ ] **Step 1: Add `clearHistory` to Session interface**

In `src/public/types.ts`, add to the `Session` interface after `getHistory`:

```typescript
  /**
   * 清除会话消息元数据索引（oak_session_messages）。
   *
   * 仅清除前端分页索引数据，不影响 SDK transcript（session 仍可继续对话）。
   * 用途：用户在 UI 上"清除聊天记录"但保留对话上下文。
   */
  clearHistory(): Promise<void>
```

- [ ] **Step 2: Implement `clearHistory` in createSession**

In `src/public/create-agent.ts`, add to the `session` object (after `abort()`):

```typescript
    async clearHistory(): Promise<void> {
      const store = config.session?.store
      if (!store) return

      const driver = (
        store as { getDriver?: () => SessionStoreDriver }
      ).getDriver?.()
      if (!driver) return

      const projectKey = config.session?.projectKey ?? config.envId
      await driver.deleteSessionMessages({ projectKey, sessionId: conversationId })
    },
```

- [ ] **Step 3: Run type-check**

```bash
pnpm --filter @cloudbase/open-agent-kernel type-check
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/open-agent-kernel/src/public/types.ts \
  packages/open-agent-kernel/src/public/create-agent.ts
git commit -m "feat(oak): add session.clearHistory() for message index cleanup

Exposes deleteSessionMessages at the public API level. Clears the
oak_session_messages index without affecting the SDK transcript,
allowing users to clear chat history while keeping conversation context."
```

---

## Task 4: Persist userId to oak_sessions table

**Context:** `userId` is passed at `startSession({ userId })` but only stored in the in-memory `Session` object. It's never written to `oak_sessions` in the DB, so `listSessions()` can't return it, and `resumeSession()` loses it (hardcoded to `'resumed'`).

**Solution:** 
1. Add `userId` field to the `oak_sessions` upsert flow
2. Pass `userId` through SessionStore append path (via a side-channel, since the SDK's SessionKey doesn't carry userId)
3. Return `userId` in `listSessions()`

The cleanest approach: store userId in `oak_sessions` at session creation time (when the first `appendEntries` happens), by adding a `registerSession` call from `createSession`.

**Files:**
- Modify: `src/session-store/drivers/types.ts` (add `registerSession` method + update `listSessions` return type)
- Modify: `src/session-store/drivers/in-memory-driver.ts` (implement)
- Modify: `src/session-store/drivers/cloudbase-db-driver.ts` (implement)
- Modify: `src/session-store/cloudbase-session-store.ts` (expose `registerSession`)
- Modify: `src/public/create-agent.ts` (call `registerSession` at session start)
- Modify: `src/public/types.ts` (update `SessionSummary` to include userId from DB)

- [ ] **Step 1: Add `registerSession` to SessionStoreDriver interface**

In `src/session-store/drivers/types.ts`, add after `appendEntries`:

```typescript
  /**
   * 注册 session 元数据（userId 等）。
   *
   * 在 session 创建时调用一次。若 session 已存在则更新 userId。
   * 与 appendEntries 内部的 upsertSessionIndex 不冲突：
   *   - registerSession 写 userId 等业务元数据
   *   - upsertSessionIndex 更新 mtime
   */
  registerSession(args: {
    projectKey: string
    sessionId: string
    userId: string
    title?: string
    metadata?: Record<string, unknown>
  }): Promise<void>
```

Update `listSessions` return type to include `userId`:

```typescript
  listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number; userId?: string }>>
```

- [ ] **Step 2: Implement `registerSession` in InMemoryDriver**

In `src/session-store/drivers/in-memory-driver.ts`, add a `sessionMeta` map and implement:

Add field to the class:

```typescript
  /** sessionKey → session metadata (userId, title, etc.) */
  private readonly sessionMeta = new Map<string, { userId: string; title?: string; metadata?: Record<string, unknown> }>()
```

Add method:

```typescript
  async registerSession(args: {
    projectKey: string
    sessionId: string
    userId: string
    title?: string
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const sk = `${args.projectKey}|${args.sessionId}`
    this.sessionMeta.set(sk, {
      userId: args.userId,
      title: args.title,
      metadata: args.metadata,
    })
  }
```

Update `listSessions` to include userId:

```typescript
  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number; userId?: string }>> {
    const result: Array<{ sessionId: string; mtime: number; userId?: string }> = []
    for (const record of this.sessions.values()) {
      if (record.projectKey === projectKey && record.subpath === undefined) {
        const sk = `${record.projectKey}|${record.sessionId}`
        const meta = this.sessionMeta.get(sk)
        result.push({ sessionId: record.sessionId, mtime: record.mtime, userId: meta?.userId })
      }
    }
    return result
  }
```

Update `clearAll` to also clear sessionMeta:

```typescript
  clearAll(): void {
    this.sessions.clear()
    this.summaries.clear()
    this.sessionMessages.clear()
    this.sessionMeta.clear()
  }
```

- [ ] **Step 3: Implement `registerSession` in CloudBaseDbDriver**

In `src/session-store/drivers/cloudbase-db-driver.ts`, add method:

```typescript
  async registerSession(args: {
    projectKey: string
    sessionId: string
    userId: string
    title?: string
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const sessionsCol = await this.getCollection('sessions')
    const existing = await sessionsCol
      .where({ projectKey: args.projectKey, sessionId: args.sessionId })
      .limit(1)
      .get()

    const now = Date.now()
    if (existing.data && existing.data.length > 0) {
      // Session 已存在（可能是 appendEntries 先写的），补写 userId
      await sessionsCol
        .where({ projectKey: args.projectKey, sessionId: args.sessionId })
        .update({
          userId: args.userId,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
          mtime: now,
        })
    } else {
      // 首次注册
      await sessionsCol.add({
        sessionKey: `${args.projectKey}|${args.sessionId}`,
        projectKey: args.projectKey,
        sessionId: args.sessionId,
        userId: args.userId,
        title: args.title ?? null,
        metadata: args.metadata ?? null,
        mtime: now,
        createdAt: now,
      })
    }
  }
```

Update `listSessions` to return userId:

```typescript
  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number; userId?: string }>> {
    const sessionsCol = await this.getCollection('sessions')
    const { data } = await sessionsCol.where({ projectKey }).get()
    return data
      .filter((row) => typeof row['sessionId'] === 'string' && typeof row['mtime'] === 'number')
      .map((row) => ({
        sessionId: row['sessionId'] as string,
        mtime: row['mtime'] as number,
        userId: typeof row['userId'] === 'string' ? row['userId'] : undefined,
      }))
  }
```

- [ ] **Step 4: Expose `registerSession` on CloudBaseSessionStore**

In `src/session-store/cloudbase-session-store.ts`, add method:

```typescript
  /**
   * 注册 session 元数据（userId 等）。
   * 在 session 创建时由 kernel 调用，不属于 SDK SessionStore 接口。
   */
  async registerSession(args: {
    projectKey: string
    sessionId: string
    userId: string
    title?: string
    metadata?: Record<string, unknown>
  }): Promise<void> {
    await this.driver.registerSession({
      ...args,
      projectKey: this.fixedProjectKey ?? args.projectKey,
    })
  }
```

- [ ] **Step 5: Call `registerSession` at session creation**

In `src/public/create-agent.ts`, in the `createSession` function, add registration logic after session object creation but before returning. Add this block right before `return session`:

```typescript
  // 持久化 session 元数据（userId, title）到 store
  if (config.session?.store && !resumeFromExisting) {
    const storeWithRegister = config.session.store as {
      registerSession?: (args: {
        projectKey: string
        sessionId: string
        userId: string
        title?: string
        metadata?: Record<string, unknown>
      }) => Promise<void>
    }
    if (typeof storeWithRegister.registerSession === 'function') {
      const projectKey = config.session?.projectKey ?? config.envId
      storeWithRegister.registerSession({
        projectKey,
        sessionId: conversationId,
        userId,
      }).catch(() => {
        // 注册失败不阻塞 session 创建
        if (process.env.OAK_DEBUG === '1') {
          console.error('[oak] registerSession failed (non-blocking)')
        }
      })
    }
  }
```

- [ ] **Step 6: Update `mapSummary` to include userId from listSessions**

In `src/public/create-agent.ts`, update the `createSessionsManagement.list` method to use the new `listSessions` return value with userId:

```typescript
    async list(opts): Promise<SessionSummary[]> {
      const store = config.session?.store as {
        listSessions?: (k: string) => Promise<Array<{ sessionId: string; mtime: number; userId?: string }>>
      } | undefined
      if (!store?.listSessions) return []
      const projectKey = config.session?.projectKey ?? config.envId
      const sessions = await store.listSessions(projectKey)
      void opts
      return sessions.map((s) => ({
        conversationId: s.sessionId,
        userId: s.userId ?? '',
        status: 'idle' as const,
        createdAt: s.mtime,
        updatedAt: s.mtime,
      }))
    },
```

- [ ] **Step 7: Export `registerSession` from session-store index (no change needed)**

The method is on `CloudBaseSessionStore` which is already exported. No index.ts change needed.

- [ ] **Step 8: Run type-check**

```bash
pnpm --filter @cloudbase/open-agent-kernel type-check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/open-agent-kernel/src/session-store/drivers/types.ts \
  packages/open-agent-kernel/src/session-store/drivers/in-memory-driver.ts \
  packages/open-agent-kernel/src/session-store/drivers/cloudbase-db-driver.ts \
  packages/open-agent-kernel/src/session-store/cloudbase-session-store.ts \
  packages/open-agent-kernel/src/public/create-agent.ts \
  packages/open-agent-kernel/src/public/types.ts
git commit -m "feat(oak): persist userId to oak_sessions table

Add registerSession to SessionStoreDriver. Called at session creation
to store userId (and optional title/metadata) in the sessions index.
listSessions now returns userId, enabling per-user session filtering."
```

---

## Final Verification

After all 4 tasks:

```bash
pnpm --filter @cloudbase/open-agent-kernel type-check
pnpm format
pnpm lint
```

All three must pass before pushing.
