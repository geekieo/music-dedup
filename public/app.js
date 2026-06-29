'use strict';
const {useState,useEffect,useRef,useMemo,useCallback}=React;
const e=React.createElement;
const APP_VERSION='1.7.0';

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

/* ── Match-tag taxonomy ──────────────────────────────────────────────────
   Tri-state fingerprint-confidence label (exact_copy / same_recording /
   fp_diff) is always exactly one of the three per group — it reflects HOW
   the match was confirmed, not an arbitrary similarity cutoff. Spectral
   similarity is unreliable across different encodes/masters (phase/alignment
   drift can crash the score even for an identical recording), so "声纹不同"
   does not mean "probably not a duplicate" — metadata is just as valid a
   basis. See lib/rules.js for the matching server-side source of truth. */
const MATCH_TAG_LABELS={
  exact_copy:'声纹一致', same_recording:'声纹相似', fp_diff:'声纹不同',
  format_diff:'格式不同', filename_same:'文件名相同', metadata_same:'标题/艺术家一致',
  single_vs_album:'单曲vs专辑', duration_near:'时长基本一致', mb_confirmed:'MusicBrainz确认',
};
const MATCH_TAG_DESCRIPTIONS={
  exact_copy:'两个文件的声纹完全一致。和文件字节是否相同无关——文件名、标签、体积都可以不一样。',
  same_recording:'声纹相似度达到设定阈值，但不完全一致，通常是同一录音的不同编码或母带。',
  fp_diff:'声纹比对未达到阈值，凭标题、艺术家、时长等元数据判定为重复。',
  format_diff:'同一首歌存在不同的文件格式（容器/编码）。',
  filename_same:'文件名（不含扩展名）完全相同。',
  metadata_same:'标题和艺术家标签完全一致。',
  single_vs_album:'一个版本来自单曲，另一个来自专辑/合辑。',
  duration_near:'时长几乎完全一致（≤1.5 秒）。',
  mb_confirmed:'两个文件被刮削到同一条 MusicBrainz 录音，第三方数据库交叉确认。',
};
const TAG_COLORS={
  exact_copy:['#065F46','#D1FAE5','#A7F3D0'], same_recording:['#1E40AF','#DBEAFE','#BFDBFE'],
  fp_diff:['#92400E','#FFFBEB','#FDE68A'], format_diff:['#5B21B6','#EDE9FE','#DDD6FE'],
  filename_same:['#1D4ED8','#DBEAFE','#BFDBFE'], metadata_same:['#0F766E','#CCFBF1','#99F6E4'],
  single_vs_album:['#9A3412','#FEE2E2','#FECACA'], duration_near:['#6B7280','#F3F4F6','#E5E7EB'],
  mb_confirmed:['#7C3AED','#EDE9FE','#DDD6FE'],
};

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
  trash:{els:[['path',{d:'M4 7h16'}],['path',{d:'M9 7V4h6v3'}],['path',{d:'M6 7l1 13h10l1-13'}]]},
  refresh:{els:[['path',{d:'M4 12a8 8 0 0114-5.3'}],['path',{d:'M20 12a8 8 0 01-14 5.3'}],['path',{d:'M18 4v4h-4'}],['path',{d:'M6 20v-4h4'}]]},
  key:{els:[['circle',{cx:7,cy:15,r:4}],['path',{d:'M10 12l9-9'}],['path',{d:'M16 6l2 2'}],['path',{d:'M13 9l2 2'}]]},
  world:{els:[['circle',{cx:12,cy:12,r:9}],['path',{d:'M3 12h18'}],['path',{d:'M12 3a14 14 0 010 18'}],['path',{d:'M12 3a14 14 0 000 18'}]]},
  'device-floppy':{els:[['path',{d:'M5 4h11l3 3v13H5z'}],['path',{d:'M9 4v5h7V4'}],['path',{d:'M8 14h8v6H8z'}]]},
  'chevron-up':{els:[['path',{d:'M6 15l6-6 6 6'}]]},
  'chevron-down':{els:[['path',{d:'M6 9l6 6 6-6'}]]},
  'chevron-left':{els:[['path',{d:'M15 6l-6 6 6 6'}]]},
  'chevron-right':{els:[['path',{d:'M9 6l6 6-6 6'}]]},
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

  useEffect(()=>{
    if(!current)return;
    const el=audioRef.current;
    if(!el)return;
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
  const close=useCallback(()=>{const el=audioRef.current;setCurrent(null);setPlaying(false);if(el){el.pause();el.removeAttribute('src');el.load();}},[]);
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

  const bind=useMemo(()=>({
    onPlay:()=>setPlaying(true),onPause:()=>setPlaying(false),onEnded:()=>setPlaying(false),
    onTimeUpdate:ev=>{setProgress(ev.target.currentTime);setDuration(ev.target.duration||0);},
  }),[]);

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
      if(duration)player.seek(p*duration); // commit seek only on release
      dragging.current=false;
      setIsDragging(false);
      window.removeEventListener('mousemove',onMove);
      window.removeEventListener('mouseup',onUp);
    }
    window.addEventListener('mousemove',onMove);
    window.addEventListener('mouseup',onUp);
  }

  // Hover does NOT update dragPct / show thumb — only thickens the rail
  const showThumb=isDragging;             // thumb visible ONLY while dragging
  const fillPct=isDragging?dragPct:pct;   // preview fill while dragging
  const timeLabel=`${fmtDur(isDragging?fillPct/100*(duration||0):progress)} / ${fmtDur(duration)}`;
  const thumbPct=Math.max(0.5,Math.min(99.5,fillPct));

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
      // Thumb + time tooltip — ONLY during active drag
      showThumb&&e('div',{style:{position:'absolute',top:'50%',left:thumbPct+'%',
        transform:'translate(-50%,-50%)',pointerEvents:'none',zIndex:2}},
        e('div',{style:{position:'absolute',bottom:'calc(100% + 6px)',left:'50%',transform:'translateX(-50%)',
          background:'rgba(17,24,39,.85)',color:'#fff',fontSize:10,fontFamily:'var(--font-mono)',
          padding:'3px 8px',borderRadius:99,whiteSpace:'nowrap',pointerEvents:'none',
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
              opacity:hasQueue?1:.3,color:'var(--tx-secondary)',padding:4,display:'flex',borderRadius:'50%'}},
            Icon('chevron-left',{fontSize:20})),
          e('button',{onClick:player.toggle,
            style:{background:'var(--amber)',border:'none',borderRadius:'50%',width:38,height:38,
              display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',flexShrink:0,
              boxShadow:'0 2px 8px rgba(217,119,6,.4)'}},
            Icon(playing?'pause':'play',{fontSize:17,color:'#fff'})),
          e('button',{onClick:player.playNext,disabled:!hasQueue,title:'下一曲',
            style:{background:'none',border:'none',cursor:hasQueue?'pointer':'default',
              opacity:hasQueue?1:.3,color:'var(--tx-secondary)',padding:4,display:'flex',borderRadius:'50%'}},
            Icon('chevron-right',{fontSize:20}))
        )
      ),

      // Right: volume control — absolute-positioned mirroring the left panel.
      e('div',{style:{position:'absolute',right:20,top:0,bottom:0,display:'flex',
        alignItems:'center',gap:4}},
        // Volume button always shows the speaker icon; slider expands on hover.
        e('div',{className:'volume-ctl',style:{display:'flex',alignItems:'center',gap:4}},
          e('button',{onClick:()=>setVolume(volume===0?0.8:0),title:volume===0?'取消静音':'静音',
            style:{background:'none',border:'none',cursor:'pointer',display:'flex',
              alignItems:'center',color:'var(--tx-muted)',padding:'4px 2px',flexShrink:0}},
            Icon(volume===0?'volume-off':volume<0.5?'volume-2':'volume',{fontSize:18})
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
function Hint({text,size=13}){
  const[show,setShow]=useState(false);
  if(!text)return null;
  return e('span',{style:{position:'relative',display:'inline-flex',marginLeft:5,verticalAlign:'middle'},
    onMouseEnter:()=>setShow(true),onMouseLeave:()=>setShow(false)},
    e('span',{style:{display:'inline-flex',color:'var(--tx-faint)',cursor:'help'},tabIndex:0,onFocus:()=>setShow(true),onBlur:()=>setShow(false)},Icon('info-circle',{fontSize:size})),
    show&&e('div',{className:'fade',style:{position:'absolute',zIndex:60,top:'140%',left:0,width:268,background:'#1F2937',color:'#F9FAFB',fontSize:11,lineHeight:1.7,padding:'9px 11px',borderRadius:'var(--r-md)',boxShadow:'var(--sh-md)',fontWeight:400}},text)
  );
}
function MatchTag({tag,hideTooltip}){
  const[col,bg,bd]=TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
  return e('span',{title:hideTooltip?undefined:(MATCH_TAG_DESCRIPTIONS[tag]||''),style:{fontSize:10,fontWeight:500,color:col,background:bg,border:`0.5px solid ${bd}`,padding:'1px 7px',borderRadius:3,whiteSpace:'nowrap',cursor:hideTooltip?'default':'help'}},MATCH_TAG_LABELS[tag]||tag);
}
function Tag({children,color='var(--tx-faint)',bg='var(--bg-muted)',border='var(--bd-default)'}){return e('span',{style:{fontSize:10,padding:'1px 7px',borderRadius:3,background:bg,color,border:`0.5px solid ${border}`,whiteSpace:'nowrap'}},children);}
function Btn({children,onClick,variant='primary',small,disabled,icon,style:sx={}}){
  const base={display:'flex',alignItems:'center',gap:5,borderRadius:'var(--r-md)',fontFamily:'var(--font-sans)',fontWeight:500,cursor:disabled?'not-allowed':'pointer',fontSize:small?11:12,padding:small?'4px 10px':'7px 14px',transition:'all .12s',border:'none',opacity:disabled?.45:1,whiteSpace:'nowrap',...sx};
  const V={primary:{...base,background:'var(--amber)',color:'#fff'},ghost:{...base,background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'},danger:{...base,background:'var(--red-bg)',color:'var(--red)',border:'0.5px solid var(--red-bd)'},success:{...base,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}};
  return e('button',{onClick:disabled?undefined:onClick,style:V[variant]||V.primary},icon&&Icon(icon,{fontSize:small?12:14},icon==='loader'?'spin':undefined),children);
}
// Icon-only action button — bigger touch target + a real fill color when
// active, so the three per-track actions (打开/属性/白名单) read as buttons
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
function SH({title,sub,hint}){return e('div',{style:{marginBottom:12}},e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',display:'flex',alignItems:'center'}},title,e(Hint,{text:hint})),sub&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:2}},sub));}
function SC({label,val,sub,col}){return e('div',{style:{background:'var(--bg-base)',borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',padding:'12px 16px',flex:1,minWidth:80}},e('div',{style:{fontSize:11,color:'var(--tx-faint)',fontWeight:500,marginBottom:4}},label),e('div',{style:{fontSize:21,fontWeight:600,fontFamily:'var(--font-mono)',color:col||'var(--tx-primary)',lineHeight:1.2,letterSpacing:'-0.02em'}},val),sub&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:2}},sub));}
function Toast({msg,type='info',onClose}){
  useEffect(()=>{const t=setTimeout(onClose,3800);return()=>clearTimeout(t);},[]);
  const S={error:{bg:'var(--red-bg)',col:'var(--red)',bd:'var(--red-bd)',ic:'alert-circle'},success:{bg:'var(--green-bg)',col:'var(--green)',bd:'var(--green-bd)',ic:'circle-check'},info:{bg:'var(--amber-bg)',col:'var(--amber)',bd:'var(--amber-bd)',ic:'info-circle'}};
  const s=S[type]||S.info;
  return e('div',{className:'fade',style:{position:'fixed',bottom:24,right:24,zIndex:9999,background:s.bg,border:`1px solid ${s.bd}`,borderRadius:'var(--r-lg)',padding:'11px 16px',color:s.col,fontSize:12,fontWeight:500,display:'flex',alignItems:'center',gap:10,boxShadow:'var(--sh-md)',maxWidth:400}},
    Icon(s.ic,{fontSize:16,flexShrink:0}),e('span',{style:{flex:1}},msg),
    e('button',{onClick:onClose,style:{background:'none',border:'none',color:s.col,cursor:'pointer',padding:2}},Icon('x',{fontSize:13})));
}
function Modal({title,children,onClose,width=520}){
  return e('div',{style:{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,.25)',display:'flex',alignItems:'center',justifyContent:'center',padding:20},onClick:ev=>ev.target===ev.currentTarget&&onClose()},
    e('div',{className:'fade',style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-xl)',boxShadow:'0 20px 60px rgba(0,0,0,.15)',width:'100%',maxWidth:width,maxHeight:'85vh',display:'flex',flexDirection:'column'}},
      e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 20px',borderBottom:'0.5px solid var(--bd-subtle)'}},
        e('span',{style:{fontSize:14,fontWeight:600}},title),
        e('button',{onClick:onClose,style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:4}},Icon('x',{fontSize:18}))
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


/* ── Scrape-status tier helper ───────────────────────────────────────────
   green:  精确匹配（title+artist+album 实际值都一致）且文件属性完整、无推荐写入
   yellow: 精确匹配但文件存在缺失字段（有推荐写入）
   red:    模糊匹配 — 任意一个字段（title/artist/album）不一致，或 match_basis=fuzzy
   null:   无可用刮削数据
*/
function scrapeStatusTier(file, scraped) {
  if (!scraped || !scraped.title || scraped.source === 'none') return null;
  // "精确匹配" = scraper 判断为 exact，且 title/artist/album 实际值都一致（或文件缺失该字段）
  function consistent(fileVal, scrapedVal) {
    if (!fileVal || !scrapedVal) return true; // 一侧为空 → 中性，不算不一致
    return normCmp(String(fileVal)) === normCmp(String(scrapedVal));
  }
  const titleOk  = consistent(file.title,  scraped.title);
  const artistOk = consistent(file.artist, scraped.artist);
  const albumOk  = consistent(file.album,  scraped.album);
  const isExact  = titleOk && artistOk && albumOk && scraped.match_basis === 'exact';
  if (!isExact) return 'red';
  const { selected } = autoSelectFields(file, scraped);
  return Object.values(selected).some(Boolean) ? 'yellow' : 'green';
}
const TIER_COLOR = { green:'var(--green)', yellow:'var(--amber)', red:'var(--red)' };

/* ── Instant-tooltip wrapper ─────────────────────────────────────────────
   `title` attribute has browser-imposed ~500 ms delay. This component
   shows the tooltip synchronously on mouseenter via a small absolutely-
   positioned div, so there's zero delay.
*/
function InstantTooltip({tip,children,style={}}){
  const[show,setShow]=useState(false);
  const[pos,setPos]=useState({x:0,y:0});
  return e('span',{style:{position:'relative',display:'inline-flex',...style},
    onMouseEnter:ev=>{const r=ev.currentTarget.getBoundingClientRect();setPos({x:ev.clientX-r.left,y:-28});setShow(true);},
    onMouseLeave:()=>setShow(false)},
    children,
    show&&tip&&e('div',{style:{position:'absolute',left:pos.x,top:pos.y,
      background:'rgba(17,24,39,.92)',color:'#fff',fontSize:10,fontFamily:'var(--font-mono)',
      padding:'4px 8px',borderRadius:6,whiteSpace:'pre',zIndex:9999,pointerEvents:'none',
      transform:'translateX(-50%)',boxShadow:'0 2px 8px rgba(0,0,0,.3)',lineHeight:1.5}},tip)
  );
}

/* ── auto-select logic for ScrapeDialog ─────────────────────────────────
   Returns { selected:{field:bool}, reasons:{field:string} }
   title/artist: NEVER auto-selected — too risky
   album:  auto if blank OR junk + exact match
   year:   auto if blank + any value available
   track:  auto if blank + any value available
*/
const normCmp = s => (s||'').toLowerCase().replace(/[\s\u3000()（）【】「」\-_,.]/g,'');
function autoSelectFields(file, scraped) {
  if (!scraped || !scraped.title) return { selected:{}, reasons:{} };
  const exact = scraped.match_basis === 'exact';
  const sel = {}, rsn = {};
  const JUNK = [/热歌/,/慢摇/,/合辑/,/精选\d/,/^\d+首/,/网络/];

  // Title — never auto
  sel.title = false;
  if (!scraped.title)              rsn.title = '刮削无数据';
  else if (!file.title)            rsn.title = '文件属性为空，但标题不建议自动写入，请手动确认';
  else if (normCmp(file.title)===normCmp(scraped.title)) rsn.title = '与文件属性一致';
  else                             rsn.title = '与文件属性不同，请手动确认';

  // Artist — never auto
  sel.artist = false;
  if (!scraped.artist)             rsn.artist = '刮削无数据';
  else if (!file.artist)           rsn.artist = '文件属性为空，但艺术家不建议自动写入，请手动确认';
  else if (normCmp(file.artist)===normCmp(scraped.artist)) rsn.artist = '与文件属性一致';
  else                             rsn.artist = '与文件属性不同，请手动确认';

  // Album
  const albumJunk = JUNK.some(p=>p.test(file.album||''));
  if (!scraped.album)                                  { sel.album=false; rsn.album='刮削无数据'; }
  else if (!file.album)                                { sel.album=true;  rsn.album='文件属性为空，建议写入'; }
  else if (normCmp(file.album)===normCmp(scraped.album)) { sel.album=false; rsn.album='与文件属性一致'; }
  else if (albumJunk && exact)                         { sel.album=true;  rsn.album='当前专辑名疑似非正规，精确匹配建议覆写'; }
  else if (exact)                                      { sel.album=true;  rsn.album='精确匹配，建议覆写'; }
  else                                                 { sel.album=false; rsn.album='模糊匹配，请手动确认'; }

  // Year
  if (!scraped.album_year)                              { sel.album_year=false; rsn.album_year='刮削无数据'; }
  else if (!file.album_year)                            { sel.album_year=true;  rsn.album_year='文件属性为空，建议写入'; }
  else if (file.album_year===scraped.album_year)        { sel.album_year=false; rsn.album_year='与文件属性一致'; }
  else if (exact)                                       { sel.album_year=true;  rsn.album_year=`精确匹配，建议覆写（当前: ${file.album_year}）`; }
  else                                                  { sel.album_year=false; rsn.album_year=`模糊匹配（当前: ${file.album_year} vs 刮削: ${scraped.album_year}）`; }

  // Track
  if (!scraped.track_number)                            { sel.track_number=false; rsn.track_number='刮削无数据'; }
  else if (!file.track_number)                          { sel.track_number=true;  rsn.track_number='文件属性为空，建议写入'; }
  else if (file.track_number===scraped.track_number)    { sel.track_number=false; rsn.track_number='与文件属性一致'; }
  else                                                  { sel.track_number=false; rsn.track_number=`曲目号不同（${file.track_number} vs ${scraped.track_number}），请手动确认`; }

  // Genre
  if (!scraped.genre)                                    { sel.genre=false; rsn.genre='刮削无数据'; }
  else if (!file.genre)                                  { sel.genre=true;  rsn.genre='文件属性为空，建议写入'; }
  else if (normCmp(file.genre)===normCmp(scraped.genre)) { sel.genre=false; rsn.genre='与文件属性一致'; }
  else                                                   { sel.genre=false; rsn.genre='流派不同，请手动确认'; }

  return { selected:sel, reasons:rsn };
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
  const[reasons,setReasons]=useState({});
  const[fileInfo,setFileInfo]=useState(null); // for filename + format

  function reload(){
    api.get(`/api/files/${fileId}`).then(r=>{if(r.ok)setFileInfo(r.data);});
    api.get(`/api/files/${fileId}/live-tags`).then(r=>{if(r.ok)setLiveTags(r.data);});
    api.get(`/api/files/${fileId}/scraped`).then(r=>{
      const sm=(r.ok&&r.data?.title)?r.data:null;
      setScraped(sm);
    });
  }
  useEffect(()=>{
    reload();
  },[fileId]);

  // Auto-compute field selection when live tags or scraped data change
  useEffect(()=>{
    if(liveTags&&scraped){
      const{selected,reasons:r}=autoSelectFields(liveTags,scraped);
      setSel(selected); setReasons(r);
    }
  },[liveTags?.title,scraped?.file_id]);

  async function doScrape(){
    setScraping(true);setWriteResult(null);
    const r=await api.post(`/api/files/${fileId}/scrape-single`);
    setScraping(false);
    if(r.ok){ reload(); onUpdated&&onUpdated(); }
  }
  async function doCancelScrape(){
    await api.del(`/api/files/${fileId}/scraped`);
    setScraped(null); setSel({}); setReasons({});
    onUpdated&&onUpdated();
  }
  async function doWrite(){
    setConfirmWrite(false); setWriting(true); setWriteResult(null);
    const fields={};
    for(const{key}of WRITE_FIELDS){
      if(sel[key]&&scraped[key]!==undefined&&scraped[key]!==null)
        fields[key]=scraped[key];
    }
    const r=await api.post(`/api/files/${fileId}/write-tags`,{fields});
    setWriting(false); setWriteResult(r);
    if(r.ok){ reload(); onUpdated?.(); onTagsWritten?.(); }
  }
  async function doRevert(snapshotId){
    const r=await api.post(`/api/snapshots/${snapshotId}/revert`);
    if(r.ok){ reload(); setWriteResult(null); onUpdated?.(); onTagsWritten?.(); }
    else alert('撤销失败: '+r.error);
  }

  const filename=fileInfo?fileInfo.path.split(/[\\/]/).pop():'';
  const loading=liveTags===null||scraped===undefined;
  const hasScraped=!!scraped&&!!scraped.title;
  const selCount=Object.values(sel).filter(Boolean).length;
  const canWrite=hasScraped&&selCount>0;

  // Diff color for a field
  function diffStyle(key){
    const fv=String(liveTags?.[key]||'').trim();
    const sv=String(scraped?.[key]||'').trim();
    if(!sv)              return {background:'transparent'};
    if(!fv)              return {background:'#EFF6FF'}; // missing in file → blue
    if(normCmp(fv)===normCmp(sv)) return {background:'#F0FDF4'}; // match → green
    return {background:'#FFFBEB'}; // different → amber
  }

  return e(Modal,{title:`刮削操作`,onClose,width:660},
    loading&&e('div',{style:{textAlign:'center',padding:40}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})),

    !loading&&e('div',null,

      // Filename + status bar
      e('div',{style:{marginBottom:12,padding:'8px 12px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}},
        Icon('file-music',{fontSize:13,color:'var(--tx-faint)',flexShrink:0}),
        e('span',{style:{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},filename),
        hasScraped&&e('span',{style:{fontSize:10,padding:'2px 8px',borderRadius:99,background:TIER_COLOR[scrapeStatusTier(liveTags,scraped)||'red']+'22',color:TIER_COLOR[scrapeStatusTier(liveTags,scraped)||'red'],border:'0.5px solid '+TIER_COLOR[scrapeStatusTier(liveTags,scraped)||'red'],whiteSpace:'nowrap'}},
          {green:'精确匹配 · 完整',yellow:'精确匹配 · 有缺失',red:'模糊匹配'}[scrapeStatusTier(liveTags,scraped)]||'已刮削')
      ),

      // Action buttons row
      e('div',{style:{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}},
        e(Btn,{icon:scraping?'loader':'cloud-download',disabled:scraping||writing,
          onClick:doScrape},scraping?'刮削中...':hasScraped?'重新刮削':'开始刮削'),
        hasScraped&&e(Btn,{icon:'x',variant:'ghost',disabled:scraping||writing,
          onClick:doCancelScrape},'取消刮削'),
      ),

      // ── Comparison table ──────────────────────────────────────────────
      hasScraped&&e('div',{style:{marginBottom:14}},
        e('div',{style:{display:'grid',gridTemplateColumns:'72px 1fr 1fr',fontSize:11,borderRadius:'var(--r-md)',overflow:'hidden',border:'0.5px solid var(--bd-default)'}},
          // Header
          ...['字段','文件属性（实际）','刮削数据'].map((h,i)=>e('div',{key:h,style:{padding:'7px 10px',background:'var(--bg-subtle)',fontWeight:600,color:'var(--tx-secondary)',borderBottom:'0.5px solid var(--bd-default)',borderRight:i<2?'0.5px solid var(--bd-subtle)':'none'}},h)),
          // Rows
          ...WRITE_FIELDS.map(({key,label})=>{
            // Numeric fields like album_year and track_number: 0 means "empty"
            const fv = (liveTags?.[key] || 0) > 0 ? String(liveTags[key]) : (liveTags?.[key] && liveTags[key] !== 0 ? String(liveTags[key]) : '');
            const sv = (scraped?.[key] || 0) > 0 ? String(scraped[key]) : (scraped?.[key] && scraped[key] !== 0 ? String(scraped[key]) : '');
            const ds=diffStyle(key);
            return [
              e('div',{key:key+'l',style:{padding:'7px 10px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:'0.5px solid var(--bd-subtle)',color:'var(--tx-faint)',background:'var(--bg-subtle)'}},label),
              e('div',{key:key+'f',style:{padding:'7px 10px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:'0.5px solid var(--bd-subtle)',color:'var(--tx-primary)',fontFamily:'var(--font-mono)',fontSize:10,...ds}},fv||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—')),
              e('div',{key:key+'s',style:{padding:'7px 10px',borderBottom:'0.5px solid var(--bd-subtle)',color:'var(--tx-primary)',fontFamily:'var(--font-mono)',fontSize:10,...ds}},sv||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—')),
            ];
          }).flat()
        )
      ),

      // ── Write to file section ─────────────────────────────────────────
      hasScraped&&e('div',{style:{borderTop:'0.5px solid var(--bd-default)',paddingTop:14}},
        e('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:10}},
          Icon('pencil',{fontSize:13,color:'var(--tx-secondary)'}),'写入文件'
        ),

        // Field checkboxes with reasons
        WRITE_FIELDS.map(({key,label})=>{
          const rawSv=scraped?.[key];
          const rawFv=liveTags?.[key];
          // For numeric fields (album_year, track_number), 0 means "no data"
          const sv = rawSv != null && rawSv !== 0 && rawSv !== '' ? rawSv : null;
          const fv = rawFv != null && rawFv !== 0 && rawFv !== '' ? rawFv : null;
          const disabled=!sv;
          const rec=sel[key];
          return e('label',{key,style:{display:'flex',alignItems:'flex-start',gap:8,padding:'5px 0',cursor:disabled?'default':'pointer',opacity:disabled?.4:1}},
            e('input',{type:'checkbox',checked:!!sel[key],disabled,
              onChange:ev=>setSel(p=>({...p,[key]:ev.target.checked})),
              style:{marginTop:2,flexShrink:0,accentColor:'var(--amber)'}}),
            e('div',{style:{flex:1,minWidth:0}},
              e('div',{style:{fontSize:12,fontWeight:rec?600:400,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4}},
                label,
                rec&&e('span',{style:{fontSize:10,color:'var(--amber)',fontWeight:400}},'推荐'),
                !!sv&&!!fv&&normCmp(String(fv))!==normCmp(String(sv))&&e('span',{style:{fontSize:10,color:'var(--tx-faint)'}},
                  ` ${fv} → ${sv}`)
              ),
              e('div',{style:{fontSize:10,color:'var(--tx-faint)'}},reasons[key]||'')
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
        e('div',{style:{background:'var(--bg-base)',borderRadius:'var(--r-xl)',padding:'24px 28px',maxWidth:400,width:'90%',boxShadow:'0 8px 32px rgba(0,0,0,.2)'}},
          e('div',{style:{fontSize:14,fontWeight:700,marginBottom:8}},'确认写入文件'),
          e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.7,marginBottom:12}},
            '将直接修改以下字段到音频文件：'),
          WRITE_FIELDS.filter(({key})=>sel[key]&&scraped[key]!=null&&scraped[key]!==0&&scraped[key]!=='').map(({key,label})=>
            e('div',{key,style:{fontSize:11,padding:'4px 8px',background:'var(--bg-subtle)',borderRadius:'var(--r-sm)',marginBottom:4,display:'flex',gap:8}},
              e('span',{style:{color:'var(--tx-faint)',width:42,flexShrink:0}},label+':'),
              e('span',{style:{fontFamily:'var(--font-mono)',color:'var(--amber)'}},String(scraped[key]))
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
    api.get(`/api/files/${fileId}/scraped`).then(r=>{if(r.ok&&r.data?.title)setScraped(r.data);});
    // Try loading cover art
    fetch(`/api/files/${fileId}/cover`).then(r=>{if(r.ok)setCoverUrl(`/api/files/${fileId}/cover`);}).catch(()=>{});
  },[fileId]);
  if(!data)return e(Modal,{title:'文件属性',onClose},e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})));
  const fpMethodLabel={spectral:'声纹（频谱指纹）',metadata:'元数据近似指纹（无法解码音频）'}[data.fingerprint_method]||'未提取';
  const rows=[['完整路径',data.path,true],['标题',data.title||'—'],['艺术家',data.artist||'—'],['专辑',data.album||'—'],['年份',data.album_year||'—'],['音轨',data.track_number||'—'],['格式',data.format||'—'],['比特率',data.bitrate?data.bitrate+'k':'—'],['采样率',data.sample_rate?(data.sample_rate/1000).toFixed(1)+' kHz':'—'],['位深',data.bits_per_sample?data.bits_per_sample+' bit':'—'],['时长',fmtDur(data.duration)],['文件大小',fmtBytes(data.size)],['修改时间',fmtDate(data.file_mtime)],['声纹方法',fpMethodLabel]];
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
    scraped&&e('div',{style:{marginTop:12,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-md)'}},
      e('div',{style:{fontSize:11,fontWeight:600,color:'#92400E',marginBottom:6,display:'flex',alignItems:'center',gap:5}},Icon('shield-check',{fontSize:13}),'刮削数据 · 来源 '+(scraped.source==='musicbrainz'?'MusicBrainz':scraped.source==='acoustid'?'AcoustID':scraped.source),
        scraped.confidence<0.85&&e('span',{style:{color:'#A16207',fontWeight:400}},`（匹配度较低 ${(scraped.confidence*100).toFixed(0)}%，请核对后再应用）`)
      ),
      [['标题',scraped.title],['艺术家',scraped.artist],['专辑',scraped.album],['年份',scraped.album_year||'']].map(([k,v])=>v?e('div',{key:k,style:{fontSize:11,color:'#92400E',display:'flex',gap:8}},e('span',{style:{color:'#A16207',width:36}},k+':'),v):null)
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
// so the library stays fast to update; a separate "智能执行" shortcut lets the
// user trigger a fuller scan without going to the 扫描 page.
function ScanDirsEditor({dirs=[],onAddDir,onRemoveDir,onEnumOnly,compact}){
  const[newDir,setNewDir]=useState('');
  const[browsing,setBrowsing]=useState(false);
  const[err,setErr]=useState('');
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
      e('button',{onClick:()=>onRemoveDir(i),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:'2px 4px',borderRadius:'var(--r-sm)'}},Icon('x',{fontSize:13}))
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
    onEnumOnly&&e('div',{style:{display:'none'}}) // button removed — caller decides when to show banner
  );
}

/* ══════════════════════════════════════════════════════════════════════
   LIBRARY VIEW
   ══════════════════════════════════════════════════════════════════════ */
const LibraryView=React.memo(function LibraryView({player,dirs,onAddDir,onRemoveDir,onEnumOnly,onLocate,mainScrollRef,onWhitelistChange,onTagsWritten}){
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
  // Per-row locator: the library renders rows with data-fileid attr so
  // the player's "locate" click can scrollIntoView the right row.
  const rowRefs=useRef({});

  function loadStats(){
    api.get('/api/library/stats').then(r=>{if(r.ok)setStats(r.data);});
  }
  useEffect(()=>{loadStats();},[]);

  function buildUrl(p,s,st,o,f,lf){
    return `/api/library?page=${p}&limit=${PAGE}&search=${encodeURIComponent(s)}&sort=${st}&order=${o}&format=${f}&libFilter=${lf}`;
  }

  function loadFresh(s=search,st=sort,o=order,f=fmt,lf=libFilter){
    setLoading(true);setRows([]);setPage(1);setHasMore(false);    api.get(buildUrl(1,s,st,o,f,lf)).then(r=>{
      if(!r.ok)return;
      const d=r.data;
      setRows(d.rows||[]);setTotal(d.total||0);
      setHasMore((d.rows||[]).length<(d.total||0));
    }).finally(()=>{setLoading(false);loadStats();});
  }
  useEffect(()=>{loadFresh();},[sort,order,fmt,libFilter]);

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
  },[loadingMore,hasMore,rows.length,search,sort,order,fmt,libFilter,mainScrollRef]);

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

  // Expose locate function upward
  useEffect(()=>{
    if(onLocate)onLocate.setLocateInLibrary?.(fid=>{
      const el=rowRefs.current[fid];
      if(el)el.scrollIntoView({behavior:'smooth',block:'center'});
    });
  },[onLocate]);

  async function toggleWhitelist(f){
    if(f.whitelisted)await api.del(`/api/whitelist/${f.id}`);
    else await api.post(`/api/whitelist/${f.id}`);
    // Update only this row in state — no full reload
    setRows(prev=>prev.map(r=>r.id===f.id?{...r,whitelisted:f.whitelisted?0:1}:r));
    loadStats();
    onWhitelistChange?.(); // notify App → SettingsView → WhitelistSection
    setToast({msg:f.whitelisted?'已从白名单移除':'已加入白名单',type:'success'});
  }

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

  const fs=filterStats[libFilter]||filterStats.all;

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
            color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'}},
          e('option',{value:''},'全部格式'),
          ...['FLAC','MP3','M4A','OGG','WAV','AIFF'].map(f=>e('option',{key:f,value:f},f))
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
              ...[['','36px'],['标题',''],['艺术家','18%'],['专辑','16%'],['格式','72px'],['刮削','38px'],['时长','56px'],['大小','64px'],['操作','108px']].map(([h,w])=>
                e('th',{key:h,
                  onClick:['标题','艺术家','专辑','格式','时长','大小'].includes(h)?()=>toggleSort({标题:'title',艺术家:'artist',专辑:'album',格式:'format',时长:'duration',大小:'size'}[h]):undefined,
                  style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',
                    width:w||undefined,cursor:h?'pointer':undefined,userSelect:'none',whiteSpace:'nowrap'}},
                  h,['标题','艺术家','专辑','格式','时长','大小'].includes(h)&&e(SortIcon,{col:{标题:'title',艺术家:'artist',专辑:'album',格式:'format',时长:'duration',大小:'size'}[h]})
                )
              )
            )),
            e('tbody',null,rows.map((f,idx)=>{
              const isCur=player.current?.id===f.id;
              const playableQueue=rows.filter(r=>r.fingerprint).map(r=>({id:r.id,title:r.title,artist:r.artist,src:'library',rowIdx:idx}));
              return e('tr',{
                key:f.id,
                ref:el=>{if(el)rowRefs.current[f.id]=el;},
                'data-fileid':f.id,
                style:{borderBottom:'0.5px solid var(--bd-subtle)',
                  background:f.whitelisted?'var(--bg-muted)':isCur?'var(--amber-bg)':'transparent',
                  transition:'background .1s'},
                onMouseEnter:ev=>ev.currentTarget.style.background=isCur?'var(--amber-bg)':f.whitelisted?'#ECEEF0':'var(--bg-subtle)',
                onMouseLeave:ev=>ev.currentTarget.style.background=f.whitelisted?'var(--bg-muted)':isCur?'var(--amber-bg)':'transparent',
              },
                e('td',{style:{padding:'6px 8px',width:36}},
                  f.fingerprint&&e('button',{
                    onClick:()=>player.playTrack({id:f.id,title:f.title,artist:f.artist,src:'library',rowIdx:idx},playableQueue),
                    style:{background:isCur?'var(--amber)':'var(--bg-muted)',border:'none',borderRadius:'50%',width:24,height:24,
                      display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},
                    Icon(isCur&&player.playing?'pause':'play',{fontSize:11,color:isCur?'#fff':'var(--tx-muted)'}))
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
                    const tier=scrapeStatusTier(f,{title:f.scraped_title,artist:f.scraped_artist,album:f.scraped_album,album_year:f.scraped_album_year||0,track_number:f.scraped_track_number||0,genre:f.scraped_genre||null,match_basis:f.scrape_match_basis,source:f.mb_recording_id?'musicbrainz':'none'});
                    if(!tier)return null;
                    const tipLines=[
                      `刮削数据 · MusicBrainz`,
                      f.scrape_match_basis==='exact'?'精确匹配':'模糊匹配',
                      f.scraped_title&&`标题: ${f.scraped_title}`,
                      f.scraped_artist&&`艺术家: ${f.scraped_artist}`,
                      f.scraped_album&&`专辑: ${f.scraped_album}`,
                    ].filter(Boolean).join('\n');
                    return e(InstantTooltip,{tip:tipLines},
                      e('button',{onClick:()=>setScrapeTarget(f.id),style:{background:'none',border:'none',cursor:'pointer',display:'inline-flex',padding:2}},
                        Icon('shield-check',{fontSize:15,color:TIER_COLOR[tier]})
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
                    e(IconAction,{icon:'info-circle',title:'查看属性',onClick:()=>setPropsId(f.id)}),
                    e(IconAction,{icon:f.whitelisted?'shield-filled':'shield-plus',title:f.whitelisted?'从白名单移除':'加入白名单',active:f.whitelisted,onClick:()=>toggleWhitelist(f)})
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
  basic:  {label:'基础匹配',  sub:'',  desc:'枚举音频文件，读取文件属性（标题/艺术家/专辑/时长等）并据此比对重复。',icon:'tag',          steps:['enum','meta','match']},
  fp:     {label:'声纹匹配',  sub:'',  desc:'计算频谱指纹，作为声纹一致/相似/不同的辅助参考；不同编码或母带间的相位差异会让分数偏低，所以它不是判定重复的唯一依据。',icon:'wave-sine',     steps:['enum','meta','fp','match']},
  scrape: {label:'刮削匹配',  sub:'',  desc:'先计算声纹（供 AcoustID 使用），再从 MusicBrainz（及可选的 AcoustID）查询录音信息；两个文件命中同一条录音即视为交叉确认。需要 AcoustID Key 才能启用声纹刮削。',icon:'cloud-download',steps:['enum','meta','fp','scrape','match']},
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
    const steps=['enum','meta','fp','scrape','match'];
    if(force){setConfirm({steps,force:true,label:'完整扫描',lane:'all'});return;}
    setRunningLane('all');
    startStep(steps,false,'完整扫描');
  }

  const isDone=status.phase==='done';
  const LC={ok:'var(--green)',done:'var(--amber)',err:'var(--red)',info:'var(--tx-secondary)',sep:'var(--amber)'};

  return e('div',{className:'fade'},
    confirm&&e(ConfirmModal,{
      title:'确认强制重新执行',
      message:e('span',null,'将对「',e('b',null,confirm.label),'」执行强制全量重提取，忽略智能跳过逻辑（按修改时间/是否存在判断），所有相关文件会被重新处理，耗时会明显更长。'),
      onConfirm:()=>{setRunningLane(confirm.lane||'all');startStep(confirm.steps,confirm.force,confirm.label);},
      onClose:()=>setConfirm(null),
      danger:true,
    }),

    // 3 lanes
    e('div',{style:{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginBottom:12}},
      Object.entries(LANE_META).map(([key,lm])=>{
        const isActive=status.running&&(runningLane===key||runningLane==='all');
        return e(Card,{key,style:{border:`0.5px solid ${isActive?'var(--amber)':'var(--bd-default)'}`}},
          e('div',{style:{display:'flex',alignItems:'center',gap:9,marginBottom:10}},
            e('div',{style:{width:32,height:32,borderRadius:8,background:isActive?'var(--amber-bg)':'var(--bg-muted)',border:`1.5px solid ${isActive?'var(--amber)':'var(--bd-default)'}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
              isActive?e('i',{className:'ti ti-loader spin',style:{fontSize:14,color:'var(--amber)'}}):Icon(lm.icon,{fontSize:14,color:'var(--tx-faint)'})
            ),
            e('div',{style:{minWidth:0}},
              e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',display:'flex',alignItems:'center',gap:5}},lm.label,e(Hint,{text:lm.desc})),
              lm.sub&&e('div',{style:{fontSize:10,color:'var(--tx-faint)'}},lm.sub)
            )
          ),
          e(Btn,{onClick:()=>runLane(key,false),disabled:status.running,icon:'player-play',style:{width:'100%',justifyContent:'center'}},'智能执行'),
          e('div',{style:{marginTop:6}},
            e('button',{onClick:()=>setAdvanced(p=>({...p,[key]:!p[key]})),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',fontSize:10,display:'flex',alignItems:'center',gap:3,padding:0}},
              e('i',{className:`ti ti-chevron-${advanced[key]?'up':'down'}`,style:{fontSize:11}}),'高级'
            ),
            advanced[key]&&e('button',{onClick:()=>runLane(key,true),disabled:status.running,title:'忽略缓存，重新处理全部相关文件',style:{marginTop:6,width:'100%',padding:'5px 6px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--bg-muted)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.5:1,display:'flex',alignItems:'center',gap:4,justifyContent:'center'}},Icon('refresh',{fontSize:11}),'强制重新执行')
          )
        );
      })
    ),

    // Full pipeline control
    e(Card,{style:{marginBottom:12}},
      e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}},
        e('div',null,e('div',{style:{fontSize:13,fontWeight:600,marginBottom:2,display:'flex',alignItems:'center'}},'智能执行全部',e(Hint,{text:'依次执行枚举 → 文件属性 → 声纹 → 刮削 → 匹配，按文件修改时间与是否存在自动跳过未变更/已删除的文件。'})),
        e('div',{style:{fontSize:11,color:'var(--tx-faint)'}},'三条匹配通道一次性全部完成')),
        e('div',{style:{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}},
          e(Btn,{icon:'radar',onClick:()=>runAll(false),disabled:status.running},'智能执行全部'),
          status.running&&e(Btn,{variant:'ghost',icon:status.paused?'player-play':'pause',onClick:()=>(status.paused?scan.resume():scan.pause())},status.paused?'继续':'暂停'),
          status.running&&e(Btn,{variant:'danger',icon:'player-stop',onClick:()=>api.post('/api/scan/abort')},'停止')
        )
      ),
      e('div',{style:{marginTop:8}},
        e('button',{onClick:()=>setAdvanced(p=>({...p,all:!p.all})),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',fontSize:10,display:'flex',alignItems:'center',gap:3,padding:0}},
          e('i',{className:`ti ti-chevron-${advanced.all?'up':'down'}`,style:{fontSize:11}}),'高级'
        ),
        advanced.all&&e('button',{onClick:()=>runAll(true),disabled:status.running,style:{marginTop:6,padding:'5px 10px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--bg-muted)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.5:1,display:'flex',alignItems:'center',gap:4}},Icon('refresh',{fontSize:11}),'强制全量重扫')
      )
    ),

    // Progress
    status.phase!=='idle'&&e('div',{style:{background:'var(--bg-base)',border:`0.5px solid ${status.paused?'var(--amber-bd)':'var(--bd-default)'}`,borderRadius:'var(--r-lg)',padding:'12px 16px',marginBottom:10,boxShadow:'var(--sh-xs)'}},
      e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}},
        e('span',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:6}},
          status.paused&&Icon('pause',{fontSize:12,color:'var(--amber)'}),
          status.paused?'已暂停':({idle:'就绪',enum:'文件枚举',meta:'文件属性提取',fp:'声纹提取',matching:'相似度匹配',scrape:'元数据刮削',done:'完成 ✓',error:'错误',aborted:'已中止'}[status.phase]||status.phase)
        ),
        e('span',{style:{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--amber)'}},(status.pct||0)+'%')
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
        height:'calc(100vh - 520px)',minHeight:180,maxHeight:'calc(100vh - 300px)',
        overflowY:'auto'}},
        logs.length===0&&e('span',{style:{color:'var(--tx-faint)'}},'等待开始...'),
        logs.map((l,i)=>e('div',{key:i,style:{color:l.ty==='sep'?'var(--amber)':LC[l.ty]||'var(--tx-secondary)',fontWeight:l.ty==='sep'?600:400}},l.ty==='sep'?l.msg:e('span',null,e('span',{style:{color:'var(--bd-strong)',marginRight:8,userSelect:'none'}},'›'),l.msg))),
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
   MIDDLE: title + quality badge + (keep_reason tag inline with title on the KEPT track)
           subtitle line: artist · album | bitrate/size info
           path on hover/truncated
   RIGHT : keep-toggle button (✓ or ✗) + secondary actions
*/
function TrackRow({track,onToggle,canToggle,onWhitelist,onProps,onScrape,player,queue,isKept}){
  const keep=!!track.keep,wl=!!track.whitelisted;
  const isCur=player?.current?.id===track.id;
  const[coverErr,setCoverErr]=useState(false);
  const bd=wl?'var(--bd-default)':keep?'var(--green-bd)':'var(--red-bd)';
  const bg=wl?'var(--bg-muted)':keep?'var(--green-bg)':'var(--red-bg)';

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
          Icon(isCur&&player.playing?'pause':'play',{fontSize:12,color:isCur?'#fff':'var(--tx-muted)'})
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
          wl&&e(Tag,{children:'白名单',color:'var(--tx-faint)'}),
          track.release_type==='single'&&e(Tag,{children:'单曲'}),
          // Decision reason tag inline with title ON THE KEPT TRACK ONLY
          isKept&&track.keep_reason&&e('span',{
            style:{fontSize:10,padding:'1px 7px',borderRadius:3,background:'var(--green-bg)',
              color:'var(--green)',border:'0.5px solid var(--green-bd)',whiteSpace:'nowrap',flexShrink:0}},
            '✓ '+track.keep_reason
          )
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

      // ── RIGHT: keep toggle + actions ─────────────────────────────────
      e('div',{style:{display:'flex',alignItems:'center',gap:4,flexShrink:0}},
        e(IconAction,{icon:'cloud-download',title:'刮削操作',onClick:onScrape}),
        e(IconAction,{icon:'folder-open',title:'打开所在目录',onClick:()=>api.post(`/api/files/${track.id}/reveal`)}),
        e(IconAction,{icon:'info-circle',title:'文件属性',onClick:onProps}),
        e(IconAction,{icon:wl?'shield-filled':'shield-plus',title:wl?'移除白名单':'加入白名单',active:wl,onClick:onWhitelist}),
        // Keep / discard toggle — right side, prominent
        e('button',{
          onClick:canToggle&&!wl?onToggle:undefined,
          title:wl?'已加入白名单':canToggle?(keep?'标记为删除（点击切换）':'标记为保留（点击切换）'):'至少保留一个',
          style:{background:wl?'var(--bg-muted)':keep?'var(--green)':'var(--red)',
            border:'none',borderRadius:'var(--r-md)',width:32,height:32,
            display:'flex',alignItems:'center',justifyContent:'center',
            cursor:canToggle&&!wl?'pointer':'default',flexShrink:0,marginLeft:2,
            opacity:(!canToggle||wl)?.5:1}},
          Icon(wl?'shield-check':keep?'check':'x',{fontSize:15,color:'#fff'})
        )
      )
    )
  );
}

// Session-level "don't ask again" flag for keep-toggle confirm
// (stored outside component so it survives re-renders but resets on page reload)
let _keepToggleSkipConfirm=false;

const DuplicatesView=React.memo(function DuplicatesView({setPendingCount,player,scanDoneKey}){
  const[filter,setFilter]=useState('pending');
  const[sort,setSort]=useState('savings');
  const[groups,setGroups]=useState([]);
  const[tagFilter,setTagFilter]=useState(new Set());
  const[search,setSearch]=useState('');
  const[selId,setSelId]=useState(null);
  const[keepConfirm,setKeepConfirm]=useState(null); // {groupId,fileId,currentKeep,tracks}
  const[detail,setDetail]=useState(null);
  const[detailLoading,setDetailLoading]=useState(false);
  const[listLoading,setListLoading]=useState(true);
  const[toast,setToast]=useState(null);
  const[showBatch,setShowBatch]=useState(false);
  const[propsId,setPropsId]=useState(null);
  const[scrapeId,setScrapeId]=useState(null);
  const prevScanDoneKey=useRef(0);

  function loadList(){
    setListLoading(true);
    const q=filter==='all'?'':filter==='pending'?'?resolved=0':'?resolved=1';
    api.get('/api/duplicates'+q).then(r=>{
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
  // Reload list whenever a scan completes (scanDoneKey increments from App)
  useEffect(()=>{
    if(scanDoneKey>0&&scanDoneKey!==prevScanDoneKey.current){
      prevScanDoneKey.current=scanDoneKey;
      loadList();
    }
  },[scanDoneKey]);
  useEffect(()=>{
    if(!selId)return;
    setDetailLoading(true);
    api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);}).finally(()=>setDetailLoading(false));
  },[selId]);

  const allTags=useMemo(()=>{
    const s=new Set();
    groups.forEach(g=>(g.match_tags||'').split(',').filter(Boolean).forEach(t=>s.add(t)));
    return [...s];
  },[groups]);

  const visibleGroups=useMemo(()=>{
    let list=groups;
    if(tagFilter.size){
      list=list.filter(g=>{
        const tags=new Set((g.match_tags||'').split(',').filter(Boolean));
        return[...tagFilter].every(t=>tags.has(t));
      });
    }
    const q=search.trim().toLowerCase();
    if(q){
      list=list.filter(g=>(g.keep_title||'').toLowerCase().includes(q)||(g.keep_artist||'').toLowerCase().includes(q));
    }
    return list;
  },[groups,tagFilter,search]);

  function toggleTagFilter(tag){setTagFilter(prev=>{const n=new Set(prev);n.has(tag)?n.delete(tag):n.add(tag);return n;});}

  async function resolve(id){
    const r=await api.post('/api/duplicates/'+id+'/resolve');
    if(r.ok){setToast({msg:`已处理，删除 ${r.deleted?.length||0} 个文件`,type:'success'});loadList();if(detail?.id===id)setDetail(d=>d?{...d,resolved:1}:d);setPendingCount(n=>Math.max(0,(n||1)-1));}
    else setToast({msg:'操作失败: '+(r.error||''),type:'error'});
  }
  async function resolveAll(){setShowBatch(false);const r=await api.post('/api/duplicates/resolve-all');if(r.ok){setToast({msg:`批量完成，删除 ${r.deletedCount} 个文件`,type:'success'});loadList();setPendingCount(0);}else setToast({msg:'失败',type:'error'});}
  async function toggleTrack(gid,fid,keep,reason){const r=await api.put(`/api/duplicates/${gid}/tracks/${fid}/keep`,{keep,reason});if(r.ok)setDetail(r.data);}
  // Guard for keep-toggle: ensures at least one non-whitelisted keep remains,
  // shows a confirm dialog (with "don't ask again this session" checkbox).
  function onTrackToggle(groupId,fileId,currentKeep,tracks){
    const nonWlKeeps=(tracks||[]).filter(t=>t.keep&&!t.whitelisted&&t.id!==fileId);
    if(currentKeep&&nonWlKeeps.length===0)return; // would leave zero kept files — block
    if(_keepToggleSkipConfirm){ toggleTrack(groupId,fileId,!currentKeep,!currentKeep?'手动指定保留':'手动指定删除'); return; }
    setKeepConfirm({groupId,fileId,currentKeep,tracks});
  }
  async function handleWL(fileId,isWl,groupId){
    isWl?await api.del(`/api/whitelist/${fileId}`):await api.post(`/api/whitelist/${fileId}`);
    const r=await api.get('/api/duplicates/'+groupId);
    if(r.ok)setDetail(r.data);
    setToast({msg:isWl?'已从白名单移除':'已加入白名单',type:'success'});
  }

  const pending=groups.filter(g=>!g.resolved);
  // BUG FIX: compute savings from the VISIBLE (filtered) pending groups,
  // not from all pending groups — so the count/bytes update when the user
  // applies a tag or search filter (previously showed unfiltered total always).
  const visiblePending=visibleGroups.filter(g=>!g.resolved);
  const savings=visiblePending.reduce((a,g)=>a+(g.savings_bytes||0),0);

  const GH='calc(100vh - 260px)';

  return e('div',{className:'fade'},
    scrapeId&&e(ScrapeDialog,{fileId:scrapeId,onClose:()=>setScrapeId(null),
      onUpdated:()=>{if(selId){api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);});}},
      onTagsWritten:()=>{}}),
    keepConfirm&&e('div',{style:{position:'fixed',inset:0,zIndex:900,background:'rgba(0,0,0,.45)',display:'flex',alignItems:'center',justifyContent:'center'},
      onClick:ev=>{if(ev.target===ev.currentTarget)setKeepConfirm(null);}},
      e('div',{className:'fade',style:{background:'var(--bg-base)',borderRadius:'var(--r-xl)',padding:'24px 28px',maxWidth:380,width:'90%',boxShadow:'0 8px 32px rgba(0,0,0,.18)'}},
        e('div',{style:{fontSize:14,fontWeight:700,marginBottom:8}},keepConfirm.currentKeep?'标记为删除？':'标记为保留？'),
        e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.7,marginBottom:16}},
          keepConfirm.currentKeep?'将此曲目标记为「删除」。智能决策保留的其他曲目不受影响。':'将此曲目也标记为「保留」。同组可以同时有多首保留曲目。'
        ),
        e('label',{style:{display:'flex',alignItems:'center',gap:8,fontSize:11,color:'var(--tx-faint)',marginBottom:18,cursor:'pointer'}},
          e('input',{type:'checkbox',onChange:ev=>{_keepToggleSkipConfirm=ev.target.checked;}}),
          '本次打开不再提示'
        ),
        e('div',{style:{display:'flex',gap:8,justifyContent:'flex-end'}},
          e(Btn,{variant:'ghost',onClick:()=>setKeepConfirm(null)},'取消'),
          e(Btn,{onClick:()=>{const{groupId,fileId,currentKeep}=keepConfirm;setKeepConfirm(null);toggleTrack(groupId,fileId,!currentKeep,!currentKeep?'手动指定保留':'手动指定删除');}},keepConfirm.currentKeep?'确认删除':'确认保留')
        )
      )
    ),
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    propsId&&e(PropsModal,{fileId:propsId,onClose:()=>setPropsId(null)}),

    // F6: filter label and tag buttons share one flex row — no line break
    allTags.length>0&&e('div',{style:{marginBottom:10,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}},
      e('span',{style:{fontSize:11,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}},Icon('filter',{fontSize:12}),'按匹配类型筛选（可多选）：'),
      allTags.map(tag=>{
        const[col,bg,bd]=TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
        const active=tagFilter.has(tag);
        return e('button',{key:tag,onClick:()=>toggleTagFilter(tag),title:MATCH_TAG_DESCRIPTIONS[tag]||'',style:{padding:'3px 10px',borderRadius:99,fontSize:11,fontWeight:active?600:400,cursor:'pointer',border:`1px solid ${active?col:bd}`,background:active?bg:'var(--bg-base)',color:active?col:'var(--tx-muted)',transition:'all .12s'}},MATCH_TAG_LABELS[tag]||tag);
      }),
      tagFilter.size>0&&e('button',{onClick:()=>setTagFilter(new Set()),style:{padding:'3px 10px',borderRadius:99,fontSize:11,cursor:'pointer',border:'1px solid var(--bd-default)',background:'var(--bg-base)',color:'var(--tx-faint)'}},'清除筛选')
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
      filter!=='done'&&visiblePending.length>0&&e('div',{style:{display:'flex',gap:8,alignItems:'center'}},
        e('span',{style:{fontSize:11,color:'var(--tx-faint)'}},`${visiblePending.length} 组 · ${fmtBytes(savings)}`),
        e(Btn,{onClick:()=>setShowBatch(true),icon:'checks',small:true},'批量确认全部')
      )
    ),

    showBatch&&e('div',{className:'fade',style:{background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)',padding:'12px 16px',marginBottom:10,display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}},
      e('div',{style:{flex:1}},e('div',{style:{fontSize:13,fontWeight:600,color:'#92400E',marginBottom:3}},'确认批量操作'),e('div',{style:{fontSize:12,color:'#A16207'}},'处理 ',e('b',null,visiblePending.length),' 个重复组，释放约 ',e('b',null,fmtBytes(savings)),'，文件移入回收站。')),
      e('div',{style:{display:'flex',gap:8}},e(Btn,{onClick:resolveAll,icon:'check'},'确认'),e(Btn,{variant:'ghost',onClick:()=>setShowBatch(false),icon:'x'},'取消'))
    ),

    e('div',{style:{display:'grid',gridTemplateColumns:'240px 1fr',gap:12,height:GH}},

      e('div',{style:{overflowY:'auto',height:'100%',paddingRight:2}},
        listLoading?e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:22}})):
        visibleGroups.length===0?e('div',{style:{color:'var(--tx-faint)',fontSize:12,padding:'20px 0',textAlign:'center',lineHeight:1.8}},(tagFilter.size||search.trim())?'当前筛选条件无结果':filter==='pending'?'无待处理组\n请先执行扫描':'暂无数据'):
        visibleGroups.map(g=>{
          const isSel=g.id===selId;
          const tags=(g.match_tags||'').split(',').filter(Boolean).slice(0,2);
          const title=g.keep_title||(detail?.id===g.id?detail.tracks?.find(t=>t.keep)?.title:null)||`组 #${g.id}`;
          const artist=g.keep_artist||(detail?.id===g.id?detail.tracks?.find(t=>t.keep)?.artist:null)||'';
          return e('div',{key:g.id,onClick:()=>setSelId(g.id),style:{padding:'10px 12px',borderRadius:'var(--r-lg)',cursor:'pointer',background:isSel?'var(--amber-bg)':'var(--bg-base)',border:`0.5px solid ${isSel?'var(--amber-bd)':'var(--bd-default)'}`,boxShadow:'var(--sh-xs)',opacity:g.resolved?.6:1,transition:'all .12s',marginBottom:4}},
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:3}},
              e('span',{style:{fontSize:12,fontWeight:600,color:isSel?'#92400E':'var(--tx-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,maxWidth:160}},title),
              !!g.resolved&&e('i',{className:'ti ti-circle-check',style:{fontSize:13,color:'var(--green)',flexShrink:0,marginLeft:4}})
            ),
            artist&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},artist),
            e('div',{style:{display:'flex',gap:4,flexWrap:'wrap'}},
              (g.savings_bytes>0)&&e('span',{style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'#FEF3C7',color:'#92400E',border:'0.5px solid #FDE68A'}},fmtBytes(g.savings_bytes)),
              tags.map(t=>e(MatchTag,{key:t,tag:t}))
            )
          );
        })
      ),

      e('div',{style:{overflowY:'auto',height:'100%',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-xs)',padding:'16px 18px'}},
        !detail||detail.id!==selId?
          e('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:10,height:'100%',color:'var(--tx-faint)',fontSize:12}},Icon('click',{fontSize:36}),'从左侧选择重复组查看详情'):
          detailLoading?e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})):
          e('div',{className:'fade'},
            // Header — F6: just tags, no extra explanation paragraph; the tag
            // itself (with hover description) carries the meaning now.
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14,gap:10}},
              e('div',{style:{flex:1,minWidth:0}},
                e('div',{style:{fontSize:15,fontWeight:700,color:'var(--tx-primary)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},detail.tracks?.find(t=>t.keep)?.title||'—'),
                e('div',{style:{fontSize:12,color:'var(--tx-muted)',marginBottom:6}},detail.tracks?.find(t=>t.keep)?.artist||''),
                e('div',{style:{display:'flex',gap:5,flexWrap:'wrap'}},
                  ...(detail.match_tags||'').split(',').filter(Boolean).map(t=>e(MatchTag,{key:t,tag:t}))
                )
              ),
              detail.resolved?e(Btn,{variant:'success',icon:'circle-check',disabled:true},'已处理'):
              e(Btn,{icon:'check',onClick:()=>resolve(detail.id)},`确认删除 ${detail.tracks?.filter(t=>!t.keep&&!t.whitelisted).length||0} 个`)
            ),

            e('div',{style:{background:'var(--bg-subtle)',borderRadius:'var(--r-md)',padding:'10px 12px',marginBottom:12}},
              e('div',{style:{fontSize:11,fontWeight:500,color:'var(--tx-faint)',marginBottom:8,display:'flex',alignItems:'center',gap:4}},Icon('chart-bar',{fontSize:12}),'文件大小对比'),
              (()=>{const mx=Math.max(...(detail.tracks||[]).map(t=>t.size||1));return(detail.tracks||[]).map(t=>e('div',{key:t.id,style:{display:'flex',alignItems:'center',gap:8,marginBottom:5}},e('div',{style:{width:90,fontSize:10,fontFamily:'var(--font-mono)',color:t.keep?'var(--green)':'var(--tx-faint)',textAlign:'right',flexShrink:0,fontWeight:t.keep?600:400}},fmtBR(t.bitrate,t.format)),e('div',{style:{flex:1,height:8,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},e('div',{style:{width:(t.size/mx*100).toFixed(1)+'%',height:'100%',background:t.keep?'var(--green)':'var(--red)',opacity:t.keep?.85:.3,borderRadius:99}})),e('div',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-faint)',width:56,flexShrink:0,textAlign:'right'}},fmtBytes(t.size))));})()
            ),

            (detail.tracks||[]).map(t=>e(TrackRow,{key:t.id,track:t,player,
              isKept:!!t.keep&&!t.whitelisted,
              queue:(detail.tracks||[]).filter(x=>x.fingerprint).map(x=>({id:x.id,title:x.title,artist:x.artist,src:'duplicates',groupId:detail.id})),
              onToggle:()=>onTrackToggle(detail.id,t.id,t.keep,detail.tracks||[]),
              canToggle:!detail.resolved,
              onWhitelist:()=>handleWL(t.id,!!t.whitelisted,detail.id),
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
   扫描目录 → 基础匹配 → 声纹匹配 → 刮削匹配 → 音质优先级 → 重复组标签 → 白名单.
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
  {id:'sec-quality', label:'音质优先级', icon:'diamond'},
  {id:'sec-tags',    label:'重复组标签', icon:'git-merge'},
  {id:'sec-wl',      label:'白名单',     icon:'shield-check'},
  {id:'sec-history', label:'写入历史',   icon:'history'},
];
const DEFAULT_Q=['Hi-Res FLAC / WAV (96kHz+)','FLAC / WAV (44.1kHz)','AIFF','M4A / AAC ≥ 256k','MP3 320k','MP3 256k','MP3 192k','OGG / Opus','MP3 128k 及以下'];
const TAG_LEGEND=['exact_copy','same_recording','fp_diff','mb_confirmed','format_diff','filename_same','metadata_same','single_vs_album','duration_near'];

function WriteHistorySection({writeHistoryKey}){
  const[rows,setRows]=useState(null);
  const[toast,setToast]=useState(null);
  const[search,setSearch]=useState('');
  function load(){api.get('/api/snapshots').then(r=>{if(r.ok)setRows(r.data||[]);});}
  useEffect(()=>{load();},[]);
  useEffect(()=>{if(writeHistoryKey>0)load();},[writeHistoryKey]);

  async function revert(fileId){
    const r=await api.post(`/api/snapshots/${fileId}/revert`);
    if(r.ok){setToast({msg:'已撤销至首次写入前的原始状态',type:'success'});load();}
    else setToast({msg:'撤销失败: '+(r.error||''),type:'error'});
  }
  async function revertAll(){
    if(!rows?.length)return;
    if(!confirm(`撤销全部 ${rows.length} 条写入历史？将恢复所有文件的原始标签。`))return;
    for(const r of rows)await api.post(`/api/snapshots/${r.file_id}/revert`);
    setToast({msg:'已全部撤销',type:'success'});load();
  }

  const q=search.trim().toLowerCase();
  const filtered=(rows||[]).filter(r=>!q||
    (r.file_title||'').toLowerCase().includes(q)||
    (r.file_artist||'').toLowerCase().includes(q)||
    (r.file_path||'').toLowerCase().includes(q));

  return e(Card,{id:'sec-history',style:{minHeight:100}},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}},
      e('div',{style:{display:'flex',alignItems:'center',gap:7}},
        Icon('history',{fontSize:15,color:'var(--amber)'}),
        e(SH,{title:`写入历史${rows?`（${rows.length} 条）`:''}`,sub:'以文件为单位，保存首次写入前的原始状态，撤销可一步恢复'})
      ),
      rows?.length>0&&e(Btn,{small:true,variant:'ghost',icon:'history',onClick:revertAll},'全部撤销')
    ),
    rows===null
      ? e('div',{style:{textAlign:'center',padding:20}},e('i',{className:'ti ti-loader spin',style:{fontSize:20}}))
      : rows.length===0
        ? e('div',{style:{textAlign:'center',padding:'24px 0',color:'var(--tx-faint)',lineHeight:2}},
            Icon('history',{fontSize:28,display:'block',margin:'0 auto 8px',color:'var(--amber)'}),
            '写入历史为空',e('br'),
            e('span',{style:{fontSize:11}},'在刮削列中写入字段后，这里会保存原始状态以供撤销')
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
                  ...['标题','艺术家','修改字段','写入次数','最近时间','操作'].map(h=>
                    e('th',{key:h,style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',whiteSpace:'nowrap',fontSize:11}},h))
                )),
                e('tbody',null, filtered.length===0
                  ? e('tr',null,e('td',{colSpan:6,style:{padding:'14px',textAlign:'center',color:'var(--tx-faint)'}},'无匹配结果'))
                  : filtered.map(r=>{
                      const fields=JSON.parse(r.modified_fields||'[]');
                      const dt=new Date(r.last_written_at);
                      const dtStr=`${dt.getMonth()+1}/${dt.getDate()} ${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}`;
                      return e('tr',{key:r.file_id,style:{borderBottom:'0.5px solid var(--bd-subtle)'}},
                        e('td',{style:{padding:'6px 10px',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:200}},
                          r.file_title||r.cur_title||'—'),
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:140}},
                          r.file_artist||r.cur_artist||'—'),
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-muted)',fontSize:11}},fields.join('、')||'—'),
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-faint)',textAlign:'center',fontSize:11}},r.write_count||1),
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:10,whiteSpace:'nowrap'}},dtStr),
                        e('td',{style:{padding:'4px 8px'}},
                          e(IconAction,{icon:'history',title:'撤销至原始状态',onClick:()=>revert(r.file_id),danger:true}))
                      );
                    })
                )
              )
            )
          )
  );
}

function WhitelistSection({player,whitelistKey}){
  const[rows,setRows]=useState([]);
  const[loading,setLoading]=useState(true);
  const[toast,setToast]=useState(null);
  const[search,setSearch]=useState('');
  function load(){setLoading(true);api.get('/api/whitelist').then(r=>{if(r.ok)setRows(r.data||[]);}).finally(()=>setLoading(false));}
  useEffect(()=>{load();},[]);
  // Refresh when Library toggles whitelist (whitelistKey increments)
  useEffect(()=>{if(whitelistKey>0)load();},[whitelistKey]);
  async function remove(id){await api.del(`/api/whitelist/${id}`);setToast({msg:'已从白名单移除',type:'success'});load();}

  const q=search.trim().toLowerCase();
  const filtered=q?rows.filter(f=>(f.title||'').toLowerCase().includes(q)||(f.artist||'').toLowerCase().includes(q)||(f.album||'').toLowerCase().includes(q)):rows;

  return e(Card,{id:'sec-wl',style:{minHeight:120}},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    e(SH,{title:`白名单（${rows.length} 个文件）`,sub:'白名单中的文件不参与重复检测'}),
    loading?e('div',{style:{textAlign:'center',padding:30,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:22}})):
    rows.length===0
      ? e('div',{style:{textAlign:'center',padding:'24px 0',color:'var(--tx-faint)',lineHeight:2}},
          Icon('shield-check',{fontSize:28,display:'block',margin:'0 auto 8px'}),
          '白名单为空',e('br'),e('span',{style:{fontSize:11}},'在"音乐库"或"重复组"中可将文件加入白名单'))
      : e('div',null,
          rows.length>0&&e('div',{style:{position:'relative',marginBottom:8}},
            Icon('search',{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--tx-faint)',pointerEvents:'none'}),
            e('input',{value:search,onChange:ev=>setSearch(ev.target.value),placeholder:'搜索标题、艺术家、专辑...',
              style:{width:'100%',paddingLeft:26,paddingRight:8,paddingTop:5,paddingBottom:5,boxSizing:'border-box',
                borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',outline:'none',fontSize:11}})
          ),
          e('div',{style:{maxHeight:'calc(100vh - 320px)',minHeight:80,overflowY:'auto',borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)'}},
            e('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:12}},
              e('thead',null,e('tr',{style:{borderBottom:'0.5px solid var(--bd-default)',background:'var(--bg-subtle)'}},
                ...['','标题','艺术家','专辑','格式','操作'].map(h=>e('th',{key:h,style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',whiteSpace:'nowrap'}},h))
              )),
              e('tbody',null,filtered.length===0
                ? e('tr',null,e('td',{colSpan:6,style:{padding:'18px',textAlign:'center',color:'var(--tx-faint)',fontSize:12}},'无匹配结果'))
                : filtered.map(f=>{
                    const isCur=player?.current?.id===f.id;
                    return e('tr',{key:f.id,style:{borderBottom:'0.5px solid var(--bd-subtle)'}},
                      e('td',{style:{padding:'6px 8px',width:36}},
                        f.fingerprint&&player&&e('button',{onClick:()=>player.playTrack({id:f.id,title:f.title,artist:f.artist}),style:{background:isCur?'var(--amber)':'var(--bg-muted)',border:'none',borderRadius:'50%',width:24,height:24,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},
                          Icon(isCur&&player.playing?'pause':'play',{fontSize:11,color:isCur?'#fff':'var(--tx-muted)'}))
                      ),
                      e('td',{style:{padding:'6px 10px',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:200}},f.title||'—'),
                      e('td',{style:{padding:'6px 10px',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160}},f.artist||'—'),
                      e('td',{style:{padding:'6px 10px',color:'var(--tx-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160,fontSize:11}},f.album||'—'),
                      e('td',{style:{padding:'6px 10px'}},e(QBadge,{format:f.format,bitrate:f.bitrate,sample_rate:f.sample_rate})),
                      e('td',{style:{padding:'4px 8px',whiteSpace:'nowrap'}},
                        e(IconAction,{icon:'library',title:'在音乐库中查看',onClick:()=>api.post(`/api/files/${f.id}/locate`,{target:'library'})}),
                        e(IconAction,{icon:'layout-sidebar',title:'在重复组中查看',onClick:()=>api.post(`/api/files/${f.id}/locate`,{target:'duplicates'})}),
                        e(IconAction,{icon:'shield',title:'移除白名单',danger:true,active:true,activeColor:'var(--red)',onClick:()=>remove(f.id)})
                      )
                    );
                  })
              )
            )
          )
        )
  );
}

function SettingsView({dirs,onAddDir,onRemoveDir,onEnumOnly,dirChanged,onMatchAffectingChange,scanRunning,player,whitelistKey,writeHistoryKey}){
  const[s,setS]=useState(null);
  const[saveState,setSaveState]=useState('idle');
  const[showExclude,setShowExclude]=useState(false);
  const[needsReapply,setNeedsReapply]=useState(false);
  const[reapplying,setReapplying]=useState(false);
  const[acoustidValidating,setAcoustidValidating]=useState(false);
  const[acoustidValidResult,setAcoustidValidResult]=useState(null); // null|{ok,error}
  const[acoustidKeyDirty,setAcoustidKeyDirty]=useState(false);
  const[needsScrapeReapply,setNeedsScrapeReapply]=useState(false);
  const[fpcalc,setFpcalc]=useState(null);
  const saveTimer=useRef(null);
  useEffect(()=>{api.get('/api/system/fpcalc').then(r=>{if(r.ok)setFpcalc(r.data);});},[]);
  const isFirst=useRef(true);
  const lastApplied=useRef(null); // {threshold, duration_tolerance, quality_tiers} snapshot as of the last manual reapply

  useEffect(()=>{
    api.get('/api/settings').then(r=>{
      if(!r.ok)return;
      const d=r.data;
      if(!d.quality_tiers||!Array.isArray(d.quality_tiers))d.quality_tiers=[...DEFAULT_Q];
      delete d.scan_dirs; // owned by App/props, not local state — avoid stale overwrite races
      setS(d);
      lastApplied.current={threshold:d.threshold,duration_tolerance:d.duration_tolerance,quality_tiers:JSON.stringify(d.quality_tiers)};
    });
  },[]);

  // F8: this only ever SAVES now — it no longer kicks off a re-match on its
  // own. A background re-match triggered by typing in Settings could still
  // be in flight when the person switched to 扫描 and clicked a lane there,
  // producing a spurious "已有扫描进行中". Applying a match-affecting change
  // is now always a deliberate, explicit click (see the reapply banner
  // below), never an automatic side effect of saving.
  useEffect(()=>{
    if(!s)return;
    if(isFirst.current){isFirst.current=false;return;}
    setSaveState('saving');clearTimeout(saveTimer.current);
    saveTimer.current=setTimeout(()=>{
      api.put('/api/settings',s).then(r=>{
        if(!r.ok){setSaveState('error');return;}
        setSaveState('saved');setTimeout(()=>setSaveState('idle'),2200);
        const qj=JSON.stringify(s.quality_tiers||[]);
        const changed = lastApplied.current && (
          lastApplied.current.threshold!==s.threshold ||
          lastApplied.current.duration_tolerance!==s.duration_tolerance ||
          lastApplied.current.quality_tiers!==qj
        );
        if(changed)setNeedsReapply(true);
      });
    },700);
    return()=>clearTimeout(saveTimer.current);
  },[s]);

  function reapply(){
    setReapplying(true);
    onMatchAffectingChange?.();
    lastApplied.current={threshold:s.threshold,duration_tolerance:s.duration_tolerance,quality_tiers:JSON.stringify(s.quality_tiers||[])};
    setNeedsReapply(false);
    setTimeout(()=>setReapplying(false),1500);
  }

  const moveQ=(i,d)=>{const q=[...(s.quality_tiers||DEFAULT_Q)];const j=i+d;if(j<0||j>=q.length)return;[q[i],q[j]]=[q[j],q[i]];setS(p=>({...p,quality_tiers:q}));};
  const resetQ=()=>setS(p=>({...p,quality_tiers:[...DEFAULT_Q]}));

  async function validateAcoustid(){
    const key=(s?.acoustid_key||'').trim();
    if(!key)return;
    setAcoustidValidating(true);setAcoustidValidResult(null);
    try{
      const r=await api.post('/api/validate-acoustid',{key});
      setAcoustidValidResult(r);
      if(r.ok){setAcoustidKeyDirty(false);setNeedsScrapeReapply(true);}
    }catch(e){setAcoustidValidResult({ok:false,error:'网络错误'});}
    finally{setAcoustidValidating(false);}
  }

  const SI=()=>e('div',{style:{fontSize:11,height:26,display:'flex',alignItems:'center',gap:5}},
    saveState==='saving'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-loader spin',style:{fontSize:12}}),'保存中...'),
    saveState==='saved'&&e('span',{className:'fade',style:{color:'var(--green)',display:'flex',alignItems:'center',gap:4}},Icon('circle-check',{fontSize:12}),'已保存'),
    saveState==='idle'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},Icon('device-floppy',{fontSize:12}),'修改后自动保存')
  );

  function jump(id){document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});}

  if(!s)return e('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:320,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}}));

  const q=s.quality_tiers||DEFAULT_Q;

  return e('div',{className:'fade',style:{display:'grid',gridTemplateColumns:'150px 1fr',gap:18,alignItems:'start'}},

    // Left rail — one click jumps straight to the section
    e('div',{style:{position:'sticky',top:0,display:'flex',flexDirection:'column',gap:1}},
      SETTINGS_SECTIONS.map(sec=>e('button',{key:sec.id,onClick:()=>jump(sec.id),style:{display:'flex',alignItems:'center',gap:7,padding:'7px 9px',background:'none',border:'none',borderRadius:'var(--r-md)',cursor:'pointer',color:'var(--tx-secondary)',fontSize:12,textAlign:'left'},onMouseEnter:ev=>ev.currentTarget.style.background='var(--bg-muted)',onMouseLeave:ev=>ev.currentTarget.style.background='none'},
        Icon(sec.icon,{fontSize:14,color:'var(--tx-faint)'}),sec.label)),
      e('div',{style:{marginTop:8,paddingTop:8,borderTop:'0.5px solid var(--bd-subtle)'}},e(SI))
    ),

    // Right — all sections concatenated, scrollable as part of <main>
    e('div',{style:{display:'flex',flexDirection:'column',gap:14}},

      // F8: manual, explicit "apply" step for match-affecting settings.
      // Re-runs ONLY the match step — existing fingerprints/scrape data are
      // reused as-is, nothing gets re-extracted.
      needsReapply&&e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)'}},
        Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
        e('div',{style:{flex:1,fontSize:12,color:'var(--tx-secondary)'}},'声纹相似度 / 时长容差 / 音质优先级 已修改，尚未重新应用到现有重复组'),
        e(Btn,{small:true,icon:reapplying?'loader':'refresh',disabled:scanRunning||reapplying,onClick:reapply},scanRunning?'扫描进行中...':'立即重新匹配')
      ),

      dirChanged&&e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)',marginBottom:2}},
        Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
        e('div',{style:{flex:1,fontSize:12,color:'var(--tx-secondary)'}},'音乐目录已修改，建议更新音乐库（只枚举文件树，不做声纹/刮削）'),
        e(Btn,{small:true,icon:'refresh',disabled:scanRunning,onClick:onEnumOnly},scanRunning?'扫描进行中...':'立即更新音乐库')
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
        e(SH,{title:'声纹匹配',hint:'声纹比对会受不同编码/母带的相位差异影响，分数可能忽高忽低，因此它只是辅助信号：标题、艺术家、时长已经一致的歌曲，即使声纹比对分数很低也仍会被判定为重复，只是会标注"声纹不同"而非"声纹一致/相似"。'}),
        e('div',null,
          e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)'}},'声纹相似度阈值'),e('span',{style:{fontSize:15,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},(s.threshold||90)+'%')),
          e('input',{type:'range',min:70,max:100,value:s.threshold||90,onChange:ev=>setS(p=>({...p,threshold:+ev.target.value}))}),
          e('div',{style:{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--tx-faint)',marginTop:3}},e('span',null,'70% 宽松'),e('span',null,'100% 精确'))
        )
      ),

      e(Card,{id:'sec-scrape'},
        e(SH,{title:'刮削匹配',hint:'刮削运行时会先计算声纹（供 AcoustID 使用），再向 MusicBrainz 查询录音信息。AcoustID 提供声纹精确匹配，MusicBrainz 提供元数据模糊搜索作为后备。'}),

        needsScrapeReapply&&e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-md)',marginBottom:12}},
          Icon('alert-circle',{fontSize:14,color:'var(--amber)',flexShrink:0}),
          e('div',{style:{flex:1,fontSize:11,color:'var(--tx-secondary)'}},'AcoustID Key 已验证，建议重新执行「刮削匹配」以应用声纹查询'),
          e(Btn,{small:true,icon:'x',variant:'ghost',onClick:()=>setNeedsScrapeReapply(false)},'知道了')
        ),

        e('div',{style:{marginBottom:12}},
          e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',marginBottom:4}},Icon('world',{marginRight:5,fontSize:13}),'MusicBrainz'),
          e('div',{style:{fontSize:11,color:'var(--tx-faint)',padding:'6px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)'}},
            Icon('check',{color:'var(--green)',marginRight:5}),'默认启用，无需配置，按文件属性精确匹配；属性极度不完整时退回标题模糊搜索。速率限制 1 次/秒。'
          )
        ),
        e('div',null,
          e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',marginBottom:6}},Icon('key',{marginRight:5,fontSize:13}),'AcoustID API Key'),
          e('div',{style:{display:'flex',gap:6}},
            e('input',{value:s.acoustid_key||'',
              onChange:ev=>{setS(p=>({...p,acoustid_key:ev.target.value}));setAcoustidKeyDirty(true);setAcoustidValidResult(null);},
              placeholder:'在 acoustid.biz 注册获取免费 API Key',
              style:{flex:1,fontSize:11,padding:'7px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',outline:'none',fontFamily:'var(--font-mono)'}}),
            acoustidKeyDirty&&(s.acoustid_key||'').trim()&&e(Btn,{small:true,variant:'ghost',icon:acoustidValidating?'loader':'circle-check',disabled:acoustidValidating,onClick:validateAcoustid},acoustidValidating?'验证中...':'验证')
          ),
          acoustidValidResult&&e('div',{style:{marginTop:5,fontSize:11,color:acoustidValidResult.ok?'var(--green)':'var(--red)',display:'flex',alignItems:'center',gap:5}},
            Icon(acoustidValidResult.ok?'circle-check':'alert-circle',{fontSize:12}),
            acoustidValidResult.ok?'API Key 有效✓':'验证失败: '+(acoustidValidResult.error||'')
          ),
          e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:4}},'选填。配置后刮削时会用声纹指纹向 AcoustID 查询，比纯文本搜索更准确'),
          fpcalc&&e('div',{style:{marginTop:6,fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',
            background:fpcalc.available?'var(--green-bg)':'var(--bg-muted)',
            border:`0.5px solid ${fpcalc.available?'var(--green-bd)':'var(--bd-default)'}`,
            color:fpcalc.available?'var(--green)':'var(--tx-faint)',display:'flex',gap:5,alignItems:'flex-start'}},
            Icon(fpcalc.available?'circle-check':'info-circle',{fontSize:12,flexShrink:0,marginTop:1}),
            fpcalc.available?`fpcalc 已就绪：AcoustID 声纹指纹将在下次声纹提取时自动生成`:
              '未检测到 fpcalc。请将 fpcalc 可执行文件放入项目根目录，或安装 Chromaprint 工具包，再重新提取声纹即可启用 AcoustID 声纹匹配。详见 acoustid.org/chromaprint'
          )
        )
      ),

      e(Card,{id:'sec-quality'},
        e('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10}},
          e('div',{style:{flex:1}},e(SH,{title:'音质优先级',sub:'上下移动调整 — 顶部优先级最高',hint:'同一重复组中按以下顺序决定保留哪个文件：① 音质档位（按本列表顺序）优先；② 相同则选年份最早的正式专辑（合辑/精选不算首发）；③ 仍相同则本地已收藏 ≥2 首的专辑版优先于单曲版；④ 最后比较标签完整度。'})),
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

      // F-tags: every tag that can appear gets a visible description here —
      // this section IS the reference, so it's not hidden behind hover.
      e(Card,{id:'sec-tags'},
        e(SH,{title:'重复组标签说明'}),
        TAG_LEGEND.map(tag=>e('div',{key:tag,style:{display:'flex',gap:8,padding:'7px 0',borderBottom:'0.5px solid var(--bd-subtle)',alignItems:'flex-start'}},
          e(MatchTag,{tag,hideTooltip:true}),
          e('span',{style:{fontSize:11,color:'var(--tx-secondary)',lineHeight:1.6}},MATCH_TAG_DESCRIPTIONS[tag])
        ))
      ),

      e(WhitelistSection,{player,whitelistKey}),
      e(WriteHistorySection,{writeHistoryKey}),
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
            const ty=d.phase==='done'?'done':d.phase==='error'?'err':d.pct>=85?'ok':'info';
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
  function startStep(steps,force=false,label){
    addSeparator(`${label||'扫描'} · ${force?'强制全量':'智能模式'}`);
    api.post('/api/scan/start',{steps,force}).then(r=>{if(!r.ok)addSeparator(`⚠ 启动失败：${r.error||''}`);});
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
   扫描 swapped from before); 白名单 folded into 设置, no longer a top tab.
   扫描目录 (scan_dirs) is lifted here so LibraryView's empty state and
   Settings' 扫描目录 section are reading/writing the exact same data.
   ══════════════════════════════════════════════════════════════════════ */
function App(){
  const[view,setView]=useState('library');
  const[pending,setPending]=useState(0);
  const[settings,setSettingsState]=useState(null);
  const[scanDoneKey,setScanDoneKey]=useState(0);
  const[whitelistKey,setWhitelistKey]=useState(0);
  const[writeHistoryKey,setWriteHistoryKey]=useState(0);
  const player=useGlobalPlayer();

  function refreshStats(){
    api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPending(r.data.dupGroups||0);});
    // Signal DuplicatesView to reload its list
    setScanDoneKey(k=>k+1);
  }
  const scan=useScanStream(refreshStats);

  useEffect(()=>{
    refreshStats();
    api.get('/api/settings').then(r=>{if(r.ok)setSettingsState(r.data);});
  },[]);

  // Stable identities — required for React.memo on LibraryView/DuplicatesView
  // to actually take effect (an inline arrow prop would defeat memo on every
  // render regardless of how stable everything else is).
  const addScanDirNav=useCallback(dir=>{
    setSettingsState(p=>{
      const cur=p?.scan_dirs||[];
      if(cur.includes(dir))return p;
      const next=[...cur,dir];
      api.put('/api/settings',{scan_dirs:next});
      scan.startStep(['enum','meta','fp','match'],false,'扫描目录更新');
      return{...(p||{}),scan_dirs:next};
    });
    setView('scanner');
  },[scan]);
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
  // F8: this used to fire automatically (debounced) whenever 声纹相似度/
  // 时长容差/音质优先级 changed — but that background re-match could still
  // be running when the person then manually triggered a lane on the 扫描
  // page, producing a spurious "已有扫描进行中" and confusing log output.
  // It is now ONLY called from a manual button in SettingsView, and only
  // re-runs the match step (existing fingerprints/scrape data are reused,
  // nothing gets re-extracted).
  const onMatchAffectingChange=useCallback(()=>{
    scan.startStep(['match'],false,'设置变更后重新匹配');
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

  // Ref for the locate-in-library scroll function set by LibraryView
  const locateInLibraryRef=useRef(null);
  const mainScrollRef=useRef(null); // ref to the <main> scroll container, shared with LibraryView
  // Called when user clicks the info panel in PlayerBar
  const handleLocate=useCallback(track=>{
    if(!track)return;
    if(track.src==='duplicates'||track.groupId){
      setView('duplicates');
      return;
    }
    // Library: switch to library tab and scroll to the row
    setView('library');
    if(track.id&&locateInLibraryRef.current){
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
    e('main',{ref:mainScrollRef,style:{flex:1,overflowY:'auto',display:'flex',justifyContent:'center'}},
      e('div',{style:{width:'100%',maxWidth:'var(--max-width)',padding:20}},
        e('div',{style:{display:view==='library'?'block':'none'}},e(LibraryView,{player:player.lite,dirs,onAddDir:addScanDirNav,onRemoveDir:removeScanDir,onEnumOnly:()=>{scan.startStep(['enum'],false,'音乐库更新');setView('scanner');},onLocate:{setLocateInLibrary:fn=>{locateInLibraryRef.current=fn;}},mainScrollRef,onWhitelistChange:()=>setWhitelistKey(k=>k+1),onTagsWritten:()=>setWriteHistoryKey(k=>k+1)})),
        e('div',{style:{display:view==='duplicates'?'block':'none'}},e(DuplicatesView,{setPendingCount:setPending,player:player.lite,scanDoneKey})),
        e('div',{style:{display:view==='scanner'?'block':'none'}},e(ScannerView,{scan})),
        e('div',{style:{display:view==='settings'?'block':'none'}},e(SettingsView,{dirs,onAddDir:addScanDirOnly,onRemoveDir:removeScanDir,dirChanged:!!settings?._dirChanged,onEnumOnly:()=>{scan.startStep(['enum'],false,'音乐库更新');setSettingsState(p=>({...(p||{}),_dirChanged:false}));},onMatchAffectingChange,scanRunning:scan.status.running,player:player.lite,whitelistKey,writeHistoryKey}))
      )
    ),
    // PlayerBar in normal flow — pushes content up, never overlaps.
    e(PlayerBar,{player,onLocate:handleLocate})
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(e(App));
