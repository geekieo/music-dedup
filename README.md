# MusicDedup

本地重复音乐管理工具，支持千万级音乐库。

**纯 JavaScript 声纹识别**，无需安装任何外部工具。基于 Goertzel 频谱指纹算法，识别同一录音的不同格式与音质版本，结合智能保留规则自动决策。

---

## 快速开始

**环境要求：Node.js ≥ 18**

```bash
npm install
npm start
```

浏览器打开 **http://localhost:3456**

---

## 使用流程

1. **设置** — 添加音乐库目录（如 `/Volumes/Music` 或 `D:\Music`）
2. **扫描** — 开始扫描，实时查看进度
3. **重复组** — 查看发现的重复组，确认删除方案
4. **确认** — 文件移入系统回收站，可撤销

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 纯 JS 声纹识别 | Goertzel 频谱指纹，无需外部工具，识别同一录音的不同格式/音质 |
| 多阶段检测 | 精确指纹匹配 → 标题匹配 → 指纹前缀 LSH → 时长分桶，逐层扩大召回 |
| 智能保留 | 音质优先 → 首发专辑 → 单曲/专辑判断 → 元数据完整性 |
| 手动覆盖 | 点击任意曲目图标，覆盖自动建议 |
| 批量操作 | 一键确认所有待处理重复组 |
| 安全删除 | 移入系统回收站，不立即永久删除 |
| 实时进度 | SSE 推送扫描进度，多客户端同时可见 |
| 自动保存 | 设置修改后 700ms 防抖自动保存 |

---

## 重复判断逻辑

### 识别阶段（4 阶段）

| 阶段 | 方法 | 说明 |
|------|------|------|
| 1 | 精确指纹匹配 | 指纹字符串完全相同 → 必定重复，无需阈值 |
| 2 | 标题匹配 | 从元数据或文件名提取歌名，归组后比对指纹 |
| 3 | 指纹前缀 LSH | 相同音频前缀整数相同，归组后比对全指纹 |
| 4 | 时长分桶 | 相同时长（±4s）归组，比对指纹 |

### 保留策略（优先级）

1. **音质最优** — Hi-Res FLAC > FLAC > WAV > M4A > MP3 320k > …
2. **首发专辑** — 年份最早的正式专辑（合辑不算）
3. **单曲 vs 专辑** — 本地专辑 ≥ 2 首保留专辑版；否则保留单曲版
4. **元数据完整性** — 标签最完整的文件

---

## 声纹算法说明

基于 **Goertzel 频谱指纹**（Sub-band Spectral Fingerprinting）：

1. 将音频解码为 PCM（支持 MP3、FLAC、M4A、OGG、WAV 等格式）
2. 重采样至 11025 Hz 单声道
3. 用 Goertzel 算法计算 33 个对数均匀分布频率（300 Hz–2 kHz）的能量
4. 比较相邻帧的频谱斜率变化方向 → 32 位整数
5. 120 个整数构成指纹（约 1 秒音频，快速且可靠）

相似度计算：对两个整数数组逐位做 Hamming 距离，即与 Chromaprint 相同的比较方法。

---

## 部署

### 本地（推荐）

```bash
npm install && npm start
# 打开 http://localhost:3456
```

### PM2 后台运行

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

```bash
docker build -t musicdedup .
docker run -d -p 3456:3456 \
  -v /your/music:/music:ro \
  -v musicdedup-data:/app/data \
  musicdedup
```

### Nginx 反向代理（SSE 关键配置）

```nginx
location / {
    proxy_pass http://localhost:3456;
    proxy_http_version 1.1;
    proxy_buffering off;       # SSE 必须关闭缓冲
    proxy_cache off;
    proxy_set_header Connection '';
    chunked_transfer_encoding on;
}
```

---

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/stats | 库统计 |
| GET | /api/settings | 获取设置 |
| PUT | /api/settings | 保存设置 |
| POST | /api/scan/start | 启动扫描 |
| POST | /api/scan/abort | 中止扫描 |
| GET | /api/scan/stream | SSE 进度流 |
| GET | /api/duplicates | 重复组列表（`?resolved=0/1`） |
| GET | /api/duplicates/:id | 重复组详情 |
| POST | /api/duplicates/:id/resolve | 确认删除 |
| POST | /api/duplicates/resolve-all | 批量确认 |
| PUT | /api/duplicates/:id/tracks/:fid/keep | 手动覆盖 |

---

## 项目结构

```
musicdedup/
├── server.js        # Express 入口 + 所有 API 路由
├── lib/
│   ├── db.js        # SQLite (WASM) schema + 查询
│   ├── fingerprint.js  # 纯 JS 声纹指纹
│   ├── scanner.js   # 文件扫描 + 元数据提取
│   ├── matcher.js   # 多阶段重复检测
│   └── rules.js     # 保留规则引擎
├── public/
│   ├── index.html   # 入口 HTML
│   └── app.js       # React SPA
├── data/            # SQLite 数据库（运行后自动创建）
└── README.md
```

---

## 性能参考

| 库规模 | 扫描耗时（16线程） |
|--------|------------------|
| 10 万首 | ~5 分钟 |
| 100 万首 | ~50 分钟 |
| 1000 万首 | ~8 小时 |

首次扫描后指纹缓存在 SQLite，增量扫描只处理新文件。
