/**
 * crypto.randomUUID polyfill —— 非安全上下文兼容
 *
 * 背景：浏览器安全上下文规则（W3C Secure Contexts）规定 crypto.randomUUID
 * 只在 HTTPS 或 localhost（回环地址）下可用。局域网 IP + 明文 HTTP 访问
 * DSH Web UI 时 crypto.randomUUID 为 undefined，导致前端发消息报
 * "crypto.randomUUID is not a function"。
 *
 * 实现：与 DSH 官方 packages/client/connection/src/client/random-uuid.ts
 * 一致，基于 crypto.getRandomValues()（该 API 在非安全上下文也允许）生成
 * RFC 4122 v4 UUID，随机性质量不变（加密级随机源）。
 *
 * 安全说明：
 *   - 不绕过任何认证/权限（trustedHosts 篱笆、管理员鉴权照常生效）
 *   - 只补一个被浏览器按规范藏起来的 API，guard 在安全上下文下自动跳过
 *   - polyfill 解决的是"UI 能用"；明文 HTTP 传输问题仍需 HTTPS 解决
 *
 * 注入位置：由 Dockerfile 把本文件注入到
 *   $(npm root -g)/@deepseek-ai/dsh-web-frontend/dist/index.html 的 </head> 前
 */
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40 // version 4
    b[8] = (b[8] & 0x3f) | 0x80 // variant 10
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
}
