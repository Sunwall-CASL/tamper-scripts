// ==UserScript==
// @name         Neurons - Reply Assistant (Detection)
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.1
// @description  Detects email compose/reply dialog and logs the email thread to the console.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  var LOG = '[UWM Reply Assistant]';
  var observerRef = null;
  var seenDialogs = {};
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
  function findModalAncestor(node) {
    // Walk up from node until we find .x-frs-modal-form or reach the top.
    // IMPORTANT: do NOT compare against a stored innerDoc reference — it may
    // become stale. Walk until tagName is HTML or parentElement is null.
    var el = node;
    var steps = 0;
    while (el && el.tagName !== 'HTML' && steps < 30) {
      if (el.className && el.className.indexOf('x-frs-modal-form') !== -1) {
        return el;
      }
      el = el.parentElement;
      steps++;
    }
    return null;
  }
  function handleDialogDetected(dialogEl, innerDoc) {
    // Confirm it has a live compose editor (designMode=on) so we don't
    // fire on read-only views that also carry x-frs-modal-form.
    var editorIframe = dialogEl.querySelector('.x-html-editor-wrap iframe');
    var isCompose = false;
    if (editorIframe) {
      try {
        isCompose = (editorIframe.contentDocument.designMode === 'on');
      } catch (e) {}
    }
    if (!isCompose) return;
    console.log(LOG, 'Compose dialog detected (id=' + dialogEl.id + ')');
    readEmailThread(innerDoc);
  }
  // ── MUTATION OBSERVER ────────────────────────────────────────────────────────
  function startObserver(innerDoc) {
    if (observerRef) {
      try { observerRef.disconnect(); } catch (e) {}
    }
    // BUG FIX: Use subtree:true.
    // ExtJS adds the dialog's outer <div> via a non-standard method that bypasses
    // childList mutations on body. However, it builds the dialog's internal content
    // (form rows, required-icon spans, etc.) using standard DOM calls which DO fire
    // subtree mutations. We walk up from each added node to find the modal ancestor.
    observerRef = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node.nodeType !== 1) continue;
          var dialogEl = findModalAncestor(node);
          if (!dialogEl) continue;
          // Debounce: each dialog fires several mutations; only handle it once.
          if (seenDialogs[dialogEl.id]) continue;
          seenDialogs[dialogEl.id] = true;
          // Use a short delay so the dialog is fully built before we inspect it.
          (function (el) {
            setTimeout(function () { handleDialogDetected(el, innerDoc); }, 200);
          }(dialogEl));
        }
      }
    });
    observerRef.observe(innerDoc.body, { childList: true, subtree: true });
    console.log(LOG, 'Observer attached to innerDoc.body (subtree:true)');
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
    console.log(LOG, 'v1.1 initialized');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }
})();
