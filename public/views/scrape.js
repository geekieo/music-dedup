
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
  const[portal,setPortal]=useState(null); // DOM element to portal into, or null for inline
  const isStr=typeof tip==='string';
  const tooltipStyle=light?{position:'absolute',left:pos.x,top:pos.y,
    background:'#fff',color:'#1F2937',fontSize:11,fontFamily:'var(--font-sans)',
    padding:'3px 10px',borderRadius:4,whiteSpace:'nowrap',zIndex:9999,pointerEvents:'none',
    transform:portal?'translate(-100%,-100%)':'translateX(-50%)',boxShadow:'0 2px 12px rgba(0,0,0,.12)',border:'0.5px solid var(--bd-default)',lineHeight:1.4}
    :{position:'absolute',left:pos.x,top:pos.y,
    background:'rgba(17,24,39,.92)',color:'#fff',fontSize:10,fontFamily:isStr?'var(--font-mono)':'var(--font-sans)',
    padding:isStr?'4px 8px':'6px 10px',borderRadius:6,whiteSpace:isStr?'pre':'normal',zIndex:9999,pointerEvents:'none',
    transform:portal?'translate(-100%,-100%)':'translateX(-50%)',boxShadow:'0 2px 8px rgba(0,0,0,.3)',lineHeight:1.5};
  return e('span',{style:{position:'relative',display:'inline-flex',...style},
    onMouseEnter:ev=>{
      const r=ev.currentTarget.getBoundingClientRect();
      const modal=document.getElementById('modal-inner');
      if(modal){
        const m=modal.getBoundingClientRect();
        setPos({x:r.right-m.left,y:r.top-m.top-6});
        setPortal(modal);
      }else{
        setPos({x:ev.clientX-r.left,y:-28});
        setPortal(null);
      }
      setShow(true);
    },
    onMouseLeave:()=>setShow(false)},
    children,
    show&&tip&&(portal
      ? ReactDOM.createPortal(e('div',{style:tooltipStyle},tip), portal)
      : e('div',{style:tooltipStyle},tip))
  );
}

/* ── Drag-to-scroll text area ────────────────────────────────────────────
   No scrollbar — drag horizontally with mouse to pan. Click events pass
   through normally so row selection isn't affected. userSelect:'none'
   prevents text selection via CSS without interfering with clicks.
*/
function DragScrollText({children, style={}}) {
  const ref = useRef(null);
  const [cursor, setCursor] = useState('auto');
  const [overflow, setOverflow] = useState(false);
  const drag = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const over = el.scrollWidth > el.clientWidth;
    setOverflow(over);
    setCursor(over ? 'grab' : 'auto');
  }, [children]);

  function onMouseDown(e) {
    if (!overflow) return;
    drag.current = { x: e.clientX, sl: ref.current?.scrollLeft || 0 };
    setCursor('grabbing');
  }

  useEffect(() => {
    function onMouseMove(e) {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      if (ref.current) ref.current.scrollLeft = drag.current.sl - dx;
    }
    function onMouseUp() { drag.current = null; setCursor(overflow ? 'grab' : 'auto'); }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [overflow]);

  return e('span', {
    ref,
    onMouseDown,
    style: { ...style, cursor, overflow: 'hidden', whiteSpace: 'nowrap', userSelect: 'none' }
  }, children);
}

