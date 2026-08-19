#!/usr/bin/env node
/**
 * 设置 Git Hooks
 * 在 npm install 时自动运行
 */

import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const HOOKS_DIR = join(ROOT, '.git', 'hooks')

// 确保 .git/hooks 目录存在
if (!existsSync(HOOKS_DIR)) {
  console.log('[hooks] .git directory not found, skipping hook setup')
  process.exit(0)
}

// pre-push hook 内容
const prePushHook = `#!/usr/bin/env bash
# ============================================================================
#  Git Pre-Push Hook
#  在 git push 时自动运行代码格式化和检查
# ============================================================================

set -e

echo " Running code format check..."

# 运行 prettier 格式化
npm run format

# 检查是否有未提交的更改
if ! git diff --quiet; then
  echo ""
  echo "⚠️  Code was formatted. Please commit the changes before pushing."
  echo ""
  echo "Run: git add . && git commit -m 'style: auto-format code'"
  echo ""
  exit 1
fi

# 运行测试
echo " Running tests..."
npm test

echo "✅ All checks passed!"
exit 0
`

// 写入 hook 文件
const hookFile = join(HOOKS_DIR, 'pre-push')
writeFileSync(hookFile, prePushHook)
chmodSync(hookFile, 0o755)

console.log('[hooks] ✅ pre-push hook installed')
console.log('[hooks]    - Auto-format code with Prettier')
console.log('[hooks]    - Run tests before push')
console.log('[hooks]    - Block push if there are uncommitted changes')
