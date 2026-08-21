#!/usr/bin/env node
/**
 * ============================================================================
 *  dsh-multitenant 入口服务（兼容层）
 * ============================================================================
 *  本文件保留作为向后兼容，实际逻辑已迁移到 src/server.js。
 *  运行方式：
 *    node entry-server.mjs    # 旧方式（兼容，重定向到模块化入口）
 *    node src/server.js       # 新方式（推荐）
 *    npm start                # 新方式（推荐）
 *
 *  注意：旧版本文件曾内嵌整套入口实现（且缺少 node:path/fs/child_process
 *  导入导致启动即崩溃，并与 src/server.js 双重监听同一端口）。现已精简为
 *  纯重定向层，避免与模块化入口冲突。
 * ============================================================================
 */

// 重定向到新的模块化服务器
import('./src/server.js').catch((err) => {
  console.error('[fatal] Failed to start modular server:', err)
  process.exit(1)
})
