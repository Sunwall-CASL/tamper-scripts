// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.16
// @description  Detects reply/compose dialog, injects AI-assist pop-up with Quill.js editor.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// @require      https://cdn.quilljs.com/1.3.7/quill.min.js
// ==/UserScript==

// ── CHANGES IN v1.16 ─────────────────────────────────────────────────────────
//
// FIX 1 — startObserver() replaced with an empty stub.
//   The MutationObserver was firing at ~300ms and defeating the 2000ms
//   stabilisation window, causing triggers to appear on the email VIEWER
//   dialog instead of the compose dialog. The poller alone detects new
//   dialogs within 500ms which is fast enough and more reliable.
//
// FIX 2 — getEditorIframe() now returns the iframe whose body.isContentEditable
//   === true. Diagnostic run 2026-03-06 confirmed:
//     viewer  dialog: body.isContentEditable = false (body text len ~619)
//     compose dialog: body.isContentEditable = true  (body text len ~583)
//   The old code returned the FIRST accessible iframe regardless of editability,
//   which meant Insert was writing to the viewer, not the compose window.
//
// COMPONENT 3 ADDITIONS — Pop-up UI shell (placeholder content only):
//   • Quill.js rich text editor replaces the custom contentEditable + execCommand
//     approach. Loaded via @require from Quill CDN 1.3.7. Quill is initialised
//     inside the pop-up after it is injected into the DOM.
//   • Quill Snow theme CSS is injected programmatically (no separate @resource
//     needed — the CDN stylesheet URL is appended as a <link> to document.head).
//   • Placeholder draft pre-loaded into Quill via setContents() with Delta format.
//   • Insert button reads Quill's HTML via quillInstance.root.innerHTML and passes
//     it to insertDraftAtTop() — same insertion logic as before.
//   • Confidence indicator hard-coded yellow ("Best guess") for this component.
//   • Citations panel has realistic placeholder entries for all 4 tiers + memory.
//   • Thumbs up/down, Cancel (with discard warning), Minimize/Restore, ESC key
//     all retained from v1.13 and confirmed working.

