// core.js — shared state, constants and cross-cutting helpers.
// Load FIRST. Everything else assumes these globals exist.

// ── State ──
let sessionToken   = null;
let currentAgent   = null;
let conversationHistory = [];
let conversationId = null;
let agentsById = {};
let isLoading      = false;

const agentIcons = {
  lawly:           '⚖️',
  copywriter:      '✍️',
  researcher:      '🔍',
  paralegal:       '📋',
  document_review: '📄',
  legal_research:  '⚖️',
  client_intake:   '🤝',
  default:         '🤖',
};

// ── Shared helpers (used across features) ──
function handleSessionExpired() {
  alert('Your session has expired. Please sign in again.');
  location.reload();
}

function authHeader() {
  return { 'Authorization': `Bearer ${sessionToken}` };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
