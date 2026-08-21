<template>
  <div class="user-center">
    <!-- 加载页面 -->
    <div v-if="loading" class="card loading-card">
      <div class="loading-spinner">
        <div class="spinner"></div>
      </div>
      <h2>{{ loadingTitle }}</h2>
      <p class="loading-message">{{ loadingMessage }}</p>
      <div class="loading-progress">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: loadingProgress + '%' }"></div>
        </div>
        <span class="progress-text">{{ loadingProgress }}%</span>
      </div>
    </div>

    <!-- 连接钱包页面 -->
    <div v-else-if="!connected" class="card connect-card">
      <h2>🔌 连接钱包</h2>
      <p>通过 CCDAO 插件连接您的 SWTC 钱包，自动分配专属 DSH 容器</p>

      <div v-if="!hasCCDAO" class="error">
        ❌ 未检测到 CCDAO 插件
        <br />
        <a
          href="https://chromewebstore.google.com/detail/ccdao-connector/fpondiojcgaollhcmjgpjmldjjkealjb"
          target="_blank"
        >
          点击安装 CCDAO Connector
        </a>
      </div>

      <button v-else class="btn btn-primary btn-large" @click="connectWallet">
        连接 CCDAO 钱包
      </button>
    </div>

    <!-- 等待队列页面 -->
    <div v-else-if="waiting" class="card waiting-card">
      <div class="waiting-icon">⏳</div>
      <h2>资源不足，请等待</h2>
      <p class="waiting-message">系统资源不足，您已进入等待队列</p>
      <p class="waiting-message">资源释放后将自动为您创建容器</p>

      <div class="queue-info">
        <div class="queue-item">
          <span class="queue-label">排队位置：</span>
          <span class="queue-value">第 {{ queuePosition }} 位</span>
        </div>
        <div class="queue-item">
          <span class="queue-label">队列总人数：</span>
          <span class="queue-value">{{ queueTotal }} 人</span>
        </div>
        <div class="queue-item">
          <span class="queue-label">等待时间：</span>
          <span class="queue-value">{{ waitingTime }}</span>
        </div>
      </div>

      <div class="waiting-progress">
        <div class="spinner"></div>
        <span>系统正在清理闲置资源，请稍候...</span>
      </div>

      <button class="btn btn-secondary" @click="cancelWaiting">取消等待</button>
    </div>

    <!-- 用户信息页面 -->
    <div v-else class="user-dashboard">
      <div class="card">
        <h2>👤 我的账户</h2>
        <div class="user-info">
          <div class="info-row">
            <span class="label">SWTC 地址：</span>
            <span class="address">{{ userInfo.address }}</span>
            <button class="btn btn-small" @click="switchAddress">切换地址</button>
          </div>
          <div class="info-row">
            <span class="label">专属端口：</span>
            <span>{{ userInfo.port }}</span>
          </div>
          <div class="info-row">
            <span class="label">当前配额：</span>
            <span class="badge" :class="tierBadge(userInfo.tier)">{{ userInfo.tierLabel }}</span>
          </div>
          <div class="info-row">
            <span class="label">容器状态：</span>
            <span class="badge" :class="statusBadge(userInfo.status)">{{
              statusText(userInfo.status)
            }}</span>
            <button
              v-if="userInfo.status !== 'running'"
              class="btn btn-small btn-success"
              @click="restartContainer"
            >
              启动容器
            </button>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>📊 资源使用</h2>
        <div v-if="userInfo.stats" class="resource-usage">
          <div class="resource-item">
            <div class="resource-header">
              <span>CPU 使用率</span>
              <span>{{ userInfo.stats.cpu }}</span>
            </div>
          </div>
          <div class="resource-item">
            <div class="resource-header">
              <span>内存使用</span>
              <span>{{ userInfo.stats.memory }} ({{ userInfo.stats.memoryPercent }})</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: userInfo.stats.memoryPercent }"></div>
            </div>
          </div>
        </div>
        <div v-else class="loading">暂无数据</div>
      </div>

      <div class="card">
        <h2>🚀 进入 DSH</h2>
        <p>点击下方按钮进入您的专属 DSH 实例</p>
        <a :href="dshWebUrl" target="_blank" class="btn btn-success btn-large"> 打开 DSH Web UI </a>
      </div>

      <div class="card">
        <h2>🔑 我的模型密钥</h2>
        <p>配置您的 API Key（需 CCDAO 插件签名验证身份），之后局域网直连即可使用</p>
        <div class="key-config">
          <div class="key-status" :class="{ ok: keyConfigured }">
            状态：{{ keyConfigured ? '✅ 已配置' : '未配置' }}
          </div>
          <input
            v-model="apiKeyInput"
            type="password"
            placeholder="输入您的 API Key（如 DeepSeek sk-xxx）"
            :disabled="!connected || keySaving"
          />
          <div class="action-buttons">
            <button
              class="btn btn-primary"
              :disabled="!connected || keySaving || !apiKeyInput"
              @click="saveApiKey"
            >
              {{ keySaving ? '保存中…' : '💾 保存密钥' }}
            </button>
            <button
              class="btn btn-danger"
              :disabled="!connected || keySaving || !keyConfigured"
              @click="clearApiKey"
            >
              清除密钥
            </button>
          </div>
          <div class="action-hints">
            <div class="hint">
              <strong>保存：</strong>CCDAO
              插件会弹出签名确认，证明该地址归您所有，密钥只写入您自己的容器
            </div>
            <div class="hint"><strong>清除：</strong>同样需要钱包签名确认</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>⚙️ 容器管理</h2>
        <p>管理您的 DSH 容器</p>
        <div class="action-buttons">
          <button class="btn btn-primary" @click="restartDSH">🔄 重启 DSH 服务</button>
          <button class="btn btn-danger" @click="resetContainer">🗑️ 重置容器（删除数据）</button>
        </div>
        <div class="action-hints">
          <div class="hint">
            <strong>重启 DSH 服务：</strong>安装插件后需要重启 DSH 服务才能生效
          </div>
          <div class="hint">
            <strong>重置容器：</strong>删除所有数据和配置，重新开始（不可恢复）
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import axios from 'axios'

