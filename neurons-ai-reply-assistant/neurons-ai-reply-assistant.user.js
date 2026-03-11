// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.18
// @description  Detects reply/compose dialog, injects AI-assist pop-up with native contentEditable editor.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// ── CHANGES IN v1.18 ─────────────────────────────────────────────────────────
//
// BUG 1 FIXED — Triggers appearing before Reply is clicked (snapshot timing):
//   Root cause: init() runs ~1s after page load, but the email viewer modal is
//   lazy-loaded by Neurons AFTER that 1s mark. Snapshot found 0 dialogs, so
//   when the viewer appeared the poller treated it as a new compose dialog.
//   Fix: Rolling re-snapshot for the first 10 poller ticks (5 seconds). During
//   this grace period every dialog found is added to knownDialogIds instead of
//   being passed to handleDialog(). After tick 10, normal handleDialog() runs.
//
// BUG 2 FIXED — Corollary of Bug 1. Resolves automatically once Bug 1 is fixed.
//
// BUG 3 FIXED — Insert button does nothing:
//   Primary fix: resolved by Bug 1 fix (triggers now go on compose dialog).
//   Additional hardening in getEditorIframe(): also checks
//     fr.contentDocument.designMode === 'on'
//   as a secondary detection path (ExtJS uses designMode, not contenteditable attr).
//   insertDraftAtTop() now uses insertAdjacentHTML('afterbegin') instead of the
//   manual node-prepend loop to avoid node-adoption edge cases.
//   isComposeDialog() PRIMARY check is now iframe editability (isContentEditable
//   or designMode=on), since BOTH viewer and compose dialogs have .x-html-editor-tb.
//
// BUG 4 FIXED — Cancel and Minimize buttons non-functional:
//   Added e.stopPropagation() to Cancel and Minimize button click handlers.
//   Added pointer-events: all to #uwm-ra-panel and all button elements in CSS.
//
// BUG 5 FIXED — After Discard from minibar, AI Assistant access is gone:
//   In the minibar Discard handler, delete seenDialogs[dialogEl.id] after
//   closePopup() + removeTriggers(), so the poller re-processes the dialog.
(function () {
  'use strict';
  var LOG          = '[UWM Reply Assistant]';
  var pollInterval = null;
  var cleanPoller  = null;
  var seenDialogs  = {};
  var knownDialogIds = {};
  var popupActive  = false;
  var isMinimized  = false;
  var escListener  = null;
  // ── FRAME HELPERS ─────────────────────────────────────────────────────────────
  function getAppFrame() {
    var frames = document.querySelectorAll('iframe.x-managed-iframe');
    var best = null, bestWidth = 0;
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentDocument && frames[i].offsetWidth > bestWidth) {
          best      = frames[i];
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
  // ── ROLLING SNAPSHOT (Bug 1 fix) ─────────────────────────────────────────────
  // pollTickCount tracks how many poller ticks have fired. For the first
  // SNAPSHOT_TICKS ticks, every dialog found is added to knownDialogIds (grace
  // period). After that, normal handleDialog() behaviour resumes. This gives
  // Neurons time to fully render the email viewer modal before we start watching
  // for new compose dialogs.
  var pollTickCount   = 0;
  var SNAPSHOT_TICKS  = 10; // 10 × 500 ms = 5 seconds
  function takeSnapshot() {
    var innerDoc = getInnerDoc();
    if (!innerDoc) return;
    var existing = innerDoc.querySelectorAll('.x-frs-modal-form');
    var added = 0;
    for (var i = 0; i < existing.length; i++) {
      if (!knownDialogIds[existing[i].id]) {
        knownDialogIds[existing[i].id] = true;
        added++;
      }
    }
    if (added > 0) {
      console.log(LOG, 'Snapshot — added ' + added + ' dialog(s) to knownDialogIds (total known: ' + Object.keys(knownDialogIds).length + ')');
    }
  }
  // ── EMAIL THREAD READER ───────────────────────────────────────────────────────
  function readEmailThread(innerDoc) {
    var items  = innerDoc.querySelectorAll('.flex-list-item-mail');
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
  // ── FIND COMPOSE EDITOR IFRAME (Bug 3 hardening) ──────────────────────────────
  // Primary check: body.isContentEditable === true (boolean).
  // Secondary check: fr.contentDocument.designMode === 'on' (ExtJS uses designMode).
  // Both viewer and compose have .x-html-editor-tb, so iframe editability is
  // the only reliable distinguisher.
  function getEditorIframe(dialogEl) {
    var iframes  = dialogEl.querySelectorAll('iframe');
    var fallback = null;
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (!doc || !doc.body) continue;
        if (doc.body.isContentEditable || doc.designMode === 'on') {
          console.log(LOG, 'getEditorIframe: editable iframe at index ' + i +
            ' (isContentEditable=' + doc.body.isContentEditable +
            ' designMode=' + doc.designMode + ')');
          return iframes[i];
        }
        if (!fallback) fallback = iframes[i];
      } catch (e) {}
    }
    if (fallback) console.log(LOG, 'getEditorIframe: fallback iframe used — compose dialog may not be editable yet');
    return fallback;
  }
  // ── IS COMPOSE DIALOG? (Bug 3 — primary check rewritten) ─────────────────────
  // PRIMARY: Does this dialog contain an iframe whose body is editable?
  // This is the only reliable check because BOTH viewer and compose have
  // .x-html-editor-tb / .x-html-editor-wrap in this version of Neurons.
  // SECONDARY: fall back to RTF toolbar check only if no iframes are present.
  function isComposeDialog(dialogEl) {
    // Primary: check for an editable iframe
    var iframes = dialogEl.querySelectorAll('iframe');
    for (var k = 0; k < iframes.length; k++) {
      try {
        var iDoc = iframes[k].contentDocument;
        if (iDoc && iDoc.body && (iDoc.body.isContentEditable || iDoc.designMode === 'on')) {
          console.log(LOG, 'isComposeDialog: editable iframe found at index ' + k + ' — is compose');
          return true;
        }
      } catch (e) {}
    }
    // Secondary: RTF toolbar markers (kept as fallback for edge cases where
    // the iframe hasn't finished loading but the toolbar is already rendered)
    if (iframes.length === 0) {
      if (dialogEl.querySelector('.x-html-editor-tb, .x-html-editor-wrap, [class*="html-editor"]')) {
        console.log(LOG, 'isComposeDialog: html-editor class found (no iframes yet) — is compose');
        return true;
      }
      var allBtns = dialogEl.querySelectorAll('button, .x-btn-text, td.x-btn-mc');
      for (var i = 0; i < allBtns.length; i++) {
        var text  = (allBtns[i].textContent || '').trim().toLowerCase();
        var title = (allBtns[i].title       || '').trim().toLowerCase();
        var cls   = (allBtns[i].className   || '').toLowerCase();
        if (text === 'bold'   || title === 'bold'   || cls.indexOf('bold')   !== -1 ||
            text === 'italic' || title === 'italic' || cls.indexOf('italic') !== -1) {
          console.log(LOG, 'isComposeDialog: bold/italic button found (no iframes) — is compose');
          return true;
        }
      }
    }
    console.log(LOG, 'isComposeDialog: no editable iframe found — treating as viewer');
    return false;
  }
  // ── TOOLBAR execCommand HELPER ────────────────────────────────────────────────
  function execCmd(cmd, value) {
    var editor = document.getElementById('uwm-ra-editor');
    if (editor) editor.focus();
    document.execCommand(cmd, false, value || null);
  }
  // ── INJECT STYLES ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('uwm-ra-styles')) return;
    var style = document.createElement('style');
    style.id  = 'uwm-ra-styles';
    style.textContent = [
      '#uwm-ra-trigger-btn {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  padding: 3px 10px; margin-left: 8px;',
      '  background: #1a2744; color: #7db3e8;',
      '  border: 1px solid #2d4a7a; border-radius: 4px;',
      '  font-size: 12px; font-weight: 600; cursor: pointer;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '  vertical-align: middle; white-space: nowrap; line-height: 1.5;',
      '  transition: background 0.15s, color 0.15s;',
      '  pointer-events: all;',
      '}',
      '#uwm-ra-trigger-btn:hover { background: #243660; color: #a8d4f5; }',
      '#uwm-ra-badge {',
      '  position: fixed; z-index: 999990;',
      '  background: #1a2744; color: #7db3e8;',
      '  border: 1px solid #2d4a7a; border-radius: 20px;',
      '  padding: 5px 12px 5px 9px;',
      '  font-size: 11.5px; font-weight: 600; cursor: pointer;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '  display: flex; align-items: center; gap: 5px;',
      '  box-shadow: 0 4px 16px rgba(0,0,0,0.25);',
      '  user-select: none; bottom: 20px; right: 20px;',
      '  transition: background 0.15s, transform 0.15s;',
      '  pointer-events: all;',
      '}',
      '#uwm-ra-badge:hover { background: #243660; transform: translateY(-1px); }',
      '#uwm-ra-badge .ra-badge-dot {',
      '  width: 7px; height: 7px; border-radius: 50%; background: #3b82f6; flex-shrink: 0;',
      '  animation: ra-pulse 2s ease-in-out infinite;',
      '}',
      '@keyframes ra-pulse {',
      '  0%, 100% { opacity: 1; transform: scale(1); }',
      '  50%       { opacity: 0.5; transform: scale(0.85); }',
      '}',
      '#uwm-ra-overlay {',
      '  position: fixed; inset: 0; z-index: 999998;',
      '  background: rgba(15,20,30,0.55);',
      '  display: flex; align-items: center; justify-content: center;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '}',
      '#uwm-ra-overlay.ra-hidden { display: none; }',
      /* Bug 4 fix: pointer-events: all on panel so overlay click-through can't swallow button clicks */
      '#uwm-ra-panel {',
      '  width: 920px; max-width: 96vw; height: 640px; max-height: 92vh;',
      '  background: #f7f8fa; border-radius: 10px;',
      '  box-shadow: 0 24px 64px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.15);',
      '  display: flex; flex-direction: column; overflow: hidden;',
      '  border: 1px solid #d0d5dd;',
      '  pointer-events: all;',
      '}',
      '#uwm-ra-header {',
      '  background: #1a2744; color: #fff;',
      '  padding: 12px 18px; display: flex; align-items: center; gap: 10px; flex-shrink: 0;',
      '}',
      '#uwm-ra-header .ra-logo { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.9; }',
      '#uwm-ra-header .ra-header-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }',
      '#uwm-ra-header .ra-version { font-size: 11px; opacity: 0.45; }',
      '#uwm-ra-minimize-btn {',
      '  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);',
      '  color: #fff; border-radius: 5px; cursor: pointer;',
      '  font-size: 14px; padding: 2px 9px; line-height: 1.6; transition: background 0.15s;',
      '  pointer-events: all;',
      '}',
      '#uwm-ra-minimize-btn:hover { background: rgba(255,255,255,0.22); }',
      '#uwm-ra-confidence {',
      '  display: flex; align-items: center; gap: 8px; padding: 8px 18px; font-size: 12.5px;',
      '  border-bottom: 1px solid #e2e5ec; flex-shrink: 0; background: #fffbf0;',
      '}',
      '#uwm-ra-confidence .ra-dot { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }',
      '.ra-dot-green  { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18); }',
      '.ra-dot-yellow { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.18); }',
      '.ra-dot-red    { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.18); }',
      '#uwm-ra-body { display: flex; flex: 1; overflow: hidden; }',
      '#uwm-ra-citations {',
      '  width: 265px; flex-shrink: 0; background: #1e2b45; color: #c8d0e0;',
      '  overflow-y: auto; padding: 14px 0; display: flex; flex-direction: column;',
      '}',
      '#uwm-ra-citations .ra-cit-heading { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6b7fa3; padding: 0 14px 8px 14px; }',
      '.ra-cit-tier { padding: 8px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); }',
      '.ra-cit-tier-label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #5b7fa3; margin-bottom: 5px; }',
      '.ra-cit-item { margin-bottom: 8px; }',
      '.ra-cit-item a { font-size: 12px; color: #7db3e8; text-decoration: none; display: block; line-height: 1.35; }',
      '.ra-cit-item a:hover { text-decoration: underline; }',
      '.ra-cit-item .ra-cit-excerpt { font-size: 11px; color: #8a97ae; margin-top: 2px; line-height: 1.4; }',
      '.ra-cit-none { font-size: 11px; color: #4a5a72; font-style: italic; }',
      '.ra-cit-community-note { font-size: 10px; color: #a08050; background: rgba(245,158,11,0.12); border-radius: 3px; padding: 2px 5px; margin-top: 3px; display: inline-block; }',
      '#uwm-ra-editor-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #fff; }',
      '#uwm-ra-toolbar { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid #e2e5ec; background: #f7f8fa; flex-shrink: 0; }',
      '.ra-tb-btn { background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 3px 7px; color: #374151; transition: background 0.12s, border-color 0.12s; line-height: 1.4; pointer-events: all; }',
      '.ra-tb-btn:hover { background: #e5e7eb; border-color: #d0d5dd; }',
      '.ra-tb-sep { width: 1px; height: 18px; background: #d0d5dd; margin: 0 4px; }',
      '#uwm-ra-editor {',
      '  flex: 1; overflow-y: auto; padding: 14px 18px;',
      '  font-size: 13.5px; font-family: "Segoe UI", system-ui, sans-serif;',
      '  line-height: 1.6; color: #1f2937; outline: none; min-height: 0; cursor: text;',
      '  pointer-events: all;',
      '}',
      '#uwm-ra-editor:empty:before { content: "Draft reply will appear here\\u2026"; color: #9ca3af; pointer-events: none; }',
      '#uwm-ra-editor a { color: #1a5bb8; }',
      '#uwm-ra-footer { padding: 10px 16px; border-top: 1px solid #e2e5ec; display: flex; align-items: center; gap: 10px; background: #f7f8fa; flex-shrink: 0; }',
      '.ra-btn { padding: 7px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; pointer-events: all; }',
      '#uwm-ra-insert { background: #1a5bb8; color: #fff; }',
      '#uwm-ra-insert:hover { background: #1549a0; }',
      '#uwm-ra-cancel { background: #e5e7eb; color: #374151; }',
      '#uwm-ra-cancel:hover { background: #d1d5db; }',
      '.ra-thumbs { display: flex; gap: 6px; margin-left: auto; }',
      '.ra-thumb-btn { background: none; border: 1px solid #d0d5dd; border-radius: 6px; cursor: pointer; font-size: 16px; padding: 4px 10px; transition: background 0.15s, border-color 0.15s; pointer-events: all; }',
      '.ra-thumb-btn:hover { background: #e5e7eb; }',
      '.ra-thumb-btn.ra-thumb-selected { background: #dbeafe; border-color: #3b82f6; }',
      '#uwm-ra-searching { font-size: 12px; color: #6b7fa3; margin-left: 8px; display: flex; align-items: center; gap: 6px; }',
      '.ra-spinner { width: 13px; height: 13px; border: 2px solid #d0d5dd; border-top-color: #3b82f6; border-radius: 50%; flex-shrink: 0; animation: ra-spin 0.7s linear infinite; }',
      '@keyframes ra-spin { to { transform: rotate(360deg); } }',
      '#uwm-ra-minibar { position: fixed; bottom: 0; left: 0; right: 0; z-index: 999999; background: #1a2744; color: #fff; display: flex; align-items: center; gap: 12px; padding: 10px 20px; box-shadow: 0 -4px 20px rgba(0,0,0,0.3); font-family: "Segoe UI", system-ui, sans-serif; }',
      '#uwm-ra-minibar.ra-hidden { display: none; }',
      '#uwm-ra-minibar .ra-mini-icon { font-size: 16px; opacity: 0.8; }',
      '#uwm-ra-minibar .ra-mini-label { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }',
      '#uwm-ra-minibar .ra-mini-sub { font-size: 11px; opacity: 0.5; margin-left: 2px; }',
      '.ra-mini-btn { padding: 5px 16px; border-radius: 5px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; pointer-events: all; }',
      '#uwm-ra-mini-restore { background: #2563eb; color: #fff; margin-left: auto; }',
      '#uwm-ra-mini-restore:hover { background: #1d4ed8; }',
      '#uwm-ra-mini-discard { background: rgba(255,255,255,0.1); color: #fca5a5; border: 1px solid rgba(255,100,100,0.3); }',
      '#uwm-ra-mini-discard:hover { background: rgba(255,80,80,0.2); }',
      '#uwm-ra-warn-overlay { position: fixed; inset: 0; z-index: 1000000; background: rgba(15,20,30,0.65); display: flex; align-items: center; justify-content: center; font-family: "Segoe UI", system-ui, sans-serif; }',
      '#uwm-ra-warn-box { background: #fff; border-radius: 10px; padding: 28px 32px; width: 400px; max-width: 92vw; box-shadow: 0 16px 48px rgba(0,0,0,0.3); border: 1px solid #e2e5ec; }',
      '#uwm-ra-warn-box h3 { margin: 0 0 10px 0; font-size: 16px; color: #111827; }',
      '#uwm-ra-warn-box p  { margin: 0 0 22px 0; font-size: 13.5px; color: #6b7280; line-height: 1.5; }',
      '#uwm-ra-warn-box .ra-warn-actions { display: flex; gap: 10px; justify-content: flex-end; }',
      '#uwm-ra-warn-keep    { background: #e5e7eb; color: #374151; }',
      '#uwm-ra-warn-keep:hover { background: #d1d5db; }',
      '#uwm-ra-warn-confirm { background: #dc2626; color: #fff; }',
      '#uwm-ra-warn-confirm:hover { background: #b91c1c; }',
    ].join('\\n');
    document.head.appendChild(style);
  }
  // ── REMOVE TRIGGERS ───────────────────────────────────────────────────────────
  function removeTriggers() {
    var innerDoc = getInnerDoc();
    if (innerDoc) {
      var btn = innerDoc.getElementById('uwm-ra-trigger-btn');
      if (btn) btn.remove();
    }
    var badge = document.getElementById('uwm-ra-badge');
    if (badge) badge.remove();
  }
  // ── INJECT TOOLBAR BUTTON INTO COMPOSE DIALOG ─────────────────────────────────
  function injectToolbarButton(dialogEl, innerDoc, onClickFn) {
    if (innerDoc.getElementById('uwm-ra-trigger-btn')) return;
    var toolbar = dialogEl.querySelector('.x-html-editor-tb');
    if (!toolbar) {
      var allBtns = dialogEl.querySelectorAll('button, .x-btn-text, td.x-btn-mc');
      for (var i = 0; i < allBtns.length; i++) {
        var txt = (allBtns[i].textContent || '').trim().toLowerCase();
        var ttl = (allBtns[i].title       || '').trim().toLowerCase();
        if (txt === 'bold' || ttl === 'bold' || txt === 'italic' || ttl === 'italic') {
          toolbar = allBtns[i].parentElement;
          for (var s = 0; s < 4; s++) {
            if (!toolbar || toolbar === dialogEl) break;
            var tag = toolbar.tagName.toLowerCase();
            if (tag === 'tr' || tag === 'div' || tag === 'ul') break;
            toolbar = toolbar.parentElement;
          }
          break;
        }
      }
    }
    var btn = innerDoc.createElement('button');
    btn.id        = 'uwm-ra-trigger-btn';
    btn.innerHTML = '&#10022; AI Assistant';
    btn.title     = 'Open Reply Assistant';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      onClickFn();
    });
    if (toolbar) {
      toolbar.appendChild(btn);
      console.log(LOG, 'Trigger button injected into compose RTF toolbar');
    } else {
      dialogEl.appendChild(btn);
      console.log(LOG, 'Trigger button injected into dialog (toolbar fallback)');
    }
  }
  // ── INJECT FLOATING BADGE ─────────────────────────────────────────────────────
  function injectBadge(onClickFn) {
    if (document.getElementById('uwm-ra-badge')) return;
    var badge = document.createElement('div');
    badge.id  = 'uwm-ra-badge';
    badge.innerHTML = '<span class="ra-badge-dot"></span>&#10022; Reply Assistant';
    badge.title = 'Open Reply Assistant';
    badge.addEventListener('click', function () { onClickFn(); });
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
    if (badge)   badge.style.display = 'none';
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
    var editor = document.getElementById('uwm-ra-editor');
    if (editor) editor.focus();
    console.log(LOG, 'Pop-up restored');
  }
  function closePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    var warn    = document.getElementById('uwm-ra-warn-overlay');
    if (overlay) overlay.remove();
    if (minibar) minibar.remove();
    if (warn)    warn.remove();
    popupActive = false;
    isMinimized = false;
    if (escListener) {
      document.removeEventListener('keydown', escListener);
      escListener = null;
    }
    console.log(LOG, 'Pop-up closed');
  }
  // ── CANCEL WARNING ────────────────────────────────────────────────────────────
  function showCancelWarning() {
    if (isMinimized) restorePopup();
    var warn = document.createElement('div');
    warn.id  = 'uwm-ra-warn-overlay';
    warn.innerHTML = [
      '<div id="uwm-ra-warn-box">',
        '<h3>Discard this draft?</h3>',
        '<p>Your draft reply and any edits will be permanently lost. This cannot be undone.</p>',
        '<div class="ra-warn-actions">',
          '<button class="ra-btn" id="uwm-ra-warn-keep">Keep editing</button>',
          '<button class="ra-btn" id="uwm-ra-warn-confirm">Yes, discard draft</button>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(warn);
    document.getElementById('uwm-ra-warn-keep').addEventListener('click', function () { warn.remove(); });
    document.getElementById('uwm-ra-warn-confirm').addEventListener('click', function () {
      console.log(LOG, 'Draft discarded by user confirmation');
      closePopup();
    });
    warn.addEventListener('click', function (e) { if (e.target === warn) warn.remove(); });
  }
  // ── INSERT DRAFT AT TOP (Bug 3 fix — use insertAdjacentHTML) ─────────────────
  // Uses insertAdjacentHTML('afterbegin') instead of manual node-prepend to avoid
  // node-adoption edge cases with ExtJS's designMode iframe.
  function insertDraftAtTop(editorIframe, draftHtml) {
    var editorBody = editorIframe.contentDocument.body;
    var editorDoc  = editorIframe.contentDocument;
    editorBody.insertAdjacentHTML('afterbegin', draftHtml);
    var evt = editorDoc.createEvent('Event');
    evt.initEvent('input', true, true);
    editorBody.dispatchEvent(evt);
    console.log(LOG, 'Draft prepended to Neurons compose editor (' + draftHtml.length + ' chars)');
  }
  // ── POP-UP UI ─────────────────────────────────────────────────────────────────
  function showPopup(dialogEl, thread) {
    if (popupActive) {
      if (isMinimized) restorePopup();
      return;
    }
    popupActive = true;
    injectStyles();
    var badge = document.getElementById('uwm-ra-badge');
    if (badge) badge.style.display = 'none';
    var overlay = document.createElement('div');
    overlay.id  = 'uwm-ra-overlay';
    overlay.innerHTML = [
      '<div id="uwm-ra-panel">',
        '<div id="uwm-ra-header">',
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7db3e8" stroke-width="2">',
            '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
          '</svg>',
          '<span class="ra-logo">Reply Assistant</span>',
          '<span id="uwm-ra-searching"><span class="ra-spinner"></span>Searching knowledge base\\u2026</span>',
          '<div class="ra-header-actions">',
            '<button id="uwm-ra-minimize-btn" title="Minimize \\u2014 draft preserved">\\u2013</button>',
            '<span class="ra-version">v1.18</span>',
          '</div>',
        '</div>',
        '<div id="uwm-ra-confidence">',
          '<span class="ra-dot ra-dot-yellow"></span>',
          '<strong style="font-size:12.5px;color:#92400e;">Best guess</strong>',
          '<span style="color:#78716c;font-size:12px;margin-left:4px;">\\u2014 reviewing search results. Verify before sending.</span>',
        '</div>',
        '<div id="uwm-ra-body">',
          '<div id="uwm-ra-citations">',
            '<div class="ra-cit-heading">Sources Consulted</div>',
            '<div class="ra-cit-tier">',
              '<div class="ra-cit-tier-label">Tier 1 \\u2014 UWM Knowledge Base</div>',
              '<div class="ra-cit-item">',
                '<a href="https://kb.uwm.edu" target="_blank">Setting Up Your Canvas Course Site</a>',
                '<div class="ra-cit-excerpt">Step-by-step guide to course creation, enrollment sync, and template use
