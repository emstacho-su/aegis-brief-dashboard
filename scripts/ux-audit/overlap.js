#!/usr/bin/env node
'use strict';
/* overlap.js: find text that collides with other text on the dashboard.
   For every rendered text node it takes the glyph boxes (Range.getClientRects), clips them to any overflow-hiding
   ancestor, groups them by layer (popout, menu, search list, feedback panel, tooltip, or the page) and reports every
   pair from different text nodes on the same layer whose boxes intersect by more than MIN_PX in both directions.
   Rotated SVG text is reported separately because axis-aligned boxes overlap when the glyphs do not.

   CLI:  node overlap.js --base http://127.0.0.1:8080 [--states STATES.json] [--viewports 1280x800,390x844]
                         [--out results/overlap.json] [--shots shots/overlap] [--max-shots 3]
   STATES.json: [{"name":"home","steps":[{"op":"goto","url":"#home"}]}, ...]; steps: goto(url), click(sel), type(sel,text),
   press(key), hover(sel), eval(js), wait(ms). Default states: home, brief, trends, archive.
   Module: const { scan, DETECTOR } = require('./overlap.js'); DETECTOR is the in-page function source for tests. */
const fs = require('fs'), path = require('path');

const MIN_PX = 2;

/* Runs inside the page. Returns { textCount, collisions: [{a, b, w, h, rotated}] }. */
function detectTextCollisions(minPx) {
  const LAYERS = '.ctip, .tlfloat, #ov, #umenu, #sres, #fbroot, .fbpanel';
  const ov = document.getElementById('ov');
  const ovOpen = !!(ov && ov.innerHTML.trim());
  const descr = el => { const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''; return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''); };
  const pathOf = el => { const parts = []; for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) parts.unshift(descr(e)); return parts.join(' > '); };
  const clippedAway = cs => /^rect\(0px,? 0px,? 0px,? 0px\)$/.test(cs.clip || '') || /^inset\((50|100)%\)/.test(cs.clipPath || '');
  const visible = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || clippedAway(cs) || (e.classList && e.classList.contains('sr-only'))) return false; } return true; };
  const rotated = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const t = getComputedStyle(e).transform; if (t && t !== 'none') { const m = /matrix\(([^)]+)\)/.exec(t); if (m) { const p = m[1].split(',').map(Number); if (Math.abs(p[1]) > 0.01 || Math.abs(p[2]) > 0.01) return true; } } if (e.getAttribute && /rotate\(/.test(e.getAttribute('transform') || '')) return true; } return false; };
  const clipTo = (r, el) => { let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); const ox = cs.overflowX, oy = cs.overflowY;
      if (ox !== 'visible' || oy !== 'visible') { const b = e.getBoundingClientRect(); if (ox !== 'visible') { x1 = Math.max(x1, b.left); x2 = Math.min(x2, b.right); } if (oy !== 'visible') { y1 = Math.max(y1, b.top); y2 = Math.min(y2, b.bottom); } } }
    return x2 - x1 > 0.5 && y2 - y1 > 0.5 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null; };
  const layerOf = el => { const l = el.closest(LAYERS); if (!l) return 'page'; return l.id ? '#' + l.id : '.' + String(l.className).split(/\s+/)[0]; };
  const rects = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n, id = 0;
  while ((n = walker.nextNode())) {
    const text = n.nodeValue; if (!text || !text.trim()) continue;
    const el = n.parentElement; if (!el || el.closest('script, style, template, title, noscript')) continue;
    if (!visible(el)) continue;
    const layer = layerOf(el); if (ovOpen && layer === 'page') continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const boxes = Array.from(range.getClientRects()).filter(b => b.width > 0 && b.height > 0);
    if (!boxes.length) continue;
    const rot = rotated(el), p = pathOf(el), t = text.trim().replace(/\s+/g, ' ').slice(0, 60); id++;
    for (const b of boxes) { const c = clipTo(b, el); if (c) rects.push({ id, text: t, path: p, layer, rot, x: c.x + scrollX, y: c.y + scrollY, w: c.w, h: c.h }); }
  }
  rects.sort((a, b) => a.x - b.x);
  const out = [];
  for (let i = 0; i < rects.length; i++) { const a = rects[i];
    for (let j = i + 1; j < rects.length; j++) { const b = rects[j];
      if (b.x >= a.x + a.w - minPx) break;
      if (a.id === b.id || a.layer !== b.layer) continue;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > minPx && h > minPx) out.push({ a: { text: a.text, path: a.path, x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h) }, b: { text: b.text, path: b.path, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }, layer: a.layer, w: Math.round(w), h: Math.round(h), rotated: a.rot || b.rot });
    } }
  return { textCount: rects.length, collisions: out };
}
const DETECTOR = detectTextCollisions.toString();

