# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-08-16

> 从「前端网页 + 后端 Node 服务」转型为 **Electron 桌面客户端** 的大版本。完整历程：v2.0.0-alpha.1（内嵌 Express 骨架）→ v2.0.0-beta.0（IPC 化 + 代码清理）→ v2.0.0（原生体验 + 数据迁移 + 发布）。

### Added

- **桌面客户端化** — Electron 单机应用，双击即用；单实例锁、系统托盘、扫描完成系统通知、窗口状态记忆
- **无边框窗口（路线 A）** — Windows `titleBarStyle:hidden` + 原生控件悬浮（Aero Snap 免费）、macOS 交通灯避让、Linux 自绘三键；标题栏整行可拖拽
- **扫描隔离 worker 化** — 整条 8 步扫描流水线移入独立 worker 线程，扫描时窗口其他功能全程流畅（主进程事件循环滞后 239ms → 33ms）；崩溃自动兜底广播终态
- **扫描进度条 UI 重设计** — 单进度条 + 内联子% + 一行可关闭摘要（绿✓/红错/灰中止）
- **并发数自适应** — 未设置时默认 `min(8, 核心数)`；新增「扫描性能」设置卡
- **数据迁移交互式 UX** — 旧数据目录 → userData 的交互式迁移（迁移/选位置/全新开始 三选项），绝不静默覆盖；`V2_MIGRATE` 环境变量可自动作答
- **NSIS 安装包 + 便携版双产物** — 安装器自动创建带 AUMID 的任务栏/开始菜单快捷方式
- **打包体积瘦身** — 99M → 80.5M（locales 裁剪 + maximum 压缩 + 删除 DXC/Vulkan 软渲染/许可文本）

### Changed

- **移除 Express/HTTP 层** — 全部约 50 个接口改为 `ipcMain.handle` 单通道（URL 桥）+ 按域拆分 `electron/ipc/{library,files,tags,scrape,duplicates,scan,settings}.js`；SSE 进度改 IPC 事件；音频/封面走 `musicdedup://` 自定义协议直读磁盘
- **代码清理** — `db.js` 按域拆 8 文件；`rules.js` 核心/展示两层拆分；tier 词汇收敛（绿蓝黄红单一出处）；相似度阈值收敛 `lib/constants.js`；`queryLibrary` 三件套合并；`app.js` 组件下沉 `components.js`
- **统一图标（6 版迭代定稿）** — `assets/icon.svg` 单一源，构建期栅格化；header Logo/favicon/托盘/打包图标四处统一
- **保留机制语义统一** — 保留名单与手动保留合并为统一「保留」，带来源标注 `smart | manual`；手动保留为级联结果的人工覆盖、不被重算冲掉

### Fixed

- **纯 JS M4A 标签写入写坏文件**（v1 遗留）— `buildAtom()` 覆盖 atom size 头，真实库 M4A 标签写入产出损坏 moov；已修并回归验证
- **扫描时窗口「未响应」** — 主线程同步解码（单文件阻塞 1~2.5s）+ 匹配相似度对比（实测最大 27s）改为 worker 卸载 + 协作式让出
- **扫描状态断链** — `broadcast` 的 `Object.assign` 把残留 `type` 并入 scanState，`done` 事件永不触发（重复组不刷新 / 关窗不退出 / 进度条不收起）
- **迁移排序回归** — P2 把 `getDB()` 提到模块顶层，目标库在迁移决策前被创建，旧数据被静默跳过；已恢复「迁移决策先于任何 DB 打开」
- **流式播放中文路径 TypeError** — ETag 含中文触发 ByteString 编码异常；改纯 `size-mtime`；路径型 URL 统一正斜杠编码
- **`estimateStepWeights` 引用不存在列** — 新 schema 库扫描即 `no such column`；改正列名并把权重计算移入 try 块
- **launch-dev.cmd 中文注释破坏启动命令** — cmd.exe 按 GBK 解析 UTF-8 批处理；重写为 ASCII 注释 + CRLF
- **打包版扫描 worker 读 asar 依赖失败** — worker 不继承 Electron asar fs 补丁，声纹/扫描 worker 一直静默降级回主进程；`asarUnpack` 扩为 `lib/**` + `node_modules/**` + `scan-worker.js`，打包版扫描现已可用
- **Windows 任务栏显示「Electron」** — 本机残留 `Electron.lnk` 与 AUMID 不匹配；清理并新建带 `com.geekieo.musicdedup` 的快捷方式
- **托盘图标进系统托盘溢出区** — Windows 11 默认折叠属正常；补 `.ico` 格式

