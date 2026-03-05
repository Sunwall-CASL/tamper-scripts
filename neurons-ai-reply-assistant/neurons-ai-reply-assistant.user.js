// ==UserScript==
// @name         Neurons - Reply Assistant (Detection)
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.4
// @description  Detects email compose/reply dialog and logs the email thread to the console.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  var LOG = '[UWM Reply Assistant]';
  var observerRef  = null;
  var pollInterval = null;
  var seenDialogs  = {};
  // ── FRAME HELPERS ────────────────────────────────────────────────────────────
  // Returns the managed iframe with the largest offsetWidth — always the active
  // Object Workspace. Multiple x-managed-iframes exist (Dashboard, etc.);
  // the widest one is always the incident workspace.
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
      console.log(LOG,
        'Message ' + (i + 1) + ':\n' +
        '  ' + to + '\n' +
        '  ' + from + '\n' +
        '  Subject : ' + (subject ? subject.textContent.trim() : '') + '\n' +
        '  Date    : ' + (stamp   ? stamp.textContent.trim()   : '') + '\n' +
        '  Body    : ' + (body    ? body.textContent.trim()    : '')
      );
    }
  }
  // ── DIALOG HANDLER ───────────────────────────────────────────────────────────
  function handleDialog(dialogEl, innerDoc) {
    if (seenDialogs[dialogEl.id]) return;
    // Confirm compose mode: find the first iframe inside the dialog and check
    // that its body has content. Neurons uses contentEditable (not designMode)
    // so we cannot rely on designMode === 'on'. Instead we confirm an iframe
    // exists and its body is accessible, which is true only for compose dialogs.
    var editorIframe = dialogEl.querySelectorAll('iframe')[0];
    var isCompose = false;
    if (editorIframe) {
      try {
        isCompose = !!(editorIframe.contentDocument && editorIframe.contentDocument.body);
      } catch (e) {}
    }
    if (!isCompose) return;
    seenDialogs[dialogEl.id] = true;
    console.log(LOG, 'Compose dialog detected (id=' + dialogEl.id + ')');
    readEmailThread(innerDoc);
  }
  // ── POLL FALLBACK ────────────────────────────────────────────────────────────
  function startPoller(innerDoc) {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(function () {
      var dialogs = innerDoc.querySelectorAll('.x-frs-modal-form');
      for (var i = 0; i < dialogs.length; i++) {
        handleDialog(dialogs[i], innerDoc);
      }
    }, 500);
  }
  // ── MUTATION OBSERVER ────────────────────────────────────────────────────────
  function startObserver(innerDoc) {
    if (observerRef) { try { observerRef.disconnect(); } catch (e) {} }
    observerRef = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node.nodeType !== 1) continue;
          var el = node;
          var steps = 0;
          while (el && el.tagName !== 'HTML' && steps < 30) {
            if (el.className && el.className.indexOf('x-frs-modal-form') !== -1) {
              (function (found) {
                setTimeout(function () { handleDialog(found, innerDoc); }, 250);
              }(el));
              break;
            }
            el = el.parentElement;
            steps++;
          }
        }
      }
    });
    observerRef.observe(innerDoc.body, { childList: true, subtree: true });
    console.log(LOG, 'Observer attached (subtree:true)');
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
    startPoller(innerDoc);
    console.log(LOG, 'v1.4 initialized');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }
})();
