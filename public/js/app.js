
// ══════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════
let sessionToken   = null;
let currentAgent   = null;
let conversationHistory = [];
let conversationId = null;
let agentsById = {};
let isLoading      = false;

const agentIcons = {
  copywriter:      '✍️',
  researcher:      '🔍',
  paralegal:       '📋',
  document_review: '📄',
  legal_research:  '⚖️',
  client_intake:   '🤝',
  default:         '🤖',
};

// ══════════════════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════════════════
document.getElementById('login-btn').addEventListener('click', login);
document.getElementById('email-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});
document.getElementById('password-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') login();
});

async function login() {
  const code  = document.getElementById('email-input').value.trim();
  const pass  = document.getElementById('password-input').value;
  const btn   = document.getElementById('login-btn');
  const error = document.getElementById('login-error');

  if (!code || !pass) return;

  btn.disabled    = true;
  btn.textContent = 'Signing in…';
  error.style.display = 'none';

  try {
    const res  = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: code, password: pass }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Login failed');

    sessionToken = data.token;
    showPortal(data.name, data.role);
    loadAgents();

  } catch (err) {
    error.textContent    = err.message;
    error.style.display  = 'block';
    btn.disabled         = false;
    btn.textContent      = 'Sign In →';
  }
}

// ══════════════════════════════════════════════════════════
//  SHOW PORTAL
// ══════════════════════════════════════════════════════════
function showPortal(name, role) {
  document.getElementById('login-screen').style.display = 'none';
  document.body.style.alignItems    = 'stretch';
  document.body.style.justifyContent = 'stretch';
  const portal = document.getElementById('portal');
  portal.style.display = 'flex';

  document.getElementById('user-name').textContent   = name;
  document.getElementById('user-role').textContent   = (role || '').split(',').filter(Boolean).join(', ');
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();


  // Show the "Manage Users" button only if this person is an admin.
  const roleList = (role || '').split(/[,\s]+/).map(r => r.trim().toLowerCase()).filter(Boolean);
  const isAdmin = roleList.includes('admin');
  document.getElementById('admin-open-btn').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('activity-open-btn').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('marketing-open-btn').style.display = isAdmin ? 'block' : 'none';
}

// ══════════════════════════════════════════════════════════
//  LOAD AGENTS
// ══════════════════════════════════════════════════════════
async function loadAgents() {
  try {
    const res  = await fetch('/api/agents', { headers: authHeader() });
    const data = await res.json();
    agentsById = {};
    const sel = document.getElementById('agent-select');
    sel.innerHTML = '<option value="">Choose an agent…</option>';
    (data.agents || []).forEach(function (agent) {
      agentsById[agent.id] = agent;
      const o = document.createElement('option');
      o.value = agent.id;
      o.textContent = (agentIcons[agent.id] || agentIcons.default) + '  ' + agent.name;
      sel.appendChild(o);
    });
  } catch (err) {
    console.error('Failed to load agents:', err);
  }
}

function fmtConvTime(ts) {
  try {
    const d = new Date(ts), now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString();
  } catch (e) { return ''; }
}

function newChat() {
  conversationId = null;
  conversationHistory = [];
  currentAgent = null;
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  document.querySelectorAll('#conversation-list .agent-btn.active').forEach(function (b) { b.classList.remove('active'); });
  const sel = document.getElementById('agent-select');
  sel.disabled = false; sel.value = '';
  const nrow = document.getElementById('input-row'); if (nrow) nrow.style.borderColor = '';
  document.getElementById('message-input').placeholder = 'Choose an agent to begin…';
  document.getElementById('header-icon').textContent = '🤖';
  document.getElementById('header-name').textContent = 'New chat';
  document.getElementById('header-desc').textContent = 'Pick an agent to begin';
  document.getElementById('no-agent').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';
  document.getElementById('messages').innerHTML = '';
  updateLawlyGreet();
  toggleHero();
  const inp = document.getElementById('message-input'); if (inp) inp.focus();
}

// ══════════════════════════════════════════════════════════
//  LAWLY HOME — hero toggle + time-of-day greeting
// ══════════════════════════════════════════════════════════
// Show the hero block whenever the message list is empty; hide it as soon as
// a message exists or a conversation is opened.
function toggleHero() {
  const hero = document.getElementById('lawly-hero');
  const msgs = document.getElementById('messages');
  const view = document.getElementById('chat-view');
  if (!hero || !msgs) return;
  const hasMsgs = !!msgs.querySelector('.message');
  hero.classList.toggle('hidden', hasMsgs);
  // When the hero is showing, collapse the (empty) message list so the hero
  // owns the full body area; restore it as soon as messages exist.
  if (view) view.classList.toggle('hero-on', !hasMsgs);
}
function updateLawlyGreet() {
  const el = document.getElementById('lawly-greet');
  if (!el) return;
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : (h < 18 ? 'Good afternoon' : 'Good evening');
  const full = (document.getElementById('user-name') || {}).textContent || '';
  const first = String(full).trim().split(/\s+/)[0] || '';
  el.textContent = first ? (part + ', ' + first + '.') : (part + '.');
}

async function loadConversations() {
  try {
    const res = await fetch('/api/conversations', { headers: authHeader() });
    if (!res.ok) return;
    const data = await res.json();
    const list = document.getElementById('conversation-list');
    list.innerHTML = '';
    // Group conversations under day headers: Today / Yesterday / Earlier.
    const groups = { today: [], yesterday: [], earlier: [] };
    (data.conversations || []).forEach(function (c) { groups[dayBucket(c.updatedAt)].push(c); });
    const order = [['today', 'Today'], ['yesterday', 'Yesterday'], ['earlier', 'Earlier']];
    order.forEach(function (g) {
      const bucket = groups[g[0]];
      if (!bucket.length) return;
      const head = document.createElement('div');
      head.className = 'grp';
      head.textContent = g[1];
      list.appendChild(head);
      bucket.forEach(function (c) {
        const icon = agentIcons[c.agentId] || agentIcons.default;
        const item = document.createElement('div');
        item.className = 'agent-btn';
        item.dataset.id = c.id;
        item.innerHTML = '<span class="agent-icon">' + icon + '</span>' +
          '<span class="agent-btn-info"><span class="agent-btn-name">' + esc(c.title || 'Chat') + '</span>' +
          '<span class="agent-btn-desc">' + fmtConvTime(c.updatedAt) + '</span></span>' +
          '<span class="conv-del" title="Delete chat" style="margin-left:auto;align-self:center;color:#dc3545;cursor:pointer;font-size:13px;padding:2px 4px;">🗑</span>';
        item.addEventListener('click', function () { openConversation(c.id, item); });
        item.querySelector('.conv-del').addEventListener('click', function (e) { e.stopPropagation(); deleteConversation(c.id); });
        list.appendChild(item);
      });
    });
    // Re-apply any active search filter after re-render.
    filterConversations();
  } catch (err) { console.error('Failed to load conversations:', err); }
}

// Which day bucket a timestamp falls into.
function dayBucket(ts) {
  try {
    const d = new Date(ts); const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startYest = new Date(startToday.getTime() - 86400000);
    if (d >= startToday) return 'today';
    if (d >= startYest) return 'yesterday';
    return 'earlier';
  } catch (e) { return 'earlier'; }
}

