#!/usr/bin/env node
/**
 * 设置 Git Hooks
 * 在 npm install 时自动运行
 */

import { writeFileSync, chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const HOOKS_DIR = join(ROOT, '.git', 'hooks')

// 确保 .git/hooks 目录存在
if (!existsSync(HOOKS_DIR)) {
  console.log('[hooks] .git directory not found, skipping hook setup')
  process.exit(0)
}

// pre-commit hook 内容
const preCommitHook = `#!/usr/bin/env bash
# ============================================================================
#  Git Pre-Commit Hook
#  在 git commit 时自动运行代码格式化和检查
# ============================================================================

set -e

echo "🎨 Running code format check..."

# 运行 prettier 格式化暂存区的文件
npx prettier --write $(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(js|vue|json|md|css)$' || true)

# 如果有文件被格式化，重新添加到暂存区
if ! git diff --cached --quiet; then
  echo "✅ Code formatted, re-staging files..."
  git add $(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(js|vue|json|md|css)$' || true)
fi

# 运行测试
echo "🧪 Running tests..."
npm test

echo "✅ All checks passed!"
exit 0
`

// 写入 hook 文件
const hookFile = join(HOOKS_DIR, 'pre-commit')
writeFileSync(hookFile, preCommitHook)
chmodSync(hookFile, 0o755)

// 删除旧的 pre-push hook（如果存在）
const oldHookFile = join(HOOKS_DIR, 'pre-push')
if (existsSync(oldHookFile)) {
  unlinkSync(oldHookFile)
  console.log('[hooks] 🗑️  Removed old pre-push hook')
}

console.log('[hooks] ✅ pre-commit hook installed')
console.log('[hooks]    - Auto-format code with Prettier (staged files only)')
console.log('[hooks]    - Run tests before commit')
console.log('[hooks]    - Block commit if tests fail')
