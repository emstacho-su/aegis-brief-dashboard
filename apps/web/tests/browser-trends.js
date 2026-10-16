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

async function open(browser, hash, width = 1280, ready = '.chart .clk') {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(PAGE_URL + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(ready, { timeout: 10000 });
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

async function chartsReadableAtPhone(browser) {
  for (const id of ['byarea', 't1cal', 'newres']) {
    const { page } = await open(browser, '#trends-' + id, 390);
    const r = await page.evaluate(() => {
      const svg = document.querySelector('.chart svg'), wrap = document.querySelector('.cscroll'), cue = document.querySelector('.scrollcue');
      const vb = svg.viewBox.baseVal.width;
      return { fontPx: 10 * svg.getBoundingClientRect().width / vb, wrapScrolls: wrap.scrollWidth > wrap.clientWidth + 1, pageFits: document.documentElement.scrollWidth <= window.innerWidth, cue: cue && getComputedStyle(cue).display !== 'none' };
    });
    check(r.fontPx >= 9.9, `${id} at 390px: chart text renders at ${r.fontPx.toFixed(1)}px (>= 10)`);
    check(r.wrapScrolls && r.pageFits, `${id} at 390px: the chart wrapper scrolls (${r.wrapScrolls}) and the page does not (fits ${r.pageFits})`);
    check(r.cue, `${id} at 390px: a scroll cue is visible`);
    await page.close();
  }
  const { page } = await open(browser, '#trends-byarea', 1280);
  const wide = await page.evaluate(() => { const svg = document.querySelector('.chart svg'); return { fontPx: 10 * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width, cue: getComputedStyle(document.querySelector('.scrollcue')).display }; });
  check(wide.cue === 'none', 'no scroll cue on desktop');
  await page.close();
}
async function cveTableOnPhone(browser) {
  const { page } = await open(browser, '#trends-cve', 390, '.chart table tbody tr');
  const r = await page.evaluate(() => {
    const hidden = [...document.querySelectorAll('.chart th.hm')].map(th => getComputedStyle(th).display);
    const row = document.querySelector('.chart tbody tr'), id = row.querySelector('td.nw'), title = row.querySelector('td.cvet'), tw = document.querySelector('.chart .tw');
    const lineH = parseFloat(getComputedStyle(id).lineHeight) || 20;
    return { hidden, idH: id.getBoundingClientRect().height, titleH: title.getBoundingClientRect().height, lineH, rowH: row.getBoundingClientRect().height, tableScrolls: tw.scrollWidth > tw.clientWidth + 1, shown: [...document.querySelectorAll('.chart th')].filter(th => getComputedStyle(th).display !== 'none').map(th => th.textContent) };
  });
  check(r.hidden.length >= 3 && r.hidden.every(d => d === 'none'), 'cve: lower-value columns are hidden at 390px (' + r.shown.join(', ') + ' stay)');
  check(r.idH < r.lineH * 2 && r.titleH < r.lineH * 2, `cve: id and title stay on one line (id ${r.idH.toFixed(0)}px, title ${r.titleH.toFixed(0)}px, line ${r.lineH}px)`);
  check(!r.tableScrolls, 'cve: the table fits the phone width without sideways scrolling');
  await page.close();
}
/* the sample archive has a brief every day and always has actions; drop two briefs and empty one day's actions so the gap paths run */
const makeGapsInArchive = page => page.evaluate(() => {
  const b = Object.assign({}, BRIEFS);
  delete b[DATES[DATES.length - 6]]; delete b[DATES[DATES.length - 7]]; delete b[DATES[DATES.length - 12]];
  setArchive(b, { real: false, meta: META });
  BRIEFS[DATES[DATES.length - 3]].outstanding = [];
  render();
});
async function t1calGapAndTooltips(browser) {
  const { page } = await open(browser, '#trends-t1cal');
  await makeGapsInArchive(page);
  const gap = await page.evaluate(() => { const g = [...document.querySelectorAll('.chart g.gap')]; return g.map(x => { const b = x.querySelector('rect').getBoundingClientRect(); return { w: b.width, h: b.height, title: x.querySelector('title').textContent }; }); });
  check(gap.length >= 1 && gap.every(g => g.w > 3 && g.h > 20), 't1cal: gap markers are visible (' + gap.map(g => g.title + ' ' + g.w.toFixed(0) + 'px').join('; ') + ')');
  await page.locator('.chart .clk[data-day]').nth(5).hover();
  let tip = await page.evaluate(() => { const t = document.querySelector('.chart .ctip'); return { shown: getComputedStyle(t).display !== 'none', text: t.textContent.replace(/\s+/g, ' ') }; });
  check(tip.shown && /Tier 1/.test(tip.text) && /Escalation/.test(tip.text), 't1cal cell shows the tooltip: ' + tip.text);
  await page.close();
  const m = await open(browser, '#trends-movers');
  await m.page.locator('.chart .clk[data-key]').nth(2).hover();
  tip = await m.page.evaluate(() => { const t = document.querySelector('.chart .ctip'); return { shown: getComputedStyle(t).display !== 'none', text: t.textContent.replace(/\s+/g, ' ') }; });
  check(tip.shown && /Then/.test(tip.text) && /Now/.test(tip.text), 'movers row shows the tooltip: ' + tip.text);
  await m.page.close();
}
async function avgageGapAndShowAll(browser) {
  const { page } = await open(browser, '#trends-avgage');
  await makeGapsInArchive(page);
  check(await page.locator('.chart .gap-pt').count() >= 1, 'avgage: the missing exposure day has a hollow marker');
  await page.close();
  const b = await open(browser, '#trends-byarea');
  /* a selection of more than 40 items: make every area match plenty by selecting the busiest bar of a long period */
  const total = await b.page.evaluate(() => { const k = Object.keys(AREAS).map(a => [a, Object.values(IDX.life).filter(x => x.areas.includes(a)).length]).sort((p, q) => q[1] - p[1])[0]; state.sel = k[0]; state.selAll = null; render(); return k[1]; });
  const capped = await b.page.locator('article.item').count();
  check(total > 40 ? capped === 40 && await b.page.locator('[data-selall]').count() === 1 : capped === total, `selection of ${total} shows ${capped} cards`);
  if (total > 40) {
    await b.page.locator('[data-selall]').click();
    await b.page.waitForSelector('[data-selall]', { state: 'detached', timeout: 3000 }).catch(() => {});
    const all = await b.page.locator('article.item').count();
    check(all === total, `Show all expands to ${all} of ${total} cards`);
  }
  await b.page.close();
}

(async () => {
  const browser = await pw.chromium.launch({ headless: true });
  try {
    for (const t of [keyboardActivation, doubleClickOpensArea, singleClickStillSelects, selectedTextUnstroked, byareaLabelsDoNotOverlap, lastQuietTooltipInsideChart, chartsReadableAtPhone, cveTableOnPhone, t1calGapAndTooltips, avgageGapAndShowAll]) {
      console.log(t.name);
      try { await t(browser); } catch (e) { check(false, t.name + ' threw: ' + e.message); }
    }
  } finally { await browser.close(); }
  console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL BROWSER CHECKS PASSED');
  process.exit(failures.length ? 1 : 0);
})();
