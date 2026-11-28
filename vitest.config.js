import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // 真库测试自管 mongod（复用 27018 或临时起）——见 globalSetup.mongo.mjs
    globalSetup: ['./test/globalSetup.mongo.mjs'],
    environment: 'node',
    // 15s 兜底：本机并行收集期负载重，5s 默认看门狗对【真连副本集】的重用例
    // （dropDatabase + 多轮事务回滚）临界误报——cleanup/dsh-capability/migration
    // 三处同源 flaky 实证（单独跑恒绿）。超时只是上限、不参与断言，提速机器无感。
    // 满载并行时 15s 预算会误杀真子进程/并发时序用例（merge-credentials、usage-limit 三复发）
    testTimeout: 45_000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.js'],
      exclude: ['src/server.js'],
    },
  },
})