async function settle(page) {
  try { await page.waitForFunction(() => (typeof BOOTED !== 'undefined' && BOOTED === true) || !!document.querySelector('.banner-err, #signinSubmit, #codeSubmit, #pwSubmit'), null, { timeout: 15000 }); } catch (e) { /* measured as is */ }
  try { await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'), null, { timeout: 4000 }); } catch (e) { /* animations may loop */ }
  await page.waitForTimeout(300);
}
async function runSteps(page, base, steps) {
  for (const s of steps || []) {
    if (s.op === 'goto') { const u = /^https?:/.test(s.url) ? s.url : base + '/' + s.url.replace(/^\//, ''); await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 }); await settle(page); }
    else if (s.op === 'click') { await page.locator(s.sel).first().click({ timeout: 8000 }); await page.waitForTimeout(250); }
    else if (s.op === 'type') { await page.locator(s.sel).first().pressSequentially(String(s.text), { delay: 15, timeout: 8000 }); await page.waitForTimeout(250); }
    else if (s.op === 'press') { if (s.sel) await page.locator(s.sel).first().focus(); await page.keyboard.press(s.key); await page.waitForTimeout(250); }
    else if (s.op === 'hover') { await page.locator(s.sel).first().hover({ timeout: 8000 }); await page.waitForTimeout(250); }
    else if (s.op === 'eval') { await page.evaluate(s.js); await page.waitForTimeout(250); }
    else if (s.op === 'wait') { await page.waitForTimeout(s.ms || 250); }
    else throw new Error('unknown step op ' + s.op);
  }
  await settle(page);
}

/* scan(base, states, opts) -> { results: [{state, viewport, textCount, collisions, error?}], total, rotated } */
async function scan(base, states, opts = {}) {
  const { chromium } = require('playwright');
  const viewports = opts.viewports || ['1280x800', '390x844'];
  const shots = opts.shots || null, maxShots = opts.maxShots == null ? 3 : opts.maxShots;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch(); const results = [];
  for (const vp of viewports) {
    const [w, h] = vp.split('x').map(Number);
    for (const st of states) {
      const page = await browser.newPage({ viewport: { width: w, height: h } }); const rec = { state: st.name, viewport: vp };
      try {
        await runSteps(page, base, st.steps);
        const r = await page.evaluate(`(${DETECTOR})(${MIN_PX})`);
        rec.textCount = r.textCount; rec.collisions = r.collisions;
        if (shots) for (let i = 0; i < Math.min(maxShots, r.collisions.length); i++) { const c = r.collisions[i];
          const x = Math.max(0, Math.min(c.a.x, c.b.x) - 40), y = Math.max(0, Math.min(c.a.y, c.b.y) - 40), cw = Math.max(c.a.x + c.a.w, c.b.x + c.b.w) - x + 40, ch = Math.max(c.a.y + c.a.h, c.b.y + c.b.h) - y + 40;
          const file = path.join(shots, `${st.name}-${vp}-${i}.png`.replace(/[^\w.-]+/g, '_'));
          try { await page.screenshot({ path: file, fullPage: true, clip: { x, y, width: Math.min(cw, 1200), height: Math.min(ch, 900) } }); c.shot = file; } catch (e) { c.shotError = e.message.split('\n')[0]; } }
      } catch (e) { rec.error = String(e && e.message || e).split('\n')[0]; }
      results.push(rec); await page.close();
      if (opts.onState) opts.onState(rec);
    }
  }
  await browser.close();
  const all = results.flatMap(r => r.collisions || []);
  return { results, total: all.filter(c => !c.rotated).length, rotated: all.filter(c => c.rotated).length };
}

function cli() {
  const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const base = opt('base', 'http://127.0.0.1:8080');
  const states = opt('states') ? JSON.parse(fs.readFileSync(opt('states'), 'utf8')) : ['home', 'brief', 'trends', 'archive'].map(n => ({ name: n, steps: [{ op: 'goto', url: '#' + n }] }));
  const viewports = opt('viewports', '1280x800,390x844').split(',');
  scan(base, states, { viewports, shots: opt('shots', path.join(__dirname, 'shots', 'overlap')), maxShots: Number(opt('max-shots', 3)),
    onState: r => console.log(`${r.state.padEnd(28)} ${r.viewport.padEnd(10)} ${r.error ? 'ERROR ' + r.error : (r.collisions.length + ' collision(s), ' + r.textCount + ' text boxes')}`) })
    .then(res => { const out = opt('out', path.join(__dirname, 'results', 'overlap.json')); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 1));
      console.log(`\n${res.total} text collision(s), ${res.rotated} rotated-label overlap(s) to verify by eye -> ${out}`); process.exit(res.total ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(2); });
}
module.exports = { scan, DETECTOR, MIN_PX, settle };
if (require.main === module) cli();
