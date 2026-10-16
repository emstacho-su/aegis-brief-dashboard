#!/usr/bin/env node
/* Browser checks for the brief-item fixes in apps/web/dashboard.html (sample mode, opened from disk).
   Skips cleanly when playwright is not installed. Exit code 1 on any failure. */
'use strict';
let pw;
try { pw = require('playwright'); } catch (e) { console.log('skipped: playwright not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'dashboard.html')).href;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } return cond; };

async function open(browser, viewport, hash) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(PAGE_URL + hash);
  await page.waitForSelector('#main :not(.skel)', { state: 'attached' });
  return { page, errors };
}

async function checkPopout(browser) {
  const { page, errors } = await open(browser, DESKTOP, '#home');
  const id = await page.evaluate(() => Object.keys(IDX.life).find(k => IDX.life[k].days.length >= 2));
  ok(!!id, 'sample data has an item seen in two or more briefs');
  await page.evaluate(h => { location.hash = h; }, '#item-' + id);
  await page.waitForSelector('#ov .panel');
  ok(await page.locator('#ov svg[aria-label="Score trajectory"]').count() === 1, 'popout shows the trajectory svg');
  const text = await page.locator('#ov .panel').innerText();
  ok(!/\b(undefined|NaN)\b/.test(text), 'popout text has no "undefined" or "NaN"');
  ok(errors.length === 0, 'no page errors while opening the popout: ' + errors.join(' | '));
  await page.close();
}

const BRIEFS_DIR = path.join(__dirname, '..', '..', '..', 'data', 'briefs');
function loadRealBriefs() { /* the exposure register (4 columns, long text) only renders for real briefs */
  const out = {};
  fs.readdirSync(BRIEFS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    .forEach(f => { out[f.slice(0, 10)] = JSON.parse(fs.readFileSync(path.join(BRIEFS_DIR, f), 'utf8')); });
  return out;
}

async function checkRailTable(browser, viewport, label) {
  const { page } = await open(browser, viewport, '#brief');
  await page.evaluate(b => { setArchive(b, { real: true, meta: {} }); location.hash = '#brief'; render(); }, loadRealBriefs());
  ok(await page.locator('.rail .tw th', { hasText: 'Unchanged' }).count() === 1, label + ': exposure register is on screen');
  const res = await page.evaluate(() => {
    const wraps = [...document.querySelectorAll('.rail .tw')];
    return wraps.map(w => {
      const cs = getComputedStyle(w), table = w.querySelector('table');
      const lastTh = table.querySelector('thead th:last-child');
      w.scrollLeft = w.scrollWidth;
      const wr = w.getBoundingClientRect(), lr = lastTh.getBoundingClientRect();
      return { cued: /gradient/.test(cs.backgroundImage), scrollable: /auto|scroll/.test(cs.overflowX), fits: w.scrollWidth <= w.clientWidth + 1, lastVisible: lr.right <= wr.right + 1 && lr.left >= wr.left - 1 };
    });
  });
  ok(res.length > 0, `${label}: rail has a table container`);
  res.forEach((r, i) => ok(r.scrollable && r.lastVisible && r.cued, `${label}: rail table ${i + 1} last column reachable (scrollable=${r.scrollable}, cue=${r.cued}, fits=${r.fits})`));
  await page.close();
}

async function checkDirectItemLoad(browser) {
  const id = await (async () => {
    const { page } = await open(browser, DESKTOP, '#home');
    const v = await page.evaluate(() => Object.keys(IDX.life)[0]);
    await page.close();
    return v;
  })();
  const { page } = await open(browser, DESKTOP, '#item-' + id);
  await page.waitForSelector('#ov .panel');
  const main = await page.locator('#main').innerText();
  ok(/Daily brief/.test(main), 'direct #item- load paints the brief beneath the overlay');
  await page.close();
}

async function openLongestPopout(browser, viewport) {
  const { page, errors } = await open(browser, viewport, '#home');
  const id = await page.evaluate(() => Object.keys(IDX.life).sort((a, b) => IDX.life[b].days.length - IDX.life[a].days.length)[0]);
  await page.evaluate(h => { location.hash = h; }, '#item-' + id);
  await page.waitForSelector('#ov .panel');
  return { page, errors, id };
}

/* hover details: the timeline tip floats fully inside the viewport (not clipped by the sideways scroller), and
   trajectory marks show the date and score on hover and on focus */
async function checkHoverDetails(browser, viewport, label) {
  const { page, errors, id } = await openLongestPopout(browser, viewport);
  const days = await page.evaluate(i => IDX.life[i].days, id);
  /* trajectory */
  const marks = page.locator('#ov .tchart .clk');
  ok(await marks.count() === days.length, `${label}: trajectory has one hover mark per observation (${await marks.count()} for ${days.length})`);
  if (await marks.count()) {
    await marks.first().hover();
    const tip = page.locator('#ov .tchart .ctip');
    const shown = await tip.isVisible();
    const tipText = shown ? await tip.innerText() : '';
    ok(shown && tipText.includes(days[0]) && /Score/.test(tipText) && /Tier/.test(tipText), `${label}: trajectory hover shows the date, tier and score (got "${tipText.replace(/\s+/g, ' ').slice(0, 60)}")`);
    await page.mouse.move(5, 5);
    await marks.nth(days.length - 1).focus();
    ok(await tip.isVisible() && (await tip.innerText()).includes(days[days.length - 1]), `${label}: trajectory mark shows its tip on keyboard focus`);
    await page.mouse.move(5, 5); await page.keyboard.press('Tab');
  }
  /* timeline */
  const ev = page.locator('#ov .tl2 .ev').first();
  await ev.scrollIntoViewIfNeeded();
  await ev.hover();
  const evDate = (await ev.getAttribute('aria-label') || '').slice(0, 10);
  const fl = page.locator('.tlfloat');
  const visible = await fl.isVisible();
  const box = visible ? await fl.boundingBox() : null;
  const metrics = visible ? await page.evaluate(() => { const f = document.querySelector('.tlfloat'); const r = f.getBoundingClientRect(); f.style.pointerEvents = 'auto'; const onTop = f.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); f.style.pointerEvents = ''; return { clipped: f.scrollHeight > f.clientHeight + 1, onTop, text: f.innerText, vw: innerWidth, vh: innerHeight }; }) : null;
  ok(visible && metrics.text.includes(evDate), `${label}: timeline hover shows a floating tip with the icon's date (${evDate})`);
  ok(visible && box.y >= 0 && box.x >= 0 && box.y + box.height <= metrics.vh && box.x + box.width <= metrics.vw && !metrics.clipped, `${label}: timeline tip is entirely inside the viewport and not clipped (box ${box && JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) })})`);
  ok(visible && metrics.onTop, `${label}: timeline tip is drawn above the popout`);
  await page.keyboard.press('Escape');
  ok(!(await fl.isVisible()), `${label}: Escape hides the timeline tip`);
  ok(errors.length === 0, `${label}: no page errors during hover checks: ${errors.join(' | ')}`);
  await page.close();
}

(async () => {
  const browser = await pw.chromium.launch();
  try {
    await checkPopout(browser);
    await checkRailTable(browser, DESKTOP, '1280');
    await checkRailTable(browser, PHONE, '390');
    await checkDirectItemLoad(browser);
    await checkHoverDetails(browser, DESKTOP, 'hover 1280');
    await checkHoverDetails(browser, PHONE, 'hover 390');
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL BROWSER CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
