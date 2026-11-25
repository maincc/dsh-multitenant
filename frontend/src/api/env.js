/**
 * 环境模板市场端点收编（P3 api 刀②）：用户面（清单/应用/定格/提交/下架/回退）
 * 与管理面（审核/发布/驳回/撤销/扫描/代格）双侧同册——两端点族在后端成对演进，
 * 收一处防"改一头忘另一头"（判例 58 双生面）。签名 headers 调用点透传。
 */
import axios from 'axios'

const U = '/api/user'
const A = '/api/admin'

export const envApi = {
  list: () => axios.get(`${U}/environments`).then((r) => r.data),
  inventory: () => axios.post(`${U}/environment-inventory`, {}).then((r) => r.data),
  apply: (payload) => axios.post(`${U}/environment/apply`, payload).then((r) => r.data),
  commit: (payload) => axios.post(`${U}/environment-commit`, payload).then((r) => r.data),
  submit: (id) => axios.post(`${U}/environment/submit`, { id }).then((r) => r.data),
  unpublish: (id) => axios.post(`${U}/environment/unpublish`, { id }).then((r) => r.data),
  revert: (alsoClean) => axios.post(`${U}/environment/revert`, { alsoClean }).then((r) => r.data),
  adminList: () => axios.get(`${A}/environments`).then((r) => r.data),
  adminDetail: (id) => axios.get(`${A}/environments/${encodeURIComponent(id)}`).then((r) => r.data),
  adminPublish: (id, headers) => axios.post(`${A}/env-publish`, { id }, { headers }),
  adminReject: (id, reason, headers) => axios.post(`${A}/env-reject`, { id, reason }, { headers }),
  adminRevoke: (id, headers) =>
    axios.post(`${A}/env-revoke`, { id }, { headers }).then((r) => r.data),
  adminScan: (id, headers) => axios.post(`${A}/env-scan`, { id }, { headers }).then((r) => r.data),
  adminCommit: (payload, headers) =>
    axios.post(`${A}/env-commit`, payload, headers ? { headers } : {}).then((r) => r.data),
}