## [1.15.0] — 2026-08-03

### Added

- **刮削可写入字段从 3 项扩展为 6 项**（标题/艺术家/专辑 + 年份/曲目号/流派），时长仅对比不写入；刮削分级从 3 级扩展为 4 级，新增 `red`（模糊匹配且无可写入信息，可直接忽略）。tier 计算收敛到服务端单一事实来源（`lib/tier.js`），修复浏览器端繁简折叠漏字（如 鐘/藉）
- **刮削比较表就地单选**：每个可写字段一个单选按钮，在 MB/AcoustID 来源间点击切换；单元格三色状态（绿=一致 / 蓝=推荐写入 / 黄=需自行判断），推荐字段标"推荐"，两源冲突显示 alert 图标
- **组内字段借用（CrossFillDialog）**：可从重复组内其他文件借字段，按来源亲和力自动推荐与目标字段最吻合的来源
- **重复组维度对比支持 AcoustID 精确匹配**作为刮削吻合来源
- **搜索增强**：逻辑优化、容错前后端统一、`SearchInput` 组件统一
- **子进度条**：长耗时步骤显示独立子进度，全局进度改为按步骤耗时加权

### Changed

- **刮削操作重构**：MB/AcoustID 双源候选列表（分别列出、可预览与应用），数据安全与写入逻辑统一
- **双源合并逻辑**：年份/曲目号/流派优先取与文件现有值一致的来源，两源都不匹配才回退主源
- **刮削列悬停弹窗重构**：双列布局（MB 左 / AcoustID 右），弹窗尺寸由内容驱动
- **刮削统计分母固定为 7**（六可写字段 + 时长）
- **写入/撤销字段后全链路实时刷新**：比较表匹配状态、全局统计、跨页面写入统一走 `onTagsWritten` 触发链；最近写入的修改字段改用中文名称
- **"全量重新执行"命名统一**：按钮 title 悬停弹窗改为 Hint 说明
- **重新执行（force）模式统一**：由 `forceStripLaneTags` 前置清理 DB，matcher 内部只做读取 + 并集
- **代码结构**：`app.js` 拆分，视图按页面剥离为 5 个独立文件（[public/views/](public/views/)）

### Fixed

- **双源合并误判**：MB 有冲突字段但 AcoustID 完全吻合时，不再被整体误判为"精确匹配 · 可写入"
- **AcoustID 时长字段**：修复刮削结果中 AcoustID 时长异常，时长对比与统计可正常读取
- **彻底删除时同步清理所有关联表**，消除孤儿数据
- **全量重新执行不再继承旧组**：matcher 内部安全排除对应旧组后重算并集

## [1.14.1] — 2026-07-21

### Added

- **"在重复组中查看"按钮**：保留名单和最近写入表格新增 `group-locate` 图标按钮，点击跳转到对应重复组；文件不在任何重复组时按钮置灰。底层依赖新增的 `/api/files/in-groups` 批量接口
- **确认弹窗 hook (`useConfirmAction`)**：封装 ConfirmModal + "本轮不再显示"复选框，通过 `suppressedRef` 记忆用户选择，会话内不再重复弹出
- **IconAction 支持 `disabled`**：置灰、降低透明度、移除点击事件

### Changed

