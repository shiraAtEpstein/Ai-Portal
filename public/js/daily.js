// daily.js — 'Today' docked panel + full-view overlay.
// Redesign: the old floating FAB/panel is replaced by a docked column beside
// the chat ("Today"), collapsible to a slim rail, with an expandable full view.
// Data pipeline is UNCHANGED — same /api/chat 'daily' agent, same JSON task
// shape {task, deal, why, url, urgency}, same localStorage completion keyed by
// deal|task so items already ticked today stay ticked. Everything the agent
// returns is escaped before it touches innerHTML (content originates from an
// LLM reading email, so treat it as untrusted).
(function () {
  var portal = document.getElementById('portal');
  var dock = document.getElementById('daily-dock');
  if (!dock) return; // markup not present — nothing to do

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

  function todayKey(){ return new Date().toISOString().slice(0,10); }
  function done(){ try { return JSON.parse(localStorage.getItem('daily-done-'+todayKey())||'[]'); } catch(e){ return []; } }
  function saveDone(a){ try { localStorage.setItem('daily-done-'+todayKey(), JSON.stringify(a)); } catch(e){} }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  // Only allow http(s) links from the agent — never javascript:/data: etc.
  function safeUrl(u){ u=String(u||'').trim(); return /^https?:\/\//i.test(u) ? u : ''; }
  function keyFor(t){ return (t.deal||'')+'|'+(t.task||''); }
  function urg(t){ var u=(t.urgency||'today').toLowerCase(); return (u==='overdue'||u==='soon')?u:'today'; }

  var GROUPS = [
    { id:'overdue', label:'Overdue', urgent:true },
    { id:'today',   label:'Today',   urgent:false },
    { id:'soon',    label:'Soon',    urgent:false }
  ];

  // dot color per matter, derived deterministically so the same deal keeps its color
  var DOTS = ['#15161a','#7a6f5a','#4a6b8a','#8a5a6b','#5a7a6b','#8a7a4a','#6b5a8a'];
  function dotFor(deal){ var s=String(deal||''); var h=0; for(var i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))>>>0; } return DOTS[h%DOTS.length]; }

  function counts(){
    var d=done(), total=tasks.length, doneN=0;
    tasks.forEach(function(t){ if(d.indexOf(keyFor(t))!==-1) doneN++; });
    var overdueOpen=tasks.filter(function(t){ return urg(t)==='overdue' && d.indexOf(keyFor(t))===-1; }).length;
    return { total:total, done:doneN, open:total-doneN, overdueOpen:overdueOpen };
  }

  // ordered list of OPEN tasks by priority; used to pick the single "Next" item
  function openOrdered(){
    var d=done(), order={overdue:0,today:1,soon:2}, out=[];
    tasks.forEach(function(t){ if(d.indexOf(keyFor(t))===-1) out.push(t); });
    out.sort(function(a,b){ return (order[urg(a)]||1)-(order[urg(b)]||1); });
    return out;
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
    var k=keyFor(t), isDone=done().indexOf(k)!==-1;
    var cls='dl-row'+(isDone?' done':'')+(opts.full?' dl-frow':'');
    var check='<span class="dl-cbx" role="checkbox" aria-checked="'+(isDone?'true':'false')+'" tabindex="0">'+
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="#fff" d="M10 2.5 4.5 9 1.5 6l1-1 2 2 4.5-5.5z"/></svg></span>';
    var html='<div class="'+cls+'" data-key="'+esc(k)+'">'+check+
      '<div class="dl-main"><div class="dl-title">'+esc(t.task||'(task)')+'</div>'+
      '<div class="dl-sub">'+metaBits(t)+'</div></div></div>';
    if(opts.full){
      var why = t.why ? '<b>Why:</b> '+esc(t.why) : 'No extra detail.';
      var url = safeUrl(t.url);
      var open = url ? '<a href="'+esc(url)+'" target="_blank" rel="noopener">Open ↗</a>' : '';
      html += '<div class="dl-detail" data-detail="'+esc(k)+'">'+why+
        '<div class="dl-acts">'+open+'</div></div>';
    }
    return html;
  }

  function renderDock(){
    var c=counts();
    if(!tasks.length){
      body.innerHTML='<div class="dl-empty">Nothing on your plate today.</div>';
    } else if(c.open===0){
      body.innerHTML='<div class="dl-clear"><div class="dl-clear-ring">✓</div>'+
        '<div class="dl-clear-t">All clear for today</div>'+
        '<div class="dl-clear-s">'+c.done+' completed</div></div>';
    } else {
      var d=done(), open=openOrdered(), next=open[0], nextKey=next?keyFor(next):null, html='';
      if(next){ html+='<div class="dl-kick">Next</div><div class="dl-next">'+rowHtml(next)+'</div>'; }
      GROUPS.forEach(function(g){
        var list=tasks.filter(function(t){ return urg(t)===g.id && keyFor(t)!==nextKey; });
        var openL=list.filter(function(t){ return d.indexOf(keyFor(t))===-1; });
        var doneL=list.filter(function(t){ return d.indexOf(keyFor(t))!==-1; });
        var ordered=openL.concat(doneL);
        if(!ordered.length) return;
        html+='<div class="dl-kick'+(g.urgent?' od':'')+'">'+esc(g.label)+' <span class="dl-cnt">'+openL.length+'</span></div>';
        ordered.forEach(function(t){ html+=rowHtml(t); });
      });
      body.innerHTML=html;
    }
    updateMeta(c);
    wire(body,false);
  }

  function renderFull(){
    var c=counts(), d=done(), html='';
    var open=openOrdered(), next=open[0], nextKey=next?keyFor(next):null;
    if(!tasks.length){
      html='<div class="dl-empty">Nothing on your plate today.</div>';
    } else {
      if(next){ html+='<div class="dl-kick">Next</div><div class="dl-next">'+rowHtml(next,{full:true})+'</div>'; }
      GROUPS.forEach(function(g){
        var list=tasks.filter(function(t){ return urg(t)===g.id && keyFor(t)!==nextKey; });
        var openL=list.filter(function(t){ return d.indexOf(keyFor(t))===-1; });
        var doneL=list.filter(function(t){ return d.indexOf(keyFor(t))!==-1; });
        var ordered=openL.concat(doneL);
        if(!ordered.length) return;
        html+='<div class="dl-kick'+(g.urgent?' od':'')+'">'+esc(g.label)+' <span class="dl-cnt">'+openL.length+'</span></div>';
        ordered.forEach(function(t){ html+=rowHtml(t,{full:true}); });
      });
    }
    fullBody.innerHTML=html;
    fullMeta.innerHTML='<b>'+c.done+' of '+c.total+'</b> done today'+
      (c.overdueOpen>0?' · <span class="dl-odflag">'+c.overdueOpen+' overdue</span>':'');
    wire(fullBody,true);
  }

  function updateMeta(c){
    var pct = c.total? Math.round(c.done/c.total*100) : 0;
    if(ring) ring.style.setProperty('--p', pct);
    if(ringTxt) ringTxt.textContent = c.done+'/'+c.total;
    if(progTxt) progTxt.innerHTML = '<b>'+c.done+' of '+c.total+'</b> done';
    if(odTxt) odTxt.style.display = c.overdueOpen>0 ? 'inline' : 'none';
    if(odTxt) odTxt.textContent = c.overdueOpen+' overdue';
    if(railBadge){ railBadge.textContent=c.open; railBadge.style.display=c.open>0?'inline-flex':'none'; }
  }

  // toggle completion for a key, persist, and refresh both views' counts/state
  function toggle(k){
    var a=done(), i=a.indexOf(k);
    if(i===-1) a.push(k); else a.splice(i,1);
    saveDone(a);
    renderDock();
    if(full.classList.contains('open')) renderFull();
  }

  function wire(root, isFull){
    root.querySelectorAll('.dl-row, .dl-frow').forEach(function(el){
      var row = el; // the row div
      row.addEventListener('click', function(e){
        var k=row.getAttribute('data-key');
        if(e.target.closest('.dl-cbx')){ toggle(k); e.stopPropagation(); return; }
        if(e.target.closest('a')) return;
        if(isFull){
          var det=fullBody.querySelector('[data-detail="'+cssEsc(k)+'"]');
          if(det){ det.classList.toggle('open'); }
        } else {
          openFull(); // compact rows open the full view for detail
        }
      });
      var cbx=row.querySelector('.dl-cbx');
      if(cbx){ cbx.addEventListener('keydown', function(e){ if(e.key===' '||e.key==='Enter'){ e.preventDefault(); toggle(row.getAttribute('data-key')); } }); }
    });
  }
  function cssEsc(s){ return String(s).replace(/["\\\]]/g,'\\$&'); }

  // --- data load: same SSE-reading logic as before -------------------------
  function extract(t){ if(!t) return null; var m=t.match(/\[[\s\S]*\]/); if(!m) return null; try { return JSON.parse(m[0]); } catch(e){ return null; } }
  function setLoading(msg){ body.innerHTML='<div class="dl-loading">'+esc(msg)+'</div>'; }
  function load(){
    setLoading('Reading your day…');
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
        tasks=parsed; loaded=true; renderDock();
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

  // date label
  var dateEl=document.getElementById('daily-date');
  if(dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});

  // Show the dock only while the portal is visible (after login); auto-load once.
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