/* ── auto-select logic for ScrapeDialog (dual-source) ────────────────────
   Returns per-source per-field states (match/recommend/judge) plus
   auto-selected fields. Follows the same tier semantics as lib/tier.js:
     match    — scraped value equals file value (green, no write needed)
     recommend — file field empty + source is exact match (blue, auto-check)
     judge    — file field non-empty conflict, or source is fuzzy (yellow)
*/
function autoSelectFields(file, scraped) {
  if (!scraped || (!scraped.mb?.title && !scraped.acoustid?.title)) {
    return { states: {}, selected: {}, recommend: {}, conflicts: {} };
  }
  const states = { mb: {}, acoustid: {} };
  const sel = {}, rec = {}, cfl = {};
  const mb = scraped.mb, aid = scraped.acoustid;

  function hasData(src, key) { const v = src?.[key]; return v != null && v !== 0 && v !== ''; }
  function srcIsExact(s) { return s?.scrape_tier === 'green' || s?.scrape_tier === 'blue'; }

  // Pick best source when both have data. Returns null on conflict
  // (only when both sources are exact and disagree, or both are fuzzy and
  // disagree — a single exact source wins over a fuzzy one).
  function pickSrc(key) {
    const hm = hasData(mb, key), ha = hasData(aid, key);
    if (!hm && !ha) return null;
    if (!hm) return 'acoustid';
    if (!ha) return 'mb';
    if (normCmp(String(mb[key])) === normCmp(String(aid[key]))) {
      return srcIsExact(aid) ? 'acoustid' : srcIsExact(mb) ? 'mb' : 'acoustid';
    }
    // Disagree: only conflict when both have the same exact/fuzzy status
    const mbExact = srcIsExact(mb), aidExact = srcIsExact(aid);
    if (mbExact && !aidExact) return 'mb';
    if (aidExact && !mbExact) return 'acoustid';
    return null; // both exact or both fuzzy → conflict
  }

  for (const { key, displayOnly } of SCRAPE_ALL_FIELDS) {
    // ── Per-source state for coloring ──────────────────────────────────
    for (const srcKey of ['mb', 'acoustid']) {
      const s = scraped[srcKey];
      if (!s || !hasData(s, key)) { states[srcKey][key] = null; continue; }
      const fv = file[key], sv = s[key];
      const fvEmpty = fv == null || fv === 0 || fv === '';
      if (!fvEmpty && normCmp(String(fv)) === normCmp(String(sv))) {
        states[srcKey][key] = 'match';
      } else if (fvEmpty && srcIsExact(s)) {
        states[srcKey][key] = 'recommend';
      } else {
        states[srcKey][key] = 'judge';
      }
    }

    // ── Auto-select logic (skip display-only fields) ────────────────────
    if (displayOnly) continue;

    const mbHas = hasData(mb, key), aidHas = hasData(aid, key);
    if (!mbHas && !aidHas) { sel[key] = false; continue; }

    const s = pickSrc(key);
    if (!s) { sel[key] = false; cfl[key] = true; continue; }

    const bestState = states[s][key];
    if (bestState === 'recommend') { sel[key] = s; rec[key] = true; }
    else { sel[key] = false; }
  }

  return { states, selected: sel, recommend: rec, conflicts: cfl };
}

const WRITE_FIELDS = [
  { key:'title',        label:'标题'   },
  { key:'artist',       label:'艺术家' },
  { key:'album',        label:'专辑'   },
  { key:'album_year',   label:'年份'   },
  { key:'track_number', label:'曲目号' },
  { key:'genre',        label:'流派'   },
];

