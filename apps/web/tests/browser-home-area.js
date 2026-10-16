#!/usr/bin/env node
/* Browser checks for the Home and Area fixes. Opens dashboard.html from disk (sample mode).
   Run: NODE_PATH=<dir with playwright> node apps/web/tests/browser-home-area.js. Exit 1 on failure. */
'use strict';
let pw;
try { pw = require('playwright'); } catch (e) { console.log('skipped: playwright not installed'); process.exit(0); }
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE = pathToFileURL(path.join(__dirname, '..', 'dashboard.html')).href;
const failures = [];
const check = (cond, msg) => { if (!cond) { failures.push(msg); console.log('  FAIL ' + msg); } };
const eventCount = page => page.locator('#sec-stream .ev').count();

async function checkRails(page) {
  const rails = await page.$$eval('.acard', cards => cards.map(c => ({
    items: parseInt((c.querySelector('.st') || {}).textContent, 10),
    cls: (c.querySelector('.rail-c') || { className: '' }).className,
  })));
  check(rails.length > 0, 'no area cards rendered');
  rails.filter(r => r.items > 0).forEach(r => check(!/\bnone\b/.test(r.cls), 'rail has class none for area with items: ' + r.cls));
}

async function checkStream(page) {
  const head = (await page.locator('#sec-stream h2').innerText()).replace(/\s+/g, ' ');
  check(/today and the previous brief/.test(head), 'stream header is "' + head + '"');
  const short = await eventCount(page);
  await page.click('[data-streamall]');
  const full = await eventCount(page);
  check(full > short, `Show all did not add events (${short} -> ${full})`);
  await page.click('[data-streamless]');
  check((await eventCount(page)) === short, 'Show less did not restore the short window');
  check(await page.locator('[data-streamall]').count() === 1, 'Show all button missing after Show less');
}

async function checkWrappedStream(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(PAGE + '#area-perimeter');
  await page.waitForSelector('.two .rail .stream');
  await page.waitForTimeout(400); /* fitTwo runs after the render */
  const m = await page.evaluate(() => { const two = document.querySelector('.two'), st = document.querySelector('.two .rail .sec > .stream');
    return { wrap: two.classList.contains('wrap'), two: two.querySelector('.rail').getBoundingClientRect().width, stream: st.getBoundingClientRect().width }; });
  check(m.wrap, 'area page at 1280 is not wrapped, so the stream-width check proves nothing');
  check(Math.abs(m.stream - m.two) <= 2, 'wrapped Activity stream is ' + m.stream + 'px in a ' + m.two + 'px wrapped rail');
}

(async () => {
  const browser = await pw.chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('console', m => { /* the optional config script is absent when opened from disk; that is not a page error */
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(PAGE + '#home');
    await page.waitForSelector('.acard');
    await checkRails(page);
    await checkStream(page);
    await checkWrappedStream(page);
  } catch (e) {
    failures.push('script error: ' + e.message);
  } finally {
    await browser.close();
  }
  check(errors.length === 0, 'console errors: ' + errors.slice(0, 3).join(' | '));
  console.log(failures.length ? `${failures.length} FAILURE(S)` : 'browser-home-area: ALL CHECKS PASSED');
  process.exit(failures.length ? 1 : 0);
})();
