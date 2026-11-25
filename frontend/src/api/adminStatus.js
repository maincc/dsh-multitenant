/**
 * 管理端读取类端点收编（P3 api 刀①）：CWT 队列三处（badges×2+cred×1）+
 * admin/check 三处（AP 壳登录/预检链）。
 */
import axios from 'axios'

export const adminStatusApi = {
  cwtApplications: (params) =>
    axios.get('/api/admin/cwt-applications', { params }).then((r) => r.data),
  check: (address) =>
    axios.get('/api/admin/check', address ? { params: { address } } : {}).then((r) => r.data),
}
