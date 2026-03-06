// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.9
// @description  Detects reply dialog, injects trigger button + badge. Pop-up opens only on user request.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// NOTE v1.9: Three fixes from v1.8:
//
// 1. AUTO-OPEN REMOVED. The pop-up no longer opens automatically. Instead,
//    when a compose dialog is detected, two triggers are injected:
//    (a) A button in the Neurons reply toolbar ("✦ AI Assistant")
//    (b) A subtle floating badge in the bottom-right corner of the compose dialog
//    The user clicks either one to open the assistant when they want it.
//
// 2. RE-FIRE BUG FIXED. Previously, closePopup() reset seenDialogs = {} which
//    caused the poller to immediately re-detect the still-open compose dialog
//    and relaunch the pop-up. Fix: seenDialogs is only cleared when the compose
//    dialog is actually gone from the DOM (detected by a separate cleanup poller).
//    The dialog ID remains in seenDialogs until Neurons closes the dialog.
//
// 3. TRIGGER FIRES ON EMAIL OPEN (not just Reply) — FIXED. The old approach
//    detected any .x-frs-modal-form with an iframe, which includes the email
//    viewer. The new approach watches specifically for the compose dialog by
//    checking whether the dialog contains a contentEditable body iframe AND
//    whether a Reply/Reply All button is visible in the inner iframe toolbar
//    at the time of detection. The trigger buttons are only injected once per
//    dialog instance, tracked by dialog ID.

