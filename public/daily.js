// daily.js — 'My Daily' floating task panel + bfcache reload guard.
(function () {
  var fab = document.getElementById('daily-fab'), panel = document.getElementById('daily-panel');
  var body = document.getElementById('daily-body'), badge = document.getElementById('daily-badge');
  var portal = document.getElementById('portal'), loaded = false;
  function todayKey(){ return new Date().toISOString().slice(0,10); }
  function done(){ try { return JSON.parse(localStorage.getItem('daily-done-'+todayKey())||'[]'); } catch(e){ return []; } }
  function saveDone(a){ localStorage.setItem('daily-done-'+todayKey(), JSON.stringify(a)); }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function sync(){ var on = portal && getComputedStyle(portal).display !== 'none'; fab.style.display = on ? 'flex':'none'; if(!on) panel.classList.remove('open'); }
  if (portal) { new MutationObserver(sync).observe(portal, { attributes:true, attributeFilter:['style'] }); }
  sync();
  document.getElementById('daily-date').textContent = new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
  function render(tasks){
    var d = done(), groups = { overdue:[], today:[], soon:[] };
    (tasks||[]).forEach(function(t){ var u=(t.urgency||'today').toLowerCase(); if(!groups[u]) u='today'; groups[u].push(t); });
    var order=[['overdue','Overdue / urgent',true],['today','Today',false],['soon','Soon',false]], html='', open=0;
    order.forEach(function(g){ var list=groups[g[0]]; if(!list.length) return;
      html+='<div class="d-group'+(g[2]?' urgent':'')+'">'+esc(g[1])+'</div>';
      list.forEach(function(t){ var key=(t.deal||'')+'|'+(t.task||''); var isDone=d.indexOf(key)!==-1; if(!isDone) open++;
        var meta=[]; if(t.deal) meta.push(esc(t.deal)); if(t.why) meta.push(esc(t.why)); var m=meta.join(' · ');
        if(t.url) m+=(m?' · ':'')+'<a href="'+esc(t.url)+'" target="_blank" rel="noopener">open</a>';
        html+='<label class="d-item'+(isDone?' done':'')+'"><input type="checkbox" data-key="'+esc(key)+'"'+(isDone?' checked':'')+'>'+
          '<div style="min-width:0;flex:1"><div class="d-task">'+esc(t.task||'(task)')+'</div>'+(m?'<div class="d-meta">'+m+'</div>':'')+'</div></label>';
      });
    });
    if(!html) html='<div class="d-empty">Nothing on your plate today. 🎉</div>';
    body.innerHTML=html; badge.textContent=open; badge.style.display=open>0?'flex':'none';
    body.querySelectorAll('input[type="checkbox"]').forEach(function(cb){ cb.addEventListener('change', function(){
      var a=done(), k=cb.getAttribute('data-key'), i=a.indexOf(k);
      if(cb.checked&&i===-1) a.push(k); if(!cb.checked&&i!==-1) a.splice(i,1); saveDone(a);
      cb.closest('.d-item').classList.toggle('done', cb.checked);
      var o=body.querySelectorAll('input:not(:checked)').length; badge.textContent=o; badge.style.display=o>0?'flex':'none';
    }); });
  }
  function extract(t){ if(!t) return null; var m=t.match(/\[[\s\S]*\]/); if(!m) return null; try { return JSON.parse(m[0]); } catch(e){ return null; } }
  function load(){
    body.innerHTML='<div class="d-loading">Reading your monday deals…</div>';
    fetch('/api/chat',{ method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ agentId:'daily', message:'Give me my tasks for today. Respond with ONLY a JSON array (no prose, no code fence). Each element: {"task": string, "deal": string, "why": string, "url": string, "urgency": "overdue"|"today"|"soon"}.' }) })
      .then(async function(r){
        if(!r.ok){ var e={}; try{ e=await r.json(); }catch(_){} body.innerHTML='<div class="d-empty">'+esc((e&&e.error)||'Could not load your daily right now.')+'</div>'; return; }
        // /api/chat streams Server-Sent Events, not JSON. Read the stream and
        // collect the final answer, then pull the JSON task array out of it.
        var reader=r.body.getReader(), dec=new TextDecoder(), buf='', answer='', finalResp=null;
        while(true){ var chunk=await reader.read(); if(chunk.done) break; buf+=dec.decode(chunk.value,{stream:true});
          var nl; while((nl=buf.indexOf('\n\n'))>=0){ var frame=buf.slice(0,nl); buf=buf.slice(nl+2);
            var line=frame.split('\n').find(function(l){ return l.indexOf('data:')===0; }); if(!line) continue;
            var evt; try{ evt=JSON.parse(line.slice(5).trim()); }catch(_){ continue; }
            if(evt.type==='token') answer+=evt.text;
            else if(evt.type==='done') finalResp=(evt.response||answer);
            else if(evt.type==='error'){ body.innerHTML='<div class="d-empty">'+esc(evt.error||'Something went wrong.')+'</div>'; return; }
          }
        }
        var tasks=extract(finalResp||answer);
        if(!tasks){ body.innerHTML='<div class="d-empty">Couldn\'t read a task list yet. Open the My Daily chat agent to check.</div>'; return; }
        loaded=true; render(tasks);
      })
      .catch(function(){ body.innerHTML='<div class="d-empty">Could not load your daily right now.</div>'; });
  }
  fab.addEventListener('click', function(){ var willOpen=!panel.classList.contains('open'); panel.classList.toggle('open', willOpen); if(willOpen&&!loaded) load(); });
  document.getElementById('daily-close').addEventListener('click', function(){ panel.classList.remove('open'); });
  document.getElementById('daily-refresh').addEventListener('click', load);
})();

// bfcache: force a fresh load when navigating back to the portal.
window.addEventListener('pageshow', function (e) { if (e.persisted) { location.reload(); } });
