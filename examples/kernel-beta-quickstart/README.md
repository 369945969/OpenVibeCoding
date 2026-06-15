# kernel-beta-quickstart

独立示例：从 **npm** 安装 `@cloudbase/open-agent-kernel@beta`，验证已发布的 beta 包能否正常构建 Agent。

本目录在 monorepo 的 `packages/*` workspace 之外，安装时会从 npm registry 拉包，不会链接本地 workspace 源码。

## 要求

- Node.js >= 22
- 已发布并可访问的 `@cloudbase/open-agent-kernel@beta`
- CloudBase 环境已开通 AI gateway，且有可用的 `TCB_API_KEY`

## 使用

```bash
cd examples/kernel-beta-quickstart

cp config.example.json config.local.json
# 编辑 config.local.json，填入 envId / model / tcbApiKey

npm install
npm start
```

> 本目录在 monorepo 内时，请用 `npm install`（会正确从 registry 安装 beta 包）。若用 `pnpm install` 可能不会在此目录生成独立 `node_modules`。

### 带 CloudBase 资源（credentials）

若要验证传 `credentials` 后默认启用的 DB / Storage 等行为：

```bash
# config.local.json 中填好 credentials
pnpm start:full
```

## 预期输出

成功时大致如下：

```text
[kernel-beta-quickstart] SDK version: 0.1.0-beta.0
[kernel-beta-quickstart] mode: minimal
User: 你好，请用一句话介绍你自己，并说明你是否了解 CloudBase。

Assistant: ……
[session_idle] reason=completed
```

## 与 monorepo 内 examples 的区别

| | `examples/kernel-beta-quickstart` | `packages/open-agent-kernel/examples` |
|--|-----------------------------------|---------------------------------------|
| 依赖来源 | npm `@cloudbase/open-agent-kernel@beta` | 本地 workspace / 需先 `pnpm build` |
| 用途 | 验证已发布包 | 开发调试 SDK 功能 |

## 故障排查

| 现象 | 处理 |
|------|------|
| `config.local.json is required` | 复制 `config.example.json` 并填写 |
| `No API key found` / 401 | 检查 `tcbApiKey` 是否为有效的 CloudBase 服务端 APIKey |
| 安装到 workspace 本地包 | 确认在 `examples/kernel-beta-quickstart` 目录执行，而非 `packages/open-agent-kernel` |
