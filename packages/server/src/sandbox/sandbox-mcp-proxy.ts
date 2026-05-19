/**
 * Sandbox MCP Proxy（CodeBuddy SDK runtime 入口）
 *
 * 创建一对 InMemoryTransport：
 *   - McpServer 暴露 cloudbase 工具给 agent-sdk
 *   - Client 由 base-runtime 连接，跑 mcporter 命令到沙箱
 *
 * 工具注册、policy 应用、凭证重注入都委托给 lib/cloudbase-mcp.ts。
 * 启动时主动注入一次凭证（mcporter list 需要凭证才能跑）。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SandboxInstance } from './scf-sandbox-manager.js'
import { tool as sdkTool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import {
  buildMcporterShellCommand,
  createCloudbaseMcpLogger,
  createInjectCredentials,
  discoverCloudbaseTools as discoverTools,
  registerCloudbasePolicies,
  registerNoopPlaceholder,
  type ToolResult,
} from '../lib/cloudbase-mcp.js'
import { loadAllPolicies } from '../middleware/mcp/cloudbase/_index.js'
import type { CloudbaseExtra } from '../middleware/mcp/cloudbase/_index.js'

// 启动时加载 policy（异步触发，不阻塞模块导出）
void loadAllPolicies()

// ─── Types ───────────────────────────────────────────────────────

export interface SandboxMcpDeps {
  /** SandboxInstance — handles auth headers, scope headers, and request routing */
  sandbox: SandboxInstance
  /** 当前会话用户 ID（也用于通过 issueTempCredentials 反查凭证） */
  userId: string
  /** 当前会话 envId（用于凭证注入与重注入） */
  envId: string
  /** bash 超时 ms，默认 30000 */
  bashTimeoutMs?: number
  /** 工作目录（注入给容器） */
  workspaceFolderPaths?: string
  /** 日志输出，默认 console.log */
  log?: (msg: string) => void
  /** uploadFiles 工具成功返回时的回调，用于触发 artifact 事件 */
  onArtifact?: (artifact: {
    title: string
    contentType: 'image' | 'link' | 'json'
    data: string
    metadata?: Record<string, unknown>
  }) => void
  /** 根据 appId 查询小程序部署凭证 */
  getMpDeployCredentials?: (appId: string) => Promise<{ appId: string; privateKey: string } | null>
  /** 当前使用的模型 ID */
  currentModel?: string
}

// ─── Auth Error ──────────────────────────────────────────────────

class AuthRequiredError extends Error {
  constructor(status: number) {
    super(`MCP_AUTH_REQUIRED: gateway returned ${status}`)
    this.name = 'AuthRequiredError'
  }
}

// ─── Core factory ────────────────────────────────────────────────

/**
 * 创建沙箱 MCP Server 并通过 InMemoryTransport 返回已连接的 Client。
 *
 * - 完全在进程内，零 IPC 开销，无 stdio/子进程
 * - 所有请求通过 SandboxInstance.request()，天然解决 token 过期和 scope header 注入
 * - Server 内部对 gateway 401/403 抛出 AuthRequiredError，Client 侧可感知并重连
 */
