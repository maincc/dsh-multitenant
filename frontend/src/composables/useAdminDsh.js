import { ref, computed } from 'vue'
import { adminDshApi } from '../api/adminDsh.js'
import i18n from '../i18n'
import { toast, askConfirm } from './useDialog'

/**
 * DSH 版本管理域单例（P3 dsh 刀）：镜像状态/版本目录/构建/清理/升级编排全在此。
 * 状态跨 tab 切换保活——构建/批量进行中切走再切回，遮罩与进度不丢（原壳
 * setup-scope 语义用模块级单例延续）。定时器/遮罩只在页面卸载清：壳
 * onUnmounted 调 cleanupDsh()；组件切 tab 绝不停表。
 * 宿主注入两把刀同 useAdminCred：sign=壳层 signAdminOperation 薄包装、
 * refresh=fetchData（升级完成后统计卡即时翻转）。
 */
const t = (key, params) => i18n.global.t(key, params)

let host = {
  sign: async () => {
    throw new Error('adminDsh host not bound')
  },
  refresh: async () => {},
}
export function bindDshHost(h) {
  host = { ...host, ...h }
}

let dshPollTimer = null

const dshStatus = ref({
  image: null,
  currentImageVersion: null,
  currentImageId: null,
  upgrade: null,
  staleTenants: 0,
  tenants: [],
  history: [],
  note: null,
})

const dshStatusLoading = ref(false)

const dshError = ref('')

const dshVersions = ref({
  latest: null,
  stable: [],
  prerelease: [],
  prereleaseCount: 0,
  // 与"远端有哪些版本"分开：这三个回答"本地手上已有哪些版本"
  stableLocal: [],
  prereleaseLocal: [],
  localTags: [],
  currentVersion: null,
})

const dshVersionsLoading = ref(false)

const dshVersionsError = ref(null)

const dshIncludePrerelease = ref(false)

const dshSelectedVersion = ref('')

const dshBuild = ref({
  running: false,
  version: null,
  ok: null,
  error: null,
  result: null,
  finishedAt: null,
})

const dshApply = ref({
  running: false,
  total: 0,
  completed: 0,
  results: [],
  finishedAt: null,
})

const dshApplyResults = ref([])

const dshUpdate = ref({
  /** @type {'single'|'batch'|null} */
  kind: null,
  /** 当前正在处理的租户地址（单租户时有值） */
  address: '',
  /** 显示用标签：单租户显示短暂版本 → 目标版本 */
  phase: '',
})

const dshImages = ref({ images: [], defaultId: '', defaultRef: '', defaultVersion: null })

const dshImagesLoading = ref(false)

const dshImagesError = ref('')

const dshSelecting = ref('')

const dshTargetImage = ref({})

const dshAvailableImages = computed(() => dshStatus.value.availableImages || [])

const pruneItems = computed(() => dshStatus.value.prunable?.items || [])

const pruneableItems = computed(() => pruneItems.value.filter((im) => im.removable))

const pruneableBytes = computed(() =>
  pruneableItems.value.reduce((s, im) => s + (im.sizeBytes || 0), 0),
)

const pruneInfoIncomplete = computed(() => Boolean(dshStatus.value.prunable?.infoIncomplete))

const dshPrune = ref({ running: false, message: '' })

const selectedImageIds = ref([])

const allVersionOptions = computed(() => {
  const seen = new Set()
  const out = []
  const add = (v, stable) => {
    if (!v || seen.has(v)) return
    seen.add(v)
    out.push({ version: v, local: versionIsLocal(v), stable })
  }
  const stableRows = dshVersions.value.stableLocal || []
  const preRows = dshVersions.value.prereleaseLocal || []
  for (const r of stableRows) add(r.version, true)
  for (const r of preRows) add(r.version, false)
  const cmp = (a, b) => {
    if (a === dshVersions.value.latest) return -1
    if (b === dshVersions.value.latest) return 1
    // 按数字段降序比较版本号（预发布后缀不参与，够用且不会误排）
    const pa = String(a)
      .split(/[.-]/)
      .map((x) => parseInt(x, 10) || 0)
    const pb = String(b)
      .split(/[.-]/)
      .map((x) => parseInt(x, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0)
    }
    return String(b).localeCompare(String(a))
  }
  return out.sort((a, b) => cmp(a.version, b.version))
})

