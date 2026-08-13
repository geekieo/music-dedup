/* ══════════════════════════════════════════════════════════════════════
   DUPLICATES VIEW
   ══════════════════════════════════════════════════════════════════════ */
/* TrackRow — redesigned layout (item 3):
   LEFT  : play button + cover art thumbnail
   MIDDLE: title + quality badge + dimension tags (quality_best/scrape_best/...)
           subtitle line: artist · album | bitrate/size info
           path on hover/truncated
   RIGHT : keep-toggle button (✓ or ✗) + secondary actions
*/
// PICK_TAG_LABEL, PICK_TAG_COLOR are served by /rules-meta.js (source: lib/rules.js)

// RTYPE_LABEL, DIMENSION_COLUMNS are served by /rules-meta.js (source: lib/rules.js)

/* ── 组内属性同步 — sync fields from sibling tracks (ScrapeDialog-style UI) ── */
function CrossFillDialog({groupId, currentId, onClose, onUpdated, onTagsWritten}){
  const [tracks, setTracks] = useState(null); // loaded from API
  const [sel, setSel] = useState({});      // per-field selected source track id
  const [recommend, setRecommend] = useState({});
  const [conflicts, setConflicts] = useState({});
  const [states, setStates] = useState({});
  const [writing, setWriting] = useState(false);
  const [writeResult, setWriteResult] = useState(null);
  const [confirmWrite, setConfirmWrite] = useState(false);

  function load(){
    api.get('/api/duplicates/'+groupId).then(r=>{
      if(r.ok) setTracks(r.data.tracks||[]);
    });
  }
  useEffect(()=>{load();},[groupId]);

  const current = tracks?.find(t => t.id === currentId);
  const sources = (tracks||[]).filter(t => t.id !== currentId);
  const srcById = {};
  for (const t of (tracks||[])) srcById[t.id] = t;

  // Auto-compute field selection (same logic as autoSelectFields for ScrapeDialog)
  useEffect(() => {
    if (!current || !sources.length) return;
    const srcStates = {};
    for (const s of sources) srcStates[s.id] = {};
    const newSel = {}, newRec = {}, newCfl = {};

    function hasData(obj, key) { const v = obj?.[key]; return v != null && v !== 0 && v !== ''; }

    for (const { key, displayOnly } of SCRAPE_ALL_FIELDS) {
      // Per-source state for coloring
      for (const s of sources) {
        if (!hasData(s, key)) { srcStates[s.id][key] = null; continue; }
        const fv = current[key], sv = s[key];
        const fvEmpty = fv == null || fv === 0 || fv === '';
        if (!fvEmpty && normCmp(String(fv)) === normCmp(String(sv))) {
          srcStates[s.id][key] = 'match';
        } else if (fvEmpty) {
          srcStates[s.id][key] = 'recommend';
        } else {
          srcStates[s.id][key] = 'judge';
        }
      }

      if (displayOnly) continue;

      // ── Source affinity scoring ──────────────────────────────────────
      // For each source, count how many WRITE_FIELDS match the target.
      // Higher affinity → preferred when multiple sources have data for a field.
      // This naturally handles cases like a duplicate group containing tracks
      // from two different albums — the source sharing more fields with the
      // target is more likely to be the "correct" one to borrow from.
      function sourceAffinity(src) {
        let score = 0;
        for (const { key: fk } of WRITE_FIELDS) {
          const sv = src[fk], tv = current[fk];
          if (sv == null || sv === 0 || sv === '') continue;
          if (tv != null && tv !== 0 && tv !== '' && normCmp(String(tv)) === normCmp(String(sv))) score += 2;
        }
        return score;
      }

      // Auto-select: among sources with data for this field, pick the one
      // with the highest affinity to the target. Auto-check if recommend.
      let bestSrc = null, bestAff = -1;
      for (const s of sources) {
        if (!hasData(s, key)) continue;
        const aff = sourceAffinity(s);
        if (aff > bestAff) { bestAff = aff; bestSrc = s; }
      }
      if (!bestSrc) { newSel[key] = false; continue; }
      const st = srcStates[bestSrc.id][key];
      if (st === 'recommend') { newSel[key] = bestSrc.id; newRec[key] = true; }
      else { newSel[key] = false; }
    }

    setStates(srcStates);
    setSel(newSel);
    setRecommend(newRec);
    setConflicts(newCfl);
  }, [tracks, currentId]);

  function toggleSrc(key, srcId) {
    setSel(p => ({ ...p, [key]: p[key] === srcId ? false : srcId }));
  }

  async function doWrite(){
    setConfirmWrite(false); setWriting(true); setWriteResult(null);
    const fields = {};
    for (const { key } of WRITE_FIELDS) {
      const srcId = sel[key];
      if (!srcId) continue;
      const src = srcById[srcId];
      if (!src || !hasData(src, key)) continue;
      fields[key] = src[key];
    }
    const r = await api.post(`/api/files/${currentId}/write-tags`, { fields });
    setWriting(false); setWriteResult(r);
    if (r.ok) {
      load();
      onUpdated?.(); onTagsWritten?.();
    }
  }

  function hasData(obj, key) { const v = obj?.[key]; return v != null && v !== 0 && v !== ''; }

  const selCount = Object.values(sel).filter(Boolean).length;
  const canWrite = selCount > 0 && !!current;

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
    return `${m}:${String(secs).padStart(2, '0')}`;
  }

  // Duration comparison state for field-borrowing — compare formatted M:SS
  function durationState(fileDur, srcDur) {
    const fa = fmtDur(fileDur), fb = fmtDur(srcDur);
    if (!fa || !fb) return null;
    return fa === fb ? 'match' : 'judge';
  }

  // Source basis: compare title/artist/album with target — all 3 match → 精确
  function sourceBasis(src) {
    const fields = ['title', 'artist', 'album'];
    const allMatch = fields.every(f =>
      hasData(current, f) && hasData(src, f) && normCmp(String(current[f])) === normCmp(String(src[f]))
    );
    return allMatch ? '（精确）' : '（模糊）';
  }

  const nCols = 2 + sources.length;
  const colTemplate = `58px 1fr${sources.map(() => ' 1fr').join('')}`;

  return e(Modal,{title:'组内属性同步',onClose,width:Math.min(900, 200 + sources.length * 160)},
    !current && e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},'未找到目标文件'),

    current && e('div',null,

      // Filename + status bar
      e('div',{style:{marginBottom:12,padding:'8px 12px',background:'var(--bg-subtle)',borderRadius:'var(--r-md)',fontSize:11,fontFamily:'var(--font-mono)',color:'var(--tx-secondary)',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}},
        Icon('file-music',{fontSize:13,color:'var(--tx-faint)',flexShrink:0}),
        e('span',{style:{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},current.title||current.path),
        e('span',{style:{fontSize:10,padding:'2px 8px',borderRadius:99,background:'var(--amber-bg)',color:'var(--amber)',border:'0.5px solid var(--amber)',whiteSpace:'nowrap'}},
          `同步目标 · ${sources.length} 个来源`)
      ),

      // ── Comparison table (same style as ScrapeDialog) ──
      e('div',{style:{marginBottom:14}},
        e('div',{style:{display:'grid',gridTemplateColumns:colTemplate,fontSize:10,borderRadius:'var(--r-md)',overflow:'hidden',border:'0.5px solid var(--bd-default)'}},
          // Header row
          e('div',{style:{padding:'6px 8px',background:'var(--bg-subtle)',fontWeight:600,color:'var(--tx-secondary)',borderBottom:'0.5px solid var(--bd-default)',borderRight:'0.5px solid var(--bd-subtle)'}},'字段'),
          e('div',{style:{padding:'6px 8px',background:'var(--bg-subtle)',fontWeight:600,color:'var(--tx-secondary)',borderBottom:'0.5px solid var(--bd-default)',borderRight:sources.length>0?'0.5px solid var(--bd-subtle)':'none'}},'文件属性'),
          ...sources.map((s,i) => e('div',{key:s.id,
            style:{padding:'6px 8px',background:'var(--bg-subtle)',fontWeight:600,color:'var(--tx-secondary)',borderBottom:'0.5px solid var(--bd-default)',maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',
              borderRight:i<sources.length-1?'0.5px solid var(--bd-subtle)':'none'}},
            e(InstantTooltip,{tip:s.path,light:true},(s.title||'—') + sourceBasis(s))
          )),
          // Data rows
          ...SCRAPE_ALL_FIELDS.map(({key,label,displayOnly}) => {
            const fv = key === 'duration' ? fmtDur(current.duration) : fmtVal(current[key]);
            const curSrc = sel[key];
            const isDisplayOnly = !!displayOnly;
            const cells = [
              e('div',{key:key+'l',style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:'0.5px solid var(--bd-subtle)',color:'var(--tx-faint)',background:'var(--bg-subtle)'}},label),
              e('div',{key:key+'f',style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',borderRight:sources.length>0?'0.5px solid var(--bd-subtle)':'none',color:'var(--tx-primary)',fontFamily:'var(--font-mono)',fontSize:9}},
                fv||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—')
              ),
            ];
            for (const s of sources) {
              const sVal = key === 'duration' ? fmtDur(s.duration) : fmtVal(s[key]);
              const sState = key === 'duration' ? durationState(current.duration, s.duration) : states[s.id]?.[key];
              const isSelected = curSrc === s.id;
              cells.push(isDisplayOnly
                ? e('div',{key:s.id,
                  style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',
                    background:sState?STATE_BG[sState]:'transparent',display:'flex',alignItems:'flex-start',gap:4,flexWrap:'wrap',
                    color:sState?'var(--tx-primary)':'var(--tx-faint)'}},
                  e('span',{style:{fontFamily:'var(--font-mono)',fontSize:9,flex:1}},
                    sVal||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—'))
                )
                : e('label',{key:s.id,
                  onClick:()=>sState&&toggleSrc(key,s.id),
                  style:{padding:'6px 8px',borderBottom:'0.5px solid var(--bd-subtle)',
                    background:sState?STATE_BG[sState]:'transparent',
                    border:'1px solid transparent',
                    cursor:sState?'pointer':'default',display:'flex',alignItems:'flex-start',gap:4,flexWrap:'wrap'
                  }},
                  sState&&e('input',{type:'radio',name:'cf_'+key,checked:isSelected,onChange:()=>{},style:{accentColor:'var(--amber)',width:12,height:12,flexShrink:0,marginTop:1}}),
                  e('span',{style:{fontFamily:'var(--font-mono)',fontSize:9,color:'var(--tx-primary)',flex:1}},
                    sVal||e('span',{style:{color:'var(--tx-faint)',fontStyle:'italic'}},'—'),
                    isSelected&&recommend[key]&&e('span',{style:{fontSize:9,color:'var(--amber)',fontWeight:500,marginLeft:3}},'推荐')
                  )
                  ));
            }
            return cells;
          }).flat()
        ),
        // Legend row
        e('div',{style:{display:'flex',gap:14,alignItems:'center',flexWrap:'wrap',marginTop:8,fontSize:10,color:'var(--tx-faint)'}},
          e('span',{style:{display:'flex',alignItems:'center',gap:4}},e('span',{style:{width:12,height:12,borderRadius:2,background:'#F0FDF4',border:'0.5px solid var(--bd-subtle)'}}),'绿=一致'),
          e('span',{style:{display:'flex',alignItems:'center',gap:4}},e('span',{style:{width:12,height:12,borderRadius:2,background:'#EFF6FF',border:'0.5px solid var(--bd-subtle)'}}),'蓝=推荐写入（空白）'),
          e('span',{style:{display:'flex',alignItems:'center',gap:4}},e('span',{style:{width:12,height:12,borderRadius:2,background:'#FFFBEB',border:'0.5px solid var(--bd-subtle)'}}),'黄=需自行判断'),
          e('span',{style:{display:'flex',alignItems:'center',gap:4}},e('span',{style:{color:'var(--tx-muted)',fontStyle:'italic'}}),'时长仅对比，不写入')
        )
      ),

      // Write result
      writeResult&&e('div',{style:{marginBottom:10,padding:'8px 12px',borderRadius:'var(--r-md)',
        background:writeResult.ok?'var(--green-bg)':'var(--red-bg)',
        border:`0.5px solid ${writeResult.ok?'var(--green-bd)':'var(--red-bd)'}`,fontSize:11}},
        writeResult.ok
          ? e('span',{style:{color:'var(--green)'}},'✓ 写入成功')
          : e('span',{style:{color:'var(--red)'}},Icon('alert-circle',{marginRight:4,fontSize:12}),'失败: '+writeResult.error)
      ),

      // Footer
      e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,flexWrap:'wrap',borderTop:'0.5px solid var(--bd-default)',paddingTop:14}},
        e('div',{style:{fontSize:10,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:5}},
          Icon('shield-check',{fontSize:12,color:'var(--green)'}),'写入前自动备份原始标签，可随时撤销'),
        e(Btn,{disabled:!canWrite||writing,
          icon:writing?'loader':'pencil',
          onClick:()=>setConfirmWrite(true)},
          writing?'写入中...':canWrite?`写入 ${selCount} 个字段`:'选择字段后写入')
      ),

      // Confirm dialog
      confirmWrite&&e('div',{style:{position:'fixed',inset:0,zIndex:1100,background:'rgba(0,0,0,.5)',display:'flex',alignItems:'center',justifyContent:'center'},
        onClick:ev=>ev.target===ev.currentTarget&&setConfirmWrite(false)},
        e('div',{style:{background:'var(--bg-base)',borderRadius:'var(--r-xl)',padding:'24px 28px',maxWidth:440,width:'90%',boxShadow:'0 8px 32px rgba(0,0,0,.2)'}},
          e('div',{style:{fontSize:14,fontWeight:700,marginBottom:8}},'确认组内属性同步'),
          e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.7,marginBottom:12}},
            `将把以下字段值写入 ${current.title||current.path}：`),
          WRITE_FIELDS.filter(({key})=>sel[key]&&srcById[sel[key]]?.[key]!=null&&srcById[sel[key]][key]!==0&&srcById[sel[key]][key]!=='').map(({key,label})=>
            e('div',{key,style:{fontSize:11,padding:'4px 8px',background:'var(--bg-subtle)',borderRadius:'var(--r-sm)',marginBottom:4,display:'flex',gap:8}},
              e('span',{style:{color:'var(--tx-faint)',width:42,flexShrink:0}},label+':'),
              e('span',{style:{fontFamily:'var(--font-mono)',color:'var(--amber)'}},String(srcById[sel[key]][key])),
              e('span',{style:{fontSize:9,color:'var(--tx-faint)'}},srcById[sel[key]].title||'#'+sel[key])
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

    ) // end current
  );
}

