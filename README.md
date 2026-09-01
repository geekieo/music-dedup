# MusicDedup

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-2.0.0-brightgreen)

本地重复音乐管理工具 — **纯 JS 声纹识别 + 智能保留策略**，桌面客户端（Electron）。

在一个含数万首歌曲的音乐库里找出重复文件是件苦差事：同名不同专辑、同一首歌的多个音质版本、相同声纹的不同来源……MusicDedup 用**多通道匹配 + 7 级智能保留策略**帮你自动识别重复、推荐保留哪个文件，一键清理，全程离线可用。

---

## 特性

- **桌面客户端** — Electron 单机应用，双击即用；无边框自绘标题栏、窗口状态记忆、单实例锁
- **四级匹配通道** — 音乐库更新（枚举+标签）/ 基础匹配（标签）/ 声纹匹配（频谱+CP）/ 刮削匹配（recording ID），各自独立运行、结果合并
- **纯 JS 声纹识别** — 基于 Goertzel 算法的频谱声纹，无需任何外部二进制
- **可选 Chromaprint** — 配置 fpcalc 后启用独立 CP 声纹比对 + AcoustID 查重
- **双源刮削** — MusicBrainz 文本搜索 + AcoustID 声纹反查，逐字段单选、来源亲和推荐，数据独立存储互不覆盖
- **智能保留策略** — 7 级级联（时长准确 → 音质 → 入库时间 → 专辑版 → 首发年份 → 刮削吻合 → 标签完整度），用户可手动覆盖且不被重算冲掉
- **标签写入与回滚** — 刮削元数据写入音频标签，保留写入历史，一键还原
- **扫描隔离** — 整条扫描流水线跑在独立 worker 线程，扫描时窗口其他功能全程流畅
- **安全删除** — 非保留文件移入系统回收站，可撤销
- **内嵌播放器** — 播放队列、进度拖拽、封面显示（自定义协议流式读取，不经 HTTP）

---

## 安装与运行

### 安装包（推荐）

从 [Releases](../../releases) 下载：

| 产物 | 说明 |
|---|---|
| `MusicDedup Setup 2.0.0.exe` | NSIS 安装包，自动创建带图标的任务栏/开始菜单快捷方式 |
| `MusicDedup 2.0.0.exe` | 便携版，解压即用，免安装 |

> 未签名程序在 Windows SmartScreen 会提示"未知发布者"——选择"仍要运行"即可。数据全程在本机，无任何云同步。

### 从源码运行

**系统要求**：Node.js ≥ 18，Windows 10/11（macOS/Linux 代码就位，未经实机验证）

```bash
npm install
npm run electron
```

> ⚠️ 若下载 Electron 二进制缓慢或失败，可配置镜像，见 [scripts/build-win.mjs](scripts/build-win.mjs) 头部注释。

### 打包 Windows 产物

```bash
npm run build:win      # 产出 release/ 下 NSIS 安装包 + 便携版
npm run smoke:packaged # 打包版冒烟自测
```

---

## 使用流程

1. **设置** — 添加音乐库文件夹，配置 AcoustID Key（可选）、音质优先级、扫描并发数
2. **扫描** — 四条通道按需执行：音乐库更新 → 基础匹配 → 声纹匹配 → 刮削匹配，可暂停/恢复/中止
3. **重复组** — 按匹配方法/特征标签筛选，逐组确认保留方案，可手动覆盖；比较表可刮削、可写入
4. **处理** — 确认后非保留文件移入系统回收站，可撤销

## 扫描与匹配

9 步流水线（四个匹配通道 + 独立的智能保留步骤，见 [扫描页](public/views/scanner.js)）：

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | 枚举 | 扫描目录，发现音频文件，入库 |
| 2 | 提取属性 | 读取标签（标题/艺术家/专辑等）与文件属性（时长/格式/比特率等），计算标签完整度评分 |
| 3 | 属性匹配 | 标题分组 → 艺术家归一化 → 时长确认，不依赖声纹 |
| 4 | 提取声纹 | 频谱声纹（Goertzel）+ CP 声纹（fpcalc，可选） |
| 5 | 频谱声纹匹配 | 精确声纹 → LSH 前缀分组 → 时长桶 + Hamming 相似度 |
| 6 | CP 声纹匹配 | Chromaprint 相似度比较（阈值 0.90） |
| 7 | 刮削 | MusicBrainz 文本搜索 + AcoustID 声纹反查，获取外部元数据 |
| 8 | 刮削匹配 | MB / AcoustID recording ID 合并对比确认重复 |
| 9 | 智能保留 | 用已应用的保留优先级重算未处理组的推荐保留（纯列更新，不清除组） |

- 四个匹配通道独立运行、结果合并，智能保留单独执行；增量扫描只处理自上次成功后变更的文件
- 智能保留：优先级改动需显式执行该步骤才生效；手动保留是人工覆盖，不会被重算冲掉
- 声纹与刮削状态缓存在本地 SQLite，增量扫描秒级完成
- 扫描在独立 worker 线程执行，窗口保持流畅

