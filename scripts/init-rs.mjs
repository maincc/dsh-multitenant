import { MongoClient } from 'mongodb'

const PORT = 27018
const RS_NAME = 'dsh-rs'
const URI = `mongodb://127.0.0.1:${PORT}/?replicaSet=${RS_NAME}`

async function initReplicaSet() {
  const client = new MongoClient(URI)

  try {
    await client.connect()
    console.log('已连接到 MongoDB')

    const admin = client.db().admin()

    // 检查副本集状态
    try {
      const status = await admin.command({ replSetGetStatus: 1 })
      console.log('副本集已初始化:', status.set)
      return
    } catch (e) {
      if (e.codeName !== 'NotYetInitialized') {
        throw e
      }
    }

    // 初始化副本集
    console.log('初始化副本集...')
    await admin.command({
      replSetInitiate: {
        _id: RS_NAME,
        members: [{ _id: 0, host: `127.0.0.1:${PORT}` }],
      },
    })

    console.log('✓ 副本集初始化成功')

    // 等待 PRIMARY
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const status = await admin.command({ replSetGetStatus: 1 })
        if (status.myState === 1) {
          console.log('✓ PRIMARY 就绪')
          return
        }
      } catch (e) {
        // 继续等待
      }
    }

    console.log('⚠ 等待 PRIMARY 超时')
  } finally {
    await client.close()
  }
}

initReplicaSet().catch((e) => {
  console.error('初始化失败:', e)
  process.exit(1)
})
