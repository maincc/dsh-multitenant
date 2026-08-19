/**
 * SWTC 地址工具函数
 */

/**
 * 验证 SWTC 地址格式
 * 井通地址格式：以 j 开头，30-35 位 base58 字符（字母数字，不含 0OIl）
 * 允许小写 l，因为前端会统一转小写后再发送
 */
export function isValidSwtcAddress(addr) {
  if (!addr || typeof addr !== 'string') return false
  return /^j[1-9A-HJ-NP-Za-km-zl]{29,34}$/.test(addr)
}

/**
 * 规范化 SWTC 地址（转小写）
 */
export function normalizeAddress(addr) {
  return addr.toLowerCase()
}

/**
 * SWTC 地址转容器名
 */
export function swtcContainerName(address) {
  return `dsh-swtc-${normalizeAddress(address)}`
}

/**
 * SWTC 地址转数据卷名
 */
export function swtcVolumeName(address) {
  return `dsh-data-swtc-${normalizeAddress(address)}`
}
