# MusicDedup

本地重复音乐管理工具 — 纯 JS 音频声纹识别 + 智能保留策略，浏览器内操作。

**环境要求：Node.js ≥ 18**

## 快速开始

```bash
npm install
npm start
```

浏览器打开 **http://localhost:3456**

## 使用流程

1. **设置** — 添加音乐库文件夹，配置 AcoustID Key（可选），调整音质优先级
2. **扫描** — 四条独立通道按需执行：音乐库更新 → 基础匹配 → 声纹匹配 → 刮削匹配
3. **重复组** — 按匹配方法/特征标签筛选，逐组确认保留方案，可手动覆盖
4. **处理** — 确认后非保留文件移入系统回收站，可撤销

## 核心功能

- **纯 JS 声纹识别** — 基于 Goertzel 算法的频谱声纹，无需任何外部二进制依赖
- **可选 Chromaprint** — 下载 fpcalc 放到项目根目录，启用独立 CP 声纹比对 + AcoustID 查重
- **双源刮削** — MusicBrainz 文本搜索 + AcoustID 声纹反查，各自独立存储、互不覆盖
- **四级匹配通道** — 音乐库更新（枚举+属性提取）/ 基础匹配（属性）/ 声纹匹配（频谱+CP）/ 刮削匹配（recording ID），各自独立运行、结果合并
- **智能增量扫描** — 按文件修改时间跳过未变更文件，各阶段独立追踪处理状态
- **智能保留策略** — 音质优先 → 首发专辑年份 → 专辑/单曲判断 → 元数据完整度，用户可手动覆盖
- **可排序音质优先级** — 设置页拖拽排序音质层级，决定同组文件保留优先级
- **标签写入与回滚** — 支持将刮削元数据写入音频文件标签，保留 30 天写入历史，可一键还原
- **匹配标签体系** — 匹配方法标签（如何发现重复）+ 特征标签（组内文件关系），支持筛选
- **安全删除** — 文件移入系统回收站，可撤销
- **内嵌播放器** — 支持播放队列、进度拖拽、封面显示
- **实时进度** — SSE 推送扫描进度，支持暂停/继续/停止
- **CJK 繁简忽略** — 基于 opencc-js，刮削匹配时自动折叠繁简体差异
- **文件属性查看** — 点击文件可查看完整音频属性及刮削数据对比
- **保留名单** — 标记指定文件受保护，参与重复检测但保留决策中优先保留

## 8 步扫描流程

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | 枚举 | 扫描目录，发现音频文件，入库 |
| 2 | 提取属性 | 读取音频标签（标题/艺术家/专辑/时长/格式/比特率等），计算元数据完整度评分 |
| 3 | 属性匹配 | 标题分组 → 艺术家归一化 → 时长确认，不依赖声纹 |
| 4 | 提取声纹 | 频谱声纹（Goertzel）+ CP 声纹（fpcalc，可选） |
| 5 | 频谱声纹匹配 | 精确声纹 → LSH 前缀分组 → 时长桶 + Hamming 相似度 |
| 6 | CP 声纹匹配 | Chromaprint 相似度比较（阈值 0.90） |
| 7 | 刮削 | MusicBrainz 文本搜索 + AcoustID 声纹反查，获取外部元数据 |
| 8 | 刮削匹配 | MB / AcoustID recording ID 合并对比确认重复 |

## 扫描页四个通道

| 通道 | 对应步骤 | 说明 |
|------|---------|------|
| 音乐库更新 | 步骤 1+2 | 枚举新文件 + 提取属性，入库后即可浏览曲库 |
| 基础匹配 | 步骤 3 | 标题分组 + 元数据确认，不依赖声纹 |
| 声纹匹配 | 步骤 5+6 | 频谱声纹 + CP 声纹 |
| 刮削匹配 | 步骤 8 | MB/AcoustID recording ID 对比 |

> 四条通道独立运行、结果合并。增量执行只处理自上次成功后变更的文件，全量重新执行忽略时间戳强制重跑。

## 声纹算法

基于 **Goertzel 频谱声纹**（Sub-band Spectral Fingerprinting）：

1. 音频解码为 PCM（支持 MP3、FLAC、M4A、OGG、WAV 等）
2. 重采样至 11025 Hz 单声道
3. Goertzel 算法计算 33 个对数均匀分布频率（300 Hz–2 kHz）的能量
4. 5 个锚点（15%、30%、50%、65%、80% 位置）跳过低能量帧，各取 25 帧
5. 比较相邻帧的频谱斜率变化方向 → 32 位整数
6. ~120 个整数构成声纹

相似度：Hamming 距离逐位比较。音频解码失败时自动降级为元数据伪声纹。

### Chromaprint（可选）

