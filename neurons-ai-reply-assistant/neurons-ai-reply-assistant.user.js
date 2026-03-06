// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.8
// @description  Detects reply dialog, shows AI-assisted drafting pop-up with citations panel and rich text editor.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// NOTE v1.8: Added minimize/restore behavior.
// Behavior map:
//   Insert button      → inserts draft into Neurons, closes fully (work is done)
//   Minimize button    → collapses to bottom bar, draft preserved
//   Click grey overlay → minimizes (same as minimize button)
//   Esc key            → minimizes
//   Cancel button      → shows confirmation warning; confirm = closes fully + discards draft
//
// Minimized state: a slim bar pinned to the bottom of the screen with
// "Reply Assistant — Draft Ready", a Restore button, and a Discard button.
// Discard from the bar closes fully without a second warning (user already
// made a deliberate choice to minimize first, then discard).

(function () {
  'use strict';

  var LOG = '[UWM Reply Assistant]';
  var observerRef  = null;
  var pollInterval = null;
  var seenDialogs  = {};
  var popupActive  = false;
  var isMinimized  = false;

  // ── FRAME HELPERS ────────────────────────────────────────────────────────────
  function getAppFrame() {
    var frames = document.querySelectorAll('iframe.x-managed-iframe');
    var best = null, bestWidth = 0;
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentDocument && frames[i].offsetWidth > bestWidth) {
          best = frames[i];
          bestWidth = frames[i].offsetWidth;
        }
      } catch (e) {}
    }
    return best;
  }

  function getInnerDoc() {
    var f = getAppFrame();
    return f ? f.contentDocument : null;
  }

  // ── EMAIL THREAD READER ──────────────────────────────────────────────────────
  function readEmailThread(innerDoc) {
    var items = innerDoc.querySelectorAll('.flex-list-item-mail');
    var thread = [];
    if (!items.length) {
      console.log(LOG, 'No email thread items found');
      return thread;
    }
    for (var i = 0; i < items.length; i++) {
      var item     = items[i];
      var emailEls = item.querySelectorAll('.flex-list-item-email');
      var subject  = item.querySelector('.flex-list-item-subject');
      var body     = item.querySelector('.flex-list-item-commentText');
      var stamp    = item.querySelector('.flex-list-item-stamp');
      thread.push({
        to:      emailEls[0] ? emailEls[0].textContent.trim() : '',
        from:    emailEls[1] ? emailEls[1].textContent.trim() : '',
        subject: subject     ? subject.textContent.trim()     : '',
        date:    stamp       ? stamp.textContent.trim()       : '',
        body:    body        ? body.textContent.trim()        : ''
      });
    }
    console.log(LOG, 'Email thread — ' + thread.length + ' message(s) read');
    return thread;
  }

  // ── FIND COMPOSE EDITOR IFRAME ────────────────────────────────────────────────
  function getEditorIframe(dialogEl) {
    var iframes = dialogEl.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (doc && doc.body) return iframes[i];
      } catch (e) {}
    }
    return null;
  }

  // ── TOOLBAR COMMAND HELPER ────────────────────────────────────────────────────
  function execCmd(cmd, value) {
    document.getElementById('uwm-ra-editor').focus();
    document.execCommand(cmd, false, value || null);
  }

  // ── INJECT STYLES ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('uwm-ra-styles')) return;
    var style = document.createElement('style');
    style.id  = 'uwm-ra-styles';
    style.textContent = [

      /* ── Overlay backdrop ── */
      '#uwm-ra-overlay {',
      '  position: fixed; inset: 0; z-index: 999998;',
      '  background: rgba(15,20,30,0.55);',
      '  display: flex; align-items: center; justify-content: center;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '}',
      '#uwm-ra-overlay.ra-hidden { display: none; }',

      /* ── Main panel ── */
      '#uwm-ra-panel {',
      '  width: 900px; max-width: 96vw; height: 620px; max-height: 90vh;',
      '  background: #f7f8fa; border-radius: 10px;',
      '  box-shadow: 0 24px 64px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.15);',
      '  display: flex; flex-direction: column; overflow: hidden;',
      '  border: 1px solid #d0d5dd;',
      '}',

      /* ── Header ── */
      '#uwm-ra-header {',
      '  background: #1a2744; color: #fff;',
      '  padding: 12px 18px; display: flex; align-items: center; gap: 10px;',
      '  flex-shrink: 0;',
      '}',
      '#uwm-ra-header .ra-logo {',
      '  font-size: 13px; font-weight: 700; letter-spacing: 0.04em;',
      '  text-transform: uppercase; opacity: 0.9;',
      '}',
      '#uwm-ra-header .ra-header-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }',
      '#uwm-ra-header .ra-version { font-size: 11px; opacity: 0.45; }',

      /* Minimize button in header */
      '#uwm-ra-minimize-btn {',
      '  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);',
      '  color: #fff; border-radius: 5px; cursor: pointer;',
      '  font-size: 14px; padding: 2px 9px; line-height: 1.6;',
      '  transition: background 0.15s;',
      '}',
      '#uwm-ra-minimize-btn:hover { background: rgba(255,255,255,0.22); }',

      /* ── Confidence bar ── */
      '#uwm-ra-confidence {',
      '  display: flex; align-items: center; gap: 8px;',
      '  padding: 8px 18px; font-size: 12.5px;',
      '  border-bottom: 1px solid #e2e5ec; flex-shrink: 0;',
      '  background: #fffbf0;',
      '}',
      '#uwm-ra-confidence .ra-dot { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }',
      '.ra-dot-green  { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18); }',
      '.ra-dot-yellow { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.18); }',
      '.ra-dot-red    { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.18); }',

      /* ── Body ── */
      '#uwm-ra-body { display: flex; flex: 1; overflow: hidden; }',

      /* ── Citations sidebar ── */
      '#uwm-ra-citations {',
      '  width: 260px; flex-shrink: 0;',
      '  background: #1e2b45; color: #c8d0e0;',
      '  overflow-y: auto; padding: 14px 0;',
      '  display: flex; flex-direction: column;',
      '}',
      '#uwm-ra-citations .ra-cit-heading {',
      '  font-size: 10px; font-weight: 700; letter-spacing: 0.1em;',
      '  text-transform: uppercase; color: #6b7fa3; padding: 0 14px 8px 14px;',
      '}',
      '.ra-cit-tier { padding: 8px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); }',
      '.ra-cit-tier-label {',
      '  font-size: 10px; font-weight: 700; letter-spacing: 0.08em;',
      '  text-transform: uppercase; color: #5b7fa3; margin-bottom: 5px;',
      '}',
      '.ra-cit-item { margin-bottom: 8px; }',
      '.ra-cit-item a { font-size: 12px; color: #7db3e8; text-decoration: none; display: block; line-height: 1.35; }',
      '.ra-cit-item a:hover { text-decoration: underline; }',
      '.ra-cit-item .ra-cit-excerpt { font-size: 11px; color: #8a97ae; margin-top: 2px; line-height: 1.4; }',
      '.ra-cit-none { font-size: 11px; color: #4a5a72; font-style: italic; }',
      '.ra-cit-community-note {',
      '  font-size: 10px; color: #a08050; background: rgba(245,158,11,0.12);',
      '  border-radius: 3px; padding: 2px 5px; margin-top: 3px; display: inline-block;',
      '}',

      /* ── Editor area ── */
      '#uwm-ra-editor-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #fff; }',

      /* ── Toolbar ── */
      '#uwm-ra-toolbar {',
      '  display: flex; align-items: center; gap: 2px; flex-wrap: wrap;',
      '  padding: 6px 10px; border-bottom: 1px solid #e2e5ec;',
      '  background: #f7f8fa; flex-shrink: 0;',
      '}',
      '.ra-tb-btn {',
      '  background: none; border: 1px solid transparent; border-radius: 4px;',
      '  cursor: pointer; font-size: 13px; padding: 3px 7px; color: #374151;',
      '  transition: background 0.12s, border-color 0.12s; line-height: 1.4;',
      '}',
      '.ra-tb-btn:hover { background: #e5e7eb; border-color: #d0d5dd; }',
      '.ra-tb-sep { width: 1px; height: 18px; background: #d0d5dd; margin: 0 4px; }',

      /* ── contentEditable editor ── */
      '#uwm-ra-editor {',
      '  flex: 1; overflow-y: auto; padding: 14px 18px;',
      '  font-size: 13.5px; font-family: "Segoe UI", system-ui, sans-serif;',
      '  line-height: 1.6; color: #1f2937; outline: none; min-height: 0;',
      '}',
      '#uwm-ra-editor:empty:before { content: "Draft reply will appear here…"; color: #9ca3af; pointer-events: none; }',

      /* ── Footer ── */
      '#uwm-ra-footer {',
      '  padding: 10px 16px; border-top: 1px solid #e2e5ec;',
      '  display: flex; align-items: center; gap: 10px; background: #f7f8fa; flex-shrink: 0;',
      '}',
      '.ra-btn {',
      '  padding: 7px 18px; border-radius: 6px; font-size: 13px;',
      '  font-weight: 600; cursor: pointer; border: none; transition: background 0.15s;',
      '}',
      '#uwm-ra-insert  { background: #1a5bb8; color: #fff; }',
      '#uwm-ra-insert:hover  { background: #1549a0; }',
      '#uwm-ra-cancel  { background: #e5e7eb; color: #374151; }',
      '#uwm-ra-cancel:hover  { background: #d1d5db; }',

      /* ── Thumbs ── */
      '.ra-thumbs { display: flex; gap: 6px; margin-left: auto; }',
      '.ra-thumb-btn {',
      '  background: none; border: 1px solid #d0d5dd; border-radius: 6px;',
      '  cursor: pointer; font-size: 16px; padding: 4px 10px;',
      '  transition: background 0.15s, border-color 0.15s;',
      '}',
      '.ra-thumb-btn:hover { background: #e5e7eb; }',
      '.ra-thumb-btn.ra-thumb-selected { background: #dbeafe; border-color: #3b82f6; }',

      /* ── Searching indicator ── */
      '#uwm-ra-searching { font-size: 12px; color: #6b7fa3; margin-left: 8px; display: flex; align-items: center; gap: 6px; }',
      '.ra-spinner {',
      '  width: 13px; height: 13px; border: 2px solid #d0d5dd; border-top-color: #3b82f6;',
      '  border-radius: 50%; flex-shrink: 0; animation: ra-spin 0.7s linear infinite;',
      '}',
      '@keyframes ra-spin { to { transform: rotate(360deg); } }',

      /* ── Minimized bottom bar ── */
      '#uwm-ra-minibar {',
      '  position: fixed; bottom: 0; left: 0; right: 0; z-index: 999999;',
      '  background: #1a2744; color: #fff;',
      '  display: flex; align-items: center; gap: 12px;',
      '  padding: 10px 20px;',
      '  box-shadow: 0 -4px 20px rgba(0,0,0,0.3);',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '}',
      '#uwm-ra-minibar.ra-hidden { display: none; }',
      '#uwm-ra-minibar .ra-mini-icon { font-size: 16px; opacity: 0.8; }',
      '#uwm-ra-minibar .ra-mini-label {',
      '  font-size: 13px; font-weight: 600; letter-spacing: 0.02em;',
      '}',
      '#uwm-ra-minibar .ra-mini-sub {',
      '  font-size: 11px; opacity: 0.5; margin-left: 2px;',
      '}',
      '.ra-mini-btn {',
      '  padding: 5px 16px; border-radius: 5px; font-size: 12.5px;',
      '  font-weight: 600; cursor: pointer; border: none; transition: background 0.15s;',
      '}',
      '#uwm-ra-mini-restore { background: #2563eb; color: #fff; margin-left: auto; }',
      '#uwm-ra-mini-restore:hover { background: #1d4ed8; }',
      '#uwm-ra-mini-discard { background: rgba(255,255,255,0.1); color: #fca5a5; border: 1px solid rgba(255,100,100,0.3); }',
      '#uwm-ra-mini-discard:hover { background: rgba(255,80,80,0.2); }',

      /* ── Cancel warning dialog ── */
      '#uwm-ra-warn-overlay {',
      '  position: fixed; inset: 0; z-index: 1000000;',
      '  background: rgba(15,20,30,0.65);',
      '  display: flex; align-items: center; justify-content: center;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '}',
      '#uwm-ra-warn-box {',
      '  background: #fff; border-radius: 10px; padding: 28px 32px;',
      '  width: 400px; max-width: 92vw;',
      '  box-shadow: 0 16px 48px rgba(0,0,0,0.3);',
      '  border: 1px solid #e2e5ec;',
      '}',
      '#uwm-ra-warn-box h3 {',
      '  margin: 0 0 10px 0; font-size: 16px; color: #111827;',
      '}',
      '#uwm-ra-warn-box p {',
      '  margin: 0 0 22px 0; font-size: 13.5px; color: #6b7280; line-height: 1.5;',
      '}',
      '#uwm-ra-warn-box .ra-warn-actions { display: flex; gap: 10px; justify-content: flex-end; }',
      '#uwm-ra-warn-keep    { background: #e5e7eb; color: #374151; }',
      '#uwm-ra-warn-keep:hover { background: #d1d5db; }',
      '#uwm-ra-warn-confirm { background: #dc2626; color: #fff; }',
      '#uwm-ra-warn-confirm:hover { background: #b91c1c; }',

    ].join('\n');
    document.head.appendChild(style);
  }

  // ── MINIMIZE ──────────────────────────────────────────────────────────────────
  // Hides the overlay (and its backdrop) and shows the bottom minibar.
  // Draft content in the contentEditable div is preserved — the overlay is
  // hidden, not removed, so the DOM (and editor content) stays intact.
  function minimizePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    if (overlay) overlay.classList.add('ra-hidden');
    if (minibar) minibar.classList.remove('ra-hidden');
    isMinimized = true;
    console.log(LOG, 'Pop-up minimized — draft preserved');
  }

  // ── RESTORE ───────────────────────────────────────────────────────────────────
  function restorePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    if (overlay) overlay.classList.remove('ra-hidden');
    if (minibar) minibar.classList.add('ra-hidden');
    isMinimized = false;
    console.log(LOG, 'Pop-up restored');
  }

  // ── CLOSE FULLY ───────────────────────────────────────────────────────────────
  // Removes all injected UI elements from the DOM and resets state.
  function closePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    var warn    = document.getElementById('uwm-ra-warn-overlay');
    if (overlay) overlay.remove();
    if (minibar) minibar.remove();
    if (warn)    warn.remove();
    popupActive = false;
    isMinimized = false;
    // Reset seenDialogs so the pop-up re-triggers on the next Reply click
    seenDialogs = {};
    console.log(LOG, 'Pop-up closed — ready for next reply');
  }

  // ── CANCEL WARNING DIALOG ─────────────────────────────────────────────────────
  // Shown when the user clicks Cancel. Requires a second deliberate confirmation
  // before discarding the draft. "Keep editing" returns to the pop-up.
  function showCancelWarning() {
    // If already minimized, restore first so the warning appears over the pop-up
    if (isMinimized) restorePopup();

    var warn = document.createElement('div');
    warn.id  = 'uwm-ra-warn-overlay';
    warn.innerHTML = [
      '<div id="uwm-ra-warn-box">',
        '<h3>Discard this draft?</h3>',
        '<p>Your draft reply and any edits you\'ve made will be permanently lost. This cannot be undone.</p>',
        '<div class="ra-warn-actions">',
          '<button class="ra-btn" id="uwm-ra-warn-keep">Keep editing</button>',
          '<button class="ra-btn" id="uwm-ra-warn-confirm">Yes, discard draft</button>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(warn);

    document.getElementById('uwm-ra-warn-keep').addEventListener('click', function () {
      warn.remove();
      console.log(LOG, 'Cancel dismissed — returning to pop-up');
    });

    document.getElementById('uwm-ra-warn-confirm').addEventListener('click', function () {
      console.log(LOG, 'Draft discarded by user confirmation');
      closePopup();
    });

    // Clicking outside the warning box also dismisses it (returns to pop-up)
    warn.addEventListener('click', function (e) {
      if (e.target === warn) warn.remove();
    });
  }

  // ── POP-UP UI ─────────────────────────────────────────────────────────────────
  function showPopup(dialogEl, thread) {

    if (popupActive) {
      console.log(LOG, 'Pop-up already active — skipping duplicate');
      return;
    }
    popupActive = true;
    injectStyles();

    // ── Build overlay ─────────────────────────────────────────────────────────
    var overlay = document.createElement('div');
    overlay.id  = 'uwm-ra-overlay';

    overlay.innerHTML = [
      '<div id="uwm-ra-panel">',

        // Header — includes Minimize button
        '<div id="uwm-ra-header">',
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7db3e8" stroke-width="2">',
            '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
          '</svg>',
          '<span class="ra-logo">Reply Assistant</span>',
          '<span id="uwm-ra-searching">',
            '<span class="ra-spinner"></span>',
            'Searching knowledge base…',
          '</span>',
          '<div class="ra-header-actions">',
            '<button id="uwm-ra-minimize-btn" title="Minimize — draft will be preserved">&#8211;</button>',
            '<span class="ra-version">v1.8</span>',
          '</div>',
        '</div>',

        // Confidence bar
        '<div id="uwm-ra-confidence">',
          '<span class="ra-dot ra-dot-yellow"></span>',
          '<strong style="font-size:12.5px;color:#92400e;">Best guess</strong>',
          '<span style="color:#78716c;font-size:12px;margin-left:4px;">— reviewing search results. Verify before sending.</span>',
        '</div>',

        // Body
        '<div id="uwm-ra-body">',

          // Citations sidebar
          '<div id="uwm-ra-citations">',
            '<div class="ra-cit-heading">Sources Consulted</div>',

            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 1 — UWM Knowledge Base</div>',
              '<div class="ra-cit-item">',
                '<a href="https://kb.uwm.edu" target="_blank">Setting Up Your Canvas Course Site</a>',
                '<div class="ra-cit-excerpt">Step-by-step guide to course creation, enrollment sync, and template use for UWM instructors.</div>',
              '</div>',
              '<div class="ra-cit-item">',
                '<a href="https://kb.uwm.edu" target="_blank">Canvas — Adding a TA or Co-instructor</a>',
                '<div class="ra-cit-excerpt">How to request additional user roles in a Canvas course site via the UWM enrollment system.</div>',
              '</div>',
            '</div>',

            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 2 — UWM Web</div>',
              '<div class="ra-cit-none">Searched — no results found</div>',
            '</div>',

            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 3 — UW System KB</div>',
              '<div class="ra-cit-item">',
                '<a href="https://kb.wisconsin.edu" target="_blank">Canvas LTI Tool Availability — UW System</a>',
                '<div class="ra-cit-excerpt">Which LTI integrations are enabled system-wide vs. configured at the institution level.</div>',
              '</div>',
            '</div>',

            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 4 — Canvas Community</div>',
              '<div class="ra-cit-item">',
                '<a href="https://community.instructure.com" target="_blank">How do I add files to a course? [Solved]</a>',
                '<div class="ra-cit-excerpt">Official Instructure documentation on the Canvas Files tool, upload limits, and folder structure.</div>',
                '<div class="ra-cit-community-note">&#9873; Peer-generated community thread</div>',
              '</div>',
            '</div>',

            '<div class="ra-cit-tier" style="border-bottom:none;">',
              '<div class="ra-cit-tier-label">Memory Store</div>',
              '<div class="ra-cit-none">No similar past answers found</div>',
            '</div>',

          '</div>',

          // Editor area
          '<div id="uwm-ra-editor-area">',
            '<div id="uwm-ra-toolbar">',
              '<button class="ra-tb-btn" data-cmd="bold"               title="Bold"><b>B</b></button>',
              '<button class="ra-tb-btn" data-cmd="italic"             title="Italic"><i>I</i></button>',
              '<button class="ra-tb-btn" data-cmd="underline"          title="Underline"><u>U</u></button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" data-cmd="insertUnorderedList" title="Bullet list">&#8226; List</button>',
              '<button class="ra-tb-btn" data-cmd="insertOrderedList"   title="Numbered list">1. List</button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" id="uwm-ra-link-btn"          title="Insert link">&#128279; Link</button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" data-cmd="removeFormat"       title="Clear formatting">&#10005; Clear</button>',
            '</div>',
            '<div id="uwm-ra-editor" contenteditable="true" spellcheck="true"></div>',
          '</div>',

        '</div>',

        // Footer
        '<div id="uwm-ra-footer">',
          '<button class="ra-btn" id="uwm-ra-insert">&#8629; Insert into Email</button>',
          '<button class="ra-btn" id="uwm-ra-cancel">Cancel</button>',
          '<div class="ra-thumbs">',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-up"   title="This draft is useful — save to memory">&#128077;</button>',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-down" title="This draft is not useful">&#128078;</button>',
          '</div>',
        '</div>',

      '</div>'
    ].join('');

    document.body.appendChild(overlay);

    // ── Build minimized bottom bar (hidden initially) ──────────────────────────
    var minibar = document.createElement('div');
    minibar.id  = 'uwm-ra-minibar';
    minibar.classList.add('ra-hidden');
    minibar.innerHTML = [
      '<span class="ra-mini-icon">&#128172;</span>',
      '<span class="ra-mini-label">Reply Assistant</span>',
      '<span class="ra-mini-sub">— draft ready</span>',
      '<button class="ra-mini-btn" id="uwm-ra-mini-restore">&#9650; Restore</button>',
      '<button class="ra-mini-btn" id="uwm-ra-mini-discard">&#10005; Discard</button>',
    ].join('');
    document.body.appendChild(minibar);

    // ── Populate editor with placeholder draft ────────────────────────────────
    document.getElementById('uwm-ra-editor').innerHTML = [
      '<p>Hi [Instructor Name],</p>',
      '<p>Thank you for reaching out to UWM CETL support.</p>',
      '<p><em>[Placeholder draft — will be replaced with a real AI-generated reply once search and Ollama integration are complete.]</em></p>',
      '<p>Based on what you\'ve described, here are some resources that may help:</p>',
      '<ul>',
      '<li>UWM Knowledge Base: <a href="https://kb.uwm.edu">Setting Up Your Canvas Course Site</a></li>',
      '<li>Canvas Community: <a href="https://community.instructure.com">How do I add files to a course?</a></li>',
      '</ul>',
      '<p>Please let me know if you have any questions or if this doesn\'t resolve the issue — happy to help further.</p>',
      '<p>Best,<br>Lane<br>CETL Teaching, Learning &amp; Technology Consultant</p>'
    ].join('');

    // ── Toolbar wiring ────────────────────────────────────────────────────────
    var tbBtns = document.querySelectorAll('#uwm-ra-toolbar .ra-tb-btn[data-cmd]');
    for (var t = 0; t < tbBtns.length; t++) {
      (function (btn) {
        btn.addEventListener('mousedown', function (e) {
          e.preventDefault();
          execCmd(btn.getAttribute('data-cmd'));
        });
      }(tbBtns[t]));
    }

    document.getElementById('uwm-ra-link-btn').addEventListener('mousedown', function (e) {
      e.preventDefault();
      var url = prompt('Enter URL:', 'https://');
      if (url && url !== 'https://') execCmd('createLink', url);
    });

    // ── Simulate search finishing ─────────────────────────────────────────────
    setTimeout(function () {
      var el = document.getElementById('uwm-ra-searching');
      if (el) el.innerHTML = '<span style="color:#4ade80;font-size:12px;">&#10003; Search complete</span>';
    }, 2000);

    // ── MINIMIZE BUTTON (header) ──────────────────────────────────────────────
    document.getElementById('uwm-ra-minimize-btn').addEventListener('click', function () {
      minimizePopup();
    });

    // ── INSERT BUTTON ─────────────────────────────────────────────────────────
    // On success: inserts draft into Neurons and closes fully. No warning needed
    // because the work is preserved in the email compose window.
    document.getElementById('uwm-ra-insert').addEventListener('click', function () {
      var html = document.getElementById('uwm-ra-editor').innerHTML;
      if (!html || !html.trim()) {
        alert('[UWM Reply Assistant] Nothing to insert — the editor is empty.');
        return;
      }
      var editorIframe = getEditorIframe(dialogEl);
      if (!editorIframe) {
        alert('[UWM Reply Assistant] Could not find the Neurons compose editor. The dialog may have closed.');
        closePopup();
        return;
      }
      try {
        var editorBody = editorIframe.contentDocument.body;
        editorBody.innerHTML = html;
        var evt = editorIframe.contentDocument.createEvent('Event');
        evt.initEvent('input', true, true);
        editorBody.dispatchEvent(evt);
        console.log(LOG, 'Draft inserted into Neurons compose editor (' + html.length + ' chars)');
        closePopup();
      } catch (e) {
        console.error(LOG, 'Insert failed:', e);
        alert('[UWM Reply Assistant] Insert failed — see console for details. Error: ' + e.message);
      }
    });

    // ── CANCEL BUTTON → warning dialog ────────────────────────────────────────
    document.getElementById('uwm-ra-cancel').addEventListener('click', function () {
      showCancelWarning();
    });

    // ── THUMBS ────────────────────────────────────────────────────────────────
    document.getElementById('uwm-ra-thumb-up').addEventListener('click', function () {
      this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-down').classList.remove('ra-thumb-selected');
      console.log(LOG, 'Thumbs up — answer marked useful (memory store: not yet connected)');
    });
    document.getElementById('uwm-ra-thumb-down').addEventListener('click', function () {
      this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-up').classList.remove('ra-thumb-selected');
      console.log(LOG, 'Thumbs down — answer marked not useful');
    });

    // ── OVERLAY CLICK → minimize ──────────────────────────────────────────────
    // Clicking the grey backdrop minimizes rather than closing, so accidental
    // clicks outside the panel don't destroy the draft.
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        console.log(LOG, 'Overlay clicked — minimizing');
        minimizePopup();
      }
    });

    // ── ESC KEY → minimize ────────────────────────────────────────────────────
    // Attached to the document so it fires regardless of focus. Removed when
    // the pop-up closes so it doesn't linger and affect other page interactions.
    function onKeyDown(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        if (!popupActive) return;
        if (isMinimized) {
          // Esc while minimized → restore (toggle behavior)
          restorePopup();
        } else {
          minimizePopup();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);

    // ── MINIBAR BUTTONS ───────────────────────────────────────────────────────
    document.getElementById('uwm-ra-mini-restore').addEventListener('click', function () {
      restorePopup();
    });

    // Discard from minibar closes fully without a second warning — the user
    // already chose to minimize, then explicitly chose Discard.
    document.getElementById('uwm-ra-mini-discard').addEventListener('click', function () {
      console.log(LOG, 'Draft discarded from minibar');
      closePopup();
      document.removeEventListener('keydown', onKeyDown);
    });

    // Patch closePopup to also remove the keydown listener when called
    // from Insert, Cancel-confirm, or minibar Discard.
    var _origClose = closePopup;
    // We override the module-level closePopup for this session's listener cleanup.
    // The onKeyDown reference is captured in this closure.
    document.getElementById('uwm-ra-insert').addEventListener('click', function () {
      document.removeEventListener('keydown', onKeyDown);
    }, true); // capture phase so it fires before the main insert handler
    document.getElementById('uwm-ra-cancel').addEventListener('click', function () {
      // keydown removed after warning confirm, not here — the user may keep editing
    });

    console.log(LOG, 'Pop-up displayed — Esc/overlay=minimize, Cancel=warning, Insert=close');
  }

  // ── DIALOG HANDLER ───────────────────────────────────────────────────────────
  function handleDialog(dialogEl, innerDoc) {
    if (seenDialogs[dialogEl.id]) return;
    var editorIframe = getEditorIframe(dialogEl);
    if (!editorIframe) return;
    seenDialogs[dialogEl.id] = true;
    console.log(LOG, 'Compose dialog detected (id=' + dialogEl.id + ')');
    var thread = readEmailThread(innerDoc);
    showPopup(dialogEl, thread);
  }

  // ── POLL FALLBACK ────────────────────────────────────────────────────────────
  function startPoller() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(function () {
      var innerDoc = getInnerDoc();
      if (!innerDoc) return;
      var dialogs = innerDoc.querySelectorAll('.x-frs-modal-form');
      for (var i = 0; i < dialogs.length; i++) {
        handleDialog(dialogs[i], innerDoc);
      }
    }, 500);
  }

  // ── MUTATION OBSERVER ────────────────────────────────────────────────────────
  function startObserver(innerDoc) {
    if (observerRef) { try { observerRef.disconnect(); } catch (e) {} }
    observerRef = new MutationObserver(function () {
      var currentDoc = getInnerDoc();
      if (!currentDoc) return;
      var dialogs = currentDoc.querySelectorAll('.x-frs-modal-form');
      for (var i = 0; i < dialogs.length; i++) {
        (function (el, doc) {
          setTimeout(function () { handleDialog(el, doc); }, 250);
        }(dialogs[i], currentDoc));
      }
    });
    observerRef.observe(innerDoc.body, { childList: true, subtree: true });
    console.log(LOG, 'MutationObserver attached');
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────
  var initAttempts = 0;
  function init() {
    initAttempts++;
    var innerDoc = getInnerDoc();
    if (!innerDoc || !innerDoc.body) {
      if (initAttempts < 30) setTimeout(init, 500);
      return;
    }
    startObserver(innerDoc);
    startPoller();
    console.log(LOG, 'v1.8 initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }

})();