- **手动保留卡片统一为绿色**：`TrackRow` 移除 `isManualOnly` / `shield-check` 特殊样式，手动保留与智能保留使用相同的绿色边框和背景
- **搜索组件统一**：`SearchInput` 组件 + `filterBySearch` 函数抽取为共享模块，替换曲库/重复组/保留名单/最近写入四个搜索框的重复代码
- **搜索容错增强**：`normalizeForSearch` 对输入和匹配字段均做 NFKD 分解 → 去除变音符 → 小写 → 仅保留 Unicode 字母数字 → 压缩空白，实现重音不敏感、符号不敏感、空白不敏感的模糊搜索
- **标签拆分增加 trim**：`group_tags` 字符串 split 后统一 `.trim()`，修复多余空白导致标签匹配失败的问题
- **移除保留名单 / 撤销写入均需弹窗确认**，含"本轮不再显示"复选框

### Removed

- **"文件属性"弹窗下方的刮削数据卡片**（MB/AcoustID 双源区块），以及 `scraped` 状态和 `/api/files/:id/scraped` API 调用

### Fixed

- **保留标签文案修正**：`ctime_best` 从"入库更新"改为"入库更晚"（入库时间越新越优先）

## [1.14.0] — 2026-07-19

### Added

- **入库时间保留维度 (`ctime_best`)**：文件创建时间越新越优先，排在音质之后、专辑之前。同一专辑后导入的可能是修正过的版本，避免旧文件因先入库而占据优势
- **重复组详情维度对比表**：每首歌 × 七个保留维度的具体取值，胜出项绿色加粗，文件大小以比例条展示

### Changed

- **级联算法重构**：每个保留维度改为在"当前候选池"里实时取最高分排序，而非预计算全局最优——文件缺某项数据时不参与该轮，不会被淘汰
- **时长维度按容差分桶比较**：以组内精确刮削时长为参考（MB 优先，容差 3s），本地时长一致的优先
- **代码整合**：`lib/tags.js` 功能合并到 `lib/rules.js`，消除中间抽象层，减少跨文件跳转
- **`match_tags` → `group_tags`**：全栈重命名（数据库列、API 字段、前端变量），更准确描述"重复组的标签"这一用途
- **`fp_diff` 动态注入**：仅当频谱声纹和 Chromaprint 声纹都不相似时才标记，之前预计算导致误标
- **`metaScore` 简化**：直接统计有效字段数（title/artist/album/year/track/genre），去掉加权计算，与其他维度同质可比
- **维度对比表 UI 增强**：去掉折叠/展开切换，常驻展示；列宽按内容像素估算自适应（`table-layout:fixed`）；新增 table-compare / ruler / clock / disc / calendar 图标
- **维度说明弹窗重构**：网格布局（维度名列 + 说明列），顶部增加级联规则的引导文案
- **标签说明弹窗重构**：互斥标签对（如 `spectral_exact`/`same_recording`）合并为单行展示，`buildLegendRows()` 自动合并；网格布局对齐标签与描述
- **重复组详情头部重排**：标题+艺术家与操作按钮同行，标签移到下方独立一行，视觉层次更清晰
- **保留维度从 6 个扩展到 7 个**：`duration_accurate → quality_best → ctime_best → album_best → release_best → scrape_best → meta_best`
- **文案精简**：`GROUP_TAG_DESCRIPTIONS` 统一为简洁风格，互斥对共享同一描述避免信息重复

### Removed

- `lib/tags.js` — 功能已完全合并到 `lib/rules.js`，不再需要中间层

## [1.13.0] — 2026-07-17

### Added

