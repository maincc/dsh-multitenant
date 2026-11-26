/**
 * 管理运维端点收编（P3 api 刀②）：users 列表/统计/容器编排代管面。
 * headers = 当场签名材料（adminSign 链产物），由调用点透传——收编只收
 * 端点字符串与 axios 形状，签名语义不动（判例 64 api 红线）。
 */ //
// 口径注（审查 C 刀）：本模块混装两种返回形态——多数成员 .then(r=>r.data) 解包；
// 少数保留完整 axios response（调用点或丢弃返回值、或需 HTTP status，与基线等价）。
// 消费前先看函数定义行有无 .then，新增调用点照此验。

import axios from 'axios'

export const adminOpsApi = {
  users: (force) => axios.get(force ? '/api/users?force=1' : '/api/users').then((r) => r.data),
  stats: () => axios.get('/api/stats').then((r) => r.data),
  dockerStatus: () => axios.get('/api/docker/status').then((r) => r.data),
  // 例外不 unwrap：消费面无 url 时兜底显示 HTTP status（AdminTabUsers.openTenant）
  tenantUrl: (address) => axios.get('/api/admin/tenant-url', { params: { address } }),
  forceStop: (address, headers) =>
    axios.post(`/api/admin/force-stop/${address}`, null, { headers }),
  deleteVolume: (address, headers) =>
    axios.post(`/api/admin/delete-volume/${address}`, null, { headers }),
  promote: (address, headers) => axios.post(`/api/admin/promote/${address}`, null, { headers }),
  orphanVolumes: () => axios.get('/api/admin/orphan-volumes').then((r) => r.data),
  diskScan: () => axios.post('/api/admin/disk-scan').then((r) => r.data),
  cleanupOrphan: (volumes, headers) =>
    axios
      .post('/api/admin/cleanup-orphan-volumes', { volumes: [...volumes] }, { headers })
      .then((r) => r.data),
}
