/*
 * FScreen - content script, ISOLATED world (default).
 *
 * Only this side has access to chrome.* APIs. Its single job is to push the
 * per-tab state (interception on/off, and which component owns Alt+`) into the
 * MAIN-world script via window.postMessage, and to relay command messages
 * coming back from the service worker.
 */
(() => {
  'use strict';

  if (window.__FSCREEN_ISO__) return;
  window.__FSCREEN_ISO__ = 1;

  const NS = '__fscreen';

  function post(msg) {
    try {
      msg[NS] = 1;
      window.postMessage(msg, '*');
    } catch (e) { /* context invalidated */ }
  }

  let stateSeen = false;
  function syncFromBackground(retry) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'fscreen:get-state' });
      if (p && typeof p.then === 'function') {
        p.then(function (res) {
          if (!res) return;
          stateSeen = true;
          // Only when the background actually holds a stored value. Interception
          // starts OFF in both worlds, so pushing the default would just race
          // with anything else that arms this tab.
          if (typeof res.enabled === 'boolean') post({ type: 'state', enabled: res.enabled });
          if (res.hotkey === 'page' || res.hotkey === 'browser') post({ type: 'hotkey', mode: res.hotkey });
          // Which files are actually loaded: the MAIN world cannot read the
          // manifest, so it gets the version from here and shows it on the exit
          // button. A content script older than the manifest is then visible
          // without opening DevTools.
          try {
            const mv = chrome.runtime.getManifest && chrome.runtime.getManifest().version;
            if (mv) post({ type: 'build', build: mv });
          } catch (e2) { /* ignore */ }
        }).catch(function () {
          // The service worker was still waking up. One retry, so a slow start
          // cannot leave this frame permanently blind to the tab's state.
          if (!stateSeen && !retry) setTimeout(function () { syncFromBackground(true); }, 1500);
        });
      }
    } catch (e) { /* extension context invalidated */ }
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.type === 'fscreen:state' && typeof msg.enabled === 'boolean') {
        post({ type: 'state', enabled: msg.enabled });
      } else if (msg.type === 'fscreen:command' && typeof msg.cmd === 'string') {
        post({ type: 'command', cmd: msg.cmd });
      }
      // Always answer: the service worker sends with {frameId:0} first and
      // treats "no reply" as "this frame has no content script".
      try { sendResponse({ ok: 1 }); } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  syncFromBackground();
})();
