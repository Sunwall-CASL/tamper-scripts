// ==UserScript==
// @name         Neurons - Reply Assistant
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.32
// @description  Detects reply/compose dialog, searches UWM KB + Canvas Community, injects AI-assist pop-up.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        GM_xmlhttpRequest
// @connect      kb.uwm.edu
// @connect      community.instructure.com
// @run-at       document-idle
// ==/UserScript==

// ── CHANGES IN v1.32 ─────────────────────────────────────────────────────────
//
// BUG FIX — Insert function not working (content disappears on Save):
//   Root cause identified via diagnostics: contentWindow.Ext is undefined, but
//   window.Ext IS accessible (version 3.1.0 confirmed present on outer page).
//   
//   insertDraftAtTop() rewritten to:
//     1. Access ExtJS via window.Ext instead of contentWindow.Ext
//     2. Find EmailBody component via ComponentMgr.all.map (Name === 'EmailBody')
//     3. Wrap inserted HTML in elementToProof div with font-size: 12pt
//        (matches Neurons' default wrapper, fixes font size mismatch)
//     4. Call setValue(wrappedHtml + currentValue) to update ExtJS state
//     5. Content now persists when Save is clicked AND displays at correct size
//
//   Signature changed back to: insertDraftAtTop(dialogEl, draftHtml)
//
// All v1.31 changes retained: CETL→CASL, signature removal after "Best,"
//
// All v1.30 functionality retained: KB search with bare numeric href handling,
// Canvas Community search, minimize/restore, image drop, citations panel.

