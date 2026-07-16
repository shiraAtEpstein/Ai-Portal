// agents.js — agent list, conversations, agent selection, new chat.
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

// Presentational: time-of-day + signed-in name for the home hero.
function setWelcomeGreeting() {
  var el = document.getElementById('welcome-greeting');
  if (!el) return;
  var nm = ((document.getElementById('user-name') || {}).textContent || '').trim();
  var first = (nm.split(/[\s,]+/)[0] || '');
  if (/^(loading|—|-)?$/i.test(first) || first.toLowerCase() === 'loading...') first = '';
  var hr = new Date().getHours();
  var part = (hr < 5) ? 'Good evening' : (hr < 12) ? 'Good morning' : (hr < 18) ? 'Good afternoon' : 'Good evening';
  el.textContent = part + (first ? ', ' + first : '') + '.';
}

function newChat() {
  conversationId = null;
  conversationHistory = [];
  // Default a fresh chat to the general Lawly agent so the user can type immediately.
  // Guard in case agents haven't loaded yet (boot calls newChat after loadAgents, so
  // normally they have); the agent pill still lets them switch to a specialist.
  const hasLawly = (typeof agentsById !== 'undefined' && agentsById && agentsById['lawly']);
  currentAgent = hasLawly ? 'lawly' : null;
  var he = false; try { he = (localStorage.getItem('portalLang') === 'he'); } catch (e) {}
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  document.querySelectorAll('#conversation-list .agent-btn.active').forEach(function (b) { b.classList.remove('active'); });
  const sel = document.getElementById('agent-select');
  sel.disabled = false; sel.value = currentAgent || '';
  const nrow = document.getElementById('input-row'); if (nrow) nrow.style.borderColor = '';
  document.getElementById('message-input').placeholder = currentAgent
    ? (he ? 'כתבו הודעה ל‑Lawly…' : 'Message Lawly…')
    : (he ? 'בחרו סוכן כדי להתחיל…' : 'Choose an agent to begin…');
  document.getElementById('header-icon').textContent = (agentIcons['lawly'] || agentIcons.default);
  document.getElementById('header-name').textContent = 'Lawly';
  document.getElementById('header-desc').textContent = he ? 'שאלו אותי כל דבר בעבודה' : 'Ask me anything about your work';
  document.getElementById('no-agent').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';
  document.getElementById('messages').innerHTML =
    '<div class="lawly-hero">' +
    '<img class="lh-mascot" src="/LAWLY%20-%20are%20new%20best%20worker.png" alt="Lawly" />' +
    '<h2 class="lh-greeting" id="welcome-greeting">Welcome</h2>' +
    '<p class="lh-sub">' + (he
      ? 'איך אפשר לעזור היום? שאלו אותי כל דבר, או החליפו סוכן למטה.'
      : 'How can I help today? Ask me anything, or switch agents below.') + '</p>' +
    '</div>';
  setWelcomeGreeting();
  const inp = document.getElementById('message-input'); if (inp) inp.focus();
}

async function loadConversations() {
  try {
    const res = await fetch('/api/conversations', { headers: authHeader() });
    if (!res.ok) return;
    const data = await res.json();
    const list = document.getElementById('conversation-list');
    list.innerHTML = '';
    (data.conversations || []).forEach(function (c) {
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
  } catch (err) { console.error('Failed to load conversations:', err); }
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