// Client-side conversation search: filters items by title, hides empty headers.
function filterConversations() {
  const box = document.getElementById('conversation-search');
  const list = document.getElementById('conversation-list');
  if (!list) return;
  const q = (box && box.value ? box.value : '').trim().toLowerCase();
  const groups = [];
  let cur = null;
  Array.prototype.forEach.call(list.children, function (node) {
    if (node.classList.contains('grp')) { cur = { head: node, shown: 0 }; groups.push(cur); return; }
    if (!node.classList.contains('agent-btn')) return;
    const nameEl = node.querySelector('.agent-btn-name');
    const title = (nameEl ? nameEl.textContent : '').toLowerCase();
    const match = !q || title.indexOf(q) !== -1;
    node.style.display = match ? '' : 'none';
    if (cur && match) cur.shown++;
  });
  groups.forEach(function (g) { g.head.style.display = g.shown ? '' : 'none'; });
}

async function deleteConversation(id) {
  if (!confirm('Delete this chat permanently? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/conversations/' + id, { method: 'DELETE', headers: authHeader() });
    if (res.status === 401) return handleSessionExpired();
    if (!res.ok) return;
    if (conversationId === id) newChat();
    loadConversations();
  } catch (err) { console.error('delete conversation failed:', err); }
}

async function openConversation(id, btn) {
  try {
    const res = await fetch('/api/conversations/' + id, { headers: authHeader() });
    if (res.status === 401) return handleSessionExpired();
    if (!res.ok) return;
    const conv = await res.json();
    conversationId = conv.id;
    try { history.replaceState(null, '', '#c=' + encodeURIComponent(conv.id)); } catch (e) {}
    currentAgent = conv.agentId;
    conversationHistory = (conv.messages || []).map(function (m) { return { role: m.role, content: m.content }; });
    document.querySelectorAll('#conversation-list .agent-btn.active').forEach(function (b) { b.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    const agent = agentsById[conv.agentId];
    const sel = document.getElementById('agent-select');
    sel.value = conv.agentId; sel.disabled = true;
    const row = document.getElementById('input-row'); if (row) row.style.borderColor = agentColors[conv.agentId] || agentColors.default;
    document.getElementById('message-input').placeholder = agent ? ('Message ' + agent.name + '…') : 'Type your message…';
    document.getElementById('header-icon').textContent = agentIcons[conv.agentId] || agentIcons.default;
    document.getElementById('header-name').textContent = agent ? agent.name : (conv.title || 'Chat');
    document.getElementById('header-desc').textContent = agent ? agent.description : '';
    document.getElementById('no-agent').style.display = 'none';
    document.getElementById('chat-view').style.display = 'flex';
    document.getElementById('messages').innerHTML = '';
    (conv.messages || []).forEach(function (m) { appendMessage(m.role, m.content); });
    if (!conv.messages || !conv.messages.length) appendMessage('assistant', 'No messages in this chat yet.');
  } catch (err) { console.error('open conversation failed:', err); }
}

document.getElementById('new-chat-btn').addEventListener('click', newChat);
const agentColors = {
  copywriter: '#C9A227', researcher: '#1A8754', paralegal: '#185FA5',
  document_review: '#7F77DD', legal_research: '#1A2744', client_intake: '#D4537E', default: '#1A2744',
};
function applyAgentChoice(id) {
  currentAgent = id || null;
  const agent = agentsById[id];
  const inp = document.getElementById('message-input');
  const row = document.getElementById('input-row');
  document.getElementById('header-icon').textContent = agentIcons[id] || '🤖';
  document.getElementById('header-name').textContent = agent ? agent.name : 'New chat';
  document.getElementById('header-desc').textContent = agent ? agent.description : 'Pick an agent to begin';
  if (agent) { inp.placeholder = 'Message ' + agent.name + '…'; if (row) row.style.borderColor = agentColors[id] || agentColors.default; }
  else { inp.placeholder = 'Choose an agent to begin…'; if (row) row.style.borderColor = ''; }
}
document.getElementById('agent-select').addEventListener('change', function () { applyAgentChoice(this.value); });

// ══════════════════════════════════════════════════════════
//  SELECT AGENT
// ══════════════════════════════════════════════════════════
function selectAgent(agent, icon, btn) {
  // Update active button
  document.querySelectorAll('.agent-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  currentAgent = agent.id;
  try { history.replaceState(null, '', '#agent=' + encodeURIComponent(agent.id)); } catch (e) {}
  conversationHistory = [];

  // Update header
  document.getElementById('header-icon').textContent = icon;
  document.getElementById('header-name').textContent = agent.name;
  document.getElementById('header-desc').textContent = agent.description;

  // Show chat view
  document.getElementById('no-agent').style.display  = 'none';
  const cv = document.getElementById('chat-view');
  cv.style.display = 'flex';

  // Clear messages and show greeting
  const msgs = document.getElementById('messages');
  msgs.innerHTML = '';
  appendMessage('assistant', `Hello! I'm the **${agent.name}**. ${agent.description}. How can I help you today?`);

  document.getElementById('message-input').focus();
}

// ══════════════════════════════════════════════════════════
//  SEND MESSAGE
// ══════════════════════════════════════════════════════════
document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('message-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Auto-grow textarea
  setTimeout(() => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
  }, 0);
});

// Agent-personality "thinking" scripts (EN + HE). Used as an instant fallback until
// the server streams real stage labels; keyed by agent id, falls back to default.
const THINK_SCRIPTS = {
  default: {
    en: ['Understanding your request','Planning the best approach','Reviewing relevant knowledge','Analysing the details','Composing your answer','Final review'],
    he: ['מנתח את הבקשה','בונה את הגישה הטובה','סוקר מידע רלוונטי','מעבד את הפרטים','מנסח את התשובה','בדיקה אחרונה']
  },
  legal_research: {
    en: ['Understanding your question','Reviewing the legal context','Checking relevant sources','Structuring the analysis','Composing your answer','Final review'],
    he: ['מבין את השאלה','בוחן את ההקשר המשפטי','בודק מקורות רלוונטיים','בונה את הניתוח','מנסח את התשובה','בדיקה אחרונה']
  },
  paralegal: {
    en: ['Understanding your request','Organising the details','Checking the file','Preparing a structured response','Composing your answer','Final review'],
    he: ['מבין את הבקשה','מסדר את הפרטים','בודק את התיק','מכין תשובה מסודרת','מנסח את התשובה','בדיקה אחרונה']
  },
  document_review: {
    en: ['Reading the document','Identifying key clauses','Cross-checking the details','Flagging what matters','Composing your answer','Final review'],
    he: ['קורא את המסמך','מזהה סעיפים מרכזיים','מצליב את הפרטים','מסמן את העיקר','מנסח את התשובה','בדיקה אחרונה']
  },
  client_intake: {
    en: ['Understanding your request','Reviewing the client details','Organising the information','Preparing next steps','Composing your answer','Final review'],
    he: ['מבין את הבקשה','סוקר את פרטי הלקוח','מארגן את המידע','מכין את השלבים הבאים','מנסח את התשובה','בדיקה אחרונה']
  },
  researcher: {
    en: ['Understanding your request','Searching relevant knowledge','Gathering the details','Analysing the information','Composing your answer','Final review'],
    he: ['מבין את הבקשה','מחפש מידע רלוונטי','אוסף את הפרטים','מנתח את המידע','מנסח את התשובה','בדיקה אחרונה']
  },
  copywriter: {
    en: ['Understanding your brief','Shaping the angle','Drafting the message','Refining the wording','Polishing the copy','Final review'],
    he: ['מבין את הבריף','מגבש את הזווית','מנסח טיוטה','מלטש את הניסוח','משכלל את הטקסט','בדיקה אחרונה']
  }
};

function thinkLang() {
  try { var l = localStorage.getItem('portalLang'); if (l) return l === 'he' ? 'he' : 'en'; } catch (e) {}
  var p = document.getElementById('portal');
  return (p && p.getAttribute('dir') === 'rtl') ? 'he' : 'en';
}

// Premium "thinking" card. Shows a glowing core + shimmer immediately, an instant
// localized fallback stage, then hands over to real server stages via setStage().
// Accumulates completed stages as a checked trail and reveals helpful actions past 50s.
// Returns { setStage(label), done() }. Call done() when the answer starts or on error.
function startThinking(wrapper) {
  const lang   = thinkLang();
  const script = ((THINK_SCRIPTS[currentAgent] || THINK_SCRIPTS.default)[lang]) || THINK_SCRIPTS.default.en;
  const COPY = {
    en: { longer: 'This is taking a little longer than usual — still working on it.', notify: 'You can keep this open; your answer will appear here as soon as it’s ready.', another: 'Start another chat' },
    he: { longer: 'זה לוקח קצת יותר זמן מהרגיל — עדיין עובד על זה.', notify: 'אפשר להשאיר את החלון פתוח; התשובה תופיע כאן ברגע שתהיה מוכנה.', another: 'התחילו צ׳אט נוסף' }
  }[lang];

  wrapper.classList.add('thinking');
  const bubble = wrapper.querySelector('.msg-bubble');
  const card = document.createElement('div');
  card.className = 'think-card';
  card.setAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  card.innerHTML =
    '<div class="think-head"><span class="think-status" role="status" aria-live="polite"></span></div>' +
    '<div class="think-steps" aria-hidden="true"></div>' +
    '<div class="think-bar"><span></span></div>' +
    '<div class="think-actions" hidden></div>';
  bubble.parentNode.insertBefore(card, bubble);

  const statusEl  = card.querySelector('.think-status');
  const stepsEl   = card.querySelector('.think-steps');
  const actionsEl = card.querySelector('.think-actions');
  const msgs = document.getElementById('messages');
  const start = Date.now();
  let scripted = -1, serverDriven = false, finished = false, answering = false;
  const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };

  function setStatus(txt) { statusEl.textContent = txt; statusEl.style.animation = 'none'; void statusEl.offsetWidth; statusEl.style.animation = ''; }
  function addDoneStep(txt) {
    if (!txt) return;
    const el = document.createElement('div'); el.className = 'think-step';
    el.innerHTML = '<span class="tk-ic"></span><span></span>'; el.lastChild.textContent = txt;
    stepsEl.appendChild(el);
    while (stepsEl.children.length > 3) stepsEl.removeChild(stepsEl.firstChild);
  }
  function showActions() {
    if (!actionsEl.hasAttribute('hidden')) return;
    actionsEl.removeAttribute('hidden');
    const note = document.createElement('div'); note.className = 'tk-note';
    note.textContent = COPY.longer; note.appendChild(document.createElement('br')); note.appendChild(document.createTextNode(COPY.notify));
    const btns = document.createElement('div'); btns.className = 'tk-btns';
    const b = document.createElement('button'); b.type = 'button'; b.textContent = COPY.another;
    b.addEventListener('click', function () { if (typeof newChat === 'function') newChat(); });
    btns.appendChild(b); actionsEl.appendChild(note); actionsEl.appendChild(btns); scroll();
  }

  const tick = setInterval(function () {
    if (finished || !document.body.contains(card)) { clearInterval(tick); return; }
    const t = (Date.now() - start) / 1000;
    if (!serverDriven && !answering) {
      let target;
      if (t < 2) target = -1; else if (t < 6) target = 0; else target = Math.min(script.length - 2, 1 + Math.floor((t - 6) / 5));
      if (t >= 50) target = script.length - 1;
      if (target > scripted) { for (let s = scripted + 1; s <= target; s++) { if (s > 0) addDoneStep(script[s - 1]); setStatus(script[s]); scripted = s; } scroll(); }
    }
    if (t >= 50 && !answering) showActions();
  }, 600);

  return {
    // Answer started streaming: keep the card + live stages, stop the scripted
    // fallback and suppress the "taking longer" nudge.
    answering: function () { answering = true; },
    setStage: function (label) {
      if (finished || !label) return;
      const cur = statusEl.textContent;
      if (!serverDriven) { serverDriven = true; }
      if (cur) addDoneStep(cur);
      setStatus(label);
      scroll();
    },
    done: function () {
      if (finished) return; finished = true;
      clearInterval(tick);
      wrapper.classList.remove('thinking');
      if (card && card.parentNode) card.parentNode.removeChild(card);
    }
  };
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const msg   = input.value.trim();
  if (!msg || isLoading) return;
  if (!currentAgent) { appendMessage('assistant', '⚠️ Please choose an agent at the top first.'); return; }

  isLoading = true;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  appendMessage('user', msg);
  conversationHistory.push({ role: 'user', content: msg });

  // Live assistant bubble + premium "thinking" card above it (driven by real SSE stages).
  const wrapper = appendMessage('assistant', '');
  const bubble  = wrapper.querySelector('.msg-bubble');
  const think   = startThinking(wrapper);
  const scroll  = () => { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; };

  let answer = '';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        agentId: currentAgent,
        message: msg,
        history: conversationHistory.slice(0, -1),
        conversationId: conversationId,
        persist: true,
      }),
    });

    if (!res.ok) {
      if (res.status === 401) { think.done(); return handleSessionExpired(); }
      let e = {}; try { e = await res.json(); } catch (_) {}
      think.done();
      bubble.innerHTML = formatText('⚠️ ' + (e.error || 'Something went wrong.'));
      isLoading = false; document.getElementById('send-btn').disabled = false; input.focus(); return;
    }

    // Read the SSE stream.
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', doneData = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }

        if (evt.type === 'stage') {
          think.setStage(evt.label);
        } else if (evt.type === 'token') {
          think.answering();
          answer += evt.text;
          bubble.innerHTML = formatText(answer);
          scroll();
        } else if (evt.type === 'meta') {
          if (evt.conversationId && !conversationId) conversationId = evt.conversationId;
        } else if (evt.type === 'file') {
          // LAWLY attachment card. Same data (url + filename) and same
          // href/download behavior as before — only the rendering changed.
          // Built with createElement + textContent so the filename is never
          // interpreted as HTML (safer than the previous approach).
          const fname = evt.filename || 'Download file';
          const ext = (fname.indexOf('.') > -1 ? fname.split('.').pop() : '').toUpperCase().slice(0, 4);
          const a = document.createElement('a');
          a.href = evt.url;
          a.className = 'msg-file';
          a.setAttribute('download', evt.filename || '');
          const ic = document.createElement('span'); ic.className = 'mf-ic'; ic.textContent = ext || 'FILE';
          const meta = document.createElement('span'); meta.className = 'mf-meta';
          const nm = document.createElement('span'); nm.className = 'mf-name'; nm.textContent = fname;
          const ty = document.createElement('span'); ty.className = 'mf-type'; ty.textContent = ext ? ext + ' file' : 'File';
          meta.appendChild(nm); meta.appendChild(ty);
          const dl = document.createElement('span'); dl.className = 'mf-dl'; dl.textContent = '↓';
          a.appendChild(ic); a.appendChild(meta); a.appendChild(dl);
          bubble.parentNode.appendChild(a);
          scroll();
        } else if (evt.type === 'done') {
          doneData = evt;
        } else if (evt.type === 'error') {
          bubble.innerHTML = formatText('⚠️ ' + (evt.error || 'Something went wrong.'));
        }
      }
    }

    think.done();
    const finalText = (doneData && doneData.response) || answer;
    if (finalText) {
      bubble.innerHTML = formatText(finalText);
      conversationHistory.push({ role: 'assistant', content: finalText });
    }
    if (doneData && doneData.conversationId && !conversationId) conversationId = doneData.conversationId;
    if (conversationId) { document.getElementById('agent-select').disabled = true; loadConversations(); }
    scroll();
  } catch (err) {
    think.done();
    bubble.innerHTML = formatText('⚠️ Connection error. Please check your network and try again.');
  }

  isLoading = false;
  document.getElementById('send-btn').disabled = false;
  input.focus();
}
// ══════════════════════════════════════════════════════════
//  RENDER MESSAGES
// ══════════════════════════════════════════════════════════
function appendMessage(role, text) {
  const msgs      = document.getElementById('messages');
  const userName  = document.getElementById('user-name').textContent;
  const isUser    = role === 'user';

  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = isUser ? userName.charAt(0).toUpperCase() : '⚖️';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.setAttribute('dir', 'auto');   // per-message bidi: align Hebrew/English independently per message
  bubble.innerHTML = formatText(text);

  wrapper.appendChild(avatar);
  wrapper.appendChild(bubble);
  msgs.appendChild(wrapper);
  msgs.scrollTop = msgs.scrollHeight;
  try { toggleHero(); } catch (e) {}
  return wrapper;
}

