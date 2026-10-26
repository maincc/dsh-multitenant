process.env.DSH_STORAGE_PROVIDER = 'mongodb'
import https from 'node:https'
import crypto from 'node:crypto'
const { credentialService, _unshelfCredentialForTest } =
  await import('../src/services/credential.service.js')
await credentialService.init()
const canon = 'jh7Gc6hGpu7kj9sytaUPFHoV6dwEYU3P9y'
const subs = [
  'jndwretndumoqbt2uauclmfmx7xbqjykva',
  'jexptitle000000000000000000000000',
  'jexpownm000000000000000000000000',
  'jexpownc000000000000000000000000',
]
const read = () =>
  new Promise((res) => {
    const h = crypto.createHash('sha256').update(canon, 'utf8').digest('hex')
    const file =
      '/' +
      h.slice(0, 2) +
      '/' +
      h.slice(2, 4) +
      '/' +
      canon +
      '/shared/did:swtc:' +
      canon +
      '.json'
    const body = JSON.stringify({ file })
    const q = https.request(
      {
        hostname: 'ipfsserver.ccda.ooo',
        path: '/v0/api/ipfs/shared/files/read',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 9000,
      },
      (r) => {
        let t = ''
        r.on('data', (d) => (t += d))
        r.on('end', () => {
          try {
            res(JSON.parse(t).credentials?.length ?? 0)
          } catch {
            res(-1)
          }
        })
      },
    )
    q.on('error', () => res(-1))
    q.write(body)
    q.end()
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let round = 1; round <= 4; round++) {
  const n = await read()
  console.log(`第${round}轮开始：货架 ${n} 张`)
  if (n === 0) break
  for (const s of subs) {
    const r = await _unshelfCredentialForTest(s).catch(() => false)
    if (r !== true) await sleep(3000)
  }
  await sleep(12000)
}
console.log('终态：货架', await read(), '张')
