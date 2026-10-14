/**
 * 真库测试的 URI 工厂：基址来自 globalSetup 注入的 DSH_TEST_MONGO
 * （复用人工 27018 或自动临时副本集；缺失时给死地址——优雅跳过兜底）。
 * 每个文件传自己的隔离库名，互不串库。
 */
export function mongoTestUri(db) {
  const base = process.env.DSH_TEST_MONGO || 'mongodb://127.0.0.1:1/?replicaSet=none'
  const u = new URL(base)
  u.pathname = '/' + db
  return u.toString()
}
