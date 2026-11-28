import { createRouter, createWebHistory } from 'vue-router'
import UserCenter from '../views/UserCenter.vue'
import Home from '../views/Home.vue'
import SkillMarket from '../views/SkillMarket.vue'

const routes = [
  { path: '/', component: Home },
  // v1.5 用户验收①：独立"系统管理"页去掉——管理页签已并入用户中心侧栏（活验证
  // role='admin' 才装配）。旧 /admin 直达用户中心管理总览；非管理员落到默认账户页，
  // 不泄露任何管理数据（判权在服务端 credential-status，不在路由）。
  { path: '/admin', redirect: '/user?tab=adm:overview' },
  { path: '/user', component: UserCenter },
  { path: '/user/:address', component: UserCenter, props: true },
  { path: '/skills', component: SkillMarket },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