- **时长准确保留维度**：组级精确刮削时长为参考（MB 优先于 AcoustID，容差 3s），判断每个文件本地时长是否准确。读的是音频本身而非标签，是保留优先级中最硬的信号
- **多段 LSH 分桶**：频谱和 CP 声纹各取 5 段（`NUM_LSH_SEGMENTS=5`）分布在整个时长上，每文件进 ~5 个桶，任一命中即触发比对，大幅提升偏移/裁剪场景的召回率
- **滑动窗口对齐**：`fingerprintSimilarity` / `chromaprintSimilarity` 新增 `maxOffset=8` 参数，±8 帧偏移搜索最优对齐位置，解决编码器 priming/padding 导致指纹序列偏移后相似度骤降的问题
- **递归时长桶细分**：时长桶超 600 不再跳过，改为按指纹段递归细分（`subdivideDurBucket`，最多 3 层），消灭超大桶导致的漏检
- **刮削 duration 字段**：`scraped_meta` 表新增 `duration REAL` 列，MB 从录音长度（ms→s）换算，AcoustID 独立记录，为 `duration_accurate` 维度提供 AcoustID 数据源
- **回收站生命周期**：`/api/duplicates/:id/unresolve`（恢复单组）、`/api/duplicates/unresolve-all`（批量恢复）、`/api/duplicates/:id/purge`（彻底删除）、`/api/duplicates/empty-trash`（清空回收站）；连带回收同名歌词文件（.lrc/.txt/.lyric 等）
- **release 脚本**：`scripts/release.js` 标准化版本发布（bump → CHANGELOG placeholder → git tag -a）

### Changed

- **保留系统完全重构**：
  - `group_tracks` 表移除 `keep` / `keep_reason` / `manual_override` 列，保留结果改为动态计算（`evaluateGroup` → `applyRetentionRules`）
  - `whitelist` 表更名为 `retention_list`，概念从"排除检测"转为"受保护不被删除"（文件仍参与重复检测，但在保留决策中标记为优先保留）
  - 保留优先级从 4 级扩展为 6 级级联：`duration_accurate → quality_best → album_best → release_best → scrape_best → meta_best`，硬信号（音频本身）优先，可被刮削覆写的软标签靠后
  - `scrape_best` 不再混入时长匹配（`countScrapeMatches` 仅比较年份/曲目号/风格），时长独立由 `duration_accurate` 判断，避免正确时长的文件因标签字段少而被时长有误的文件逆袭
- **统一进度报告系统**：SSE 进度推送规范化，`phase:'done'` 完成提示，`runMetadata` 按文件粒度更新进度
- **TrackRow 标签化展示**：从单一 `keep_reason` 改为 `_tags` 多维标签数组，每个保留维度独立标注颜色和图标
- **批量操作 UI 安全加固**：单组回收站无弹窗；批量恢复确认弹窗显示组数和空间；已处理组"撤销"/"彻底删除"；"待处理"/"已处理"批处理功能区分
- **过滤标签互斥组**：`EXCLUSIVE_TAG_GROUPS` 定义 5 组互斥标签对，同组选中一个自动替换另一个，避免 AND 语义下返回零结果
- **筛选栏框架始终可见**：重复组筛选栏不会因标签为空而消失
- **刮削状态图标**：`shield-check` → `cloud-check`，区分"刮削已确认"与"保留名单受保护"
- **设置页新增图标**：`audio-levels`（音质优先级，三段均衡器）、`priority-podium`（保留优先级，领奖台+星标）
- **播放进度条**：悬停和拖拽时统一显示"进度 / 总时长"
- **版本号管理**：`release.js` 同步更新 `package.json` + `public/app.js`（`APP_VERSION`）+ CHANGELOG
- **自定义优先级向后兼容**：旧 `pick_tag_order` 设置缺少新维度键时从默认顺序尾部补齐，不会静默丢失

### Fixed

- UI 细节：Hint 点击常驻/滚动收起、AcoustID 验证持久化（localStorage）、布局晃动修复（`scrollbar-gutter:stable`）
- 修复"全部扫描操作"步骤序列错误
- 修复重复组详情载入逻辑
- 声纹匹配 hint 文案修正

## [1.12.3] — 2026-07-11

### Changed

- **扫描页通道拆分**：基础匹配拆分为「音乐库更新」（枚举 + 属性提取）和「基础匹配」（属性匹配），通道从 3 个扩展为 4 个
- **"智能执行"→"增量执行"**：全局重命名，更准确描述按修改时间跳过未变更文件的增量行为
- **全部扫描操作**：原"增量执行全部"改为「全部扫描操作」，去掉冗余副标题；右侧按钮同步改为「增量执行」，宽度与上方通道按钮一致
- **"强制重新执行"/"强制全量重扫"→"全量重新执行"**：统一命名
- **通道说明重构**：每个通道的 (i) 说明改为先介绍执行步骤模块（用「」标注），再描述功能
- **高级按钮改为下拉叠窗**：点击「高级」不再改变卡片高度，而是在按钮下方弹出绝对定位的下拉菜单；点击页面其他位置自动收起（透明遮罩层实现）

