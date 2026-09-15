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
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG } from './config/config.js'
import { userService } from './services/user.service.js'
import { handleAdminRoutes } from './routes/admin.routes.js'
import { handleUserRoutes } from './routes/user.routes.js'
import { handleTenantRoutes } from './routes/tenant.routes.js'
import { handleSkillRoutes } from './routes/skill.routes.js'
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
    // 缓存策略：
    // - html（index.html / SPA fallback）：no-cache，每次回源校验，防止旧页面引用旧 bundle
    // - assets/*（Vite 产物带内容 hash）：immutable 长缓存，URL 变即取新文件
    // - 其余小文件：no-cache，避免部署后残留旧资源
    const cacheControl =
      ext === 'html'
        ? 'no-cache'
        : filePath.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
    const headers = { 'content-type': contentType }
    if (cacheControl) headers['cache-control'] = cacheControl
    res.writeHead(200, headers)
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
 * 启动每日使用时限检查定时器
 */
function startUsageLimitTimer() {
  const interval = CONFIG.usageLimit?.checkIntervalMs ?? 60000
  setInterval(() => userService.checkUsageLimitAndStop(), interval)
  const minutes = CONFIG.usageLimit?.dailyMinutes ?? 120
  console.log(
    `[usage-limit] timer started: check every ${(interval / 1000).toFixed(0)}s, daily limit ${minutes}min, CWT authorized users exempt`,
  )
}

/**
 * 启动资源监控定时器
 * 每 monitorIntervalMs 检查一次运行中租户容器的内存使用率，
 * 超过 autoUpgradeThreshold 自动升一级配额（userService.monitorResources）。
 */
function startResourceMonitor() {
  const interval = CONFIG.resource.monitorIntervalMs
  const threshold = CONFIG.resource.autoUpgradeThreshold
  setInterval(() => {
    userService.monitorResources().catch((err) => {
      console.error('[monitor] resource monitor error:', err.message)
    })
  }, interval)
  console.log(
    `[monitor] resource monitor started: check every ${(interval / 1000).toFixed(0)}s, auto-upgrade at ${threshold}% memory`,
  )
}

/**
 * 启动磁盘采集定时器
 * 每 diskCheckIntervalMs 采集一次宿主磁盘 / Docker 总体 / 租户卷占用，
 * 结果缓存到 userService.diskUsage 供 /api/stats 返回（首次启动立即采集一次）。
 */
function startDiskMonitor() {
  const interval = CONFIG.resource?.diskCheckIntervalMs ?? 300000
  setInterval(() => {
    userService.collectDiskUsage().catch((err) => {
      console.error('[disk] monitor error:', err.message)
    })
  }, interval)
  // 立即采集一次，避免首个展示周期无数据
  userService.collectDiskUsage().catch((err) => {
    console.error('[disk] initial collect error:', err.message)
  })

  // 每日一次精确扫描（du 实测），校正 overlayfs 引擎口径偏差。
  // 低频 O(n)：卷少时开销小，卷多时被 scanVolumeUsage 的 maxVolumes 上限保护跳过。
  const dailyMs = 24 * 60 * 60 * 1000
  setInterval(() => {
    userService.scanVolumeUsage().catch((err) => {
      console.error('[disk] daily precise scan error:', err.message)
    })
  }, dailyMs)

  console.log(`[disk] monitor started: collect every ${(interval / 60000).toFixed(0)}min`)
}

/**
 * 启动等待队列处理定时器
 * 每 30 秒检查一次队列，尝试为等待的用户创建容器
 */
function startQueueProcessor() {
  const interval = 30000 // 30 秒
  setInterval(async () => {
    try {
      const processed = await userService.processWaitQueue()
      if (processed.length > 0) {
        console.log(`[queue] processed ${processed.length} items`)
      }
    } catch (err) {
      console.error('[queue] error processing queue:', err.message)
    }
  }, interval)
  console.log(`[queue] processor started: check every ${(interval / 1000).toFixed(0)}s`)
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
  if (
    path.startsWith('/api/admin/') ||
    path === '/api/users' ||
    path === '/api/stats' ||
    path === '/api/docker/status'
  ) {
    if (await handleAdminRoutes(req, res, path, url)) return
  }

  // 技能市场路由
  if (path.startsWith('/api/skills')) {
    if (await handleSkillRoutes(req, res, path)) return
  }

  // 用户路由
  if (
    path.startsWith('/api/user/') ||
    path.startsWith('/api/upgrade/') ||
    path.startsWith('/api/cwt/')
  ) {
    if (await handleUserRoutes(req, res, path)) return
  }

  // 租户路由
  if (
    path === '/connect' ||
    path === '/connect-status' ||
    path.startsWith('/leave/') ||
    (path.startsWith('/api/user/') &&
      (path.endsWith('/remove') ||
        path.endsWith('/restart') ||
        path.endsWith('/reset') ||
        path.endsWith('/stop')))
  ) {
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

  // SPA 路由 fallback；未注册的 /api/* 一律返回 404 JSON，绝不能吞成前端 HTML
  if (!res.headersSent) {
    if (path.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }))
      return
    }
    serveFrontend(res)
  }
})

// 启动服务器
const PORT = Number(process.env.PORT || CONFIG.server.port)
server.listen(PORT, '0.0.0.0', async () => {
  await userService.restoreFromDocker()
  startCleanupTimer()
  startUsageLimitTimer()
  startResourceMonitor()
  startDiskMonitor()
  startQueueProcessor()
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