// appendTyping() removed — superseded by startThinking() + the SSE streaming flow in sendMessage().

// Very basic markdown: bold, italic, code, line breaks, lists
// Legacy escape-based formatter — kept as a safe fallback if the Markdown
// libraries fail to load (offline / CDN blocked).
function formatTextLegacy(text) {
  return text
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code>$1</code>')
    .replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
    .replace(/^\s*[-•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g,   '<br>')
    .replace(/^(.+)$/s, '<p>$1</p>');
}

// Rich Markdown rendering: marked (GFM — tables, ordered/unordered lists,
// task-lists, fenced code, links, blockquotes) then DOMPurify to stay XSS-safe.
function formatText(text) {
  try {
    if (window.marked && window.DOMPurify) {
      const html = window.marked.parse(String(text), { gfm: true, breaks: true });
      return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
    }
  } catch (e) { /* fall through to the legacy formatter */ }
  return formatTextLegacy(text);
}

// ══════════════════════════════════════════════════════════
//  LOGOUT
// ══════════════════════════════════════════════════════════
document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST', headers: authHeader() });
  } catch {}
  sessionToken = null;
  window.location.replace('/');
});

function handleSessionExpired() {
  alert('Your session has expired. Please sign in again.');
  location.reload();
}

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════
function authHeader() {
  return { 'Authorization': `Bearer ${sessionToken}` };
}

