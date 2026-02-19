// ==UserScript==
// @name         Neurons - Image Drop Insert
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.6
// @description  Ctrl+Shift+I to drop image at cursor. Click image to resize with corner handles. Enter to confirm.
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  // ── CONFIG ──────────────────────────────────────────────────────────────────
  var SHORTCUT_KEY   = 'i';
  var SHORTCUT_CTRL  = true;
  var SHORTCUT_SHIFT = true;
  var SHORTCUT_ALT   = false;
  var SHORTCUT_META  = false;
  // Default width for newly inserted images (px). Height is set proportionally.
  var DEFAULT_INSERT_WIDTH = 300;
  // Size of the corner drag handles (px)
  var HANDLE_SIZE = 10;
  // ────────────────────────────────────────────────────────────────────────────
  var activeEditorCtx  = null;
  var attachedEditors  = new WeakSet();
  var observerRef      = null;
  var retryInterval    = null;
  // Resize state (one active at a time, shared across all editors)
  var resizeState = {
    active:       false,
    img:          null,
    editorDoc:    null,
    editorBody:   null,
    wrap:         null,
    corner:       null,
    startX:       0,
    startY:       0,
    startW:       0,
    startH:       0,
    aspectRatio:  1
  };
  // ── FIND APP FRAME ──────────────────────────────────────────────────────────
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
  // ── FIND EDITOR IFRAMES ─────────────────────────────────────────────────────
  function findEditorIframes() {
    var innerDoc = getInnerDoc();
    if (!innerDoc) return [];
    var results = [];
    var wraps = innerDoc.querySelectorAll('.x-html-editor-wrap');
    for (var i = 0; i < wraps.length; i++) {
      var iframe = wraps[i].querySelector('iframe');
      if (!iframe) continue;
      try {
        var doc = iframe.contentDocument;
        if (doc && doc.designMode === 'on' && iframe.offsetWidth > 0) results.push(iframe);
      } catch (e) {}
    }
    return results;
  }
  // ── RESIZE HANDLE SYSTEM ────────────────────────────────────────────────────
  var CURSORS = { nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize' };
  function createResizeWrap(editorDoc) {
    var wrap = editorDoc.createElement('div');
    wrap.id = 'imgdrop-resizer-wrap';
    wrap.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'z-index:9999',
      'box-sizing:border-box',
      'border:2px solid #3a8fd8',
      'outline:1px solid rgba(255,255,255,0.6)'
    ].join(';');
    var hs   = HANDLE_SIZE;
    var half = Math.floor(hs / 2);
    ['nw', 'ne', 'sw', 'se'].forEach(function (corner) {
      var h = editorDoc.createElement('div');
      h.className = 'imgdrop-handle';
      h.setAttribute('data-corner', corner);
      h.style.cssText = [
        'position:absolute',
        'width:'  + hs + 'px',
        'height:' + hs + 'px',
        'background:#3a8fd8',
        'border:1.5px solid #fff',
        'border-radius:2px',
        'pointer-events:all',
        'box-sizing:border-box',
        'cursor:' + CURSORS[corner],
        corner.indexOf('n') !== -1 ? 'top:-'    + half + 'px' : 'bottom:-' + half + 'px',
        corner.indexOf('w') !== -1 ? 'left:-'   + half + 'px' : 'right:-'  + half + 'px'
      ].join(';');
      wrap.appendChild(h);
    });
    return wrap;
  }
  function positionWrap(wrap, img) {
    wrap.style.top    = img.offsetTop    + 'px';
    wrap.style.left   = img.offsetLeft   + 'px';
    wrap.style.width  = img.offsetWidth  + 'px';
    wrap.style.height = img.offsetHeight + 'px';
  }
  function showResizeHandles(img, editorDoc) {
    removeResizeHandles(editorDoc);
    var editorBody = editorDoc.body;
    editorBody.style.position = 'relative';
    var wrap = createResizeWrap(editorDoc);
    positionWrap(wrap, img);
    editorBody.appendChild(wrap);
    resizeState.img        = img;
    resizeState.editorDoc  = editorDoc;
    resizeState.editorBody = editorBody;
    resizeState.wrap       = wrap;
    var handles = wrap.querySelectorAll('.imgdrop-handle');
    for (var i = 0; i < handles.length; i++) {
      handles[i].addEventListener('mousedown', onHandleMouseDown, true);
    }
    img.style.outline = '2px solid #3a8fd8';
  }
  function removeResizeHandles(editorDoc) {
    var existing = editorDoc.getElementById('imgdrop-resizer-wrap');
    if (existing) existing.remove();
    editorDoc.body.style.position = '';
    if (resizeState.img && resizeState.img.ownerDocument === editorDoc) {
      resizeState.img.style.outline = '';
    }
    resizeState.active    = false;
    resizeState.img       = null;
    resizeState.wrap      = null;
    resizeState.editorDoc = null;
  }
  // ── DRAG-TO-RESIZE ──────────────────────────────────────────────────────────
  function onHandleMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();
    var corner = e.currentTarget.getAttribute('data-corner');
    var img    = resizeState.img;
    resizeState.active      = true;
    resizeState.corner      = corner;
    resizeState.startX      = e.clientX;
    resizeState.startY      = e.clientY;
    resizeState.startW      = img.offsetWidth;
    resizeState.startH      = img.offsetHeight;
    resizeState.aspectRatio = img.offsetHeight / img.offsetWidth;
    var editorDoc = resizeState.editorDoc;
    editorDoc.addEventListener('mousemove', onResizeMouseMove, true);
    editorDoc.addEventListener('mouseup',   onResizeMouseUp,   true);
  }
  function onResizeMouseMove(e) {
    if (!resizeState.active) return;
    e.preventDefault();
    var dx     = e.clientX - resizeState.startX;
    var dy     = e.clientY - resizeState.startY;
    var corner = resizeState.corner;
    var effectiveDx = (corner === 'nw' || corner === 'sw') ? -dx : dx;
    var effectiveDy = (corner === 'nw' || corner === 'ne') ? -dy : dy;
    var delta  = (Math.abs(effectiveDx) > Math.abs(effectiveDy)) ? effectiveDx : effectiveDy;
    var newW   = Math.max(20, resizeState.startW + delta);
    var newH   = Math.round(newW * resizeState.aspectRatio);
    var img  = resizeState.img;
    var wrap = resizeState.wrap;
    img.style.width    = newW + 'px';
    img.style.height   = newH + 'px';
    img.style.maxWidth = 'none';
    positionWrap(wrap, img);
  }
  function onResizeMouseUp(e) {
    if (!resizeState.active) return;
    e.preventDefault();
    resizeState.active = false;
    var editorDoc = resizeState.editorDoc;
    editorDoc.removeEventListener('mousemove', onResizeMouseMove, true);
    editorDoc.removeEventListener('mouseup',   onResizeMouseUp,   true);
    setTimeout(function () {
      if (resizeState.wrap && resizeState.img) {
        positionWrap(resizeState.wrap, resizeState.img);
      }
    }, 0);
  }
  // ── IMAGE CLICK DETECTION IN EDITOR ─────────────────────────────────────────
  function onEditorClick(e) {
    var editorDoc = this;
    var target    = e.target;
    if (target.className && target.className.indexOf('imgdrop-handle') !== -1) return;
    if (target.tagName === 'IMG') {
      e.preventDefault();
      showResizeHandles(target, editorDoc);
    } else {
      removeResizeHandles(editorDoc);
    }
  }
  // ── BUG 1 FIX: Esc handling moved into onEditorKeyDown ──────────────────────
  // The popup overlay lives in the outer document but focus stays in the editor
  // iframe. Key events never bubble across iframe boundaries, so the escHandler
  // registered on the outer document never fires. By handling Escape here (inside
  // the editor's own keydown listener) we catch it wherever it originates.
  function onEditorKeyDown(e) {
    var editorDoc = this;
    // FIX: Close the drop popup on Escape, regardless of where the escHandler is
    if (e.key === 'Escape') {
      if (document.getElementById('imgdrop-overlay')) {
        e.preventDefault();
        e.stopPropagation();
        closePopup();
        return;
      }
    }
    // Enter key: dismiss resize handles
    if (e.key === 'Enter' && resizeState.img && resizeState.editorDoc === editorDoc) {
      removeResizeHandles(editorDoc);
      return;
    }
    // Keyboard shortcut: Ctrl+Shift+I
    if (
      e.key.toLowerCase() === SHORTCUT_KEY &&
      e.ctrlKey  === SHORTCUT_CTRL  &&
      e.shiftKey === SHORTCUT_SHIFT &&
      e.altKey   === SHORTCUT_ALT   &&
      e.metaKey  === SHORTCUT_META
    ) {
      e.preventDefault();
      e.stopPropagation();
      var iframeEl   = editorDoc.defaultView.frameElement;
      var editorBody = editorDoc.body;
      var sel        = editorDoc.getSelection();
      var savedRange;
      if (sel && sel.rangeCount > 0) {
        savedRange = sel.getRangeAt(0).cloneRange();
      } else {
        savedRange = editorDoc.createRange();
        savedRange.selectNodeContents(editorBody);
        savedRange.collapse(false);
      }
      activeEditorCtx = {
        iframeEl:   iframeEl,
        editorDoc:  editorDoc,
        editorBody: editorBody,
        savedRange: savedRange
      };
      showDropPopup();
    }
  }
  // ── POPUP ───────────────────────────────────────────────────────────────────
  function showDropPopup() {
    if (document.getElementById('imgdrop-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'imgdrop-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'top:0', 'left:0', 'right:0', 'bottom:0',
      'background:rgba(0,0,0,0.55)',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font-family:Arial,sans-serif'
    ].join(';');
    var box = document.createElement('div');
    box.id = 'imgdrop-box';
    box.style.cssText = [
      'width:420px',
      'height:260px',
      'background:#fff',
      'border-radius:10px',
      'border:3px dashed #3a8fd8',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'gap:12px',
      'cursor:default',
      'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
      'transition:background 0.15s,border-color 0.15s'
    ].join(';');
    var icon = document.createElement('div');
    icon.style.cssText = 'font-size:52px;line-height:1;user-select:none;';
    icon.textContent = '[IMG]';
    var label = document.createElement('div');
    label.style.cssText = 'font-size:20px;font-weight:700;color:#222;user-select:none;';
    label.textContent = 'Drop image here';
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:13px;color:#666;user-select:none;';
    sub.textContent = 'PNG, JPG, GIF, WEBP - releases instantly on drop';
    var cancel = document.createElement('div');
    cancel.style.cssText = 'margin-top:6px;font-size:12px;color:#999;cursor:pointer;text-decoration:underline;user-select:none;';
    cancel.textContent = 'Cancel (Esc)';
    cancel.onclick = closePopup;
    box.appendChild(icon);
    box.appendChild(label);
    box.appendChild(sub);
    box.appendChild(cancel);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closePopup();
    });
    // Keep the outer escHandler as a fallback for when focus happens to be
    // outside all editor iframes (e.g. user tabbed to a form field).
    document.addEventListener('keydown', escHandler, true);
    box.addEventListener('dragenter', function (e) {
      e.preventDefault();
      box.style.background   = '#e8f4fd';
      box.style.borderColor  = '#1a6fb5';
    });
    box.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    box.addEventListener('dragleave', function (e) {
      if (!box.contains(e.relatedTarget)) {
        box.style.background  = '#fff';
        box.style.borderColor = '#3a8fd8';
      }
    });
    box.addEventListener('drop', handleDrop);
  }
  function closePopup() {
    var overlay = document.getElementById('imgdrop-overlay');
    if (overlay) overlay.remove();
    document.removeEventListener('keydown', escHandler, true);
  }
  function escHandler(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopup();
    }
  }
  // ── DROP HANDLER ────────────────────────────────────────────────────────────
  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    var files = [];
    for (var i = 0; i < e.dataTransfer.files.length; i++) {
      if (e.dataTransfer.files[i].type.indexOf('image/') === 0) files.push(e.dataTransfer.files[i]);
    }
    if (files.length === 0) {
      showDropError('No image found. Please drop a PNG, JPG, GIF, or WEBP file.');
      return;
    }
    var file   = files[0];
    var reader = new FileReader();
    reader.onload = function (ev) {
      closePopup();
      insertImageAtSavedCursor(ev.target.result, file.name);
    };
    reader.onerror = function () { showDropError('Could not read the file. Please try again.'); };
    reader.readAsDataURL(file);
  }
  function showDropError(msg) {
    var box = document.getElementById('imgdrop-box');
    if (!box) return;
    box.style.borderColor = '#c0392b';
    box.style.background  = '#fff0ee';
    var label = box.querySelector('div:nth-child(2)');
    var sub   = box.querySelector('div:nth-child(3)');
    if (label) { label.textContent = 'Error'; label.style.color = '#c0392b'; }
    if (sub)   { sub.textContent   = msg; }
  }
  // ── IMAGE INSERTION ─────────────────────────────────────────────────────────
  function insertImageAtSavedCursor(dataUrl, filename) {
    if (!activeEditorCtx) {
      console.warn('[ImageDrop] No editor context saved.');
      return;
    }
    var editorDoc  = activeEditorCtx.editorDoc;
    var editorBody = activeEditorCtx.editorBody;
    var savedRange = activeEditorCtx.savedRange;
    activeEditorCtx = null;
    try {
      editorBody.focus();
      var sel = editorDoc.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
      var safeName = (filename || 'image').replace(/"/g, '&quot;');
      // BUG 2 FIX: stamp a unique marker on the alt attribute so we can find
      // exactly this image in the setTimeout below. execCommand strips id/class/
      // data-* but always preserves alt. We replace it with the real filename
      // after locating the image.
      var uniqueMarker = 'imgdrop-new-' + Date.now();
      var imgHTML = '<img src="' + dataUrl + '"'
        + ' alt="' + uniqueMarker + '"'
        + ' style="width:' + DEFAULT_INSERT_WIDTH + 'px;height:auto;max-width:none;vertical-align:middle;">';
      var ok = editorDoc.execCommand('insertHTML', false, imgHTML);
      if (!ok) {
        // Fallback: manual DOM insertion
        var img = editorDoc.createElement('img');
        img.src           = dataUrl;
        img.alt           = uniqueMarker;
        img.style.cssText = 'width:' + DEFAULT_INSERT_WIDTH + 'px;height:auto;max-width:none;vertical-align:middle;';
        savedRange.deleteContents();
        savedRange.insertNode(img);
        var after = editorDoc.createRange();
        after.setStartAfter(img);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
      }
      // Wait for the browser to render the image at its natural dimensions,
      // then lock in the height and show resize handles.
      setTimeout(function () {
        // Find this specific image by its unique marker alt value
        var insertedImg = editorDoc.querySelector('img[alt="' + uniqueMarker + '"]');
        if (insertedImg) {
          // Replace the temporary marker alt with the real filename
          insertedImg.alt = safeName;
          // Lock in the rendered height as an explicit px value so the
          // resize drag math works correctly from the start
          var renderedH = insertedImg.offsetHeight;
          if (renderedH > 0) insertedImg.style.height = renderedH + 'px';
          showResizeHandles(insertedImg, editorDoc);
        }
      }, 50);
    } catch (err) {
      console.error('[ImageDrop] Insert failed:', err);
    }
  }
  // ── ATTACH TO EDITORS ───────────────────────────────────────────────────────
  function attachToEditors() {
    var editors  = findEditorIframes();
    var attached = 0;
    for (var i = 0; i < editors.length; i++) {
      var iframe = editors[i];
      if (attachedEditors.has(iframe)) continue;
      try {
        var editorDoc = iframe.contentDocument;
        editorDoc.addEventListener('keydown', onEditorKeyDown.bind(editorDoc), true);
        editorDoc.addEventListener('click',   onEditorClick.bind(editorDoc),   false);
        attachedEditors.add(iframe);
        attached++;
        console.log('[ImageDrop] Attached to:', iframe.id);
      } catch (e) {
        console.warn('[ImageDrop] Could not attach to:', iframe.id, e);
      }
    }
    return attached;
  }
  // ── MUTATION OBSERVER ───────────────────────────────────────────────────────
  function startObserver(innerDoc) {
    if (observerRef) { try { observerRef.disconnect(); } catch(e) {} }
    observerRef = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        if (mutations[m].addedNodes.length > 0) { setTimeout(attachToEditors, 400); break; }
      }
    });
    observerRef.observe(innerDoc.body, { childList: true, subtree: true });
  }
  // ── LOAD BADGE ──────────────────────────────────────────────────────────────
  function showLoadBadge() {
    var badge = document.createElement('div');
    badge.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px',
      'background:#2ecc71', 'color:#fff',
      'padding:8px 14px', 'border-radius:6px',
      'font-family:Arial,sans-serif', 'font-size:13px', 'font-weight:bold',
      'z-index:2147483647', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      'pointer-events:none'
    ].join(';');
    badge.textContent = 'Image Drop Ready (Ctrl+Shift+I)';
    document.body.appendChild(badge);
    setTimeout(function () { badge.remove(); }, 3000);
  }
  // ── INIT ────────────────────────────────────────────────────────────────────
  var initAttempts = 0;
  function init() {
    initAttempts++;
    var appFrame = getAppFrame();
    if (!appFrame) { if (initAttempts < 30) setTimeout(init, 500); return; }
    var innerDoc = getInnerDoc();
    if (!innerDoc || !innerDoc.body) { if (initAttempts < 30) setTimeout(init, 500); return; }
    attachToEditors();
    startObserver(innerDoc);
    if (retryInterval) clearInterval(retryInterval);
    retryInterval = setInterval(attachToEditors, 2000);
    console.log('[ImageDrop] v1.6 initialized. Shortcut: Ctrl+Shift+I');
    showLoadBadge();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1000); });
  } else {
    setTimeout(init, 1000);
  }
})();
