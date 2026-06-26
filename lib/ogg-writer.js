// lib/ogg-writer.js — Pure-JS OGG Vorbis / Opus comment writer
//
// OGG Container page layout (all integers little-endian unless noted):
//   4B  capture pattern "OggS"
//   1B  version (0)
//   1B  header_type: 0x00=continuation, 0x02=bos, 0x04=eos
//   8B  granule_position (int64 LE)
//   4B  bitstream_serial_number
//   4B  page_sequence_number
//   4B  checksum (CRC32 with generator 0x04c11db7, LE; field is zeroed when computing)
//   1B  number_page_segments
//   NB  segment_table (lace values; 255 = more data follows in next segment)
//   MB  page_data (concatenated segment data)
//
// Vorbis Comment packet: 0x03 + "vorbis" + standard Vorbis comment + 0x01 framing
// Opus   Comment packet: "OpusTags"       + standard Vorbis comment  (no framing)
//
// Standard Vorbis comment structure (little-endian):
//   4B  vendor_string_length
//   NB  vendor_string (UTF-8)
//   4B  num_comments
//   For each comment:
//     4B  comment_length
//     NB  "KEY=VALUE" (UTF-8)

import { readFileSync, writeFileSync } from 'fs';

const VENDOR = 'MusicDedup';
const FIELD_TO_VORBIS = {
  title: 'TITLE', artist: 'ARTIST', album: 'ALBUM',
  album_year: 'DATE', track_number: 'TRACKNUMBER',
};

// ── OGG-specific CRC32 (polynomial 0x04c11db7, MSB-first, no reflection) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    }
    t[i] = r;
  }
  return t;
})();

function oggCrc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  }
  return crc;
}

// ── Parse OGG pages ──────────────────────────────────────────────────────
function parsePages(buf) {
  const pages = [];
  let pos = 0;
  while (pos + 27 <= buf.length) {
    if (buf.toString('ascii', pos, pos + 4) !== 'OggS') break;
    const version      = buf[pos + 4];
    const headerType   = buf[pos + 5];
    const granule      = buf.slice(pos + 6, pos + 14);       // 8 bytes
    const serial       = buf.readUInt32LE(pos + 14);
    const seqno        = buf.readUInt32LE(pos + 18);
    const numSegs      = buf[pos + 26];
    if (pos + 27 + numSegs > buf.length) break;
    const segTable     = buf.slice(pos + 27, pos + 27 + numSegs);
    let dataLen        = 0;
    for (let i = 0; i < numSegs; i++) dataLen += segTable[i];
    const dataStart    = pos + 27 + numSegs;
    if (dataStart + dataLen > buf.length) break;
    const data         = buf.slice(dataStart, dataStart + dataLen);
    pages.push({ pos, version, headerType, granule, serial, seqno, numSegs, segTable, data, totalLen: 27 + numSegs + dataLen });
    pos += 27 + numSegs + dataLen;
  }
  return pages;
}

// ── Encode a packet into OGG page(s) ────────────────────────────────────
function packetToPages(packet, serial, seqnoStart, headerType = 0x00, granule = null) {
  const pages = [];
  let offset = 0;
  let seqno  = seqnoStart;
  const gran = granule || Buffer.alloc(8); // 8 zero bytes

  while (offset < packet.length || pages.length === 0) {
    const MAX_PAGE_DATA = 255 * 255; // 65025 bytes max per page
    const chunk = packet.slice(offset, offset + MAX_PAGE_DATA);
    offset += chunk.length;
    const isLast = (offset >= packet.length);

    // Build segment table using lacing
    const segs = [];
    let remaining = chunk.length;
    while (remaining >= 255) { segs.push(255); remaining -= 255; }
    // If packet continues to next page (remaining === 0 after a full 255), we
    // intentionally do NOT add a terminating 0-segment — the next page's
    // continued flag handles it. Otherwise add the final segment length.
    if (isLast) segs.push(remaining); // terminator, may be 0 if exactly divisible
    else if (remaining > 0) segs.push(remaining);

    // Assemble the header
    const ht = pages.length === 0 ? headerType : 0x00; // continuation pages have type 0
    const pageHeader = Buffer.allocUnsafe(27 + segs.length);
    pageHeader.write('OggS', 0, 'ascii');
    pageHeader[4]  = 0; // version
    pageHeader[5]  = ht;
    gran.copy(pageHeader, 6);
    pageHeader.writeUInt32LE(serial, 14);
    pageHeader.writeUInt32LE(seqno,  18);
    pageHeader.writeUInt32LE(0,      22); // checksum placeholder
    pageHeader[26] = segs.length;
    for (let i = 0; i < segs.length; i++) pageHeader[27 + i] = segs[i];

    const page = Buffer.concat([pageHeader, chunk]);
    // Write checksum in-place
    const crc = oggCrc32(page);
    page.writeUInt32LE(crc, 22);
    pages.push(page);
    seqno++;
  }
  return pages;
}

// ── Identify stream type from the first page ──────────────────────────────
function detectStreamType(firstPageData) {
  if (firstPageData.length >= 7 && firstPageData[0] === 0x01 && firstPageData.toString('ascii', 1, 7) === 'vorbis') return 'vorbis';
  if (firstPageData.length >= 8 && firstPageData.toString('ascii', 0, 8) === 'OpusHead') return 'opus';
  return 'unknown';
}

