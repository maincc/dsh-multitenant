<template>
  <div id="app">
    <nav class="navbar">
      <div class="nav-brand">
        <router-link to="/" class="brand-link" :title="$t('common.brand')">
          <h1>{{ $t('common.brand') }}</h1>
        </router-link>
      </div>
      <div class="nav-links">
        <router-link to="/skills">{{ $t('common.nav.skills') }}</router-link>
        <router-link to="/admin">{{ $t('common.nav.admin') }}</router-link>
        <router-link to="/user">{{ $t('common.nav.user') }}</router-link>
      </div>
    </nav>
    <main class="container">
      <router-view />
    </main>
  </div>
</template>

<script setup></script>

<style scoped>
.navbar {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 1rem 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}

.nav-brand h1 {
  margin: 0;
  font-size: 1.5rem;
}

.nav-brand .brand-link {
  color: white;
  text-decoration: none;
  display: inline-block;
}

.nav-brand .brand-link:hover {
  opacity: 0.85;
}

.nav-links {
  display: flex;
  gap: 1.5rem;
}

.nav-links a {
  color: white;
  text-decoration: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  transition: background 0.3s;
}

.nav-links a:hover,
.nav-links a.router-link-active {
  background: rgba(255, 255, 255, 0.2);
}

.container {
  max-width: 1200px;
  margin: 2rem auto;
  padding: 0 1rem;
}
</style>
