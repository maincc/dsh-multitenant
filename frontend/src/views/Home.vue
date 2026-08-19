<template>
  <div class="home">
    <div class="hero">
      <h1>🚀 DSH 多租户平台</h1>
      <p class="subtitle">基于 SWTC 地址的智能容器分配系统</p>
      
      <div class="features">
        <div class="feature-card">
          <div class="icon">🔐</div>
          <h3>钱包认证</h3>
          <p>通过 CCDAO 插件获取 SWTC 地址，无需注册</p>
        </div>
        <div class="feature-card">
          <div class="icon">📦</div>
          <h3>独立容器</h3>
          <p>每个用户独享 Docker 容器，数据完全隔离</p>
        </div>
        <div class="feature-card">
          <div class="icon">⚡</div>
          <h3>智能扩容</h3>
          <p>自动监控资源使用，按需动态调整配额</p>
        </div>
        <div class="feature-card">
          <div class="icon">💾</div>
          <h3>数据持久化</h3>
          <p>容器销毁后数据保留，重新连接自动恢复</p>
        </div>
      </div>

      <div class="actions">
        <router-link to="/user" class="btn btn-primary btn-large">
          🔌 连接钱包开始使用
        </router-link>
        <router-link to="/admin" class="btn btn-success btn-large">
          📊 管理面板
        </router-link>
      </div>
    </div>

    <div class="tiers">
      <h2>资源配额层级</h2>
      <div class="tier-grid">
        <div class="tier-card">
          <h3>🥉 基础配额</h3>
          <ul>
            <li>内存：512 MB</li>
            <li>CPU：1 核</li>
            <li>进程：256 个</li>
            <li>适用：普通对话</li>
          </ul>
        </div>
        <div class="tier-card featured">
          <h3>🥈 增强配额</h3>
          <ul>
            <li>内存：1 GB</li>
            <li>CPU：2 核</li>
            <li>进程：512 个</li>
            <li>适用：复杂任务</li>
          </ul>
          <span class="badge badge-info">自动扩容</span>
        </div>
        <div class="tier-card">
          <h3>🥇 高性能配额</h3>
          <ul>
            <li>内存：2 GB</li>
            <li>CPU：4 核</li>
            <li>进程：1024 个</li>
            <li>适用：大文件处理</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.hero {
  text-align: center;
  padding: 3rem 1rem;
  background: white;
  border-radius: 16px;
  margin-bottom: 2rem;
  box-shadow: 0 4px 20px rgba(0,0,0,0.08);
}

.hero h1 {
  font-size: 2.5rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 0.5rem;
}

.subtitle {
  font-size: 1.2rem;
  color: #6b7280;
  margin-bottom: 2rem;
}

.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.5rem;
  margin: 2rem 0;
  text-align: left;
}

.feature-card {
  padding: 1.5rem;
  background: #f9fafb;
  border-radius: 12px;
  transition: transform 0.3s;
}

.feature-card:hover {
  transform: translateY(-4px);
}

.feature-card .icon {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.feature-card h3 {
  font-size: 1.1rem;
  margin-bottom: 0.5rem;
  color: #374151;
}

.feature-card p {
  font-size: 0.9rem;
  color: #6b7280;
}

.actions {
  display: flex;
  gap: 1rem;
  justify-content: center;
  margin-top: 2rem;
}

.btn-large {
  padding: 0.75rem 2rem;
  font-size: 1rem;
}

.tiers {
  background: white;
  padding: 2rem;
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.08);
}

.tiers h2 {
  text-align: center;
  margin-bottom: 2rem;
  color: #667eea;
}

.tier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1.5rem;
}

.tier-card {
  padding: 1.5rem;
  background: #f9fafb;
  border-radius: 12px;
  border: 2px solid transparent;
  position: relative;
}

.tier-card.featured {
  border-color: #667eea;
  background: linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%);
}

.tier-card h3 {
  margin-bottom: 1rem;
  color: #374151;
}

.tier-card ul {
  list-style: none;
  margin-bottom: 1rem;
}

.tier-card li {
  padding: 0.5rem 0;
  border-bottom: 1px solid #e5e7eb;
  font-size: 0.9rem;
}

.tier-card li:last-child {
  border-bottom: none;
}
</style>
