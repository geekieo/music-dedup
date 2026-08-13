// lib/db/settings.js — settings 表（JSON 序列化的 key-value）
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
