'use strict';
const {useState,useEffect,useRef,useMemo,useCallback}=React;
const e=React.createElement;
const APP_VERSION='1.14.1';

/* ── API ─────────────────────────────────────────────────────────────── */
const api={
  get: u=>fetch(u).then(r=>r.json()),
  post:(u,b={})=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()),
  put: (u,b={})=>fetch(u,{method:'PUT', headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()),
  del: u=>fetch(u,{method:'DELETE'}).then(r=>r.json()),
};

/* ── Helpers ──────────────────────────────────────────────────────────── */
const fmtN=n=>n==null?'—':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':String(n);
const fmtBytes=b=>{if(!b)return'0 B';if(b>=1e12)return(b/1e12).toFixed(2)+' TB';if(b>=1e9)return(b/1e9).toFixed(2)+' GB';if(b>=1e6)return(b/1e6).toFixed(1)+' MB';return Math.round(b/1e3)+' KB';};
const fmtBR=(br,fmt)=>{const f=(fmt||'').toUpperCase();return['FLAC','WAV','AIFF','DSF'].includes(f)?f:br?`${f} ${br}k`:(f||'—');};
const fmtDur=s=>{if(!s)return'—';const m=Math.floor(s/60),sec=Math.floor(s%60);return`${m}:${String(sec).padStart(2,'0')}`;};
const fmtDate=ms=>{if(!ms)return'—';return new Date(ms).toLocaleString('zh-CN',{dateStyle:'short',timeStyle:'short'});};

/* ── Shared search ────────────────────────────────────────────────────── */
function normalizeForSearch(s){
  if(!s)return'';
  // NFKD decomposes accented chars (é→e+́), strip combining marks, lowercase,
  // keep only Unicode letters/numbers/whitespace, collapse runs of whitespace.
  return s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu,'').replace(/\s+/g,' ').trim();
}

/** filterBySearch(items, search, fields)
 *  fields: array of string keys OR accessor functions (item)=>string */
function filterBySearch(items,search,fields){
  const q=normalizeForSearch(search);
  if(!q)return items;
  return items.filter(item=>fields.some(f=>{
    const val=typeof f==='function'?f(item):(item[f]||'');
    return normalizeForSearch(val).includes(q);
  }));
}

