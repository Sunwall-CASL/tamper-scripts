// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.17
// @description  Detects reply/compose dialog, injects AI-assist pop-up with native contentEditable editor.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// ── CHANGES IN v1.17 ─────────────────────────────────────────────────────────
//
// REVERTED: Quill.js removed entirely. Quill 1.3.7 throws
//   "t.keys is not a function" on this page due to a NamedNodeMap conflict
//   with the host page environment. The working contentEditable + execCommand
//   editor from v1.13 is fully restored instead.
//
// RETAINED FROM v1.16:
//   Fix 1 — startObserver() is an empty stub. Poller-only mode.
//   Fix 2 — getEditorIframe() returns the iframe whose body.isContentEditable
//            === true, so Insert targets the compose window, not the viewer.
//
// FIXED: Triggers (toolbar button + badge) were appearing before Reply was
//   clicked. Root cause: takeSnapshot() was happening inside the first poller
//   tick, which meant there was a 500ms window where dialogs could slip through
//   before the snapshot ran. Fixed by calling takeSnapshot() synchronously
//   inside init(), before startPoller() is called. This guarantees ALL
//   pre-existing dialogs are in knownDialogIds before the poller begins.
//
// RESTORED: Full placeholder draft text in the contentEditable editor.
// RESTORED: All toolbar buttons (Bold, Italic, Underline, Lists, Link, Clear).
// RESTORED: Insert, Cancel, Minimize, ESC, thumbs up/down — all functional.

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
  // Three iframe.x-managed-iframe elements exist. The correct app frame is always
  // the one with the largest offsetWidth. Never select by index.
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

  // Must be called fresh on every interval — never cache this reference.
  function getInnerDoc() {
    var f = getAppFrame();
    return f ? f.contentDocument : null;
  }

  // ── TAKE SNAPSHOT OF PRE-EXISTING DIALOGS ────────────────────────────────────
  // Called synchronously inside init(), before startPoller() runs.
  // Any .x-frs-modal-form visible right now (the viewer dialog, etc.) goes into
  // knownDialogIds and will never be treated as a compose dialog by the poller.
  function takeSnapshot() {
    var innerDoc = getInnerDoc();
    if (!innerDoc) return;
    var existing = innerDoc.querySelectorAll('.x-frs-modal-form');
    for (var i = 0; i < existing.length; i++) {
      knownDialogIds[existing[i].id] = true;
    }
    console.log(LOG, 'Snapshot taken — ' + existing.length + ' pre-existing dialog(s) marked as known');
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

  // ── FIND COMPOSE EDITOR IFRAME (v1.16 Fix 2) ─────────────────────────────────
  // Returns the iframe whose body.isContentEditable === true.
  // Diagnostic confirmed: viewer iframe body has isContentEditable = false,
  // compose iframe body has isContentEditable = true.
  function getEditorIframe(dialogEl) {
    var iframes  = dialogEl.querySelectorAll('iframe');
    var fallback = null;
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (!doc || !doc.body) continue;
        if (doc.body.isContentEditable) {
          console.log(LOG, 'getEditorIframe: editable iframe at index ' + i);
          return iframes[i];
        }
        if (!fallback) fallback = iframes[i];
      } catch (e) {}
    }
    if (fallback) console.log(LOG, 'getEditorIframe: fallback iframe used');
    return fallback;
  }

  // ── IS COMPOSE DIALOG? ────────────────────────────────────────────────────────
  // Secondary guard: compose dialog contains an RTF editor toolbar (bold/italic).
  // The viewer dialog does not have these controls.
  function isComposeDialog(dialogEl) {
    if (dialogEl.querySelector('.x-html-editor-tb, .x-html-editor-wrap, [class*="html-editor"]')) {
      console.log(LOG, 'isComposeDialog: html-editor class found — is compose');
      return true;
    }
    var allBtns = dialogEl.querySelectorAll('button, .x-btn-text, td.x-btn-mc');
    for (var i = 0; i < allBtns.length; i++) {
      var text  = (allBtns[i].textContent || '').trim().toLowerCase();
      var title = (allBtns[i].title       || '').trim().toLowerCase();
      var cls   = (allBtns[i].className   || '').toLowerCase();
      if (text === 'bold'   || title === 'bold'   || cls.indexOf('bold')   !== -1 ||
          text === 'italic' || title === 'italic' || cls.indexOf('italic') !== -1) {
        console.log(LOG, 'isComposeDialog: bold/italic button found — is compose');
        return true;
      }
    }
    var imgs = dialogEl.querySelectorAll('img[alt], img[title]');
    for (var j = 0; j < imgs.length; j++) {
      var alt = ((imgs[j].alt || imgs[j].title) || '').toLowerCase();
      if (alt === 'bold' || alt === 'italic' || alt === 'underline') {
        console.log(LOG, 'isComposeDialog: bold/italic img found — is compose');
        return true;
      }
    }
    console.log(LOG, 'isComposeDialog: no RTF toolbar — treating as viewer');
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

      '#uwm-ra-panel {',
      '  width: 920px; max-width: 96vw; height: 640px; max-height: 92vh;',
      '  background: #f7f8fa; border-radius: 10px;',
      '  box-shadow: 0 24px 64px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.15);',
      '  display: flex; flex-direction: column; overflow: hidden;',
      '  border: 1px solid #d0d5dd;',
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
      '.ra-tb-btn { background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 3px 7px; color: #374151; transition: background 0.12s, border-color 0.12s; line-height: 1.4; }',
      '.ra-tb-btn:hover { background: #e5e7eb; border-color: #d0d5dd; }',
      '.ra-tb-sep { width: 1px; height: 18px; background: #d0d5dd; margin: 0 4px; }',

      '#uwm-ra-editor {',
      '  flex: 1; overflow-y: auto; padding: 14px 18px;',
      '  font-size: 13.5px; font-family: "Segoe UI", system-ui, sans-serif;',
      '  line-height: 1.6; color: #1f2937; outline: none; min-height: 0; cursor: text;',
      '}',
      '#uwm-ra-editor:empty:before { content: "Draft reply will appear here\u2026"; color: #9ca3af; pointer-events: none; }',
      '#uwm-ra-editor a { color: #1a5bb8; }',

      '#uwm-ra-footer { padding: 10px 16px; border-top: 1px solid #e2e5ec; display: flex; align-items: center; gap: 10px; background: #f7f8fa; flex-shrink: 0; }',
      '.ra-btn { padding: 7px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; }',
      '#uwm-ra-insert { background: #1a5bb8; color: #fff; }',
      '#uwm-ra-insert:hover { background: #1549a0; }',
      '#uwm-ra-cancel { background: #e5e7eb; color: #374151; }',
      '#uwm-ra-cancel:hover { background: #d1d5db; }',

      '.ra-thumbs { display: flex; gap: 6px; margin-left: auto; }',
      '.ra-thumb-btn { background: none; border: 1px solid #d0d5dd; border-radius: 6px; cursor: pointer; font-size: 16px; padding: 4px 10px; transition: background 0.15s, border-color 0.15s; }',
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
      '.ra-mini-btn { padding: 5px 16px; border-radius: 5px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; }',
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

    ].join('\n');
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

  // ── INSERT DRAFT AT TOP ───────────────────────────────────────────────────────
  // Prepends draft HTML before existing content (signature, thread).
  // Never overwrites — existing content remains below the inserted draft.
  function insertDraftAtTop(editorIframe, draftHtml) {
    var editorBody = editorIframe.contentDocument.body;
    var editorDoc  = editorIframe.contentDocument;

    var temp = editorDoc.createElement('div');
    temp.innerHTML = draftHtml;

    var firstChild = editorBody.firstChild;
    var nodes      = Array.prototype.slice.call(temp.childNodes);

    if (firstChild) {
      for (var i = 0; i < nodes.length; i++) {
        editorBody.insertBefore(nodes[i], firstChild);
      }
    } else {
      for (var j = 0; j < nodes.length; j++) {
        editorBody.appendChild(nodes[j]);
      }
    }

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
          '<span id="uwm-ra-searching"><span class="ra-spinner"></span>Searching knowledge base\u2026</span>',
          '<div class="ra-header-actions">',
            '<button id="uwm-ra-minimize-btn" title="Minimize \u2014 draft preserved">\u2013</button>',
            '<span class="ra-version">v1.17</span>',
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
                '<div class="ra-cit-excerpt">How to request additional user roles in a Canvas course via the UWM enrollment system.</div>',
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
              '<button class="ra-tb-btn" data-cmd="bold"                title="Bold"><b>B</b></button>',
              '<button class="ra-tb-btn" data-cmd="italic"              title="Italic"><i>I</i></button>',
              '<button class="ra-tb-btn" data-cmd="underline"           title="Underline"><u>U</u></button>',
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
          '<button class="ra-btn" id="uwm-ra-insert">\u21b5 Insert into Email</button>',
          '<button class="ra-btn" id="uwm-ra-cancel">Cancel</button>',
          '<div class="ra-thumbs">',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-up"   title="Useful \u2014 save to memory">&#128077;</button>',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-down" title="Not useful">&#128078;</button>',
          '</div>',
        '</div>',

      '</div>'
    ].join('');
    document.body.appendChild(overlay);

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

    // Load placeholder draft — written directly to innerHTML, no library needed
    document.getElementById('uwm-ra-editor').innerHTML = [
      '<p>Hi [Instructor Name],</p>',
      '<p>Thank you for reaching out to UWM CETL support.</p>',
      '<p><em>Placeholder draft \u2014 will be replaced with a real AI-generated reply once search and Ollama integration are complete.</em></p>',
      '<p>Based on what you\u2019ve described, here are some resources that may help:</p>',
      '<ul>',
        '<li>UWM Knowledge Base: <a href="https://kb.uwm.edu">Setting Up Your Canvas Course Site</a></li>',
        '<li>Canvas Community: <a href="https://community.instructure.com">How do I add files to a course?</a></li>',
      '</ul>',
      '<p>Please let me know if you have any questions or if this doesn\u2019t resolve the issue \u2014 happy to help further.</p>',
      '<p>Best,<br>Lane<br>CETL Teaching, Learning &amp; Technology Consultant</p>'
    ].join('');

    document.getElementById('uwm-ra-editor').focus();

    // Simulate search completing (placeholder — real search wired in Component 4)
    setTimeout(function () {
      var el = document.getElementById('uwm-ra-searching');
      if (el) el.innerHTML = '<span style="color:#4ade80;font-size:12px;">&#10003; Search complete</span>';
    }, 2000);

    // Toolbar buttons
    var tbBtns = document.querySelectorAll('#uwm-ra-toolbar .ra-tb-btn[data-cmd]');
    for (var t = 0; t < tbBtns.length; t++) {
      (function (btn) {
        btn.addEventListener('mousedown', function (e) {
          e.preventDefault(); // keep editor focus
          execCmd(btn.getAttribute('data-cmd'));
        });
      }(tbBtns[t]));
    }
    document.getElementById('uwm-ra-link-btn').addEventListener('mousedown', function (e) {
      e.preventDefault();
      var url = prompt('Enter URL:', 'https://');
      if (url && url !== 'https://') execCmd('createLink', url);
    });

    document.getElementById('uwm-ra-minimize-btn').addEventListener('click', minimizePopup);

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
        insertDraftAtTop(editorIframe, html);
        closePopup();
        removeTriggers();
      } catch (e) {
        console.error(LOG, 'Insert failed:', e);
        alert('[UWM Reply Assistant] Insert failed \u2014 see console. Error: ' + e.message);
      }
    });

    document.getElementById('uwm-ra-cancel').addEventListener('click', showCancelWarning);

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

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) minimizePopup();
    });

    escListener = function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        if (!popupActive) return;
        if (isMinimized) { restorePopup(); } else { minimizePopup(); }
      }
    };
    document.addEventListener('keydown', escListener);

    document.getElementById('uwm-ra-mini-restore').addEventListener('click', restorePopup);
    document.getElementById('uwm-ra-mini-discard').addEventListener('click', function () {
      console.log(LOG, 'Draft discarded from minibar');
      closePopup();
      removeTriggers();
    });

    console.log(LOG, 'Pop-up displayed');
  }

  // ── HANDLE COMPOSE DIALOG ─────────────────────────────────────────────────────
  function handleDialog(dialogEl, innerDoc) {
    if (seenDialogs[dialogEl.id])    return;
    if (knownDialogIds[dialogEl.id]) return;

    if (!isComposeDialog(dialogEl)) {
      console.log(LOG, 'New dialog ' + dialogEl.id + ' skipped — no RTF toolbar');
      return;
    }

    seenDialogs[dialogEl.id] = true;
    console.log(LOG, 'NEW compose dialog confirmed (id=' + dialogEl.id + ') — injecting triggers');

    var thread = readEmailThread(innerDoc);

    function openAssistant() {
      showPopup(dialogEl, thread);
    }

    injectToolbarButton(dialogEl, innerDoc, openAssistant);
    injectBadge(openAssistant);

    if (cleanPoller) clearInterval(cleanPoller);
    cleanPoller = setInterval(function () {
      var currentDoc = getInnerDoc();
      if (!currentDoc) return;
      if (!currentDoc.body.contains(dialogEl)) {
        clearInterval(cleanPoller);
        cleanPoller = null;
        delete seenDialogs[dialogEl.id];
        removeTriggers();
        if (popupActive) closePopup();
        console.log(LOG, 'Compose dialog closed — ready for next reply');
      }
    }, 800);
  }

  // ── POLL FOR NEW DIALOGS ──────────────────────────────────────────────────────
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

  // ── OBSERVER STUB (Fix 1 from v1.16) ─────────────────────────────────────────
  function startObserver(innerDoc) {
    console.log(LOG, 'Observer disabled — poller-only mode');
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────
  var initAttempts = 0;
  function init() {
    initAttempts++;
    injectStyles();
    var innerDoc = getInnerDoc();
    if (!innerDoc || !innerDoc.body) {
      if (initAttempts < 30) setTimeout(init, 500);
      else console.error(LOG, 'Init failed — inner iframe not found after ' + initAttempts + ' attempts');
      return;
    }
    // Snapshot MUST run before startPoller() so all currently-visible dialogs
    // (the viewer, any other modal) are in knownDialogIds before polling begins.
    takeSnapshot();
    startObserver(innerDoc); // stub — no-op
    startPoller();
    console.log(LOG, 'v1.17 initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }

})();
