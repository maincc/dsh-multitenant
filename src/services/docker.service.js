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
        '{{json .NetworkSettings.Ports}}',
        container,
      ])
      const parsed = JSON.parse(out)
      const binding = parsed?.['3080/tcp']?.[0]
      if (binding?.HostPort) return Number(binding.HostPort)
    } catch {
      // container gone / 格式异常
    }
    try {
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
   * @param {string} name 容器名
   * @param {number} internalPort 宿主回环端口（127.0.0.1 只本机可连；外部进路由网关代理）
   * @param {string} volume 租户数据卷名
   * @param {string} patchFile cordis patch 路径
   * @param {object} limits 资源限额
   */
  async createContainer(name, internalPort, volume, patchFile, limits) {
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--restart',
      'unless-stopped',
      // DSH 的 bash 沙箱（bwrap）需要在这三个条件下才能工作：
      //   - --cap-add SYS_ADMIN：允许创建 mount/用户命名空间、pivot_root
      //   - --security-opt seccomp=unconfined：Docker 默认 seccomp profile
      //     会拦截 bwrap 的 namespace 创建与 pivot_root 系统调用
      //     （bwrap: Creating new namespace failed / pivot_root failed）
      //   - --security-opt apparmor=unconfined：Linux 主机 docker-default
      //     AppArmor profile 拦截 bwrap 的 mount 操作
      //     （bwrap: Failed to make / slave: Permission denied）
      // 仅对租户容器内部生效（容器本身就是租户隔离边界），不暴露给宿主。
      '--cap-add',
      'SYS_ADMIN',
      '--security-opt',
      'seccomp=unconfined',
      '--security-opt',
      'apparmor=unconfined',
      '--memory',
      limits.memory,
      '--cpus',
      limits.cpus,
      '--pids-limit',
      String(limits.pids),
      // 磁盘配额（尽力而为）：--storage-opt size= 仅对支持配额的后端生效
      // （btrfs/zfs/devicemapper）；overlayfs/overlay2 下接受但不强制，
      // 记录在 HostConfig.StorageOpt 供审计。换存储驱动后自动变为硬限制。
      '--storage-opt',
      `size=${limits.disk}`,
      // 回环发布：外部网络物理不可达，只有宿主本机（网关）能连。
      // 用户浏览器访问的是网关的对外端口（0.0.0.0），网关转发到这里。
      '-p',
      `127.0.0.1:${internalPort}:3080`,
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
   * 列出全量 docker 卷名
   */
  async listVolumes() {
    try {
      const out = await sh('docker', ['volume', 'ls', '--format', '{{.Name}}'])
      return out.split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * 所有容器（含已停止）当前挂载引用的卷名集合
   * （清理孤儿卷时用于排除"仍有容器在用"的卷，避免误删）
   */
  async listReferencedVolumes() {
    const refs = new Set()
    try {
      const out = await sh('docker', ['ps', '-a', '--format', '{{.Names}}'])
      const names = out.split('\n').filter(Boolean)
      for (const name of names) {
        const info = await this.inspectContainer(name)
        for (const mount of info?.Mounts || []) {
          if (mount.Name) refs.add(mount.Name.toLowerCase())
        }
      }
    } catch {
      /* 返回已收集到的引用（尽力而为） */
    }
    return refs
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
   * 更新容器资源配额（热更新）
   * 注：docker update 不支持 --storage-opt，磁盘配额须在重建容器时应用（见 createContainer）
   */
  async updateContainer(name, limits) {
    await sh('docker', [
      'update',
      '--memory',
      limits.memory,
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

  /**
   * 宿主磁盘使用情况（df -k /）
   * 返回 { totalKB, usedKB, availableKB, usePercent }，失败返回 null
   */
  async hostDiskUsage() {
    try {
      const out = await sh('df', ['-k', '/'])
      const lines = out.split('\n')
      if (lines.length < 2) return null
      const parts = lines[1].split(/\s+/)
      return {
        totalKB: parseInt(parts[1], 10) || 0,
        usedKB: parseInt(parts[2], 10) || 0,
        availableKB: parseInt(parts[3], 10) || 0,
        usePercent: parts[4] || '0%',
      }
    } catch {
      return null
    }
  }

  /**
   * Docker 整体磁盘占用（docker system df）
   * 使用 --format 输出（| 分隔），避免 Local Volumes / Build Cache 多词类型名被空白拆开。
   * 返回各类型 { name, total, active, size, reclaimable } 列表，失败返回 null
   */
  async dockerDiskSummary() {
    try {
      const out = await sh('docker', [
        'system',
        'df',
        '--format',
        '{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}',
      ])
      const items = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, total, active, size, reclaimable] = line.split('|')
          return { name, total, active, size, reclaimable }
        })
      return { items }
    } catch {
      return null
    }
  }

  /**
   * 租户数据卷占用（docker system df -v，筛选 dsh-data-swtc-*）
   * 返回 [ { volume, size } ]，失败返回 null
   */
  async tenantVolumeUsage() {
    try {
      const out = await sh('docker', ['system', 'df', '-v'])
      const volumes = []
      out.split('\n').forEach((line) => {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 3 && parts[0].startsWith('dsh-data-swtc-')) {
          volumes.push({ volume: parts[0], size: parts[2] })
        }
      })
      return volumes
    } catch {
      return null
    }
  }

  /**
   * 单卷真实占用（du -s 实测，起一次临时容器）
   * 返回字节数；失败返回 null
   * 注：低频校正用途（如手动扫描/每日快照），勿在定时器热路径中逐卷调用。
   */
  async duVolumeSize(volume) {
    try {
      const out = await sh('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        '-v',
        `${volume}:/dsh-home`,
        IMAGE,
        '-c',
        'du -sb /dsh-home 2>/dev/null | cut -f1',
      ])
      const bytes = Number.parseInt(out, 10)
      return Number.isFinite(bytes) && bytes >= 0 ? bytes : null
    } catch {
      return null
    }
  }
}

export const dockerService = new DockerService()
