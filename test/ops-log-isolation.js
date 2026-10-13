/**
 * 测试卫生：把 dataService.dataDir 临时换到 mkdtemp 目录，afterAll 还原并清理。
 *
 * 背景：ops 留痕（logOperation）的 json 分支出口就是 dataDir——真实链路测试
 * （skill/cwt/cleanup/usage-limit 等）跑到成功路径会追加 operations.log。
 * 逐个文件 spy 是追着问题跑；把"写"引到临时目录才是收口（json 模式回归锁
 * meta-singleton 自己管临时目录，与本 helper 无关）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function isolateOpsLog(dataService) {
  let saved = null
  let dir = null
  beforeAll(() => {
    saved = dataService.dataDir
    dir = mkdtempSync(join(tmpdir(), 'dsh-opslog-'))
    dataService.dataDir = dir
  })
  afterAll(() => {
    dataService.dataDir = saved
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
}