## 智能保留策略

重复组检测到后自动推荐保留者，7 级级联：

1. **时长准确** — 以组内精确刮削时长为参考（MB 优先），本地时长一致者优先
2. **音质优先** — 按设置页音质优先级（默认 Hi-Res FLAC > FLAC/WAV > AIFF > M4A/AAC ≥256k > MP3 320k > … > MP3 128k）
3. **入库更晚** — 文件创建时间越晚越优先
4. **专辑优先** — 专辑版优先于单曲/合集版
5. **首发专辑** — 同条件下保留发行年份最早的版本
6. **刮削更准** — 年份/曲目号/风格与 MusicBrainz 吻合项数更多
7. **标签最全** — 标签字段最完整

手动保留是对级联结果的**人工覆盖**，不会被后续重算冲掉；UI 可区分某保留来自智能还是手动。

## 刮削

- **MusicBrainz**：文本搜索（标题 + 艺术家），无需 API Key；recording ID / release 列表 / 官方元数据；分级为精确或模糊匹配；限速 1 req/s
- **AcoustID**：音频声纹反查，需免费 API Key（[acoustid.org](https://acoustid.org/) 注册）；返回 recording ID，置信度高于纯文本匹配；350ms 请求间隔，自动处理限流
- 双源各自独立存储，MB 与 AcoustID 的 recording ID 合并对比，修复同 ID 不同来源文件无法匹配的问题
- 刮削结果可**逐字段写入**音频标签，写入历史保留 30 天，可一键还原

## 声纹算法

基于 **Goertzel 频谱声纹**（Sub-band Spectral Fingerprinting）：

1. 音频解码为 PCM（MP3、FLAC、M4A、OGG、WAV 等）
2. 重采样至 11025 Hz 单声道
3. Goertzel 计算 33 个对数均匀分布频率（300 Hz–2 kHz）的能量
4. 5 个锚点跳过能量低帧，各取 25 帧
5. 比较相邻帧频谱斜率变化方向 → 32 位整数
6. ~120 个整数构成声纹；Hamming 距离逐位比较；解码失败自动降级为元数据伪声纹

## 数据与隐私

- 全部数据存储在本机（SQLite + 日志），无任何云端上传：安装版在 `%APPDATA%/MusicDedup/`，便携版在 exe 旁的 `MusicDedup-data/`（便携不留数据在宿主）
- **首次启动自动迁移**：检测到 v1（Web 版）数据目录会交互式询问是否迁移，绝不静默覆盖
- 删除操作一律进系统回收站，可撤销

## 窗口行为

- 单实例锁：重复打开只聚焦已有窗口，避免数据库并发写冲突
- 空闲时关闭窗口 = 退出；**任务进行中关闭窗口** = 程序内确认弹窗，确认后中止任务再退出
- 窗口尺寸/位置/最大化状态自动记忆

---

## 开发

### 环境

- Node.js ≥ 18；本项目为 ESM（`"type": "module"`）
- ⚠️ 本机若存在全局 `ELECTRON_RUN_AS_NODE` 环境变量，Electron 会退化为纯 Node 模式——已由 [scripts/run-electron.mjs](scripts/run-electron.mjs) 自动清除

### 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run electron` | 启动开发客户端 |
| `npm run smoke` | 真实库全链路自测（IPC/流式/渲染/图标） |
| `npm run test:setup` | 搭建隔离测试环境（备份生产库 + 复制重复曲目副本 + 建测试 userData） |
| `npm run build:win` | 打包 Windows NSIS + 便携版 |

**隔离测试**：`npm run test:setup` 后，用
`npm run electron -- --userdata <测试userdata>` 启动测试实例（数据与生产
`%APPDATA%/MusicDedup` 完全隔离，生产库备份在 `%APPDATA%/MusicDedup/backup/`），
验证完关窗、直接 `npm run electron` 即回到生产。详见 `scripts/setup-test-env.mjs` 头部说明。

### 架构

```
Electron 单机应用，无 HTTP 层：
Renderer (public/*.js, React)
   │  window.bridge.request(method, url, body)  ←→  ipcRenderer.invoke('api')
   ▼
Preload (contextBridge) → Main (electron/ipc/index.js 路由表)
   ▼
electron/ipc/{library,files,tags,scrape,duplicates,scan,settings}.js
   ▼
lib/{db,scanner,matcher,rules,scraper,tagger,fingerprint,...}.js → SQLite/文件系统
音频/封面：musicdedup:// 自定义协议直读磁盘（不进 IPC）
```

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 常见问题

- **扫描时窗口卡顿？** 2.0 起扫描已隔离到 worker 线程，若仍复现请带主进程日志提 issue。
- **SmartScreen 提示"未知发布者"？** 程序未做代码签名，选择"仍要运行"；安装包与便携版皆如此。
- **如何启用 AcoustID / Chromaprint？** 设置页填写 AcoustID API Key；fpcalc.exe 放入项目根目录或设置其路径。

## License

[MIT](LICENSE) © 2026 Geekieo
