/**
 * 用户侧配置/凭证端点收编（P3 api 刀①）：tenant-config 五处 + credential-status
 * 三处（原 useUserModel/useUserCred 直调）。canonical address 口径
 * （canonical=插件原始大小写）保持调用点透传。
 */
import axios from 'axios'

export const userConfigApi = {
  getConfig: (address) =>
    axios.get(`/api/user/tenant-config?address=${encodeURIComponent(address)}`).then((r) => r.data),
  saveConfig: (payload) => axios.post('/api/user/tenant-config', payload).then((r) => r.data),
  discover: (payload) =>
    axios.post('/api/user/tenant-config/discover', payload).then((r) => r.data),
  deleteConfig: (payload) =>
    axios.delete('/api/user/tenant-config', { data: payload }).then((r) => r.data),
  credentialStatus: (address, canonical) =>
    axios
      .get('/api/user/credential-status', {
        params: { address, canonical: canonical || undefined },
      })
      .then((r) => r.data),
}