// ══════════════════
//  ADMIN — MANAGE USERS (Day 7)
// ══════════════════
let adminRoles = [];   // role names this admin may assign (from the server)

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Multi-select dropdown (a button that opens a list of checkboxes) ──
function buildDropdown(container, selected) {
  const sel = new Set(selected || []);
  const opts = adminRoles.map(r =>
    `<label class="dropdown-opt"><input type="checkbox" value="${esc(r)}" ${sel.has(r) ? 'checked' : ''}> ${esc(r)}</label>`
  ).join('');
  container.classList.add('dropdown');
  container.innerHTML =
    '<button type="button" class="dropdown-toggle"><span class="dropdown-toggle-text"></span></button>' +
    '<div class="dropdown-menu">' + opts + '</div>';
  container.querySelector('.dropdown-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = container.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) container.classList.add('open');
  });
  container.querySelectorAll('.dropdown-menu input').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => updateDropdownText(container));
  });
  updateDropdownText(container);
}

function updateDropdownText(container) {
  const chosen = Array.from(container.querySelectorAll('input:checked')).map(cb => cb.value);
  const txt = container.querySelector('.dropdown-toggle-text');
  if (chosen.length) { txt.textContent = chosen.join(', '); txt.classList.remove('placeholder'); }
  else { txt.textContent = 'Select roles…'; txt.classList.add('placeholder'); }
}

