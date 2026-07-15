// daily.js — 'Today' docked panel + full-view overlay.
// Docked column beside the chat (collapsible to a rail) + expandable full view.
// Task list still comes from the /api/chat 'daily' agent {task, deal, why, url, urgency}.
//
// Server-backed per-user state (with localStorage as fast cache / offline fallback):
//   • completion  — GET /api/daily/completions, POST /api/daily/complete
//   • snooze      — POST /api/daily/snooze ; GET returns keys still hidden today
// Task identity is a NORMALIZED deal|task key so trivial wording drift doesn't
// lose a tick or a snooze. All agent-supplied text is escaped before innerHTML;
// agent URLs pass an http(s) allowlist.
//
// Dates: `day` is the LOCAL calendar date and nextDay() does UTC-based calendar
// math. (Parsing 'YYYY-MM-DDT00:00:00' as local and re-serialising with
// toISOString() shifts backwards across midnight in UTC+ zones such as
// Asia/Jerusalem, which made "tomorrow" resolve to today.)
(function () {
  var portal = document.getElementById('portal');
  var dock = document.getElementById('daily-dock');
  if (!dock) return;

  var body     = document.getElementById('daily-body');
  var ring     = document.getElementById('daily-ring');
  var ringTxt  = document.getElementById('daily-ring-txt');
  var progTxt  = document.getElementById('daily-prog');
  var odTxt    = document.getElementById('daily-od');
  var full     = document.getElementById('daily-full');
  var fullBody = document.getElementById('daily-full-body');
  var fullMeta = document.getElementById('daily-full-meta');
  var rail     = document.getElementById('daily-rail');
  var railBadge= document.getElementById('daily-rail-badge');

  var tasks = [];
  var loaded = false;
  var prevKeys = null;                     // for the refresh diff
  function localDay(){ var d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
  function nextDay(d){ var t=new Date(d+'T00:00:00Z'); t.setUTCDate(t.getUTCDate()+1); return t.toISOString().slice(0,10); }
  var day = localDay();
  var doneMap = {};                        // { normalizedKey: true }
  var snoozeMap = {};                      // { normalizedKey: true } — hidden today

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function safeUrl(u){ u=String(u||'').trim(); return /^https?:\/\//i.test(u) ? u : ''; }
  function norm(s){ return String(s==null?'':s).trim().toLowerCase().replace(/\s+/g,' '); }
  function keyFor(t){ return norm(t.deal)+'|'+norm(t.task); }
  function isDone(k){ return doneMap[k]===true; }
  function urg(t){ var u=(t.urgency||'today').toLowerCase(); return (u==='overdue'||u==='soon')?u:'today'; }
  // tasks visible today = not snoozed-until-later
  function visibleTasks(){ return tasks.filter(function(t){ return !snoozeMap[keyFor(t)]; }); }

  // --- local cache (fallback / instant paint) ---
  function readList(name){ try { return JSON.parse(localStorage.getItem(name+'-'+day)||'[]'); } catch(e){ return []; } }
  function writeList(name, map){ try { localStorage.setItem(name+'-'+day, JSON.stringify(Object.keys(map).filter(function(k){ return map[k]; }))); } catch(e){} }
  function toMap(arr){ var m={}; (arr||[]).forEach(function(k){ m[k]=true; }); return m; }

  // --- server sync ---
  function loadState(){
    fetch('/api/daily/completions?day='+encodeURIComponent(day), { credentials:'same-origin' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        if(!j) return;
        if(j.keys){ doneMap = toMap(j.keys); writeList('daily-done', doneMap); }
        if(j.snoozed){ snoozeMap = toMap(j.snoozed); writeList('daily-snoozed', snoozeMap); }
        renderDock(); if(full.classList.contains('open')) renderFull();
      })
      .catch(function(){ /* keep local cache */ });
  }
  function persistDone(k, val){
    fetch('/api/daily/complete', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ day:day, key:k, done:val }) }).catch(function(){});
  }
  function persistSnooze(k, until){
    fetch('/api/daily/snooze', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key:k, until:until }) }).catch(function(){});
  }

  var GROUPS = [
    { id:'overdue', label:'Overdue', urgent:true },
    { id:'today',   label:'Today',   urgent:false },
    { id:'soon',    label:'Soon',    urgent:false }
  ];
  var ORDER = { overdue:0, today:1, soon:2 };

  var DOTS = ['#15161a','#7a6f5a','#4a6b8a','#8a5a6b','#5a7a6b','#8a7a4a','#6b5a8a'];
  function dotFor(deal){ var s=String(deal||''); var h=0; for(var i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))>>>0; } return DOTS[h%DOTS.length]; }

  function counts(){
    var vis=visibleTasks(), total=vis.length, doneN=0;
    vis.forEach(function(t){ if(isDone(keyFor(t))) doneN++; });
    var overdueOpen=vis.filter(function(t){ return urg(t)==='overdue' && !isDone(keyFor(t)); }).length;
    return { total:total, done:doneN, open:total-doneN, overdueOpen:overdueOpen };
  }

  function metaBits(t){
    var bits=[];
    if(t.deal) bits.push('<span class="dl-chip"><span class="dl-dot" style="background:'+dotFor(t.deal)+'"></span>'+esc(t.deal)+'</span>');
    if(t.due)  bits.push('<span class="dl-pill'+(urg(t)==='overdue'?' time':'')+'">'+esc(t.due)+'</span>');
    else if(urg(t)==='overdue') bits.push('<span class="dl-pill time">overdue</span>');
    if(t.estimate) bits.push('<span class="dl-pill">'+esc(t.estimate)+'</span>');
    return bits.join('');
  }

  function rowHtml(t, opts){
    opts=opts||{};
    var k=keyFor(t), d=isDone(k);
    var cls='dl-row'+(d?' done':'')+(opts.full?' dl-frow':'');
    var check='<span class="dl-cbx" role="checkbox" aria-checked="'+(d?'true':'false')+'" tabindex="0">'+
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="#fff" d="M10 2.5 4.5 9 1.5 6l1-1 2 2 4.5-5.5z"/></svg></span>';
    var html='<div class="'+cls+'" data-key="'+esc(k)+'">'+check+
      '<div class="dl-main"><div class="dl-title">'+esc(t.task||'(task)')+'</div>'+
      '<div class="dl-sub">'+metaBits(t)+'</div></div></div>';
    if(opts.full){
      var why = t.why ? '<b>Why:</b> '+esc(t.why) : 'No extra detail.';
      var url = safeUrl(t.url);
      var open = url ? '<a href="'+esc(url)+'" target="_blank" rel="noopener">Open ↗</a>' : '';
      var snz = d ? '' : '<button type="button" class="dl-snooze" data-snooze="'+esc(k)+'">Snooze to tomorrow</button>';
      html += '<div class="dl-detail" data-detail="'+esc(k)+'">'+why+'<div class="dl-acts">'+open+snz+'</div></div>';
    }
    return html;
  }

  function contentHtml(full_){
    var vis=visibleTasks();
    var open=vis.filter(function(t){ return !isDone(keyFor(t)); });
    var doneL=vis.filter(function(t){ return isDone(keyFor(t)); });
    var ordered=open.slice().sort(function(a,b){ return (ORDER[urg(a)]||1)-(ORDER[urg(b)]||1); });
    var next=ordered[0], nextKey=next?keyFor(next):null, html='';
    if(next){ html+='<div class="dl-kick">Next</div><div class="dl-next">'+rowHtml(next,{full:full_})+'</div>'; }
    GROUPS.forEach(function(g){
      var list=open.filter(function(t){ return urg(t)===g.id && keyFor(t)!==nextKey; });
      if(!list.length) return;
      html+='<div class="dl-kick'+(g.urgent?' od':'')+'">'+esc(g.label)+' <span class="dl-cnt">'+list.length+'</span></div>';
      list.forEach(function(t){ html+=rowHtml(t,{full:full_}); });
    });
    if(doneL.length){
      html+='<details class="dl-donesec"'+(open.length?'':' open')+'><summary>Done ('+doneL.length+')</summary><div class="dl-done-list">';
      doneL.forEach(function(t){ html+=rowHtml(t,{full:full_}); });
      html+='</div></details>';
    }
    return html;
  }

  function renderDock(){
    var c=counts();
    if(!tasks.length){ body.innerHTML='<div class="dl-empty">Nothing on your plate today.</div>'; }
    else if(c.total===0){ body.innerHTML='<div class="dl-empty">Everything is snoozed for later. 🌙</div>'; }
    else if(c.open===0){ body.innerHTML='<div class="dl-clear"><div class="dl-clear-ring">✓</div>'+
      '<div class="dl-clear-t">All clear for today</div>'+
      '<div class="dl-clear-s">'+c.done+' completed</div>'+
      '<div class="dl-clear-list">'+contentHtml(false)+'</div></div>'; }
    else { body.innerHTML=contentHtml(false); }
    updateMeta(c);
    wire(body,false);
  }

  function renderFull(){
    var c=counts();
    fullBody.innerHTML = tasks.length ? contentHtml(true) : '<div class="dl-empty">Nothing on your plate today.</div>';
    fullMeta.innerHTML='<b>'+c.done+' of '+c.total+'</b> done today'+
      (c.overdueOpen>0?' · <span class="dl-odflag">'+c.overdueOpen+' overdue</span>':'');
    wire(fullBody,true);
  }

  function updateMeta(c){
    var pct = c.total? Math.round(c.done/c.total*100) : 0;
    if(ring) ring.style.setProperty('--p', pct);
    if(ringTxt) ringTxt.textContent = c.done+'/'+c.total;
    if(progTxt) progTxt.innerHTML = '<b>'+c.done+' of '+c.total+'</b> done';
    if(odTxt){ odTxt.style.display = c.overdueOpen>0 ? 'inline' : 'none'; odTxt.textContent = c.overdueOpen+' overdue'; }
    if(railBadge){ railBadge.textContent=c.open; railBadge.style.display=c.open>0?'inline-flex':'none'; }
  }

  function toggle(k){
    var val = !isDone(k);
    if(val) doneMap[k]=true; else delete doneMap[k];
    writeList('daily-done', doneMap);
    renderDock();
    if(full.classList.contains('open')) renderFull();
    persistDone(k, val);
  }

  function snooze(k){
    var until = nextDay(day);
    snoozeMap[k]=true;
    writeList('daily-snoozed', snoozeMap);
    renderDock();
    if(full.classList.contains('open')) renderFull();
    persistSnooze(k, until);
    showToast('Snoozed to tomorrow');
  }

  function wire(root, isFull){
    root.querySelectorAll('.dl-row, .dl-frow').forEach(function(row){
      row.addEventListener('click', function(e){
        var k=row.getAttribute('data-key');
        if(e.target.closest('.dl-cbx')){ toggle(k); e.stopPropagation(); return; }
        if(e.target.closest('a') || e.target.closest('.dl-snooze')) return;
        if(isFull){ var det=fullBody.querySelector('[data-detail="'+cssEsc(k)+'"]'); if(det){ det.classList.toggle('open'); } }
        else { openFull(); }
      });
      var cbx=row.querySelector('.dl-cbx');
      if(cbx){ cbx.addEventListener('keydown', function(e){ if(e.key===' '||e.key==='Enter'){ e.preventDefault(); toggle(row.getAttribute('data-key')); } }); }
    });
    root.querySelectorAll('.dl-snooze').forEach(function(btn){
      btn.addEventListener('click', function(e){ e.stopPropagation(); snooze(btn.getAttribute('data-snooze')); });
    });
  }
  function cssEsc(s){ return String(s).replace(/["\\\]]/g,'\\$&'); }

  // --- transient toast in the dock ---
  var toastEl=null, toastT=null;
  function showToast(msg){
    if(!toastEl){ toastEl=document.createElement('div'); toastEl.className='dl-toast'; dock.appendChild(toastEl); }
    toastEl.textContent=msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT=setTimeout(function(){ toastEl.classList.remove('show'); }, 2600);
  }

  // --- task load: same SSE-reading logic, now with a non-destructive diff ---
  function extract(t){ if(!t) return null; var m=t.match(/\[[\s\S]*\]/); if(!m) return null; try { return JSON.parse(m[0]); } catch(e){ return null; } }
  function diffToast(newTasks){
    if(prevKeys===null) return; // first load — nothing to compare
    var nk=newTasks.map(keyFor);
    var added=nk.filter(function(k){ return prevKeys.indexOf(k)===-1; }).length;
    var gone =prevKeys.filter(function(k){ return nk.indexOf(k)===-1; }).length;
    if(added||gone){ showToast(added+' new · '+gone+' resolved'); }
    else { showToast('Up to date'); }
  }
  function load(){
    body.innerHTML='<div class="dl-loading">Reading your day…</div>';
    loadState(); // refresh completion + snooze truth in parallel
    fetch('/api/chat',{ method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ agentId:'daily', message:'Give me my tasks for today. Respond with ONLY a JSON array (no prose, no code fence). Each element: {"task": string, "deal": string, "why": string, "url": string, "urgency": "overdue"|"today"|"soon"}.' }) })
      .then(async function(r){
        if(!r.ok){ var e={}; try{ e=await r.json(); }catch(_){} body.innerHTML='<div class="dl-empty">'+esc((e&&e.error)||'Could not load your day right now.')+'</div>'; return; }
        var reader=r.body.getReader(), dec=new TextDecoder(), buf='', answer='', finalResp=null;
        while(true){ var chunk=await reader.read(); if(chunk.done) break; buf+=dec.decode(chunk.value,{stream:true});
          var nl; while((nl=buf.indexOf('\n\n'))>=0){ var frame=buf.slice(0,nl); buf=buf.slice(nl+2);
            var line=frame.split('\n').find(function(l){ return l.indexOf('data:')===0; }); if(!line) continue;
            var evt; try{ evt=JSON.parse(line.slice(5).trim()); }catch(_){ continue; }
            if(evt.type==='token') answer+=evt.text;
            else if(evt.type==='done') finalResp=(evt.response||answer);
            else if(evt.type==='error'){ body.innerHTML='<div class="dl-empty">'+esc(evt.error||'Something went wrong.')+'</div>'; return; }
          }
        }
        var parsed=extract(finalResp||answer);
        if(!parsed || !parsed.length){ body.innerHTML='<div class="dl-empty">Couldn\'t read a task list yet. Try refresh, or open the Daily agent in chat.</div>'; return; }
        diffToast(parsed);
        tasks=parsed; prevKeys=parsed.map(keyFor); loaded=true;
        renderDock();
        if(full.classList.contains('open')) renderFull();
      })
      .catch(function(){ body.innerHTML='<div class="dl-empty">Could not load your day right now.</div>'; });
  }

  // --- open/close full view + collapse rail --------------------------------
  function openFull(){ renderFull(); full.classList.add('open'); }
  function closeFull(){ full.classList.remove('open'); }
  function collapse(){ portal.classList.add('daily-collapsed'); }
  function expand(){ portal.classList.remove('daily-collapsed'); if(!loaded) load(); }

  var elFull=document.getElementById('daily-open-full');
  var elClose=document.getElementById('daily-full-close');
  var elRefresh=document.getElementById('daily-refresh');
  var elCollapse=document.getElementById('daily-collapse');
  if(elFull) elFull.addEventListener('click', openFull);
  if(elClose) elClose.addEventListener('click', closeFull);
  if(elRefresh) elRefresh.addEventListener('click', function(){ load(); });
  if(elCollapse) elCollapse.addEventListener('click', collapse);
  if(rail) rail.addEventListener('click', expand);
  full.addEventListener('click', function(e){ if(e.target===full) closeFull(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape' && full.classList.contains('open')) closeFull(); });

  var dateEl=document.getElementById('daily-date');
  if(dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});

  // seed from local cache so the panel paints instantly, then server overrides
  doneMap = toMap(readList('daily-done'));
  snoozeMap = toMap(readList('daily-snoozed'));

  function sync(){
    var on = portal && getComputedStyle(portal).display !== 'none';
    dock.style.display = on ? '' : 'none';
    if(rail) rail.style.display = on ? '' : 'none';
    if(on && !loaded && !portal.classList.contains('daily-collapsed')) load();
  }
  if (portal) { new MutationObserver(sync).observe(portal, { attributes:true, attributeFilter:['style'] }); }
  sync();
})();

// bfcache: force a fresh load when navigating back to the portal.
window.addEventListener('pageshow', function (e) { if (e.persisted) { location.reload(); } });
