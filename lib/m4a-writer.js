// lib/m4a-writer.js — Pure-JS M4A/MP4 iTunes atom tag writer
//
// MP4/M4A files use the ISO Base Media File Format (ISO BMFF).
// Tags live at: moov → udta → meta → ilst
//
// Each atom:  4B size (BE) | 4B type (ASCII) | data
// "Full" atoms have an extra 4B version+flags after the type.
// meta and hdlr are full atoms.
//
// iTunes ilst children:
//   ©nam  title       (data: type 1 = UTF-8)
//   ©ART  artist      (data: type 1 = UTF-8)
//   ©alb  album       (data: type 1 = UTF-8)
//   ©day  year        (data: type 1 = UTF-8, usually just "2020")
//   trkn  track num   (data: type 0 = implicit integer, 8 bytes: 0,0,hi,lo,0,0,hi,lo)
//
// If moov comes BEFORE mdat in the file (streaming-optimised layout, common
// for downloaded/purchased files) then changing moov's size shifts the mdat
// offset; all chunk offsets in stco/co64 atoms must be adjusted by delta.
// If mdat comes first, no adjustment is needed.

import { readFileSync, writeFileSync } from 'fs';

// ── Atom helpers ─────────────────────────────────────────────────────────
function readAtoms(buf, start, end) {
  const atoms = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (size === 1) {
      // Extended 64-bit size — rare in music files, skip for safety
      break;
    }
    if (size === 0) size = end - pos; // size 0 = extend to end of container
    if (size < 8 || pos + size > end) break;
    atoms.push({ type, start: pos, size, dataStart: pos + 8, dataEnd: pos + size });
    pos += size;
  }
  return atoms;
}

function buildAtom(type, data) {
  const size = 8 + data.length;
  const hdr = Buffer.allocUnsafe(8);
  hdr.writeUInt32BE(size, 0);
  hdr.write(type.padEnd(4), 4, 4, 'latin1'); // latin1 handles © prefix (0xA9)
  return Buffer.concat([hdr, data]);
}

function buildFullAtom(type, version, flags, data) {
  const fullHdr = Buffer.allocUnsafe(4);
  fullHdr[0] = version;
  fullHdr.writeUIntBE(flags, 1, 3);
  return buildAtom(type, Buffer.concat([fullHdr, data]));
}

// ── Build iTunes data atoms ───────────────────────────────────────────────
function dataAtom(typeCode, localeCode, payload) {
  const hdr = Buffer.allocUnsafe(8);
  hdr.writeUInt32BE(typeCode,  0);
  hdr.writeUInt32BE(localeCode, 4);
  return buildAtom('data', Buffer.concat([hdr, payload]));
}

function textDataAtom(text) {
  return dataAtom(1, 0, Buffer.from(String(text), 'utf8'));
}

function trknDataAtom(track) {
  const n = parseInt(track) || 0;
  const payload = Buffer.alloc(8);
  payload.writeUInt16BE(n, 2); // bytes 2-3 = track number
  return dataAtom(0, 0, payload);
}

// ── Build the complete ilst atom from fields ──────────────────────────────
const ILST_MAP = {
  title:        '\xa9nam',
  artist:       '\xa9ART',
  album:        '\xa9alb',
  album_year:   '\xa9day',
  track_number: 'trkn',
};

function buildIlst(fields) {
  const parts = [];
  for (const [field, atomKey] of Object.entries(ILST_MAP)) {
    const val = fields[field];
    if (val === undefined || val === null || val === '') continue;
    const inner = field === 'track_number' ? trknDataAtom(val) : textDataAtom(val);
    parts.push(buildAtom(atomKey, inner));
  }
  if (parts.length === 0) return buildAtom('ilst', Buffer.alloc(0));
  return buildAtom('ilst', Buffer.concat(parts));
}

