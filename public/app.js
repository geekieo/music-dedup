'use strict';
const {useState,useEffect,useRef,useMemo,useCallback}=React;
const e=React.createElement;
const APP_VERSION='1.14.0';

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
    ['path',{d:'M4.5 14.5V6l7.5-1.3v7.3'}],
    ['circle',{cx:3,cy:14.5,r:1.9}],
    ['circle',{cx:10.5,cy:13.2,r:1.9}],
    ['path',{d:'M19.5 12.2c0 3-3.3 6.3-3.3 6.3s-3.3-3.3-3.3-6.3a3.3 3.3 0 016.6 0z',fill:'currentColor',stroke:'none'}],
    ['circle',{cx:16.2,cy:12.2,r:1.15,fill:'var(--bg-base)',stroke:'none'}]
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
function IconAction({icon,title,onClick,active,activeColor='var(--amber)',activeBg,color='var(--tx-muted)',size=15,danger}){
  const ac=danger?'var(--red)':activeColor;
  const bg=active?(activeBg||ac+'17'):'var(--bg-base)';
  const bd=active?ac:'var(--bd-default)';
  const fg=active?ac:(danger?'var(--red)':color);
  return e('button',{onClick,title,style:{background:bg,border:`1px solid ${bd}`,borderRadius:'var(--r-md)',cursor:'pointer',color:fg,width:30,height:30,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,transition:'all .12s',boxShadow:'var(--sh-xs)'}},
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
    e('div',{className:'fade',style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-xl)',boxShadow:'0 20px 60px rgba(0,0,0,.15)',width:'100%',maxWidth:width,maxHeight:'85vh',display:'flex',flexDirection:'column'}},
      e('div',{style:{borderBottom:'0.5px solid var(--bd-subtle)'}},
        e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 20px'}},
          e('span',{style:{fontSize:14,fontWeight:600}},title),
          e('button',{onClick:onClose,style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:4}},Icon('x',{fontSize:18}))
        ),
        description&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',lineHeight:1.6,padding:'0 20px 12px 20px'}},description)
      ),
      e('div',{style:{overflowY:'auto',padding:'16px 20px',flex:1}},children)
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


// Client reads scrape_tier from the server (lib/tier.js) — no longer
// carries its own incomplete CJK folding table. normCmp is kept for
// autoSelectFields' byte-level equality check (different question from tier).
const normCmp = s => (s||'').toLowerCase().replace(/[\s\u3000()（）【】「」\-_,.]/g,'');

// TIER_COLOR, TIER_LABEL are served by /rules-meta.js (source: lib/rules.js)

/* ── Instant-tooltip wrapper ─────────────────────────────────────────────
   `title` attribute has browser-imposed ~500 ms delay. This component
   shows the tooltip synchronously on mouseenter via a small absolutely-
   positioned div, so there's zero delay.
*/
function InstantTooltip({tip,children,style={},light=false}){
  const[show,setShow]=useState(false);
  const[pos,setPos]=useState({x:0,y:0});
  return e('span',{style:{position:'relative',display:'inline-flex',...style},
    onMouseEnter:ev=>{const r=ev.currentTarget.getBoundingClientRect();setPos({x:ev.clientX-r.left,y:-28});setShow(true);},
    onMouseLeave:()=>setShow(false)},
    children,
    show&&tip&&e('div',{style:light?{position:'absolute',left:pos.x,top:pos.y,
      background:'#fff',color:'#1F2937',fontSize:11,fontFamily:'var(--font-sans)',
      padding:'3px 10px',borderRadius:4,whiteSpace:'nowrap',zIndex:9999,pointerEvents:'none',
      transform:'translateX(-50%)',boxShadow:'0 2px 12px rgba(0,0,0,.12)',border:'0.5px solid var(--bd-default)',lineHeight:1.4}
      :{position:'absolute',left:pos.x,top:pos.y,
      background:'rgba(17,24,39,.92)',color:'#fff',fontSize:10,fontFamily:'var(--font-mono)',
      padding:'4px 8px',borderRadius:6,whiteSpace:'pre',zIndex:9999,pointerEvents:'none',
      transform:'translateX(-50%)',boxShadow:'0 2px 8px rgba(0,0,0,.3)',lineHeight:1.5}},tip)
  );
}

/* ── auto-select logic for ScrapeDialog (dual-source) ────────────────────
   Conservative per-field logic mirrors the old single-source MB rules.
   - Title/Artist: NEVER auto-select (high-visibility, always manual confirm)
   - Album: auto-select ONLY when file's album is blank
   - Year: auto-select when blank, OR when an exact-match source has a
     different (likely more correct) value
   - Track/Genre: auto-select ONLY when blank
   Source-level match_basis is NEVER shown per-field — it's a recording-level
   attribute, not a per-field verification.
*/
function autoSelectFields(file, scraped) {
  if (!scraped || (!scraped.mb?.title && !scraped.acoustid?.title)) return { selected:{}, recommend:{}, reasons:{}, conflicts:{} };
  const sel = {}, rec = {}, rsn = {}, cfl = {};
  const JUNK = [/热歌/,/慢摇/,/合辑/,/精选\d/,/^\d+首/,/网络/];
  const mb = scraped.mb, aid = scraped.acoustid;
  const mbExact = mb?.scrape_tier === 'green' || mb?.scrape_tier === 'blue';
  const aidExact = aid?.scrape_tier === 'green' || aid?.scrape_tier === 'blue';

  function hasData(src, key) { const v=src?.[key]; return v!=null && v!==0 && v!==''; }

  // Pick best source for a field when both have data. Returns null on conflict.
  function pickSrc(key) {
    const hm=hasData(mb,key), ha=hasData(aid,key);
    if (!hm&&!ha) return null;
    if (!hm) return 'acoustid';
    if (!ha) return 'musicbrainz';
    if (normCmp(String(mb[key]))===normCmp(String(aid[key]))) return aidExact?'acoustid':mbExact?'musicbrainz':'acoustid';
    return null; // disagree
  }

  // ── Title — NEVER auto-check ──────────────────────────────────────────
  sel.title = false;
  if (!hasData(mb,'title')&&!hasData(aid,'title')) rsn.title='刮削无数据';
  else if (!file.title) rsn.title='文件属性为空，但标题不建议自动写入，请手动确认';
  else rsn.title='与文件属性不同，请手动确认';

  // ── Artist — NEVER auto-check ─────────────────────────────────────────
  sel.artist = false;
  if (!hasData(mb,'artist')&&!hasData(aid,'artist')) rsn.artist='刮削无数据';
  else if (!file.artist) rsn.artist='文件属性为空，但艺术家不建议自动写入，请手动确认';
  else rsn.artist='与文件属性不同，请手动确认';

  // ── Album — auto-check ONLY when blank ────────────────────────────────
  const albumJunk = JUNK.some(p=>p.test(file.album||''));
  if (!hasData(mb,'album')&&!hasData(aid,'album')) { sel.album=false; rsn.album='刮削无数据'; }
  else if (!file.album) {
    const s=pickSrc('album'); sel.album=s||false; if(s)rec.album=true;
    rsn.album=s?'文件属性为空，建议写入':'⚠ 两个来源数据不一致，请手动选择';
    if(!s) cfl.album=true;
  } else if (scraped.scrape_tier==='green') {
    sel.album=false; rsn.album='仅繁简写法不同，与文件属性一致';
  } else if (albumJunk&&(mbExact||aidExact)) {
    sel.album=false; rec.album=true; rsn.album='当前专辑名疑似非正规，建议手动确认后覆写';
  } else {
    sel.album=false;
    if (hasData(mb,'album')&&hasData(aid,'album')&&normCmp(String(mb.album))!==normCmp(String(aid.album))) {
      cfl.album=true; rsn.album='⚠ 两个来源数据不一致，且文件已有专辑信息，请手动确认';
    } else rsn.album='与文件属性不同，请手动确认';
  }

  // ── Year — auto-check when blank, OR when exact source has diff value ─
  if (!hasData(mb,'album_year')&&!hasData(aid,'album_year')) { sel.album_year=false; rsn.album_year='刮削无数据'; }
  else if (!file.album_year) {
    const s=pickSrc('album_year'); sel.album_year=s||false; if(s)rec.album_year=true;
    rsn.album_year=s?'文件属性为空，建议写入':'⚠ 两个来源数据不一致，请手动选择';
    if(!s) cfl.album_year=true;
  } else {
    const s=pickSrc('album_year');
    if (s&&(s==='acoustid'?aidExact:mbExact)) {
      const sv=s==='acoustid'?aid.album_year:mb.album_year;
      if (sv!==file.album_year) { sel.album_year=s; rec.album_year=true; rsn.album_year=`精确匹配，建议覆写（当前: ${file.album_year}）`; }
      else { sel.album_year=false; rsn.album_year='与文件属性一致'; }
    } else if (!s) {
      sel.album_year=false; cfl.album_year=true; rsn.album_year='⚠ 两个来源数据不一致，请手动选择';
    } else {
      sel.album_year=false; rsn.album_year=`模糊匹配（当前: ${file.album_year}），请手动确认`;
    }
  }

  // ── Track — auto-check ONLY when blank ────────────────────────────────
  if (!hasData(mb,'track_number')&&!hasData(aid,'track_number')) { sel.track_number=false; rsn.track_number='刮削无数据'; }
  else if (!file.track_number) {
    const s=pickSrc('track_number'); sel.track_number=s||false; if(s)rec.track_number=true;
    rsn.track_number=s?'文件属性为空，建议写入':'⚠ 两个来源数据不一致，请手动选择';
    if(!s) cfl.track_number=true;
  } else {
    sel.track_number=false;
    if (hasData(mb,'track_number')&&hasData(aid,'track_number')&&mb.track_number!==aid.track_number) {
      cfl.track_number=true; rsn.track_number=`⚠ 两个来源曲目号不一致（${mb.track_number} vs ${aid.track_number}），请手动确认`;
    } else rsn.track_number='与文件属性一致';
  }

  // ── Genre — auto-check ONLY when blank ────────────────────────────────
  if (!hasData(mb,'genre')&&!hasData(aid,'genre')) { sel.genre=false; rsn.genre='刮削无数据'; }
  else if (!file.genre) {
    const s=pickSrc('genre'); sel.genre=s||false; if(s)rec.genre=true;
    rsn.genre=s?'文件属性为空，建议写入':'⚠ 两个来源数据不一致，请手动选择';
    if(!s) cfl.genre=true;
  } else {
    sel.genre=false;
    if (hasData(mb,'genre')&&hasData(aid,'genre')&&normCmp(String(mb.genre))!==normCmp(String(aid.genre))) {
      cfl.genre=true; rsn.genre='⚠ 两个来源数据不一致，且文件已有流派信息，请手动确认';
    } else rsn.genre='与文件属性一致';
  }

  return { selected:sel, recommend:rec, reasons:rsn, conflicts:cfl };
}

const WRITE_FIELDS = [
  { key:'title',        label:'标题'   },
  { key:'artist',       label:'艺术家' },
  { key:'album',        label:'专辑'   },
  { key:'album_year',   label:'年份'   },
  { key:'track_number', label:'曲目号' },
  { key:'genre',        label:'流派'   },
];

function ScrapeDialog({fileId,onClose,onUpdated,onTagsWritten}){
  const[liveTags,setLiveTags]=useState(null);   // actual file tags
  const[scraped,setScraped]=useState(undefined);// undefined=loading, null=none
  const[scraping,setScraping]=useState(false);
  const[writing,setWriting]=useState(false);
  const[writeResult,setWriteResult]=useState(null);
  const[confirmWrite,setConfirmWrite]=useState(false);
  const[sel,setSel]=useState({});
  const[recommend,setRecommend]=useState({});
  const[reasons,setReasons]=useState({});
  const[conflicts,setConflicts]=useState({});
  const[fileInfo,setFileInfo]=useState(null); // for filename + format

  function reload(){
    api.get(`/api/files/${fileId}`).then(r=>{if(r.ok)setFileInfo(r.data);});
    api.get(`/api/files/${fileId}/live-tags`).then(r=>{if(r.ok)setLiveTags(r.data);});
    api.get(`/api/files/${fileId}/scraped`).then(r=>{
      const data = r.ok ? r.data : null;
      setScraped(data);
    });
  }
  useEffect(()=>{
    reload();
  },[fileId]);

  // Auto-compute field selection when live tags or scraped data change
  useEffect(()=>{
    if(liveTags&&scraped){
      const{selected,recommend:rec,reasons:r,conflicts:c}=autoSelectFields(liveTags,scraped);
      setSel(selected); setRecommend(rec); setReasons(r); setConflicts(c||{});
    }
  },[liveTags?.title,scraped?.mb?.file_id,scraped?.acoustid?.file_id]);

  async function doScrape(){
    setScraping(true);setWriteResult(null);
    const r=await api.post(`/api/files/${fileId}/scrape-single`);
    setScraping(false);
    if(r.ok){ reload(); onUpdated&&onUpdated(); }
  }
  async function doCancelScrape(){
    await api.del(`/api/files/${fileId}/scraped`);
    setScraped(null); setSel({}); setRecommend({}); setReasons({});
    onUpdated&&onUpdated();
  }
  async function doWrite(){
    setConfirmWrite(false); setWriting(true); setWriteResult(null);
    const fields={};
    for(const{key}of WRITE_FIELDS){
      const src = sel[key];
      if (src && scraped[src]?.[key] != null && scraped[src][key] !== 0 && scraped[src][key] !== '')
        fields[key] = scraped[src][key];
    }
    const r=await api.post(`/api/files/${fileId}/write-tags`,{fields});
    setWriting(false); setWriteResult(r);
    if(r.ok){ reload(); onUpdated?.(); onTagsWritten?.(); }
  }
  async function doRevert(snapshotId){
    const r=await api.post(`/api/snapshots/${snapshotId}/revert`);
    if(r.ok){ reload(); setWriteResult(null); onUpdated?.(); onTagsWritten?.(); }
    else setWriteResult({ok:false,error:r.error||'撤销失败'});
  }

  const filename=fileInfo?fileInfo.path.split(/[\\/]/).pop():'';
  const loading=liveTags===null||scraped===undefined;
  const hasScraped=!!(scraped?.mb?.title||scraped?.acoustid?.title);
  const selCount=Object.values(sel).filter(Boolean).length;
  const canWrite=hasScraped&&selCount>0;
  const tier=scraped?.scrape_tier;
  // Source-level match labels based on per-source scrape_tier (considers
  // title+artist+album matching, not just the recording-level match_basis).
  const mbTier = scraped?.mb?.scrape_tier;
  const aidTier = scraped?.acoustid?.scrape_tier;
  const mbBasisLabel = mbTier === 'green' || mbTier === 'blue' ? '（精确）' : mbTier === 'yellow' ? '（模糊）' : '';
  const aidBasisLabel = aidTier === 'green' || aidTier === 'blue' ? '（精确）' : aidTier === 'yellow' ? '（模糊）' : '';

  // Diff color for a field vs a specific source
  function diffStyle(key, src){
    const fv=String(liveTags?.[key]||'').trim();
    const sv=String(scraped?.[src]?.[key]||'').trim();
    if(!sv)              return {background:'transparent'};
    if(!fv)              return {background:'#EFF6FF'};
    if(normCmp(fv)===normCmp(sv)) return {background:'#F0FDF4'};
    return {background:'#FFFBEB'};
  }

  return e(Modal,{title:`刮削操作`,onClose,width:760},
    loading&&e('div',{style:{textAlign:'center',padding:40}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})),

    !loading&&e('div',null,

      // Filename + status bar
      e('div',{style:{marginBottom:12,padding:'8px 12px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}},
        Icon('file-music',{fontSize:13,color:'var(--tx-faint)',flexShrink:0}),
        e('span',{style:{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},filename),
        hasScraped&&e('span',{style:{fontSize:10,padding:'2px 8px',borderRadius:99,background:TIER_COLOR[tier||'yellow']+'22',color:TIER_COLOR[tier||'yellow'],border:'0.5px solid '+TIER_COLOR[tier||'yellow'],whiteSpace:'nowrap'}},
          TIER_LABEL[tier]||'已刮削'),
        scraped?.mb?.title&&e('span',{style:{fontSize:9,color:'var(--tx-faint)'}},'MB'),
        scraped?.acoustid?.title&&e('span',{style:{fontSize:9,color:'var(--tx-faint)'}},'AcoustID')
      ),

      // Action buttons row
      e('div',{style:{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}},
        e(Btn,{icon:scraping?'loader':'cloud-download',disabled:scraping||writing,
          onClick:doScrape},scraping?'刮削中...':hasScraped?'重新刮削':'开始刮削'),
        hasScraped&&e(Btn,{icon:'x',variant:'ghost',disabled:scraping||writing,
          onClick:doCancelScrape},'取消刮削'),
      ),

      // ── Comparison table (dynamic columns: Field | File | MB? | AcoustID?) ──
      hasScraped&&(()=>{
        const showMb = !!(scraped?.mb?.title);
        const showAid = !!(scraped?.acoustid?.title);
        const colTemplate = `62px 1fr${showMb ? ' 1fr' : ''}${showAid ? ' 1fr' : ''}`;
        const nCols = 2 + (showMb?1:0) + (showAid?1:0);
        // Build header labels
        const headers = ['字段','文件属性'];
        if (showMb) headers.push(`MB 刮削${mbBasisLabel}`);
        if (showAid) headers.push(`AcoustID 刮削${aidBasisLabel}`);
        return e('div',{style:{marginBottom:14}},
          e('div',{style:{display:'grid',gridTemplateColumns:colTemplate,fontSize:10,borderRadius:'var(--r-md)',overflow:'hidden',border:'0.5px solid var(--bd-default)'}},
            // Header
            ...headers.map((h,i)=>e('div',{key:h,style:{padding:'6px 8px',background:'var(--bg-subtle)',fontWeight:600,color:'var(--tx-secondary)',borderBottom:'0.5px solid var(--bd-default)',borderRight:i<nCols-1?'0.5px solid var(--bd-subtle)':'none'}},h)),
            // Rows — conditionally include MB/AcoustID cells
            ...WRITE_FIELDS.map(({key,label})=>{
              const fv = (liveTags?.[key] || 0) > 0 ? String(liveTags[key]) : (liveTags?.[key] && liveTags[key] !== 0 ? String(liveTags[key]) : '');
              const conflict = conflicts[key];
              const cellBg = conflict ? {background:'#FFFBEB'} : {};
              const cells = [
                e('div',{key:key+'l',style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:'0.5px solid var(--bd-subtle)',color:'var(--tx-faint)',background:'var(--bg-subtle)'}},label),
                e('div',{key:key+'f',style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:(showMb||showAid)?'0.5px solid var(--bd-subtle)':'none',color:'var(--tx-primary)',fontFamily:'var(--font-mono)',fontSize:9,...cellBg}},fv||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—')),
              ];
              if (showMb) {
                const mbVal = (scraped?.mb?.[key] || 0) > 0 ? String(scraped.mb[key]) : (scraped?.mb?.[key] && scraped.mb[key] !== 0 ? String(scraped.mb[key]) : '');
                cells.push(e('div',{key:key+'m',style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:showAid?'0.5px solid var(--bd-subtle)':'none',color:'var(--tx-primary)',fontFamily:'var(--font-mono)',fontSize:9,...diffStyle(key,'mb'),...cellBg}},
                  mbVal||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—')
                ));
              }
              if (showAid) {
                const aidVal = (scraped?.acoustid?.[key] || 0) > 0 ? String(scraped.acoustid[key]) : (scraped?.acoustid?.[key] && scraped.acoustid[key] !== 0 ? String(scraped.acoustid[key]) : '');
                cells.push(e('div',{key:key+'a',style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',color:'var(--tx-primary)',fontFamily:'var(--font-mono)',fontSize:9,...diffStyle(key,'acoustid'),...cellBg}},
                  aidVal||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—'),
                  conflict&&e('span',{title:'MB 与 AcoustID 数据不一致，请手动选择',style:{cursor:'help',marginLeft:2}},Icon('alert-circle',{fontSize:10,color:'#D97706'}))
                ));
              }
              return cells;
            }).flat()
          )
        );
      })(),

      // ── Write to file section ─────────────────────────────────────────
      hasScraped&&e('div',{style:{borderTop:'0.5px solid var(--bd-default)',paddingTop:14}},
        e('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:10}},
          Icon('pencil',{fontSize:13,color:'var(--tx-secondary)'}),'写入文件'
        ),

        // Field radio-buttons: choose source per field
        WRITE_FIELDS.map(({key,label})=>{
          const hasMb = scraped?.mb?.[key] != null && scraped.mb[key] !== 0 && scraped.mb[key] !== '';
          const hasAid = scraped?.acoustid?.[key] != null && scraped.acoustid[key] !== 0 && scraped.acoustid[key] !== '';
          const disabled = !hasMb && !hasAid;
          const rec = recommend[key];
          const curSrc = sel[key];
          return e('div',{key,style:{display:'flex',alignItems:'flex-start',gap:8,padding:'5px 0',opacity:disabled?.4:1}},
            e('div',{style:{flex:1,minWidth:0}},
              e('div',{style:{fontSize:12,fontWeight:rec?600:400,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4,marginBottom:2}},
                label,
                rec&&e('span',{style:{fontSize:10,color:'var(--amber)',fontWeight:400}},'推荐')
              ),
              e('div',{style:{fontSize:10,color:'var(--tx-faint)',marginBottom:3}},reasons[key]||''),
              // Source selector
              !disabled&&e('div',{style:{display:'flex',gap:12,fontSize:10}},
                hasMb&&e('label',{style:{display:'flex',alignItems:'center',gap:3,cursor:'pointer',color:curSrc==='musicbrainz'?'var(--amber)':'var(--tx-muted)'}},
                  e('input',{type:'radio',name:'src_'+key,checked:curSrc==='musicbrainz',
                    onChange:()=>setSel(p=>({...p,[key]:'musicbrainz'})),
                    style:{accentColor:'var(--amber)'}}),
                  'MB'
                ),
                hasAid&&e('label',{style:{display:'flex',alignItems:'center',gap:3,cursor:'pointer',color:curSrc==='acoustid'?'var(--amber)':'var(--tx-muted)'}},
                  e('input',{type:'radio',name:'src_'+key,checked:curSrc==='acoustid',
                    onChange:()=>setSel(p=>({...p,[key]:'acoustid'})),
                    style:{accentColor:'var(--amber)'}}),
                  'AcoustID'
                )
              )
            )
          );
        }),

        // Write result
        writeResult&&e('div',{style:{marginTop:10,padding:'8px 12px',borderRadius:'var(--r-md)',
          background:writeResult.ok?'var(--green-bg)':'var(--red-bg)',
          border:`0.5px solid ${writeResult.ok?'var(--green-bd)':'var(--red-bd)'}`,fontSize:11}},
          writeResult.ok
            ?e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}},
              e('span',{style:{color:'var(--green)'}},'✓ 写入成功'),
              e('button',{onClick:()=>doRevert(writeResult.snapshotId),
                style:{background:'none',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-sm)',padding:'2px 10px',fontSize:11,cursor:'pointer',color:'var(--tx-secondary)'}},
                '撤销此次写入'))
            :e('span',{style:{color:'var(--red)'}},
              Icon('alert-circle',{marginRight:4,fontSize:12}),'失败: '+writeResult.error)
        ),

        // Safety notice + write button
        e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,marginTop:12,flexWrap:'wrap'}},
          e('div',{style:{fontSize:10,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:5}},
            Icon('shield-check',{fontSize:12,color:'var(--green)'}),'写入前自动备份原始标签，可随时撤销'),
          e(Btn,{disabled:!canWrite||writing||scraping,
            icon:writing?'loader':'pencil',
            onClick:()=>setConfirmWrite(true)},
            writing?'写入中...':canWrite?`写入 ${selCount} 个字段`:'选择字段后写入')
        )
      ),

      // Write confirm dialog (inline)
      confirmWrite&&e('div',{style:{position:'fixed',inset:0,zIndex:1100,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center'},
        onClick:ev=>ev.target===ev.currentTarget&&setConfirmWrite(false)},
        e('div',{style:{background:'var(--bg-base)',borderRadius:'var(--r-xl)',padding:'24px 28px',maxWidth:440,width:'90%',boxShadow:'0 8px 32px rgba(0,0,0,.2)'}},
          e('div',{style:{fontSize:14,fontWeight:700,marginBottom:8}},'确认写入文件'),
          e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.7,marginBottom:12}},
            '将直接修改以下字段到音频文件：'),
          WRITE_FIELDS.filter(({key})=>sel[key]&&scraped[sel[key]]?.[key]!=null&&scraped[sel[key]][key]!==0&&scraped[sel[key]][key]!=='').map(({key,label})=>
            e('div',{key,style:{fontSize:11,padding:'4px 8px',background:'var(--bg-subtle)',borderRadius:'var(--r-sm)',marginBottom:4,display:'flex',gap:8}},
              e('span',{style:{color:'var(--tx-faint)',width:42,flexShrink:0}},label+':'),
              e('span',{style:{fontFamily:'var(--font-mono)',color:'var(--amber)'}},String(scraped[sel[key]][key])),
              e('span',{style:{fontSize:9,color:'var(--tx-faint)'}},sel[key]==='acoustid'?'AcoustID':'MB')
            )
          ),
          e('div',{style:{fontSize:10,color:'var(--tx-faint)',marginTop:10,marginBottom:16,display:'flex',alignItems:'center',gap:5}},
            Icon('shield-check',{fontSize:11,color:'var(--green)'}),'写入前将自动备份原始标签，支持撤销'),
          e('div',{style:{display:'flex',gap:8,justifyContent:'flex-end'}},
            e(Btn,{variant:'ghost',onClick:()=>setConfirmWrite(false)},'返回'),
            e(Btn,{onClick:doWrite},'确认写入')
          )
        )
      )

    ) // end !loading
  );
}

