/**
 * RESOURCE_EXHAUSTED（F1 等待队列）202 响应的统一组装。
 *
 * 为什么单独成文件：/connect（tenant.routes，浏览器门禁跳转）与
 * /api/cwt/gateway-enter（user.routes，CWT 出示）两条进入链共用同一句
 * 排队话术；2026-09 查重时这里已发现两处手抄近似代码（我加 failedResources
 * 时亲手贴成了第二处）。话术/字段以后只会一起演进，单源是唯一正确姿势。
 */

const LABELS = { ports: '端口', memory: '内存', disk: '磁盘空间', containers: '容器数量' }

/**
 * 把 ensureContainer 抛出的 RESOURCE_EXHAUSTED 错误转成给前端的 202 载荷。
 * err.failedResources（预检缺项 key 数组）翻成人话；无信息时退回通用文案。
 *
 * @param {{queuePosition?: number, failedResources?: string[]}} err
 */
export function resourceExhaustedPayload(err) {
  const reasons = (err?.failedResources || []).map((k) => LABELS[k] || k)
  return {
    error: reasons.length ? `资源不足：${reasons.join('、')}` : '资源不足，请等待',
    code: 'RESOURCE_EXHAUSTED',
    queuePosition: err?.queuePosition,
    failedResources: err?.failedResources || [],
    message: reasons.length
      ? `系统${reasons.join('、')}不足，您已进入等待队列，资源释放后将自动为您创建容器`
      : '系统资源不足，您已进入等待队列，资源释放后将自动为您创建容器',
  }
}