// ── Build hdlr atom (required inside meta) ────────────────────────────────
function buildHdlr() {
  const payload = Buffer.alloc(25);
  payload.write('mdir', 8, 4, 'ascii'); // handler type
  return buildFullAtom('hdlr', 0, 0, payload);
}

// ── Adjust stco/co64 chunk offsets by delta ───────────────────────────────
// Recursively walks a moov buffer that we've already built, finds all stco
// and co64 full atoms, and adds delta to every chunk offset.
function adjustStco(buf, start, end, delta) {
  const CONTAINERS = new Set(['moov','trak','mdia','minf','stbl','dinf']);
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (size === 0) size = end - pos;
    if (size < 8 || pos + size > end) break;

    if (type === 'stco') {
      // Full atom: version(1)+flags(3)+count(4)+entries(4B each)
      const count = buf.readUInt32BE(pos + 12);
      for (let i = 0; i < count; i++) {
        const off = pos + 16 + i * 4;
        buf.writeUInt32BE(buf.readUInt32BE(off) + delta, off);
      }
    } else if (type === 'co64') {
      // 8-byte offsets — delta assumed to fit in lower 32 bits
      const count = buf.readUInt32BE(pos + 12);
      for (let i = 0; i < count; i++) {
        const off = pos + 16 + i * 8;
        const lo = buf.readUInt32BE(off + 4) + delta;
        buf.writeUInt32BE(lo >>> 0, off + 4);
        if (lo > 0xffffffff) buf.writeUInt32BE(buf.readUInt32BE(off) + 1, off);
      }
    } else if (CONTAINERS.has(type)) {
      adjustStco(buf, pos + 8, pos + size, delta);
    }
    pos += size;
  }
}

// ── Rebuild the moov atom with new tags ───────────────────────────────────
function rebuildMoov(origBuf, moovAtom, fields) {
  const moovAtoms = readAtoms(origBuf, moovAtom.dataStart, moovAtom.dataEnd);

  // Build new udta/meta/ilst hierarchy
  const ilst   = buildIlst(fields);
  const hdlr   = buildHdlr();
  const metaPayload = Buffer.concat([Buffer.alloc(4), hdlr, ilst]); // 4B full-atom header
  const meta   = buildAtom('meta', metaPayload);
  const udta   = buildAtom('udta', meta);

  // Replace (or add) udta in moov's child atoms
  const moovChildren = [];
  let foundUdta = false;
  for (const a of moovAtoms) {
    if (a.type === 'udta') { moovChildren.push(udta); foundUdta = true; }
    else moovChildren.push(origBuf.slice(a.start, a.start + a.size));
  }
  if (!foundUdta) moovChildren.push(udta);

  return buildAtom('moov', Buffer.concat(moovChildren));
}

// ── Main export ──────────────────────────────────────────────────────────
export function writeM4aTags(filePath, fields) {
  const orig = readFileSync(filePath);
  const topAtoms = readAtoms(orig, 0, orig.length);

  const moovAtom = topAtoms.find(a => a.type === 'moov');
  if (!moovAtom) throw new Error('No moov atom found — not a valid M4A/MP4 file');

  const mdatAtom = topAtoms.find(a => a.type === 'mdat');
  const mdatAfterMoov = mdatAtom && mdatAtom.start > moovAtom.start;

  // Build new moov
  const newMoov = rebuildMoov(orig, moovAtom, fields);
  const delta   = newMoov.length - moovAtom.size;

  // Adjust chunk offsets if mdat comes after moov and size changed
  if (mdatAfterMoov && delta !== 0) {
    adjustStco(newMoov, 8, newMoov.length, delta); // start at 8 to skip moov's own header
  }

  // Reassemble the file with new moov in its original position
  const parts = [];
  for (const a of topAtoms) {
    if (a.type === 'moov') parts.push(newMoov);
    else parts.push(orig.slice(a.start, a.start + a.size));
  }

  writeFileSync(filePath, Buffer.concat(parts));
}