// All fields that scraping downloads — includes duration which is display-only
const SCRAPE_ALL_FIELDS = [
  ...WRITE_FIELDS,
  { key:'duration',     label:'时长',   displayOnly:true },
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
  const[conflicts,setConflicts]=useState({});
  const[states,setStates]=useState({});
  const[fileInfo,setFileInfo]=useState(null); // for filename + format
  const[mbCandidates,setMbCandidates]=useState(null); // null=not fetched, []=no results
  const[aidCandidates,setAidCandidates]=useState(null); // null=not fetched, []=no results
  const[aidError,setAidError]=useState(null);           // reason for empty AcoustID results
  const[confirmCancel,setConfirmCancel]=useState(false);
  const[previewMbId,setPreviewMbId]=useState(null);      // MB candidate preview (recording id)
  const[previewAidId,setPreviewAidId]=useState(null);    // AcoustID candidate preview (recording id)

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
      const{states:st,selected:s,recommend:rec,conflicts:c}=autoSelectFields(liveTags,scraped);
      setStates(st); setSel(s); setRecommend(rec); setConflicts(c||{});
    }
  },[liveTags?.title,
      scraped?.mb?.mb_recording_id, scraped?.acoustid?.mb_recording_id,
    ]);

  async function doScrape(){
    setScraping(true);setWriteResult(null);setMbCandidates(null);setAidCandidates(null);setAidError(null);
    setPreviewMbId(null);setPreviewAidId(null);
    if(hasScraped){
      // 重新刮削（已有数据）：只拉取候选列表，不自动保存，等用户手动选择
      const[mbR, aidR]=await Promise.all([
        api.get(`/api/files/${fileId}/mb-candidates`),
        api.get(`/api/files/${fileId}/acoustid-candidates`),
      ]);
      setScraping(false);
      if(mbR.ok) setMbCandidates(mbR.data||[]);
      if(aidR.ok){ setAidCandidates(aidR.data||[]); setAidError(aidR.error||null); }
    } else {
      // 首次刮削（无数据）：自动保存 AcoustID + MB 结果，与批量扫描一致
      const[srapeR, mbR, aidR]=await Promise.all([
        api.post(`/api/files/${fileId}/scrape-single`),
        api.get(`/api/files/${fileId}/mb-candidates`),
        api.get(`/api/files/${fileId}/acoustid-candidates`),
      ]);
      setScraping(false);
      if(mbR.ok) setMbCandidates(mbR.data||[]);
      if(aidR.ok){ setAidCandidates(aidR.data||[]); setAidError(aidR.error||null); }
      reload(); if(srapeR.ok) onUpdated&&onUpdated();
    }
  }
  async function selectCandidate(candidate){
    setPreviewMbId(null);
    await api.post(`/api/files/${fileId}/select-mb`,{candidate});
    reload(); onUpdated&&onUpdated();
  }
  async function selectAcoustidCandidate(candidate){
    setPreviewAidId(null);
    await api.post(`/api/files/${fileId}/select-acoustid`,{candidate});
    reload(); onUpdated&&onUpdated();
  }
  async function doCancelScrape(){
    await api.del(`/api/files/${fileId}/scraped`);
    setScraped(null); setSel({}); setRecommend({}); setStates({}); setConflicts({});
    setMbCandidates(null); setAidCandidates(null);
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

  // Per-source tiers (for colored dot indicator — same source as library scrape filter).
  const mbTier = scraped?.mb?.scrape_tier;
  const aidTier = scraped?.acoustid?.scrape_tier;

  // ── Per-source statistics ──────────────────────────────────────────────
  function srcStats(src) {
    if (!src) return null;
    const avail = [], match = [];
    for (const { key } of SCRAPE_ALL_FIELDS) {
      const sv = src[key];
      if (sv != null && sv !== 0 && sv !== '') {
        avail.push(key);
        const fv = key === 'duration' ? (fileInfo?.duration || 0) : liveTags?.[key];
        if (fv != null && fv !== 0 && fv !== '') {
          if (key === 'duration') {
            if (Math.abs(parseFloat(fv) - parseFloat(sv)) <= 3) match.push(key);
          } else if (normCmp(String(fv)) === normCmp(String(sv))) {
            match.push(key);
          }
        }
      }
    }
    return { avail: avail.length, match: match.length, total: SCRAPE_ALL_FIELDS.length };
  }
  const mbStats = srcStats(scraped?.mb);
  const aidStats = srcStats(scraped?.acoustid);

  // Duration comparison state (display-only, not a tag so not in liveTags)
  function durationState(src, fileDur, scrapedDur) {
    if (!scrapedDur && scrapedDur !== 0) return null;
    const fd = parseFloat(fileDur) || 0, sd = parseFloat(scrapedDur) || 0;
    if (fd <= 0 || sd <= 0) return sd > 0 ? 'recommend' : null;
    if (Math.abs(fd - sd) <= 3) return 'match';
    return 'judge';
  }

  // Cell state → background color
  const STATE_BG = { match: '#F0FDF4', recommend: '#EFF6FF', judge: '#FFFBEB' };

  function fmtVal(v) {
    if (v == null || v === 0 || v === '') return '';
    return String(v);
  }
  function fmtDur(sec) {
    if (sec == null || sec === 0 || sec === '') return '';
    const s = parseFloat(sec) || 0;
    if (s <= 0) return '';
    const m = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${m}:${String(secs).padStart(2,'0')}`;
  }

  return e(Modal,{title:`刮削操作`,onClose,width:760},
    loading&&e('div',{style:{textAlign:'center',padding:40}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})),

    !loading&&e('div',null,

      // Filename + status bar
      e('div',{style:{marginBottom:12,padding:'8px 12px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}},
        Icon('file-music',{fontSize:13,color:'var(--tx-faint)',flexShrink:0}),
        e('span',{style:{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},filename),
        hasScraped&&e(InstantTooltip,{tip:tier?TIER_DESC[tier]:null,light:true},
          e('span',{style:{fontSize:10,padding:'2px 8px',borderRadius:99,background:(TIER_COLOR[tier||'yellow']||'#EAB308')+'22',color:TIER_COLOR[tier||'yellow']||'#EAB308',border:'0.5px solid '+(TIER_COLOR[tier||'yellow']||'#EAB308'),whiteSpace:'nowrap'}},
            TIER_LABEL[tier]||'已刮削')
        )
      ),

      // Action buttons row
      e('div',{style:{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}},
        e(Btn,{icon:scraping?'loader':'cloud-download',disabled:scraping||writing,
          onClick:doScrape},scraping?'刮削中...':hasScraped?'重新刮削':'开始刮削'),
        hasScraped&&e(Btn,{icon:'x',variant:'ghost',disabled:scraping||writing,
          onClick:()=>setConfirmCancel(true)},'取消刮削'),
      ),

      // ── MB candidates list ──────────────────────────────────────────────
      mbCandidates&&(()=>{
        const n=mbCandidates.length;
        const activeMbId=scraped?.mb?.mb_recording_id;
        return e('div',{style:{marginBottom:14}},
          e('div',{style:{fontSize:11,fontWeight:600,color:'var(--tx-secondary)',marginBottom:6,display:'flex',alignItems:'center',justifyContent:'space-between'}},
            e('span',null,`MusicBrainz 搜索结果（${n} 个候选）`),
            e('button',{onClick:()=>{setMbCandidates(null);setPreviewMbId(null);},
              style:{fontSize:16,color:'var(--tx-faint)',background:'none',border:'none',cursor:'pointer',padding:0,lineHeight:1}},
              '\u00d7'),
          ),
          n===0
            ? e('div',{style:{padding:'8px 12px',borderRadius:'var(--r-md)',
                background:'var(--bg-subtle)',border:'0.5px solid var(--bd-default)',fontSize:11,color:'var(--tx-faint)'}},
                'MusicBrainz 未找到匹配结果')
            : e('div',{style:{maxHeight:128,overflowY:'auto',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)'}},
            mbCandidates.map((item,idx)=>{
              const c=item.candidate;
              const recId=c.mb_recording_id;
              const isActive=recId&&recId===activeMbId;
              const isPreview=recId&&recId===previewMbId&&!isActive;
              const pct=Math.round(Math.min(1,item.score)*100);
              const tierLabel=c.match_basis==='exact'?'精确':'模糊';
              const tierColor=c.match_basis==='exact'?'var(--green)':'var(--amber)';
              const parts=[c.title||'—'];
              if(c.artist) parts.push(c.artist);
              if(c.album) parts.push(c.album+(c.album_year?' · '+c.album_year:''));
              if(c.track_number) parts.push('#'+c.track_number);
              if(c.genre) parts.push(c.genre);
              if(c.duration) parts.push(fmtDur(c.duration));
              let rowBg='transparent';
              if(isActive) rowBg='var(--blue-bg)';
              else if(isPreview) rowBg='var(--amber-bg, #FFFBEB)';
              return e('div',{key:recId||idx,
                onClick:()=>isActive?null:setPreviewMbId(isPreview?null:recId),
                style:{padding:'8px 10px',borderBottom:idx<n-1?'0.5px solid var(--bd-subtle)':'none',
                  cursor:'default',background:rowBg,
                  display:'flex',alignItems:'center',gap:6,
                  fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-primary)',
                }},
                e('span',{style:{flexShrink:0,fontSize:10,fontWeight:700,color:tierColor,
                  background:tierColor+'18',borderRadius:99,padding:'2px 8px',minWidth:36,textAlign:'center'}},
                  tierLabel),
                e('span',{style:{flexShrink:0,fontSize:9,color:'var(--tx-faint)',minWidth:32,textAlign:'right'}},
                  pct+'%'),
                e(DragScrollText,{style:{flex:1,minWidth:0}},
                  parts.join(' · ')),
                isActive&&e('span',{style:{flexShrink:0,fontSize:9,color:'var(--blue)',
                  background:'var(--blue-bg)',borderRadius:3,padding:'1px 5px'}},'当前'),
                !isActive&&e('button',{onClick:e=>{e.stopPropagation();selectCandidate(c);},
                  style:{flexShrink:0,fontSize:9,color:'#fff',background:'var(--amber)',
                    border:'none',borderRadius:3,padding:'2px 8px',cursor:'pointer',
                    fontWeight:600}},
                  '应用')
              );
            })
          )
        );
      })(),

      // ── AcoustID candidates list ─────────────────────────────────────────
      aidCandidates&&(()=>{
        const n=aidCandidates.length;
        const activeAidId=scraped?.acoustid?.mb_recording_id;
        const emptyMsg = aidError==='no-key-or-fingerprint' ? '未配置 AcoustID API Key 或未提取 CP 声纹'
          : aidError==='no-fingerprint' ? '未提取 CP 声纹指纹'
          : aidError==='no-duration' ? '无法获取音频时长'
          : aidError==='rate-limited' ? 'AcoustID 请求过于频繁，请稍后重试'
          : aidError==='invalid-key' ? 'AcoustID API Key 无效'
          : 'AcoustID 未找到匹配结果';
        return e('div',{style:{marginBottom:14}},
          e('div',{style:{fontSize:11,fontWeight:600,color:'var(--tx-secondary)',marginBottom:6,display:'flex',alignItems:'center',justifyContent:'space-between'}},
            e('span',null,`AcoustID 搜索结果（${n} 个候选，按匹配度+声纹得分排列）`),
            e('button',{onClick:()=>{setAidCandidates(null);setPreviewAidId(null);setAidError(null);},
              style:{fontSize:16,color:'var(--tx-faint)',background:'none',border:'none',cursor:'pointer',padding:0,lineHeight:1}},
              '\u00d7'),
          ),
          n===0
            ? e('div',{style:{padding:'8px 12px',borderRadius:'var(--r-md)',
                background:'var(--bg-subtle)',border:'0.5px solid var(--bd-default)',fontSize:11,color:'var(--tx-faint)'}},
                emptyMsg)
            : e('div',{style:{maxHeight:128,overflowY:'auto',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-md)'}},
            aidCandidates.map((item,idx)=>{
              const c=item.candidate;
              const recId=c.mb_recording_id;
              const isActive=recId&&recId===activeAidId;
              const isPreview=recId&&recId===previewAidId&&!isActive;
              const pct=Math.round(item.score*100);
              const mt=item.matchTier??0;
              const tierColor=mt===3?'var(--green)':mt>=1?'var(--amber)':'var(--red)';
              const tierLabel=mt===3?'精确':mt+'/3';
              const parts=[c.title||'—'];
              if(c.artist) parts.push(c.artist);
              if(c.album) parts.push(c.album+(c.album_year?' · '+c.album_year:''));
              if(c.track_number) parts.push('#'+c.track_number);
              if(c.genre) parts.push(c.genre);
              if(c.duration) parts.push(fmtDur(c.duration));
              let rowBg='transparent';
              if(isActive) rowBg='var(--blue-bg)';
              else if(isPreview) rowBg='var(--amber-bg, #FFFBEB)';
              return e('div',{key:recId||idx,
                onClick:()=>isActive?null:setPreviewAidId(isPreview?null:recId),
                style:{padding:'8px 10px',borderBottom:idx<n-1?'0.5px solid var(--bd-subtle)':'none',
                  cursor:'default',background:rowBg,
                  display:'flex',alignItems:'center',gap:6,
                  fontSize:10,fontFamily:'var(--font-mono)',color:'var(--tx-primary)',
                }},
                e('span',{style:{flexShrink:0,fontSize:10,fontWeight:700,color:tierColor,
                  background:tierColor+'18',borderRadius:99,padding:'2px 8px',minWidth:36,textAlign:'center'}},
                  tierLabel),
                e('span',{style:{flexShrink:0,fontSize:9,color:'var(--tx-faint)',minWidth:32,textAlign:'right'}},
                  pct+'%'),
                e(DragScrollText,{style:{flex:1,minWidth:0}},
                  parts.join(' · ')),
                isActive&&e('span',{style:{flexShrink:0,fontSize:9,color:'var(--blue)',
                  background:'var(--blue-bg)',borderRadius:3,padding:'1px 5px'}},'当前'),
                !isActive&&e('button',{onClick:e=>{e.stopPropagation();selectAcoustidCandidate(c);},
                  style:{flexShrink:0,fontSize:9,color:'#fff',background:'var(--amber)',
                    border:'none',borderRadius:3,padding:'2px 8px',cursor:'pointer',
                    fontWeight:600}},
                  '应用')
              );
            })
          )
        );
      })(),

      // ── Comparison table (cells contain radio buttons for source selection) ──
      hasScraped&&(()=>{
        const showMb = !!(scraped?.mb?.title);
        const showAid = !!(scraped?.acoustid?.title);
        const colTemplate = `58px 1fr${showMb ? ' 1fr' : ''}${showAid ? ' 1fr' : ''}`;
        const nCols = 2 + (showMb?1:0) + (showAid?1:0);
        const headers = [
          { key: 'field', el: '字段' },
          { key: 'file',  el: '文件属性' },
        ];
        if (showMb) headers.push({
          key: 'mb',
          el: e('span',{style:{whiteSpace:'nowrap'},title:mbTier?TIER_DESC[mbTier]:undefined},
            mbTier
              ? Icon('cloud-check',{fontSize:13,color:TIER_COLOR[mbTier],verticalAlign:'text-bottom'})
              : Icon('cloud',{fontSize:13,color:'var(--tx-faint)',verticalAlign:'text-bottom'}),
            ` MB 刮削${mbStats ? ` · ${mbStats.match}/${mbStats.total} 项吻合` : ''}`)
        });
        if (showAid) headers.push({
          key: 'aid',
          el: e('span',{style:{whiteSpace:'nowrap'},title:aidTier?TIER_DESC[aidTier]:undefined},
            aidTier
              ? Icon('cloud-check',{fontSize:13,color:TIER_COLOR[aidTier],verticalAlign:'text-bottom'})
              : Icon('cloud',{fontSize:13,color:'var(--tx-faint)',verticalAlign:'text-bottom'}),
            ` AcoustID 刮削${aidStats ? ` · ${aidStats.match}/${aidStats.total} 项吻合` : ''}`)
        });
        // Helper: toggle source (click again to deselect)
        const toggleSrc = (key, src) => setSel(p=>({...p,[key]:p[key]===src?false:src}));
        return e('div',{style:{marginBottom:14}},
          e('div',{style:{display:'grid',gridTemplateColumns:colTemplate,fontSize:10,borderRadius:'var(--r-md)',overflow:'hidden',border:'0.5px solid var(--bd-default)'}},
            // Header row
            ...headers.map((h,i)=>e('div',{key:h.key,style:{padding:'6px 8px',display:'flex',alignItems:'center',background:'var(--bg-subtle)',fontWeight:600,color:'var(--tx-secondary)',borderBottom:'0.5px solid var(--bd-default)',borderRight:i<nCols-1?'0.5px solid var(--bd-subtle)':'none'}},h.el)),
            // Data rows — each MB/AcoustID cell has a radio, click toggles selection
            ...SCRAPE_ALL_FIELDS.map(({key,label,displayOnly})=>{
              const fv = key === 'duration' ? fmtDur(fileInfo?.duration) : fmtVal(liveTags?.[key]);
              const conflict = conflicts[key];
              const curSrc = sel[key];
              const isDisplayOnly = !!displayOnly;
              const cells = [
                e('div',{key:key+'l',style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:'0.5px solid var(--bd-subtle)',color:'var(--tx-faint)',background:'var(--bg-subtle)'}},label),
                e('div',{key:key+'f',style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:(showMb||showAid)?'0.5px solid var(--bd-subtle)':'none',color:'var(--tx-primary)',fontFamily:'var(--font-mono)',display:'flex',alignItems:'center'}},
                  fv||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—')
                ),
              ];
              if (showMb) {
                const mbVal = key === 'duration' ? fmtDur(scraped?.mb?.[key]) : fmtVal(scraped?.mb?.[key]);
                const mbState = key === 'duration' ? durationState('mb', fileInfo?.duration, scraped?.mb?.duration) : states?.mb?.[key];
                const isSelected = curSrc === 'mb';
                const hasAidConflict = conflict && scraped?.acoustid?.[key] != null;
                cells.push(isDisplayOnly
                  ? e('div',{key:key+'m',
                    style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:showAid?'0.5px solid var(--bd-subtle)':'none',
                      background:mbState?STATE_BG[mbState]:'transparent',display:'flex',alignItems:'center',gap:4,flexWrap:'wrap',
                      color:mbState?'var(--tx-primary)':'var(--tx-faint)'}},
                    e('span',{style:{fontFamily:'var(--font-mono)',flex:1}},
                      mbVal||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—'))
                  )
                  : e('label',{key:key+'m',
                    style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:showAid?'0.5px solid var(--bd-subtle)':'none',
                      background:mbState?STATE_BG[mbState]:'transparent',
                      cursor:mbState?'pointer':'default',display:'flex',alignItems:'center',gap:4,flexWrap:'wrap'
                    }},
                    mbState&&e('input',{type:'radio',name:'src_'+key,checked:isSelected,
                      onClick:()=>toggleSrc(key,'mb'),
                      style:{cursor:'pointer',accentColor:'var(--amber)',width:12,height:12,flexShrink:0,marginTop:1}}),
                    e('span',{style:{fontFamily:'var(--font-mono)',color:'var(--tx-primary)',flex:1}},
                      mbVal||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—'),
                      isSelected&&recommend[key]&&e('span',{style:{color:'var(--amber)',fontWeight:500,marginLeft:3}},'推荐'),
                      hasAidConflict&&Icon('alert-circle',{fontSize:9,color:'#D97706',style:{position:'absolute',top:1,right:2}})
                    )
                  ));
              }
              if (showAid) {
                const aidVal = key === 'duration' ? fmtDur(scraped?.acoustid?.[key]) : fmtVal(scraped?.acoustid?.[key]);
                const aidState = key === 'duration' ? durationState('acoustid', fileInfo?.duration, scraped?.acoustid?.duration) : states?.acoustid?.[key];
                const isSelected = curSrc === 'acoustid';
                const hasMbConflict = conflict && scraped?.mb?.[key] != null;
                cells.push(isDisplayOnly
                  ? e('div',{key:key+'a',
                    style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',
                      background:aidState?STATE_BG[aidState]:'transparent',display:'flex',alignItems:'center',gap:4,flexWrap:'wrap',
                      color:aidState?'var(--tx-primary)':'var(--tx-faint)'}},
                    e('span',{style:{fontFamily:'var(--font-mono)',flex:1}},
                      aidVal||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—'))
                  )
                  : e('label',{key:key+'a',
                    style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',
                      background:aidState?STATE_BG[aidState]:'transparent',
                      cursor:aidState?'pointer':'default',display:'flex',alignItems:'center',gap:4,flexWrap:'wrap'
                    }},
                    aidState&&e('input',{type:'radio',name:'src_'+key,checked:isSelected,
                      onClick:()=>toggleSrc(key,'acoustid'),
                      style:{cursor:'pointer',accentColor:'var(--amber)',width:12,height:12,flexShrink:0,marginTop:1}}),
                    e('span',{style:{fontFamily:'var(--font-mono)',color:'var(--tx-primary)',flex:1}},
                      aidVal||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—'),
                      isSelected&&recommend[key]&&e('span',{style:{color:'var(--amber)',fontWeight:500,marginLeft:3}},'推荐'),
                      hasMbConflict&&Icon('alert-circle',{fontSize:9,color:'#D97706',style:{position:'absolute',top:1,right:2}})
                    )
                  ));
              }
              return cells;
            }).flat()
          ),
          // Legend row
          e('div',{style:{display:'flex',gap:14,alignItems:'center',flexWrap:'wrap',marginTop:8,fontSize:10,color:'var(--tx-faint)'}},
            e('span',{style:{display:'flex',alignItems:'center',gap:4}},e('span',{style:{width:12,height:12,borderRadius:2,background:'#F0FDF4',border:'0.5px solid var(--bd-subtle)'}}),'绿=一致'),
            e('span',{style:{display:'flex',alignItems:'center',gap:4}},e('span',{style:{width:12,height:12,borderRadius:2,background:'#EFF6FF',border:'0.5px solid var(--bd-subtle)'}}),'蓝=推荐写入（精确·空白）'),
            e('span',{style:{display:'flex',alignItems:'center',gap:4}},e('span',{style:{width:12,height:12,borderRadius:2,background:'#FFFBEB',border:'0.5px solid var(--bd-subtle)'}}),'黄=需自行判断'),
            e('span',{style:{display:'flex',alignItems:'center',gap:4}},Icon('alert-circle',{fontSize:10,color:'#D97706'}),'=两来源冲突'),
            e('span',{style:{display:'flex',alignItems:'center',gap:4}},e('span',{style:{color:'var(--tx-muted)',fontStyle:'italic'}}),'时长仅对比，不写入')
          ),
          // MB identifiers info
          (scraped?.mb?.mb_recording_id || scraped?.acoustid?.mb_recording_id) && e('div',{style:{marginTop:8,fontSize:10,color:'var(--tx-faint)',display:'flex',flexDirection:'column',gap:2}},
            scraped?.mb?.mb_recording_id && e('div',{style:{display:'flex',gap:6,alignItems:'center'}},
              e('span',{style:{fontWeight:500,flexShrink:0}},'MB Recording:'),
              e('code',{style:{fontFamily:'var(--font-mono)',fontSize:9,color:'var(--tx-secondary)',
                overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}, scraped.mb.mb_recording_id),
              scraped?.mb?.mb_release_id && e('span',null,'/'),
              scraped?.mb?.mb_release_id && e('code',{style:{fontFamily:'var(--font-mono)',fontSize:9,color:'var(--tx-secondary)',
                overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}, scraped.mb.mb_release_id)
            ),
            scraped?.acoustid?.mb_recording_id && e('div',{style:{display:'flex',gap:6,alignItems:'center'}},
              e('span',{style:{fontWeight:500,flexShrink:0}},'AcoustID Recording:'),
              e('code',{style:{fontFamily:'var(--font-mono)',fontSize:9,color:'var(--tx-secondary)',
                overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}, scraped.acoustid.mb_recording_id)
            )
          )
        );
      })(),

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

      // Footer: safety notice + write button
      hasScraped&&e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,marginTop:12,flexWrap:'wrap',borderTop:'0.5px solid var(--bd-default)',paddingTop:14}},
        e('div',{style:{fontSize:10,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:5}},
          Icon('shield-check',{fontSize:12,color:'var(--green)'}),'写入前自动备份原始标签，可随时撤销'),
        e(Btn,{disabled:!canWrite||writing||scraping,
          icon:writing?'loader':'pencil',
          onClick:()=>setConfirmWrite(true)},
          writing?'写入中...':canWrite?`写入 ${selCount} 个字段`:'选择字段后写入')
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
      ),

      // Cancel scrape confirmation dialog
      confirmCancel&&e(ConfirmModal,{
        title:'取消刮削',
        message:'确认清除该文件的所有刮削数据？此操作不可撤销。',
        onConfirm:()=>{setConfirmCancel(false);doCancelScrape();},
        onClose:()=>setConfirmCancel(false),
        danger:true,
      })

    ) // end !loading
  );
}

/* ── Props Modal ─────────────────────────────────────────────────────── */
function PropsModal({fileId,onClose}){
  const[data,setData]=useState(null);
  const[coverUrl,setCoverUrl]=useState(null);
  const[coverBig,setCoverBig]=useState(false);
  useEffect(()=>{
    api.get(`/api/files/${fileId}`).then(r=>{if(r.ok)setData(r.data);});
    // Try loading cover art
    fetch(`/api/files/${fileId}/cover`).then(r=>{if(r.ok)setCoverUrl(`/api/files/${fileId}/cover`);}).catch(()=>{});
  },[fileId]);
  if(!data)return e(Modal,{title:'文件属性',onClose},e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})));
  // Two independent fingerprints: spectral (built-in, for duplicate matching)
  // and Chromaprint via fpcalc (for AcoustID queries). Shown as separate rows.
  const fpMethodLabel={spectral:'已提取',metadata:'未解码，退化为属性匹配'}[data.fingerprint_method]||'未提取';
  const chromaprintLabel=data.chromaprint?'已提取':'未提取（前往设置 → CP 声纹 配置）';
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
