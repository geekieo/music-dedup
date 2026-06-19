'use strict';
const {useState,useEffect,useRef,useMemo,useCallback}=React;
const e=React.createElement;

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

const MATCH_TAG_LABELS={exact_copy:'声纹完全一致',same_recording:'声纹高度相似',format_diff:'格式差异',quality_diff:'音质差异',filename_same:'文件名相同',metadata_same:'标题/艺术家一致',single_vs_album:'单曲vs专辑',duration_near:'时长基本一致',meta_confirmed:'元数据判定',mb_confirmed:'MusicBrainz确认'};
const TAG_COLORS={exact_copy:['#065F46','#D1FAE5','#A7F3D0'],same_recording:['#1E40AF','#DBEAFE','#BFDBFE'],format_diff:['#5B21B6','#EDE9FE','#DDD6FE'],quality_diff:['#92400E','#FEF3C7','#FDE68A'],filename_same:['#1D4ED8','#DBEAFE','#BFDBFE'],metadata_same:['#0F766E','#CCFBF1','#99F6E4'],single_vs_album:['#9A3412','#FEE2E2','#FECACA'],duration_near:['#6B7280','#F3F4F6','#E5E7EB'],meta_confirmed:['#92400E','#FFFBEB','#FDE68A'],mb_confirmed:['#7C3AED','#EDE9FE','#DDD6FE']};

/* ── Icon system ──────────────────────────────────────────────────────
   Previously every icon was a tabler-icons-webfont glyph loaded from a
   CDN. On networks where that CDN is slow/blocked (a likely cause of the
   reported "play button shows blank" bug — the icon font simply never
   downloaded), every single icon in the app silently disappears. These
   are self-contained inline SVGs: zero network dependency, ever. */
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

/* ── Global persistent player ───────────────────────────────────────────
   The previous per-view player only mounted <audio> AFTER the first click,
   so audioRef.current was null on that very first click — the root cause
   of "play needs to be clicked twice". Here <audio> is mounted once, for
   the lifetime of the app, in App() itself — fixing that bug and letting
   playback continue uninterrupted while switching tabs. */
