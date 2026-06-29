// lib/ogg-writer.js — OGG Vorbis/Opus Vorbis Comment read+write
// writeOggTags() reads existing raw comments first then merges updates.
import { readFileSync, writeFileSync } from 'fs';

const VENDOR = 'MusicDedup';

export const FIELD_TO_VORBIS = {
  title:'TITLE', artist:'ARTIST', album:'ALBUM', album_year:'DATE',
  track_number:'TRACKNUMBER', genre:'GENRE', composer:'COMPOSER',
  comment:'COMMENT', isrc:'ISRC', album_artist:'ALBUMARTIST',
  disc_number:'DISCNUMBER', total_tracks:'TOTALTRACKS',
};

// ── OGG-specific CRC32 (0x04c11db7, MSB-first) ──────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r<<1)^0x04c11db7)>>>0 : (r<<1)>>>0;
    t[i] = r;
  }
  return t;
})();
function oggCrc32(buf) {
  let c = 0;
  for (let i = 0; i < buf.length; i++) c = ((c<<8)^CRC_TABLE[((c>>>24)^buf[i])&0xff])>>>0;
  return c;
}

// ── Parse OGG pages ──────────────────────────────────────────────────────
function parsePages(buf) {
  const pages = []; let pos = 0;
  while (pos + 27 <= buf.length) {
    if (buf.toString('ascii', pos, pos+4) !== 'OggS') break;
    const numSegs = buf[pos+26];
    if (pos+27+numSegs > buf.length) break;
    const segs = buf.slice(pos+27, pos+27+numSegs);
    let dl = 0; for (let i=0;i<numSegs;i++) dl+=segs[i];
    const ds = pos+27+numSegs;
    if (ds+dl > buf.length) break;
    pages.push({ headerType:buf[pos+5], granule:buf.slice(pos+6,pos+14),
      serial:buf.readUInt32LE(pos+14), seqno:buf.readUInt32LE(pos+18),
      segTable:segs, data:buf.slice(ds, ds+dl),
      totalLen:27+numSegs+dl, pos });
    pos += 27+numSegs+dl;
  }
  return pages;
}

// ── Encode a packet into OGG page(s) ────────────────────────────────────
function packetToPages(pkt, serial, seqnoStart, headerType=0x00) {
  const pages=[]; let off=0, seqno=seqnoStart;
  while (off < pkt.length || pages.length===0) {
    const chunk = pkt.slice(off, off+65025); off+=chunk.length;
    const isLast = off>=pkt.length;
    const segs=[]; let rem=chunk.length;
    while(rem>=255){segs.push(255);rem-=255;}
    if(isLast)segs.push(rem); else if(rem>0)segs.push(rem);
    const ht = pages.length===0 ? headerType : 0x00;
    const hdr = Buffer.allocUnsafe(27+segs.length);
    hdr.write('OggS',0,'ascii'); hdr[4]=0; hdr[5]=ht;
    Buffer.alloc(8).copy(hdr,6);
    hdr.writeUInt32LE(serial,14); hdr.writeUInt32LE(seqno,18);
    hdr.writeUInt32LE(0,22); hdr[26]=segs.length;
    segs.forEach((s,i)=>hdr[27+i]=s);
    const page=Buffer.concat([hdr,chunk]);
    page.writeUInt32LE(oggCrc32(page),22);
    pages.push(page); seqno++;
  }
  return pages;
}

// ── Detect stream type from first page ───────────────────────────────────
function streamType(d) {
  if(d.length>=7&&d[0]===0x01&&d.toString('ascii',1,7)==='vorbis')return'vorbis';
  if(d.length>=8&&d.toString('ascii',0,8)==='OpusHead')return'opus';
  return'unknown';
}

// ── Vorbis Comment binary codec ──────────────────────────────────────────
function parseVorbisPayload(buf, isVorbis) {
  const off = isVorbis ? 7 : 8; // skip header prefix
  const tags={};
  if(off+4>buf.length)return tags;
  let pos=off;
  const vl=buf.readUInt32LE(pos);pos+=4+vl;
  if(pos+4>buf.length)return tags;
  const count=buf.readUInt32LE(pos);pos+=4;
  for(let i=0;i<count;i++){
    if(pos+4>buf.length)break;
    const el=buf.readUInt32LE(pos);pos+=4;
    if(pos+el>buf.length)break;
    const e=buf.toString('utf8',pos,pos+el);pos+=el;
    const eq=e.indexOf('=');
    if(eq>0)tags[e.slice(0,eq).toUpperCase()]=e.slice(eq+1);
  }
  return tags;
}

