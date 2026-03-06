// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.6
// @description  Detects reply dialog, shows AI-assisted drafting pop-up with citations panel and rich text editor.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// @require      https://cdn.quilljs.com/1.3.7/quill.min.js
// ==/UserScript==

(function () {
  'use strict';

  var LOG = '[UWM Reply Assistant]';
  var observerRef  = null;
  var pollInterval = null;
  var seenDialogs  = {};
  var popupActive  = false;  // Prevent multiple pop-ups from stacking

  // ── QUILL CSS INJECTION ───────────────────────────────────────────────────────
  // Quill's stylesheet must be injected into the page since @require only loads JS.
  // We inject it into the outer document's <head> once on script load.
  function injectQuillCSS() {
    if (document.getElementById('uwm-quill-css')) return;
    var link = document.createElement('link');
    link.id  = 'uwm-quill-css';
    link.rel  = 'stylesheet';
    link.href = 'https://cdn.quilljs.com/1.3.7/quill.snow.css';
    document.head.appendChild(link);
  }

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

  // ── POP-UP UI ─────────────────────────────────────────────────────────────────
  // Creates and injects the reply assistant pop-up into the outer document body.
  // The pop-up floats above everything, including the Neurons inner iframe.
  // It must be injected into the outer document (not the inner iframe) so it
  // can reliably overlap the Neurons compose dialog.
  function showPopup(dialogEl, thread) {

    if (popupActive) {
      console.log(LOG, 'Pop-up already active — skipping duplicate');
      return;
    }
    popupActive = true;

    // ── Inject pop-up styles into outer document ──────────────────────────────
    if (!document.getElementById('uwm-ra-styles')) {
      var style = document.createElement('style');
      style.id  = 'uwm-ra-styles';
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

        /* Header bar */
        '#uwm-ra-header {',
        '  background: #1a2744; color: #fff;',
        '  padding: 12px 18px; display: flex; align-items: center; gap: 10px;',
        '  flex-shrink: 0;',
        '}',
        '#uwm-ra-header .ra-logo {',
        '  font-size: 13px; font-weight: 700; letter-spacing: 0.04em;',
        '  text-transform: uppercase; opacity: 0.9;',
        '}',
        '#uwm-ra-header .ra-version {',
        '  font-size: 11px; opacity: 0.45; margin-left: auto;',
        '}',

        /* Confidence badge */
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
        '#uwm-ra-body {',
        '  display: flex; flex: 1; overflow: hidden;',
        '}',

        /* Citations panel */
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
        '.ra-cit-item {',
        '  margin-bottom: 8px;',
        '}',
        '.ra-cit-item a {',
        '  font-size: 12px; color: #7db3e8; text-decoration: none;',
        '  display: block; line-height: 1.35;',
        '}',
        '.ra-cit-item a:hover { text-decoration: underline; }',
        '.ra-cit-item .ra-cit-excerpt {',
        '  font-size: 11px; color: #8a97ae; margin-top: 2px; line-height: 1.4;',
        '}',
        '.ra-cit-none {',
        '  font-size: 11px; color: #4a5a72; font-style: italic; padding: 0 14px;',
        '}',
        '.ra-cit-community-note {',
        '  font-size: 10px; color: #a08050; background: rgba(245,158,11,0.12);',
        '  border-radius: 3px; padding: 2px 5px; margin-top: 3px; display: inline-block;',
        '}',

        /* Editor area */
        '#uwm-ra-editor-area {',
        '  flex: 1; display: flex; flex-direction: column; overflow: hidden;',
        '  background: #fff;',
        '}',
        '#uwm-ra-quill-container {',
        '  flex: 1; overflow-y: auto;',
        '  display: flex; flex-direction: column;',
        '}',
        '#uwm-ra-quill-container .ql-container {',
        '  flex: 1; font-size: 13.5px; font-family: "Segoe UI", system-ui, sans-serif;',
        '  border: none !important;',
        '}',
        '#uwm-ra-quill-container .ql-toolbar {',
        '  border-left: none !important; border-right: none !important;',
        '  border-top: none !important; border-bottom: 1px solid #e2e5ec !important;',
        '  background: #f7f8fa;',
        '}',
        '#uwm-ra-quill-container .ql-editor { min-height: 200px; padding: 14px 18px; }',

        /* Footer / action bar */
        '#uwm-ra-footer {',
        '  padding: 10px 16px; border-top: 1px solid #e2e5ec;',
        '  display: flex; align-items: center; gap: 10px; background: #f7f8fa;',
        '  flex-shrink: 0;',
        '}',
        '.ra-btn {',
        '  padding: 7px 18px; border-radius: 6px; font-size: 13px;',
        '  font-weight: 600; cursor: pointer; border: none; transition: background 0.15s;',
        '}',
        '#uwm-ra-insert {',
        '  background: #1a5bb8; color: #fff;',
        '}',
        '#uwm-ra-insert:hover { background: #1549a0; }',
        '#uwm-ra-cancel {',
        '  background: #e5e7eb; color: #374151;',
        '}',
        '#uwm-ra-cancel:hover { background: #d1d5db; }',

        /* Thumbs feedback */
        '.ra-thumbs { display: flex; gap: 6px; margin-left: auto; }',
        '.ra-thumb-btn {',
        '  background: none; border: 1px solid #d0d5dd; border-radius: 6px;',
        '  cursor: pointer; font-size: 16px; padding: 4px 10px;',
        '  transition: background 0.15s, border-color 0.15s;',
        '}',
        '.ra-thumb-btn:hover { background: #e5e7eb; }',
        '.ra-thumb-btn.ra-thumb-selected { background: #dbeafe; border-color: #3b82f6; }',

        /* Searching spinner */
        '#uwm-ra-searching {',
        '  font-size: 12px; color: #6b7fa3; margin-left: 8px;',
        '  display: flex; align-items: center; gap: 6px;',
        '}',
        '.ra-spinner {',
        '  width: 13px; height: 13px;',
        '  border: 2px solid #d0d5dd; border-top-color: #3b82f6;',
        '  border-radius: 50%;',
        '  animation: ra-spin 0.7s linear infinite;',
        '  flex-shrink: 0;',
        '}',
        '@keyframes ra-spin { to { transform: rotate(360deg); } }',

      ].join('\n');
      document.head.appendChild(style);
    }

    // ── Build DOM ─────────────────────────────────────────────────────────────

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
          '<span class="ra-version">v1.6 — Shell</span>',
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
            '<div id="uwm-ra-quill-container"></div>',
          '</div>',

        '</div>',

        // Footer
        '<div id="uwm-ra-footer">',
          '<button class="ra-btn" id="uwm-ra-insert">↩ Insert into Email</button>',
          '<button class="ra-btn" id="uwm-ra-cancel">Cancel</button>',
          '<div class="ra-thumbs">',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-up"   title="This draft is useful — save to memory">👍</button>',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-down" title="This draft is not useful">👎</button>',
          '</div>',
        '</div>',

      '</div>'
    ].join('');

    document.body.appendChild(overlay);

    // ── Initialize Quill ──────────────────────────────────────────────────────
    // Quill was loaded via @require, so it should be available as window.Quill.
    var quill = null;
    var quillContainer = document.getElementById('uwm-ra-quill-container');

    if (typeof Quill !== 'undefined') {
      // Create a div inside the container for Quill to mount into
      var quillMount = document.createElement('div');
      quillMount.id = 'uwm-ra-quill-editor';
      quillContainer.appendChild(quillMount);

      quill = new Quill('#uwm-ra-quill-editor', {
        theme: 'snow',
        placeholder: 'Draft reply will appear here…',
        modules: {
          toolbar: [
            [{ 'header': [1, 2, 3, false] }],
            ['bold', 'italic', 'underline'],
            [{ 'list': 'ordered' }, { 'list': 'bullet' }],
            ['link'],
            ['clean']
          ]
        }
      });

      // Placeholder draft content — will be replaced by actual AI output in later phases
      quill.root.innerHTML = [
        '<p>Hi [Instructor Name],</p>',
        '<p>Thank you for reaching out to UWM CETL support.</p>',
        '<p><em>[Placeholder draft — this area will be populated with a real AI-generated reply once search and Ollama integration are complete in a later development phase.]</em></p>',
        '<p>Based on what you\'ve described, here are some resources that may help:</p>',
        '<ul>',
        '<li>UWM Knowledge Base article: <a href="https://kb.uwm.edu">Setting Up Your Canvas Course Site</a></li>',
        '<li>Canvas Community: <a href="https://community.instructure.com">How do I add files to a course?</a></li>',
        '</ul>',
        '<p>Please let me know if you have any questions or if this doesn\'t resolve the issue — happy to help further.</p>',
        '<p>Best,<br>Lane<br>CETL Teaching, Learning &amp; Technology Consultant</p>'
      ].join('');

      console.log(LOG, 'Quill editor initialized');
    } else {
      // Fallback if Quill didn't load — plain textarea
      console.warn(LOG, 'Quill not available — falling back to textarea');
      quillContainer.innerHTML = '<textarea id="uwm-ra-textarea" style="width:100%;height:100%;padding:14px 18px;border:none;resize:none;font-size:13.5px;font-family:Segoe UI,sans-serif;outline:none;">[Placeholder draft — Quill failed to load. Check @require URL.]</textarea>';
    }

    // ── Simulate search finishing after 2s (placeholder behavior) ─────────────
    // In the real implementation, this will resolve when actual search completes.
    setTimeout(function () {
      var searchingEl = document.getElementById('uwm-ra-searching');
      if (searchingEl) {
        searchingEl.innerHTML = '<span style="color:#4ade80;font-size:12px;">✓ Search complete</span>';
      }
    }, 2000);

    // ── INSERT BUTTON ─────────────────────────────────────────────────────────
    // Writes the Quill editor's HTML content into the Neurons compose window.
    // Strategy: find the editor iframe inside the compose dialog, then write
    // to its contentDocument.body (Neurons uses contentEditable, not designMode).
    document.getElementById('uwm-ra-insert').addEventListener('click', function () {

      var html = '';
      if (quill) {
        html = quill.root.innerHTML;
      } else {
        var ta = document.getElementById('uwm-ra-textarea');
        if (ta) html = ta.value.replace(/\n/g, '<br>');
      }

      if (!html || !html.trim()) {
        alert('[UWM Reply Assistant] Nothing to insert — the editor is empty.');
        return;
      }

      // Re-locate the editor iframe at insert time — don't use a captured
      // reference since the DOM may have shifted since the pop-up opened.
      var editorIframe = getEditorIframe(dialogEl);
      if (!editorIframe) {
        alert('[UWM Reply Assistant] Could not find the Neurons email compose editor. The dialog may have closed.');
        closePopup();
        return;
      }

      try {
        var editorBody = editorIframe.contentDocument.body;

        // Clear existing content and write the draft
        editorBody.innerHTML = html;

        // Trigger an input event so Neurons registers the change in its form state
        var inputEvent = editorIframe.contentDocument.createEvent('Event');
        inputEvent.initEvent('input', true, true);
        editorBody.dispatchEvent(inputEvent);

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
    // In Phase 3 (memory microservice), thumbs-up will POST the Q&A pair to
    // localhost:8000/store. For now, they just log and toggle visual state.
    document.getElementById('uwm-ra-thumb-up').addEventListener('click', function () {
      this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-down').classList.remove('ra-thumb-selected');
      console.log(LOG, 'Thumbs up — answer marked as useful (memory store: not yet connected)');
    });

    document.getElementById('uwm-ra-thumb-down').addEventListener('click', function () {
      this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-up').classList.remove('ra-thumb-selected');
      console.log(LOG, 'Thumbs down — answer marked as not useful');
    });

    // ── OVERLAY CLICK TO CLOSE (optional safety valve) ────────────────────────
    // Clicking the dark overlay outside the panel closes the pop-up.
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        console.log(LOG, 'Overlay clicked — closing pop-up');
        closePopup();
      }
    });

    console.log(LOG, 'Pop-up UI displayed');
  }

  // ── CLOSE & CLEANUP ────────────────────────────────────────────────────────
  function closePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    if (overlay) overlay.remove();
    popupActive = false;

    // Clear seenDialogs so the pop-up can re-trigger on the next Reply click
    seenDialogs = {};

    console.log(LOG, 'Pop-up closed — ready for next reply');
  }

  // ── DIALOG HANDLER ───────────────────────────────────────────────────────────
  // Called when a new .x-frs-modal-form is detected in the inner iframe.
  // Confirms it is a compose dialog (has an editable iframe inside), then
  // reads the email thread and shows the pop-up.
  function handleDialog(dialogEl, innerDoc) {
    if (seenDialogs[dialogEl.id]) return;

    // Confirm compose mode: the dialog must contain an iframe with an
    // accessible body — this is the Neurons rich text compose editor.
    var editorIframe = getEditorIframe(dialogEl);
    if (!editorIframe) return;

    seenDialogs[dialogEl.id] = true;
    console.log(LOG, 'Compose dialog detected (id=' + dialogEl.id + ')');

    var thread = readEmailThread(innerDoc);
    showPopup(dialogEl, thread);
  }

  // ── POLL FALLBACK ────────────────────────────────────────────────────────────
  // Polls every 500ms with a fresh getInnerDoc() call to catch dialogs that the
  // MutationObserver may miss (e.g., ExtJS rendering in two passes).
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
  // Watches the inner iframe's body for new .x-frs-modal-form elements.
  // Uses a 250ms delay before calling handleDialog to allow ExtJS to finish
  // rendering the dialog's internal components (particularly the editor iframe).
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
    injectQuillCSS();

    var innerDoc = getInnerDoc();
    if (!innerDoc || !innerDoc.body) {
      if (initAttempts < 30) setTimeout(init, 500);
      return;
    }

    startObserver(innerDoc);
    startPoller();
    console.log(LOG, 'v2.0 initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }

})();