const connected = ref(false)
const connecting = ref(false)
const hasCCDAO = ref(false)
const userInfo = ref({})
const waiting = ref(false)
const queuePosition = ref(0)
const queueTotal = ref(0)
const waitingSince = ref(0)

// 专属 DSH 实例地址：用用户当前访问入口页的 host 拼端口，
// 保证内网/公网/域名部署下跳转目标正确（不再硬编码 127.0.0.1）
const dshWebUrl = computed(() => {
  if (!userInfo.value.port) return ''
  return `http://${window.location.hostname}:${userInfo.value.port}/`
})

// ---- 我的模型密钥（钱包签名验证身份后写入自己的租户卷）----
const keyConfigured = ref(false)
const apiKeyInput = ref('')
const keySaving = ref(false)

const currentAddress = () => userInfo.value.address || localStorage.getItem('swtc_address')

const fetchKeyStatus = async () => {
  const address = currentAddress()
  if (!address) return
  try {
    const res = await axios.get(`/api/user/tenant-config?address=${encodeURIComponent(address)}`)
    keyConfigured.value = !!res.data.configured
  } catch {
    keyConfigured.value = false
  }
}

/**
 * 钱包签名挑战-响应：先取插件当前账户 → 领 nonce → 插件签名 + 取公钥。
 *
 * 关键：签名对象必须用插件【当前选中的账户】，否则插件会以
 * "The requested account and/or method has not been authorized" 拒绝
 * （源码：swtc_signMessage 检查 accounts.includes(from)）。
 * 返回的 address 即插件当前账户，后续提交/清除都用它（写的是该账户自己的卷）。
 */