const versionIsLocal = (v) =>
  Boolean(
    (dshVersions.value.stableLocal || [])
      .concat(dshVersions.value.prereleaseLocal || [])
      .find((r) => r.version === v)?.local,
  )

const needsApply = (t) => Boolean(t.stale) || targetImageFor(t.address) !== ''

const targetImageFor = (address) => dshTargetImage.value[address] || ''

const dshUpdateBusy = computed(() => dshUpdate.value.kind !== null)

const loadDshStatus = async () => {
  dshStatusLoading.value = true
  try {
    // 先确保版本列表已加载：/status 只读缓存做版本对比（它不联网，以免拖慢刷新），
    // 所以这里必须先把缓存预热，否则"最新可用版本"永远显示"尚未加载"
    if (!dshVersions.value.latest) {
      await loadDshVersions()
    }
    dshStatus.value = await adminDshApi.status()
    dshError.value = ''
  } catch (err) {
    console.error('[AdminPanel] 读取 DSH 镜像状态失败:', err)
    // 写本 tab 的横幅（此前写全局 error：横幅在 users tab，看不见且会串tab）
    dshError.value = t('admin.loadFail', {
      err: err.response?.data?.error || err.message,
    })
  } finally {
    dshStatusLoading.value = false
  }
}

const loadDshImages = async () => {
  dshImagesLoading.value = true
  dshImagesError.value = ''
  try {
    const d = await adminDshApi.localImages()
    // 形状归一：任何字段缺失都塌成安全默认值，绝不让模板对 undefined 取值
    // （曾经清单形状一变整张表就人间蒸发，"想设也没得设"）
    dshImages.value = {
      images: Array.isArray(d.images) ? d.images : [],
      defaultId: d.defaultId || '',
      defaultRef: d.defaultRef || '',
      defaultVersion: d.defaultVersion || null,
    }
  } catch (err) {
    // 错误必须上屏：静默 console 会让空表看起来像"本机真没镜像"（误导决策）
    dshImages.value = { images: [], defaultId: '', defaultRef: '', defaultVersion: null }
    dshImagesError.value = `${t('admin.dshImagesLoadFail')}：${err.response?.data?.error || err.message}`
  } finally {
    dshImagesLoading.value = false
  }
}

const loadDshVersions = async (force = false) => {
  dshVersionsLoading.value = true
  dshVersionsError.value = null
  try {
    const d = await adminDshApi.versions({
      includePrerelease: dshIncludePrerelease.value ? 1 : 0,
      ...(force ? { refresh: 1 } : {}),
    })
    dshVersions.value = d
  } catch (err) {
    const data = err.response?.data
    // registry 不可达（503）要明确说明，而不是静默空列表
    dshVersionsError.value = data?.error || err.message
  } finally {
    dshVersionsLoading.value = false
  }
}

const stopDshPolling = () => {
  if (dshPollTimer) {
    clearInterval(dshPollTimer)
    dshPollTimer = null
  }
}

const anyDshTaskRunning = () => dshBuild.value.running || dshApply.value.running

const finishBatchUpdate = () => {
  stopDshPolling()
  if (dshUpdate.value.kind === 'batch') {
    dshUpdate.value = { kind: null, address: '', phase: '' }
  }
}

