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

async function checkSidebar(browser) {
  const page = await openPage(browser, 1280, 800, '#trends-restime');
  /* side-trends-badge-truncate: the report badge is cut, the label keeps its full text */
  const lbl = await page.evaluate(() => { const a = document.querySelector('#side a[href="#trends"]'), tx = a.querySelector('.tx'), d = a.querySelector('.dotc');
    return { tx: tx.scrollWidth - tx.clientWidth, txw: tx.getBoundingClientRect().width, badge: d ? d.textContent : '', dh: d ? d.getBoundingClientRect().height : 0, over: a.scrollWidth - a.clientWidth }; });
  ok(lbl.badge.length > 0, 'no report badge on the Trends link, so the truncation check proves nothing');
  ok(lbl.tx <= 0 && lbl.txw > 30, 'Trends label is squeezed: overflow ' + lbl.tx + ', width ' + lbl.txw);
  ok(lbl.dh < 20 && lbl.over <= 0, 'Trends badge wraps or overflows: height ' + lbl.dh + ', overflow ' + lbl.over);
  /* no arrow in the sidebar: the collapse control is keyboard-only (visible on focus), the empty sidebar background still toggles with the mouse */
  const tgl = await page.evaluate(() => { const b = document.getElementById('sideTgl'), r = b.getBoundingClientRect(); return { w: r.width, h: r.height, svg: !!b.querySelector('svg'), text: b.textContent.trim() }; });
  ok(tgl.w <= 1 && tgl.h <= 1 && !tgl.svg && /sidebar/.test(tgl.text), 'sidebar toggle must be invisible until focused and carry no arrow icon: ' + JSON.stringify(tgl));
  const bg = await page.evaluate(() => { const s = document.getElementById('side').getBoundingClientRect(); return { x: s.left + s.width / 2, y: s.bottom - 24 }; });
  await page.mouse.click(bg.x, bg.y);
  ok(await page.evaluate(() => document.getElementById('side').classList.contains('collapsed')), 'clicking the empty sidebar background did not collapse it');
  await page.waitForTimeout(400);
  await page.mouse.click(28, bg.y);
  ok(!(await page.evaluate(() => document.getElementById('side').classList.contains('collapsed'))), 'clicking the collapsed rail did not expand it');
  await page.focus('#sideTgl');
  const shown = await page.evaluate(() => { const r = document.getElementById('sideTgl').getBoundingClientRect(); return r.width > 20 && r.height > 10; });
  ok(shown, 'keyboard focus does not reveal the sidebar toggle');
  await page.keyboard.press('Enter');
  ok(await page.evaluate(() => document.getElementById('side').classList.contains('collapsed')), 'Enter on the focused toggle did not collapse the sidebar');
  await page.focus('#sideTgl'); await page.keyboard.press('Enter');
  ok(!(await page.evaluate(() => document.getElementById('side').classList.contains('collapsed'))), 'Enter on the focused toggle did not expand the sidebar');
  /* side-group-persist: a manually opened group is still open after a reload */
  await page.goto(URL + '#home'); await page.waitForSelector('#main h1');
  const open = () => page.getAttribute('[data-grp="areas"]', 'aria-expanded');
  if (await open() === 'true') await page.click('[data-grp="areas"]');
  await page.click('[data-grp="areas"]');
  ok(await open() === 'true', 'Areas group did not open on click');
  await page.reload(); await page.waitForSelector('#main h1');
  ok(await open() === 'true', 'Areas group was closed again after a reload');
  await page.close();
}

async function checkPhoneTabs(browser) {
  const page = await openPage(browser, 390, 844, '#home');
  const r = await page.evaluate(() => { const t = document.querySelector('.tabs'), bs = [...t.querySelectorAll('[role="tab"]')];
    return { n: bs.length, right: Math.max(...bs.map(b => b.getBoundingClientRect().right)), left: Math.min(...bs.map(b => b.getBoundingClientRect().left)), pos: getComputedStyle(t).position, scroll: t.scrollWidth - t.clientWidth }; });
  ok(r.n >= 4 && r.left >= 0 && r.right <= 390, 'home tabs run off the 390px viewport: ' + JSON.stringify(r));
  ok(r.scroll <= 0, 'home tab row still scrolls sideways at 390: ' + r.scroll);
  ok(r.pos === 'relative', '.tabs lost position:relative');
  ok(await hscroll(page) === 0, 'horizontal page overflow on #home at 390');
  await page.close();
}

async function checkSpaceOnCard(browser) {
  const page = await openPage(browser, 1280, 800, '#brief');
  await page.waitForSelector('[data-expand]');
  const card = page.locator('[data-expand]').first();
  await card.focus();
  const before = await page.evaluate(() => document.getElementById('main').innerHTML.length);
  const y0 = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById('main').innerHTML.length);
  ok(before !== after, 'Space did not toggle the focused card (page markup ' + before + ' -> ' + after + ')');
  ok(Math.abs((await page.evaluate(() => window.scrollY)) - y0) < 2, 'Space scrolled the page');
  await page.close();
}

(async () => {
  const browser = await pw.chromium.launch();
  try { await checkOverflow(browser); await checkPhoneHeader(browser); await checkMenuAndFocus(browser); await checkSidebar(browser); await checkPhoneTabs(browser); await checkSpaceOnCard(browser); }
  catch (e) { failures++; console.log('  FAIL script error: ' + e.message); }
  await browser.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nBROWSER SHELL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
