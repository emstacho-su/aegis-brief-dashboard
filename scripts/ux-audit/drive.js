#!/usr/bin/env node
'use strict';
/* drive.js: run a JSON list of browser steps against a running dashboard, write screenshots and a result JSON.
   Part of the UX audit kit (see README.md in this directory). Needs Playwright: npm install here first.
   Usage:
     node drive.js STEPS.json [--out RESULT.json] [--base http://127.0.0.1:8081] [--viewport 1280x800]
                   [--theme dark|light] [--profile NAME] [--shots DIR] [--timeout 8000] [--continue] [--headed]
   STEPS.json is either an array of steps or {"base":..,"viewport":..,"theme":..,"profile":..,"steps":[..]}.
   Exit code 0 when every step passed, 1 otherwise. See KIT.md for the step reference. */
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const argv = process.argv.slice(2);
const BOOL = new Set(['continue', 'headed', 'help']);
const opts = { steps: null, out: null, base: 'http://127.0.0.1:8081', viewport: '1280x800', theme: 'dark', profile: null,
  shots: path.join(HERE, 'shots'), timeout: 8000, continue: false, headed: false, help: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { if (!opts.steps) opts.steps = a; continue; }
  const k = a.slice(2);
  if (BOOL.has(k)) { opts[k] = true; continue; }
  opts[k] = argv[++i];
}
if (opts.help || !opts.steps) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].slice(2)); process.exit(opts.help ? 0 : 2); }

