'use strict';
const APP_VERSION='2.0.0';

/* ── API ─────────────────────────────────────────────────────────────── */
// window.bridge.request 走 IPC（electron/ipc/index.js 路由表），调用签名同 fetch 封装。
const api={
  get: u=>window.bridge.request('GET', u),
  post:(u,b={})=>window.bridge.request('POST', u, b),
  put:(u,b={})=>window.bridge.request('PUT', u, b),
  del: u=>window.bridge.request('DELETE', u),
};

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
    el.src=`musicdedup://stream/${current.id}`;
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
  // 扫描结果分阶段增量合并（P5.2）：worker 每完成一个阶段，broker 合并临时库→主库并广播
  // type:'merged'，此处据此刷新——"完成一个阶段，更新一个阶段"，扫描期间即可看到已完成的
  // 阶段数据（enum 后文件列表、fp 后播放按钮、匹配后重复组）。终态 type:'done'（settle
  // 合并之后广播）再做最终刷新兜底。中途不再依赖匹配步骤完成点的旧刷新逻辑。
  const prevPhaseRef=useRef(null);

  useEffect(()=>{
    if(!window.bridge?.onScanProgress)return;
    // onScanProgress 事件：payload 同构 {phase,pct,running,message,level,type}，更新进度卡与日志
    const off=window.bridge.onScanProgress(d=>{
      // merged（分阶段合并完成）只触发刷新，不更新进度卡状态/日志——payload 无 phase/message，
      // 交给 setStatus 会把进度卡抹掉。
      if(d.type==='merged'){ onDoneRef.current?.(); return; }
      // 相位切换时清 subPct：新相位首个 emit 常不带 subPct，残留上一相位的值会让
      // 内联子% 卡在旧值（如上一相位结束的 100%）。
      setStatus(prev=>(d.phase!==prevPhaseRef.current?{...d,subPct:undefined}:d));
      if(d.message){
        setLogs(p=>{
          if(p.length&&p[p.length-1].msg===d.message&&p[p.length-1].ty!=='sep')return p;
          const ty=d.level||'ok';
          return[...p.slice(-500),{msg:d.message,ty,ts:Date.now()}];
        });
      }
      if(d.type==='done')onDoneRef.current?.();
      prevPhaseRef.current=d.phase;
    });
    // 挂载时拉一次当前状态（等价 SSE 首连的 type:'state' 事件，覆盖重载场景）
    api.get('/api/scan/status').then(r=>{if(r.ok&&r.data)setStatus(r.data);});
    return off;
  },[]);

  function addSeparator(label){
    const ts=new Date().toLocaleTimeString('zh-CN');
    setLogs(p=>[...p,{msg:`━━━ ${label} [${ts}] ━━━`,ty:'sep',ts:Date.now()}]);
  }
  function startStep(steps,force=false,label,extra={}){
    addSeparator(`${label||'扫描'} · ${force?'全量重新执行':extra.retryMissed?'未命中重新执行':'智能模式'}`);
    api.post('/api/scan/start',{steps,force,...extra}).then(r=>{if(!r.ok)addSeparator(`⚠ 启动失败：${r.error||''}`);});
  }
  function pause(){api.post('/api/scan/pause');}
  function resume(){api.post('/api/scan/resume');}
  return{status,logs,setLogs,confirm,setConfirm,addSeparator,startStep,pause,resume};
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
  const[confirmCloseOpen,setConfirmCloseOpen]=useState(false); // 任务进行中关窗的确认弹窗
  const player=useGlobalPlayer();

  function refreshStats(){
    api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPending(r.data.pendingGroups||0);});
    setScanDoneKey(k=>k+1);
    setLibraryKey(k=>k+1);
  }
  const scan=useScanStream(refreshStats);

  useEffect(()=>{
    refreshStats();
    api.get('/api/settings').then(r=>{if(r.ok)setSettingsState(r.data);});
  },[]);

  // P4 统一图标生成：首启栅格化 favicon SVG → PNG data URL，窗口/任务栏图标(256px)
  // 同源送达主进程（不提交图片资产，源为 assets/icon.svg）
  useEffect(()=>{
    if(!window.bridge?.readyWindowIcon)return;
    const link=document.querySelector('link[rel=icon]');
    if(!link)return;
    const img=new Image();
    img.onload=()=>{
      try{
        const c=document.createElement('canvas');
        c.width=c.height=256;
        c.getContext('2d').drawImage(img,0,0,256,256);
        window.bridge.readyWindowIcon(c.toDataURL('image/png'));
      }catch(e){}
    };
    img.onerror=()=>{};
    img.src=link.href;
  },[]);

  // 弹窗遮罩 → 标题栏控件颜色实时联动：titleBarOverlay 原生三键由 OS 绘制在网页之上、
  // CSS 遮罩盖不住，只能经 setTitleBarOverlay 改色。读当前 DOM 里实际的全屏遮罩栈
  // （fixed + inset:0 + z-index≥1000 + rgba 背景），把 header 底色/符号色逐层与遮罩 alpha
  // 合成，得到与遮罩实时一致的颜色（嵌套弹窗逐层加深），经 IPC 设回三键。
  useEffect(()=>{
    if(!window.bridge?.setTitlebarOverlay)return;
    const cssVar=v=>(getComputedStyle(document.documentElement).getPropertyValue(v).trim());
    const parse=s=>{
      const h=(s||'').match(/#([0-9a-f]{6})/i);
      if(h)return [0,2,4].map(i=>parseInt(h[1].slice(i,i+2),16));
      const n=(s||'').match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,]+([\d.]+))?\s*\)/);
      if(n)return [+n[1],+n[2],+n[3]];
      return null;
    };
    const toHex=c=>'#'+c.map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
    let lastColor=null,lastSym=null;
    const sync=()=>{
      const base=parse(cssVar('--bg-base'))||[255,255,255];
      const sym=parse(cssVar('--tx-muted'))||[107,114,128];
      const bg=base.slice(), sc=sym.slice();
      for(const el of document.querySelectorAll('div[style*="position: fixed"][style*="inset: 0px"]')){
        const z=parseInt(el.style.zIndex,10);
        if(!(z>=1000))continue;
        const m=el.style.background.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,]+([\d.]+))?\s*\)/);
        if(!m)continue;
        const a=m[4]===undefined?1:parseFloat(m[4]);
        for(let i=0;i<3;i++){ bg[i]+=(+m[i+1]-bg[i])*a; sc[i]+=(+m[i+1]-sc[i])*a; }
      }
      const color=toHex(bg), symbolColor=toHex(sc);
      if(color===lastColor&&symbolColor===lastSym)return; // 颜色未变不发 IPC，重渲染不产生多余发送
      lastColor=color; lastSym=symbolColor;
      window.bridge.setTitlebarOverlay({ color, symbolColor });
    };
    sync();
    // 观察器回调在微任务/浏览器绘制前触发，同步计算 → 与页面遮罩同帧出现
    // （requestAnimationFrame 会多等一帧，造成三键比遮罩晚变暗）。
    const mo=new MutationObserver(sync);
    mo.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['style']});
    return ()=>mo.disconnect();
  },[]);

  // 任务进行中关窗：主进程发 app:confirm-close → 弹窗确认；确认后中止扫描并调
  // confirmClose()，主进程等归位后退出。
  useEffect(()=>{
    if(!window.bridge?.onConfirmClose)return;
    return window.bridge.onConfirmClose(()=>setConfirmCloseOpen(true));
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
      return{...(p||{}),scan_dirs:next,_dirChanged:(p?._dirChanged||0)+1}; // 计数递增，重复加目录也能重新触发执行卡滑动
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
  // steps 由设置页按改动设置对应模块传入（基础匹配卡→['basicMatch']，声纹匹配卡→['fpMatch']）。
  const onMatchAffectingChange=useCallback((steps)=>{
    scan.startStep(steps||['basicMatch','fpMatch','scrapeMatch'],false,'设置变更后重新匹配');
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
    // v2（P2）：封面走自定义协议（同源 musicdedup://app/cover/<id>，避免二进制过 IPC）
    fetch(`musicdedup://app/cover/${cur.id}`)
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
    // P4 无边框：整行是拖拽区（-webkit-app-region:drag），交互元素 no-drag；
    //   Windows 原生 overlay 按钮在右上、macOS 红绿灯在左上（品牌避让）、Linux 自绘三键在右列。
    e('div',{style:{display:'grid',gridTemplateColumns:'1fr auto 1fr',alignItems:'center',padding:'0 24px',height:54,background:'var(--bg-base)',borderBottom:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',flexShrink:0,zIndex:10,WebkitAppRegion:'drag'},
      onDoubleClick:()=>{ if(window.bridge?.platform==='linux'&&window.bridge?.winControls) window.bridge.winControls.toggleMaximize(); }},
      e('div',{style:{display:'flex',alignItems:'center',gap:10,justifySelf:'start',paddingLeft:window.bridge?.platform==='darwin'?72:0}},
        e(Logo,{size:28}),
        e('span',{style:{fontWeight:700,fontSize:15,color:'var(--tx-primary)',letterSpacing:'-.015em'}},'MusicDedup'),
        e('span',{style:{fontSize:11,color:'var(--tx-faint)',background:'var(--bg-muted)',padding:'2px 8px',borderRadius:4,border:'0.5px solid var(--bd-default)',fontFamily:'var(--font-mono)'}},'v'+APP_VERSION),
        window.bridge?.isTest&&e('span',{style:{fontSize:11,color:'var(--amber)',background:'var(--amber-bg)',padding:'2px 8px',borderRadius:4,border:'1px solid var(--amber-bd)',fontFamily:'var(--font-mono)',fontWeight:600}},'隔离测试')
      ),
      e('nav',{style:{display:'flex',gap:4,justifySelf:'center',WebkitAppRegion:'no-drag'}},
        TABS.map(t=>e('button',{key:t.id,onClick:()=>setView(t.id),style:{display:'flex',alignItems:'center',gap:6,padding:'8px 16px',cursor:'pointer',fontSize:12,fontWeight:view===t.id?600:400,color:view===t.id?'var(--amber)':'var(--tx-muted)',background:view===t.id?'var(--amber-bg)':'none',border:'none',outline:'none',borderRadius:'var(--r-md)',transition:'all .15s'}},
          Icon(t.icon,{fontSize:15}),t.label,
          t.badge?e('span',{style:{fontSize:10,fontWeight:700,background:'var(--amber)',color:'#fff',borderRadius:8,padding:'1px 6px',minWidth:16,textAlign:'center'}},t.badge):null
        ))
      ),
      e('div',{style:{justifySelf:'end',display:'flex',WebkitAppRegion:'no-drag'}},
        window.bridge?.platform==='linux'?e(WindowControls):null
      )
    ),

    // Main content — max-width centred column. Views are permanently mounted
    // (display:none when inactive) so tab switches don't re-fetch anything.
    e('main',{ref:mainScrollRef,style:{flex:1,overflowY:'auto',scrollbarGutter:'stable',display:'flex',justifyContent:'center'}},
      e('div',{style:{width:'100%',maxWidth:'var(--max-width)',padding:20}},
        e('div',{style:{display:view==='library'?'block':'none'}},e(LibraryView,{player:player.lite,dirs,onAddDir:addScanDirNav,onRemoveDir:removeScanDir,onEnumOnly:refreshLibrary,onLocate:{setLocateInLibrary:fn=>{locateInLibraryRef.current=fn;}},mainScrollRef,libraryKey,onRetentionChange:()=>setRetentionListKey(k=>k+1),onTagsWritten:()=>{setWriteHistoryKey(k=>k+1);setLibraryKey(k=>k+1);api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPending(r.data.pendingGroups||0);});}})),
        e('div',{style:{display:view==='duplicates'?'block':'none'}},e(DuplicatesView,{player:player.lite,scanDoneKey,libraryKey,onRetentionChange:()=>setRetentionListKey(k=>k+1),onTagsWritten:()=>{setWriteHistoryKey(k=>k+1);setLibraryKey(k=>k+1);api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPending(r.data.pendingGroups||0);});},onLibraryMutated:()=>{setLibraryKey(k=>k+1);api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPending(r.data.pendingGroups||0);});},onLocate:{setLocateInDuplicates:fn=>{locateInDuplicatesRef.current=fn;}}})),
        e('div',{style:{display:view==='scanner'?'block':'none'}},e(ScannerView,{scan,hasPlayer:!!player.current})),
        e('div',{style:{display:view==='settings'?'block':'none'}},e(SettingsView,{active:view==='settings',dirs,onAddDir:addScanDirOnly,onRemoveDir:removeScanDir,dirChanged:!!settings?._dirChanged,dirSeq:settings?._dirChanged||0,onEnumOnly:()=>{refreshLibrary();},onDismissDirChanged:()=>setSettingsState(p=>({...(p||{}),_dirChanged:0})),onMatchAffectingChange,onScrapeReapply,scanRunning:scan.status.running,player:player.lite,retentionListKey,writeHistoryKey,onTagsWritten:()=>{setWriteHistoryKey(k=>k+1);setLibraryKey(k=>k+1);api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPending(r.data.pendingGroups||0);});},onLocateFile:navigateToFile,onNavigateToDuplicateGroup:navigateToDuplicateGroup,onLocate:{setLocateInRetentionList:fn=>{locateInRetentionListRef.current=fn;},setLocateInHistory:fn=>{locateInHistoryRef.current=fn;}},mainScrollRef}))
      )
    ),
    // PlayerBar in normal flow — pushes content up, never overlaps.
    e(PlayerBar,{player,onLocate:handleLocate}),
    // 扫描进行中关窗时弹出的确认弹窗：确认后中止扫描 → confirmClose() → 主进程等归位后退出。
    confirmCloseOpen&&e(ConfirmModal,{
      title:'关闭应用',
      message:e('span',null,'有任务正在执行（扫描进行中）。确认停止任务并关闭应用？未完成的扫描结果将丢失。'),
      onConfirm:()=>{ api.post('/api/scan/abort'); if(window.bridge?.confirmClose)window.bridge.confirmClose(); },
      onClose:()=>setConfirmCloseOpen(false),
    })
  );
}
