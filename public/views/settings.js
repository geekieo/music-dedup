/* ══════════════════════════════════════════════════════════════════════
   SETTINGS VIEW — F6: single scrollable page, anchored sections:
   扫描目录 → 基础匹配 → 声纹匹配 → 刮削匹配 → 智能保留 → 手动保留 → 最近写入.
   A sticky left rail jumps to each anchor. Explanatory text that used to
   sit as an always-visible box is now a hover-revealed Hint next to the
   heading it explains, except 重复组标签 which IS the reference itself
   and stays visible. F8: changes auto-SAVE; a match-affecting change
   (时长容差/声纹阈值/排除规则/音质优先级/AcoustID Key) lights the corresponding
   执行模块卡 (基础匹配/声纹匹配/更新音乐库/智能保留/刮削匹配) at the top of the
   column — the button re-runs that module only, never re-extracts fp/scrape.
   智能保留优先级修改只点亮「智能保留」卡，点「立即重新计算」才应用到现有重复组。
   ══════════════════════════════════════════════════════════════════════ */
const SETTINGS_SECTIONS=[
  {id:'sec-dirs',    label:'音乐目录',   icon:'folders'},
  {id:'sec-basic',   label:'基础匹配',   icon:'tag'},
  {id:'sec-fp',      label:'声纹匹配',   icon:'wave-sine'},
  {id:'sec-scrape',  label:'刮削匹配',   icon:'cloud-download'},
  {id:'sec-smartkeep', label:'智能保留', icon:'priority-podium'},
  {id:'sec-wl',      label:'手动保留', icon:'shield-check'},
  {id:'sec-history', label:'最近写入',   icon:'edit'},
];
// DEFAULT_Q, DEFAULT_PICK, mergePickOrder are served by /rules-meta.js (source: lib/rules.js)

// 每张设置卡可恢复默认的键与默认值。仅覆盖「有默认值且可选范围广」的设置
// （滑块、优先级排序）；输入框与二值开关不做恢复默认。quality_tiers/pick_tag_order
// 需新鲜数组，避免与全局 DEFAULT_* 共享引用。恢复默认只改本卡的键，不动其他卡。
// 音乐目录卡不放按钮：其主体（scan_dirs）是用户数据，无默认值。
const CARD_DEFAULTS={
  'sec-scan-perf': ()=>({ threads:null }),
  'sec-basic':     ()=>({ duration_tolerance:5 }),
  'sec-fp':        ()=>({ threshold:90 }),
  'sec-smartkeep': ()=>({ quality_tiers:[...DEFAULT_Q], pick_tag_order:[...DEFAULT_PICK] }),
};
// 恢复默认按钮的悬停说明：告诉用户该卡具体重置什么。
const RESET_HINT={
  'sec-scan-perf': '恢复默认：并发数回到自动（按 CPU 核数）',
  'sec-basic':     '恢复默认：时长容差回到 5 秒',
  'sec-fp':        '恢复默认：相似度阈值回到 90%',
  'sec-smartkeep': '恢复默认：音质与保留优先级回到默认顺序',
};
// 撤销快照与当前值比较时归一化：字符串"90"与数字 90 视为相同，数组按内容比较。
const sameVal=(a,b)=>Array.isArray(a)||Array.isArray(b)?JSON.stringify(a)===JSON.stringify(b):String(a)===String(b);

