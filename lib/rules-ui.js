// lib/rules-ui.js — 展示层常量（计分/级联核心 lib/rules.js 的 UI 伴侣）
// 这里只放"标签文字/颜色/维度列/刮削档位描述"这类纯展示数据，供
// electron/protocol.js 的 rules-meta.js 生成器序列化给前端，以及 UI 过滤用。
// 核心逻辑（lib/rules.js）不依赖本模块；本模块可依赖核心。

export const PICK_TAG_COLOR = {
  quality_best: 'var(--amber)', scrape_best: '#0D9488', release_best: '#7C3AED',
  album_best: '#C2410C', meta_best: '#3B82F6', duration_accurate: '#DB2777',
  ctime_best: '#0891B2',
  manual_keep: 'var(--green)',
};

// ── Group-tag display data（标签文字/描述/颜色，服务端序列化给客户端）──────
export const GROUP_TAG_LABELS = {
  spectral_exact: '频谱声纹一致', same_recording: '频谱声纹相似', cp_exact: 'CP声纹一致', cp_similar: 'CP声纹相似',
  meta_confirmed: '属性匹配', mb_confirmed: 'MusicBrainz刮削一致', acoustid_confirmed: 'AcoustID刮削一致',
  fp_diff: '声纹不同', format_diff: '格式不同', format_same: '格式相同', filename_same: '文件名相同',
  metadata_same: '属性一致', metadata_diff: '属性不同', duration_same: '时长一致', duration_diff: '时长不同',
  release_year_diff: '年份不同', release_type_diff: '发行类型不同', meta_score_diff: '属性完整度不同', retention_tie: '保留平局',
};

// Exclusive pairs (see EXCLUSIVE_TAG_GROUPS below) share ONE merged,
// simplified description — both keys map to the same text so the legend
// can render the pair as a single row with a single explanation.
export const GROUP_TAG_DESCRIPTIONS = {
  spectral_exact: '频谱声纹相似度：完全一致，或达到阈值但未完全一致。',
  same_recording: '频谱声纹相似度：完全一致，或达到阈值但未完全一致。',
  cp_exact: 'Chromaprint 声纹相似度：≥98% 记为一致，≥90% 记为相似。与频谱声纹相互独立。',
  cp_similar: 'Chromaprint 声纹相似度：≥98% 记为一致，≥90% 记为相似。与频谱声纹相互独立。',
  meta_confirmed: '标题、艺术家、时长近似，不需要声纹即可判定为重复。',
  mb_confirmed: '被 MusicBrainz 文本搜索匹配到同一条录音，第三方数据库交叉确认。',
  acoustid_confirmed: '被 AcoustID 声纹识别匹配到同一条录音，比纯文本搜索更可信。',
  fp_diff: '频谱声纹和 Chromaprint 声纹均不相似、不一致。',
  format_diff: '文件格式是否一致（如 FLAC+MP3）。不同格式时按音质优先级择优，同音质选更大码率。',
  format_same: '文件格式是否一致（如 FLAC+MP3）。不同格式时按音质优先级择优，同音质选更大码率。',
  filename_same: '文件名（不含扩展名）完全相同。',
  metadata_same: '标题、艺术家、专辑（归一化后）是否一致。不一致时标签可能有误或写法不同。',
  metadata_diff: '标题、艺术家、专辑（归一化后）是否一致。不一致时标签可能有误或写法不同。',
  duration_same: '文件时长是否一致。不一致可能是不同版本，或编码误差（以精确刮削时长为准）。',
  duration_diff: '文件时长是否一致。不一致可能是不同版本，或编码误差（以精确刮削时长为准）。',
  release_year_diff: '组内发行年份不同，保留规则优先选首发专辑。',
  release_type_diff: '组内发行类型不同（专辑/单曲/原声/合辑），保留规则优先选专辑版。',
  meta_score_diff: '组内属性完整度不同，优先保留字段更全的文件。',
  retention_tie: '智能保留规则无法自动决定，需手动选择。',
};

export const GROUP_TAG_COLORS = {
  spectral_exact: ['#065F46','#D1FAE5','#A7F3D0'], same_recording: ['#1E40AF','#DBEAFE','#BFDBFE'],
  cp_exact: ['#B45309','#FEF3C7','#FDE68A'], cp_similar: ['#92400E','#FFF7ED','#FED7AA'],
  meta_confirmed: ['#0F766E','#CCFBF1','#99F6E4'], mb_confirmed: ['#7C3AED','#EDE9FE','#DDD6FE'],
  acoustid_confirmed: ['#0891B2','#CFFAFE','#A5F3FC'],
  fp_diff: ['#6B7280','#F3F4F6','#E5E7EB'], format_diff: ['#5B21B6','#EDE9FE','#DDD6FE'],
  format_same: ['#4338CA','#E0E7FF','#C7D2FE'], filename_same: ['#1D4ED8','#DBEAFE','#BFDBFE'],
  metadata_same: ['#0F766E','#CCFBF1','#99F6E4'], metadata_diff: ['#DC2626','#FEE2E2','#FECACA'],
  duration_same: ['#6B7280','#F3F4F6','#E5E7EB'], duration_diff: ['#D97706','#FEF3C7','#FDE68A'],
  release_year_diff: ['#7C3AED','#EDE9FE','#DDD6FE'], release_type_diff: ['#A21CAF','#FAE8FF','#F0ABFC'], meta_score_diff: ['#0F766E','#CCFBF1','#99F6E4'],
  retention_tie: ['#DC2626','#FEE2E2','#FECACA'],
};