(function () {
  'use strict';

  var LOG          = '[UWM Reply Assistant]';
  var pollInterval = null;
  var cleanPoller  = null;
  var seenDialogs  = {};
  var knownDialogIds = {};
  var snapshotTaken  = false;
  var popupActive  = false;
  var isMinimized  = false;
  var escListener  = null;
  var quillInstance = null; // holds the Quill editor object once pop-up is open

  // ── QUILL CSS INJECTION ───────────────────────────────────────────────────────
  // Appends the Quill Snow theme stylesheet once. Without this the toolbar renders
  // without icons/borders. We inject it into the OUTER document's <head> because
  // the pop-up overlay is also appended to the outer document body.
  function injectQuillCSS() {
    if (document.getElementById('uwm-ra-quill-css')) return;
    var link  = document.createElement('link');
    link.id   = 'uwm-ra-quill-css';
    link.rel  = 'stylesheet';
    link.href = 'https://cdn.quilljs.com/1.3.7/quill.snow.css';
    document.head.appendChild(link);
    console.log(LOG, 'Quill Snow CSS injected');
  }

  // ── FRAME HELPERS ─────────────────────────────────────────────────────────────
  // Three iframe.x-managed-iframe elements exist on the page.
  // The correct application frame is always the one with the largest offsetWidth.
  // Never select by index or by a fixed pixel threshold.
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

  // getInnerDoc() must be called fresh on every interval — captured closure
  // references become stale and stop seeing newly-added dialogs.
  function getInnerDoc() {
    var f = getAppFrame();
    return f ? f.contentDocument : null;
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

  // ── FIND COMPOSE EDITOR IFRAME (FIX 2) ───────────────────────────────────────
  // CRITICAL: returns the iframe whose body.isContentEditable === true.
  // Diagnostic confirmed this is the definitive signal that distinguishes the
  // compose window's editable body from the read-only viewer iframe.
  // Falls back to the first accessible iframe if none are editable (safety net).
  function getEditorIframe(dialogEl) {
    var iframes  = dialogEl.querySelectorAll('iframe');
    var fallback = null;
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (!doc || !doc.body) continue;
        if (doc.body.isContentEditable) {
          console.log(LOG, 'getEditorIframe: found editable iframe at index ' + i);
          return iframes[i]; // definitive match — compose editor
        }
        if (!fallback) fallback = iframes[i];
      } catch (e) {}
    }
    if (fallback) console.log(LOG, 'getEditorIframe: no editable iframe found, using fallback');
    return fallback;
  }

  // ── IS COMPOSE DIALOG? ────────────────────────────────────────────────────────
  // Kept as a secondary guard. Looks for the ExtJS HTML editor toolbar (RTF
  // formatting controls: bold/italic/underline) inside the dialog element.
  // The viewer dialog has Reply/Forward buttons but no RTF formatting toolbar.
  function isComposeDialog(dialogEl) {
    // Check for ExtJS HTML editor class patterns
    if (dialogEl.querySelector('.x-html-editor-tb, .x-html-editor-wrap, [class*="html-editor"]')) {
      console.log(LOG, 'isComposeDialog: html-editor class found');
      return true;
    }

    var allBtns = dialogEl.querySelectorAll('button, .x-btn-text, td.x-btn-mc, .x-tool-type-bold, .x-tool-type-italic');
    for (var i = 0; i < allBtns.length; i++) {
      var el    = allBtns[i];
      var text  = (el.textContent || '').trim().toLowerCase();
      var title = (el.title       || '').trim().toLowerCase();
      var cls   = (el.className   || '').toLowerCase();
      if (text === 'bold'   || title === 'bold'   || cls.indexOf('bold')   !== -1 ||
          text === 'italic' || title === 'italic' || cls.indexOf('italic') !== -1) {
        console.log(LOG, 'isComposeDialog: bold/italic button found');
        return true;
      }
    }

    var imgs = dialogEl.querySelectorAll('img[alt], img[title]');
    for (var j = 0; j < imgs.length; j++) {
      var alt = ((imgs[j].alt || imgs[j].title) || '').toLowerCase();
      if (alt === 'bold' || alt === 'italic' || alt === 'underline') {
        console.log(LOG, 'isComposeDialog: bold/italic img found');
        return true;
      }
    }

    console.log(LOG, 'isComposeDialog: No RTF toolbar found — treating as viewer dialog');
    return false;
  }

  // ── INJECT STYLES ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('uwm-ra-styles')) return;
    var style = document.createElement('style');
    style.id  = 'uwm-ra-styles';
    style.textContent = [

      /* ── Trigger button (in compose RTF toolbar) ── */
      '#uwm-ra-trigger-btn {',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '  padding: 3px 10px; margin-left: 8px;',
      '  background: #1a2744; color: #7db3e8;',
      '  border: 1px solid #2d4a7a; border-radius: 4px;',
      '  font-size: 12px; font-weight: 600; cursor: pointer;',
      '  font-family: "Segoe UI", system-ui, sans-serif;',
      '  transition: background 0.15s, color 0.15s;',
      '  vertical-align: middle; white-space: nowrap; line-height: 1.5;',
      '}',
      '#uwm-ra-trigger-btn:hover { background: #243660; color: #a8d4f5; }',

      /* ── Floating badge ── */
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
      '  user-select: none; bottom: 20px; right: 20px;',
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
      '  width: 920px; max-width: 96vw; height: 640px; max-height: 92vh;',
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
      '#uwm-ra-header .ra-logo { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.9; }',
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
      '  display: flex; align-items: center; gap: 8px; padding: 8px 18px; font-size: 12.5px;',
      '  border-bottom: 1px solid #e2e5ec; flex-shrink: 0; background: #fffbf0;',
      '}',
      '#uwm-ra-confidence .ra-dot { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }',
      '.ra-dot-green  { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18); }',
      '.ra-dot-yellow { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.18); }',
      '.ra-dot-red    { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.18); }',

      /* ── Body row ── */
      '#uwm-ra-body { display: flex; flex: 1; overflow: hidden; }',

      /* ── Citations sidebar ── */
      '#uwm-ra-citations {',
      '  width: 265px; flex-shrink: 0; background: #1e2b45; color: #c8d0e0;',
      '  overflow-y: auto; padding: 14px 0; display: flex; flex-direction: column;',
      '}',
      '#uwm-ra-citations .ra-cit-heading {',
      '  font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;',
      '  color: #6b7fa3; padding: 0 14px 8px 14px;',
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

      /* ── Quill editor area ── */
      '#uwm-ra-editor-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #fff; }',

      /* ── Quill container overrides ── */
      /* Give the Quill toolbar the same background as the panel and tighten spacing */
      '#uwm-ra-editor-area .ql-toolbar.ql-snow {',
      '  border-left: none; border-right: none; border-top: none;',
      '  border-bottom: 1px solid #e2e5ec;',
      '  background: #f7f8fa; padding: 6px 10px; flex-shrink: 0;',
      '}',
      /* Quill editor pane: fill remaining height, scroll internally */
      '#uwm-ra-editor-area .ql-container.ql-snow {',
      '  border: none; flex: 1; overflow-y: auto; font-family: "Segoe UI", system-ui, sans-serif;',
      '  font-size: 13.5px;',
      '}',
      '#uwm-ra-editor-area .ql-editor { padding: 14px 18px; line-height: 1.6; min-height: 100%; }',
      '#uwm-ra-editor-area .ql-editor.ql-blank::before { color: #9ca3af; font-style: normal; }',
      /* Quill link tooltip needs a high z-index to appear above the overlay */
      '.ql-tooltip { z-index: 1000010 !important; }',

      /* ── Footer ── */
      '#uwm-ra-footer {',
      '  padding: 10px 16px; border-top: 1px solid #e2e5ec;',
      '  display: flex; align-items: center; gap: 10px;',
      '  background: #f7f8fa; flex-shrink: 0;',
      '}',
      '.ra-btn { padding: 7px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; }',
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
      '.ra-spinner { width: 13px; height: 13px; border: 2px solid #d0d5dd; border-top-color: #3b82f6; border-radius: 50%; flex-shrink: 0; animation: ra-spin 0.7s linear infinite; }',
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
      '#uwm-ra-warn-box { background: #fff; border-radius: 10px; padding: 28px 32px; width: 400px; max-width: 92vw; box-shadow: 0 16px 48px rgba(0,0,0,0.3); border: 1px solid #e2e5ec; }',
      '#uwm-ra-warn-box h3 { margin: 0 0 10px 0; font-size: 16px; color: #111827; }',
      '#uwm-ra-warn-box p { margin: 0 0 22px 0; font-size: 13.5px; color: #6b7280; line-height: 1.5; }',
      '#uwm-ra-warn-box .ra-warn-actions { display: flex; gap: 10px; justify-content: flex-end; }',
      '#uwm-ra-warn-keep { background: #e5e7eb; color: #374151; }',
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
  // Appends the AI Assistant button to the compose dialog's own RTF toolbar row.
  // This keeps the button visible while the compose dialog is open, and only then.
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
    btn.id  = 'uwm-ra-trigger-btn';
    btn.innerHTML = '&#10022; AI Assistant';
    btn.title = 'Open Reply Assistant';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      onClickFn();
    });

    if (toolbar) {
      toolbar.appendChild(btn);
      console.log(LOG, 'Trigger button injected into compose RTF toolbar');
    } else {
      dialogEl.appendChild(btn);
      console.log(LOG, 'Trigger button injected into dialog (toolbar not found — fallback)');
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
    console.log(LOG, 'Pop-up minimized — draft preserved in Quill');
  }

  function restorePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    var badge   = document.getElementById('uwm-ra-badge');
    if (overlay) overlay.classList.remove('ra-hidden');
    if (minibar) minibar.classList.add('ra-hidden');
    if (badge)   badge.style.display = '';
    isMinimized = false;
    // Re-focus Quill after restore so keyboard shortcuts work immediately
    if (quillInstance) quillInstance.focus();
    console.log(LOG, 'Pop-up restored');
  }

  function closePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    var warn    = document.getElementById('uwm-ra-warn-overlay');
    if (overlay) overlay.remove();
    if (minibar) minibar.remove();
    if (warn)    warn.remove();
    quillInstance = null;
    popupActive   = false;
    isMinimized   = false;
    if (escListener) {
      document.removeEventListener('keydown', escListener);
      escListener = null;
    }
    console.log(LOG, 'Pop-up closed — Quill instance destroyed');
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
  // Prepends draft HTML before existing content (signature, thread) so the reply
  // text appears at the very top of the Neurons compose editor. Never overwrites.
  function insertDraftAtTop(editorIframe, draftHtml) {
    var editorBody = editorIframe.contentDocument.body;
    var editorDoc  = editorIframe.contentDocument;

    // Parse draft HTML into temporary container so we get real DOM nodes
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

    // Fire an input event so Neurons registers the change in its ExtJS model
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
    injectQuillCSS();

    // Hide badge while panel is open
    var badge = document.getElementById('uwm-ra-badge');
    if (badge) badge.style.display = 'none';

    // ── OVERLAY HTML ──
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
          '<span id="uwm-ra-searching"><span class="ra-spinner"></span>Searching knowledge base\u2026</span>',
          '<div class="ra-header-actions">',
            '<button id="uwm-ra-minimize-btn" title="Minimize \u2014 draft preserved">\u2013</button>',
            '<span class="ra-version">v1.16</span>',
          '</div>',
        '</div>',

        // Confidence bar — hard-coded yellow for Component 3 placeholder phase
        '<div id="uwm-ra-confidence">',
          '<span class="ra-dot ra-dot-yellow"></span>',
          '<strong style="font-size:12.5px;color:#92400e;">Best guess</strong>',
          '<span style="color:#78716c;font-size:12px;margin-left:4px;">\u2014 reviewing search results. Verify before sending.</span>',
        '</div>',

        // Body: citations sidebar + Quill editor
        '<div id="uwm-ra-body">',

          // Citations sidebar (placeholder data for Component 3)
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

          // Quill editor area — Quill will mount here after overlay is in DOM
          '<div id="uwm-ra-editor-area">',
            '<div id="uwm-ra-quill-mount"></div>',
          '</div>',

        '</div>',

        // Footer
        '<div id="uwm-ra-footer">',
          '<button class="ra-btn" id="uwm-ra-insert">\u21b5 Insert into Email</button>',
          '<button class="ra-btn" id="uwm-ra-cancel">Cancel</button>',
          '<div class="ra-thumbs">',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-up"   title="Useful \u2014 save to memory">\uD83D\uDC4D</button>',
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-down" title="Not useful">\uD83D\uDC4E</button>',
          '</div>',
        '</div>',

      '</div>'

    ].join('');
    document.body.appendChild(overlay);

    // ── MINIBAR ──
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

    // ── INITIALISE QUILL ──
    // Quill is loaded via @require so it is available as window.Quill.
    // We mount it on #uwm-ra-quill-mount which is inside #uwm-ra-editor-area.
    // The 'snow' theme renders a full toolbar with common formatting options.
    //
    // Toolbar modules: standard text formatting + link + image + clean.
    // 'image' is included so users can paste or insert images for future phases.
    var quillMountEl = document.getElementById('uwm-ra-quill-mount');
    quillInstance = new window.Quill(quillMountEl, {
      theme:   'snow',
      placeholder: 'Draft reply will appear here\u2026',
      modules: {
        toolbar: [
          [{ header: [false, 1, 2, 3] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link', 'image'],
          ['clean']
        ]
      }
    });

    // ── PLACEHOLDER DRAFT ──
    // Pre-loaded with a realistic placeholder reply so the Insert flow can be
    // tested immediately without waiting for real search integration.
    quillInstance.clipboard.dangerouslyPasteHTML([
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
    ].join(''));

    // Focus Quill so the user can start typing immediately
    quillInstance.focus();

    // ── SIMULATED SEARCH COMPLETE (placeholder) ──
    setTimeout(function () {
      var el = document.getElementById('uwm-ra-searching');
      if (el) el.innerHTML = '<span style="color:#4ade80;font-size:12px;">&#10003; Search complete</span>';
    }, 2000);

    // ── EVENT WIRING ──

    document.getElementById('uwm-ra-minimize-btn').addEventListener('click', minimizePopup);

    // INSERT — reads HTML from Quill, prepends to top of Neurons compose editor
    document.getElementById('uwm-ra-insert').addEventListener('click', function () {
      if (!quillInstance) {
        alert('[UWM Reply Assistant] Quill editor not initialised.');
        return;
      }
      var html = quillInstance.root.innerHTML;
      // Quill's empty state is '<p><br></p>' — treat this as empty
      if (!html || html === '<p><br></p>' || !html.trim()) {
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

    // Click on the darkened backdrop minimizes (doesn't close) so draft is preserved
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

    console.log(LOG, 'Pop-up displayed with Quill editor');
  }

  // ── HANDLE COMPOSE DIALOG ─────────────────────────────────────────────────────
  // Both viewer and reply dialogs share identical markup. The ONLY reliable
  // difference is that the compose dialog is NEW — created after Reply is clicked.
  // Strategy:
  //   1. At init, snapshot all existing .x-frs-modal-form IDs → knownDialogIds
  //   2. Skip any dialog whose ID is in knownDialogIds
  //   3. New dialogs also pass through isComposeDialog() as a secondary guard
  function handleDialog(dialogEl, innerDoc) {
    if (seenDialogs[dialogEl.id])   return; // already processed
    if (knownDialogIds[dialogEl.id]) return; // existed before we started watching

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

    // Cleanup poller — watches for Neurons to close the compose dialog
    if (cleanPoller) clearInterval(cleanPoller);
    cleanPoller = setInterval(function () {
      var currentDoc = getInnerDoc(); // fresh reference every interval
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
  // First poll takes a snapshot of all pre-existing dialog IDs → knownDialogIds.
  // Subsequent polls call handleDialog() only for dialogs NOT in that set.
  // MutationObserver is disabled (see FIX 1 above) — poller alone is used.
  function startPoller() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(function () {
      var innerDoc = getInnerDoc(); // must be called fresh — never use a cached ref
      if (!innerDoc) return;
      var dialogs = innerDoc.querySelectorAll('.x-frs-modal-form');

      if (!snapshotTaken) {
        for (var s = 0; s < dialogs.length; s++) {
          knownDialogIds[dialogs[s].id] = true;
        }
        snapshotTaken = true;
        console.log(LOG, 'Snapshot taken — ' + dialogs.length + ' pre-existing dialog(s) ignored');
        return;
      }

      for (var i = 0; i < dialogs.length; i++) {
        handleDialog(dialogs[i], innerDoc);
      }
    }, 500);
  }

  // ── OBSERVER STUB (FIX 1) ────────────────────────────────────────────────────
  // MutationObserver disabled entirely. It was firing at ~300ms and defeating
  // the snapshotTaken guard, causing triggers to appear on the VIEWER dialog
  // before the compose dialog existed. The poller alone is sufficient.
  function startObserver(innerDoc) {
    console.log(LOG, 'Observer disabled — poller-only mode (v1.16)');
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
    startObserver(innerDoc); // stub — does nothing
    startPoller();
    console.log(LOG, 'v1.16 initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }

})();
