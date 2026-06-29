// lib/m4a-writer.js — M4A/MP4 iTunes atom read+write
// writeM4aTags() reads existing ilst atoms first then merges updates.
import { readFileSync, writeFileSync } from 'fs';

export const FIELD_TO_M4A = {
  title:'©nam', artist:'©ART', album:'©alb', album_year:'©day',
  track_number:'trkn', genre:'©gen', composer:'©wrt', comment:'©cmt',
  album_artist:'aART', disc_number:'disk',
};

// ── Atom helpers ─────────────────────────────────────────────────────────
function readAtoms(buf, s, e) {
  const atoms=[]; let pos=s;
  while(pos+8<=e){
    let sz=buf.readUInt32BE(pos);
    const type=buf.toString('latin1',pos+4,pos+8);
    if(sz===1){break;} if(sz===0)sz=e-pos;
    if(sz<8||pos+sz>e)break;
    atoms.push({type,start:pos,size:sz,dataStart:pos+8,dataEnd:pos+sz});
    pos+=sz;
  }
  return atoms;
}

function buildAtom(type,data){
  const b=Buffer.allocUnsafe(8+data.length);
  b.writeUInt32BE(8+data.length,0);
  b.write(type.padEnd(4),'utf8').toString; // just set bytes
  for(let i=0;i<4;i++)b[4+i]=type.charCodeAt(i)||0x20;
  data.copy(b,8);return b;
}
function buildDataAtom(typeCode,locale,payload){
  const h=Buffer.allocUnsafe(8);h.writeUInt32BE(typeCode,0);h.writeUInt32BE(locale,4);
  return buildAtom('data',Buffer.concat([h,payload]));
}
function textAtom(key,text){
  return buildAtom(key,buildDataAtom(1,0,Buffer.from(String(text),'utf8')));
}
function trknAtom(n){
  const p=Buffer.alloc(8);p.writeUInt16BE(parseInt(n)||0,2);
  return buildAtom('trkn',buildDataAtom(0,0,p));
}
function diskAtom(n){
  const p=Buffer.alloc(6);p.writeUInt16BE(parseInt(n)||0,2);
  return buildAtom('disk',buildDataAtom(0,0,p));
}
function buildHdlr(){
  const p=Buffer.alloc(25);p.write('mdir',8,'ascii');
  const fullHdr=Buffer.allocUnsafe(4);fullHdr.writeUInt32BE(0,0);
  return buildAtom('hdlr',Buffer.concat([fullHdr,p]));
}

// ── Read existing ilst tag atoms → {atomType: stringValue} ───────────────
function readDataAtomText(buf, atomStart, atomEnd) {
  const children=readAtoms(buf,atomStart,atomEnd);
  for(const c of children){
    if(c.type==='data'&&c.dataEnd-c.dataStart>=8){
      const typeCode=buf.readUInt32BE(c.dataStart);
      if(typeCode===1)return buf.toString('utf8',c.dataStart+8,c.dataEnd);
    }
  }
  return null;
}

function readDataAtomInt16(buf, atomStart, atomEnd) {
  const children=readAtoms(buf,atomStart,atomEnd);
  for(const c of children){
    if(c.type==='data'&&c.dataEnd-c.dataStart>=10){
      return buf.readUInt16BE(c.dataStart+10);
    }
  }
  return null;
}

export function readM4aRawTags(filePath) {
  try{
    const buf=readFileSync(filePath);
    const top=readAtoms(buf,0,buf.length);
    const moov=top.find(a=>a.type==='moov'); if(!moov)return{};
    const moovCh=readAtoms(buf,moov.dataStart,moov.dataEnd);
    const udta=moovCh.find(a=>a.type==='udta'); if(!udta)return{};
    const udtaCh=readAtoms(buf,udta.dataStart,udta.dataEnd);
    const meta=udtaCh.find(a=>a.type==='meta'); if(!meta)return{};
    // meta is a full atom (4 bytes version+flags before children)
    const metaCh=readAtoms(buf,meta.dataStart+4,meta.dataEnd);
    const ilst=metaCh.find(a=>a.type==='ilst'); if(!ilst)return{};
    const tags={};
    for(const item of readAtoms(buf,ilst.dataStart,ilst.dataEnd)){
      if(item.type==='trkn'){
        const v=readDataAtomInt16(buf,item.dataStart,item.dataEnd);
        if(v!=null)tags['trkn']=String(v);
      }else if(item.type==='disk'){
        const v=readDataAtomInt16(buf,item.dataStart,item.dataEnd);
        if(v!=null)tags['disk']=String(v);
      }else{
        const v=readDataAtomText(buf,item.dataStart,item.dataEnd);
        if(v!=null)tags[item.type]=v;
      }
    }
    return tags;
  }catch{return{};}
}

