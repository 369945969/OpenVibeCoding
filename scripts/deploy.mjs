#!/usr/bin/env node

/**
 * Deploy Script — 一键部署到 CloudBase 云托管或 Web 云函数
 *
 * Usage:
 *   pnpm deploy              # 交互式选择部署方式
 *   pnpm deploy --cloudrun   # 直接部署到云托管
 *   pnpm deploy --function   # 直接部署到 Web 云函数
 *   pnpm deploy --skip-build # 跳过构建步骤
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'fs'
import { resolve } from 'path'
import readline from 'readline'

// ===================== Constants =====================

const ROOT = process.cwd()
const ENV_FILE = resolve(ROOT, '.env.local')
const SERVER_ENV_FILE = resolve(ROOT, 'packages/server/.env')
const CLOUDBASERC = resolve(ROOT, 'cloudbaserc.json')
const TCR_DOMAIN = 'ccr.ccs.tencentyun.com'
const DEFAULT_SERVICE_NAME = 'vibecoding-platform'

// Env vars to skip when injecting into cloud runtime
const SKIP_ENV_VARS = new Set([
  'PORT', 'NODE_ENV', 'DATABASE_PATH', 'SCF_SANDBOX_TEST_URL',
])

// ===================== Helpers =====================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
}

function log(message, type = 'info') {
  const prefix = {
    info: `${colors.cyan}→${colors.reset}`,
    success: `${colors.green}✓${colors.reset}`,
    error: `${colors.red}✗${colors.reset}`,
    warn: `${colors.yellow}!${colors.reset}`,
  }[type]
  console.log(`${prefix} ${message}`)
}

function logSection(title) {
  console.log('')
  console.log(`${colors.bright}${colors.cyan}━━━ ${title} ━━━${colors.reset}`)
}

function loadEnvFile(filePath) {
  const env = {}
  if (existsSync(filePath)) {
    readFileSync(filePath, 'utf-8').split('\n').forEach((line) => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...rest] = trimmed.split('=')
        if (key) env[key.trim()] = rest.join('=').trim()
      }
    })
  }
  return env
}

function promptInput(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`${prompt}: `, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function askYesNo(prompt, defaultValue = true) {
  const hint = defaultValue ? '[Y/n]' : '[y/N]'
  const answer = await promptInput(`${prompt} ${hint}`)
  if (!answer) return defaultValue
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes'
}

function getGitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: 'pipe' }).trim()
  } catch {
    return `build-${Date.now()}`
  }
}

function commandExists(name) {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function run(cmd, options = {}) {
  console.log(`  ${colors.dim}$ ${cmd}${colors.reset}`)
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...options })
}

// ===================== Env Var Collection =====================

function collectRuntimeEnvVars() {
  const serverEnv = loadEnvFile(SERVER_ENV_FILE)
  const filtered = {}

  for (const [key, value] of Object.entries(serverEnv)) {
    if (!value) continue
    if (SKIP_ENV_VARS.has(key)) continue
    filtered[key] = value
  }

  // Force production settings
  filtered.NODE_ENV = 'production'
  filtered.PORT = '80'

  return filtered
}

// ===================== CloudRun Deploy =====================

async function deployCloudRun(env, skipBuild) {
  logSection('部署到云托管（容器服务）')

  const namespace = env.TCR_NAMESPACE
  const password = env.TCR_PASSWORD
  const envId = env.TCB_ENV_ID
  const accountId = env.TENCENTCLOUD_ACCOUNT_ID

  if (!namespace || !password) {
    log('缺少 TCR 配置（TCR_NAMESPACE / TCR_PASSWORD），请先运行 pnpm setup:tcr', 'error')
    process.exit(1)
  }
  if (!envId) {
    log('缺少 TCB_ENV_ID，请先运行 ./init.sh', 'error')
    process.exit(1)
  }

  // Check docker
  if (!commandExists('docker')) {
    log('Docker 未安装或未运行', 'error')
    process.exit(1)
  }

  // Step 1: Build
  if (!skipBuild) {
    log('构建项目...')
    run('pnpm build')
  } else {
    log('跳过构建（--skip-build）', 'warn')
  }

  // Step 2: Build docker image
  const tag = getGitHash()
  const imageName = `${TCR_DOMAIN}/${namespace}/${DEFAULT_SERVICE_NAME}`
  const imageTag = `${imageName}:${tag}`

  log(`构建 Docker 镜像 → ${imageTag}`)
  run(`docker build -t ${imageTag} -t ${imageName}:latest .`)

  // Step 3: Docker login + push
  log('登录 TCR...')
  const dockerUser = accountId || '100000000001'
  try {
    execSync(
      `echo "${password}" | docker login ${TCR_DOMAIN} -u ${dockerUser} --password-stdin`,
      { stdio: 'pipe', cwd: ROOT },
    )
  } catch (err) {
    log('Docker login 失败，请检查 TCR_PASSWORD 和 TENCENTCLOUD_ACCOUNT_ID', 'error')
    process.exit(1)
  }

  log('推送镜像...')
  run(`docker push ${imageTag}`)
  run(`docker push ${imageName}:latest`)

  // Step 4: Deploy to CloudRun
  log('部署到云托管...')

  const runtimeEnv = collectRuntimeEnvVars()
  const envParamsJson = JSON.stringify(runtimeEnv)

  // Update cloudbaserc.json
  const rcContent = { envId, cloudrun: { name: DEFAULT_SERVICE_NAME } }
  writeFileSync(CLOUDBASERC, JSON.stringify(rcContent, null, 2))

  // Try cloudbase CLI deploy
  if (commandExists('cloudbase')) {
    try {
      run(`cloudbase run:deploy ${DEFAULT_SERVICE_NAME} --envId ${envId} --image ${imageTag} --override '{"containerPort":80,"envParams":${JSON.stringify(envParamsJson)}}'`)
    } catch {
      log('cloudbase run:deploy 失败，尝试使用 MCP 工具方式...', 'warn')
      log(`请手动在云开发控制台部署镜像：${imageTag}`, 'info')
      log(`控制台地址：https://tcb.cloud.tencent.com/dev?envId=${envId}#/run`, 'info')
    }
  } else {
    log('cloudbase CLI 未安装，请手动部署', 'warn')
    log(`镜像地址：${imageTag}`, 'info')
    log(`控制台：https://tcb.cloud.tencent.com/dev?envId=${envId}#/run`, 'info')
  }

  // Done
  console.log('')
  log('部署完成！', 'success')
  console.log('')
  console.log(`  ${colors.bright}镜像：${colors.reset}${imageTag}`)
  console.log(`  ${colors.bright}服务：${colors.reset}${DEFAULT_SERVICE_NAME}`)
  console.log(`  ${colors.bright}环境变量：${colors.reset}${Object.keys(runtimeEnv).length} 个已注入`)
  console.log(`  ${colors.bright}访问地址：${colors.reset}https://${envId}.service.tcloudbase.com`)
  console.log('')
}

// ===================== Web Function Deploy =====================

async function deployFunction(env, skipBuild) {
  logSection('部署到 Web 云函数')

  const envId = env.TCB_ENV_ID
  if (!envId) {
    log('缺少 TCB_ENV_ID，请先运行 ./init.sh', 'error')
    process.exit(1)
  }

  if (!commandExists('cloudbase')) {
    log('cloudbase CLI 未安装，请先安装：npm i -g @cloudbase/cli', 'error')
    process.exit(1)
  }

  // Step 1: Build
  if (!skipBuild) {
    log('构建项目...')
    run('pnpm build')
  } else {
    log('跳过构建（--skip-build）', 'warn')
  }

  // Step 2: Prepare deploy directory
  const deployDir = resolve(ROOT, '.deploy-function')
  if (existsSync(deployDir)) rmSync(deployDir, { recursive: true })
  mkdirSync(deployDir, { recursive: true })

  log('准备部署目录...')

  // Copy built artifacts
  cpSync(resolve(ROOT, 'packages/server/dist'), resolve(deployDir, 'packages/server/dist'), { recursive: true })
  cpSync(resolve(ROOT, 'packages/web/dist'), resolve(deployDir, 'packages/web/dist'), { recursive: true })
  cpSync(resolve(ROOT, 'packages/shared/dist'), resolve(deployDir, 'packages/shared/dist'), { recursive: true })

  // Copy package manifests for production install
  for (const pkg of ['server', 'shared']) {
    cpSync(
      resolve(ROOT, `packages/${pkg}/package.json`),
      resolve(deployDir, `packages/${pkg}/package.json`),
    )
  }
  cpSync(resolve(ROOT, 'package.json'), resolve(deployDir, 'package.json'))
  cpSync(resolve(ROOT, 'pnpm-lock.yaml'), resolve(deployDir, 'pnpm-lock.yaml'))
  cpSync(resolve(ROOT, 'pnpm-workspace.yaml'), resolve(deployDir, 'pnpm-workspace.yaml'))
  if (existsSync(resolve(ROOT, 'patches'))) {
    cpSync(resolve(ROOT, 'patches'), resolve(deployDir, 'patches'), { recursive: true })
  }

  // Stub web/dashboard package.json
  mkdirSync(resolve(deployDir, 'packages/web'), { recursive: true })
  mkdirSync(resolve(deployDir, 'packages/dashboard'), { recursive: true })
  writeFileSync(resolve(deployDir, 'packages/web/package.json'), '{"name":"@coder/web","version":"0.1.0","private":true}')
  writeFileSync(resolve(deployDir, 'packages/dashboard/package.json'), '{"name":"@coder/dashboard","version":"0.1.0","private":true}')

  // Fix shared package.json exports
  const sharedPkg = resolve(deployDir, 'packages/shared/package.json')
  if (existsSync(resolve(ROOT, 'packages/shared/package.json'))) {
    let content = readFileSync(resolve(ROOT, 'packages/shared/package.json'), 'utf-8')
    content = content.replace(/\.\/src\/index\.ts/g, './dist/index.js')
    writeFileSync(sharedPkg, content)
  }

  // Install production deps
  log('安装生产依赖...')
  execSync('corepack enable && pnpm install --prod --no-frozen-lockfile --ignore-scripts', {
    stdio: 'inherit',
    cwd: deployDir,
  })

  // Create symlink for web dist
  execSync('ln -sf ../../packages/web packages/server/web', { cwd: deployDir })

  // Copy skills
  if (existsSync(resolve(ROOT, '.agents/skills/cloudbase'))) {
    cpSync(resolve(ROOT, '.agents/skills/cloudbase'), resolve(deployDir, 'packages/server/skills/cloudbase'), { recursive: true })
  }

  // Copy opencode config
  if (existsSync(resolve(ROOT, '.opencode'))) {
    cpSync(resolve(ROOT, '.opencode'), resolve(deployDir, '.opencode'), { recursive: true })
  }

  // Create entry point wrapper for cloud function
  const entryContent = `
const { createServer } = await import('./packages/server/dist/index.js')
export { createServer }
// Default export for web function runtime
export default async (event, context) => {
  // CloudBase Web Function will call this
  return { statusCode: 200, body: 'OK' }
}
`
  writeFileSync(resolve(deployDir, 'index.mjs'), entryContent.trim())

  // Step 3: Deploy
  log('部署到云函数...')

  const runtimeEnv = collectRuntimeEnvVars()

  try {
    // Use cloudbase CLI to deploy
    run(`cloudbase functions:deploy ${DEFAULT_SERVICE_NAME} --envId ${envId} --path ${deployDir}`)

    // Bind HTTP trigger
    log('绑定 HTTP 触发器...')
    run(`cloudbase functions:bindHttp ${DEFAULT_SERVICE_NAME} / --envId ${envId}`)
  } catch (err) {
    log('部署失败', 'error')
    log(`部署目录保留在：${deployDir}`, 'info')
    log(`可手动部署：cloudbase functions:deploy ${DEFAULT_SERVICE_NAME} --envId ${envId} --path ${deployDir}`, 'info')
    process.exit(1)
  }

  // Cleanup
  rmSync(deployDir, { recursive: true })

  // Done
  console.log('')
  log('部署完成！', 'success')
  console.log('')
  console.log(`  ${colors.bright}函数名：${colors.reset}${DEFAULT_SERVICE_NAME}`)
  console.log(`  ${colors.bright}环境变量：${colors.reset}${Object.keys(runtimeEnv).length} 个`)
  console.log(`  ${colors.bright}访问地址：${colors.reset}https://${envId}.service.tcloudbase.com/${DEFAULT_SERVICE_NAME}`)
  console.log('')
}

// ===================== Main =====================

async function main() {
  console.log('')
  console.log(`${colors.bright}${colors.cyan}━━━ 部署到 CloudBase ━━━${colors.reset}`)
  console.log('')

  const args = process.argv.slice(2)
  const skipBuild = args.includes('--skip-build')

  // Load env
  const env = { ...loadEnvFile(ENV_FILE), ...loadEnvFile(SERVER_ENV_FILE) }

  if (!env.TCB_ENV_ID) {
    log('未找到 TCB_ENV_ID，请先运行 ./init.sh 完成初始化', 'error')
    process.exit(1)
  }

  // Determine deploy mode
  let mode = null
  if (args.includes('--cloudrun')) mode = 'cloudrun'
  if (args.includes('--function')) mode = 'function'

  if (!mode) {
    console.log('  1) 云托管（容器服务）— 推荐，Docker 镜像部署')
    console.log('  2) Web 云函数 — 零运维，按请求计费')
    console.log('')

    const answer = await promptInput('请选择部署方式 [1/2]')
    mode = answer === '2' ? 'function' : 'cloudrun'
  }

  if (mode === 'cloudrun') {
    await deployCloudRun(env, skipBuild)
  } else {
    await deployFunction(env, skipBuild)
  }
}

main().catch((err) => {
  console.error('')
  log(`部署失败：${err.message}`, 'error')
  process.exit(1)
})
