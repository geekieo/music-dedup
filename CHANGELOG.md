# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.12.0] — 2026-07-08

### Added

- **双源刮削架构**：MusicBrainz 和 AcoustID 刮削数据各自独立存储，`scraped_meta` 表主键改为 `(file_id, source)` 复合键，两种来源互不覆盖
- **独立状态跟踪**：MB 和 AcoustID 各自用 `mb_checked_at` / `acoustid_checked_at` 管理处理进度，互不干扰
- **分源统计**：刮削完成日志区分 MB/AcoustID 各自命中数；匹配启动日志显示频谱/Chromaprint 声纹数和两类 recording ID 数量
- **数据库安全迁移**：自动添加 `scraped_meta.source` 列，并根据文件是否有 chromaprint 智能回填来源（有 chromaprint → AcoustID，否则 → MusicBrainz）

### Changed

- **Recording ID 合并匹配**：Phase 2c 将 MB 和 AcoustID 的 recording ID 合并到统一 Map，修复同 ID 不同来源文件无法匹配的 bug
- **统一 tier 计算**：两个刮削源使用同一套 `computeScrapeTier` 规则（标题+艺术家+专辑三字段匹配 + CJK 繁简折叠）
- **MB API 严格限速**：`sleep(1000)` 1 req/s，去掉过度保守的 `sleep(1100)` 额外延迟
- **动态刮削 UI**：ScrapeDialog 对比表和 PropsModal 根据实际有数据的来源动态显示列/区块
- **扫描步骤解耦**：library maintenance（enum+meta）与 matching channels（basic/fp/scrape）分离，新增文件夹入库不自动触发匹配
- **注释精简**：全项目清理冗长 F9/F10 debug 过程描述，仅保留功能说明

### Fixed

- 修复 `scraped_meta` 旧数据库缺少 `source` 列导致复合主键迁移失败
- 修复 MB/AcoustID recording ID 分两个独立 Map，导致 MB 刮削匹配仅 7 对（实际应为 AcoustID 同量级数百对）
- 修复 AcoustID 刮削缺少专辑/年份/曲目号（releases 嵌套在 `releasegroups[].releases[]` 下）
- 修复 AcoustID 流派显示为浮点小数（旧版 scraper 将 score 误存为 genre 字段）

## [1.11.1] — 2026-07-08

### Changed

- **标签体系完善**：筛选栏拆为双行——匹配方法（如何发现）和其他组内特征（组内关系）；新增对称特征标签
- **术语统一**：用户可见文本全部使用"声纹"不再混用"指纹"。Goertzel→频谱声纹，Chromaprint→CP声纹（标签）/Chromaprint声纹（描述），元数据→文件属性/属性
- **标签瘦身**：CP声纹一致/相似、时长接近、年份不同、属性完整度不同
- **设置滑块更名**：频谱指纹相似度阈值 → 频谱声纹相似度阈值

### Added

- **对称特征标签**：format_same、metadata_diff、duration_diff、album_year_diff、meta_score_diff
- **保留平局标签**：`retention_tie`，当智能规则无法自动决定时标记，需手动选择
- **文件属性新增创建时间**：数据库自动迁移 `file_ctime` 列

### Removed

- 删除不可靠的 `single_vs_album` 标签（基于专辑名正则，无实际 release_type 数据支撑）

### Fixed

- `metadata_same` 判断增加 album 字段，与刮削器的精确匹配定义对齐
- `fp_diff` 正确解耦：仅当频谱声纹和 Chromaprint 都未命中时才标记

## [1.11.0] — 2026-07-07

### Changed

- **标签体系重构**：筛选栏标签拆分为"匹配方法"和"特征"两类。匹配方法标签（频谱声纹一致/相似、Chromaprint声纹一致/相似、元数据匹配、MusicBrainz刮削一致、AcoustID刮削一致）出现在筛选栏；特征标签（声纹不同、格式不同、文件名相同、标题/艺术家一致、单曲vs专辑、时长基本一致）仅在重复组详情中显示
- **Chromaprint 阈值解耦**：Phase 5 Chromaprint 改用独立硬编码阈值 `CP_THRESH = 0.90`，不再跟随用户设置的频谱指纹阈值滑块变动
- **UI 明确阈值定义**：设置页滑块从"声纹相似度阈值"更名为"频谱指纹相似度阈值"，并补充说明 Chromaprint 不受此滑块影响

### Added

- 新增匹配方法标签 `meta_confirmed`（元数据匹配），对应 Phase 2/2b 标题+艺术家+时长确认
- 新增匹配方法标签 `cp_similar`（Chromaprint声纹相似），对应 Phase 5 Chromaprint ≥90% 但 <98%

## [1.10.1] — 2026-07-06

### Added

- **多类型重复匹配解耦**：基础匹配（`basicMatch`）、声纹匹配（`fpMatch`）、刮削匹配（`scrapeMatch`）各自独立运行，互不影响。各通道均保留现有重复组，新增结果合并写入
- 扫描页新增三条独立通道，可分别触发基础匹配、声纹匹配、刮削匹配

### Fixed

- 修复 `plausiblePair is not defined` 导致刮削匹配报错 — 提取为模块级共享函数
- 修复 `noAcoustid` 过滤导致 MusicBrainz 刮削只能匹配 8 对的问题 — 移除 AcoustID 互斥过滤，恢复 MB/AcoustID 独立刮削
- 修复 `getFilesNeedingAcoustidScrape` SQL 别名缺失
- 修复非声纹匹配器中 `spectralConfirmed` 恒为 true 导致标签错误

## [1.10.0] — 2026-07-04

### Added

- 5 阶段多策略重复检测：精确指纹匹配 → 标题分组 → 元数据确认 → 前缀 LSH → 时长桶 → Chromaprint
- 智能保留策略（音质优先级 → 首发专辑 → 专辑vs单曲 → 元数据完整度）
- MusicBrainz / AcoustID 刮削匹配（Phase 2c）
- 白名单机制
- Web UI：重复组列表、详情面板、文件属性查看、内嵌音频播放

## [1.9.1] — 2026-06-28

### Added

- 实验性：fpcalc / Chromaprint 本地声纹匹配支持

## [1.9.0] — 2026-06-25

### Changed

- 重构指纹提取管线，支持降级为元数据指纹（`META:` 前缀）

## [1.8.2] — 2026-06-20

### Fixed

- 多项稳定性修复

## [1.8.1] — 2026-06-18

### Changed

- UI 改进和性能优化

## [1.8.0] — 2026-06-15

### Added

- 多线程指纹提取
- 增量扫描支持

## [1.7.4] — 2026-06-10

### Fixed

- 多项修复

## [1.7.0] — 2026-06-01

### Added

- 重复检测引擎初版
- SQLite 持久化
- Express Web 服务

[1.12.0]: https://github.com/geekieo/musicdedup/compare/v1.11.1...HEAD
[1.11.1]: https://github.com/geekieo/musicdedup/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/geekieo/musicdedup/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/geekieo/musicdedup/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/geekieo/musicdedup/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/geekieo/musicdedup/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/geekieo/musicdedup/compare/v1.8.2...v1.9.0
[1.8.2]: https://github.com/geekieo/musicdedup/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/geekieo/musicdedup/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/geekieo/musicdedup/compare/v1.7.4...v1.8.0
[1.7.4]: https://github.com/geekieo/musicdedup/compare/v1.7.0...v1.7.4
[1.7.0]: https://github.com/geekieo/musicdedup/compare/v1.6.0...v1.7.0
