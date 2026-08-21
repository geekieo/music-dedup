// lib/constants.js — 相似度/评分阈值单一出处
// 领域调参都收敛于此：改阈值只动一处；各模块按需 import。
// 注意：数值相同不代表同一概念（如 0.75 既是频谱相似度下限也是刮削评分权重），
// 勿擅自合并不同含义的常量。

// ── 频谱声纹（Goertzel）相似度 ─────────────────────────────────────────────
export const SPECTRAL_SIM_MIN  = 0.75; // 低于此不视为相似匹配（fingerprint metaSim）
export const SPECTRAL_SIM_CAP  = 0.96; // 相似度映射上限（fingerprint metaSim）
export const SPECTRAL_EXACT_SIM = 0.97; // 视为"完全一致"的频谱相似度（matcher VERY_HIGH_SIM）

// ── Chromaprint 声纹相似度 ────────────────────────────────────────────────
export const CP_EXACT_SIM   = 0.98; // ≥98% 记为 cp_exact（rules detectGroupTags）
export const CP_SIMILAR_SIM = 0.90; // ≥90% 记为 cp_similar（matcher CP_THRESH）

// ── 刮削候选评分（scraper selectRelease）──────────────────────────────────
export const SCRAPE_SIM_WEIGHT    = 0.75; // 相似度在候选评分中的权重
export const SCRAPE_SCR_WEIGHT    = 0.25; // 刮削可信度在候选评分中的权重
export const SCRAPE_TOP_FRACTION  = 0.9;  // 候选阈值 = 最高分 × 此比例
export const SCRAPE_MIN_THRESHOLD = 0.4;  // 候选阈值下限
