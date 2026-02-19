// ==UserScript==
// @name         Neurons – Cmd+K Hyperlink Inserter
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Press Cmd+K in any Neurons rich-text editor to insert a hyperlink
// @author       You
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  // Only run in the TOP frame - prevents double dialogs in child iframes
  if (window !== window.top) return;
  var DIALOG_ID = 'cmdk-hyperlink-dialog';
  var activeEditorDoc = null;
  var savedRange = null;
  var attachedDocs = new WeakSet();
  // ── Build the dialog (once) ──────────────────────────────────────────────
  function buildDialog() {
    if (document.getElementById(DIALOG_ID + '-overlay')) return;
    var style = document.createElement('style');
    style.id = 'cmdk-style';
    style.textContent = '#cmdk-hyperlink-dialog-overlay{display:none;position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.4);align-items:center;justify-content:center}#cmdk-hyperlink-dialog-overlay.visible{display:flex}#cmdk-hyperlink-dialog{background:#fff;border-radius:8px;padding:24px 28px 20px;box-shadow:0 8px 32px rgba(0,0,0,.3);min-width:380px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}#cmdk-hyperlink-dialog h3{margin:0 0 14px;font-size:15px;font-weight:600;color:#111}#cmdk-hyperlink-dialog label{display:block;font-size:12px;color:#555;margin-bottom:4px}#cmdk-hyperlink-dialog input{width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:7px 10px;font-size:14px;outline:none;margin-bottom:14px}#cmdk-hyperlink-dialog input:focus{border-color:#0070f3}#cmdk-hyperlink-dialog .cmdk-hint{font-size:11px;color:#888;margin-top:-10px;margin-bottom:14px}#cmdk-hyperlink-dialog .cmdk-row{display:flex;gap:8px;justify-content:flex-end}#cmdk-hyperlink-dialog button{padding:7px 18px;border-radius:4px;border:none;cursor:pointer;font-size:13px;font-weight:500}#cmdk-hyperlink-dialog .cmdk-cancel{background:#f1f1f1;color:#333}#cmdk-hyperlink-dialog .cmdk-insert{background:#0070f3;color:#fff}';
    document.head.appendChild(style);
    var overlay = document.createElement('div');
    overlay.id = DIALOG_ID + '-overlay';
    overlay.innerHTML =
      '<div id="' + DIALOG_ID + '">' +
        '<h3>Insert Hyperlink</h3>' +
        '<label>Link text <span id="cmdk-text-note" style="color:#aaa"></span></label>' +
        '<input type="text" id="cmdk-text-input" placeholder="Display text..." />' +
        '<label>URL</label>' +
        '<input type="text" id="cmdk-url-input" placeholder="https://" />' +
        '<div class="cmdk-hint">Tip: paste a URL then press Enter</div>' +
        '<div class="cmdk-row">' +
          '<button class="cmdk-cancel" id="cmdk-cancel-btn">Cancel</button>' +
          '<button class="cmdk-insert" id="cmdk-insert-btn">Insert Link</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('cmdk-cancel-btn').addEventListener('click', closeDialog);
    document.getElementById('cmdk-insert-btn').addEventListener('click', commitLink);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeDialog(); });
    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeDialog();
      if (e.key === 'Enter') commitLink();
    });
  }
  // ── Open ─────────────────────────────────────────────────────────────────
  function openDialog(editorDoc) {
    buildDialog();
    activeEditorDoc = editorDoc;
    var sel = editorDoc.defaultView.getSelection();
    savedRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
    var selectedText = sel ? sel.toString() : '';
    var textInput = document.getElementById('cmdk-text-input');
    var urlInput  = document.getElementById('cmdk-url-input');
    var textNote  = document.getElementById('cmdk-text-note');
    urlInput.value = '';
    if (selectedText) {
      textNote.textContent = '(using your selected text)';
      textInput.value = selectedText;
      textInput.style.display = 'none';
    } else {
      textNote.textContent = '(or leave blank to use the URL as text)';
      textInput.value = '';
      textInput.style.display = '';
    }
    document.getElementById(DIALOG_ID + '-overlay').classList.add('visible');
    setTimeout(function() { urlInput.focus(); }, 50);
  }
  // ── Close ────────────────────────────────────────────────────────────────
  function closeDialog() {
    var overlay = document.getElementById(DIALOG_ID + '-overlay');
    if (overlay) overlay.classList.remove('visible');
    activeEditorDoc = null;
    savedRange = null;
  }
  // ── Insert link ──────────────────────────────────────────────────────────
  function commitLink() {
    var urlRaw  = document.getElementById('cmdk-url-input').value.trim();
    var textVal = document.getElementById('cmdk-text-input').value.trim();
    if (!urlRaw || !activeEditorDoc) { closeDialog(); return; }
    var url = urlRaw;
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('mailto:')) {
      url = 'https://' + url;
    }
    // Capture locals BEFORE closeDialog() nulls the globals
    var editorDoc = activeEditorDoc;
    var editorWin = editorDoc.defaultView;
    var range = savedRange;
    var hasSelection = range && !range.collapsed;
    closeDialog();
    // Restore focus into the nested editor iframe
    try { editorWin.frameElement.ownerDocument.defaultView.focus(); } catch(e) {}
    editorWin.focus();
    editorDoc.body.focus();
    // Restore the saved selection
    var sel = editorWin.getSelection();
    sel.removeAllRanges();
    if (range) sel.addRange(range);
    // Insert the link
    if (hasSelection) {
      editorDoc.execCommand('createLink', false, url);
      try {
        var anchor = sel.anchorNode && sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('a');
        if (anchor) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
      } catch(e) {}
    } else {
      var linkText = textVal || url;
      var safe = linkText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      editorDoc.execCommand('insertHTML', false,
        '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + safe + '</a>');
    }
    // Notify ExtJS the field changed so it saves properly
    try {
      var frameEl = editorWin.frameElement;
      if (frameEl) {
        var outerWin = frameEl.ownerDocument.defaultView;
        if (outerWin && outerWin.Ext) {
          outerWin.Ext.ComponentMgr.all.each(function(cmp) {
            if (cmp.iframe && cmp.iframe.contentDocument === editorDoc) {
              if (typeof cmp.syncValue === 'function') cmp.syncValue();
              return false;
            }
          });
        }
      }
    } catch(e) {}
  }
  // ── Attach keydown listeners to designMode iframes ───────────────────────
  function attachToEditableIframes(win, depth) {
    if (depth > 4) return;
    try {
      var iframes = win.document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var childDoc = iframes[i].contentDocument;
          var childWin = iframes[i].contentWindow;
          if (!childDoc) continue;
          if (childDoc.designMode === 'on' && !attachedDocs.has(childDoc)) {
            attachedDocs.add(childDoc);
            (function(doc) {
              doc.addEventListener('keydown', function(e) {
                if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                  e.preventDefault();
                  e.stopPropagation();
                  openDialog(doc);
                }
              }, true);
            })(childDoc);
          }
          attachToEditableIframes(childWin, depth + 1);
        } catch(e) {}
      }
    } catch(e) {}
  }
  // ── Watcher loop (catches iframes opened after page load) ─────────────────
  function watch() {
    buildDialog();
    attachToEditableIframes(window, 0);
    setTimeout(watch, 2000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watch);
  } else {
    watch();
  }
})();
