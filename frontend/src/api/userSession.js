/**
 * 用户会话/容器操作端点收编（P3 api 刀②a）。
 * 双生面重点：/api/user/:address/* 与 /api/upgrade/:address 是"用户自助 vs 管理员
 * 代管"两条链共用的后端面（判例 58 前端版温床）——端点字符串收进单源，
 * headers（当场签名）保持调用点透传，语义零改动。
 */ //
// 口径注（审查 C 刀）：本模块混装两种返回形态——多数成员 .then(r=>r.data) 解包；
// 少数保留完整 axios response（调用点或丢弃返回值、或需 HTTP status，与基线等价）。
// 消费前先看函数定义行有无 .then，新增调用点照此验。

import axios from 'axios'

export const userSessionApi = {
  connectStatus: (address) =>
    axios.get('/connect-status', { params: { address } }).then((r) => r.data),
  sessionInfo: () => axios.get('/api/user/session-info').then((r) => r.data),
  logout: () => axios.post('/api/user/logout').then((r) => r.data),
  profile: (address) => axios.get(`/api/user/${address}`).then((r) => r.data),
  restart: (address) => axios.post(`/api/user/${address}/restart`).then((r) => r.data),
  reset: (address) => axios.post(`/api/user/${address}/reset`).then((r) => r.data),
  stop: (address) => axios.post(`/api/user/${address}/stop`).then((r) => r.data),
  // 管理员代删（AdminTabUsers 面）：keepVolume=留卷删容器
  remove: (address, keepVolume, headers) =>
    axios.post(`/api/user/${address}/remove`, null, {
      params: keepVolume ? { keepVolume: 1 } : {},
      headers,
    }),
  upgrade: (address, tier, headers) => axios.post(`/api/upgrade/${address}`, { tier }, { headers }),
}
