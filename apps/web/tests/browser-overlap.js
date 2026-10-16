#!/usr/bin/env node
/* Real-browser check that no rendered text collides with other text, on the main views, the item popout, the
   account menu and the search list, at desktop and phone width. Opens dashboard.html from disk in sample mode.
   The detector lives in scripts/ux-audit/overlap.js (also used to scan running containers). Skips without Playwright.
   Run: NODE_PATH=<dir with node_modules containing playwright> node apps/web/tests/browser-overlap.js */
'use strict';
let pw; try { pw = require('playwright'); } catch (e) { console.log('skipped: playwright not installed'); process.exit(0); }
const path = require('path'), { pathToFileURL } = require('url');
const { DETECTOR, MIN_PX, settle } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'ux-audit', 'overlap.js'));
const URL = pathToFileURL(path.join(__dirname, '..', 'dashboard.html')).href;
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL ' + msg); } return cond; };

const STATES = [
  { name: 'home', hash: '#home' },
  { name: 'home-new-tab', hash: '#home', js: "state.tab='new';render()" },
  { name: 'brief', hash: '#brief' },
  { name: 'brief-expanded', hash: '#brief', click: '[data-exp]' },
  { name: 'area-identity', hash: '#area-identity' },
  { name: 'area-perimeter', hash: '#area-perimeter' },
  { name: 'trends', hash: '#trends' },
  { name: 'trends-byarea', hash: '#trends-byarea' },
  { name: 'trends-t1cal', hash: '#trends-t1cal' },
  { name: 'trends-cve', hash: '#trends-cve' },
  { name: 'archive', hash: '#archive' },
  { name: 'popout', hash: '#home', js: "location.hash='#item-'+Object.keys(IDX.life).sort((a,b)=>IDX.life[b].days.length-IDX.life[a].days.length)[0]" },
  { name: 'menu', hash: '#home', js: 'state.umenu=true;renderUmenu()' },
  { name: 'search', hash: '#archive', type: ['#q', 'cve'] },
];

async function measure(browser, width, height, st) {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.goto(URL + st.hash); await settle(page);
    if (st.js) { await page.evaluate(st.js); await page.waitForTimeout(300); await settle(page); }
    if (st.click) { await page.locator(st.click).first().click(); await page.waitForTimeout(300); }
    if (st.type) { await page.locator(st.type[0]).first().click(); await page.locator(st.type[0]).first().pressSequentially(st.type[1], { delay: 15 }); await page.waitForTimeout(300); }
    const r = await page.evaluate(`(${DETECTOR})(${MIN_PX})`);
    const real = r.collisions.filter(c => !c.rotated);
    ok(real.length === 0, `${st.name} at ${width}px: ${real.length} text collision(s), first: "${real[0] && real[0].a.text}" (${real[0] && real[0].a.path}) over "${real[0] && real[0].b.text}" (${real[0] && real[0].b.path})`);
    ok(r.textCount > 20, `${st.name} at ${width}px: only ${r.textCount} text boxes measured, the page did not render`);
  } catch (e) { ok(false, `${st.name} at ${width}px threw: ${String(e.message).split('\n')[0]}`); }
  await page.close();
}

(async () => {
  const browser = await pw.chromium.launch();
  try { for (const [w, h] of [[1280, 800], [390, 844]]) for (const st of STATES) await measure(browser, w, h, st); }
  finally { await browser.close(); }
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL BROWSER CHECKS PASSED (no text collisions)');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
