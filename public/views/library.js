
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
        e(SearchInput,{value:search,onChange:onSearch,minWidth:200}),
        e('select',{value:fmt,onChange:ev=>{setFmt(ev.target.value);},
          style:{fontSize:12,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',
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
          style:{fontSize:12,padding:'6px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',
            color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)',width:112}},
          e('option',{value:''},'全部刮削'),
          e('option',{value:'green'},TIER_LABEL.green),
          e('option',{value:'blue'},TIER_LABEL.blue),
          e('option',{value:'yellow'},TIER_LABEL.yellow),
          e('option',{value:'red'},TIER_LABEL.red),
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
                    if(!tier){
                      // Unscraped — gray placeholder icon, pure display
                      return e(InstantTooltip,{tip:'未刮削'},
                        Icon('cloud',{fontSize:15,color:'var(--tx-faint)'})
                      );
                    }
                    const mbHas=f.mb_title||f.mb_artist||f.mb_album||f.mb_album_year>0;
                    const aidHas=f.aid_title||f.aid_artist||f.aid_album||f.aid_album_year>0;
                    const dual=mbHas&&aidHas;
                    const fieldRow=(label,val)=>e('div',{style:{whiteSpace:'nowrap'}},
                      e('span',{style:{color:'rgba(255,255,255,.45)'}},label+'\u2009'),
                      val
                    );
                    const sourceCol=(name,has,fields,divider)=>!has?null:
                      e('div',{style:{flex:dual?'1 1 auto':'0 0 auto',...(divider?{paddingRight:8,borderRight:'0.5px solid rgba(255,255,255,.15)'}:{})}},
                        e('div',{style:{textAlign:'center',fontWeight:600,marginBottom:2,fontSize:9,color:'rgba(255,255,255,.45)',textTransform:'uppercase',letterSpacing:.5}},name),
                        ...fields.filter(Boolean).map(f=>fieldRow(f[0],f[1]))
                      );
                    const tipContent=e('div',{style:{textAlign:'left',maxWidth:dual?520:360,lineHeight:1.6}},
                      e('div',{style:{textAlign:'center',whiteSpace:'nowrap',marginBottom:4,paddingBottom:3,borderBottom:'0.5px solid rgba(255,255,255,.12)',fontWeight:600,fontSize:10,color:'rgba(255,255,255,.85)'}},
                        `刮削 · ${TIER_LABEL[tier]||tier}`
                      ),
                      e('div',{style:{display:'flex',gap:dual?9:0,justifyContent:'center'}},
                        sourceCol('MusicBrainz',mbHas,[
                          f.mb_title&&['标题',f.mb_title],
                          f.mb_artist&&['艺术家',f.mb_artist],
                          f.mb_album&&['专辑',f.mb_album],
                          f.mb_album_year>0&&['年份',f.mb_album_year],
                        ],dual),
                        sourceCol('AcoustID',aidHas,[
                          f.aid_title&&['标题',f.aid_title],
                          f.aid_artist&&['艺术家',f.aid_artist],
                          f.aid_album&&['专辑',f.aid_album],
                          f.aid_album_year>0&&['年份',f.aid_album_year],
                        ])
                      )
                    );
                    return e(InstantTooltip,{tip:tipContent},
                      Icon('cloud-check',{fontSize:15,color:TIER_COLOR[tier]})
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