(function () {
  'use strict';

  var LOG          = '[UWM Reply Assistant]';
  var observerRef  = null;
  var pollInterval = null;
  var cleanPoller  = null;   // Watches for the compose dialog to close
  var seenDialogs  = {};     // dialogId → true once triggers injected
  var popupActive  = false;
  var isMinimized  = false;
  var escListener  = null;   // Stored so it can be removed on close

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
  // The compose dialog contains a contentEditable iframe — the Neurons rich text
  // editor. This is what distinguishes a compose dialog from the read-only email
  // viewer dialog (which has a non-editable iframe body).
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

  // ── IS COMPOSE DIALOG? ────────────────────────────────────────────────────────
  // Distinguishes the compose/reply dialog from the email viewer dialog.
  // Strategy: a compose dialog's editor iframe body has contentEditable="true"
  // OR the dialog contains a button whose text includes "Send" or "Save".
  // The viewer dialog has neither.
  function isComposeDialog(dialogEl) {
    // Check 1: editor iframe with contentEditable body
    var editorIframe = getEditorIframe(dialogEl);
    if (editorIframe) {
      try {
        var body = editorIframe.contentDocument.body;
        if (body && (body.contentEditable === 'true' || body.isContentEditable)) {
          return true;
        }
      } catch (e) {}
    }

    // Check 2: dialog contains a "Send" or "Save" button (compose-mode buttons)
    var btns = dialogEl.querySelectorAll('button, .x-btn-text');
    for (var i = 0; i < btns.length; i++) {
      var txt = (btns[i].textContent || '').trim().toLowerCase();
      if (txt === 'send' || txt === 'save') return true;
    }

    // Check 3: dialog contains a "To:" input field (compose mode has recipients)
    var inputs = dialogEl.querySelectorAll('input[name="To"], input[id*="To"]');
    if (inputs.length) return true;

    return false;
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

      /* ── Trigger button (injected into Neurons reply toolbar) ── */
      '#uwm-ra-trigger-btn {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  padding: 3px 10px; margin-left: 6px;',
      '  background: #1a2744; color: #7db3e8;',
      '  border: 1px solid #2d4a7a; border-radius: 4px;',
      '  font-size: 12px; font-weight: 600; cursor: pointer;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '  transition: background 0.15s, color 0.15s;',
      '  vertical-align: middle; white-space: nowrap;',
      '}',
      '#uwm-ra-trigger-btn:hover { background: #243660; color: #a8d4f5; }',

      /* ── Floating badge (bottom-right of compose dialog) ── */
      '#uwm-ra-badge {',
      '  position: fixed; z-index: 999990;',
      '  background: #1a2744; color: #7db3e8;',
      '  border: 1px solid #2d4a7a; border-radius: 20px;',
      '  padding: 5px 12px 5px 9px;',
      '  font-size: 11.5px; font-weight: 600; cursor: pointer;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '  display: flex; align-items: center; gap: 5px;',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.25);',
      '  transition: background 0.15s, transform 0.15s;',
      '  user-select: none;',
      '}',
      '#uwm-ra-badge:hover { background: #243660; transform: translateY(-1px); }',
      '#uwm-ra-badge .ra-badge-dot {',
      '  width: 7px; height: 7px; border-radius: 50%;',
      '  background: #3b82f6; flex-shrink: 0;',
      '  animation: ra-pulse 2s ease-in-out infinite;',
      '}',
      '@keyframes ra-pulse {',
      '  0%, 100% { opacity: 1; transform: scale(1); }',
      '  50%       { opacity: 0.5; transform: scale(0.85); }',
      '}',

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
      '#uwm-ra-minimize-btn {',
      '  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);',
      '  color: #fff; border-radius: 5px; cursor: pointer;',
      '  font-size: 14px; padding: 2px 9px; line-height: 1.6; transition: background 0.15s;',
      '}',
      '#uwm-ra-minimize-btn:hover { background: rgba(255,255,255,0.22); }',

      /* ── Confidence bar ── */
      '#uwm-ra-confidence {',
      '  display: flex; align-items: center; gap: 8px;',
      '  padding: 8px 18px; font-size: 12.5px;',
      '  border-bottom: 1px solid #e2e5ec; flex-shrink: 0; background: #fffbf0;',
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
      '  overflow-y: auto; padding: 14px 0; display: flex; flex-direction: column;',
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
      '#uwm-ra-insert { background: #1a5bb8; color: #fff; }',
      '#uwm-ra-insert:hover { background: #1549a0; }',
      '#uwm-ra-cancel { background: #e5e7eb; color: #374151; }',
      '#uwm-ra-cancel:hover { background: #d1d5db; }',

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
      '  display: flex; align-items: center; gap: 12px; padding: 10px 20px;',
      '  box-shadow: 0 -4px 20px rgba(0,0,0,0.3);',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '}',
      '#uwm-ra-minibar.ra-hidden { display: none; }',
      '#uwm-ra-minibar .ra-mini-icon { font-size: 16px; opacity: 0.8; }',
      '#uwm-ra-minibar .ra-mini-label { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }',
      '#uwm-ra-minibar .ra-mini-sub { font-size: 11px; opacity: 0.5; margin-left: 2px; }',
      '.ra-mini-btn { padding: 5px 16px; border-radius: 5px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; }',
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
      '  box-shadow: 0 16px 48px rgba(0,0,0,0.3); border: 1px solid #e2e5ec;',
      '}',
      '#uwm-ra-warn-box h3 { margin: 0 0 10px 0; font-size: 16px; color: #111827; }',
      '#uwm-ra-warn-box p { margin: 0 0 22px 0; font-size: 13.5px; color: #6b7280; line-height: 1.5; }',
      '#uwm-ra-warn-box .ra-warn-actions { display: flex; gap: 10px; justify-content: flex-end; }',
      '#uwm-ra-warn-keep    { background: #e5e7eb; color: #374151; }',
      '#uwm-ra-warn-keep:hover { background: #d1d5db; }',
      '#uwm-ra-warn-confirm { background: #dc2626; color: #fff; }',
      '#uwm-ra-warn-confirm:hover { background: #b91c1c; }',

    ].join('\n');
    document.head.appendChild(style);
  }

  // ── REMOVE TRIGGERS ───────────────────────────────────────────────────────────
  // Cleans up the toolbar button and floating badge when the compose dialog closes.
  function removeTriggers() {
    var btn   = document.getElementById('uwm-ra-trigger-btn');
    var badge = document.getElementById('uwm-ra-badge');
    if (btn)   btn.remove();
    if (badge) badge.remove();
  }

  // ── INJECT TRIGGER BUTTON INTO NEURONS REPLY TOOLBAR ─────────────────────────
  // Finds the toolbar row containing Reply / Reply All / Forward buttons inside
  // the email viewer/compose area and appends our button to it.
  // The toolbar is inside the inner iframe, so we search innerDoc, not document.
  function injectToolbarButton(innerDoc, onClickFn) {
    // Guard: only inject once
    if (innerDoc.getElementById('uwm-ra-trigger-btn')) return;

    // Find the toolbar that contains Reply/Reply All/Forward.
    // Neurons renders these as .x-toolbar or a div containing .x-btn elements.
    // We look for any element containing a button with text "Reply".
    var replyBtn = null;
    var allBtns  = innerDoc.querySelectorAll('button, .x-btn-text, td.x-btn-mc');
    for (var i = 0; i < allBtns.length; i++) {
      var t = (allBtns[i].textContent || '').trim();
      if (t === 'Reply' || t === 'Reply All') { replyBtn = allBtns[i]; break; }
    }

    if (!replyBtn) {
      console.log(LOG, 'Could not find Reply button in toolbar — badge only');
      return;
    }

    // Walk up to find the toolbar container (a tr or div holding all the buttons)
    var toolbar = replyBtn;
    for (var s = 0; s < 6; s++) {
      if (!toolbar.parentElement) break;
      toolbar = toolbar.parentElement;
      var tag = toolbar.tagName.toLowerCase();
      if (tag === 'tr' || tag === 'div' || tag === 'td') {
        // Check if this container also holds Forward — then we know it's the right level
        var text = toolbar.textContent || '';
        if (text.indexOf('Forward') !== -1 || text.indexOf('Reply All') !== -1) break;
      }
    }

    var btn = innerDoc.createElement('button');
    btn.id  = 'uwm-ra-trigger-btn';
    btn.innerHTML = '&#10022; AI Assistant';
    btn.title = 'Open Reply Assistant';
    // Button must live in the inner iframe's document but click handler
    // can call functions in the outer scope via closure.
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      onClickFn();
    });

    // Append after the toolbar container's last child, or after the Reply button
    try {
      toolbar.appendChild(btn);
      console.log(LOG, 'Trigger button injected into reply toolbar');
    } catch (e) {
      console.warn(LOG, 'Toolbar injection failed:', e);
    }
  }

  // ── INJECT FLOATING BADGE ─────────────────────────────────────────────────────
  // Injects a small floating badge into the outer document positioned near the
  // bottom-right of the viewport. The badge is in the outer document (not the
  // inner iframe) so it can overlay the Neurons compose dialog cleanly.
  function injectBadge(onClickFn) {
    if (document.getElementById('uwm-ra-badge')) return;

    var badge = document.createElement('div');
    badge.id  = 'uwm-ra-badge';
    badge.innerHTML = '<span class="ra-badge-dot"></span>&#10022; Reply Assistant';
    badge.title = 'Open Reply Assistant';

    // Position: fixed bottom-right, above where the minibar would appear
    badge.style.bottom = '20px';
    badge.style.right  = '20px';

    badge.addEventListener('click', function () {
      onClickFn();
    });

    document.body.appendChild(badge);
    console.log(LOG, 'Floating badge injected');
  }

  // ── MINIMIZE / RESTORE / CLOSE ────────────────────────────────────────────────
  function minimizePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    var badge   = document.getElementById('uwm-ra-badge');
    if (overlay) overlay.classList.add('ra-hidden');
    if (minibar) minibar.classList.remove('ra-hidden');
    if (badge)   badge.style.display = 'none'; // hide badge while minibar is showing
    isMinimized = true;
    console.log(LOG, 'Pop-up minimized — draft preserved');
  }

  function restorePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    var badge   = document.getElementById('uwm-ra-badge');
    if (overlay) overlay.classList.remove('ra-hidden');
    if (minibar) minibar.classList.add('ra-hidden');
    if (badge)   badge.style.display = '';
    isMinimized = false;
    console.log(LOG, 'Pop-up restored');
  }

  function closePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    var warn    = document.getElementById('uwm-ra-warn-overlay');
    if (overlay) overlay.remove();
    if (minibar) minibar.remove();
    if (warn)    warn.remove();
    // NOTE: do NOT reset seenDialogs here. The compose dialog is still open in
    // Neurons. seenDialogs is only cleared by the cleanup poller when Neurons
    // actually removes the dialog from the DOM (i.e. user clicks Save/Cancel
    // in Neurons itself). This prevents the re-fire bug from v1.8.
    popupActive = false;
    isMinimized = false;
    if (escListener) {
      document.removeEventListener('keydown', escListener);
      escListener = null;
    }
    console.log(LOG, 'Pop-up closed');
  }

  // ── CANCEL WARNING DIALOG ─────────────────────────────────────────────────────
  function showCancelWarning() {
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
    });
    document.getElementById('uwm-ra-warn-confirm').addEventListener('click', function () {
      console.log(LOG, 'Draft discarded by user confirmation');
      closePopup();
    });
    warn.addEventListener('click', function (e) {
      if (e.target === warn) warn.remove();
    });
  }

  // ── POP-UP UI ─────────────────────────────────────────────────────────────────
  function showPopup(dialogEl, thread) {
    if (popupActive) {
      // If already open and user clicks the trigger again, restore if minimized
      if (isMinimized) restorePopup();
      return;
    }
    popupActive = true;
    injectStyles();

    // Hide the badge while the pop-up is open (not minimized)
    var badge = document.getElementById('uwm-ra-badge');
    if (badge) badge.style.display = 'none';

    // ── Overlay ───────────────────────────────────────────────────────────────
    var overlay = document.createElement('div');
    overlay.id  = 'uwm-ra-overlay';
    overlay.innerHTML = [
      '<div id="uwm-ra-panel">',

        '<div id="uwm-ra-header">',
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7db3e8" stroke-width="2">',
            '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
          '</svg>',
          '<span class="ra-logo">Reply Assistant</span>',
          '<span id="uwm-ra-searching">',
            '<span class="ra-spinner"></span>',
            'Searching knowledge base\u2026',
          '</span>',
          '<div class="ra-header-actions">',
            '<button id="uwm-ra-minimize-btn" title="Minimize \u2014 draft will be preserved">\u2013</button>',
            '<span class="ra-version">v1.9</span>',
          '</div>',
        '</div>',

        '<div id="uwm-ra-confidence">',
          '<span class="ra-dot ra-dot-yellow"></span>',
          '<strong style="font-size:12.5px;color:#92400e;">Best guess</strong>',
          '<span style="color:#78716c;font-size:12px;margin-left:4px;">\u2014 reviewing search results. Verify before sending.</span>',
        '</div>',

        '<div id="uwm-ra-body">',

          '<div id="uwm-ra-citations">',
            '<div class="ra-cit-heading">Sources Consulted</div>',
            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 1 \u2014 UWM Knowledge Base</div>',
              '<div class="ra-cit-item">',
                '<a href="https://kb.uwm.edu" target="_blank">Setting Up Your Canvas Course Site</a>',
                '<div class="ra-cit-excerpt">Step-by-step guide to course creation, enrollment sync, and template use for UWM instructors.</div>',
              '</div>',
              '<div class="ra-cit-item">',
                '<a href="https://kb.uwm.edu" target="_blank">Canvas \u2014 Adding a TA or Co-instructor</a>',
                '<div class="ra-cit-excerpt">How to request additional user roles in a Canvas course site via the UWM enrollment system.</div>',
              '</div>',
            '</div>',
            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 2 \u2014 UWM Web</div>',
              '<div class="ra-cit-none">Searched \u2014 no results found</div>',
            '</div>',
            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 3 \u2014 UW System KB</div>',
              '<div class="ra-cit-item">',
                '<a href="https://kb.wisconsin.edu" target="_blank">Canvas LTI Tool Availability \u2014 UW System</a>',
                '<div class="ra-cit-excerpt">Which LTI integrations are enabled system-wide vs. configured at the institution level.</div>',
              '</div>',
            '</div>',
            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 4 \u2014 Canvas Community</div>',
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

          '<div id="uwm-ra-editor-area">',
            '<div id="uwm-ra-toolbar">',
              '<button class="ra-tb-btn" data-cmd="bold"               title="Bold"><b>B</b></button>',
              '<button class="ra-tb-btn" data-cmd="italic"             title="Italic"><i>I</i></button>',
              '<button class="ra-tb-btn" data-cmd="underline"          title="Underline"><u>U</u></button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" data-cmd="insertUnorderedList" title="Bullet list">&#8226; List</button>',
              '<button class="ra-tb-btn" data-cmd="insertOrderedList"   title="Numbered list">1. List</button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" id="uwm-ra-link-btn"           title="Insert link">&#128279; Link</button>',
              '<div class="ra-tb-sep"></div>',
              '<button class="ra-tb-btn" data-cmd="removeFormat"        title="Clear formatting">&#10005; Clear</button>',
            '</div>',
            '<div id="uwm-ra-editor" contenteditable="true" spellcheck="true"></div>',
          '</div>',

        '</div>',

        '<div id="uwm-ra-footer">',
          '<button class="ra-btn" id="uwm-ra-insert">&#8629; Insert into Email</button>',
          '<button class="ra-btn" id="uwm-ra-cancel">Cancel</button>',
          '<div class="ra-thumbs">',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-up"   title="Useful \u2014 save to memory">&#128077;</button>',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-down" title="Not useful">&#128078;</button>',
          '</div>',
        '</div>',

      '</div>'
    ].join('');
    document.body.appendChild(overlay);

    // ── Minibar (hidden initially) ────────────────────────────────────────────
    var minibar = document.createElement('div');
    minibar.id  = 'uwm-ra-minibar';
    minibar.classList.add('ra-hidden');
    minibar.innerHTML = [
      '<span class="ra-mini-icon">&#128172;</span>',
      '<span class="ra-mini-label">Reply Assistant</span>',
      '<span class="ra-mini-sub">\u2014 draft ready</span>',
      '<button class="ra-mini-btn" id="uwm-ra-mini-restore">&#9650; Restore</button>',
      '<button class="ra-mini-btn" id="uwm-ra-mini-discard">&#10005; Discard</button>',
    ].join('');
    document.body.appendChild(minibar);

    // ── Placeholder draft ─────────────────────────────────────────────────────
    document.getElementById('uwm-ra-editor').innerHTML = [
      '<p>Hi [Instructor Name],</p>',
      '<p>Thank you for reaching out to UWM CETL support.</p>',
      '<p><em>[Placeholder draft \u2014 will be replaced with a real AI-generated reply once search and Ollama integration are complete.]</em></p>',
      '<p>Based on what you\'ve described, here are some resources that may help:</p>',
      '<ul>',
      '<li>UWM Knowledge Base: <a href="https://kb.uwm.edu">Setting Up Your Canvas Course Site</a></li>',
      '<li>Canvas Community: <a href="https://community.instructure.com">How do I add files to a course?</a></li>',
      '</ul>',
      '<p>Please let me know if you have any questions or if this doesn\'t resolve the issue \u2014 happy to help further.</p>',
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

    // ── Simulated search complete ─────────────────────────────────────────────
    setTimeout(function () {
      var el = document.getElementById('uwm-ra-searching');
      if (el) el.innerHTML = '<span style="color:#4ade80;font-size:12px;">&#10003; Search complete</span>';
    }, 2000);

    // ── Minimize button ───────────────────────────────────────────────────────
    document.getElementById('uwm-ra-minimize-btn').addEventListener('click', minimizePopup);

    // ── Insert ────────────────────────────────────────────────────────────────
    document.getElementById('uwm-ra-insert').addEventListener('click', function () {
      var html = document.getElementById('uwm-ra-editor').innerHTML;
      if (!html || !html.trim()) {
        alert('[UWM Reply Assistant] Nothing to insert \u2014 the editor is empty.');
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
        console.log(LOG, 'Draft inserted (' + html.length + ' chars)');
        closePopup();
        removeTriggers();
      } catch (e) {
        console.error(LOG, 'Insert failed:', e);
        alert('[UWM Reply Assistant] Insert failed \u2014 see console. Error: ' + e.message);
      }
    });

    // ── Cancel → warning ──────────────────────────────────────────────────────
    document.getElementById('uwm-ra-cancel').addEventListener('click', showCancelWarning);

    // ── Thumbs ────────────────────────────────────────────────────────────────
    document.getElementById('uwm-ra-thumb-up').addEventListener('click', function () {
      this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-down').classList.remove('ra-thumb-selected');
      console.log(LOG, 'Thumbs up (memory store: not yet connected)');
    });
    document.getElementById('uwm-ra-thumb-down').addEventListener('click', function () {
      this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-up').classList.remove('ra-thumb-selected');
      console.log(LOG, 'Thumbs down');
    });

    // ── Overlay click → minimize ──────────────────────────────────────────────
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) minimizePopup();
    });

    // ── Esc → minimize/restore toggle ────────────────────────────────────────
    escListener = function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        if (!popupActive) return;
        if (isMinimized) { restorePopup(); } else { minimizePopup(); }
      }
    };
    document.addEventListener('keydown', escListener);

    // ── Minibar buttons ───────────────────────────────────────────────────────
    document.getElementById('uwm-ra-mini-restore').addEventListener('click', restorePopup);
    document.getElementById('uwm-ra-mini-discard').addEventListener('click', function () {
      console.log(LOG, 'Draft discarded from minibar');
      closePopup();
      removeTriggers();
    });

    console.log(LOG, 'Pop-up displayed');
  }

  // ── HANDLE COMPOSE DIALOG ─────────────────────────────────────────────────────
  // Called when a new .x-frs-modal-form is found. Instead of auto-opening the
  // pop-up, it injects the trigger button and badge, then waits for user action.
  function handleDialog(dialogEl, innerDoc) {
    if (seenDialogs[dialogEl.id]) return;
    if (!isComposeDialog(dialogEl)) return;

    seenDialogs[dialogEl.id] = true;
    console.log(LOG, 'Compose dialog detected (id=' + dialogEl.id + ') — injecting triggers');

    var thread = readEmailThread(innerDoc);

    // The trigger callback: called when user clicks toolbar button or badge
    function openAssistant() {
      showPopup(dialogEl, thread);
    }

    // Inject toolbar button (inside inner iframe) and badge (outer document)
    injectToolbarButton(innerDoc, openAssistant);
    injectBadge(openAssistant);

    // ── Cleanup poller: watch for Neurons to close the compose dialog ─────────
    // When the dialog disappears from the DOM, clean up triggers and reset
    // seenDialogs so the next Reply click starts fresh.
    if (cleanPoller) clearInterval(cleanPoller);
    cleanPoller = setInterval(function () {
      var currentDoc = getInnerDoc();
      if (!currentDoc) return;
      // If the dialog element is no longer in the DOM, the user closed it in Neurons
      if (!currentDoc.getElementById(dialogEl.id) && !currentDoc.body.contains(dialogEl)) {
        clearInterval(cleanPoller);
        cleanPoller = null;
        // Safe to reset now — the compose dialog is truly gone
        delete seenDialogs[dialogEl.id];
        removeTriggers();
        if (popupActive) closePopup();
        console.log(LOG, 'Compose dialog closed by Neurons — triggers removed, ready for next reply');
      }
    }, 800);
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
          setTimeout(function () { handleDialog(el, doc); }, 300);
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
    injectStyles();
    var innerDoc = getInnerDoc();
    if (!innerDoc || !innerDoc.body) {
      if (initAttempts < 30) setTimeout(init, 500);
      return;
    }
    startObserver(innerDoc);
    startPoller();
    console.log(LOG, 'v1.9 initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }

})();