export async function createSandboxMcpClient(deps: SandboxMcpDeps): Promise<{
  client: Client
  /** McpServer 实例（@modelcontextprotocol/sdk），供直接操作 */
  server: McpServer
  /** SDK MCP Server（@tencent-ai/agent-sdk createSdkMcpServer），传入 query() 的 mcpServers 选项 */
  sdkServer: ReturnType<typeof createSdkMcpServer>
  /** 显式关闭，释放 transport pair */
  close: () => Promise<void>
}> {
  const {
    sandbox,
    userId,
    envId,
    bashTimeoutMs = 30_000,
    workspaceFolderPaths = '',
    log = (msg: string) => console.log(msg),
    onArtifact,
    getMpDeployCredentials,
    currentModel: depsCurrentModel,
  } = deps

  // ── HTTP helpers ────────────────────────────────────────────────
  // ── HTTP helpers ────────────────────────────────────────────────
  // All requests go through sandbox.request() which injects auth + scope headers.

  // 统一日志：复用流式 sink（行末加 \n 兼容历史调用方）
  const logger = createCloudbaseMcpLogger('sandbox-mcp', {
    info: (line) => log(line + '\n'),
    warn: (line) => log(line + '\n'),
    error: (line, err) => log(line + (err ? ' ' + String(err) : '') + '\n'),
  })

  async function apiCall(tool: string, body: unknown, timeoutMs = bashTimeoutMs): Promise<any> {
    const res = await sandbox.request(`/api/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401 || res.status === 403) {
      throw new AuthRequiredError(res.status)
    }
    const data = (await res.json()) as any
    if (!data.success) throw new Error(data.error ?? `${tool} call failed`)
    return data.result
  }

  async function bashCall(command: string, timeoutMs = bashTimeoutMs): Promise<any> {
    return apiCall('bash', { command, timeout: timeoutMs }, timeoutMs)
  }

  // 启动时主动注入一次凭证：mcporter list 需要凭证才能跑（SDK runtime 特有）。
  // 运行时的凭证错误重注入由 registerCloudbasePolicies 内部处理（见下方传 envId）。
  const startupInject = createInjectCredentials({
    userId,
    envId,
    conversationId: sandbox.conversationId,
    sandboxFetch: (path, init) => sandbox.request(path, init),
    workspaceFolderPaths,
    on401: (status) => {
      throw new AuthRequiredError(status)
    },
  })

  // ── CloudBase schema discovery + mcporter call（用 lib 共享实现） ───────

  async function fetchCloudbaseSchema(): Promise<any[]> {
    return discoverTools({
      bash: (cmd, t) => bashCall(cmd, t ?? 20_000),
      readJsonFile: async (p) => {
        const res = await sandbox.request(`/e2b-compatible/files?path=${encodeURIComponent(p)}`)
        if (!res.ok) throw new Error(`Failed to read schema file: ${res.status}`)
        return res.json()
      },
    })
  }

  async function mcporterCall(toolName: string, args: Record<string, unknown>): Promise<any> {
    const cmd = buildMcporterShellCommand(toolName, args)
    logger.info(`bash cmd: ${cmd}`)
    return bashCall(cmd, 60_000)
  }

  // ── Inject credentials first, then fetch tools ───────────────
  // Must inject before fetchCloudbaseSchema so mcporter can authenticate
  try {
    await startupInject()
    logger.info('Credentials injected successfully')
  } catch (e: any) {
    logger.warn(`Failed to inject credentials: ${e.message}`)
  }

  // ── Fetch CloudBase tools (degraded on failure) ───────────────

  let cloudbaseTools: any[] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cloudbaseTools = await fetchCloudbaseSchema()
      logger.info(`Discovered ${cloudbaseTools.length} CloudBase tools (attempt ${attempt})`)
      break
    } catch (e: any) {
      logger.warn(`Schema fetch failed (attempt ${attempt}/3): ${e.message}`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3_000))
      else logger.warn('Starting in degraded mode (workspace tools only)')
    }
  }

  // ── Build MCP Server ──────────────────────────────────────────

  const server = new McpServer({ name: 'cloudbase-sandbox-proxy', version: '2.0.0' })

  // CloudbaseExtra 上下文（注入到所有 policy ctx.extra）
  // 注意：injectCredentials 由 registerCloudbasePolicies 内部根据 envId 自动注入到 extra
  const sandboxFetch: CloudbaseExtra['sandboxFetch'] = (path, init) => sandbox.request(path, init)
  const extra: CloudbaseExtra = {
    sandboxUrl: '', // sandbox.request 已内置 baseUrl，policy 通过 sandboxFetch 走
    sandboxAuth: {}, // 同上
    sandboxFetch,
    conversationId: sandbox.conversationId,
    onArtifact,
    getMpDeployCredentials,
    currentModel: depsCurrentModel,
  }

  const ctxBase = {
    userId,
    sessionId: sandbox.conversationId ?? '',
    extra,
  }

  // ── 收集 SDK MCP Server 的 sdkTool 定义（与下方 server.tool 注册同步生成） ─
  const sdkTools: ReturnType<typeof sdkTool>[] = []

  // ── 一站式注册：原生工具 + augmented 工具，同时注册到 server 和 sdkTools ─
  // 凭证错误自动重注入 + ctx.extra.injectCredentials 都由 lib 内部根据 envId 处理。
  await registerCloudbasePolicies({
    nativeTools: cloudbaseTools,
    ctxBase,
    mcporterCall: async (toolName, args) => {
      const result = await mcporterCall(toolName, args)
      return (result.output ?? '') as string
    },
    envId,
    injectOptions: {
      workspaceFolderPaths,
      on401: (status) => {
        throw new AuthRequiredError(status)
      },
    },
    register: (name, desc, shape, handler) => {
      // 标准 MCP server
      server.tool(name, desc, shape as any, handler as any)
      // SDK MCP server（agent-sdk 用）
      sdkTools.push(sdkTool(name, desc, shape as any, handler as any))
    },
    logger,
  })

  // 若原生工具列表为空，注册占位 tool 让 McpServer 仍声明 tools capability
  if (cloudbaseTools.length === 0) {
    registerNoopPlaceholder((name, desc, shape, handler) => {
      server.tool(name, desc, shape as any, handler as any)
    })
  }

  // ── 通过 InMemoryTransport 把 server <-> client 连接起来（进程内零开销） ──
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const client = new Client({ name: 'cloudbase-agent', version: '1.0.0' })
  await client.connect(clientTransport)

  const sdkServer = createSdkMcpServer({
    name: 'cloudbase',
    version: '1.0.0',
    tools: sdkTools,
  })

  logger.info(
    `Ready. sandbox=${sandbox.functionName} session=${sandbox.scfSessionId} scope=${sandbox.conversationId} mode=${sandbox.sandboxMode} coding=${sandbox.isCodingMode} tools=${cloudbaseTools.length}`,
  )

  return {
    client,
    server,
    sdkServer,
    close: async () => {
      try {
        await client.close()
      } catch {}
      try {
        await server.close()
      } catch {}
    },
  }
}
