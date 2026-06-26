// lib/flac-writer.js — Pure-JS FLAC Vorbis Comment writer
// Reads the FLAC metadata block chain, replaces the VORBIS_COMMENT block
// with freshly-encoded tags, and rewrites the file. Uses a PADDING block
// to absorb small size changes in-place where possible. Falls back to a
// full-file rewrite when the new comment doesn't fit in the existing space.
//
// FLAC metadata block header format (4 bytes):
//   byte 0:   bit 7 = last-metadata-block flag; bits 0-6 = block type
//   bytes 1-3: block length in bytes (big-endian, 24-bit)
//
// Vorbis Comment content format (all little-endian):
//   4 bytes: vendor string length
//   N bytes: vendor string (UTF-8)
//   4 bytes: number of comments
//   For each comment:
//     4 bytes: comment string length
//     N bytes: "KEY=VALUE" (UTF-8)

import { readFileSync, writeFileSync } from 'fs';

const BLOCK_TYPE_VORBIS_COMMENT = 4;
const BLOCK_TYPE_PADDING        = 1;
const VENDOR = 'MusicDedup';
// How much PADDING to leave after the comment block so future small writes
// don't require a full file rewrite.
const PAD_BYTES = 512;

// ── Tag-name mapping ────────────────────────────────────────────────────
const FIELD_TO_VORBIS = {
  title:        'TITLE',
  artist:       'ARTIST',
  album:        'ALBUM',
  album_year:   'DATE',
  track_number: 'TRACKNUMBER',
};

// ── Binary helpers ───────────────────────────────────────────────────────
function readUInt24BE(buf, offset) {
  return (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
}
function writeUInt24BE(buf, offset, value) {
  buf[offset]     = (value >>> 16) & 0xff;
  buf[offset + 1] = (value >>>  8) & 0xff;
  buf[offset + 2] =  value         & 0xff;
}
function readUInt32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}
function writeUInt32LE(buf, offset, value) {
  buf.writeUInt32LE(value >>> 0, offset);
}

// ── Parse the metadata block chain ──────────────────────────────────────
function parseBlocks(buf) {
  if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'fLaC') {
    throw new Error('Not a valid FLAC file (missing fLaC signature)');
  }
  let pos = 4;
  const blocks = [];
  while (pos + 4 <= buf.length) {
    const b0     = buf[pos];
    const isLast = (b0 & 0x80) !== 0;
    const type   = b0 & 0x7f;
    const len    = readUInt24BE(buf, pos + 1);
    if (pos + 4 + len > buf.length) throw new Error('Malformed FLAC: block overruns file');
    blocks.push({
      type,
      isLast,
      headerOffset: pos,
      dataOffset:   pos + 4,
      len,
    });
    pos += 4 + len;
    if (isLast) break;
  }
  return { blocks, audioOffset: pos };
}

// ── Build a Vorbis Comment block payload ─────────────────────────────────
function buildVorbisCommentPayload(fields) {
  const vendorBuf = Buffer.from(VENDOR, 'utf8');
  // Build comment entries from non-empty fields
  const entries = [];
  for (const [key, vorbisKey] of Object.entries(FIELD_TO_VORBIS)) {
    const val = fields[key];
    if (val === undefined || val === null || val === '') continue;
    entries.push(Buffer.from(`${vorbisKey}=${val}`, 'utf8'));
  }

  // Calculate total size
  let size = 4 + vendorBuf.length + 4; // vendor_len + vendor + num_comments
  for (const e of entries) size += 4 + e.length;

  const payload = Buffer.allocUnsafe(size);
  let pos = 0;
  writeUInt32LE(payload, pos, vendorBuf.length);  pos += 4;
  vendorBuf.copy(payload, pos);                   pos += vendorBuf.length;
  writeUInt32LE(payload, pos, entries.length);    pos += 4;
  for (const e of entries) {
    writeUInt32LE(payload, pos, e.length); pos += 4;
    e.copy(payload, pos);                  pos += e.length;
  }
  return payload;
}

// ── Build a metadata block header (4 bytes) ──────────────────────────────
function buildBlockHeader(type, isLast, payloadLen) {
  const h = Buffer.allocUnsafe(4);
  h[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f);
  writeUInt24BE(h, 1, payloadLen);
  return h;
}

// ── Main export ──────────────────────────────────────────────────────────
export function writeFlacTags(filePath, fields) {
  const orig = readFileSync(filePath);
  const { blocks, audioOffset } = parseBlocks(orig);

  // Collect all blocks we want to keep (drop VORBIS_COMMENT + PADDING)
  const keepBlocks = blocks.filter(
    b => b.type !== BLOCK_TYPE_VORBIS_COMMENT && b.type !== BLOCK_TYPE_PADDING
  );

  // Build the new VORBIS_COMMENT payload
  const commentPayload = buildVorbisCommentPayload(fields);
  const paddingPayload = Buffer.alloc(PAD_BYTES);

  // Assemble output in parts
  const parts = [Buffer.from('fLaC')];

  // Keep-blocks come first (STREAMINFO must be first, which is guaranteed as
  // STREAMINFO is always first and we're preserving order)
  const allNew = [
    ...keepBlocks.map(b => ({ type: b.type, payload: orig.slice(b.dataOffset, b.dataOffset + b.len) })),
    { type: BLOCK_TYPE_VORBIS_COMMENT, payload: commentPayload },
    { type: BLOCK_TYPE_PADDING,        payload: paddingPayload  },
  ];

  for (let i = 0; i < allNew.length; i++) {
    const isLast = (i === allNew.length - 1);
    const { type, payload } = allNew[i];
    parts.push(buildBlockHeader(type, isLast, payload.length));
    parts.push(payload);
  }

  // Append original audio data unchanged
  parts.push(orig.slice(audioOffset));

  writeFileSync(filePath, Buffer.concat(parts));
}
