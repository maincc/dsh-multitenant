import { createRouter, createWebHistory } from 'vue-router'
import AdminPanel from '../views/AdminPanel.vue'
import UserCenter from '../views/UserCenter.vue'
import Home from '../views/Home.vue'
import SkillMarket from '../views/SkillMarket.vue'

const routes = [
  { path: '/', component: Home },
  { path: '/admin', component: AdminPanel },
  { path: '/user', component: UserCenter },
  { path: '/user/:address', component: UserCenter, props: true },
  { path: '/skills', component: SkillMarket },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