function loadSteps() {
  const raw = opts.steps === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(opts.steps, 'utf8');
  let j; try { j = JSON.parse(raw); } catch (e) { console.error('steps file is not valid JSON: ' + e.message); process.exit(2); }
  if (Array.isArray(j)) return j;
  for (const k of ['base', 'viewport', 'theme', 'profile', 'shots', 'timeout']) if (j[k] !== undefined && argv.indexOf('--' + k) < 0) opts[k] = j[k];
  if (!Array.isArray(j.steps)) { console.error('steps file needs an array or {steps:[...]}'); process.exit(2); }
  return j.steps;
}
function absUrl(u) {
  if (/^https?:\/\//.test(u)) return u;
  if (u.startsWith('#')) return opts.base + '/' + u;
  return opts.base + (u.startsWith('/') ? '' : '/') + u;
}

async function main() {
  const steps = loadSteps();
  const [vw, vh] = String(opts.viewport).split('x').map(Number);
  if (!(vw > 0 && vh > 0)) { console.error('bad --viewport, want WxH'); process.exit(2); }
  fs.mkdirSync(opts.shots, { recursive: true });
  const result = { base: opts.base, profile: opts.profile, viewport: opts.viewport, theme: opts.theme, startedAt: new Date().toISOString(),
    ok: true, steps: [], console: [], pageErrors: [], failedRequests: [] };
  let browser = null, context, page, cur = -1;
  const popups = [];
  const attach = p => {
    p.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') result.console.push({ step: cur, type: t, text: m.text().slice(0, 500) }); });
    p.on('pageerror', e => result.pageErrors.push({ step: cur, message: String(e && e.message || e).slice(0, 500) }));
    p.on('requestfailed', r => result.failedRequests.push({ step: cur, url: r.url(), failure: (r.failure() || {}).errorText || 'failed' }));
    p.on('response', r => { if (r.status() >= 400) result.failedRequests.push({ step: cur, url: r.url(), status: r.status() }); });
  };
  const ctxOpts = { viewport: { width: vw, height: vh }, colorScheme: opts.theme, ignoreHTTPSErrors: true };
  if (opts.profile) {
    const dir = path.join(HERE, 'profiles', String(opts.profile)); fs.mkdirSync(dir, { recursive: true });
    context = await chromium.launchPersistentContext(dir, { headless: !opts.headed, ...ctxOpts });
  } else {
    browser = await chromium.launch({ headless: !opts.headed });
    context = await browser.newContext(ctxOpts);
  }
  context.setDefaultTimeout(Number(opts.timeout));
  page = context.pages()[0] || await context.newPage();
  attach(page);

  const pause = s => page.waitForTimeout(s.pause !== undefined ? s.pause : 150);
  async function settle(s) {
    let booted = false;
    try {
      await page.waitForFunction(() => (typeof BOOTED !== 'undefined' && BOOTED === true) ||
        !!document.querySelector('.banner-err, #signinSubmit, #codeSubmit, #pwSubmit'), null, { timeout: s.timeout || 15000 });
      booted = await page.evaluate(() => typeof BOOTED !== 'undefined' && BOOTED === true);
    } catch (e) { /* loading status still shown; the screenshot will say so */ }
    try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch (e) { /* CDN scripts may linger */ }
    await page.waitForTimeout(s.settle !== undefined ? s.settle : 250);
    return booted;
  }
  const L = (s, sel) => { let l = page.locator(sel); if (s.nth !== undefined) l = l.nth(s.nth); return l; };
  async function metrics() {
    return page.evaluate(() => ({ hash: location.hash, title: document.title, innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight,
      hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      theme: document.documentElement.getAttribute('data-theme') || 'system',
      focused: (() => { const a = document.activeElement; if (!a) return null; const cls = typeof a.className === 'string' ? a.className.trim() : ''; return a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + (cls ? '.' + cls.split(/\s+/).join('.') : ''); })() }));
  }
  async function run(s) {
    switch (s.op) {
      case 'goto': { const u = absUrl(s.url); await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 }); const booted = await settle(s); return { url: u, booted }; }
      case 'reload': { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); return { booted: await settle(s) }; }
      case 'back': { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }); return { booted: await settle(s) }; }
      case 'viewport': { await page.setViewportSize({ width: s.w, height: s.h }); await page.waitForTimeout(250); return { w: s.w, h: s.h }; }
      case 'theme': { await page.emulateMedia({ colorScheme: s.scheme }); await page.waitForTimeout(150); return s.scheme; }
      case 'click': {
        const l = L(s, s.sel), o = { force: !!s.force, button: s.button || 'left', timeout: s.timeout };
        if (s.popup) { const [pop] = await Promise.all([context.waitForEvent('page', { timeout: s.timeout || 8000 }), l.click(o)]);
          await pop.waitForLoadState('domcontentloaded'); popups.push(page); page = pop; attach(page); await page.waitForTimeout(400); return { popup: page.url() }; }
        await l.click(o); await pause(s); return;
      }
      case 'dblclick': await L(s, s.sel).dblclick({ force: !!s.force, timeout: s.timeout }); await pause(s); return;
      case 'close-popup': { if (!popups.length) throw new Error('no popup open'); const old = page; page = popups.pop(); await old.close(); return page.url(); }
      case 'fill': await L(s, s.sel).fill(String(s.value), { timeout: s.timeout }); await pause(s); return;
      case 'type': await L(s, s.sel).pressSequentially(String(s.text), { delay: s.delay || 20, timeout: s.timeout }); await pause(s); return;
      case 'press': { if (s.sel) await L(s, s.sel).focus({ timeout: s.timeout }); await page.keyboard.press(s.key); await pause(s); return; }
      case 'hover': await L(s, s.sel).hover({ force: !!s.force, timeout: s.timeout }); await pause(s); return;
      case 'focus': await L(s, s.sel).focus({ timeout: s.timeout }); return;
      case 'blur': await page.evaluate(() => document.activeElement && document.activeElement.blur()); await pause(s); return;
      case 'scroll': { if (s.sel) await L(s, s.sel).scrollIntoViewIfNeeded({ timeout: s.timeout }); else await page.evaluate(y => window.scrollTo(0, y), s.y || 0); await pause(s); return; }
      case 'drag': { const [x1, y1] = s.from, [x2, y2] = s.to; await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 10 }); await page.mouse.up(); await pause(s); return; }
      case 'mouse': { const [x, y] = s.at; if (s.action === 'move') await page.mouse.move(x, y); else if (s.action === 'click') await page.mouse.click(x, y); else if (s.action === 'down') { await page.mouse.move(x, y); await page.mouse.down(); } else if (s.action === 'up') { await page.mouse.move(x, y); await page.mouse.up(); } else throw new Error('mouse action must be move|click|down|up'); await pause(s); return; }
      case 'wait': { if (s.ms) await page.waitForTimeout(s.ms); else if (s.sel) await L(s, s.sel).waitFor({ state: s.state || 'visible', timeout: s.timeout || 8000 }); else if (s.fn) await page.waitForFunction(s.fn, null, { timeout: s.timeout || 8000 }); return; }
      case 'eval': return await page.evaluate(s.js);
      case 'text': return (await L(s, s.sel).innerText({ timeout: s.timeout })).slice(0, s.max || 4000);
      case 'html': return (await L(s, s.sel).innerHTML({ timeout: s.timeout })).slice(0, s.max || 4000);
      case 'count': return await L(s, s.sel).count();
      case 'attr': return await L(s, s.sel).getAttribute(s.name, { timeout: s.timeout });
      case 'visible': return await L(s, s.sel).isVisible();
      case 'box': return await L(s, s.sel).boundingBox();
      case 'aria': return await L(s, s.sel || 'body').ariaSnapshot({ timeout: s.timeout });
      case 'storage': return await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = String(localStorage.getItem(k)).slice(0, 2000); } return o; });
      case 'metrics': return await metrics();
      case 'shot': {
        const f = path.isAbsolute(s.file) ? s.file : path.join(opts.shots, s.file); fs.mkdirSync(path.dirname(f), { recursive: true });
        if (s.sel) await L(s, s.sel).screenshot({ path: f, timeout: s.timeout }); else await page.screenshot({ path: f, fullPage: s.full !== false });
        return { file: f, ...(await metrics()) };
      }
      default: throw new Error('unknown op: ' + s.op);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    cur = i; const s = steps[i] || {}; const t0 = Date.now(); const rec = { i, op: s.op, ok: true };
    if (s.note) rec.note = s.note;
    try { const v = await run(s); if (v !== undefined) rec.value = v; }
    catch (e) {
      rec.ok = false; rec.error = String(e && e.message || e).split('\n')[0].slice(0, 400); result.ok = false;
      try { const f = path.join(opts.shots, 'error-step' + i + '.png'); await page.screenshot({ path: f, fullPage: true }); rec.file = f; } catch (e2) { /* page may be gone */ }
    }
    rec.ms = Date.now() - t0;
    try { rec.title = await page.title(); rec.url = page.url(); } catch (e) { /* ignore */ }
    result.steps.push(rec);
    if (!rec.ok && !opts.continue) break;
  }
  result.finishedAt = new Date().toISOString();
  try { await context.close(); if (browser) await browser.close(); } catch (e) { /* ignore */ }
  const passed = result.steps.filter(x => x.ok).length;
  const summary = (result.ok ? 'OK ' : 'FAILED ') + passed + '/' + steps.length + ' steps, console errors+warnings=' + result.console.length +
    ', page errors=' + result.pageErrors.length + ', failed requests=' + result.failedRequests.length;
  if (opts.out) { fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true }); fs.writeFileSync(opts.out, JSON.stringify(result, null, 1)); console.log(summary + ' -> ' + opts.out); }
  else console.log(JSON.stringify(result, null, 1));
  process.exit(result.ok ? 0 : 1);
}
main().catch(e => { console.error('drive.js crashed: ' + (e && e.stack || e)); process.exit(1); });
