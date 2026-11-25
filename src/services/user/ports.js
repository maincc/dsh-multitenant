/**
 * 用户域模块 · 端口账本（refactor-giant-files §P2 第一刀，源 user.service.js 逐字节搬运）
 *
 * mixin 法：本文件导出普通对象，由 user.service.js `Object.assign(UserService.prototype,
 * portsMixin)` 装配——方法体内 `this.state / this._saveState / this.portInRange` 等
 * 语义与拆分前完全一致（state 仍在实例上，26 个引用 userService 的测试文件零改动（静态 18+动态 4+mock 5））。
 * 跨域互借（_saveState）是 §3.2 允许的过渡丑线，域间红线以调用面而非文件界为准。
 */

import { createServer as createNetServer } from 'node:net'
import { CONFIG } from '../../config/config.js'
import { tenantGateway } from '../tenant-proxy.service.js'

export const portsMixin = {
  /**
   * 分配宿主内部回环端口（40000-49999 随机，避开已占用）。
   * 内部端口只绑 127.0.0.1，对外进路由网关（tenantGateway）代理。
   * @param {Set<number>} [exclude] 本次分配过程要排除的端口（重试时避免拿到同一个）
   */
  allocateInternalPort(exclude = new Set()) {
    const used = new Set(exclude)
    for (const u of Object.values(this.state.swtcUsers || {})) {
      if (u?.internalPort) used.add(u.internalPort)
    }
    for (let i = 0; i < 300; i++) {
      const p = 40000 + Math.floor(Math.random() * 10000)
      if (!used.has(p)) {
        used.add(p)
        return p
      }
    }
    throw new Error('no internal port available')
  },

  /**
   * 是否存在「容器已销毁（destroyed）但记录还占着端口」的闲置端口（可按需征用）
   */
  hasReclaimablePorts() {
    for (const user of Object.values(this.state.swtcUsers || {})) {
      if (user.containerStatus === 'destroyed' && user.port) return true
    }
    return false
  },

  /**
   * 端口耗尽时的按需征用：把 destroyed 租户闲置的端口收进回收池供新用户分配。
   * 被征用者下次连接时会重新分配新端口（端口号对用户透明，内部资产转移）。
   * 前提：destroyed 状态时网关监听已关闭（cleanup/destroy 路径已补 close），端口确实空闲。
   * @param {string} excludeAddress - 本次申请者自身（不征用自己的端口）
   * @returns {number} 征用到的端口数量
   */
  async reclaimDestroyedPorts(excludeAddress) {
    if (!this.state.availablePorts) this.state.availablePorts = []
    let reclaimed = 0
    for (const [addr, user] of Object.entries(this.state.swtcUsers || {})) {
      if (!user?.port) continue
      if (addr === excludeAddress) continue
      if (user.containerStatus !== 'destroyed') continue
      if (this.state.availablePorts.includes(user.port)) continue
      // 端口段纪律（方案 B 配套）：收段后越界旧号不进池——发出去就是
      // 隧道没映射的死链接。该地址下次连接按"own 越界重发号"路径处理。
      if (!this.portInRange(user.port)) continue
      this.state.availablePorts.push(user.port)
      reclaimed++
      console.log(
        `[port] reclaiming destroyed tenant ${addr.slice(0, 8)}...: port ${user.port} → pool`,
      )
      // 端口已被征用：该地址下次连接时重新分配新端口（记录里不再保留旧号）
      delete user.port
    }
    if (reclaimed > 0) {
      this.state.availablePorts.sort((a, b) => a - b)
      await this._saveState()
    }
    return reclaimed
  },

  /**
   * 端口段形态解析（2026-11-14 双段配对；同日收敛重复键）：
   *   basePort..maxPort = **唯一对外段**（用户可见/隧道 DNAT 面，单双段皆是）。
   *   internalBasePort/internalMaxPort 同时 >0 → 配对模式：容器宿主回环映射段，
   *     运行期一一对应 internal = internalBase + (public - publicBase)，
   *     发号整对探测，外部占用跳对并记账。
   *   未配置（0）→ 内部回环口随机分配（旧行为）。
   *   （原 publicBasePort/publicMaxPort 与 basePort/maxPort 同义，已删除——
   *   六键收敛为四键，无双真源。）
   */
  tenantPortRanges() {
    const d = CONFIG.docker
    const dual = d.internalBasePort > 0 && d.internalMaxPort > 0
    return {
      pub: { base: d.basePort, max: d.maxPort },
      internal: dual ? { base: d.internalBasePort, max: d.internalMaxPort } : null,
    }
  },

  /** 双段模式下由对外端口推导配对回环端口；旧模式返回 null（随机分配）。 */
  internalForPublic(publicPort) {
    const { pub, internal } = this.tenantPortRanges()
    if (!internal) return null
    const paired = internal.base + (publicPort - pub.base)
    if (!Number.isInteger(paired) || paired < internal.base || paired > internal.max) return null
    return paired
  },

  /**
   * 占用账本：**非本服务产生的占用**逐条记录（用户要求，2026-11-14）。
   * 探针发现某号 bind 不上、而网关路由表又不认账 → 外部监听器 → 记下
   * port/scope/首末见时间/命中次数。gateway-ports 接口透出，运维排查
   * "40xxx 混段里谁占了哪号"直接看这份账，不必再 ss 全表人肉对。
   */
  recordOccupation(port, scope) {
    if (!this.state.externalOccupations) this.state.externalOccupations = {}
    const now = Date.now()
    const prev = this.state.externalOccupations[port]
    this.state.externalOccupations[port] = {
      port,
      scope, // 'public'=对外段(0.0.0.0) | 'internal'=回环段(127.0.0.1)
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      hits: (prev?.hits ?? 0) + 1,
    }
  },

  /**
   * 对外端口是否落在配置段 [docker.basePort, docker.maxPort]（含两端）。
   *
   * 段的现实含义：隧道/端口段映射部署（deploy/README 方案 B）里，frpc 与
   * 安全组按段预先开通，段外发号=给用户一个打不通的链接。三个来源
   * （回收池 / own 续用 / nextPort 新号）都必须过这道滤。
   * 值在**调用时**读取：测试收段验证即时生效。
   */
  portInRange(p) {
    const { pub } = this.tenantPortRanges()
    return Number.isInteger(p) && p >= pub.base && p <= pub.max
  },

  /**
   * 端口可绑定性探针：在指定地址挂空监听器 bind 后即放。
   * 用 bind 而非 connect：别人绑在 127.0.0.1 上的地址，connect 探测未必可见，
   * 而 bind 冲突必报 EADDRINUSE——与网关 listen（0.0.0.0）/docker -p
   * （127.0.0.1）的落点语义一致。探针到实际 bind 之间的竞态窗口由
   * finalizeTenant "绑败弃号" 与 docker 报错重试路径兜底。
   */
  probeBindable(port, host = '0.0.0.0') {
    return new Promise((resolve) => {
      const srv = createNetServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, host, () => {
        srv.close(() => resolve(true))
      })
    })
  },

  /**
   * 从 preferred 起扫描对外段 [preferred..max] → [base..preferred)，返回首个
   * **整对可用**的对外端口（双段模式下两端都探）。占用判定：
   *   自己网关在册 → 直接用（幂等复用，不探）
   *   别的在册租户 → 避让
   *   不在册但 bind 失败（外部监听：混段部署的常态）→ 记占用账，跳过
   * selfInternal：调用现场已知的**自家容器**回环映射口（exists 重建路径旧容器
   * 还没拆，探针必撞它）——跳过它但不记账，否则迁移当天每租户留一笔幽灵账。
   * 找到可用号才推进 nextPort（先占后建纪律不变）；全段无空 → PORT_RANGE_FULL。
   */
  async findFreePublicPort(preferred, address, selfInternal = null) {
    const { pub, internal } = this.tenantPortRanges()
    const start = this.portInRange(preferred) ? preferred : pub.base
    const order = []
    for (let p = start; p <= pub.max; p++) order.push(p)
    for (let p = pub.base; p < start; p++) order.push(p)
    for (const candidate of order) {
      const owner = tenantGateway.ownerOf?.(candidate) ?? null
      if (owner === address) return candidate
      if (owner) continue
      if (!(await this.probeBindable(candidate, '0.0.0.0'))) {
        this.recordOccupation(candidate, 'public')
        continue
      }
      if (internal) {
        const paired = this.internalForPublic(candidate)
        if (paired === null) {
          // 跨度不齐的尾部对外号：配不上对（启动已告警），不是"被占"，不记账
          continue
        }
        if (!(await this.probeBindable(paired, '127.0.0.1'))) {
          if (paired !== selfInternal) this.recordOccupation(paired, 'internal')
          continue
        }
      }
      if (preferred !== null && preferred !== undefined && candidate !== preferred) {
        const paired = this.internalForPublic(candidate)
        console.log(
          `[port] ${String(address).slice(0, 8)}… 候选 ${preferred} 不可用（越段/外部占用），段内改派 ${candidate}${paired ? `（配对回环 ${paired}）` : ''}`,
        )
      }
      if (candidate >= (this.state.nextPort ?? 0)) this.state.nextPort = candidate + 1
      return candidate
    }
    const err = new Error(
      internal
        ? `端口段 对外 ${pub.base}..${pub.max} / 回环 ${internal.base}..${internal.max} 内已无整对可用（外部占用见占用账本 state.externalOccupations / gateway-ports 接口）`
        : `端口段 ${pub.base}..${pub.max} 内已无可绑定端口（被外部程序占满或段太小；对照 ss -tlnp 排查）`,
    )
    err.code = 'PORT_RANGE_FULL'
    throw err
  },
}
