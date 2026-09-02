// public/components.js — 共享 UI 组件库（app.js 与 views/*.js 共用）
// 经典脚本顶层 const/function 进全局词法环境，app.js 与 views/*.js 均可直接使用。
// 必须在 rules-meta.js 之后、app.js 之前加载（见 index.html 脚本顺序）。
'use strict';
const {useState,useEffect,useRef,useMemo,useCallback,useLayoutEffect}=React;
const e=React.createElement;
/* ── Helpers ──────────────────────────────────────────────────────────── */
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
  search:{els:[['circle',{cx:11,cy:11,r:7}],['path',{d:'M21 21l-4.3-4.3'}]]},
  filter:{els:[['path',{d:'M4 5h16L14 12v6l-4 2v-8z'}]]},
  settings:{els:[['circle',{cx:12,cy:12,r:3}],['path',{d:'M19.4 13a8 8 0 000-2l2-1.6-2-3.4-2.4.6a8 8 0 00-1.7-1l-.4-2.6h-4l-.4 2.6a8 8 0 00-1.7 1l-2.4-.6-2 3.4L4.6 11a8 8 0 000 2l-2 1.6 2 3.4 2.4-.6a8 8 0 001.7 1l.4 2.6h4l.4-2.6a8 8 0 001.7-1l2.4.6 2-3.4z'}]]},
  music:{els:[['path',{d:'M9 18V5l12-2v13'}],['circle',{cx:6,cy:18,r:3}],['circle',{cx:18,cy:16,r:3}]]},
  // "在音乐库中查看" — 音乐库的 music-note 字形（缩小置左上）+ 实心定位针徽标（右下）。
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
  'alert-triangle':{els:[['path',{d:'M12 4l8 14H4z'}],['path',{d:'M12 10v3.5'}],['path',{d:'M12 17h.01'}]]},
  'circle-check':{els:[['circle',{cx:12,cy:12,r:9}],['path',{d:'M8.5 12.5l2 2 4.5-5'}]]},
  'circle-dashed':{els:[['circle',{cx:12,cy:12,r:9,strokeDasharray:'4 3'}]]},
  loader:{els:[['circle',{cx:12,cy:12,r:9,strokeDasharray:'14 50'}]]},
  'shield-check':{els:[['path',{d:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'}],['path',{d:'M9 12l2 2 4-4'}]]},
  // 刮削未确认 — plain cloud silhouette; cloud-check / cloud-download add a status glyph
  cloud:{els:[['path',{d:'M7 18a4 4 0 01-1-7.9A5 5 0 0116 7a4.5 4.5 0 011 8.9'}]]},
  // 刮削确认 — cloud 字形加对勾（区别于 download 箭头）；「保护」语义归 shield-check/手动保留名单。
  'cloud-check':{els:[['path',{d:'M7 18a4 4 0 01-1-7.9A5 5 0 0116 7a4.5 4.5 0 011 8.9'}],['path',{d:'M8.5 14.3l2.3 2.3 4.7-4.9'}]]},
  // 音质优先级 — 三段音频均衡器（竖条 + 滑块旋钮）。
  'audio-levels':{els:[
    ['path',{d:'M6 19V15'}],['path',{d:'M6 12V5'}],['circle',{cx:6,cy:13.5,r:1.4,fill:'currentColor'}],
    ['path',{d:'M12 19V10'}],['path',{d:'M12 7V5'}],['circle',{cx:12,cy:8.5,r:1.4,fill:'currentColor'}],
    ['path',{d:'M18 19V17'}],['path',{d:'M18 14V5'}],['circle',{cx:18,cy:15.5,r:1.4,fill:'currentColor'}]
  ]},
  // 保留优先级 — 领奖台，最高（第一名）柱带星标。
  'priority-podium':{els:[
    ['rect',{x:3,y:13,width:5,height:8,rx:1}],
    ['rect',{x:9.5,y:8,width:5,height:13,rx:1}],
    ['rect',{x:16,y:15,width:5,height:6,rx:1}],
    ['path',{d:'M12 3.8l.7 1.5 1.6.2-1.2 1.2.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.2 1.6-.2z',fill:'currentColor',stroke:'none'}]
  ]},
  // 维度对比 — 对比表（表头行 + 列分隔线）；区别于单个维度图标（音质优先级/audio-levels）。
  'table-compare':{els:[
    ['rect',{x:3,y:4.5,width:18,height:15,rx:1.5}],['path',{d:'M3 9.5h18'}],
    ['path',{d:'M9.3 9.5v10'}],['path',{d:'M15 9.5v10'}]
  ]},
  // 大小 dimension — 直尺（与 priority-podium 的堆叠条区分）。
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
  'skip-back':{fill:1,els:[['rect',{x:4,y:5,width:2.5,height:14,rx:1}],['path',{d:'M18 5v14l-10-7z'}]]},
  'skip-forward':{fill:1,els:[['rect',{x:17.5,y:5,width:2.5,height:14,rx:1}],['path',{d:'M6 5v14l10-7z'}]]},
  click:{els:[['path',{d:'M9 9l11 4-4.5 1.8L14 19z'}],['path',{d:'M5 3v3'}],['path',{d:'M3 9h3'}],['path',{d:'M5.6 5.6l1.8 1.8'}]]},
  'terminal-2':{els:[['path',{d:'M5 7l5 5-5 5'}],['path',{d:'M12 19h7'}]]},
  tag:{els:[['path',{d:'M3 11V5a2 2 0 012-2h6l10 10-8 8z'}],['circle',{cx:8,cy:8,r:1.3,fill:'currentColor'}]]},
  'wave-sine':{els:[['path',{d:'M2 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0'}]]},
  'cloud-download':{els:[['path',{d:'M7 18a4 4 0 01-1-7.9A5 5 0 0116 7a4.5 4.5 0 011 8.9'}],['path',{d:'M12 11v8'}],['path',{d:'M9 16l3 3 3-3'}]]},
  star:{els:[['path',{d:'M12 17.75l-6.172 3.245 1.179-6.873-5-4.867 6.9-1L12 2.002l3.086 6.253 6.9 1-5 4.867 1.179 6.873z'}],['path',{d:'M9 12l2 2 4-4'}]]},
  download:{els:[['path',{d:'M12 4v12'}],['path',{d:'M7 11l5 5 5-5'}],['path',{d:'M5 20h14'}]]},
  // Volume / speaker icons
  'volume':     {els:[['path',{d:'M11 5L6 9H2v6h4l5 4V5z'}],['path',{d:'M19.07 4.93a10 10 0 010 14.14'}],['path',{d:'M15.54 8.46a5 5 0 010 7.07'}]]},
  'volume-2':   {els:[['path',{d:'M11 5L6 9H2v6h4l5 4V5z'}],['path',{d:'M15.54 8.46a5 5 0 010 7.07'}]]},
  'volume-off': {els:[['path',{d:'M11 5L6 9H2v6h4l5 4V5z'}],['path',{d:'M23 9l-6 6'}],['path',{d:'M17 9l6 6'}]]},
  edit:{els:[['path',{d:'M7 20H4v-3L15.5 5.5a2.12 2.12 0 013 3z'}],['path',{d:'M13.5 7.5l3 3'}]]},
  pencil:{els:[['path',{d:'M7 20H4v-3L15.5 5.5a2.12 2.12 0 013 3z'}],['path',{d:'M13.5 7.5l3 3'}]]},
  'arrow-back-up':{els:[['path',{d:'M9 13l-4-4 4-4'}],['path',{d:'M5 9h9a5 5 0 010 10h-2'}]]},
  'arrows-exchange':{els:[['path',{d:'M20 7H8'}],['path',{d:'M12 4l-4 3 4 3'}],['path',{d:'M4 17h12'}],['path',{d:'M12 14l4 3-4 3'}]]},
  'shield-x':{els:[['path',{d:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'}],['path',{d:'M9.5 9.5l5 5'}],['path',{d:'M14.5 9.5l-5 5'}]]},
  'toggle-left':{els:[['path',{d:'M4 12a6 6 0 016-6h4a6 6 0 010 12H10a6 6 0 01-6-6z'}],['circle',{cx:9.5,cy:12,r:2.6,fill:'currentColor'}]]},
  'file-music':{els:[['path',{d:'M14 3v4a1 1 0 001 1h4'}],['path',{d:'M5 4a1 1 0 011-1h7l5 5v11a1 1 0 01-1 1H6a1 1 0 01-1-1z'}],['path',{d:'M9.5 17v-4.5l4-1v4.5'}],['circle',{cx:8.7,cy:17,r:1.2,fill:'currentColor'}],['circle',{cx:12.7,cy:15.5,r:1.2,fill:'currentColor'}]]},
  // 无边框：Linux 自绘窗口控制三键（Win/mac 用原生控件，用不到）
  'minus':{els:[['path',{d:'M5 12h14'}]]},
  'maximize':{els:[['rect',{x:5,y:5,width:14,height:14,rx:1}]]},
  'restore':{els:[['rect',{x:6,y:9,width:10,height:10,rx:1}],['path',{d:'M9 9V6a1 1 0 011-1h8a1 1 0 011 1v8a1 1 0 01-1 1h-3'}]]},
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

/* ── Brand mark — 多方法音乐去重：
   雷达环+扫描扇区 = 多通道检测；标准四分音符前方实心（居中略偏左上，保留），
   阴影空心音符投射在右斜下方（被去重的副本）。与 assets/icon.svg 同一设计。 */
function Logo({size=28,radius=7}={}){
  // 标准四分音符（品牌图标同款路径）
  const NOTE_PATH='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z';
  return e('svg',{width:size,height:size,viewBox:'0 0 64 64',style:{display:'inline-block',verticalAlign:'middle',flexShrink:0,borderRadius:radius,boxShadow:'0 1px 3px rgba(217,119,6,.25)'}},
    e('defs',null,e('linearGradient',{id:'logoGrad',x1:0,y1:0,x2:0,y2:1},e('stop',{offset:0,stopColor:'#FDE68A'}),e('stop',{offset:1,stopColor:'#D97706'}))),
    e('rect',{width:64,height:64,rx:radius*2,fill:'url(#logoGrad)'}),
    e('circle',{cx:32,cy:32,r:22.5,fill:'none',stroke:'#fff',strokeOpacity:.5,strokeWidth:1.5}),
    e('path',{d:'M32 9.5 A22.5 22.5 0 0 1 54.5 32 L32 32 Z',fill:'#fff',fillOpacity:.15}),
    e('path',{d:'M32 9.5 A22.5 22.5 0 0 1 54.5 32',fill:'none',stroke:'#fff',strokeOpacity:.7,strokeWidth:1.2}),
    e('path',{transform:'translate(19,21) scale(1.5)',d:NOTE_PATH,fill:'none',stroke:'#fff',strokeOpacity:.8,strokeWidth:1.5,strokeLinejoin:'round'}),
    e('path',{transform:'translate(13,15) scale(1.5)',d:NOTE_PATH,fill:'#fff'})
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
      background:'#fff',color:'#1F2937',fontSize:12,lineHeight:1.75,whiteSpace:'pre-line',textAlign:'left',
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
// 路径/目录选择框：文本框 + 浏览按钮合并为一体（input-group 式），文本框 flex:1
// 随容器铺满。音乐目录编辑器与 CP 声纹路径共用同一造型，避免两处样式漂移。
function PathInput({value,onChange,placeholder,title,onBrowse,browsing,buttonLabel='选择文件夹',buttonTitle,onKeyDown,onBlur,style:ws={},inputStyle:x={}}){
  return e('div',{style:{display:'flex',borderRadius:'var(--r-md)',overflow:'hidden',...ws}},
    e('input',{value,onChange,placeholder,title,onKeyDown,onBlur,
      style:{flex:1,minWidth:0,fontSize:11,padding:'6px 10px',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRight:'none',boxShadow:'var(--sh-xs)',fontFamily:'var(--font-mono)',outline:'none',...x}}),
    e('button',{onClick:onBrowse,disabled:browsing,title:buttonTitle,
      style:{padding:'6px 12px',background:'var(--bg-muted)',border:'0.5px solid var(--bd-default)',borderLeft:'none',borderRadius:0,borderTopRightRadius:'var(--r-md)',borderBottomRightRadius:'var(--r-md)',cursor:browsing?'wait':'pointer',fontSize:11,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4,whiteSpace:'nowrap',flexShrink:0}},
      Icon(browsing?'loader':'folder-open',{fontSize:12,color:'var(--tx-muted)'},browsing?'spin':undefined),buttonLabel)
  );
}
function Btn({children,onClick,variant='primary',small,disabled,icon,title,style:sx={}}){
  const base={display:'flex',alignItems:'center',gap:5,borderRadius:'var(--r-md)',fontFamily:'var(--font-sans)',fontWeight:500,cursor:disabled?'not-allowed':'pointer',fontSize:small?11:12,padding:small?'4px 10px':'7px 14px',transition:'all .12s',border:'none',opacity:disabled?.6:1,whiteSpace:'nowrap',...sx};
  const V={primary:{...base,background:'var(--amber)',color:'#fff'},ghost:{...base,background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'},danger:{...base,background:'var(--red-bg)',color:'var(--red)',border:'0.5px solid var(--red-bd)'},success:{...base,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}};
  return e('button',{onClick:disabled?undefined:onClick,title,style:V[variant]||V.primary},icon&&Icon(icon,{fontSize:small?12:14},icon==='loader'?'spin':undefined),children);
}
// Icon-only action button — 更大的点击区；激活时有实心填充色。
function IconAction({icon,title,onClick,active,activeColor='var(--amber)',activeBg,color='var(--tx-muted)',size=15,danger,disabled}){
  const ac=danger?'var(--red)':activeColor;
  const bg=active?(activeBg||ac+'17'):'var(--bg-base)';
  const bd=active?ac:'var(--bd-default)';
  const fg=active?ac:(danger?'var(--red)':color);
  return e('button',{onClick:disabled?undefined:onClick,title,disabled,style:{
    background:bg,border:`1px solid ${bd}`,borderRadius:'var(--r-md)',
    cursor:'pointer',
    color:disabled?'var(--tx-faint)':fg,
    opacity:disabled?0.6:1,
    width:30,height:30,display:'flex',alignItems:'center',justifyContent:'center',
    flexShrink:0,transition:'all .12s',boxShadow:'var(--sh-xs)'}},
    Icon(icon,{fontSize:size}));
}
function Card({children,style:sx={},id}){return e('div',{id,style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-xs)',padding:'18px 20px',...sx}},children);}
function SH({title,hint,icon}){return e('div',{style:{marginBottom:18}},e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',display:'flex',alignItems:'center',gap:5}},icon&&Icon(icon,{fontSize:14,color:'var(--tx-muted)'}),title,e(Hint,{text:hint})));}
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

/* ── 更新检查 / 下载 ── 与设置页「关于」卡共用（App 单例 + AboutSection 兜底）。
   check({silent}) 静默检查不弹提示，命中结果由 App 派生顶部「设置」标签徽标；
   手动检查命中打开确认弹窗（App 级 UpdateModal）；行内状态由 AboutSection 从 res/checked/err 派生。
   download({silent}) 自动下载只下载不安装，安装由 install() 在用户确认后触发。 */
function useUpdate(){
  const[checking,setChecking]=useState(false);
  const[res,setRes]=useState(null);       // {current,hasUpdate,latest} | {error}
  const[promptOpen,setPromptOpen]=useState(false);
  const[dl,setDl]=useState(null);         // null|'downloading'|'downloaded'|'installing'
  const[dlError,setDlError]=useState(null);
  const[checked,setChecked]=useState(false); // 手动检查过（非 silent），行内据此显示「已是最新」
  const[err,setErr]=useState(null);          // 手动检查失败信息

  async function check(opts={}){
    setChecking(true);setErr(null);setDlError(null);
    if(!opts.silent)setChecked(true);
    try{
      const r=await api.get('/api/update/check?current='+encodeURIComponent(APP_VERSION));
      if(r.ok){
        setRes(r.data);
        if(r.data.hasUpdate&&r.data.latest&&!opts.silent)setPromptOpen(true);
      }else if(!opts.silent){ setErr(r.error||'检查更新失败'); }
    }catch(e){
      if(!opts.silent)setErr('网络错误，请检查网络连接');
    }finally{ setChecking(false); }
  }
  async function download(opts={}){
    const latest=res?.latest;
    if(!latest||dl)return;
    setDl('downloading');setDlError(null);
    try{
      // 安装版（electron-updater）无需 url/digest；便携版携带资产地址与 SHA256 供校验
      const payload={version:latest.version};
      if(latest.asset){payload.url=latest.asset.url;if(latest.asset.digest)payload.digest=latest.asset.digest;}
      const r=await api.post('/api/update/download',payload);
      // 下载只下载不安装：安装/替换由用户点「立即安装」走 install 触发
      if(r.ok)setDl('downloaded');
      else{setDl(null);setDlError(r.error||'下载失败');}
    }catch(e){setDl(null);setDlError('下载失败，请检查网络');}
  }
  async function install(){
    const v=res?.latest?.version;
    if(!v)return;
    setDl('installing');setDlError(null);
    try{
      const r=await api.post('/api/update/install',{version:v});
      if(!r.ok){setDl('downloaded');setDlError(r.error||'安装失败');}
    }catch(e){setDl('downloaded');setDlError('安装失败，请检查网络');}
  }
  function close(){setPromptOpen(false);}

  return{checking,res,promptOpen,setPromptOpen,dl,dlError,checked,err,check,download,install,close};
}

// 发现新版本弹窗：手动「检查更新」命中时展示。dl 状态驱动按钮（下载中/已下载→立即安装）。
function UpdateModal({res,dl,dlError,onDownload,onInstall,onOpenExternal,onClose}){
  const latest=res?.latest;
  if(!latest)return null;
  return e(Modal,{title:'发现新版本',description:`v${res.current} → v${latest.version}`+(latest.publishedAt?' · '+fmtDate(new Date(latest.publishedAt)):''),onClose,width:500},
    latest.body&&e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.7,whiteSpace:'pre-wrap',maxHeight:280,overflowY:'auto',scrollbarGutter:'stable'}},latest.body),
    dlError&&e('div',{style:{color:'var(--red)',fontSize:12,marginTop:10}},'更新失败：'+dlError),
    e('div',{style:{display:'flex',gap:8,justifyContent:'flex-end',marginTop:16}},
      e(Btn,{variant:'ghost',onClick:()=>onOpenExternal&&onOpenExternal(latest.htmlUrl)},'查看更新内容'),
      dl==='downloading'&&e(Btn,{icon:'loader',disabled:true},'正在下载更新…'),
      dl==='installing'&&e(Btn,{icon:'loader',disabled:true},'正在安装新版本…'),
      dl==='downloaded'&&e(Btn,{variant:'ghost',onClick:onClose},'稍后'),
      dl==='downloaded'&&e(Btn,{icon:'download',onClick:onInstall},'立即安装'),
      dl===null&&e(Btn,{icon:'download',onClick:onDownload},'下载更新')
    )
  );
}

/* ── 无边框：Linux 自绘窗口控制三键（frame:false 无原生按钮；Win/mac 不渲染）── */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!window.bridge?.winControls) return;
    let off = null;
    window.bridge.winControls.isMaximized().then(setMaximized).catch(() => {});
    off = window.bridge.winControls.onMaximized(setMaximized);
    return () => { if (off) off(); };
  }, []);
  if (window.bridge?.platform !== 'linux' || !window.bridge?.winControls) return null;
  const btn = (icon, onClick, title) => e('button', {
    onClick, title,
    style: { width:34, height:30, display:'flex', alignItems:'center', justifyContent:'center',
      background:'transparent', border:'none', borderRadius:'var(--r-sm)', cursor:'pointer',
      color:'var(--tx-muted)', WebkitAppRegion:'no-drag' },
    onMouseEnter: (ev) => { ev.currentTarget.style.background = 'var(--bg-muted)'; },
    onMouseLeave: (ev) => { ev.currentTarget.style.background = 'transparent'; },
  }, Icon(icon, { fontSize: 14 }));
  return e('div', { style: { display:'flex', alignItems:'center', gap:2, WebkitAppRegion:'no-drag' } },
    btn('minus', () => window.bridge.winControls.minimize(), '最小化'),
    btn(maximized ? 'restore' : 'maximize', () => window.bridge.winControls.toggleMaximize(), maximized ? '还原' : '最大化'),
    btn('x', () => window.bridge.winControls.close(), '关闭')
  );
}