/** Unified search input. Props: value, onChange, placeholder?, minWidth? */
const SearchInput=({value,onChange,placeholder='搜索标题、艺术家、专辑...',minWidth=180,style:containerStyle})=>
  e('div',{style:{position:'relative',flex:1,minWidth,...containerStyle}},
    Icon('search',{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',fontSize:14,color:'var(--tx-faint)',pointerEvents:'none'}),
    e('input',{value,onChange:ev=>onChange(ev.target.value),placeholder,
      style:{width:'100%',paddingLeft:32,paddingRight:10,paddingTop:6,paddingBottom:6,
        boxSizing:'border-box',borderRadius:'var(--r-md)',
        background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',
        boxShadow:'var(--sh-xs)',outline:'none',fontSize:13}})
  );

// Group-tag taxonomy is documented in lib/rules.js → detectGroupTags().
// All tag metadata (GROUP_TAG_LABELS, GROUP_TAG_DESCRIPTIONS, GROUP_GROUP_TAG_COLORS,
// PICK_TAG_LABEL, PICK_TAG_COLOR, MATCH_METHOD_TAGS, CHARACTERISTIC_TAGS,
// CHARACTERISTIC_TAGS_ARRAY, RTYPE_LABEL, DIMENSION_COLUMNS, DIMENSION_INFO, DEFAULT_PICK,
// DEFAULT_Q, mergePickOrder, TIER_COLOR, TIER_LABEL)
// are served by /rules-meta.js (source: lib/rules.js)

/* ── Icon system ──────────────────────────────────────────────────────
   Self-contained inline SVGs: zero network dependency, ever. */
const ICONS={
  play:{fill:1,els:[['path',{d:'M8 5v14l11-7z'}]]},
  pause:{fill:1,els:[['rect',{x:6,y:5,width:4,height:14,rx:1}],['rect',{x:14,y:5,width:4,height:14,rx:1}]]},
  'player-play':{fill:1,els:[['path',{d:'M8 5v14l11-7z'}]]},
  'player-stop':{fill:1,els:[['rect',{x:6,y:6,width:12,height:12,rx:1.5}]]},
  x:{els:[['path',{d:'M18 6 6 18'}],['path',{d:'M6 6l12 12'}]]},
  check:{els:[['path',{d:'M5 13l4 4L19 7'}]]},
  checks:{els:[['path',{d:'M2 12l4 4L14 8'}],['path',{d:'M9 12l4 4L21 8'}]]},
  plus:{els:[['path',{d:'M12 5v14M5 12h14'}]]},
  search:{els:[['circle',{cx:11,cy:11,r:7}],['path',{d:'M21 21l-4.3-4.3'}]]},
  filter:{els:[['path',{d:'M4 5h16L14 12v6l-4 2v-8z'}]]},
  settings:{els:[['circle',{cx:12,cy:12,r:3}],['path',{d:'M19.4 13a8 8 0 000-2l2-1.6-2-3.4-2.4.6a8 8 0 00-1.7-1l-.4-2.6h-4l-.4 2.6a8 8 0 00-1.7 1l-2.4-.6-2 3.4L4.6 11a8 8 0 000 2l-2 1.6 2 3.4 2.4-.6a8 8 0 001.7 1l.4 2.6h4l.4-2.6a8 8 0 001.7-1l2.4.6 2-3.4z'}]]},
  music:{els:[['path',{d:'M9 18V5l12-2v13'}],['circle',{cx:6,cy:18,r:3}],['circle',{cx:18,cy:16,r:3}]]},
  // "在音乐库中查看" — the same music-note glyph as 音乐库 (scaled down,
  // top-left) plus a filled locate-pin badge (bottom-right) so it reads as
  // "find this in the library" rather than an unrelated bookshelf icon.
  'music-locate':{els:[
    ['path',{d:'M6.58 12.16V4.1l7.44 -1.24v8.06'}],
    ['circle',{cx:4.72,cy:12.16,r:1.86}],
    ['circle',{cx:12.16,cy:10.92,r:1.86}],
    ['path',{d:'M19.83 19.33l-2.12 2.12a1 1 0 0 1 -1.41 0l-2.12 -2.12a4 4 0 1 1 5.66 0z'}],
    ['circle',{cx:17,cy:16.5,r:1.5}]
  ]},
  // "在重复组中查看" — folders glyph (duplicate groups) top-left + locate pin bottom-right
  'group-locate':{els:[
    ['rect',{x:6.58,y:6.58,width:6.82,height:6.82,rx:1.24}],
    ['path',{d:'M4.1 10.3V4.1a1.24 1.24 0 0 1 1.24 -1.24h6.2'}],
    ['path',{d:'M19.83 19.33l-2.12 2.12a1 1 0 0 1 -1.41 0l-2.12 -2.12a4 4 0 1 1 5.66 0z'}],
    ['circle',{cx:17,cy:16.5,r:1.5}]
  ]},
  'music-off':{els:[['path',{d:'M9 18V5l12-2v13'}],['circle',{cx:6,cy:18,r:3}],['circle',{cx:18,cy:16,r:3}],['path',{d:'M3 3l18 18'}]]},
  radar:{els:[['circle',{cx:12,cy:12,r:9}],['circle',{cx:12,cy:12,r:5}],['circle',{cx:12,cy:12,r:1,fill:'currentColor'}],['path',{d:'M12 3a9 9 0 019 9'}]]},
  copy:{els:[['rect',{x:9,y:9,width:11,height:11,rx:2}],['path',{d:'M5 15V5a2 2 0 012-2h10'}]]},
  'folder-open':{els:[['path',{d:'M3 7h6l2 2h9'}],['path',{d:'M3 7v11a1 1 0 001 1h13.2a1 1 0 001-.86l1.3-9.14a1 1 0 00-1-1.14H10l-2-2H4a1 1 0 00-1 1z'}]]},
  'folder-filled':{fill:1,els:[['path',{d:'M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z'}]]},
  folders:{els:[['path',{d:'M3 6v10a2 2 0 002 2h2'}],['path',{d:'M7 7a2 2 0 012-2h3l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H9a2 2 0 01-2-2z'}]]},
  'info-circle':{els:[['circle',{cx:12,cy:12,r:9}],['path',{d:'M12 11v5'}],['path',{d:'M12 8h.01'}]]},
  'alert-circle':{els:[['circle',{cx:12,cy:12,r:9}],['path',{d:'M12 8v4'}],['path',{d:'M12 16h.01'}]]},
  'circle-check':{els:[['circle',{cx:12,cy:12,r:9}],['path',{d:'M8.5 12.5l2 2 4.5-5'}]]},
  'circle-dashed':{els:[['circle',{cx:12,cy:12,r:9,strokeDasharray:'4 3'}]]},
  loader:{els:[['circle',{cx:12,cy:12,r:9,strokeDasharray:'14 50'}]]},
  shield:{els:[['path',{d:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'}]]},
  'shield-check':{els:[['path',{d:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'}],['path',{d:'M9 12l2 2 4-4'}]]},
  'shield-filled':{fill:1,els:[['path',{d:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'}]]},
  'shield-plus':{els:[['path',{d:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'}],['path',{d:'M12 9v5M9.5 11.5h5'}]]},
  // 刮削确认 — same cloud silhouette as the "刮削操作" action icon
  // (cloud-download), but with a checkmark instead of the download arrow,
  // so the status reads as "data fetched & confirmed" rather than
  // "protected" (that meaning is reserved for shield-check/保留名单).
  'cloud-check':{els:[['path',{d:'M7 18a4 4 0 01-1-7.9A5 5 0 0116 7a4.5 4.5 0 011 8.9'}],['path',{d:'M8.5 14.3l2.3 2.3 4.7-4.9'}]]},
  // 音质优先级 — a 3-band audio equalizer (vertical tracks + slider knobs),
  // reads as "sound quality levels" rather than a generic gem/rating mark.
  'audio-levels':{els:[
    ['path',{d:'M6 19V15'}],['path',{d:'M6 12V5'}],['circle',{cx:6,cy:13.5,r:1.4,fill:'currentColor'}],
    ['path',{d:'M12 19V10'}],['path',{d:'M12 7V5'}],['circle',{cx:12,cy:8.5,r:1.4,fill:'currentColor'}],
    ['path',{d:'M18 19V17'}],['path',{d:'M18 14V5'}],['circle',{cx:18,cy:15.5,r:1.4,fill:'currentColor'}]
  ]},
  // 保留优先级 — a ranking podium with the tallest (1st-place) column
  // starred, reads as "which file wins and gets kept" rather than an
  // ambiguous card stack.
  'priority-podium':{els:[
    ['rect',{x:3,y:13,width:5,height:8,rx:1}],
    ['rect',{x:9.5,y:8,width:5,height:13,rx:1}],
    ['rect',{x:16,y:15,width:5,height:6,rx:1}],
    ['path',{d:'M12 3.8l.7 1.5 1.6.2-1.2 1.2.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.2 1.6-.2z',fill:'currentColor',stroke:'none'}]
  ]},
  // 维度对比 — a comparison table (header row + column dividers), reads as
  // "compare across columns" rather than any single dimension's own icon
  // (avoids colliding with 音质优先级/audio-levels, which is one specific
  // dimension, not the whole comparison).
  'table-compare':{els:[
    ['rect',{x:3,y:4.5,width:18,height:15,rx:1.5}],['path',{d:'M3 9.5h18'}],
    ['path',{d:'M9.3 9.5v10'}],['path',{d:'M15 9.5v10'}]
  ]},
  // 大小 dimension — a ruler (distinct from priority-podium's stacked bars,
  // so "size" and "保留优先级" don't read as the same glyph).
  ruler:{els:[
    ['rect',{x:3,y:9,width:18,height:6,rx:1}],['path',{d:'M7 9v2.2'}],['path',{d:'M11 9v3.2'}],
    ['path',{d:'M15 9v2.2'}],['path',{d:'M18 9v3.2'}]
  ]},
  clock:{els:[['circle',{cx:12,cy:12,r:9}],['path',{d:'M12 7.2v5l3.4 2'}]]},
  disc:{els:[['circle',{cx:12,cy:12,r:9}],['circle',{cx:12,cy:12,r:2.2}]]},
  calendar:{els:[['rect',{x:4,y:5,width:16,height:15,rx:1.5}],['path',{d:'M4 10h16'}],['path',{d:'M8 3v4'}],['path',{d:'M16 3v4'}]]},
  'list-check':{els:[['path',{d:'M9.5 6.5h10'}],['path',{d:'M9.5 12h10'}],['path',{d:'M9.5 17.5h10'}],
    ['path',{d:'M4 6.5l1 1 2-2'}],['path',{d:'M4 12l1 1 2-2'}],['path',{d:'M4 17.5l1 1 2-2'}]]},
  trash:{els:[['path',{d:'M4 7h16'}],['path',{d:'M9 7V4h6v3'}],['path',{d:'M6 7l1 13h10l1-13'}]]},
  refresh:{els:[['path',{d:'M4 12a8 8 0 0114-5.3'}],['path',{d:'M20 12a8 8 0 01-14 5.3'}],['path',{d:'M18 4v4h-4'}],['path',{d:'M6 20v-4h4'}]]},
  key:{els:[['circle',{cx:7,cy:15,r:4}],['path',{d:'M10 12l9-9'}],['path',{d:'M16 6l2 2'}],['path',{d:'M13 9l2 2'}]]},
  world:{els:[['circle',{cx:12,cy:12,r:9}],['path',{d:'M3 12h18'}],['path',{d:'M12 3a14 14 0 010 18'}],['path',{d:'M12 3a14 14 0 000 18'}]]},
  'device-floppy':{els:[['path',{d:'M5 4h11l3 3v13H5z'}],['path',{d:'M9 4v5h7V4'}],['path',{d:'M8 14h8v6H8z'}]]},
  'chevron-up':{els:[['path',{d:'M6 15l6-6 6 6'}]]},
  'chevron-down':{els:[['path',{d:'M6 9l6 6 6-6'}]]},
  'chevron-left':{els:[['path',{d:'M15 6l-6 6 6 6'}]]},
  'chevron-right':{els:[['path',{d:'M9 6l6 6-6 6'}]]},
  'skip-back':{fill:1,els:[['rect',{x:4,y:5,width:2.5,height:14,rx:1}],['path',{d:'M18 5v14l-10-7z'}]]},
  'skip-forward':{fill:1,els:[['rect',{x:17.5,y:5,width:2.5,height:14,rx:1}],['path',{d:'M6 5v14l10-7z'}]]},
  'arrow-up':{els:[['path',{d:'M12 19V5'}],['path',{d:'M6 11l6-6 6 6'}]]},
  'arrow-down':{els:[['path',{d:'M12 5v14'}],['path',{d:'M6 13l6 6 6-6'}]]},
  click:{els:[['path',{d:'M9 9l11 4-4.5 1.8L14 19z'}],['path',{d:'M5 3v3'}],['path',{d:'M3 9h3'}],['path',{d:'M5.6 5.6l1.8 1.8'}]]},
  'chart-bar':{els:[['rect',{x:4,y:11,width:3,height:8}],['rect',{x:10.5,y:6,width:3,height:13}],['rect',{x:17,y:14,width:3,height:5}]]},
  sparkles:{els:[['path',{d:'M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z'}],['path',{d:'M19 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z'}]]},
  'terminal-2':{els:[['path',{d:'M5 7l5 5-5 5'}],['path',{d:'M12 19h7'}]]},
  tag:{els:[['path',{d:'M3 11V5a2 2 0 012-2h6l10 10-8 8z'}],['circle',{cx:8,cy:8,r:1.3,fill:'currentColor'}]]},
  adjustments:{els:[['path',{d:'M4 6h8'}],['path',{d:'M16 6h4'}],['circle',{cx:14,cy:6,r:2}],['path',{d:'M4 12h4'}],['path',{d:'M12 12h8'}],['circle',{cx:10,cy:12,r:2}],['path',{d:'M4 18h12'}],['circle',{cx:16,cy:18,r:2}]]},
  'wave-sine':{els:[['path',{d:'M2 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0'}]]},
  'cloud-download':{els:[['path',{d:'M7 18a4 4 0 01-1-7.9A5 5 0 0116 7a4.5 4.5 0 011 8.9'}],['path',{d:'M12 11v8'}],['path',{d:'M9 16l3 3 3-3'}]]},
  download:{els:[['path',{d:'M12 4v12'}],['path',{d:'M7 11l5 5 5-5'}],['path',{d:'M5 20h14'}]]},
  diamond:{els:[['path',{d:'M12 3l5 5-5 13-5-13z'}]]},
  'git-merge':{els:[['path',{d:'M6 8.2V15.8'}],['path',{d:'M6 12c0 3.3 2.7 6 6 6h3.8'}],['circle',{cx:6,cy:6,r:2.2}],['circle',{cx:18,cy:18,r:2.2}],['circle',{cx:6,cy:18,r:2.2}]]},
  dots:{fill:1,els:[['circle',{cx:5,cy:12,r:1.6}],['circle',{cx:12,cy:12,r:1.6}],['circle',{cx:19,cy:12,r:1.6}]]},
  // Volume / speaker icons
  'volume':     {els:[['path',{d:'M11 5L6 9H2v6h4l5 4V5z'}],['path',{d:'M19.07 4.93a10 10 0 010 14.14'}],['path',{d:'M15.54 8.46a5 5 0 010 7.07'}]]},
  'volume-2':   {els:[['path',{d:'M11 5L6 9H2v6h4l5 4V5z'}],['path',{d:'M15.54 8.46a5 5 0 010 7.07'}]]},
  'volume-off': {els:[['path',{d:'M11 5L6 9H2v6h4l5 4V5z'}],['path',{d:'M23 9l-6 6'}],['path',{d:'M17 9l6 6'}]]},
  wand:{els:[['path',{d:'M4 20L20 4'}],['path',{d:'M7 4l1.5 1.5L7 7'}],['path',{d:'M17 14l1.5 1.5-1.5 1.5'}],['path',{d:'M4 4l.5.5'}],['path',{d:'M20 20l-.5-.5'}]]},
  'stack-2':{els:[['path',{d:'M16 16v-4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4'}],['path',{d:'M8 12h8'}],['path',{d:'M16 8v-4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4'}],['path',{d:'M8 4h8'}]]},
  edit:{els:[['path',{d:'M7 20H4v-3L15.5 5.5a2.12 2.12 0 013 3z'}],['path',{d:'M13.5 7.5l3 3'}]]},
  pencil:{els:[['path',{d:'M7 20H4v-3L15.5 5.5a2.12 2.12 0 013 3z'}],['path',{d:'M13.5 7.5l3 3'}]]},
  'arrow-back-up':{els:[['path',{d:'M9 13l-4-4 4-4'}],['path',{d:'M5 9h9a5 5 0 010 10h-2'}]]},
  'arrows-exchange':{els:[['path',{d:'M20 7H8'}],['path',{d:'M12 4l-4 3 4 3'}],['path',{d:'M4 17h12'}],['path',{d:'M12 14l4 3-4 3'}]]},
  books:{els:[['path',{d:'M5 4a1 1 0 011-1h3a1 1 0 011 1v16a1 1 0 01-1 1H6a1 1 0 01-1-1z'}],['path',{d:'M11 6h3a1 1 0 011 1v13a1 1 0 01-1 1h-3'}],['path',{d:'M17.3 5.2l2.4.7a1 1 0 01.7 1.2l-3.6 13a1 1 0 01-1.2.7l-1.9-.5'}]]},
  'shield-x':{els:[['path',{d:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'}],['path',{d:'M9.5 9.5l5 5'}],['path',{d:'M14.5 9.5l-5 5'}]]},
  'toggle-left':{els:[['path',{d:'M4 12a6 6 0 016-6h4a6 6 0 010 12H10a6 6 0 01-6-6z'}],['circle',{cx:9.5,cy:12,r:2.6,fill:'currentColor'}]]},
  'file-music':{els:[['path',{d:'M14 3v4a1 1 0 001 1h4'}],['path',{d:'M5 4a1 1 0 011-1h7l5 5v11a1 1 0 01-1 1H6a1 1 0 01-1-1z'}],['path',{d:'M9.5 17v-4.5l4-1v4.5'}],['circle',{cx:8.7,cy:17,r:1.2,fill:'currentColor'}],['circle',{cx:12.7,cy:15.5,r:1.2,fill:'currentColor'}]]},
};
function Icon(name,style={},className){
  const spec=ICONS[name];
  const size=style.fontSize||14,color=style.color||'currentColor';
  const rest={...style};delete rest.fontSize;delete rest.color;
  const wrapStyle={display:'inline-block',verticalAlign:'middle',flexShrink:0,...rest};
  if(!spec)return e('svg',{width:size,height:size,viewBox:'0 0 24 24',style:wrapStyle,className});
  const svgProps=spec.fill
    ?{width:size,height:size,viewBox:'0 0 24 24',fill:color,stroke:'none',style:wrapStyle,className}
    :{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:color,strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round',style:wrapStyle,className};
  return e('svg',svgProps,spec.els.map(([tag,props],i)=>e(tag,{key:i,...props})));
}

/* ── Brand mark — two overlapping music notes: the front one solid, the
   back one a hollow "ghost", reading as "duplicate → resolved to one".
   Used for the header badge and (as a matching data-URI) the favicon. */
const NOTE_PATH='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z';
function Logo({size=28,radius=7}={}){
  return e('svg',{width:size,height:size,viewBox:'0 0 28 28',style:{display:'inline-block',verticalAlign:'middle',flexShrink:0,borderRadius:radius,boxShadow:'0 1px 3px rgba(217,119,6,.25)'}},
    e('defs',null,e('linearGradient',{id:'logoGrad',x1:0,y1:0,x2:1,y2:1},e('stop',{offset:0,stopColor:'#FDE68A'}),e('stop',{offset:1,stopColor:'#D97706'}))),
    e('rect',{width:28,height:28,rx:radius,fill:'url(#logoGrad)'}),
    e('g',{transform:'translate(2.5,3) scale(.6)',opacity:.55},e('path',{d:NOTE_PATH,fill:'none',stroke:'#fff',strokeWidth:2.4,strokeLinejoin:'round',strokeLinecap:'round'})),
    e('g',{transform:'translate(9.5,9.5) scale(.6)'},e('path',{d:NOTE_PATH,fill:'#fff'}))
  );
}

/* ── Global persistent player ───────────────────────────────────────────
   <audio> is mounted once, for the lifetime of the app, in App() itself —
   so playback continues uninterrupted while switching tabs.

   PERF NOTE: onTimeUpdate fires many times per second while a track plays.
   If every consumer of this hook re-rendered on every tick, any view on
   screen during playback (e.g. the 100-row library table) would re-render
   at that same high frequency — that's the real source of "playback causes
   the UI to feel laggy/delayed". So progress/duration are kept OUT of the
   memoized `player` object that gets handed to list views; only PlayerBar
   (the one consumer that actually needs them every tick) reads them
   directly from this hook's return value. playTrack/toggle/etc are wrapped
   in useCallback so their identity is stable across re-renders too. */
function useGlobalPlayer(){
  const[current,setCurrent]=useState(null);   // {id,title,artist}
  const[playing,setPlaying]=useState(false);
  const[progress,setProgress]=useState(0);
  const[duration,setDuration]=useState(0);
  const[volume,setVolume]=useState(1);
  const audioRef=useRef(null);
  const queueRef=useRef([]);                  // last list playTrack was called with
  // See the stall-watchdog block below (near armStallWatchdog) for what
  // these are for — declared here so the track-switch effect can clear a
  // stale watchdog left over from the PREVIOUS track.
  const stallTimer=useRef(null);
  const errorRetries=useRef(0);
  const clearStallTimer=useCallback(()=>{ if(stallTimer.current){clearTimeout(stallTimer.current);stallTimer.current=null;} },[]);

  useEffect(()=>{
    if(!current)return;
    const el=audioRef.current;
    if(!el)return;
    clearStallTimer(); // a pending watchdog from the previous track shouldn't fire against this one
    errorRetries.current=0;
    el.src=`/api/files/${current.id}/stream`;
    setProgress(0);
    el.play().catch(()=>{});
  },[current?.id]);

  useEffect(()=>{ if(audioRef.current)audioRef.current.volume=volume; },[volume]);

  const playTrack=useCallback((track,list)=>{
    if(Array.isArray(list)&&list.length)queueRef.current=list;
    setCurrent(cur=>{
      if(cur&&cur.id===track.id){
        const el=audioRef.current;
        if(el)el.paused?el.play().catch(()=>{}):el.pause();
        return cur;
      }
      return track;
    });
  },[]);
  const toggle=useCallback(()=>{const el=audioRef.current;if(!el)return;el.paused?el.play().catch(()=>{}):el.pause();},[]);
  const seek=useCallback(t=>{const el=audioRef.current;if(el)el.currentTime=t;},[]);
  const close=useCallback(()=>{const el=audioRef.current;clearStallTimer();errorRetries.current=0;setCurrent(null);setPlaying(false);if(el){el.pause();el.removeAttribute('src');el.load();}},[clearStallTimer]);
  const step=useCallback(dir=>{
    const q=queueRef.current;
    if(!q.length)return;
    setCurrent(cur=>{
      const i=cur?q.findIndex(t=>t.id===cur.id):-1;
      const next=i===-1?q[0]:q[(i+dir+q.length)%q.length];
      return next||cur;
    });
  },[]);
  const playNext=useCallback(()=>step(1),[step]);
  const playPrev=useCallback(()=>step(-1),[step]);

  // Stalled playback watchdog: if the browser doesn't recover from a
  // 'waiting'/'stalled' event, reload the source at the same position.
  const recoverStalledPlayback=useCallback(()=>{
    const el=audioRef.current;
    if(!el||el.paused||el.ended)return;
    const t=el.currentTime;
    const src=el.currentSrc||el.src;
    if(!src)return;
    el.load(); // drops and re-establishes the underlying network request
    const onReady=()=>{ el.currentTime=t; el.play().catch(()=>{}); el.removeEventListener('loadedmetadata',onReady); };
    el.addEventListener('loadedmetadata',onReady);
  },[]);
  const armStallWatchdog=useCallback(()=>{
    clearStallTimer();
    stallTimer.current=setTimeout(recoverStalledPlayback,4000);
  },[clearStallTimer,recoverStalledPlayback]);

  const bind=useMemo(()=>({
    onPlay:()=>{setPlaying(true);clearStallTimer();errorRetries.current=0;},
    onPause:()=>{setPlaying(false);clearStallTimer();},
    onEnded:()=>{setPlaying(false);clearStallTimer();},
    onTimeUpdate:ev=>{setProgress(ev.target.currentTime);setDuration(ev.target.duration||0);clearStallTimer();},
    // 'waiting'/'stalled' fire when the browser is buffering — normal for a
    // moment, but if it doesn't clear within a few seconds the underlying
    // connection is probably dead, not just slow. 'error' fires for a
    // genuine MediaError (e.g. the network request itself failed); retrying
    // is worth it since most causes here are transient (a stalled/reset
    // connection), not a broken file — capped so a truly broken file doesn't
    // retry forever.
    onWaiting:armStallWatchdog,
    onStalled:armStallWatchdog,
    onError:()=>{
      clearStallTimer();
      if(errorRetries.current>=3)return;
      errorRetries.current++;
      recoverStalledPlayback();
    },
  }),[armStallWatchdog,clearStallTimer,recoverStalledPlayback]);

  // Stable-identity slice — safe to hand to heavy list views without causing
  // a re-render every time progress/duration tick.
  const lite=useMemo(()=>({current,playing,audioRef,playTrack,toggle,close,hasQueue:queueRef.current.length>1}),
    [current,playing,playTrack,toggle,close]);

  return{
    current,playing,progress,duration,volume,setVolume,audioRef,
    playTrack,toggle,seek,close,playNext,playPrev,bind,lite,
  };
}
/* PlayerBar — fixed layout:
   - Progress rail with global pointer-capture so drag never breaks
     when the mouse leaves the rail area.
   - Play controls absolutely centred in the viewport (position:absolute
     + left/right:0 + margin:auto), NOT flexed against the side panels,
     so they stay centred regardless of how wide/narrow the side panels are.
   - Time tooltip: shows as a rounded pill ABOVE the thumb on hover/drag.
   - Volume: icon always visible; slider expands on hover.
   - Duplicate-group extra padding fix: the bar is in normal flow (no
     position:fixed), so it already pushes content up; the <main>
     element has no extra paddingBottom.
*/
function PlayerBar({player,onLocate}){
  if(!player.current)return null;
  const{current,playing,progress,duration,volume,setVolume}=player;
  const hasQueue=player.lite.hasQueue;
  const pct=duration?Math.min(100,progress/duration*100):0;

  // ── Global-pointer-capture drag ─────────────────────────────────────────
  // We attach mousemove/mouseup to the WINDOW during a drag so the seek
  // continues even when the mouse moves outside the rail element. This is
  // the only reliable cross-browser way to avoid "deactivation on mouse-leave".
  const railRef=useRef(null);
  const dragging=useRef(false);
  const seekTargetRef=useRef(null); // last seek position in seconds, cleared when progress catches up
  const[hovered,setHovered]=useState(false);
  const[dragPct,setDragPct]=useState(0);    // only used during actual drag
  const[isDragging,setIsDragging]=useState(false); // trigger re-render on drag state change

  function pctFromClient(clientX){
    if(!railRef.current)return 0;
    const r=railRef.current.getBoundingClientRect();
    return Math.max(0,Math.min(1,(clientX-r.left)/r.width));
  }

  // mousedown: start drag, track dragPct for visual preview, seek ONLY on mouseup
  function onRailMouseDown(ev){
    ev.preventDefault();
    dragging.current=true;
    setIsDragging(true);
    const startP=pctFromClient(ev.clientX);
    setDragPct(startP*100);
    function onMove(e){
      const p=pctFromClient(e.clientX);
      setDragPct(p*100);
    }
    function onUp(e){
      const p=pctFromClient(e.clientX);
      const target=p*duration;
      if(duration){ seekTargetRef.current=target; player.seek(target); }
      dragging.current=false;
      setIsDragging(false);
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',onUp);
    }
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
  }

  // Once real progress reaches (or passes) the seek target, clear it
  if(seekTargetRef.current!==null&&duration&&progress>=seekTargetRef.current-0.3){
    seekTargetRef.current=null;
  }

  // Show thumb during drag (follows mouse) OR hover (at playback position)
  const showThumb=isDragging || hovered || seekTargetRef.current!==null;
  // During drag: use drag position. Right after seek: use seek target until progress catches up.
  const fillPct=isDragging?dragPct
    :seekTargetRef.current!==null&&duration?seekTargetRef.current/duration*100
    :pct;
  const thumbPct=Math.max(0.5,Math.min(99.5,fillPct));
  const timeLabel=`${fmtDur(fillPct/100*(duration||0))} / ${fmtDur(duration)}`;

  return e('div',{className:'fade',style:{flexShrink:0,background:'var(--bg-base)',borderTop:'0.5px solid var(--bd-default)',boxShadow:'0 -1px 8px rgba(0,0,0,.06)',zIndex:10}},

    // ── Progress rail ───────────────────────────────────────────────────────
    e('div',{
      ref:railRef,
      style:{position:'relative',cursor:'pointer',userSelect:'none',
        height:(hovered||isDragging)?8:4,
        background:(hovered||isDragging)?'var(--bg-muted)':'var(--bd-subtle)',
        transition:'height .12s ease, background .12s ease',
        boxShadow:isDragging?'0 0 0 3px rgba(217,119,6,.15)':'none',
      },
      onMouseDown:onRailMouseDown,
      onMouseEnter:()=>setHovered(true),
      onMouseLeave:()=>setHovered(false),
    },
      // Fill — real playback progress normally, drag preview while dragging
      e('div',{style:{position:'absolute',left:0,top:0,height:'100%',
        width:fillPct+'%',background:'var(--amber)',
        transition:isDragging?'none':'width .15s'}}),
      // Thumb + time capsule — during drag OR hover
      showThumb&&e('div',{style:{position:'absolute',top:'50%',left:thumbPct+'%',
        transform:'translate(-50%,-50%)',pointerEvents:'none',zIndex:2}},
        e('div',{style:{position:'absolute',bottom:'calc(100% + 8px)',left:'50%',transform:'translateX(-50%)',
          background:'var(--amber)',color:'#fff',fontSize:14,fontWeight:600,
          padding:'4px 12px',borderRadius:99,whiteSpace:'nowrap',pointerEvents:'none',
          fontVariantNumeric:'tabular-nums',textAlign:'center',lineHeight:1.2,
          boxShadow:'0 2px 8px rgba(0,0,0,.25)'}},timeLabel),
        e('div',{style:{width:14,height:14,borderRadius:'50%',background:'var(--amber)',
          boxShadow:'0 0 0 3px rgba(217,119,6,.3), 0 2px 6px rgba(217,119,6,.5)'}})
      )
    ),

    // ── Transport bar ───────────────────────────────────────────────────────
    e('div',{style:{position:'relative',height:58,padding:'0 20px'}},

      // Left: cover art + track info — absolute-positioned so it doesn't affect
      // centering of the play controls.
      e('div',{
        onClick:()=>onLocate&&onLocate(current),
        title:'定位到歌曲',
        style:{position:'absolute',left:20,top:0,bottom:0,display:'flex',alignItems:'center',
          gap:10,maxWidth:'calc(50% - 80px)',cursor:'pointer',overflow:'hidden'},
      },
        e('div',{style:{width:38,height:38,borderRadius:'var(--r-md)',overflow:'hidden',flexShrink:0,
          background:'var(--bg-muted)',display:'flex',alignItems:'center',justifyContent:'center'}},
          current.cover
            ?e('img',{src:current.cover,style:{width:'100%',height:'100%',objectFit:'cover'}})
            :Icon('music',{fontSize:18,color:'var(--tx-faint)'})
        ),
        e('div',{style:{overflow:'hidden',minWidth:0}},
          e('div',{style:{fontSize:12,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',
            whiteSpace:'nowrap',color:'var(--tx-primary)'}},current.title||'—'),
          e('div',{style:{fontSize:11,color:'var(--tx-faint)',overflow:'hidden',textOverflow:'ellipsis',
            whiteSpace:'nowrap'}},current.artist||'')
        )
      ),

      // Centre controls — absolutely centred in the bar regardless of side
      // panel widths, using left:0+right:0+margin:auto+width:fit-content.
      e('div',{style:{position:'absolute',left:0,right:0,top:0,bottom:0,
        display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none'}},
        e('div',{style:{display:'flex',alignItems:'center',gap:6,pointerEvents:'auto'}},
          e('button',{onClick:player.playPrev,disabled:!hasQueue,title:'上一曲',
            style:{background:'none',border:'none',cursor:hasQueue?'pointer':'default',
              opacity:hasQueue?1:.3,color:'var(--tx-secondary)',padding:0,display:'flex',
              alignItems:'center',justifyContent:'center',borderRadius:'50%',width:38,height:38}},
            Icon('skip-back',{fontSize:24})),
          e('button',{onClick:player.toggle,
            style:{background:'var(--amber)',border:'none',borderRadius:'50%',width:38,height:38,
              display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',flexShrink:0,
              boxShadow:'0 2px 8px rgba(217,119,6,.4)'}},
            Icon(playing?'pause':'play',{fontSize:24,color:'#fff'})),
          e('button',{onClick:player.playNext,disabled:!hasQueue,title:'下一曲',
            style:{background:'none',border:'none',cursor:hasQueue?'pointer':'default',
              opacity:hasQueue?1:.3,color:'var(--tx-secondary)',padding:0,display:'flex',
              alignItems:'center',justifyContent:'center',borderRadius:'50%',width:38,height:38}},
            Icon('skip-forward',{fontSize:24}))
        )
      ),

      // Right: volume control — absolute-positioned mirroring the left panel.
      e('div',{style:{position:'absolute',right:20,top:0,bottom:0,display:'flex',
        alignItems:'center',gap:4}},
        // Volume button always shows the speaker icon; slider expands on hover.
        e('div',{className:'volume-ctl',style:{display:'flex',alignItems:'center',gap:4}},
          e('button',{onClick:()=>setVolume(volume===0?0.8:0),title:volume===0?'取消静音':'静音',
            style:{background:'none',border:'none',cursor:'pointer',display:'flex',
              alignItems:'center',justifyContent:'center',color:'var(--tx-muted)',
              padding:0,flexShrink:0,width:38,height:38}},
            Icon(volume===0?'volume-off':volume<0.5?'volume-2':'volume',{fontSize:24})
          ),
          e('div',{className:'volume-slider-wrap'},
            e('input',{type:'range',min:0,max:1,step:0.01,value:volume,
              onChange:ev=>setVolume(+ev.target.value),style:{width:72}})
          )
        ),
        e('button',{onClick:player.close,title:'关闭播放器',
          style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',
            padding:4,display:'flex',borderRadius:'50%',marginLeft:2}},
          Icon('x',{fontSize:14}))
      )
    )
  );
}


/* ── Shared UI ────────────────────────────────────────────────────────── */
function QBadge({format:fmt,bitrate:br,sample_rate:sr}){
  const f=(fmt||'').toUpperCase(),lo=['FLAC','WAV','AIFF','DSF'].includes(f),hi=sr&&sr>=88200;
  const[col,bg]=hi?['#065F46','#D1FAE5']:lo?['#1D4ED8','#DBEAFE']:br>=320?['#5B21B6','#EDE9FE']:br>=256?['#92400E','#FEF3C7']:['#9A3412','#FEE2E2'];
  return e('span',{style:{fontSize:10,fontWeight:600,color:col,background:bg,border:`0.5px solid ${col}30`,padding:'1px 7px',borderRadius:3,fontFamily:'var(--font-mono)',whiteSpace:'nowrap',flexShrink:0}},hi?`Hi-Res ${f}`:lo?f:`${f} ${br||'?'}k`);
}
// Hover-revealed hint bubble — used everywhere an explanatory note exists,
// so the note stays out of the way until someone actually wants to read it.
// Uses viewport-aware positioning to avoid being clipped by window edges.
// If an ancestor has `data-hint-boundary`, the tooltip is clamped within that
// element instead of the viewport (used in settings cards to avoid overflow).
function Hint({text,size=13}){
  const[show,setShow]=useState(false);
  const[pinned,setPinned]=useState(false);
  const[tipStyle,setTipStyle]=useState({});
  const ref=useRef(null);
  if(!text)return null;
  function calcStyle(){
    if(!ref.current)return;
    const r=ref.current.getBoundingClientRect();
    const tipW=320, gap=8;
    let boundary=null;
    let el=ref.current.parentElement;
    while(el){if(el.hasAttribute&&el.hasAttribute('data-hint-boundary')){boundary=el;break;}el=el.parentElement;}
    const bbox=boundary?boundary.getBoundingClientRect():{left:0,top:0,right:window.innerWidth,bottom:window.innerHeight};
    const margin=16;
    let left=r.left+r.width/2-tipW/2;
    left=Math.max(bbox.left+margin,Math.min(left,bbox.right-tipW-margin));
    const below=r.bottom+gap;
    const above=r.top-gap;
    const estH=Math.min(200,text.length*0.4+40);
    const fitsBelow=below+estH<bbox.bottom-margin;
    setTipStyle({
      left,top:fitsBelow?below:'auto',bottom:!fitsBelow?window.innerHeight-above:'auto',
      maxWidth:tipW,
    });
  }
  function open(){calcStyle();setShow(true);}
  function close(){if(!pinned){setShow(false);}}
  function togglePin(e){e.stopPropagation();calcStyle();setShow(true);setPinned(p=>!p);}
  // dismiss pinned tooltip on outside click or scroll
  useEffect(()=>{
    if(!pinned)return;
    function dismiss(e){
      // ignore clicks inside the tooltip itself
      if(ref.current&&ref.current.closest('.hint-wrap')&&e.target.closest('.hint-tip'))return;
      setShow(false);setPinned(false);
    }
    document.addEventListener('click',dismiss,true);
    window.addEventListener('scroll',dismiss,true);
    return ()=>{
      document.removeEventListener('click',dismiss,true);
      window.removeEventListener('scroll',dismiss,true);
    };
  },[pinned]);
  return e('span',{className:'hint-wrap',style:{position:'relative',display:'inline-flex',marginLeft:4,verticalAlign:'middle'},
    onMouseEnter:open,onMouseLeave:close},
    e('span',{ref,style:{display:'inline-flex',color:'var(--tx-faint)',cursor:'pointer',borderRadius:'50%',
      transition:'all .15s',background:(show||pinned)?'var(--bg-muted)':'transparent'},
      tabIndex:0,onFocus:open,onBlur:()=>{if(!pinned)setShow(false);},onClick:togglePin},
      Icon('info-circle',{fontSize:size})),
    show&&e('div',{className:'hint-tip fade',style:{position:'fixed',zIndex:10000,left:tipStyle.left,top:tipStyle.top,bottom:tipStyle.bottom,maxWidth:tipStyle.maxWidth,
      background:'#fff',color:'#1F2937',fontSize:12,lineHeight:1.75,whiteSpace:'pre-line',
      padding:'8px 12px',borderRadius:'var(--r-md)',fontWeight:400,
      boxShadow:'0 4px 20px rgba(0,0,0,.12), 0 0 0 0.5px rgba(0,0,0,.06)'}},
      text
    )
  );
}
function GroupTag({tag}){
  const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
  return e('span',{style:{fontSize:10,fontWeight:500,color:col,background:bg,border:`0.5px solid ${bd}`,padding:'1px 7px',borderRadius:3,whiteSpace:'nowrap'}},GROUP_TAG_LABELS[tag]||tag);
}
function Tag({children,color='var(--tx-faint)',bg='var(--bg-muted)',border='var(--bd-default)'}){return e('span',{style:{fontSize:10,padding:'1px 7px',borderRadius:3,background:bg,color,border:`0.5px solid ${border}`,whiteSpace:'nowrap'}},children);}
// Compact status badge for settings-item validation rows (AcoustID Key /
// fpcalc path). Shows result in a circle badge; click to re-check.
function SettingStatus({state='idle',message,onClick,busy}){
  const C={
    idle: {ic:'circle-dashed',col:'var(--tx-faint)',bg:'var(--bg-muted)',bd:'var(--bd-default)'},
    ok:   {ic:'circle-check', col:'var(--green)',   bg:'var(--green-bg)',bd:'var(--green-bd)'},
    warn: {ic:'alert-circle', col:'var(--amber)',   bg:'var(--amber-bg)',bd:'var(--amber-bd)'},
    error:{ic:'alert-circle', col:'var(--red)',     bg:'var(--red-bg)',  bd:'var(--red-bd)'},
  }[state]||{ic:'circle-dashed',col:'var(--tx-faint)',bg:'var(--bg-muted)',bd:'var(--bd-default)'};
  return e('button',{onClick:onClick,disabled:busy||!onClick,title:message||'',
    style:{width:28,height:28,borderRadius:'50%',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',
      background:C.bg,border:`0.5px solid ${C.bd}`,cursor:(onClick&&!busy)?'pointer':'default',padding:0}},
    Icon(busy?'loader':C.ic,{fontSize:13,color:C.col},busy?'spin':undefined)
  );
}
function Btn({children,onClick,variant='primary',small,disabled,icon,style:sx={}}){
  const base={display:'flex',alignItems:'center',gap:5,borderRadius:'var(--r-md)',fontFamily:'var(--font-sans)',fontWeight:500,cursor:disabled?'not-allowed':'pointer',fontSize:small?11:12,padding:small?'4px 10px':'7px 14px',transition:'all .12s',border:'none',opacity:disabled?.45:1,whiteSpace:'nowrap',...sx};
  const V={primary:{...base,background:'var(--amber)',color:'#fff'},ghost:{...base,background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'},danger:{...base,background:'var(--red-bg)',color:'var(--red)',border:'0.5px solid var(--red-bd)'},success:{...base,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}};
  return e('button',{onClick:disabled?undefined:onClick,style:V[variant]||V.primary},icon&&Icon(icon,{fontSize:small?12:14},icon==='loader'?'spin':undefined),children);
}
// Icon-only action button — bigger touch target + a real fill color when
// active, so the three per-track actions (打开/属性/保留名单) read as buttons
// at a glance instead of being lost as small grey text links.
function IconAction({icon,title,onClick,active,activeColor='var(--amber)',activeBg,color='var(--tx-muted)',size=15,danger,disabled}){
  const ac=danger?'var(--red)':activeColor;
  const bg=active?(activeBg||ac+'17'):'var(--bg-base)';
  const bd=active?ac:'var(--bd-default)';
  const fg=active?ac:(danger?'var(--red)':color);
  return e('button',{onClick:disabled?undefined:onClick,title,disabled,style:{
    background:bg,border:`1px solid ${bd}`,borderRadius:'var(--r-md)',
    cursor:'pointer',
    color:disabled?'var(--tx-faint)':fg,
    opacity:disabled?0.4:1,
    width:30,height:30,display:'flex',alignItems:'center',justifyContent:'center',
    flexShrink:0,transition:'all .12s',boxShadow:'var(--sh-xs)'}},
    Icon(icon,{fontSize:size}));
}
function Card({children,style:sx={},id}){return e('div',{id,style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-xs)',padding:'18px 20px',...sx}},children);}
function SH({title,sub,hint,icon}){return e('div',{style:{marginBottom:12}},e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',display:'flex',alignItems:'center',gap:5}},icon&&Icon(icon,{fontSize:14,color:'var(--tx-muted)'}),title,e(Hint,{text:hint})),sub&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:2}},sub));}
function Toast({msg,type='info',onClose}){
  useEffect(()=>{const t=setTimeout(onClose,3800);return()=>clearTimeout(t);},[]);
  const S={error:{bg:'var(--red-bg)',col:'var(--red)',bd:'var(--red-bd)',ic:'alert-circle'},success:{bg:'var(--green-bg)',col:'var(--green)',bd:'var(--green-bd)',ic:'circle-check'},info:{bg:'var(--amber-bg)',col:'var(--amber)',bd:'var(--amber-bd)',ic:'info-circle'}};
  const s=S[type]||S.info;
  return e('div',{className:'fade',style:{position:'fixed',bottom:24,right:24,zIndex:9999,background:s.bg,border:`1px solid ${s.bd}`,borderRadius:'var(--r-lg)',padding:'11px 16px',color:s.col,fontSize:12,fontWeight:500,display:'flex',alignItems:'center',gap:10,boxShadow:'var(--sh-md)',maxWidth:400}},
    Icon(s.ic,{fontSize:16,flexShrink:0}),e('span',{style:{flex:1}},msg),
    e('button',{onClick:onClose,style:{background:'none',border:'none',color:s.col,cursor:'pointer',padding:2}},Icon('x',{fontSize:13})));
}
function Modal({title,children,onClose,width=520,description}){
  return e('div',{style:{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,.25)',display:'flex',alignItems:'center',justifyContent:'center',padding:20},onClick:ev=>ev.target===ev.currentTarget&&onClose()},
    e('div',{id:'modal-inner',className:'fade',style:{position:'relative',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-xl)',boxShadow:'0 20px 60px rgba(0,0,0,.15)',width:'100%',maxWidth:width,maxHeight:'85vh',display:'flex',flexDirection:'column'}},
      e('div',{style:{borderBottom:'0.5px solid var(--bd-subtle)'}},
        e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 20px'}},
          e('span',{style:{fontSize:14,fontWeight:600}},title),
          e('button',{onClick:onClose,style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:4}},Icon('x',{fontSize:18}))
        ),
        description&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',lineHeight:1.6,padding:'0 20px 12px 20px'}},description)
      ),
      e('div',{style:{overflowY:'auto',scrollbarGutter:'stable',padding:'16px 20px',flex:1}},children)
    ));
}
function ConfirmModal({title,message,onConfirm,onClose,danger}){
  return e(Modal,{title,onClose},
    e('div',{style:{fontSize:13,color:'var(--tx-secondary)',lineHeight:1.7,marginBottom:20}},message),
    e('div',{style:{display:'flex',gap:8,justifyContent:'flex-end'}},
      e(Btn,{variant:'ghost',onClick:onClose},'取消'),
      e(Btn,{variant:danger?'danger':'primary',onClick:()=>{onConfirm();onClose();}},danger?'确认删除':'确认')
    ));
}

/* ── useConfirmAction: ConfirmModal wrapper with "本轮不再显示" checkbox ── */
function useConfirmAction(){
  const suppressedRef=useRef(new Set());
  const[pending,setPending]=useState(null); // {actionKey,title,message,danger,onConfirm}

  function confirmAction(actionKey,{title,message,danger},onConfirm){
    if(suppressedRef.current.has(actionKey)){
      onConfirm();
      return;
    }
    setPending({actionKey,title,message,danger,onConfirm});
  }

  const confirmDialog=pending&&e(Modal,{title:pending.title,onClose:()=>setPending(null)},
    e('div',{style:{fontSize:13,color:'var(--tx-secondary)',lineHeight:1.7,marginBottom:16}},pending.message),
    e('label',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:16,cursor:'pointer',fontSize:12,color:'var(--tx-muted)'}},
      e('input',{type:'checkbox',
        onChange:ev=>{
          if(ev.target.checked)suppressedRef.current.add(pending.actionKey);
          else suppressedRef.current.delete(pending.actionKey);
        }
      }),
      '本轮不再显示'
    ),
    e('div',{style:{display:'flex',gap:8,justifyContent:'flex-end'}},
      e(Btn,{variant:'ghost',onClick:()=>setPending(null)},'取消'),
      e(Btn,{variant:pending.danger?'danger':'primary',onClick:()=>{pending.onConfirm();setPending(null);}},pending.danger?'确认删除':'确认')
    )
  );

  return{confirmAction,confirmDialog};
}


/* ══════════════════════════════════════════════════════════════════════
   GLOBAL SCAN STREAM — mounted once at App level (not inside ScannerView)
   so the SSE connection — and therefore the final "done" event that
   refreshes the 重复组 badge count — survives switching tabs mid-scan.
   Previously this lived inside ScannerView and was torn down the moment
   the user navigated away, so a re-match started there and watched from
   another tab would finish silently with a stale badge.
   ══════════════════════════════════════════════════════════════════════ */
function useScanStream(onDone){
  const[status,setStatus]=useState({phase:'idle',pct:0,running:false,message:''});
  const[logs,setLogs]=useState([]);
  const[confirm,setConfirm]=useState(null);
  const onDoneRef=useRef(onDone);
  onDoneRef.current=onDone;

  useEffect(()=>{
    const es=new EventSource('/api/scan/stream');
    es.onmessage=ev=>{
      try{
        const d=JSON.parse(ev.data);
        setStatus(d);
        if(d.message){
          setLogs(p=>{
            if(p.length&&p[p.length-1].msg===d.message&&p[p.length-1].ty!=='sep')return p;
            const ty=d.level||'ok';
            return[...p.slice(-500),{msg:d.message,ty,ts:Date.now()}];
          });
        }
        if(d.type==='done')onDoneRef.current?.();
      }catch{}
    };
    return()=>es.close();
  },[]);

  function addSeparator(label){
    const ts=new Date().toLocaleTimeString('zh-CN');
    setLogs(p=>[...p,{msg:`━━━ ${label} [${ts}] ━━━`,ty:'sep',ts:Date.now()}]);
  }
  function startStep(steps,force=false,label,extra={}){
    addSeparator(`${label||'扫描'} · ${force?'强制全量':extra.retryMissed?'未命中重新执行':'智能模式'}`);
    api.post('/api/scan/start',{steps,force,...extra}).then(r=>{if(!r.ok)addSeparator(`⚠ 启动失败：${r.error||''}`);});
  }
  function tryStart(steps,force,label){
    if(force){setConfirm({steps,force,label});return;}
    startStep(steps,force,label);
  }
  function pause(){api.post('/api/scan/pause');}
  function resume(){api.post('/api/scan/resume');}
  return{status,logs,setLogs,confirm,setConfirm,addSeparator,startStep,tryStart,pause,resume};
}

/* ══════════════════════════════════════════════════════════════════════
   APP SHELL — F4: tab order is 音乐库 → 重复组 → 扫描 → 设置 (重复组 and
   扫描 swapped from before); 保留名单 folded into 设置, no longer a top tab.
   扫描目录 (scan_dirs) is lifted here so LibraryView's empty state and
   Settings' 扫描目录 section are reading/writing the exact same data.
   ══════════════════════════════════════════════════════════════════════ */
function App(){
  const[view,setView]=useState('library');
  const[pending,setPending]=useState(0);
  const[settings,setSettingsState]=useState(null);
  const[scanDoneKey,setScanDoneKey]=useState(0);
  const[libraryKey,setLibraryKey]=useState(0);
  const[retentionListKey,setRetentionListKey]=useState(0);
  const[writeHistoryKey,setWriteHistoryKey]=useState(0);
  const player=useGlobalPlayer();

  function refreshStats(){
    api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPending(r.data.dupGroups||0);});
    setScanDoneKey(k=>k+1);
    setLibraryKey(k=>k+1);
  }
  const scan=useScanStream(refreshStats);

  useEffect(()=>{
    refreshStats();
    api.get('/api/settings').then(r=>{if(r.ok)setSettingsState(r.data);});
  },[]);

  // Stable identities — required for React.memo on LibraryView/DuplicatesView
  // to actually take effect (an inline arrow prop would defeat memo on every
  // render regardless of how stable everything else is).
  const refreshLibrary=useCallback(()=>{
    scan.startStep(['enum','meta'],false,'音乐库更新');
    setView('scanner');
  },[scan]);

  const addScanDirNav=useCallback(dir=>{
    setSettingsState(p=>{
      const cur=p?.scan_dirs||[];
      if(cur.includes(dir))return p;
      const next=[...cur,dir];
      api.put('/api/settings',{scan_dirs:next});
      return{...(p||{}),scan_dirs:next};
    });
    refreshLibrary();
  },[scan,refreshLibrary]);
  const addScanDirOnly=useCallback(dir=>{
    setSettingsState(p=>{
      const cur=p?.scan_dirs||[];
      if(cur.includes(dir))return p;
      const next=[...cur,dir];
      api.put('/api/settings',{scan_dirs:next});
      return{...(p||{}),scan_dirs:next,_dirChanged:true};
    });
  },[scan]);
  const removeScanDir=useCallback(i=>{
    setSettingsState(p=>{
      const cur=p?.scan_dirs||[];
      const next=cur.filter((_,j)=>j!==i);
      api.put('/api/settings',{scan_dirs:next});
      return{...(p||{}),scan_dirs:next};
    });
  },[]);
  // onMatchAffectingChange only fires from a manual button — no auto-fire
  // on Settings keystrokes. Also jumps to 扫描 page for progress visibility.
  const onMatchAffectingChange=useCallback(()=>{
    scan.startStep(['basicMatch','fpMatch','scrapeMatch'],false,'设置变更后重新匹配');
    setView('scanner');
  },[scan]);
  const onScrapeReapply=useCallback(()=>{
    scan.startStep(['scrape','scrapeMatch'],false,'AcoustID Key 更新后重新刮削');
    setView('scanner');
  },[scan]);

  const TABS=[
    {id:'library',    label:'音乐库', icon:'music'},
    {id:'duplicates', label:'重复组', icon:'copy', badge:pending},
    {id:'scanner',    label:'扫描',   icon:'radar'},
    {id:'settings',   label:'设置',   icon:'settings'},
  ];

  const dirs=settings?.scan_dirs||[];

  // Fetch cover art when the playing track changes. Stored on the track
  // object itself so the cover survives tab switches without re-fetching.
  useEffect(()=>{
    const cur=player.current;
    if(!cur||cur.cover!==undefined)return;
    fetch(`/api/files/${cur.id}/cover`)
      .then(r=>r.ok?r.blob():null)
      .then(blob=>{ if(blob)cur.cover=URL.createObjectURL(blob); else cur.cover=null; })
      .catch(()=>{ cur.cover=null; });
  },[player.current?.id]);

  // Refs for the locate-scroll functions registered by each view/section —
  // one per possible "播放来源": 音乐库, 重复组, 设置→保留名单, 设置→最近写入.
  const locateInLibraryRef=useRef(null);
  const locateInDuplicatesRef=useRef(null);
  const locateInRetentionListRef=useRef(null);
  const locateInHistoryRef=useRef(null);
  const navigateToFile = (fileId) => {
    setView('library');
    setTimeout(()=>locateInLibraryRef.current?.(fileId), 150);
  };
  const navigateToDuplicateGroup=useCallback((groupId)=>{
    if(!groupId)return;
    setView('duplicates');
    setTimeout(()=>locateInDuplicatesRef.current?.(groupId),150);
  },[]);
  const mainScrollRef=useRef(null); // ref to the <main> scroll container, shared with LibraryView
  // Called when user clicks the info panel in PlayerBar — jumps back to
  // whichever list the currently-playing track was played from (音乐库、
  // 重复组、或设置→保留名单/最近写入), scrolled to that track's exact row.
  const handleLocate=useCallback(track=>{
    if(!track)return;
    if(track.src==='duplicates'||track.groupId){
      setView('duplicates');
      if(track.groupId)setTimeout(()=>locateInDuplicatesRef.current?.(track.groupId),150);
      return;
    }
    if(track.src==='settings-retention-list'){
      setView('settings');
      if(track.id)setTimeout(()=>locateInRetentionListRef.current?.(track.id),150);
      return;
    }
    if(track.src==='settings-history'){
      setView('settings');
      if(track.id)setTimeout(()=>locateInHistoryRef.current?.(track.id),150);
      return;
    }
    // Library (default): switch to library tab and scroll to the row
    setView('library');
    if(track.id){
      setTimeout(()=>locateInLibraryRef.current?.(track.id),120);
    }
  },[]);

  return e('div',{style:{display:'flex',flexDirection:'column',height:'100vh',overflow:'hidden',background:'var(--bg-subtle)'}},
    e('audio',{ref:player.audioRef,...player.bind,style:{display:'none'}}),

    // Header + nav: single row, 3-column grid — brand left, nav centre, empty right.
    e('div',{style:{display:'grid',gridTemplateColumns:'1fr auto 1fr',alignItems:'center',padding:'0 24px',height:54,background:'var(--bg-base)',borderBottom:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',flexShrink:0,zIndex:10}},
      e('div',{style:{display:'flex',alignItems:'center',gap:10,justifySelf:'start'}},
        e(Logo,{size:28}),
        e('span',{style:{fontWeight:700,fontSize:15,color:'var(--tx-primary)',letterSpacing:'-.015em'}},'MusicDedup'),
        e('span',{style:{fontSize:11,color:'var(--tx-faint)',background:'var(--bg-muted)',padding:'2px 8px',borderRadius:4,border:'0.5px solid var(--bd-default)',fontFamily:'var(--font-mono)'}},'v'+APP_VERSION)
      ),
      e('nav',{style:{display:'flex',gap:4,justifySelf:'center'}},
        TABS.map(t=>e('button',{key:t.id,onClick:()=>setView(t.id),style:{display:'flex',alignItems:'center',gap:6,padding:'8px 16px',cursor:'pointer',fontSize:12,fontWeight:view===t.id?600:400,color:view===t.id?'var(--amber)':'var(--tx-muted)',background:view===t.id?'var(--amber-bg)':'none',border:'none',outline:'none',borderRadius:'var(--r-md)',transition:'all .15s'}},
          Icon(t.icon,{fontSize:15}),t.label,
          t.badge?e('span',{style:{fontSize:10,fontWeight:700,background:'var(--amber)',color:'#fff',borderRadius:8,padding:'1px 6px',minWidth:16,textAlign:'center'}},t.badge):null
        ))
      ),
      e('div',{style:{justifySelf:'end'}})
    ),

    // Main content — max-width centred column. Views are permanently mounted
    // (display:none when inactive) so tab switches don't re-fetch anything.
    e('main',{ref:mainScrollRef,style:{flex:1,overflowY:'auto',scrollbarGutter:'stable',display:'flex',justifyContent:'center'}},
      e('div',{style:{width:'100%',maxWidth:'var(--max-width)',padding:20}},
        e('div',{style:{display:view==='library'?'block':'none'}},e(LibraryView,{player:player.lite,dirs,onAddDir:addScanDirNav,onRemoveDir:removeScanDir,onEnumOnly:refreshLibrary,onLocate:{setLocateInLibrary:fn=>{locateInLibraryRef.current=fn;}},mainScrollRef,libraryKey,onRetentionChange:()=>setRetentionListKey(k=>k+1),onTagsWritten:()=>{setWriteHistoryKey(k=>k+1);refreshStats();}})),
        e('div',{style:{display:view==='duplicates'?'block':'none'}},e(DuplicatesView,{setPendingCount:setPending,player:player.lite,scanDoneKey,onRetentionChange:()=>setRetentionListKey(k=>k+1),onTagsWritten:()=>{setWriteHistoryKey(k=>k+1);refreshStats();},onLocate:{setLocateInDuplicates:fn=>{locateInDuplicatesRef.current=fn;}}})),
        e('div',{style:{display:view==='scanner'?'block':'none'}},e(ScannerView,{scan})),
        e('div',{style:{display:view==='settings'?'block':'none'}},e(SettingsView,{dirs,onAddDir:addScanDirOnly,onRemoveDir:removeScanDir,dirChanged:!!settings?._dirChanged,onEnumOnly:()=>{refreshLibrary();setSettingsState(p=>({...(p||{}),_dirChanged:false}));},onMatchAffectingChange,onScrapeReapply,scanRunning:scan.status.running,player:player.lite,retentionListKey,writeHistoryKey,onLocateFile:navigateToFile,onNavigateToDuplicateGroup:navigateToDuplicateGroup,onLocate:{setLocateInRetentionList:fn=>{locateInRetentionListRef.current=fn;},setLocateInHistory:fn=>{locateInHistoryRef.current=fn;}},mainScrollRef}))
      )
    ),
    // PlayerBar in normal flow — pushes content up, never overlaps.
    e(PlayerBar,{player,onLocate:handleLocate})
  );
}
