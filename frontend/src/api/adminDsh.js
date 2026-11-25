/**
 * DSH 版本管理端点收编（P3 api 刀①）：原散在 useAdminDsh.js 的 8 处 axios 直调。
 * 返回体统一 .data（调用点从 `res.data` 改接返回值）；headers 参数保持签名头
 * 透传口径不变——端点单一来源，防两副本漂移（判例 58 同源精神）。
 */
import axios from 'axios'

const BASE = '/api/admin/dsh'

export const adminDshApi = {
  imageStatus: () => axios.get(`${BASE}/image`).then((r) => r.data),
  buildImage: (version, headers) =>
    axios.post(`${BASE}/image`, { version }, { headers }).then((r) => r.data),
  pruneImages: (ids, headers) =>
    axios.post(`${BASE}/images/prune`, { ids }, { headers }).then((r) => r.data),
  applyStatus: () => axios.get(`${BASE}/apply`).then((r) => r.data),
  applyOne: (address, image, headers) =>
    axios.post(`${BASE}/apply`, { address, image }, { headers }).then((r) => r.data),
  applyAll: (headers) =>
    axios.post(`${BASE}/apply`, { all: true }, { headers }).then((r) => r.data),
  applyAllDryRun: (headers) =>
    axios.post(`${BASE}/apply`, { all: true, dryRun: true }, { headers }).then((r) => r.data),
  applyPreview: (address, image, headers) =>
    axios.post(`${BASE}/apply`, { address, image, dryRun: true }, { headers }).then((r) => r.data),
}