const signChallenge = async () => {
  if (!window.ccdao || !window.ccdao.request) {
    throw new Error('未检测到 CCDAO 插件，请先安装并连接钱包')
  }
  // 1. 插件当前账户【保留原始大小写】！
  //    插件的 accounts.includes() 是大小写敏感严格匹配：把 jNDwRet... 转成
  //    jndwret... 再传回去会被判"未授权"(4100)。只有 requestAccounts 原样
  //    返回的字符串才能通过。后端 normalizeAddress 会自己转小写，无需担心。
  const accounts = await window.ccdao.request({
    method: 'swtc_requestAccounts',
    params: [],
  })
  const pluginAddress = accounts?.[0]
  if (!pluginAddress) {
    throw new Error('未获取到钱包账户，请确认 CCDAO 插件已解锁并授权本网站')
  }
  // 2. 领一次性挑战
  const challengeRes = await axios.post('/api/user/config-challenge', { address: pluginAddress })
  const nonce = challengeRes.data.nonce
  // 3. 插件对 nonce 签名 + 取公钥（都用原始大小写地址）
  const signature = await window.ccdao.request({
    method: 'swtc_signMessage',
    params: [pluginAddress, nonce],
  })
  const publicKey = await window.ccdao.request({
    method: 'swtc_getPublicKey',
    params: [pluginAddress],
  })
  return { address: pluginAddress, nonce, signature, publicKey }
}

/** 保存/清除成功后，把插件当前账户同步到页面与 localStorage */
const syncWalletAccount = async (address) => {
  const normalized = String(address).toLowerCase()
  localStorage.setItem('swtc_address', normalized)
  if (userInfo.value.address !== normalized) {
    userInfo.value = { ...userInfo.value, address: normalized }
    await fetchUserInfo(normalized)
  }
  fetchKeyStatus()
}

/**
 * 把 CCDAO 插件的未授权错误转成可操作的提示。
 * 插件对每个网站（origin）单独授权，且 swtc_signMessage 不会自动触发授权
 * （源码确认：signMessage 直接验签，无授权/解锁流程）。
 */
const friendlyPluginError = (err) => {
  const msg = err.response?.data?.error || err.message || '未知错误'
  if (/not been authorized|unauthorized/i.test(String(msg))) {
    return (
      'CCDAO 插件尚未授权本网站：请先点击浏览器上的 CCDAO 插件图标解锁钱包，' +
      '再点击本页"连接钱包"完成授权（会弹出授权确认框），然后重试'
    )
  }
  return msg
}

const saveApiKey = async () => {
  if (!currentAddress()) return alert('请先连接钱包')
  keySaving.value = true
  try {
    const { address, nonce, signature, publicKey } = await signChallenge()
    await axios.post('/api/user/tenant-config', {
      address,
      nonce,
      signature,
      publicKey,
      apiKey: apiKeyInput.value.trim(),
    })
    apiKeyInput.value = ''
    keyConfigured.value = true
    await syncWalletAccount(address)
    alert('✅ API Key 已保存并热加载，可以直接开始聊天了')
  } catch (err) {
    alert('保存失败：' + friendlyPluginError(err))
  } finally {
    keySaving.value = false
  }
}

const clearApiKey = async () => {
  if (!currentAddress()) return alert('请先连接钱包')
  if (!confirm('确认清除您的 API Key？')) return
  keySaving.value = true
  try {
    const { address, nonce, signature, publicKey } = await signChallenge()
    await axios.delete('/api/user/tenant-config', {
      data: { address, nonce, signature, publicKey },
    })
    keyConfigured.value = false
    await syncWalletAccount(address)
    alert('✅ API Key 已清除')
  } catch (err) {
    alert('清除失败：' + friendlyPluginError(err))
  } finally {
    keySaving.value = false
  }
}

// 加载状态
const loading = ref(false)
const loadingTitle = ref('')
const loadingMessage = ref('')
const loadingProgress = ref(0)

