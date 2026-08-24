import { afterEach, describe, expect, it, vi } from 'vitest'
import { Keypairs } from '@swtc/keypairs'
import { tenantConfigService } from '../src/services/tenant-config.service.js'

/** 生成一个模拟"用户钱包"的密钥对（与 CCDAO 插件同库） */
function makeWallet() {
  const seed = Keypairs.generateSeed({ algorithm: 'ed25519' })
  const kp = Keypairs.deriveKeypair(seed)
  return {
    address: Keypairs.deriveAddress(kp.publicKey).toLowerCase(),
    publicKey: kp.publicKey,
    sign: (msg) => Keypairs.sign(msg, kp.privateKey),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('租户密钥配置（钱包签名验证）', () => {
  it('挑战是一次性的（用后即焚）', () => {
    const { address } = makeWallet()
    const nonce = tenantConfigService.issueChallenge(address)
    expect(typeof nonce).toBe('string')
    expect(nonce.length).toBe(64) // 32 字节 hex
    expect(tenantConfigService.consumeChallenge(address, nonce)).toBe(true)
    expect(tenantConfigService.consumeChallenge(address, nonce)).toBe(false) // 重放被拒
  })

  it('挑战 5 分钟后过期', () => {
    vi.useFakeTimers()
    const { address } = makeWallet()
    const nonce = tenantConfigService.issueChallenge(address)
    vi.setSystemTime(Date.now() + 6 * 60 * 1000) // 拨快 6 分钟
    expect(tenantConfigService.consumeChallenge(address, nonce)).toBe(false)
  })

  it('验签：合法签名 + 公钥推导地址匹配则通过', () => {
    const wallet = makeWallet()
    const nonce = tenantConfigService.issueChallenge(wallet.address)
    const signature = wallet.sign(nonce)
    expect(
      tenantConfigService.verifySignature(wallet.address, nonce, signature, wallet.publicKey),
    ).toBe(true)
  })

  it('验签：地址不匹配则拒绝', () => {
    const wallet = makeWallet()
    const other = makeWallet()
    const nonce = tenantConfigService.issueChallenge(wallet.address)
    const signature = wallet.sign(nonce)
    expect(
      tenantConfigService.verifySignature(other.address, nonce, signature, wallet.publicKey),
    ).toBe(false)
  })

  it('验签：签名被篡改则拒绝', () => {
    const wallet = makeWallet()
    const nonce = tenantConfigService.issueChallenge(wallet.address)
    const signature = wallet.sign(nonce)
    const tampered = signature.slice(0, -2) + (signature.endsWith('00') ? '01' : '00')
    expect(
      tenantConfigService.verifySignature(wallet.address, nonce, tampered, wallet.publicKey),
    ).toBe(false)
  })

  it('验签：公钥非法格式则拒绝（不抛异常）', () => {
    const wallet = makeWallet()
    const nonce = tenantConfigService.issueChallenge(wallet.address)
    const signature = wallet.sign(nonce)
    expect(tenantConfigService.verifySignature(wallet.address, nonce, signature, 'not-a-key')).toBe(
      false,
    )
  })

  it('configure 拒绝未领取/已消费的挑战', async () => {
    const wallet = makeWallet()
    await expect(
      tenantConfigService.configure(wallet.address, {
        nonce: 'deadbeef'.repeat(8),
        signature: '',
        publicKey: wallet.publicKey,
        apiKey: 'sk-test',
      }),
    ).rejects.toThrow(/挑战/)
  })
})

describe('模型配置（settings.yaml）', () => {
  const ADDR = 'jndwretndumoqbt2uauclmfmx7xbqjykva'

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('normalizeModelConfig', () => {
    it('合法输入：规范化 baseURL 并保留 models 字段', () => {
      const out = tenantConfigService.normalizeModelConfig({
        baseURL: ' https://gw.example.com/v1/ ',
        models: [{ id: 'm1', name: 'M1', contextWindow: 128000, maxTokens: 8192 }],
      })
      expect(out).toEqual({
        baseURL: 'https://gw.example.com/v1',
        models: [{ id: 'm1', name: 'M1', contextWindow: 128000, maxTokens: 8192 }],
      })
    })

    it('baseURL 空串 = 删除字段（回官方端点）', () => {
      expect(tenantConfigService.normalizeModelConfig({ baseURL: '  ' })).toEqual({ baseURL: '' })
    })

    it('非法协议 baseURL 拒绝', () => {
      expect(() => tenantConfigService.normalizeModelConfig({ baseURL: 'ftp://x' })).toThrow(/http/)
    })

    it('模型 id 重复拒绝', () => {
      expect(() =>
        tenantConfigService.normalizeModelConfig({ models: [{ id: 'a' }, { id: 'a' }] }),
      ).toThrow(/重复/)
    })

    it('模型 id 缺失拒绝', () => {
      expect(() =>
        tenantConfigService.normalizeModelConfig({ models: [{ name: 'no-id' }] }),
      ).toThrow(/id/)
    })

    it('非法 contextWindow 拒绝', () => {
      expect(() =>
        tenantConfigService.normalizeModelConfig({ models: [{ id: 'a', contextWindow: 0 }] }),
      ).toThrow(/contextWindow/)
    })

    it('非法 maxTokens 拒绝', () => {
      expect(() =>
        tenantConfigService.normalizeModelConfig({ models: [{ id: 'a', maxTokens: -1 }] }),
      ).toThrow(/maxTokens/)
    })

    it('空数组 models = 删除字段（回默认模型）', () => {
      expect(tenantConfigService.normalizeModelConfig({ models: [] })).toEqual({ models: [] })
    })
  })

  describe('configure 扩展', () => {
    it('无任何字段时拒绝（不触发 docker）', async () => {
      vi.spyOn(tenantConfigService, 'verifySignature').mockReturnValue(true)
      const nonce = tenantConfigService.issueChallenge(ADDR) // 真挑战
      await expect(
        tenantConfigService.configure(ADDR, { nonce, signature: 'x', publicKey: 'x' }),
      ).rejects.toThrow(/没有可配置/)
    })

    it('apiKey 空串但提供 baseURL 时跳过 key 写入（mock docker）', async () => {
      const spy = vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue('written')
      vi.spyOn(tenantConfigService, 'verifySignature').mockReturnValue(true)
      const nonce = tenantConfigService.issueChallenge(ADDR) // 真挑战
      await tenantConfigService.configure(ADDR, {
        nonce,
        signature: 'dummy',
        publicKey: 'dummy',
        apiKey: '',
        baseURL: 'https://gw.example.com',
      })
      expect(spy).toHaveBeenCalledTimes(1)
      const [addr, script, scriptArgs] = spy.mock.calls[0]
      expect(addr).toBe(ADDR)
      expect(script).toBe('merge-settings.mjs')
      expect(JSON.parse(scriptArgs[2])).toEqual({ baseURL: 'https://gw.example.com' })
    })

    it('discoverWithAuth 未领挑战拒绝（不触发 docker）', async () => {
      await expect(
        tenantConfigService.discoverWithAuth(ADDR, {
          nonce: 'x'.repeat(64),
          signature: 's',
          publicKey: 'p',
          baseURL: 'https://x.com',
        }),
      ).rejects.toThrow(/挑战/)
    })

    it('getStatus 解析各脚本输出（mock docker）', async () => {
      vi.spyOn(tenantConfigService, 'runScript').mockImplementation((addr, script, args) => {
        if (script.includes('merge-credentials')) {
          return Promise.resolve(JSON.stringify(['DEEPSEEK_API_KEY', 'CUSTOM_1_API_KEY']))
        }
        if (args?.[2] === 'llm-pi-ai') {
          return Promise.resolve(
            JSON.stringify({
              providers: {
                'custom-1': {
                  api: 'openai-completions',
                  displayName: '我的网关',
                  baseURL: 'https://gw.example.com',
                  apiKeyEnv: 'CUSTOM_1_API_KEY',
                },
              },
            }),
          )
        }
        return Promise.resolve(
          JSON.stringify({
            baseURL: 'https://gw.example.com',
            models: [{ id: 'm1', name: 'M1' }],
          }),
        )
      })
      const status = await tenantConfigService.getStatus(ADDR)
      expect(status).toEqual({
        apiKeyConfigured: true,
        baseURL: 'https://gw.example.com',
        models: [{ id: 'm1', name: 'M1' }],
        providers: [
          {
            route: 'custom-1',
            displayName: '我的网关',
            baseURL: 'https://gw.example.com',
            models: [],
            apiKeyEnv: 'CUSTOM_1_API_KEY',
            keyConfigured: true,
          },
        ],
      })
    })

    it('normalizeProviders 校验：非法 baseURL 拒绝', () => {
      expect(() =>
        tenantConfigService.normalizeProviders([{ displayName: 'x', baseURL: 'ftp://x' }]),
      ).toThrow(/http/)
    })

    it('normalizeProviders 校验：显示名缺失拒绝', () => {
      expect(() => tenantConfigService.normalizeProviders([{ baseURL: 'https://x.com' }])).toThrow(
        /显示名/,
      )
    })

    it('normalizeProviders 校验：route 格式拒绝', () => {
      expect(() =>
        tenantConfigService.normalizeProviders([
          { route: 'BAD ROUTE!', displayName: 'x', baseURL: 'https://x.com' },
        ]),
      ).toThrow(/route/)
    })

    it('setProviders 全量语义：新增/更新/删除（mock docker）', async () => {
      const spy = vi
        .spyOn(tenantConfigService, 'runScript')
        .mockImplementation((addr, script, args) => {
          if (script.includes('merge-credentials')) return Promise.resolve('absent')
          return Promise.resolve('{}')
        })
      const result = await tenantConfigService.setProviders(ADDR, [
        { displayName: '网关A', baseURL: 'https://a.example.com', apiKey: 'sk-a' },
        {
          route: 'custom-1',
          displayName: '网关B',
          baseURL: 'https://b.example.com',
          models: [{ id: 'm1' }],
        },
      ])
      expect(result.routes).toHaveLength(2)
      // settings set 调用：第二个参数是 JSON payload
      const settingsCall = spy.mock.calls.find(
        ([, script, args]) => script === 'merge-settings.mjs' && args[0] === 'set',
      )
      expect(settingsCall).toBeTruthy()
      const payload = JSON.parse(settingsCall[2][2])
      const routes = Object.keys(payload.providers)
      expect(routes).toContain('custom-1')
      // 新建的 route 自动分配
      const newRoute = routes.find((r) => r !== 'custom-1')
      expect(newRoute).toMatch(/^custom-/)
      expect(payload.providers['custom-1'].api).toBe('openai-completions')
      expect(payload.providers['custom-1'].apiKeyEnv).toBe('CUSTOM_1_API_KEY')
      // credentials 写入：新 provider 的 key
      const credCalls = spy.mock.calls.filter(([, script]) => script.includes('merge-credentials'))
      expect(credCalls.length).toBeGreaterThanOrEqual(1)
      expect(credCalls[0][2][0]).toBe('set')
    })

    it('setProviders 全量语义：移除的 route 被标记删除并清 key', async () => {
      vi.spyOn(tenantConfigService, 'readProvidersMap').mockResolvedValue({
        'custom-old': { apiKeyEnv: 'CUSTOM_OLD_API_KEY' },
      })
      const spy = vi
        .spyOn(tenantConfigService, 'runScript')
        .mockImplementation((addr, script, args) => {
          if (script.includes('merge-credentials')) return Promise.resolve('absent')
          return Promise.resolve('{}')
        })
      await tenantConfigService.setProviders(ADDR, [
        { displayName: '保留的', baseURL: 'https://keep.example.com' },
      ])
      const settingsCall = spy.mock.calls.find(
        ([, script, args]) => script === 'merge-settings.mjs' && args[0] === 'set',
      )
      const payload = JSON.parse(settingsCall[2][2])
      expect(payload.providers['custom-old']).toBeNull()
      // 清 key 调用：CUSTOM_OLD_API_KEY 的 del
      const delCalls = spy.mock.calls.filter(
        ([, script, args]) =>
          script.includes('merge-credentials') &&
          args[0] === 'del' &&
          args[2] === 'CUSTOM_OLD_API_KEY',
      )
      expect(delCalls.length).toBe(1)
    })

    it('clear：scope=official-key 只删官方 key（不删 settings 段）', async () => {
      const spy = vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue('deleted')
      vi.spyOn(tenantConfigService, 'verifySignature').mockReturnValue(true)
      const nonce = tenantConfigService.issueChallenge(ADDR)
      await tenantConfigService.clear(ADDR, {
        nonce,
        signature: 'x',
        publicKey: 'x',
        scope: 'official-key',
      })
      // 只调 merge-credentials del；不调 merge-settings
      const settingsCalls = spy.mock.calls.filter(([, script]) => script === 'merge-settings.mjs')
      expect(settingsCalls).toHaveLength(0)
      const credCalls = spy.mock.calls.filter(([, script]) => script.includes('merge-credentials'))
      expect(credCalls).toHaveLength(1)
      expect(credCalls[0][2][0]).toBe('del')
      expect(credCalls[0][2][2]).toBe('DEEPSEEK_API_KEY')
    })

    it('clear：默认 scope 清官方 key + settings 段 + 自定义 provider 的 key', async () => {
      vi.spyOn(tenantConfigService, 'readProvidersMap').mockResolvedValue({
        'custom-1': { apiKeyEnv: 'CUSTOM_1_API_KEY' },
      })
      const spy = vi.spyOn(tenantConfigService, 'runScript').mockResolvedValue('deleted')
      vi.spyOn(tenantConfigService, 'verifySignature').mockReturnValue(true)
      const nonce = tenantConfigService.issueChallenge(ADDR)
      await tenantConfigService.clear(ADDR, { nonce, signature: 'x', publicKey: 'x' })
      const settingsCalls = spy.mock.calls.filter(([, script]) => script === 'merge-settings.mjs')
      expect(settingsCalls).toHaveLength(1)
      expect(settingsCalls[0][2][0]).toBe('del')
      const delRefs = spy.mock.calls
        .filter(([, script, args]) => script.includes('merge-credentials') && args[0] === 'del')
        .map(([, , args]) => args[2])
      expect(delRefs).toContain('DEEPSEEK_API_KEY')
      expect(delRefs).toContain('CUSTOM_1_API_KEY')
    })
  })
})