const startDshPolling = () => {
  if (dshPollTimer) return
  // 是否已观察到批量任务"真的开始跑"。
  // 必须确认过才算结束：POST 返回 202 与后台任务被标记 running 之间有一瞬间，
  // 若第一次轮询恰好落在这个窗口，会看到 running:false 而**提前判定结束**
  // （遮罩卡死、进度不再更新）。没见过 running=true 之前不认"结束"。
  let sawApplyRunning = false
  // 兜底计时：POST 已返回 202 却迟迟等不到 running=true（服务端起来前就失败），
  // 不能让遮罩无限停留 —— 超时后收尾并强制刷新一次状态。
  let pollTicks = 0
  dshPollTimer = setInterval(async () => {
    pollTicks += 1
    try {
      if (dshBuild.value.running) {
        const d = await adminDshApi.imageStatus()
        dshBuild.value = d
        if (!d.running) {
          // 构建结束：刷新镜像状态（新版本要显示出来）。
          // 版本清单也要重拉：新构建的 "✓ 本地" 标记来自 /versions 的现算结果，
          // 不刷的话刚建好的版本要等用户手动点"更新"才亮勾（与清理面板同源同步）。
          // 钦定清单同样要重拉：刚构建的 tag 就是它的候选行。
          await loadDshStatus()
          await loadDshVersions().catch(() => {})
          await loadDshImages().catch(() => {})
          // 注意：批量可能同时在跑，不能无条件停表
          if (!anyDshTaskRunning()) stopDshPolling()
        }
      }
      if (dshApply.value.running) {
        const d = await adminDshApi.applyStatus()
        dshApply.value = d
        if (d.running) sawApplyRunning = true
        if (!d.running && sawApplyRunning) {
          // 批量结束：把逐租户结果落到明细列表（含失败原因）
          dshApplyResults.value = d.results || []
          // 全部待选目标作废：批量已把陈旧租户刷到最新，下拉框回到实际钉像
          dshTargetImage.value = {}
          await loadDshStatus()
          finishBatchUpdate()
        } else if (!sawApplyRunning && pollTicks >= 30) {
          // ~60s 仍未见到任务启动 → 视为启动失败，收尾并刷新真实状态
          console.error('[AdminPanel] 批量任务迟迟未启动，停止跟踪')
          await loadDshStatus().catch(() => {})
          finishBatchUpdate()
        }
      }
    } catch (err) {
      // 单次轮询失败（网络抖动/瞬时 5xx）不该终止整个进度跟踪：
      // 停表会让遮罩永久停留、进度静默失效。只有确认没有任务在跑才真停。
      console.error('[AdminPanel] 轮询 DSH 任务失败:', err)
      if (!anyDshTaskRunning()) {
        stopDshPolling()
        if (dshUpdate.value.kind === 'batch') finishBatchUpdate()
      }
    }
  }, 2000)
}

const toggleSelectAllImages = (e) => {
  selectedImageIds.value = e.target.checked ? pruneableItems.value.map((im) => im.id) : []
}

const pruneImages = async () => {
  const ids = [...selectedImageIds.value]
  if (!ids.length) return
  // 2026-10 审计：不可逆删镜像（zh.js 自己警告"带 tag 旧版本删掉无法回滚"）此前零确认
  if (
    !(await askConfirm({ message: t('admin.confirmPruneImages', { n: ids.length }), danger: true }))
  )
    return
  dshPrune.value = { running: true, message: '' }
  try {
    const headers = await host.sign('dsh/prune-images', { ids })
    const d = await adminDshApi.pruneImages(ids, headers)
    const { removed = [], skipped = [], freedBytes = 0 } = d || {}
    // ⚠️ script setup 里没有 $t（那是模板专属）：必须用 useI18n() 的 t——
    // 此处曾写错，镜像删成功后组装回执时 ReferenceError，用户误以为没删掉
    const parts = [t('admin.dshPruned', { n: removed.length, size: formatBytes(freedBytes) })]
    if (skipped.length) parts.push(t('admin.dshPruneSkipped', { n: skipped.length }))
    dshPrune.value = { running: false, message: parts.join('，') }
  } catch (err) {
    dshPrune.value = { running: false, message: friendlyPluginError(err) }
  } finally {
    // 刷新放 finally 且两路都拉——不管这次是全删成、被服务端部分拒、还是中途抛错，
    // 页面都必须回到守护进程的真实状态：
    //   · /status 现算清理面板列表（prunable.items 与可回收字节）
    //   · /versions 现算版本行"✓ 本地"标记：不重拉的话刚删掉的 0.1.1-rc.2
    //     会长期谎称"本地存在"（2026-10 实测用户所见即此）
    // 两个都 catch：守护瞬时不答也不该把已执行完的清理反报成失败
    selectedImageIds.value = []
    await loadDshStatus().catch(() => {})
    await loadDshVersions().catch(() => {})
    // 镜像刚被删掉 → 钦定清单必须同步，否则按钮还对着一个已不存在的 tag
    await loadDshImages().catch(() => {})
  }
}