// ── Tag category sets（派生自标签键，用于前端筛选栏）──────────────────────
export const CHARACTERISTIC_TAGS_ARRAY = [
  'format_same', 'format_diff', 'filename_same',
  'metadata_same', 'metadata_diff', 'duration_same', 'duration_diff',
  'release_year_diff', 'release_type_diff', 'meta_score_diff',
  'fp_diff', 'retention_tie',
];
// Stable display order for match-method tag buttons
export const MATCH_METHOD_TAGS_ARRAY = [
  'meta_confirmed', 'spectral_exact', 'same_recording', 'cp_exact', 'cp_similar',
  'mb_confirmed', 'acoustid_confirmed',
];

// Tag pairs that never co-occur on the same group (detectGroupTags assigns
// at most one from each pair via if/else-if). The client-side tag filter
// combines selections with AND, so letting both be selected together would
// be a self-contradictory filter that always returns zero results.
export const EXCLUSIVE_TAG_GROUPS = [
  ['spectral_exact', 'same_recording'],
  ['cp_exact', 'cp_similar'],
  ['format_same', 'format_diff'],
  ['duration_same', 'duration_diff'],
  ['metadata_same', 'metadata_diff'],
];

// ── Release-type labels（maps classifyReleaseType output to display text）──
export const RTYPE_LABEL = {
  album: '专辑', soundtrack: '原声', compilation: '合辑', single: '单曲', unknown: '未知',
};

// ── Dimension column definitions（客户端 DimensionTable 组件用）─────────────
// cell 函数读的是 evaluateGroup 在每条 track 上注出的 _quality/_meta/_rtype/
// _durationAccurate 等字段（核心层的输出契约）。
export const DIMENSION_DEFS = [
  { key: 'duration_accurate', label: '时长准确', icon: 'clock',
    cell: (t, all) => {
      if (t._durationAccurate === null) return { text: '无参考', ok: false, muted: true };
      const dev = Math.round(t._durationDeviation || 0);
      const applicable = all.filter(x => x._durationAccurate !== null);
      const minDev = Math.min(...applicable.map(x => Math.round(x._durationDeviation || 0)));
      const ok = t._durationAccurate && dev === minDev;
      return { text: t._durationAccurate ? `${Math.round(t.duration)}s ✓` : `${Math.round(t.duration)}s (偏差${dev}s)`, ok };
    }},
  { key: 'quality_best', label: '音质', icon: 'audio-levels',
    cell: (t, all) => {
      const max = Math.max(...all.map(x => x._quality || 0));
      const fmt = (t.format || '').toUpperCase();
      const text = t.bitrate ? `${fmt} ${t.bitrate}kbps` : fmt;
      return { text, ok: t._quality === max };
    }},
  { key: 'ctime_best', label: '入库时间', icon: 'download',
    cell: (t, all) => {
      const ctimes = all.map(x => x.file_ctime || 0);
      const max = Math.max(...ctimes);
      const has = (t.file_ctime || 0) > 0;
      let text = '无记录';
      if (has) { const d = new Date(t.file_ctime); text = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
      return { text, ok: has && (t.file_ctime || 0) === max, muted: !has };
    }},
  { key: 'album_best', label: '发行类型', icon: 'disc',
    cell: (t, all) => {
      const applicable = all.filter(x => x._rtypeScore > 0);
      const max = applicable.length ? Math.max(...applicable.map(x => x._rtypeScore)) : 0;
      const known = t._rtypeScore > 0;
      return { text: RTYPE_LABEL[t._rtype] || t._rtype || '未知', ok: known && t._rtypeScore === max, muted: !known };
    }},
  { key: 'release_best', label: '发行年份', icon: 'calendar',
    cell: (t, all) => {
      const applicable = all.filter(x => x.album_year > 0);
      const min = applicable.length ? Math.min(...applicable.map(x => x.album_year)) : null;
      const has = t.album_year > 0;
      return { text: has ? String(t.album_year) : '未知', ok: has && t.album_year === min, muted: !has };
    }},
  { key: 'scrape_best', label: '刮削吻合', icon: 'cloud-download',
    cell: (t, all) => {
      if (!t._scrapeVerified) return { text: '未刮削', ok: false, muted: true };
      const verified = all.filter(x => x._scrapeVerified);
      const max = Math.max(...verified.map(x => x._scrapeMatches || 0));
      return { text: `${t._scrapeMatches}/6 项`, ok: t._scrapeMatches === max };
    }},
  { key: 'meta_best', label: '属性完整度', icon: 'list-check',
    cell: (t, all) => {
      const max = Math.max(...all.map(x => x._meta || 0));
      return { text: `${t._meta}/6 项`, ok: t._meta === max };
    }},
];

export const DIMENSION_INFO = {
  duration_accurate: '本地时长是否与精确刮削一致；MB与AcoustID冲突时以MB为准，组内全部准确则不标注 — 读的是音频本身，标签改不了它',
  quality_best: '格式/码率/采样率/位深最高 — 同样是音频本身的客观事实',
  ctime_best: '文件创建时间越新越好 — 同一专辑后导入的可能是修正过的版本',
  album_best: '专辑版优先于单曲版，选的是更正确的版本',
  release_best: '年份越早越好，选的是更早的原版',
  scrape_best: '标题/艺术家/专辑/年份/曲目号/风格与 MusicBrainz 官方数据吻合数量（不含时长，时长已单独判断）— 只能证明标签被刮削比对过，不代表这份文件本身更原始',
  meta_best: '标题/艺术家/专辑/年份/曲目号/风格标签字段有值的数量 — 原始未刮削过的文件往往标签更少，这一项容易误伤"原汁原味"的版本，因此排最后，仅作为其他维度都打平时的兜底',
};

// 刮削档位展示（TIER_COLOR/LABEL/DESC）已随「绿蓝黄红」概念收敛到 lib/tier.js（单一出处）。
