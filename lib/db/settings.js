// lib/db/settings.js — settings 表（JSON 序列化的 key-value）
import { DEFAULT_TIER_ORDER, DEFAULT_PICK_TAG_ORDER } from '../rules.js';

export function getSetting(db, key, fallback=null) {
  const row = db.get('SELECT value FROM settings WHERE key=?', [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
export function setSetting(db, key, value) {
  db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, JSON.stringify(value)]);
}
export function getAllSettings(db) {
  const rows = db.all('SELECT key,value FROM settings');
  const out = {};
  for (const r of rows) { try { out[r.key]=JSON.parse(r.value); } catch { out[r.key]=r.value; } }
  return out;
}

// 智能保留的"已应用"优先级快照：所有智能保留计算只读快照（applied → 默认 两级回退，
// 绝不落到当前草稿值），只有显式执行（扫描含匹配/智能保留步骤，或设置页"立即重新计算"）
// 才更新。当前设置是草稿，未执行前不允许进入任何计算（所见即所得）。
export function getAppliedPickSettings(db) {
  const aq = getSetting(db, 'quality_tiers_applied');
  const ap = getSetting(db, 'pick_tag_order_applied');
  return {
    quality_tiers:  Array.isArray(aq) && aq.length ? aq : DEFAULT_TIER_ORDER,
    pick_tag_order: Array.isArray(ap) && ap.length ? ap : DEFAULT_PICK_TAG_ORDER,
  };
}
export function setAppliedPickSettings(db, { quality_tiers, pick_tag_order }) {
  setSetting(db, 'quality_tiers_applied',  quality_tiers  ?? null);
  setSetting(db, 'pick_tag_order_applied', pick_tag_order ?? null);
}
