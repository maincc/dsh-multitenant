import i18n from '../i18n'

/**
 * CCDAO 插件错误→用户可操作提示（i18n 版）。
 * 正身=基线 UserCenter.vue:1810-1818 本地 friendlyPluginError 原文随域迁出；
 * api/wallet.js 的同名函数是另一语义（钱包桥接错误类族，登录链消费），两版
 * 各司其职非判例 58 复制——话术/判据/键全部按 UC 基线口径。
 */
export function friendlyPluginError(err) {
  const t = (key, params) => i18n.global.t(key, params)
  const msg = err.response?.data?.error || err.message || t('user.unknownError')
  if (
    /not been authorized|unauthorized/i.test(String(err.response?.data?.error || err.message || ''))
  ) {
    return t('user.pluginNotAuthorized')
  }
  return msg
}
