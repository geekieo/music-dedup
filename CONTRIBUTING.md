# Contributing to MusicDedup

## 环境

- Node.js ≥ 18，本项目为 ESM（`"type": "module"`）
- `npm install` 后 `npm run electron` 启动开发客户端
- 若存在全局 `ELECTRON_RUN_AS_NODE` 环境变量，Electron 会退化为纯 Node 模式（无 GUI）——[scripts/run-electron.mjs](scripts/run-electron.mjs) 会自动清除，请勿手动设置
- 跨平台：Windows 10/11（macOS/Linux 代码就位，未经实机验证）

## 反馈 Bug / 建议功能

在 GitHub Issues 提交，一个 issue 只描述一个问题：

- **Bug**：复现步骤、期望行为 vs 实际行为、主进程日志（`npm run electron` 终端输出）、示例文件路径。请使用 [Bug 模板](.github/ISSUE_TEMPLATE/bug_report.md)。
- **功能**：使用场景与期望行为。请使用 [Feature 模板](.github/ISSUE_TEMPLATE/feature_request.md)。

## 提交代码

1. 新建分支：`git checkout -b fix/xxx` 或 `feat/xxx`
2. 遵循 **Conventional Commits** 格式：
   - `feat:` 新功能
   - `fix:` 缺陷修复（正文说明根因）
   - `refactor:` 重构（行为不变）
   - `perf:` 性能优化
   - `docs:` 文档
   - `chore:` 杂项
3. 改动最小化，只包含解决该问题的修改。
4. 涉及核心逻辑（匹配/保留/刮削/DB）的改动需回归验证。
5. 提交信息正文说明改动根因，示例：`fix: 匹配阶段让出事件循环消除扫描未响应`

## 构建与自测

```bash
npm run electron       # 启动开发客户端
npm run smoke          # 真实库全链路自测（IPC/流式/渲染/图标）
npm run scan:abort     # 扫描中止/暂停回归
npm run scan:phase     # 分阶段增量合并回归
npm run build:win      # 打包 Windows NSIS + 便携版
npm run smoke:packaged # 打包版冒烟
```

## 代码约定

- 命名沿用现有风格：业务模块深实现小接口，按域拆分（`lib/db/*`、`electron/ipc/*`）
- 单文件行数建议 < 400（深模块如 `lib/matcher.js` 可例外）
- 阈值、tier 等领域常量收敛到单一出处（`lib/constants.js`、`lib/tier.js`）
- 不引入新的原生依赖（当前 SQLite 走 WASM，纯 JS 标签写入是特性）
- 保持功能精简，不为扩展而增加复杂度

## License

提交即表示同意以 [MIT](LICENSE) 协议发布。
