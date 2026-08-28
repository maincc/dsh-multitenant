/**
 * 技能市场 API 封装
 *
 * auth = { address, nonce, signature, publicKey }（由 wallet.js 的
 * signChallenge() 生成，后端按地址签名鉴权）。
 */

import axios from 'axios'

const BASE = '/api/skills'
const enc = encodeURIComponent

export const skillsApi = {
  /** 领取挑战 nonce（供自研流程使用；一般直接走 signChallenge） */
  challenge: (address) => axios.post(`${BASE}/challenge`, { address }).then((r) => r.data),

  /** 市场列表；address 非空时附带"已安装"标记 */
  list: (address) => axios.get(BASE, { params: address ? { address } : {} }).then((r) => r.data),

  /** 详情（含全文预览） */
  detail: (name) => axios.get(`${BASE}/${enc(name)}`).then((r) => r.data),

  /** 发布：从签名地址的卷提取并共享到市场；renameTo 可选（名字被占时换名发布） */
  publish: (auth, skillName, renameTo) =>
    axios
      .post(`${BASE}/publish`, Object.assign({ ...auth, skillName }, renameTo ? { renameTo } : {}))
      .then((r) => r.data),

  /** 安装到签名地址自己的卷 */
  install: (auth, name) =>
    axios.post(`${BASE}/${enc(name)}/install`, { ...auth }).then((r) => r.data),

  /** 卸载（删除自己卷里的技能文件） */
  uninstall: (auth, name) =>
    axios.post(`${BASE}/${enc(name)}/uninstall`, { ...auth }).then((r) => r.data),

  /** 取消共享（作者签名）/ 下架（管理员） */
  unpublish: (auth, name) =>
    axios.delete(`${BASE}/${enc(name)}`, { data: auth }).then((r) => r.data),

  /** 本地导入：写入自己卷（不入市场） */
  importSkill: (auth, skillName, content) =>
    axios.post(`${BASE}/import`, { ...auth, skillName, content }).then((r) => r.data),

  /** 我的发布 + 我的安装（个人视图，无需签名） */
  mineView: (address) => axios.get(`${BASE}/mine`, { params: { address } }).then((r) => r.data),

  /** 我的发布 + 我的安装 + 容器内可共享列表（需签名，共享弹窗用） */
  mine: (auth) => axios.post(`${BASE}/mine`, { ...auth }).then((r) => r.data),

  /** 下载/导出地址 */
  downloadUrl: (name) => `${BASE}/${enc(name)}/download`,
}
