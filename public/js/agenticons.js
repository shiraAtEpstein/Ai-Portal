// agenticons.js — Lawly agent icon set (SVG).
// Loaded after core.js. Provides a cohesive, gold-and-cream badge icon per
// agent id, plus helpers to render them. These replace the old emoji in the
// agent picker, chat header and conversation sidebar.
//
// Each icon is a self-contained 40x40 SVG "badge": a cream rounded tile with a
// thin gold ring and a charcoal + gold glyph. They share one gradient/def block
// (injected once) so the markup stays small when many icons are on the page.

(function () {
  // Inject shared gradient defs once.
  function injectDefs() {
    if (document.getElementById('lawly-icon-defs')) return;
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.id = 'lawly-icon-defs';
    s.setAttribute('width', '0');
    s.setAttribute('height', '0');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;');
    s.innerHTML =
      '<defs>' +
      '<linearGradient id="lawlyTile" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#FFFDF9"/>' +
        '<stop offset="1" stop-color="#F1E6CE"/>' +
      '</linearGradient>' +
      '</defs>';
    (document.body || document.documentElement).appendChild(s);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectDefs);
  } else {
    injectDefs();
  }

  var CHARCOAL = '#23252B';
  var GOLD     = '#C4A24C';
  var RING     = '#D9BE7B';

  // Wrap a glyph in the shared badge tile.
  function badge(glyph) {
    return '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" role="img" focusable="false">' +
      '<rect x="1.4" y="1.4" width="37.2" height="37.2" rx="11" fill="url(#lawlyTile)" stroke="' + RING + '" stroke-width="1.3"/>' +
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' + glyph + '</g>' +
    '</svg>';
  }

  var C = CHARCOAL, G = GOLD;

  var GLYPHS = {
    // Flagship — scales of justice
    lawly:
      '<path d="M20 10 V29.5" stroke="' + C + '" stroke-width="1.8"/>' +
      '<circle cx="20" cy="9" r="1.7" fill="' + G + '" stroke="none"/>' +
      '<path d="M11 12.5 H29" stroke="' + G + '" stroke-width="1.8"/>' +
      '<path d="M11 12.5 V16.5 M29 12.5 V16.5" stroke="' + C + '" stroke-width="1.3"/>' +
      '<path d="M7.5 16.5 Q11 21.5 14.5 16.5" stroke="' + G + '" stroke-width="1.7"/>' +
      '<path d="M25.5 16.5 Q29 21.5 32.5 16.5" stroke="' + G + '" stroke-width="1.7"/>' +
      '<path d="M16 30 L24 30 L22 27 L18 27 Z" fill="' + C + '" stroke="none"/>',

    // Content Writer — pen nib
    copywriter:
      '<path d="M20 11 L25 23 Q20 26.5 15 23 Z" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M20 15 V22.5" stroke="' + C + '" stroke-width="1.5"/>' +
      '<circle cx="20" cy="24.4" r="1.3" fill="' + G + '" stroke="none"/>',

    // Research Assistant — magnifier
    researcher:
      '<circle cx="18" cy="18" r="6" stroke="' + C + '" stroke-width="2"/>' +
      '<path d="M22.4 22.4 L28.5 28.5" stroke="' + C + '" stroke-width="2.4"/>' +
      '<path d="M15.5 16.6 A3.5 3.5 0 0 1 18 15" stroke="' + G + '" stroke-width="1.6"/>',

    // Paralegal Assistant — clipboard
    paralegal:
      '<rect x="12" y="12" width="16" height="18" rx="2.5" stroke="' + C + '" stroke-width="1.8"/>' +
      '<rect x="17" y="9" width="6" height="4" rx="1.4" fill="' + C + '" stroke="none"/>' +
      '<path d="M15.5 18 H24.5" stroke="' + G + '" stroke-width="1.7"/>' +
      '<path d="M15.5 21.7 H24.5" stroke="' + C + '" stroke-width="1.6"/>' +
      '<path d="M15.5 25.4 H21" stroke="' + C + '" stroke-width="1.6"/>',

    // Document Review — page + check
    document_review:
      '<path d="M14 10 H23 L27 14 V30 H14 Z" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M23 10 V14 H27" stroke="' + C + '" stroke-width="1.5"/>' +
      '<path d="M16.5 22 L19 24.8 L24 18.5" stroke="' + G + '" stroke-width="2.3"/>',

    // Legal Research — open book
    legal_research:
      '<path d="M20 13.5 V28" stroke="' + C + '" stroke-width="1.7"/>' +
      '<path d="M20 13.5 C16.5 11.5 12.5 12 11 12.4 V25.6 C12.5 25.2 16.5 24.8 20 26.8" stroke="' + C + '" stroke-width="1.7"/>' +
      '<path d="M20 13.5 C23.5 11.5 27.5 12 29 12.4 V25.6 C27.5 25.2 23.5 24.8 20 26.8" stroke="' + C + '" stroke-width="1.7"/>' +
      '<path d="M24.5 12 V18 L26.3 16.6 L28 18 V12.4" fill="' + G + '" stroke="none"/>',

    // Client Intake — person + plus
    client_intake:
      '<circle cx="18.5" cy="16" r="3.4" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M11.5 28.5 C11.5 22.5 25.5 22.5 25.5 28.5" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M27.5 11.5 V17.5 M24.5 14.5 H30.5" stroke="' + G + '" stroke-width="2"/>',

    // Marketing Director — megaphone
    marketing_director:
      '<path d="M13 17 L24 12.5 V27.5 L13 23 Z" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M10 18 H13 V22 H10 Z" stroke="' + C + '" stroke-width="1.6"/>' +
      '<path d="M16 23 V27" stroke="' + C + '" stroke-width="1.6"/>' +
      '<path d="M27 15.5 Q30 20 27 24.5" stroke="' + G + '" stroke-width="1.7"/>' +
      '<path d="M29.5 13 Q33.5 20 29.5 27" stroke="' + G + '" stroke-width="1.5"/>',

    // Content Planner — calendar
    content_planner:
      '<rect x="11" y="13" width="18" height="16" rx="2.5" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M11 18 H29" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M16 10.5 V15 M24 10.5 V15" stroke="' + C + '" stroke-width="2"/>' +
      '<circle cx="16" cy="22.5" r="1.2" fill="' + G + '" stroke="none"/>' +
      '<circle cx="20" cy="22.5" r="1.2" fill="' + C + '" stroke="none"/>' +
      '<circle cx="24" cy="22.5" r="1.2" fill="' + C + '" stroke="none"/>' +
      '<circle cx="16" cy="26" r="1.2" fill="' + C + '" stroke="none"/>' +
      '<circle cx="20" cy="26" r="1.2" fill="' + C + '" stroke="none"/>',

    // Marketing Copywriter — pen + sparkle
    mkt_copywriter:
      '<path d="M16 15 L21 25 Q16.5 27.5 13 24 Z" stroke="' + C + '" stroke-width="1.7"/>' +
      '<path d="M16 18.5 V24" stroke="' + C + '" stroke-width="1.4"/>' +
      '<path d="M27 11 L28.3 14.3 L31.6 15.6 L28.3 16.9 L27 20.2 L25.7 16.9 L22.4 15.6 L25.7 14.3 Z" fill="' + G + '" stroke="none"/>',

    // Daily Briefing — sunrise
    daily:
      '<path d="M9.5 25 H30.5" stroke="' + C + '" stroke-width="2"/>' +
      '<path d="M13.5 29 H26.5" stroke="' + C + '" stroke-width="1.5"/>' +
      '<path d="M14 25 A6 6 0 0 1 26 25" stroke="' + G + '" stroke-width="2"/>' +
      '<path d="M20 11 V14 M11.5 17.5 L13.5 19.5 M28.5 17.5 L26.5 19.5" stroke="' + G + '" stroke-width="1.7"/>',

    // Gmail / Email
    gmail:
      '<rect x="11" y="13" width="18" height="14" rx="2.5" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M12 15 L20 21 L28 15" stroke="' + G + '" stroke-width="1.8"/>',

    // Default — friendly robot (Lawly mascot motif)
    default:
      '<rect x="12" y="13" width="16" height="14" rx="5" stroke="' + C + '" stroke-width="1.8"/>' +
      '<path d="M20 9 V13" stroke="' + C + '" stroke-width="1.6"/>' +
      '<circle cx="20" cy="8" r="1.5" fill="' + G + '" stroke="none"/>' +
      '<path d="M12 18.5 H10 M28 18.5 H30" stroke="' + C + '" stroke-width="1.6"/>' +
      '<circle cx="17" cy="20" r="1.7" fill="' + G + '" stroke="none"/>' +
      '<circle cx="23" cy="20" r="1.7" fill="' + G + '" stroke="none"/>' +
      '<path d="M17 24 Q20 26 23 24" stroke="' + C + '" stroke-width="1.6"/>',
  };

  var CACHE = {};

  // Public: return the SVG markup string for an agent id.
  function agentSvg(id) {
    var key = (id && GLYPHS[id]) ? id : 'default';
    if (!CACHE[key]) CACHE[key] = badge(GLYPHS[key]);
    return CACHE[key];
  }

  // Public: SVG wrapped in a sized span, for inline placement.
  function agentIconHTML(id, cls) {
    return '<span class="lawly-ico ' + (cls || '') + '">' + agentSvg(id) + '</span>';
  }

  // Expose globally (non-module scripts).
  window.agentSvg = agentSvg;
  window.agentIconHTML = agentIconHTML;
  window.LAWLY_AGENT_ICON_IDS = Object.keys(GLYPHS);
})();
