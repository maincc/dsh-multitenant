/**
 * 输入验证中间件
 */

import { isValidSwtcAddress, normalizeAddress } from '../utils/address.js'

/**
 * 验证 SWTC 地址
 * 如果无效，发送 400 响应并返回 false
 */
export function validateSwtcAddress(address, res) {
  if (!address || !isValidSwtcAddress(address)) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'Invalid SWTC address', code: 'BAD_REQUEST' }))
    return false
  }
  return true
}

/**
 * 规范化地址（转小写）
 */
export function normalizeAddressMiddleware(req, res, next) {
  if (req.params?.address) {
    req.params.address = normalizeAddress(req.params.address)
  }
  if (req.body?.address) {
    req.body.address = normalizeAddress(req.body.address)
  }
  next()
}
