<template>
  <div class="mobile-page">
    <div class="page-header">
      <div class="page-title">我的</div>
    </div>
    <div class="page-body">
      <div class="placeholder">
        <div class="placeholder-icon">👤</div>
        <div class="placeholder-text">我的页面</div>
        <div class="placeholder-hint">待实现</div>
      </div>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.mobile-page {
  min-height: 100vh;
  background: #f4f5fa;
}

.page-header {
  background: #fff;
  padding: 16px;
  border-bottom: 1px solid #eceef4;
}

.page-title {
  font-size: 18px;
  font-weight: 600;
  color: #20242f;
}

.page-body {
  padding: 16px;
}

.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  background: #fff;
  border-radius: 16px;
}

.placeholder-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.placeholder-text {
  font-size: 16px;
  font-weight: 600;
  color: #20242f;
  margin-bottom: 8px;
}

.placeholder-hint {
  font-size: 14px;
  color: #8a90a3;
}
</style>
