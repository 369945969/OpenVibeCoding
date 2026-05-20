# CloudBase VibeCoding Platform

基于 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) 重构的 AI 编程助手平台，以腾讯云 CloudBase 为底座，支持多 AI Agent、多租户环境隔离与完整的 VibeCoding 工作流。

## 文档

- [Setup 指南](docs/setup.md) — 初始化流程、环境变量、验证清单与排障
- [系统架构](docs/architecture.md) — 系统分层、模块设计与关键数据流

## 特性

- **多 Agent 运行时** — CodeBuddy / OpenCode / MiMo，per-agent 独立模型选择，支持多模态图片输入
- **三级环境隔离** — `shared` / `isolated` / `task` 三种 provision 模式，admin 后台动态切换
- **环境池 (Environment Pool)** — 预创建 CloudBase 环境 + CAM，获取延迟从分钟级降至毫秒级
- **子工作区隔离 (Scope API)** — 同一 session 内多个隔离工作区，独立 vite dev server
- **CloudBase MCP** — 内置 50+ CloudBase 工具，支持 stdio / HTTP 双模式，koa 风格中间件框架
- **Human-in-Loop** — ToolConfirm + AskUserQuestion，Plan 模式写操作拦截
- **预览沙箱** — 内嵌 Browser 工具栏、HMR 热更新、preview bridge postMessage 协议、错误自动修复
- **部署能力** — Web 静态托管（CDN）、微信小程序（异步轮询）
- **图片生成** — Default 模式 ImageGen，上传至 CloudBase 静态托管并返回 CDN 链接

## 项目结构

```
├── docs/
│   ├── setup.md                  # setup 详解与排障
│   └──  architecture.md           # 系统架构文档
├── packages/
│   ├── web/                  # React 19 + Vite 前端
│   ├── server/               # Hono 后端：Auth、Agent 编排、Sandbox 管理
│   ├── dashboard/            # CloudBase 资源管理 UI（DB / Storage / Functions）
│   └── shared/               # ACP 协议类型、任务 / 消息 schema
├── scripts/
│   ├── init.mjs              # 交互式初始化脚本
│   └── setup-tcr.mjs         # TCR 镜像仓库配置
└── init.sh                   # 快速入口
```

## 系统架构概览

- `packages/web` 提供面向用户的主交互界面，包括任务、对话、日志和仓库相关能力
- `packages/server` 负责认证、API 路由、Agent 编排、消息持久化与 SCF Sandbox 管理
- `packages/dashboard` 提供 CloudBase 资源管理相关界面
- `packages/shared` 提供前后端共享类型和协议定义
- CloudBase 负责数据库、云函数、存储和镜像基础设施，CodeBuddy / 模型层负责智能体能力

更完整的分层图、用户环境绑定机制和任务执行链路见 [系统架构文档](docs/architecture.md)。

## 快速开始

**前置条件**

- Node.js >= 18
- Docker
- 腾讯云账号（CloudBase 环境 + API 密钥）
- CodeBuddy API Key 或 OAuth 配置

**一键初始化**

```bash
git clone <repository-url>
cd coding-agent-template
./init.sh
```

初始化脚本依次完成：Node.js 检查 → pnpm 安装 → `.env.local` 生成 → Docker 检查 → CloudBase 配置 → 依赖安装 → CodeBuddy 认证 → TCR 配置 → 数据库初始化。

详细步骤与排障见 [docs/setup.md](docs/setup.md)。

## 开发

```bash
pnpm dev          # 同时启动 web (localhost:5174) 和 server (localhost:3001)
pnpm dev:web      # 仅启动前端
pnpm dev:server   # 仅启动后端
```

## 生产

```bash
pnpm build        # 构建所有包
pnpm start        # 启动生产服务（端口 3001，同时服务 API 和静态文件）
```

## 常用命令

```bash
# 代码质量
pnpm type-check   # TypeScript 类型检查
pnpm lint         # ESLint
pnpm format       # Prettier 格式化

# 数据库
pnpm db:generate  # 生成迁移
pnpm db:push      # 推送 schema
pnpm db:studio    # 打开 Drizzle Studio

# TCR 镜像仓库
pnpm setup:tcr
pnpm setup:tcr --namespace my-app --local-image node:20
```

## 环境变量

完整的变量说明见 [docs/setup.md](docs/setup.md)。核心变量：

```env
# 加密密钥（init 脚本自动生成）
JWE_SECRET=
ENCRYPTION_KEY=

# 认证
NEXT_PUBLIC_AUTH_PROVIDERS=local   # local | github | cloudbase

# CloudBase
TCB_SECRET_ID=
TCB_SECRET_KEY=
TENCENTCLOUD_ACCOUNT_ID=
TCB_ENV_ID=
TCB_PROVISION_MODE=shared          # shared | isolated | task

# TCR
TCR_NAMESPACE=
TCR_PASSWORD=
TCR_IMAGE=

# 可选
MAX_MESSAGES_PER_DAY=50
MAX_SANDBOX_DURATION=300
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
GIT_PERSONAL_AUTH=
```

## 技术栈

| 层      | 技术                                                    |
| ------- | ------------------------------------------------------- |
| 前端    | React 19, Vite, Tailwind CSS 4, shadcn/ui, Jotai        |
| 后端    | Hono, Node.js, Drizzle ORM                              |
| 数据库  | CloudBase DB（主），SQLite（本地回退）                  |
| AI      | `@tencent-ai/agent-sdk` (CodeBuddy), OpenCode ACP, MiMo |
| Sandbox | CloudBase SCF, TCR 容器镜像                             |
| 认证    | JWE session, bcrypt, Arctic (OAuth)                     |
| 持久化  | CloudBase DB, 本地 .jsonl, Git archive                  |

## 与上游的关系

本项目 fork 自 Vercel 的 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template)。主要差异：

- 架构：Next.js 全栈 → Monorepo 前后端分离（React + Vite / Hono）
- 部署：Vercel → 腾讯云 CloudBase
- Sandbox：Vercel Sandbox → CloudBase SCF

## Contributing

1. Fork 并创建功能分支 (`git checkout -b feature/xxx`)
2. 开发完成后确保通过：`pnpm type-check && pnpm lint && pnpm format`
3. 提交 Pull Request

**日志安全规则**：所有 `logger.*` / `console.*` 调用必须使用静态字符串，不得包含 `${动态值}`。详见 [AGENTS.md](./AGENTS.md)。

## Acknowledgments

- [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) by Vercel
- [CloudBase](https://cloudbase.net/) — 云开发基础设施
- [CodeBuddy](https://copilot.tencent.com/) — AI 编程助手
- [Hono](https://hono.dev/) — 轻量级 Web 框架

## License

基于 [coding-agent-template](https://github.com/vercel-labs/coding-agent-template) (Copyright 2025 Vercel, Inc.) 改造，沿用 Apache License 2.0。详见 [LICENSE](./LICENSE) 和 [NOTICE](./NOTICE)。