// 左栏保存状态指示。必须是模块级组件：内联在 SettingsView 里每次父重渲染都是新函数
// 标识，React 视为新组件类型而卸载重挂载子树，其内 className:'fade' 的「已保存」span
// 会反复重放淡入动画（滚动/任意重渲染时闪烁）。提为模块级后 span 只在状态真正变
// 成 'saved' 时挂载一次，fade 只播一次。
function SaveStatus({saveState}){
  return e('div',{style:{fontSize:11,height:26,display:'flex',alignItems:'center',gap:5}},
    saveState==='saving'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-loader spin',style:{fontSize:12}}),'保存中...'),
    saveState==='saved'&&e('span',{className:'fade',style:{color:'var(--green)',display:'flex',alignItems:'center',gap:4}},Icon('circle-check',{fontSize:12}),'已保存'),
    saveState==='idle'&&e('span',{style:{color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},Icon('device-floppy',{fontSize:12}),'修改后自动保存')
  );
}

function WriteHistorySection({writeHistoryKey,player,onLocateFile,onLocate,onLocateInDuplicates,onTagsWritten}){
  const[rows,setRows]=useState(null);
  const[toast,setToast]=useState(null);
  const[search,setSearch]=useState('');
  const[purgeConfirm,setPurgeConfirm]=useState(null); // {fileId,title}
  const[inGroupMap,setInGroupMap]=useState({}); // {[fileId]: groupId|null}
  const{confirmAction,confirmDialog}=useConfirmAction();
  function load(){
    api.get('/api/snapshots').then(r=>{
      if(r.ok){
        const data=r.data||[];
        setRows(data);
        const ids=data.filter(r=>r.file_id).map(r=>r.file_id);
        if(ids.length){
          api.post('/api/files/in-groups',{ids}).then(r2=>{
            if(r2.ok)setInGroupMap(r2.data||{});
          });
        }
      }
    });
  }
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
    if(r.ok){setToast({msg:'已撤销至首次写入前的原始状态',type:'success'});load();onTagsWritten?.();}
    else setToast({msg:'撤销失败: '+(r.error||''),type:'error'});
  }
  async function doPurge(){
    if(!purgeConfirm)return;
    await api.del(`/api/snapshots/${purgeConfirm.fileId}`);
    setToast({msg:'已彻底删除写入历史',type:'success'});
    setPurgeConfirm(null);load();
  }

  const filtered=filterBySearch(rows||[],search,[
    r=>(r.file_title||r.cur_title||''),
    r=>(r.file_artist||r.cur_artist||''),
    r=>(r.cur_album||''),
    r=>(r.file_path||'')
  ]);

  // [列名, 固定布局列宽] — 列宽总和 100%，fixed 布局下表格恒等于容器宽，不撑破设置列
  const COLS=[['播放','6%'],['标题','16%'],['艺术家','13%'],['修改字段','14%'],['修改时间','15%'],['剩余天数','14%'],['操作','22%']];

  return e(Card,{id:'sec-history',style:{minHeight:100}},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    confirmDialog,
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
            e(SearchInput,{value:search,onChange:setSearch,style:{marginBottom:8}}),
            e('div',{style:{maxHeight:'calc(100vh - 340px)',minHeight:60,overflowY:'auto',borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)'}},
              e('table',{style:{width:'100%',tableLayout:'fixed',borderCollapse:'collapse',fontSize:12}},
                e('thead',null,e('tr',{style:{borderBottom:'0.5px solid var(--bd-default)',background:'var(--bg-subtle)'}},
                  ...COLS.map(([h,w])=>e('th',{key:h,style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',whiteSpace:'nowrap',fontSize:11,width:w,overflow:'hidden'}},h))
                )),
                e('tbody',null,filtered.length===0
                  ? e('tr',null,e('td',{colSpan:COLS.length,style:{padding:'14px',textAlign:'center',color:'var(--tx-faint)'}},'无匹配结果'))
                  : filtered.map(r=>{
                      const title=r.file_title||r.cur_title||'';
                      const artist=r.file_artist||r.cur_artist||'';
                      const fields=JSON.parse(r.modified_fields||'[]');
                      const FIELD_LABELS={title:'标题',artist:'艺术家',album:'专辑',album_year:'年份',track_number:'曲目号',genre:'流派'};
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
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-muted)',fontSize:11}},fields.map(f=>FIELD_LABELS[f]||f).join('、')||'—'),
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:10,whiteSpace:'nowrap',overflow:'hidden'}},dtStr),
                        e('td',{style:{padding:'6px 10px',color:daysColor,fontFamily:'var(--font-mono)',fontSize:10,textAlign:'center',whiteSpace:'nowrap',overflow:'hidden'}},`${daysLeft}天`),
                        e('td',{style:{padding:'4px 8px'}},
                          e('div',{style:{display:'flex',gap:3,alignItems:'center'}},
                            onLocateFile&&e(IconAction,{icon:'music-locate',title:'在音乐库中查看',onClick:()=>onLocateFile(r.file_id)}),
                            e(IconAction,{
                              icon:'group-locate',
                              title:inGroupMap[r.file_id]?'在重复组中查看':'该文件不在任何重复组中',
                              onClick:inGroupMap[r.file_id]?()=>onLocateInDuplicates&&onLocateInDuplicates(inGroupMap[r.file_id]):undefined,
                              disabled:!inGroupMap[r.file_id]
                            }),
                            e(IconAction,{icon:'arrow-back-up',title:'撤销至原始状态',
                              onClick:()=>confirmAction('write-history-revert',{
                                title:'撤销至原始状态',
                                message:e('span',null,'确定要将「',e('b',null,title||'未知文件'),'」撤销至首次写入前的原始标签状态吗？此操作将覆盖当前所有标签。'),
                                danger:false,
                              },()=>revert(r.file_id))}),
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


function RetentionListSection({player,retentionListKey,onLocateFile,onLocate,onLocateInDuplicates}){
  const[rows,setRows]=useState([]);
  const[loading,setLoading]=useState(true);
  const[toast,setToast]=useState(null);
  const[search,setSearch]=useState('');
  const[inGroupMap,setInGroupMap]=useState({}); // {[fileId]: groupId|null}
  const{confirmAction,confirmDialog}=useConfirmAction();
  function load(){
    setLoading(true);
    api.get('/api/retention-list').then(r=>{
      if(r.ok){
        const data=r.data||[];
        setRows(data);
        if(data.length){
          const ids=data.map(f=>f.id);
          api.post('/api/files/in-groups',{ids}).then(r2=>{
            if(r2.ok)setInGroupMap(r2.data||{});
          });
        }
      }
    }).finally(()=>setLoading(false));
  }
  useEffect(()=>{load();},[]);
  useEffect(()=>{if(retentionListKey>0)load();},[retentionListKey]);
  async function remove(id){await api.del(`/api/retention-list/${id}`);setToast({msg:'已从手动保留名单移除',type:'success'});load();}

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

  const filtered=filterBySearch(rows,search,['title','artist','album','path']);

  return e(Card,{id:'sec-wl',style:{minHeight:120}},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    confirmDialog,
    e(SH,{title:`手动保留（${rows.length} 个文件）`,sub:'你手动标记保留的文件，参与重复检测但不会被删除'}),
    loading?e('div',{style:{textAlign:'center',padding:30,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:22}})):
    rows.length===0
      ? e('div',{style:{textAlign:'center',padding:'24px 0',color:'var(--tx-faint)',lineHeight:2}},
          Icon('shield-check',{fontSize:28,display:'block',margin:'0 auto 8px'}),
          '手动保留名单为空',e('br'),e('span',{style:{fontSize:11}},'在"音乐库"或"重复组"中可将文件标记为保留'))
      : e('div',null,
          e(SearchInput,{value:search,onChange:setSearch,style:{marginBottom:8}}),
          e('div',{style:{maxHeight:'calc(100vh - 320px)',minHeight:80,overflowY:'auto',borderRadius:'var(--r-lg)',border:'0.5px solid var(--bd-default)'}},
            e('table',{style:{width:'100%',tableLayout:'fixed',borderCollapse:'collapse',fontSize:12}},
              e('thead',null,e('tr',{style:{borderBottom:'0.5px solid var(--bd-default)',background:'var(--bg-subtle)'}},
                ...[['','7%'],['标题','23%'],['艺术家','17%'],['专辑','17%'],['格式','16%'],['操作','20%']].map(([h,w])=>e('th',{key:h,style:{padding:'8px 10px',textAlign:'left',fontWeight:600,color:'var(--tx-secondary)',whiteSpace:'nowrap',fontSize:11,width:w,overflow:'hidden'}},h))
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
                          e(IconAction,{
                            icon:'group-locate',
                            title:inGroupMap[f.id]?'在重复组中查看':'该文件不在任何重复组中',
                            onClick:inGroupMap[f.id]?()=>onLocateInDuplicates&&onLocateInDuplicates(inGroupMap[f.id]):undefined,
                            disabled:!inGroupMap[f.id]
                          }),
                          e(IconAction,{icon:'shield-x',title:'移除手动保留',danger:true,
                            onClick:()=>confirmAction('retention-remove',{
                              title:'移除手动保留',
                              message:e('span',null,'确定要将「',e('b',null,f.title||'未知文件'),'」从手动保留名单中移除吗？移除后该文件将在重复处理时不再受保护。'),
                              danger:true,
                            },()=>remove(f.id))})
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

// 常驻执行卡：设置列顶部（音乐目录卡上方）的常驻琥珀卡，无滑动动画。滑动卡
// （ExecuteToast）消失后在此就地显现；visible=false 时仍占位（visibility:hidden），
// 保证滑动卡展示期间下方内容零位移——卡显现只翻转显隐、不动布局。
function ExecutePinnedCard({visible,message,btnLabel,btnIcon='refresh',onAction,onClose,disabled,disabledLabel}){
  return e('div',{style:{visibility:visible?'visible':'hidden',display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-md)'}},
    Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
    e('div',{style:{fontSize:12,color:'var(--tx-secondary)',flex:1,minWidth:0}},message),
    btnLabel&&e(Btn,{small:true,icon:btnIcon,disabled,onClick:onAction},disabled?disabledLabel:btnLabel),
    e('button',{onClick:onClose,title:'关闭',style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-muted)',padding:4,flexShrink:0}},Icon('x',{fontSize:14}))
  );
}

// 滑动执行卡：系统通知式固定层（position:fixed，锚定视口、不随内容页滚动、不触发滚动条），
// 停在设置内容页顶部位置（顶栏 54 + main 内边距 20 = 74）。从视口上方下滑出现，停留 holdMs
// 后上滑消失，消失完成后回调 onDone（父级据此放行对应常驻卡显现）。key 变化（新卡触发 /
// 同卡再次修改）即重挂载重播动画。只在有按钮的卡触发（无按钮卡不设此层）。
function ExecuteToast({config,pos,onDone}){
  const[phase,setPhase]=useState('entering'); // entering|shown|leaving|hidden
  useEffect(()=>{
    const raf=requestAnimationFrame(()=>requestAnimationFrame(()=>setPhase('shown')));
    const hold=setTimeout(()=>setPhase('leaving'),config.holdMs||4000);
    return ()=>{cancelAnimationFrame(raf);clearTimeout(hold);};
  },[]);
  // active=false（如值回到已应用基线）时提前上滑退出，不必等 hold 结束
  useEffect(()=>{
    if(phase!=='hidden'&&phase!=='leaving'&&config.active===false)setPhase('leaving');
  },[config.active,phase]);
  useEffect(()=>{
    if(phase==='leaving'){
      const t=setTimeout(()=>{setPhase('hidden');onDone?.();},300);
      return ()=>clearTimeout(t);
    }
  },[phase]);
  if(phase==='hidden')return null;
  // 初始/退出时整卡上移出视口（锚点上方），shown 时落到锚点
  const y=phase==='shown'?'0':'calc(-100% - 90px)';
  return e('div',{style:{position:'fixed',top:pos.top,left:pos.left,width:pos.width,zIndex:50,
    display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',
    border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-md)',
    transform:`translateY(${y})`,transition:'transform .3s ease'}},
    Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
    e('div',{style:{fontSize:12,color:'var(--tx-secondary)',flex:1,minWidth:0}},config.message),
    config.btnLabel&&e(Btn,{small:true,icon:config.btnIcon,disabled:config.disabled,onClick:()=>{config.onAction?.();setPhase('leaving');}},config.disabled?config.disabledLabel:config.btnLabel),
    e('button',{onClick:()=>setPhase('leaving'),title:'关闭',style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-muted)',padding:4,flexShrink:0}},Icon('x',{fontSize:14}))
  );
}

function SettingsView({dirs,onAddDir,onRemoveDir,onEnumOnly,onDismissDirChanged,dirChanged,dirSeq,onMatchAffectingChange,onScrapeReapply,scanRunning,player,retentionListKey,writeHistoryKey,onLocateFile,onNavigateToDuplicateGroup,onLocate,mainScrollRef,onTagsWritten,active}){
  // 并发默认值 = 自动 min(12, 物理核)（主进程经 /api/system/info 查询；非 SMT 机型也能用满物理核）
  const [autoThreads,setAutoThreads]=useState(Math.min(12, Math.round((navigator.hardwareConcurrency||8)/2)));
  const[s,setS]=useState(null);
  const[saveState,setSaveState]=useState('idle');
  const[showExclude,setShowExclude]=useState(false);
  // 各执行模块的「待重新应用」触发态：只有影响最终结果的设置变更才点亮对应模块的卡。
  // 扫描性能（threads）不影响最终结果，不触发任何卡。每张卡独立 show + seq（再次修改重新滑动）。
  const[basicPending,setBasicPending]=useState(false); // 基础匹配模块 ← duration_tolerance
  const[basicSeq,setBasicSeq]=useState(0);
  const[fpPending,setFpPending]=useState(false);       // 声纹匹配模块 ← threshold
  const[fpSeq,setFpSeq]=useState(0);
  const[keepPending,setKeepPending]=useState(false);   // 智能保留模块 ← quality_tiers/pick_tag_order（与 applied 快照比对，执行后才收起）
  const[keepSeq,setKeepSeq]=useState(0);               // 智能保留参数再次修改时递增，驱动琥珀卡重新滑动
  const[excludePending,setExcludePending]=useState(false); // 音乐库更新模块 ← exclude_patterns（与 scan_dirs 同卡）
  const[excludeSeq,setExcludeSeq]=useState(0);
  const[reapplying,setReapplying]=useState(false);
  const[acoustidValidating,setAcoustidValidating]=useState(false);
  const[acoustidValidResult,setAcoustidValidResult]=useState(null); // null|{ok,error}
  const[acoustidValidatedKey,setAcoustidValidatedKey]=useState(''); // last key that passed validation
  const[acoustidKeyDirty,setAcoustidKeyDirty]=useState(false);
  const[needsScrapeReapply,setNeedsScrapeReapply]=useState(false);
  const[scrapeSeq,setScrapeSeq]=useState(0); // 每次 AcoustID Key 变更验证通过递增，驱动刮削卡重新滑动
  const[fpcalc,setFpcalc]=useState(null);
  const[fpcalcPathDirty,setFpcalcPathDirty]=useState(false);
  const[fpcalcChecking,setFpcalcChecking]=useState(false);
  const[browsingFpcalc,setBrowsingFpcalc]=useState(false);
  const[undoSnapshots,setUndoSnapshots]=useState({}); // {[cardId]: 该卡最近一次修改（恢复默认/手动调整）前的各键值} — 撤销快照按卡一份
  const saveTimer=useRef(null);
  const draggingRange=useRef(false); // 滑块拖动中不保存（松开时一次提交，见 commitRange）
  useEffect(()=>{api.get('/api/system/fpcalc').then(r=>{if(r.ok)setFpcalc(r.data);});},[]);
  useEffect(()=>{api.get('/api/system/info').then(r=>{if(r.ok&&r.data?.physicalCores)setAutoThreads(Math.min(12, r.data.physicalCores));});},[]);
  async function recheckFpcalc(pathOverride){
    setFpcalcChecking(true);
    try{
      // 仅字符串视为显式路径；onClick 直接透传会收到事件对象，此时回退到当前设置值。
      const p=(typeof pathOverride==='string'?pathOverride:(s?.fpcalc_path||'')).trim();
      const r=await api.get('/api/system/fpcalc?path='+encodeURIComponent(p));
      if(r.ok){setFpcalc(r.data);setFpcalcPathDirty(false);}
    } finally { setFpcalcChecking(false); }
  }
  // 浏览选择 fpcalc 所在目录：选中后写回设置并标记 dirty，交由下方自动重检生效。
  async function browseFpcalc(){
    setBrowsingFpcalc(true);
    try{
      const r=await api.post('/api/browse-folder?title='+encodeURIComponent('选择 fpcalc 所在目录'));
      if(r.ok&&r.path){setS(p=>({...p,fpcalc_path:r.path}));setFpcalcPathDirty(true);}
    } catch {} finally { setBrowsingFpcalc(false); }
  }
  // 自定义路径变更后防抖自动重新检测（与自动保存节奏一致），改完即有反馈。
  useEffect(()=>{
    if(!s||!fpcalcPathDirty)return;
    const p=(s.fpcalc_path||'').trim();
    const t=setTimeout(()=>recheckFpcalc(p),700);
    return ()=>clearTimeout(t);
  },[s?.fpcalc_path]);
  // 捕获该卡当前值为撤销快照（覆盖旧快照）。skipIfDefault：已默认时跳过——
  // 重复按恢复默认不会用默认值覆盖快照，撤销目标始终是恢复/修改前的保存数值。
  function captureSnapshot(cardId,{skipIfDefault=false}={}){
    if(!s)return;
    const def=CARD_DEFAULTS[cardId];
    if(!def)return;
    const defaults=def();
    const keys=Object.keys(defaults);
    if(skipIfDefault&&keys.every(k=>sameVal(s[k],defaults[k])))return;
    const snap={};for(const k of keys)snap[k]=s[k];
    setUndoSnapshots(prev=>({...prev,[cardId]:snap}));
  }
  // 当前值是否偏离快照：相等或快照不存在即无可撤销内容（撤销按钮置灰）。
  const hasUndo=(cardId)=>{
    const snap=undoSnapshots[cardId];
    if(!snap)return false;
    return Object.keys(CARD_DEFAULTS[cardId]()).some(k=>!sameVal(s[k],snap[k]));
  };
  // 滑块变化入口：拖动中（pointerdown 已捕获拖前值）不重复捕获；键盘/点击单次变化即捕获。
  function rangeChange(cardId,key){
    return ev=>{
      if(!draggingRange.current)captureSnapshot(cardId);
      setS(p=>({...p,[key]:+ev.target.value}));
    };
  }
  // 恢复默认：先捕获恢复前数值作为撤销目标，再套用默认值；只改本卡键，不影响其他设置。
  function restoreDefaults(cardId){
    if(!s)return;
    const def=CARD_DEFAULTS[cardId];
    if(!def)return;
    captureSnapshot(cardId,{skipIfDefault:true});
    setS(p=>({...p,...def(p)}));
  }
  // 撤销：恢复快照数值并清除快照（无快照或无偏离时空操作，此时按钮已置灰）。
  function undoRestore(cardId){
    const snap=undoSnapshots[cardId];
    if(!snap)return;
    if(!hasUndo(cardId))return;
    setUndoSnapshots(prev=>{const{[cardId]:_,...rest}=prev;return rest;});
    setS(p=>({...p,...snap}));
  }
  const isFirst=useRef(true);
  // 各模块的「已应用/已确认」基线：模块重跑或卡关闭时同步为当前设置值。
  // 智能保留基线 = 上次执行时的 applied 优先级快照（加载时设置，执行后同步为当前值）——
  // 当前值偏离基线即点亮琥珀卡，回到基线自动收起。
  const moduleBaseline=useRef(null); // {duration_tolerance,threshold,quality_tiers,pick_tag_order,exclude_patterns}
  // 上次持久化的模块值快照：本次保存真的改动了某模块才递增该模块 seq / 重算 pending，
  // 避免改动无关设置（如 threads）时已显示的卡被重复触发。
  const lastPersisted=useRef(null);

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
      // applied 快照（后端执行「智能保留」时写入）仅用于 pending 比对，剥离出可编辑对象，
      // 避免 PUT /api/settings 把只读快照原样回写。缺省回退默认顺序（与后端一致），
      // 不回退到当前草稿值——未执行前改优先级应点亮琥珀卡而非视为已应用。
      const appliedQ = Array.isArray(d.quality_tiers_applied) && d.quality_tiers_applied.length ? d.quality_tiers_applied : DEFAULT_Q;
      const appliedPick = mergePickOrder(Array.isArray(d.pick_tag_order_applied) && d.pick_tag_order_applied.length ? d.pick_tag_order_applied : DEFAULT_PICK);
      delete d.scan_dirs; // owned by App/props, not local state — avoid stale overwrite races
      delete d.quality_tiers_applied;
      delete d.pick_tag_order_applied;
      setS(d);
      const curSnap={duration_tolerance:d.duration_tolerance,threshold:d.threshold,quality_tiers:JSON.stringify(d.quality_tiers),pick_tag_order:JSON.stringify(d.pick_tag_order),exclude_patterns:JSON.stringify(d.exclude_patterns||[])};
      // 基线用 applied（偏离即未应用）；lastPersisted 用当前值（只有真正改动才触发滑动卡）
      moduleBaseline.current={...curSnap, quality_tiers:JSON.stringify(appliedQ), pick_tag_order:JSON.stringify(appliedPick)};
      lastPersisted.current={...curSnap};
      // validate stored AcoustID key against the actual API (not just assume valid)
      const key=(d.acoustid_key||'').trim();
      const lastValidated = localStorage.getItem('acoustid_validated_key') || '';
      if(key && key === lastValidated){
        setAcoustidValidatedKey(key);
        setAcoustidValidResult({ok:true});
      }
    });
  },[]);

  // Settings save: 非滑块改动走 700ms 防抖；滑块拖动中（draggingRange）不保存，
  // 松开/失焦时 commitRange 用最终值一次提交——拖动过程零保存、零「保存中」闪烁。
  function persist(){
    if(!s)return;
    api.put('/api/settings',s).then(r=>{
      if(!r.ok){setSaveState('error');return;}
      // 复用 saveTimer：连续保存时先清旧的「已保存→空闲」定时器，避免多个叠加、较早的
      // 提前把状态翻回 idle，造成 saved→idle→saved 抖动。
      setSaveState('saved');clearTimeout(saveTimer.current);saveTimer.current=setTimeout(()=>setSaveState('idle'),2200);
      const cur={duration_tolerance:s.duration_tolerance,threshold:s.threshold,quality_tiers:JSON.stringify(s.quality_tiers||[]),pick_tag_order:JSON.stringify(s.pick_tag_order||[]),exclude_patterns:JSON.stringify(s.exclude_patterns||[])};
      // 各模块 seq 只在「本次保存真的改动了该模块」时递增（对比上次持久化快照）：
      // 改动无关设置（如 threads）不会让已显示的卡重新滑动。threads 不在任何模块的
      // 跟踪范围内，永不触发任何卡。
      const prev=lastPersisted.current;
      if(prev){
        if(prev.duration_tolerance!==cur.duration_tolerance)setBasicSeq(k=>k+1);
        if(prev.threshold!==cur.threshold)setFpSeq(k=>k+1);
        if(prev.exclude_patterns!==cur.exclude_patterns)setExcludeSeq(k=>k+1);
        if(prev.quality_tiers!==cur.quality_tiers||prev.pick_tag_order!==cur.pick_tag_order)setKeepSeq(k=>k+1);
      }
      lastPersisted.current=cur;
      // 各模块 pending = 当前值偏离该模块已应用基线（值回到基线自动收起）。threads 不跟踪。
      const b=moduleBaseline.current;
      if(b){
        setBasicPending(b.duration_tolerance!==cur.duration_tolerance);
        setFpPending(b.threshold!==cur.threshold);
        setKeepPending(b.quality_tiers!==cur.quality_tiers||b.pick_tag_order!==cur.pick_tag_order);
        setExcludePending(b.exclude_patterns!==cur.exclude_patterns);
      }
    });
  }
  function commitRange(){
    if(!draggingRange.current)return; // 已提交过（如 pointerUp 后 blur 再触发）
    draggingRange.current=false;
    clearTimeout(saveTimer.current);
    persist(); // 立即用拖动结束后的最终值保存
  }
  useEffect(()=>{
    if(!s)return;
    if(isFirst.current){isFirst.current=false;return;}
    if(draggingRange.current)return; // 滑块拖动中：跳过，松开时 commitRange 统一保存
    setSaveState('saving');clearTimeout(saveTimer.current);
    saveTimer.current=setTimeout(persist,700);
    return()=>clearTimeout(saveTimer.current);
  },[s]);

  // 按执行模块重跑。steps 只含该卡对应模块（基础匹配卡→basicMatch，声纹匹配卡→fpMatch，
  // 智能保留卡→smartKeep）。应用后把该模块基线同步为当前值，并清 pending（卡消失）——
  // 变更已交到执行通道，不再需要常驻提醒。
  function applyBasic(){
    setReapplying(true);
    onMatchAffectingChange?.(['basicMatch']);
    moduleBaseline.current.duration_tolerance=s.duration_tolerance;
    setBasicPending(false);
    setTimeout(()=>setReapplying(false),1500);
  }
  function applyKeep(){
    setReapplying(true);
    onMatchAffectingChange?.(['smartKeep']);
    moduleBaseline.current.quality_tiers=JSON.stringify(s.quality_tiers||[]);
    moduleBaseline.current.pick_tag_order=JSON.stringify(s.pick_tag_order||[]);
    setKeepPending(false);
    setTimeout(()=>setReapplying(false),1500);
  }
  function applyFp(){
    setReapplying(true);
    onMatchAffectingChange?.(['fpMatch']);
    moduleBaseline.current.threshold=s.threshold;
    setFpPending(false);
    setTimeout(()=>setReapplying(false),1500);
  }
  function applyEnum(){
    onEnumOnly?.();
    moduleBaseline.current.exclude_patterns=JSON.stringify(s.exclude_patterns||[]);
    setExcludePending(false);
    onDismissDirChanged?.();
  }
  // 关闭卡 = 确认，把该模块基线同步为当前值，避免后续改动无关设置时重新点亮
  const closeBasic=()=>{moduleBaseline.current.duration_tolerance=s.duration_tolerance;setBasicPending(false);};
  const closeFp=()=>{moduleBaseline.current.threshold=s.threshold;setFpPending(false);};
  const closeKeep=()=>{moduleBaseline.current.quality_tiers=JSON.stringify(s.quality_tiers||[]);moduleBaseline.current.pick_tag_order=JSON.stringify(s.pick_tag_order||[]);setKeepPending(false);};
  const closeExclude=()=>{moduleBaseline.current.exclude_patterns=JSON.stringify(s.exclude_patterns||[]);setExcludePending(false);onDismissDirChanged?.();};

  // ── 执行卡编排：滑动卡（ExecuteToast，固定层）+ 常驻卡（ExecutePinnedCard，设置列顶部槽）──
  // 只有带按钮的卡（需要点击重新执行）才触发滑动卡；toast 只存 {key,seq}，配置渲染期从
  // EXEC_CARDS 现取（disabled 等跟随最新状态）；seq 递增（同卡再次修改）或换 key（新卡
  // 触发）都会重挂载滑动卡重播动画。
  const EXEC_CARDS=[
    {key:'basic',  message:'时长容差已修改，尚未重新应用到现有重复组',  btnLabel:'立即重新匹配', btnIcon:reapplying?'loader':'refresh', disabled:scanRunning||reapplying, disabledLabel:'扫描进行中...'},
    {key:'fp',     message:'频谱声纹阈值已修改，尚未重新应用到现有重复组', btnLabel:'立即重新匹配', btnIcon:reapplying?'loader':'refresh', disabled:scanRunning||reapplying, disabledLabel:'扫描进行中...'},
    {key:'keep',   message:'音质优先级 / 保留优先级 已修改，尚未重新应用到现有重复组', btnLabel:'立即重新计算', btnIcon:reapplying?'loader':'refresh', disabled:scanRunning||reapplying, disabledLabel:'扫描进行中...'},
    {key:'enum',   message:(dirChanged&&excludePending)?'音乐目录 / 排除规则已修改，建议更新音乐库（只枚举文件树，不做声纹/刮削）':dirChanged?'音乐目录已修改，建议更新音乐库（只枚举文件树，不做声纹/刮削）':'排除规则已修改，建议更新音乐库（只枚举文件树，不做声纹/刮削）', btnLabel:'立即更新音乐库', disabled:scanRunning, disabledLabel:'扫描进行中...'},
    {key:'scrape', message:'AcoustID Key 已验证，建议重新执行「刮削匹配」以应用声纹查询', btnLabel:'立即刮削匹配', disabled:scanRunning, disabledLabel:'扫描进行中...'},
  ];
  const cardPending={basic:basicPending,fp:fpPending,keep:keepPending,enum:dirChanged||excludePending,scrape:needsScrapeReapply};
  const cardAction={basic:applyBasic,fp:applyFp,keep:applyKeep,enum:applyEnum,scrape:()=>onScrapeReapply?.()};
  const cardClose={basic:closeBasic,fp:closeFp,keep:closeKeep,enum:closeExclude,scrape:()=>setNeedsScrapeReapply(false)};

  // 固定层锚点：滑动卡定位在设置内容页顶部（main 顶栏 54 + 内边距 20 = 74），水平范围与设置
  // 右列对齐（测量 data-hint-boundary 容器）。窗口 resize / 设置页激活时重测。
  const colRef=useRef(null);
  const[colRect,setColRect]=useState(null);
  const[toast,setToast]=useState(null); // {key,seq}——触发滑动卡的模块与本次触发序号
  const measureCol=useCallback(()=>{
    if(!colRef.current)return;
    const r=colRef.current.getBoundingClientRect();
    setColRect(prev=>prev&&prev.left===r.left&&prev.width===r.width&&prev.top===74?prev:{top:74,left:r.left,width:r.width});
  },[]);
  useEffect(()=>{ if(active)measureCol(); },[active]);
  useEffect(()=>{
    measureCol();
    window.addEventListener('resize',measureCol);
    return ()=>window.removeEventListener('resize',measureCol);
  },[measureCol]);
  const fireToast=key=>{
    measureCol();
    setToast(t=>t&&t.key===key?{key,seq:t.seq+1}:{key,seq:1});
  };
  // seq 递增即「该模块设置被修改」——点亮 pending 的同时触发滑动卡。useLayoutEffect 在绘制前
  // 设好 toast，避免常驻卡先闪现一帧。
  useLayoutEffect(()=>{ if(basicPending&&basicSeq>0)fireToast('basic'); },[basicSeq]);
  useLayoutEffect(()=>{ if(fpPending&&fpSeq>0)fireToast('fp'); },[fpSeq]);
  useLayoutEffect(()=>{ if(keepPending&&keepSeq>0)fireToast('keep'); },[keepSeq]);
  useLayoutEffect(()=>{ if((dirChanged||excludePending)&&(dirSeq>0||excludeSeq>0))fireToast('enum'); },[dirSeq,excludeSeq]);
  useLayoutEffect(()=>{ if(needsScrapeReapply&&scrapeSeq>0)fireToast('scrape'); },[scrapeSeq]);

  // 渲染期派生：当前滑动卡配置（按 toast.key 从 EXEC_CARDS 现取；btnLabel 为空则无滑动卡）
  const toastCard=toast?EXEC_CARDS.find(c=>c.key===toast.key):null;
  const toastConfig=toast&&toastCard&&toastCard.btnLabel
    ? {...toastCard,key:toast.key,seq:toast.seq,active:cardPending[toast.key],onAction:()=>cardAction[toast.key]?.()}
    : null;

  const moveQ=(i,d)=>{const q=[...(s.quality_tiers||DEFAULT_Q)];const j=i+d;if(j<0||j>=q.length)return;captureSnapshot('sec-smartkeep');[q[i],q[j]]=[q[j],q[i]];setS(p=>({...p,quality_tiers:q}));};
  const movePick=(i,d)=>{const q=[...(s.pick_tag_order||DEFAULT_PICK)];const j=i+d;if(j<0||j>=q.length)return;captureSnapshot('sec-smartkeep');[q[i],q[j]]=[q[j],q[i]];setS(p=>({...p,pick_tag_order:q}));};

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
        if(!silent && keyChanged){setNeedsScrapeReapply(true);setScrapeSeq(k=>k+1);}
      }
    }catch(e){setAcoustidValidResult({ok:false,error:'网络错误'});}
    finally{setAcoustidValidating(false);}
  }
  async function validateAcoustid(){
    await validateAcoustidKey((s?.acoustid_key||'').trim());
  }

  // 设置卡头部的「恢复默认 / 撤销」按钮组：撤销常驻显示，无可撤销内容（无快照或
  // 当前值等于快照）时置灰；恢复默认始终可用。
  const ResetBar=({cardId})=>e('div',{style:{display:'flex',alignItems:'center',gap:4,flexShrink:0}},
    e(Btn,{small:true,variant:'ghost',icon:'arrow-back-up',disabled:!hasUndo(cardId),onClick:()=>undoRestore(cardId),title:'撤销最近一次修改（恢复默认或手动调整），回到修改前的数值'},'撤销'),
    e(Btn,{small:true,variant:'ghost',icon:'refresh',onClick:()=>restoreDefaults(cardId),title:RESET_HINT[cardId]},'恢复默认')
  );

  function jump(id){document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});}

  if(!s)return e('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:320,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:28}}));

  const q=s.quality_tiers||DEFAULT_Q;
  const pick=mergePickOrder(s.pick_tag_order);

  return e('div',{className:'fade',style:{display:'grid',gridTemplateColumns:'128px 1fr',gap:14,alignItems:'start'}},

    // Left rail — sticky, no overflow mask; whitespace is natural layout.
    e('div',{ref:sidebarRef,style:{position:'sticky',top:20,display:'flex',flexDirection:'column',gap:1}},
      SETTINGS_SECTIONS.map(sec=>e('button',{key:sec.id,'data-section':sec.id,onClick:()=>jump(sec.id),style:{display:'flex',alignItems:'center',gap:7,padding:'7px 9px',background:'none',border:'none',borderRadius:'var(--r-md)',cursor:'pointer',color:'var(--tx-secondary)',fontSize:12,textAlign:'left',flexShrink:0},onMouseEnter:ev=>ev.currentTarget.style.background='var(--bg-muted)',onMouseLeave:ev=>ev.currentTarget.style.background='none'},
        Icon(sec.icon,{fontSize:14,color:'var(--tx-faint)'}),sec.label)),
      e('div',{style:{marginTop:8,paddingTop:8,borderTop:'0.5px solid var(--bd-subtle)'}},e(SaveStatus,{saveState}))
    ),

    // Right — all sections concatenated, scrollable as part of <main>
    e('div',{ref:colRef,'data-hint-boundary':'',style:{position:'relative',display:'flex',flexDirection:'column',gap:14,paddingBottom:14}},

      // 顶部执行卡槽：按设置项影响的执行模块各一张，常驻于音乐目录卡上方（文档流内，不覆盖设置卡）。
      // 只对「影响最终结果」的设置点亮对应卡：threads（扫描性能）不影响结果，永不触发任何卡。
      // 槽为每张卡保留固定高度——滑动卡展示期间对应常驻卡以 visibility:hidden 占位，卡显现时
      // 下方内容零位移；槽随待处理集合增减而增减（发生在点亮/关闭时）。带按钮的卡先播滑动卡
      // （ExecuteToast，固定层），消失后才显现常驻卡；无按钮卡（keep）直接常驻。
      (basicPending||fpPending||keepPending||dirChanged||excludePending||needsScrapeReapply)&&e('div',{style:{display:'flex',flexDirection:'column',gap:16}},
        EXEC_CARDS.filter(c=>cardPending[c.key]).map(c=>e(ExecutePinnedCard,{key:c.key,visible:toastConfig?.key!==c.key,message:c.message,btnLabel:c.btnLabel,btnIcon:c.btnIcon,disabled:c.disabled,disabledLabel:c.disabledLabel,onAction:cardAction[c.key],onClose:cardClose[c.key]})),
      ),
      // 滑动执行卡：固定层，锚定设置内容页顶部，不随内容页滚动、永远可见
      toastConfig&&colRect&&e(ExecuteToast,{key:toast.key+':'+toast.seq,config:toastConfig,pos:colRect,onDone:()=>setToast(null)}),

      e(Card,{id:'sec-dirs'},
        e(SH,{title:'音乐目录',sub:'添加包含音乐文件的文件夹到音乐库'}),
        e(ScanDirsEditor,{dirs,onAddDir,onRemoveDir,onEnumOnly}),
        e('button',{onClick:()=>setShowExclude(v=>!v),style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-faint)',fontSize:11,display:'flex',alignItems:'center',gap:4,padding:0,marginTop:10}},
          e('i',{className:`ti ti-chevron-${showExclude?'up':'down'}`,style:{fontSize:12}}),'高级：排除规则 / 增量扫描'
        ),
        showExclude&&e('div',{style:{marginTop:10,display:'flex',flexDirection:'column',gap:12}},
          e('div',null,
            e('textarea',{value:(s.exclude_patterns||[]).join(', '),onChange:ev=>setS(p=>({...p,exclude_patterns:ev.target.value.split(',').map(x=>x.trim()).filter(Boolean)})),style:{width:'100%',fontSize:11,fontFamily:'var(--font-mono)',padding:'8px 10px',borderRadius:'var(--r-md)',background:'var(--bg-subtle)',border:'0.5px solid var(--bd-default)',color:'var(--tx-secondary)',resize:'none',height:54,lineHeight:1.6,outline:'none'}}),
            e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginTop:4}},'逗号分隔，支持 glob。示例：*.tmp, .DS_Store, Thumbs.db')
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

      // 扫描性能 — 声纹解码并发数（同时解码的文件数），直接影响声纹阶段的并行度与内存。
      // threads 未设置（自动）时由 scan-worker 按逻辑核数计算 min(12, 逻辑核/2)；滑块上限 12
      // 与并发上限一致（更高只加内存无收益）。
      e(Card,{id:'sec-scan-perf'},
        e('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10}},
          e('div',{style:{flex:1}},e(SH,{title:'扫描性能'})),
          e(ResetBar,{cardId:'sec-scan-perf'})
        ),
        e('div',null,
          e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4}},'同时处理文件数',e(Hint,{text:'并发解码的文件数，默认自动按 CPU 核数；调低可减少扫描内存占用。'})),e('span',{style:{fontSize:14,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},s.threads?s.threads:autoThreads)),
          e('input',{type:'range',min:1,max:12,value:s.threads||autoThreads,onChange:rangeChange('sec-scan-perf','threads'),onPointerDown:()=>{draggingRange.current=true;captureSnapshot('sec-scan-perf');},onPointerUp:commitRange,onBlur:commitRange})
        )
      ),

      e(Card,{id:'sec-basic'},
        e('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10}},
          e('div',{style:{flex:1}},e(SH,{title:'基础匹配',sub:'标题 + 艺术家 + 时长',hint:'按标题、艺术家和时长直接比对，是最主要、最可靠的重复判定依据，不需要声纹。'})),
          e(ResetBar,{cardId:'sec-basic'})
        ),
        e('div',null,
          e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)',display:'flex',alignItems:'center'}},'时长容差',e(Hint,{text:'两个文件标题、艺术家一致时，时长相差在此范围内仍视为同一首歌——不同来源的同一首歌常有 1-5 秒的掐头去尾差异。'})),e('span',{style:{fontSize:14,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},(s.duration_tolerance??5)+' 秒')),
          e('input',{type:'range',min:1,max:15,value:s.duration_tolerance??5,onChange:rangeChange('sec-basic','duration_tolerance'),onPointerDown:()=>{draggingRange.current=true;captureSnapshot('sec-basic');},onPointerUp:commitRange,onBlur:commitRange})
        )
      ),

      // 声纹匹配 — 技术细节：内置 Goertzel 声纹（无需配置）；Chromaprint（CP）可选，需 fpcalc
      // 可执行文件，配置后在频谱声纹之外独立再比对一遍；同一份声纹数据也被刮削匹配的 AcoustID 使用。
      e(Card,{id:'sec-fp'},
        e('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10}},
          e('div',{style:{flex:1}},e(SH,{title:'声纹匹配',hint:'通过对比音频声纹识别重复，内置声纹开箱即用。可选配第二种声纹（CP 声纹），能额外发现一些漏掉的重复。'})),
          e(ResetBar,{cardId:'sec-fp'})
        ),
        e('div',null,
          e('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:6}},e('span',{style:{fontSize:12,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4}},'频谱声纹相似度阈值',e(Hint,{text:'相似度达到此值即视为匹配。值越高越严格（匹配更少），越低越宽松（匹配更多）。标题、艺术家、时长近似的歌曲，即使低于此值仍会被判定为重复。'})),e('span',{style:{fontSize:15,fontWeight:700,fontFamily:'var(--font-mono)',color:'var(--amber)'}},(s.threshold||90)+'%')),
          e('input',{type:'range',min:70,max:100,value:s.threshold||90,onChange:rangeChange('sec-fp','threshold'),onPointerDown:()=>{draggingRange.current=true;captureSnapshot('sec-fp');},onPointerUp:commitRange,onBlur:commitRange}),
          e('div',{style:{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--tx-faint)',marginTop:3}},e('span',null,'70% 宽松'),e('span',null,'100% 精确'))
        ),

        e('div',{style:{marginTop:16,paddingTop:14,borderTop:'0.5px solid var(--bd-subtle)'}},
          e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',marginBottom:2,display:'flex',alignItems:'center'}},'CP 声纹（可选）',e(Hint,{text:'默认声纹无需配置。CP 声纹是可选第二种，配置后会额外检查一遍，通常能发现默认声纹漏掉的重复，结果会分开标注。同一份数据也会被「刮削匹配」用到。'})),
          e('div',{style:{display:'flex',gap:6,maxWidth:460}},
            e('input',{value:s.fpcalc_path||fpcalc?.path||'',
              onChange:ev=>{setS(p=>({...p,fpcalc_path:ev.target.value}));setFpcalcPathDirty(true);},
              placeholder:'留空则自动检测（项目根目录 / PATH）',
              title:'可填 fpcalc 所在目录或完整路径；留空时显示自动检测结果，可直接选择复制',
              style:{flex:1,fontSize:11,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',outline:'none',fontFamily:'var(--font-mono)',minWidth:0,color:s.fpcalc_path?'var(--tx-primary)':'var(--tx-muted)'}}),
            e('button',{onClick:browseFpcalc,disabled:browsingFpcalc,title:'浏览选择 fpcalc 所在目录',style:{padding:'6px 10px',background:'var(--bg-muted)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)',cursor:browsingFpcalc?'wait':'pointer',fontSize:11,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4,whiteSpace:'nowrap',flexShrink:0}},
              Icon('folders',{fontSize:12}),'浏览'),
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
              e('button',{onClick:()=>jump('sec-fp'),title:fpcalc?.path,style:{display:'flex',alignItems:'center',gap:6,width:'100%',padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',cursor:'pointer',fontSize:11,color:fpcalc?.available?'var(--green)':'var(--tx-faint)',textAlign:'left'}},
                Icon(fpcalc?.available?'circle-check':'alert-circle',{fontSize:12,flexShrink:0}),
                e('span',{style:{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},fpcalc?.available?`已配置：${fpcalc.path}`:'未配置'),
                e('span',{style:{color:'var(--tx-faint)',textDecoration:'underline',whiteSpace:'nowrap',flexShrink:0}},'去「声纹匹配」配置')
              )
            )
          ),
          e('div',{style:{marginTop:4,fontSize:11,color:'var(--tx-faint)'}},
            '在 acoustid.org 注册应用即可免费获取 API Key。需同时满足两个条件才生效：① 上方 API Key 有效；② 在「声纹匹配」中配置好 CP 声纹（fpcalc）。'
          )
        )
      ),

      e(Card,{id:'sec-smartkeep'},
        e('div',{style:{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10}},
          e('div',{style:{flex:1}},e(SH,{icon:'priority-podium',title:'智能保留',sub:'上下移动调整 — 顶部优先级最高',hint:'音质优先级决定不同格式/码率哪个更优；保留优先级决定重复组中保留哪个文件。修改后需点击顶部琥珀卡「立即重新计算」（或到扫描页执行「智能保留」），才会重新应用到现有重复组。'})),
          e(ResetBar,{cardId:'sec-smartkeep'})
        ),
        e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4,margin:'2px 0 4px'}},Icon('audio-levels',{fontSize:13}),'音质优先级'),
        q.map((f,i)=>e('div',{key:f,style:{display:'flex',alignItems:'center',gap:10,padding:'4px 10px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',marginBottom:3,border:'0.5px solid var(--bd-subtle)'}},
          e('span',{style:{width:20,fontSize:11,fontFamily:'var(--font-mono)',fontWeight:700,color:i<3?'var(--green)':i<6?'var(--amber)':'var(--tx-faint)',textAlign:'center'}},i+1),
          e('span',{style:{flex:1,fontSize:12,color:i<6?'var(--tx-secondary)':'var(--tx-faint)'}},f),
          i===0&&e('span',{style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'var(--green-bg)',color:'var(--green)',border:'0.5px solid var(--green-bd)'}},'最优'),
          e('div',{style:{display:'flex',flexDirection:'column',gap:1}},
            e('button',{onClick:()=>moveQ(i,-1),disabled:i===0,style:{background:'none',border:'none',cursor:i===0?'default':'pointer',padding:'1px 4px',opacity:i===0?.2:1,color:'var(--tx-muted)'}},Icon('chevron-up',{fontSize:13})),
            e('button',{onClick:()=>moveQ(i,1),disabled:i===q.length-1,style:{background:'none',border:'none',cursor:i===q.length-1?'default':'pointer',padding:'1px 4px',opacity:i===q.length-1?.2:1,color:'var(--tx-muted)'}},Icon('chevron-down',{fontSize:13}))
          )
        )),
        e('div',{style:{fontSize:12,fontWeight:500,color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:4,margin:'14px 0 4px'}},Icon('priority-podium',{fontSize:13}),'保留优先级',e(Hint,{text:'决定重复组中保留哪个文件，越靠上越优先。某文件缺少对应数据时，该轮不参与、也不会被淘汰。各维度含义见重复组详情「维度对比」旁的说明按钮。'})),
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

      e(RetentionListSection,{player,retentionListKey,onLocateFile,onLocate,onLocateInDuplicates:onNavigateToDuplicateGroup}),
      e(WriteHistorySection,{writeHistoryKey,player,onLocateFile,onLocate,onLocateInDuplicates:onNavigateToDuplicateGroup,onTagsWritten})
    )
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(e(App));
