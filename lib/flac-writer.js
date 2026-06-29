// lib/flac-writer.js — FLAC Vorbis Comment read+write
// IMPORTANT: writeFlacTags() READS all existing Vorbis Comments first, then
// MERGES the provided updates, so unknown/extra fields are never lost.
import { readFileSync, writeFileSync } from 'fs';

const BLOCK_TYPE_VORBIS_COMMENT = 4;
const BLOCK_TYPE_PADDING        = 1;
const VENDOR  = 'MusicDedup';
const PAD_BYTES = 512;

// ── Field-name → Vorbis Comment key mapping (extensible) ────────────────
export const FIELD_TO_VORBIS = {
  title:        'TITLE',
  artist:       'ARTIST',
  album:        'ALBUM',
  album_year:   'DATE',
  track_number: 'TRACKNUMBER',
  genre:        'GENRE',
  composer:     'COMPOSER',
  comment:      'COMMENT',
  isrc:         'ISRC',
  album_artist: 'ALBUMARTIST',
  disc_number:  'DISCNUMBER',
  total_tracks: 'TOTALTRACKS',
};

// ── Binary helpers ───────────────────────────────────────────────────────
function r24BE(buf, o)  { return (buf[o]<<16)|(buf[o+1]<<8)|buf[o+2]; }
function w24BE(buf, o, v){ buf[o]=(v>>>16)&0xff; buf[o+1]=(v>>>8)&0xff; buf[o+2]=v&0xff; }
function r32LE(buf, o)  { return buf.readUInt32LE(o); }
function w32LE(buf, o, v){ buf.writeUInt32LE(v>>>0, o); }

// ── Parse block chain ────────────────────────────────────────────────────
function parseBlocks(buf) {
  if (buf.length < 4 || buf.toString('ascii',0,4) !== 'fLaC')
    throw new Error('Not a FLAC file');
  let pos = 4;
  const blocks = [];
  while (pos + 4 <= buf.length) {
    const b0 = buf[pos];
    const type = b0 & 0x7f;
    const len  = r24BE(buf, pos+1);
    blocks.push({ type, isLast:!!(b0&0x80), headerOffset:pos, dataOffset:pos+4, len });
    pos += 4 + len;
    if (b0 & 0x80) break;
  }
  return { blocks, audioOffset: pos };
}

// ── Vorbis Comment binary parser → {KEY: 'value'} ───────────────────────
function parseVorbisPayload(payload) {
  const tags = {};
  let pos = 0;
  if (pos + 4 > payload.length) return tags;
  const vl = r32LE(payload, pos); pos += 4 + vl;        // skip vendor
  if (pos + 4 > payload.length) return tags;
  const count = r32LE(payload, pos); pos += 4;
  for (let i = 0; i < count; i++) {
    if (pos + 4 > payload.length) break;
    const el = r32LE(payload, pos); pos += 4;
    if (pos + el > payload.length) break;
    const entry = payload.toString('utf8', pos, pos + el); pos += el;
    const eq = entry.indexOf('=');
    if (eq > 0) tags[entry.slice(0, eq).toUpperCase()] = entry.slice(eq+1);
  }
  return tags;
}

// ── Build Vorbis Comment payload from {KEY: 'value'} map ────────────────
function buildVorbisPayload(rawTags) {
  const vendor  = Buffer.from(VENDOR, 'utf8');
  const entries = Object.entries(rawTags)
    .filter(([,v]) => v !== null && v !== undefined && v !== '')
    .map(([k,v]) => Buffer.from(`${k}=${v}`, 'utf8'));
  let sz = 4 + vendor.length + 4;
  for (const e of entries) sz += 4 + e.length;
  const buf = Buffer.allocUnsafe(sz);
  let pos = 0;
  w32LE(buf, pos, vendor.length); pos += 4;
  vendor.copy(buf, pos); pos += vendor.length;
  w32LE(buf, pos, entries.length); pos += 4;
  for (const e of entries) { w32LE(buf, pos, e.length); pos+=4; e.copy(buf, pos); pos+=e.length; }
  return buf;
}