function useGlobalPlayer(){
  const[current,setCurrent]=useState(null);   // {id,title,artist}
  const[playing,setPlaying]=useState(false);
  const[progress,setProgress]=useState(0);
  const[duration,setDuration]=useState(0);
  const audioRef=useRef(null);

  useEffect(()=>{
    if(!current)return;
    const el=audioRef.current;
    if(!el)return;
    el.src=`/api/files/${current.id}/stream`;
    setProgress(0);
    el.play().catch(()=>{});
  },[current?.id]);

  function playTrack(track){
    if(current&&current.id===track.id){
      const el=audioRef.current;
      if(el)el.paused?el.play().catch(()=>{}):el.pause();
      return;
    }
    setCurrent(track);
  }
  function toggle(){const el=audioRef.current;if(!el)return;el.paused?el.play().catch(()=>{}):el.pause();}
  function seek(t){const el=audioRef.current;if(el)el.currentTime=t;}
  function close(){const el=audioRef.current;setCurrent(null);setPlaying(false);if(el){el.pause();el.removeAttribute('src');el.load();}}

  return{
    current,playing,progress,duration,audioRef,playTrack,toggle,seek,close,
    bind:{
      onPlay:()=>setPlaying(true),onPause:()=>setPlaying(false),onEnded:()=>setPlaying(false),
      onTimeUpdate:ev=>{setProgress(ev.target.currentTime);setDuration(ev.target.duration||0);},
    },
  };
}
function PlayerBar({player}){
  if(!player.current)return null;
  const{current,playing,progress,duration}=player;
  return e('div',{className:'fade',style:{position:'fixed',left:0,right:0,bottom:0,zIndex:200,background:'var(--bg-base)',borderTop:'0.5px solid var(--bd-default)',boxShadow:'0 -2px 10px rgba(0,0,0,.06)',padding:'9px 20px',display:'flex',alignItems:'center',gap:14}},
    e('button',{onClick:player.toggle,style:{background:'var(--amber)',border:'none',borderRadius:'50%',width:32,height:32,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',flexShrink:0}},
      Icon(playing?'pause':'play',{fontSize:14,color:'#fff'})
    ),
    e('div',{style:{flex:1,minWidth:0,maxWidth:480}},
      e('div',{style:{fontSize:12,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:4}},current.title||'—',current.artist&&e('span',{style:{color:'var(--tx-faint)',fontWeight:400}},'  ·  '+current.artist)),
      e('div',{style:{display:'flex',alignItems:'center',gap:8}},
        e('span',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-faint)',width:32}},fmtDur(progress)),
        e('div',{style:{flex:1,height:4,background:'var(--bg-muted)',borderRadius:99,cursor:'pointer',overflow:'hidden'},onClick:ev=>{if(!duration)return;const r=ev.currentTarget.getBoundingClientRect();player.seek(((ev.clientX-r.left)/r.width)*duration);}},
          e('div',{style:{width:(duration?progress/duration*100:0)+'%',height:'100%',background:'var(--amber)',borderRadius:99,transition:'width .3s'}})
        ),
        e('span',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-faint)',width:32,textAlign:'right'}},fmtDur(duration))
      )
    ),
    e('button',{onClick:player.close,style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:4,flexShrink:0}},Icon('x',{fontSize:14}))
  );
}

/* ── Shared UI ────────────────────────────────────────────────────────── */
function QBadge({format:fmt,bitrate:br,sample_rate:sr}){
  const f=(fmt||'').toUpperCase(),lo=['FLAC','WAV','AIFF','DSF'].includes(f),hi=sr&&sr>=88200;
  const[col,bg]=hi?['#065F46','#D1FAE5']:lo?['#1D4ED8','#DBEAFE']:br>=320?['#5B21B6','#EDE9FE']:br>=256?['#92400E','#FEF3C7']:['#9A3412','#FEE2E2'];
  return e('span',{style:{fontSize:10,fontWeight:600,color:col,background:bg,border:`0.5px solid ${col}30`,padding:'1px 7px',borderRadius:3,fontFamily:'var(--font-mono)',whiteSpace:'nowrap',flexShrink:0}},hi?`Hi-Res ${f}`:lo?f:`${f} ${br||'?'}k`);
}
function MatchTag({tag}){
  const[col,bg,bd]=TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
  return e('span',{style:{fontSize:10,fontWeight:500,color:col,background:bg,border:`0.5px solid ${bd}`,padding:'1px 7px',borderRadius:3,whiteSpace:'nowrap'}},MATCH_TAG_LABELS[tag]||tag);
}
function Tag({children,color='var(--tx-faint)',bg='var(--bg-muted)',border='var(--bd-default)'}){return e('span',{style:{fontSize:10,padding:'1px 7px',borderRadius:3,background:bg,color,border:`0.5px solid ${border}`,whiteSpace:'nowrap'}},children);}
function Btn({children,onClick,variant='primary',small,disabled,icon,style:sx={}}){
  const base={display:'flex',alignItems:'center',gap:5,borderRadius:'var(--r-md)',fontFamily:'var(--font-sans)',fontWeight:500,cursor:disabled?'not-allowed':'pointer',fontSize:small?11:12,padding:small?'4px 10px':'7px 14px',transition:'all .12s',border:'none',opacity:disabled?.45:1,whiteSpace:'nowrap',...sx};
  const V={primary:{...base,background:'var(--amber)',color:'#fff'},ghost:{...base,background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'},danger:{...base,background:'var(--red-bg)',color:'var(--red)',border:'0.5px solid var(--red-bd)'},success:{...base,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}};
  return e('button',{onClick:disabled?undefined:onClick,style:V[variant]||V.primary},icon&&Icon(icon,{fontSize:small?12:14}),children);
}
function Card({children,style:sx={}}){return e('div',{style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-xs)',padding:'18px 20px',...sx}},children);}
function SH({title,sub}){return e('div',{style:{marginBottom:12}},e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)'}},title),sub&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:2}},sub));}
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

/* ── Props Modal ─────────────────────────────────────────────────────── */
function PropsModal({fileId,onClose}){
  const[data,setData]=useState(null);
  const[scraped,setScraped]=useState(null);
  const[applying,setApplying]=useState(false);
  const[toast,setToast]=useState(null);
  useEffect(()=>{
    api.get(`/api/files/${fileId}`).then(r=>{if(r.ok)setData(r.data);});
    api.get(`/api/files/${fileId}/scraped`).then(r=>{if(r.ok&&r.data?.title)setScraped(r.data);});
  },[fileId]);
  if(!data)return e(Modal,{title:'文件属性',onClose},e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})));
  const fpMethodLabel={spectral:'声纹（频谱指纹）',metadata:'元数据近似指纹（无法解码音频）'}[data.fingerprint_method]||'未提取';
  const rows=[['完整路径',data.path,true],['标题',data.title||'—'],['艺术家',data.artist||'—'],['专辑',data.album||'—'],['年份',data.album_year||'—'],['音轨',data.track_number||'—'],['格式',data.format||'—'],['比特率',data.bitrate?data.bitrate+'k':'—'],['采样率',data.sample_rate?(data.sample_rate/1000).toFixed(1)+' kHz':'—'],['位深',data.bits_per_sample?data.bits_per_sample+' bit':'—'],['时长',fmtDur(data.duration)],['文件大小',fmtBytes(data.size)],['修改时间',fmtDate(data.file_mtime)],['声纹方法',fpMethodLabel]];
  async function applyScraped(){setApplying(true);const r=await api.post(`/api/files/${fileId}/apply-scraped`);setApplying(false);if(r.ok)setToast('刮削数据已应用');else setToast('应用失败: '+r.error);}
  return e(Modal,{title:'文件属性',onClose,width:560},
    toast&&e('div',{style:{padding:'8px 12px',background:'var(--green-bg)',border:'0.5px solid var(--green-bd)',borderRadius:'var(--r-md)',fontSize:12,color:'var(--green)',marginBottom:12}},toast),
    rows.map(([k,v,mono])=>e('div',{key:k,style:{display:'flex',gap:12,padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
      e('div',{style:{fontSize:11,color:'var(--tx-faint)',width:72,flexShrink:0,paddingTop:1}},k),
      e('div',{style:{fontSize:12,color:'var(--tx-primary)',fontFamily:mono?'var(--font-mono)':undefined,wordBreak:'break-all',flex:1}},String(v))
    )),
    scraped&&e('div',{style:{marginTop:12,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-md)'}},
      e('div',{style:{fontSize:11,fontWeight:600,color:'#92400E',marginBottom:6,display:'flex',alignItems:'center',gap:5}},Icon('shield-check',{fontSize:13}),'刮削数据 · 来源 '+(scraped.source==='musicbrainz'?'MusicBrainz':scraped.source==='acoustid'?'AcoustID':scraped.source),
        scraped.confidence<0.85&&e('span',{style:{color:'#A16207',fontWeight:400}},`（匹配度较低 ${(scraped.confidence*100).toFixed(0)}%，请核对后再应用）`)
      ),
      [['标题',scraped.title],['艺术家',scraped.artist],['专辑',scraped.album],['年份',scraped.album_year]].map(([k,v])=>v&&e('div',{key:k,style:{fontSize:11,color:'#92400E',display:'flex',gap:8}},e('span',{style:{color:'#A16207',width:36}},k+':'),v))
    ),
    e('div',{style:{marginTop:14,display:'flex',gap:8,flexWrap:'wrap',justifyContent:'space-between',alignItems:'center'}},
      e('div',{style:{display:'flex',gap:8}},
        e(Btn,{icon:'folder-open',small:true,variant:'ghost',onClick:()=>api.post(`/api/files/${fileId}/reveal`)},'在文件管理器中显示'),
        e(Btn,{small:true,variant:'ghost',icon:'copy',onClick:()=>navigator.clipboard?.writeText(data.path)},'复制路径')
      ),
      scraped&&e(Btn,{small:true,icon:'download',onClick:applyScraped,disabled:applying},applying?'应用中...':'应用刮削数据')
    )
  );
}

/* ══════════════════════════════════════════════════════════════════════
   LIBRARY VIEW
   ══════════════════════════════════════════════════════════════════════ */
function LibraryView({player}){
  const[stats,setStats]=useState(null);
  const[rows,setRows]=useState([]);
  const[total,setTotal]=useState(0);
  const[page,setPage]=useState(1);
  const[search,setSearch]=useState('');
  const[sort,setSort]=useState('title');
  const[order,setOrder]=useState('asc');
  const[fmt,setFmt]=useState('');
  const[loading,setLoading]=useState(false);
  const[propsId,setPropsId]=useState(null);
  const[toast,setToast]=useState(null);
  const searchTimer=useRef(null);
  const LIMIT=100;

  useEffect(()=>{api.get('/api/stats').then(r=>{if(r.ok)setStats(r.data);});},[]);

  function load(p=page,s=search,st=sort,o=order,f=fmt){
    setLoading(true);
    api.get(`/api/library?page=${p}&limit=${LIMIT}&search=${encodeURIComponent(s)}&sort=${st}&order=${o}&format=${f}`)
      .then(r=>{if(r.ok){setRows(r.data.rows||[]);setTotal(r.data.total||0);}}).finally(()=>setLoading(false));
  }
  useEffect(()=>{load();},[page,sort,order,fmt]);
  function onSearch(v){setSearch(v);clearTimeout(searchTimer.current);searchTimer.current=setTimeout(()=>{setPage(1);load(1,v);},(500));}

  function toggleSort(col){if(sort===col){setOrder(o=>o==='asc'?'desc':'asc');}else{setSort(col);setOrder('asc');}setPage(1);}
  const SortIcon=({col})=>sort===col?e('i',{className:`ti ti-arrow-${order==='asc'?'up':'down'}`,style:{fontSize:11,marginLeft:3}}):null;

  const totalPages=Math.ceil(total/LIMIT);

  async function toggleWhitelist(f){
    if(f.whitelisted){await api.del(`/api/whitelist/${f.id}`);}else{await api.post(`/api/whitelist/${f.id}`);}
    load();setToast({msg:f.whitelisted?'已从白名单移除':'已加入白名单',type:'success'});
  }

  return e('div',{className:'fade'},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    propsId&&e(PropsModal,{fileId:propsId,onClose:()=>setPropsId(null)}),

    // Stats bar
    stats&&stats.total>0&&e('div',{style:{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}},
      e(SC,{label:'总曲目',val:fmtN(stats.total),sub:fmtBytes(stats.totalBytes)}),
      e(SC,{label:'专辑',val:fmtN(stats.albums)}),
      e(SC,{label:'艺术家',val:fmtN(stats.artists)}),
      e(SC,{label:'已提取声纹',val:fmtN(stats.withFP),col:stats.withFP===stats.total?'var(--green)':'var(--amber)'}),
      stats.dupGroups>0&&e(SC,{label:'重复组',val:fmtN(stats.dupGroups),col:'var(--red)',sub:fmtBytes(stats.dupBytes)+' 可释放'}),
    ),

    // Search + filter bar
    e('div',{style:{display:'flex',gap:8,marginBottom:10,flexWrap:'wrap',alignItems:'center'}},
      e('div',{style:{position:'relative',flex:1,minWidth:200}},
        Icon('search',{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',fontSize:14,color:'var(--tx-faint)',pointerEvents:'none'}),
        e('input',{value:search,onChange:ev=>onSearch(ev.target.value),placeholder:'搜索标题、艺术家、专辑...',style:{width:'100%',paddingLeft:32,paddingRight:10,paddingTop:7,paddingBottom:7,borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',outline:'none',fontSize:12}})
      ),
      e('select',{value:fmt,onChange:ev=>{setFmt(ev.target.value);setPage(1);},style:{fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'}},
        e('option',{value:''},'全部格式'),
        ...['FLAC','MP3','M4A','OGG','WAV','AIFF'].map(f=>e('option',{key:f,value:f},f))
      ),
      e('span',{style:{fontSize:11,color:'var(--tx-faint)',whiteSpace:'nowrap'}},`${fmtN(total)} 首`)
    ),

    // Table — no inner fixed-height scroll wrapper; the outer <main> already
    // scrolls, and pagination already limits each page to 100 rows, so an
    // additional independent inner scrollbar was pure redundancy (you'd hit
    // two different scroll mechanisms stacked on top of each other).
    e('div',{style:{borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)',background:'var(--bg-base)'}},
      loading&&rows.length===0?e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}})):
      total===0?e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)',lineHeight:2}},Icon('music-off',{fontSize:32,display:'block',marginBottom:8}),'音乐库为空，请先配置目录并执行扫描'):
      e('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:12}},
        e('thead',null,e('tr',{style:{borderBottom:'0.5px solid var(--bd-default)',background:'var(--bg-subtle)',position:'sticky',top:0,zIndex:2}},
          ...[['','36px'],['标题',''],['艺术家','18%'],['专辑','16%'],['格式','72px'],['大小','64px'],['操作','120px']].map(([h,w])=>
            e('th',{key:h,onClick:h&&['标题','艺术家','专辑','格式','大小'].includes(h)?()=>toggleSort({标题:'title',艺术家:'artist',专辑:'album',格式:'format',大小:'size'}[h]):undefined,style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',width:w||undefined,cursor:h?'pointer':undefined,userSelect:'none',whiteSpace:'nowrap'}},
              h,['标题','艺术家','专辑','格式','大小'].includes(h)&&e(SortIcon,{col:{标题:'title',艺术家:'artist',专辑:'album',格式:'format',大小:'size'}[h]})
            )
          )
        )),
        e('tbody',null,rows.map(f=>{
          const isCur=player.current?.id===f.id;
          return e('tr',{key:f.id,style:{borderBottom:'0.5px solid var(--bd-subtle)',background:f.whitelisted?'var(--bg-muted)':isCur?'var(--amber-bg)':'transparent',transition:'background .1s'},onMouseEnter:ev=>ev.currentTarget.style.background=isCur?'var(--amber-bg)':f.whitelisted?'#ECEEF0':'var(--bg-subtle)',onMouseLeave:ev=>ev.currentTarget.style.background=f.whitelisted?'var(--bg-muted)':isCur?'var(--amber-bg)':'transparent'},
          e('td',{style:{padding:'6px 8px',width:36}},
            f.fingerprint&&e('button',{onClick:()=>player.playTrack({id:f.id,title:f.title,artist:f.artist}),style:{background:isCur?'var(--amber)':'var(--bg-muted)',border:'none',borderRadius:'50%',width:24,height:24,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},Icon(isCur&&player.playing?'pause':'play',{fontSize:11,color:isCur?'#fff':'var(--tx-muted)'}))
          ),
          e('td',{style:{padding:'6px 10px',maxWidth:0,overflow:'hidden'}},
            e('div',{style:{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:500,color:'var(--tx-primary)'}},f.title||'—'),
            f.scraped_title&&f.scraped_title!==f.title&&e('div',{style:{fontSize:10,color:'var(--amber)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},Icon('shield-check',{marginRight:3,fontSize:10}),f.scraped_title)
          ),
          e('td',{style:{padding:'6px 10px',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:0}},f.artist||'—'),
          e('td',{style:{padding:'6px 10px',color:'var(--tx-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:0,fontSize:11}},f.album||'—'),
          e('td',{style:{padding:'6px 10px'}},e(QBadge,{format:f.format,bitrate:f.bitrate,sample_rate:f.sample_rate})),
          e('td',{style:{padding:'6px 10px',color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:11,whiteSpace:'nowrap'}},fmtBytes(f.size)),
          e('td',{style:{padding:'4px 8px'}},
            e('div',{style:{display:'flex',gap:4}},
              e('button',{onClick:()=>api.post(`/api/files/${f.id}/reveal`),title:'在文件管理器中显示',style:{background:'none',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-sm)',cursor:'pointer',color:'var(--tx-faint)',padding:'3px 6px',fontSize:11,display:'flex',alignItems:'center',gap:3}},Icon('folder-open',{fontSize:12}),'打开'),
              e('button',{onClick:()=>setPropsId(f.id),title:'查看属性',style:{background:'none',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-sm)',cursor:'pointer',color:'var(--tx-faint)',padding:'3px 6px',fontSize:11,display:'flex',alignItems:'center',gap:3}},Icon('info-circle',{fontSize:12}),'属性'),
              e('button',{onClick:()=>toggleWhitelist(f),title:f.whitelisted?'从白名单移除':'加入白名单',style:{background:f.whitelisted?'var(--amber-bg)':'none',border:`0.5px solid ${f.whitelisted?'var(--amber-bd)':'var(--bd-default)'}`,borderRadius:'var(--r-sm)',cursor:'pointer',color:f.whitelisted?'var(--amber)':'var(--tx-faint)',padding:'3px 6px',fontSize:11,display:'flex',alignItems:'center',gap:3}},e('i',{className:`ti ti-shield${f.whitelisted?'-filled':'-plus'}`,style:{fontSize:12}}),f.whitelisted?'已白名单':'白名单')
            )
          )
        );}))
      )
    ),

    // Pagination
    totalPages>1&&e('div',{style:{display:'flex',gap:4,justifyContent:'center',alignItems:'center',marginTop:10,flexWrap:'wrap'}},
      e(Btn,{small:true,variant:'ghost',disabled:page<=1,icon:'chevron-left',onClick:()=>setPage(p=>p-1)},''),
      ...[...Array(Math.min(totalPages,7))].map((_,i)=>{
        let p;if(totalPages<=7)p=i+1;else if(page<=4)p=i+1;else if(page>=totalPages-3)p=totalPages-6+i;else p=page-3+i;
        if(p<1||p>totalPages)return null;
        return e('button',{key:p,onClick:()=>setPage(p),style:{padding:'4px 10px',borderRadius:'var(--r-sm)',border:`0.5px solid ${p===page?'var(--amber)':'var(--bd-default)'}`,background:p===page?'var(--amber)':'var(--bg-base)',color:p===page?'#fff':'var(--tx-secondary)',cursor:'pointer',fontSize:11,fontWeight:p===page?600:400}},p);
      }),
      e(Btn,{small:true,variant:'ghost',disabled:page>=totalPages,icon:'chevron-right',onClick:()=>setPage(p=>p+1)},'')
    )
  );
}

/* ══════════════════════════════════════════════════════════════════════
   SCANNER VIEW — 5 steps, progressive log (never cleared mid-session)
   ══════════════════════════════════════════════════════════════════════ */
function ScannerView({onScanDone}){
  const[status,setStatus]=useState({phase:'idle',pct:0,running:false,message:''});
  const[logs,setLogs]=useState([]);
  const[confirm,setConfirm]=useState(null);
  const logRef=useRef(null);

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
        if(d.type==='done')onScanDone?.();
      }catch{}
    };
    return()=>es.close();
  },[]);
  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[logs]);

  function addSeparator(label){
    const ts=new Date().toLocaleTimeString('zh-CN');
    setLogs(p=>[...p,{msg:`━━━ ${label} [${ts}] ━━━`,ty:'sep',ts:Date.now()}]);
  }
  function startStep(steps,force=false){
    const base=steps.length===1?(STEP_META[steps[0]]?.label||steps[0]):'完整扫描';
    const mode=force?'强制全量':'智能模式';
    addSeparator(`${base} · ${mode}`);
    api.post('/api/scan/start',{steps,force});
  }
  function tryStart(steps,force,label){
    if(force){setConfirm({steps,force,label});return;}
    startStep(steps,force);
  }

  const STEP_META={
    enum:  {label:'文件枚举',  desc:'发现所有音频文件',   icon:'folders'},
    meta:  {label:'提取元数据',desc:'解析 ID3/Vorbis 标签',icon:'tag'},
    fp:    {label:'提取声纹',  desc:'频谱指纹计算',        icon:'wave-sine'},
    match: {label:'相似度匹配',desc:'发现重复组',          icon:'circle-dashed'},
    scrape:{label:'元数据刮削',desc:'MusicBrainz / AcoustID 刮削数据',icon:'cloud-download'},
  };
  const LC={ok:'var(--green)',done:'var(--amber)',err:'var(--red)',info:'var(--tx-secondary)',sep:'var(--amber)'};
  const phaseMap={enum:'enum',meta:'meta',fp:'fp',matching:'match',scrape:'scrape'};
  const activeStep=phaseMap[status.phase];
  const isDone=status.phase==='done';

  return e('div',{className:'fade'},
    confirm&&e(ConfirmModal,{
      title:'确认重新执行',
      message:e('span',null,'将对「',e('b',null,confirm.label),'」执行强制全量重提取，忽略智能扫描，所有文件将被重新处理。'),
      onConfirm:()=>startStep(confirm.steps,confirm.force),
      onClose:()=>setConfirm(null),
    }),

    // Step cards
    e('div',{style:{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:8,marginBottom:12}},
      Object.entries(STEP_META).map(([key,sm])=>{
        const isActive=activeStep===key&&status.running;
        const wasDone=isDone||(!status.running&&status.pct>0);
        return e('div',{key,style:{background:'var(--bg-base)',border:`0.5px solid ${isActive?'var(--amber)':'var(--bd-default)'}`,borderRadius:'var(--r-lg)',padding:'12px 14px',boxShadow:'var(--sh-xs)'}},
          e('div',{style:{display:'flex',alignItems:'center',gap:8,marginBottom:8}},
            e('div',{style:{width:28,height:28,borderRadius:7,background:isActive?'var(--amber-bg)':'var(--bg-muted)',border:`1.5px solid ${isActive?'var(--amber)':'var(--bd-default)'}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
              isActive?e('i',{className:'ti ti-loader spin',style:{fontSize:13,color:'var(--amber)'}}):
              Icon(sm.icon,{fontSize:13,color:isActive?'var(--amber)':'var(--tx-faint)'})
            ),
            e('div',null,e('div',{style:{fontSize:11,fontWeight:600,color:'var(--tx-primary)',lineHeight:1.3}},sm.label),e('div',{style:{fontSize:10,color:'var(--tx-faint)',lineHeight:1.4}},sm.desc))
          ),
          key==='enum'
            ? e('div',{style:{display:'flex',gap:4}},
                e('button',{onClick:()=>tryStart([key],false,sm.label),disabled:status.running,style:{flex:1,padding:'4px 6px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--amber)',color:'#fff',border:'none',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.5:1,display:'flex',alignItems:'center',gap:3,justifyContent:'center'}},Icon('player-play',{fontSize:11}),'执行扫描')
              )
            : e('div',{style:{display:'flex',gap:4,flexWrap:'wrap'}},
                e('button',{onClick:()=>tryStart([key],false,sm.label),disabled:status.running,title:'按文件修改时间跳过未变更的文件',style:{flex:1,padding:'4px 6px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--amber)',color:'#fff',border:'none',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.5:1,display:'flex',alignItems:'center',gap:3,justifyContent:'center'}},Icon('player-play',{fontSize:11}),'智能执行'),
                e('button',{onClick:()=>tryStart([key],true,sm.label),disabled:status.running,title:'忽略缓存，重新处理全部文件',style:{flex:1,padding:'4px 6px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--bg-muted)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.5:1,display:'flex',alignItems:'center',gap:3,justifyContent:'center'}},Icon('refresh',{fontSize:11}),'强制重新执行')
              )
        );
      })
    ),

    // Full scan control
    e(Card,{style:{marginBottom:12}},
      e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}},
        e('div',null,e('div',{style:{fontSize:13,fontWeight:600,marginBottom:2}},'完整扫描'),e('div',{style:{fontSize:11,color:'var(--tx-faint)'}},'按顺序执行：枚举 → 元数据 → 声纹 → 匹配 → 刮削')),
        e('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
          e(Btn,{icon:'radar',onClick:()=>startStep(['enum','meta','fp','match','scrape'],false),disabled:status.running},'智能继续扫描'),
          e(Btn,{variant:'ghost',icon:'refresh',onClick:()=>setConfirm({steps:['enum','meta','fp','match','scrape'],force:true,label:'完整重新扫描'}),disabled:status.running},'强制全量重扫'),
          status.running&&e(Btn,{variant:'danger',icon:'player-stop',onClick:()=>api.post('/api/scan/abort')},'中止')
        )
      )
    ),

    // Progress
    status.phase!=='idle'&&e('div',{style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',padding:'12px 16px',marginBottom:10,boxShadow:'var(--sh-xs)'}},
      e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}},
        e('span',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)'}},{idle:'就绪',enum:'文件枚举',meta:'元数据提取',fp:'声纹提取',matching:'相似度匹配',scrape:'元数据刮削',done:'完成 ✓',error:'错误',aborted:'已中止'}[status.phase]||status.phase),
        e('span',{style:{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--amber)'}},(status.pct||0)+'%')
      ),
      e('div',{style:{height:5,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},
        e('div',{style:{width:(status.pct||0)+'%',height:'100%',background:'var(--amber)',borderRadius:99,transition:'width .3s'}}))
    ),

    // Log — progressive, never cleared mid-session
    e('div',{style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',overflow:'hidden',boxShadow:'var(--sh-xs)'}},
      e('div',{style:{padding:'8px 14px',borderBottom:'0.5px solid var(--bd-subtle)',background:'var(--bg-subtle)',display:'flex',alignItems:'center',justifyContent:'space-between'}},
        e('div',{style:{display:'flex',alignItems:'center',gap:6}},Icon('terminal-2',{fontSize:13,color:'var(--tx-faint)'}),e('span',{style:{fontSize:11,fontWeight:500,color:'var(--tx-muted)'}},'运行日志')),
        e('button',{onClick:()=>setLogs([]),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',fontSize:11,display:'flex',alignItems:'center',gap:4}},Icon('trash',{fontSize:12}),'清空')
      ),
      e('div',{ref:logRef,style:{padding:'10px 14px',fontFamily:'var(--font-mono)',fontSize:11.5,lineHeight:1.85,height:200,overflowY:'auto'}},
        logs.length===0&&e('span',{style:{color:'var(--tx-faint)'}},'等待开始... 历史日志在此渐进显示，执行新步骤时不会清空'),
        logs.map((l,i)=>e('div',{key:i,style:{color:l.ty==='sep'?'var(--amber)':LC[l.ty]||'var(--tx-secondary)',fontWeight:l.ty==='sep'?600:400}},l.ty==='sep'?l.msg:e('span',null,e('span',{style:{color:'var(--bd-strong)',marginRight:8,userSelect:'none'}},'›'),l.msg))),
        status.running&&e('span',{className:'blink',style:{color:'var(--amber)'}},'█')
      )
    )
  );
}

/* ══════════════════════════════════════════════════════════════════════
   DUPLICATES VIEW — F1 song names, F2 independent scroll, F3 bigger buttons, F8 match type filter
   ══════════════════════════════════════════════════════════════════════ */
function TrackRow({track,onToggle,canToggle,onWhitelist,onProps,player}){
  const keep=!!track.keep,wl=!!track.whitelisted;
  const isCur=player?.current?.id===track.id;
  return e('div',{style:{marginBottom:8,borderRadius:'var(--r-md)',border:`1px solid ${wl?'var(--bd-default)':keep?'var(--green-bd)':'var(--red-bd)'}`,background:wl?'var(--bg-muted)':keep?'var(--green-bg)':'var(--red-bg)',overflow:'hidden'}},
    // Track header
    e('div',{style:{display:'flex',alignItems:'flex-start',gap:10,padding:'10px 12px'}},
      player&&e('button',{onClick:()=>player.playTrack({id:track.id,title:track.title,artist:track.artist}),title:'试听',style:{background:isCur?'var(--amber)':'var(--bg-muted)',border:'none',borderRadius:'50%',width:24,height:24,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',flexShrink:0,marginTop:1}},
        Icon(isCur&&player.playing?'pause':'play',{fontSize:11,color:isCur?'#fff':'var(--tx-muted)'})
      ),
      e('button',{onClick:canToggle&&!wl?onToggle:undefined,title:wl?'已加入白名单':canToggle?(keep?'切换为删除':'切换为保留'):'至少保留一个',style:{background:'none',border:'none',padding:0,flexShrink:0,cursor:canToggle&&!wl?'pointer':'default',marginTop:2}},
        e('i',{className:`ti ${wl?'ti-shield-check':keep?'ti-circle-check':'ti-trash'}`,style:{fontSize:20,color:wl?'var(--tx-faint)':keep?'var(--green)':'var(--red)'}})
      ),
      e('div',{style:{flex:1,minWidth:0}},
        e('div',{style:{display:'flex',alignItems:'center',gap:6,marginBottom:4,flexWrap:'wrap'}},
          e('span',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:220}},track.title||'—'),
          e(QBadge,{format:track.format,bitrate:track.bitrate,sample_rate:track.sample_rate}),
          wl&&e(Tag,{children:'白名单',color:'var(--tx-faint)'}),
          track.release_type==='single'&&e(Tag,{children:'单曲'}),
        ),
        e('div',{style:{fontSize:11,color:'var(--tx-secondary)',marginBottom:3}},track.artist||(track.album?'专辑: '+track.album:'')),
        e('div',{style:{fontSize:10,color:'var(--tx-faint)',fontFamily:'var(--font-mono)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},track.path)
      ),
      e('div',{style:{textAlign:'right',flexShrink:0,minWidth:80}},
        e('div',{style:{fontSize:12,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',fontWeight:500,marginBottom:2}},fmtBR(track.bitrate,track.format)),
        e('div',{style:{fontSize:11,color:'var(--tx-faint)'}},fmtBytes(track.size))
      )
    ),
    // Action row — bigger, labeled buttons
    e('div',{style:{display:'flex',gap:0,borderTop:`1px solid ${keep?'var(--green-bd)':'var(--red-bd)'}`,background:keep?'rgba(5,150,105,0.05)':'rgba(220,38,38,0.05)'}},
      ...[
        {ic:'folder-open',label:'打开目录',action:()=>api.post(`/api/files/${track.id}/reveal`)},
        {ic:'info-circle', label:'文件属性',action:onProps},
        {ic:`shield${wl?'-filled':'-plus'}`,label:wl?'移除白名单':'加入白名单',action:onWhitelist,active:wl},
      ].map(({ic,label,action,active},i,arr)=>e('button',{key:label,onClick:action,style:{flex:1,padding:'7px 4px',background:'none',border:'none',borderRight:i<arr.length-1?`1px solid ${keep?'var(--green-bd)':'var(--red-bd)'}`:undefined,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:5,fontSize:11,color:active?'var(--amber)':'var(--tx-muted)',fontWeight:active?600:400,transition:'background .1s'},onMouseEnter:ev=>ev.currentTarget.style.background='rgba(0,0,0,0.04)',onMouseLeave:ev=>ev.currentTarget.style.background='none'},
        Icon(ic,{fontSize:14}),label
      ))
    )
  );
}

function DuplicatesView({setPendingCount,player}){
  const[filter,setFilter]=useState('pending');
  const[sort,setSort]=useState('savings');
  const[groups,setGroups]=useState([]);
  const[tagFilter,setTagFilter]=useState(new Set());
  const[search,setSearch]=useState('');
  const[selId,setSelId]=useState(null);
  const[detail,setDetail]=useState(null);
  const[detailLoading,setDetailLoading]=useState(false);
  const[listLoading,setListLoading]=useState(true);
  const[toast,setToast]=useState(null);
  const[showBatch,setShowBatch]=useState(false);
  const[propsId,setPropsId]=useState(null);

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
  useEffect(()=>{
    if(!selId)return;
    setDetailLoading(true);
    api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);}).finally(()=>setDetailLoading(false));
  },[selId]);

  // All match tags present in current list
  const allTags=useMemo(()=>{
    const s=new Set();
    groups.forEach(g=>(g.match_tags||'').split(',').filter(Boolean).forEach(t=>s.add(t)));
    return [...s];
  },[groups]);

  // Filtered group list — by selected match-tag chips AND free-text search
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
  async function handleWL(fileId,isWl,groupId){
    isWl?await api.del(`/api/whitelist/${fileId}`):await api.post(`/api/whitelist/${fileId}`);
    const r=await api.get('/api/duplicates/'+groupId);
    if(r.ok)setDetail(r.data);
    setToast({msg:isWl?'已从白名单移除':'已加入白名单',type:'success'});
  }

  const pending=groups.filter(g=>!g.resolved);
  const savings=pending.reduce((a,g)=>a+(g.savings_bytes||0),0);

  const GH='calc(100vh - 260px)'; // group list + detail height

  return e('div',{className:'fade'},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    propsId&&e(PropsModal,{fileId:propsId,onClose:()=>setPropsId(null)}),

    // Match type filter chips — F8
    allTags.length>0&&e('div',{style:{marginBottom:10}},
      e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginBottom:6,display:'flex',alignItems:'center',gap:5}},Icon('filter',{fontSize:12}),'按匹配类型筛选（可多选）：'),
      e('div',{style:{display:'flex',gap:5,flexWrap:'wrap'}},
        allTags.map(tag=>{
          const[col,bg,bd]=TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
          const active=tagFilter.has(tag);
          return e('button',{key:tag,onClick:()=>toggleTagFilter(tag),style:{padding:'3px 10px',borderRadius:99,fontSize:11,fontWeight:active?600:400,cursor:'pointer',border:`1px solid ${active?col:bd}`,background:active?bg:'var(--bg-base)',color:active?col:'var(--tx-muted)',transition:'all .12s'}},MATCH_TAG_LABELS[tag]||tag);
        }),
        tagFilter.size>0&&e('button',{onClick:()=>setTagFilter(new Set()),style:{padding:'3px 10px',borderRadius:99,fontSize:11,cursor:'pointer',border:'1px solid var(--bd-default)',background:'var(--bg-base)',color:'var(--tx-faint)'},'children':'清除筛选'},'清除筛选')
      )
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
      filter!=='done'&&pending.length>0&&e('div',{style:{display:'flex',gap:8,alignItems:'center'}},
        e('span',{style:{fontSize:11,color:'var(--tx-faint)'}},`${visibleGroups.filter(g=>!g.resolved).length} 组 · ${fmtBytes(savings)}`),
        e(Btn,{onClick:()=>setShowBatch(true),icon:'checks',small:true},'批量确认全部')
      )
    ),

    showBatch&&e('div',{className:'fade',style:{background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)',padding:'12px 16px',marginBottom:10,display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}},
      e('div',{style:{flex:1}},e('div',{style:{fontSize:13,fontWeight:600,color:'#92400E',marginBottom:3}},'确认批量操作'),e('div',{style:{fontSize:12,color:'#A16207'}},'处理 ',e('b',null,pending.length),' 个重复组，释放约 ',e('b',null,fmtBytes(savings)),'，文件移入回收站。')),
      e('div',{style:{display:'flex',gap:8}},e(Btn,{onClick:resolveAll,icon:'check'},'确认'),e(Btn,{variant:'ghost',onClick:()=>setShowBatch(false),icon:'x'},'取消'))
    ),

    // Main: independent scroll left + right — F2
    e('div',{style:{display:'grid',gridTemplateColumns:'240px 1fr',gap:12,height:GH}},

      // LEFT list — its own scroll
      e('div',{style:{overflowY:'auto',height:'100%',paddingRight:2}},
        listLoading?e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:22}})):
        visibleGroups.length===0?e('div',{style:{color:'var(--tx-faint)',fontSize:12,padding:'20px 0',textAlign:'center',lineHeight:1.8}},(tagFilter.size||search.trim())?'当前筛选条件无结果':filter==='pending'?'无待处理组\n请先执行扫描':'暂无数据'):
        visibleGroups.map(g=>{
          const isSel=g.id===selId;
          const tags=(g.match_tags||'').split(',').filter(Boolean).slice(0,2);
          // F1: show keep_title from API (included in group list now)
          const title=g.keep_title||(detail?.id===g.id?detail.tracks?.find(t=>t.keep)?.title:null)||`组 #${g.id}`;
          const artist=g.keep_artist||(detail?.id===g.id?detail.tracks?.find(t=>t.keep)?.artist:null)||'';
          return e('div',{key:g.id,onClick:()=>setSelId(g.id),style:{padding:'10px 12px',borderRadius:'var(--r-lg)',cursor:'pointer',background:isSel?'var(--amber-bg)':'var(--bg-base)',border:`0.5px solid ${isSel?'var(--amber-bd)':'var(--bd-default)'}`,boxShadow:'var(--sh-xs)',opacity:g.resolved?.6:1,transition:'all .12s',marginBottom:4}},
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:3}},
              e('span',{style:{fontSize:12,fontWeight:600,color:isSel?'#92400E':'var(--tx-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,maxWidth:160}},title),
              e('i',{className:`ti ${g.resolved?'ti-circle-check':'ti-alert-circle'}`,style:{fontSize:13,color:g.resolved?'var(--green)':'var(--amber)',flexShrink:0,marginLeft:4}})
            ),
            artist&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},artist),
            e('div',{style:{display:'flex',gap:4,flexWrap:'wrap'}},
              (g.savings_bytes>0)&&e('span',{style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'#FEF3C7',color:'#92400E',border:'0.5px solid #FDE68A'}},fmtBytes(g.savings_bytes)),
              tags.map(t=>{const[c,b]=TAG_COLORS[t]||['#6B7280','#F3F4F6'];return e('span',{key:t,style:{fontSize:9,padding:'1px 5px',borderRadius:3,background:b,color:c,border:`0.5px solid ${c}30`}},MATCH_TAG_LABELS[t]||t);}),
              e('span',{style:{fontSize:10,padding:'1px 5px',borderRadius:3,background:'var(--bg-muted)',color:'var(--tx-faint)',border:'0.5px solid var(--bd-default)'}},g.similarity+'%')
            )
          );
        })
      ),

      // RIGHT detail — its own scroll — F2
      e('div',{style:{overflowY:'auto',height:'100%',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-xs)',padding:'16px 18px'}},
        !detail||detail.id!==selId?
          e('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:10,height:'100%',color:'var(--tx-faint)',fontSize:12}},Icon('click',{fontSize:36}),'从左侧选择重复组查看详情'):
          detailLoading?e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})):
          e('div',{className:'fade'},
            // Header
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14,gap:10}},
              e('div',{style:{flex:1,minWidth:0}},
                e('div',{style:{fontSize:15,fontWeight:700,color:'var(--tx-primary)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},detail.tracks?.find(t=>t.keep)?.title||'—'),
                e('div',{style:{fontSize:12,color:'var(--tx-muted)',marginBottom:6}},detail.tracks?.find(t=>t.keep)?.artist||''),
                e('div',{style:{display:'flex',gap:5,flexWrap:'wrap'}},
                  e(Tag,{children:`声纹相似度 ${detail.similarity}%`,color:'#92400E',bg:'var(--amber-bg)',border:'var(--amber-bd)'}),
                  ...(detail.match_tags||'').split(',').filter(Boolean).map(t=>e(MatchTag,{key:t,tag:t}))
                ),
                (detail.match_tags||'').includes('meta_confirmed')&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:6,lineHeight:1.6,maxWidth:420}},'声纹比对未达到阈值（或缺少声纹数据），此重复判定主要依据标题/艺术家/时长一致性，并非声纹本身高度相似。')
              ),
              detail.resolved?e(Btn,{variant:'success',icon:'circle-check',disabled:true},'已处理'):
              e(Btn,{icon:'check',onClick:()=>resolve(detail.id)},`确认删除 ${detail.tracks?.filter(t=>!t.keep&&!t.whitelisted).length||0} 个`)
            ),

            // Size bars
            e('div',{style:{background:'var(--bg-subtle)',borderRadius:'var(--r-md)',padding:'10px 12px',marginBottom:12}},
              e('div',{style:{fontSize:11,fontWeight:500,color:'var(--tx-faint)',marginBottom:8,display:'flex',alignItems:'center',gap:4}},Icon('chart-bar',{fontSize:12}),'文件大小对比'),
              (()=>{const mx=Math.max(...(detail.tracks||[]).map(t=>t.size||1));return(detail.tracks||[]).map(t=>e('div',{key:t.id,style:{display:'flex',alignItems:'center',gap:8,marginBottom:5}},e('div',{style:{width:90,fontSize:10,fontFamily:'var(--font-mono)',color:t.keep?'var(--green)':'var(--tx-faint)',textAlign:'right',flexShrink:0,fontWeight:t.keep?600:400}},fmtBR(t.bitrate,t.format)),e('div',{style:{flex:1,height:8,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},e('div',{style:{width:(t.size/mx*100).toFixed(1)+'%',height:'100%',background:t.keep?'var(--green)':'var(--red)',opacity:t.keep?.85:.3,borderRadius:99}})),e('div',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-faint)',width:56,flexShrink:0,textAlign:'right'}},fmtBytes(t.size))));})()
            ),

            // Track list with bigger buttons — F3
            (detail.tracks||[]).map(t=>e(TrackRow,{key:t.id,track:t,player,
              onToggle:()=>toggleTrack(detail.id,t.id,!t.keep,!t.keep?'手动指定保留':'手动指定删除'),
              canToggle:!detail.resolved&&!(t.keep&&(detail.tracks||[]).filter(x=>x.keep&&!x.whitelisted).length<=1),
              onWhitelist:()=>handleWL(t.id,!!t.whitelisted,detail.id),
              onProps:()=>setPropsId(t.id),
            })),

            // Decision reason
            e('div',{style:{background:'var(--bg-subtle)',borderRadius:'var(--r-md)',padding:'10px 12px'}},
              e('div',{style:{fontSize:11,fontWeight:600,color:'var(--tx-secondary)',marginBottom:5,display:'flex',alignItems:'center',gap:4}},Icon('sparkles',{fontSize:13,color:'var(--amber)'}),'智能决策依据'),
              e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.7}},detail.tracks?.find(t=>t.keep)?.keep_reason||'—')
            )
          )
      )
    )
  );
}

/* ══════════════════════════════════════════════════════════════════════
   SETTINGS VIEW — also hosts what used to be the standalone "规则" tab as
   contextual help next to the controls it explains (Rules itself was pure
   reference text with no actions, so a separate tab for it added a click
   without adding any capability; Scanner stays separate since it's an
   action/operational page, not configuration).
   ══════════════════════════════════════════════════════════════════════ */
function InfoNote({children}){
  return e('div',{style:{fontSize:11,color:'var(--tx-faint)',lineHeight:1.7,background:'var(--bg-subtle)',border:'0.5px solid var(--bd-subtle)',borderRadius:'var(--r-md)',padding:'8px 10px',marginBottom:12,display:'flex',gap:6,alignItems:'flex-start'}},
    Icon('info-circle',{fontSize:13,flexShrink:0,marginTop:1}),
    e('span',null,children)
  );
}
function SettingsView(){
  const[s,setS]=useState(null);
  const[newDir,setNewDir]=useState('');
  const[saveState,setSaveState]=useState('idle');
  const[toast,setToast]=useState(null);
  const[showExclude,setShowExclude]=useState(false);
  const saveTimer=useRef(null);
  const isFirst=useRef(true);
  const DEFAULT_Q=['Hi-Res FLAC / WAV (96kHz+)','FLAC / WAV (44.1kHz)','AIFF','M4A / AAC ≥ 256k','MP3 320k','MP3 256k','MP3 192k','OGG / Opus','MP3 128k 及以下'];

  useEffect(()=>{api.get('/api/settings').then(r=>{if(r.ok){const d=r.data;if(!d.quality_tiers||!Array.isArray(d.quality_tiers))d.quality_tiers=[...DEFAULT_Q];setS(d);}});},[]);

  useEffect(()=>{
    if(!s)return;if(isFirst.current){isFirst.current=false;return;}
    setSaveState('saving');clearTimeout(saveTimer.current);
    saveTimer.current=setTimeout(()=>{api.put('/api/settings',s).then(r=>{if(r.ok){setSaveState('saved');setTimeout(()=>setSaveState('idle'),2200);}else{setSaveState('error');}});},700);
    return()=>clearTimeout(saveTimer.current);
  },[s]);

  const addDir=()=>{if(!newDir.trim())return;setS(p=>({...p,scan_dirs:[...(p.scan_dirs||[]),newDir.trim()]}));setNewDir('');};
  const remDir=i=>setS(p=>({...p,scan_dirs:(p.scan_dirs||[]).filter((_,j)=>j!==i)}));
  const moveQ=(i,d)=>{const q=[...(s.quality_tiers||DEFAULT_Q)];const j=i+d;if(j<0||j>=q.length)return;[q[i],q[j]]=[q[j],q[i]];setS(p=>({...p,quality_tiers:q}));};

  const SI=()=>e('div',{style:{fontSize:11,height:26,display:'flex',alignItems:'center',gap:5}},
    saveState==='saving'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-loader spin',style:{fontSize:12}}),'保存中...'),
    saveState==='saved'&&e('span',{className:'fade',style:{color:'var(--green)',display:'flex',alignItems:'center',gap:4}},Icon('circle-check',{fontSize:12}),'已自动保存'),
    saveState==='idle'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},Icon('device-floppy',{fontSize:12}),'修改后自动保存')
  );

  if(!s)return e('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:320,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}}));

  const q=s.quality_tiers||DEFAULT_Q;

  return e('div',{className:'fade'},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    e('div',{style:{display:'flex',justifyContent:'flex-end',marginBottom:8}},e(SI)),
    e('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}},
      e('div',{style:{display:'flex',flexDirection:'column',gap:14}},
        // Scan dirs (+ collapsed exclude patterns, demoted since it's rarely touched)
        e(Card,null,e(SH,{title:'扫描目录'}),
          (s.scan_dirs||[]).length===0&&e('div',{style:{color:'var(--tx-faint)',fontSize:12,padding:'4px 0 8px',display:'flex',gap:5,alignItems:'center'}},Icon('info-circle',{}),'暂未配置'),
          (s.scan_dirs||[]).map((d,i)=>e('div',{key:i,style:{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)',marginBottom:6}},
            Icon('folder-filled',{fontSize:13,color:'var(--amber)',flexShrink:0}),
            e('span',{title:d,style:{flex:1,fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},d),
            e('button',{onClick:()=>remDir(i),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:'2px 4px',borderRadius:'var(--r-sm)'}},Icon('x',{fontSize:13}))
          )),
          e('div',{style:{display:'flex',gap:6,marginBottom:10}},
            e('input',{value:newDir,onChange:ev=>setNewDir(ev.target.value),onKeyDown:ev=>ev.key==='Enter'&&addDir(),placeholder:'/Volumes/Music 或 D:\\Music',style:{flex:1,fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',fontFamily:'var(--font-mono)',outline:'none'}}),
            e(Btn,{onClick:addDir,small:true,icon:'plus'},'添加')
          ),
          e('button',{onClick:()=>setShowExclude(v=>!v),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',fontSize:11,display:'flex',alignItems:'center',gap:4,padding:0}},
            e('i',{className:`ti ti-chevron-${showExclude?'up':'down'}`,style:{fontSize:12}}),'高级：排除规则'
          ),
          showExclude&&e('div',{style:{marginTop:8}},
            e('textarea',{value:(s.exclude_patterns||[]).join(', '),onChange:ev=>setS(p=>({...p,exclude_patterns:ev.target.value.split(',').map(x=>x.trim()).filter(Boolean)})),style:{width:'100%',fontSize:11,fontFamily:'var(--font-mono)',padding:'8px 10px',borderRadius:'var(--r-md)',background:'var(--bg-subtle)',border:'0.5px solid var(--bd-default)',color:'var(--tx-secondary)',resize:'none',height:60,lineHeight:1.6,outline:'none'}}),
            e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:4}},'逗号分隔，支持 glob。示例：*.tmp, .DS_Store, Thumbs.db')
          )
        ),
        // Detection params
        e(Card,null,e(SH,{title:'检测参数'}),
          e(InfoNote,null,'重复检测分四级比对：精确声纹 → 歌曲名称 → 指纹前缀 → 时长分组，尽量提高召回率。下方的阈值只影响其中“声纹比对”这一级，标题/时长一致但声纹比对不达标的歌曲仍可能通过元数据被识别为重复（重复组中会标注“元数据判定”）。'),
          e('div',{style:{marginBottom:14}},
            e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)'}},'声纹相似度阈值'),e('span',{style:{fontSize:15,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},(s.threshold||90)+'%')),
            e('input',{type:'range',min:70,max:100,value:s.threshold||90,onChange:ev=>setS(p=>({...p,threshold:+ev.target.value}))}),
            e('div',{style:{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--tx-faint)',marginTop:3}},e('span','70% 宽松'),e('span','100% 精确'))
          ),
          e('div',{style:{marginBottom:12}},
            e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)'}},'并发线程数'),e('span',{style:{fontSize:15,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},s.threads||8)),
            e('input',{type:'range',min:1,max:32,value:s.threads||8,onChange:ev=>setS(p=>({...p,threads:+ev.target.value}))})
          ),
          e('div',{style:{display:'flex',alignItems:'flex-start',gap:8,padding:'10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)'}},
            e('input',{type:'checkbox',id:'smart',checked:s.smart_scan!==false,onChange:ev=>setS(p=>({...p,smart_scan:ev.target.checked})),style:{marginTop:2}}),
            e('label',{htmlFor:'smart',style:{fontSize:12,color:'var(--tx-secondary)',cursor:'pointer',lineHeight:1.6,display:'flex',flexDirection:'column',gap:2}},
              e('span',{style:{display:'flex',alignItems:'center',gap:6}},'智能增量扫描',e(Tag,{children:'推荐',color:'var(--green)',bg:'var(--green-bg)',border:'var(--green-bd)'})),
              e('span',{style:{fontSize:11,color:'var(--tx-faint)'}},'按文件修改时间自动跳过未变更文件')
            )
          )
        ),
        // API Keys — renamed from "外部 API 设置" to make clear this is about
        // looking up/correcting metadata, and to spell out what scraping is
        // actually used for instead of leaving it as a disconnected feature.
        e(Card,null,e(SH,{title:'在线元数据匹配',sub:'用于校正标签、并作为重复判定的额外证据'}),
          e(InfoNote,null,'刮削到的数据不只是展示：两个文件若被刮削到同一条 MusicBrainz 录音，会被直接判定为重复（标注“MusicBrainz确认”）；已确认刮削匹配的文件在选择保留版本时也会获得少量加分。刮削到的中文数据如为繁体，会在写入前自动转换为简体。'),
          e('div',{style:{marginBottom:10}},
            e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',marginBottom:4}},Icon('world',{marginRight:5,fontSize:13}),'MusicBrainz'),
            e('div',{style:{fontSize:11,color:'var(--tx-faint)',padding:'6px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)'}},
              Icon('check',{color:'var(--green)',marginRight:5}),
              '默认启用，无需配置，按标题/艺术家文本检索。速率限制 1 次/秒。'
            )
          ),
          e('div',null,
            e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',marginBottom:4}},Icon('key',{marginRight:5,fontSize:13}),'AcoustID API Key'),
            e('input',{value:s.acoustid_key||'',onChange:ev=>setS(p=>({...p,acoustid_key:ev.target.value})),placeholder:'在 acoustid.biz 注册获取免费 API Key',style:{width:'100%',fontSize:11,padding:'7px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',outline:'none',fontFamily:'var(--font-mono)'}}),
            e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:4}},'选填。配置后会优先用声纹指纹去匹配 MusicBrainz 录音，比纯文本检索更准确')
          )
        )
      ),
      e('div',{style:{display:'flex',flexDirection:'column',gap:14}},
        // Quality priority — editable
        e(Card,null,e(SH,{title:'音质优先级',sub:'可拖动调整 — 顶部优先级最高'}),
          e(InfoNote,null,'同一重复组中按以下顺序决定保留哪个文件：① 音质最优分先；② 音质相同则选年份最早的正式专辑（合辑/精选不算首发）；③ 仍相同则本地已收藏 ≥2 首的专辑版优先于单曲版；④ 最后比较标签完整度（含是否有刮削确认）。'),
          q.map((f,i)=>e('div',{key:f,style:{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',marginBottom:4,border:'0.5px solid var(--bd-subtle)'}},
            e('span',{style:{width:20,fontSize:11,fontFamily:'var(--font-mono)',fontWeight:700,color:i<3?'var(--green)':i<6?'var(--amber)':'var(--tx-faint)',textAlign:'center'}},i+1),
            e('span',{style:{flex:1,fontSize:12,color:i<6?'var(--tx-secondary)':'var(--tx-faint)'}},f),
            i===0&&e('span',{style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}},'最优'),
            e('div',{style:{display:'flex',flexDirection:'column',gap:1}},
              e('button',{onClick:()=>moveQ(i,-1),disabled:i===0,style:{background:'none',border:'none',cursor:i===0?'default':'pointer',padding:'1px 4px',opacity:i===0?.2:1,color:'var(--tx-muted)'}},Icon('chevron-up',{fontSize:13})),
              e('button',{onClick:()=>moveQ(i,1),disabled:i===q.length-1,style:{background:'none',border:'none',cursor:i===q.length-1?'default':'pointer',padding:'1px 4px',opacity:i===q.length-1?.2:1,color:'var(--tx-muted)'}},Icon('chevron-down',{fontSize:13}))
            )
          ))
        ),
        // Match-tag legend — what used to be the standalone "规则" tab's
        // "重复识别" card now lives here as reference next to the params
        // that actually control it.
        e(Card,null,e(SH,{title:'重复组标签说明'}),
          [
            ['exact_copy','两个文件的声纹完全一致（不代表文件本身字节相同，文件名/标签/大小完全可以不同）。'],
            ['same_recording','声纹高度相似（≥85%）但不完全一致，通常是同一录音的不同编码。'],
            ['meta_confirmed','声纹比对未达标或缺少声纹数据，凭标题/艺术家/时长一致性判定为重复。'],
            ['mb_confirmed','两个文件被刮削到同一条 MusicBrainz 录音，第三方数据交叉确认。'],
            ['duration_near','时长几乎完全一致（≤1.5 秒），用于和差异较大的改编/现场版区分。'],
          ].map(([tag,desc])=>e('div',{key:tag,style:{display:'flex',gap:8,padding:'7px 0',borderBottom:'0.5px solid var(--bd-subtle)',alignItems:'flex-start'}},
            e(MatchTag,{tag}),
            e('span',{style:{fontSize:11,color:'var(--tx-secondary)',lineHeight:1.6}},desc)
          )),
          e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:8,lineHeight:1.6,display:'flex',gap:5,alignItems:'flex-start'}},e('i',{className:'ti ti-adjustments',style:{fontSize:12,flexShrink:0,marginTop:1}}),'任意重复组中都可手动切换某个曲目的保留/删除状态，覆盖自动建议；加入白名单的文件会被完全排除在重复检测之外（见"白名单"标签页）。')
        )
      )
    )
  );
}

/* ══════════════════════════════════════════════════════════════════════
   WHITELIST VIEW — browse and manage whitelisted files
   ══════════════════════════════════════════════════════════════════════ */
function WhitelistView({player}){
  const[rows,setRows]=useState([]);
  const[loading,setLoading]=useState(true);
  const[toast,setToast]=useState(null);

  function load(){
    setLoading(true);
    api.get('/api/whitelist').then(r=>{if(r.ok)setRows(r.data||[]);}).finally(()=>setLoading(false));
  }
  useEffect(()=>{load();},[]);

  async function remove(id){
    await api.del(`/api/whitelist/${id}`);
    setToast({msg:'已从白名单移除',type:'success'});
    load();
  }

  if(loading)return e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}}));

  return e('div',{className:'fade'},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}},
      e('div',null,
        e('div',{style:{fontSize:14,fontWeight:600,color:'var(--tx-primary)'}},`白名单 (${rows.length} 个文件)`),
        e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:2}},'白名单中的文件不参与重复检测，重新执行"相似度匹配"后生效')
      )
    ),
    rows.length===0
      ? e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)',lineHeight:2}},
          e('i',{className:'ti ti-shield-check',style:{fontSize:36,display:'block',marginBottom:8}}),
          '白名单为空',e('br'),'在"音乐库"或"重复组"中可将文件加入白名单')
      : e('div',{style:{borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)',background:'var(--bg-base)'}},
          e('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:12}},
            e('thead',null,e('tr',{style:{borderBottom:'0.5px solid var(--bd-default)',background:'var(--bg-subtle)'}},
              ...['','标题','艺术家','专辑','格式','操作'].map(h=>e('th',{key:h,style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',whiteSpace:'nowrap'}},h))
            )),
            e('tbody',null,rows.map(f=>{
              const isCur=player?.current?.id===f.id;
              return e('tr',{key:f.id,style:{borderBottom:'0.5px solid var(--bd-subtle)'},onMouseEnter:ev=>ev.currentTarget.style.background='var(--bg-subtle)',onMouseLeave:ev=>ev.currentTarget.style.background=''},
                e('td',{style:{padding:'6px 8px',width:36}},
                  f.fingerprint&&player&&e('button',{onClick:()=>player.playTrack({id:f.id,title:f.title,artist:f.artist}),style:{background:isCur?'var(--amber)':'var(--bg-muted)',border:'none',borderRadius:'50%',width:24,height:24,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}},
                    e('i',{className:`ti ti-${isCur&&player.playing?'pause':'play'}`,style:{fontSize:11,color:isCur?'#fff':'var(--tx-muted)'}}))
                ),
                e('td',{style:{padding:'6px 10px',fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:200}},f.title||'—'),
                e('td',{style:{padding:'6px 10px',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160}},f.artist||'—'),
                e('td',{style:{padding:'6px 10px',color:'var(--tx-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160,fontSize:11}},f.album||'—'),
                e('td',{style:{padding:'6px 10px'}},e(QBadge,{format:f.format,bitrate:f.bitrate,sample_rate:f.sample_rate})),
                e('td',{style:{padding:'4px 8px'}},
                  e('button',{onClick:()=>remove(f.id),style:{background:'var(--red-bg)',border:'0.5px solid var(--red-bd)',borderRadius:'var(--r-sm)',cursor:'pointer',color:'var(--red)',padding:'3px 8px',fontSize:11,display:'flex',alignItems:'center',gap:3}},
                    e('i',{className:'ti ti-shield',style:{fontSize:12}}),'移除')
                )
              );
            }))
          )
        )
  );
}

/* ══════════════════════════════════════════════════════════════════════
   APP SHELL
   ══════════════════════════════════════════════════════════════════════ */
function App(){
  const[view,setView]=useState('library');
  const[pending,setPending]=useState(0);
  const player=useGlobalPlayer();

  useEffect(()=>{api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPending(r.data.dupGroups||0);});},[]);

  // Nav tabs: removed standalone 规则 (merged into 设置 as contextual help);
  // added 白名单 so users can browse/manage whitelisted files without having
  // to dig into the library or duplicate groups.
  const TABS=[
    {id:'library',    label:'音乐库', icon:'music'},
    {id:'scanner',    label:'扫描',   icon:'radar'},
    {id:'duplicates', label:'重复组', icon:'copy', badge:pending},
    {id:'whitelist',  label:'白名单', icon:'shield-check'},
    {id:'settings',   label:'设置',   icon:'settings'},
  ];

  const hasPB=!!player.current;

  return e('div',{style:{display:'flex',flexDirection:'column',height:'100vh',overflow:'hidden',background:'var(--bg-subtle)'}},
    // Always-mounted <audio> — the root cause of the "first click needs double click" bug
    // was that the old code only created <audio> after the first click, so audioRef.current
    // was null on that very click. Mounting it here (outside any conditional) means it's
    // available immediately on any playTrack() call.
    e('audio',{ref:player.audioRef,...player.bind,style:{display:'none'}}),

    e('header',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px',height:50,background:'var(--bg-base)',borderBottom:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',flexShrink:0,zIndex:10}},
      e('div',{style:{display:'flex',alignItems:'center',gap:10}},
        e('div',{style:{width:28,height:28,background:'linear-gradient(135deg,#FDE68A,#D97706)',borderRadius:7,display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 1px 3px rgba(217,119,6,.25)',fontSize:16}},'♫'),
        e('span',{style:{fontWeight:700,fontSize:15,color:'var(--tx-primary)',letterSpacing:'-.015em'}},'MusicDedup'),
        e('span',{style:{fontSize:11,color:'var(--tx-faint)',background:'var(--bg-muted)',padding:'2px 8px',borderRadius:4,border:'0.5px solid var(--bd-default)',fontFamily:'var(--font-mono)'}},'v1.2')
      ),
      e('div',{style:{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--tx-faint)'}},
        e('span',{style:{width:7,height:7,borderRadius:'50%',background:'var(--green)',display:'inline-block',boxShadow:'0 0 0 2px #D1FAE5'}}),
        '运行中',e('span',{style:{color:'var(--bd-strong)'}},'·'),location.host
      )
    ),
    e('nav',{style:{display:'flex',borderBottom:'0.5px solid var(--bd-default)',padding:'0 24px',background:'var(--bg-base)',flexShrink:0,gap:2}},
      TABS.map(t=>e('button',{key:t.id,onClick:()=>setView(t.id),style:{display:'flex',alignItems:'center',gap:6,padding:'9px 14px',cursor:'pointer',fontSize:12,fontWeight:view===t.id?600:400,color:view===t.id?'var(--amber)':'var(--tx-muted)',background:'none',border:'none',outline:'none',borderBottom:view===t.id?'2px solid var(--amber)':'2px solid transparent',marginBottom:-1,transition:'all .15s'}},
        e('i',{className:`ti ti-${t.icon}`,style:{fontSize:15}}),t.label,
        t.badge?e('span',{style:{fontSize:10,fontWeight:700,background:'var(--amber)',color:'#fff',borderRadius:8,padding:'1px 6px',minWidth:16,textAlign:'center'}},t.badge):null
      ))
    ),
    e('main',{style:{flex:1,overflowY:'auto',padding:20,paddingBottom:hasPB?72:20}},
      view==='library'   &&e(LibraryView,{player}),
      view==='scanner'   &&e(ScannerView,{onScanDone:()=>api.get('/api/stats').then(r=>{if(r.ok)setPending(r.data.dupGroups||0);})}),
      view==='duplicates'&&e(DuplicatesView,{setPendingCount:setPending,player}),
      view==='whitelist' &&e(WhitelistView,{player}),
      view==='settings'  &&e(SettingsView),
    ),
    e(PlayerBar,{player})
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(e(App));