// ── CHANGES IN v1.31 ─────────────────────────────────────────────────────────
//
// BUG FIX — Inserted content disappears when Save is clicked (ATTEMPTED FIX):
//   Diagnostics revealed: insertAdjacentHTML modifies DOM only, not ExtJS state.
//   Neurons saves from getValue(), not DOM. Attempted to use setValue() but
//   contentWindow.Ext was inaccessible. Fix deferred to v1.32.
//
// BUG FIX — Font size mismatch:
//   Diagnostics revealed Neurons wraps all content in elementToProof div with
//   inline style font-size: 12pt. Wrapper added to match (implemented in v1.32).
//
// CETL → CASL replacement:
//   Changed all references from "CETL" to "CASL" (Center for Advancing Student
//   Learning) across editor scaffolds, console logs, and UI text.
//
// Signature removal:
//   Editor scaffolds now end at "Best," — removed signature line as Neurons
//   auto-appends signature on send.

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

  var IMG_DEFAULT_WIDTH = 300;
  var savedImageRange   = null;

  var currentSearchState = null;

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

  // ── HTML HELPERS ──────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escAttr(str) {
    return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

  // ── KEYWORD EXTRACTION ────────────────────────────────────────────────────────
  function extractKeywords(thread) {
    var EMPTY = { keywords: [], queryString: '', isCanvas: false };
    if (!thread || thread.length === 0) return EMPTY;

    var mostRecent = thread[thread.length - 1];
    var bodyText   = mostRecent.body    || '';
    var subject    = mostRecent.subject || '';

    bodyText = bodyText.replace(/^>.*$/gm, '');
    bodyText = bodyText.replace(/^On .+wrote:.*$/gm, '');
    bodyText = bodyText.replace(/[-_]{2,}[\s\S]*$/, '');
    bodyText = bodyText.replace(/(Best regards|Best|Thanks|Thank you|Regards|Sincerely)[,\s][\s\S]*$/i, '');
    bodyText = bodyText.replace(/Sent from (my|an?)[\s\S]*$/i, '');
    bodyText = bodyText.replace(/[\w.-]+@[\w.-]+\.\w+/g, '');
    bodyText = bodyText.replace(/https?:\/\/[^\s]+/g, '');

    var combined = (subject + ' ' + subject + ' ' + bodyText).toLowerCase();
    combined = combined.replace(/[^\w\s]/g, ' ');

    var stopWords = {
      a:1,an:1,the:1,and:1,or:1,but:1,if:1,in:1,on:1,at:1,to:1,for:1,of:1,
      with:1,is:1,are:1,was:1,were:1,be:1,been:1,being:1,have:1,has:1,had:1,
      do:1,does:1,did:1,will:1,would:1,could:1,should:1,may:1,might:1,
      shall:1,can:1,need:1,i:1,me:1,my:1,we:1,our:1,you:1,your:1,he:1,
      she:1,it:1,they:1,their:1,this:1,that:1,these:1,those:1,what:1,
      which:1,who:1,how:1,when:1,where:1,why:1,hi:1,hello:1,dear:1,
      please:1,thank:1,thanks:1,regard:1,best:1,sincerely:1,get:1,got:1,
      getting:1,let:1,know:1,able:1,just:1,also:1,too:1,very:1,like:1,
      help:1,use:1,using:1,used:1,make:1,making:1,made:1,not:1,from:1,
      into:1,through:1,during:1,before:1,after:1,about:1,between:1,
      lane:1,uwm:1,cetl:1,casl:1,instructor:1,student:1,professor:1,email:1,
      message:1,issue:1,problem:1,question:1,there:1,more:1,some:1,
      any:1,all:1,each:1,sent:1,send:1,sending:1,receive:1,received:1,
      try:1,trying:1,tried:1,see:1,seeing:1,saw:1,look:1,looking:1,
      looked:1,find:1,finding:1,found:1,click:1,clicking:1,go:1,going:1,
      went:1,come:1,coming:1,came:1,am:1,pm:1,day:1,week:1,month:1
    };

    var canvasBoost = {
      canvas:1,assignment:1,module:1,gradebook:1,speedgrader:1,quiz:1,
      quizzes:1,discussion:1,announcement:1,submission:1,submissions:1,
      rubric:1,rubrics:1,page:1,pages:1,enrollment:1,enroll:1,
      kaltura:1,video:1,media:1,upload:1,file:1,files:1,lti:1,
      integration:1,tool:1,studio:1,arc:1,mediaspace:1,grade:1,grades:1,
      grading:1,course:1,section:1,modules:1,publish:1,published:1,
      unpublish:1,outcomes:1,mastery:1,blueprint:1,template:1,crosslist:1
    };

    var words = combined.split(/\s+/);
    var freq  = {};
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.length <= 2 || stopWords[w]) continue;
      freq[w] = (freq[w] || 0) + 1;
      if (canvasBoost[w]) freq[w] += 3;
    }

    var sorted      = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
    var keywords    = sorted.slice(0, 7);
    var isCanvas    = keywords.some(function (k) { return !!canvasBoost[k]; });
    var queryString = keywords.slice(0, 4).join(' ');

    console.log(LOG, 'Keywords:', keywords.join(', '), '| Canvas:', isCanvas, '| Query:', queryString);
    return { keywords: keywords, queryString: queryString, isCanvas: isCanvas };
  }

  // ── SEARCH: UWM KNOWLEDGE BASE — TIER 1 ──────────────────────────────────────
  function searchUWMKB(queryString, callback) {
    if (!queryString) { callback(null, []); return; }
    var url = 'https://kb.uwm.edu/search.php?q=' + encodeURIComponent(queryString);
    console.log(LOG, 'Tier 1 fetch:', url);
    GM_xmlhttpRequest({
      method: 'GET', url: url, timeout: 9000,
      onload: function (response) {
        console.log(LOG, 'Tier 1 response status:', response.status);
        try {
          var parser  = new DOMParser();
          var doc     = parser.parseFromString(response.responseText, 'text/html');
          var results = parseKBResults(doc);
          console.log(LOG, 'Tier 1 parsed results:', results.length);
          callback(null, results);
        } catch (e) { console.error(LOG, 'Tier 1 parse error:', e); callback(e, []); }
      },
      onerror:   function (e) { console.error(LOG, 'Tier 1 error:', e);   callback(new Error('KB fetch failed'), []); },
      ontimeout: function ()  { console.error(LOG, 'Tier 1 timeout');      callback(new Error('KB timeout'), []); }
    });
  }

  function parseKBResults(doc) {
    var allLinks = doc.querySelectorAll('a[href]');
    console.log(LOG, 'Tier 1: total <a> tags in fetched HTML:', allLinks.length);

    var results = [], seen = {};

    // Pass 1: exact UWM KB article URL patterns — handles both page.php?id= and bare numeric
    for (var i = 0; i < allLinks.length && results.length < 5; i++) {
      var link = allLinks[i];
      var raw  = link.getAttribute('href') || '';
      var title = (link.textContent || '').trim();
      if (!title || title.length < 5) continue;

      var href = null;

      // Pattern 1: page.php?id=NNN or document.php?id=NNN
      if (/page\.php\?id=/i.test(raw) || /document\.php\?id=/i.test(raw)) {
        href = /^https?:\/\//i.test(raw) ? raw : 'https://kb.uwm.edu' + (raw.charAt(0) === '/' ? '' : '/') + raw;
      }
      // Pattern 2: bare numeric string like "146742" (v1.29 addition)
      else if (/^\d+$/.test(raw)) {
        href = 'https://kb.uwm.edu/page.php?id=' + raw;
      }

      if (href && !seen[href]) {
        seen[href] = true;
        results.push({ title: title, url: href, excerpt: '' });
        console.log(LOG, 'Tier 1 Pass 1 result ' + results.length + ':', title, '->', href);
      }
    }

    // Pass 2: any link inside a <td> with meaningful text — catches alternate URL formats
    if (results.length === 0) {
      var tdLinks = doc.querySelectorAll('td a[href]');
      console.log(LOG, 'Tier 1 Pass 2: <td> links found:', tdLinks.length);
      for (var j = 0; j < tdLinks.length && results.length < 5; j++) {
        var tlink  = tdLinks[j];
        var traw   = tlink.getAttribute('href') || '';
        if (!traw || traw === '#' || traw.indexOf('mailto:') === 0) continue;
        var ttitle = (tlink.textContent || '').trim();
        if (!ttitle || ttitle.length < 5) continue;

        var thref = null;

        // Same two patterns as Pass 1
        if (/page\.php\?id=/i.test(traw) || /document\.php\?id=/i.test(traw)) {
          thref = /^https?:\/\//i.test(traw) ? traw : 'https://kb.uwm.edu' + (traw.charAt(0) === '/' ? '' : '/') + traw;
        }
        else if (/^\d+$/.test(traw)) {
          thref = 'https://kb.uwm.edu/page.php?id=' + traw;
        }

        if (thref && !seen[thref]) {
          seen[thref] = true;
          results.push({ title: ttitle, url: thref, excerpt: '' });
          console.log(LOG, 'Tier 1 Pass 2 result ' + results.length + ':', ttitle, '->', thref);
        }
      }
    }

    console.log(LOG, 'Tier 1 table parse: found', results.length, 'results');
    return results;
  }

  // ── SEARCH: CANVAS COMMUNITY — TIER 4 ────────────────────────────────────────
  function searchCanvasCommunity(queryString, callback) {
    if (!queryString) { callback(null, []); return; }
    var url = 'https://community.instructure.com/api/2.0/search/messages?q='
              + encodeURIComponent(queryString) + '&scope.type=community&page_size=5';
    console.log(LOG, 'Tier 4 fetch:', url);
    GM_xmlhttpRequest({
      method: 'GET', url: url, timeout: 9000,
      headers: { 'Accept': 'application/json' },
      onload: function (response) {
        console.log(LOG, 'Tier 4 response status:', response.status);
        try {
          var data    = JSON.parse(response.responseText);
          var results = parseCanvasCommunityJSON(data);
          console.log(LOG, 'Tier 4 parsed results:', results.length);
          callback(null, results);
        } catch (e) {
          console.log(LOG, 'Tier 4 JSON failed, trying HTML:', e.message);
          searchCanvasCommunityHTML(queryString, callback);
        }
      },
      onerror:   function (e) { callback(new Error('Canvas Community failed'), []); },
      ontimeout: function ()  { callback(new Error('Canvas Community timeout'), []); }
    });
  }

  function parseCanvasCommunityJSON(data) {
    var results = [], items;
    try { items = data.data.items; } catch (e) { return results; }
    if (!Array.isArray(items)) return results;
    var seen = {};
    for (var i = 0; i < items.length && results.length < 4; i++) {
      var item = items[i];
      var href = item.href || '';
      if (!href) continue;
      if (!/^https?:\/\//.test(href)) href = 'https://community.instructure.com' + href;
      if (seen[href]) continue;
      seen[href] = true;
      var title   = (item.subject || item.title || 'Canvas Community Result').trim();
      var rawBody = (item.body || item.teaser || '').replace(/<[^>]+>/g, ' ').trim();
      var excerpt = rawBody.slice(0, 130); if (excerpt.length === 130) excerpt += '\u2026';
      results.push({ title: title, url: href, excerpt: excerpt, isCommunity: !/solved/i.test(href) });
    }
    return results;
  }

  function searchCanvasCommunityHTML(queryString, callback) {
    var url = 'https://community.instructure.com/t5/forums/searchpage/tab/message?q='
              + encodeURIComponent(queryString) + '&filter=location&location=category:canvas';
    GM_xmlhttpRequest({
      method: 'GET', url: url, timeout: 9000,
      onload: function (response) {
        try {
          var doc     = new DOMParser().parseFromString(response.responseText, 'text/html');
          var linkEls = doc.querySelectorAll('.search-result-row a[href*="/t5/"],.lia-message-subject a,h3.message-subject a,a[href*="/t5/"]');
          var results = [], seen = {};
          for (var i = 0; i < linkEls.length && results.length < 4; i++) {
            var link  = linkEls[i];
            var title = (link.textContent || '').trim();
            var raw   = link.getAttribute('href') || '';
            if (!title || title.length < 5) continue;
            var href  = /^https?:\/\//.test(raw) ? raw : 'https://community.instructure.com' + raw;
            if (seen[href]) continue;
            seen[href] = true;
            results.push({ title: title, url: href, excerpt: '', isCommunity: !/solved/i.test(href) });
          }
          callback(null, results);
        } catch (e) { callback(e, []); }
      },
      onerror:   function () { callback(new Error('Canvas Community HTML failed'), []); },
      ontimeout: function () { callback(new Error('Canvas Community HTML timeout'), []); }
    });
  }

  // ── SEARCH ORCHESTRATION ──────────────────────────────────────────────────────
  function runSearch(keywordData, onComplete) {
    var state = {
      keywords: keywordData.keywords, queryString: keywordData.queryString, isCanvas: keywordData.isCanvas,
      tiers: {
        tier1: { status: 'searching', items: [] }, tier2: { status: 'skipped', items: [] },
        tier3: { status: 'skipped',   items: [] }, tier4: { status: keywordData.isCanvas ? 'searching' : 'skipped', items: [] }
      },
      confidence: 'yellow', complete: false
    };
    currentSearchState = state;
    var pending = keywordData.isCanvas ? 2 : 1;

    function checkDone() {
      pending--;
      if (pending <= 0 && !state.complete) {
        state.complete = true;
        var total = state.tiers.tier1.items.length + state.tiers.tier4.items.length;
        state.confidence = total >= 2 ? 'green' : total === 1 ? 'yellow' : 'red';
        console.log(LOG, 'All tiers done — total:', total, '| confidence:', state.confidence);
        onComplete(state);
      }
    }

    searchUWMKB(keywordData.queryString, function (err, results) {
      state.tiers.tier1.status = (err || !results.length) ? (err ? 'error' : 'no-results') : 'done';
      if (!err && results.length) state.tiers.tier1.items = results;
      updatePopupWithResults(state);
      checkDone();
    });

    if (keywordData.isCanvas) {
      searchCanvasCommunity(keywordData.queryString, function (err, results) {
        state.tiers.tier4.status = (err || !results.length) ? (err ? 'error' : 'no-results') : 'done';
        if (!err && results.length) state.tiers.tier4.items = results;
        updatePopupWithResults(state);
        checkDone();
      });
    }
  }

  // ── CITATIONS PANEL RENDERER ──────────────────────────────────────────────────
  function renderCitations(state) {
    var html = '';

    html += '<div class="ra-cit-tier"><div class="ra-cit-tier-label">Tier 1 \u2014 UWM Knowledge Base</div>';
    if (state.tiers.tier1.status === 'searching') {
      html += '<div class="ra-cit-none"><span class="ra-spinner ra-spinner-inline"></span>\u00a0Searching\u2026</div>';
    } else if (state.tiers.tier1.status === 'done') {
      state.tiers.tier1.items.forEach(function (item) {
        html += '<div class="ra-cit-item"><a href="' + escAttr(item.url) + '" target="_blank">' + escHtml(item.title) + '</a>';
        if (item.excerpt) html += '<div class="ra-cit-excerpt">' + escHtml(item.excerpt) + '</div>';
        html += '</div>';
      });
    } else {
      html += '<div class="ra-cit-none">' + (state.tiers.tier1.status === 'error' ? 'Search error \u2014 see console' : 'Searched \u2014 no results found') + '</div>';
    }
    html += '</div>';

    html += '<div class="ra-cit-tier"><div class="ra-cit-tier-label">Tier 2 \u2014 UWM Web</div><div class="ra-cit-none">Coming in Session 2</div></div>';
    html += '<div class="ra-cit-tier"><div class="ra-cit-tier-label">Tier 3 \u2014 UW System KB</div><div class="ra-cit-none">Coming in Session 2</div></div>';

    html += '<div class="ra-cit-tier"><div class="ra-cit-tier-label">Tier 4 \u2014 Canvas Community</div>';
    if (!state.isCanvas) {
      html += '<div class="ra-cit-none">Non-Canvas topic \u2014 skipped</div>';
    } else if (state.tiers.tier4.status === 'searching') {
      html += '<div class="ra-cit-none"><span class="ra-spinner ra-spinner-inline"></span>\u00a0Searching\u2026</div>';
    } else if (state.tiers.tier4.status === 'done') {
      state.tiers.tier4.items.forEach(function (item) {
        html += '<div class="ra-cit-item"><a href="' + escAttr(item.url) + '" target="_blank">' + escHtml(item.title) + '</a>';
        if (item.excerpt) html += '<div class="ra-cit-excerpt">' + escHtml(item.excerpt) + '</div>';
        if (item.isCommunity) html += '<div class="ra-cit-community-note">&#9873; Peer-generated thread</div>';
        html += '</div>';
      });
    } else {
      html += '<div class="ra-cit-none">' + (state.tiers.tier4.status === 'error' ? 'Search error \u2014 see console' : 'Searched \u2014 no results found') + '</div>';
    }
    html += '</div>';

    html += '<div class="ra-cit-tier" style="border-bottom:none;"><div class="ra-cit-tier-label">Memory Store</div><div class="ra-cit-none">Coming in Component 5</div></div>';
    return html;
  }

  // ── UPDATE POPUP WITH RESULTS ─────────────────────────────────────────────────
  function updatePopupWithResults(state) {
    if (!popupActive) return;
    var citEl = document.getElementById('uwm-ra-citations');
    if (citEl) citEl.innerHTML = '<div class="ra-cit-heading">Sources Consulted</div>' + renderCitations(state);

    if (state.complete) {
      var confEl = document.getElementById('uwm-ra-confidence');
      if (confEl) {
        var dotClass, label, detail;
        if (state.confidence === 'green') {
          dotClass = 'ra-dot-green'; label = '<strong style="font-size:12.5px;color:#166534;">High confidence</strong>';
          detail = '<span style="color:#78716c;font-size:12px;"> \u2014 found matching articles. Verify before sending.</span>';
        } else if (state.confidence === 'red') {
          dotClass = 'ra-dot-red'; label = '<strong style="font-size:12.5px;color:#991b1b;">No results found</strong>';
          detail = '<span style="color:#78716c;font-size:12px;"> \u2014 no matching articles found.</span>';
        } else {
          dotClass = 'ra-dot-yellow'; label = '<strong style="font-size:12.5px;color:#92400e;">Limited results</strong>';
          detail = '<span style="color:#78716c;font-size:12px;"> \u2014 partial match. Verify before sending.</span>';
        }
        confEl.innerHTML = '<span class="ra-dot ' + dotClass + '"></span>' + label + detail;
      }
      var searchingEl = document.getElementById('uwm-ra-searching');
      if (searchingEl) {
        var total = state.tiers.tier1.items.length + state.tiers.tier4.items.length;
        searchingEl.innerHTML = total > 0
          ? '<span style="color:#4ade80;font-size:12px;">&#10003; Found ' + total + ' result(s)</span>'
          : '<span style="color:#f59e0b;font-size:12px;">&#9888; No results found</span>';
      }
      updateEditorWithResults(state);
    }
  }

  // ── UPDATE EDITOR WITH SEARCH RESULTS ────────────────────────────────────────
  function updateEditorWithResults(state) {
    var editor = document.getElementById('uwm-ra-editor');
    if (!editor || editor.getAttribute('data-ra-placeholder') !== 'true') return;

    var allResults = [];
    state.tiers.tier1.items.forEach(function (i) { allResults.push({ item: i }); });
    state.tiers.tier4.items.forEach(function (i) { allResults.push({ item: i }); });

    if (allResults.length === 0) {
      editor.innerHTML =
        '<p>Hi [Instructor Name] ,</p>' +
        '<p>Thank you for reaching out to UWM CASL support.</p>' +
        '<p>I searched the UWM Knowledge Base and other resources but wasn\u2019t able to find a direct match. Could you share any additional details about what you\u2019re experiencing?</p>' +
        '<p>Best,</p>';
      editor.removeAttribute('data-ra-placeholder');
      return;
    }

    var topicPhrase = state.isCanvas ? 'Canvas' :
      state.keywords.slice(0, 2).join(' ').replace(/\w\S*/g, function (t) { return t.charAt(0).toUpperCase() + t.slice(1); });

    var html = '<p>Hi [Instructor Name],</p>';
    html += '<p>Thank you for reaching out to UWM CASL support.</p>';
    html += '<p>Based on your question about ' + escHtml(topicPhrase) + ', here are some resources that may help:</p>';
    html += '<ul>';
    allResults.slice(0, 5).forEach(function (r) {
      html += '<li><a href="' + escAttr(r.item.url) + '" target="_blank">' + escHtml(r.item.title) + '</a>';
      if (r.item.excerpt) html += ' \u2014 ' + escHtml(r.item.excerpt);
      html += '</li>';
    });
    html += '</ul>';
    html += '<p>Please let me know if these resources address your question, or if you need additional assistance.</p>';
    html += '<p>Best,</p>';

    editor.innerHTML = html;
    editor.removeAttribute('data-ra-placeholder');
    console.log(LOG, 'Editor updated with ' + allResults.length + ' result(s)');
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
  function execCmd(cmd, value) {
    var editor = document.getElementById('uwm-ra-editor');
    if (!editor) return;
    editor.focus();
    editor.ownerDocument.execCommand(cmd, false, value || null);
  }

  function fixLinksNewTab() {
    var editor = document.getElementById('uwm-ra-editor');
    if (!editor) return;
    var links = editor.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) { links[i].target = '_blank'; links[i].rel = 'noopener noreferrer'; }
  }

  // ── INJECT STYLES ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('uwm-ra-styles')) return;
    var css = '';

    css += '#uwm-ra-trigger-btn { display:inline-flex;align-items:center;gap:5px;padding:3px 10px;margin-left:8px;background:#1a2744;color:#7db3e8;border:1px solid #2d4a7a;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;font-family:"Segoe UI",system-ui,sans-serif;vertical-align:middle;white-space:nowrap;line-height:1.5;transition:background .15s,color .15s;pointer-events:all; }';
    css += '#uwm-ra-trigger-btn:hover { background:#243660;color:#a8d4f5; }';
    css += '#uwm-ra-badge { position:fixed;z-index:999990;background:#1a2744;color:#7db3e8;border:1px solid #2d4a7a;border-radius:20px;padding:5px 12px 5px 9px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:"Segoe UI",system-ui,sans-serif;display:flex;align-items:center;gap:5px;box-shadow:0 4px 16px rgba(0,0,0,.25);user-select:none;bottom:20px;right:20px;transition:background .15s,transform .15s;pointer-events:all; }';
    css += '#uwm-ra-badge:hover { background:#243660;transform:translateY(-1px); }';
    css += '#uwm-ra-badge .ra-badge-dot { width:7px;height:7px;border-radius:50%;background:#3b82f6;flex-shrink:0;animation:ra-pulse 2s ease-in-out infinite; }';
    css += '@keyframes ra-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.85)} }';
    css += '#uwm-ra-overlay { position:fixed;inset:0;z-index:999998;background:rgba(15,20,30,.55);display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,sans-serif; }';
    css += '#uwm-ra-overlay.ra-hidden { display:none; }';
    css += '#uwm-ra-panel { width:920px;max-width:96vw;height:640px;max-height:92vh;background:#f7f8fa;border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.15);display:flex;flex-direction:column;overflow:hidden;border:1px solid #d0d5dd;pointer-events:all; }';
    css += '#uwm-ra-header { background:#1a2744;color:#fff;padding:12px 18px;display:flex;align-items:center;gap:10px;flex-shrink:0; }';
    css += '#uwm-ra-header .ra-logo { font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.9; }';
    css += '#uwm-ra-header .ra-header-actions { display:flex;align-items:center;gap:6px;margin-left:auto; }';
    css += '#uwm-ra-header .ra-version { font-size:11px;opacity:.45; }';
    css += '#uwm-ra-minimize-btn { background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:5px;cursor:pointer;font-size:14px;padding:2px 9px;line-height:1.6;transition:background .15s;pointer-events:all; }';
    css += '#uwm-ra-minimize-btn:hover { background:rgba(255,255,255,.22); }';
    css += '#uwm-ra-confidence { display:flex;align-items:center;gap:8px;padding:8px 18px;font-size:12.5px;border-bottom:1px solid #e2e5ec;flex-shrink:0;background:#fffbf0; }';
    css += '#uwm-ra-confidence .ra-dot { width:11px;height:11px;border-radius:50%;flex-shrink:0; }';
    css += '.ra-dot-green { background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18); }';
    css += '.ra-dot-yellow { background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.18); }';
    css += '.ra-dot-red { background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.18); }';
    css += '#uwm-ra-body { display:flex;flex:1;overflow:hidden; }';
    css += '#uwm-ra-citations { width:265px;flex-shrink:0;background:#1e2b45;color:#c8d0e0;overflow-y:auto;padding:14px 0;display:flex;flex-direction:column; }';
    css += '#uwm-ra-citations .ra-cit-heading { font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6b7fa3;padding:0 14px 8px 14px; }';
    css += '.ra-cit-tier { padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.06); }';
    css += '.ra-cit-tier-label { font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5b7fa3;margin-bottom:5px; }';
    css += '.ra-cit-item { margin-bottom:8px; }';
    css += '.ra-cit-item a { font-size:12px;color:#7db3e8;text-decoration:none;display:block;line-height:1.35; }';
    css += '.ra-cit-item a:hover { text-decoration:underline; }';
    css += '.ra-cit-item .ra-cit-excerpt { font-size:11px;color:#8a97ae;margin-top:2px;line-height:1.4; }';
    css += '.ra-cit-none { font-size:11px;color:#4a5a72;font-style:italic; }';
    css += '.ra-cit-community-note { font-size:10px;color:#a08050;background:rgba(245,158,11,.12);border-radius:3px;padding:2px 5px;margin-top:3px;display:inline-block; }';
    css += '#uwm-ra-editor-area { flex:1;display:flex;flex-direction:column;overflow:hidden;background:#fff; }';
    css += '#uwm-ra-toolbar { display:flex;align-items:center;gap:2px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid #e2e5ec;background:#f7f8fa;flex-shrink:0; }';
    css += '.ra-tb-btn { background:none;border:1px solid transparent;border-radius:4px;cursor:pointer;font-size:13px;padding:3px 7px;color:#374151;transition:background .12s,border-color .12s;line-height:1.4;pointer-events:all; }';
    css += '.ra-tb-btn:hover { background:#e5e7eb;border-color:#d0d5dd; }';
    css += '.ra-tb-sep { width:1px;height:18px;background:#d0d5dd;margin:0 4px; }';
    css += '#uwm-ra-editor { flex:1;overflow-y:auto;padding:14px 18px;font-size:13.5px;font-family:"Segoe UI",system-ui,sans-serif;line-height:1.6;color:#1f2937;outline:none;min-height:0;cursor:text;pointer-events:all; }';
    css += '#uwm-ra-editor a { color:#1a5bb8; }';
    css += '#uwm-ra-editor img { max-width:100%;height:auto;display:block;margin:6px 0; }';
    css += '#uwm-ra-editor ul,#uwm-ra-editor ol { list-style:initial!important;padding-left:2em!important;margin:.5em 0!important; }';
    css += '#uwm-ra-editor ul { list-style-type:disc!important; }';
    css += '#uwm-ra-editor ol { list-style-type:decimal!important; }';
    css += '#uwm-ra-editor li { display:list-item!important;list-style-position:outside!important; }';
    css += '#uwm-ra-footer { padding:10px 16px;border-top:1px solid #e2e5ec;display:flex;align-items:center;gap:10px;background:#f7f8fa;flex-shrink:0; }';
    css += '.ra-btn { padding:7px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:background .15s;pointer-events:all; }';
    css += '#uwm-ra-insert { background:#1a5bb8;color:#fff; } #uwm-ra-insert:hover { background:#1549a0; }';
    css += '#uwm-ra-cancel { background:#e5e7eb;color:#374151; } #uwm-ra-cancel:hover { background:#d1d5db; }';
    css += '.ra-thumbs { display:flex;gap:6px;margin-left:auto; }';
    css += '.ra-thumb-btn { background:none;border:1px solid #d0d5dd;border-radius:6px;cursor:pointer;font-size:16px;padding:4px 10px;transition:background .15s,border-color .15s;pointer-events:all; }';
    css += '.ra-thumb-btn:hover { background:#e5e7eb; } .ra-thumb-btn.ra-thumb-selected { background:#dbeafe;border-color:#3b82f6; }';
    css += '#uwm-ra-searching { font-size:12px;color:#6b7fa3;margin-left:8px;display:flex;align-items:center;gap:6px; }';
    css += '.ra-spinner { width:13px;height:13px;border:2px solid #d0d5dd;border-top-color:#3b82f6;border-radius:50%;flex-shrink:0;animation:ra-spin .7s linear infinite; }';
    css += '.ra-spinner-inline { display:inline-block;vertical-align:middle; }';
    css += '@keyframes ra-spin { to{transform:rotate(360deg)} }';
    css += '#uwm-ra-minibar { position:fixed;bottom:0;left:0;right:0;z-index:999999;background:#1a2744;color:#fff;display:flex;align-items:center;gap:12px;padding:10px 20px;box-shadow:0 -4px 20px rgba(0,0,0,.3);font-family:"Segoe UI",system-ui,sans-serif; }';
    css += '#uwm-ra-minibar.ra-hidden { display:none; }';
    css += '#uwm-ra-minibar .ra-mini-icon { font-size:16px;opacity:.8; } #uwm-ra-minibar .ra-mini-label { font-size:13px;font-weight:600;letter-spacing:.02em; } #uwm-ra-minibar .ra-mini-sub { font-size:11px;opacity:.5;margin-left:2px; }';
    css += '.ra-mini-btn { padding:5px 16px;border-radius:5px;font-size:12.5px;font-weight:600;cursor:pointer;border:none;transition:background .15s;pointer-events:all; }';
    css += '#uwm-ra-mini-restore { background:#2563eb;color:#fff;margin-left:auto; } #uwm-ra-mini-restore:hover { background:#1d4ed8; }';
    css += '#uwm-ra-mini-discard { background:rgba(255,255,255,.1);color:#fca5a5;border:1px solid rgba(255,100,100,.3); } #uwm-ra-mini-discard:hover { background:rgba(255,80,80,.2); }';
    css += '#uwm-ra-warn-overlay { position:fixed;inset:0;z-index:1000000;background:rgba(15,20,30,.65);display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,sans-serif; }';
    css += '#uwm-ra-warn-box { background:#fff;border-radius:10px;padding:28px 32px;width:400px;max-width:92vw;box-shadow:0 16px 48px rgba(0,0,0,.3);border:1px solid #e2e5ec; }';
    css += '#uwm-ra-warn-box h3 { margin:0 0 10px;font-size:16px;color:#111827; } #uwm-ra-warn-box p { margin:0 0 22px;font-size:13.5px;color:#6b7280;line-height:1.5; }';
    css += '#uwm-ra-warn-box .ra-warn-actions { display:flex;gap:10px;justify-content:flex-end; }';
    css += '#uwm-ra-warn-keep { background:#e5e7eb;color:#374151; } #uwm-ra-warn-keep:hover { background:#d1d5db; }';
    css += '#uwm-ra-warn-confirm { background:#dc2626;color:#fff; } #uwm-ra-warn-confirm:hover { background:#b91c1c; }';
    css += '#uwm-ra-imgdrop-overlay { position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,sans-serif; }';
    css += '#uwm-ra-imgdrop-box { width:420px;height:280px;background:#fff;border-radius:12px;border:3px dashed #3a8fd8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.35);transition:background .15s,border-color .15s; }';
    css += '#uwm-ra-imgdrop-box.ra-drop-hover { background:#e8f4fd;border-color:#1a6fb5; }';
    css += '#uwm-ra-imgdrop-icon { font-size:52px;line-height:1;user-select:none; } #uwm-ra-imgdrop-label { font-size:20px;font-weight:700;color:#222;user-select:none; } #uwm-ra-imgdrop-sub { font-size:13px;color:#666;user-select:none; }';
    css += '#uwm-ra-imgdrop-cancel { margin-top:6px;font-size:12px;color:#999;cursor:pointer;text-decoration:underline;user-select:none; } #uwm-ra-imgdrop-cancel:hover { color:#555; }';
    css += '#uwm-ra-imgdrop-box.ra-drop-error { border-color:#c0392b;background:#fff0ee; }';

    var style = document.createElement('style');
    style.id = 'uwm-ra-styles'; style.textContent = css;
    document.head.appendChild(style);
  }

  // ── BADGE / TRIGGER HELPERS ───────────────────────────────────────────────────
  function hideBadge()    { var b = document.getElementById('uwm-ra-badge'); if (b) b.style.display = 'none'; }
  function restoreBadge() { var b = document.getElementById('uwm-ra-badge'); if (b) b.style.display = ''; }

  function removeTriggers() {
    var innerDoc = getInnerDoc();
    if (innerDoc) { var btn = innerDoc.getElementById('uwm-ra-trigger-btn'); if (btn) btn.remove(); }
    var badge = document.getElementById('uwm-ra-badge'); if (badge) badge.remove();
  }

  function injectToolbarButton(dialogEl, innerDoc, onClickFn) {
    if (innerDoc.getElementById('uwm-ra-trigger-btn')) return;
    var toolbar = dialogEl.querySelector('.x-html-editor-tb');
    if (!toolbar) {
      var allBtns = dialogEl.querySelectorAll('button, .x-btn-text, td.x-btn-mc');
      for (var i = 0; i < allBtns.length; i++) {
        var txt = (allBtns[i].textContent || '').trim().toLowerCase();
        var ttl = (allBtns[i].title || '').trim().toLowerCase();
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
    btn.id = 'uwm-ra-trigger-btn'; btn.innerHTML = '&#10022; AI Assistant'; btn.title = 'Open Reply Assistant';
    btn.addEventListener('click', function (e) { e.stopPropagation(); onClickFn(); });
    if (toolbar) { toolbar.appendChild(btn); console.log(LOG, 'Trigger button injected into compose RTF toolbar'); }
    else { dialogEl.appendChild(btn); console.log(LOG, 'Trigger button injected into dialog (toolbar fallback)'); }
  }

  function injectBadge(onClickFn) {
    if (document.getElementById('uwm-ra-badge')) return;
    var badge = document.createElement('div');
    badge.id = 'uwm-ra-badge';
    badge.innerHTML = '<span class="ra-badge-dot"></span>&#10022; Reply Assistant';
    badge.title = 'Open Reply Assistant';
    badge.addEventListener('click', function () { onClickFn(); });
    document.body.appendChild(badge);
    console.log(LOG, 'Floating badge injected');
  }

  // ── MINIMIZE / RESTORE / CLOSE ────────────────────────────────────────────────
  function minimizePopup() {
    var o = document.getElementById('uwm-ra-overlay'), m = document.getElementById('uwm-ra-minibar');
    if (o) o.classList.add('ra-hidden'); if (m) m.classList.remove('ra-hidden');
    hideBadge(); isMinimized = true; console.log(LOG, 'Pop-up minimized');
  }
  function restorePopup() {
    var o = document.getElementById('uwm-ra-overlay'), m = document.getElementById('uwm-ra-minibar');
    if (o) o.classList.remove('ra-hidden'); if (m) m.classList.add('ra-hidden');
    hideBadge(); isMinimized = false;
    var ed = document.getElementById('uwm-ra-editor'); if (ed) ed.focus();
    console.log(LOG, 'Pop-up restored');
  }
  function closePopup() {
    ['uwm-ra-overlay','uwm-ra-minibar','uwm-ra-warn-overlay','uwm-ra-imgdrop-overlay'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.remove();
    });
    popupActive = false; isMinimized = false; savedImageRange = null;
    if (escListener) { document.removeEventListener('keydown', escListener); escListener = null; }
    restoreBadge(); console.log(LOG, 'Pop-up closed');
  }

  // ── CANCEL WARNING ────────────────────────────────────────────────────────────
  function showCancelWarning() {
    if (isMinimized) restorePopup();
    var warn = document.createElement('div'); warn.id = 'uwm-ra-warn-overlay';
    warn.innerHTML = '<div id="uwm-ra-warn-box"><h3>Discard this draft?</h3><p>Your draft and edits will be permanently lost.</p>' +
      '<div class="ra-warn-actions"><button class="ra-btn" id="uwm-ra-warn-keep">Keep editing</button>' +
      '<button class="ra-btn" id="uwm-ra-warn-confirm">Yes, discard draft</button></div></div>';
    document.body.appendChild(warn);
    document.getElementById('uwm-ra-warn-keep').addEventListener('click', function () { warn.remove(); });
    document.getElementById('uwm-ra-warn-confirm').addEventListener('click', function () { closePopup(); });
    warn.addEventListener('click', function (e) { if (e.target === warn) warn.remove(); });
  }

  // ── IMAGE DROP ────────────────────────────────────────────────────────────────
  function showImageDropPopup() {
    if (document.getElementById('uwm-ra-imgdrop-overlay')) return;
    var editor = document.getElementById('uwm-ra-editor');
    if (editor) {
      var sel = editor.ownerDocument.getSelection();
      if (sel && sel.rangeCount > 0) { savedImageRange = sel.getRangeAt(0).cloneRange(); }
      else { savedImageRange = editor.ownerDocument.createRange(); savedImageRange.selectNodeContents(editor); savedImageRange.collapse(false); }
    }
    var overlay = document.createElement('div'); overlay.id = 'uwm-ra-imgdrop-overlay';
    var box = document.createElement('div'); box.id = 'uwm-ra-imgdrop-box';
    ['icon:\uD83D\uDDBC:uwm-ra-imgdrop-icon','label:Drop image here:uwm-ra-imgdrop-label','sub:PNG, JPG, GIF, WEBP:uwm-ra-imgdrop-sub'].forEach(function (s) {
      var parts = s.split(':'); var el = document.createElement('div'); el.id = parts[2]; el.textContent = parts[1]; box.appendChild(el);
    });
    var cancel = document.createElement('div'); cancel.id = 'uwm-ra-imgdrop-cancel'; cancel.textContent = 'Cancel (Esc)';
    cancel.addEventListener('click', closeImageDropPopup); box.appendChild(cancel);
    overlay.appendChild(box); document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeImageDropPopup(); });
    box.addEventListener('dragenter', function (e) { e.preventDefault(); box.classList.add('ra-drop-hover'); });
    box.addEventListener('dragover',  function (e) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; });
    box.addEventListener('dragleave', function (e) { if (!box.contains(e.relatedTarget)) box.classList.remove('ra-drop-hover'); });
    box.addEventListener('drop', handleImageDrop);
    document.addEventListener('keydown', imgDropEscHandler, true);
  }
  function closeImageDropPopup() {
    var o = document.getElementById('uwm-ra-imgdrop-overlay'); if (o) o.remove();
    document.removeEventListener('keydown', imgDropEscHandler, true);
    var ed = document.getElementById('uwm-ra-editor'); if (ed) ed.focus();
  }
  function imgDropEscHandler(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImageDropPopup(); } }
  function handleImageDrop(e) {
    e.preventDefault(); e.stopPropagation();
    var files = [];
    for (var i = 0; i < e.dataTransfer.files.length; i++) { if (e.dataTransfer.files[i].type.indexOf('image/') === 0) files.push(e.dataTransfer.files[i]); }
    if (!files.length) { var b = document.getElementById('uwm-ra-imgdrop-box'); if (b) b.classList.add('ra-drop-error'); return; }
    var reader = new FileReader();
    reader.onload  = function (ev) { closeImageDropPopup(); insertImageInEditor(ev.target.result, files[0].name); };
    reader.onerror = function () { var b = document.getElementById('uwm-ra-imgdrop-box'); if (b) b.classList.add('ra-drop-error'); };
    reader.readAsDataURL(files[0]);
  }
  function insertImageInEditor(dataUrl, filename) {
    var editor = document.getElementById('uwm-ra-editor'); if (!editor) return;
    var editorDoc = editor.ownerDocument; editor.focus();
    if (savedImageRange) { var sel = editorDoc.getSelection(); sel.removeAllRanges(); sel.addRange(savedImageRange); savedImageRange = null; }
    try {
      var marker = 'ra-img-' + Date.now();
      var ok = editorDoc.execCommand('insertHTML', false, '<img src="' + dataUrl + '" alt="' + marker + '" style="width:' + IMG_DEFAULT_WIDTH + 'px;height:auto;max-width:100%;display:block;margin:6px 0;">');
      if (!ok) { var img = editorDoc.createElement('img'); img.src = dataUrl; img.style.cssText = 'width:' + IMG_DEFAULT_WIDTH + 'px;height:auto;max-width:100%;display:block;margin:6px 0;'; editor.appendChild(img); }
      setTimeout(function () { var ins = editor.querySelector('img[alt="' + marker + '"]'); if (ins) ins.alt = filename || 'image'; }, 50);
      editor.removeAttribute('data-ra-placeholder');
    } catch (err) { console.error(LOG, 'Image insert failed:', err); }
  }

  // ── INSERT DRAFT INTO NEURONS COMPOSE ────────────────────────────────────────
  // REWRITTEN in v1.32 to use window.Ext (diagnostic confirmed this works).
  // Ensures content persists when Neurons Save button is clicked.
  function insertDraftAtTop(dialogEl, draftHtml) {
    // Access ExtJS via window.Ext (confirmed available via diagnostics)
    var Ext = window.Ext;
    
    if (!Ext || !Ext.ComponentMgr) {
      console.error(LOG, 'Insert failed: ExtJS not accessible via window.Ext');
      alert('[UWM Reply Assistant] ExtJS not found. Cannot insert content.');
      return;
    }

    var emailBodyComp = null;

    // Find EmailBody component by Name property
    var allComps = Ext.ComponentMgr.all.map;
    for (var id in allComps) {
      if (allComps[id].Name === 'EmailBody') {
        emailBodyComp = allComps[id];
        console.log(LOG, 'Found EmailBody component, id:', emailBodyComp.id);
        break;
      }
    }

    if (!emailBodyComp) {
      console.error(LOG, 'Insert failed: could not find EmailBody component');
      alert('[UWM Reply Assistant] Could not find Neurons email body field.');
      return;
    }

    if (typeof emailBodyComp.setValue !== 'function' || typeof emailBodyComp.getValue !== 'function') {
      console.error(LOG, 'Insert failed: EmailBody component missing setValue/getValue methods');
      alert('[UWM Reply Assistant] EmailBody component API unavailable.');
      return;
    }

    // Wrap inserted content in Neurons' standard elementToProof div with explicit 12pt font
    var wrappedHtml = '<div class="elementToProof" style="font-family: Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif; font-size: 12pt;">'
      + draftHtml
      + '</div>';

    // Prepend to existing content
    var currentValue = emailBodyComp.getValue() || '';
    var newValue = wrappedHtml + currentValue;

    try {
      emailBodyComp.setValue(newValue);
      console.log(LOG, 'Draft prepended via setValue() with elementToProof wrapper — ' + draftHtml.length + ' chars inserted');
    } catch (e) {
      console.error(LOG, 'Insert failed during setValue():', e);
      alert('[UWM Reply Assistant] Insert failed: ' + e.message);
    }
  }

  // ── POP-UP UI ─────────────────────────────────────────────────────────────────
  function showPopup(dialogEl, thread) {
    if (popupActive) { if (isMinimized) restorePopup(); return; }
    popupActive = true; injectStyles(); hideBadge();

    var overlay = document.createElement('div'); overlay.id = 'uwm-ra-overlay';
    overlay.innerHTML =
      '<div id="uwm-ra-panel">' +
        '<div id="uwm-ra-header">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7db3e8" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
          '<span class="ra-logo">Reply Assistant</span>' +
          '<span id="uwm-ra-searching"><span class="ra-spinner"></span>Searching\u2026</span>' +
          '<div class="ra-header-actions"><button id="uwm-ra-minimize-btn">\u2013</button><span class="ra-version">v1.32</span></div>' +
        '</div>' +
        '<div id="uwm-ra-confidence"><span class="ra-dot ra-dot-yellow"></span>' +
          '<strong style="font-size:12.5px;color:#92400e;">Searching\u2026</strong>' +
          '<span style="color:#78716c;font-size:12px;margin-left:4px;">\u2014 results loading.</span></div>' +
        '<div id="uwm-ra-body">' +
          '<div id="uwm-ra-citations"><div class="ra-cit-heading">Sources Consulted</div></div>' +
          '<div id="uwm-ra-editor-area">' +
            '<div id="uwm-ra-toolbar">' +
              '<button class="ra-tb-btn" data-cmd="bold"><b>B</b></button>' +
              '<button class="ra-tb-btn" data-cmd="italic"><i>I</i></button>' +
              '<button class="ra-tb-btn" data-cmd="underline"><u>U</u></button>' +
              '<div class="ra-tb-sep"></div>' +
              '<button class="ra-tb-btn" data-cmd="insertUnorderedList">\u2022 List</button>' +
              '<button class="ra-tb-btn" data-cmd="insertOrderedList">1. List</button>' +
              '<div class="ra-tb-sep"></div>' +
              '<button class="ra-tb-btn" id="uwm-ra-link-btn">\uD83D\uDD17 Link</button>' +
              '<button class="ra-tb-btn" id="uwm-ra-image-btn">\uD83D\uDDBC\uFE0F Image</button>' +
              '<div class="ra-tb-sep"></div>' +
              '<button class="ra-tb-btn" data-cmd="removeFormat">\u2715 Clear formatting</button>' +
            '</div>' +
            '<div id="uwm-ra-editor" contenteditable="true" spellcheck="true" data-ra-placeholder="true"></div>' +
          '</div>' +
        '</div>' +
        '<div id="uwm-ra-footer">' +
          '<button class="ra-btn" id="uwm-ra-insert">\u21b5 Insert into Email</button>' +
          '<button class="ra-btn" id="uwm-ra-cancel">Cancel</button>' +
          '<div class="ra-thumbs"><button class="ra-thumb-btn" id="uwm-ra-thumb-up">&#128077;</button><button class="ra-thumb-btn" id="uwm-ra-thumb-down">&#128078;</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var minibar = document.createElement('div'); minibar.id = 'uwm-ra-minibar'; minibar.classList.add('ra-hidden');
    minibar.innerHTML = '<span class="ra-mini-icon">&#128172;</span><span class="ra-mini-label">Reply Assistant</span>' +
      '<span class="ra-mini-sub">\u2014 draft ready</span>' +
      '<button class="ra-mini-btn" id="uwm-ra-mini-restore">&#9650; Restore</button>' +
      '<button class="ra-mini-btn" id="uwm-ra-mini-discard">&#10005; Discard</button>';
    document.body.appendChild(minibar);

    var editor = document.getElementById('uwm-ra-editor');
    editor.innerHTML =
      '<p>Hi [Instructor Name],</p><p>Thank you for reaching out to UWM CASL support.</p>' +
      '<p><em>Searching knowledge base \u2014 draft will update momentarily\u2026</em></p>' +
      '<p>Best,</p>';
    editor.focus();
    editor.addEventListener('input', function () { this.removeAttribute('data-ra-placeholder'); });

    if (currentSearchState) {
      updatePopupWithResults(currentSearchState);
    } else {
      var citEl = document.getElementById('uwm-ra-citations');
      if (citEl) citEl.innerHTML = '<div class="ra-cit-heading">Sources Consulted</div>' +
        '<div class="ra-cit-tier"><div class="ra-cit-tier-label">UWM Knowledge Base</div>' +
        '<div class="ra-cit-none"><span class="ra-spinner ra-spinner-inline"></span>\u00a0Searching\u2026</div></div>';
    }

    var tbBtns = document.querySelectorAll('#uwm-ra-toolbar .ra-tb-btn[data-cmd]');
    for (var t = 0; t < tbBtns.length; t++) {
      (function (btn) {
        btn.addEventListener('mousedown', function (e) {
          e.preventDefault(); execCmd(btn.getAttribute('data-cmd'));
          var ed = document.getElementById('uwm-ra-editor'); if (ed) ed.removeAttribute('data-ra-placeholder');
        });
      }(tbBtns[t]));
    }

    document.getElementById('uwm-ra-link-btn').addEventListener('mousedown', function (e) {
      e.preventDefault();
      var url = prompt('Enter URL:', 'https://');
      if (url && url !== 'https://') { execCmd('createLink', url); fixLinksNewTab(); var ed = document.getElementById('uwm-ra-editor'); if (ed) ed.removeAttribute('data-ra-placeholder'); }
    });
    document.getElementById('uwm-ra-image-btn').addEventListener('mousedown', function (e) { e.preventDefault(); showImageDropPopup(); });
    document.getElementById('uwm-ra-minimize-btn').addEventListener('click', function (e) { e.stopPropagation(); minimizePopup(); });

    // Insert button handler
    document.getElementById('uwm-ra-insert').addEventListener('click', function (e) {
      e.stopPropagation();
      var html = document.getElementById('uwm-ra-editor').innerHTML;
      if (!html || !html.trim()) { alert('[UWM Reply Assistant] Nothing to insert.'); return; }
      try {
        insertDraftAtTop(dialogEl, html);
        closePopup();
      } catch (e2) {
        console.error(LOG, 'Insert failed:', e2);
        alert('[UWM Reply Assistant] Insert failed: ' + e2.message);
      }
    });

    document.getElementById('uwm-ra-cancel').addEventListener('click', function (e) { e.stopPropagation(); showCancelWarning(); });
    document.getElementById('uwm-ra-thumb-up').addEventListener('click', function (e) {
      e.stopPropagation(); this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-down').classList.remove('ra-thumb-selected');
    });
    document.getElementById('uwm-ra-thumb-down').addEventListener('click', function (e) {
      e.stopPropagation(); this.classList.toggle('ra-thumb-selected');
      document.getElementById('uwm-ra-thumb-up').classList.remove('ra-thumb-selected');
    });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) minimizePopup(); });

    escListener = function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        if (document.getElementById('uwm-ra-imgdrop-overlay')) return;
        if (!popupActive) return;
        if (isMinimized) restorePopup(); else minimizePopup();
      }
    };
    document.addEventListener('keydown', escListener);

    document.getElementById('uwm-ra-mini-restore').addEventListener('click', restorePopup);
    document.getElementById('uwm-ra-mini-discard').addEventListener('click', function () { closePopup(); delete seenDialogs[dialogEl.id]; });

    console.log(LOG, 'Pop-up displayed');
  }

  // ── HANDLE COMPOSE DIALOG ─────────────────────────────────────────────────────
  function handleDialog(dialogEl, innerDoc) {
    if (seenDialogs[dialogEl.id] || knownDialogIds[dialogEl.id]) return;
    if (!isComposeDialog(dialogEl)) {
      knownDialogIds[dialogEl.id] = true;
      console.log(LOG, 'Dialog ' + dialogEl.id + ' is not compose — filed, will not re-check');
      return;
    }
    seenDialogs[dialogEl.id] = true;
    console.log(LOG, 'NEW compose dialog (id=' + dialogEl.id + ') — starting search + injecting triggers');

    var thread      = readEmailThread(innerDoc);
    var keywordData = extractKeywords(thread);

    if (keywordData.keywords.length > 0) {
      runSearch(keywordData, function (state) { console.log(LOG, 'Search complete — confidence:', state.confidence); });
    } else {
      currentSearchState = {
        keywords: [], queryString: '', isCanvas: false,
        tiers: { tier1:{status:'no-results',items:[]}, tier2:{status:'skipped',items:[]}, tier3:{status:'skipped',items:[]}, tier4:{status:'skipped',items:[]} },
        confidence: 'red', complete: true
      };
    }

    function openAssistant() { showPopup(dialogEl, thread); }
    injectToolbarButton(dialogEl, innerDoc, openAssistant);
    injectBadge(openAssistant);

    if (cleanPoller) clearInterval(cleanPoller);
    cleanPoller = setInterval(function () {
      var currentDoc = getInnerDoc(); if (!currentDoc) return;
      if (!currentDoc.body.contains(dialogEl)) {
        clearInterval(cleanPoller); cleanPoller = null;
        delete seenDialogs[dialogEl.id]; currentSearchState = null;
        removeTriggers(); if (popupActive) closePopup();
        console.log(LOG, 'Compose dialog closed — triggers removed');
      }
    }, 800);
  }

  // ── POLL FOR NEW DIALOGS ──────────────────────────────────────────────────────
  function startPoller() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(function () {
      var innerDoc = getInnerDoc(); if (!innerDoc) return;
      pollTickCount++;
      var dialogs = innerDoc.querySelectorAll('.x-frs-modal-form');
      if (pollTickCount <= SNAPSHOT_TICKS) {
        for (var s = 0; s < dialogs.length; s++) { if (!knownDialogIds[dialogs[s].id]) knownDialogIds[dialogs[s].id] = true; }
        return;
      }
      for (var i = 0; i < dialogs.length; i++) { handleDialog(dialogs[i], innerDoc); }
    }, 500);
  }

  // ── INIT ─────────────────────────────────────────────────────────────────────
  function startObserver() { console.log(LOG, 'Observer disabled — poller-only mode'); }

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
    startObserver(); startPoller();
    console.log(LOG, 'v1.32 initialized — 5-second grace period active');
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); }); }
  else { setTimeout(init, 1000); }

})();
