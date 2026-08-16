# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 2.0.x   | ✅ |
| < 2.0   | ❌ |

## Reporting a Vulnerability

请**不要**通过公开 GitHub Issue 报告安全漏洞。

**首选通道**：GitHub 仓库页 → **Security → Report a vulnerability**（私有安全公告，仅维护者可见）。

请在报告中说明：

- 漏洞类型与影响
- 复现步骤（尽量附最小复现）
- 受影响版本

**处理预期**：

- 收到报告后 72 小时内确认接收
- 确认有效后尽快提供修复与发布计划
- 修复版本发布后，若报告者同意，可在 CHANGELOG 中致谢

> 本项目为本地单机工具，无网络服务面；但仍有依赖安全（如 music-metadata 的解析漏洞）与数据安全（标签写入、数据库完整性）两个关注面，报告同样欢迎。

## Dependency Security

- `music-metadata` 存在已知的 ASF 解析 DoS（GHSA-5v7r-6r5c-r473，moderate），当前曲库格式（FLAC/MP3/M4A/OGG）不受影响；主版本升级须单独回归验证
- 依赖更新由 Dependabot 跟踪，见 [dependabot.yml](.github/dependabot.yml)