// ── Adjust stco/co64 offsets ─────────────────────────────────────────────
function adjustStco(buf,s,e,delta){
  const CONT=new Set(['moov','trak','mdia','minf','stbl','dinf']);
  let pos=s;
  while(pos+8<=e){
    let sz=buf.readUInt32BE(pos);
    const type=buf.toString('ascii',pos+4,pos+8);
    if(sz===0)sz=e-pos; if(sz<8||pos+sz>e)break;
    if(type==='stco'){
      const cnt=buf.readUInt32BE(pos+12);
      for(let i=0;i<cnt;i++){const o=pos+16+i*4;buf.writeUInt32BE(buf.readUInt32BE(o)+delta,o);}
    }else if(type==='co64'){
      const cnt=buf.readUInt32BE(pos+12);
      for(let i=0;i<cnt;i++){const o=pos+16+i*8;const lo=(buf.readUInt32BE(o+4)+delta)>>>0;buf.writeUInt32BE(lo,o+4);}
    }else if(CONT.has(type))adjustStco(buf,pos+8,pos+sz,delta);
    pos+=sz;
  }
}

// ── Build ilst from raw tag map ───────────────────────────────────────────
function buildIlst(rawTags) {
  const parts=[];
  for(const[k,v]of Object.entries(rawTags)){
    if(!v&&v!==0)continue;
    if(k==='trkn')parts.push(trknAtom(v));
    else if(k==='disk')parts.push(diskAtom(v));
    else parts.push(textAtom(k,v));
  }
  return parts.length ? buildAtom('ilst',Buffer.concat(parts))
                      : buildAtom('ilst',Buffer.alloc(0));
}

// ── Rebuild moov with new ilst ────────────────────────────────────────────
function rebuildMoov(origBuf, moovAtom, rawTags) {
  const moovCh=readAtoms(origBuf,moovAtom.dataStart,moovAtom.dataEnd);
  const ilst=buildIlst(rawTags);
  const hdlr=buildHdlr();
  const meta=buildAtom('meta',Buffer.concat([Buffer.alloc(4),hdlr,ilst]));
  const udta=buildAtom('udta',meta);
  const children=[];
  let hasUdta=false;
  for(const a of moovCh){
    if(a.type==='udta'){children.push(udta);hasUdta=true;}
    else children.push(origBuf.slice(a.start,a.start+a.size));
  }
  if(!hasUdta)children.push(udta);
  return buildAtom('moov',Buffer.concat(children));
}

// ── Public: write tags (merges with existing) ────────────────────────────
export function writeM4aTags(filePath, updatedFields) {
  const rawTags=readM4aRawTags(filePath);
  for(const[ourKey,atomKey]of Object.entries(FIELD_TO_M4A)){
    const val=updatedFields[ourKey];
    if(val!==undefined&&val!==null&&val!==''&&!(typeof val==='number'&&val===0))
      rawTags[atomKey]=String(val);
  }
  _writeM4a(filePath, rawTags);
}

// ── Public: write raw tags directly (for revert) ─────────────────────────
export function writeM4aRawTags(filePath, rawTags) { _writeM4a(filePath, rawTags); }

function _writeM4a(filePath, rawTags) {
  const orig=readFileSync(filePath);
  const top=readAtoms(orig,0,orig.length);
  const moovAtom=top.find(a=>a.type==='moov');
  if(!moovAtom)throw new Error('No moov atom');
  const mdatAtom=top.find(a=>a.type==='mdat');
  const mdatAfterMoov=mdatAtom&&mdatAtom.start>moovAtom.start;
  const newMoov=rebuildMoov(orig,moovAtom,rawTags);
  const delta=newMoov.length-moovAtom.size;
  if(mdatAfterMoov&&delta!==0)adjustStco(newMoov,8,newMoov.length,delta);
  const parts=[];
  for(const a of top) parts.push(a.type==='moov'?newMoov:orig.slice(a.start,a.start+a.size));
  writeFileSync(filePath,Buffer.concat(parts));
}
