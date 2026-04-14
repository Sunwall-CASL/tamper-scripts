// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.23
// @description  Detects reply/compose dialog, injects AI-assist pop-up with native contentEditable editor.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// ── CHANGES IN v1.23 ─────────────────────────────────────────────────────────
//
// FIX — Ordered / unordered list buttons appeared non-functional:
//   Diagnostic confirmed execCommand('insertUnorderedList') and
//   ('insertOrderedList') were actually executing correctly and returning true,
//   and the DOM was being updated with valid <ul>/<ol>/<li> markup. The visual
//   problem was that the Neurons/Ivanti host page's ext-all.css global reset
//   applies `list-style: none` and `padding-left: 0` to ALL ul/ol on the page,
//   overriding browser defaults inside the contentEditable editor. The fix is
//   scoped CSS added to injectStyles() that restores list-style, padding, and
//   display:list-item exclusively inside #uwm-ra-editor using !important to
//   win the specificity battle against the host reset.
//   No changes to execCmd() — it was correct in v1.22.
//
// All v1.22 fixes retained.

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

  var pollTickCount  = 0;
  var SNAPSHOT_TICKS = 10;

  // Default width for images inserted via the drop popup
  var IMG_DEFAULT_WIDTH = 300;

  // Saved selection range for image insertion (cursor position before popup opens)
  var savedImageRange = null;

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

  // ── IS COMPOSE DIALOG? ────────────────────────────────────────────────────────
  function isComposeDialog(dialogEl) {
    var iframes = dialogEl.querySelectorAll('iframe');
    for (var k = 0; k < iframes.length; k++) {
      try {
        var iDoc = iframes[k].contentDocument;
        if (iDoc && iDoc.body &&
            (iDoc.body.isContentEditable || iDoc.designMode === 'on')) {
          return true;
        }
      } catch (e) {}
    }
    if (iframes.length === 0) {
      if (dialogEl.querySelector('.x-html-editor-tb, .x-html-editor-wrap')) {
        return true;
      }
    }
    return false;
  }

  // ── FIND COMPOSE EDITOR IFRAME ───────────────────────────────────────────────
  function getEditorIframe(dialogEl) {
    var iframes  = dialogEl.querySelectorAll('iframe');
    var fallback = null;
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (!doc || !doc.body) continue;
        if (doc.body.isContentEditable || doc.designMode === 'on') {
          console.log(LOG, 'getEditorIframe: editable iframe at index ' + i);
          return iframes[i];
        }
        if (!fallback) fallback = iframes[i];
      } catch (e) {}
    }
    if (fallback) console.log(LOG, 'getEditorIframe: using fallback iframe');
    return fallback;
  }

  // ── TOOLBAR execCommand HELPER ────────────────────────────────────────────────
  // Must call execCommand on editor.ownerDocument, not on `document` (the outer
  // page). The outer document's execCommand operates on the outer page's
  // selection (always empty). Bold/italic/underline happen to work in some
  // environments despite this, but list commands require the correct document.
  function execCmd(cmd, value) {
    var editor = document.getElementById('uwm-ra-editor');
    if (!editor) return;
    editor.focus();
    // Run the command on the div's own document so it targets the correct selection
    editor.ownerDocument.execCommand(cmd, false, value || null);
  }

  // After inserting a link, ensure all <a> tags in the editor open in a new tab
  function fixLinksNewTab() {
    var editor = document.getElementById('uwm-ra-editor');
    if (!editor) return;
    var links = editor.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      links[i].target = '_blank';
      links[i].rel    = 'noopener noreferrer';
    }
  }

  // ── INJECT STYLES ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('uwm-ra-styles')) return;
    var css = '';

    css += '#uwm-ra-trigger-btn {';
    css += '  display: inline-flex; align-items: center; gap: 5px;';
    css += '  padding: 3px 10px; margin-left: 8px;';
    css += '  background: #1a2744; color: #7db3e8;';
    css += '  border: 1px solid #2d4a7a; border-radius: 4px;';
    css += '  font-size: 12px; font-weight: 600; cursor: pointer;';
    css += '  font-family: "Segoe UI", system-ui, sans-serif;';
    css += '  vertical-align: middle; white-space: nowrap; line-height: 1.5;';
    css += '  transition: background 0.15s, color 0.15s; pointer-events: all;';
    css += '}';
    css += '#uwm-ra-trigger-btn:hover { background: #243660; color: #a8d4f5; }';

    css += '#uwm-ra-badge {';
    css += '  position: fixed; z-index: 999990;';
    css += '  background: #1a2744; color: #7db3e8;';
    css += '  border: 1px solid #2d4a7a; border-radius: 20px;';
    css += '  padding: 5px 12px 5px 9px;';
    css += '  font-size: 11.5px; font-weight: 600; cursor: pointer;';
    css += '  font-family: "Segoe UI", system-ui, sans-serif;';
    css += '  display: flex; align-items: center; gap: 5px;';
    css += '  box-shadow: 0 4px 16px rgba(0,0,0,0.25);';
    css += '  user-select: none; bottom: 20px; right: 20px;';
    css += '  transition: background 0.15s, transform 0.15s; pointer-events: all;';
    css += '}';
    css += '#uwm-ra-badge:hover { background: #243660; transform: translateY(-1px); }';
    css += '#uwm-ra-badge .ra-badge-dot {';
    css += '  width: 7px; height: 7px; border-radius: 50%; background: #3b82f6; flex-shrink: 0;';
    css += '  animation: ra-pulse 2s ease-in-out infinite;';
    css += '}';
    css += '@keyframes ra-pulse {';
    css += '  0%, 100% { opacity: 1; transform: scale(1); }';
    css += '  50% { opacity: 0.5; transform: scale(0.85); }';
    css += '}';

    css += '#uwm-ra-overlay {';
    css += '  position: fixed; inset: 0; z-index: 999998;';
    css += '  background: rgba(15,20,30,0.55);';
    css += '  display: flex; align-items: center; justify-content: center;';
    css += '  font-family: "Segoe UI", system-ui, sans-serif;';
    css += '}';
    css += '#uwm-ra-overlay.ra-hidden { display: none; }';

    css += '#uwm-ra-panel {';
    css += '  width: 920px; max-width: 96vw; height: 640px; max-height: 92vh;';
    css += '  background: #f7f8fa; border-radius: 10px;';
    css += '  box-shadow: 0 24px 64px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.15);';
    css += '  display: flex; flex-direction: column; overflow: hidden;';
    css += '  border: 1px solid #d0d5dd; pointer-events: all;';
    css += '}';

    css += '#uwm-ra-header {';
    css += '  background: #1a2744; color: #fff;';
    css += '  padding: 12px 18px; display: flex; align-items: center; gap: 10px; flex-shrink: 0;';
    css += '}';
    css += '#uwm-ra-header .ra-logo { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.9; }';
    css += '#uwm-ra-header .ra-header-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }';
    css += '#uwm-ra-header .ra-version { font-size: 11px; opacity: 0.45; }';
    css += '#uwm-ra-minimize-btn {';
    css += '  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);';
    css += '  color: #fff; border-radius: 5px; cursor: pointer;';
    css += '  font-size: 14px; padding: 2px 9px; line-height: 1.6;';
    css += '  transition: background 0.15s; pointer-events: all;';
    css += '}';
    css += '#uwm-ra-minimize-btn:hover { background: rgba(255,255,255,0.22); }';

    css += '#uwm-ra-confidence {';
    css += '  display: flex; align-items: center; gap: 8px; padding: 8px 18px; font-size: 12.5px;';
    css += '  border-bottom: 1px solid #e2e5ec; flex-shrink: 0; background: #fffbf0;';
    css += '}';
    css += '#uwm-ra-confidence .ra-dot { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }';
    css += '.ra-dot-green  { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18); }';
    css += '.ra-dot-yellow { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.18); }';
    css += '.ra-dot-red    { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.18); }';

    css += '#uwm-ra-body { display: flex; flex: 1; overflow: hidden; }';

    css += '#uwm-ra-citations {';
    css += '  width: 265px; flex-shrink: 0; background: #1e2b45; color: #c8d0e0;';
    css += '  overflow-y: auto; padding: 14px 0; display: flex; flex-direction: column;';
    css += '}';
    css += '#uwm-ra-citations .ra-cit-heading { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #6b7fa3; padding: 0 14px 8px 14px; }';
    css += '.ra-cit-tier { padding: 8px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); }';
    css += '.ra-cit-tier-label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #5b7fa3; margin-bottom: 5px; }';
    css += '.ra-cit-item { margin-bottom: 8px; }';
    css += '.ra-cit-item a { font-size: 12px; color: #7db3e8; text-decoration: none; display: block; line-height: 1.35; }';
    css += '.ra-cit-item a:hover { text-decoration: underline; }';
    css += '.ra-cit-item .ra-cit-excerpt { font-size: 11px; color: #8a97ae; margin-top: 2px; line-height: 1.4; }';
    css += '.ra-cit-none { font-size: 11px; color: #4a5a72; font-style: italic; }';
    css += '.ra-cit-community-note { font-size: 10px; color: #a08050; background: rgba(245,158,11,0.12); border-radius: 3px; padding: 2px 5px; margin-top: 3px; display: inline-block; }';

    css += '#uwm-ra-editor-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #fff; }';

    css += '#uwm-ra-toolbar { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; padding: 6px 10px; border-bottom: 1px solid #e2e5ec; background: #f7f8fa; flex-shrink: 0; }';
    css += '.ra-tb-btn { background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; font-size: 13px; padding: 3px 7px; color: #374151; transition: background 0.12s, border-color 0.12s; line-height: 1.4; pointer-events: all; }';
    css += '.ra-tb-btn:hover { background: #e5e7eb; border-color: #d0d5dd; }';
    css += '.ra-tb-sep { width: 1px; height: 18px; background: #d0d5dd; margin: 0 4px; }';

    css += '#uwm-ra-editor {';
    css += '  flex: 1; overflow-y: auto; padding: 14px 18px;';
    css += '  font-size: 13.5px; font-family: "Segoe UI", system-ui, sans-serif;';
    css += '  line-height: 1.6; color: #1f2937; outline: none; min-height: 0;';
    css += '  cursor: text; pointer-events: all;';
    css += '}';
    css += '#uwm-ra-editor a { color: #1a5bb8; }';
    css += '#uwm-ra-editor img { max-width: 100%; height: auto; display: block; margin: 6px 0; }';

    // ── List style fix (v1.23) ────────────────────────────────────────────────
    // The Neurons/Ivanti host page's ext-all.css applies a global CSS reset:
    //   ol, ul { list-style: none; padding: 0; }
    // This strips bullets, numbers, and indentation from any <ul>/<ol> on the
    // page — including those created by execCommand inside our contentEditable
    // editor. The commands run correctly and produce valid markup, but nothing
    // is visible. These scoped rules override the host reset using !important,
    // restoring proper list rendering exclusively inside #uwm-ra-editor.
    css += '#uwm-ra-editor ul,';
    css += '#uwm-ra-editor ol {';
    css += '  list-style: initial !important;';
    css += '  padding-left: 2em !important;';
    css += '  margin: 0.5em 0 !important;';
    css += '}';
    css += '#uwm-ra-editor ul { list-style-type: disc !important; }';
    css += '#uwm-ra-editor ol { list-style-type: decimal !important; }';
    css += '#uwm-ra-editor li {';
    css += '  display: list-item !important;';
    css += '  list-style-position: outside !important;';
    css += '}';
    // ─────────────────────────────────────────────────────────────────────────

    css += '#uwm-ra-footer { padding: 10px 16px; border-top: 1px solid #e2e5ec; display: flex; align-items: center; gap: 10px; background: #f7f8fa; flex-shrink: 0; }';
    css += '.ra-btn { padding: 7px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; pointer-events: all; }';
    css += '#uwm-ra-insert { background: #1a5bb8; color: #fff; }';
    css += '#uwm-ra-insert:hover { background: #1549a0; }';
    css += '#uwm-ra-cancel { background: #e5e7eb; color: #374151; }';
    css += '#uwm-ra-cancel:hover { background: #d1d5db; }';

    css += '.ra-thumbs { display: flex; gap: 6px; margin-left: auto; }';
    css += '.ra-thumb-btn { background: none; border: 1px solid #d0d5dd; border-radius: 6px; cursor: pointer; font-size: 16px; padding: 4px 10px; transition: background 0.15s, border-color 0.15s; pointer-events: all; }';
    css += '.ra-thumb-btn:hover { background: #e5e7eb; }';
    css += '.ra-thumb-btn.ra-thumb-selected { background: #dbeafe; border-color: #3b82f6; }';

    css += '#uwm-ra-searching { font-size: 12px; color: #6b7fa3; margin-left: 8px; display: flex; align-items: center; gap: 6px; }';
    css += '.ra-spinner { width: 13px; height: 13px; border: 2px solid #d0d5dd; border-top-color: #3b82f6; border-radius: 50%; flex-shrink: 0; animation: ra-spin 0.7s linear infinite; }';
    css += '@keyframes ra-spin { to { transform: rotate(360deg); } }';

    css += '#uwm-ra-minibar { position: fixed; bottom: 0; left: 0; right: 0; z-index: 999999; background: #1a2744; color: #fff; display: flex; align-items: center; gap: 12px; padding: 10px 20px; box-shadow: 0 -4px 20px rgba(0,0,0,0.3); font-family: "Segoe UI", system-ui, sans-serif; }';
    css += '#uwm-ra-minibar.ra-hidden { display: none; }';
    css += '#uwm-ra-minibar .ra-mini-icon { font-size: 16px; opacity: 0.8; }';
    css += '#uwm-ra-minibar .ra-mini-label { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }';
    css += '#uwm-ra-minibar .ra-mini-sub { font-size: 11px; opacity: 0.5; margin-left: 2px; }';
    css += '.ra-mini-btn { padding: 5px 16px; border-radius: 5px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: none; transition: background 0.15s; pointer-events: all; }';
    css += '#uwm-ra-mini-restore { background: #2563eb; color: #fff; margin-left: auto; }';
    css += '#uwm-ra-mini-restore:hover { background: #1d4ed8; }';
    css += '#uwm-ra-mini-discard { background: rgba(255,255,255,0.1); color: #fca5a5; border: 1px solid rgba(255,100,100,0.3); }';
    css += '#uwm-ra-mini-discard:hover { background: rgba(255,80,80,0.2); }';

    css += '#uwm-ra-warn-overlay { position: fixed; inset: 0; z-index: 1000000; background: rgba(15,20,30,0.65); display: flex; align-items: center; justify-content: center; font-family: "Segoe UI", system-ui, sans-serif; }';
    css += '#uwm-ra-warn-box { background: #fff; border-radius: 10px; padding: 28px 32px; width: 400px; max-width: 92vw; box-shadow: 0 16px 48px rgba(0,0,0,0.3); border: 1px solid #e2e5ec; }';
    css += '#uwm-ra-warn-box h3 { margin: 0 0 10px 0; font-size: 16px; color: #111827; }';
    css += '#uwm-ra-warn-box p { margin: 0 0 22px 0; font-size: 13.5px; color: #6b7280; line-height: 1.5; }';
    css += '#uwm-ra-warn-box .ra-warn-actions { display: flex; gap: 10px; justify-content: flex-end; }';
    css += '#uwm-ra-warn-keep { background: #e5e7eb; color: #374151; }';
    css += '#uwm-ra-warn-keep:hover { background: #d1d5db; }';
    css += '#uwm-ra-warn-confirm { background: #dc2626; color: #fff; }';
    css += '#uwm-ra-warn-confirm:hover { background: #b91c1c; }';

    // ── Image drop popup styles ──
    css += '#uwm-ra-imgdrop-overlay {';
    css += '  position: fixed; inset: 0; z-index: 1000001;';
    css += '  background: rgba(0,0,0,0.65);';
    css += '  display: flex; align-items: center; justify-content: center;';
    css += '  font-family: "Segoe UI", system-ui, sans-serif;';
    css += '}';
    css += '#uwm-ra-imgdrop-box {';
    css += '  width: 420px; height: 280px;';
    css += '  background: #fff; border-radius: 12px;';
    css += '  border: 3px dashed #3a8fd8;';
    css += '  display: flex; flex-direction: column;';
    css += '  align-items: center; justify-content: center; gap: 12px;';
    css += '  box-shadow: 0 8px 32px rgba(0,0,0,0.35);';
    css += '  transition: background 0.15s, border-color 0.15s;';
    css += '  cursor: default;';
    css += '}';
    css += '#uwm-ra-imgdrop-box.ra-drop-hover {';
    css += '  background: #e8f4fd; border-color: #1a6fb5;';
    css += '}';
    css += '#uwm-ra-imgdrop-icon { font-size: 52px; line-height: 1; user-select: none; }';
    css += '#uwm-ra-imgdrop-label { font-size: 20px; font-weight: 700; color: #222; user-select: none; }';
    css += '#uwm-ra-imgdrop-sub { font-size: 13px; color: #666; user-select: none; }';
    css += '#uwm-ra-imgdrop-cancel { margin-top: 6px; font-size: 12px; color: #999; cursor: pointer; text-decoration: underline; user-select: none; }';
    css += '#uwm-ra-imgdrop-cancel:hover { color: #555; }';
    css += '#uwm-ra-imgdrop-box.ra-drop-error { border-color: #c0392b; background: #fff0ee; }';

    var style = document.createElement('style');
    style.id          = 'uwm-ra-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── BADGE VISIBILITY HELPERS ──────────────────────────────────────────────────
  function hideBadge() {
    var badge = document.getElementById('uwm-ra-badge');
    if (badge) badge.style.display = 'none';
  }

  function restoreBadge() {
    var badge = document.getElementById('uwm-ra-badge');
    if (badge) badge.style.display = '';
  }

  // ── REMOVE TRIGGERS ───────────────────────────────────────────────────────────
  // ONLY called when the compose dialog closes. Never called on Insert/Cancel/Discard.
  function removeTriggers() {
    var innerDoc = getInnerDoc();
    if (innerDoc) {
      var btn = innerDoc.getElementById('uwm-ra-trigger-btn');
      if (btn) btn.remove();
    }
    var badge = document.getElementById('uwm-ra-badge');
    if (badge) badge.remove();
  }

  // ── INJECT TOOLBAR BUTTON ─────────────────────────────────────────────────────
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
    if (overlay) overlay.classList.add('ra-hidden');
    if (minibar) minibar.classList.remove('ra-hidden');
    hideBadge();
    isMinimized = true;
    console.log(LOG, 'Pop-up minimized');
  }

  function restorePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    if (overlay) overlay.classList.remove('ra-hidden');
    if (minibar) minibar.classList.add('ra-hidden');
    hideBadge();
    isMinimized = false;
    var editor = document.getElementById('uwm-ra-editor');
    if (editor) editor.focus();
    console.log(LOG, 'Pop-up restored');
  }

  function closePopup() {
    var overlay = document.getElementById('uwm-ra-overlay');
    var minibar = document.getElementById('uwm-ra-minibar');
    var warn    = document.getElementById('uwm-ra-warn-overlay');
    var imgDrop = document.getElementById('uwm-ra-imgdrop-overlay');
    if (overlay) overlay.remove();
    if (minibar) minibar.remove();
    if (warn)    warn.remove();
    if (imgDrop) imgDrop.remove();
    popupActive = false;
    isMinimized = false;
    savedImageRange = null;
    if (escListener) {
      document.removeEventListener('keydown', escListener);
      escListener = null;
    }
    restoreBadge();
    console.log(LOG, 'Pop-up closed');
  }

  // ── CANCEL WARNING ────────────────────────────────────────────────────────────
  function showCancelWarning() {
    if (isMinimized) restorePopup();
    var warn = document.createElement('div');
    warn.id  = 'uwm-ra-warn-overlay';
    warn.innerHTML =
      '<div id="uwm-ra-warn-box">' +
        '<h3>Discard this draft?</h3>' +
        '<p>Your draft reply and any edits will be permanently lost. This cannot be undone.</p>' +
        '<div class="ra-warn-actions">' +
          '<button class="ra-btn" id="uwm-ra-warn-keep">Keep editing</button>' +
          '<button class="ra-btn" id="uwm-ra-warn-confirm">Yes, discard draft</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(warn);
    document.getElementById('uwm-ra-warn-keep').addEventListener('click', function () {
      warn.remove();
    });
    document.getElementById('uwm-ra-warn-confirm').addEventListener('click', function () {
      console.log(LOG, 'Draft discarded by user confirmation');
      closePopup();
    });
    warn.addEventListener('click', function (e) { if (e.target === warn) warn.remove(); });
  }

  // ── IMAGE DROP POPUP ──────────────────────────────────────────────────────────
  // Opens a full-screen drop zone. On successful drop, inserts the image as a
  // base64 <img> at the saved cursor position in the Reply Assistant editor.
  // The image travels with the HTML when Insert into Email is clicked.
  function showImageDropPopup() {
    if (document.getElementById('uwm-ra-imgdrop-overlay')) return;

    // Save the current cursor position in the RA editor before opening overlay
    var editor = document.getElementById('uwm-ra-editor');
    if (editor) {
      var sel = editor.ownerDocument.getSelection();
      if (sel && sel.rangeCount > 0) {
        savedImageRange = sel.getRangeAt(0).cloneRange();
      } else {
        // Default to end of editor content
        savedImageRange = editor.ownerDocument.createRange();
        savedImageRange.selectNodeContents(editor);
        savedImageRange.collapse(false);
      }
    }

    var overlay = document.createElement('div');
    overlay.id  = 'uwm-ra-imgdrop-overlay';

    var box = document.createElement('div');
    box.id  = 'uwm-ra-imgdrop-box';

    var icon = document.createElement('div');
    icon.id          = 'uwm-ra-imgdrop-icon';
    icon.textContent = '\uD83D\uDDBC'; // 🖼

    var label = document.createElement('div');
    label.id          = 'uwm-ra-imgdrop-label';
    label.textContent = 'Drop image here';

    var sub = document.createElement('div');
    sub.id          = 'uwm-ra-imgdrop-sub';
    sub.textContent = 'PNG, JPG, GIF, WEBP — releases instantly on drop';

    var cancelBtn = document.createElement('div');
    cancelBtn.id          = 'uwm-ra-imgdrop-cancel';
    cancelBtn.textContent = 'Cancel (Esc)';
    cancelBtn.addEventListener('click', closeImageDropPopup);

    box.appendChild(icon);
    box.appendChild(label);
    box.appendChild(sub);
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Close on backdrop click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeImageDropPopup();
    });

    // Drag visual feedback
    box.addEventListener('dragenter', function (e) {
      e.preventDefault();
      box.classList.add('ra-drop-hover');
    });
    box.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    box.addEventListener('dragleave', function (e) {
      if (!box.contains(e.relatedTarget)) {
        box.classList.remove('ra-drop-hover');
      }
    });
    box.addEventListener('drop', handleImageDrop);

    // ESC closes image drop popup (but keeps RA panel open)
    document.addEventListener('keydown', imgDropEscHandler, true);

    console.log(LOG, 'Image drop popup opened');
  }

  function closeImageDropPopup() {
    var overlay = document.getElementById('uwm-ra-imgdrop-overlay');
    if (overlay) overlay.remove();
    document.removeEventListener('keydown', imgDropEscHandler, true);
    // Restore focus to the RA editor
    var editor = document.getElementById('uwm-ra-editor');
    if (editor) editor.focus();
    console.log(LOG, 'Image drop popup closed');
  }

  function imgDropEscHandler(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeImageDropPopup();
    }
  }

  function handleImageDrop(e) {
    e.preventDefault();
    e.stopPropagation();

    var files = [];
    for (var i = 0; i < e.dataTransfer.files.length; i++) {
      if (e.dataTransfer.files[i].type.indexOf('image/') === 0) {
        files.push(e.dataTransfer.files[i]);
      }
    }

    if (files.length === 0) {
      showImageDropError('No image found. Please drop a PNG, JPG, GIF, or WEBP file.');
      return;
    }

    var file   = files[0];
    var reader = new FileReader();
    reader.onload = function (ev) {
      closeImageDropPopup();
      insertImageInEditor(ev.target.result, file.name);
    };
    reader.onerror = function () {
      showImageDropError('Could not read the file. Please try again.');
    };
    reader.readAsDataURL(file);
  }

  function showImageDropError(msg) {
    var box   = document.getElementById('uwm-ra-imgdrop-box');
    var label = document.getElementById('uwm-ra-imgdrop-label');
    var sub   = document.getElementById('uwm-ra-imgdrop-sub');
    if (!box) return;
    box.classList.add('ra-drop-error');
    if (label) { label.textContent = 'Error'; label.style.color = '#c0392b'; }
    if (sub)   { sub.textContent   = msg; }
  }

  // Insert a base64 image into the RA contentEditable editor at the saved cursor
  function insertImageInEditor(dataUrl, filename) {
    var editor = document.getElementById('uwm-ra-editor');
    if (!editor) {
      console.warn(LOG, 'insertImageInEditor: editor not found');
      return;
    }

    var editorDoc = editor.ownerDocument;
    editor.focus();

    // Restore the saved cursor position (from before the drop popup opened)
    if (savedImageRange) {
      var sel = editorDoc.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedImageRange);
      savedImageRange = null;
    }

    try {
      var safeName     = (filename || 'image').replace(/"/g, '&quot;');
      var uniqueMarker = 'ra-img-' + Date.now();
      var imgHTML = '<img src="' + dataUrl + '"'
        + ' alt="' + uniqueMarker + '"'
        + ' style="width:' + IMG_DEFAULT_WIDTH + 'px;height:auto;max-width:100%;display:block;margin:6px 0;">';

      var ok = editorDoc.execCommand('insertHTML', false, imgHTML);

      if (!ok) {
        // Fallback: manual DOM insertion
        var img = editorDoc.createElement('img');
        img.src       = dataUrl;
        img.alt       = uniqueMarker;
        img.style.cssText = 'width:' + IMG_DEFAULT_WIDTH + 'px;height:auto;max-width:100%;display:block;margin:6px 0;';
        var sel2  = editorDoc.getSelection();
        var range = sel2 && sel2.rangeCount > 0 ? sel2.getRangeAt(0) : null;
        if (range) {
          range.deleteContents();
          range.insertNode(img);
          var after = editorDoc.createRange();
          after.setStartAfter(img);
          after.collapse(true);
          sel2.removeAllRanges();
          sel2.addRange(after);
        } else {
          editor.appendChild(img);
        }
      }

      // Clean up the temp marker alt tag
      setTimeout(function () {
        var inserted = editor.querySelector('img[alt="' + uniqueMarker + '"]');
        if (inserted) inserted.alt = safeName;
      }, 50);

      console.log(LOG, 'Image inserted into RA editor (' + filename + ')');
    } catch (err) {
      console.error(LOG, 'Image insert failed:', err);
    }
  }

  // ── INSERT DRAFT INTO NEURONS COMPOSE ────────────────────────────────────────
  function insertDraftAtTop(editorIframe, draftHtml) {
    var editorBody = editorIframe.contentDocument.body;
    var editorDoc  = editorIframe.contentDocument;
    editorBody.insertAdjacentHTML('afterbegin', draftHtml);
    var evt = editorDoc.createEvent('Event');
    evt.initEvent('input', true, true);
    editorBody.dispatchEvent(evt);
    console.log(LOG, 'Draft prepended (' + draftHtml.length + ' chars)');
  }

  // ── POP-UP UI ─────────────────────────────────────────────────────────────────
  function showPopup(dialogEl, thread) {
    if (popupActive) {
      if (isMinimized) restorePopup();
      return;
    }
    popupActive = true;
    injectStyles();

    hideBadge();

    var overlay = document.createElement('div');
    overlay.id  = 'uwm-ra-overlay';
    overlay.innerHTML =
      '<div id="uwm-ra-panel">' +

        '<div id="uwm-ra-header">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7db3e8" stroke-width="2">' +
            '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
          '</svg>' +
          '<span class="ra-logo">Reply Assistant</span>' +
          '<span id="uwm-ra-searching"><span class="ra-spinner"></span>Searching knowledge base\u2026</span>' +
          '<div class="ra-header-actions">' +
            '<button id="uwm-ra-minimize-btn" title="Minimize \u2014 draft preserved">\u2013</button>' +
            '<span class="ra-version">v1.23</span>' +
          '</div>' +
        '</div>' +

        '<div id="uwm-ra-confidence">' +
          '<span class="ra-dot ra-dot-yellow"></span>' +
          '<strong style="font-size:12.5px;color:#92400e;">Best guess</strong>' +
          '<span style="color:#78716c;font-size:12px;margin-left:4px;">\u2014 reviewing search results. Verify before sending.</span>' +
        '</div>' +

        '<div id="uwm-ra-body">' +

          '<div id="uwm-ra-citations">' +
            '<div class="ra-cit-heading">Sources Consulted</div>' +
            '<div class="ra-cit-tier">' +
              '<div class="ra-cit-tier-label">Tier 1 \u2014 UWM Knowledge Base</div>' +
              '<div class="ra-cit-item">' +
                '<a href="https://kb.uwm.edu" target="_blank">Setting Up Your Canvas Course Site</a>' +
                '<div class="ra-cit-excerpt">Step-by-step guide to course creation, enrollment sync, and template use for UWM instructors.</div>' +
              '</div>' +
              '<div class="ra-cit-item">' +
                '<a href="https://kb.uwm.edu" target="_blank">Canvas \u2014 Adding a TA or Co-instructor</a>' +
                '<div class="ra-cit-excerpt">How to request additional user roles in a Canvas course via the UWM enrollment system.</div>' +
              '</div>' +
            '</div>' +
            '<div class="ra-cit-tier">' +
              '<div class="ra-cit-tier-label">Tier 2 \u2014 UWM Web</div>' +
              '<div class="ra-cit-none">Searched \u2014 no results found</div>' +
            '</div>' +
            '<div class="ra-cit-tier">' +
              '<div class="ra-cit-tier-label">Tier 3 \u2014 UW System KB</div>' +
              '<div class="ra-cit-item">' +
                '<a href="https://kb.wisconsin.edu" target="_blank">Canvas LTI Tool Availability \u2014 UW System</a>' +
                '<div class="ra-cit-excerpt">Which LTI integrations are enabled system-wide vs. configured at the institution level.</div>' +
              '</div>' +
            '</div>' +
            '<div class="ra-cit-tier">' +
              '<div class="ra-cit-tier-label">Tier 4 \u2014 Canvas Community</div>' +
              '<div class="ra-cit-item">' +
                '<a href="https://community.instructure.com" target="_blank">How do I add files to a course? [Solved]</a>' +
                '<div class="ra-cit-excerpt">Official Instructure documentation on the Canvas Files tool, upload limits, and folder structure.</div>' +
                '<div class="ra-cit-community-note">&#9873; Peer-generated community thread</div>' +
              '</div>' +
            '</div>' +
            '<div class="ra-cit-tier" style="border-bottom:none;">' +
              '<div class="ra-cit-tier-label">Memory Store</div>' +
              '<div class="ra-cit-none">No similar past answers found</div>' +
            '</div>' +
          '</div>' +

          '<div id="uwm-ra-editor-area">' +
            '<div id="uwm-ra-toolbar">' +
              '<button class="ra-tb-btn" data-cmd="bold"      title="Bold (Ctrl+B)"><b>B</b></button>' +
              '<button class="ra-tb-btn" data-cmd="italic"    title="Italic (Ctrl+I)"><i>I</i></button>' +
              '<button class="ra-tb-btn" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>' +
              '<div class="ra-tb-sep"></div>' +
              '<button class="ra-tb-btn" data-cmd="insertUnorderedList" title="Bullet list">\u2022 List</button>' +
              '<button class="ra-tb-btn" data-cmd="insertOrderedList"   title="Numbered list">1. List</button>' +
              '<div class="ra-tb-sep"></div>' +
              '<button class="ra-tb-btn" id="uwm-ra-link-btn"  title="Insert hyperlink (opens in new tab)">\uD83D\uDD17 Link</button>' +
              '<button class="ra-tb-btn" id="uwm-ra-image-btn" title="Insert image (drop PNG, JPG, GIF, WEBP)">\uD83D\uDDBC\uFE0F Image</button>' +
              '<div class="ra-tb-sep"></div>' +
              '<button class="ra-tb-btn" data-cmd="removeFormat" title="Remove bold, italic, underline, and color from selected text">\u2715 Clear formatting</button>' +
            '</div>' +
            '<div id="uwm-ra-editor" contenteditable="true" spellcheck="true"></div>' +
          '</div>' +

        '</div>' +

        '<div id="uwm-ra-footer">' +
          '<button class="ra-btn" id="uwm-ra-insert">\u21b5 Insert into Email</button>' +
          '<button class="ra-btn" id="uwm-ra-cancel">Cancel</button>' +
          '<div class="ra-thumbs">' +
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-up"   title="Useful \u2014 save to memory">&#128077;</button>' +
            '<button class="ra-thumb-btn" id="uwm-ra-thumb-down" title="Not useful">&#128078;</button>' +
          '</div>' +
        '</div>' +

      '</div>';
    document.body.appendChild(overlay);

    var minibar = document.createElement('div');
    minibar.id  = 'uwm-ra-minibar';
    minibar.classList.add('ra-hidden');
    minibar.innerHTML =
      '<span class="ra-mini-icon">&#128172;</span>' +
      '<span class="ra-mini-label">Reply Assistant</span>' +
      '<span class="ra-mini-sub">\u2014 draft ready</span>' +
      '<button class="ra-mini-btn" id="uwm-ra-mini-restore">&#9650; Restore</button>' +
      '<button class="ra-mini-btn" id="uwm-ra-mini-discard">&#10005; Discard</button>';
    document.body.appendChild(minibar);

    // Placeholder draft
    document.getElementById('uwm-ra-editor').innerHTML =
      '<p>Hi [Instructor Name] ,</p>' +
      '<p>Thank you for reaching out to UWM CASL support.</p>' +
      '<p><em>Placeholder draft \u2014 will be replaced with a real AI-generated reply once search and Ollama integration are complete.</em></p>' +
      '<p>Based on what you\u2019ve described, here are some resources that may help:</p>' +
      '<ul>' +
        '<li>UWM Knowledge Base: <a href="https://kb.uwm.edu" target="_blank" rel="noopener noreferrer">Setting Up Your Canvas Course Site</a></li>' +
        '<li>Canvas Community: <a href="https://community.instructure.com" target="_blank" rel="noopener noreferrer">How do I add files to a course?</a></li>' +
      '</ul>' +
      '<p>Please let me know if you have any questions or if this doesn\u2019t resolve the issue \u2014 happy to help further.</p>' +
      '<p>Best,</p>';

    document.getElementById('uwm-ra-editor').focus();

    setTimeout(function () {
      var el = document.getElementById('uwm-ra-searching');
      if (el) el.innerHTML = '<span style="color:#4ade80;font-size:12px;">&#10003; Search complete</span>';
    }, 2000);

    // ── Toolbar: standard execCommand buttons ──
    var tbBtns = document.querySelectorAll('#uwm-ra-toolbar .ra-tb-btn[data-cmd]');
    for (var t = 0; t < tbBtns.length; t++) {
      (function (btn) {
        btn.addEventListener('mousedown', function (e) {
          // preventDefault keeps focus in the editor so selection is preserved
          e.preventDefault();
          execCmd(btn.getAttribute('data-cmd'));
        });
      }(tbBtns[t]));
    }

    // ── Link button: prompt for URL, insert link, force new tab ──
    document.getElementById('uwm-ra-link-btn').addEventListener('mousedown', function (e) {
      e.preventDefault();
      var url = prompt('Enter URL (will open in a new tab):', 'https://');
      if (url && url !== 'https://') {
        execCmd('createLink', url);
        // After inserting, ensure all links in the editor open in a new tab
        fixLinksNewTab();
      }
    });

    // ── Image button: save cursor position, open drop popup ──
    document.getElementById('uwm-ra-image-btn').addEventListener('mousedown', function (e) {
      e.preventDefault(); // keeps cursor position
      showImageDropPopup();
    });

    // ── Minimize ──
    document.getElementById('uwm-ra-minimize-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      minimizePopup();
    });

    // ── Insert into Email ──
    document.getElementById('uwm-ra-insert').addEventListener('click', function (e) {
      e.stopPropagation();
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
        console.log(LOG, 'Insert complete — badge and button remain for re-use');
      } catch (e2) {
        console.error(LOG, 'Insert failed:', e2);
        alert('[UWM Reply Assistant] Insert failed \u2014 see console. Error: ' + e2.message);
      }
    });

    // ── Cancel ──
    document.getElementById('uwm-ra-cancel').addEventListener('click', function (e) {
      e.stopPropagation();
      showCancelWarning();
    });

    // ── Thumbs ──
    document.getElementById('uwm-ra-thumb-up').addEventListener('click', function (e) {
      e.stopPropagation();
      this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-down').classList.remove('ra-thumb-selected');
      console.log(LOG, 'Thumbs up');
    });
    document.getElementById('uwm-ra-thumb-down').addEventListener('click', function (e) {
      e.stopPropagation();
      this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-up').classList.remove('ra-thumb-selected');
      console.log(LOG, 'Thumbs down');
    });

    // ── Backdrop click → minimize ──
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) minimizePopup();
    });

    // ── ESC key: minimize/restore RA panel; close image drop if open ──
    escListener = function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        // If image drop popup is open, ESC closes that first (handled by its own listener)
        if (document.getElementById('uwm-ra-imgdrop-overlay')) return;
        if (!popupActive) return;
        if (isMinimized) { restorePopup(); } else { minimizePopup(); }
      }
    };
    document.addEventListener('keydown', escListener);

    // ── Minibar restore / discard ──
    document.getElementById('uwm-ra-mini-restore').addEventListener('click', restorePopup);

    document.getElementById('uwm-ra-mini-discard').addEventListener('click', function () {
      console.log(LOG, 'Draft discarded from minibar');
      closePopup();
      delete seenDialogs[dialogEl.id];
    });

    console.log(LOG, 'Pop-up displayed');
  }

  // ── HANDLE COMPOSE DIALOG ─────────────────────────────────────────────────────
  function handleDialog(dialogEl, innerDoc) {
    if (seenDialogs[dialogEl.id])    return;
    if (knownDialogIds[dialogEl.id]) return;

    if (!isComposeDialog(dialogEl)) {
      knownDialogIds[dialogEl.id] = true;
      console.log(LOG, 'Dialog ' + dialogEl.id + ' is not compose — filed, will not re-check');
      return;
    }

    seenDialogs[dialogEl.id] = true;
    console.log(LOG, 'NEW compose dialog (id=' + dialogEl.id + ') — injecting triggers');

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
        console.log(LOG, 'Compose dialog closed — triggers removed');
      }
    }, 800);
  }

  // ── POLL FOR NEW DIALOGS ──────────────────────────────────────────────────────
  function startPoller() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(function () {
      var innerDoc = getInnerDoc();
      if (!innerDoc) return;

      pollTickCount++;
      var dialogs = innerDoc.querySelectorAll('.x-frs-modal-form');

      if (pollTickCount <= SNAPSHOT_TICKS) {
        for (var s = 0; s < dialogs.length; s++) {
          if (!knownDialogIds[dialogs[s].id]) {
            knownDialogIds[dialogs[s].id] = true;
          }
        }
        return;
      }

      for (var i = 0; i < dialogs.length; i++) {
        handleDialog(dialogs[i], innerDoc);
      }
    }, 500);
  }

  // ── OBSERVER STUB ─────────────────────────────────────────────────────────────
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
      else console.error(LOG, 'Init failed after ' + initAttempts + ' attempts');
      return;
    }
    startObserver(innerDoc);
    startPoller();
    console.log(LOG, 'v1.23 initialized — 5-second grace period active');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }

})();
