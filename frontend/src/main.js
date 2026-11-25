import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import './assets/style.css'
import './assets/gate-skeleton.css'
import './assets/admin-shared.css'
// T2（2026-11-10）：移动设计 token 单一真源（:root 自定义属性，等值提取零视觉变化；
// 桌面不引用故不泄漏）。移动六组件的 --m-* 全部解析于此。
import './styles/mobile-tokens.css'

const app = createApp(App)
app.use(router)
app.use(i18n)
app.mount('#app')
