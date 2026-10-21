/*
 * FScreen - background service worker.
 *
 * Holds the per-tab question "does FScreen intercept this site's own fullscreen
 * requests?" - OFF by default, the toolbar icon opts in - persisted in
 * chrome.storage.session so it survives service worker restarts but resets when
 * the browser session ends. It also reports whether the user bound Alt+` itself
 * at chrome://extensions/shortcuts, which is what tells the content script how
 * long a duplicate copy of that key has to be dropped.
 */

const DEFAULT_ENABLED = false;   // must match `enabled` in src/content-main.js
const BUILD = '1.4.0';           // keep in sync with manifest.json "version"
const KEY_PREFIX = 'fscreen:tab:';
const GREEN = [26, 127, 55];
const RED = [179, 38, 30];

const keyFor = (tabId) => KEY_PREFIX + tabId;

/** The tab's stored value, or null when the user never touched the icon. */
async function readStored(tabId) {
  if (tabId == null) return null;
  try {
    const stored = await chrome.storage.session.get(keyFor(tabId));
    const value = stored[keyFor(tabId)];
    return typeof value === 'boolean' ? value : null;
  } catch (e) {
    return null;
  }
}

const effective = (stored) => (typeof stored === 'boolean' ? stored : DEFAULT_ENABLED);

async function setBadge(tabId, enabled) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeText({ tabId, text: enabled ? 'ON' : 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: enabled ? GREEN : RED });
    await chrome.action.setTitle({
      tabId,
      title: enabled
        ? 'FScreen ' + BUILD + ': this site\'s fullscreen goes to the pane (click for real fullscreen)'
        : 'FScreen ' + BUILD + ': real fullscreen here (click to send this site\'s fullscreen to the pane)'
    });
  } catch (e) { /* tab went away */ }
}

async function pushState(tabId, enabled) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'fscreen:state', enabled });
  } catch (e) { /* no content script in this tab (chrome://, web store, ...) */ }
}

async function writeState(tabId, enabled) {
  if (tabId == null) return;
  try {
    await chrome.storage.session.set({ [keyFor(tabId)]: enabled });
  } catch (e) { /* ignore */ }
  await setBadge(tabId, enabled);
  await pushState(tabId, enabled);
}

async function toggleState(tabId) {
  const next = !effective(await readStored(tabId));
  await writeState(tabId, next);
  return next;
}

/* ---- Alt+`: delivered by the page, or by the browser if the user bound it ---- */

function isAltBackquote(shortcut) {
  if (!shortcut) return false;
  const sc = String(shortcut);
  if (/ctrl|command|macctrl|search/i.test(sc)) return false;
  if (!/alt/i.test(sc)) return false;
  const parts = sc.split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts[parts.length - 1];
  return key === '`' || key === '~';
}

/**
 * 'browser' only when the bound key is our Alt+` itself: that key may reach us
 * twice - once as a page keydown in the focused frame, once as this command in
 * the top frame - so the content script widens its "one keypress" window and
 * drops the copy. Neither path is ever disabled: if Chrome does not deliver the
 * command (a conflicting binding, a context where commands are suppressed) the
 * in-page listener is all the user has left.
 */
async function hotkeyMode() {
  try {
    const commands = await chrome.commands.getAll();
    const toggle = (commands || []).find((c) => c && c.name === 'toggle');
    return isAltBackquote(toggle && toggle.shortcut) ? 'browser' : 'page';
  } catch (e) {
    return 'page';
  }
}

/* ---- toolbar icon: click toggles the tab's mode ---- */

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  toggleState(tab.id);
});

/* ---- command registered in manifest ---- */

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'toggle') return;
    let targetId = tab && tab.id != null ? tab.id : null;
    if (targetId == null) {
      try {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        targetId = active ? active.id : null;
      } catch (e) { /* ignore */ }
    }
    if (targetId == null) return;

    const msg = { type: 'fscreen:command', cmd: 'toggle' };
    // Top frame first: it owns the <iframe> element an embed expands through.
    // Only if that frame has no content script at all do we fall back to every
    // frame, so a covered embed inside a page we do not cover still gets the key.
    try {
      await chrome.tabs.sendMessage(targetId, msg, { frameId: 0 });
    } catch (e) {
      try { await chrome.tabs.sendMessage(targetId, msg); } catch (e2) { /* no content script here */ }
    }
  });
}

/* ---- content script asking for the current state on load ---- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'fscreen:get-state') return;
  const tabId = sender.tab && sender.tab.id != null ? sender.tab.id : null;
  Promise.all([readStored(tabId), hotkeyMode()])
    .then(([stored, hotkey]) => {
      // enabled:null means "nothing stored" - the MAIN world keeps its own
      // default instead of being raced by a push.
      try { sendResponse({ enabled: typeof stored === 'boolean' ? stored : null, hotkey }); } catch (e) { /* ignore */ }
    })
    .catch(() => {
      try { sendResponse({ enabled: null, hotkey: 'page' }); } catch (e) { /* ignore */ }
    });
  return true; // async response
});

/* ---- lifecycle ---- */

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(keyFor(tabId)).catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab || tab.id == null) return;
  readStored(tab.id).then((stored) => setBadge(tab.id, effective(stored)));
});

async function syncAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => readStored(tab.id).then((stored) => setBadge(tab.id, effective(stored)))));
  } catch (e) { /* ignore */ }
}

chrome.runtime.onInstalled.addListener(syncAllTabs);
chrome.runtime.onStartup.addListener(syncAllTabs);
syncAllTabs();