### Fixed

- **刮削筛选与刮削操作标签一致**：`scrapedShapeFromRow` 从"选最优源"改为"合并双源"，推荐写入字段取两源并集，避免 AcoustID 有可写入字段但被 MB 源的绿色层级覆盖导致 blue→green 降级

## [1.12.2] — 2026-07-09

### Changed

- **刮削分级术语统一**：`red`→`yellow`，模糊匹配从"红色"改为"黄色"，与 UI 中已使用的黄色图标保持一致
- **匹配方法标签跨阶段保留**：部分重跑匹配（如仅重跑基础匹配）时，快照并合并旧的匹配方法标签，避免其他阶段的标签被清除
- **Recording-ID 匹配补充检测**：部分重跑时 `mbConfirmedPairs`/`acoustidConfirmedPairs` 为 null，回退到从 track 数据直接检测 recording-ID 匹配
- **标签悬停移除**：`MatchTag` 移除悬停说明，标签仅作为视觉标识，不再承载解释文本
- **设置提示组件优化**：`Hint` (i) 悬停提示改为白底亮色主题；支持 `data-hint-boundary` 约束在卡片范围内；支持自动上下翻转避让；文字排版更清晰（`pre-line` 支持多行列表）；移除三角箭头
- **标签说明移至重复组页面**：从设置页移除"重复组标签说明"区块，改为在重复组筛选栏右侧增加"标签说明"按钮，点击弹窗展示，分"匹配方法"和"其他组内特征标签"两区；匹配方法和特征标签均按固定顺序排列
- **解释性说明归入 Hint**：CP 声纹描述、繁简忽略描述从行内文字移入 (i) 悬停提示，设置页仅保留功能说明直接可见
- **设置页侧栏 scroll-spy**：IntersectionObserver 追踪当前可见设置区块，侧栏自动居中对应导航项；sticky `top: 20px` 保留自然留白不破坏；滚动条隐藏；保存状态随侧栏自然滚动
- **播放栏改进**：上一曲/下一曲使用专用图标；进度条 hover 时显示拖拽滑块和时间胶囊；时间显示改为播放位置而非"已播放/总时长"格式
- **扫描完成后曲库自动刷新**：扫描/匹配完成后曲库列表自动重新加载，无需手动切换页面

### Fixed

- `queryLibrary` 刮削分类筛选时未 JOIN `scraped_meta` 表导致 SQL 报错
- `scrapedShapeFromRow` rank 函数未将 `red` 更新为 `yellow`
- 重复组 API 未禁用浏览器缓存，导致操作后列表未刷新

## [1.12.1] — 2026-07-08

### Changed

- **Phase 编号重整为全局 8 步**：统一执行流程 1枚举→2提取属性→3属性匹配→4提取声纹→5频谱声纹匹配→6CP声纹匹配→7刮削→8刮削匹配，消除旧 `2b`/`2c` 后缀和非顺序编号
- **执行顺序优化**：默认步骤 `enum→meta→basicMatch→fp→fpMatch→scrape→scrapeMatch`，属性匹配提前到声纹提取之前
- **扫描页通道明确化**：三个匹配通道与全局步骤的对应关系写入 matcher.js 顶部注释和 README
- **筛选栏标签重排**：匹配方法标签按属性→声纹→刮削、默认→可选、一致→相似的规则排序

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

[1.15.0]: https://github.com/geekieo/musicdedup/compare/v1.14.1...v1.15.0
[1.12.2]: https://github.com/geekieo/musicdedup/compare/v1.12.1...HEAD
[1.12.1]: https://github.com/geekieo/musicdedup/compare/v1.12.0...v1.12.1
[1.12.0]: https://github.com/geekieo/musicdedup/compare/v1.11.1...v1.12.0
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