/* ── Props Modal ─────────────────────────────────────────────────────── */
function PropsModal({fileId,onClose}){
  const[data,setData]=useState(null);
  const[scraped,setScraped]=useState(null);
  const[coverUrl,setCoverUrl]=useState(null);
  const[coverBig,setCoverBig]=useState(false);
  useEffect(()=>{
    api.get(`/api/files/${fileId}`).then(r=>{if(r.ok)setData(r.data);});
    api.get(`/api/files/${fileId}/scraped`).then(r=>{if(r.ok&&r.data)setScraped(r.data);});
    // Try loading cover art
    fetch(`/api/files/${fileId}/cover`).then(r=>{if(r.ok)setCoverUrl(`/api/files/${fileId}/cover`);}).catch(()=>{});
  },[fileId]);
  if(!data)return e(Modal,{title:'文件属性',onClose},e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})));
  // Two independent fingerprints: spectral (built-in, for duplicate matching)
  // and Chromaprint via fpcalc (for AcoustID queries). Shown as separate rows.
  const fpMethodLabel={spectral:'已提取',metadata:'未解码，退化为属性匹配'}[data.fingerprint_method]||'未提取';
  const chromaprintLabel=data.chromaprint?'已提取':'未提取（前往设置 → CP 声纹 配置）';
  const mbTier = scraped?.mb?.scrape_tier;
  const aidTier = scraped?.acoustid?.scrape_tier;
  const rows=[['完整路径',data.path,true],['标题',data.title||'—'],['艺术家',data.artist||'—'],['专辑',data.album||'—'],['年份',data.album_year||'—'],['音轨',data.track_number||'—'],['流派',data.genre||'—'],['格式',data.format||'—'],['比特率',data.bitrate?data.bitrate+'k':'—'],['采样率',data.sample_rate?(data.sample_rate/1000).toFixed(1)+' kHz':'—'],['位深',data.bits_per_sample?data.bits_per_sample+' bit':'—'],['时长',fmtDur(data.duration)],['文件大小',fmtBytes(data.size)],['创建时间',fmtDate(data.file_ctime)],['修改时间',fmtDate(data.file_mtime)],['频谱声纹',fpMethodLabel],['CP 声纹',chromaprintLabel]];
  return e(Modal,{title:'文件属性',onClose,width:560},
    // Cover art row
    coverUrl&&e('div',{style:{display:'flex',justifyContent:'center',marginBottom:12}},
      e('img',{src:coverUrl,onClick:()=>setCoverBig(true),
        style:{width:90,height:90,objectFit:'cover',borderRadius:'var(--r-md)',cursor:'pointer',
          border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-sm)'},
        title:'点击放大'})
    ),
    // Cover art lightbox
    coverBig&&e('div',{onClick:()=>setCoverBig(false),
      style:{position:'fixed',inset:0,background:'rgba(0,0,0,0.82)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},
      e('img',{src:coverUrl,style:{maxWidth:'min(600px,90vw)',maxHeight:'80vh',borderRadius:'var(--r-lg)',objectFit:'contain'},
        onClick:e=>e.stopPropagation()})
    ),
    rows.map(([k,v,mono])=>e('div',{key:k,style:{display:'flex',gap:12,padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
      e('div',{style:{fontSize:11,color:'var(--tx-faint)',width:72,flexShrink:0,paddingTop:1}},k),
      e('div',{style:{fontSize:12,color:'var(--tx-primary)',fontFamily:mono?'var(--font-mono)':undefined,wordBreak:'break-all',flex:1}},String(v))
    )),
    // Dual-source scrape data sections
    (scraped?.mb?.title||scraped?.acoustid?.title)&&e('div',{style:{marginTop:12}},
      scraped.mb?.title&&e('div',{style:{marginBottom:8,padding:'10px 14px',background:'#F5F3FF',border:'0.5px solid #DDD6FE',borderRadius:'var(--r-md)'}},
        e('div',{style:{fontSize:11,fontWeight:600,color:'#5B21B6',marginBottom:6,display:'flex',alignItems:'center',gap:5}},
          Icon('cloud-check',{fontSize:13}),'刮削数据 · MusicBrainz',
              mbTier==='yellow'&&e('span',{style:{fontSize:9,color:'#7C3AED',fontWeight:400,marginLeft:4}},'(模糊匹配)'),
              mbTier==='green'&&e('span',{style:{fontSize:9,color:'#7C3AED',fontWeight:400,marginLeft:4}},'(精确匹配)'),
              mbTier==='blue'&&e('span',{style:{fontSize:9,color:'#7C3AED',fontWeight:400,marginLeft:4}},'(精确匹配 · 可写入)'),
          scraped.mb.confidence>0&&scraped.mb.confidence<0.85&&e('span',{style:{color:'#7C3AED',fontWeight:400,fontSize:9}},` 匹配度 ${(scraped.mb.confidence*100).toFixed(0)}%`)
        ),
        [['标题',scraped.mb.title],['艺术家',scraped.mb.artist],['专辑',scraped.mb.album],['年份',scraped.mb.album_year||'']].map(([k,v])=>v?e('div',{key:k,style:{fontSize:11,color:'#5B21B6',display:'flex',gap:8}},e('span',{style:{color:'#7C3AED',width:36}},k+':'),v):null)
      ),
      scraped.acoustid?.title&&e('div',{style:{padding:'10px 14px',background:'#ECFEFF',border:'0.5px solid #A5F3FC',borderRadius:'var(--r-md)'}},
        e('div',{style:{fontSize:11,fontWeight:600,color:'#0E7490',marginBottom:6,display:'flex',alignItems:'center',gap:5}},
          Icon('wave-sine',{fontSize:13}),'刮削数据 · AcoustID',
          aidTier==='yellow'&&e('span',{style:{fontSize:9,color:'#0891B2',fontWeight:400,marginLeft:4}},'(模糊匹配)'),
          aidTier==='green'&&e('span',{style:{fontSize:9,color:'#0891B2',fontWeight:400,marginLeft:4}},'(精确匹配)'),
          aidTier==='blue'&&e('span',{style:{fontSize:9,color:'#0891B2',fontWeight:400,marginLeft:4}},'(精确匹配 · 可写入)'),
          scraped.acoustid.confidence>0&&scraped.acoustid.confidence<0.85&&e('span',{style:{color:'#0891B2',fontWeight:400,fontSize:9}},` 匹配度 ${(scraped.acoustid.confidence*100).toFixed(0)}%`)
        ),
        [['标题',scraped.acoustid.title],['艺术家',scraped.acoustid.artist],['专辑',scraped.acoustid.album],['年份',scraped.acoustid.album_year||'']].map(([k,v])=>v?e('div',{key:k,style:{fontSize:11,color:'#0E7490',display:'flex',gap:8}},e('span',{style:{color:'#0891B2',width:36}},k+':'),v):null)
      )
    ),
    e('div',{style:{marginTop:14,display:'flex',gap:8,flexWrap:'wrap',justifyContent:'flex-start',alignItems:'center'}},
      e(Btn,{icon:'folder-open',small:true,variant:'ghost',onClick:()=>api.post(`/api/files/${fileId}/reveal`)},'在文件管理器中显示'),
      e(Btn,{small:true,variant:'ghost',icon:'copy',onClick:()=>navigator.clipboard?.writeText(data.path)},'复制路径')
    )
  );
}

// ── Shared scan-directory editor — used both in LibraryView's empty state
// (so a brand-new user can get going without hunting for Settings) and in
// Settings → 扫描目录. Both call the SAME onAddDir/onRemoveDir handlers
// (owned by App), so the directory list is always one shared piece of data,
// not two copies that can drift — and adding a dir here kicks off a scan
// immediately, since that's obviously what someone wants right after typing
// a path in.
// ScanDirsEditor — item 7: manual path + browse-button on ONE row; blur or
// Enter on the manual field saves immediately (no separate Add button for the
// text). Browse button sits inside the right end of the same line. After any
// dir change the default action is only an enumeration pass (no meta/fp/scrape)
// so the library stays fast to update; a separate "执行" shortcut lets the
// user trigger a fuller scan without going to the 扫描 page.
function ScanDirsEditor({dirs=[],onAddDir,onRemoveDir,onEnumOnly,compact}){
  const[newDir,setNewDir]=useState('');
  const[browsing,setBrowsing]=useState(false);
  const[err,setErr]=useState('');
  const[removeIdx,setRemoveIdx]=useState(null);
  function commit(){if(!newDir.trim())return;onAddDir(newDir.trim());setNewDir('');}
  async function browse(){
    setErr('');setBrowsing(true);
    try{
      const r=await api.post('/api/browse-folder');
      if(r.ok&&r.path)onAddDir(r.path);
      else if(!r.ok)setErr('未能打开系统文件夹选择器');
    }catch{ setErr('未能打开系统文件夹选择器'); }
    finally{ setBrowsing(false); }
  }
  const inputStyle={flex:1,fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',fontFamily:'var(--font-mono)',outline:'none',borderRight:'none',borderTopRightRadius:0,borderBottomRightRadius:0};
  const browseStyle={padding:'6px 12px',background:'var(--bg-muted)',border:'0.5px solid var(--bd-default)',borderLeft:'none',borderRadius:0,borderTopRightRadius:'var(--r-md)',borderBottomRightRadius:'var(--r-md)',cursor:browsing?'wait':'pointer',fontSize:11,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4,flexShrink:0};
  return e('div',null,
    dirs.length===0&&e('div',{style:{color:'var(--tx-faint)',fontSize:12,padding:'4px 0 8px',display:'flex',gap:5,alignItems:'center'}},Icon('info-circle',{}),'暂未配置音乐目录'),
    dirs.map((d,i)=>e('div',{key:i,style:{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)',marginBottom:6}},
      Icon('folder-filled',{fontSize:13,color:'var(--amber)',flexShrink:0}),
      e('span',{title:d,style:{flex:1,fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},d),
      e('button',{onClick:()=>setRemoveIdx(i),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:'2px 4px',borderRadius:'var(--r-sm)'}},Icon('x',{fontSize:13}))
    )),
    e('div',{style:{display:'flex',borderRadius:'var(--r-md)',overflow:'hidden',marginBottom:6}},
      e('input',{value:newDir,onChange:ev=>setNewDir(ev.target.value),
        onKeyDown:ev=>ev.key==='Enter'&&commit(),
        onBlur:commit,
        placeholder:'/Volumes/Music 或 D:\\Music',style:inputStyle}),
      e('button',{onClick:browse,disabled:browsing,style:browseStyle},
        Icon(browsing?'loader':'folder-open',{fontSize:12,color:'var(--tx-muted)'},browsing?'spin':undefined),'选择文件夹')
    ),
    err&&e('div',{style:{fontSize:11,color:'var(--red)',marginBottom:6}},err),
    removeIdx!==null&&e(ConfirmModal,{
      title:'移除音乐目录',
      message:e('span',null,'确认移除该目录？\n\n',e('b',null,dirs[removeIdx])),
      onConfirm:()=>onRemoveDir(removeIdx),
      onClose:()=>setRemoveIdx(null),
      danger:true,
    }),
    onEnumOnly&&e('div',{style:{display:'none'}}) // button removed — caller decides when to show banner
  );
}

/* ══════════════════════════════════════════════════════════════════════
   LIBRARY VIEW
   ══════════════════════════════════════════════════════════════════════ */
const LibraryView=React.memo(function LibraryView({player,dirs,onAddDir,onRemoveDir,onEnumOnly,onLocate,mainScrollRef,libraryKey,onRetentionChange,onTagsWritten}){
  // ── Filter state ───────────────────────────────────────────────────────
  // 'all' | 'scraped' | 'dup'  — the 3 interactive stat cards
  const[libFilter,setLibFilter]=useState('all');
  const[stats,setStats]=useState(null);         // from /api/library/stats
  const[rows,setRows]=useState([]);
  const[total,setTotal]=useState(0);
  const[search,setSearch]=useState('');
  const[sort,setSort]=useState('title');
  const[order,setOrder]=useState('asc');
  const[fmt,setFmt]=useState('');
  const[scrapeFilter,setScrapeFilter]=useState(''); // '' | green|blue|yellow|none
  const[loading,setLoading]=useState(false);
  const[propsId,setPropsId]=useState(null);
  const[toast,setToast]=useState(null);
  // Smart-fill state for 刮削 filter view
  const[scrapeTarget,setScrapeTarget]=useState(null); // file id for ScrapeDialog
  // Virtual / infinite-scroll state
  const PAGE=80;
  const[page,setPage]=useState(1);
  const[hasMore,setHasMore]=useState(false);
  const[loadingMore,setLoadingMore]=useState(false);
  // Scroll position memory — persists across tab switches
  // We DON'T own the scroll container — the <main> element in App does.
  // mainScrollRef is passed down from App so we can listen and save/restore position.
  const savedScrollTop=useRef(0);
  const scrollSentinelRef=useRef(null); // bottom sentinel for infinite scroll
  const searchTimer=useRef(null);
  // locate() resets filters so the target is visible, triggering a re-fetch.
  // Suppress the auto-loadFresh effect that would race with locate's own fetch.
  const suppressAutoLoad=useRef(false);
  // Per-row locator: the library renders rows with data-fileid attr so
  // the player's "locate" click can scrollIntoView the right row.
  const rowRefs=useRef({});

  function loadStats(){
    api.get('/api/library/stats').then(r=>{if(r.ok)setStats(r.data);});
  }
  useEffect(()=>{loadStats();},[]);

  function buildUrl(p,s,st,o,f,lf,sf=scrapeFilter,lim=PAGE){
    return `/api/library?page=${p}&limit=${lim}&search=${encodeURIComponent(s)}&sort=${st}&order=${o}&format=${f}&libFilter=${lf}&scrapeTier=${sf}`;
  }

  function loadFresh(s=search,st=sort,o=order,f=fmt,lf=libFilter,sf=scrapeFilter){
    setLoading(true);setRows([]);setPage(1);setHasMore(false);    api.get(buildUrl(1,s,st,o,f,lf,sf)).then(r=>{
      if(!r.ok)return;
      const d=r.data;
      setRows(d.rows||[]);setTotal(d.total||0);
      setHasMore((d.rows||[]).length<(d.total||0));
    }).finally(()=>{setLoading(false);loadStats();});
  }
  useEffect(()=>{
    if(suppressAutoLoad.current){ suppressAutoLoad.current=false; return; }
    loadFresh();
  },[sort,order,fmt,libFilter,scrapeFilter]);
  // Reload library when a scan completes (libraryKey increments from App)
  useEffect(()=>{
    if(libraryKey>0) loadFresh();
  },[libraryKey]);

  function loadMore(){
    if(loadingMore||!hasMore)return;
    const nextPage=page+1;
    setLoadingMore(true);
    api.get(buildUrl(nextPage,search,sort,order,fmt,libFilter)).then(r=>{
      if(!r.ok)return;
      const d=r.data;
      setRows(prev=>[...prev,...(d.rows||[])]);
      setHasMore(rows.length+(d.rows||[]).length<(d.total||0));
      setPage(nextPage);
    }).finally(()=>setLoadingMore(false));
  }

  function onSearch(v){
    setSearch(v);clearTimeout(searchTimer.current);
    searchTimer.current=setTimeout(()=>loadFresh(v),400);
  }
  function toggleSort(col){
    const newOrder=sort===col&&order==='asc'?'desc':'asc';
    setSort(col);setOrder(newOrder);
  }
  const SortIcon=({col})=>sort===col?e('i',{className:`ti ti-arrow-${order==='asc'?'up':'down'}`,style:{fontSize:11,marginLeft:3}}):null;

  // Save/restore scroll position when tab becomes visible/hidden
  useEffect(()=>{
    const el=mainScrollRef?.current;
    if(!el)return;
    // Restore on mount
    el.scrollTop=savedScrollTop.current;
    return()=>{ savedScrollTop.current=el?.scrollTop||0; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // Infinite scroll + scrolledToBottom via IntersectionObserver on a
  // sentinel div at the bottom of the list. This works correctly regardless
  // of which ancestor element actually scrolls — avoids the "wrong container"
  // bug where attaching to containerRef had no effect because the element
  // didn't scroll itself (the <main> parent did).
  useEffect(()=>{
    const sentinel=scrollSentinelRef.current;
    if(!sentinel)return;
    const obs=new IntersectionObserver(entries=>{
      const e=entries[0];
      if(e.isIntersecting){
                if(!loadingMore&&hasMore)loadMore();
      } else {
              }
    },{root:mainScrollRef?.current||null,rootMargin:'200px',threshold:0});
    obs.observe(sentinel);
    return()=>obs.disconnect();
  // loadMore is recreated on every render; use its stable deps instead
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[loadingMore,hasMore,rows.length,search,sort,order,fmt,libFilter,scrapeFilter,mainScrollRef]);

  // Also track scroll direction for "show header" behaviour.
  // Show header when scrolled to top or scrolling up; collapse when scrolling down.
  const[headerVisible,setHeaderVisible]=useState(true);
  const lastScrollY=useRef(0);
  useEffect(()=>{
    const el=mainScrollRef?.current;
    if(!el)return;
    function onScroll(){
      const y=el.scrollTop;
      if(y<80||y<lastScrollY.current-10) setHeaderVisible(true);
      else if(y>lastScrollY.current+10) setHeaderVisible(false);
      lastScrollY.current=y;
    }
    el.addEventListener('scroll',onScroll,{passive:true});
    return()=>el.removeEventListener('scroll',onScroll);
  },[mainScrollRef]);

  // Locate-in-library: briefly highlights the target row after scrolling to it.
  const[flashId,setFlashId]=useState(null);
  useEffect(()=>{
    if(!flashId)return;
    const t=setTimeout(()=>setFlashId(null),3200);
    return()=>clearTimeout(t);
  },[flashId]);
  function scrollToRow(fid){
    const el=rowRefs.current[fid];
    // Defense in depth: the ref-cleanup fix above should mean a stale/
    // detached entry can no longer linger here, but if one ever does,
    // treat it the same as "not found" instead of silently no-op'ing a
    // scrollIntoView on a node that's no longer in the document (which
    // looks IDENTICAL to success from here — no error, just nothing visibly
    // happens — and was the actual root cause of "定位在换过排序/筛选后就
    // 再也不管用了").
    if(!el||!el.isConnected){ delete rowRefs.current[fid]; return false; }
    el.scrollIntoView({behavior:'smooth',block:'center'});
    setFlashId(fid);
    return true;
  }
  function scrollToRowRetry(fid,attempts=15){
    if(scrollToRow(fid)||attempts<=0)return;
    setTimeout(()=>scrollToRowRetry(fid,attempts-1),120);
  }

  // Expose locate function upward — used by the player bar's "定位到歌曲"
  // click and by 设置 → 保留名单/最近写入 → "在音乐库中查看".
  // Locate a file in library: if not on current page, ask server for its
  // position in the unfiltered library, reset filters, and fetch to its page.
  useEffect(()=>{
    if(!onLocate)return;
    onLocate.setLocateInLibrary?.(async fid=>{
      if(scrollToRow(fid))return;
      try{
        const loc=await api.get(`/api/library/locate/${fid}?sort=${sort}&order=${order}`);
        if(!loc.ok||loc.index<0)return;
        const targetPage=Math.floor(loc.index/PAGE)+1;
        suppressAutoLoad.current=true;
        // Safety net: if search/fmt/libFilter/scrapeFilter were already at
        // their defaults, the setState calls below are no-ops and the
        // auto-load effect never re-fires to consume+reset the flag above —
        // which would otherwise leave it stuck "true" and wrongly suppress
        // the NEXT legitimate filter change the user makes.
        setTimeout(()=>{suppressAutoLoad.current=false;},50);
        setSearch('');setFmt('');setLibFilter('all');setScrapeFilter('');
        setLoading(true);
        const r=await api.get(buildUrl(1,'',sort,order,'','all','',targetPage*PAGE));
        setLoading(false);
        if(!r.ok)return;
        const d=r.data;
        setRows(d.rows||[]);setTotal(d.total||0);setPage(targetPage);
        setHasMore((d.rows||[]).length<(d.total||0));
        scrollToRowRetry(fid,40);
      }catch{}
    });
  },[onLocate,sort,order]);

  // ── Library empty state ────────────────────────────────────────────────
  if(!loading&&total===0&&(!search&&!fmt&&libFilter==='all')&&stats&&(stats.total||0)===0){
    return e('div',{className:'fade',style:{maxWidth:480,margin:'40px auto'}},
      toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
      e('div',{style:{textAlign:'center',marginBottom:18}},
        Icon('music-off',{fontSize:38,color:'var(--tx-faint)'}),
        e('div',{style:{fontSize:15,fontWeight:600,color:'var(--tx-primary)',marginTop:10}},'音乐库还是空的'),
        e('div',{style:{fontSize:12,color:'var(--tx-faint)',marginTop:4}},'添加一个目录，立即开始扫描')
      ),
      e(Card,null,e(ScanDirsEditor,{dirs,onAddDir,onRemoveDir,onEnumOnly,compact:true}))
    );
  }

  // ── Stats helpers ──────────────────────────────────────────────────────
  const s=stats||{};
  // Per-filter derived stats to display in the active card
  const filterStats={
    all:   {count:s.total||0,   albums:s.albums||0,   artists:s.artists||0,   bytes:s.totalBytes||0},
    scraped:{count:s.scraped||0, albums:s.scrapedAlbums||0, artists:s.scrapedArtists||0, bytes:null},
    dup:   {count:s.dupFiles||0, albums:s.dupAlbums||0,   artists:s.dupArtists||0,   bytes:s.dupTotalBytes||0},
  };

  // ── Interactive filter cards ────────────────────────────────────────────
  function FilterCard({id,label,icon,count,sub1,sub2,active,onClick}){
    return e('button',{onClick,style:{
      flex:1,minWidth:140,padding:'14px 16px',borderRadius:'var(--r-lg)',textAlign:'left',
      background:active?'var(--amber-bg)':'var(--bg-base)',
      border:`1px solid ${active?'var(--amber)':'var(--bd-default)'}`,
      cursor:'pointer',transition:'all .15s',boxShadow:active?'0 0 0 2px rgba(217,119,6,.15)':'var(--sh-xs)',
    }},
      e('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
        e('div',{style:{width:32,height:32,borderRadius:'var(--r-md)',background:active?'var(--amber)':'var(--bg-muted)',
          display:'flex',alignItems:'center',justifyContent:'center',transition:'background .15s'}},
          Icon(icon,{fontSize:15,color:active?'#fff':'var(--tx-faint)'})
        ),
        e('span',{style:{fontSize:12,fontWeight:600,color:active?'#92400E':'var(--tx-secondary)'}},' '+label)
      ),
      e('div',{style:{fontSize:22,fontWeight:700,fontFamily:'var(--font-mono)',color:active?'var(--amber)':'var(--tx-primary)',letterSpacing:'-.02em',lineHeight:1}},
        count===null?'—':(count||0).toLocaleString()),
      e('div',{style:{fontSize:10,color:'var(--tx-faint)',marginTop:5,lineHeight:1.6}},sub1||''),
      sub2&&e('div',{style:{fontSize:10,color:'var(--tx-faint)',lineHeight:1.6}},sub2||'')
    );
  }

  return e('div',{className:'fade'},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    scrapeTarget&&e(ScrapeDialog,{fileId:scrapeTarget,onClose:()=>setScrapeTarget(null),onUpdated:()=>{loadFresh();loadStats();onTagsWritten?.();}}),
    propsId&&e(PropsModal,{fileId:propsId,onClose:()=>setPropsId(null)}),


    // ── Sticky header: filter cards + search — collapses on scroll down, reveals on scroll up
    e('div',{style:{position:'sticky',top:0,zIndex:5,background:'var(--bg-subtle)',paddingBottom:10,marginBottom:0,transition:'opacity .2s,transform .2s',opacity:headerVisible?1:0,transform:headerVisible?'translateY(0)':'translateY(-8px)',pointerEvents:headerVisible?'auto':'none'}},

      // Filter cards row
      e('div',{style:{display:'flex',gap:8,marginBottom:10,flexWrap:'wrap'}},
        e(FilterCard,{id:'all',label:'全部曲目',icon:'music',active:libFilter==='all',onClick:()=>setLibFilter('all'),
          count:s.total,
          sub1:`专辑 ${(s.albums||0).toLocaleString()} · 艺术家 ${(s.artists||0).toLocaleString()}`,
          sub2:fmtBytes(s.totalBytes)}),
        e(FilterCard,{id:'scraped',label:'已刮削',icon:'cloud-download',active:libFilter==='scraped',onClick:()=>setLibFilter('scraped'),
          count:s.scraped,
          sub1:`专辑 ${(s.scrapedAlbums||0).toLocaleString()} · 艺术家 ${(s.scrapedArtists||0).toLocaleString()}`,
          sub2:`占全库 ${s.total?Math.round((s.scraped||0)/s.total*100):0}%`}),
        e(FilterCard,{id:'dup',label:'重复曲目',icon:'copy',active:libFilter==='dup',onClick:()=>setLibFilter('dup'),
          count:s.dupFiles,
          sub1:`重复组 ${(s.dupGroups||0).toLocaleString()} 个`,
          sub2:`占用 ${fmtBytes(s.dupTotalBytes||0)}`}),
      ),

      // Search + format filter
      e('div',{style:{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}},
        e('div',{style:{position:'relative',flex:1,minWidth:200}},
          Icon('search',{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',fontSize:14,color:'var(--tx-faint)',pointerEvents:'none'}),
          e('input',{value:search,onChange:ev=>onSearch(ev.target.value),placeholder:'搜索标题、艺术家、专辑...',
            style:{width:'100%',paddingLeft:32,paddingRight:10,paddingTop:7,paddingBottom:7,
              borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',
              boxShadow:'var(--sh-xs)',outline:'none',fontSize:12}})
        ),
        e('select',{value:fmt,onChange:ev=>{setFmt(ev.target.value);},
          style:{fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',
            color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',width:104}},
          e('option',{value:''},'全部格式'),
          ...['FLAC','MP3','M4A','OGG','WAV','AIFF'].map(f=>e('option',{key:f,value:f},f))
        ),
        // 刮削分类筛选 — same tier vocabulary as the 刮削 column icon/tooltip.
        // Same width/padding/neutral color as the 格式 dropdown right next to
        // it (previously it auto-sized wider from its longer option text and
        // changed color per selection, which read as a different control
        // style rather than a matching pair).
        e('select',{value:scrapeFilter,onChange:ev=>setScrapeFilter(ev.target.value),
          style:{fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',
            color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',width:112}},
          e('option',{value:''},'全部刮削'),
          e('option',{value:'green'},TIER_LABEL.green),
          e('option',{value:'blue'},TIER_LABEL.blue),
          e('option',{value:'yellow'},TIER_LABEL.yellow),
          e('option',{value:'none'},'未刮削')
        ),
        e('span',{style:{fontSize:11,color:'var(--tx-faint)',whiteSpace:'nowrap'}},`显示 ${rows.length} / ${total.toLocaleString()} 首`)
      )
    ),



    // ── Table ─────────────────────────────────────────────────────────────
    e('div',{style:{borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)',background:'var(--bg-base)',marginTop:0}},
      loading&&rows.length===0
        ?e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}}))
        :total===0
          ?e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)',lineHeight:2}},
            Icon('music-off',{fontSize:32,display:'block',margin:'0 auto 8px'}),'未找到匹配的曲目')
          :e('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:12}},
            e('thead',null,e('tr',{style:{borderBottom:'0.5px solid var(--bd-default)',background:'var(--bg-subtle)',position:'sticky',top:0,zIndex:2}},
              ...[['','36px'],['标题',''],['艺术家','18%'],['专辑','16%'],['格式','72px'],['刮削','48px'],['时长','56px'],['大小','64px'],['操作','108px']].map(([h,w])=>
                e('th',{key:h,
                  onClick:['标题','艺术家','专辑','格式','时长','大小','刮削'].includes(h)?()=>toggleSort({标题:'title',艺术家:'artist',专辑:'album',格式:'format',时长:'duration',大小:'size',刮削:'scrape_tier'}[h]):undefined,
                  style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',
                    width:w||undefined,cursor:['标题','艺术家','专辑','格式','时长','大小','刮削'].includes(h)?'pointer':undefined,userSelect:'none',whiteSpace:'nowrap'}},
                  h,['标题','艺术家','专辑','格式','时长','大小','刮削'].includes(h)&&e(SortIcon,{col:{标题:'title',艺术家:'artist',专辑:'album',格式:'format',时长:'duration',大小:'size',刮削:'scrape_tier'}[h]})
                )
              )
            )),
            e('tbody',null,rows.map((f,idx)=>{
              const isCur=player.current?.id===f.id;
              const playableQueue=rows.filter(r=>r.fingerprint).map(r=>({id:r.id,title:r.title,artist:r.artist,src:'library',rowIdx:idx}));
              return e('tr',{
                key:f.id,
                ref:el=>{if(el)rowRefs.current[f.id]=el;else delete rowRefs.current[f.id];},
                'data-fileid':f.id,
                className:f.id===flashId?'locate-flash':undefined,
                style:{borderBottom:'0.5px solid var(--bd-subtle)',
                  background:f.in_retention_list?'var(--bg-muted)':isCur?'var(--amber-bg)':'transparent',
                  transition:'background .1s'},
                onMouseEnter:ev=>ev.currentTarget.style.background=isCur?'var(--amber-bg)':f.in_retention_list?'#ECEEF0':'var(--bg-subtle)',
                onMouseLeave:ev=>ev.currentTarget.style.background=f.in_retention_list?'var(--bg-muted)':isCur?'var(--amber-bg)':'transparent',
              },
                e('td',{style:{padding:'6px 8px',width:36}},
                  f.fingerprint&&e('button',{
                    onClick:()=>player.playTrack({id:f.id,title:f.title,artist:f.artist,src:'library',rowIdx:idx},playableQueue),
                    style:{background:isCur?'var(--amber)':'var(--bg-muted)',border:'none',borderRadius:'50%',width:24,height:24,
                      display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},
                    Icon(isCur&&player.playing?'pause':'play',{fontSize:15,color:isCur?'#fff':'var(--tx-muted)'}))
                ),
                e('td',{style:{padding:'6px 10px',maxWidth:0,overflow:'hidden'}},
                  e('div',{style:{display:'flex',alignItems:'center',gap:5,overflow:'hidden'}},
                    e('span',{style:{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:500,color:'var(--tx-primary)',flex:'1 1 0'}},f.title||'—')
                  )
                ),
                e('td',{style:{padding:'6px 10px',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:0}},f.artist||'—'),
                e('td',{style:{padding:'6px 10px',color:'var(--tx-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:0,fontSize:11}},f.album||'—'),
                e('td',{style:{padding:'6px 10px'}},e(QBadge,{format:f.format,bitrate:f.bitrate,sample_rate:f.sample_rate})),
                e('td',{style:{padding:'4px 6px',textAlign:'center'}},
                  (()=>{
                    const tier=f.scrape_tier;
                    if(!tier)return null;
                    const sources=[];
                    if(f.aid_title||f.mb_title){
                      if(f.aid_title){ sources.push('AcoustID'); }
                      if(f.mb_title){ sources.push('MusicBrainz'); }
                    }
                    const tipLines=[
                      `刮削 · ${sources.join(' + ')||'未知'} · ${TIER_LABEL[tier]||tier}`,
                      f.aid_title&&`[AcoustID] 标题: ${f.aid_title}`,
                      f.aid_artist&&`[AcoustID] 艺术家: ${f.aid_artist}`,
                      f.aid_album&&`[AcoustID] 专辑: ${f.aid_album}`,
                      f.aid_album_year>0&&`[AcoustID] 年份: ${f.aid_album_year}`,
                      f.mb_title&&`[MusicBrainz] 标题: ${f.mb_title}`,
                      f.mb_artist&&`[MusicBrainz] 艺术家: ${f.mb_artist}`,
                      f.mb_album&&`[MusicBrainz] 专辑: ${f.mb_album}`,
                      f.mb_album_year>0&&`[MusicBrainz] 年份: ${f.mb_album_year}`,
                    ].filter(Boolean).join('\n');
                    return e(InstantTooltip,{tip:tipLines},
                      e('button',{onClick:()=>setScrapeTarget(f.id),style:{background:'none',border:'none',cursor:'pointer',display:'inline-flex',padding:2}},
                        Icon('cloud-check',{fontSize:15,color:TIER_COLOR[tier]})
                      )
                    );
                  })()
                ),
                e('td',{style:{padding:'6px 10px',color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:11,whiteSpace:'nowrap'}},fmtDur(f.duration)),
                e('td',{style:{padding:'6px 10px',color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:11,whiteSpace:'nowrap'}},fmtBytes(f.size)),
                e('td',{style:{padding:'4px 8px'}},
                  e('div',{style:{display:'flex',gap:4}},
                    e(IconAction,{icon:'cloud-download',title:'刮削操作',onClick:()=>setScrapeTarget(f.id)}),
                    e(IconAction,{icon:'folder-open',title:'在文件管理器中显示',onClick:()=>api.post(`/api/files/${f.id}/reveal`)}),
                    e(IconAction,{icon:'info-circle',title:'查看属性',onClick:()=>setPropsId(f.id)})
                  )
                )
              );
            }))
          )
    ),

    // Infinite-scroll bottom sentinel — IntersectionObserver watches this
    e('div',{ref:scrollSentinelRef,style:{height:1}}),
    loadingMore&&e('div',{style:{textAlign:'center',padding:'14px 0',color:'var(--tx-faint)',fontSize:11}},
      e('i',{className:'ti ti-loader spin',style:{fontSize:14,marginRight:6}}),'加载更多...'
    )
  );
});

/* ═══════════════════════════════════════════════════════════════════════
   SCANNER VIEW — F5: simplified to 3 auto lanes (basic/fp/scrape), each
   bundles its own prerequisites (enum/meta) and always finishes with a
   global match — no more standalone "文件枚举" / "相似度匹配" buttons.
   "强制重新执行" is collapsed behind an advanced toggle + confirm dialog.
   `scan` (status/logs/tryStart/...) is owned by App so it survives tab
   switches — see useScanStream().
   ══════════════════════════════════════════════════════════════════════ */
const LANE_META={
  library:{label:'音乐库更新',sub:'',  desc:'依次执行「文件枚举」和「文件属性提取」两个步骤。枚举步骤扫描目录发现音频文件，属性提取步骤读取内嵌标签（标题/艺术家/专辑/时长等），更新本地音乐库索引。',icon:'folders',      steps:['enum','meta']},
  basic:  {label:'基础匹配',  sub:'',  desc:'执行「属性匹配」步骤。按标题分组、结合艺术家与时长容差比对，输出重复候选组，不依赖声纹。',icon:'tag',          steps:['basicMatch']},
  fp:     {label:'声纹匹配',  sub:'',  desc:'依次执行「声纹提取」和「声纹匹配」两个步骤。提取步骤计算音频频谱声纹，匹配步骤比对相似度。不同编码或母带间的相位差异会让分数偏低，因此它不是判定重复的唯一依据。',icon:'wave-sine',     steps:['fp','fpMatch']},
  scrape: {label:'刮削匹配',  sub:'',  desc:'依次执行「刮削」和「刮削匹配」两个步骤。刮削步骤向 MusicBrainz 查询录音信息（可选叠加 AcoustID 声纹识别），匹配步骤比对两个文件是否命中同一条录音以交叉确认。',icon:'cloud-download',steps:['scrape','scrapeMatch']},
};
function ScannerView({scan}){
  const{status,logs,setLogs,confirm,setConfirm,tryStart,startStep}=scan;
  const[runningLane,setRunningLane]=useState(null);
  const[advanced,setAdvanced]=useState({});
  const logRef=useRef(null);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[logs]);
  useEffect(()=>{if(!status.running)setRunningLane(null);},[status.running]);

  function runLane(key,force=false){
    const lm=LANE_META[key];
    if(force){setConfirm({steps:lm.steps,force:true,label:lm.label,lane:key});return;}
    setRunningLane(key);
    startStep(lm.steps,false,lm.label);
  }
  function runAll(force=false){
    const steps=['enum','meta','basicMatch','fp','fpMatch','scrape','scrapeMatch'];
    if(force){setConfirm({steps,force:true,label:'完整扫描',lane:'all'});return;}
    setRunningLane('all');
    startStep(steps,false,'完整扫描');
  }

  const isDone=status.phase==='done';
  const LC={ok:'var(--amber)',done:'var(--green)',err:'var(--red)',info:'var(--tx-secondary)',sep:'var(--amber)'};

  return e('div',{className:'fade'},
    confirm&&e(ConfirmModal,{
      title:'确认强制重新执行',
      message:e('span',null,'将对「',e('b',null,confirm.label),'」执行强制全量重提取，忽略智能跳过逻辑（按修改时间/是否存在判断），所有相关文件会被重新处理，耗时会明显更长。'),
      onConfirm:()=>{setRunningLane(confirm.lane||'all');startStep(confirm.steps,confirm.force,confirm.label);},
      onClose:()=>setConfirm(null),
      danger:true,
    }),

    // 4 lanes — "执行" + "高级" side by side; dropdown on "高级".
    e('div',{style:{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:12}},
      Object.entries(LANE_META).map(([key,lm])=>{
        const isActive=status.running&&(runningLane===key||runningLane==='all');
        return e(Card,{key,style:{border:`0.5px solid ${isActive?'var(--amber)':'var(--bd-default)'}`}},
          e('div',{style:{display:'flex',alignItems:'center',gap:9,marginBottom:10}},
            e('div',{style:{width:32,height:32,borderRadius:8,background:isActive?'var(--amber-bg)':'var(--bg-muted)',border:`1.5px solid ${isActive?'var(--amber)':'var(--bd-default)'}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
              isActive?e('i',{className:'ti ti-loader spin',style:{fontSize:14,color:'var(--amber)'}}):Icon(lm.icon,{fontSize:14,color:'var(--tx-faint)'})
            ),
            e('div',{style:{minWidth:0}},
              e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',display:'flex',alignItems:'center'}},lm.label,e(Hint,{text:lm.desc})),
              lm.sub&&e('div',{style:{fontSize:10,color:'var(--tx-faint)'}},lm.sub)
            )
          ),
          e('div',{style:{position:'relative',marginTop:2,zIndex:advanced[key]?100:'auto'}},
            e('div',{style:{display:'flex',gap:5,alignItems:'center'}},
              e(Btn,{onClick:()=>runLane(key,false),disabled:status.running,icon:'player-play',style:{flex:1,justifyContent:'center'}},'执行'),
              e('button',{
                onClick:()=>setAdvanced(p=>({...p,[key]:!p[key]})),
                title:'高级：全量重新执行（忽略缓存）',
                style:{background:'none',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',padding:'0 8px',height:32,cursor:'pointer',color:advanced[key]?'var(--amber)':'var(--tx-faint)',fontSize:10,display:'flex',alignItems:'center',gap:3,flexShrink:0,whiteSpace:'nowrap'}},
                e('i',{className:`ti ti-chevron-${advanced[key]?'up':'down'}`,style:{fontSize:11}}),'高级'
              )
            ),
            advanced[key]&&e('div',{
              style:{position:'absolute',top:'100%',left:0,right:0,marginTop:4,background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',boxShadow:'var(--sh-md)',padding:6,display:'flex',flexDirection:'column',gap:4}},
              e('button',{onClick:()=>{runLane(key,true);setAdvanced(p=>({...p,[key]:false}));},disabled:status.running,title:'忽略缓存，重新处理全部相关文件',style:{width:'100%',padding:'5px 6px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--bg-muted)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.5:1,display:'flex',alignItems:'center',gap:4,justifyContent:'center'}},Icon('refresh',{fontSize:11}),'全量重新执行'),
              key==='scrape'&&e('button',{onClick:()=>{setRunningLane(key);startStep(lm.steps,false,lm.label,{retryMissed:true});setAdvanced(p=>({...p,[key]:false}));},disabled:status.running,title:'重新尝试之前刮削未命中的文件（含之前无 AcoustID Key 或未装 fpcalc 时跳过的文件），已成功匹配的文件不受影响',style:{width:'100%',padding:'5px 6px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--bg-muted)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.5:1,display:'flex',alignItems:'center',gap:4,justifyContent:'center'}},Icon('refresh',{fontSize:11}),'未命中重新执行')
            )
          )
        );
      })
    ),

    // Transparent backdrop — closes any open advanced dropdown when user
    // clicks/touches/scrolls anywhere outside the button area.
    Object.values(advanced).some(Boolean)&&e('div',{
      onClick:()=>setAdvanced({}),
      onWheel:()=>setAdvanced({}),
      style:{position:'fixed',inset:0,zIndex:99}
    }),

    // Full pipeline control — label left, button group right.  Width
    // calc(25% - 37.5px) exactly equals a single lane card's content
    // width at any viewport, so the "执行" button matches the 4 above.
    e(Card,{style:{marginBottom:12}},
      e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}},
        e('div',{style:{flex:1,minWidth:0}},
          e('div',{style:{fontSize:13,fontWeight:600,display:'flex',alignItems:'center'}},
            e('div',{style:{width:32,height:32,borderRadius:8,background:(status.running&&runningLane==='all')?'var(--amber-bg)':'var(--bg-muted)',border:`1.5px solid ${(status.running&&runningLane==='all')?'var(--amber)':'var(--bd-default)'}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,marginRight:9}},
              (status.running&&runningLane==='all')?e('i',{className:'ti ti-loader spin',style:{fontSize:14,color:'var(--amber)'}}):Icon('radar',{fontSize:14,color:'var(--tx-faint)'})
            ),
            '全部扫描操作',e(Hint,{text:'依次执行全局 8 个步骤：1.文件枚举 → 2.文件属性提取 → 3.属性匹配 → 4.声纹提取 → 5.频谱声纹匹配 → 6.CP声纹匹配 → 7.刮削 → 8.刮削匹配，一次性完成从扫描到重复判定的完整流程。'})),
        ),
        e('div',{style:{width:'calc(25% - 37.5px)',flexShrink:0}},
          e('div',{style:{position:'relative',zIndex:advanced.all?100:'auto'}},
            e('div',{style:{display:'flex',gap:5,alignItems:'center'}},
              e(Btn,{icon:'player-play',onClick:()=>runAll(false),disabled:status.running,style:{flex:1,justifyContent:'center'}},'执行'),
              e('button',{onClick:()=>setAdvanced(p=>({...p,all:!p.all})),title:'全量重新执行（忽略缓存）',style:{background:'none',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',padding:'0 8px',height:32,cursor:'pointer',color:advanced.all?'var(--amber)':'var(--tx-faint)',fontSize:10,display:'flex',alignItems:'center',gap:3,flexShrink:0,whiteSpace:'nowrap'}},e('i',{className:`ti ti-chevron-${advanced.all?'up':'down'}`,style:{fontSize:11}}),'高级')
            ),
            advanced.all&&e('div',{
              style:{position:'absolute',top:'100%',left:0,right:0,marginTop:4,background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',boxShadow:'var(--sh-md)',padding:6,display:'flex',flexDirection:'column',gap:4}},
              e('button',{onClick:()=>{runAll(true);setAdvanced(p=>({...p,all:false}));},disabled:status.running,title:'忽略缓存，重新处理全部相关文件',style:{width:'100%',padding:'5px 6px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--bg-muted)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.5:1,display:'flex',alignItems:'center',gap:4,justifyContent:'center'}},Icon('refresh',{fontSize:11}),'全量重新执行')
            )
          )
        )
      ),
    ),

    // Progress — 暂停/继续/停止 alongside phase/percent/log output
    // (pause/resume/abort are global, not per-lane).
    status.phase!=='idle'&&e('div',{style:{background:'var(--bg-base)',border:`0.5px solid ${status.paused?'var(--amber-bd)':'var(--bd-default)'}`,borderRadius:'var(--r-lg)',padding:'12px 16px',marginBottom:10,boxShadow:'var(--sh-xs)'}},
      e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8,flexWrap:'wrap',gap:8}},
        e('span',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:6}},
          status.paused&&Icon('pause',{fontSize:12,color:'var(--amber)'}),
          status.paused?'已暂停':({idle:'就绪',starting:'准备中',enum:'文件枚举',meta:'文件属性提取',basicMatch:'基础匹配',fp:'声纹提取',fpMatch:'声纹匹配',scrape:'刮削',scrapeMatch:'刮削匹配',done:'完成 ✓',error:'错误',aborted:'已中止'}[status.phase]||status.phase)
        ),
        e('div',{style:{display:'flex',alignItems:'center',gap:10}},
          status.running&&e('div',{style:{display:'flex',gap:6}},
            e(Btn,{small:true,variant:'ghost',icon:status.paused?'player-play':'pause',onClick:()=>(status.paused?scan.resume():scan.pause())},status.paused?'继续':'暂停'),
            e(Btn,{small:true,variant:'danger',icon:'player-stop',onClick:()=>api.post('/api/scan/abort')},'停止')
          ),
          e('span',{style:{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--amber)'}},(status.pct||0)+'%')
        )
      ),
      e('div',{style:{height:5,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},
        e('div',{style:{width:(status.pct||0)+'%',height:'100%',background:status.paused?'var(--tx-faint)':'var(--amber)',borderRadius:99,transition:'width .3s'}}))
    ),

    // Log — progressive, never cleared mid-session
    e('div',{style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',overflow:'hidden',boxShadow:'var(--sh-xs)'}},
      e('div',{style:{padding:'8px 14px',borderBottom:'0.5px solid var(--bd-subtle)',background:'var(--bg-subtle)',display:'flex',alignItems:'center',justifyContent:'space-between'}},
        e('div',{style:{display:'flex',alignItems:'center',gap:6}},Icon('terminal-2',{fontSize:13,color:'var(--tx-faint)'}),e('span',{style:{fontSize:11,fontWeight:500,color:'var(--tx-muted)'}},'运行日志')),
        e('button',{onClick:()=>setLogs([]),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',fontSize:11,display:'flex',alignItems:'center',gap:4}},Icon('trash',{fontSize:12}),'清空')
      ),
      e('div',{ref:logRef,style:{padding:'10px 14px',fontFamily:'var(--font-mono)',fontSize:11.5,lineHeight:1.85,
        height:'calc(100vh - 430px)',minHeight:180,maxHeight:'calc(100vh - 300px)',
        overflowY:'auto'}},
        logs.length===0&&e('span',{style:{color:'var(--tx-faint)'}},'等待开始...'),
        logs.map((l,i)=>e('div',{key:i,style:{color:l.ty==='sep'?'var(--amber)':LC[l.ty]||'var(--tx-secondary)',fontWeight:l.ty==='sep'?600:400}},l.ty==='sep'?l.msg:((m=>{const ts=m[1],txt=m[2];return e('span',null,e('span',{style:{color:'var(--bd-strong)',marginRight:8,userSelect:'none'}},'›'),ts&&e('span',{style:{color:'var(--tx-faint)',marginRight:6,userSelect:'none',fontWeight:400}},ts),e('span',null,txt))})(l.msg.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/)||['',null,l.msg])))),
        status.running&&e('span',{className:'blink',style:{color:'var(--amber)'}},'█')
      )
    )
  );
}

/* ══════════════════════════════════════════════════════════════════════
   DUPLICATES VIEW
   ══════════════════════════════════════════════════════════════════════ */
/* TrackRow — redesigned layout (item 3):
   LEFT  : play button + cover art thumbnail
   MIDDLE: title + quality badge + dimension tags (quality_best/scrape_best/...)
           subtitle line: artist · album | bitrate/size info
           path on hover/truncated
   RIGHT : keep-toggle button (✓ or ✗) + secondary actions
*/
// PICK_TAG_LABEL, PICK_TAG_COLOR are served by /rules-meta.js (source: lib/rules.js)

// RTYPE_LABEL, DIMENSION_COLUMNS are served by /rules-meta.js (source: lib/rules.js)

function DimensionTable({tracks}){
  const[showInfo,setShowInfo]=useState(false);
  if(!tracks||tracks.length<2)return null;
  const mxSize=Math.max(...tracks.map(t=>t.size||1));
  // Estimate rendered pixel width at fontSize 10.5: CJK ~10.5px, Latin/digit ~6px
  const textPx=s=>{let w=0;for(const c of s){w+=/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(c)?10.5:6}return Math.ceil(w)};
  // Header width = icon(~11px) + gap(~2px) + label
  const hdrPx=label=>13+textPx(label);
  // Size column inner: bar(min 100px) + internal gap(6) + widest bytes text
  const sizeInner=Math.max(80+6+Math.max(...tracks.map(t=>textPx(fmtBytes(t.size)))),hdrPx('大小'))+4;
  // Dimension columns inner: max(header, widest cell) + buffer
  const dimInner={};
  DIMENSION_COLUMNS.forEach(c=>{
    const dataPx=Math.max(...tracks.map(t=>textPx(c.cell(t,tracks).text)));
    dimInner[c.key]=Math.max(hdrPx(c.label),dataPx)+4;
  });
  // Convert inner widths → percentages for table-layout:fixed
  const totalInner=sizeInner+Object.values(dimInner).reduce((a,b)=>a+b,0);
  const pct=v=>(v/totalInner*100).toFixed(1)+'%';
  const GAP=10; // right padding = visual gap between columns (no borders)
  const GAP_FIRST=18; // extra gap after size column — bar fills cell, needs clearer separation
  return e('div',{style:{background:'var(--bg-subtle)',borderRadius:'var(--r-md)',padding:'10px 12px',marginBottom:12}},
    e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
      e('div',{style:{fontSize:11,fontWeight:500,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},
        Icon('table-compare',{fontSize:12}),'维度对比'
      ),
      e('button',{
        onClick:()=>setShowInfo(true),
        style:{padding:'3px 10px',borderRadius:99,fontSize:11,cursor:'pointer',border:'0.5px solid var(--bd-default)',background:'var(--bg-base)',color:'var(--tx-muted)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap',flexShrink:0},
      }, Icon('info-circle',{fontSize:12}), '维度说明')
    ),
    e('div',{style:{overflowX:'auto'}},
      e('table',{style:{borderCollapse:'collapse',tableLayout:'fixed',width:'100%',fontSize:10.5}},
        e('thead',null,e('tr',null,
          e('th',{style:{textAlign:'left',padding:'2px '+GAP_FIRST+'px 4px 0',color:'var(--tx-faint)',fontWeight:500,whiteSpace:'nowrap',width:pct(sizeInner)}},Icon('ruler',{fontSize:11}),' 大小'),
          ...DIMENSION_COLUMNS.map(c=>e('th',{key:c.key,style:{textAlign:'left',padding:'2px '+GAP+'px 4px 0',color:'var(--tx-faint)',fontWeight:500,whiteSpace:'nowrap',width:pct(dimInner[c.key])}},Icon(c.icon,{fontSize:11}),' ',c.label))
        )),
        e('tbody',null,tracks.map(t=>e('tr',{key:t.id},
          e('td',{style:{padding:'3px '+GAP_FIRST+'px 3px 0',whiteSpace:'nowrap'}},
            e('div',{style:{display:'flex',alignItems:'center',gap:6}},
              e('div',{style:{flex:1,height:6,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden',minWidth:50}},
                e('div',{style:{width:(t.size/mxSize*100).toFixed(1)+'%',height:'100%',background:t._keepWinner?'var(--green)':'var(--red)',opacity:t._keepWinner?.85:.3,borderRadius:99}})
              ),
              e('span',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:t._keepWinner?'var(--green)':'var(--tx-faint)',fontWeight:t._keepWinner?600:400}},fmtBytes(t.size))
            )
          ),
          ...DIMENSION_COLUMNS.map(c=>{
            const{text,ok,muted}=c.cell(t,tracks);
            return e('td',{key:c.key,style:{padding:'3px '+GAP+'px 3px 0',whiteSpace:'nowrap',color:muted?'var(--tx-faint)':ok?'var(--green)':'var(--tx-secondary)',fontWeight:ok?600:400}},text);
          })
        )))
      )
    ),
    showInfo&&e(Modal,{title:'维度说明',width:600,onClose:()=>setShowInfo(false),description:'重复组内每首歌按以下6个维度逐项比较，绿色加粗为该项胜出。维度按优先级从高到低排列，上一级打平时交由下一级裁决，全部打平则全保留，由用户手动选择。'},
      e('div',{style:{fontSize:12,lineHeight:1.8,color:'var(--tx-secondary)'}},
        e('div',{style:{display:'grid',gridTemplateColumns:'minmax(72px,max-content) 1fr',columnGap:12,rowGap:2,marginBottom:10}},
          ...DIMENSION_COLUMNS.map(c=>DIMENSION_INFO[c.key]?e('div',{key:c.key,style:{display:'contents'}},
            e('div',{style:{fontWeight:600,color:'var(--tx-primary)',padding:'5px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},c.label),
            e('div',{style:{fontSize:11,color:'var(--tx-secondary)',lineHeight:1.6,padding:'5px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},DIMENSION_INFO[c.key])
          ):null)
        )
      )
    )
  );
}

function TrackRow({track,onToggle,canToggle,onProps,onScrape,player,queue,isKept}){
  const keep=!!track._keepWinner;

  const wl=!!track.in_retention_list||(track._pickTags||[]).includes('manual_keep');
  // Manual only: kept purely by retention_list, not by smart cascade
  const isManualOnly=keep&&track._winReason==='手动保留';
  const isCur=player?.current?.id===track.id;
  const[coverErr,setCoverErr]=useState(false);
  const bd=wl&&isManualOnly?'var(--bd-default)':keep?'var(--green-bd)':'var(--red-bd)';
  const bg=wl&&isManualOnly?'var(--bg-muted)':keep?'var(--green-bg)':'var(--red-bg)';

  const coverSrc=`/api/files/${track.id}/cover`;

  return e('div',{style:{marginBottom:8,borderRadius:'var(--r-md)',border:`1px solid ${bd}`,background:bg,overflow:'hidden'}},
    e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 12px'}},

      // ── LEFT: play + cover ───────────────────────────────────────────
      e('div',{style:{display:'flex',alignItems:'center',gap:6,flexShrink:0}},
        player&&e('button',{
          onClick:()=>player.playTrack({id:track.id,title:track.title,artist:track.artist,src:queue?.[0]?.src||'duplicates',groupId:queue?.[0]?.groupId},queue),
          title:'试听',
          style:{background:isCur?'var(--amber)':'rgba(0,0,0,.08)',border:'none',borderRadius:'50%',
            width:26,height:26,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',flexShrink:0}},
          Icon(isCur&&player.playing?'pause':'play',{fontSize:16,color:isCur?'#fff':'var(--tx-muted)'})
        ),
        // Cover art thumbnail
        e('div',{style:{width:36,height:36,borderRadius:'var(--r-sm)',overflow:'hidden',flexShrink:0,
          background:'var(--bg-muted)',display:'flex',alignItems:'center',justifyContent:'center'}},
          !coverErr
            ?e('img',{src:coverSrc,alt:'',onError:()=>setCoverErr(true),
                style:{width:'100%',height:'100%',objectFit:'cover'}})
            :Icon('music',{fontSize:16,color:'var(--tx-faint)'})
        )
      ),

      // ── MIDDLE: info ─────────────────────────────────────────────────
      e('div',{style:{flex:1,minWidth:0}},
        e('div',{style:{display:'flex',alignItems:'center',gap:6,marginBottom:3,flexWrap:'wrap'}},
          e('span',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:220}},track.title||'—'),
          e(QBadge,{format:track.format,bitrate:track.bitrate,sample_rate:track.sample_rate}),
          track.release_type==='single'&&e(Tag,{children:'单曲'}),
          (track._pickTags||[]).map(t=>e(Tag,{key:t,children:PICK_TAG_LABEL[t]||t,color:PICK_TAG_COLOR[t]||'var(--tx-faint)'}))
        ),
        e('div',{style:{fontSize:11,color:'var(--tx-secondary)',display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}},
          track.artist&&e('span',null,track.artist),
          track.album&&e('span',{style:{color:'var(--tx-faint)'}},track.album),
          e('span',{style:{color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:10}},fmtBR(track.bitrate,track.format)),
          e('span',{style:{color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:10}},fmtBytes(track.size))
        ),
        e('div',{style:{fontSize:10,color:'var(--tx-faint)',fontFamily:'var(--font-mono)',
          overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginTop:2}},track.path)
      ),

      // ── RIGHT: keep toggle ───────────────────────────────────────────
      e('div',{style:{display:'flex',alignItems:'center',gap:4,flexShrink:0}},
        e(IconAction,{icon:'cloud-download',title:'刮削操作',onClick:onScrape}),
        e(IconAction,{icon:'folder-open',title:'打开所在目录',onClick:()=>api.post(`/api/files/${track.id}/reveal`)}),
        e(IconAction,{icon:'info-circle',title:'文件属性',onClick:onProps}),
        e('button',{
          onClick:canToggle?onToggle:undefined,
          title:canToggle?(keep?'标记为删除':'标记为保留'):'至少保留一个',
          style:{background:keep?'var(--green)':'var(--bg-base)',
            border:'1px solid '+(keep?'var(--green)':'var(--bd-default)'),
            borderRadius:'var(--r-md)',width:32,height:32,
            display:'flex',alignItems:'center',justifyContent:'center',
            cursor:canToggle?'pointer':'default',flexShrink:0,marginLeft:2,
            opacity:(!canToggle)?.4:1},
        }, keep
          ? Icon(isManualOnly?'shield-check':'check',{fontSize:15,color:'#fff'})
          : Icon('toggle-left',{fontSize:15,color:'var(--tx-secondary)'}))
      )
    )
  );
}

// Merge mutually-exclusive tag pairs (EXCLUSIVE_TAG_GROUPS) into a single
// legend row — they never co-occur on the same group, so they share one
// line and one description instead of two near-duplicate entries.
function buildLegendRows(tagArray){
  const shown=new Set(),rows=[];
  for(const tag of tagArray){
    if(shown.has(tag))continue;
    const pair=EXCLUSIVE_TAG_GROUPS.find(g=>g.includes(tag)&&g.every(t=>tagArray.includes(t)));
    const row=pair||[tag];
    row.forEach(t=>shown.add(t));
    rows.push(row);
  }
  return rows;
}

const DuplicatesView=React.memo(function DuplicatesView({setPendingCount,player,scanDoneKey,onLocate,onRetentionChange}){
  const[filter,setFilter]=useState('pending');
  const[sort,setSort]=useState('savings');
  const[groups,setGroups]=useState([]);
  const[tagFilter,setTagFilter]=useState(new Set());
  const[search,setSearch]=useState('');
  const[selId,setSelId]=useState(null);
  const[displayCount,setDisplayCount]=useState(50);
  const scrollSentinelRef=useRef(null);
  // Locate-in-duplicates: briefly highlights the target group after scrolling to it.
  const groupRefs=useRef({});
  const[flashGroupId,setFlashGroupId]=useState(null);
  const[showTagLegend,setShowTagLegend]=useState(false);
  const pendingLocateId=useRef(null);
  useEffect(()=>{
    if(!flashGroupId)return;
    const t=setTimeout(()=>setFlashGroupId(null),3200);
    return()=>clearTimeout(t);
  },[flashGroupId]);
  function scrollToGroup(gid){
    const el=groupRefs.current[gid];
    if(!el||!el.isConnected){ delete groupRefs.current[gid]; return false; }
    el.scrollIntoView({behavior:'smooth',block:'center'});
    setFlashGroupId(gid);
    return true;
  }
  function scrollToGroupRetry(gid,attempts=20){
    if(scrollToGroup(gid)||attempts<=0)return;
    setTimeout(()=>scrollToGroupRetry(gid,attempts-1),120);
  }
  // Clicking a track in the player: switch to duplicates tab, reset filters
  // to show all groups, then scroll to the containing group.
  useEffect(()=>{
    if(!onLocate)return;
    onLocate.setLocateInDuplicates?.(gid=>{
      if(!gid)return;
      setSelId(gid);
      setTagFilter(new Set());
      setSearch('');
      if(filter!=='all'){
        pendingLocateId.current=gid;
        setFilter('all');
      } else {
        scrollToGroupRetry(gid);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[onLocate]);
  // Once a filter-change triggered by locate finishes reloading the list, scroll.
  useEffect(()=>{
    if(!pendingLocateId.current)return;
    if(groups.some(g=>g.id===pendingLocateId.current)){
      const gid=pendingLocateId.current;
      pendingLocateId.current=null;
      scrollToGroupRetry(gid);
    }
  },[groups]);
  const[detail,setDetail]=useState(null);
  const[detailLoading,setDetailLoading]=useState(false);
  const[listLoading,setListLoading]=useState(true);
  const[toast,setToast]=useState(null);
  const[showEmptyTrash,setShowEmptyTrash]=useState(false);
  const[showBatchResolve,setShowBatchResolve]=useState(false);
  const[showBatchUnresolve,setShowBatchUnresolve]=useState(false);
  const[purgeConfirm,setPurgeConfirm]=useState(null); // {id, count} for per-group permanent delete
  const[propsId,setPropsId]=useState(null);
  const[scrapeId,setScrapeId]=useState(null);
  const prevScanDoneKey=useRef(0);

  function loadList(){
    setListLoading(true);
    const q=filter==='all'?'':filter==='pending'?'?resolved=0':'?resolved=1';
    api.get('/api/duplicates'+q+(q?'&':'?')+'_='+Date.now()).then(r=>{
      if(!r.ok)return;
      let list=r.data||[];
      if(sort==='savings')list=[...list].sort((a,b)=>(b.savings_bytes||0)-(a.savings_bytes||0));
      else if(sort==='sim')list=[...list].sort((a,b)=>(b.similarity||0)-(a.similarity||0));
      else list=[...list].sort((a,b)=>(b.track_count||0)-(a.track_count||0));
      setGroups(list);
      if(!selId&&list.length>0)setSelId(list[0].id);
    }).finally(()=>setListLoading(false));
  }
  useEffect(()=>{loadList();},[filter,sort]);
  // Reset display count when filter, search, or tag filter changes
  useEffect(()=>{setDisplayCount(50);},[filter,sort,search,tagFilter]);
  // Infinite scroll for the group list (left panel) — purely client-side
  // windowing over already-fetched groups.
  useEffect(()=>{
    const sentinel=scrollSentinelRef.current;
    if(!sentinel)return;
    const obs=new IntersectionObserver(entries=>{
      if(entries[0].isIntersecting){
        setDisplayCount(prev=>Math.min(prev+50,groups.length));
      }
    },{rootMargin:'300px',threshold:0});
    obs.observe(sentinel);
    return ()=>obs.disconnect();
  },[groups.length]);
  // Reload list whenever a scan completes (scanDoneKey increments from App)
  useEffect(()=>{
    if(scanDoneKey>0&&scanDoneKey!==prevScanDoneKey.current){
      prevScanDoneKey.current=scanDoneKey;
      loadList();
      // A rematch rebuilds all dup_groups rows from scratch — group IDs are
      // not stable across rematches. Close any open detail panel to avoid
      // showing stale data under an old (or now-reassigned) group ID.
      setSelId(null);
      setDetail(null);
    }
  },[scanDoneKey]);
  useEffect(()=>{
    if(!selId)return;
    setDetailLoading(true);
    api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);}).finally(()=>setDetailLoading(false));
  },[selId]);

  const allTags=useMemo(()=>{
    const s=new Set();
    groups.forEach(g=>(g.group_tags||'').split(',').filter(Boolean).forEach(t=>s.add(t)));
    return [...s];
  },[groups]);

  // Both matching-method tags and characteristic tags are filterable —
  // they share the same tagFilter set (two button rows below), combined
  // with AND semantics. See EXCLUSIVE_TAG_GROUPS for how mutually
  // exclusive tags within one row (e.g. format_same vs format_diff) are
  // kept from being selected together, which would otherwise always
  // yield zero results.
  const filterTags=useMemo(()=>{
    const rank=t=>{const i=MATCH_METHOD_TAGS_ARRAY.indexOf(t);return i===-1?99:i;};
    return allTags.filter(t=>MATCH_METHOD_TAGS.has(t)).sort((a,b)=>rank(a)-rank(b));
  },[allTags]);
  const charTags=useMemo(()=>{
    const rank=t=>{const i=CHARACTERISTIC_TAGS_ARRAY.indexOf(t);return i===-1?99:i;};
    return allTags.filter(t=>CHARACTERISTIC_TAGS.has(t)).sort((a,b)=>rank(a)-rank(b));
  },[allTags]);

  const visibleGroups=useMemo(()=>{
    let list=groups;
    if(tagFilter.size){
      list=list.filter(g=>{
        const tags=new Set((g.group_tags||'').split(',').filter(Boolean));
        return[...tagFilter].every(t=>tags.has(t));
      });
    }
    const q=search.trim().toLowerCase();
    if(q){
      list=list.filter(g=>(g.keep_title||'').toLowerCase().includes(q)||(g.keep_artist||'').toLowerCase().includes(q));
    }
    return list;
  },[groups,tagFilter,search]);

  function toggleTagFilter(tag){
    setTagFilter(prev=>{
      const n=new Set(prev);
      if(n.has(tag)){n.delete(tag);return n;}
      const excl=EXCLUSIVE_TAG_GROUPS.find(g=>g.includes(tag));
      if(excl)for(const other of excl)if(other!==tag)n.delete(other);
      n.add(tag);
      return n;
    });
  }

  async function resolve(id){
    const r=await api.post('/api/duplicates/'+id+'/resolve');
    if(r.ok){setToast({msg:`已放入回收站，删除 ${r.deleted?.length||0} 个文件`,type:'success'});loadList();if(detail?.id===id)setDetail(d=>d?{...d,resolved:1}:d);setPendingCount(n=>Math.max(0,(n||1)-1));}
    else setToast({msg:r.error||'操作失败',type:'warn'});
  }
  async function unresolve(id){
    const r=await api.post('/api/duplicates/'+id+'/unresolve');
    if(r.ok){setToast({msg:r.restored?.length?`已恢复 ${r.restored.length} 个文件`:r.failed?.length?'部分文件恢复失败':'已撤销处理',type:'success'});loadList();api.get('/api/duplicates/'+id).then(r2=>{if(r2.ok)setDetail(r2.data);});}
    else setToast({msg:'操作失败: '+(r.error||''),type:'error'});
  }
  async function unresolveAll(){setShowBatchUnresolve(false);const ids=visibleResolved.map(g=>g.id);const r=await api.post('/api/duplicates/unresolve-all',{ids});if(r.ok){setToast({msg:`已恢复 ${r.restoredCount} 个文件，${r.groupsRestored} 组`,type:'success'});loadList();}else setToast({msg:'批量撤销失败',type:'error'});}
  async function resolveAll(){setShowBatchResolve(false);const ids=visiblePending.map(g=>g.id);const r=await api.post('/api/duplicates/resolve-all',{ids});if(r.ok){setToast({msg:`批量完成，放入回收站 ${r.deletedCount} 个文件`,type:'success'});loadList();setPendingCount(0);}else setToast({msg:r.error||'失败',type:'error'});}
  async function emptyTrash(){setShowEmptyTrash(false);const ids=visibleResolved.map(g=>g.id);const r=await api.post('/api/trash/empty',{ids});if(r.ok){setToast({msg:`已永久删除 ${r.deletedCount} 个文件${r.groupsRemoved?`，${r.groupsRemoved} 个组已清理`:''}`,type:'success'});loadList();if(r.groupsRemoved>0)setSelId(null);}else setToast({msg:'清空失败',type:'error'});}
  async function purgeGroup(id){const r=await api.post('/api/duplicates/'+id+'/purge');if(r.ok){setToast({msg:r.groupRemoved?`已彻底删除并清理该组`:`已彻底删除 ${r.deletedCount} 个文件`,type:'success'});loadList();if(r.groupRemoved){setDetail(null);setSelId(null);}}else setToast({msg:'删除失败',type:'error'});}
  async function toggleTrack(gid,fid,keep,reason){const r=await api.put(`/api/duplicates/${gid}/tracks/${fid}/keep`,{keep,reason});if(r.ok){setDetail(r.data);onRetentionChange?.();}}
  // Toggle keep: adds/removes from retention list (manual override).
  function onTrackToggle(groupId,fileId,currentKeep,tracks){
    toggleTrack(groupId,fileId,!currentKeep,!currentKeep?'手动指定保留':'移除手动保留');
  }

  const pending=groups.filter(g=>!g.resolved);
  // BUG FIX: compute savings from the VISIBLE (filtered) pending groups,
  // not from all pending groups — so the count/bytes update when the user
  // applies a tag or search filter (previously showed unfiltered total always).
  const visiblePending=visibleGroups.filter(g=>!g.resolved);
  const visibleResolved=visibleGroups.filter(g=>g.resolved);
  const savings=visiblePending.reduce((a,g)=>a+(g.savings_bytes||0),0);
  const resolvedSavings=visibleResolved.reduce((a,g)=>a+(g.savings_bytes||0),0);

  const GH='calc(100vh - 260px)';

  return e('div',{className:'fade'},
    scrapeId&&e(ScrapeDialog,{fileId:scrapeId,onClose:()=>setScrapeId(null),
      onUpdated:()=>{if(selId){api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);});}},
      onTagsWritten:()=>{}}),
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    showTagLegend&&e(Modal,{title:'重复组标签说明',onClose:()=>setShowTagLegend(false),width:640,description:'可多选，多选为同时满足关系；同一行内的标签互斥，只会出现其一。'},
      e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.8,marginBottom:16}},
        e('div',{style:{fontSize:13,fontWeight:700,color:'var(--tx-primary)',marginBottom:10}},'重复匹配方法'),
        e('div',{style:{display:'grid',gridTemplateColumns:'minmax(96px,max-content) 1fr',columnGap:12,rowGap:2}},
          buildLegendRows(MATCH_METHOD_TAGS_ARRAY).map(row=>
            e('div',{key:row.join('+'),style:{display:'contents'}},
              e('div',{style:{display:'flex',flexWrap:'wrap',gap:4,alignContent:'flex-start',padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
                row.map(tag=>{
                  const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
                  return e('span',{key:tag,style:{fontSize:10,fontWeight:500,color:col,background:bg,border:`0.5px solid ${bd}`,padding:'1px 7px',borderRadius:3,whiteSpace:'nowrap'}},GROUP_TAG_LABELS[tag]||tag);
                })
              ),
              e('div',{style:{fontSize:11,color:'var(--tx-secondary)',lineHeight:1.6,padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},GROUP_TAG_DESCRIPTIONS[row[0]])
            )
          )
        ),
        e('div',{style:{fontSize:13,fontWeight:700,color:'var(--tx-primary)',marginTop:16,marginBottom:10}},'其他组内特征'),
        e('div',{style:{display:'grid',gridTemplateColumns:'minmax(96px,max-content) 1fr',columnGap:12,rowGap:2}},
          buildLegendRows(CHARACTERISTIC_TAGS_ARRAY).map(row=>
            e('div',{key:row.join('+'),style:{display:'contents'}},
              e('div',{style:{display:'flex',flexWrap:'wrap',gap:4,alignContent:'flex-start',padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
                row.map(tag=>{
                  const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
                  return e('span',{key:tag,style:{fontSize:10,fontWeight:500,color:col,background:bg,border:`0.5px solid ${bd}`,padding:'1px 7px',borderRadius:3,whiteSpace:'nowrap'}},GROUP_TAG_LABELS[tag]||tag);
                })
              ),
              e('div',{style:{fontSize:11,color:'var(--tx-secondary)',lineHeight:1.6,padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},GROUP_TAG_DESCRIPTIONS[row[0]])
            )
          )
        )
      )
    ),
    propsId&&e(PropsModal,{fileId:propsId,onClose:()=>setPropsId(null)}),

    // Filter bar: matching-method tags (how the group was discovered)
    e('div',{style:{marginBottom:6,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}},
      e('span',{style:{fontSize:11,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}},Icon('filter',{fontSize:12}),'匹配方法筛选：'),
      filterTags.map(tag=>{
        const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
        const active=tagFilter.has(tag);
        return e('button',{key:tag,onClick:()=>toggleTagFilter(tag),style:{padding:'3px 10px',borderRadius:99,fontSize:11,fontWeight:active?600:400,cursor:'pointer',border:`1px solid ${active?col:bd}`,background:active?bg:'var(--bg-base)',color:active?col:'var(--tx-muted)',transition:'all .12s'}},GROUP_TAG_LABELS[tag]||tag);
      }),
      e('span',{style:{flex:1,minWidth:8}}),
      e('button',{
        onClick:()=>setShowTagLegend(true),
        style:{padding:'3px 10px',borderRadius:99,fontSize:11,cursor:'pointer',border:'0.5px solid var(--bd-default)',background:'var(--bg-base)',color:'var(--tx-muted)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap',flexShrink:0},
      }, Icon('info-circle',{fontSize:12}), '标签说明'),
    ),
    // Second row: characteristic tags (what the group looks like) + clear button
    e('div',{style:{marginBottom:10,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}},
      e('span',{style:{fontSize:11,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}},Icon('tag',{fontSize:12}),'其他组内特征：'),
      charTags.map(tag=>{
        const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
        const active=tagFilter.has(tag);
        return e('button',{key:tag,onClick:()=>toggleTagFilter(tag),style:{padding:'3px 10px',borderRadius:99,fontSize:11,fontWeight:active?600:400,cursor:'pointer',border:`1px solid ${active?col:bd}`,background:active?bg:'var(--bg-base)',color:active?col:'var(--tx-muted)',transition:'all .12s'}},GROUP_TAG_LABELS[tag]||tag);
      }),
      e('span',{style:{flex:1,minWidth:24}}),
      e('button',{
        onClick:()=>setTagFilter(new Set()),
        disabled:tagFilter.size===0,
        style:{
          padding:'4px 12px',borderRadius:'var(--r-md)',fontSize:11,cursor:tagFilter.size>0?'pointer':'default',
          border:'0.5px solid var(--bd-default)',background:tagFilter.size>0?'var(--bg-base)':'transparent',
          color:tagFilter.size>0?'var(--tx-secondary)':'var(--tx-faint)',
          opacity:tagFilter.size>0?1:0.4,whiteSpace:'nowrap',
          display:'flex',alignItems:'center',gap:4,flexShrink:0,
        }
      }, Icon('x',{fontSize:12}), '清除筛选')
    ),

    // Toolbar
    e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8,gap:8,flexWrap:'wrap'}},
      e('div',{style:{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}},
        e('div',{style:{display:'flex',background:'var(--bg-muted)',padding:2,borderRadius:'var(--r-md)',gap:2}},
          ...[['pending','待处理'],['done','已处理'],['all','全部']].map(([f,l])=>
            e('button',{key:f,onClick:()=>{setFilter(f);setSelId(null);},style:{padding:'4px 12px',fontSize:11,fontWeight:filter===f?600:400,cursor:'pointer',borderRadius:'var(--r-sm)',background:filter===f?'var(--bg-base)':'transparent',color:filter===f?'var(--tx-primary)':'var(--tx-muted)',border:'none',boxShadow:filter===f?'var(--sh-xs)':'none',transition:'all .15s'}},l))
        ),
        e('select',{value:sort,onChange:ev=>setSort(ev.target.value),style:{fontSize:11,padding:'5px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'}},
          e('option',{value:'savings'},'按可释放空间'),e('option',{value:'sim'},'按相似度'),e('option',{value:'files'},'按文件数')
        ),
        e('div',{style:{position:'relative'}},
          Icon('search',{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--tx-faint)',pointerEvents:'none'}),
          e('input',{value:search,onChange:ev=>setSearch(ev.target.value),placeholder:'搜索曲名、艺术家...',style:{width:160,paddingLeft:26,paddingRight:8,paddingTop:5,paddingBottom:5,borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',outline:'none',fontSize:11}})
        )
      ),
      filter==='pending'&&visiblePending.length>0&&e('div',{style:{display:'flex',gap:8,alignItems:'center'}},
        e('span',{style:{fontSize:11,color:'var(--tx-faint)'}},`${visiblePending.length} 组 · ${fmtBytes(savings)}`),
        e(Btn,{onClick:()=>setShowBatchResolve(true),icon:'trash',small:true},'批量放入回收站')
      ),
      filter==='done'&&e('div',{style:{display:'flex',gap:8,alignItems:'center'}},
        e(Btn,{onClick:()=>setShowBatchUnresolve(true),icon:'arrow-back-up',small:true,variant:'ghost'},'批量撤销'),
        e(Btn,{onClick:()=>setShowEmptyTrash(true),icon:'trash',small:true,variant:'ghost'},'清空回收站')
      )
    ),

    showEmptyTrash&&e(ConfirmModal,{
      title:'清空回收站',
      message:e('span',null,
        '将永久删除 ',e('b',null,visibleResolved.length),' 个已处理组的 .deleted 文件',
        resolvedSavings>0?e('span',null,'（约 ',fmtBytes(resolvedSavings),'）'):null,
        '。',e('br'),e('br'),
        '此操作不可撤销。确定要继续吗？'),
      onConfirm:emptyTrash,
      onClose:()=>setShowEmptyTrash(false),
      danger:true,
    }),
    showBatchResolve&&e(ConfirmModal,{
      title:'批量放入回收站',
      message:e('span',null,
        '将处理 ',e('b',null,visiblePending.length),' 个重复组，',
        '释放约 ',e('b',null,fmtBytes(savings)),'。',e('br'),e('br'),
        '文件将被重命名为 .deleted，需要时可撤销恢复。'),
      onConfirm:resolveAll,
      onClose:()=>setShowBatchResolve(false),
      danger:true,
    }),
    showBatchUnresolve&&e(ConfirmModal,{
      title:'批量撤销',
      message:e('span',null,
        '将恢复 ',e('b',null,visibleResolved.length),' 个已处理组的 .deleted 文件',
        resolvedSavings>0?e('span',null,'（约 ',fmtBytes(resolvedSavings),'）'):null,
        '。',e('br'),e('br'),
        '确定要继续吗？'),
      onConfirm:unresolveAll,
      onClose:()=>setShowBatchUnresolve(false),
    }),
    purgeConfirm&&e(ConfirmModal,{
      title:'彻底删除',
      message:e('span',null,
        '将永久删除此组 ',e('b',null,purgeConfirm.count),' 个 .deleted 文件。',e('br'),e('br'),
        '此操作不可撤销。确定要继续吗？'),
      onConfirm:()=>{const id=purgeConfirm.id;setPurgeConfirm(null);purgeGroup(id);},
      onClose:()=>setPurgeConfirm(null),
      danger:true,
    }),

    e('div',{style:{display:'grid',gridTemplateColumns:'240px 1fr',gap:12,height:GH}},

      e('div',{style:{overflowY:'auto',height:'100%',paddingRight:2}},
        listLoading?e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:22}})):
        visibleGroups.length===0?e('div',{style:{color:'var(--tx-faint)',fontSize:12,padding:'20px 0',textAlign:'center',lineHeight:1.8}},(tagFilter.size||search.trim())?'当前筛选条件无结果':filter==='pending'?'无待处理组\n请先执行扫描':filter==='done'?'暂无已处理组':'暂无数据'):
        e('div',null,
          visibleGroups.slice(0,displayCount).map(g=>{
          const isSel=g.id===selId;
          const tags=(g.group_tags||'').split(',').filter(Boolean).slice(0,2);
          const title=g.keep_title||(detail?.id===g.id?detail.tracks?.find(t=>t._keepWinner)?.title:null)||`组 #${g.id}`;
          const artist=g.keep_artist||(detail?.id===g.id?detail.tracks?.find(t=>t._keepWinner)?.artist:null)||'';
          return e('div',{key:g.id,ref:el=>{if(el)groupRefs.current[g.id]=el;else delete groupRefs.current[g.id];},className:g.id===flashGroupId?'locate-flash':undefined,onClick:()=>setSelId(g.id),style:{padding:'10px 12px',borderRadius:'var(--r-lg)',cursor:'pointer',background:isSel?'var(--amber-bg)':'var(--bg-base)',border:`0.5px solid ${isSel?'var(--amber-bd)':'var(--bd-default)'}`,boxShadow:'var(--sh-xs)',opacity:g.resolved?.6:1,transition:'all .12s',marginBottom:4}},
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:3}},
              e('span',{style:{fontSize:12,fontWeight:600,color:isSel?'#92400E':'var(--tx-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,maxWidth:160}},title),
              !!g.resolved&&e('i',{className:'ti ti-circle-check',style:{fontSize:13,color:'var(--green)',flexShrink:0,marginLeft:4}})
            ),
            artist&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},artist),
            e('div',{style:{display:'flex',gap:4,flexWrap:'wrap'}},
              (g.savings_bytes>0)&&e('span',{style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'#FEF3C7',color:'#92400E',border:'0.5px solid #FDE68A'}},fmtBytes(g.savings_bytes)),
              tags.map(t=>e(GroupTag,{key:t,tag:t}))
            )
          );
        }),
        e('div',{ref:scrollSentinelRef,style:{height:1}})
      )
      ),

      e('div',{style:{overflowY:'auto',height:'100%',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-xs)',padding:'16px 18px'}},
        detailLoading?e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})):
        !detail||detail.id!==selId?
          e('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:10,height:'100%',color:'var(--tx-faint)',fontSize:12}},Icon('click',{fontSize:36}),'从左侧选择重复组查看详情'):
          e('div',{className:'fade'},
            // Header — F6: just tags, no extra explanation paragraph; the tag
            // itself (with hover description) carries the meaning now.
            e('div',{style:{marginBottom:14}},
              e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}},
                e('div',{style:{flex:1,minWidth:0}},
                  e('div',{style:{fontSize:15,fontWeight:700,color:'var(--tx-primary)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},detail.tracks?.find(t=>t._keepWinner)?.title||'—'),
                  e('div',{style:{fontSize:12,color:'var(--tx-muted)'}},detail.tracks?.find(t=>t._keepWinner)?.artist||'')
                ),
                detail.resolved?
                  (()=>{
                    const dels=detail.tracks?.filter(t=>!t._keepWinner)||[];
                    return e('div',{style:{display:'flex',gap:6}},
                      e('span',{style:{fontSize:11,fontWeight:500,color:'var(--green)',background:'var(--green-bg)',border:'0.5px solid var(--green-bd)',borderRadius:'var(--r-md)',padding:'4px 10px',display:'inline-flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-circle-check',style:{fontSize:13}}),dels.length?'已处理':'已清理'),
                      dels.length>0&&e(Btn,{variant:'ghost',icon:'arrow-back-up',small:true,onClick:()=>unresolve(detail.id)},'撤销'),
                      dels.length>0&&e(Btn,{variant:'ghost',icon:'trash',small:true,onClick:()=>setPurgeConfirm({id:detail.id,count:dels.length})},'彻底删除')
                    );
                  })()
                :
                  (()=>{const dels=detail.tracks?.filter(t=>!t._keepWinner)||[];return e(Btn,{icon:'trash',onClick:()=>resolve(detail.id)},`放入回收站 ${dels.length} 个`);})()
              ),
              e('div',{style:{display:'flex',gap:5,flexWrap:'wrap',marginTop:6}},
                ...(detail.group_tags||'').split(',').filter(Boolean).map(t=>e(GroupTag,{key:t,tag:t}))
              )
            ),


            e(DimensionTable,{tracks:detail.tracks||[]}),

            (detail.tracks||[]).map(t=>e(TrackRow,{key:t.id,track:t,player,
              isKept:!!t._keepWinner,
              queue:(detail.tracks||[]).filter(x=>x.fingerprint).map(x=>({id:x.id,title:x.title,artist:x.artist,src:'duplicates',groupId:detail.id})),
              onToggle:()=>onTrackToggle(detail.id,t.id,t._keepWinner,detail.tracks||[]),
              canToggle:!detail.resolved,
              onProps:()=>setPropsId(t.id),
              onScrape:()=>setScrapeId(t.id),
            })),


          )
      )
    )
  );
});

/* ══════════════════════════════════════════════════════════════════════
   SETTINGS VIEW — F6: single scrollable page, anchored sections:
   扫描目录 → 基础匹配 → 声纹匹配 → 刮削匹配 → 音质优先级 → 重复组标签 → 保留名单.
   A sticky left rail jumps to each anchor. Explanatory text that used to
   sit as an always-visible box is now a hover-revealed Hint next to the
   heading it explains, except 重复组标签 which IS the reference itself
   and stays visible. F8: changes auto-SAVE, but applying a match-affecting
   change (声纹阈值/时长容差/音质优先级) is a manual, explicit click on the
   reapply banner — it only re-runs matching, never re-extracts fp/scrape.
   ══════════════════════════════════════════════════════════════════════ */
const SETTINGS_SECTIONS=[
  {id:'sec-dirs',    label:'音乐目录',   icon:'folders'},
  {id:'sec-basic',   label:'基础匹配',   icon:'tag'},
  {id:'sec-fp',      label:'声纹匹配',   icon:'wave-sine'},
  {id:'sec-scrape',  label:'刮削匹配',   icon:'cloud-download'},
  {id:'sec-quality', label:'音质优先级', icon:'audio-levels'},
  {id:'sec-pick',    label:'保留优先级', icon:'priority-podium'},
  {id:'sec-wl',      label:'保留名单',     icon:'shield-check'},
  {id:'sec-history', label:'最近写入',   icon:'edit'},
];
// DEFAULT_Q, DEFAULT_PICK, mergePickOrder are served by /rules-meta.js (source: lib/rules.js)

function WriteHistorySection({writeHistoryKey,player,onLocateFile,onLocate}){
  const[rows,setRows]=useState(null);
  const[toast,setToast]=useState(null);
  const[search,setSearch]=useState('');
  const[purgeConfirm,setPurgeConfirm]=useState(null); // {fileId,title}
  function load(){api.get('/api/snapshots').then(r=>{if(r.ok)setRows(r.data||[]);});}
  useEffect(()=>{load();},[]);
  useEffect(()=>{if(writeHistoryKey>0)load();},[writeHistoryKey]);

  // Locate-in-此列表: used when the player's "定位到歌曲" is clicked for a
  // track that was played from here — scrolls this section into view, then
  // the specific row, clearing any search filter that would hide it.
  const rowRefs=useRef({});
  const[flashId,setFlashId]=useState(null);
  useEffect(()=>{ if(!flashId)return; const t=setTimeout(()=>setFlashId(null),3200); return()=>clearTimeout(t); },[flashId]);
  useEffect(()=>{
    if(!onLocate)return;
    onLocate.setLocateInHistory?.(fid=>{
      document.getElementById('sec-history')?.scrollIntoView({behavior:'smooth',block:'start'});
      setSearch('');
      let attempts=15;
      const tryScroll=()=>{
        const el=rowRefs.current[fid];
        if(el&&el.isConnected){ el.scrollIntoView({behavior:'smooth',block:'center'}); setFlashId(fid); return; }
        if(el&&!el.isConnected)delete rowRefs.current[fid]; // stale entry from before a reload — see LibraryView's scrollToRow for the full story
        if(--attempts>0)setTimeout(tryScroll,120);
      };
      setTimeout(tryScroll,150);
    });
  },[onLocate]);

  async function revert(fileId){
    const r=await api.post(`/api/snapshots/${fileId}/revert`);
    if(r.ok){setToast({msg:'已撤销至首次写入前的原始状态',type:'success'});load();}
    else setToast({msg:'撤销失败: '+(r.error||''),type:'error'});
  }
  async function doPurge(){
    if(!purgeConfirm)return;
    await api.del(`/api/snapshots/${purgeConfirm.fileId}`);
    setToast({msg:'已彻底删除写入历史',type:'success'});
    setPurgeConfirm(null);load();
  }

  const q=search.trim().toLowerCase();
  const filtered=(rows||[]).filter(r=>!q||
    (r.file_title||r.cur_title||'').toLowerCase().includes(q)||
    (r.file_artist||r.cur_artist||'').toLowerCase().includes(q));

  const COLS=['播放','标题','艺术家','修改字段','修改时间','剩余天数','操作'];

  return e(Card,{id:'sec-history',style:{minHeight:100}},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    purgeConfirm&&e(ConfirmModal,{
      title:'彻底删除写入历史',
      message:e('span',null,'确定要彻底删除「',e('b',null,purgeConfirm.title||purgeConfirm.fileId),'」的写入历史吗？删除后将无法再撤销，文件当前的标签保持不变。'),
      onConfirm:doPurge,
      onClose:()=>setPurgeConfirm(null),
      danger:true,
    }),
    e(SH,{title:`最近写入${rows?` （${rows.length} 条）`:''} `,
      sub:'以文件为单位，保留首次写入前的完整标签快照，可一步撤销；30天后自动清除'}),
    rows===null
      ? e('div',{style:{textAlign:'center',padding:20}},e('i',{className:'ti ti-loader spin',style:{fontSize:20}}))
      : rows.length===0
        ? e('div',{style:{textAlign:'center',padding:'24px 0',color:'var(--tx-faint)',lineHeight:2}},
            Icon('edit',{fontSize:28,display:'block',margin:'0 auto 8px',color:'var(--amber)'}),
            '写入历史为空',e('br'),
            e('span',{style:{fontSize:11}},'在刮削列写入字段后，原始标签将被快照保存于此')
          )
        : e('div',null,
            e('div',{style:{position:'relative',marginBottom:8}},
              Icon('search',{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--tx-faint)',pointerEvents:'none'}),
              e('input',{value:search,onChange:ev=>setSearch(ev.target.value),placeholder:'搜索标题、艺术家...',
                style:{width:'100%',paddingLeft:26,paddingRight:8,paddingTop:5,paddingBottom:5,boxSizing:'border-box',
                  borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',outline:'none',fontSize:11}})
            ),
            e('div',{style:{maxHeight:'calc(100vh - 340px)',minHeight:60,overflowY:'auto',borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)'}},
              e('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:12}},
                e('thead',null,e('tr',{style:{borderBottom:'0.5px solid var(--bd-default)',background:'var(--bg-subtle)'}},
                  ...COLS.map(h=>e('th',{key:h,style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',whiteSpace:'nowrap',fontSize:11}},h))
                )),
                e('tbody',null,filtered.length===0
                  ? e('tr',null,e('td',{colSpan:COLS.length,style:{padding:'14px',textAlign:'center',color:'var(--tx-faint)'}},'无匹配结果'))
                  : filtered.map(r=>{
                      const title=r.file_title||r.cur_title||'';
                      const artist=r.file_artist||r.cur_artist||'';
                      const fields=JSON.parse(r.modified_fields||'[]');
                      const dt=new Date(r.last_written_at);
                      const dtStr=`${dt.getMonth()+1}/${dt.getDate()} ${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}`;
                      const daysLeft=r.expires_at>0?Math.ceil((r.expires_at-Date.now())/(24*3600*1000)):30;
                      const daysColor=daysLeft<=3?'var(--red)':daysLeft<=7?'var(--amber)':'var(--tx-faint)';
                      const isCur=player?.current?.id===r.file_id;
                      return e('tr',{key:r.file_id,ref:el=>{if(el)rowRefs.current[r.file_id]=el;else delete rowRefs.current[r.file_id];},className:r.file_id===flashId?'locate-flash':undefined,style:{borderBottom:'0.5px solid var(--bd-subtle)'}},
                        e('td',{style:{padding:'6px 8px',width:36}},
                          player&&r.file_id&&e('button',{onClick:()=>player.playTrack({id:r.file_id,title,artist,src:'settings-history'}),
                            style:{background:isCur?'var(--amber)':'var(--bg-muted)',border:'none',borderRadius:'50%',width:24,height:24,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},
                            Icon(isCur&&player.playing?'pause':'play',{fontSize:15,color:isCur?'#fff':'var(--tx-muted)'}))
                        ),
                        e('td',{style:{padding:'6px 10px',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:180}},title||'—'),
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:130}},artist||'—'),
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-muted)',fontSize:11}},fields.join('、')||'—'),
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:10,whiteSpace:'nowrap'}},dtStr),
                        e('td',{style:{padding:'6px 10px',color:daysColor,fontFamily:'var(--font-mono)',fontSize:10,textAlign:'center',whiteSpace:'nowrap'}},`${daysLeft}天`),
                        e('td',{style:{padding:'4px 8px'}},
                          e('div',{style:{display:'flex',gap:3,alignItems:'center'}},
                            onLocateFile&&e(IconAction,{icon:'music-locate',title:'在音乐库中查看',onClick:()=>onLocateFile(r.file_id)}),
                            e(IconAction,{icon:'arrow-back-up',title:'撤销至原始状态',onClick:()=>revert(r.file_id)}),
                            e(IconAction,{icon:'trash',title:'彻底删除此条历史',danger:true,onClick:()=>setPurgeConfirm({fileId:r.file_id,title})})
                          )
                        )
                      );
                    })
                )
              )
            )
          )
  );
}


function RetentionListSection({player,retentionListKey,onLocateFile,onLocate}){
  const[rows,setRows]=useState([]);
  const[loading,setLoading]=useState(true);
  const[toast,setToast]=useState(null);
  const[search,setSearch]=useState('');
  function load(){setLoading(true);api.get('/api/retention-list').then(r=>{if(r.ok)setRows(r.data||[]);}).finally(()=>setLoading(false));}
  useEffect(()=>{load();},[]);
  useEffect(()=>{if(retentionListKey>0)load();},[retentionListKey]);
  async function remove(id){await api.del(`/api/retention-list/${id}`);setToast({msg:'已从保留名单移除',type:'success'});load();}

  // Locate-in-此列表 — same pattern as WriteHistorySection.
  const rowRefs=useRef({});
  const[flashId,setFlashId]=useState(null);
  useEffect(()=>{ if(!flashId)return; const t=setTimeout(()=>setFlashId(null),3200); return()=>clearTimeout(t); },[flashId]);
  useEffect(()=>{
    if(!onLocate)return;
    onLocate.setLocateInRetentionList?.(fid=>{
      document.getElementById('sec-wl')?.scrollIntoView({behavior:'smooth',block:'start'});
      setSearch('');
      let attempts=15;
      const tryScroll=()=>{
        const el=rowRefs.current[fid];
        if(el&&el.isConnected){ el.scrollIntoView({behavior:'smooth',block:'center'}); setFlashId(fid); return; }
        if(el&&!el.isConnected)delete rowRefs.current[fid]; // stale entry from before a reload — see LibraryView's scrollToRow for the full story
        if(--attempts>0)setTimeout(tryScroll,120);
      };
      setTimeout(tryScroll,150);
    });
  },[onLocate]);

  const q=search.trim().toLowerCase();
  const filtered=q?rows.filter(f=>(f.title||'').toLowerCase().includes(q)||(f.artist||'').toLowerCase().includes(q)||(f.album||'').toLowerCase().includes(q)):rows;

  return e(Card,{id:'sec-wl',style:{minHeight:120}},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    e(SH,{title:`保留名单（${rows.length} 个文件）`,sub:'名单中的文件参与重复检测，但受保护不被删除'}),
    loading?e('div',{style:{textAlign:'center',padding:30,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:22}})):
    rows.length===0
      ? e('div',{style:{textAlign:'center',padding:'24px 0',color:'var(--tx-faint)',lineHeight:2}},
          Icon('shield-check',{fontSize:28,display:'block',margin:'0 auto 8px'}),
          '保留名单为空',e('br'),e('span',{style:{fontSize:11}},'在"音乐库"或"重复组"中可将文件加入保留名单'))
      : e('div',null,
          e('div',{style:{position:'relative',marginBottom:8}},
            Icon('search',{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--tx-faint)',pointerEvents:'none'}),
            e('input',{value:search,onChange:ev=>setSearch(ev.target.value),placeholder:'搜索标题、艺术家、专辑...',
              style:{width:'100%',paddingLeft:26,paddingRight:8,paddingTop:5,paddingBottom:5,boxSizing:'border-box',
                borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',outline:'none',fontSize:11}})
          ),
          e('div',{style:{maxHeight:'calc(100vh - 320px)',minHeight:80,overflowY:'auto',borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)'}},
            e('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:12}},
              e('thead',null,e('tr',{style:{borderBottom:'0.5px solid var(--bd-default)',background:'var(--bg-subtle)'}},
                ...['','标题','艺术家','专辑','格式','操作'].map(h=>e('th',{key:h,style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',whiteSpace:'nowrap',fontSize:11}},h))
              )),
              e('tbody',null,filtered.length===0
                ? e('tr',null,e('td',{colSpan:6,style:{padding:'18px',textAlign:'center',color:'var(--tx-faint)',fontSize:12}},'无匹配结果'))
                : filtered.map(f=>{
                    const isCur=player?.current?.id===f.id;
                    return e('tr',{key:f.id,ref:el=>{if(el)rowRefs.current[f.id]=el;else delete rowRefs.current[f.id];},className:f.id===flashId?'locate-flash':undefined,style:{borderBottom:'0.5px solid var(--bd-subtle)'}},
                      e('td',{style:{padding:'6px 8px',width:36}},
                        f.fingerprint&&player&&e('button',{onClick:()=>player.playTrack({id:f.id,title:f.title,artist:f.artist,src:'settings-retention-list'}),style:{background:isCur?'var(--amber)':'var(--bg-muted)',border:'none',borderRadius:'50%',width:24,height:24,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},
                          Icon(isCur&&player.playing?'pause':'play',{fontSize:15,color:isCur?'#fff':'var(--tx-muted)'}))
                      ),
                      e('td',{style:{padding:'6px 10px',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:200}},f.title||'—'),
                      e('td',{style:{padding:'6px 10px',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160}},f.artist||'—'),
                      e('td',{style:{padding:'6px 10px',color:'var(--tx-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160,fontSize:11}},f.album||'—'),
                      e('td',{style:{padding:'6px 10px'}},e(QBadge,{format:f.format,bitrate:f.bitrate,sample_rate:f.sample_rate})),
                      e('td',{style:{padding:'4px 8px'}},
                        e('div',{style:{display:'flex',gap:3,alignItems:'center'}},
                          onLocateFile&&e(IconAction,{icon:'music-locate',title:'在音乐库中查看',onClick:()=>onLocateFile(f.id)}),
                          e(IconAction,{icon:'shield-x',title:'移除保留名单',danger:true,onClick:()=>remove(f.id)})
                        )
                      )
                    );
                  })
              )
            )
          )
        )
  );
}

function SettingsView({dirs,onAddDir,onRemoveDir,onEnumOnly,dirChanged,onMatchAffectingChange,onScrapeReapply,scanRunning,player,retentionListKey,writeHistoryKey,onLocateFile,onLocate,mainScrollRef}){
  const[s,setS]=useState(null);
  const[saveState,setSaveState]=useState('idle');
  const[showExclude,setShowExclude]=useState(false);
  const[needsReapply,setNeedsReapply]=useState(false);
  const[reapplying,setReapplying]=useState(false);
  const[acoustidValidating,setAcoustidValidating]=useState(false);
  const[acoustidValidResult,setAcoustidValidResult]=useState(null); // null|{ok,error}
  const[acoustidValidatedKey,setAcoustidValidatedKey]=useState(''); // last key that passed validation
  const[acoustidKeyDirty,setAcoustidKeyDirty]=useState(false);
  const[needsScrapeReapply,setNeedsScrapeReapply]=useState(false);
  const[fpcalc,setFpcalc]=useState(null);
  const[fpcalcPathDirty,setFpcalcPathDirty]=useState(false);
  const[fpcalcChecking,setFpcalcChecking]=useState(false);
  const saveTimer=useRef(null);
  useEffect(()=>{api.get('/api/system/fpcalc').then(r=>{if(r.ok)setFpcalc(r.data);});},[]);
  async function recheckFpcalc(){
    setFpcalcChecking(true);
    try{
      const p=(s?.fpcalc_path||'').trim();
      const r=await api.get('/api/system/fpcalc?path='+encodeURIComponent(p));
      if(r.ok){setFpcalc(r.data);setFpcalcPathDirty(false);}
    } finally { setFpcalcChecking(false); }
  }
  const isFirst=useRef(true);
  const lastApplied=useRef(null); // {threshold, duration_tolerance, quality_tiers} snapshot as of the last manual reapply

  // Scroll-spy: track which settings section is most visible in the main scroll area
  const sidebarRef=useRef(null);
  const[activeSection,setActiveSection]=useState(null);
  useEffect(()=>{
    if(!mainScrollRef?.current||!s)return;
    const root=mainScrollRef.current;
    const ratios=new Map();
    const observer=new IntersectionObserver(entries=>{
      for(const e of entries) ratios.set(e.target.id,e.intersectionRatio);
      let best=null,bestR=0;
      for(const[id,r]of ratios){if(r>bestR){bestR=r;best=id;}}
      if(best) setActiveSection(best);
    },{root,threshold:[0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1]});
    for(const sec of SETTINGS_SECTIONS){const el=document.getElementById(sec.id);if(el)observer.observe(el);}
    return()=>observer.disconnect();
  },[mainScrollRef,s]);

  useEffect(()=>{
    api.get('/api/settings').then(r=>{
      if(!r.ok)return;
      const d=r.data;
      if(!d.quality_tiers||!Array.isArray(d.quality_tiers))d.quality_tiers=[...DEFAULT_Q];
      d.pick_tag_order=mergePickOrder(d.pick_tag_order);
      delete d.scan_dirs; // owned by App/props, not local state — avoid stale overwrite races
      setS(d);
      lastApplied.current={threshold:d.threshold,duration_tolerance:d.duration_tolerance,quality_tiers:JSON.stringify(d.quality_tiers),pick_tag_order:JSON.stringify(d.pick_tag_order)};
      // validate stored AcoustID key against the actual API (not just assume valid)
      const key=(d.acoustid_key||'').trim();
      const lastValidated = localStorage.getItem('acoustid_validated_key') || '';
      if(key && key === lastValidated){
        setAcoustidValidatedKey(key);
        setAcoustidValidResult({ok:true});
      }
    });
  },[]);

  // Settings save: no longer auto-fires a re-match. Changes are only
  // applied via the explicit reapply banner button below.
  useEffect(()=>{
    if(!s)return;
    if(isFirst.current){isFirst.current=false;return;}
    setSaveState('saving');clearTimeout(saveTimer.current);
    saveTimer.current=setTimeout(()=>{
      api.put('/api/settings',s).then(r=>{
        if(!r.ok){setSaveState('error');return;}
        setSaveState('saved');setTimeout(()=>setSaveState('idle'),2200);
        const qj=JSON.stringify(s.quality_tiers||[]);
        const pj=JSON.stringify(s.pick_tag_order||[]);
        const changed = lastApplied.current && (
          lastApplied.current.threshold!==s.threshold ||
          lastApplied.current.duration_tolerance!==s.duration_tolerance ||
          lastApplied.current.quality_tiers!==qj ||
          lastApplied.current.pick_tag_order!==pj
        );
        if(changed)setNeedsReapply(true);
      });
    },700);
    return()=>clearTimeout(saveTimer.current);
  },[s]);

  function reapply(){
    setReapplying(true);
    onMatchAffectingChange?.();
    lastApplied.current={threshold:s.threshold,duration_tolerance:s.duration_tolerance,quality_tiers:JSON.stringify(s.quality_tiers||[]),pick_tag_order:JSON.stringify(s.pick_tag_order||[])};
    setNeedsReapply(false);
    setTimeout(()=>setReapplying(false),1500);
  }

  const moveQ=(i,d)=>{const q=[...(s.quality_tiers||DEFAULT_Q)];const j=i+d;if(j<0||j>=q.length)return;[q[i],q[j]]=[q[j],q[i]];setS(p=>({...p,quality_tiers:q}));};
  const resetQ=()=>setS(p=>({...p,quality_tiers:[...DEFAULT_Q]}));
  const movePick=(i,d)=>{const q=[...(s.pick_tag_order||DEFAULT_PICK)];const j=i+d;if(j<0||j>=q.length)return;[q[i],q[j]]=[q[j],q[i]];setS(p=>({...p,pick_tag_order:q}));};
  const resetPick=()=>setS(p=>({...p,pick_tag_order:[...DEFAULT_PICK]}));

  async function validateAcoustidKey(key,silent=false){
    if(!key)return;
    const keyChanged = key !== acoustidValidatedKey;
    setAcoustidValidating(true);setAcoustidValidResult(null);
    try{
      const r=await api.post('/api/validate-acoustid',{key});
      setAcoustidValidResult(r);
      if(r.ok){
        setAcoustidKeyDirty(false);
        setAcoustidValidatedKey(key);
        localStorage.setItem('acoustid_validated_key', key);
        if(!silent && keyChanged) setNeedsScrapeReapply(true);
      }
    }catch(e){setAcoustidValidResult({ok:false,error:'网络错误'});}
    finally{setAcoustidValidating(false);}
  }
  async function validateAcoustid(){
    await validateAcoustidKey((s?.acoustid_key||'').trim());
  }

  const SI=()=>e('div',{style:{fontSize:11,height:26,display:'flex',alignItems:'center',gap:5}},
    saveState==='saving'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-loader spin',style:{fontSize:12}}),'保存中...'),
    saveState==='saved'&&e('span',{className:'fade',style:{color:'var(--green)',display:'flex',alignItems:'center',gap:4}},Icon('circle-check',{fontSize:12}),'已保存'),
    saveState==='idle'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},Icon('device-floppy',{fontSize:12}),'修改后自动保存')
  );

  function jump(id){document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});}

  if(!s)return e('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:320,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}}));

  const q=s.quality_tiers||DEFAULT_Q;
  const pick=mergePickOrder(s.pick_tag_order);

  return e('div',{className:'fade',style:{display:'grid',gridTemplateColumns:'150px 1fr',gap:18,alignItems:'start'}},

    // Left rail — sticky, no overflow mask; whitespace is natural layout.
    e('div',{ref:sidebarRef,style:{position:'sticky',top:20,display:'flex',flexDirection:'column',gap:1}},
      SETTINGS_SECTIONS.map(sec=>e('button',{key:sec.id,'data-section':sec.id,onClick:()=>jump(sec.id),style:{display:'flex',alignItems:'center',gap:7,padding:'7px 9px',background:'none',border:'none',borderRadius:'var(--r-md)',cursor:'pointer',color:'var(--tx-secondary)',fontSize:12,textAlign:'left',flexShrink:0},onMouseEnter:ev=>ev.currentTarget.style.background='var(--bg-muted)',onMouseLeave:ev=>ev.currentTarget.style.background='none'},
        Icon(sec.icon,{fontSize:14,color:'var(--tx-faint)'}),sec.label)),
      e('div',{style:{marginTop:8,paddingTop:8,borderTop:'0.5px solid var(--bd-subtle)'}},e(SI))
    ),

    // Right — all sections concatenated, scrollable as part of <main>
    e('div',{'data-hint-boundary':'',style:{display:'flex',flexDirection:'column',gap:14,paddingBottom:14}},

      // Unified prompt layout for "设置已修改，需要重新扫描" — jumps to 扫描 page.
      needsReapply&&e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)'}},
        Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
        e('div',{style:{flex:1,fontSize:12,color:'var(--tx-secondary)'}},'频谱声纹阈值 / 时长容差 / 音质优先级 / 保留优先级 已修改，尚未重新应用到现有重复组'),
        e(Btn,{small:true,icon:reapplying?'loader':'refresh',disabled:scanRunning||reapplying,onClick:reapply},scanRunning?'扫描进行中...':'立即重新匹配')
      ),

      dirChanged&&e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)'}},
        Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
        e('div',{style:{flex:1,fontSize:12,color:'var(--tx-secondary)'}},'音乐目录已修改，建议更新音乐库（只枚举文件树，不做声纹/刮削）'),
        e(Btn,{small:true,icon:'refresh',disabled:scanRunning,onClick:onEnumOnly},scanRunning?'扫描进行中...':'立即更新音乐库')
      ),

      needsScrapeReapply&&e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)'}},
        Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
        e('div',{style:{flex:1,fontSize:12,color:'var(--tx-secondary)'}},'AcoustID Key 已验证，建议重新执行「刮削匹配」以应用声纹查询'),
        e(Btn,{small:true,icon:'refresh',disabled:scanRunning,onClick:()=>{onScrapeReapply?.();setNeedsScrapeReapply(false);}},scanRunning?'扫描进行中...':'立即刮削匹配')
      ),

      e(Card,{id:'sec-dirs'},
        e(SH,{title:'音乐目录',sub:'添加包含音乐文件的文件夹到音乐库'}),
        e(ScanDirsEditor,{dirs,onAddDir,onRemoveDir,onEnumOnly}),
        e('button',{onClick:()=>setShowExclude(v=>!v),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',fontSize:11,display:'flex',alignItems:'center',gap:4,padding:0,marginTop:10}},
          e('i',{className:`ti ti-chevron-${showExclude?'up':'down'}`,style:{fontSize:12}}),'高级：排除规则 / 并发线程 / 增量扫描'
        ),
        showExclude&&e('div',{style:{marginTop:10,display:'flex',flexDirection:'column',gap:12}},
          e('div',null,
            e('textarea',{value:(s.exclude_patterns||[]).join(', '),onChange:ev=>setS(p=>({...p,exclude_patterns:ev.target.value.split(',').map(x=>x.trim()).filter(Boolean)})),style:{width:'100%',fontSize:11,fontFamily:'var(--font-mono)',padding:'8px 10px',borderRadius:'var(--r-md)',background:'var(--bg-subtle)',border:'0.5px solid var(--bd-default)',color:'var(--tx-secondary)',resize:'none',height:54,lineHeight:1.6,outline:'none'}}),
            e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:4}},'逗号分隔，支持 glob。示例：*.tmp, .DS_Store, Thumbs.db')
          ),
          e('div',null,
            e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)'}},'并发线程数'),e('span',{style:{fontSize:14,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},s.threads||8)),
            e('input',{type:'range',min:1,max:32,value:s.threads||8,onChange:ev=>setS(p=>({...p,threads:+ev.target.value}))})
          ),
          e('div',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)'}},
            e('input',{type:'checkbox',id:'smart',checked:s.smart_scan!==false,onChange:ev=>setS(p=>({...p,smart_scan:ev.target.checked})),style:{marginTop:2}}),
            e('label',{htmlFor:'smart',style:{fontSize:12,color:'var(--tx-secondary)',cursor:'pointer',lineHeight:1.6,display:'flex',flexDirection:'column',gap:2}},
              e('span',{style:{display:'flex',alignItems:'center',gap:6}},'智能增量扫描',e(Tag,{children:'推荐',color:'var(--green)',bg:'var(--green-bg)',border:'var(--green-bd)'})),
              e('span',{style:{fontSize:11,color:'var(--tx-faint)'}},'按文件修改时间跳过未变更文件；同时检查文件是否仍然存在，已删除的文件会从库中移除')
            )
          )
        )
      ),

      e(Card,{id:'sec-basic'},
        e(SH,{title:'基础匹配',sub:'标题 + 艺术家 + 时长',hint:'枚举文件、读取标签后直接比对，是最主要、最可靠的重复判定依据，完全不依赖声纹。'}),
        e('div',null,
          e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)',display:'flex',alignItems:'center'}},'时长容差',e(Hint,{text:'两个文件标题、艺术家一致时，时长相差在此范围内仍视为同一首歌——不同来源的同一首歌常有 1-5 秒的掐头去尾差异。'})),e('span',{style:{fontSize:14,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},(s.duration_tolerance??5)+' 秒')),
          e('input',{type:'range',min:1,max:15,value:s.duration_tolerance??5,onChange:ev=>setS(p=>({...p,duration_tolerance:+ev.target.value}))})
        )
      ),

      e(Card,{id:'sec-fp'},
        e(SH,{title:'声纹匹配',hint:'提取音频声纹后交叉比对相似度（滑动窗口对齐）。达到阈值即视为声纹匹配。内置 Goertzel 声纹开箱即用；配置 fpcalc 后可额外启用 Chromaprint 声纹独立比对。'}),
        e('div',null,
          e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4}},'频谱声纹相似度阈值',e(Hint,{text:'两条音轨的频谱声纹对比相似度达到此阈值即视为匹配。值越高越严格（匹配更少），越低越宽松（匹配更多）。注意：标题、艺术家、时长近似的歌曲，即使低于此阈值仍会被判定为重复。'})),e('span',{style:{fontSize:15,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},(s.threshold||90)+'%')),
          e('input',{type:'range',min:70,max:100,value:s.threshold||90,onChange:ev=>setS(p=>({...p,threshold:+ev.target.value}))}),
          e('div',{style:{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--tx-faint)',marginTop:3}},e('span',null,'70% 宽松'),e('span',null,'100% 精确'))
        ),

        e('div',{style:{marginTop:16,paddingTop:14,borderTop:'0.5px solid var(--bd-subtle)'}},
          e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',marginBottom:2,display:'flex',alignItems:'center'}},'CP 声纹（可选）',e(Hint,{text:'频谱声纹开箱即用，不需要配置。Chromaprint 是第二种声纹，配置后会在频谱声纹之外额外做一次独立比对，两者互不影响、结果会分别标注，通常能找到频谱声纹漏掉的一些重复。同一份 Chromaprint 数据也会被「刮削匹配」里的 AcoustID 用到。'})),
          e('div',{style:{display:'flex',gap:6,maxWidth:460}},
            e('input',{value:s.fpcalc_path||'',
              onChange:ev=>{setS(p=>({...p,fpcalc_path:ev.target.value}));setFpcalcPathDirty(true);},
              placeholder:fpcalc?.available?`已自动检测：${fpcalc.path}`:'留空则自动检测（项目根目录 / PATH）',
              style:{flex:1,fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',outline:'none',fontFamily:'var(--font-mono)'}}),
            e(SettingStatus,{
              state:!fpcalc?'idle':fpcalc.available?'ok':'warn',
              busy:fpcalcChecking,
              message:!fpcalc?'检测中...':fpcalc.available?`已找到：${fpcalc.path}`:(fpcalc.note||'未检测到，点击重新检测'),
              onClick:recheckFpcalc,
            })
          ),
          e('div',{style:{marginTop:4,fontSize:11,color:'var(--tx-faint)'}},
            '下载地址：acoustid.org/chromaprint（对应你的系统，文件很小）。下载后把 fpcalc 放到本项目根目录，或在上面填入完整路径，两者任选一种。'
          )
        )
      ),

      e(Card,{id:'sec-scrape'},
        e(SH,{title:'刮削匹配',hint:'向 MusicBrainz 查询录音信息，可选再叠加 AcoustID 声纹识别。两个文件命中同一条录音即视为交叉确认，是比对比声纹更强的重复证据。'}),

        e('div',{style:{display:'flex',alignItems:'center',padding:'8px 10px',marginBottom:12,background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)'}},
          e('input',{type:'checkbox',id:'ignoreScript',checked:s.ignore_script_variant!==false,
            onChange:ev=>setS(p=>({...p,ignore_script_variant:ev.target.checked})),style:{marginRight:8,flexShrink:0}}),
          e('label',{htmlFor:'ignoreScript',style:{cursor:'pointer'}},
            e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)'}},'刮削分类 · 繁简忽略')
          ),
          e(Hint,{text:'判断标题/艺术家/专辑是否"精确匹配"时，忽略繁体与简体的写法差异（如 回到过去/回到過去 视为一致）。关闭后繁简不同会被归入「模糊匹配」。此项立即生效，无需重新扫描。'})
        ),

        e('div',{style:{marginBottom:12}},
          e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',marginBottom:4}},Icon('world',{marginRight:5,fontSize:13}),'MusicBrainz'),
          e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:2}},'默认启用，无需配置。按文件属性精确匹配，属性极度不完整时退回标题模糊搜索。速率限制 1 次/秒。')
        ),
        e('div',null,
          e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',marginBottom:6}},
            Icon('key',{marginRight:5,fontSize:13}),'AcoustID（可选）'
          ),
          e('div',{style:{display:'flex',gap:14,flexWrap:'wrap'}},
            // Condition 1: API Key
            e('div',{style:{flex:'1 1 220px',minWidth:200}},
              e('div',{style:{fontSize:11,color:'var(--tx-secondary)',marginBottom:4,fontWeight:500}},'① AcoustID API Key'),
              e('div',{style:{display:'flex',gap:6}},
                e('input',{value:s.acoustid_key||'',
                  onChange:ev=>{const v=ev.target.value;setS(p=>({...p,acoustid_key:v}));setAcoustidKeyDirty(true);if(v.trim()!==acoustidValidatedKey)setAcoustidValidResult(null);},
                  placeholder:'acoustid.org 注册应用获取',
                  style:{flex:1,fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',outline:'none',fontFamily:'var(--font-mono)'}}),
                e(SettingStatus,{
                  state:acoustidValidating?'idle':acoustidValidResult?(acoustidValidResult.ok?'ok':'error'):'idle',
                  busy:acoustidValidating,
                  message:acoustidValidating?'验证中...':acoustidValidResult?(acoustidValidResult.ok?'API Key 已验证':(acoustidValidResult.error||'验证失败')):((s.acoustid_key||'').trim()?'点击验证 API Key':'请先填写 API Key'),
                  onClick:(s.acoustid_key||'').trim()?validateAcoustid:undefined,
                })
              )
            ),
            // Condition 2: Chromaprint — configured in 声纹匹配, status-only
            // reference here (single source of truth for the fpcalc path;
            // see sec-fp) rather than a second input for the same setting.
            e('div',{style:{flex:'1 1 260px',minWidth:240}},
              e('div',{style:{fontSize:11,color:'var(--tx-secondary)',marginBottom:4,fontWeight:500}},'② CP 声纹'),
              e('button',{onClick:()=>jump('sec-fp'),style:{display:'flex',alignItems:'center',gap:6,width:'100%',padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',cursor:'pointer',fontSize:11,color:fpcalc?.available?'var(--green)':'var(--tx-faint)',textAlign:'left'}},
                Icon(fpcalc?.available?'circle-check':'alert-circle',{fontSize:12,flexShrink:0}),
                e('span',{style:{flex:1}},fpcalc?.available?`已配置：${fpcalc.path}`:'未配置'),
                e('span',{style:{color:'var(--tx-faint)',textDecoration:'underline'}},'去「声纹匹配」配置')
              )
            )
          ),
          e('div',{style:{marginTop:10,padding:'8px 12px',background:'var(--bg-subtle)',border:'0.5px solid var(--bd-subtle)',borderRadius:'var(--r-md)',fontSize:11,color:'var(--tx-faint)'}},
            '两个条件都满足后，重新运行一次「刮削匹配」，AcoustID 即可生效。'
          )
        )
      ),

      e(Card,{id:'sec-quality'},
        e('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10}},
          e('div',{style:{flex:1}},e(SH,{icon:'audio-levels',title:'音质优先级',sub:'上下移动调整 — 顶部优先级最高',hint:'按列表顺序对格式/码率/采样率/位深分级打分，作为保留优先级中"音质最优"维度的评分依据。'})),
          e(Btn,{small:true,variant:'ghost',icon:'refresh',onClick:resetQ},'恢复默认')
        ),
        q.map((f,i)=>e('div',{key:f,style:{display:'flex',alignItems:'center',gap:10,padding:'4px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',marginBottom:3,border:'0.5px solid var(--bd-subtle)'}},
          e('span',{style:{width:20,fontSize:11,fontFamily:'var(--font-mono)',fontWeight:700,color:i<3?'var(--green)':i<6?'var(--amber)':'var(--tx-faint)',textAlign:'center'}},i+1),
          e('span',{style:{flex:1,fontSize:12,color:i<6?'var(--tx-secondary)':'var(--tx-faint)'}},f),
          i===0&&e('span',{style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}},'最优'),
          e('div',{style:{display:'flex',flexDirection:'column',gap:1}},
            e('button',{onClick:()=>moveQ(i,-1),disabled:i===0,style:{background:'none',border:'none',cursor:i===0?'default':'pointer',padding:'1px 4px',opacity:i===0?.2:1,color:'var(--tx-muted)'}},Icon('chevron-up',{fontSize:13})),
            e('button',{onClick:()=>moveQ(i,1),disabled:i===q.length-1,style:{background:'none',border:'none',cursor:i===q.length-1?'default':'pointer',padding:'1px 4px',opacity:i===q.length-1?.2:1,color:'var(--tx-muted)'}},Icon('chevron-down',{fontSize:13}))
          )
        ))
      ),

      e(Card,{id:'sec-pick'},
        e('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10}},
          e('div',{style:{flex:1}},e(SH,{icon:'priority-podium',title:'保留优先级',sub:'上下移动调整 — 顶部优先级最高',hint:'决定重复组中保留哪个文件的级联规则：按列表顺序依次比较，每轮在当前候选池中取最高分文件晋级，直至唯一胜出。文件缺某项数据时不参与该轮，不会被淘汰。具体各维度含义见重复组详情"维度对比"旁的说明按钮。'})),
          e(Btn,{small:true,variant:'ghost',icon:'refresh',onClick:resetPick},'恢复默认')
        ),
        pick.map((key,i)=>e('div',{key,style:{display:'flex',alignItems:'center',gap:10,padding:'4px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',marginBottom:3,border:'0.5px solid var(--bd-subtle)'}},
          e('span',{style:{width:20,fontSize:11,fontFamily:'var(--font-mono)',fontWeight:700,color:i<2?'var(--green)':i<4?'var(--amber)':'var(--tx-faint)',textAlign:'center'}},i+1),
          e('span',{style:{flex:1,fontSize:12,color:i<pick.length?'var(--tx-secondary)':'var(--tx-faint)'}},PICK_TAG_LABEL[key]||key),
          i===0&&e('span',{style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}},'最优先'),
          e('div',{style:{display:'flex',flexDirection:'column',gap:1}},
            e('button',{onClick:()=>movePick(i,-1),disabled:i===0,style:{background:'none',border:'none',cursor:i===0?'default':'pointer',padding:'1px 4px',opacity:i===0?.2:1,color:'var(--tx-muted)'}},Icon('chevron-up',{fontSize:13})),
            e('button',{onClick:()=>movePick(i,1),disabled:i===pick.length-1,style:{background:'none',border:'none',cursor:i===pick.length-1?'default':'pointer',padding:'1px 4px',opacity:i===pick.length-1?.2:1,color:'var(--tx-muted)'}},Icon('chevron-down',{fontSize:13}))
          )
        ))
      ),

      e(RetentionListSection,{player,retentionListKey,onLocateFile,onLocate}),
      e(WriteHistorySection,{writeHistoryKey,player,onLocateFile,onLocate})
    )
  );
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
        e('div',{style:{display:view==='library'?'block':'none'}},e(LibraryView,{player:player.lite,dirs,onAddDir:addScanDirNav,onRemoveDir:removeScanDir,onEnumOnly:refreshLibrary,onLocate:{setLocateInLibrary:fn=>{locateInLibraryRef.current=fn;}},mainScrollRef,libraryKey,onRetentionChange:()=>setRetentionListKey(k=>k+1),onTagsWritten:()=>setWriteHistoryKey(k=>k+1)})),
        e('div',{style:{display:view==='duplicates'?'block':'none'}},e(DuplicatesView,{setPendingCount:setPending,player:player.lite,scanDoneKey,onRetentionChange:()=>setRetentionListKey(k=>k+1),onLocate:{setLocateInDuplicates:fn=>{locateInDuplicatesRef.current=fn;}}})),
        e('div',{style:{display:view==='scanner'?'block':'none'}},e(ScannerView,{scan})),
        e('div',{style:{display:view==='settings'?'block':'none'}},e(SettingsView,{dirs,onAddDir:addScanDirOnly,onRemoveDir:removeScanDir,dirChanged:!!settings?._dirChanged,onEnumOnly:()=>{refreshLibrary();setSettingsState(p=>({...(p||{}),_dirChanged:false}));},onMatchAffectingChange,onScrapeReapply,scanRunning:scan.status.running,player:player.lite,retentionListKey,writeHistoryKey,onLocateFile:navigateToFile,onLocate:{setLocateInRetentionList:fn=>{locateInRetentionListRef.current=fn;},setLocateInHistory:fn=>{locateInHistoryRef.current=fn;}},mainScrollRef}))
      )
    ),
    // PlayerBar in normal flow — pushes content up, never overlaps.
    e(PlayerBar,{player,onLocate:handleLocate})
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(e(App));
