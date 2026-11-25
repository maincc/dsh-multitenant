/**
 * 管理运维端点收编（P3 api 刀②）：users 列表/统计/容器编排代管面。
 * headers = 当场签名材料（adminSign 链产物），由调用点透传——收编只收
 * 端点字符串与 axios 形状，签名语义不动（判例 64 api 红线）。
 */
import axios from 'axios'

export const adminOpsApi = {
  users: (force) => axios.get(force ? '/api/users?force=1' : '/api/users').then((r) => r.data),
  stats: () => axios.get('/api/stats').then((r) => r.data),
  dockerStatus: () => axios.get('/api/docker/status').then((r) => r.data),
  tenantUrl: (address) =>
    axios.get('/api/admin/tenant-url', { params: { address } }).then((r) => r.data),
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