function dropdownValues(container) {
  return Array.from(container.querySelectorAll('input:checked')).map(cb => cb.value);
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', closeAllDropdowns);

// ── Open / close the admin screen and the invite popup ──
document.getElementById('admin-open-btn').addEventListener('click', openAdmin);
document.getElementById('admin-close-btn').addEventListener('click', () => {
  document.getElementById('admin-screen').style.display = 'none';
  try { history.replaceState(null, '', conversationId ? '#c=' + encodeURIComponent(conversationId) : location.pathname); } catch (e) {}
});
document.getElementById('open-invite-btn').addEventListener('click', openInviteModal);
document.getElementById('invite-modal-close').addEventListener('click', closeInviteModal);
document.getElementById('invite-modal').addEventListener('click', (e) => {
  if (e.target.id === 'invite-modal') closeInviteModal();
});
document.getElementById('invite-btn').addEventListener('click', sendInvite);
document.getElementById('activity-open-btn').addEventListener('click', openAudit);
document.getElementById('audit-close-btn').addEventListener('click', closeAudit);
document.getElementById('audit-refresh-btn').addEventListener('click', loadAudit);
document.getElementById('audit-q').addEventListener('input', renderAudit);
document.getElementById('audit-action').addEventListener('change', renderAudit);
document.getElementById('audit-from').addEventListener('change', renderAudit);
document.getElement('audit-to') ? null : null;
document.getElementById('audit-to').addEventListener('change', renderAudit);
document.getElementById('audit-export').addEventListener('click', exportAudit);
document.getElementById('audit-clear').addEventListener('click', function () {
  document.getElementById('audit-q').value = '';
  document.getElementById('audit-action').value = '';
  document.getElementById('audit-from').value = '';
  document.getElementById('audit-to').value = '';
  renderAudit();
});

function openAdmin() {
  document.getElementById('admin-screen').style.display = 'block';
  try { history.replaceState(null, '', '#admin'); } catch (e) {}
  loadAdminUsers();
}

// ==============================================================
//  MARKETING (admins only) - read-only dashboard
// ==============================================================
document.getElementById('marketing-open-btn').addEventListener('click', openMarketing);
document.getElementById('marketing-close-btn').addEventListener('click', closeMarketing);
document.getElementById('marketing-refresh-btn').addEventListener('click', loadMarketing);

function openMarketing() {
  document.getElementById('marketing-screen').style.display = 'block';
  try { history.replaceState(null, '', '#marketing'); } catch (e) {}
  loadMarketing();
}
function closeMarketing() {
  document.getElementById('marketing-screen').style.display = 'none';
  try { history.replaceState(null, '', conversationId ? '#c=' + encodeURIComponent(conversationId) : location.pathname); } catch (e) {}
}

function mkBadge(status) {
  var colors = {
    draft:    ['#eef1f5', '#5b6b7d'],
    review:   ['#fbf1dc', '#b07d18'],
    approved: ['#e4f3ea', '#1c7a42'],
    scheduled:['#e6edf6', '#3a5da8'],
    published:['#eae7f4', '#6b52a8']
  };
  var c = colors[status] || colors.draft;
  return '<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;background:' + c[0] + ';color:' + c[1] + ';">' + esc(status) + '</span>';
}

async function loadMarketing() {
  var note = document.getElementById('marketing-note');
  var body = document.getElementById('marketing-body');
  note.className = 'admin-note';
  note.textContent = '';
  body.innerHTML = '<p style="color:var(--gray-400);">Loading…</p>';
  try {
    var res = await fetch('/api/marketing', { headers: authHeader() });
    if (res.status === 401) return handleSessionExpired();
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the marketing data.');
    renderMarketing(data);
  } catch (e) {
    body.innerHTML = '';
    note.className = 'admin-note error';
    note.textContent = e.message || 'Could not load the marketing data.';
  }
}

function renderMarketing(d) {
  var body = document.getElementById('marketing-body');
  var td = d.themeDecision || {};
  var plan = d.plan || {};
  var a = d.analytics || {};
  var h = '';

  h += '<div class="admin-card">';
  h += '<h2>Monthly plan · ' + esc(plan.month || td.month || '') + '</h2>';
  if (td.status === 'chosen' && td.chosen) {
    var ch = (td.options || []).find(function (o) { return o.id === td.chosen; }) || {};
    h += '<p style="margin-bottom:14px;">Theme: <strong>' + esc(ch.name || '') + '</strong></p>';
  } else {
    h += '<p style="margin-bottom:12px;color:var(--gray-600);">Theme: awaiting Yaacov’s choice. Options:</p>';
    (td.options || []).forEach(function (o) {
      h += '<div style="border:1px solid var(--gray-200);border-radius:9px;padding:12px 14px;margin-bottom:10px;">'
        + '<div style="font-weight:600;color:var(--navy);">' + esc(o.name) + '</div>'
        + '<div style="font-size:13px;color:var(--gray-600);margin-top:3px;">' + esc(o.focus) + '</div>'
        + '<div style="font-size:12.5px;margin-top:5px;"><strong>Who:</strong> ' + esc(o.audience) + '</div>'
        + '<div style="font-size:12.5px;"><strong>Why it fits:</strong> ' + esc(o.why) + '</div>'
        + '</div>';
    });
  }
  if ((plan.campaigns || []).length) {
    h += '<h2 style="margin-top:18px;">Campaigns</h2><table class="admin-table"><thead><tr><th>Campaign</th><th>Weeks</th><th>Audience</th><th>In plain terms</th></tr></thead><tbody>';
    plan.campaigns.forEach(function (c) {
      h += '<tr><td><strong>' + esc(c.name) + '</strong></td><td>' + esc(c.weeks) + '</td><td>' + esc(c.audience) + '</td><td style="color:var(--gray-600);">' + esc(c.plain) + '</td></tr>';
    });
    h += '</tbody></table>';
  }
  if ((plan.weeks || []).length) {
    h += '<h2 style="margin-top:18px;">Weekly focus</h2><div style="display:flex;flex-wrap:wrap;gap:12px;">';
    plan.weeks.forEach(function (w) {
      h += '<div style="flex:1;min-width:160px;border:1px solid var(--gray-200);border-radius:9px;padding:10px 12px;"><strong>' + esc(w.label) + '</strong><div style="font-size:12.5px;color:var(--gray-600);margin-top:3px;">' + esc(w.focus) + '</div></div>';
    });
    h += '</div>';
  }
  h += '</div>';

  if ((d.content || []).length) {
    h += '<div class="admin-card"><h2>Content</h2><table class="admin-table"><thead><tr><th>Title</th><th>Channel</th><th>Date</th><th>Status</th></tr></thead><tbody>';
    d.content.forEach(function (c, i) {
      h += '<tr class="mk-row" data-mk="' + i + '" style="cursor:pointer;"><td><strong>' + esc(c.title) + '</strong></td><td>' + esc(c.channel) + '</td><td>' + esc(c.date) + '</td><td>' + mkBadge(c.status) + '</td></tr>';
      h += '<tr id="mk-detail-' + i + '" style="display:none;"><td colspan="4" style="background:var(--gray-50);">'
        + '<div style="white-space:pre-wrap;font-size:13px;line-height:1.5;">' + esc(c.body) + '</div>'
        + '<div style="font-size:12.5px;margin-top:8px;"><strong>CTA:</strong> ' + esc(c.cta) + '</div>'
        + (c.note ? '<div style="font-size:12px;color:#b07d18;margin-top:6px;">⚠ ' + esc(c.note) + '</div>' : '')
        + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  if ((a.kpis || []).length) {
    h += '<div class="admin-card"><h2>Analytics · ' + esc(a.period || '') + '</h2>';
    h += '<p style="font-size:12px;color:var(--gray-600);margin-bottom:12px;">Reputation-first, since our leads come from referrals.</p>';
    h += '<div style="display:flex;flex-wrap:wrap;gap:14px;">';
    a.kpis.forEach(function (k) {
      h += '<div style="flex:1;min-width:150px;border:1px solid var(--gray-200);border-radius:10px;padding:14px;">'
        + '<div style="font-size:12px;color:var(--gray-600);">' + (k.star ? '★ ' : '') + esc(k.label) + '</div>'
        + '<div style="font-size:24px;font-weight:700;color:' + (k.star ? '#b07d18' : 'var(--navy)') + ';margin-top:2px;">' + esc(k.value) + '</div>'
        + '<div style="font-size:11px;color:var(--gray-600);margin-top:4px;">' + esc(k.sub || '') + '</div>'
        + '</div>';
    });
    h += '</div>';
    if ((a.reviewsRecent || []).length) {
      h += '<div style="margin-top:16px;">';
      a.reviewsRecent.forEach(function (r) { h += '<div style="font-size:13px;padding:7px 0;border-bottom:1px solid var(--gray-100);">⭐ “' + esc(r) + '”</div>'; });
      h += '</div>';
    }
    if (a.note) h += '<p style="font-size:12px;color:var(--gray-400);margin-top:12px;">' + esc(a.note) + '</p>';
    h += '</div>';
  }

  body.innerHTML = h;
  body.querySelectorAll('.mk-row').forEach(function (row) {
    row.addEventListener('click', function () {
      var i = row.getAttribute('data-mk');
      var det = document.getElementById('mk-detail-' + i);
      if (det) det.style.display = (det.style.display === 'none') ? 'table-row' : 'none';
    });
  });
}

// ── History / audit log (Day 9) ──
const AUDIT_LABELS = {
  'agent.used': 'Used an agent',
  'chat.deleted': 'Deleted a chat',
  'user.invite_resent': 'Resent an invite',
  'auth.login': 'Signed in',
  'auth.login.denied': 'Sign-in denied',
  'auth.login.pending': 'Sign-in (pending invite)',
  'user.invited': 'Invited a user',
  'user.roles_changed': 'Changed roles',
  'user.disabled': 'Disabled a user',
  'user.enabled': 'Enabled a user',
  'user.deleted': 'Deleted a user',
};

function openAudit() {
  document.getElementById('audit-screen').style.display = 'block';
  loadAudit();
}
function closeAudit() {
  document.getElementById('audit-screen').style.display = 'none';
}
function fmtWhen(ts) {
  try { return new Date(ts).toLocaleString(); } catch (e) { return esc(ts); }
}
function fmtDetails(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  for (const k of Object.keys(meta)) {
    if (k === 'actor' || k === 'target') continue;
    let v = meta[k];
    if (Array.isArray(v)) v = v.join(', ');
    else if (v && typeof v === 'object') v = JSON.stringify(v);
    parts.push(esc(k) + ': ' + esc(v));
  }
  return parts.join(' · ');
}

let auditEvents = [];

async function loadAudit() {
  const tbody = document.getElementById('audit-tbody');
  const note = document.getElementById('audit-note');
  note.className = 'admin-note';
  tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400);">Loading…</td></tr>';
  try {
    const res = await fetch('/api/admin/audit?limit=500', { headers: authHeader() });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the history.');
    auditEvents = data.events || [];
    const sel = document.getElementById('audit-action');
    const cur = sel.value;
    const present = Array.from(new Set(auditEvents.map(function (e) { return e.action; })));
    sel.innerHTML = '<option value="">All actions</option>' + present.map(function (a) {
      return '<option value="' + esc(a) + '">' + esc(AUDIT_LABELS[a] || a) + '</option>';
    }).join('');
    sel.value = cur;
    renderAudit();
  } catch (err) {
    tbody.innerHTML = '';
    note.textContent = err.message;
    note.className = 'admin-note err';
  }
}

function filteredAudit() {
  const q = (document.getElementById('audit-q').value || '').trim().toLowerCase();
  const act = document.getElementById('audit-action').value || '';
  const from = document.getElementById('audit-from').value || '';
  const to = document.getElementById('audit-to').value || '';
  const fromT = from ? new Date(from + 'T00:00:00').getTime() : null;
  const toT = to ? new Date(to + 'T23:59:59').getTime() : null;
  return auditEvents.filter(function (e) {
    if (act && e.action !== act) return false;
    const t = new Date(e.ts).getTime();
    if (fromT && t < fromT) return false;
    if (toT && t > toT) return false;
    if (q) {
      const hay = ((e.actorName || '') + ' ' + (e.target || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}

function renderAudit() {
  const tbody = document.getElementById('audit-tbody');
  const rows = filteredAudit();
  document.getElementById('audit-count').textContent = rows.length + ' event' + (rows.length === 1 ? '' : 's');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400);">No matching events.</td></tr>'; return; }
  tbody.innerHTML = rows.map(function (e) {
    const who = e.actorName ? esc(e.actorName) : '<span style="color:var(--gray-400)">system</span>';
    const action = esc(AUDIT_LABELS[e.action] || e.action);
    return '<tr>' +
      '<td style="white-space:nowrap;">' + fmtWhen(e.ts) + '</td>' +
      '<td>' + who + '</td>' +
      '<td>' + action + '</td>' +
      '<td>' + (e.target ? esc(e.target) : '') + '</td>' +
      '<td style="color:var(--gray-600);">' + fmtDetails(e.metadata) + '</td>' +
      '</tr>';
  }).join('');
}

function fmtDetailsPlain(meta) {
  if (!meta || typeof meta !== 'object') return '';
  return Object.keys(meta).filter(function (k) { return k !== 'actor' && k !== 'target'; }).map(function (k) {
    let v = meta[k];
    if (Array.isArray(v)) v = v.join(', ');
    else if (v && typeof v === 'object') v = JSON.stringify(v);
    return k + ': ' + v;
  }).join(' | ');
}

function exportAudit() {
  const rows = filteredAudit();
  const head = ['When', 'Who', 'Action', 'On', 'Details'];
  const cell = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
  const lines = [head.map(cell).join(',')];
  rows.forEach(function (e) {
    lines.push([fmtWhen(e.ts), e.actorName || 'system', (AUDIT_LABELS[e.action] || e.action), e.target || '', fmtDetailsPlain(e.metadata)].map(cell).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'epstein-portal-audit.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function openInviteModal() {
  document.getElementById('invite-email').value = '';
  document.getElementById('invite-name').value = '';
  document.getElementById('invite-note').className = 'admin-note';
  renderInviteRoles();
  document.getElementById('invite-modal').classList.add('open');
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.remove('open');
}

async function loadAdminUsers() {
  const tbody = document.getElementById('users-tbody');
  const note  = document.getElementById('users-note');
  note.className = 'admin-note';
  tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400);">Loading…</td></tr>';
  try {
    const res  = await fetch('/api/admin/all-users', { headers: authHeader() });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load users.');
    adminRoles = data.roles || [];
    renderUsersTable(data.users || []);
  } catch (err) {
    tbody.innerHTML = '';
    note.textContent = err.message;
    note.className = 'admin-note err';
  }
}

// Roles dropdown inside the invite popup.
function renderInviteRoles() {
  buildDropdown(document.getElementById('invite-roles'), []);
}

function renderUsersTable(users) {
  const tbody = document.getElementById('users-tbody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--gray-400);">No users yet.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => {
    const rolesText = (u.roles && u.roles.length) ? u.roles.map(esc).join(', ') : '<span style="color:var(--gray-400)">none</span>';
    const toggle = (u.status === 'disabled')
      ? `<button class="row-btn go" data-act="enable" data-email="${esc(u.email)}">Enable</button>`
      : `<button class="row-btn danger" data-act="disable" data-email="${esc(u.email)}">Disable</button>`;
    return `
      <tr>
        <td>${esc(u.name) || '<span style="color:var(--gray-400)">—</span>'}</td>
        <td>${esc(u.email)}</td>
        <td><span class="status-badge status-${esc(u.status)}">${esc(u.status)}</span></td>
        <td>
          <div>${rolesText}</div>
          <div class="role-editor" data-email="${esc(u.email)}">
            <div class="dropdown" data-roledd="${esc(u.email)}" style="margin-top:8px;"></div>
            <button class="row-btn go" data-act="save-roles" data-email="${esc(u.email)}" style="margin-top:8px;">Save roles</button>
            <button class="row-btn" data-act="cancel-roles" data-email="${esc(u.email)}" style="margin-top:8px;">Cancel</button>
          </div>
        </td>
        <td>
          ${u.status === 'pending' ? '<button class="row-btn" data-act="resend" data-email="' + esc(u.email) + '">Resend</button>' : ''}
          <button class="row-btn" data-act="edit" data-email="${esc(u.email)}">Edit roles</button>
          ${toggle}
          <button class="row-btn danger" data-act="delete" data-email="${esc(u.email)}" title="Delete user" aria-label="Delete user" style="padding:6px 10px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg></button>
        </td>
      </tr>`;
  }).join('');

  // Build a roles dropdown for each row, pre-selected to that user's roles.
  users.forEach(u => {
    const dd = tbody.querySelector('.dropdown[data-roledd="' + CSS.escape(u.email) + '"]');
    if (dd) buildDropdown(dd, u.roles || []);
  });

  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); onRowAction(btn); });
  });
}

function onRowAction(btn) {
  const act = btn.dataset.act;
  const email = btn.dataset.email;
  const editor = document.querySelector('.role-editor[data-email="' + CSS.escape(email) + '"]');
  if (act === 'edit')              { editor.classList.add('open'); }
  else if (act === 'cancel-roles') { editor.classList.remove('open'); }
  else if (act === 'save-roles')   { saveRoles(email, editor); }
  else if (act === 'disable')      { if (confirm('Disable ' + email + '? They will be signed out immediately.')) setStatus(email, 'disable'); }
  else if (act === 'enable')       { setStatus(email, 'enable'); }
  else if (act === 'resend')       { resendInvite(email); }
  else if (act === 'delete')       { deleteUser(email); }
}

async function saveRoles(email, editor) {
  const dd = editor.querySelector('.dropdown[data-roledd]');
  const roles = dropdownValues(dd);
  try {
    const res  = await fetch('/api/admin/set-roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ email, roles }),
    });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not change roles.');
    flash('users-note', 'Roles updated for ' + email + '.', true);
    loadAdminUsers();
  } catch (err) {
    flash('users-note', err.message, false);
  }
}

async function setStatus(email, action) {
  try {
    const res  = await fetch('/api/admin/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ email }),
    });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Action failed.');
    flash('users-note', email + ' is now ' + (action === 'disable' ? 'disabled' : 'active') + '.', true);
    loadAdminUsers();
  } catch (err) {
    flash('users-note', err.message, false);
  }
}

async function deleteUser(email) {
  if (!confirm('Permanently DELETE ' + email + ' from the database? This removes the account entirely and cannot be undone.')) return;
  try {
    const res = await fetch('/api/admin/delete-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ email }),
    });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete the user.');
    flash('users-note', email + ' was permanently deleted.', true);
    loadAdminUsers();
  } catch (err) {
    flash('users-note', err.message, false);
  }
}

