/**
 * 通用 MCP Policy Middleware 框架。
 *
 * 与具体 MCP 后端无关。任何 MCP 后端（CloudBase / GitHub / Linear / ...）
 * 都可以通过 `createPolicyLoader` + `runWithPolicy` 复用这套基础设施。
 */

export type { McpContext, McpMiddleware, McpPolicy } from './types.js'
export { createPolicyLoader, type PolicyLoader, type PolicyLoaderOptions } from './loader.js'
export { isToolHidden, runWithPolicy, runAugmentedTool } from './apply.js'
