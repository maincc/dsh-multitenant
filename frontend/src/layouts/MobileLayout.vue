<template>
  <div class="mobile-layout">
    <div class="mobile-content">
      <router-view />
    </div>
    
    <nav class="mobile-tabbar">
      <router-link 
        v-for="tab in visibleTabs" 
        :key="tab.path" 
        :to="tab.path"
        class="tab-item"
        :class="{ active: currentPath === tab.path }"
      >
        <div class="tab-icon" v-html="tab.icon"></div>
        <div class="tab-label">{{ tab.label }}</div>
      </router-link>
    </nav>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const currentPath = computed(() => route.path)

// 根据用户角色动态显示 Tab
const visibleTabs = computed(() => {
  const tabs = [
    { path: '/mobile/home', label: '首页', icon: '🏠' },
    { path: '/mobile/container', label: '容器', icon: '📦' },
    { path: '/mobile/skills', label: '技能', icon: '🎯' },
    { path: '/mobile/approvals', label: '审批', icon: '✅' },
    { path: '/mobile/me', label: '我的', icon: '👤' },
  ]
  
  // TODO: 根据用户角色添加管理员 Tab
  // if (isAdmin) tabs.push(...)
  
  return tabs
})
</script>

<style scoped>
.mobile-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f4f5fa;
}

.mobile-content {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.mobile-tabbar {
  display: flex;
  background: #fff;
  border-top: 1px solid #eceef4;
  padding: 8px 0 calc(8px + env(safe-area-inset-bottom));
  box-shadow: 0 -2px 8px rgba(0,0,0,0.05);
}

.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  text-decoration: none;
  color: #8a90a3;
  transition: color 0.2s;
}

.tab-item.active {
  color: #6a72e8;
}

.tab-icon {
  font-size: 24px;
}

.tab-label {
  font-size: 12px;
  font-weight: 500;
}
</style>
