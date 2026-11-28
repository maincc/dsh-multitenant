/* v1.4 spike：平台 issuer.key 签发两种 VC → 本地 verifyCredential。跑通即钉死 issuer 链路。 */
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const {
  secp256k1,
} = require('/Users/cly/.dshWorkspace/dsh-multitenant/node_modules/@noble/curves/secp256k1.js')

const D = '/Users/cly/.dshWorkspace/dsh-multitenant/node_modules/@jccdex/did/'
const { issueCredential, verifyCredential } = require(D + 'lib/credential-sdk/credentials.js')
const Secp256k1Keypair = require(D + 'lib/credential-sdk/keypairs/keypair-secp256k1.js').default
const { createDocumentLoader, registerContextUrl } = require(D + 'lib/context-loader.js')

// PEM(SEC1) → 32B priv hex
function privFromPem(pem) {
  const b64 = pem
    .split('\n')
    .filter((l) => !l.startsWith('-----'))
    .join('')
  const der = Buffer.from(b64, 'base64')
  const i = der.indexOf(Buffer.from([0x04])) // 跳 SEQUENCE+INTEGER ver+priv 找 0x04? 不稳——用 crypto
  const k = require('node:crypto').createPrivateKey({ key: pem, format: 'pem' })
  const jwk = k.export({ format: 'jwk' })
  const hex = Buffer.from(jwk.d, 'base64url').toString('hex')
  return hex.padStart(64, '0')
}
const priv = privFromPem(
  fs.readFileSync('/Users/cly/.dshWorkspace/dsh-multitenant/data/keys/issuer.key', 'utf8'),
)
const pubHex = secp256k1.getPublicKey(priv, true)
console.log('priv末6:', priv.slice(-6), '| pubC:', Buffer.from(pubHex).toString('hex').slice(0, 16))

const profile = JSON.parse(
  fs.readFileSync('/Users/cly/.dshWorkspace/dsh-multitenant/data/keys/issuer-profile.json', 'utf8'),
)
const DID = profile.id
const vm = profile.verificationMethod[0]
const expectHex = '0x' + Buffer.from(pubHex).toString('hex')
console.log(
  '档案公钥匹配:',
  vm.publicKeyHex === expectHex ? '✅' : `❌ 档案${vm.publicKeyHex} 实${expectHex}`,
)

registerContextUrl(
  'https://w3id.org/security/suites/secp256k1-2019/v1',
  JSON.parse(
    fs.readFileSync(
      '/Users/cly/.dshWorkspace/dsh-multitenant/src/assets/secp256k1-2019-v1.json',
      'utf8',
    ),
  ),
)
const loader = createDocumentLoader()

const kp = new Secp256k1Keypair(Buffer.from(priv, 'hex'), 'private')
const keyDoc = {
  id: `${DID}#key-1`,
  controller: DID,
  type: Secp256k1Keypair.VerKeyType,
  keypair: kp,
}

const SUBJ_ADDR = 'jm2ktvxqnzhpvhwof2pgjhaltdwnzynv9v' // 测试 subject（小写 canonical）
const CTX = [
  'https://www.w3.org/2018/credentials/v1',
  {
    DshMemberCredential: 'urn:dshm-test:credential:DshMemberCredential',
    DshCwtCredential: 'urn:dshm-test:credential:DshCwtCredential',
    tier: 'urn:dshm-test:credential#tier',
    verifiedVia: 'urn:dshm-test:credential#verifiedVia',
    dailyMinutes: 'urn:dshm-test:credential#dailyMinutes',
    cwtGrant: 'urn:dshm-test:credential#cwtGrant',
  },
]
const rnd = () => Math.random().toString(36).slice(2, 10)

async function mint(kind) {
  const subject =
    kind === 'member'
      ? {
          id: `did:swtc:${SUBJ_ADDR}`,
          tier: 1,
          dailyMinutes: 120,
          verifiedVia: 'urn:dshm-test:auto-assign',
        }
      : {
          id: `did:swtc:${SUBJ_ADDR}`,
          tier: 1,
          cwtGrant: 'urn:dshm-test:legacy-import',
          verifiedVia: 'urn:dshm-test:cwt',
        }
  const descriptor = {
    '@context': CTX,
    id: `${DID}#credential-${kind}-${rnd()}`,
    type: ['VerifiableCredential', kind === 'member' ? 'DshMemberCredential' : 'DshCwtCredential'],
    issuer: DID,
    issuanceDate: new Date().toISOString(),
    expirationDate: new Date(Date.now() + 365 * 864e5).toISOString(),
    credentialSubject: subject,
  }
  return issueCredential(keyDoc, descriptor, true, loader, null, undefined, null, true, 'jsonld')
}

// resolver 壳：issuer 公钥从本地档案取（外部验证方等价物）
const fakeLoader = async (url) => {
  if (url === DID || url === `${DID}#key-1`) {
    return { context: undefined, document: profile, documentUrl: DID }
  }
  return loader(url)
}

;(async () => {
  for (const kind of ['member', 'cwt']) {
    const vc = await mint(kind)
    console.log(
      `\n[${kind}] VC id=${vc.id}\n  proof.type=${vc.proof.type} jws头=${(vc.proof.jws || '').split('.')[0].slice(0, 30)}…`,
    )
    const v = await verifyCredential(vc, { documentLoader: fakeLoader, compactProof: true })
    console.log(
      `  verify: ${v.verified ? '✅ verified' : '❌ ' + JSON.stringify(v.errors ?? v).slice(0, 160)}`,
    )
  }
})().catch((e) => {
  console.error('SPIKE FAIL', String(e.stack || e.message).slice(0, 500))
  process.exit(1)
})
