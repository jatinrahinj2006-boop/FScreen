/*
 * FScreen end-to-end test.
 *
 *   node test/run-test.mjs
 *
 * Builds a throwaway copy of the extension with http://127.0.0.1 and
 * http://localhost added to the match list, serves test/www on both origins
 * (so the iframe test really is cross-origin), loads it into headless Chromium
 * and evaluates the assertions the test pages write into <pre id="results">.
 *
 * Browser: Chrome stable ignores --load-extension ("not allowed in Google
 * Chrome"), so Edge is tried first. Override with FSCREEN_BROWSER=<path>.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WWW = join(HERE, 'www');
const PORT = 8791;
const TEST_MATCHES = ['http://127.0.0.1/*', 'http://localhost/*'];

const BROWSER_CANDIDATES = [
  `${process.env['ProgramFiles']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['LOCALAPPDATA']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`
];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// What the files on disk say. Case F reports the version the *loaded*
// extension is running, so a stale build (edited files, extension never
// reloaded) fails loudly instead of silently asserting the wrong behaviour.
const SOURCE_VERSION = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;

function findChrome() {
  if (process.env.FSCREEN_BROWSER) return process.env.FSCREEN_BROWSER;
  const hit = BROWSER_CANDIDATES.filter(Boolean).find((p) => {
    try { readFileSync(p); return true; } catch { return false; }
  });
  if (!hit) throw new Error('No Chromium browser found - set FSCREEN_BROWSER to one that accepts --load-extension.');
  return hit;
}

function buildExtension(dir) {
  mkdirSync(dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push(...TEST_MATCHES);
  for (const cs of manifest.content_scripts) cs.matches.push(...TEST_MATCHES);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'icons'), join(dir, 'icons'), { recursive: true });
}

function startServers() {
  const handler = (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    // Real-time delay endpoint: --virtual-time-budget fast-forwards page timers,
    // but a cross-origin frame lives in its own process and talks to us in real
    // time. Waiting on a fetch gives that traffic an actual window to land.
    if (url.startsWith('/realwait')) {
      const ms = Math.min(2000, Math.max(0, parseInt(new URL(req.url, 'http://x').searchParams.get('ms'), 10) || 0));
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); }, ms);
      return;
    }
    const file = join(WWW, url.replace(/^\/+/, '') || 'index.html');
    try {
      const body = readFileSync(file);
      const type = TYPES[extname(file)] || 'text/html';
      // c.html runs under the same Trusted Types policy youtube.com sends,
      // which is what broke the innerHTML-built exit button.
      const headers = { 'Content-Type': type };
      if (/\/c\.html$/.test(url)) {
        headers['Content-Security-Policy'] = "require-trusted-types-for 'script'";
      }
      // Real-time delay: gives --load-extension time to finish registering the
      // content scripts before the document starts parsing.
      const delay = extname(file) === '.html' ? 1200 : 0;
      setTimeout(() => {
        res.writeHead(200, headers);
        res.end(body);
      }, delay);
    } catch (e) {
      res.writeHead(404);
      res.end('not found');
    }
  };
  const servers = [createServer(handler), createServer(handler)];
  return Promise.all([
    new Promise((r) => servers[0].listen(PORT, '127.0.0.1', r)),
    new Promise((r) => servers[1].listen(PORT, '::1', r))
  ]).then(() => servers);
}

function runChrome(chrome, profile, url, timeoutMs) {
  return new Promise((resolvePromise) => {
    const args = [
      '--headless',
      '--disable-gpu',
      '--mute-audio',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--enable-logging=stderr',
      `--user-data-dir=${profile}`,
      `--load-extension=${EXT_DIR}`,
      '--virtual-time-budget=30000',
      '--dump-dom',
      url
    ];

    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolvePromise({ out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ out, err: String(e) }); });
  });
}

const unescapeHtml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&');

function extractResults(dom) {
  const m = dom.match(/<pre id="results"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  const text = unescapeHtml(m[1]).trim();
  if (!text.startsWith('{')) return { __raw: text };
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.checks && typeof parsed.checks === 'object') {
      parsed.checks.__msgs = parsed.msgs;      // cross-origin frame test envelope
      return parsed.checks;
    }
    return parsed;
  } catch { return { __raw: text }; }
}

let EXT_DIR = '';

async function main() {
  const stamp = Date.now();
  EXT_DIR = join(tmpdir(), `fscreen-ext-${stamp}`);
  const profile = join(tmpdir(), `fscreen-profile-${stamp}`);
  mkdirSync(EXT_DIR, { recursive: true });
  buildExtension(EXT_DIR);

  const chrome = findChrome();
  const servers = await startServers();
  console.log(`extension : ${EXT_DIR}`);
  console.log(`chrome    : ${chrome}`);
  console.log(`server    : http://127.0.0.1:${PORT} + http://localhost:${PORT} (cross-origin)\n`);

  const cases = [
    ['A  single frame (override ordering, CSS, Esc, hotkey, MO)', `http://127.0.0.1:${PORT}/a.html`],
    ['B  cross-origin iframe (child -> parent expansion)', `http://127.0.0.1:${PORT}/frame.html`],
    ['C  Trusted Types page + fullscreenElement identity', `http://127.0.0.1:${PORT}/c.html`],
    ['D  interception off by default, hotkey still live', `http://127.0.0.1:${PORT}/d.html`],
    ['E  pane stops at the player box, page sections stay out', `http://127.0.0.1:${PORT}/e.html`],
    ['F  no dead keys: player-less frame, duplicate command, replaced player', `http://127.0.0.1:${PORT}/f.html`],
    ['G  pane escapes the site stacking context (z-index wrapper + fixed header)', `http://127.0.0.1:${PORT}/g.html`],
    ['H  gesture-less fullscreen request: page sees it, window does not', `http://127.0.0.1:${PORT}/h.html`]
  ];

  let failures = 0;
  const profiles = [];

  for (const [label, url] of cases) {
    console.log('='.repeat(74));
    console.log(label);
    console.log('='.repeat(74));

    const profileDir = `${profile}-${profiles.length}`;
    profiles.push(profileDir);
    const { out, err } = await runChrome(chrome, profileDir, url, 60000);
    const results = extractResults(out);

    if (err && err.trim()) {
      if (/--load-extension is not allowed/.test(err)) {
        console.log('   !! This browser ignores --load-extension. Set FSCREEN_BROWSER to a');
        console.log('      build that accepts it (Edge and Chrome Canary/Dev normally do).');
        failures++;
      }
      const interesting = err.split('\n')
        .filter((l) => /extension|manifest|invalid|error|warning|permission/i.test(l))
        .slice(0, 20);
      console.log(`   [chrome stderr${interesting.length ? '' : ' (no extension-related lines)'}]`);
      for (const l of (interesting.length ? interesting : err.split('\n').slice(0, 8))) {
        console.log('     ' + l.trim().slice(0, 220));
      }
    }

    if (!results) {
      failures++;
      console.log('!! No results block in the dumped DOM - the page never finished.');
      const boot = err.split('\n').filter((l) => /extension|manifest|error|invalid/i.test(l)).slice(0, 12);
      if (boot.length) console.log('   stderr hints:\n   ' + boot.join('\n   '));
      console.log('   tail of stdout: ' + out.slice(-300).replace(/\s+/g, ' '));
      console.log('');
      continue;
    }
    if (results.__raw) {
      failures++;
      console.log('!! Results were not valid JSON:\n' + results.__raw);
      console.log('');
      continue;
    }

    // The page reports the version its extension is actually running (read
    // from the loaded manifest). Compare it with the files we just built.
    if (results.extension_build) {
      const running = results.extension_build.detail;
      results.extension_build = {
        pass: running === SOURCE_VERSION,
        detail: `running ${running}, files say ${SOURCE_VERSION}`
      };
    }

    let total = 0;
    let passed = 0;
    for (const [name, r] of Object.entries(results)) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.pass !== 'boolean') {
        console.log(`  info  ${name} -> ${JSON.stringify(r)}`);
        continue;
      }
      total++;
      if (r.pass) passed++;
      else failures++;
      console.log(`${r.pass ? '  PASS' : '* FAIL'}  ${name}${r.detail != null ? '   -> ' + JSON.stringify(r.detail) : ''}`);
    }
    console.log(`  ${passed}/${total} assertions\n`);
  }

  for (const s of servers) s.close();
  for (const p of profiles) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
  try { rmSync(EXT_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}

  console.log('='.repeat(74));
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
