<template>
  <div id="app">
    <nav class="navbar">
      <div class="nav-brand">
        <router-link to="/" class="brand-link" :title="$t('common.brand')">
          <span class="brand-logo">DSH</span>
          <span class="brand-title">{{ $t('common.brand') }}</span>
        </router-link>
      </div>
      <div class="nav-links">
        <router-link to="/skills" class="nav-tab">{{ $t('common.nav.skills') }}</router-link>
        <router-link to="/admin" class="nav-tab">{{ $t('common.nav.admin') }}</router-link>
        <router-link to="/user" class="nav-tab">{{ $t('common.nav.user') }}</router-link>
      </div>
    </nav>
    <main class="page">
      <router-view />
    </main>
  </div>
</template>

<script setup></script>

<style scoped>
#app {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

/* ── NavBar（与 React 原型稿一致：h-14 渐变条 + 三 Tab） ── */
.navbar {
  height: 56px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 1.5rem;
  gap: 1rem;
  background: linear-gradient(135deg, #6c69c2 0%, #6b7bdb 100%);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
}

.nav-brand {
  margin-right: auto;
  display: flex;
  align-items: center;
}

.brand-link {
  color: white;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.brand-logo {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.35);
  color: white;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-title {
  color: white;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.nav-links {
  display: flex;
  gap: 0.125rem;
  align-items: center;
}

.nav-tab {
  color: rgba(255, 255, 255, 0.6);
  text-decoration: none;
  padding: 0.375rem 1rem;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
}

.nav-tab:hover {
  color: white;
  background: rgba(255, 255, 255, 0.1);
}

.nav-tab.router-link-exact-active,
.nav-tab.router-link-active {
  color: white;
  background: rgba(255, 255, 255, 0.2);
}

/* ── 页面背景（原型稿：bg-slate-50，无边距直接由视图控制） ── */
.page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: #f8fafc;
}

/* 三 Tab 视图自身撑满并内部滚动；Home 等长页在此容器内自然滚动 */
</style>
