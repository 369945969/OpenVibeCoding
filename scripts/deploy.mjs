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
import { existsSync, readFileSync, writeFileSync } from 'fs'
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

// Prefixes reserved by the cloud platform — cannot be used as env var keys
const RESERVED_PREFIXES = ['SCF_', 'QCLOUD_', 'TENCENTCLOUD_']

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
    // Platform reserved prefixes — rename with CB_ prefix to bypass restriction
    if (RESERVED_PREFIXES.some((p) => key.startsWith(p))) {
      filtered[`CB_${key}`] = value
      continue
    }
    filtered[key] = value
  }

  // Force production settings
  filtered.NODE_ENV = 'production'
  // PORT is set by Dockerfile (80) — do NOT override here so container listens on the
  // same port that imageConfig.imagePort / CloudRun expects.

  return filtered
}

// ===================== CloudRun Deploy =====================

async function deployCloudRun(env, skipBuild) {
  logSection('部署到云托管（容器服务）')

  const envId = env.TCB_ENV_ID
  if (!envId) {
    log('缺少 TCB_ENV_ID，请先运行 ./init.sh', 'error')
    process.exit(1)
  }

  if (!commandExists('cloudbase')) {
    log('cloudbase CLI 未安装，请先安装：npm i -g @cloudbase/cli', 'error')
    process.exit(1)
  }

  // Ensure cloudbaserc.json has envId so CLI can read it
  const rcBackup = existsSync(CLOUDBASERC) ? readFileSync(CLOUDBASERC, 'utf-8') : null
  const rcContent = { envId }
  writeFileSync(CLOUDBASERC, JSON.stringify(rcContent, null, 2))

  try {
    // cloudbase cloudrun deploy uploads source + Dockerfile to cloud for building
    // No local Docker required — cloud builds the image from Dockerfile
    log('提交到云托管（云端构建）...')
    run(`cloudbase cloudrun deploy -s ${DEFAULT_SERVICE_NAME} --port 80 --force --source .`)
  } catch (err) {
    log('部署失败', 'error')
    log(`可在控制台手动部署：https://tcb.cloud.tencent.com/dev?envId=${envId}#/run`, 'info')
    process.exit(1)
  } finally {
    if (rcBackup) writeFileSync(CLOUDBASERC, rcBackup)
  }

  // Done
  console.log('')
  log('部署已提交，云端构建中...', 'success')
  console.log('')
  console.log(`  ${colors.bright}服务：${colors.reset}${DEFAULT_SERVICE_NAME}`)
  console.log(`  ${colors.bright}查看构建进度：${colors.reset}`)
  console.log(`  https://tcb.cloud.tencent.com/dev?envId=${envId}#/platform-run/service/detail?serverName=${DEFAULT_SERVICE_NAME}&tabId=deploy&envId=${envId}`)
  console.log('')
  console.log(`  ${colors.bright}部署完成后访问：${colors.reset}https://${envId}.service.tcloudbase.com`)
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

  // Step 2: Build Docker image (same as CloudRun — reuses Dockerfile)
  // Cloud Function supports image deployment which avoids pnpm/node_modules compatibility issues
  const namespace = env.TCR_NAMESPACE
  const password = env.TCR_PASSWORD
  const accountId = env.TENCENTCLOUD_ACCOUNT_ID

  if (!namespace || !password) {
    log('缺少 TCR 配置（TCR_NAMESPACE / TCR_PASSWORD），请先运行 pnpm setup:tcr', 'error')
    process.exit(1)
  }

  if (!commandExists('docker')) {
    log('Docker 未安装或未运行', 'error')
    process.exit(1)
  }

  const tag = getGitHash()
  const imageName = `${TCR_DOMAIN}/${namespace}/${DEFAULT_SERVICE_NAME}`
  const imageTag = `${imageName}:${tag}`

  log(`构建 Docker 镜像 → ${imageTag}`)
  run(`docker build -t ${imageTag} .`)

  // Docker login (if needed) + push
  log('推送镜像到 TCR...')
  try {
    // Try push directly (docker may already be logged in)
    run(`docker push ${imageTag}`)
  } catch {
    // Not logged in — try login then push
    const dockerUser = accountId || '100000000001'
    try {
      execSync(
        `echo "${password}" | docker login ${TCR_DOMAIN} -u ${dockerUser} --password-stdin`,
        { stdio: 'pipe', cwd: ROOT },
      )
      run(`docker push ${imageTag}`)
    } catch {
      log('Docker push 失败，请手动 docker login 后重试', 'error')
      log(`  docker login ${TCR_DOMAIN}`, 'info')
      log(`  docker push ${imageTag}`, 'info')
      process.exit(1)
    }
  }

  // Step 3: Deploy as image-based function
  log('部署到云函数（镜像模式）...')

  const runtimeEnv = collectRuntimeEnvVars()

  // Write cloudbaserc.json for CLI
  const rcBackup = existsSync(CLOUDBASERC) ? readFileSync(CLOUDBASERC, 'utf-8') : null
  const fnConfig = {
    envId,
    functions: [{
      name: DEFAULT_SERVICE_NAME,
      type: 'HTTP',
      timeout: 900,
      memorySize: 512,
      envVariables: runtimeEnv,
      imageConfig: {
        imageType: 'personal',
        imageUri: imageTag,
        imagePort: 80,
      },
    }],
  }
  writeFileSync(CLOUDBASERC, JSON.stringify(fnConfig, null, 2))

  try {
    run(`cloudbase fn deploy ${DEFAULT_SERVICE_NAME} --httpFn --path / --force --deployMode image`)
  } catch (err) {
    log('部署失败', 'error')
    log(`镜像地址：${imageTag}`, 'info')
    log(`可在控制台手动部署：https://tcb.cloud.tencent.com/dev?envId=${envId}#/function`, 'info')
    process.exit(1)
  } finally {
    if (rcBackup) writeFileSync(CLOUDBASERC, rcBackup)
  }

  // Done
  console.log('')
  log('部署完成！', 'success')
  console.log('')
  console.log(`  ${colors.bright}函数名：${colors.reset}${DEFAULT_SERVICE_NAME}`)
  console.log(`  ${colors.bright}镜像：${colors.reset}${imageTag}`)
  console.log(`  ${colors.bright}环境变量：${colors.reset}${Object.keys(runtimeEnv).length} 个`)
  console.log(`  ${colors.bright}访问地址：${colors.reset}https://${envId}.service.tcloudbase.com/`)
  console.log(`  ${colors.dim}（HTTP 路径 / 已绑定，如遇冲突请到控制台调整）${colors.reset}`)
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
