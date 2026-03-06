// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.7
// @description  Detects reply dialog, shows AI-assisted drafting pop-up with citations panel and rich text editor.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// NOTE v1.7: Removed Quill.js entirely. Quill's internal use of NamedNodeMap.collect()
// conflicts with ExtJS 3.1's Array.prototype patches, causing a fatal TypeError on init.
// Replaced with a native contentEditable div + hand-rolled toolbar. Zero external
// dependencies — no @require, no CDN calls, nothing that can conflict with ExtJS.

(function () {
  'use strict';

  var LOG = '[UWM Reply Assistant]';
  var observerRef  = null;
  var pollInterval = null;
  var seenDialogs  = {};
  var popupActive  = false;

  // ── FRAME HELPERS ────────────────────────────────────────────────────────────
  // Returns the managed iframe with the largest offsetWidth — always the active
  // Object Workspace. Called fresh each time to avoid stale document references.
  function getAppFrame() {
    var frames = document.querySelectorAll('iframe.x-managed-iframe');
    var best = null;
    var bestWidth = 0;
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
  // Reads all .flex-list-item-mail items in the inner iframe and returns a
  // structured array of message objects for use in search and display.
  function readEmailThread(innerDoc) {
    var items = innerDoc.querySelectorAll('.flex-list-item-mail');
    var thread = [];
    if (!items.length) {
      console.log(LOG, 'No email thread items found (.flex-list-item-mail)');
      return thread;
    }
    for (var i = 0; i < items.length; i++) {
      var item     = items[i];
      var emailEls = item.querySelectorAll('.flex-list-item-email');
      var to       = emailEls[0] ? emailEls[0].textContent.trim() : '';
      var from     = emailEls[1] ? emailEls[1].textContent.trim() : '';
      var subject  = item.querySelector('.flex-list-item-subject');
      var body     = item.querySelector('.flex-list-item-commentText');
      var stamp    = item.querySelector('.flex-list-item-stamp');
      thread.push({
        to:      to,
        from:    from,
        subject: subject ? subject.textContent.trim() : '',
        date:    stamp   ? stamp.textContent.trim()   : '',
        body:    body    ? body.textContent.trim()    : ''
      });
    }
    console.log(LOG, 'Email thread — ' + thread.length + ' message(s) read');
    return thread;
  }

  // ── FIND COMPOSE EDITOR IFRAME ────────────────────────────────────────────────
  // Locates the first iframe inside the compose dialog — this is Neurons' rich
  // text editor. Its contentDocument.body is the editable email compose area.
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
  // Executes a document.execCommand on the contentEditable editor div.
  // execCommand is deprecated but universally supported and — critically —
  // does not touch ExtJS prototypes at all. Safe for this environment.
  function execCmd(cmd, value) {
    document.getElementById('uwm-ra-editor').focus();
    document.execCommand(cmd, false, value || null);
  }

  // ── INJECT STYLES ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('uwm-ra-styles')) return;
    var style = document.createElement('style');
    style.id   = 'uwm-ra-styles';
    style.textContent = [

      /* Overlay backdrop */
      '#uwm-ra-overlay {',
      '  position: fixed; inset: 0; z-index: 999998;',
      '  background: rgba(15,20,30,0.55);',
      '  display: flex; align-items: center; justify-content: center;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '}',

      /* Main panel */
      '#uwm-ra-panel {',
      '  width: 900px; max-width: 96vw; height: 620px; max-height: 90vh;',
      '  background: #f7f8fa; border-radius: 10px;',
      '  box-shadow: 0 24px 64px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.15);',
      '  display: flex; flex-direction: column; overflow: hidden;',
      '  border: 1px solid #d0d5dd;',
      '}',

      /* Header */
      '#uwm-ra-header {',
      '  background: #1a2744; color: #fff;',
      '  padding: 12px 18px; display: flex; align-items: center; gap: 10px;',
      '  flex-shrink: 0;',
      '}',
      '#uwm-ra-header .ra-logo {',
      '  font-size: 13px; font-weight: 700; letter-spacing: 0.04em;',
      '  text-transform: uppercase; opacity: 0.9;',
      '}',
      '#uwm-ra-header .ra-version { font-size: 11px; opacity: 0.45; margin-left: auto; }',

      /* Confidence bar */
      '#uwm-ra-confidence {',
      '  display: flex; align-items: center; gap: 8px;',
      '  padding: 8px 18px; font-size: 12.5px;',
      '  border-bottom: 1px solid #e2e5ec; flex-shrink: 0;',
      '  background: #fffbf0;',
      '}',
      '#uwm-ra-confidence .ra-dot {',
      '  width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0;',
      '}',
      '.ra-dot-green  { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18); }',
      '.ra-dot-yellow { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.18); }',
      '.ra-dot-red    { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.18); }',

      /* Body: citations sidebar + editor */
      '#uwm-ra-body { display: flex; flex: 1; overflow: hidden; }',

      /* Citations sidebar */
      '#uwm-ra-citations {',
      '  width: 260px; flex-shrink: 0;',
      '  background: #1e2b45; color: #c8d0e0;',
      '  overflow-y: auto; padding: 14px 0;',
      '  display: flex; flex-direction: column;',
      '}',
      '#uwm-ra-citations .ra-cit-heading {',
      '  font-size: 10px; font-weight: 700; letter-spacing: 0.1em;',
      '  text-transform: uppercase; color: #6b7fa3;',
      '  padding: 0 14px 8px 14px;',
      '}',
      '.ra-cit-tier {',
      '  padding: 8px 14px;',
      '  border-bottom: 1px solid rgba(255,255,255,0.06);',
      '}',
      '.ra-cit-tier-label {',
      '  font-size: 10px; font-weight: 700; letter-spacing: 0.08em;',
      '  text-transform: uppercase; color: #5b7fa3; margin-bottom: 5px;',
      '}',
      '.ra-cit-item { margin-bottom: 8px; }',
      '.ra-cit-item a {',
      '  font-size: 12px; color: #7db3e8; text-decoration: none;',
      '  display: block; line-height: 1.35;',
      '}',
      '.ra-cit-item a:hover { text-decoration: underline; }',
      '.ra-cit-item .ra-cit-excerpt {',
      '  font-size: 11px; color: #8a97ae; margin-top: 2px; line-height: 1.4;',
      '}',
      '.ra-cit-none { font-size: 11px; color: #4a5a72; font-style: italic; }',
      '.ra-cit-community-note {',
      '  font-size: 10px; color: #a08050; background: rgba(245,158,11,0.12);',
      '  border-radius: 3px; padding: 2px 5px; margin-top: 3px; display: inline-block;',
      '}',

      /* Editor area */
      '#uwm-ra-editor-area {',
      '  flex: 1; display: flex; flex-direction: column; overflow: hidden;',
      '  background: #fff;',
      '}',

      /* Toolbar */
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
      '.ra-tb-sep {',
      '  width: 1px; height: 18px; background: #d0d5dd; margin: 0 4px;',
      '}',

      /* contentEditable editor */
      '#uwm-ra-editor {',
      '  flex: 1; overflow-y: auto; padding: 14px 18px;',
      '  font-size: 13.5px; font-family: "Segoe UI", system-ui, sans-serif;',
      '  line-height: 1.6; color: #1f2937; outline: none;',
      '  min-height: 0;',
      '}',
      '#uwm-ra-editor:empty:before {',
      '  content: "Draft reply will appear here…";',
      '  color: #9ca3af; pointer-events: none;',
      '}',

      /* Footer */
      '#uwm-ra-footer {',
      '  padding: 10px 16px; border-top: 1px solid #e2e5ec;',
      '  display: flex; align-items: center; gap: 10px; background: #f7f8fa;',
      '  flex-shrink: 0;',
      '}',
      '.ra-btn {',
      '  padding: 7px 18px; border-radius: 6px; font-size: 13px;',
      '  font-weight: 600; cursor: pointer; border: none; transition: background 0.15s;',
      '}',
      '#uwm-ra-insert { background: #1a5bb8; color: #fff; }',
      '#uwm-ra-insert:hover { background: #1549a0; }',
      '#uwm-ra-cancel { background: #e5e7eb; color: #374151; }',
      '#uwm-ra-cancel:hover { background: #d1d5db; }',

      /* Thumbs */
      '.ra-thumbs { display: flex; gap: 6px; margin-left: auto; }',
      '.ra-thumb-btn {',
      '  background: none; border: 1px solid #d0d5dd; border-radius: 6px;',
      '  cursor: pointer; font-size: 16px; padding: 4px 10px;',
      '  transition: background 0.15s, border-color 0.15s;',
      '}',
      '.ra-thumb-btn:hover { background: #e5e7eb; }',
      '.ra-thumb-btn.ra-thumb-selected { background: #dbeafe; border-color: #3b82f6; }',

      /* Searching indicator */
      '#uwm-ra-searching {',
      '  font-size: 12px; color: #6b7fa3; margin-left: 8px;',
      '  display: flex; align-items: center; gap: 6px;',
      '}',
      '.ra-spinner {',
      '  width: 13px; height: 13px;',
      '  border: 2px solid #d0d5dd; border-top-color: #3b82f6;',
      '  border-radius: 50%; flex-shrink: 0;',
      '  animation: ra-spin 0.7s linear infinite;',
      '}',
      '@keyframes ra-spin { to { transform: rotate(360deg); } }',

    ].join('\n');
    document.head.appendChild(style);
  }

  // ── POP-UP UI ─────────────────────────────────────────────────────────────────
  function showPopup(dialogEl, thread) {

    if (popupActive) {
      console.log(LOG, 'Pop-up already active — skipping duplicate');
      return;
    }
    popupActive = true;
    injectStyles();

    // ── Build overlay + panel ─────────────────────────────────────────────────
    var overlay = document.createElement('div');
    overlay.id  = 'uwm-ra-overlay';

    overlay.innerHTML = [
      '<div id="uwm-ra-panel">',

        // Header
        '<div id="uwm-ra-header">',
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7db3e8" stroke-width="2">',
            '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
          '</svg>',
          '<span class="ra-logo">Reply Assistant</span>',
          '<span id="uwm-ra-searching">',
            '<span class="ra-spinner"></span>',
            'Searching knowledge base…',
          '</span>',
          '<span class="ra-version">v1.7</span>',
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
                '<div class="ra-cit-community-note">⚑ Peer-generated community thread</div>',
              '</div>',
            '</div>',

            '<div class="ra-cit-tier" style="border-bottom:none;">',
              '<div class="ra-cit-tier-label">Memory Store</div>',
              '<div class="ra-cit-none">No similar past answers found</div>',
            '</div>',

          '</div>',

          // Editor area
          '<div id="uwm-ra-editor-area">',

            // Toolbar — execCommand-based, no external library
            '<div id="uwm-ra-toolbar">',
              '<button class="ra-tb-btn" data-cmd="bold"        title="Bold"><b>B</b></button>',
              '<button class="ra-tb-btn" data-cmd="italic"      title="Italic"><i>I</i></button>',
              '<button class="ra-tb-btn" data-cmd="underline"   title="Underline"><u>U</u></button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" data-cmd="insertUnorderedList" title="Bullet list">&#8226; List</button>',
              '<button class="ra-tb-btn" data-cmd="insertOrderedList"   title="Numbered list">1. List</button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" id="uwm-ra-link-btn"   title="Insert link">&#128279; Link</button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" data-cmd="removeFormat" title="Clear formatting">&#10005; Clear</button>',
            '</div>',

            // contentEditable editor — no library, no ExtJS conflict
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

    // ── Populate editor with placeholder draft ────────────────────────────────
    // In Phase 4 (search integration) this will be replaced with real content
    // assembled from KB articles and Ollama output.
    var editor = document.getElementById('uwm-ra-editor');
    editor.innerHTML = [
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

    // ── Toolbar button wiring ─────────────────────────────────────────────────
    // Wire data-cmd buttons via execCommand. Because execCommand operates on the
    // current selection inside the focused contentEditable, no library is needed.
    var tbBtns = document.querySelectorAll('#uwm-ra-toolbar .ra-tb-btn[data-cmd]');
    for (var t = 0; t < tbBtns.length; t++) {
      (function (btn) {
        btn.addEventListener('mousedown', function (e) {
          // Prevent the button click from stealing focus from the editor
          e.preventDefault();
          execCmd(btn.getAttribute('data-cmd'));
        });
      }(tbBtns[t]));
    }

    // Link button — prompt for URL then wrap selection
    document.getElementById('uwm-ra-link-btn').addEventListener('mousedown', function (e) {
      e.preventDefault();
      var url = prompt('Enter URL:', 'https://');
      if (url && url !== 'https://') {
        execCmd('createLink', url);
      }
    });

    // ── Simulate search finishing after 2s ────────────────────────────────────
    setTimeout(function () {
      var el = document.getElementById('uwm-ra-searching');
      if (el) el.innerHTML = '<span style="color:#4ade80;font-size:12px;">&#10003; Search complete</span>';
    }, 2000);

    // ── INSERT BUTTON ─────────────────────────────────────────────────────────
    // Reads innerHTML from the contentEditable div and writes it into the
    // Neurons compose editor iframe's body.
    document.getElementById('uwm-ra-insert').addEventListener('click', function () {

      var html = document.getElementById('uwm-ra-editor').innerHTML;

      if (!html || !html.trim()) {
        alert('[UWM Reply Assistant] Nothing to insert — the editor is empty.');
        return;
      }

      // Re-locate the Neurons editor iframe at insert time — not at open time —
      // to avoid stale references if ExtJS re-rendered the dialog.
      var editorIframe = getEditorIframe(dialogEl);
      if (!editorIframe) {
        alert('[UWM Reply Assistant] Could not find the Neurons compose editor. The dialog may have closed.');
        closePopup();
        return;
      }

      try {
        var editorBody = editorIframe.contentDocument.body;
        editorBody.innerHTML = html;

        // Fire an input event so Neurons registers the change in its form model
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

    // ── CANCEL BUTTON ─────────────────────────────────────────────────────────
    document.getElementById('uwm-ra-cancel').addEventListener('click', function () {
      console.log(LOG, 'Pop-up cancelled — no changes made to compose window');
      closePopup();
    });

    // ── THUMBS FEEDBACK ───────────────────────────────────────────────────────
    // Will POST to localhost:8000/store in Phase 5 (memory microservice).
    // For now they log and toggle visual state only.
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

    // ── OVERLAY CLICK TO CLOSE ────────────────────────────────────────────────
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        console.log(LOG, 'Overlay clicked — closing pop-up');
        closePopup();
      }
    });

    console.log(LOG, 'Pop-up displayed (native contentEditable editor)');
  }

  // ── CLOSE & CLEANUP ────────────────────────────────────────────────────────
  function closePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    if (overlay) overlay.remove();
    popupActive = false;
    // Reset seenDialogs so the pop-up re-triggers on the next Reply click
    seenDialogs = {};
    console.log(LOG, 'Pop-up closed — ready for next reply');
  }

  // ── DIALOG HANDLER ───────────────────────────────────────────────────────────
  // Called when a .x-frs-modal-form appears. Confirms it is a compose dialog
  // (contains an accessible editor iframe), then opens the pop-up.
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
    console.log(LOG, 'v1.7 initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }

})();
