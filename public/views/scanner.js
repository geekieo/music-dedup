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
        e('div',{style:{width:(status.pct||0)+'%',height:'100%',background:status.paused?'var(--tx-faint)':'var(--amber)',borderRadius:99,transition:'width .3s'}})),
      // 子进度条 — 展示长耗时步骤（刮削/声纹匹配等）内部的详细进度
      status.subPct!=null&&status.subPct>0&&e('div',{style:{marginTop:6}},
        e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:3}},
          e('span',{style:{fontSize:10,color:'var(--tx-faint)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1}},status.subMessage||status.message||''),
          e('span',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-faint)',marginLeft:8}},(status.subPct||0)+'%')
        ),
        e('div',{style:{height:3,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},
          e('div',{style:{width:(status.subPct||0)+'%',height:'100%',background:status.paused?'var(--tx-faint)':'var(--amber-bd)',borderRadius:99,transition:'width .15s'}}))
      )
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
