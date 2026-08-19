# 贡献指南

感谢你对 DSH 多租户管理系统的关注！我们欢迎所有形式的贡献。

## 🚀 快速开始

### 1. Fork 仓库

点击 GitHub 页面右上角的 "Fork" 按钮。

### 2. 克隆仓库

```bash
git clone https://github.com/<your-username>/dsh-multitenant.git
cd dsh-multitenant
```

### 3. 安装依赖

```bash
npm install
cd frontend && npm install && cd ..
```

### 4. 创建分支

```bash
git checkout -b feature/your-feature-name
# 或
git checkout -b bugfix/your-bugfix-name
```

## 📝 提交规范

我们使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type 类型

- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式（不影响逻辑）
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

### Scope 范围

- `config`: 配置模块
- `service`: 服务层
- `route`: 路由层
- `middleware`: 中间件
- `utils`: 工具函数
- `frontend`: 前端
- `docker`: Docker 相关

### 示例

```
feat(service): 添加 UserService 用户管理模块

- 实现用户容器生命周期管理
- 支持自动清理空闲容器
- 添加资源监控和自动扩容

Closes #123
```

##  测试

提交前请确保所有测试通过：

```bash
npm test
```

## 🎨 代码格式

我们使用 Prettier 进行代码格式化。提交前会自动格式化：

```bash
npm run format
```

## 📤 提交 PR

1. 确保代码通过所有测试
2. 确保代码已格式化
3. 更新相关文档
4. 提交 Pull Request 到 `main` 分支

## 🐛 报告 Bug

请使用 GitHub Issues 报告 Bug，并提供：

- 问题描述
- 复现步骤
- 预期行为
- 实际行为
- 环境信息（Node.js 版本、操作系统等）

## 💡 功能请求

欢迎提出功能请求，请说明：

- 功能描述
- 使用场景
- 预期效果

## 📄 许可证

本项目使用 MIT 许可证。