// ── Rebuild a Vorbis comment body ─────────────────────────────────────────
function buildCommentBody(fields) {
  const vendor = Buffer.from(VENDOR, 'utf8');
  const entries = [];
  for (const [k, vk] of Object.entries(FIELD_TO_VORBIS)) {
    const v = fields[k];
    if (v === undefined || v === null || v === '') continue;
    entries.push(Buffer.from(`${vk}=${v}`, 'utf8'));
  }
  let sz = 4 + vendor.length + 4;
  for (const e of entries) sz += 4 + e.length;
  const buf = Buffer.allocUnsafe(sz);
  let pos = 0;
  buf.writeUInt32LE(vendor.length, pos); pos += 4;
  vendor.copy(buf, pos);                 pos += vendor.length;
  buf.writeUInt32LE(entries.length, pos); pos += 4;
  for (const e of entries) {
    buf.writeUInt32LE(e.length, pos); pos += 4;
    e.copy(buf, pos);                 pos += e.length;
  }
  return buf;
}

// ── Build a complete comment header packet ────────────────────────────────
function buildCommentPacket(streamType, fields) {
  const body = buildCommentBody(fields);
  if (streamType === 'opus') {
    // OpusTags: "OpusTags" + comment body (no framing bit)
    const hdr = Buffer.from('OpusTags', 'ascii');
    return Buffer.concat([hdr, body]);
  }
  // Vorbis: 0x03 + "vorbis" + comment body + framing bit (0x01)
  const hdr = Buffer.allocUnsafe(7);
  hdr[0] = 0x03;
  hdr.write('vorbis', 1, 'ascii');
  return Buffer.concat([hdr, body, Buffer.from([0x01])]);
}

// ── Reassemble an OGG packet from consecutive pages ───────────────────────
function collectPacket(pages, startPageIdx, startPacketStart) {
  // Walk pages collecting segment data until we find the packet terminator
  let data = Buffer.alloc(0);
  let pi = startPageIdx;
  let segStart = startPacketStart;

  while (pi < pages.length) {
    const page = pages[pi];
    const segs = page.segTable;
    let dataOff = 0;
    for (let si = 0; si < segs.length; si++) {
      if (si >= segStart) data = Buffer.concat([data, page.data.slice(dataOff, dataOff + segs[si])]);
      dataOff += segs[si];
      if (si >= segStart && segs[si] < 255) {
        return { data, endPageIdx: pi, endSegIdx: si };
      }
    }
    pi++;
    segStart = 0;
  }
  return { data, endPageIdx: pi - 1, endSegIdx: -1 };
}

// ── Main export ──────────────────────────────────────────────────────────
export function writeOggTags(filePath, fields) {
  const buf = readFileSync(filePath);
  const pages = parsePages(buf);
  if (pages.length === 0) throw new Error('No valid OGG pages found');

  const streamType = detectStreamType(pages[0].data);
  if (streamType === 'unknown') throw new Error('Unrecognised OGG stream type (not Vorbis or Opus)');

  // The comment header is always the second logical packet (packet index 1).
  // Find the page/segment where packet 1 starts.
  let packetCount = 0;
  let commentPageIdx = -1, commentSegIdx = 0, commentEndPageIdx = -1;

  outer: for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    // Skip continuation pages for now; they belong to the current packet
    for (let si = 0; si < page.segTable.length; si++) {
      if (page.segTable[si] < 255) {
        // End of a packet
        packetCount++;
        if (packetCount === 2) { commentEndPageIdx = pi; break outer; }
        if (packetCount === 1) { commentPageIdx = pi + (si + 1 >= page.segTable.length ? 1 : 0); commentSegIdx = (si + 1 < page.segTable.length) ? si + 1 : 0; }
      }
    }
  }

  if (commentPageIdx === -1) throw new Error('Could not find comment header packet');

  // Build new comment packet
  const newCommentPacket = buildCommentPacket(streamType, fields);

  // Determine the serial number and next seqno
  const serial = pages[0].serial;

  // Find the seqno of the first audio page (after comment)
  const audioStartIdx = commentEndPageIdx + 1;
  const audioSeqnoBase = audioStartIdx < pages.length ? pages[audioStartIdx].seqno : commentEndPageIdx + 2;

  // Build new pages:
  //   [page 0 = identification header unchanged]
  //   [new comment page(s)]
  //   [all audio pages with renumbered seqno]

  const identPage = buf.slice(pages[0].pos, pages[0].pos + pages[0].totalLen);

  const newCommentPages = packetToPages(newCommentPacket, serial, pages[0].seqno + 1, 0x00, Buffer.alloc(8));

  const seqnoAudioStart = pages[0].seqno + 1 + newCommentPages.length;
  const audioPages = [];
  for (let pi = audioStartIdx; pi < pages.length; pi++) {
    const pg = pages[pi];
    const rawPage = buf.slice(pg.pos, pg.pos + pg.totalLen);
    const newPage = Buffer.from(rawPage); // copy
    // Update sequence number
    newPage.writeUInt32LE(seqnoAudioStart + (pi - audioStartIdx), 18);
    // Recompute checksum
    newPage.writeUInt32LE(0, 22);
    newPage.writeUInt32LE(oggCrc32(newPage), 22);
    audioPages.push(newPage);
  }

  const result = Buffer.concat([identPage, ...newCommentPages, ...audioPages]);
  writeFileSync(filePath, result);
}
