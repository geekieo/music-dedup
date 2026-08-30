/* ═══════════════════════════════════════════════════════════════════════
   SCANNER VIEW — 三阶段流程卡：① 音乐库更新 → ② 重复匹配（基础/声纹/刮削
   三法平行，可独立执行）→ ③ 智能保留。每个单元自带 执行 + 下拉（全量重新
   执行 / 刮削未命中重新执行）；整流程走标题栏「一键执行」。全量重新执行
   折叠在单元下拉 + 确认框里。
   `scan` (status/logs/...) is owned by App so it survives tab
   switches — see useScanStream().
   ═══════════════════════════════════════════════════════════════════════ */
const LANE_META={
  library:{label:'音乐库更新',sub:'扫描·读取标签',desc:'扫描音乐目录，发现音乐文件并读取标题、艺术家、专辑等信息，更新音乐库。',icon:'folders',steps:['enum','meta']},
  basic:{label:'基础匹配',sub:'按标签比对',desc:'按标题、艺术家和时长比对，找出重复候选，不依赖声纹。',icon:'tag',steps:['basicMatch']},
  // fp lane — 技术细节：频谱声纹相似度比对；不同编码/母带间的相位差异会让相似度偏低，
  // 因此声纹匹配不单独作为判定唯一依据（阈值 + 基础匹配兜底）。
  fp:{label:'声纹匹配',sub:'按指纹比对',desc:'对比音频声纹找出重复。声纹匹配不作为判定重复的唯一依据。',icon:'wave-sine',steps:['fp','fpMatch']},
  scrape:{label:'刮削匹配',sub:'按刮削数据比对',desc:'联网查询录音信息，两个文件命中同一条录音即视为重复。',icon:'cloud-download',steps:['scrape','scrapeMatch']},
  smartKeep:{label:'智能保留',sub:'计算保留结果',desc:'按当前应用的保留优先级，计算所有未处理重复组的推荐保留。',icon:'star',steps:['smartKeep']},
};
// phase → 所属阶段单元：全量执行时点亮当前方法卡
const PHASE_LANE={starting:'library',enum:'library',meta:'library',basicMatch:'basic',fp:'fp',fpMatch:'fp',scrape:'scrape',scrapeMatch:'scrape',smartKeep:'smartKeep'};
function ScannerView({scan,hasPlayer}){
  const{status,logs,setLogs,confirm,setConfirm,startStep}=scan;
  const[runningLane,setRunningLane]=useState(null);
  const[advanced,setAdvanced]=useState({});
  const logRef=useRef(null);
  // 「一键执行」按钮组宽度 = 智能保留卡按钮行（= 卡内容宽）实测值：flex 1:3:1 并非
  // 五卡严格等宽（首尾框受内容影响略宽），calc 假设等宽会对不齐；ResizeObserver 跟随
  // 真实宽度，任意窗口/chrome 都自动对齐。卡按钮行无横向内边距，border-box 即内容宽。
  const smartKeepRef=useRef(null);
  const[groupW,setGroupW]=useState(null);
  useLayoutEffect(()=>{
    const el=smartKeepRef.current;
    if(!el)return;
    const measure=()=>setGroupW(el.getBoundingClientRect().width);
    measure();
    const ro=new ResizeObserver(measure);
    ro.observe(el);
    return()=>ro.disconnect();
  },[]);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[logs]);
  useEffect(()=>{if(!status.running)setRunningLane(null);},[status.running]);

  function runLane(key,force=false){
    const lm=LANE_META[key];
    if(force){setConfirm({steps:lm.steps,force:true,label:lm.label,lane:key});return;}
    setRunningLane(key);
    startStep(lm.steps,false,lm.label);
  }
  function runAll(force=false){
    const steps=['enum','meta','basicMatch','fp','fpMatch','scrape','scrapeMatch','smartKeep'];
    if(force){setConfirm({steps,force:true,label:'完整扫描',lane:'all'});return;}
    setRunningLane('all');
    startStep(steps,false,'完整扫描');
  }

  // 终态判定（scan.js finally）：done/error/aborted 且 running=false 才算整轮扫描结束。
  // 注意匹配步骤完成点会以 running=true 发 phase:'done'，必须用 !running 门控，
  // 否则运行中途会把进度卡误判成终态（"匹配完成"而非"运行完成"）。
  const TERMINAL=['done','error','aborted'];
  const isTerminal=TERMINAL.includes(status.phase)&&!status.running;
  const SUM_META={
    done:{icon:'circle-check',color:'var(--green)',bg:'var(--green-bg)',bd:'var(--green-bd)',text:'完成'},
    error:{icon:'alert-circle',color:'var(--red)',bg:'var(--red-bg)',bd:'var(--red-bd)',text:'错误'},
    aborted:{icon:'player-stop',color:'var(--tx-secondary)',bg:'var(--bg-subtle)',bd:'var(--bd-default)',text:'已中止'},
  };
  const summaryText=(status.message||'').replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/,'')||(SUM_META[status.phase]&&SUM_META[status.phase].text)||'完成';
  // 活动行文字去时间戳（[HH:MM:SS] 是"现在"信息，日志里才有意义；进度块里是噪声）
  const actText=(status.subMessage||status.message||'').replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/,'');
  // 内联子进度%仅在与总%明显不同时显示——meta/fp 阶段二者相同，避免冗余
  const showInlineSub=status.subPct!=null&&status.subPct>0&&Math.abs(status.subPct-(status.pct||0))>1;
  const LC={ok:'var(--amber)',done:'var(--green)',err:'var(--red)',info:'var(--tx-secondary)',sep:'var(--amber)'};
  // PlayerBar 在普通流中（存在时占 ~64px），日志用 flex:1 吃掉剩余高度，精确适配所有窗口尺寸，
  // 日志正文永不超出 main 可视区，底部最新行不会被播放器遮住。
  const PLAYER_H=hasPlayer?64:0;
  // 顶栏 54 + main 上下内边距 40：扫描页根高度钉在 main 可视区（100vh - 顶栏 - 播放器）。
  const CHROME_H=54+40;

  const activeLane=status.running?(runningLane==='all'?(PHASE_LANE[status.phase]||null):runningLane):null;
  const advDropdown=key=>{
    const items=[
      {label:'全量重新执行',run:()=>key==='all'?runAll(true):runLane(key,true)},
      ...(key==='scrape'?[{label:'未命中重新执行',run:()=>{setRunningLane(key);startStep(LANE_META[key].steps,false,LANE_META[key].label,{retryMissed:true});}}]:[])
    ];
    return e('div',{style:{position:'absolute',top:'100%',left:0,right:0,marginTop:4,background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',boxShadow:'var(--sh-md)',padding:6,display:'flex',flexDirection:'column',gap:4}},
      items.map(it=>e('button',{key:it.label,onClick:()=>{it.run();setAdvanced(p=>({...p,[key]:false}));},disabled:status.running,style:{width:'100%',padding:'5px 6px',fontSize:10,fontWeight:500,borderRadius:'var(--r-sm)',background:'var(--bg-muted)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',cursor:status.running?'not-allowed':'pointer',opacity:status.running?.65:1,display:'flex',alignItems:'center',gap:4,justifyContent:'center'}},Icon('refresh',{fontSize:11}),it.label))
    );
  };
  const renderUnit=key=>{
    const lm=LANE_META[key],isActive=activeLane===key,open=advanced[key];
    return e('div',{style:{flex:1,minWidth:0,display:'flex',flexDirection:'column'}},
      e('div',{style:{display:'flex',alignItems:'center',gap:8,minWidth:0}},
        e('div',{style:{width:32,height:32,borderRadius:8,background:isActive?'var(--amber-bg)':'var(--bg-muted)',border:`1.5px solid ${isActive?'var(--amber)':'var(--bd-default)'}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
          isActive?e('i',{className:'ti ti-loader spin',style:{fontSize:14,color:'var(--amber)'}}):Icon(lm.icon,{fontSize:14,color:'var(--tx-faint)'})
        ),
        e('div',{style:{minWidth:0,flex:1}},
          e('div',{style:{display:'flex',alignItems:'center',gap:3,minWidth:0}},
            e('span',{style:{fontSize:13,fontWeight:600,color:'var(--tx-primary)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',minWidth:0,flex:1}},lm.label),
            e(Hint,{text:lm.desc})
          ),
          e('div',{style:{fontSize:10,color:'var(--tx-faint)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',marginTop:1}},lm.sub)
        )
      ),
      e('div',{...(key==='smartKeep'?{ref:smartKeepRef}:{}),style:{position:'relative',zIndex:open?100:'auto',marginTop:'auto',paddingTop:8,display:'flex',gap:5,alignItems:'center'}},
        e(Btn,{onClick:()=>runLane(key,false),disabled:status.running,icon:'player-play',style:{flex:1,justifyContent:'center'}},'执行'),
        e('button',{onClick:()=>setAdvanced(p=>({...p,[key]:!open})),style:{height:30,padding:'0 9px',background:'none',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',cursor:'pointer',color:open?'var(--amber)':'var(--tx-faint)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},e('i',{className:`ti ti-chevron-${open?'up':'down'}`,style:{fontSize:11}})),
        open&&advDropdown(key)
      )
    );
  };
  const unitCard=key=>e('div',{style:{flex:'1 1 0',minWidth:100,background:activeLane===key?'var(--amber-bg)':'var(--bg-base)',border:`0.5px solid ${activeLane===key?'var(--amber-bd)':'var(--bd-default)'}`,borderRadius:'var(--r-md)',padding:'10px 12px'}},renderUnit(key));
  // 三阶段统一包框卡片：bg-subtle 阶段框 + 内部统一单元卡；一三阶段放一个单元，二阶段放三个。
  const stageFrame=(keys,widthStyle)=>e('div',{style:{...widthStyle,border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',background:'var(--bg-subtle)',padding:8,display:'flex',gap:8}},keys.map(unitCard));

  return e('div',{className:'fade',style:{display:'flex',flexDirection:'column',height:`calc(100vh - ${CHROME_H+PLAYER_H}px)`,minHeight:0}},
    confirm&&e(ConfirmModal,{
      title:'确认全量重新执行',
      message:e('span',null,'将对「',e('b',null,confirm.label),'」执行全量重提取，忽略智能跳过逻辑（按修改时间/是否存在判断），所有相关文件会被重新处理，耗时会明显更长。'),
      onConfirm:()=>{setRunningLane(confirm.lane||'all');startStep(confirm.steps,confirm.force,confirm.label);},
      onClose:()=>setConfirm(null),
      danger:true,
    }),

    // 三阶段流程卡：① → ②（三法平行）→ ③；每个单元独立执行。三个阶段统一
    // 包框卡片（bg-subtle 阶段框 + 内部单元卡），一三阶段放一个单元、二阶段放三个；
    // 单元图标带 32×32 包框，运行时换 loader 旋转。
    e(Card,{style:{marginBottom:12}},
      // 标题行左右内缩 21px（= 阶段框边框 0.5 + 内边距 8 + 单元卡边框 0.5 + 内边距 12），
      // 用 margin 内缩（不改行盒宽）；雷达图标盒对齐单元图标盒。
      // 「一键执行」按钮组右对齐最右边的「执行」按钮组；「一键执行」与「执行」按钮同宽。
      e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}},
        e('div',{style:{display:'flex',alignItems:'center',gap:9,marginLeft:21}},
          e('div',{style:{width:32,height:32,borderRadius:8,background:status.running?'var(--amber-bg)':'var(--bg-muted)',border:`1.5px solid ${status.running?'var(--amber)':'var(--bd-default)'}`,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},
            status.running?e('i',{className:'ti ti-loader spin',style:{fontSize:14,color:'var(--amber)'}}):Icon('radar',{fontSize:14,color:'var(--tx-faint)'})
          ),
          e('div',{style:{fontSize:14,fontWeight:500,color:'var(--tx-primary)'}},'扫描流程')
        ),
        e('div',{style:{position:'relative',zIndex:advanced.all?100:'auto',display:'flex',justifyContent:'flex-end',gap:5,flex:'1 1 0%',minWidth:'max-content',maxWidth:groupW?groupW+'px':'calc((100% - 24px)/5 - 42px)',marginRight:21}},
          e(Btn,{icon:'player-play',onClick:()=>runAll(false),disabled:status.running,style:{flex:1,justifyContent:'center'}},'一键执行'),
          e('button',{onClick:()=>setAdvanced(p=>({...p,all:!p.all})),style:{height:30,padding:'0 9px',background:'none',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',cursor:'pointer',color:advanced.all?'var(--amber)':'var(--tx-faint)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}},e('i',{className:`ti ti-chevron-${advanced.all?'up':'down'}`,style:{fontSize:11}})),
          advanced.all&&advDropdown('all')
        )
      ),
      e('div',{style:{display:'flex',alignItems:'stretch',gap:12}},
        // 阶段框按 1:3:1（flex basis 0）平分剩余空间，随窗口伸缩；minWidth:0 使基准
        // 不受内容最小宽约束。二阶段内卡间距 8×2 使三张卡比一/三阶段卡宽约 6px，接受。
        stageFrame(['library'],{flex:'1 1 0',minWidth:0}),
        stageFrame(['basic','fp','scrape'],{flex:'3 1 0',minWidth:0}),
        stageFrame(['smartKeep'],{flex:'1 1 0',minWidth:0})
      )
    ),

    // Transparent backdrop — closes any open advanced dropdown when user
    // clicks/touches/scrolls anywhere outside the button area.
    Object.values(advanced).some(Boolean)&&e('div',{
      onClick:()=>setAdvanced({}),
      onWheel:()=>setAdvanced({}),
      style:{position:'fixed',inset:0,zIndex:99}
    }),

    // 常驻进度卡（Steam「管理下载」式）—— 三态：
    //   idle：默认态，按钮置灰（无可暂停/停止对象）、进度条空、短默认文本「就绪」；
    //   运行中：单进度条 + 活动行（内联子%仅在与总%明显不同时显示）；
    //   终态(done/error/aborted)：保持卡片、不提供关闭、不收起进度条，用 绿/红/灰 完成文本
    //     （如「运行完成」+ 最终消息），下次扫描开始自动复位。
    // 相位语义：匹配步骤完成点会以 running=true 发 phase:'done'（matcher 完成消息），
    // 必须用 isTerminal（done/error/aborted 且 !running）区分"单步完成"与"整轮扫描结束"。
    (()=>{
      const TERM_LABEL={done:'运行完成',error:'错误',aborted:'已中止'};
      const RUN_LABEL={idle:'就绪',starting:'准备中',enum:'文件枚举',meta:'文件属性提取',basicMatch:'基础匹配',fp:'声纹提取',fpMatch:'声纹匹配',scrape:'刮削',scrapeMatch:'刮削匹配',smartKeep:'智能保留'};
      const phaseLabel=isTerminal
        ?(TERM_LABEL[status.phase]||'完成')
        :(status.phase==='done'?'匹配完成':(RUN_LABEL[status.phase]||status.phase));
      const phaseColor=isTerminal?(SUM_META[status.phase]?.color||'var(--tx-primary)'):'var(--tx-secondary)';
      const phaseIcon=isTerminal
        ?Icon(SUM_META[status.phase]?.icon||'circle-check',{fontSize:14,color:phaseColor,flexShrink:0})
        :status.running
          ?e('i',{className:'ti ti-loader spin',style:{fontSize:14,color:'var(--amber)'}})
          :Icon('radar',{fontSize:14,color:'var(--tx-faint)'});
      const barFill=status.paused?'var(--tx-faint)':(isTerminal?(SUM_META[status.phase]?.color||'var(--amber)'):'var(--amber)');
      const pct=status.pct||0;
      // 活动/完成行 —— 常驻固定高度（各状态都渲染），保证卡片上下高度一致不跳变。
      // 空闲显示占位（ ），运行中显示活动行，终态显示绿/红/灰完成文本。
      const lineText=isTerminal?summaryText:actText;
      const lineColor=isTerminal?phaseColor:'var(--tx-faint)';
      return e('div',{style:{background:'var(--bg-base)',border:`0.5px solid ${status.paused?'var(--amber-bd)':'var(--bd-default)'}`,borderRadius:'var(--r-lg)',padding:'12px 16px',marginBottom:10,boxShadow:'var(--sh-xs)'}},
        e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8,flexWrap:'wrap',gap:8}},
          e('span',{style:{fontSize:12,fontWeight:500,color:phaseColor,display:'flex',alignItems:'center',gap:6}},
            status.paused&&Icon('pause',{fontSize:12,color:'var(--amber)'}),
            phaseIcon,phaseLabel
          ),
          e('div',{style:{display:'flex',alignItems:'center',gap:10}},
            // 按钮行常驻（非运行置灰）——隐藏会造成卡片高度变化，尺寸须各状态一致
            e('div',{style:{display:'flex',gap:6}},
              e(Btn,{small:true,variant:'ghost',icon:status.paused?'player-play':'pause',onClick:()=>(status.paused?scan.resume():scan.pause()),disabled:!status.running},status.paused?'继续':'暂停'),
              e(Btn,{small:true,variant:'danger',icon:'player-stop',onClick:()=>api.post('/api/scan/abort'),disabled:!status.running},'停止')
            ),
            e('span',{style:{fontSize:13,fontFamily:'var(--font-mono)',fontWeight:600,color:isTerminal?phaseColor:(pct>0?'var(--amber)':'var(--tx-faint)')}},pct+'%')
          )
        ),
        e('div',{style:{height:5,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden'}},
          e('div',{style:{width:pct+'%',height:'100%',background:barFill,borderRadius:99,transition:'width .3s'}})),
        e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:6,gap:8,minHeight:16}},
          e('span',{style:{fontSize:10.5,color:lineColor,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1}},lineText||' '),
          (!isTerminal&&showInlineSub)&&e('span',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-faint)',flexShrink:0}},'· '+(status.subPct||0)+'%')
        )
      );
    })(),

    // Log — progressive, never cleared mid-session
    e('div',{style:{flex:1,minHeight:0,display:'flex',flexDirection:'column',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',overflow:'hidden',boxShadow:'var(--sh-xs)'}},
      e('div',{style:{flexShrink:0,padding:'8px 14px',borderBottom:'0.5px solid var(--bd-subtle)',background:'var(--bg-subtle)',display:'flex',alignItems:'center',justifyContent:'space-between'}},
        e('div',{style:{display:'flex',alignItems:'center',gap:6}},Icon('terminal-2',{fontSize:13,color:'var(--tx-faint)'}),e('span',{style:{fontSize:11,fontWeight:500,color:'var(--tx-muted)'}},'运行日志')),
        e('button',{onClick:()=>setLogs([]),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',fontSize:11,display:'flex',alignItems:'center',gap:4}},Icon('trash',{fontSize:12}),'清空')
      ),
      e('div',{ref:logRef,style:{flex:1,minHeight:0,overflowY:'auto',padding:'10px 14px',fontFamily:'var(--font-mono)',fontSize:11.5,lineHeight:1.85,wordBreak:'break-all'}},
        logs.length===0&&e('span',{style:{color:'var(--tx-faint)'}},'等待开始...'),
        logs.map((l,i)=>e('div',{key:i,style:{color:l.ty==='sep'?'var(--amber)':LC[l.ty]||'var(--tx-secondary)',fontWeight:l.ty==='sep'?600:400}},l.ty==='sep'?l.msg:((m=>{const ts=m[1],txt=m[2];return e('span',null,e('span',{style:{color:'var(--bd-strong)',marginRight:8,userSelect:'none'}},'›'),ts&&e('span',{style:{color:'var(--tx-faint)',marginRight:6,userSelect:'none',fontWeight:400}},ts),e('span',null,txt))})(l.msg.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/)||['',null,l.msg])))),
        status.running&&e('span',{className:'blink',style:{color:'var(--amber)'}},'█')
      )
    )
  );
}