function blockHeader(type, isLast, len) {
  const h = Buffer.allocUnsafe(4);
  h[0] = (isLast ? 0x80 : 0) | (type & 0x7f);
  w24BE(h, 1, len);
  return h;
}

// ── Public: read ALL existing Vorbis Comments as {KEY: 'value'} ─────────
export function readFlacRawTags(filePath) {
  try {
    const buf = readFileSync(filePath);
    const { blocks } = parseBlocks(buf);
    const cb = blocks.find(b => b.type === BLOCK_TYPE_VORBIS_COMMENT);
    if (!cb) return {};
    return parseVorbisPayload(buf.slice(cb.dataOffset, cb.dataOffset + cb.len));
  } catch { return {}; }
}

// ── Public: write tags (merges with existing — unknown fields are kept) ──
export function writeFlacTags(filePath, updatedFields) {
  const orig = readFileSync(filePath);
  const { blocks, audioOffset } = parseBlocks(orig);

  // Step 1: read ALL existing raw Vorbis Comments
  const existing = blocks.find(b => b.type === BLOCK_TYPE_VORBIS_COMMENT);
  const rawTags  = existing
    ? parseVorbisPayload(orig.slice(existing.dataOffset, existing.dataOffset + existing.len))
    : {};

  // Step 2: overlay only the provided updates
  for (const [ourKey, vorbisKey] of Object.entries(FIELD_TO_VORBIS)) {
    const val = updatedFields[ourKey];
    if (val !== undefined && val !== null && val !== ''
        && !(typeof val === 'number' && val === 0)) {
      rawTags[vorbisKey] = String(val);
    }
  }

  // Step 3: rebuild file
  const commentPayload = buildVorbisPayload(rawTags);
  const padding        = Buffer.alloc(PAD_BYTES);
  const keepBlocks     = blocks.filter(b =>
    b.type !== BLOCK_TYPE_VORBIS_COMMENT && b.type !== BLOCK_TYPE_PADDING);
  const allNew = [
    ...keepBlocks.map(b => ({ type:b.type, data:orig.slice(b.dataOffset, b.dataOffset+b.len) })),
    { type: BLOCK_TYPE_VORBIS_COMMENT, data: commentPayload },
    { type: BLOCK_TYPE_PADDING,        data: padding },
  ];
  const parts = [Buffer.from('fLaC')];
  allNew.forEach(({ type, data }, i) => {
    parts.push(blockHeader(type, i===allNew.length-1, data.length));
    parts.push(data);
  });
  parts.push(orig.slice(audioOffset));
  writeFileSync(filePath, Buffer.concat(parts));
}

// ── Public: write raw {KEY:'value'} tags directly (used for revert) ─────
export function writeFlacRawTags(filePath, rawTags) {
  const orig = readFileSync(filePath);
  const { blocks, audioOffset } = parseBlocks(orig);
  const commentPayload = buildVorbisPayload(rawTags);
  const padding        = Buffer.alloc(PAD_BYTES);
  const keepBlocks     = blocks.filter(b =>
    b.type !== BLOCK_TYPE_VORBIS_COMMENT && b.type !== BLOCK_TYPE_PADDING);
  const allNew = [
    ...keepBlocks.map(b => ({ type:b.type, data:orig.slice(b.dataOffset, b.dataOffset+b.len) })),
    { type: BLOCK_TYPE_VORBIS_COMMENT, data: commentPayload },
    { type: BLOCK_TYPE_PADDING,        data: padding },
  ];
  const parts = [Buffer.from('fLaC')];
  allNew.forEach(({ type, data }, i) => {
    parts.push(blockHeader(type, i===allNew.length-1, data.length));
    parts.push(data);
  });
  parts.push(orig.slice(audioOffset));
  writeFileSync(filePath, Buffer.concat(parts));
}
