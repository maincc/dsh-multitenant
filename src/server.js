#!/usr/bin/env node
/**
 * ============================================================================
 *  dsh-multitenant 入口服务（重构版）
 * ============================================================================
 *  模块化架构：
 *    - src/config/     配置管理
 *    - src/services/   业务服务（Docker、User、Data）
 *    - src/middleware/ 中间件（认证、验证）
 *    - src/routes/     路由处理（Admin、User、Tenant）
 *    - src/utils/      工具函数（地址、错误）
 *
 *  整体流程：
 *    用户安装 CCDAO 插件 → 访问 http://127.0.0.1:8090/
 *      → 点击"连接钱包" → CCDAO 插件返回 SWTC 地址
 *      → 跳转到 /connect?address=<swtc>
 *      → 确保该地址对应的容器存在并运行
 *      → 302 跳转到该用户的专属端口
 * ============================================================================
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG } from './config/config.js'
import { userService } from './services/user.service.js'
import { handleAdminRoutes } from './routes/admin.routes.js'
import { handleUserRoutes } from './routes/user.routes.js'
import { handleTenantRoutes } from './routes/tenant.routes.js'
import { handleError } from './utils/errors.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FRONTEND_DIST = join(ROOT, 'frontend', 'dist')

/**
 * 提供静态文件服务
 */
function serveStaticFile(filePath, res) {
  const ext = filePath.split('.').pop().toLowerCase()
  const mimeTypes = {
    html: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
  }
  const contentType = mimeTypes[ext] || 'application/octet-stream'

  try {
    const content = readFileSync(filePath)
    res.writeHead(200, { 'content-type': contentType })
    res.end(content)
    return true
  } catch {
    return false
  }
}

/**
 * 提供前端页面（SPA fallback）
 */
function serveFrontend(res) {
  const indexPath = join(FRONTEND_DIST, 'index.html')
  if (serveStaticFile(indexPath, res)) {
    return true
  }
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><body>
    <h1>前端未构建</h1>
    <p>请先运行: <code>cd frontend && npm install && npm run build</code></p>
  </body></html>`)
  return true
}

/**
 * 启动清理定时器
 */
function startCleanupTimer() {
  const interval = userService.state.cleanupPolicy.checkIntervalMs
  setInterval(() => userService.cleanupIdleContainers(), interval)
  const checkMin = (interval / 60000).toFixed(0)
  const stopMin = (userService.state.cleanupPolicy.stopTimeoutMs / 60000).toFixed(0)
  const destroyMin = (userService.state.cleanupPolicy.destroyTimeoutMs / 60000).toFixed(0)
  console.log(
    `[cleanup] timer started: check every ${checkMin}min, stop after ${stopMin}min idle, destroy after ${destroyMin}min stopped`,
  )
}

/**
 * 启动资源监控定时器
 */
function startResourceMonitor() {
  const interval = CONFIG.resource.monitorIntervalMs
  const threshold = CONFIG.resource.autoUpgradeThreshold
  setInterval(() => {
    // 资源监控逻辑（可选实现）
  }, interval)
  console.log(
    `[monitor] resource monitor started: check every ${(interval / 1000).toFixed(0)}s, auto-upgrade at ${threshold}% memory`,
  )
}

// 创建 HTTP 服务器
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  // GET /health：健康检查
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // 管理路由
  if (path.startsWith('/api/admin/') || path === '/api/users' || path === '/api/stats') {
    if (await handleAdminRoutes(req, res, path, url)) return
  }

  // 用户路由
  if (path.startsWith('/api/user/') || path.startsWith('/api/upgrade/')) {
    if (await handleUserRoutes(req, res, path)) return
  }

  // 租户路由
  if (path === '/connect' || path === '/connect-status' || path.startsWith('/leave/')) {
    if (await handleTenantRoutes(req, res, path, url)) return
  }

  // 静态资源
  if (path.startsWith('/assets/') || path === '/favicon.ico') {
    const filePath = join(FRONTEND_DIST, path)
    if (serveStaticFile(filePath, res)) {
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return
  }

  // SPA 路由 fallback
  if (!res.headersSent) {
    serveFrontend(res)
  }
})

// 启动服务器
const PORT = Number(process.env.PORT || CONFIG.server.port)
server.listen(PORT, '0.0.0.0', async () => {
  await userService.restoreFromDocker()
  startCleanupTimer()
  startResourceMonitor()
  console.log(`[dsh-multitenant] entry server on http://127.0.0.1:${PORT}/`)
  console.log(
    `[dsh-multitenant] tenant image: ${CONFIG.docker.image}, host: ${CONFIG.server.publicHost}, ports from ${CONFIG.docker.basePort}`,
  )
  console.log(`[dsh-multitenant] Frontend: http://127.0.0.1:${PORT}/`)
  console.log(`[dsh-multitenant] Admin: http://127.0.0.1:${PORT}/admin`)
  console.log(`[dsh-multitenant] User: http://127.0.0.1:${PORT}/user`)
})

// 全局错误处理
process.on('unhandledRejection', (reason, promise) => {
  console.error('[fatal] Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught Exception:', err)
  process.exit(1)
})
