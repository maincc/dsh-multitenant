import { ref } from 'vue'
import axios from 'axios'
import i18n from '../i18n'
import { toast, askConfirm } from './useDialog'

/**
 * 容器运维域单例（P3 UC 第三刀）：自动开机/重启/重启DSH/重置/停止 + 开机遮罩。
 * autoBootContainer 由壳 fetchUserInfo 进页即检调用（解构同名，判例 58）；
 * 深链 initialSub 经组件 props。宿主注入：ensureContainer（connect 域开通编排
 * 主权在壳）、showLoading/hideLoading（全局进度罩）、currentAddress/userInfo/
 * fetchUserInfo。enterDsh 经 host 透传给组件模板按钮。
 */
const t = (key, params) => i18n.global.t(key, params)

let host = {
  ensureContainer: async () => {},
  showLoading: () => {},
  hideLoading: () => {},
  currentAddress: () => '',
  userInfo: { value: {} },
  fetchUserInfo: async () => {},
  enterDsh: async () => {},
}
export function bindUserContainerHost(h) {
  host = { ...host, ...h }
}

const containerBooting = ref(false)

const bootNotice = (msg) => {
  askConfirm({ message: msg }).then((ok) => {
    if (ok) activeTab.value = 'container'
  })
}

const autoBootContainer = async (data) => {
  const address = data?.address || host.currentAddress()
  if (!address || autoBootFor === address) return
  autoBootFor = address
  const st = data?.status
  if (st === 'running') {
    bootNotice(t('user.bootAlreadyRunning'))
    return
  }
  // 只拉"登过账的停机户"：stopped（纯 session 静默启动）与 destroyed（需一次
  // 归属签名重建）；none 未建档/waiting 已在排队页/未知态都不自动造轮子
  if (st !== 'stopped' && st !== 'destroyed') return
  containerBooting.value = true
  try {
    if (st === 'stopped') {
      await axios.post(`/api/user/${address}/restart`)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    } else {
      const r = await host.ensureContainer(address, { quiet: true })
      if (r === 'waiting') return // 排队页由状态机挂出——页面本身即告知
      if (r === 'usage-limit') {
        bootNotice(lastConnect202Message || t('user.bootUsageLimit'))
        return
      }
    }
    await host.fetchUserInfo(address)
    bootNotice(t('user.bootDoneNotice'))
  } catch (err) {
    bootNotice(t('user.bootFailNotice', { err: err?.message || String(err) }))
  } finally {
    containerBooting.value = false
  }
}

const restartContainer = async () => {
  // 后台自动拉起进行中：按钮已置灰，这里再挡一层（快捷键/其他路径直触）
  if (containerBooting.value) return
  const address = host.userInfo.value.address || host.currentAddress()
  if (!address) {
    toast(t('user.errConnectFirst'))
    return
  }
  try {
    host.showLoading(t('user.loadingStarting'), t('user.loadingPleaseWait'), 40)
    // ★v1.5 反馈②：进页面不再建容器，此按钮成为建/启容器的唯一自动入口——
    // 走 ensureContainer 全状态机（不存在→创建、停止→启动、排队→排队页、额度尽→提示），
    // 旧实现直连 /connect 不看 202 的坑也一并消掉（202 在状态机内转成排队/usage-limit）。
    const st = await host.ensureContainer(address)
    host.hideLoading()
    if (st === 'waiting') return // 排队页已由状态机挂出（waiting.value）
    if (st === 'usage-limit') {
      toast(lastConnect202Message || t('user.usageLimitReached'))
      return
    }
    await host.fetchUserInfo(address)
    toast(t('user.startedOk'))
  } catch (err) {
    host.hideLoading()
    toast(t('user.startFail', { err: err.message }))
  }
}

const restartDSH = async () => {
  await askConfirm({
    message: t('user.confirmRestartDsh'),
    run: async () => {
      try {
        const address = host.userInfo.value.address
        host.showLoading(t('user.loadingRestarting'), t('user.loadingPleaseWait'), 50)

        const res = await axios.post(`/api/user/${address}/restart`)

        // 等待容器完全就绪
        await new Promise((resolve) => setTimeout(resolve, 5000))

        await host.fetchUserInfo(address)
        host.hideLoading()
        toast(t('user.restartedOk'))
      } catch (err) {
        host.hideLoading()
        toast(t('user.restartFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

const resetContainer = async () => {
  if (!(await askConfirm(t('user.confirmResetContainer')))) return

  await askConfirm({
    message: t('user.confirmResetContainer2'),
    danger: true,
    run: async () => {
      const address = host.userInfo.value.address
      host.showLoading(t('user.loadingResetting'), t('user.loadingDeleteRebuild'), 50)
      try {
        // 后端在同一个请求里完成「清空旧容器/数据 → 重建全新容器 → 签发会话」，
        // 返回新容器 url，前端直接打开即可（无需手动重新连接）
        const res = await axios.post(`/api/user/${address}/reset`)

        host.hideLoading()
        const { url } = res.data
        if (url) window.open(url, '_blank', 'noopener')
        toast(t('user.resetContainerOk'))
      } catch (err) {
        host.hideLoading()
        toast(t('user.resetContainerFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

const stopContainer = async () => {
  await askConfirm({
    message: t('user.confirmStopContainer'),
    run: async () => {
      try {
        const address = host.userInfo.value.address
        host.showLoading(t('user.loadingStopping'), t('user.loadingSettleStop'), 50)

        await axios.post(`/api/user/${address}/stop`)

        await host.fetchUserInfo(address)
        host.hideLoading()
        toast(t('user.stoppedOk'))
      } catch (err) {
        host.hideLoading()
        toast(t('user.stopFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

export function useUserContainer() {
  return {
    containerBooting,
    bootNotice,
    autoBootContainer,
    restartContainer,
    restartDSH,
    resetContainer,
    stopContainer,
    enterDsh: (...a) => host.enterDsh(...a),
  }
}
