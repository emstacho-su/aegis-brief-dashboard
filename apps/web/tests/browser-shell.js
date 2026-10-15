#!/usr/bin/env node
/* Real-browser checks for the dashboard shell (phone header, drawer, account menu, focus). Opens dashboard.html from
   disk in sample mode, no server. Skips cleanly when Playwright is not installed.
   Run: NODE_PATH=<dir with node_modules containing playwright> node apps/web/tests/browser-shell.js */
'use strict';
let pw; try { pw = require('playwright'); } catch (e) { console.log('skipped: playwright not installed'); process.exit(0); }
const path = require('path'), { pathToFileURL } = require('url');
const URL = pathToFileURL(path.join(__dirname, '..', 'dashboard.html')).href;
const ROUTES = ['#home', '#brief', '#trends', '#archive'];
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL ' + msg); } return cond; };

async function openPage(browser, width, height, hash) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', e => ok(false, 'page error: ' + e.message));
  await page.goto(URL + hash);
  await page.waitForSelector('#main h1', { timeout: 10000 });
  return page;
}
const hscroll = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function checkOverflow(browser) {
  for (const [w, h] of [[390, 844], [900, 1000]]) {
    for (const route of ROUTES) {
      const page = await openPage(browser, w, h, route);
      const extra = await hscroll(page);
      ok(extra === 0, `horizontal overflow of ${extra}px on ${route} at ${w}x${h}`);
      await page.close();
    }
  }
}

async function checkPhoneHeader(browser) {
  const page = await openPage(browser, 390, 844, '#home');
  const hit = await page.evaluate(() => { const b = document.getElementById('menubtn'), r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; });
  ok(hit, 'hamburger centre is covered by another element');
  for (const id of ['menubtn', 'fbBtn', 'avatarBtn']) {
    const r = await page.evaluate(i => { const b = document.getElementById(i).getBoundingClientRect(); return { l: b.left, r: b.right }; }, id);
    ok(r.l >= 0 && r.r <= 390, `#${id} is outside the 390px viewport (${r.l}..${r.r})`);
  }
  /* drawer: open, click a link, closes and aria-expanded follows */
  await page.click('#menubtn');
  ok(await page.getAttribute('#menubtn', 'aria-expanded') === 'true', 'drawer did not open');
  await page.click('#side a[href="#trends"]');
  await page.waitForFunction(() => location.hash === '#trends');
  ok(await page.getAttribute('#menubtn', 'aria-expanded') === 'false', 'aria-expanded stayed true after a drawer link');
  ok(!(await page.evaluate(() => document.getElementById('side').classList.contains('open'))), 'drawer stayed open after a link');
  /* drawer: Escape and outside tap */
  await page.click('#menubtn');
  await page.keyboard.press('Escape');
  ok(await page.getAttribute('#menubtn', 'aria-expanded') === 'false', 'Escape did not close the drawer');
  await page.click('#menubtn');
  await page.mouse.click(370, 400);
  ok(await page.getAttribute('#menubtn', 'aria-expanded') === 'false', 'tapping outside did not close the drawer');
  await page.close();
}

async function checkMenuAndFocus(browser) {
  const page = await openPage(browser, 1280, 800, '#home');
  await page.click('#avatarBtn');
  ok(await page.getAttribute('#avatarBtn', 'aria-expanded') === 'true', 'account menu did not open');
  await page.keyboard.press('Escape');
  ok(await page.getAttribute('#avatarBtn', 'aria-expanded') === 'false', 'Escape did not close the account menu');
  ok(await page.evaluate(() => document.activeElement.id) === 'avatarBtn', 'focus did not return to the avatar');
  const tabs = await page.evaluate(() => { const b = document.querySelector('[data-tab="new"]'); return !!b; });
  if (ok(tabs, 'home tab [data-tab="new"] not found')) {
    await page.focus('[data-tab="new"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => document.activeElement.getAttribute('data-tab')) === 'new', 'focus left the Home tab after Enter');
  }
  /* skip link keeps the page */
  await page.goto(URL + '#trends'); await page.waitForSelector('#main h1');
  await page.focus('.skip'); await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => location.hash) === '#trends' && /Trends/.test(await page.title()), 'skip link changed the page');
  await page.close();
}

(async () => {
  const browser = await pw.chromium.launch();
  try { await checkOverflow(browser); await checkPhoneHeader(browser); await checkMenuAndFocus(browser); }
  catch (e) { failures++; console.log('  FAIL script error: ' + e.message); }
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nBROWSER SHELL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
