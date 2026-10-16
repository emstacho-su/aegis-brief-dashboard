#!/usr/bin/env node
/* Browser checks for the archive / search / feedback fixes. Needs playwright (skipped when absent).
   Run: NODE_PATH=<dir with playwright> node apps/web/tests/browser-archive-search-feedback.js */
'use strict';
let pw;
try { pw = require('playwright'); } catch (e) { console.log('skipped: playwright not installed'); process.exit(0); }
const path = require('path'), { pathToFileURL } = require('url');
const URL_ = pathToFileURL(path.join(__dirname, '..', 'dashboard.html')).href;
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; return cond; };

async function open(browser, width, height, hash) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', e => ok(false, 'page error: ' + e.message));
  await page.goto(URL_ + (hash || ''));
  await page.waitForSelector('#main .crumb, #main .sec-h, #main h1', { timeout: 10000 });
  return page;
}
const hidden = page => page.$eval('#sres', el => el.hidden);

async function checkFeedbackClick(browser) {
  const page = await open(browser, 1280, 800, '#archive');
  const box = await page.locator('#fbBtn').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  ok(await page.locator('.fbhint').isVisible(), 'a real mouse click on the centre of #fbBtn opens the capture hint');
  await page.locator('[data-fbskip]').click();
  ok(await page.locator('#fb1').isVisible(), 'Skip opens the form');
  const msg = await page.locator('.fbpanel .empty').innerText();
  ok(/No screenshot attached/.test(msg), 'Skip message says no screenshot attached: ' + msg);
  await page.fill('#fb1', 'browser test');
  await page.locator('[data-fbsave]').click();
  ok(await page.locator('.fbtoast').isVisible() && /Feedback saved \(1 in this browser\)/.test(await page.locator('.fbtoast').innerText()), 'the saved toast is visible with the count');
  await page.waitForTimeout(4600);
  ok(await page.locator('.fbtoast').count() === 0, 'the saved toast hides itself after about 4 s');
  await page.close();
}

async function checkSearch(browser) {
  const page = await open(browser, 390, 844, '#archive');
  await page.click('#q');
  await page.keyboard.type('cve-2026');
  ok(!(await hidden(page)), 'search dropdown opens at 390');
  const b = await page.locator('#sres').boundingBox();
  ok(b && b.x >= 0 && b.x + b.width <= 390, `search dropdown is inside the 390px viewport (x=${b && b.x}, w=${b && b.width})`);
  await page.keyboard.press('ArrowDown');
  const active = await page.$eval('#q', q => q.getAttribute('aria-activedescendant'));
  ok(!!active && await page.locator('#' + active + '[role="option"]').count() === 1, 'ArrowDown sets aria-activedescendant to an option');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.startsWith('#item-'));
  ok(await page.locator('#ov [role="dialog"]').count() > 0, 'Enter opens the item popout');
  ok(await hidden(page), 'the dropdown is hidden once a result is chosen');
  await page.close();

  const p2 = await open(browser, 1280, 800, '#archive');
  await p2.click('#q');
  await p2.keyboard.type('cve-2026');
  ok(!(await hidden(p2)), 'dropdown open at 1280');
  await p2.keyboard.press('Escape');
  ok(await hidden(p2), 'Escape closes the dropdown');
  await p2.keyboard.type('cve-2026');
  ok(!(await hidden(p2)), 'typing reopens the dropdown');
  await p2.keyboard.press('Tab');
  ok(await hidden(p2), 'Tab out of #q hides the dropdown');
  await p2.close();
}

async function checkArchiveKeyboard(browser) {
  const page = await open(browser, 1280, 800, '#archive');
  await page.waitForSelector('tr.rowlink');
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement && document.activeElement.matches('tr.rowlink'));
  }
  ok(reached, 'Tab reaches an archive row');
  const target = await page.evaluate(() => document.activeElement.dataset.nav);
  await page.keyboard.press('Enter');
  await page.waitForFunction(h => location.hash === h, target);
  ok((await page.evaluate(() => location.hash)) === target, 'Enter on a row navigates to ' + target);
  await page.close();
}

(async () => {
  const browser = await pw.chromium.launch();
  try {
    await checkFeedbackClick(browser);
    await checkSearch(browser);
    await checkArchiveKeyboard(browser);
  } catch (e) { ok(false, 'unexpected error: ' + (e && e.stack || e)); }
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL BROWSER CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