const selectPlatformImage = async (img) => {
  await askConfirm({
    message: t('admin.dshSelectConfirm', { ref: img.ref }),
    run: async () => {
      dshSelecting.value = img.ref
      try {
        const headers = await host.sign('dsh/select', { ref: img.ref })
        await adminDshApi.selectImage(img.ref, headers)
        toast(t('admin.dshSelectDone', { ref: img.ref }))
      } catch (err) {
        toast(t('admin.dshSelectFail', { err: err.response?.data?.error || err.message }))
      } finally {
        // 无论成败都刷新：latest tag 可能已挪、清单与状态必须回到事实态
        dshSelecting.value = ''
        await Promise.all([
          loadDshImages().catch(() => {}),
          loadDshStatus().catch(() => {}),
          loadDshVersions().catch(() => {}),
        ])
      }
    },
  })
}

const setTargetImage = (address, value) => {
  // 显式记录（含清空）：清空后要覆盖掉 pinnedImage 的回退值，所以不能删 key
  dshTargetImage.value = { ...dshTargetImage.value, [address]: value }
}

const applyOne = async (address) => {
  if (
    !(await askConfirm({
      message: t('admin.confirmApplyOne', { addr: `${address.slice(0, 10)}…` }),
      danger: true,
    }))
  )
    return
  dshApplyResults.value = []
  // 同步请求（后端重建完才返回），必须给用户明确的"正在执行"反馈。
  // phase 显示**目标版本**（这次要装上的），不是租户当前版本 —— 免得被读成
  // "正在更新到 <当前版本>"。
  const image = targetImageFor(address)
  // phase 要反映"这次到底装哪个"：钉了版本就显示那个版本，否则显示最新版
  const target = image
    ? String(image).split(':')[1]
    : dshStatus.value.upgrade?.latest || dshStatus.value.currentImageVersion || ''
  dshUpdate.value = { kind: 'single', address, phase: target }
  try {
    const headers = await host.sign('dsh/apply', { address, image })
    const d = await adminDshApi.applyOne(address, image, headers)
    dshApplyResults.value = d.results || []
    // 应用成功 → 撤销本地待选目标：下拉框回到"实际钉住的镜像"（loadDshStatus
    // 刷新出的 pinnedImage）。留着陈旧 key 会在别处换钉后仍显示旧目标（2026-10 审计）
    const rest = { ...dshTargetImage.value }
    delete rest[address]
    dshTargetImage.value = rest
    await loadDshStatus()
  } catch (err) {
    dshApplyResults.value = [{ address, ok: false, error: friendlyPluginError(err) }]
    await loadDshStatus()
  } finally {
    dshUpdate.value = { kind: null, address: '', phase: '' }
  }
}

