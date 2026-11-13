/**
 * T3 收敛（2026-11-10）：isMobile 此前在 App/Home/UserCenter 三份同款复制
 * （ref(window.innerWidth<=768) + updateMobile + resize 监听/清理），视口口径
 * 一旦调整就得改三处（判例 58 孪生面漂移的移动版）。收敛为模块级单例：
 * 全站共享同一个 ref 与同一个监听（首用绑定、永不解绑——app 壳生命周期=页面
 * 生命周期，无泄漏面；三份旧实现卸载时其实也都记得解绑，收敛后更无须操心）。
 */
import { ref } from 'vue'

export const MOBILE_BREAKPOINT_PX = 768

const isMobile = ref(window.innerWidth <= MOBILE_BREAKPOINT_PX)
let listenerBound = false

/** 返回全站唯一的 isMobile ref（窄屏=移动端形态） */
export function useIsMobile() {
  if (!listenerBound) {
    listenerBound = true
    window.addEventListener('resize', () => {
      isMobile.value = window.innerWidth <= MOBILE_BREAKPOINT_PX
    })
  }
  return isMobile
}