下载 [fpcalc](https://acoustid.org/chromaprint) 放到项目根目录，可启用独立的 Chromaprint 声纹比对。同一份 Chromaprint 数据也用于 AcoustID 刮削。

## 智能保留策略

当检测到重复组时，系统自动推荐保留哪个文件：

1. **时长准确** — 以组内精确刮削时长为参考（MB 优先，容差 3s），本地时长一致的优先。读取的是音频本身，不受标签修改影响
2. **音质优先** — 按设置页音质优先级排序（默认：Hi-Res FLAC > FLAC/WAV > AIFF > M4A/AAC ≥256k > MP3 320k > MP3 256k > MP3 192k > OGG/Opus > MP3 128k 及以下）
3. **专辑优先** — 专辑版优先于单曲/合集版，选择更正确的发行版本
4. **首发专辑** — 同条件下保留发行年份最早的版本
5. **刮削更准** — 年份/曲目号/风格与 MusicBrainz 官方数据吻合项数更多（不含时长，时长已在第 1 步独立判断）
6. **属性最全** — 以上均相同时，保留标签字段最完整的文件

点击重复组中任意曲目可手动覆盖自动推荐。

## 刮削

### MusicBrainz

- 文本搜索（标题 + 艺术家），无需 API Key
- 获取 recording ID、release 列表、官方元数据
- 按标题/艺术家/专辑/时长/轨号交叉验证，分级为精确匹配或模糊匹配
- 限速 1 req/s

### AcoustID

- 音频声纹反查，需免费 API Key（[acoustid.org](https://acoustid.org/) 注册获取）
- 返回 MusicBrainz recording ID，置信度高于纯文本匹配
- 350ms 请求间隔，自动处理限流和 transient 错误

双源数据各自独立存储，MB 和 AcoustID 的 recording ID 合并对比，修复同 ID 不同来源文件无法匹配的问题。

## 部署

### 本地

```bash
npm install && npm start
```

### 开发模式（文件变更自动重启）

```bash
npm run dev
```

### PM2

```bash
npm i -g pm2
pm2 start server.js --name musicdedup
pm2 save && pm2 startup
```

### Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3456
CMD ["node", "server.js"]
```

### Nginx 反向代理

SSE 进度推送需要关闭缓冲：

```nginx
location / {
    proxy_pass http://localhost:3456;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Connection '';
    chunked_transfer_encoding on;
}
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 曲库统计 |
| GET/PUT | `/api/settings` | 获取/保存设置 |
| GET | `/api/library` | 曲库分页查询（支持排序、搜索、格式/刮削状态筛选） |
| GET | `/api/library/stats` | 曲库筛选统计 |
| GET | `/api/library/locate/:id` | 定位文件在曲库中的页码 |
| GET | `/api/files/:id` | 文件详情 |
| POST | `/api/files/:id/reveal` | 在资源管理器中打开 |
| GET | `/api/files/:id/stream` | 音频流（支持 Range 请求） |
| GET | `/api/files/:id/cover` | 封面图片 |
| POST | `/api/files/:id/rename` | 文件重命名 |
| GET/POST | `/api/files/:id/live-tags` | 读取/写入音频标签 |
| POST | `/api/files/:id/write-tags` | 将刮削数据写入文件标签 |
| GET | `/api/files/:id/snapshots` | 标签写入历史 |
| POST | `/api/files/:id/scrape-single` | 对单个文件执行刮削 |
| GET/DELETE | `/api/files/:id/scraped` | 查看/清除刮削数据 |
| GET/POST/DELETE | `/api/retention-list/:fileId?` | 保留名单管理 |
| GET | `/api/duplicates` | 重复组列表 |
| GET | `/api/duplicates/:id` | 重复组详情 |
| POST | `/api/duplicates/:id/resolve` | 确认处理重复组 |
| POST | `/api/duplicates/resolve-all` | 批量处理所有重复组 |
| PUT | `/api/duplicates/:id/tracks/:fid/keep` | 手动指定保留文件 |
| POST | `/api/scan/start` | 启动扫描 |
| POST | `/api/scan/pause` | 暂停扫描 |
| POST | `/api/scan/resume` | 恢复扫描 |
| POST | `/api/scan/abort` | 停止扫描 |
| GET | `/api/scan/stream` | SSE 进度流 |
| GET | `/api/scan/status` | 扫描状态 |
| POST | `/api/browse-folder` | 系统文件夹选择对话框 |
| GET | `/api/system/fpcalc` | fpcalc 检测状态 |
| GET | `/api/system/exiftool` | exiftool 检测状态 |
| POST | `/api/validate-acoustid` | 验证 AcoustID API Key |

## 项目结构

```
musicdedup/
├── server.js                 # Express 入口 + 全部 API 路由 + SSE
├── fpcalc.exe                # Chromaprint 二进制（可选）
├── lib/
│   ├── db.js                 # SQLite (WASM) 数据层，schema 定义与迁移
│   ├── fingerprint.js        # 纯 JS Goertzel 频谱声纹算法
│   ├── chromaprint-bridge.js # fpcalc 桥接
│   ├── scanner.js            # 文件枚举 + 属性提取 + 声纹提取
│   ├── matcher.js            # 多阶段重复检测引擎
│   ├── scraper.js            # MusicBrainz / AcoustID 双源刮削
│   ├── rules.js              # 智能保留规则 + 匹配标签 + 音质分级
│   ├── tagger.js             # 标签读写 + 写入快照与回滚
│   ├── tier.js               # 刮削分级计算（绿/蓝/黄）
│   ├── flac-writer.js        # FLAC 标签写入
│   ├── ogg-writer.js         # OGG 标签写入
│   └── m4a-writer.js         # M4A 标签写入
├── public/
│   ├── index.html            # HTML 入口 + 全局样式
│   ├── app.js                # React SPA（无 JSX，纯 React.createElement）
│   ├── icons.css             # 图标定义
│   └── vendor/               # React 生产构建
├── scripts/
│   └── release.js            # 版本发布脚本（版本号/CHANGELOG/git tag）
├── data/                     # SQLite 数据库（运行后生成）
└── CHANGELOG.md
```

## 性能参考

| 库规模 | 扫描耗时（16 线程） |
|--------|-------------------|
| 10 万首 | ~5 分钟 |
| 100 万首 | ~50 分钟 |
| 1000 万首 | ~8 小时 |

首次扫描后声纹缓存在 SQLite，增量扫描只处理新文件或已修改文件。

## License

MIT
