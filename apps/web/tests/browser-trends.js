#!/usr/bin/env node
/* Browser regression checks for the Trends reports in apps/web/dashboard.html (sample mode, opened from disk).
   Skips quietly when playwright is not installed. Usage: NODE_PATH=<dir with playwright> node apps/web/tests/browser-trends.js */
'use strict';
let pw;
try { pw = require('playwright'); } catch (e) { console.log('skipped: playwright not installed'); process.exit(0); }
const path = require('path'), { pathToFileURL } = require('url');
const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'dashboard.html')).href;
const failures = [];
const check = (cond, msg) => { if (!cond) { failures.push(msg); console.log('  FAIL ' + msg); } else console.log('  ok   ' + msg); };

async function open(browser, hash, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(PAGE_URL + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart .clk', { timeout: 10000 });
  return { page, errors };
}
const boxesIntersect = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function keyboardActivation(browser) {
  const { page, errors } = await open(browser, '#trends-byarea');
  await page.focus('.chart .clk');
  await page.keyboard.press('Enter');
  check(await page.locator('.selbar').count() > 0, 'Enter on a focused byarea mark selects it (.selbar shown)');
  check(errors.length === 0, 'no page error on keyboard activation: ' + errors.join(' | '));
  await page.close();
}
async function doubleClickOpensArea(browser) {
  const { page, errors } = await open(browser, '#trends-byarea');
  await page.locator('.chart .clk[data-key]').nth(1).dblclick();
  await page.waitForFunction(() => location.hash.startsWith('#area-'), null, { timeout: 3000 }).catch(() => {});
  check(await page.evaluate(() => location.hash.startsWith('#area-')), 'double click on an area mark opens #area-');
  check(errors.length === 0, 'no page error on double click: ' + errors.join(' | '));
  await page.close();
}
async function singleClickStillSelects(browser) {
  const { page } = await open(browser, '#trends-byarea');
  await page.locator('.chart .clk[data-key]').nth(1).click();
  await page.waitForSelector('.selbar', { timeout: 3000 }).catch(() => {});
  check(await page.evaluate(() => location.hash === '#trends-byarea') && await page.locator('.selbar').count() > 0, 'single click selects without navigating');
  await page.close();
}
async function selectedTextUnstroked(browser) {
  for (const id of ['movers', 'byarea', 'quiet', 'restime']) {
    const { page } = await open(browser, '#trends-' + id);
    await page.locator('.chart .clk').nth(1).click();
    await page.waitForSelector('.chart .clk.sel', { timeout: 3000 }).catch(() => {});
    const strokes = await page.evaluate(() => [...document.querySelectorAll('.chart .sel text')].map(t => getComputedStyle(t).stroke));
    check(strokes.length > 0 && strokes.every(s => s === 'none'), `${id}: selected row text is unstroked (${strokes.length} labels)`);
    const shapeStroke = await page.evaluate(() => { const s = document.querySelector('.chart .sel rect.bar, .chart .sel circle, .chart .sel rect'); return s ? getComputedStyle(s).stroke : 'none'; });
    check(shapeStroke !== 'none', `${id}: selected shape still carries the highlight stroke`);
    await page.close();
  }
}
async function byareaLabelsDoNotOverlap(browser) {
  for (const width of [1280, 900, 390]) {
    const { page } = await open(browser, '#trends-byarea', width);
    const boxes = await page.evaluate(() => [...document.querySelectorAll('.chart svg .grp > text')].map(t => { const r = t.getBoundingClientRect(); return { text: t.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
    let clash = null;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxesIntersect(boxes[i], boxes[j])) clash = clash || `${boxes[i].text} / ${boxes[j].text}`;
    check(boxes.length >= 9 && !clash, `byarea labels at ${width}px: ${boxes.length} labels, overlap ${clash || 'none'}`);
    await page.close();
  }
}
async function lastQuietTooltipInsideChart(browser) {
  const { page } = await open(browser, '#trends-quiet');
  await page.locator('.chart .clk').last().hover();
  const r = await page.evaluate(() => { const tip = document.querySelector('.chart .ctip'), ch = document.querySelector('.chart'); const a = tip.getBoundingClientRect(), b = ch.getBoundingClientRect(); return { shown: getComputedStyle(tip).display !== 'none', top: a.top - b.top, bottom: b.bottom - a.bottom, text: tip.textContent }; });
  check(r.shown && r.top >= -1 && r.bottom >= -1, `last quiet tooltip stays inside the chart (top gap ${r.top.toFixed(0)}, bottom gap ${r.bottom.toFixed(0)})`);
  check(/days since Tier 1/.test(r.text), 'quiet tooltip names its unit: ' + r.text.replace(/\s+/g, ' '));
  await page.close();
}

(async () => {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    for (const t of [keyboardActivation, doubleClickOpensArea, singleClickStillSelects, selectedTextUnstroked, byareaLabelsDoNotOverlap, lastQuietTooltipInsideChart]) {
      console.log(t.name);
      try { await t(browser); } catch (e) { check(false, t.name + ' threw: ' + e.message); }
    }
  } finally { await browser.close(); }
  console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL BROWSER CHECKS PASSED');
  process.exit(failures.length ? 1 : 0);
})();
