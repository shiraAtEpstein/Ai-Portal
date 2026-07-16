// i18n.js — English/Hebrew UI strings + RTL toggle.
(function () {
  var HE = {
    subtitle:'מאובטח · חסוי', newChatBtn:'+ צ׳אט חדש', recentChats:'צ׳אטים אחרונים',
    activityLog:'📋 יומן פעילות', manageUsers:'⚙ ניהול משתמשים', signOut:'התנתקות',
    welcomeTitle:'התחלת צ׳אט חדש',
    welcomeBody:'לחצו על "צ׳אט חדש", בחרו סוכן למעלה והקלידו את ההודעה. הצ׳אטים הקודמים שלכם נמצאים מימין.',
    headerName:'צ׳אט חדש', headerDesc:'בחרו סוכן כדי להתחיל', chooseAgent:'בחירת סוכן…',
    agentHint:'התשובות מגיעות מהסוכן שנבחר — אפשר להחליף בכל רגע.',
    messagePlaceholder:'כתבו הודעה…', inputHint:'Enter לשליחה · Shift+Enter לשורה חדשה',
    mu_title:'⚙ ניהול משתמשים', mu_sub:'הזמינו צוות, הגדירו הרשאות ונהלו גישה.',
    mu_invite:'+ הזמנת משתמש חדש', backPortal:'← חזרה לפורטל', mu_allUsers:'כל המשתמשים',
    th_name:'שם', th_email:'אימייל', th_status:'סטטוס', th_roles:'הרשאות', th_actions:'פעולות',
    al_title:'יומן פעילות', al_sub:'תיעוד של מי עשה מה, ומתי.', al_refresh:'רענון',
    al_allActions:'כל הפעולות', al_clear:'ניקוי', al_export:'ייצוא CSV',
    aw_when:'מתי', aw_who:'מי', aw_action:'פעולה', aw_on:'על', aw_details:'פרטים',
    im_title:'הזמנת משתמש חדש', im_email:'אימייל (חייב להיות @epsteinlaw.co.il)',
    im_name:'שם', im_roles:'הרשאות', im_send:'שליחת הזמנה'
  };
  var HE_AGENTS = {
    copywriter:{name:'כותב תוכן', description:'יוצר ניוזלטרים, פוסטים ותוכן מקצועי'},
    researcher:{name:'עוזר מחקר', description:'חוקר נושאים, מגמות ומידע רקע'},
    paralegal:{name:'עוזר משפטי', description:'מסייע בהכנת תיקים, מועדים ומסמכים'},
    document_review:{name:'בדיקת מסמכים', description:'בודק חוזים ומסמכים משפטיים לאיתור נקודות מפתח'},
    legal_research:{name:'מחקר משפטי', description:'חוקר פסיקה, חקיקה ותקדימים משפטיים'},
    client_intake:{name:'קליטת לקוחות', description:'אוסף מידע ראשוני מלקוחות ומתעד פרטי תיק'},
    gmail:{name:'עוזר אימייל', description:'עוזר לקריאת אימייל בלבד שקורא את תיבת הדואר שלך ועונה על שאלות לגביה'}
  };
  var EN = {};
  var currentLang = 'en';
  function captureEnglish(){
    document.querySelectorAll('[data-i18n]').forEach(function(el){var k=el.getAttribute('data-i18n'); if(EN[k]==null) EN[k]=el.textContent;});
    document.querySelectorAll('[data-i18n-ph]').forEach(function(el){var k=el.getAttribute('data-i18n-ph'); if(EN[k]==null) EN[k]=el.getAttribute('placeholder');});
  }
  function translateAgents(lang){
    try {
      if (typeof agentsById === 'undefined' || !agentsById) return;
      Object.keys(agentsById).forEach(function(id){
        var a = agentsById[id]; if(!a) return;
        if(!a._en) a._en = { name:a.name, description:a.description };
        if(lang==='he' && HE_AGENTS[id]){ a.name=HE_AGENTS[id].name; a.description=HE_AGENTS[id].description; }
        else { a.name=a._en.name; a.description=a._en.description; }
      });
      var sel=document.getElementById('agent-select');
      if(sel){ Array.prototype.forEach.call(sel.options,function(o){
        if(!o.value){ o.textContent = (lang==='he'?HE.chooseAgent:(EN.chooseAgent||'Choose an agent…')); return; }
        var a=agentsById[o.value]; if(!a) return;
        var icon=''; try{ icon=(agentIcons[o.value]||agentIcons.default)||''; }catch(e){}
        o.textContent = icon + '  ' + a.name;
      }); }
      if(typeof applyAgentChoice==='function' && typeof currentAgent!=='undefined' && currentAgent){
        applyAgentChoice(currentAgent);
        if(lang==='he'){ var inp=document.getElementById('message-input'); var a2=agentsById[currentAgent];
          if(inp&&a2) inp.placeholder='כתבו הודעה ל' + a2.name + '…'; }
      }
    } catch(e){}
  }
  function apply(lang){
    if(lang!=='he' && lang!=='en') lang='en';
    currentLang = lang;
    var dict = lang==='he'?HE:EN;
    document.querySelectorAll('[data-i18n]').forEach(function(el){var k=el.getAttribute('data-i18n');if(dict[k]!=null)el.textContent=dict[k];});
    document.querySelectorAll('[data-i18n-ph]').forEach(function(el){var k=el.getAttribute('data-i18n-ph');if(dict[k]!=null)el.setAttribute('placeholder',dict[k]);});
    var dir = lang==='he'?'rtl':'ltr';
    ['portal','admin-screen','audit-screen','invite-modal'].forEach(function(idv){var el=document.getElementById(idv);if(el)el.setAttribute('dir',dir);});
    document.querySelectorAll('.lang-btn').forEach(function(b){b.classList.toggle('active',b.getAttribute('data-lang')===lang);});
    translateAgents(lang);
    try{localStorage.setItem('portalLang',lang);}catch(e){}
  }
  // Let other scripts (e.g. boot.js, after reading the saved Settings preference)
  // drive the portal language. Applies immediately and persists the choice.
  window.setPortalLang = apply;
  function init(){
    captureEnglish();
    var saved='en'; try{saved=localStorage.getItem('portalLang')||'en';}catch(e){}
    apply(saved);
    document.querySelectorAll('.lang-btn').forEach(function(b){b.addEventListener('click',function(){apply(b.getAttribute('data-lang'));});});
    var sel=document.getElementById('agent-select');
    if(sel && window.MutationObserver){ new MutationObserver(function(){ translateAgents(currentLang); }).observe(sel,{childList:true}); }
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init);}else{init();}
})();
