'use strict';
const {useState,useEffect,useRef,useMemo,useCallback}=React;
const e=React.createElement;

const api={
  get:  u     =>fetch(u).then(r=>r.json()),
  post: (u,b={})=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()),
  put:  (u,b={})=>fetch(u,{method:'PUT', headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()),
  del:  u     =>fetch(u,{method:'DELETE'}).then(r=>r.json()),
};

function fmtN(n){return n==null?'—':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'K':String(n);}
function fmtBytes(b){if(!b)return'0 B';if(b>=1e12)return(b/1e12).toFixed(2)+' TB';if(b>=1e9)return(b/1e9).toFixed(2)+' GB';if(b>=1e6)return(b/1e6).toFixed(1)+' MB';return Math.round(b/1e3)+' KB';}
function fmtBR(br,fmt){const f=(fmt||'').toUpperCase();const lo=['FLAC','WAV','AIFF','DSF'].includes(f);return lo?f:br?`${f} ${br}k`:(f||'—');}
function fmtDate(ms){if(!ms)return'—';return new Date(ms).toLocaleString('zh-CN',{dateStyle:'short',timeStyle:'short'});}

/* ── Shared UI ─────────────────────────────────────────────────────────── */
function QBadge({format:fmt,bitrate:br,sample_rate:sr}){
  const f=(fmt||'').toUpperCase(),lo=['FLAC','WAV','AIFF','DSF'].includes(f),hi=sr&&sr>=88200;
  const[col,bg]=hi?['#065F46','#D1FAE5']:lo?['#1D4ED8','#DBEAFE']:br>=320?['#5B21B6','#EDE9FE']:br>=256?['#92400E','#FEF3C7']:['#9A3412','#FEE2E2'];
  return e('span',{style:{fontSize:10,fontWeight:600,color:col,background:bg,border:`0.5px solid ${col}30`,padding:'1px 7px',borderRadius:3,fontFamily:'var(--font-mono)',whiteSpace:'nowrap',flexShrink:0}},hi?`Hi-Res ${f}`:lo?f:`${f} ${br||'?'}k`);
}
function Tag({children,color='var(--tx-faint)',bg='var(--bg-muted)',border='var(--bd-default)'}){
  return e('span',{style:{fontSize:10,padding:'1px 7px',borderRadius:3,background:bg,color,border:`0.5px solid ${border}`,whiteSpace:'nowrap'}},children);
}
function Btn({children,onClick,variant='primary',small,disabled,icon,style:sx={}}){
  const base={display:'flex',alignItems:'center',gap:5,borderRadius:'var(--r-md)',fontFamily:'var(--font-sans)',fontWeight:500,cursor:disabled?'not-allowed':'pointer',fontSize:small?11:12,padding:small?'4px 10px':'7px 14px',transition:'all 0.12s',border:'none',opacity:disabled?0.45:1,whiteSpace:'nowrap',...sx};
  const V={primary:{...base,background:'var(--amber)',color:'#fff',boxShadow:'0 1px 3px rgba(217,119,6,0.3)'},ghost:{...base,background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'},danger:{...base,background:'var(--red-bg)',color:'var(--red)',border:'0.5px solid var(--red-bd)'},success:{...base,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}};
  return e('button',{onClick:disabled?undefined:onClick,style:V[variant]||V.primary},icon&&e('i',{className:`ti ti-${icon}`,style:{fontSize:small?12:14}}),children);
}
function Card({children,style:sx={}}){return e('div',{style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-xs)',padding:'18px 20px',...sx}},children);}
function SectionHead({title,sub}){return e('div',{style:{marginBottom:14}},e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)'}},title),sub&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:2}},sub));}
function StatCard({label,val,sub,col}){return e('div',{style:{background:'var(--bg-base)',borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',padding:'14px 16px',flex:1,minWidth:90}},e('div',{style:{fontSize:11,color:'var(--tx-faint)',fontWeight:500,marginBottom:5}},label),e('div',{style:{fontSize:22,fontWeight:600,fontFamily:'var(--font-mono)',color:col||'var(--tx-primary)',lineHeight:1.15,letterSpacing:'-0.02em'}},val),sub&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:3}},sub));}
function Toast({msg,type='info',onClose}){
  useEffect(()=>{const t=setTimeout(onClose,3800);return()=>clearTimeout(t);},[]);
  const S={error:{bg:'var(--red-bg)',col:'var(--red)',bd:'var(--red-bd)',ic:'alert-circle'},success:{bg:'var(--green-bg)',col:'var(--green)',bd:'var(--green-bd)',ic:'circle-check'},info:{bg:'var(--amber-bg)',col:'var(--amber)',bd:'var(--amber-bd)',ic:'info-circle'}};
  const s=S[type]||S.info;
  return e('div',{className:'fade',style:{position:'fixed',bottom:24,right:24,zIndex:9999,background:s.bg,border:`1px solid ${s.bd}`,borderRadius:'var(--r-lg)',padding:'11px 16px',color:s.col,fontSize:12,fontWeight:500,display:'flex',alignItems:'center',gap:10,boxShadow:'var(--sh-md)',maxWidth:400}},e('i',{className:`ti ti-${s.ic}`,style:{fontSize:16,flexShrink:0}}),e('span',{style:{flex:1}},msg),e('button',{onClick:onClose,style:{background:'none',border:'none',color:s.col,cursor:'pointer',opacity:0.6,padding:2}},e('i',{className:'ti ti-x',style:{fontSize:13}})));
}
function Modal({title,children,onClose,width=520}){
  return e('div',{style:{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.25)',display:'flex',alignItems:'center',justifyContent:'center',padding:20},onClick:e=>e.target===e.currentTarget&&onClose()},
    e('div',{className:'fade',style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-xl)',boxShadow:'0 20px 60px rgba(0,0,0,0.15)',width:'100%',maxWidth:width,maxHeight:'85vh',display:'flex',flexDirection:'column'}},
      e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'16px 20px',borderBottom:'0.5px solid var(--bd-subtle)'}},
        e('span',{style:{fontSize:14,fontWeight:600,color:'var(--tx-primary)'}},title),
        e('button',{onClick:onClose,style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:4}},e('i',{className:'ti ti-x',style:{fontSize:18}}))
      ),
      e('div',{style:{overflowY:'auto',padding:'16px 20px',flex:1}},children)
    )
  );
}
function ConfirmModal({title,message,confirmLabel='确认',onConfirm,onClose}){
  return e(Modal,{title,onClose},
    e('div',{style:{fontSize:13,color:'var(--tx-secondary)',lineHeight:1.7,marginBottom:20}},message),
    e('div',{style:{display:'flex',gap:8,justifyContent:'flex-end'}},
      e(Btn,{variant:'ghost',onClick:onClose},'取消'),
      e(Btn,{onClick:()=>{onConfirm();onClose();}},confirmLabel)
    )
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   LIBRARY VIEW — split: scan stats always visible, dup stats only after match
   ═══════════════════════════════════════════════════════════════════════ */
function LibraryView(){
  const [stats,setStats]=useState(null);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{api.get('/api/stats').then(r=>{if(r.ok)setStats(r.data);}).finally(()=>setLoading(false));},[]);

  if(loading)return e('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:320,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}}));
  if(!stats||stats.total===0)return e('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:360,gap:12,color:'var(--tx-muted)'}},
    e('div',{style:{width:64,height:64,borderRadius:16,background:'var(--bg-muted)',display:'flex',alignItems:'center',justifyContent:'center'}},e('i',{className:'ti ti-music-off',style:{fontSize:30,color:'var(--tx-faint)'}})),
    e('div',{style:{fontSize:14,fontWeight:600,color:'var(--tx-secondary)'}},'音乐库为空'),
    e('div',{style:{fontSize:12,color:'var(--tx-faint)',textAlign:'center',lineHeight:1.8}},'请先在「设置」中配置扫描目录，然后在「扫描」中运行步骤')
  );

  const FMT_COL={FLAC:'#059669',MP3:'#2563EB',M4A:'#D97706',OGG:'#7C3AED',WAV:'#DC2626',AIFF:'#DC2626'};
  const totalFmts=(stats.formats||[]).reduce((a,f)=>a+f.n,0)||1;

  return e('div',{className:'fade'},
    // ── Scan stats (always show after enumeration) ─────────────────────
    e('div',{style:{marginBottom:8}},
      e('div',{style:{fontSize:11,fontWeight:600,color:'var(--tx-faint)',letterSpacing:'0.05em',textTransform:'uppercase',marginBottom:10}},
        '音乐库概况'),
      e('div',{style:{display:'flex',gap:10,flexWrap:'wrap',marginBottom:14}},
        e(StatCard,{label:'总曲目',val:fmtN(stats.total),sub:fmtBytes(stats.totalBytes)}),
        e(StatCard,{label:'专辑',val:fmtN(stats.albums)}),
        e(StatCard,{label:'艺术家',val:fmtN(stats.artists)}),
        e(StatCard,{label:'已提取元数据',val:fmtN(stats.withMeta),col:stats.withMeta===stats.total?'var(--green)':'var(--amber)'}),
        e(StatCard,{label:'已提取声纹',val:fmtN(stats.withFP),col:stats.withFP===stats.total?'var(--green)':'var(--amber)'}),
      ),
      e('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}},
        e(Card,null,
          e(SectionHead,{title:'格式分布'}),
          (stats.formats||[]).slice(0,8).map(f=>{const pct=f.n/totalFmts*100;const col=FMT_COL[f.format]||'#6B7280';return e('div',{key:f.format,style:{display:'flex',alignItems:'center',gap:10,marginBottom:9}},e('div',{style:{width:38,fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',textAlign:'right',fontWeight:500}},f.format),e('div',{style:{flex:1,height:6,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},e('div',{style:{width:pct.toFixed(1)+'%',height:'100%',background:col,borderRadius:99}})),e('div',{style:{width:40,fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-faint)',textAlign:'right'}},pct.toFixed(1)+'%'));})
        ),
        // ── Dup stats (only after matching) ──────────────────────────
        stats.dupGroups>0
          ?e(Card,null,
              e(SectionHead,{title:'重复概况'}),
              [{l:'重复组',v:fmtN(stats.dupGroups),c:'var(--red)'},{l:'重复文件',v:fmtN(stats.dupFiles),c:'var(--tx-primary)'},{l:'可释放',v:fmtBytes(stats.dupBytes),c:'var(--amber)'}].map(r=>
                e('div',{key:r.l,style:{display:'flex',justifyContent:'space-between',padding:'11px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
                  e('span',{style:{fontSize:12,color:'var(--tx-muted)'}},r.l),
                  e('span',{style:{fontSize:20,fontWeight:600,fontFamily:'var(--font-mono)',color:r.c,letterSpacing:'-0.02em'}},r.v)
                )
              )
            )
          :e(Card,null,
              e('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:120,gap:8,color:'var(--tx-faint)'}},
                e('i',{className:'ti ti-copy',style:{fontSize:28}}),
                e('div',{style:{fontSize:12,textAlign:'center',lineHeight:1.7}},'重复组信息在「相似度匹配」步骤完成后显示')
              )
            )
      )
    )
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   SCANNER VIEW — 4 independent steps + full rescan with confirmation
   ═══════════════════════════════════════════════════════════════════════ */
function ScannerView({onScanDone}){
  const [status,setStatus]=useState({phase:'idle',pct:0,running:false,message:''});
  const [logs,setLogs]=useState([]);
  const [confirm,setConfirm]=useState(null); // {steps, force, label}
  const logRef=useRef(null);

  useEffect(()=>{
    const es=new EventSource('/api/scan/stream');
    es.onmessage=ev=>{
      try{
        const d=JSON.parse(ev.data);
        setStatus(d);
        if(d.message){setLogs(p=>{if(p.length&&p[p.length-1].msg===d.message)return p;const ty=d.phase==='done'?'done':d.phase==='error'?'err':d.pct>=85?'ok':'info';return[...p.slice(-300),{msg:d.message,ty,phase:d.phase}];});}
        if(d.type==='done')onScanDone?.();
      }catch{}
    };
    return()=>es.close();
  },[]);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[logs]);

  const running=status.running;

  function startStep(steps,force=false,label=''){
    if(running)return;
    setLogs([]);
    api.post('/api/scan/start',{steps,force});
  }

  function tryStart(steps,force,label){
    if(force){setConfirm({steps,force,label});return;}
    startStep(steps,force,label);
  }

  const STEPS=[
    {key:'enum', label:'文件枚举',  desc:'扫描目录，发现所有音频文件',          icon:'folders',      steps:['enum']},
    {key:'meta', label:'提取元数据',desc:'解析 ID3/Vorbis 标签，更新数据库',   icon:'tag',          steps:['meta']},
    {key:'fp',   label:'提取声纹',  desc:'Goertzel 频谱指纹（跳过未修改文件）', icon:'wave-sine',    steps:['fp']},
    {key:'match',label:'相似度匹配',desc:'多阶段聚类，发现重复组',             icon:'circle-dashed', steps:['match']},
  ];

  const phaseActive=(key)=>status.phase===key||(status.phase==='meta'&&key==='meta')||(status.phase==='fp'&&key==='fp')||(status.phase==='enum'&&key==='enum')||(status.phase==='matching'&&key==='match');
  const phaseDone=(key,pct)=>(!running&&pct===100&&status.phase!=='idle')||(status.phase==='done');

  const LC={ok:'var(--green)',done:'var(--amber)',err:'var(--red)',info:'var(--tx-secondary)'};
  const PHASE_LABEL={idle:'就绪',enum:'文件枚举',meta:'元数据提取',fp:'声纹提取',matching:'相似度匹配',done:'完成 ✓',error:'错误',aborted:'已中止'};

  return e('div',{className:'fade'},
    confirm&&e(ConfirmModal,{
      title:'确认重新扫描',
      message:e('span',null,'将对「',e('b',null,confirm.label),'」执行',confirm.force?'强制全量提取（忽略修改时间，重新提取所有文件的元数据和声纹）':'重新执行','。'),
      confirmLabel:'确认执行',
      onConfirm:()=>startStep(confirm.steps,confirm.force,confirm.label),
      onClose:()=>setConfirm(null),
    }),

    // ── 4 step cards ──────────────────────────────────────────────────
    e('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:14}},
      STEPS.map(s=>e('div',{key:s.key,style:{background:'var(--bg-base)',border:`0.5px solid ${phaseActive(s.key)?'var(--amber)':'var(--bd-default)'}`,borderRadius:'var(--r-lg)',padding:'14px 16px',boxShadow:'var(--sh-xs)'}},
        e('div',{style:{display:'flex',alignItems:'center',gap:10,marginBottom:10}},
          e('div',{style:{width:32,height:32,borderRadius:8,background:phaseActive(s.key)?'var(--amber-bg)':'var(--bg-muted)',border:`1.5px solid ${phaseActive(s.key)?'var(--amber-bd)':'var(--bd-default)'}`,display:'flex',alignItems:'center',justifyContent:'center'}},
            phaseActive(s.key)&&running
              ?e('i',{className:'ti ti-loader spin',style:{fontSize:15,color:'var(--amber)'}})
              :e('i',{className:`ti ti-${s.icon}`,style:{fontSize:15,color:phaseActive(s.key)?'var(--amber)':'var(--tx-faint)'}})
          ),
          e('div',null,
            e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)'}},s.label),
            e('div',{style:{fontSize:11,color:'var(--tx-faint)',lineHeight:1.5}},s.desc)
          )
        ),
        e('div',{style:{display:'flex',gap:6,flexWrap:'wrap'}},
          e(Btn,{small:true,icon:'player-play',onClick:()=>tryStart(s.steps,false,s.label),disabled:running},'执行'),
          e(Btn,{small:true,variant:'ghost',icon:'refresh',onClick:()=>tryStart(s.steps,['enum'].includes(s.key)?false:true,s.label),disabled:running},'重新执行'),
        )
      ))
    ),

    // ── Full scan buttons ─────────────────────────────────────────────
    e(Card,{style:{marginBottom:14}},
      e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}},
        e('div',null,
          e('div',{style:{fontSize:13,fontWeight:600,marginBottom:3}},'完整扫描'),
          e('div',{style:{fontSize:11,color:'var(--tx-faint)'}},'按顺序执行全部四个步骤')
        ),
        e('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
          e(Btn,{icon:'radar',onClick:()=>startStep(['enum','meta','fp','match'],false),disabled:running},'继续扫描（智能）'),
          e(Btn,{variant:'ghost',icon:'refresh',onClick:()=>setConfirm({steps:['enum','meta','fp','match'],force:true,label:'完整重新扫描'}),disabled:running},'强制全量重扫'),
          running&&e(Btn,{variant:'danger',icon:'player-stop',onClick:()=>api.post('/api/scan/abort')},'中止')
        )
      )
    ),

    // ── Progress + log ────────────────────────────────────────────────
    status.phase!=='idle'&&e('div',{style:{marginBottom:12}},
      e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}},
        e('span',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)'}},(PHASE_LABEL[status.phase]||status.phase)+'…'),
        e('span',{style:{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--amber)'}},(status.pct||0)+'%')
      ),
      e('div',{style:{height:6,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},
        e('div',{style:{width:(status.pct||0)+'%',height:'100%',background:'var(--amber)',borderRadius:99,transition:'width 0.3s'}}))
    ),
    e('div',{style:{background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',overflow:'hidden'}},
      e('div',{style:{padding:'9px 14px',borderBottom:'0.5px solid var(--bd-subtle)',background:'var(--bg-subtle)',display:'flex',alignItems:'center',gap:6}},
        e('i',{className:'ti ti-terminal-2',style:{fontSize:13,color:'var(--tx-faint)'}}),
        e('span',{style:{fontSize:11,fontWeight:500,color:'var(--tx-muted)'}},'运行日志')
      ),
      e('div',{ref:logRef,style:{padding:'12px 14px',fontFamily:'var(--font-mono)',fontSize:11.5,lineHeight:1.85,height:180,overflowY:'auto'}},
        logs.length===0&&e('span',{style:{color:'var(--tx-faint)'}},'等待开始...'),
        logs.map((l,i)=>e('div',{key:i,style:{color:LC[l.ty]||'var(--tx-secondary)'}},e('span',{style:{color:'var(--bd-strong)',marginRight:8,userSelect:'none'}},'›'),l.msg)),
        running&&e('span',{className:'blink',style:{color:'var(--amber)'}},'█')
      )
    )
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FILE PROPERTIES MODAL
   ═══════════════════════════════════════════════════════════════════════ */
function PropertiesModal({fileId,onClose}){
  const [data,setData]=useState(null);
  useEffect(()=>{api.get(`/api/files/${fileId}`).then(r=>{if(r.ok)setData(r.data);});},[fileId]);

  if(!data)return e(Modal,{title:'文件属性',onClose},e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})));

  const rows=[
    ['完整路径',data.path],
    ['标题',data.title||'—'],['艺术家',data.artist||'—'],['专辑',data.album||'—'],
    ['年份',data.album_year||'—'],['音轨',data.track_number||'—'],
    ['格式',data.format||'—'],['比特率',data.bitrate?data.bitrate+'k':'—'],
    ['采样率',data.sample_rate?(data.sample_rate/1000).toFixed(1)+' kHz':'—'],
    ['位深',data.bits_per_sample?data.bits_per_sample+' bit':'—'],
    ['时长',data.duration?new Date(data.duration*1000).toISOString().slice(11,19):'—'],
    ['文件大小',fmtBytes(data.size)],
    ['修改时间',fmtDate(data.file_mtime)],
    ['声纹方法',data.fingerprint_method||'未提取'],
    ['元数据提取',fmtDate(data.meta_extracted_at)],
    ['声纹提取',fmtDate(data.fp_extracted_at)],
  ];

  return e(Modal,{title:'文件属性',onClose},
    rows.map(([k,v])=>e('div',{key:k,style:{display:'flex',gap:12,padding:'7px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
      e('div',{style:{fontSize:11,color:'var(--tx-faint)',width:80,flexShrink:0,paddingTop:1}},k),
      e('div',{style:{fontSize:12,color:'var(--tx-primary)',fontFamily:k==='完整路径'?'var(--font-mono)':undefined,wordBreak:'break-all',flex:1}},String(v))
    )),
    e('div',{style:{marginTop:12,display:'flex',gap:8,justifyContent:'flex-end'}},
      e(Btn,{icon:'folder-open',onClick:()=>api.post(`/api/files/${fileId}/reveal`)},'在文件管理器中显示'),
      e(Btn,{variant:'ghost',icon:'copy',onClick:()=>navigator.clipboard?.writeText(data.path)},'复制路径')
    )
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   DUPLICATES VIEW
   ═══════════════════════════════════════════════════════════════════════ */
function TrackRow({track,onToggle,canToggle,onWhitelist,onProperties}){
  const keep=!!track.keep;
  const wl=!!track.whitelisted;
  return e('div',{style:{display:'flex',alignItems:'center',gap:8,padding:'9px 12px',borderLeft:`3px solid ${wl?'var(--bd-strong)':keep?'var(--green)':'var(--red)'}`,background:wl?'var(--bg-muted)':keep?'#F0FDF4':'#FFF5F5',borderRadius:'0 6px 6px 0',marginBottom:4,opacity:wl?0.6:1}},
    e('button',{onClick:canToggle&&!wl?onToggle:undefined,title:wl?'已加入白名单':canToggle?(keep?'切换为删除':'切换为保留'):'至少保留一个',style:{background:'none',border:'none',padding:0,flexShrink:0,cursor:canToggle&&!wl?'pointer':'default',lineHeight:1}},
      e('i',{className:`ti ${wl?'ti-shield-check':keep?'ti-circle-check':'ti-trash'}`,style:{fontSize:17,color:wl?'var(--tx-faint)':keep?'var(--green)':'var(--red)'}})
    ),
    e('div',{style:{flex:1,minWidth:0}},
      e('div',{style:{display:'flex',alignItems:'center',gap:6,marginBottom:3,flexWrap:'wrap'}},
        e('span',{style:{fontSize:12,fontWeight:500,color:'var(--tx-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:200}},track.title||'—'),
        e(QBadge,{format:track.format,bitrate:track.bitrate,sample_rate:track.sample_rate}),
        wl&&e(Tag,{children:'白名单',color:'#6B7280',bg:'var(--bg-muted)'}),
        track.release_type==='single'&&e(Tag,{children:'单曲'}),
        track.release_type==='compilation'&&e(Tag,{children:'合辑'}),
      ),
      e('div',{style:{fontSize:10,color:'var(--tx-faint)',fontFamily:'var(--font-mono)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},track.path)
    ),
    e('div',{style:{textAlign:'right',flexShrink:0,minWidth:72}},
      e('div',{style:{fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',fontWeight:500}},fmtBR(track.bitrate,track.format)),
      e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:1}},fmtBytes(track.size))
    ),
    // Action buttons
    e('div',{style:{display:'flex',flexDirection:'column',gap:3,flexShrink:0}},
      e('button',{onClick:()=>api.post(`/api/files/${track.id}/reveal`),title:'在文件管理器中显示',style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:'2px 4px',borderRadius:4,lineHeight:1}},e('i',{className:'ti ti-folder-open',style:{fontSize:14}})),
      e('button',{onClick:onProperties,title:'查看属性',style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:'2px 4px',borderRadius:4,lineHeight:1}},e('i',{className:'ti ti-info-circle',style:{fontSize:14}})),
      e('button',{onClick:onWhitelist,title:wl?'从白名单移除':'加入白名单（不参与重复检测）',style:{background:'none',border:'none',cursor:'pointer',color:wl?'var(--amber)':'var(--tx-faint)',padding:'2px 4px',borderRadius:4,lineHeight:1}},e('i',{className:`ti ${wl?'ti-shield-filled':'ti-shield-plus'}`,style:{fontSize:14}}))
    )
  );
}

function GroupDetail({group,onResolve,onToggle,onWhitelist,loading}){
  const [propsFileId,setPropsFileId]=useState(null);
  if(loading)return e('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:280,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:26}}));
  if(!group)return e('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:10,height:280,color:'var(--tx-faint)',fontSize:12}},e('div',{style:{width:56,height:56,background:'var(--bg-muted)',borderRadius:12,display:'flex',alignItems:'center',justifyContent:'center'}},e('i',{className:'ti ti-click',style:{fontSize:26}})),'从左侧选择重复组查看详情');

  const keep=group.tracks?.find(t=>t.keep);
  const dels=group.tracks?.filter(t=>!t.keep&&!t.whitelisted)||[];
  const savings=dels.reduce((a,t)=>a+(t.size||0),0);
  const maxSize=Math.max(...(group.tracks||[]).map(t=>t.size||1));
  const keepCount=(group.tracks||[]).filter(t=>t.keep&&!t.whitelisted).length;
  const TL={format_diff:'格式差异',single_vs_album:'单曲vs专辑',name_diff:'名称不同',name_partial:'名称相似'};

  return e('div',{className:'fade'},
    propsFileId&&e(PropertiesModal,{fileId:propsFileId,onClose:()=>setPropsFileId(null)}),
    e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14,gap:12}},
      e('div',{style:{flex:1,minWidth:0}},
        e('div',{style:{fontSize:14,fontWeight:600,marginBottom:6,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},keep?.title||'—',' ',e('span',{style:{fontSize:12,color:'var(--tx-faint)',fontWeight:400}},keep?.artist?'— '+keep.artist:'')),
        e('div',{style:{display:'flex',gap:5,flexWrap:'wrap'}},
          e(Tag,{children:`相似度 ${group.similarity}%`,color:'#92400E',bg:'var(--amber-bg)',border:'var(--amber-bd)'}),
          e(Tag,{children:TL[group.type]||group.type})
        )
      ),
      group.resolved?e(Btn,{variant:'success',icon:'circle-check',disabled:true},'已处理'):
      dels.length>0?e(Btn,{onClick:()=>onResolve(group.id),icon:'check'},`确认删除 ${dels.length} 个`):
      e('span',{style:{fontSize:11,color:'var(--tx-faint)',padding:'7px 0'}},dels.length===0?'所有曲目已加入白名单':'')
    ),
    // Size bars
    e('div',{style:{background:'var(--bg-subtle)',border:'0.5px solid var(--bd-subtle)',borderRadius:'var(--r-md)',padding:'10px 12px',marginBottom:10}},
      e('div',{style:{fontSize:10,color:'var(--tx-faint)',marginBottom:8}},'文件大小对比'),
      (group.tracks||[]).map(t=>e('div',{key:t.id,style:{display:'flex',alignItems:'center',gap:8,marginBottom:5}},
        e('div',{style:{width:96,fontSize:10,fontFamily:'var(--font-mono)',color:t.keep?'var(--green)':'var(--tx-faint)',textAlign:'right',flexShrink:0,fontWeight:t.keep?600:400}},fmtBR(t.bitrate,t.format)),
        e('div',{style:{flex:1,height:8,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},e('div',{style:{width:(t.size/maxSize*100).toFixed(1)+'%',height:'100%',background:t.keep?'var(--green)':'var(--red)',opacity:t.keep?0.85:0.3,borderRadius:99}})),
        e('div',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-faint)',width:58,flexShrink:0,textAlign:'right'}},fmtBytes(t.size))
      ))
    ),
    e('div',{style:{marginBottom:10}},
      e('div',{style:{fontSize:10,color:'var(--tx-faint)',marginBottom:7,display:'flex',alignItems:'center',gap:5}},
        e('i',{className:'ti ti-hand-click',style:{fontSize:11}}),'点击左侧图标切换保留/删除 · 右侧图标：打开目录 / 属性 / 白名单'),
      (group.tracks||[]).map(t=>e(TrackRow,{key:t.id,track:t,
        onToggle:()=>onToggle(group.id,t.id,!t.keep,!t.keep?'手动指定保留':'手动指定删除'),
        canToggle:!group.resolved&&!(t.keep&&keepCount<=1),
        onWhitelist:()=>onWhitelist(t.id,!!t.whitelisted,group.id),
        onProperties:()=>setPropsFileId(t.id),
      }))
    ),
    e('div',{style:{background:'var(--bg-subtle)',border:'0.5px solid var(--bd-subtle)',borderRadius:'var(--r-md)',padding:'10px 12px'}},
      e('div',{style:{fontSize:11,fontWeight:600,color:'var(--tx-secondary)',marginBottom:6,display:'flex',alignItems:'center',gap:5}},e('i',{className:'ti ti-sparkles',style:{fontSize:13,color:'var(--amber)'}}),'智能决策依据'),
      e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.7}},keep?.keep_reason||'—'),
      !group.resolved&&savings>0&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:8,display:'flex',alignItems:'center',gap:5}},e('i',{className:'ti ti-device-floppy',style:{fontSize:12}}),'确认后释放约 '+fmtBytes(savings))
    )
  );
}

function DuplicatesView({setPendingCount}){
  const [filter,setFilter]=useState('pending');
  const [sort,setSort]=useState('savings');
  const [groups,setGroups]=useState([]);
  const [selId,setSelId]=useState(null);
  const [detail,setDetail]=useState(null);
  const [detailLoading,setDetailLoading]=useState(false);
  const [listLoading,setListLoading]=useState(true);
  const [toast,setToast]=useState(null);
  const [showBatch,setShowBatch]=useState(false);

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

  async function resolve(id){
    const r=await api.post('/api/duplicates/'+id+'/resolve');
    if(r.ok){setToast({msg:`已处理，删除 ${r.deleted?.length||0} 个文件`,type:'success'});loadList();if(detail?.id===id)setDetail(d=>d?{...d,resolved:1}:d);setPendingCount(n=>Math.max(0,(n||1)-1));}
    else setToast({msg:'操作失败: '+(r.error||'未知'),type:'error'});
  }
  async function resolveAll(){setShowBatch(false);const r=await api.post('/api/duplicates/resolve-all');if(r.ok){setToast({msg:`批量完成，删除 ${r.deletedCount} 个文件，处理 ${r.groupsProcessed} 组`,type:'success'});loadList();setPendingCount(0);}else setToast({msg:'批量操作失败',type:'error'});}
  async function toggleTrack(gid,fid,keep,reason){const r=await api.put(`/api/duplicates/${gid}/tracks/${fid}/keep`,{keep,reason});if(r.ok)setDetail(r.data);else setToast({msg:r.error||'失败',type:'error'});}
  async function handleWhitelist(fileId,isWl,groupId){
    if(isWl){await api.del(`/api/whitelist/${fileId}`);}
    else{await api.post(`/api/whitelist/${fileId}`);}
    // Refresh detail
    const r=await api.get('/api/duplicates/'+groupId);
    if(r.ok)setDetail(r.data);
    setToast({msg:isWl?'已从白名单移除，重新匹配后生效':'已加入白名单，此文件将不再参与重复检测',type:'success'});
  }

  const pending=groups.filter(g=>!g.resolved);
  const totalSavings=pending.reduce((a,g)=>a+(g.savings_bytes||0),0);

  return e('div',{className:'fade'},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    // toolbar
    e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12,gap:8,flexWrap:'wrap'}},
      e('div',{style:{display:'flex',gap:6,alignItems:'center'}},
        e('div',{style:{display:'flex',background:'var(--bg-muted)',padding:2,borderRadius:'var(--r-md)',gap:2}},
          ...[['pending','待处理'],['done','已处理'],['all','全部']].map(([f,l])=>e('button',{key:f,onClick:()=>{setFilter(f);setSelId(null);},style:{padding:'4px 12px',fontSize:11,fontWeight:filter===f?600:400,cursor:'pointer',borderRadius:'var(--r-sm)',background:filter===f?'var(--bg-base)':'transparent',color:filter===f?'var(--tx-primary)':'var(--tx-muted)',border:'none',boxShadow:filter===f?'var(--sh-xs)':'none',transition:'all 0.15s'}},l))
        ),
        e('select',{value:sort,onChange:ev=>setSort(ev.target.value),style:{fontSize:11,padding:'5px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'}},
          e('option',{value:'savings'},'按可释放空间'),e('option',{value:'sim'},'按相似度'),e('option',{value:'files'},'按文件数')
        )
      ),
      filter!=='done'&&pending.length>0&&e('div',{style:{display:'flex',gap:8,alignItems:'center'}},
        e('span',{style:{fontSize:11,color:'var(--tx-faint)'}},`${pending.length} 组 · ${fmtBytes(totalSavings)}`),
        e(Btn,{onClick:()=>setShowBatch(true),icon:'checks',small:true},'批量确认全部')
      )
    ),
    showBatch&&e('div',{className:'fade',style:{background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)',padding:'14px 18px',marginBottom:12,display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}},
      e('div',{style:{flex:1}},e('div',{style:{fontSize:13,fontWeight:600,color:'#92400E',marginBottom:4}},'确认批量操作'),e('div',{style:{fontSize:12,color:'#A16207'}},'处理 ',e('b',null,pending.length),' 个重复组，释放约 ',e('b',null,fmtBytes(totalSavings)),'。文件移入系统回收站。')),
      e('div',{style:{display:'flex',gap:8}},e(Btn,{onClick:resolveAll,icon:'check'},'确认执行'),e(Btn,{variant:'ghost',onClick:()=>setShowBatch(false),icon:'x'},'取消'))
    ),
    e('div',{style:{display:'grid',gridTemplateColumns:'236px 1fr',gap:14,minHeight:460}},
      // Left list
      e('div',{style:{overflowY:'auto',maxHeight:580}},
        listLoading?e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})):
        groups.length===0?e('div',{style:{color:'var(--tx-faint)',fontSize:12,padding:'24px 0',textAlign:'center',lineHeight:1.8}},filter==='pending'?'暂无待处理重复组':'暂无数据'):
        groups.map(g=>{
          const isSel=g.id===selId,savings=g.savings_bytes||0;
          const dispTitle=detail?.id===g.id?detail.tracks?.find(t=>t.keep)?.title||`组 #${g.id}`:`组 #${g.id}`;
          const artist=detail?.id===g.id?detail.tracks?.find(t=>t.keep)?.artist||'':'';
          return e('div',{key:g.id,onClick:()=>setSelId(g.id),style:{padding:'10px 12px',borderRadius:'var(--r-lg)',cursor:'pointer',background:isSel?'var(--amber-bg)':'var(--bg-base)',border:`0.5px solid ${isSel?'var(--amber-bd)':'var(--bd-default)'}`,boxShadow:isSel?`0 0 0 1px var(--amber-bd)`:'var(--sh-xs)',opacity:g.resolved?0.6:1,transition:'all 0.12s',marginBottom:4}},
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}},e('span',{style:{fontSize:12,fontWeight:500,color:isSel?'#92400E':'var(--tx-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:160,flex:1}},dispTitle),e('i',{className:`ti ${g.resolved?'ti-circle-check':'ti-alert-circle'}`,style:{fontSize:13,color:g.resolved?'var(--green)':'var(--amber)',flexShrink:0,marginLeft:4}})),
            artist&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginBottom:5,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},artist),
            e('div',{style:{display:'flex',gap:4,flexWrap:'wrap'}},e(Tag,{children:`${g.track_count||'?'}个文件`}),savings>0&&e(Tag,{children:fmtBytes(savings),color:'#92400E',bg:'#FEF3C7',border:'#FDE68A'}),e(Tag,{children:g.similarity+'%'}))
          );
        })
      ),
      e(Card,{style:{minHeight:400}},e(GroupDetail,{group:selId&&detail?.id===selId?detail:null,onResolve:resolve,onToggle:toggleTrack,onWhitelist:handleWhitelist,loading:detailLoading&&selId!=null}))
    )
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   RULES VIEW — simplified, no technical details
   ═══════════════════════════════════════════════════════════════════════ */
function RulesView(){
  const RuleItem=({icon,title,desc})=>e('div',{style:{display:'flex',gap:12,alignItems:'flex-start',padding:'14px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
    e('div',{style:{width:32,height:32,borderRadius:8,background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},e('i',{className:`ti ti-${icon}`,style:{fontSize:15,color:'var(--amber)'}})),
    e('div',null,e('div',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',marginBottom:4}},title),e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.7}},desc))
  );
  return e('div',{className:'fade',style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}},
    e(Card,null,
      e(SectionHead,{title:'保留策略',sub:'重复组中如何选择保留哪个版本'}),
      e(RuleItem,{icon:'diamond',title:'音质最优',desc:'无损格式（FLAC、WAV）优先于有损格式（MP3、M4A）；更高比特率优先于低比特率；Hi-Res 高清版本最优先。'}),
      e(RuleItem,{icon:'calendar',title:'首发版本',desc:'音质相同时，选择发行年份最早的正式专辑版本。精选集、合辑视为二次发行，不视为首发。'}),
      e(RuleItem,{icon:'vinyl',title:'专辑完整性',desc:'同时存在专辑版和单曲版时：若本地已收藏该专辑中 2 首以上曲目，保留专辑版；否则保留单曲版。'}),
      e(RuleItem,{icon:'tag',title:'信息完整性',desc:'以上条件均相同时，优先保留标签信息（封面、曲目号、年份）最完整的文件。'})
    ),
    e(Card,null,
      e(SectionHead,{title:'重复识别',sub:'哪些情况会被认定为重复'}),
      e(RuleItem,{icon:'copy',title:'相同录音',desc:'即使格式、比特率不同，同一录音的 FLAC 版与 MP3 版会被识别为重复，因为声纹来自音频内容，与编码无关。'}),
      e(RuleItem,{icon:'git-merge',title:'多途径比对',desc:'首先精确匹配声纹，再对照歌曲名称（自动从文件名提取），最后通过时长等特征兜底，最大程度找出潜在重复。'}),
      e(RuleItem,{icon:'shield',title:'白名单例外',desc:'对某首曲目点击白名单图标后，该文件将被排除在重复检测之外，不会再出现在任何重复组中。重新匹配后生效。'}),
      e(RuleItem,{icon:'adjustments',title:'手动覆盖',desc:'可随时在重复组中手动切换任意曲目的保留/删除状态，覆盖自动建议。文件实际删除前需逐组确认。'})
    )
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   SETTINGS VIEW — editable quality priority, incremental scan, step params
   ═══════════════════════════════════════════════════════════════════════ */
function SettingsView(){
  const [settings,setSettings]=useState(null);
  const [newDir,setNewDir]=useState('');
  const [saveState,setSaveState]=useState('idle');
  const [toast,setToast]=useState(null);
  const saveTimer=useRef(null);
  const isFirst=useRef(true);

  const DEFAULT_QUALITY=[
    'Hi-Res FLAC / WAV (96kHz+)',
    'FLAC / WAV (44.1kHz)',
    'AIFF',
    'M4A / AAC ≥ 256k',
    'MP3 320k',
    'MP3 256k',
    'MP3 192k',
    'OGG / Opus',
    'MP3 128k 及以下',
  ];

  useEffect(()=>{api.get('/api/settings').then(r=>{if(r.ok){const s=r.data;if(!s.quality_tiers||s.quality_tiers==='null')s.quality_tiers=[...DEFAULT_QUALITY];setSettings(s);}});},[]);

  useEffect(()=>{
    if(!settings)return;
    if(isFirst.current){isFirst.current=false;return;}
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current=setTimeout(()=>{
      api.put('/api/settings',settings).then(r=>{
        if(r.ok){setSaveState('saved');setTimeout(()=>setSaveState('idle'),2200);}
        else{setSaveState('error');setToast({msg:'自动保存失败',type:'error'});}
      });
    },700);
    return()=>clearTimeout(saveTimer.current);
  },[settings]);

  function addDir(){if(!newDir.trim())return;setSettings(s=>({...s,scan_dirs:[...(s.scan_dirs||[]),newDir.trim()]}));setNewDir('');}
  function removeDir(i){setSettings(s=>({...s,scan_dirs:(s.scan_dirs||[]).filter((_,j)=>j!==i)}));}
  function moveQuality(i,dir){
    const q=[...(settings.quality_tiers||DEFAULT_QUALITY)];
    const j=i+dir;
    if(j<0||j>=q.length)return;
    [q[i],q[j]]=[q[j],q[i]];
    setSettings(s=>({...s,quality_tiers:q}));
  }

  const SaveIndicator=()=>e('div',{style:{display:'flex',alignItems:'center',gap:6,fontSize:11,height:28}},
    saveState==='saving'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-loader spin',style:{fontSize:12}}),'保存中...'),
    saveState==='saved'&&e('span',{className:'fade',style:{color:'var(--green)',display:'flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-circle-check',style:{fontSize:12}}),'已自动保存'),
    saveState==='error'&&e('span',{style:{color:'var(--red)',display:'flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-alert-circle',style:{fontSize:12}}),'保存失败'),
    saveState==='idle'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-device-floppy',style:{fontSize:12}}),'修改后自动保存')
  );

  if(!settings)return e('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:320,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}}));

  const quality=settings.quality_tiers||DEFAULT_QUALITY;

  return e('div',{className:'fade'},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    e('div',{style:{display:'flex',justifyContent:'flex-end',marginBottom:8}},e(SaveIndicator)),
    e('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}},
      e('div',{style:{display:'flex',flexDirection:'column',gap:14}},
        // Scan dirs
        e(Card,null,
          e(SectionHead,{title:'扫描目录'}),
          (settings.scan_dirs||[]).length===0&&e('div',{style:{color:'var(--tx-faint)',fontSize:12,padding:'6px 0 10px',display:'flex',alignItems:'center',gap:6}},e('i',{className:'ti ti-info-circle',style:{fontSize:13}}),'暂未配置'),
          (settings.scan_dirs||[]).map((d,i)=>e('div',{key:i,style:{display:'flex',alignItems:'center',gap:8,padding:'7px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)',marginBottom:6}},
            e('i',{className:'ti ti-folder-filled',style:{fontSize:14,color:'var(--amber)',flexShrink:0}}),
            e('span',{title:d,style:{flex:1,fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},d),
            e('button',{onClick:()=>removeDir(i),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',padding:'2px 4px',borderRadius:'var(--r-sm)',flexShrink:0}},e('i',{className:'ti ti-x',style:{fontSize:13}}))
          )),
          e('div',{style:{display:'flex',gap:6}},
            e('input',{value:newDir,onChange:ev=>setNewDir(ev.target.value),onKeyDown:ev=>ev.key==='Enter'&&addDir(),placeholder:'/Volumes/Music  或  D:\\Music',style:{flex:1,fontSize:11,padding:'7px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',fontFamily:'var(--font-mono)',outline:'none'}}),
            e(Btn,{onClick:addDir,small:true,icon:'plus'},'添加')
          )
        ),
        // Exclude
        e(Card,null,
          e(SectionHead,{title:'排除规则',sub:'逗号分隔，支持 glob 通配符'}),
          e('textarea',{value:(settings.exclude_patterns||[]).join(', '),onChange:ev=>setSettings(s=>({...s,exclude_patterns:ev.target.value.split(',').map(x=>x.trim()).filter(Boolean)})),style:{width:'100%',fontSize:11,fontFamily:'var(--font-mono)',padding:'8px 10px',borderRadius:'var(--r-md)',background:'var(--bg-subtle)',border:'0.5px solid var(--bd-default)',color:'var(--tx-secondary)',resize:'none',height:64,lineHeight:1.7,outline:'none'}}),
          e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:4}},'示例：*.tmp, .DS_Store, Thumbs.db')
        ),
        // Detection params
        e(Card,null,
          e(SectionHead,{title:'检测参数'}),
          e('div',{style:{marginBottom:14}},
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)'}},'声纹相似度阈值'),e('span',{style:{fontSize:16,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},(settings.threshold||90)+'%')),
            e('input',{type:'range',min:70,max:100,step:1,value:settings.threshold||90,onChange:ev=>setSettings(s=>({...s,threshold:+ev.target.value}))}),
            e('div',{style:{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--tx-faint)',marginTop:4}},e('span','70% 宽松'),e('span','100% 精确'))
          ),
          e('div',{style:{marginBottom:10}},
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)'}},'并发线程数'),e('span',{style:{fontSize:16,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},settings.threads||8)),
            e('input',{type:'range',min:1,max:32,value:settings.threads||8,onChange:ev=>setSettings(s=>({...s,threads:+ev.target.value}))}),
            e('div',{style:{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--tx-faint)',marginTop:4}},e('span','1'),e('span','32'))
          ),
          // Smart scan toggle
          e('div',{style:{display:'flex',alignItems:'flex-start',gap:10,padding:'10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',border:'0.5px solid var(--bd-subtle)'}},
            e('input',{type:'checkbox',id:'smart',checked:settings.smart_scan!==false,onChange:ev=>setSettings(s=>({...s,smart_scan:ev.target.checked})),style:{marginTop:2,flexShrink:0,accentColor:'var(--amber)'}}),
            e('label',{htmlFor:'smart',style:{fontSize:12,color:'var(--tx-secondary)',cursor:'pointer',lineHeight:1.6}},
              '智能增量扫描 ',e('span',{style:{color:'var(--green)',fontWeight:600}},'（推荐）'),
              e('br'),e('span',{style:{fontSize:11,color:'var(--tx-faint)'}},'根据文件修改时间自动跳过未变更的文件，节省大量时间')
            )
          )
        )
      ),
      // Quality priority (editable)
      e('div',null,
        e(Card,null,
          e(SectionHead,{title:'音质优先级',sub:'拖动调整顺序 — 顶部优先级最高'}),
          quality.map((f,i)=>e('div',{key:f,style:{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',marginBottom:4,border:'0.5px solid var(--bd-subtle)'}},
            e('span',{style:{width:20,fontSize:11,fontFamily:'var(--font-mono)',fontWeight:700,color:i<3?'var(--green)':i<6?'var(--amber)':'var(--tx-faint)',textAlign:'center',flexShrink:0}},i+1),
            e('span',{style:{flex:1,fontSize:12,color:i<6?'var(--tx-secondary)':'var(--tx-faint)'}},f),
            i===0&&e(Tag,{children:'最优',color:'#065F46',bg:'var(--green-bg)',border:'var(--green-bd)'}),
            e('div',{style:{display:'flex',flexDirection:'column',gap:2,flexShrink:0}},
              e('button',{onClick:()=>moveQuality(i,-1),disabled:i===0,style:{background:'none',border:'none',cursor:i===0?'default':'pointer',padding:'1px 4px',opacity:i===0?0.2:1,color:'var(--tx-muted)'}},e('i',{className:'ti ti-chevron-up',style:{fontSize:13}})),
              e('button',{onClick:()=>moveQuality(i,1),disabled:i===quality.length-1,style:{background:'none',border:'none',cursor:i===quality.length-1?'default':'pointer',padding:'1px 4px',opacity:i===quality.length-1?0.2:1,color:'var(--tx-muted)'}},e('i',{className:'ti ti-chevron-down',style:{fontSize:13}}))
            )
          ))
        )
      )
    )
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   APP SHELL
   ═══════════════════════════════════════════════════════════════════════ */
function App(){
  const [view,setView]=useState('library');
  const [pendingCount,setPendingCount]=useState(0);
  useEffect(()=>{api.get('/api/stats').then(r=>{if(r.ok&&r.data)setPendingCount(r.data.pendingGroups||0);});},[]);

  const TABS=[{id:'library',label:'音乐库',icon:'music'},{id:'scanner',label:'扫描',icon:'radar'},{id:'duplicates',label:'重复组',icon:'copy',badge:pendingCount},{id:'rules',label:'规则',icon:'filter'},{id:'settings',label:'设置',icon:'settings'}];

  return e('div',{style:{display:'flex',flexDirection:'column',height:'100vh',overflow:'hidden',background:'var(--bg-subtle)'}},
    e('header',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 24px',height:52,background:'var(--bg-base)',borderBottom:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',flexShrink:0,zIndex:10}},
      e('div',{style:{display:'flex',alignItems:'center',gap:10}},
        e('div',{style:{width:30,height:30,background:'linear-gradient(135deg,#FDE68A 0%,#D97706 100%)',borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 1px 3px rgba(217,119,6,0.25)'}},e('i',{className:'ti ti-music-heart',style:{fontSize:16,color:'#fff'}})),
        e('span',{style:{fontWeight:700,fontSize:15,color:'var(--tx-primary)',letterSpacing:'-0.015em'}},'MusicDedup'),
        e('span',{style:{fontSize:11,color:'var(--tx-faint)',background:'var(--bg-muted)',padding:'2px 8px',borderRadius:4,border:'0.5px solid var(--bd-default)',fontFamily:'var(--font-mono)'}},'v1.1')
      ),
      e('div',{style:{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'var(--tx-faint)'}},
        e('span',{style:{width:7,height:7,borderRadius:'50%',background:'var(--green)',display:'inline-block',boxShadow:'0 0 0 2px #D1FAE5'}}),
        '运行中 ·',e('span',{style:{fontFamily:'var(--font-mono)',color:'var(--tx-muted)'}},location.host)
      )
    ),
    e('nav',{style:{display:'flex',borderBottom:'0.5px solid var(--bd-default)',padding:'0 24px',background:'var(--bg-base)',flexShrink:0,gap:2}},
      TABS.map(t=>e('button',{key:t.id,onClick:()=>setView(t.id),style:{display:'flex',alignItems:'center',gap:6,padding:'10px 14px',cursor:'pointer',fontSize:12,fontWeight:view===t.id?600:400,color:view===t.id?'var(--amber)':'var(--tx-muted)',background:'none',border:'none',outline:'none',borderBottom:view===t.id?'2px solid var(--amber)':'2px solid transparent',marginBottom:-1,transition:'all 0.15s'}},
        e('i',{className:`ti ti-${t.icon}`,style:{fontSize:15}}),t.label,
        t.badge?e('span',{style:{fontSize:10,fontWeight:700,background:'var(--amber)',color:'#fff',borderRadius:8,padding:'1px 6px',minWidth:16,textAlign:'center'}},t.badge):null
      ))
    ),
    e('main',{style:{flex:1,overflowY:'auto',padding:24}},
      view==='library'   &&e(LibraryView),
      view==='scanner'   &&e(ScannerView,{onScanDone:()=>api.get('/api/stats').then(r=>{if(r.ok)setPendingCount(r.data.pendingGroups||0);})}),
      view==='duplicates'&&e(DuplicatesView,{setPendingCount}),
      view==='rules'     &&e(RulesView),
      view==='settings'  &&e(SettingsView),
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(e(App));