function DimensionTable({tracks}){
  const[showInfo,setShowInfo]=useState(false);
  if(!tracks||tracks.length<2)return null;
  const mxSize=Math.max(...tracks.map(t=>t.size||1));
  // Estimate rendered pixel width at fontSize 10.5: CJK ~10.5px, Latin/digit ~6px
  const textPx=s=>{let w=0;for(const c of s){w+=/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(c)?10.5:6}return Math.ceil(w)};
  // Header width = icon(~11px) + gap(~2px) + label
  const hdrPx=label=>13+textPx(label);
  // Size column inner: bar(min 100px) + internal gap(6) + widest bytes text
  const sizeInner=Math.max(80+6+Math.max(...tracks.map(t=>textPx(fmtBytes(t.size)))),hdrPx('大小'))+4;
  // Dimension columns inner: max(header, widest cell) + buffer
  const dimInner={};
  DIMENSION_COLUMNS.forEach(c=>{
    const dataPx=Math.max(...tracks.map(t=>textPx(c.cell(t,tracks).text)));
    dimInner[c.key]=Math.max(hdrPx(c.label),dataPx)+4;
  });
  // Convert inner widths → percentages for table-layout:fixed
  const totalInner=sizeInner+Object.values(dimInner).reduce((a,b)=>a+b,0);
  const pct=v=>(v/totalInner*100).toFixed(1)+'%';
  const GAP=10; // right padding = visual gap between columns (no borders)
  const GAP_FIRST=18; // extra gap after size column — bar fills cell, needs clearer separation
  return e('div',{style:{background:'var(--bg-subtle)',borderRadius:'var(--r-md)',padding:'10px 12px',marginBottom:12}},
    e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}},
      e('div',{style:{fontSize:11,fontWeight:500,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:4}},
        Icon('table-compare',{fontSize:12}),'维度对比'
      ),
      e('button',{
        onClick:()=>setShowInfo(true),
        style:{padding:'3px 10px',borderRadius:99,fontSize:11,cursor:'pointer',border:'0.5px solid var(--bd-default)',background:'var(--bg-base)',color:'var(--tx-muted)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap',flexShrink:0},
      }, Icon('info-circle',{fontSize:12}), '维度说明')
    ),
    e('div',{style:{overflowX:'auto'}},
      e('table',{style:{borderCollapse:'collapse',tableLayout:'fixed',width:'100%',fontSize:10.5}},
        e('thead',null,e('tr',null,
          e('th',{style:{textAlign:'left',padding:'2px '+GAP_FIRST+'px 4px 0',color:'var(--tx-faint)',fontWeight:500,whiteSpace:'nowrap',width:pct(sizeInner)}},Icon('ruler',{fontSize:11}),' 大小'),
          ...DIMENSION_COLUMNS.map(c=>e('th',{key:c.key,style:{textAlign:'left',padding:'2px '+GAP+'px 4px 0',color:'var(--tx-faint)',fontWeight:500,whiteSpace:'nowrap',width:pct(dimInner[c.key])}},Icon(c.icon,{fontSize:11}),' ',c.label))
        )),
        e('tbody',null,tracks.map(t=>e('tr',{key:t.id},
          e('td',{style:{padding:'3px '+GAP_FIRST+'px 3px 0',whiteSpace:'nowrap'}},
            e('div',{style:{display:'flex',alignItems:'center',gap:6}},
              e('div',{style:{flex:1,height:6,background:'var(--bg-muted)',borderRadius:99,overflow:'hidden',minWidth:50}},
                e('div',{style:{width:(t.size/mxSize*100).toFixed(1)+'%',height:'100%',background:t._keepWinner?'var(--green)':'var(--red)',opacity:t._keepWinner?.85:.3,borderRadius:99}})
              ),
              e('span',{style:{fontSize:10,fontFamily:'var(--font-mono)',color:t._keepWinner?'var(--green)':'var(--tx-faint)',fontWeight:t._keepWinner?600:400}},fmtBytes(t.size))
            )
          ),
          ...DIMENSION_COLUMNS.map(c=>{
            const{text,ok,muted}=c.cell(t,tracks);
            return e('td',{key:c.key,style:{padding:'3px '+GAP+'px 3px 0',whiteSpace:'nowrap',color:muted?'var(--tx-faint)':ok?'var(--green)':'var(--tx-secondary)',fontWeight:ok?600:400}},text);
          })
        )))
      )
    ),
    showInfo&&e(Modal,{title:'维度说明',width:600,onClose:()=>setShowInfo(false),description:'重复组内每首歌按以下6个维度逐项比较，绿色加粗为该项胜出。维度按优先级从高到低排列，上一级打平时交由下一级裁决，全部打平则全保留，由用户手动选择。'},
      e('div',{style:{fontSize:12,lineHeight:1.8,color:'var(--tx-secondary)'}},
        e('div',{style:{display:'grid',gridTemplateColumns:'minmax(72px,max-content) 1fr',columnGap:12,rowGap:2,marginBottom:10}},
          ...DIMENSION_COLUMNS.map(c=>DIMENSION_INFO[c.key]?e('div',{key:c.key,style:{display:'contents'}},
            e('div',{style:{fontWeight:600,color:'var(--tx-primary)',padding:'5px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},c.label),
            e('div',{style:{fontSize:11,color:'var(--tx-secondary)',lineHeight:1.6,padding:'5px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},DIMENSION_INFO[c.key])
          ):null)
        )
      )
    )
  );
}

function TrackRow({track,onToggle,canToggle,onProps,onScrape,onCrossFill,player,queue,isKept}){
  const keep=!!track._keepWinner;
  const isCur=player?.current?.id===track.id;
  const[coverErr,setCoverErr]=useState(false);
  const bd=keep?'var(--green-bd)':'var(--red-bd)';
  const bg=keep?'var(--green-bg)':'var(--red-bg)';

  const coverSrc=`musicdedup://app/cover/${track.id}`;

  return e('div',{style:{marginBottom:8,borderRadius:'var(--r-md)',border:`1px solid ${bd}`,background:bg,overflow:'hidden'}},
    e('div',{style:{display:'flex',alignItems:'center',gap:10,padding:'10px 12px'}},

      // ── LEFT: play + cover ───────────────────────────────────────────
      e('div',{style:{display:'flex',alignItems:'center',gap:6,flexShrink:0}},
        player&&e('button',{
          onClick:()=>player.playTrack({id:track.id,title:track.title,artist:track.artist,src:queue?.[0]?.src||'duplicates',groupId:queue?.[0]?.groupId},queue),
          title:'试听',
          style:{background:isCur?'var(--amber)':'rgba(0,0,0,.08)',border:'none',borderRadius:'50%',
            width:26,height:26,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',flexShrink:0}},
          Icon(isCur&&player.playing?'pause':'play',{fontSize:16,color:isCur?'#fff':'var(--tx-muted)'})
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
          track.release_type==='single'&&e(Tag,{children:'单曲'}),
          (track._pickTags||[]).map(t=>e(Tag,{key:t,children:PICK_TAG_LABEL[t]||t,color:PICK_TAG_COLOR[t]||'var(--tx-faint)'}))
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

      // ── RIGHT: keep toggle ───────────────────────────────────────────
      e('div',{style:{display:'flex',alignItems:'center',gap:4,flexShrink:0}},
        e(IconAction,{icon:'cloud-download',title:'刮削操作',onClick:onScrape}),
        onCrossFill&&e(IconAction,{icon:'arrows-exchange',title:'组内属性同步',onClick:onCrossFill}),
        e(IconAction,{icon:'folder-open',title:'打开所在目录',onClick:()=>api.post(`/api/files/${track.id}/reveal`)}),
        e(IconAction,{icon:'info-circle',title:'文件属性',onClick:onProps}),
        e('button',{
          onClick:canToggle?onToggle:undefined,
          title:canToggle?(keep?'标记为删除':'标记为保留'):'至少保留一个',
          style:{background:keep?'var(--green)':'var(--bg-base)',
            border:'1px solid '+(keep?'var(--green)':'var(--bd-default)'),
            borderRadius:'var(--r-md)',width:32,height:32,
            display:'flex',alignItems:'center',justifyContent:'center',
            cursor:canToggle?'pointer':'default',flexShrink:0,marginLeft:2,
            opacity:(!canToggle)?.4:1},
        }, keep
          ? Icon('check',{fontSize:15,color:'#fff'})
          : Icon('toggle-left',{fontSize:15,color:'var(--tx-secondary)'}))
      )
    )
  );
}

// Merge mutually-exclusive tag pairs (EXCLUSIVE_TAG_GROUPS) into a single
// legend row — they never co-occur on the same group, so they share one
// line and one description instead of two near-duplicate entries.
function buildLegendRows(tagArray){
  const shown=new Set(),rows=[];
  for(const tag of tagArray){
    if(shown.has(tag))continue;
    const pair=EXCLUSIVE_TAG_GROUPS.find(g=>g.includes(tag)&&g.every(t=>tagArray.includes(t)));
    const row=pair||[tag];
    row.forEach(t=>shown.add(t));
    rows.push(row);
  }
  return rows;
}

const DuplicatesView=React.memo(function DuplicatesView({setPendingCount,player,scanDoneKey,libraryKey,onLocate,onRetentionChange,onTagsWritten}){
  const[filter,setFilter]=useState('pending');
  const[sort,setSort]=useState('savings');
  const[groups,setGroups]=useState([]);
  const[tagFilter,setTagFilter]=useState(new Set());
  const[search,setSearch]=useState('');
  const[selId,setSelId]=useState(null);
  const[displayCount,setDisplayCount]=useState(50);
  const scrollSentinelRef=useRef(null);
  // Locate-in-duplicates: briefly highlights the target group after scrolling to it.
  const groupRefs=useRef({});
  const[flashGroupId,setFlashGroupId]=useState(null);
  const[showTagLegend,setShowTagLegend]=useState(false);
  const pendingLocateId=useRef(null);
  useEffect(()=>{
    if(!flashGroupId)return;
    const t=setTimeout(()=>setFlashGroupId(null),3200);
    return()=>clearTimeout(t);
  },[flashGroupId]);
  function scrollToGroup(gid){
    const el=groupRefs.current[gid];
    if(!el||!el.isConnected){ delete groupRefs.current[gid]; return false; }
    el.scrollIntoView({behavior:'smooth',block:'center'});
    setFlashGroupId(gid);
    return true;
  }
  function scrollToGroupRetry(gid,attempts=20){
    if(scrollToGroup(gid)||attempts<=0)return;
    setTimeout(()=>scrollToGroupRetry(gid,attempts-1),120);
  }
  // Clicking a track in the player: switch to duplicates tab, reset filters
  // to show all groups, then scroll to the containing group.
  useEffect(()=>{
    if(!onLocate)return;
    onLocate.setLocateInDuplicates?.(gid=>{
      if(!gid)return;
      setSelId(gid);
      setTagFilter(new Set());
      setSearch('');
      if(filter!=='all'){
        pendingLocateId.current=gid;
        setFilter('all');
      } else {
        scrollToGroupRetry(gid);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[onLocate]);
  // Once a filter-change triggered by locate finishes reloading the list, scroll.
  useEffect(()=>{
    if(!pendingLocateId.current)return;
    if(groups.some(g=>g.id===pendingLocateId.current)){
      const gid=pendingLocateId.current;
      pendingLocateId.current=null;
      scrollToGroupRetry(gid);
    }
  },[groups]);
  const[detail,setDetail]=useState(null);
  const[detailLoading,setDetailLoading]=useState(false);
  const[listLoading,setListLoading]=useState(true);
  const[toast,setToast]=useState(null);
  const[showEmptyTrash,setShowEmptyTrash]=useState(false);
  const[showBatchResolve,setShowBatchResolve]=useState(false);
  const[showBatchUnresolve,setShowBatchUnresolve]=useState(false);
  const[purgeConfirm,setPurgeConfirm]=useState(null); // {id, count} for per-group permanent delete
  const[propsId,setPropsId]=useState(null);
  const[scrapeId,setScrapeId]=useState(null);
  const[crossFillTracks,setCrossFillTracks]=useState(null);
  const prevScanDoneKey=useRef(0);

  function loadList(){
    setListLoading(true);
    const q=filter==='all'?'':filter==='pending'?'?resolved=0':'?resolved=1';
    api.get('/api/duplicates'+q+(q?'&':'?')+'_='+Date.now()).then(r=>{
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
  // Reset display count when filter, search, or tag filter changes
  useEffect(()=>{setDisplayCount(50);},[filter,sort,search,tagFilter]);
  // Infinite scroll for the group list (left panel) — purely client-side
  // windowing over already-fetched groups.
  useEffect(()=>{
    const sentinel=scrollSentinelRef.current;
    if(!sentinel)return;
    const obs=new IntersectionObserver(entries=>{
      if(entries[0].isIntersecting){
        setDisplayCount(prev=>Math.min(prev+50,groups.length));
      }
    },{rootMargin:'300px',threshold:0});
    obs.observe(sentinel);
    return ()=>obs.disconnect();
  },[groups.length]);
  // Reload list whenever a scan completes (scanDoneKey increments from App)
  useEffect(()=>{
    if(scanDoneKey>0&&scanDoneKey!==prevScanDoneKey.current){
      prevScanDoneKey.current=scanDoneKey;
      loadList();
      // A rematch rebuilds all dup_groups rows from scratch — group IDs are
      // not stable across rematches. Close any open detail panel to avoid
      // showing stale data under an old (or now-reassigned) group ID.
      setSelId(null);
      setDetail(null);
    }
  },[scanDoneKey]);
  // Soft-refresh: data changed (write/revert from another page), refresh list
  // and detail without clearing selection.
  useEffect(()=>{
    if(libraryKey>0&&selId){
      loadList();
      api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);});
    }
  },[libraryKey]);
  useEffect(()=>{
    if(!selId)return;
    setDetailLoading(true);
    api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);}).finally(()=>setDetailLoading(false));
  },[selId]);

  const allTags=useMemo(()=>{
    const s=new Set();
    groups.forEach(g=>(g.group_tags||'').split(',').filter(Boolean).forEach(t=>s.add(t.trim())));
    return [...s];
  },[groups]);

  // Both matching-method tags and characteristic tags are filterable —
  // they share the same tagFilter set (two button rows below), combined
  // with AND semantics. See EXCLUSIVE_TAG_GROUPS for how mutually
  // exclusive tags within one row (e.g. format_same vs format_diff) are
  // kept from being selected together, which would otherwise always
  // yield zero results.
  const filterTags=useMemo(()=>{
    const rank=t=>{const i=MATCH_METHOD_TAGS_ARRAY.indexOf(t);return i===-1?99:i;};
    return allTags.filter(t=>MATCH_METHOD_TAGS.has(t)).sort((a,b)=>rank(a)-rank(b));
  },[allTags]);
  const charTags=useMemo(()=>{
    const rank=t=>{const i=CHARACTERISTIC_TAGS_ARRAY.indexOf(t);return i===-1?99:i;};
    return allTags.filter(t=>CHARACTERISTIC_TAGS.has(t)).sort((a,b)=>rank(a)-rank(b));
  },[allTags]);

  const visibleGroups=useMemo(()=>{
    let list=groups;
    if(tagFilter.size){
      list=list.filter(g=>{
        const tags=new Set((g.group_tags||'').split(',').filter(Boolean).map(t=>t.trim()));
        return[...tagFilter].every(t=>tags.has(t));
      });
    }
    if(search.trim()){
      list=filterBySearch(list,search,['keep_title','keep_artist','keep_album','paths']);
    }
    return list;
  },[groups,tagFilter,search]);

  function toggleTagFilter(tag){
    setTagFilter(prev=>{
      const n=new Set(prev);
      if(n.has(tag)){n.delete(tag);return n;}
      const excl=EXCLUSIVE_TAG_GROUPS.find(g=>g.includes(tag));
      if(excl)for(const other of excl)if(other!==tag)n.delete(other);
      n.add(tag);
      return n;
    });
  }

  async function resolve(id){
    const r=await api.post('/api/duplicates/'+id+'/resolve');
    if(r.ok){setToast({msg:`已放入回收站，删除 ${r.deleted?.length||0} 个文件`,type:'success'});loadList();if(detail?.id===id)setDetail(d=>d?{...d,resolved:1}:d);setPendingCount(n=>Math.max(0,(n||1)-1));}
    else setToast({msg:r.error||'操作失败',type:'warn'});
  }
  async function unresolve(id){
    const r=await api.post('/api/duplicates/'+id+'/unresolve');
    if(r.ok){setToast({msg:r.restored?.length?`已恢复 ${r.restored.length} 个文件`:r.failed?.length?'部分文件恢复失败':'已撤销处理',type:'success'});loadList();api.get('/api/duplicates/'+id).then(r2=>{if(r2.ok)setDetail(r2.data);});}
    else setToast({msg:'操作失败: '+(r.error||''),type:'error'});
  }
  async function unresolveAll(){setShowBatchUnresolve(false);const ids=visibleResolved.map(g=>g.id);const r=await api.post('/api/duplicates/unresolve-all',{ids});if(r.ok){setToast({msg:`已恢复 ${r.restoredCount} 个文件，${r.groupsRestored} 组`,type:'success'});loadList();}else setToast({msg:'批量撤销失败',type:'error'});}
  async function resolveAll(){setShowBatchResolve(false);const ids=visiblePending.map(g=>g.id);const r=await api.post('/api/duplicates/resolve-all',{ids});if(r.ok){setToast({msg:`批量完成，放入回收站 ${r.deletedCount} 个文件`,type:'success'});loadList();setPendingCount(0);}else setToast({msg:r.error||'失败',type:'error'});}
  async function emptyTrash(){setShowEmptyTrash(false);const ids=visibleResolved.map(g=>g.id);const r=await api.post('/api/trash/empty',{ids});if(r.ok){setToast({msg:`已永久删除 ${r.deletedCount} 个文件${r.groupsRemoved?`，${r.groupsRemoved} 个组已清理`:''}`,type:'success'});loadList();if(r.groupsRemoved>0)setSelId(null);}else setToast({msg:'清空失败',type:'error'});}
  async function purgeGroup(id){const r=await api.post('/api/duplicates/'+id+'/purge');if(r.ok){setToast({msg:r.groupRemoved?`已彻底删除并清理该组`:`已彻底删除 ${r.deletedCount} 个文件`,type:'success'});loadList();if(r.groupRemoved){setDetail(null);setSelId(null);}}else setToast({msg:'删除失败',type:'error'});}
  async function toggleTrack(gid,fid,keep,reason){const r=await api.put(`/api/duplicates/${gid}/tracks/${fid}/keep`,{keep,reason});if(r.ok){setDetail(r.data);onRetentionChange?.();}}
  // Toggle keep: adds/removes from retention list (manual override).
  function onTrackToggle(groupId,fileId,currentKeep,tracks){
    toggleTrack(groupId,fileId,!currentKeep,!currentKeep?'手动指定保留':'移除手动保留');
  }

  const pending=groups.filter(g=>!g.resolved);
  // BUG FIX: compute savings from the VISIBLE (filtered) pending groups,
  // not from all pending groups — so the count/bytes update when the user
  // applies a tag or search filter (previously showed unfiltered total always).
  const visiblePending=visibleGroups.filter(g=>!g.resolved);
  const visibleResolved=visibleGroups.filter(g=>g.resolved);
  const savings=visiblePending.reduce((a,g)=>a+(g.savings_bytes||0),0);
  const resolvedSavings=visibleResolved.reduce((a,g)=>a+(g.savings_bytes||0),0);

  const GH='calc(100vh - 260px)';

  return e('div',{className:'fade'},
    scrapeId&&e(ScrapeDialog,{fileId:scrapeId,onClose:()=>setScrapeId(null),
      onUpdated:()=>{loadList();if(selId){api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);});}},
      onTagsWritten:onTagsWritten}),
    crossFillTracks&&e(CrossFillDialog,{groupId:crossFillTracks.groupId, currentId:crossFillTracks.currentId,
      onClose:()=>setCrossFillTracks(null),
      onUpdated:()=>{loadList();if(selId){api.get('/api/duplicates/'+selId).then(r=>{if(r.ok)setDetail(r.data);});}},
      onTagsWritten:onTagsWritten}),
    toast&&e(Toast,{msg:toast.msg,type:toast.type,onClose:()=>setToast(null)}),
    showTagLegend&&e(Modal,{title:'重复组标签说明',onClose:()=>setShowTagLegend(false),width:640,description:'可多选，多选为同时满足关系；同一行内的标签互斥，只会出现其一。'},
      e('div',{style:{fontSize:12,color:'var(--tx-secondary)',lineHeight:1.8,marginBottom:16}},
        e('div',{style:{fontSize:13,fontWeight:700,color:'var(--tx-primary)',marginBottom:10}},'重复匹配方法'),
        e('div',{style:{display:'grid',gridTemplateColumns:'minmax(96px,max-content) 1fr',columnGap:12,rowGap:2}},
          buildLegendRows(MATCH_METHOD_TAGS_ARRAY).map(row=>
            e('div',{key:row.join('+'),style:{display:'contents'}},
              e('div',{style:{display:'flex',flexWrap:'wrap',gap:4,alignContent:'flex-start',padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
                row.map(tag=>{
                  const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
                  return e('span',{key:tag,style:{fontSize:10,fontWeight:500,color:col,background:bg,border:`0.5px solid ${bd}`,padding:'1px 7px',borderRadius:3,whiteSpace:'nowrap'}},GROUP_TAG_LABELS[tag]||tag);
                })
              ),
              e('div',{style:{fontSize:11,color:'var(--tx-secondary)',lineHeight:1.6,padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},GROUP_TAG_DESCRIPTIONS[row[0]])
            )
          )
        ),
        e('div',{style:{fontSize:13,fontWeight:700,color:'var(--tx-primary)',marginTop:16,marginBottom:10}},'其他组内特征'),
        e('div',{style:{display:'grid',gridTemplateColumns:'minmax(96px,max-content) 1fr',columnGap:12,rowGap:2}},
          buildLegendRows(CHARACTERISTIC_TAGS_ARRAY).map(row=>
            e('div',{key:row.join('+'),style:{display:'contents'}},
              e('div',{style:{display:'flex',flexWrap:'wrap',gap:4,alignContent:'flex-start',padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},
                row.map(tag=>{
                  const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
                  return e('span',{key:tag,style:{fontSize:10,fontWeight:500,color:col,background:bg,border:`0.5px solid ${bd}`,padding:'1px 7px',borderRadius:3,whiteSpace:'nowrap'}},GROUP_TAG_LABELS[tag]||tag);
                })
              ),
              e('div',{style:{fontSize:11,color:'var(--tx-secondary)',lineHeight:1.6,padding:'6px 0',borderBottom:'0.5px solid var(--bd-subtle)'}},GROUP_TAG_DESCRIPTIONS[row[0]])
            )
          )
        )
      )
    ),
    propsId&&e(PropsModal,{fileId:propsId,onClose:()=>setPropsId(null)}),

    // Filter bar: matching-method tags (how the group was discovered)
    e('div',{style:{marginBottom:6,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',paddingRight:18,justifyContent:'space-between'}},
      e('span',{style:{fontSize:11,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}},Icon('filter',{fontSize:12}),'匹配方法筛选：'),
      e('span',{style:{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}},
        filterTags.map(tag=>{
          const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
          const active=tagFilter.has(tag);
          return e('button',{key:tag,onClick:()=>toggleTagFilter(tag),style:{padding:'3px 10px',borderRadius:99,fontSize:11,fontWeight:active?600:400,cursor:'pointer',border:`1px solid ${active?col:bd}`,background:active?bg:'var(--bg-base)',color:active?col:'var(--tx-muted)',transition:'all .12s'}},GROUP_TAG_LABELS[tag]||tag);
        }),
      ),
      e('button',{
        onClick:()=>setShowTagLegend(true),
        style:{padding:'3px 10px',borderRadius:99,fontSize:11,cursor:'pointer',border:'0.5px solid var(--bd-default)',background:'var(--bg-base)',color:'var(--tx-muted)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap',flexShrink:0},
      }, Icon('info-circle',{fontSize:12}), '标签说明'),
    ),
    // Second row: characteristic tags (what the group looks like) + clear button
    e('div',{style:{marginBottom:10,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',paddingRight:18,justifyContent:'space-between'}},
      e('span',{style:{display:'flex',alignItems:'center',gap:8}},
        e('span',{style:{fontSize:11,color:'var(--tx-faint)',display:'flex',alignItems:'center',gap:5,whiteSpace:'nowrap'}},Icon('tag',{fontSize:12}),'其他组内特征：'),
        charTags.map(tag=>{
          const[col,bg,bd]=GROUP_TAG_COLORS[tag]||['#6B7280','#F3F4F6','#E5E7EB'];
          const active=tagFilter.has(tag);
          return e('button',{key:tag,onClick:()=>toggleTagFilter(tag),style:{padding:'3px 10px',borderRadius:99,fontSize:11,fontWeight:active?600:400,cursor:'pointer',border:`1px solid ${active?col:bd}`,background:active?bg:'var(--bg-base)',color:active?col:'var(--tx-muted)',transition:'all .12s'}},GROUP_TAG_LABELS[tag]||tag);
        }),
      ),
      e('button',{
        onClick:()=>setTagFilter(new Set()),
        disabled:tagFilter.size===0,
        style:{
          padding:'4px 12px',borderRadius:'var(--r-md)',fontSize:11,cursor:tagFilter.size>0?'pointer':'default',
          border:'0.5px solid var(--bd-default)',background:tagFilter.size>0?'var(--bg-base)':'transparent',
          color:tagFilter.size>0?'var(--tx-secondary)':'var(--tx-faint)',
          opacity:tagFilter.size>0?1:0.4,whiteSpace:'nowrap',
          display:'flex',alignItems:'center',gap:4,flexShrink:0,
        }
      }, Icon('x',{fontSize:12}), '清除筛选')
    ),

    // Toolbar
    e('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8,gap:8,flexWrap:'wrap',paddingRight:18}},
      e('div',{style:{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center',flex:1,minWidth:0}},
        e('div',{style:{display:'flex',background:'var(--bg-muted)',padding:2,borderRadius:'var(--r-md)',gap:2}},
          ...[['pending','待处理'],['done','已处理'],['all','全部']].map(([f,l])=>
            e('button',{key:f,onClick:()=>{setFilter(f);setSelId(null);},style:{padding:'4px 10px',fontSize:11,fontWeight:filter===f?600:400,cursor:'pointer',borderRadius:'var(--r-sm)',background:filter===f?'var(--bg-base)':'transparent',color:filter===f?'var(--tx-primary)':'var(--tx-muted)',border:'none',boxShadow:filter===f?'var(--sh-xs)':'none',transition:'all .15s'}},l))
        ),
        e('select',{value:sort,onChange:ev=>setSort(ev.target.value),style:{fontSize:12,padding:'5px 10px',borderRadius:'var(--r-md)',background:'var(--bg-base)',color:'var(--tx-secondary)',border:'0.5px solid var(--bd-default)',boxShadow:'var(--sh-xs)'}},
          e('option',{value:'savings'},'按可释放空间'),e('option',{value:'sim'},'按相似度'),e('option',{value:'files'},'按文件数')
        ),
        e(SearchInput,{value:search,onChange:setSearch}),
      ),
      filter==='pending'&&visiblePending.length>0&&e('div',{style:{display:'flex',gap:8,alignItems:'center'}},
        e('span',{style:{fontSize:11,color:'var(--tx-faint)'}},`${visiblePending.length} 组 · ${fmtBytes(savings)}`),
        e(Btn,{onClick:()=>setShowBatchResolve(true),icon:'trash',style:{padding:'5px 12px',fontSize:12}},'批量放入回收站')
      ),
      filter==='done'&&e('div',{style:{display:'flex',gap:8,alignItems:'center'}},
        e(Btn,{onClick:()=>setShowBatchUnresolve(true),icon:'arrow-back-up',variant:'ghost',style:{padding:'5px 12px',fontSize:12}},'批量撤销'),
        e(Btn,{onClick:()=>setShowEmptyTrash(true),icon:'trash',variant:'ghost',style:{padding:'5px 12px',fontSize:12}},'清空回收站')
      )
    ),

    showEmptyTrash&&e(ConfirmModal,{
      title:'清空回收站',
      message:e('span',null,
        '将永久删除 ',e('b',null,visibleResolved.length),' 个已处理组的 .deleted 文件',
        resolvedSavings>0?e('span',null,'（约 ',fmtBytes(resolvedSavings),'）'):null,
        '。',e('br'),e('br'),
        '此操作不可撤销。确定要继续吗？'),
      onConfirm:emptyTrash,
      onClose:()=>setShowEmptyTrash(false),
      danger:true,
    }),
    showBatchResolve&&e(ConfirmModal,{
      title:'批量放入回收站',
      message:e('span',null,
        '将处理 ',e('b',null,visiblePending.length),' 个重复组，',
        '释放约 ',e('b',null,fmtBytes(savings)),'。',e('br'),e('br'),
        '文件将被重命名为 .deleted，需要时可撤销恢复。'),
      onConfirm:resolveAll,
      onClose:()=>setShowBatchResolve(false),
      danger:true,
    }),
    showBatchUnresolve&&e(ConfirmModal,{
      title:'批量撤销',
      message:e('span',null,
        '将恢复 ',e('b',null,visibleResolved.length),' 个已处理组的 .deleted 文件',
        resolvedSavings>0?e('span',null,'（约 ',fmtBytes(resolvedSavings),'）'):null,
        '。',e('br'),e('br'),
        '确定要继续吗？'),
      onConfirm:unresolveAll,
      onClose:()=>setShowBatchUnresolve(false),
    }),
    purgeConfirm&&e(ConfirmModal,{
      title:'彻底删除',
      message:e('span',null,
        '将永久删除此组 ',e('b',null,purgeConfirm.count),' 个 .deleted 文件。',e('br'),e('br'),
        '此操作不可撤销。确定要继续吗？'),
      onConfirm:()=>{const id=purgeConfirm.id;setPurgeConfirm(null);purgeGroup(id);},
      onClose:()=>setPurgeConfirm(null),
      danger:true,
    }),

    e('div',{style:{display:'grid',gridTemplateColumns:'240px 1fr',gap:12,height:GH}},

      e('div',{style:{overflowY:'auto',height:'100%',paddingRight:2}},
        listLoading?e('div',{style:{textAlign:'center',padding:40,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:22}})):
        visibleGroups.length===0?e('div',{style:{color:'var(--tx-faint)',fontSize:12,padding:'20px 0',textAlign:'center',lineHeight:1.8}},(tagFilter.size||search.trim())?'当前筛选条件无结果':filter==='pending'?'无待处理组\n请先执行扫描':filter==='done'?'暂无已处理组':'暂无数据'):
        e('div',null,
          visibleGroups.slice(0,displayCount).map(g=>{
          const isSel=g.id===selId;
          const tags=(g.group_tags||'').split(',').filter(Boolean).map(t=>t.trim()).slice(0,2);
          const title=g.keep_title||(detail?.id===g.id?detail.tracks?.find(t=>t._keepWinner)?.title:null)||`组 #${g.id}`;
          const artist=g.keep_artist||(detail?.id===g.id?detail.tracks?.find(t=>t._keepWinner)?.artist:null)||'';
          return e('div',{key:g.id,ref:el=>{if(el)groupRefs.current[g.id]=el;else delete groupRefs.current[g.id];},className:g.id===flashGroupId?'locate-flash':undefined,onClick:()=>setSelId(g.id),style:{padding:'10px 12px',borderRadius:'var(--r-lg)',cursor:'pointer',background:isSel?'var(--amber-bg)':'var(--bg-base)',border:`0.5px solid ${isSel?'var(--amber-bd)':'var(--bd-default)'}`,boxShadow:'var(--sh-xs)',opacity:g.resolved?.6:1,transition:'all .12s',marginBottom:4}},
            e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:3}},
              e('span',{style:{fontSize:12,fontWeight:600,color:isSel?'#92400E':'var(--tx-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,maxWidth:160}},title),
              !!g.resolved&&e('i',{className:'ti ti-circle-check',style:{fontSize:13,color:'var(--green)',flexShrink:0,marginLeft:4}})
            ),
            artist&&e('div',{style:{fontSize:11,color:'var(--tx-faint)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},artist),
            e('div',{style:{display:'flex',gap:4,flexWrap:'wrap'}},
              (g.savings_bytes>0)&&e('span',{style:{fontSize:10,padding:'1px 6px',borderRadius:3,background:'#FEF3C7',color:'#92400E',border:'0.5px solid #FDE68A'}},fmtBytes(g.savings_bytes)),
              tags.map(t=>e(GroupTag,{key:t,tag:t}))
            )
          );
        }),
        e('div',{ref:scrollSentinelRef,style:{height:1}})
      )
      ),

      e('div',{style:{overflowY:'auto',height:'100%',background:'var(--bg-base)',border:'0.5px solid var(--bd-default)',borderRadius:'var(--r-lg)',boxShadow:'var(--sh-xs)',padding:'16px 18px'}},
        detailLoading?e('div',{style:{textAlign:'center',padding:60,color:'var(--tx-faint)'}},e('i',{className:'ti ti-loader spin',style:{fontSize:24}})):
        !detail||detail.id!==selId?
          e('div',{style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:10,height:'100%',color:'var(--tx-faint)',fontSize:12}},Icon('click',{fontSize:36}),'从左侧选择重复组查看详情'):
          e('div',{className:'fade'},
            // Header — F6: just tags, no extra explanation paragraph; the tag
            // itself (with hover description) carries the meaning now.
            e('div',{style:{marginBottom:14}},
              e('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10}},
                e('div',{style:{flex:1,minWidth:0}},
                  e('div',{style:{fontSize:15,fontWeight:700,color:'var(--tx-primary)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},detail.tracks?.find(t=>t._keepWinner)?.title||'—'),
                  e('div',{style:{fontSize:12,color:'var(--tx-muted)'}},detail.tracks?.find(t=>t._keepWinner)?.artist||'')
                ),
                detail.resolved?
                  (()=>{
                    const dels=detail.tracks?.filter(t=>!t._keepWinner)||[];
                    return e('div',{style:{display:'flex',gap:6}},
                      e('span',{style:{fontSize:11,fontWeight:500,color:'var(--green)',background:'var(--green-bg)',border:'0.5px solid var(--green-bd)',borderRadius:'var(--r-md)',padding:'4px 10px',display:'inline-flex',alignItems:'center',gap:4}},e('i',{className:'ti ti-circle-check',style:{fontSize:13}}),dels.length?'已处理':'已清理'),
                      dels.length>0&&e(Btn,{variant:'ghost',icon:'arrow-back-up',small:true,onClick:()=>unresolve(detail.id)},'撤销'),
                      dels.length>0&&e(Btn,{variant:'ghost',icon:'trash',small:true,onClick:()=>setPurgeConfirm({id:detail.id,count:dels.length})},'彻底删除')
                    );
                  })()
                :
                  (()=>{const dels=detail.tracks?.filter(t=>!t._keepWinner)||[];return e(Btn,{icon:'trash',onClick:()=>resolve(detail.id)},`放入回收站 ${dels.length} 个`);})()
              ),
              e('div',{style:{display:'flex',gap:5,flexWrap:'wrap',marginTop:6}},
                ...(detail.group_tags||'').split(',').filter(Boolean).map(t=>t.trim()).map(t=>e(GroupTag,{key:t,tag:t}))
              )
            ),


            e(DimensionTable,{tracks:detail.tracks||[]}),

            (detail.tracks||[]).map(t=>e(TrackRow,{key:t.id,track:t,player,
              isKept:!!t._keepWinner,
              queue:(detail.tracks||[]).filter(x=>x.fingerprint).map(x=>({id:x.id,title:x.title,artist:x.artist,src:'duplicates',groupId:detail.id})),
              onToggle:()=>onTrackToggle(detail.id,t.id,t._keepWinner,detail.tracks||[]),
              canToggle:!detail.resolved,
              onProps:()=>setPropsId(t.id),
              onScrape:()=>setScrapeId(t.id),
              onCrossFill:()=>setCrossFillTracks({groupId:detail.id, currentId:t.id}),
            })),


          )
      )
    )
  );
});
