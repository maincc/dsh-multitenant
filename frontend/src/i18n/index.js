/**
 * i18n 初始化
 * - 当前 locale 固定为 zh（语言切换暂不启用，en 为预留翻译骨架）
 * - legacy:false + globalInjection:true → 模板里直接用 $t()，无需逐组件注入
 */
import { createI18n } from 'vue-i18n'
import zh from './zh.js'
import en from './en.js'

export const SUPPORTED_LOCALES = ['zh', 'en']

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'zh', // 固定中文；后续启用切换时改为读取持久化选择
  fallbackLocale: 'zh',
  messages: { zh, en },
})

export default i18n