// 等待时间计算
const waitingTime = computed(() => {
  if (!waitingSince.value) return '0 秒'
  const ms = Date.now() - waitingSince.value
  if (ms < 60000) return `${Math.floor(ms / 1000)} 秒`
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟`
  return `${(ms / 3600000).toFixed(1)} 小时`
})

const showLoading = (title, message, progress = 0) => {
  loading.value = true
  loadingTitle.value = title
  loadingMessage.value = message
  loadingProgress.value = progress
}

const hideLoading = () => {
  loading.value = false
}

const checkCCDAO = () => {
  hasCCDAO.value = typeof window.ccdao !== 'undefined'
}

// 监听账户变化事件
const setupAccountChangeListener = () => {
  if (!hasCCDAO.value) {
    console.log('[UserCenter] CCDAO 插件未安装')
    return
  }

  console.log('[UserCenter] 设置账户监听器...')
  console.log('[UserCenter] window.ethereum:', typeof window.ethereum)
  console.log('[UserCenter] window.ccdao:', typeof window.ccdao)

  // 尝试多种方式监听账户变化
  let eventEmitter = null

  // 方式 1: window.ethereum.on (MetaMask 风格)
  if (window.ethereum && window.ethereum.on) {
    console.log('[UserCenter] 使用 window.ethereum.on')
    eventEmitter = window.ethereum
  }
  // 方式 2: window.ccdao.on (CCDAO 风格)
  else if (window.ccdao && window.ccdao.on) {
    console.log('[UserCenter] 使用 window.ccdao.on')
    eventEmitter = window.ccdao
  }
  // 方式 3: 轮询检查（备用方案）
  else {
    console.log('[UserCenter] 未找到事件监听器，使用轮询检查')
    let lastAddress = localStorage.getItem('swtc_address')
    setInterval(async () => {
      try {
        if (window.ccdao && window.ccdao.request) {
          const accounts = await window.ccdao.request({
            method: 'swtc_requestAccounts',
            params: [],
          })
          const currentAddress = accounts?.[0]?.toLowerCase()
          if (currentAddress && currentAddress !== lastAddress) {
            console.log(`[UserCenter] 轮询检测到地址变化：${lastAddress} -> ${currentAddress}`)
            lastAddress = currentAddress
            await handleAddressChange(currentAddress)
          }
        }
      } catch (err) {
        // 忽略错误
      }
    }, 3000) // 每 3 秒检查一次
    return
  }

  // 注册事件监听器
  if (eventEmitter) {
    eventEmitter.on('swtcAccountsChanged', async (accounts) => {
      console.log('[UserCenter] 检测到账户变化:', accounts)

      if (!accounts || accounts.length === 0) {
        // 用户断开连接
        localStorage.removeItem('swtc_address')
        connected.value = false
        userInfo.value = {}
        alert('钱包已断开连接')
        return
      }

      const newAddress = accounts[0].toLowerCase()
      await handleAddressChange(newAddress)
    })
  }
}

// 处理地址变化的通用函数
const handleAddressChange = async (newAddress, isInitialLoad = false) => {
  const oldAddress = localStorage.getItem('swtc_address')

  if (isInitialLoad) {
    console.log('[UserCenter] 初始加载，恢复地址:', newAddress)
  } else if (newAddress !== oldAddress) {
    console.log(`[UserCenter] 地址切换：${oldAddress} -> ${newAddress}`)
  } else {
    console.log('[UserCenter] 地址相同，但仍需检查容器状态')
  }

  try {
    // 显示加载页面
    showLoading('正在连接钱包', '验证地址...', 10)

    // 关键：无论地址是否变化，都要确保容器存在并运行
    const containerStatus = await ensureContainer(newAddress)

    // 如果在等待队列中，不继续加载用户信息
    if (containerStatus === 'waiting') {
      hideLoading()
      // 保存地址
      localStorage.setItem('swtc_address', newAddress)
      return
    }

    // 更新加载状态
    showLoading(
      '正在创建容器',
      containerStatus === 'created' ? '首次创建，需要等待容器启动...' : '容器已存在，正在启动...',
      50,
    )

    // 保存地址（即使是相同的地址也要保存，确保格式正确）
    localStorage.setItem('swtc_address', newAddress)

    // 获取用户信息
    showLoading('正在获取用户信息', '加载账户数据...', 80)
    await fetchUserInfo(newAddress)

    // 关键：设置 connected 为 true，否则页面不显示用户信息
    if (userInfo.value.address) {
      connected.value = true
      console.log('[UserCenter] 已设置 connected = true')
      hideLoading()
    } else {
      console.error('[UserCenter] userInfo.value.address 为空，无法设置 connected')
      hideLoading()
    }

    // 只在地址真正变化时才显示提示
    if (!isInitialLoad && newAddress !== oldAddress) {
      alert(`已切换到新地址：${newAddress.slice(0, 10)}...`)
    }
  } catch (err) {
    console.error('[UserCenter] 处理地址失败:', err)
    hideLoading()
    if (!isInitialLoad) {
      alert('处理地址失败：' + err.message)
    }
  }
}

const connectWallet = async () => {
  if (!hasCCDAO.value) return

  connecting.value = true
  try {
    const accounts = await window.ccdao.request({
      method: 'swtc_requestAccounts',
      params: [],
    })

    if (!accounts || accounts.length === 0) {
      throw new Error('未获取到账户')
    }

    // 统一转小写
    const address = accounts[0].toLowerCase()
    console.log('[UserCenter] 连接钱包，地址:', address)

    // 使用通用处理函数
    await handleAddressChange(address)
  } catch (err) {
    console.error('[UserCenter] 连接失败:', err)
    alert('连接失败：' + err.message)
  } finally {
    connecting.value = false
  }
}

const ensureContainer = async (address) => {
  // 先检查容器状态
  try {
    const statusRes = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)

    // 如果在等待队列中
    if (statusRes.data.status === 'waiting') {
      waiting.value = true
      queuePosition.value = statusRes.data.queuePosition
      queueTotal.value = statusRes.data.queueTotal
      waitingSince.value = statusRes.data.waitingSince
      // 开始轮询队列状态
      startQueuePolling(address)
      return 'waiting'
    }

    // 如果容器不存在或已销毁，创建新容器
    if (!statusRes.data.exists || statusRes.data.status === 'destroyed') {
      console.log('[UserCenter] 容器不存在，正在创建...')
      const connectRes = await fetch(`/connect?address=${encodeURIComponent(address)}`, {
        redirect: 'manual',
      })

      // 检查是否返回 202（资源不足，进入队列）
      if (connectRes.status === 202) {
        const data = await connectRes.json()
        waiting.value = true
        queuePosition.value = data.queuePosition
        queueTotal.value = 1 // 初始值，后续轮询会更新
        waitingSince.value = Date.now()
        startQueuePolling(address)
        return 'waiting'
      }

      // 等待容器就绪
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return 'created'
    }
    // 如果容器已停止，启动它
    else if (statusRes.data.status === 'stopped') {
      console.log('[UserCenter] 容器已停止，正在启动...')
      await fetch(`/connect?address=${encodeURIComponent(address)}`, {
        redirect: 'manual',
      })
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return 'started'
    }
    // 容器正在运行，无需操作
    else {
      console.log('[UserCenter] 容器正在运行')
      return 'running'
    }
  } catch (err) {
    console.error('[UserCenter] 检查容器状态失败:', err)
    // 如果检查失败，尝试直接创建容器
    const connectRes = await fetch(`/connect?address=${encodeURIComponent(address)}`, {
      redirect: 'manual',
    })

    // 检查是否返回 202（资源不足，进入队列）
    if (connectRes.status === 202) {
      const data = await connectRes.json()
      waiting.value = true
      queuePosition.value = data.queuePosition
      queueTotal.value = 1
      waitingSince.value = Date.now()
      startQueuePolling(address)
      return 'waiting'
    }

    await new Promise((resolve) => setTimeout(resolve, 3000))
    return 'created'
  }
}

// 轮询队列状态
let queuePollingTimer = null
const startQueuePolling = (address) => {
  // 清除之前的轮询
  if (queuePollingTimer) {
    clearInterval(queuePollingTimer)
  }

  // 每 5 秒检查一次队列状态
  queuePollingTimer = setInterval(async () => {
    try {
      const statusRes = await axios.get(`/connect-status?address=${encodeURIComponent(address)}`)

      // 如果容器已创建成功
      if (statusRes.data.exists) {
        waiting.value = false
        if (queuePollingTimer) {
          clearInterval(queuePollingTimer)
          queuePollingTimer = null
        }
        // 重新加载用户信息
        await fetchUserInfo(address)
        connected.value = true
        return
      }

      // 更新队列信息
      if (statusRes.data.status === 'waiting') {
        queuePosition.value = statusRes.data.queuePosition
        queueTotal.value = statusRes.data.queueTotal
      }
    } catch (err) {
      console.error('[UserCenter] 轮询队列状态失败:', err)
    }
  }, 5000)
}

// 取消等待
const cancelWaiting = () => {
  waiting.value = false
  if (queuePollingTimer) {
    clearInterval(queuePollingTimer)
    queuePollingTimer = null
  }
  connected.value = false
  userInfo.value = {}
}

const fetchUserInfo = async (address) => {
  try {
    const res = await axios.get(`/api/user/${address}`)
    userInfo.value = res.data
    fetchKeyStatus()
  } catch (err) {
    console.error('获取用户信息失败:', err)

    // 如果是 400 错误，说明地址无效，清除 localStorage
    if (err.response?.status === 400) {
      console.warn('[UserCenter] 地址无效，清除 localStorage')
      localStorage.removeItem('swtc_address')
      connected.value = false
      userInfo.value = {}
      alert('保存的地址无效，请重新连接钱包')
      return
    }

    // 如果获取失败，可能是容器刚创建，重试一次
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      const res = await axios.get(`/api/user/${address}`)
      userInfo.value = res.data
    } catch (err2) {
      console.error('重试获取用户信息失败:', err2)
    }
  }
}

const switchAddress = async () => {
  if (!hasCCDAO.value) {
    alert('请先安装 CCDAO 插件')
    return
  }

  try {
    const accounts = await window.ccdao.request({
      method: 'swtc_requestAccounts',
      params: [],
    })

    if (!accounts || accounts.length === 0) {
      throw new Error('未获取到账户')
    }

    // 统一转小写
    const newAddress = accounts[0].toLowerCase()
    console.log('[UserCenter] 切换地址:', newAddress)

    // 使用通用处理函数
    await handleAddressChange(newAddress)
  } catch (err) {
    console.error('[UserCenter] 切换失败:', err)
    alert('切换失败：' + err.message)
  }
}

const restartContainer = async () => {
  try {
    const address = userInfo.value.address
    showLoading('正在启动容器', '请稍候...', 50)

    await fetch(`/connect?address=${encodeURIComponent(address)}`, {
      redirect: 'manual',
    })

    // 等待容器完全就绪
    await new Promise((resolve) => setTimeout(resolve, 5000))

    await fetchUserInfo(address)
    hideLoading()
    alert('容器已启动')
  } catch (err) {
    hideLoading()
    alert('启动失败：' + err.message)
  }
}

const restartDSH = async () => {
  if (!confirm('确定要重启 DSH 服务吗？\n\n安装插件后需要重启才能生效。\n重启期间服务暂时不可用。'))
    return

  try {
    const address = userInfo.value.address
    showLoading('正在重启 DSH 服务', '请稍候...', 50)

    const res = await axios.post(`/api/user/${address}/restart`)

    // 等待容器完全就绪
    await new Promise((resolve) => setTimeout(resolve, 5000))

    await fetchUserInfo(address)
    hideLoading()
    alert('DSH 服务已重启')
  } catch (err) {
    hideLoading()
    alert('重启失败：' + (err.response?.data?.error || err.message))
  }
}

const resetContainer = async () => {
  if (
    !confirm(
      '️ 警告：此操作将删除所有数据！\n\n确定要重置容器吗？\n- 删除所有 DSH 配置\n- 删除所有插件\n- 删除所有会话数据\n- 此操作不可恢复！',
    )
  )
    return

  if (!confirm('再次确认：您确定要放弃所有数据重新开始吗？')) return

  try {
    const address = userInfo.value.address
    showLoading('正在重置容器', '删除数据和重建容器...', 50)

    const res = await axios.post(`/api/user/${address}/reset`)

    // 重置后需要重新创建容器
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // 重新连接
    await handleAddressChange(address)

    hideLoading()
    alert('容器已重置，正在重新创建...')
  } catch (err) {
    hideLoading()
    alert('重置失败：' + (err.response?.data?.error || err.message))
  }
}

const tierBadge = (tier) => {
  const map = { 1: 'badge-info', 2: 'badge-warning', 3: 'badge-success' }
  return map[tier] || 'badge-info'
}

const statusBadge = (status) => {
  const map = { running: 'badge-success', stopped: 'badge-warning', destroyed: 'badge-danger' }
  return map[status] || 'badge-info'
}

const statusText = (status) => {
  const map = { running: '运行中', stopped: '已停止', destroyed: '已销毁' }
  return map[status] || status
}

onMounted(async () => {
  checkCCDAO()

  // 设置账户变化监听器
  if (hasCCDAO.value) {
    setupAccountChangeListener()
  }

  // 优先从 CCDAO 插件获取当前地址，而不是 localStorage
  if (hasCCDAO.value && window.ccdao && window.ccdao.request) {
    try {
      const accounts = await window.ccdao.request({
        method: 'swtc_requestAccounts',
        params: [],
      })

      if (accounts && accounts.length > 0) {
        const currentAddress = accounts[0].toLowerCase()
        console.log('[UserCenter] 从 CCDAO 获取当前地址:', currentAddress)

        // 清除 localStorage 中的旧地址（如果有）
        const savedAddress = localStorage.getItem('swtc_address')
        if (savedAddress && savedAddress !== currentAddress) {
          console.log(`[UserCenter] 清除旧地址：${savedAddress} -> ${currentAddress}`)
          localStorage.removeItem('swtc_address')
        }

        // 使用当前地址
        await handleAddressChange(currentAddress, true)
      } else {
        // 没有账户，检查 localStorage
        const savedAddress = localStorage.getItem('swtc_address')
        if (savedAddress) {
          console.log('[UserCenter] CCDAO 无账户，使用 localStorage:', savedAddress)
          await handleAddressChange(savedAddress, true)
        }
      }
    } catch (err) {
      console.error('[UserCenter] 获取 CCDAO 账户失败:', err)

      // 降级：使用 localStorage
      const savedAddress = localStorage.getItem('swtc_address')
      if (savedAddress) {
        console.log('[UserCenter] 降级使用 localStorage:', savedAddress)
        await handleAddressChange(savedAddress, true)
      }
    }
  } else {
    // 没有 CCDAO，使用 localStorage
    const savedAddress = localStorage.getItem('swtc_address')
    if (savedAddress) {
      console.log('[UserCenter] 无 CCDAO，使用 localStorage:', savedAddress)
      await handleAddressChange(savedAddress, true)
    }
  }
})
</script>

<style scoped>
.user-center {
  animation: fadeIn 0.3s;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.loading-card {
  text-align: center;
  padding: 3rem;
}

.loading-spinner {
  margin-bottom: 2rem;
}

.spinner {
  width: 60px;
  height: 60px;
  border: 6px solid #f3f4f6;
  border-top: 6px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.loading-card h2 {
  font-size: 1.8rem;
  margin-bottom: 1rem;
  color: #374151;
}

.loading-message {
  color: #6b7280;
  margin-bottom: 2rem;
}

.loading-progress {
  max-width: 400px;
  margin: 0 auto;
}

.progress-bar {
  width: 100%;
  height: 8px;
  background: #f3f4f6;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 0.9rem;
  color: #6b7280;
}

.connect-card {
  text-align: center;
  padding: 3rem;
}

.connect-card h2 {
  font-size: 1.8rem;
  margin-bottom: 1rem;
}

.connect-card p {
  color: #6b7280;
  margin-bottom: 2rem;
}

.btn-large {
  padding: 0.75rem 2rem;
  font-size: 1.1rem;
}

.btn-small {
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

.user-info {
  display: grid;
  gap: 1rem;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.info-row .label {
  font-weight: 600;
  color: #374151;
  min-width: 100px;
}

.info-row .address {
  font-family: monospace;
  background: #f3f4f6;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  word-break: break-all;
}

.resource-usage {
  display: grid;
  gap: 1.5rem;
}

.resource-item {
  padding: 1rem;
  background: #f9fafb;
  border-radius: 8px;
}

.resource-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
  font-weight: 500;
}

.tier-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-top: 1rem;
}

.tier-option {
  padding: 1.5rem;
  background: #f9fafb;
  border-radius: 12px;
  border: 2px solid transparent;
  text-align: center;
}

.tier-option.current {
  border-color: #667eea;
  background: linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%);
}

.tier-option h4 {
  margin-bottom: 1rem;
  color: #374151;
}

.tier-option ul {
  list-style: none;
  margin-bottom: 1rem;
  text-align: left;
}

.tier-option li {
  padding: 0.25rem 0;
  font-size: 0.9rem;
  color: #6b7280;
}

/* 等待队列样式 */
.waiting-card {
  text-align: center;
  padding: 3rem;
  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
  border: 2px solid #f59e0b;
}

.waiting-icon {
  font-size: 4rem;
  margin-bottom: 1rem;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.1);
  }
}

.waiting-card h2 {
  font-size: 1.8rem;
  margin-bottom: 1rem;
  color: #92400e;
}

.waiting-message {
  color: #78350f;
  margin-bottom: 0.5rem;
  font-size: 1rem;
}

.queue-info {
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
  margin: 2rem 0;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.queue-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
  border-bottom: 1px solid #f3f4f6;
}

.queue-item:last-child {
  border-bottom: none;
}

.queue-label {
  color: #6b7280;
  font-size: 0.9rem;
}

.queue-value {
  color: #1f2937;
  font-weight: 600;
  font-size: 1.1rem;
}

.waiting-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin: 2rem 0;
  color: #92400e;
}

.waiting-progress .spinner {
  width: 30px;
  height: 30px;
  border: 4px solid #fde68a;
  border-top: 4px solid #f59e0b;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.btn-secondary {
  background: #6b7280;
  color: white;
  padding: 0.75rem 2rem;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  transition: background 0.3s;
}

.btn-secondary:hover {
  background: #4b5563;
}

/* 容器管理卡片样式 */
.action-buttons {
  display: flex;
  gap: 1rem;
  margin: 1.5rem 0;
  flex-wrap: wrap;
}

.action-buttons .btn {
  flex: 1;
  min-width: 150px;
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
}

.action-hints {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
}

.hint {
  margin-bottom: 0.75rem;
  font-size: 0.9rem;
  color: #6b7280;
  line-height: 1.5;
}

.hint strong {
  color: #374151;
}

.hint:last-child {
  margin-bottom: 0;
}

/* 我的模型密钥卡片 */
.key-config input {
  width: 100%;
  padding: 0.65rem 0.85rem;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 0.95rem;
  margin-bottom: 0.75rem;
  box-sizing: border-box;
}

.key-config input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}

.key-status {
  display: inline-block;
  padding: 0.3rem 0.8rem;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 600;
  background: #f3f4f6;
  color: #6b7280;
  margin-bottom: 0.75rem;
}

.key-status.ok {
  background: #d1fae5;
  color: #065f46;
}
</style>
