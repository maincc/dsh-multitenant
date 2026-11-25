<!-- 用户管理 tab（P3 拆分自 AdminPanel，一刀一 commit）。
     数据 props 下发（fetchData 归壳轮询）；动作所需签名/刷新/撤销管理员
     经 inject 取壳层单例——绝不复制第二份（判例 58 红线）。 -->
<script setup>
import { computed } from 'vue'
import { inject } from 'vue'
import { adminOpsApi } from '../../api/adminOps.js'
import { userSessionApi } from '../../api/userSession.js'
import { useI18n } from 'vue-i18n'
import { toast, askConfirm } from '../../composables/useDialog'
import { shortAddress } from '../../utils/format.js'
import { tierBadge, statusBadge, makeStatusText } from './shared.js'
import AdminTabHead from './AdminTabHead.vue'
import { useAdminCred } from '../../composables/useAdminCred.js'

const props = defineProps({
  users: { type: Array, default: () => [] },
  tiers: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  error: { type: String, default: null },
  refreshIntervalMs: { type: Number, default: 15000 },
})
defineEmits(['refresh'])

const { t } = useI18n()
const signAdminOperation = inject('adminSign')
const fetchData = inject('adminRefresh')
const { demoteAdmin } = useAdminCred()

const statusText = makeStatusText(t)

const maxTier = computed(() => {
  const keys = Object.keys(props.tiers || {})
    .map(Number)
    .filter(Number.isFinite)
  return keys.length ? Math.max(...keys) : 3
})

const formatIdle = (ms) => {
  // 2026-10 审计：idle 可为 null/undefined（无启动记录/状态漂移）。undefined
  // 与数字比较全为 false，会一路落到最后一行渲染出 "NaN天"；null 则被
  // null<60000=true 误显示成 "0秒"（看起来像刚活跃）。非有限值一律占位。
  if (!Number.isFinite(ms)) return '—'
  if (ms < 60000) return `${Math.floor(ms / 1000)}${t('admin.secUnit')}`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}${t('admin.minUnit')}`
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}${t('admin.hourUnit')}`
  return `${(ms / 86400000).toFixed(1)}${t('admin.dayUnit')}`
}

/**
 * 管理员代开租户容器：后端生成一次性 gateway_ticket（管理员会话授权），
 * 浏览器打开该 URL 首跳即换取租户会话并放行（后续请求无需再带 ticket）。
 */
const openTenant = async (address) => {
  try {
    const res = await adminOpsApi.tenantUrl(address)
    if (res.url) {
      window.open(res.url, '_blank', 'noopener')
      return
    }
    toast(t('admin.openFail', { err: res.data.error || res.status }))
  } catch (err) {
    const msg = err.response?.data?.error || err.message
    toast(t('admin.openFail', { err: msg }))
  }
}

