// daily.js — 'Today' docked panel + full-view overlay.
//
// COST MODEL (important): generating the list runs the 'daily' agent across the
// user's email, calendar and monday boards — slow and expensive. It therefore
// NEVER runs automatically. Opening the panel reads the cached list from
// /api/daily/tasks (a cheap DB read). The agent only runs when the user clicks
// "Load my day" or ⟳ Refresh, and the server caps it at 3 runs per user per day
// (the run is claimed server-side BEFORE the call, so the cap actually bites).
//
// Server-backed per-user state:
//   • task list   — GET /api/daily/tasks, POST /api/daily/tasks/claim, POST /api/daily/tasks
//   • completion  — GET /api/daily/completions, POST /api/daily/complete
//   • snooze      — POST /api/daily/snooze
//
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
  var dateEl   = document.getElementById('daily-date');

  var tasks = [];
  var loaded = false;          // true once a real list is in hand
  var opened = false;          // true once we've done the cheap open fetch
  var prevKeys = null;         // for the refresh diff
  var remaining = null;        // agent runs left today (from server)
  var generatedAt = null;

  function localDay(){ var d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10); }
  function nextDay(d){ var t=new Date(d+'T00:00:00Z'); t.setUTCDate(t.getUTCDate()+1); return t.toISOString().slice(0,10); }
  var day = localDay();

  var doneMap = {};            // { key: true } — ticked
  var snoozeMap = {};          // { key: true } — hidden until a later day
  // Keys that were ALREADY done when this panel opened. These are treated as
  // handled and never rendered again — that is what "don't show it to me on the
  // next reload" means. Ticking during this session does NOT hide the row
  // immediately; it moves into "Done" so the check still feels like something.
  var hiddenDone = {};

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function safeUrl(u){ u=String(u||'').trim(); return /^https?:\/\//i.test(u) ? u : ''; }
  function norm(s){ return String(s==null?'':s).trim().toLowerCase().replace(/\s+/g,' '); }
  function keyFor(t){ return norm(t.deal)+'|'+norm(t.task); }
  function isDone(k){ return doneMap[k]===true; }
  function isSnoozed(k){ return snoozeMap[k]===true; }
  function isHandled(k){ return hiddenDone[k]===true; }
  function urg(t){ var u=(t.urgency||'today').toLowerCase(); return (u==='overdue'||u==='soon')?u:'today'; }
  // what the panel shows: not snoozed, and not already-handled before we opened
  function visibleTasks(){ return tasks.filter(function(t){ var k=keyFor(t); return !isSnoozed(k) && !isHandled(k); }); }
  function snoozedTasks(){ return tasks.filter(function(t){ var k=keyFor(t); return isSnoozed(k) && !isHandled(k); }); }

  function readList(name){ try { return JSON.parse(localStorage.getItem(name+'-'+day)||'[]'); } catch(e){ return []; } }
  function writeList(name, map){ try { localStorage.setItem(name+'-'+day, JSON.stringify(Object.keys(map).filter(function(k){ return map[k]; }))); } catch(e){} }
  function toMap(arr){ var m={}; (arr||[]).forEach(function(k){ m[k]=true; }); return m; }

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
  var CLOCK_SVG='<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.4 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

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

  function quickHtml(t, k, opts){
    var url=safeUrl(t.url), bits='';
    if(url) bits+='<a class="dl-q" href="'+esc(url)+'" target="_blank" rel="noopener" title="Open" aria-label="Open">&#8599;</a>';
    if(opts.snoozed){
      bits+='<button type="button" class="dl-q dl-unsnooze" data-unsnooze="'+esc(k)+'" title="Un-snooze" aria-label="Un-snooze">&#8617;</button>';
    } else if(!isDone(k)){
      bits+='<button type="button" class="dl-q dl-snooze" data-snooze="'+esc(k)+'" title="Snooze to tomorrow" aria-label="Snooze to tomorrow">'+CLOCK_SVG+'</button>';
    }
    return bits ? '<div class="dl-quick">'+bits+'</div>' : '';
  }

  function rowHtml(t, opts){
    opts=opts||{};
    var k=keyFor(t), d=isDone(k);
    var cls='dl-row'+(d?' done':'')+(opts.full?' dl-frow':'')+(opts.snoozed?' snoozed':'');
    var check='<span class="dl-cbx" role="checkbox" aria-checked="'+(d?'true':'false')+'" tabindex="0">'+
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="#fff" d="M10 2.5 4.5 9 1.5 6l1-1 2 2 4.5-5.5z"/></svg></span>';
    var html='<div class="'+cls+'" data-key="'+esc(k)+'">'+check+
      '<div class="dl-main"><div class="dl-title">'+esc(t.task||'(task)')+'</div>'+
      '<div class="dl-sub">'+metaBits(t)+'</div></div>'+quickHtml(t,k,opts)+'</div>';
    if(opts.full){
      var why = t.why ? '<b>Why:</b> '+esc(t.why) : 'No extra detail.';
      var url = safeUrl(t.url);
      var open = url ? '<a href="'+esc(url)+'" target="_blank" rel="noopener">Open &#8599;</a>' : '';
      var snz = '';
      if(opts.snoozed) snz='<button type="button" class="dl-unsnooze" data-unsnooze="'+esc(k)+'">Un-snooze</button>';
      else if(!d) snz='<button type="button" class="dl-snooze" data-snooze="'+esc(k)+'">Snooze to tomorrow</button>';
      html += '<div class="dl-detail" data-detail="'+esc(k)+'">'+why+'<div class="dl-acts">'+open+snz+'</div></div>';
    }
    return html;
  }

  function contentHtml(full_){
    var vis=visibleTasks();
    var open=vis.filter(function(t){ return !isDone(keyFor(t)); });
    var doneL=vis.filter(function(t){ return isDone(keyFor(t)); });
    var snzL=snoozedTasks();
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
    if(snzL.length){
      html+='<details class="dl-donesec dl-snzsec"><summary>Snoozed ('+snzL.length+')</summary><div class="dl-done-list">';
      snzL.forEach(function(t){ html+=rowHtml(t,{full:full_, snoozed:true}); });
      html+='</div></details>';
    }
    return html;
  }

  // The panel has no list yet today — offer to generate one. Nothing runs
  // until this is clicked.
  function ctaHtml(){
    if(remaining===0){
      return '<div class="dl-cta"><div class="dl-cta-t">Daily limit reached</div>'+
        '<div class="dl-cta-s">Your day has already been generated 3 times today. It resets tomorrow.</div></div>';
    }
    return '<div class="dl-cta">'+
      '<div class="dl-cta-t">Your day isn\'t prepared yet</div>'+
      '<button type="button" class="dl-cta-btn" id="daily-load-btn">Load my day</button>'+
      '<div class="dl-cta-s">Reads your email, calendar and monday deals. Runs once, then it\'s saved for today.</div>'+
      '</div>';
  }

  function renderDock(){
    var c=counts();
    if(!loaded){ body.innerHTML=ctaHtml(); wireCta(); updateMeta(c); return; }
    if(!tasks.length){ body.innerHTML='<div class="dl-empty">Nothing on your plate today.</div>'; }
    else if(c.total===0){ body.innerHTML='<div class="dl-empty">Nothing left for today.</div>'+contentHtml(false); }
    else if(c.open===0){ body.innerHTML='<div class="dl-clear"><div class="dl-clear-ring">&#10003;</div>'+
      '<div class="dl-clear-t">All clear for today</div>'+
      '<div class="dl-clear-s">'+c.done+' completed</div>'+
      '<div class="dl-clear-list">'+contentHtml(false)+'</div></div>'; }
    else { body.innerHTML=contentHtml(false); }
    updateMeta(c);
    wire(body,false);
  }

  function renderFull(){
    var c=counts();
    fullBody.innerHTML = loaded ? (tasks.length ? contentHtml(true) : '<div class="dl-empty">Nothing on your plate today.</div>') : ctaHtml();
    fullMeta.innerHTML = loaded ? ('<b>'+c.done+' of '+c.total+'</b> done today'+
      (c.overdueOpen>0?' &middot; <span class="dl-odflag">'+c.overdueOpen+' overdue</span>':'')) : '';
    if(loaded) wire(fullBody,true); else wireCta();
  }

  function stamp(){
    if(!dateEl) return;
    var base = new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
    if(generatedAt){
      var t = new Date(generatedAt);
      if(!isNaN(t)) base += ' · as of ' + t.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    }
    dateEl.textContent = base;
  }

  function updateMeta(c){
    var pct = c.total? Math.round(c.done/c.total*100) : 0;
    if(ring) ring.style.setProperty('--p', loaded?pct:0);
    if(ringTxt) ringTxt.textContent = loaded ? (c.done+'/'+c.total) : '–';
    if(progTxt) progTxt.innerHTML = loaded ? ('<b>'+c.done+' of '+c.total+'</b> done') : '';
    if(odTxt){ odTxt.style.display = (loaded && c.overdueOpen>0) ? 'inline' : 'none'; odTxt.textContent = c.overdueOpen+' overdue'; }
    if(railBadge){ var o=loaded?c.open:0; railBadge.textContent=o; railBadge.style.display=o>0?'inline-flex':'none'; }
    var rb=document.getElementById('daily-refresh');
    if(rb && remaining!==null) rb.title = remaining>0 ? ('Refresh ('+remaining+' left today)') : 'Daily limit reached';
    stamp();
  }

  function rerender(){ renderDock(); if(full.classList.contains('open')) renderFull(); }

  function toggle(k){
    var val = !isDone(k);
    if(val) doneMap[k]=true; else delete doneMap[k];
    writeList('daily-done', doneMap);
    rerender();
    persistDone(k, val);
  }
  function snooze(k){
    snoozeMap[k]=true; writeList('daily-snoozed', snoozeMap);
    rerender(); persistSnooze(k, nextDay(day)); showToast('Snoozed to tomorrow');
  }
  function unsnooze(k){
    delete snoozeMap[k]; writeList('daily-snoozed', snoozeMap);
    rerender(); persistSnooze(k, day); showToast('Back on today');
  }

  function wireCta(){
    var b=document.getElementById('daily-load-btn');
    if(b) b.addEventListener('click', function(){ runAgent(); });
  }

  function wire(root, isFull){
    root.querySelectorAll('.dl-row, .dl-frow').forEach(function(row){
      row.addEventListener('click', function(e){
        var k=row.getAttribute('data-key');
        if(e.target.closest('.dl-cbx')){ toggle(k); e.stopPropagation(); return; }
        if(e.target.closest('a') || e.target.closest('.dl-quick') ||
           e.target.closest('.dl-snooze') || e.target.closest('.dl-unsnooze')) return;
        if(isFull){ var det=fullBody.querySelector('[data-detail="'+cssEsc(k)+'"]'); if(det){ det.classList.toggle('open'); } }
        else { openFull(); }
      });
      var cbx=row.querySelector('.dl-cbx');
      if(cbx){ cbx.addEventListener('keydown', function(e){ if(e.key===' '||e.key==='Enter'){ e.preventDefault(); toggle(row.getAttribute('data-key')); } }); }
    });
    root.querySelectorAll('.dl-snooze').forEach(function(btn){
      btn.addEventListener('click', function(e){ e.stopPropagation(); snooze(btn.getAttribute('data-snooze')); });
    });
    root.querySelectorAll('.dl-unsnooze').forEach(function(btn){
      btn.addEventListener('click', function(e){ e.stopPropagation(); unsnooze(btn.getAttribute('data-unsnooze')); });
    });
  }
  function cssEsc(s){ return String(s).replace(/["\\\]]/g,'\\$&'); }

  var toastEl=null, toastT=null;
  function showToast(msg){
    if(!toastEl){ toastEl=document.createElement('div'); toastEl.className='dl-toast'; dock.appendChild(toastEl); }
    toastEl.textContent=msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT=setTimeout(function(){ toastEl.classList.remove('show'); }, 2600);
  }

  // --- open: cheap reads only, NO agent call -------------------------------
  function openDay(){
    if(opened) return; opened = true;
    body.innerHTML='<div class="dl-loading">Loading…</div>';
    Promise.all([
      fetch('/api/daily/completions?day='+encodeURIComponent(day), { credentials:'same-origin' })
        .then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; }),
      fetch('/api/daily/tasks?day='+encodeURIComponent(day), { credentials:'same-origin' })
        .then(function(r){ return r.ok?r.json():null; }).catch(function(){ return null; })
    ]).then(function(res){
      var state=res[0], cached=res[1];
      if(state){
        if(state.keys) doneMap = toMap(state.keys);
        if(state.snoozed) snoozeMap = toMap(state.snoozed);
      } else {
        doneMap = toMap(readList('daily-done'));
        snoozeMap = toMap(readList('daily-snoozed'));
      }
      writeList('daily-done', doneMap); writeList('daily-snoozed', snoozeMap);
      // Anything already ticked before this open is handled — hide it for good.
      hiddenDone = {};
      Object.keys(doneMap).forEach(function(k){ if(doneMap[k]) hiddenDone[k]=true; });

      if(cached){
        remaining = (typeof cached.remaining==='number') ? cached.remaining : null;
        generatedAt = cached.generatedAt || null;
        if(cached.tasks && cached.tasks.length){ tasks = cached.tasks; prevKeys = tasks.map(keyFor); loaded = true; }
      }
      rerender();
    });
  }

  // --- run the agent: only on an explicit click ---------------------------
  function extract(t){ if(!t) return null; var m=t.match(/\[[\s\S]*\]/); if(!m) return null; try { return JSON.parse(m[0]); } catch(e){ return null; } }
  function diffToast(newTasks){
    if(prevKeys===null) return;
    var nk=newTasks.map(keyFor);
    var added=nk.filter(function(k){ return prevKeys.indexOf(k)===-1; }).length;
    var gone =prevKeys.filter(function(k){ return nk.indexOf(k)===-1; }).length;
    if(added||gone) showToast(added+' new · '+gone+' resolved'); else showToast('Up to date');
  }
  var running=false;
  function runAgent(){
    if(running) return; running=true;
    var rb=document.getElementById('daily-refresh'); if(rb) rb.classList.add('spinning');
    body.innerHTML='<div class="dl-loading">Reading your day…<br><span class="dl-loading-s">email · calendar · monday</span></div>';
    // Claim a run first — the server enforces the daily cap here, BEFORE the
    // expensive call, so a rejected claim costs nothing.
    fetch('/api/daily/tasks/claim', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ day:day }) })
      .then(function(r){ return r.json().then(function(j){ return { status:r.status, j:j }; }); })
      .then(function(c){
        if(c.status===429){ remaining=0; running=false; if(rb) rb.classList.remove('spinning'); rerender(); showToast('Daily limit reached (3/day)'); return null; }
        if(c.status!==200){ throw new Error((c.j&&c.j.error)||'claim failed'); }
        if(typeof c.j.remaining==='number') remaining=c.j.remaining;
        return callAgent();
      })
      .catch(function(){
        running=false; if(rb) rb.classList.remove('spinning');
        body.innerHTML='<div class="dl-empty">Could not load your day right now.</div>';
      });
  }

  function callAgent(){
    return fetch('/api/chat',{ method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ agentId:'daily', message:'Give me my tasks for today. Respond with ONLY a JSON array (no prose, no code fence). Each element: {"task": string, "deal": string, "why": string, "url": string, "urgency": "overdue"|"today"|"soon"}.' }) })
      .then(async function(r){
        var rb=document.getElementById('daily-refresh');
        if(!r.ok){ var e={}; try{ e=await r.json(); }catch(_){}
          running=false; if(rb) rb.classList.remove('spinning');
          body.innerHTML='<div class="dl-empty">'+esc((e&&e.error)||'Could not load your day right now.')+'</div>'; return; }
        var reader=r.body.getReader(), dec=new TextDecoder(), buf='', answer='', finalResp=null;
        while(true){ var chunk=await reader.read(); if(chunk.done) break; buf+=dec.decode(chunk.value,{stream:true});
          var nl; while((nl=buf.indexOf('\n\n'))>=0){ var frame=buf.slice(0,nl); buf=buf.slice(nl+2);
            var line=frame.split('\n').find(function(l){ return l.indexOf('data:')===0; }); if(!line) continue;
            var evt; try{ evt=JSON.parse(line.slice(5).trim()); }catch(_){ continue; }
            if(evt.type==='token') answer+=evt.text;
            else if(evt.type==='done') finalResp=(evt.response||answer);
            else if(evt.type==='error'){ running=false; if(rb) rb.classList.remove('spinning');
              body.innerHTML='<div class="dl-empty">'+esc(evt.error||'Something went wrong.')+'</div>'; return; }
          }
        }
        running=false; if(rb) rb.classList.remove('spinning');
        var parsed=extract(finalResp||answer);
        if(!parsed || !parsed.length){ body.innerHTML='<div class="dl-empty">Couldn\'t read a task list yet. Try refresh, or open the Daily agent in chat.</div>'; return; }
        diffToast(parsed);
        tasks=parsed; prevKeys=parsed.map(keyFor); loaded=true; generatedAt=new Date().toISOString();
        rerender();
        // cache it so no one pays for this again today
        fetch('/api/daily/tasks', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ day:day, tasks:parsed }) })
          .then(function(r){ return r.ok?r.json():null; })
          .then(function(j){ if(j){ if(j.generatedAt) generatedAt=j.generatedAt;
            if(typeof j.remaining==='number') remaining=j.remaining; stamp(); } })
          .catch(function(){});
      });
  }

  // --- open/close full view + collapse rail --------------------------------
  function openFull(){ renderFull(); full.classList.add('open'); }
  function closeFull(){ full.classList.remove('open'); }
  function collapse(){ portal.classList.add('daily-collapsed'); }
  function expand(){ portal.classList.remove('daily-collapsed'); openDay(); }

  var elFull=document.getElementById('daily-open-full');
  var elClose=document.getElementById('daily-full-close');
  var elRefresh=document.getElementById('daily-refresh');
  var elCollapse=document.getElementById('daily-collapse');
  if(elFull) elFull.addEventListener('click', openFull);
  if(elClose) elClose.addEventListener('click', closeFull);
  if(elRefresh) elRefresh.addEventListener('click', function(){ runAgent(); });
  if(elCollapse) elCollapse.addEventListener('click', collapse);
  if(rail) rail.addEventListener('click', expand);
  full.addEventListener('click', function(e){ if(e.target===full) closeFull(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape' && full.classList.contains('open')) closeFull(); });

  stamp();
  doneMap = toMap(readList('daily-done'));
  snoozeMap = toMap(readList('daily-snoozed'));

  function sync(){
    var on = portal && getComputedStyle(portal).display !== 'none';
    dock.style.display = on ? '' : 'none';
    if(rail) rail.style.display = on ? '' : 'none';
    if(on && !portal.classList.contains('daily-collapsed')) openDay();
  }
  if (portal) { new MutationObserver(sync).observe(portal, { attributes:true, attributeFilter:['style'] }); }
  sync();
})();

// bfcache: force a fresh load when navigating back to the portal.
window.addEventListener('pageshow', function (e) { if (e.persisted) { location.reload(); } });
