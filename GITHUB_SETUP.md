# GitHub 远程仓库配置指引

## 第一步：创建 GitHub 仓库

1. 访问 https://github.com/new
2. 填写仓库信息：
   - **Repository name**: `dsh-multitenant`
   - **Description**: `DSH 多租户管理系统 - 基于 SWTC 地址的智能容器分配`
   - **Visibility**: Public 或 Private（根据需要）
   - ❌ 不要勾选 "Add a README file"（我们已有）
   -  不要勾选 "Add .gitignore"（我们已有）
   - ❌ 不要勾选 "Choose a license"（我们已有）
3. 点击 "Create repository"

## 第二步：配置 Git 用户信息（可选）

```bash
# 设置全局用户名和邮箱
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"

# 或者仅为此项目设置
git config user.name "Your Name"
git config user.email "your.email@example.com"
```

## 第三步：添加远程仓库

```bash
# 添加远程仓库（替换 <your-username>）
git remote add origin https://github.com/<your-username>/dsh-multitenant.git

# 验证远程仓库
git remote -v
```

## 第四步：推送代码

```bash
# 推送 main 分支
git push -u origin main

# 如果需要强制推送（首次）
git push -u origin main --force
```

## 第五步：验证推送

访问你的 GitHub 仓库页面，确认文件已上传。

## 第六步：配置分支保护（推荐）

1. 进入仓库 Settings → Branches
2. 点击 "Add branch protection rule"
3. 填写分支名称：`main`
4. 勾选以下选项：
   - ✅ Require a pull request before merging
   - ✅ Require approvals (1)
   - ✅ Require status checks to pass before merging
   - ✅ Require branches to be up to date before merging
   - ✅ Include administrators
   - ✅ Allow force pushes (取消勾选)
   - ✅ Allow deletions (取消勾选)
5. 点击 "Create"

## 第七步：配置 GitHub Actions（可选）

创建 `.github/workflows/test.yml`：

```yaml
name: Tests

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v4
    
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '22'
    
    - name: Install dependencies
      run: |
        npm install
        cd frontend && npm install
    
    - name: Run tests
      run: npm test
    
    - name: Build frontend
      run: cd frontend && npm run build
```

## 常用命令

```bash
# 查看远程仓库
git remote -v

# 拉取最新代码
git pull origin main

# 推送代码
git push origin main

# 查看分支
git branch -a

# 创建新分支
git checkout -b feature/new-feature

# 合并分支
git merge feature/new-feature

# 删除远程分支
git push origin --delete feature/old-feature
```

## 注意事项

1. **敏感信息**：
   - `config.json` 已在 `.gitignore` 中
   - `state.json` 已在 `.gitignore` 中
   - `data/` 目录已在 `.gitignore` 中
   - 不要手动添加这些文件

2. **大文件**：
   - 如果有超过 100MB 的文件，使用 Git LFS
   - `git lfs install`
   - `git lfs track "*.tar.gz"`

3. **子模块**：
   - 如果需要引用其他仓库，使用 Git Submodules
   - `git submodule add <url> <path>`

## 问题排查

### 推送被拒绝

```bash
# 如果是首次推送
git push -u origin main --force

# 如果有冲突
git pull origin main --rebase
git push origin main
```

### 认证失败

```bash
# 使用 Personal Access Token
# 1. GitHub → Settings → Developer settings → Personal access tokens
# 2. 生成新 token（勾选 repo 权限）
# 3. 推送时使用 token 作为密码

git remote set-url origin https://<token>@github.com/<username>/dsh-multitenant.git
```

### Hook 未执行

```bash
# 重新安装 hooks
npm run prepare

# 或手动设置
chmod +x .git/hooks/pre-push
```

## 完成！

现在你的项目已经：
- ✅ 本地 Git 仓库初始化
- ✅ 代码格式化钩子配置
- ✅ 测试自动化配置
- ✅ 文档完善
- ✅ 准备推送到 GitHub

祝开发顺利！🎉
