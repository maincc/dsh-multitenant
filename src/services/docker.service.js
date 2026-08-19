/**
 * Docker 服务模块
 * 封装所有 Docker CLI 操作
 */

import { execFile } from 'node:child_process'
import { CONFIG } from '../config/config.js'

const IMAGE = process.env.DSH_TENANT_IMAGE || CONFIG.docker.image
const STARTUP_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS || CONFIG.docker.startupTimeoutMs)

/**
 * 封装 execFile 为 Promise
 */
function sh(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout ?? '')
        err.stderr = String(stderr ?? '')
        reject(err)
      } else {
        resolvePromise(String(stdout ?? '').trim())
      }
    })
  })
}

export class DockerService {
  /**
   * 检查 Docker 是否可用
   */
  async isDockerAvailable() {
    try {
      await sh('docker', ['version'])
      return true
    } catch {
      return false
    }
  }

  /**
   * 查询容器是否存在及其运行状态
   */
  async containerInfo(name) {
    try {
      const out = await sh('docker', ['inspect', '--format', '{{.State.Status}}', name])
      return { exists: true, status: out }
    } catch {
      return { exists: false, status: 'missing' }
    }
  }

  /**
   * 查询容器实际映射到宿主的端口
   */
  async publishedPort(container) {
    try {
      const out = await sh('docker', [
        'inspect',
        '--format',
        '{{range $p, $c := .NetworkSettings.Ports}}{{$p}}={{$c}}{{end}}',
        container,
      ])
      const m = out.match(/3080\/tcp=\[?\{?0\.0\.0\.0 (\d+)|3080\/tcp=(\d+)/)
      if (m) return Number(m[1] || m[2])
    } catch {
      // container gone
    }
    return null
  }

  /**
   * 创建并启动容器
   */
  async createContainer(name, port, volume, patchFile, limits) {
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--restart',
      'unless-stopped',
      '--memory',
      limits.memory,
      '--memory-swap',
      limits.memorySwap,
      '--cpus',
      limits.cpus,
      '--pids-limit',
      String(limits.pids),
      '-p',
      `${port}:3080`,
      '-v',
      `${volume}:/dsh-home`,
      '-v',
      `${patchFile}:/patches/tenant.patch.yml:ro`,
      IMAGE,
    ]
    await sh('docker', args)
  }

  /**
   * 启动容器
   */
  async startContainer(name) {
    await sh('docker', ['start', name])
  }

  /**
   * 停止容器
   */
  async stopContainer(name) {
    await sh('docker', ['stop', name])
  }

  /**
   * 删除容器（保留数据卷）
   */
  async removeContainer(name) {
    await sh('docker', ['rm', name])
  }

  /**
   * 强制删除容器
   */
  async forceRemoveContainer(name) {
    try {
      await sh('docker', ['rm', '-f', name])
    } catch {
      // already gone
    }
  }

  /**
   * 更新容器资源配额
   */
  async updateContainer(name, limits) {
    await sh('docker', [
      'update',
      '--memory',
      limits.memory,
      '--memory-swap',
      limits.memorySwap,
      '--cpus',
      limits.cpus,
      '--pids-limit',
      String(limits.pids),
      name,
    ])
  }

  /**
   * 获取容器资源使用统计
   */
  async getContainerStats(containerName) {
    try {
      const out = await sh('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","memPercent":"{{.MemPerc}}","net":"{{.NetIO}}","block":"{{.BlockIO}}"}',
        containerName,
      ])
      return JSON.parse(out)
    } catch {
      return null
    }
  }

  /**
   * 轮询等待容器就绪
   */
  async waitReady(port, timeoutMs = STARTUP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        if (res.ok) return true
      } catch {
        // 还没起来，继续等
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  /**
   * 列出所有 dsh-swtc- 容器
   */
  async listSwtcContainers() {
    try {
      const out = await sh('docker', [
        'ps',
        '-a',
        '--filter',
        'name=dsh-swtc-',
        '--format',
        '{{.Names}}',
      ])
      return out.split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * 检查容器详细配置
   */
  async inspectContainer(name) {
    try {
      const out = await sh('docker', ['inspect', name])
      return JSON.parse(out)[0]
    } catch {
      return null
    }
  }
}

export const dockerService = new DockerService()