async function resendInvite(email) {
  try {
    const res = await fetch('/api/admin/resend-invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ email }) });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not resend the invite.');
    let msg = 'Invite resent to ' + esc(email) + '. ';
    msg += data.emailed ? 'A new invitation email was sent.' : 'Email is off, so share this new link:<br><strong>' + esc(data.inviteLink) + '</strong>';
    flash('users-note', msg, true, true);
    loadAdminUsers();
  } catch (err) {
    flash('users-note', err.message, false);
  }
}

async function sendInvite() {
  const email = document.getElementById('invite-email').value.trim();
  const name  = document.getElementById('invite-name').value.trim();
  const roles = dropdownValues(document.getElementById('invite-roles'));
  const btn   = document.getElementById('invite-btn');
  if (!email) return flash('invite-note', 'Please enter an email address.', false);
  if (!name) return flash('invite-note', 'Please enter a name.', false);

  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res  = await fetch('/api/admin/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ email, name, roles }),
    });
    if (res.status === 401) return handleSessionExpired();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send the invite.');
    let msg = 'Invited ' + esc(email) + (roles.length ? ' as ' + esc(roles.join(', ')) : '') + '. ';
    msg += data.emailed ? 'An invitation email was sent. ' : 'Email was not sent (' + esc(data.emailError || 'unknown') + '). ';
    msg += 'Invite link (share this if needed):<br><strong>' + esc(data.inviteLink) + '</strong>';
    flash('invite-note', msg, true, true);
    loadAdminUsers();
  } catch (err) {
    flash('invite-note', err.message, false);
  } finally {
    btn.disabled = false; btn.textContent = 'Send invite';
  }
}

