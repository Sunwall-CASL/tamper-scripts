// ==UserScript==
// @name         Neurons - Reply Assistant (Detection)
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.0
// @description  Detects email compose/reply dialog and logs the email thread to the console.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  var LOG = '[UWM Reply Assistant]';
  var observerRef = null;
  // ── COPIED EXACTLY FROM REFERENCE SCRIPT ────────────────────────────────────
  function getAppFrame() {
    var frames = document.querySelectorAll('iframe.x-managed-iframe');
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentDocument && frames[i].offsetWidth > 100) return frames[i];
      } catch (e) {}
    }
    return null;
  }
  function getInnerDoc() {
    var f = getAppFrame();
    return f ? f.contentDocument : null;
  }
  // ── EMAIL THREAD READER ──────────────────────────────────────────────────────
  function readEmailThread(innerDoc) {
    var items = innerDoc.querySelectorAll('.flex-list-item-mail');
    if (!items.length) {
      console.log(LOG, 'No email thread items found (.flex-list-item-mail)');
      return;
    }
    console.log(LOG, 'Email thread — ' + items.length + ' message(s) found:');
    for (var i = 0; i < items.length; i++) {
      var item     = items[i];
      var emailEls = item.querySelectorAll('.flex-list-item-email');
      var to       = emailEls[0] ? emailEls[0].textContent.trim() : '';
      var from     = emailEls[1] ? emailEls[1].textContent.trim() : '';
      var subject  = item.querySelector('.flex-list-item-subject');
      var body     = item.querySelector('.flex-list-item-commentText');
      var stamp    = item.querySelector('.flex-list-item-stamp');
      console.log(
        LOG,
        'Message ' + (i + 1) + ':\\n' +
        '  ' + to + '\\n' +
        '  ' + from + '\\n' +
        '  Subject : ' + (subject ? subject.textContent.trim() : '') + '\\n' +
        '  Date    : ' + (stamp   ? stamp.textContent.trim()   : '') + '\\n' +
        '  Body    : ' + (body    ? body.textContent.trim()    : '')
      );
    }
  }
  // ── DIALOG DETECTION ─────────────────────────────────────────────────────────
  function onNodeAdded(node, innerDoc) {
    // Must be an element node
    if (node.nodeType !== 1) return;
    // Direct match: the dialog itself was added
    if (node.className && node.className.indexOf('x-frs-modal-form') !== -1) {
      handleDialogDetected(node, innerDoc);
      return;
    }
    // Subtree match: unlikely given dialogs are direct body children, but safe fallback
    var nested = node.querySelector ? node.querySelector('.x-frs-modal-form') : null;
    if (nested) {
      handleDialogDetected(nested, innerDoc);
    }
  }
  function handleDialogDetected(dialogEl, innerDoc) {
    // Confirm it has a live compose editor (designMode=on) so we don't
    // fire on read-only views that also carry x-frs-modal-form
    var editorIframe = dialogEl.querySelector('.x-html-editor-wrap iframe');
    var isCompose = false;
    if (editorIframe) {
      try {
        isCompose = (editorIframe.contentDocument.designMode === 'on');
      } catch (e) {}
    }
    if (!isCompose) return; // skip non-compose dialogs
    console.log(LOG, 'Compose dialog detected (id=' + dialogEl.id + ')');
    readEmailThread(innerDoc);
  }
  // ── MUTATION OBSERVER ────────────────────────────────────────────────────────
  function startObserver(innerDoc) {
    if (observerRef) {
      try { observerRef.disconnect(); } catch (e) {}
    }
    observerRef = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          onNodeAdded(added[n], innerDoc);
        }
      }
    });
    // childList on body is enough — dialogs are direct body children
    observerRef.observe(innerDoc.body, { childList: true });
    console.log(LOG, 'Observer attached to innerDoc.body');
  }
  // ── INIT (same retry pattern as reference script) ────────────────────────────
  var initAttempts = 0;
  function init() {
    initAttempts++;
    var innerDoc = getInnerDoc();
    if (!innerDoc || !innerDoc.body) {
      if (initAttempts < 30) setTimeout(init, 500);
      return;
    }
    startObserver(innerDoc);
    console.log(LOG, 'v1.0 initialized');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }
})();