function buildVorbisPayload(rawTags) {
  const vendor=Buffer.from(VENDOR,'utf8');
  const entries=Object.entries(rawTags)
    .filter(([,v])=>v!==null&&v!==undefined&&v!=='')
    .map(([k,v])=>Buffer.from(`${k}=${v}`,'utf8'));
  let sz=4+vendor.length+4;
  for(const e of entries)sz+=4+e.length;
  const buf=Buffer.allocUnsafe(sz);
  let pos=0;
  buf.writeUInt32LE(vendor.length,pos);pos+=4;
  vendor.copy(buf,pos);pos+=vendor.length;
  buf.writeUInt32LE(entries.length,pos);pos+=4;
  for(const e of entries){buf.writeUInt32LE(e.length,pos);pos+=4;e.copy(buf,pos);pos+=e.length;}
  return buf;
}

function buildCommentPacket(type, rawTags) {
  const body = buildVorbisPayload(rawTags);
  if(type==='opus'){return Buffer.concat([Buffer.from('OpusTags','ascii'),body]);}
  const hdr=Buffer.allocUnsafe(7);hdr[0]=0x03;hdr.write('vorbis',1,'ascii');
  return Buffer.concat([hdr,body,Buffer.from([0x01])]);
}

// ── Collect 2nd OGG packet (comment header) ──────────────────────────────
function collectSecondPacket(pages) {
  let pkts=0, data=Buffer.alloc(0), pktEndPage=-1;
  for(let pi=0;pi<pages.length;pi++){
    const segs=pages[pi].segTable;
    let do_=0;
    for(let si=0;si<segs.length;si++){
      data=Buffer.concat([data,pages[pi].data.slice(do_,do_+segs[si])]);
      do_+=segs[si];
      if(segs[si]<255){pkts++;if(pkts===2){pktEndPage=pi;return{data,pktEndPage};}}
    }
  }
  return{data,pktEndPage};
}

// ── Public: read ALL Vorbis Comments from OGG file ───────────────────────
export function readOggRawTags(filePath) {
  try{
    const buf=readFileSync(filePath);
    const pages=parsePages(buf);
    if(!pages.length)return{};
    const type=streamType(pages[0].data);
    if(type==='unknown')return{};
    const{data}=collectSecondPacket(pages);
    return parseVorbisPayload(data,type==='vorbis');
  }catch{return{};}
}

// ── Public: write tags (merges with existing) ────────────────────────────
export function writeOggTags(filePath, updatedFields) {
  const rawTags = readOggRawTags(filePath);
  for(const[ourKey,vorbisKey]of Object.entries(FIELD_TO_VORBIS)){
    const val=updatedFields[ourKey];
    if(val!==undefined&&val!==null&&val!==''&&!(typeof val==='number'&&val===0))
      rawTags[vorbisKey]=String(val);
  }
  _writeOgg(filePath, rawTags);
}

// ── Public: write raw tags directly (for revert) ─────────────────────────
export function writeOggRawTags(filePath, rawTags) { _writeOgg(filePath, rawTags); }

function _writeOgg(filePath, rawTags) {
  const buf=readFileSync(filePath);
  const pages=parsePages(buf);
  if(!pages.length)throw new Error('No OGG pages');
  const type=streamType(pages[0].data);
  if(type==='unknown')throw new Error('Unknown OGG stream type');
  const{pktEndPage}=collectSecondPacket(pages);
  const newPkt=buildCommentPacket(type,rawTags);
  const serial=pages[0].serial;
  const identPage=buf.slice(pages[0].pos,pages[0].pos+pages[0].totalLen);
  const newCommentPages=packetToPages(newPkt,serial,pages[0].seqno+1);
  const audioStart=pktEndPage+1;
  const seqBase=pages[0].seqno+1+newCommentPages.length;
  const audioParts=[];
  for(let pi=audioStart;pi<pages.length;pi++){
    const pg=pages[pi];
    const np=Buffer.from(buf.slice(pg.pos,pg.pos+pg.totalLen));
    np.writeUInt32LE(seqBase+(pi-audioStart),18);
    np.writeUInt32LE(0,22);np.writeUInt32LE(oggCrc32(np),22);
    audioParts.push(np);
  }
  writeFileSync(filePath,Buffer.concat([identPage,...newCommentPages,...audioParts]));
}
