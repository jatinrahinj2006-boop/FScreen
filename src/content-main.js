/*
 * FScreen - content script, MAIN world.
 *
 * Injected with world:"MAIN" + run_at:"document_start" so it shares the page's
 * JavaScript realm. That is the whole point: an override installed from an
 * ISOLATED world would patch a *different* copy of Element.prototype and the
 * site's own scripts would never see it.
 *
 * This file deliberately uses no chrome.* API - MAIN world scripts have none.
 * Per-tab state (enabled/disabled) is pushed in from content-isolated.js with
 * window.postMessage, using the __fscreen namespace.
 */
(() => {
  'use strict';

  if (window.__FSCREEN__) return;
  try {
    Object.defineProperty(window, '__FSCREEN__', { value: 1, configurable: false });
  } catch (e) {
    window.__FSCREEN__ = 1;
  }

  // Declared up here, not with the other constants: markBoot() below runs at
  // load and reads it, so a `const` further down would still be in its
  // temporal dead zone (the error is swallowed by markBoot's try/catch, which
  // is exactly the kind of silent failure this project does not need).
  const BUILD = '1.4.0';               // keep in sync with manifest.json "version"

  // Visible to the page (unlike window.__FSCREEN__, which is world-local):
  // doubles as a debug marker, "is FScreen armed here?", and tells us whether we
  // got in before the first page script.
  function markBoot() {
    try {
      const de = document.documentElement;
      if (de) {
        if (!de.hasAttribute('data-fscreen')) de.setAttribute('data-fscreen', '1');
        // Which content script build is running here, for the same reason as
        // above - `document.documentElement.dataset.fscreenBuild`.
        de.setAttribute('data-fscreen-build', BUILD);
      }
    } catch (e) { /* ignore */ }
  }
  markBoot();
  if (!document.documentElement) document.addEventListener('DOMContentLoaded', markBoot, { once: true });

  /* -------------------------------------------------------------------- *
   * Constants
   * -------------------------------------------------------------------- */

  const NS = '__fscreen';              // cross-world message namespace
  const MAX_Z = 2147483647;
  const STYLE_ID = 'fscreen-style';
  const BTN_ID = 'fscreen-exit';
  const TOGGLE_GUARD_MS = 200;         // absorbs double-fire if a global command key is also bound
  // The same physical key can reach us twice: once as a page keydown in the
  // frame that has focus, once as a chrome.commands message in the top frame.
  // These windows say "that was one keypress", so the second copy is dropped
  // instead of toggling the pane back off (or toggling a parent frame that a
  // child frame has already handled).
  const COMMAND_DEDUPE_PAGE_MS = 250;
  const COMMAND_DEDUPE_BROWSER_MS = 400;
  const KEY_DROP_MS = 400;             // set on children when the browser command acted first

  // One line per document, so "is the current build even running here?" and
  // "which element did it pick?" are answerable from the page console.
  try { console.info('[FScreen] ready ' + BUILD); } catch (e) { /* ignore */ }

  /* -------------------------------------------------------------------- *
   * Per-site configuration
   *
   * Adding a site later = one match pattern in manifest.json + (optionally)
   * one entry here. Nothing else in this file is site specific.
   *
   *   playerSelector      - the element that should fill the tab viewport.
   *                         Comma lists are allowed; first visible/hit match wins.
   *   fullscreenButtonSelector - optional, informational (used by nothing yet,
   *                         kept so per-site tuning has a home).
   * -------------------------------------------------------------------- */

  const SITE_CONFIG = {
    '*.youtube.com': {
      playerSelector: '.html5-video-player',
      fullscreenButtonSelector: '.ytp-fullscreen'
    },
    '*.anikototv.to': {
      // The video lives in a cross-origin megaplay.buzz iframe, but this site's
      // player-fullscreen-parent.min.js relays the iframe's "megaCommand" and
      // calls #player-wrapper.requestFullscreen() in *this* document, so the
      // intercept happens here and the iframe element expands with it.
      // #w-player - the bigger match of the list - also owns the toolbar, the
      // "You're watching" row and the SUB/DUB server list; tightenToPlayer()
      // trims that back to #player-aspect, the box that actually holds the
      // iframe, so the rest of the page stays behind the pane.
      playerSelector: '#player-wrapper, #w-player',
      fullscreenButtonSelector: null
    },
    '*.megaplay.buzz': {
      // The embed itself, when it is not nested under an allowlisted parent.
      playerSelector: '#megaplay-player, .mg3-player',
      fullscreenButtonSelector: null
    },
    '*.hianime.at': {
      // <div class="player-frame"><iframe src="https://zokoanime.video" ...></div>
      playerSelector: '.player-frame',
      fullscreenButtonSelector: null
    },
    '*.cinehd.vc': {
      // Next.js player: a Tailwind wrapper holding one visible provider iframe
      // plus a stack of about:blank ones for the other servers. :has() keeps this
      // from matching any other rounded box; if it stops matching we silently
      // fall back to the generic "biggest visible iframe" resolver.
      playerSelector: '.overflow-hidden.rounded-lg:has(iframe[data-provider-name])',
      fullscreenButtonSelector: null
    }
  };

  function siteConfig() {
    const h = String(location.hostname || '').toLowerCase();
    if (SITE_CONFIG[h]) return SITE_CONFIG[h];
    const keys = Object.keys(SITE_CONFIG);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.charAt(0) === '*' && k.charAt(1) === '.') {
        const bare = k.slice(2);
        if (h === bare || h.slice(-(bare.length + 1)) === '.' + bare) return SITE_CONFIG[k];
      }
    }
    return null;
  }

  /* -------------------------------------------------------------------- *
   * DOM helpers (composed/light-DOM aware - players love shadow roots)
   * -------------------------------------------------------------------- */

  function composedParent(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    let root = null;
    try { root = el.getRootNode ? el.getRootNode() : null; } catch (e) { root = null; }
    return root && root.host ? root.host : null;
  }

  function deepQuery(root, selector, depth) {
    depth = depth || 0;
    if (!root || depth > 6 || !root.querySelector) return null;
    let hit = null;
    try { hit = root.querySelector(selector); } catch (e) { hit = null; }
    if (hit) return hit;

    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return null; }
    const limit = Math.min(all.length, 2500);
    for (let i = 0; i < limit; i++) {
      const sr = all[i].shadowRoot;
      if (sr) {
        const found = deepQuery(sr, selector, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function deepQueryAll(root, selector) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    try {
      const direct = root.querySelectorAll(selector);
      for (let i = 0; i < direct.length; i++) out.push(direct[i]);
    } catch (e) { /* ignore */ }
    if (out.length) return out;

    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { return out; }
    const limit = Math.min(all.length, 2500);
    for (let i = 0; i < limit; i++) {
      const sr = all[i].shadowRoot;
      if (sr) {
        const nested = deepQueryAll(sr, selector);
        for (let j = 0; j < nested.length; j++) out.push(nested[j]);
      }
    }
    return out;
  }

  /** "div#player-aspect" - for the console lines that make support possible. */
  function describeEl(el) {
    if (!el) return 'null';
    let s;
    try { s = el.tagName ? el.tagName.toLowerCase() : String(el); } catch (e) { return String(el); }
    if (el.id) s += '#' + el.id;
    const c = typeof el.className === 'string' ? el.className.trim() : '';
    if (c) s += '.' + c.split(/\s+/)[0];
    return s;
  }

  function hasVideo(node) {
    if (!node) return false;
    if (node.tagName === 'VIDEO') return true;
    if (!node.querySelector) return false;
    try {
      if (node.querySelector('video')) return true;
    } catch (e) { /* ignore */ }
    return !!deepQuery(node, 'video');
  }

  function area(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return 0;
      return r.width * r.height;
    } catch (e) {
      return 0;
    }
  }

  function largest(list) {
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < list.length; i++) {
      const a = area(list[i]);
      if (a > bestArea) { bestArea = a; best = list[i]; }
    }
    return best;
  }

  // Everything a wrapper owns beside or under the player box that is bigger
  // than a control row is page content, not part of the player.
  const SECTION_RATIO = 0.05;      // share of the player box's own area
  const SECTION_MIN_AREA = 4000;   // px^2 - buttons and labels never count

  /**
   * A wrapper that owns whole sections of page next to or under the player box
   * - a server list, season rows, an episode grid, a related-videos rail - is a
   * page section rather than the player shell. Restyling it fills the tab with
   * a black rectangle that still *contains* the rest of the page, which is what
   * Alt+` looked like on the anime site that reported this: the video kept its
   * old slice at the top and everything underneath stayed on screen.
   *
   * @param {Element} parent candidate wrapper
   * @param {Element} box the player box that lives inside it
   * @returns {boolean} true when parent owns content of its own around that box
   */
  function ownsItsOwnSection(parent, box) {
    if (!parent || !box || !parent.children) return false;
    let boxRect;
    try { boxRect = box.getBoundingClientRect(); } catch (e) { return false; }
    const min = Math.max(SECTION_MIN_AREA, area(box) * SECTION_RATIO);
    const kids = parent.children;
    const n = Math.min(kids.length, 200);
    for (let i = 0; i < n; i++) {
      const c = kids[i];
      if (c === box || (c.contains && c.contains(box))) continue;
      let r;
      try { r = c.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width * r.height < min) continue;
      // Under the box (a row of its own), or beside it (a rail). Content
      // overlaying the box - controls drawn on top of the video - is ignored.
      if (r.top >= boxRect.bottom - 4 ||
          r.left >= boxRect.right - 4 ||
          r.right <= boxRect.left + 4) return true;
    }
    return false;
  }

  /**
   * A stack of inactive server iframes (about:blank, opacity:0,
   * pointer-events:none) is exactly the same size as the live one, so "biggest
   * iframe" alone picks the wrong element. Filter first.
   */
  function isLiveFrame(frame) {
    let src = '';
    try { src = (frame.getAttribute && frame.getAttribute('src')) || ''; } catch (e) { return false; }
    if (!src || /^about:/i.test(src)) return false;
    let cs = null;
    try { cs = getComputedStyle(frame); } catch (e) { return false; }
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) < 0.1) return false;
    if (cs.pointerEvents === 'none') return false;
    return area(frame) > 0;
  }

  /* -------------------------------------------------------------------- *
   * Target resolution: "walk up until we find the real player container"
   * -------------------------------------------------------------------- */

  function climbToPlayer(start) {
    if (!start) return null;

    let node = start;
    let found = null;
    for (let guard = 0; node && guard < 12; guard++) {
      if (hasVideo(node)) { found = node; break; }
      node = composedParent(node);
    }
    if (!found) return null;

    // Fullscreening a bare <video> hides the site's custom controls, which live
    // in the wrapper - prefer the shell when it owns the video.
    if (found.tagName === 'VIDEO') {
      const p = composedParent(found);
      if (p && p.tagName !== 'BODY' && p.tagName !== 'HTML' && hasVideo(p)) found = p;
    }

    // Bounded growth: walk up while the parent is basically the same box, so a
    // nested shell (video -> .video-container -> #player) still brings its own
    // controls along. The ratio stops us well before a page-level wrapper -
    // fullscreening that would leave the real player unscaled inside a black
    // rectangle covering the tab.
    //
    // The ratio alone is not enough: a watch page grows in small steps (player
    // -> player + toolbar -> player + servers + episodes), each under the cap,
    // so the walk used to end on the whole page section. A wrapper that owns
    // page content around the box is where the player stops.
    let cur = found;
    for (let i = 0; i < 3; i++) {
      const p = composedParent(cur);
      if (!p || p === document.body || p === document.documentElement) break;
      if (p.tagName === 'BODY' || p.tagName === 'HTML' || !hasVideo(p)) break;
      const aCur = area(cur);
      const aP = area(p);
      if (!aCur || !aP || aP > aCur * 2.5) break;
      if (ownsItsOwnSection(p, cur)) break;
      cur = p;
    }
    return cur;
  }

  function closestComposed(el, selector) {
    let n = el;
    for (let guard = 0; n && guard < 12; guard++) {
      if (n.matches && n.matches(selector)) return n;
      n = composedParent(n);
    }
    return null;
  }

  /**
   * @param {Element|null} preferEl the element that asked for fullscreen, if any
   * @returns {Element|null}
   */
  function resolveTargetInner(preferEl) {
    const cfg = siteConfig();
    const selector = cfg && cfg.playerSelector;

    // A request on <html>/<body> - YouTube's "external fullscreen" path - says
    // nothing about where the player is: climbToPlayer() would return the
    // document element simply because it contains a <video>, freezing the whole
    // page (sidebar, comments and all) instead of the player. Resolve the real
    // player through the generic path below instead.
    const wantsPage = preferEl === document.documentElement || preferEl === document.body;

    if (preferEl && !wantsPage) {
      // Closest configured ancestor of the thing that asked (crosses shadow roots).
      if (selector) {
        try {
          const hit = closestComposed(preferEl, selector);
          if (hit) return hit;
        } catch (e) { /* invalid selector - fall through */ }
      }
      return climbToPlayer(preferEl) || preferEl;
    }

    // Hotkey path: no element to start from, so find the player ourselves.
    if (selector) {
      const matches = deepQueryAll(document, selector);
      const owner = largest(matches.filter(function (n) { return hasVideo(n) || !!deepQuery(n, 'iframe'); }));
      if (owner) return owner;
    }

    const video = largest(deepQueryAll(document, 'video'));
    if (video) return climbToPlayer(video) || video;

    // The element that has focus is the strongest hint we have: clicking a
    // player inside a cross-origin embed puts that <iframe> - or the <video>
    // itself - here even when it is far too small to win on area.
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== document.documentElement) {
      if (focused.tagName === 'IFRAME' && isLiveFrame(focused)) return focused;
      const asPlayer = climbToPlayer(focused);
      if (asPlayer) return asPlayer;
    }

    // Cross-origin player: the <video> is invisible to us, but the iframe is not.
    const frames = deepQueryAll(document, 'iframe');
    const live = frames.filter(isLiveFrame);
    const frame = largest(live.length ? live : frames);
    if (frame) {
      const viewportArea = window.innerWidth * window.innerHeight;
      // One visible frame on the page is the player even when it is small
      // (side panel player, mobile layout, a player box still growing in).
      if (live.length === 1 || area(frame) >= viewportArea * 0.15 || area(frame) >= 640 * 360) return frame;
    }

    // Last resort: what is sitting in the middle of the viewport? Players are.
    let centre = null;
    try { centre = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2); } catch (e) { centre = null; }
    if (centre) {
      if (centre.tagName === 'IFRAME' && isLiveFrame(centre)) return centre;
      const p = climbToPlayer(centre);
      if (p) return p;
    }

    return null;
  }

  /**
   * Keep the pane on the box that owns the player. resolveTargetInner() can
   * hand back something that merely *wraps* the player - a configured selector
   * that matched a section, a focus hint, whatever sat in the middle of the
   * viewport - and a wrapper that owns page content of its own (server list,
   * seasons, episodes, a related rail) would fill the tab with a black
   * rectangle containing the rest of the page. Descend to the box the video or
   * the embed actually lives in whenever the candidate has sections around it.
   *
   * @param {Element|null} target
   * @returns {Element|null}
   */
  function tightenToPlayer(target) {
    if (!target || !target.getBoundingClientRect) return target;

    // The media the pane is really about - the largest one that is on screen,
    // so a hidden ad frame cannot win on size alone.
    let media = null;
    try {
      const found = deepQueryAll(target, 'video, iframe');
      let best = 0;
      for (let i = 0; i < found.length; i++) {
        const el = found[i];
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a <= best) continue;
        if (r.bottom <= 0 || r.top >= window.innerHeight ||
            r.right <= 0 || r.left >= window.innerWidth) continue;
        // A painted-over but still laid-out frame (opacity:0 server stack) has
        // a perfectly good rect: skip it, but keep frames that are simply
        // invisible by style.
        try {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' ||
              parseFloat(cs.opacity) < 0.1) continue;
        } catch (e) { /* no style - keep it */ }
        best = a;
        media = el;
      }
    } catch (e) { media = null; }
    if (!media || media === target) return target;

    // Walk from the media up to the candidate - the shell the media sits in,
    // as long as that shell owns nothing but the media (and its overlays).
    let box = media;
    for (let i = 0; i < 8; i++) {
      const p = composedParent(box);
      if (!p || p === target || p === document.body || p === document.documentElement) break;
      if (!area(p) || ownsItsOwnSection(p, box)) break;
      box = p;
    }

    return ownsItsOwnSection(target, box) ? box : target;
  }

  /**
   * @param {Element|null} preferEl the element that asked for fullscreen, if any
   * @returns {Element|null} the element the pane has to be applied to
   */
  function resolveTarget(preferEl) {
    return tightenToPlayer(resolveTargetInner(preferEl));
  }

  /* -------------------------------------------------------------------- *
   * Style save/restore
   * -------------------------------------------------------------------- */

  const TARGET_PROPS = [
    'position', 'top', 'left', 'right', 'bottom', 'width', 'height',
    'zIndex', 'margin', 'maxWidth', 'maxHeight', 'transform', 'backgroundColor'
  ];

  const TARGET_STYLE = {
    position: 'fixed',
    top: '0px',
    left: '0px',
    right: 'auto',
    bottom: 'auto',
    width: '100vw',
    height: '100vh',
    zIndex: String(MAX_Z),
    margin: '0',
    maxWidth: 'none',
    maxHeight: 'none',
    transform: 'none',
    backgroundColor: '#000'
  };

  // These create a containing block for position:fixed, which would make the
  // player fill its ancestor instead of the tab viewport. Neutralised on enter,
  // restored on exit.
  const CONTAINING_BLOCK_PROPS = ['transform', 'perspective', 'filter', 'backdrop-filter', 'will-change', 'contain', 'transform-style'];
  const NO_VALUE = { none: 1, auto: 1, flat: 1, normal: 1, visible: 1 };

  // ...and these make an ancestor own a *stacking context*, which is a
  // different trap with the same symptom. z-index:2147483647 is only ever
  // compared against the siblings of the nearest context above the pane, so a
  // wrapper like the anime watch pages' `div.anis-watch-wrap { position:relative;
  // z-index:3 }` pins the pane at level 3 and the site's fixed header (z-index
  // 9999, straight in the root context) keeps painting on top of it - which the
  // user sees as "some site content is still there". Resetting the property
  // that opens the context lets the pane join the root context, where
  // 2147483647 really is the maximum. Everything is restored on exit.
  //   rotate/scale/translate are here twice over: they open a context and they
  //   also make the element a containing block for fixed descendants.
  const STACKING_CONTEXT_RULES = [
    ['opacity', function (v) { return parseFloat(v) < 1; }, '1'],
    ['isolation', function (v) { return v === 'isolate'; }, 'auto'],
    ['mix-blend-mode', function (v) { return v !== 'normal'; }, 'normal'],
    ['clip-path', function (v) { return !!v && v !== 'none'; }, 'none'],
    ['mask-image', function (v) { return !!v && v !== 'none'; }, 'none'],
    ['rotate', function (v) { return !!v && v !== 'none'; }, 'none'],
    ['scale', function (v) { return !!v && v !== 'none'; }, 'none'],
    ['translate', function (v) { return !!v && v !== 'none'; }, 'none']
  ];

  function camToDash(n) {
    return n.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
  }

  function saveProps(el, names) {
    const saved = [];
    for (let i = 0; i < names.length; i++) {
      const dash = camToDash(names[i]);
      // Some pages expose an element whose `style` is not a CSSStyleDeclaration
      // (custom elements with their own getter). Never let that abort the save.
      let value = '', prio = '';
      try {
        const s = el.style;
        if (s && typeof s.getPropertyValue === 'function') {
          value = s.getPropertyValue(dash);
          prio = s.getPropertyPriority(dash);
        }
      } catch (e) { /* hostile element */ }
      saved.push([dash, value, prio]);
    }
    return saved;
  }

  function restoreProps(el, saved) {
    if (!el || !saved) return;
    for (let i = 0; i < saved.length; i++) {
      const dash = saved[i][0];
      const value = saved[i][1];
      const prio = saved[i][2];
      try {
        if (value) el.style.setProperty(dash, value, prio);
        else el.style.removeProperty(dash);
      } catch (e) { /* detached or frozen */ }
    }
  }

  function applyProps(el, styleMap) {
    for (const key in styleMap) {
      try { el.style.setProperty(camToDash(key), styleMap[key], 'important'); } catch (e) { /* ignore */ }
    }
  }

  function neutralizeAncestors(target) {
    const saved = [];
    let n = composedParent(target);
    for (let guard = 0; n && guard < 12; guard++) {
      if (n === document.documentElement) break;
      let cs = null;
      try { cs = getComputedStyle(n); } catch (e) { cs = null; }
      if (cs) {
        const touched = [];
        // The applied value rides along (4th slot) so housekeep() can put it
        // back if the site rewrites our inline style behind our back.
        const mark = (prop, applied) => {
          let value = '', prio = '';
          try {
            const s = n.style;
            if (s && typeof s.getPropertyValue === 'function') {
              value = s.getPropertyValue(prop);
              prio = s.getPropertyPriority(prop);
            }
          } catch (e) { /* custom element with a foreign `style` getter */ }
          touched.push([prop, value, prio, applied]);
          try { n.style.setProperty(prop, applied, 'important'); } catch (e) { /* ignore */ }
        };

        for (let i = 0; i < CONTAINING_BLOCK_PROPS.length; i++) {
          const prop = CONTAINING_BLOCK_PROPS[i];
          let value = '';
          try { value = cs.getPropertyValue(prop); } catch (e) { value = ''; }
          if (!value || NO_VALUE[value]) continue;
          // `contain: size` only resizes the box - dropping it would move the
          // page around behind the pane for no stacking benefit.
          if (prop === 'contain' && !/layout|paint|strict|content/.test(value)) continue;
          mark(prop, prop === 'will-change' ? 'auto'
            : prop === 'contain' ? 'none'
            : prop === 'transform-style' ? 'flat' : 'none');
        }

        // Any non-auto z-index opens a context: on a positioned ancestor, or on
        // a flex/grid item (which can be position:static). z-index never
        // affects layout, so resetting it is always safe. This is the one that
        // matters in practice - the anime watch pages wrap the player in
        // `position:relative; z-index:3`.
        try {
          const zi = cs.getPropertyValue('z-index');
          if (zi && zi !== 'auto') mark('z-index', 'auto');
        } catch (e) { /* ignore */ }

        for (let i = 0; i < STACKING_CONTEXT_RULES.length; i++) {
          const rule = STACKING_CONTEXT_RULES[i];
          const prop = rule[0];
          let value = '';
          try { value = cs.getPropertyValue(prop); } catch (e) { value = ''; }
          if (!value || NO_VALUE[value]) continue;
          if (!rule[1](value)) continue;
          mark(prop, rule[2]);
        }

        if (touched.length) saved.push([n, touched]);
      }
      n = composedParent(n);
    }
    return saved;
  }

  function restoreAncestors(saved) {
    if (!saved) return;
    for (let i = 0; i < saved.length; i++) restoreProps(saved[i][0], saved[i][1]);
  }

  /* -------------------------------------------------------------------- *
   * Overlay UI: style sheet + hover-fade exit button
   * -------------------------------------------------------------------- */

  const BUTTON_CSS = [
    '#' + BTN_ID + '{',
    'position:fixed!important;top:14px;right:14px;z-index:' + MAX_Z + '!important;',
    'width:40px;height:40px;padding:0;margin:0;border:1px solid rgba(255,255,255,.55);',
    'border-radius:999px;background:rgba(0,0,0,.72);color:#fff;cursor:pointer;',
    'display:flex;align-items:center;justify-content:center;',
    'box-shadow:0 2px 10px rgba(0,0,0,.45);opacity:.16;',
    'transition:opacity .18s ease,transform .18s ease,background .18s ease;',
    'pointer-events:auto;',
    '}',
    '#' + BTN_ID + ':hover,#' + BTN_ID + ':focus-visible{opacity:1!important;transform:scale(1.08);background:rgba(0,0,0,.9);}',
    '#' + BTN_ID + ' svg{width:20px;height:20px;display:block;}'
  ].join('');

  function ensureStyle() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) return existing;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = BUTTON_CSS;
    (document.head || document.documentElement).appendChild(el);
    return el;
  }

  function removeStyle() {
    const el = document.getElementById(STYLE_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function ensureButton() {
    let btn = document.getElementById(BTN_ID);
    if (btn && btn.isConnected && document.body && btn.parentNode !== document.body) {
      document.body.appendChild(btn);       // sites that re-render their <body>
      return btn;
    }
    if (btn && btn.isConnected) return btn;

    if (!document.body) return null;        // MO will call us again once <body> exists

    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'FScreen: exit pane (Esc)';
    btn.setAttribute('aria-label', 'FScreen: exit pane');

    // Built with createElementNS, never innerHTML: sites such as youtube.com
    // ship a Trusted Types policy (require-trusted-types-for 'script'), where
    // assigning a string to innerHTML throws and would abort the transition.
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    svg.appendChild(path);
    btn.appendChild(svg);

    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      exitPseudo();
    }, true);
    document.body.appendChild(btn);
    return btn;
  }

  function removeButton() {
    const btn = document.getElementById(BTN_ID);
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }

  /**
   * The exit button doubles as the on-page support readout: hovering it shows
   * the build (so "am I running the new files?" needs no DevTools) and the box
   * the pane landed on (the single number needed to fix target resolution).
   */
  function updateButtonStatus() {
    const btn = document.getElementById(BTN_ID);
    if (!btn || !active) return;
    let where = describeEl(active.target);
    try {
      const r = active.target.getBoundingClientRect();
      where += ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
    } catch (e) { /* ignore */ }
    const txt = 'FScreen ' + (manifestBuild || BUILD) + ': pane on ' + where +
      ' - click or Esc to exit';
    try {
      btn.title = txt;
      btn.setAttribute('aria-label', txt);
    } catch (e) { /* ignore */ }
  }

  function keepButtonOnTop() {
    if (!active || !document.body) return;
    const btn = document.getElementById(BTN_ID);
    if (!btn) { ensureButton(); return; }
    if (document.body.lastElementChild !== btn && Date.now() - lastButtonPush > 500) {
      lastButtonPush = Date.now();
      document.body.appendChild(btn);
    }
  }

  /* -------------------------------------------------------------------- *
   * State
   * -------------------------------------------------------------------- */

  /**
   * Interception is OPT-IN and OFF by default. The default has to agree with
   * DEFAULT_ENABLED in src/background.js:
   *
   *   - mode OFF (default): the site's own fullscreen - the F key, its
   *     fullscreen button, its <video controls> - goes through untouched and
   *     really goes fullscreen. Only Alt+` uses our pane mode.
   *   - mode ON (toolbar icon): those site-initiated requests are redirected
   *     into the tab pane instead, which is what you want while split-screening.
   */
  let enabled = false;
  // 'page'    - the in-page Alt+` listener below handles the key.
  // 'browser' - the same key is bound at chrome://extensions/shortcuts, so
  //             Chrome hands it to the service worker even when focus sits in
  //             a frame we do not cover (an ad, an unlisted embed). Toggling
  //             here as well would fire the command twice, so we stand down.
  let hotkeyMode = 'page';
  let active = null;         // { target, targetSaved, ancestors, scrollSaved, fromChild }
  let lastToggleAt = 0;
  let lastButtonPush = 0;
  let lastStyleApply = 0;      // cooldown for the drift re-assert in housekeep()
  let lastChildSignalAt = 0;   // a child frame handled the key a moment ago
  let keyDropUntil = 0;        // an ancestor handled it; do not act on the key too
  let manifestBuild = '';      // version the ISOLATED world reads from the manifest
  let lastPatchCheck = 0;

  const fsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement');
  const fsWebkitDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'webkitFullscreenElement');

  /* -------------------------------------------------------------------- *
   * Fake fullscreen state
   *
   * Without this every player thinks it is still windowed: they ask
   * document.fullscreenElement, get null, and their fullscreen button sends
   * "enter" forever with no way to exit. Lying here makes their own button,
   * their icon state and their postMessage bridges behave normally.
   * -------------------------------------------------------------------- */

  if (fsDesc && fsDesc.get) {
    const orig = fsDesc.get;
    try {
      Object.defineProperty(Document.prototype, 'fullscreenElement', {
        configurable: true,
        enumerable: true,
        get: function () { return active ? (active.requestedBy || active.target) : orig.call(this); }
      });
    } catch (e) { /* ignore */ }
  }

  if (fsWebkitDesc && fsWebkitDesc.get) {
    const origW = fsWebkitDesc.get;
    try {
      Object.defineProperty(Document.prototype, 'webkitFullscreenElement', {
        configurable: true,
        enumerable: true,
        get: function () { return active ? (active.requestedBy || active.target) : origW.call(this); }
      });
    } catch (e) { /* ignore */ }
  }

  function emitFullscreenChange() {
    try { document.dispatchEvent(new Event('fullscreenchange', { bubbles: true })); } catch (e) { /* ignore */ }
    try { document.dispatchEvent(new Event('webkitfullscreenchange', { bubbles: true })); } catch (e) { /* ignore */ }
    // Players size their <video> off window.innerWidth, which we did not change.
    try {
      requestAnimationFrame(function () { window.dispatchEvent(new Event('resize')); });
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------------- *
   * Enter / exit
   * -------------------------------------------------------------------- */

  /**
   * @param {Element} target        the element we restyle to fill the viewport
   * @param {Window|null} fromChild the child frame that asked, if any
   * @param {Element|null} requestedBy what the page passed to requestFullscreen().
   *        Reported back from document.fullscreenElement: players compare it
   *        against their own element when deciding whether to exit (YouTube
   *        calls exitFullscreen() only if fullscreenElement === the element it
   *        asked for), so answering with a *different* element silently kills
   *        their toggle.
   */
  function enterPseudo(target, fromChild, requestedBy) {
    if (!target) return false;
    if (active) exitPseudo();

    // Nothing below may throw its way back to the caller: the caller is the
    // site's own requestFullscreen() (often .catch()-swallowed), so a throw here
    // means "the user pressed the fullscreen key and nothing visibly happened",
    // and it also skips the fullscreenchange/resize events the player needs in
    // order to re-measure itself.
    let targetSaved = null;
    let ancestors = null;
    let scrollSaved = null;
    try {
      targetSaved = saveProps(target, TARGET_PROPS);
      applyProps(target, TARGET_STYLE);

      ancestors = neutralizeAncestors(target);

      const html = document.documentElement;
      const body = document.body;
      scrollSaved = [
        [html, html.style.getPropertyValue('overflow'), html.style.getPropertyPriority('overflow')],
        body ? [body, body.style.getPropertyValue('overflow'), body.style.getPropertyPriority('overflow')] : null
      ];
      try { html.style.setProperty('overflow', 'hidden', 'important'); } catch (e) { /* ignore */ }
      if (body) { try { body.style.setProperty('overflow', 'hidden', 'important'); } catch (e) { /* ignore */ } }
    } catch (e) { /* hostile style environment - still activate below */ }

    active = {
      target: target,
      requestedBy: requestedBy || null,
      targetSaved: targetSaved,
      ancestors: ancestors,
      scrollSaved: scrollSaved,
      fromChild: fromChild || null
    };

    try { ensureStyle(); } catch (e) { /* ignore */ }
    try { ensureButton(); } catch (e) { /* ignore */ }
    try { updateButtonStatus(); } catch (e) { /* ignore */ }
    lastButtonPush = 0;
    lastStyleApply = Date.now();
    observeTarget();
    // Support line: which element the pane landed on, and at what size. If this
    // says a wrapper that owns page content, the target resolution is wrong.
    try {
      const r = target.getBoundingClientRect();
      console.info('[FScreen] pane on -> ' + describeEl(target) +
        ' (' + Math.round(r.width) + 'x' + Math.round(r.height) + ')');
    } catch (e) { /* ignore */ }
    emitFullscreenChange();
    notifyParent('child-expand');
    return true;
  }

  function exitPseudo() {
    if (!active) return;
    const snapshot = active;
    active = null;
    stopObserveTarget();

    restoreProps(snapshot.target, snapshot.targetSaved);
    restoreAncestors(snapshot.ancestors);

    if (snapshot.scrollSaved) {
      for (let i = 0; i < snapshot.scrollSaved.length; i++) {
        const row = snapshot.scrollSaved[i];
        if (!row) continue;
        const el = row[0];
        try {
          if (row[1]) el.style.setProperty('overflow', row[1], row[2]);
          else el.style.removeProperty('overflow');
        } catch (e) { /* ignore */ }
      }
    }

    removeButton();
    removeStyle();
    try { console.info('[FScreen] pane off -> ' + describeEl(snapshot.target)); } catch (e) { /* ignore */ }
    emitFullscreenChange();
    notifyParent('child-collapse');

    if (snapshot.fromChild && snapshot.fromChild.postMessage) {
      try { snapshot.fromChild.postMessage({ __fscreen: 1, type: 'command', cmd: 'exit' }, '*'); } catch (e) { /* ignore */ }
    }
    // Also tell every embed below us. If the pane went down here (Esc, the exit
    // button, a browser command) while an embed still has its own pane open,
    // that embed is left fullscreen inside a slice-sized box - which reads as
    // "the shortcut stopped working". Embeds without a pane ignore this.
    broadcastDown({ __fscreen: 1, type: 'command', cmd: 'exit' });
  }

  function notifyParent(type) {
    if (window.parent === window) return;
    try { window.parent.postMessage({ __fscreen: 1, type: type }, '*'); } catch (e) { /* ignore */ }
  }

  /** Reach every embed below us, so parent/child pane state cannot drift apart. */
  function broadcastDown(msg) {
    let frames = null;
    try { frames = document.querySelectorAll('iframe'); } catch (e) { return; }
    for (let i = 0; i < frames.length; i++) {
      try { frames[i].contentWindow.postMessage(msg, '*'); } catch (e2) { /* ignore */ }
    }
  }

  /**
   * How long "the same keypress" lasts when deciding whether a second copy of
   * it (a page keydown plus a chrome.commands message for one physical key)
   * should be dropped.
   */
  function commandDedupeMs() {
    return hotkeyMode === 'browser' ? COMMAND_DEDUPE_BROWSER_MS : COMMAND_DEDUPE_PAGE_MS;
  }

  /* -------------------------------------------------------------------- *
   * Cross-frame cooperation
   *
   * When a cross-origin embed expands itself, the parent (which does have a
   * content script) stretches the <iframe> element to fill the tab. That is what
   * makes the video fill the whole tab viewport rather than just the embed box.
   * -------------------------------------------------------------------- */

  function frameFor(childWindow) {
    if (!childWindow) return null;
    const frames = document.querySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentWindow === childWindow) return frames[i];
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function onChildExpand(childWindow) {
    const frame = frameFor(childWindow);
    if (!frame) return;
    if (active && active.target === frame) return;
    // Preserve what the page itself asked for: if this document already had a
    // fullscreen request of its own (anikototv relays the iframe command and
    // requests #player-wrapper), handing the style over to the <iframe> must
    // not lose it, or that site's exit guard starts failing here.
    const requestedBy = active ? active.requestedBy : null;
    enterPseudo(frame, childWindow, requestedBy);
  }

  function onChildCollapse(childWindow) {
    if (!active) return;
    // fromChild covers the normal path (the embed expanded itself and we
    // followed). The target check covers the other order: the browser command
    // expanded this frame first, then the embed's own keydown caught up - the
    // parent must still follow the embed down, or it is left with a pane the
    // user just closed.
    if (active.fromChild === childWindow) { exitPseudo(); return; }
    try {
      const frame = frameFor(childWindow);
      if (frame && active.target === frame) exitPseudo();
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------------- *
   * Native fullscreen overrides
   * -------------------------------------------------------------------- */

  const nativeRequest = Element.prototype.requestFullscreen ||
                        Element.prototype.webkitRequestFullscreen ||
                        Element.prototype.webkitRequestFullScreen;
  const nativeExit = Document.prototype.exitFullscreen || Document.prototype.webkitExitFullscreen;

  /**
   * The page asked for *real* fullscreen with no user gesture left, so the
   * browser refused and the promise we hand back rejects. The site attached no
   * .catch, so the rejection reaches window.onunhandledrejection, where its
   * error overlay prints the stack - and the stack starts in this file,
   * because we are the requestFullscreen() that called down into the browser.
   *
   * anikototv.to does exactly this: checkIframeSrc() polls every 500ms for the
   * next episode's iframe and then calls requestFullscreen() from the timer.
   * Without FScreen the identical rejection fires with the site's own script
   * in that stack instead of ours, so nothing is actually broken by us - the
   * report is just misattributed and loud.
   *
   * Attaching a handler marks the promise handled *without taking anything
   * away from the page*: it still receives the very same rejected promise, and
   * its own .catch still runs when it has one. Only the gesture case is
   * defused - a genuine failure still surfaces the way the site expects.
   */
  function defuseGestureRejection(p) {
    if (!p || typeof p.then !== 'function') return p;
    let noGesture = false;
    try {
      // Available since Chrome 121; absent means "cannot tell", and then we
      // leave the page exactly as the browser would have handed it to us.
      noGesture = !!(navigator.userActivation && navigator.userActivation.isActive === false);
    } catch (e) { noGesture = false; }
    if (!noGesture) return p;
    try {
      p.catch(function (e) {
        const why = (e && e.message) || String(e);
        if (/gesture/i.test(why)) {
          console.warn('[FScreen] fullscreen request refused: ' + why +
            ' - the page called requestFullscreen() outside a click or keypress ' +
            '(a timer, a message from an embed). Passed straight through to the ' +
            'browser; the site would have reported this as its own error.');
        } else {
          console.warn('[FScreen] fullscreen request rejected: ' + why);
        }
      });
    } catch (e) { /* ignore */ }
    return p;
  }

  function fakeRequest(options) {
    const el = this;

    // Mode off: real fullscreen, exactly as if FScreen were not installed.
    if (!enabled) {
      return defuseGestureRejection(nativeRequest ? nativeRequest.call(el, options) : Promise.resolve());
    }

    let target = null;
    try { target = resolveTarget(el); } catch (e) { target = null; }
    if (!target) {
      return defuseGestureRejection(nativeRequest ? nativeRequest.call(el, options) : Promise.resolve());
    }

    if (active) {
      // Pressing the site's fullscreen button again means "toggle", and it is
      // the only exit path for players that never call document.exitFullscreen().
      if (active.target === target) { exitPseudo(); return Promise.resolve(); }
      exitPseudo();
    }

    // Drop a native fullscreen the page may already be in, then go pane-relative.
    if (document.fullscreenElement) {
      try {
        const p = nativeExit ? nativeExit.call(document) : null;
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* ignore */ }
    }

    enterPseudo(target, null, el);
    return Promise.resolve();
  }

  function fakeExit() {
    if (active) { exitPseudo(); return Promise.resolve(); }
    return defuseGestureRejection(nativeExit ? nativeExit.call(this) : Promise.resolve());
  }

  function defineMethod(obj, name, fn) {
    try {
      Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true, enumerable: false });
      return obj[name] === fn;
    } catch (e) {
      try { obj[name] = fn; return obj[name] === fn; } catch (e2) { return false; }
    }
  }

  function installOverrides() {
    defineMethod(Element.prototype, 'requestFullscreen', fakeRequest);
    defineMethod(Element.prototype, 'webkitRequestFullscreen', fakeRequest);
    if (Object.getOwnPropertyDescriptor(Element.prototype, 'webkitRequestFullScreen')) {
      defineMethod(Element.prototype, 'webkitRequestFullScreen', fakeRequest);
    }
    if (Object.getOwnPropertyDescriptor(Element.prototype, 'mozRequestFullScreen')) {
      defineMethod(Element.prototype, 'mozRequestFullScreen', fakeRequest);
    }
    if (Object.getOwnPropertyDescriptor(Element.prototype, 'msRequestFullscreen')) {
      defineMethod(Element.prototype, 'msRequestFullscreen', fakeRequest);
    }
    defineMethod(Document.prototype, 'exitFullscreen', fakeExit);
    defineMethod(Document.prototype, 'webkitExitFullscreen', fakeExit);
    if (Object.getOwnPropertyDescriptor(Document.prototype, 'webkitCancelFullScreen')) {
      defineMethod(Document.prototype, 'webkitCancelFullScreen', fakeExit);
    }
  }

  function overridesIntact() {
    return Element.prototype.requestFullscreen === fakeRequest &&
           Document.prototype.exitFullscreen === fakeExit;
  }

  /*
   * Safety net. Anything that still reaches REAL native fullscreen gets pulled
   * back to pane-relative fullscreen while this tab's mode is ON:
   *
   *   - the browser's own <video controls> fullscreen button (never goes through
   *     requestFullscreen at all),
   *   - an embed host that is not in the allowlist yet - the call happens inside
   *     a frame that has no content script, and Chrome promotes it to the
   *     top-level document with this document's <iframe> element as the
   *     fullscreen element,
   *   - a player that cached the original API before we patched it.
   *
   * With the mode OFF this handler does nothing, so native fullscreen stays
   * native.
   */
  document.addEventListener('fullscreenchange', function () {
    if (active || !enabled) return;
    const el = document.fullscreenElement;
    if (!el) return;
    try {
      const p = nativeExit ? nativeExit.call(document) : null;
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* ignore */ }
    enterPseudo(el, null);
  });

  /* -------------------------------------------------------------------- *
   * Keyboard: Esc exits, Alt+` toggles
   * -------------------------------------------------------------------- */

  function toggle() {
    const now = Date.now();
    if (now - lastToggleAt < TOGGLE_GUARD_MS) return;
    lastToggleAt = now;

    if (active) { exitPseudo(); return; }

    // What document.fullscreenElement has to report while we are active.
    // Sites compare it with the element THEY asked for before they are willing
    // to exit (YouTube: `fullscreenElement == document.documentElement` before
    // it calls exitFullscreen()), so answering with the element we chose to
    // restyle turns their F key / fullscreen button into a no-op. If real
    // fullscreen is up we take over that element; otherwise we answer <html>,
    // the page-level request players like YouTube make themselves.
    let nativeFsEl = null;
    try { nativeFsEl = document.fullscreenElement; } catch (e) { nativeFsEl = null; }
    const requestedBy = nativeFsEl || document.documentElement;

    if (nativeFsEl) {
      // Real fullscreen is up first - leave it, then go pane-relative.
      try {
        const p = nativeExit ? nativeExit.call(document) : null;
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* ignore */ }
    }

    let target = null;
    try { target = resolveTarget(null); } catch (e) { target = null; }
    if (target) {
      enterPseudo(target, null, requestedBy);
      return;
    }

    // No player in THIS frame. A keydown only ever reaches the frame that has
    // focus, and focus spends a lot of its time inside an ad, a logo link or a
    // secondary embed - so swallowing the key here is exactly the "the shortcut
    // did nothing" report. Hand the press to the parent frame instead; it walks
    // up the tree until somebody owns a player, and stops at the top.
    if (window.parent && window.parent !== window) {
      try {
        window.parent.postMessage({ __fscreen: 1, type: 'command', cmd: 'toggle' }, '*');
        console.info('[FScreen] no player in this frame - passed the key to the parent frame.');
        return;
      } catch (e2) { /* ignore */ }
    }

    // Say something instead of looking broken: "Alt+` did nothing" is almost
    // always "there is no player in this frame".
    try { console.info('[FScreen] Alt+` pressed, but no player found in this frame.'); } catch (e) { /* ignore */ }
  }

  window.addEventListener('keydown', function (e) {
    if (!e) return;

    if (e.key === 'Escape' || e.key === 'Esc') {
      if (active) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        exitPseudo();
      }
      return;
    }

    // Alt+` - the physical key (Backquote) as well as whatever character the
    // layout prints for it, and AltGr (right Alt) is accepted too: it reports
    // ctrlKey alongside altKey. All the keys the site might own stay untouched.
    //
    // This used to stand down when the key was also bound at
    // chrome://extensions/shortcuts ("the browser will deliver it instead").
    // That made the shortcut dead whenever the browser did NOT deliver it -
    // a conflicting binding, or a context where Chrome suppresses commands -
    // and there was nothing left to fall back on. It now always acts, and the
    // duplicate delivery (if any) is dropped by the time windows below.
    const toggleKey = e.altKey && !e.metaKey &&
      (e.code === 'Backquote' || e.key === '`' || e.key === '~');
    if (toggleKey && !e.repeat) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const now = Date.now();
      if (now < keyDropUntil) {
        // An ancestor frame already handled this very keypress (the browser
        // command landed there first); acting here too would leave the two
        // frames disagreeing about whether the pane is open.
        try { console.info('[FScreen] Alt+` ignored: an ancestor frame already handled it.'); } catch (e2) { /* ignore */ }
        return;
      }
      toggle();
    }
  }, true);

  /* -------------------------------------------------------------------- *
   * Cross-world bridge (ISOLATED -> MAIN, plus parent <-> child frames)
   * -------------------------------------------------------------------- */

  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d || d[NS] !== 1) return;

    if (e.source === window) {
      if (d.type === 'state' && typeof d.enabled === 'boolean') {
        enabled = d.enabled;
        if (!enabled && active) exitPseudo();
      } else if (d.type === 'build' && typeof d.build === 'string' && d.build) {
        if (d.build !== manifestBuild) {
          manifestBuild = d.build;
          if (manifestBuild !== BUILD) {
            console.info('[FScreen] content script is ' + BUILD + ' but the manifest says ' +
              manifestBuild + ' - reload the extension and refresh this tab.');
          }
          updateButtonStatus();
        }
      } else if (d.type === 'hotkey' && (d.mode === 'page' || d.mode === 'browser')) {
        hotkeyMode = d.mode;
      } else if (d.type === 'command') {
        if (d.cmd === 'toggle') {
          const now = Date.now();
          const win = commandDedupeMs();
          if (now - lastToggleAt <= win || now - lastChildSignalAt <= win) {
            // One physical key, two deliveries: this frame (or an embed, which
            // owns the player) already acted on it. Acting again would close
            // the pane the user just opened.
            try { console.info('[FScreen] command ignored: that keypress was already handled.'); } catch (e2) { /* ignore */ }
            return;
          }
          toggle();
          // Tell the embeds it was handled up here, so a keydown that arrives
          // a few ms later in a focused embed does not toggle a second time.
          broadcastDown({ __fscreen: 1, type: 'command-drop' });
        } else if (d.cmd === 'exit' && active) exitPseudo();
      }
      return;
    }

    if (d.type === 'command-drop' && e.source === window.parent && window.parent !== window) {
      // An ancestor handled the key (its browser command fired first).
      keyDropUntil = Date.now() + KEY_DROP_MS;
      broadcastDown(d);              // relay to the embeds below us
      return;
    }

    if (d.type === 'command' && e.source && e.source !== window) {
      // From our parent: stand down. From an embed: that frame had no player
      // of its own and handed the key up to us.
      if (d.cmd === 'exit' && active) exitPseudo();
      else if (d.cmd === 'toggle') toggle();
      return;
    }

    if (d.type === 'child-expand') {
      lastChildSignalAt = Date.now();
      onChildExpand(e.source);
    } else if (d.type === 'child-collapse') {
      lastChildSignalAt = Date.now();
      onChildCollapse(e.source);
    }
  }, true);

  /* -------------------------------------------------------------------- *
   * MutationObserver: SPA players re-render, replace the player, and even
   * re-patch our prototype methods behind our back.
   * -------------------------------------------------------------------- */

  let pendingHousekeep = false;
  let targetObserver = null;

  function housekeep() {
    pendingHousekeep = false;

    const now = Date.now();
    if (now - lastPatchCheck > 250) {
      lastPatchCheck = now;
      if (!overridesIntact()) installOverrides();
    }

    if (!active) {
      if (document.getElementById(BTN_ID)) removeButton();
      return;
    }

    if (!active.target.isConnected) {
      // The site swapped the player out from under us (SPA re-render, episode
      // change, ad overlay taking its place). Dropping the pane here is what
      // looks like "the shortcut stopped working": the user presses again, it
      // opens, the next render kills it. Restore the old tree - restoring
      // styles on a detached node is a no-op, the ancestors are still live -
      // and re-arm on whatever replaced it.
      const wanted = active.requestedBy;
      const fromChild = active.fromChild;
      exitPseudo();
      if (!fromChild) {
        let replacement = null;
        try { replacement = resolveTarget(null); } catch (e) { replacement = null; }
        if (replacement) enterPseudo(replacement, null, wanted);
      }
      return;
    }

    // A site resize handler that writes el.style.height drops the !important
    // declaration we set, and only checking position would leave the pane
    // half-height with the rest of the page showing underneath it. Re-assert
    // the sizing props - with a cooldown, so a site that rewrites the style
    // every frame cannot turn this into a write loop. The neutralised ancestor
    // props are checked in the same pass: a site that puts a wrapper's
    // `z-index: 3` back would drop the pane into its stacking context again and
    // bring the header straight back on top of it.
    const stamp = Date.now();
    if (stamp - lastStyleApply > 100) {
      let drifted = false;
      try {
        const st = active.target.style;
        drifted = st.getPropertyValue('position') !== TARGET_STYLE.position ||
                  st.getPropertyValue('width') !== TARGET_STYLE.width ||
                  st.getPropertyValue('height') !== TARGET_STYLE.height;
      } catch (e) { drifted = true; }

      let ancestorDrift = false;
      try {
        const list = active.ancestors || [];
        for (let i = 0; !ancestorDrift && i < list.length; i++) {
          const touched = list[i][1] || [];
          for (let j = 0; j < touched.length; j++) {
            if (list[i][0].style.getPropertyValue(touched[j][0]) !== touched[j][3]) {
              ancestorDrift = true;
              break;
            }
          }
        }
      } catch (e) { ancestorDrift = false; }

      if (drifted || ancestorDrift) {
        lastStyleApply = stamp;
        if (drifted) applyProps(active.target, TARGET_STYLE);
        if (ancestorDrift) {
          try {
            const list = active.ancestors || [];
            for (let i = 0; i < list.length; i++) {
              const el = list[i][0];
              const touched = list[i][1] || [];
              for (let j = 0; j < touched.length; j++) {
                if (el.style.getPropertyValue(touched[j][0]) !== touched[j][3]) {
                  el.style.setProperty(touched[j][0], touched[j][3], 'important');
                }
              }
            }
          } catch (e) { /* ignore */ }
        }
      }
    }

    keepButtonOnTop();
    try { updateButtonStatus(); } catch (e) { /* ignore */ }
    if (!document.getElementById(STYLE_ID)) ensureStyle();
  }

  function scheduleHousekeep() {
    if (pendingHousekeep) return;
    pendingHousekeep = true;
    // setTimeout, not rAF: rAF does not run in a background tab, and this has to
    // keep working when the user clicks away from the video.
    setTimeout(housekeep, 50);
  }

  function observeTarget() {
    stopObserveTarget();
    if (typeof MutationObserver === 'undefined' || !active) return;
    try {
      targetObserver = new MutationObserver(scheduleHousekeep);
      targetObserver.observe(active.target, { attributes: true, attributeFilter: ['style', 'class'] });
    } catch (e) { targetObserver = null; }
  }

  function stopObserveTarget() {
    if (targetObserver) { try { targetObserver.disconnect(); } catch (e) { /* ignore */ } }
    targetObserver = null;
  }

  if (typeof MutationObserver !== 'undefined') {
    const start = function () {
      const root = document.documentElement || document;
      try {
        new MutationObserver(scheduleHousekeep).observe(root, { childList: true, subtree: true });
      } catch (e) { /* ignore */ }
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  /* -------------------------------------------------------------------- *
   * Boot
   * -------------------------------------------------------------------- */

  installOverrides();
})();
