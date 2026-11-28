import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
// T5 移动 chunk 拆分（2026-11-10）：UserCenter/SkillMarket/MobileContainer 改路由级懒加载——
// 桌面用户不再为首屏背上整个用户中心（含桌面 AdminPanel 巨型孪生），移动用户也不背 SkillMarket；
// Home 保留同步（首屏入口，异步反而多一跳白屏）。判权与装载无关，照旧全在服务端。
const UserCenter = () => import('../views/UserCenter.vue')
const SkillMarket = () => import('../views/SkillMarket.vue')
const MobileContainer = () => import('../views/mobile/MobileContainer.vue')

const routes = [
  { path: '/', component: Home },
  // v1.5 用户验收①：独立"系统管理"页去掉——管理页签已并入用户中心侧栏（活验证
  // role='admin' 才装配）。旧 /admin 直达用户中心管理总览；非管理员落到默认账户页，
  // 不泄露任何管理数据（判权在服务端 credential-status，不在路由）。
  { path: '/admin', redirect: '/user?tab=adm:overview' },
  { path: '/user', component: UserCenter },
  { path: '/user/:address', component: UserCenter, props: true },
  { path: '/skills', component: SkillMarket },
  { path: '/mobile/container', component: MobileContainer },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