const applyAllStale = async () => {
  await askConfirm({
    message: t('admin.confirmApplyAllStale', { n: dshStatus.value?.staleTenants ?? 0 }),
    danger: true,
    run: async () => {
      dshApplyResults.value = []
      try {
        const headers = await host.sign('dsh/apply', { all: true })
        const d = await adminDshApi.applyAll(headers)
        dshApply.value = {
          running: true,
          total: d.total || 0,
          completed: 0,
          results: [],
          finishedAt: null,
        }
        // 批量在服务端后台跑，遮罩持续到轮询发现任务结束
        dshUpdate.value = { kind: 'batch', address: '', phase: '' }
        startDshPolling()
      } catch (err) {
        toast(t('admin.applyFail', { err: friendlyPluginError(err) }))
      }
    },
  })
}

const previewApplyOne = async (address) => {
  dshApplyResults.value = []
  try {
    // 预览也要签名：后端把 dsh/apply 整体当作破坏性操作（dryRun 只是"不执行"，
    // 签名绑定的是地址这个执行意图，与是否 dryRun 无关）。漏签名会直接 403
    // SIGNATURE_REQUIRED —— 这正是"预览按钮点了没反应"的原因。
    const image = targetImageFor(address)
    const headers = await host.sign('dsh/apply', { address, image })
    const d = await adminDshApi.applyPreview(address, image, headers)
    dshApplyResults.value = d.results || []
  } catch (err) {
    dshApplyResults.value = [{ address, ok: false, error: friendlyPluginError(err) }]
  }
}

const previewApplyAll = async () => {
  dshApplyResults.value = []
  try {
    const headers = await host.sign('dsh/apply', { all: true })
    const d = await adminDshApi.applyAllDryRun(headers)
    dshApplyResults.value = d.results || []
  } catch (err) {
    toast(t('admin.applyFail', { err: friendlyPluginError(err) }))
  }
}

const startImageUpgrade = async () => {
  if (!dshSelectedVersion.value) return
  const version = dshSelectedVersion.value
  if (
    !(await askConfirm({
      message: t('admin.confirmBuildImage', { v: version }),
      danger: true,
    }))
  )
    return
  try {
    const headers = await host.sign('dsh/build-image', { version })
    await adminDshApi.buildImage(version, headers)
    dshBuild.value = {
      running: true,
      version: dshSelectedVersion.value,
      ok: null,
      error: null,
      result: null,
      finishedAt: null,
    }
    startDshPolling()
  } catch (err) {
    dshBuild.value = {
      ...dshBuild.value,
      running: false,
      ok: false,
      error: err.response?.data?.error || err.message,
      finishedAt: Date.now(),
    }
  }
}

function formatTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function shortImageId(id) {
  if (!id) return '—'
  const bare = String(id).replace(/^sha256:/, '')
  return bare.slice(0, 12)
}

export function useAdminDsh() {
  return {
    dshStatus,
    dshStatusLoading,
    dshError,
    dshVersions,
    dshVersionsLoading,
    dshVersionsError,
    dshIncludePrerelease,
    dshSelectedVersion,
    dshBuild,
    dshApply,
    dshApplyResults,
    dshUpdate,
    dshImages,
    dshImagesLoading,
    dshImagesError,
    dshSelecting,
    dshTargetImage,
    dshAvailableImages,
    pruneItems,
    pruneableItems,
    pruneableBytes,
    pruneInfoIncomplete,
    dshPrune,
    selectedImageIds,
    allVersionOptions,
    versionIsLocal,
    needsApply,
    targetImageFor,
    dshUpdateBusy,
    loadDshStatus,
    loadDshImages,
    loadDshVersions,
    stopDshPolling,
    anyDshTaskRunning,
    finishBatchUpdate,
    startDshPolling,
    toggleSelectAllImages,
    pruneImages,
    selectPlatformImage,
    setTargetImage,
    applyOne,
    applyAllStale,
    previewApplyOne,
    previewApplyAll,
    startImageUpgrade,
    formatTime,
    shortImageId,
  }
}

/** 页面卸载清理：停表 + 遮罩复位（tab 内切换绝不调用——保活语义所在） */
export function cleanupDsh() {
  stopDshPolling()
  dshUpdate.value = { kind: null, address: '', phase: '' }
}
