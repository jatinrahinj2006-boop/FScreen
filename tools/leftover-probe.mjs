/*
 * Which elements are painted over the pane, if any?
 *
 *   node tools/leftover-probe.mjs https://site/watch/whatever
 *
 * Loads the extension headless with remote debugging, opens the watch page,
 * presses Alt+`, then samples a 6x5 grid with elementFromPoint. Every hit is
 * reported with its selector and flagged as inside/outside the styled box:
 *   inside  -> content living inside the box we picked
 *   outside -> content painting above our z-index (top layer, fixed overlays,
 *              or - the case that shipped a bug - a stacking context around
 *              the pane that traps z-index:2147483647 below a fixed header)
 *
 * This is how the hianime.at header leak was found. Not part of the suite: it
 * needs real sites and network access.
 */
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const CHROME = process.env.PROBE_CHROME || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = process.env.TEMP + '\\opencode\\cdpleft';
const PORT = 9419;
const HOME = process.argv[2] || process.env.PROBE_URL;
if (!HOME) {
  console.error('usage: node tools/leftover-probe.mjs <watch-url>');
  process.exit(2);
}

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--mute-audio', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
  '--autoplay-policy=no-user-gesture-required', '--window-size=961,946',
  `--user-data-dir=${PROFILE}`, `--load-extension=D:\\FScreen`,
  `--remote-debugging-port=${PORT}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0; const pending = new Map(); const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) listeners.forEach((fn) => fn(m));
  };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => {
    const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => pending.set(id, res));
  };
  return { ready, send, on: (fn) => listeners.add(fn), close: () => { try { ws.close(); } catch {} } };
}

async function evalIn(t, expression) {
  const r = await t.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) };
  return r.result?.result?.value;
}

const desc = `((e) => e ? (e.tagName.toLowerCase() + (e.id ? '#'+e.id : '') +
  (typeof e.className === 'string' && e.className ? '.'+e.className.trim().split(/\\s+/).slice(0,3).join('.') : '')) : null)`;

// What is painted at each grid point while the pane is up.
const SAMPLE = `(() => {
  const desc = ${desc};
  let target = null;
  document.querySelectorAll('*').forEach((e) => {
    if (e.style && typeof e.style.getPropertyValue === 'function' &&
        e.style.getPropertyValue('position') === 'fixed' &&
        e.style.getPropertyPriority('position') === 'important' &&
        e.style.getPropertyValue('height') === '100vh') target = e;
  });
  if (!target) return { error: 'no pane element' };
  const btn = document.getElementById('fscreen-exit');
  const video = document.querySelector('video');
  const pts = [];
  for (const fx of [0.03, 0.2, 0.4, 0.6, 0.8, 0.97])
    for (const fy of [0.05, 0.25, 0.5, 0.75, 0.95])
      pts.push([Math.round(innerWidth*fx), Math.round(innerHeight*fy)]);
  const rows = [];
  for (const [x, y] of pts) {
    const el = document.elementFromPoint(x, y);
    if (!el) { rows.push({ p: x+','+y, el: '(none)' }); continue; }
    const ours = (btn && (el === btn || btn.contains(el))) || target === el || target.contains(el);
    const inVideo = !!(video && (el === video || video.contains(el) || el.contains(video)));
    rows.push({ p: x+','+y, el: desc(el), ours: !!ours, video: inVideo });
  }
  const vr = video ? video.getBoundingClientRect() : null;
  const tr = target.getBoundingClientRect();
  return {
    target: desc(target),
    targetRect: [Math.round(tr.x), Math.round(tr.y), Math.round(tr.width), Math.round(tr.height)],
    videoRect: vr ? [Math.round(vr.x), Math.round(vr.y), Math.round(vr.width), Math.round(vr.height)] : null,
    viewport: [innerWidth, innerHeight],
    hitsOutside: rows.filter((r) => !r.ours).map((r) => r.p + ' -> ' + r.el),
    hitsInside: [...new Set(rows.filter((r) => r.ours && !r.video).map((r) => r.el))],
    pointCount: rows.length
  };
})()`;

const BEFORE = `(() => {
  const desc = ${desc};
  const v = document.querySelector('video');
  return { video: desc(v), videoRect: v ? (r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])(v.getBoundingClientRect()) : null,
           viewport: [innerWidth, innerHeight] };
})()`;

let page;
const key = async (k, code, vk, mods) => {
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};

async function main() {
  let list = null;
  for (let i = 0; i < 60 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(500); } }
  const t0 = list.find((t) => t.type === 'page');
  page = attach(t0.webSocketDebuggerUrl);
  await page.ready;
  page.on((m) => { if (m.method === 'Runtime.exceptionThrown') console.log('EXC', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  await page.send('Page.enable'); await page.send('Runtime.enable');

  await page.send('Page.navigate', { url: HOME });
  await sleep(9000);
  const where = await evalIn(page, 'location.href');
  console.log('home:', where);

  if (!/\/(watch|embed|play|episode|ep-)/i.test(where)) {
    const watch = await evalIn(page, `(() => {
      const seen = new Set();
      const a = [...document.querySelectorAll('a[href]')].filter((x) => {
        const h = x.getAttribute('href') || '';
        if (/watchlist|genre|category|actor|director/i.test(h)) return false;
        if (!/\\/(watch|episode|ep|movie|tv|film|series)\\/.+/.test(h)) return false;
        if (seen.has(h)) return false; seen.add(h); return true;
      });
      return a.slice(0, 8).map((x) => x.href);
    })()`);
    console.log('watch links:', JSON.stringify(watch));
    if (Array.isArray(watch) && watch.length) {
      await page.send('Page.navigate', { url: watch[0] });
      await sleep(10000);
    }
  }
  console.log('url now:', await evalIn(page, 'location.href'));

  // Players need the video element; try a server button a couple of times.
  for (let i = 0; i < 12; i++) {
    if (await evalIn(page, '!!document.querySelector("video")')) break;
    if (i === 3 || i === 6) {
      const clicked = await evalIn(page, `(() => {
        const b = [...document.querySelectorAll('button, .btn, [class*="server"] span, li')].find((x) => /HD-1|Vidstream-1|Vidstream-2|Server 1/i.test(x.textContent || ''));
        if (b) { b.click(); return b.textContent.trim().slice(0, 20); } return null; })()`);
      if (clicked) console.log('clicked server:', clicked);
    }
    await sleep(2000);
  }
  await sleep(4000);

  console.log('before:', JSON.stringify(await evalIn(page, BEFORE)));

  await key('`', 'Backquote', 192, 1);          // Alt+`
  await sleep(3000);

  const s = await evalIn(page, SAMPLE);
  console.log('\n=== pane sample ===');
  console.log(JSON.stringify(s, null, 2));

  if (s && !s.error) {
    console.log('\nverdict:', s.hitsOutside.length ? 'CONTENT VISIBLE OUTSIDE THE PANE' : 'clean: nothing but the pane');
    if (s.hitsOutside.length) console.log(s.hitsOutside.join('\n'));
  }

  await key('`', 'Backquote', 192, 1);          // toggle off, restore
  await sleep(1000);
}

main().then(() => { try { chrome.kill(); } catch {} process.exit(0); },
  (e) => { console.error('FAIL', e); try { chrome.kill(); } catch {} process.exit(1); });
