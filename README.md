# MusicDedup

本地重复音乐管理工具 — 纯 JS 声纹识别 + 智能保留策略。

## 快速开始

**环境要求：Node.js ≥ 18**

```bash
npm install
npm start
```

浏览器打开 **http://localhost:3456**

## 使用流程

1. **设置** — 点击"添加文件夹"，选择音乐库目录
2. **扫描** — 三条匹配通道可独立执行：基础匹配（文件属性）/ 声纹匹配（频谱+Chromaprint）/ 刮削匹配（MusicBrainz+AcoustID）
3. **重复组** — 按匹配方法筛选，逐组确认保留方案
4. **写入** — 文件移入系统回收站，可撤销

## 核心功能

| 功能 | 说明 |
|------|------|
| 纯 JS 声纹识别 | Goertzel 频谱声纹，无需外部工具 |
| 多阶段检测 | 8 步执行流程：枚举→提取属性→属性匹配→提取声纹→频谱声纹匹配→CP声纹匹配→刮削→刮削匹配 |
| 三种匹配通道 | 基础匹配 / 声纹匹配 / 刮削匹配，各自独立运行、结果合并 |
| 智能保留 | 音质优先 → 首发专辑 → 单曲/专辑判断 → 属性完整性 |
| 手动覆盖 | 点击任意曲目图标，覆盖自动建议 |
| 安全删除 | 移入系统回收站，可撤销 |
| 实时进度 | SSE 推送，多客户端可见 |
| 暂停/继续/停止 | 扫描任意阶段边界均可操作 |

## 重复判断逻辑

### 8 步执行流程

| 步骤 | 名称 | 模块 | 说明 |
|------|------|------|------|
| 1 | 枚举 | scanner.js | 扫描目录，发现文件，入库 |
| 2 | 提取属性 | scanner.js | 读取文件标签（标题/艺术家/专辑/时长等） |
| 3 | 属性匹配 | matcher.js | 标题分组 → 元数据确认（不依赖声纹） |
| 4 | 提取声纹 | scanner.js | 频谱声纹(Goertzel) + CP声纹(fpcalc) |
| 5 | 频谱声纹匹配 | matcher.js | 精确声纹 → LSH分组 → 时长桶+相似度 |
| 6 | CP声纹匹配 | matcher.js | Chromaprint 相似度比较（硬编码阈值 0.90） |
| 7 | 刮削 | scraper.js | MB / AcoustID API 获取外部元数据 |
| 8 | 刮削匹配 | matcher.js | MB/AcoustID recording ID 对比 |

### 扫描页三个匹配通道

| 通道 | 对应步骤 | 说明 |
|------|---------|------|
| 属性匹配 | 步骤 3 | 标题分组 + 元数据确认，不依赖声纹 |
| 声纹匹配 | 步骤 5+6 | 频谱声纹 + CP声纹 |
| 刮削匹配 | 步骤 8 | recording ID 对比 |

> 三条通道独立运行、结果合并。全量匹配 = 步骤 3+5+6+8 全集。

### 保留策略

1. **音质最优** — Hi-Res FLAC > FLAC > WAV > M4A > MP3 320k > …
2. **首发专辑** — 年份最早的正式专辑
3. **单曲 vs 专辑** — 本地专辑 ≥ 2 首保留专辑版
4. **属性完整性** — 标签最完整的文件

## 声纹算法

基于 **Goertzel 频谱声纹**（Sub-band Spectral Fingerprinting）：

1. 音频解码为 PCM（MP3、FLAC、M4A、OGG、WAV 等）
2. 重采样至 11025 Hz 单声道
3. Goertzel 算法计算 33 个对数均匀分布频率（300 Hz–2 kHz）的能量
4. 比较相邻帧的频谱斜率变化方向 → 32 位整数
5. ~120 个整数构成声纹（约 1 秒音频）

相似度：Hamming 距离逐位比较。

### Chromaprint（可选）

下载 [fpcalc](https://acoustid.org/chromaprint) 放到项目根目录，可启用独立的 Chromaprint 声纹比对，与频谱声纹互补。同一份 Chromaprint 数据也用于 AcoustID 刮削。

## 部署

### 本地

```bash
npm install && npm start
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

### Nginx 反向代理（SSE 关键配置）

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
| GET | /api/stats | 库统计 |
| GET | /api/settings | 获取设置 |
| PUT | /api/settings | 保存设置 |
| GET | /api/library | 音乐库分页查询 |
| POST | /api/browse-folder | 系统文件夹选择对话框 |
| POST | /api/scan/start | 启动扫描 |
| POST | /api/scan/pause | 暂停扫描 |
| POST | /api/scan/resume | 恢复扫描 |
| POST | /api/scan/abort | 停止扫描 |
| GET | /api/scan/stream | SSE 进度流 |
| GET | /api/duplicates | 重复组列表 |
| GET | /api/duplicates/:id | 重复组详情 |
| POST | /api/duplicates/:id/resolve | 确认删除 |
| PUT | /api/duplicates/:id/tracks/:fid/keep | 手动覆盖 |

扫描通道详见 [CHANGELOG.md](CHANGELOG.md#v1.10.1)。

## 项目结构

```
musicdedup/
├── server.js               # Express 入口 + API 路由
├── lib/
│   ├── db.js               # SQLite (WASM) 数据层
│   ├── fingerprint.js      # 纯 JS Goertzel 频谱声纹
│   ├── chromaprint-bridge.js # fpcalc 桥接
│   ├── scanner.js          # 文件扫描 + 文件属性/声纹提取
│   ├── scraper.js          # MusicBrainz / AcoustID 刮削
│   ├── matcher.js          # 多阶段重复检测引擎
│   ├── rules.js            # 智能保留规则 + 匹配标签
│   └── tagger.js           # 标签读写 + 写入历史
├── public/
│   ├── index.html
│   └── app.js              # React SPA
├── data/                   # SQLite 数据库（运行后创建）
├── CHANGELOG.md            # 版本更新日志
└── README.md
```

## 性能参考

| 库规模 | 扫描耗时（16线程） |
|--------|-------------------|
| 10 万首 | ~5 分钟 |
| 100 万首 | ~50 分钟 |
| 1000 万首 | ~8 小时 |

首次扫描后声纹缓存在 SQLite，增量扫描只处理新文件。

## License

MIT
