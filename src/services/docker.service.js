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
      // 先尝试从 NetworkSettings.Ports 获取（容器运行时的实际映射）
      const out = await sh('docker', [
        'inspect',
        '--format',
        '{{range $p, $c := .NetworkSettings.Ports}}{{$p}}={{$c}}{{end}}',
        container,
      ])
      const m = out.match(/3080\/tcp=\[?\{?0\.0\.0\.0 (\d+)|3080\/tcp=(\d+)/)
      if (m) return Number(m[1] || m[2])

      // 如果 NetworkSettings.Ports 为空，尝试从 HostConfig.PortBindings 获取（配置的目标端口）
      const configOut = await sh('docker', [
        'inspect',
        '--format',
        '{{json .HostConfig.PortBindings}}',
        container,
      ])
      const configMatch = configOut.match(/"3080\/tcp":\[.*?"HostPort":"(\d+)"/)
      if (configMatch) return Number(configMatch[1])
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
      // DSH 的 bash 沙箱（bwrap）需要在这两个条件下才能工作：
      //   - --cap-add SYS_ADMIN：允许创建 mount/用户命名空间、pivot_root
      //   - --security-opt seccomp=unconfined：Docker 默认 seccomp profile
      //     会拦截 bwrap 的 namespace 创建与 pivot_root 系统调用
      //     （bwrap: Creating new namespace failed / pivot_root failed）
      //  仅对租户容器内部生效（容器本身就是租户隔离边界），不暴露给宿主。
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'seccomp=unconfined',
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
   * 启动容器（使用 restart 以确保端口映射恢复）
   */
  async startContainer(name) {
    // 使用 restart 而不是 start，因为 start 可能不会恢复端口映射
    await sh('docker', ['restart', name])
  }

  /**
   * 重启容器
   */
  async restartContainer(name) {
    await sh('docker', ['restart', name])
  }

  /**
   * 停止容器（支持优雅宽限：先 SIGTERM，宽限超时后 SIGKILL）
   * @param {string} name 容器名
   * @param {number} [graceSeconds] SIGTERM 后等待秒数，默认 10
   */
  async stopContainer(name, graceSeconds = 10) {
    await sh('docker', ['stop', '-t', String(graceSeconds), name])
  }

  /**
   * 删除容器（保留数据卷）
   */
  async removeContainer(name) {
    await sh('docker', ['rm', name])
  }

  /**
   * 删除数据卷
   */
  async removeVolume(name) {
    await sh('docker', ['volume', 'rm', name])
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
   * 列出容器内运行的进程数（宿主侧 docker top，无需进容器）
   * @param {string} name 容器名
   * @returns {Promise<number>} 进程数；容器不存在/停止返回 0
   */
  async topProcessCount(name) {
    try {
      const out = await sh('docker', ['top', name])
      const lines = out.split('\n').filter(Boolean)
      return Math.max(0, lines.length - 1) // 去掉表头
    } catch {
      return 0
    }
  }

  /**
   * 在租户镜像的辅助容器内执行一个卷脚本（挂载租户卷 + 宿主脚本）
   * @param {string} volume 租户数据卷名
   * @param {string} scriptHostPath 宿主脚本绝对路径
   * @param {string} scriptName 容器内脚本文件名
   * @param {string[]} [scriptArgs] 传给脚本的参数
   * @param {object} [opts] 选项：{ networkContainer: 共享该容器的网络命名空间 }
   * @returns {Promise<string>} 脚本 stdout
   */
  async runVolumeScript(volume, scriptHostPath, scriptName, scriptArgs = [], opts = {}) {
    const args = ['run', '--rm']
    if (opts.networkContainer) {
      args.push('--network', `container:${opts.networkContainer}`)
    }
    args.push(
      '-v',
      `${volume}:/dsh-home`,
      '-v',
      `${scriptHostPath}:/${scriptName}:ro`,
      IMAGE,
      'node',
      `/${scriptName}`,
      ...scriptArgs,
    )
    const out = await sh('docker', args)
    return out
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
