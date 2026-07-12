// chat.js — sending messages, the 'thinking' card, message rendering.
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
  let scripted = -1, serverDriven = false, finished = false;
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
    if (!serverDriven) {
      let target;
      if (t < 2) target = -1; else if (t < 6) target = 0; else target = Math.min(script.length - 2, 1 + Math.floor((t - 6) / 5));
      if (t >= 50) target = script.length - 1;
      if (target > scripted) { for (let s = scripted + 1; s <= target; s++) { if (s > 0) addDoneStep(script[s - 1]); setStatus(script[s]); scripted = s; } scroll(); }
    }
    if (t >= 50) showActions();
  }, 600);

  return {
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
          think.done();
          answer += evt.text;
          bubble.innerHTML = formatText(answer);
          scroll();
        } else if (evt.type === 'meta') {
          if (evt.conversationId && !conversationId) conversationId = evt.conversationId;
        } else if (evt.type === 'file') {
          const a = document.createElement('a');
          a.href = evt.url;
          a.textContent = '⬇ ' + (evt.filename || 'Download file');
          a.className = 'msg-file';
          a.setAttribute('download', evt.filename || '');
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
  var __hero = msgs.querySelector('.lawly-hero'); if (__hero) __hero.remove();
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
  return wrapper;
}

// appendTyping() removed — superseded by startThinking() + the SSE streaming flow in sendMessage().