// 2026-10 审计：调配额会当场 stop→update→start 该租户容器（别人正在用的会话被断）。
// 此前既无确认也无签名——后端已收进签名白名单（binding=address:tier），
// 这里补危险确认，动作进 run 由弹窗 busy 锁防连点。
const upgradeUser = async (address, tier) => {
  if (tier > maxTier.value) return
  await askConfirm({
    message: t('admin.confirmTierChange', { addr: `${address.slice(0, 10)}…`, tier }),
    danger: true,
    run: async () => {
      try {
        const headers = await signAdminOperation('user-upgrade', { address, tier })
        await userSessionApi.upgrade(address, tier, headers)
        await fetchData()
        toast(t('admin.upgradeOk'))
      } catch (err) {
        toast(t('admin.upgradeFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

const downgradeUser = async (address, tier) => {
  if (tier < 1) return
  // 2026-11-02 实账补刀：2026-10 审计给同端点升级半边上了"确认+签名"，降级半边
  // 漏了——裸 POST 无签，服务端闸（binding=address:tier 双向同闸）拒得对，用户
  // 看到的是我们的手术遗漏。与 upgradeUser 同款补全：danger 确认 + run 锁 +
  // signAdminOperation('user-upgrade')——同一把闸同一张票，降档同样会重启对方容器。
  await askConfirm({
    message: t('admin.confirmTierChange', { addr: `${address.slice(0, 10)}…`, tier }),
    danger: true,
    run: async () => {
      try {
        const headers = await signAdminOperation('user-upgrade', { address, tier })
        await userSessionApi.upgrade(address, tier, headers)
        await fetchData()
        toast(t('admin.downgradeOk'))
      } catch (err) {
        toast(t('admin.downgradeFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

const removeUser = async (address) => {
  const port = props.users.find((u) => u.address === address)?.port
  if (!(await askConfirm(t('admin.confirmRemove', { addr: `${address.slice(0, 10)}...`, port }))))
    return

  // 卷二选一改 danger 正语义（确认=连卷删除不可逆；取消/Esc/遮罩=保留数据卷，
  // 关闭弹窗必落安全面——原生时代"取消=删除"的反向地雷就此拆除）
  const wipeVolume = await askConfirm({
    message: t('admin.confirmRemoveKeepVolume'),
    danger: true,
    confirmLabel: t('admin.volWipeBtn'),
    cancelLabel: t('admin.volKeepBtn'),
  })
  const keepVolume = !wipeVolume

  try {
    const headers = await signAdminOperation('remove', { address, keepVolume })
    await userSessionApi.remove(address, keepVolume, headers)
    await fetchData()
    toast(keepVolume ? t('admin.removedOkKeepVolume') : t('admin.removedOk'))
  } catch (err) {
    toast(t('admin.removeFail', { err: err.response?.data?.error || err.message }))
  }
}

const forceStopUser = async (address) => {
  await askConfirm({
    message: t('admin.confirmForceStop', { addr: `${address.slice(0, 10)}...` }),
    danger: true,
    run: async () => {
      try {
        const headers = await signAdminOperation('force-stop', { address })
        await adminOpsApi.forceStop(address, headers)
        await fetchData()
        toast(t('admin.forceStoppedOk'))
      } catch (err) {
        toast(t('admin.forceStopFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

const deleteVolume = async (address) => {
  if (!(await askConfirm(t('admin.confirmDeleteVolume', { addr: `${address.slice(0, 10)}...` }))))
    return

  await askConfirm({
    message: t('admin.confirmDeleteVolume2'),
    danger: true,
    run: async () => {
      try {
        const headers = await signAdminOperation('delete-volume', { address })
        await adminOpsApi.deleteVolume(address, headers)
        await fetchData()
        toast(t('admin.volumeDeletedOk'))
      } catch (err) {
        toast(t('admin.removeFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}

const promoteUser = async (address) => {
  await askConfirm({
    message: t('admin.confirmPromote', { addr: `${address.slice(0, 10)}...` }),
    run: async () => {
      try {
        const headers = await signAdminOperation('promote', { address })
        await adminOpsApi.promote(address, headers)
        await fetchData()
        toast(t('admin.promoteOk'))
      } catch (err) {
        toast(t('admin.promoteFail', { err: err.response?.data?.error || err.message }))
      }
    },
  })
}
</script>

<template>
  <div>
    <AdminTabHead
      :title="$t('admin.tabUsers')"
      :hint="$t('admin.userListHint')"
      :loading="loading"
      :interval-ms="refreshIntervalMs"
      @refresh="$emit('refresh')"
    />
    <div v-if="loading" class="loading">{{ $t('admin.loading') }}</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <table v-else>
      <thead>
        <tr>
          <th>{{ $t('admin.colAddress') }}</th>
          <th>{{ $t('admin.colPort') }}</th>
          <th>{{ $t('admin.colTier') }}</th>
          <th>{{ $t('admin.colVersion') }}</th>
          <th>{{ $t('admin.colStatus') }}</th>
          <th>{{ $t('admin.colIdle') }}</th>
          <th>{{ $t('admin.colRole') }}</th>
          <th>{{ $t('admin.colOps') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in users" :key="user.address">
          <td>
            <span class="address addr-tip" :data-full="user.address">{{
              shortAddress(user.address)
            }}</span>
          </td>
          <td>{{ user.port }}</td>
          <td>
            <span class="badge" :class="tierBadge(user.tier)">
              {{ user.tierLabel }}
            </span>
          </td>
          <td>
            <code v-if="user.dshVersion" class="dsh-ver">{{ user.dshVersion }}</code>
            <span v-else class="dsh-ver-unknown">{{ $t('admin.versionUnknown') }}</span>
          </td>
          <td>
            <span class="badge" :class="statusBadge(user.status)">
              {{ statusText(user.status) }}
            </span>
          </td>
          <td>{{ formatIdle(user.idle) }}</td>
          <td>
            <span v-if="user.isAdmin" class="badge badge-success">{{ $t('admin.roleAdmin') }}</span>
            <span v-else class="badge badge-info">{{ $t('admin.roleUser') }}</span>
          </td>
          <td>
            <div class="ops-cell">
              <button
                class="btn btn-primary"
                @click="upgradeUser(user.address, user.tier + 1)"
                :disabled="
                  user.tier >= maxTier || user.status === 'destroyed' || user.status === 'unknown'
                "
              >
                {{ $t('admin.upgrade') }}
              </button>
              <button
                class="btn btn-success"
                @click="downgradeUser(user.address, user.tier - 1)"
                :disabled="
                  user.tier <= 1 || user.status === 'destroyed' || user.status === 'unknown'
                "
              >
                {{ $t('admin.downgrade') }}
              </button>
              <!-- 提权与容器生命周期解耦（2026-10-23 用户实测"不能用"的根因）：
                   任命管理员=台账+档案动作，容器 destroyed/unknown 不该禁用它——
                   真正的门禁是当场钱包签名双验证，这里不设状态闸 -->
              <button
                v-if="!user.isAdmin"
                class="btn btn-warning"
                @click="promoteUser(user.address)"
              >
                {{ $t('admin.promote') }}
              </button>
              <!-- 撤权在用户管理行内闭环（任免名册转只读后的唯一操作入口）：
                   demoteAdmin 自带 danger 确认+钱包签名门禁，LAST_ADMIN 防锁死
                   由后端人话报错直出 -->
              <button v-if="user.isAdmin" class="btn btn-danger" @click="demoteAdmin(user.address)">
                {{ $t('admin.rosterDemote') }}
              </button>
              <a
                v-if="user.status === 'running'"
                href="#"
                @click.prevent="openTenant(user.address)"
                rel="noopener noreferrer"
                class="btn btn-info"
              >
                {{ $t('admin.visit') }}
              </a>
              <button
                v-if="user.status === 'running'"
                class="btn btn-warning"
                @click="forceStopUser(user.address)"
                :title="$t('admin.forceStopTitle')"
              >
                {{ $t('admin.forceStop') }}
              </button>
              <button
                class="btn btn-danger"
                @click="deleteVolume(user.address)"
                :title="$t('admin.deleteDataTitle')"
              >
                {{ $t('admin.deleteData') }}
              </button>
              <button
                class="btn btn-danger"
                @click="removeUser(user.address)"
                :title="$t('admin.removeTitle')"
              >
                {{ $t('admin.remove') }}
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped></style>