// Show a small success/error note. allowHtml only for trusted, pre-escaped text.
function flash(id, text, ok, allowHtml) {
  const el = document.getElementById(id);
  if (allowHtml) el.innerHTML = text; else el.textContent = text;
  el.className = 'admin-note ' + (ok ? 'ok' : 'err');
}

// ══ GOOGLE SIGN-IN (Phase 2) ══
document.getElementById('google-login-btn').addEventListener('click', () => {
  window.location.href = '/auth/google/start';
});

// Hide the Google button if the server doesn't have it configured yet.
fetch('/auth/google/status')
  .then(r => r.json())
  .then(d => {
    if (!d.enabled) {
      document.getElementById('google-login-btn').style.display = 'none';
      document.getElementById('google-divider').style.display = 'none';
    }
  })
  .catch(() => {});

// Boot: pick the right screen with no flicker, keep you signed in across a
// refresh (via the session cookie), and reopen the agent you had selected.
function restoreAgentFromUrl() {
  const m = (location.hash || '').match(/agent=([^&]+)/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
  const btn = document.querySelector('.agent-btn[data-id="' + sel + '"]');
  if (btn) btn.click();
}

(function boot() {
  const loader = document.getElementById('boot-loading');
  const hideLoader = () => { if (loader) loader.style.display = 'none'; };
  const showLogin = () => { hideLoader(); document.getElementById('login-screen').style.display = ''; };
  const enterPortal = async (name, roles) => {
    showPortal(name, roles);
    await loadAgents();
    await loadConversations();
    const hash = location.hash || '';
    const convMatch = hash.match(/c=([^&]+)/);
    if (hash.indexOf('admin') !== -1) {
      newChat();
      const adminBtn = document.getElementById('admin-open-btn');
      if (adminBtn && adminBtn.style.display !== 'none') openAdmin();
    } else if (convMatch) {
      const id = decodeURIComponent(convMatch[1]);
      const sel = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
      const item = document.querySelector('#conversation-list .agent-btn[data-id="' + sel + '"]');
      if (item) { await openConversation(id, item); } else { newChat(); if (typeof defaultToLawly === 'function') defaultToLawly(); }
    } else {
      newChat();
      // Open directly on Lawly's empty chat view when Lawly is available.
      if (typeof defaultToLawly === 'function') defaultToLawly();
    }
    hideLoader();
  };

  const params = new URLSearchParams(location.search);
  const authErr = params.get('auth_error');
  if (authErr) {
    history.replaceState(null, '', location.pathname);
    showLogin();
    const error = document.getElementById('login-error');
    if (error) { error.textContent = authErr; error.style.display = 'block'; }
    return;
  }

  if (location.hash && location.hash.indexOf('token=') !== -1) {
    const h = new URLSearchParams(location.hash.slice(1));
    const token = h.get('token');
    if (token) {
      sessionToken = token;
      history.replaceState(null, '', location.pathname);
      enterPortal(h.get('name') || 'User', h.get('roles') || h.get('role') || '');
      return;
    }
  }

  fetch('/api/me')
    .then(res => res.ok ? res.json() : null)
    .then(d => { if (d) enterPortal(d.name || 'User', (d.roles || []).join(', ')); else showLogin(); })
    .catch(showLogin);
})();


/* ===== section: i18n (moved from index.html) ===== */
(function () {
  var HE = {
    subtitle:'מאובטח · חסוי', newChatBtn:'+ צ׳אט חדש', recentChats:'צ׳אטים אחרונים',
    activityLog:'📋 יומן פעילות', manageUsers:'⚙ ניהול משתמשים', signOut:'התנתקות',
    welcomeTitle:'התחלת צ׳אט חדש',
    welcomeBody:'לחצו על "צ׳אט חדש", בחרו סוכן למעלה והקלידו את ההודעה. הצ׳אטים הקודמים שלכם נמצאים מימין.',
    headerName:'צ׳אט חדש', headerDesc:'בחרו סוכן כדי להתחיל', chooseAgent:'בחירת סוכן…',
    messagePlaceholder:'בחרו סוכן כדי להתחיל…', inputHint:'Enter לשליחה · Shift+Enter לשורה חדשה',
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


/* ===== section: gmail-connect (moved from index.html) ===== */
(function () {
  var btn = null, toast = null, statusCache = null;
  function showToast(msg, ok) {
    if (!toast) return;
    toast.textContent = msg;
    toast.className = ok ? 'ok' : 'err';
    toast.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toast.style.display = 'none'; }, 6000);
  }
  function render(status) {
    statusCache = status;
    if (!btn) return;
    if (!btn) return;
    if (status && status.configured === false) { btn.style.display = 'none'; return; }
    btn.style.display = 'block';
    if (status && status.connected) {
      btn.textContent = '✅ Gmail: ' + (status.email || 'connected');
      btn.classList.add('connected');
      btn.title = 'Click to disconnect ' + (status.email || 'your Gmail');
    } else {
      btn.textContent = '🔗 Connect Gmail';
      btn.classList.remove('connected');
      btn.title = 'Connect your Gmail to use the Email Assistant';
    }
  }
  function refresh() {
    return fetch('/api/gmail/status', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s) render(s); return s; })
      .catch(function () {});
  }
  function onClick() {
    if (statusCache && statusCache.connected) {
      if (!window.confirm('Disconnect ' + (statusCache.email || 'your Gmail') +
          '? The Email Assistant will no longer be able to read your mail until you reconnect.')) return;
      fetch('/api/gmail/disconnect', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function () { showToast('Gmail disconnected.', true); refresh(); })
        .catch(function () { showToast('Could not disconnect. Please try again.', false); });
    } else {
      window.location.href = '/api/gmail/connect';
    }
  }
  var MESSAGES = {
    connected:    ['Gmail connected successfully.', true],
    wrongaccount: ['That Google account does not match your portal email. Please connect your own Gmail.', false],
    expired:      ['The connection attempt timed out. Please try again.', false],
    denied:       ['Gmail connection was cancelled.', false],
    noRefresh:    ['Google did not grant lasting access. Please try again and allow access when asked.', false],
    failed:       ['Could not connect Gmail. Please try again.', false]
  };
  function handleReturn() {
    var m = (location.hash || '').match(/gmail=([a-zA-Z]+)/);
    if (!m) return;
    var info = MESSAGES[m[1]];
    if (info) showToast(info[0], info[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }
  function init() {
    btn = document.getElementById('gmail-connect-btn');
    toast = document.getElementById('gmail-toast');
    if (btn) btn.addEventListener('click', onClick);
    handleReturn();
    refresh();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();


/* ===== section: my-daily (moved from index.html) ===== */
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
      .then(function(r){ return r.json(); })
      .then(function(j){ if(j&&j.error){ body.innerHTML='<div class="d-empty">'+esc(j.error)+'</div>'; return; }
        var tasks=extract(j&&j.response); if(!tasks){ body.innerHTML='<div class="d-empty">Couldn\'t read a task list yet. Open the My Daily chat agent to check.</div>'; return; }
        loaded=true; render(tasks); })
      .catch(function(){ body.innerHTML='<div class="d-empty">Could not load your daily right now.</div>'; });
  }
  fab.addEventListener('click', function(){ var willOpen=!panel.classList.contains('open'); panel.classList.toggle('open', willOpen); if(willOpen&&!loaded) load(); });
  document.getElementById('daily-close').addEventListener('click', function(){ panel.classList.remove('open'); });
  document.getElementById('daily-refresh').addEventListener('click', load);
})();


/* ===== section: pageshow-reload (moved from index.html) ===== */
window.addEventListener('pageshow', function (e) { if (e.persisted) { location.reload(); } });


/* ===================================================================
   LAWLY HOME — behavior wiring (default Lawly, search, "/" switcher,
   chips, settings). Routes every agent selection through the SAME code
   path as a manual #agent-select change (set value + applyAgentChoice),
   so no existing behavior is duplicated or bypassed.
   =================================================================== */
(function () {
  // Select an agent exactly like the user picking it from the #agent-select
  // dropdown: set the value and run applyAgentChoice(). Returns true if the
  // agent is available (allowed) to this user.
  function selectAgentById(id) {
    if (!id || !agentsById[id]) return false;
    const sel = document.getElementById('agent-select');
    if (!sel) return false;
    sel.value = id;
    if (sel.value !== id) return false; // option not present → not allowed
    applyAgentChoice(id);
    return true;
  }
  window.selectAgentById = selectAgentById;

  // Default to Lawly whenever a fresh/empty chat is shown, if allowed.
  // Called after loadAgents() + newChat() during boot.
  function defaultToLawly() {
    if (currentAgent) return;                    // a conversation/agent already active
    const msgs = document.getElementById('messages');
    if (msgs && msgs.querySelector('.message')) return; // not an empty view
    selectAgentById('lawly');                    // no-op if lawly isn't available
  }
  window.defaultToLawly = defaultToLawly;

  function init() {
    // ── Conversation search ──
    const search = document.getElementById('conversation-search');
    if (search) {
      search.addEventListener('input', function () { filterConversations(); });
    }
    // Cmd/Ctrl+K focuses search.
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        const s = document.getElementById('conversation-search');
        if (s) { e.preventDefault(); s.focus(); s.select(); }
      }
    });

    // ── Hero chips ──
    document.querySelectorAll('.lawly-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        const id = chip.getAttribute('data-agent');
        const fill = chip.getAttribute('data-fill') || '';
        if (id) selectAgentById(id);             // no-op if not allowed
        const inp = document.getElementById('message-input');
        if (inp) { inp.value = fill; inp.focus(); }
      });
    });

    // ── "/" specialist switcher ──
    const switcher = document.getElementById('agent-switcher');
    const input = document.getElementById('message-input');
    function hideSwitcher() { if (switcher) { switcher.hidden = true; switcher.innerHTML = ''; } }
    function renderSwitcher() {
      if (!switcher || !input) return;
      const val = input.value || '';
      if (val.charAt(0) !== '/') { hideSwitcher(); return; }
      const term = val.slice(1).toLowerCase();
      const ids = Object.keys(agentsById).filter(function (id) {
        if (!term) return true;
        const a = agentsById[id];
        return id.toLowerCase().indexOf(term) !== -1 ||
               (a.name || '').toLowerCase().indexOf(term) !== -1;
      });
      if (!ids.length) { hideSwitcher(); return; }
      switcher.innerHTML = '';
      ids.forEach(function (id) {
        const a = agentsById[id];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lawly-sw-opt';
        const nm = document.createElement('span'); nm.className = 'lawly-sw-name';
        nm.textContent = (agentIcons[id] || agentIcons.default) + '  ' + (a.name || id);
        const ds = document.createElement('span'); ds.className = 'lawly-sw-desc';
        ds.textContent = a.description || '';
        btn.appendChild(nm); btn.appendChild(ds);
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus/value
        btn.addEventListener('click', function () {
          selectAgentById(id);
          // Remove the leading "/command" the user was typing.
          input.value = input.value.replace(/^\/\S*\s?/, '');
          hideSwitcher();
          input.focus();
        });
        switcher.appendChild(btn);
      });
      switcher.hidden = false;
    }
    if (input) {
      input.addEventListener('input', renderSwitcher);
      input.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideSwitcher(); });
      input.addEventListener('blur', function () { setTimeout(hideSwitcher, 120); });
    }

    // ── Settings overlay ──
    const openBtn = document.getElementById('settings-open-btn');
    const closeBtn = document.getElementById('settings-close-btn');
    const screen = document.getElementById('settings-screen');
    if (openBtn && screen) openBtn.addEventListener('click', function () { screen.style.display = 'block'; });
    if (closeBtn && screen) closeBtn.addEventListener('click', function () { screen.style.display = 'none'; });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
