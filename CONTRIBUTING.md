# Contributing to MusicDedup

感谢你愿意为 MusicDedup 贡献！请先花两分钟阅读以下约定。

## 环境准备

- Node.js ≥ 18，本项目为 ESM（`"type": "module"`）
- `npm install` 后 `npm run electron` 启动开发客户端
- ⚠️ 本机若存在全局 `ELECTRON_RUN_AS_NODE` 环境变量，Electron 会退化为纯 Node 模式（无 GUI）——[scripts/run-electron.mjs](scripts/run-electron.mjs) 会自动清除，请勿手动设置该变量

## 如何反馈 Bug / 建议功能

请在 GitHub Issues 提交，**一个 issue 只描述一个问题**，并尽量附上：

- **Bug**：复现步骤、期望行为 vs 实际行为、主进程日志（`npm run electron` 终端输出）、涉及的示例文件路径/文件名。请使用 [Bug 模板](.github/ISSUE_TEMPLATE/bug_report.md)。
- **功能**：使用场景与期望行为。请使用 [Feature 模板](.github/ISSUE_TEMPLATE/feature_request.md)。

## 提交代码

1. 从 `main` 或当前工作分支新建分支：`git checkout -b fix/xxx` 或 `feat/xxx`
2. 遵循 **Conventional Commits** 格式：
   - `feat:` 新功能
   - `fix:` 缺陷修复（正文说明根因）
   - `refactor:` 重构（行为不变）
   - `perf:` 性能优化
   - `docs:` 文档
   - `chore:` 杂项
3. 变更请**尽量附带回归验证**：涉及核心逻辑（匹配/保留/刮削/DB）运行 `npm run smoke` 与 `npm run p0:verify`，两者需全绿。
4. 提交信息用中文描述主体，示例：`fix: 匹配阶段让出事件循环消除扫描未响应`

## 构建与自测

```bash
npm run electron       # 启动开发客户端
npm run smoke          # 真实库全链路自测（IPC/流式/渲染/图标）
npm run p0:verify      # 核心技术栈回归（WASM 库/标签写入/声纹/流式）
npm run build:win      # 打包 Windows NSIS + 便携版
npm run smoke:packaged # 打包版冒烟
```

## 代码约定

- 命名沿用现有风格：业务模块深实现小接口，按域拆分（`lib/db/*`、`electron/ipc/*`）
- 单文件行数建议 < 400（深模块如 `lib/matcher.js` 可例外）
- 阈值、tier 等领域常量收敛到单一出处（`lib/constants.js`、`lib/tier.js`），不要散布裸字面量
- 不引入新的原生依赖（当前 SQLite 走 WASM，纯 JS 标签写入是特性，请保持）

## License

参与贡献即表示你同意你的代码以 [MIT](LICENSE) 协议发布。
