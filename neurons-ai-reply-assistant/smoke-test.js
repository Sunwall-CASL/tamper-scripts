// ==UserScript==
// @name         TM Smoke Test
// @namespace    https://uwm-amc.ivanticloud.com/
// @version      1.0
// @match        https://uwm-amc.ivanticloud.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function () {
  console.log('[TM SMOKE TEST] Script is running. Time:', new Date().toISOString());
  alert('[TM SMOKE TEST] Tampermonkey is working.');
})();
