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

  const COLS=['播放','标题','艺术家','修改字段','修改时间','剩余天数','操作'];

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
                        e('td',{style:{padding:'6px 10px',color:'var(--tx-faint)',fontFamily:'var(--font-mono)',fontSize:10,whiteSpace:'nowrap'}},dtStr),
                        e('td',{style:{padding:'6px 10px',color:daysColor,fontFamily:'var(--font-mono)',fontSize:10,textAlign:'center',whiteSpace:'nowrap'}},`${daysLeft}天`),
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

  const filtered=filterBySearch(rows,search,['title','artist','album','path']);

  return e(Card,{id:'sec-wl',style:{minHeight:120}},
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    confirmDialog,
    e(SH,{title:`保留名单（${rows.length} 个文件）`,sub:'名单中的文件参与重复检测，但受保护不被删除'}),
    loading?e('div',{style:{textAlign:'center',padding:30,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:22}})):
    rows.length===0
      ? e('div',{style:{textAlign:'center',padding:'24px 0',color:'var(--tx-faint)',lineHeight:2}},
          Icon('shield-check',{fontSize:28,display:'block',margin:'0 auto 8px'}),
          '保留名单为空',e('br'),e('span',{style:{fontSize:11}},'在"音乐库"或"重复组"中可将文件加入保留名单'))
      : e('div',null,
          e(SearchInput,{value:search,onChange:setSearch,style:{marginBottom:8}}),
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
                          e(IconAction,{
                            icon:'group-locate',
                            title:inGroupMap[f.id]?'在重复组中查看':'该文件不在任何重复组中',
                            onClick:inGroupMap[f.id]?()=>onLocateInDuplicates&&onLocateInDuplicates(inGroupMap[f.id]):undefined,
                            disabled:!inGroupMap[f.id]
                          }),
                          e(IconAction,{icon:'shield-x',title:'移除保留名单',danger:true,
                            onClick:()=>confirmAction('retention-remove',{
                              title:'移除保留名单',
                              message:e('span',null,'确定要将「',e('b',null,f.title||'未知文件'),'」从保留名单中移除吗？移除后该文件将在重复处理时不再受保护。'),
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

function SettingsView({dirs,onAddDir,onRemoveDir,onEnumOnly,onDismissDirChanged,dirChanged,onMatchAffectingChange,onScrapeReapply,scanRunning,player,retentionListKey,writeHistoryKey,onLocateFile,onNavigateToDuplicateGroup,onLocate,mainScrollRef,onTagsWritten}){
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
        e('div',{style:{fontSize:12,color:'var(--tx-secondary)',flex:1}},'频谱声纹阈值 / 时长容差 / 音质优先级 / 保留优先级 已修改，尚未重新应用到现有重复组'),
        e(Btn,{small:true,icon:reapplying?'loader':'refresh',disabled:scanRunning||reapplying,onClick:reapply},scanRunning?'扫描进行中...':'立即重新匹配'),
        e('button',{onClick:()=>setNeedsReapply(false),title:'关闭',style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-muted)',padding:4,flexShrink:0}},Icon('x',{fontSize:14}))
      ),

      dirChanged&&e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)'}},
        Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
        e('div',{style:{fontSize:12,color:'var(--tx-secondary)',flex:1}},'音乐目录已修改，建议更新音乐库（只枚举文件树，不做声纹/刮削）'),
        e(Btn,{small:true,icon:'refresh',disabled:scanRunning,onClick:onEnumOnly},scanRunning?'扫描进行中...':'立即更新音乐库'),
        e('button',{onClick:onDismissDirChanged,title:'关闭',style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-muted)',padding:4,flexShrink:0}},Icon('x',{fontSize:14}))
      ),

      needsScrapeReapply&&e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--amber-bg)',border:'0.5px solid var(--amber-bd)',borderRadius:'var(--r-lg)'}},
        Icon('alert-circle',{fontSize:15,color:'var(--amber)',flexShrink:0}),
        e('div',{style:{fontSize:12,color:'var(--tx-secondary)',flex:1}},'AcoustID Key 已验证，建议重新执行「刮削匹配」以应用声纹查询'),
        e(Btn,{small:true,icon:'refresh',disabled:scanRunning,onClick:()=>{onScrapeReapply?.();setNeedsScrapeReapply(false);}},scanRunning?'扫描进行中...':'立即刮削匹配'),
        e('button',{onClick:()=>setNeedsScrapeReapply(false),title:'关闭',style:{background:'none',border:'none',cursor:'pointer',color:'var(--tx-muted)',padding:4,flexShrink:0}},Icon('x',{fontSize:14}))
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

      e(RetentionListSection,{player,retentionListKey,onLocateFile,onLocate,onLocateInDuplicates:onNavigateToDuplicateGroup}),
      e(WriteHistorySection,{writeHistoryKey,player,onLocateFile,onLocate,onLocateInDuplicates:onNavigateToDuplicateGroup,onTagsWritten})
    )
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(e(App));
