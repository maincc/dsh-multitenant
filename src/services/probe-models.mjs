#!/usr/bin/env node
/**
 * 模型探测工具（在租户镜像的辅助容器内运行）
 *
 * 请求 <baseURL>/models（OpenAI 兼容协议），输出模型列表 JSON。
 * - apiKey 参数未提供时，自动从租户卷 /dsh-home/.credentials.yaml 读取
 *   DEEPSEEK_API_KEY —— key 不离开卷，宿主进程与前端均不可见。
 * - 凭据文件用 DSH 同源的 yaml 库解析（DSH credentials-local 会用该库
 *   重写文件，样式可变；正则解析脆弱，必须同源解析）。
 * - 只接受 http/https，10s 超时。
 *
 * 输出（stdout，始终可 JSON.parse）：
 *   { "models": [ { "id": "...", "name": "..." } ] }  成功
 *   { "error": "..." }                                 业务失败（HTTP/超时/网络）
 * 退出码：0 = 业务完成（含业务错误，error 字段表达）；2 = 参数非法。
 *
 * 用法：
 *   node probe-models.mjs <baseURL> [apiKey] [credentialRef]
 *   credentialRef 默认 DEEPSEEK_API_KEY（llm-pi-ai 自定义 provider 传其 apiKeyEnv）。
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(new URL(import.meta.url).pathname)

/** yaml 库候选路径：镜像内 dsh 全局依赖优先，宿主编译环境兜底（测试用）。 */
const YAML_CANDIDATES = [
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/yaml',
  '/usr/local/lib/node_modules/yaml',
  join(here, '..', '..', 'node_modules', 'yaml'),
]

function loadYaml() {
  for (const p of YAML_CANDIDATES) {
    if (!existsSync(p)) continue
    try {
      return require(p)
    } catch {
      // 该候选不可用，试下一个
    }
  }
  return null
}

const yaml = loadYaml()

const [baseURL, apiKeyArg, refArg] = process.argv.slice(2)
const credentialRef = typeof refArg === 'string' && refArg.trim() ? refArg.trim() : 'DEEPSEEK_API_KEY'

if (typeof baseURL !== 'string' || !/^https?:\/\//.test(baseURL)) {
  console.log(JSON.stringify({ error: 'baseURL 必须是 http(s) 地址' }))
  process.exit(2)
}

let apiKey = typeof apiKeyArg === 'string' ? apiKeyArg.trim() : ''
let keySource = apiKey ? 'request' : 'none'

if (!apiKey) {
  // 用 yaml 库读卷内凭据（与 DSH credentials-local 同源解析，格式鲁棒）
  const credFile = '/dsh-home/.credentials.yaml'
  if (yaml && existsSync(credFile)) {
    try {
      const { readFileSync } = await import('node:fs')
      const doc = yaml.parseDocument(readFileSync(credFile, 'utf8'))
      const value = doc.get(credentialRef)
      if (typeof value === 'string' && value.trim() !== '') {
        apiKey = value.trim()
        keySource = 'volume'
      }
    } catch {
      // 解析失败按无 key 处理（错误信息会提示）
    }
  }
}

/** 未带鉴权时的提示（帮助区分"没 key"和"key 无效"） */
const NO_KEY_HINT =
  '（未找到已保存的 API Key：请先在"模型配置"里保存 API Key，或在探测前在输入框中填写）'

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 10_000)
try {
  const headers = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const url = baseURL.replace(/\/+$/, '') + '/models'
  const res = await fetch(url, { headers, signal: controller.signal })
  if (!res.ok) {
    console.log(JSON.stringify({ error: `HTTP ${res.status}${keySource === 'none' ? NO_KEY_HINT : ''}` }))
  } else {
    const data = await res.json()
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => ({
        id: String(m?.id ?? '').trim(),
        name: typeof m?.name === 'string' && m.name.trim() ? m.name.trim() : String(m?.id ?? '').trim(),
      }))
      .filter((m) => m.id.length > 0)
    console.log(JSON.stringify({ models }))
  }
} catch (e) {
  console.log(
    JSON.stringify({
      error: e?.name === 'AbortError' ? '请求超时（10s）' : String(e?.message ?? e),
    }),
  )
} finally {
  clearTimeout(timer)
}
