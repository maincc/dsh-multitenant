/**
 * DSH 镜像相关 docker 方法测试
 *
 * 覆盖：
 *   - imageDshVersion：读 /usr/local/share/dsh-version（旧镜像无文件 → null）
 *   - imageId / containerImageId：参数与失败降级
 *   - buildImage：--build-arg DSH_VERSION 传参、确切版本打双重 tag、
 *                 构建超时远大于默认（编译 node-pty 需要）
 *   - listLocalVersionTags：解析 docker image ls 输出
 *
 * 隔离：mock node:child_process 的 execFile，不执行真实 docker。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { execFile } from 'node:child_process'
import {
  dockerService,
  VERSION_PROBE_CMD,
  clearDshVersionCache,
} from '../src/services/docker.service.js'

const lastArgs = () => execFile.mock.calls.at(-1)?.[1] ?? []
const lastOpts = () => execFile.mock.calls.at(-1)?.[2] ?? {}
const allArgs = () => execFile.mock.calls.map((c) => c[1])

beforeEach(() => {
  execFile.mockReset()
  execFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'ok\n', ''))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('imageDshVersion', () => {
  it('读取镜像内烘焙的真实版本（权威值）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '0.1.5-rc.1\n', ''))

    const version = await dockerService.imageDshVersion()

    expect(version).toBe('0.1.5-rc.1')
    // 改为 sh -c：单条命令内先读版本文件、再回退读 package.json
    expect(lastArgs().slice(0, 5)).toEqual([
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      expect.any(String),
    ])
    expect(lastArgs()[5]).toBe('-c')
  })

  it('回退命令覆盖旧镜像：先版本文件、再 package.json', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '0.1.1-rc.2\n', ''))

    await dockerService.imageDshVersion()

    // 旧镜像没有版本文件 → 必须能回退到包内 package.json，否则界面永远"未知"
    expect(VERSION_PROBE_CMD).toContain('/usr/local/share/dsh-version')
    expect(VERSION_PROBE_CMD).toContain('@deepseek-ai/dsh/package.json')
    expect(VERSION_PROBE_CMD).toContain('||')
    // 回退不依赖 node（镜像里一定有 sh，node 未必在 PATH）
    expect(VERSION_PROBE_CMD).not.toContain('node -p')
    // 且该命令确实被用在了 docker run 上（不是只定义没接线）
    expect(lastArgs()[6]).toBe(VERSION_PROBE_CMD)
  })

  it('多行输出只取第一行', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '0.1.5-rc.1\n0.1.1-rc.2\n', ''))

    await expect(dockerService.imageDshVersion()).resolves.toBe('0.1.5-rc.1')
  })

  it('镜像不存在/读不到 → null（不抛异常）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) =>
      cb(new Error('No such file or directory'), '', ''),
    )

    await expect(dockerService.imageDshVersion()).resolves.toBeNull()
  })

  it('空白输出 → null 而不是空串', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '   \n', ''))

    await expect(dockerService.imageDshVersion()).resolves.toBeNull()
  })
})

describe('imageId / containerImageId', () => {
  it('imageId 取 sha256 ID', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'sha256:abc123\n', ''))

    const id = await dockerService.imageId()

    expect(id).toBe('sha256:abc123')
    expect(lastArgs()).toEqual(['image', 'inspect', '--format', '{{.Id}}', expect.any(String)])
  })

  it('containerImageId 读容器创建时的镜像 ID', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'sha256:def456\n', ''))

    const id = await dockerService.containerImageId('dsh-swtc-jxxx')

    expect(id).toBe('sha256:def456')
    expect(lastArgs()).toEqual(['inspect', '--format', '{{.Image}}', 'dsh-swtc-jxxx'])
  })

  it('镜像/容器不存在 → null', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(new Error('No such image'), '', ''))
    clearDshVersionCache()

    await expect(dockerService.imageId()).resolves.toBeNull()
    await expect(dockerService.containerImageId('gone')).resolves.toBeNull()
  })
})

describe('containerDshVersion（容器实际安装的 DSH 版本）', () => {
  it('先读镜像 ID，再在容器内执行 dsh --version', async () => {
    clearDshVersionCache()
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'inspect') return cb(null, 'sha256:img1\n', '')
      if (args[0] === 'exec') return cb(null, '0.1.5-rc.1\n', '')
      return cb(new Error('unexpected'), '', '')
    })

    await expect(dockerService.containerDshVersion('dsh-swtc-jxxx')).resolves.toBe('0.1.5-rc.1')

    const execArgs = allArgs().find((a) => a[0] === 'exec')
    expect(execArgs).toEqual(['exec', 'dsh-swtc-jxxx', 'dsh', '--version'])
  })

  it('同一镜像只 exec 一次（管理面板刷新不会反复起子进程）', async () => {
    clearDshVersionCache()
    let execCount = 0
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'inspect') return cb(null, 'sha256:same\n', '')
      execCount++
      return cb(null, '0.1.5-rc.1\n', '')
    })

    await dockerService.containerDshVersion('a')
    await dockerService.containerDshVersion('b')
    await dockerService.containerDshVersion('c')

    expect(execCount).toBe(1)
  })

  it('并发调用合并为一次 exec', async () => {
    clearDshVersionCache()
    let execCount = 0
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'inspect') return cb(null, 'sha256:shared\n', '')
      execCount++
      setTimeout(() => cb(null, '0.1.6\n', ''), 10)
    })

    const [a, b] = await Promise.all([
      dockerService.containerDshVersion('a'),
      dockerService.containerDshVersion('b'),
    ])

    expect(a).toBe('0.1.6')
    expect(b).toBe('0.1.6')
    expect(execCount).toBe(1)
  })

  it('容器未运行（exec 失败）→ null，不抛', async () => {
    clearDshVersionCache()
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'inspect') return cb(null, 'sha256:img9\n', '')
      return cb(new Error('container is not running'), '', '')
    })

    await expect(dockerService.containerDshVersion('stopped')).resolves.toBeNull()
  })

  it('容器不存在 → null（不 exec）', async () => {
    clearDshVersionCache()
    let execCount = 0
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'inspect') return cb(new Error('No such container'), '', '')
      execCount++
      return cb(null, '0.1.5\n', '')
    })

    await expect(dockerService.containerDshVersion('gone')).resolves.toBeNull()
    expect(execCount).toBe(0)
  })
})

describe('buildImage', () => {
  it('传 --build-arg DSH_VERSION，且确切版本打双重 tag（回滚退路）', async () => {
    // 第一次 docker build 成功，随后读版本 + 读 imageId
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'build') return cb(null, 'built\n', '')
      if (args[0] === 'run') return cb(null, '0.1.5-rc.1\n', '')
      return cb(null, 'sha256:newimg\n', '')
    })

    const res = await dockerService.buildImage('0.1.5-rc.1')

    const buildArgs = allArgs().find((a) => a[0] === 'build')
    expect(buildArgs).toContain('--build-arg')
    expect(buildArgs).toContain('DSH_VERSION=0.1.5-rc.1')
    // 双重 tag：latest + 版本 tag
    expect(buildArgs.filter((a) => a === '-t')).toHaveLength(2)
    expect(buildArgs).toContain('dsh-multitenant:0.1.5-rc.1')

    expect(res.tag).toBe('dsh-multitenant:0.1.5-rc.1')
    expect(res.version).toBe('0.1.5-rc.1')
    expect(res.imageId).toBe('sha256:newimg')
  })

  it('latest 不打版本 tag（dsh-multitenant:latest 本身就是它）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'build') return cb(null, 'built\n', '')
      if (args[0] === 'run') return cb(null, '0.1.6-alpha.1\n', '')
      return cb(null, 'sha256:x\n', '')
    })

    const res = await dockerService.buildImage('latest')

    const buildArgs = allArgs().find((a) => a[0] === 'build')
    expect(buildArgs.filter((a) => a === '-t')).toHaveLength(1)
    expect(res.tag).toBeNull()
  })

  it('构建超时远大于默认 120s（要编译 node-pty，不能中途被掐死）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'build') return cb(null, '', '')
      if (args[0] === 'run') return cb(null, '0.1.5\n', '')
      return cb(null, 'sha256:x\n', '')
    })

    await dockerService.buildImage('0.1.5')

    const buildCall = execFile.mock.calls.find((c) => c[1][0] === 'build')
    expect(buildCall[2].timeout).toBeGreaterThanOrEqual(600000)
  })

  it('构建失败 → 向上抛出（不产出错版镜像）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args[0] === 'build') return cb(new Error('build failed: 版本不符'), '', '')
      return cb(null, '', '')
    })

    await expect(dockerService.buildImage('9.9.9')).rejects.toThrow(/build failed/)
  })
})

describe('listLocalVersionTags', () => {
  it('解析 docker image ls 输出为版本列表', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) =>
      cb(
        null,
        'dsh-multitenant:0.1.5-rc.1\tabc123\t2026-09-10 03:12:53 +0000 UTC\n' +
          'dsh-multitenant:latest\tdef456\t2026-09-15 03:23:13 +0000 UTC\n',
        '',
      ),
    )

    const tags = await dockerService.listLocalVersionTags()

    expect(tags).toHaveLength(2)
    expect(tags[0]).toMatchObject({
      tag: 'dsh-multitenant:0.1.5-rc.1',
      version: '0.1.5-rc.1',
      imageId: 'abc123',
    })
    expect(tags[1].version).toBe('latest')
  })

  it('docker 不可用 → 空数组（不抛）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(new Error('docker down'), '', ''))

    await expect(dockerService.listLocalVersionTags()).resolves.toEqual([])
  })
})
// ---------------------------------------------------------------------------
// 镜像清理相关：listImages / listReferencedImageIds / removeImages
//
// 关键约束：只用 `docker rmi <id>` 精确删除，**绝不** docker image prune ——
// 这台机器上还跑着其它项目的镜像，prune -a 会一起删掉且未必能重新拉回。
// ---------------------------------------------------------------------------
describe('listImages', () => {
  it('解析 docker images 输出并把体积字符串转为字节', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) =>
      cb(
        null,
        [
          'aaaa11112222|dsh-multitenant|<none>|1.22GB|2026-09-17 09:00:00 +0800 CST',
          'bbbb11112222|dsh-multitenant|0.1.5-rc.1|843MB|2026-09-17 09:00:00 +0800 CST',
        ].join('\n'),
        '',
      ),
    )

    const imgs = await dockerService.listImages()

    expect(imgs).toHaveLength(2)
    expect(imgs[0].id).toBe('aaaa11112222')
    expect(imgs[0].sizeBytes).toBe(Math.round(1.22 * 1024 ** 3))
    expect(imgs[1].tag).toBe('0.1.5-rc.1')
    expect(imgs[1].sizeBytes).toBe(843 * 1024 ** 2)
  })

  it('体积解析失败时返回 0 而不是抛错（体积只是展示信息）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) =>
      cb(null, 'aaaa11112222|dsh-multitenant|<none>|???|now', ''),
    )

    const imgs = await dockerService.listImages()

    expect(imgs[0].sizeBytes).toBe(0)
  })

  it('docker 失败 → 返回空数组（不抛）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(new Error('boom'), '', ''))

    await expect(dockerService.listImages()).resolves.toEqual([])
  })
})

describe('listReferencedImageIds', () => {
  it('逐个 inspect 容器拿真实镜像 ID（ps 的 {{.Image}} 会给名字，不能用）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args.includes('ps')) return cb(null, 'c1\nc2\n', '')
      if (args.includes('c1')) return cb(null, 'sha256:aaa\n', '')
      if (args.includes('c2')) return cb(null, 'sha256:bbb\n', '')
      return cb(null, '', '')
    })

    const refs = await dockerService.listReferencedImageIds()

    expect([...refs].sort()).toEqual(['sha256:aaa', 'sha256:bbb'])
    // 必须走 inspect，而不是 ps --format {{.Image}}
    expect(allArgs().some((a) => a.includes('inspect'))).toBe(true)
  })

  it('任一容器无法确认镜像 → 抛错（绝不静默漏掉一个引用）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args.includes('ps')) return cb(null, 'c1\n', '')
      return cb(new Error('inspect 失败'), '', '')
    })

    await expect(dockerService.listReferencedImageIds()).rejects.toThrow()
  })

  it('ps 本身失败 → 抛错（调用方据此保守处理）', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(new Error('boom'), '', ''))

    await expect(dockerService.listReferencedImageIds()).rejects.toThrow()
  })
})

describe('removeImages', () => {
  it('逐个精确删除，不使用 prune', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => cb(null, '', ''))

    const res = await dockerService.removeImages(['aaaa11112222'])

    expect(res.removed).toEqual(['aaaa11112222'])
    expect(lastArgs()).toEqual(['rmi', 'aaaa11112222'])
    // 绝不能出现 prune
    expect(allArgs().flat()).not.toContain('prune')
  })

  it('单个失败不影响其余，且失败原因被记录', async () => {
    execFile.mockImplementation((cmd, args, opts, cb) => {
      if (args?.[1] === 'bad') return cb(new Error('No such image'), '', '')
      return cb(null, '', '')
    })

    const res = await dockerService.removeImages(['good', 'bad'])

    expect(res.removed).toEqual(['good'])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].id).toBe('bad')
    expect(res.failed[0].error).toContain('No such image')
  })
})
