#!/usr/bin/env node
/* Headless smoke test for apps/web/dashboard.html (no browser, no dependencies).
   Extracts the main inline script, runs it in a node:vm context against a small DOM stub, and renders every view
   in each data mode. Usage: node apps/web/test-harness.js [data/briefs dir] [--dump-index out.json]. Exit code 1 on any failure.
   --dump-index writes the page's own buildIndex output for the briefs dir (for the worker's index-equality test). */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = path.join(__dirname, 'dashboard.html');
const args = process.argv.slice(2);
const dumpAt = args.indexOf('--dump-index');
const DUMP = dumpAt >= 0 ? args.splice(dumpAt, 2)[1] : null;
const BRIEFS_DIR = args[0] || path.join(__dirname, '..', '..', 'data', 'briefs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.log('  FAIL ' + msg); } return cond; };

function mainScript() {
  const h = fs.readFileSync(HTML, 'utf8');
  const m = [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return m[m.length - 1][1];
}
function loadBriefs() {
  const out = {};
  fs.readdirSync(BRIEFS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    .forEach(f => { out[f.slice(0, 10)] = JSON.parse(fs.readFileSync(path.join(BRIEFS_DIR, f), 'utf8')); });
  return out;
}

/* ---- DOM stub ---- */
function makeEnv({ config, fetchImpl, supabase } = {}) {
  const els = new Map(), errors = [], listeners = {};
  const ctx = {};
  function classList() { const s = new Set(); return { add: c => s.add(c), remove: c => s.delete(c), toggle: (c, f) => { (f === undefined ? !s.has(c) : f) ? s.add(c) : s.delete(c); }, contains: c => s.has(c) }; }
  function el(id) {
    const attrs = {};
    return { id, innerHTML: '', hidden: false, textContent: '', value: '', title: '', disabled: false, className: '', style: {}, dataset: {},
      classList: classList(), setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
      removeAttribute(k) { delete attrs[k]; }, hasAttribute(k) { return k in attrs; }, focus() { ctx.__focused = id; }, appendChild() {} };
  }
  const document = {
    title: '', activeElement: null, head: el('head'), body: el('body'), documentElement: el('html'),
    getElementById(id) { if (!els.has(id)) els.set(id, el(id)); return els.get(id); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement(t) { return el('new-' + t); },
    addEventListener(type, fn) { (listeners['doc:' + type] = listeners['doc:' + type] || []).push(fn); },
  };
  const store = new Map();
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  Object.assign(ctx, {
    document, localStorage, navigator: {}, console: { log: console.log, warn: () => {}, error: (...a) => errors.push(a.map(String).join(' ')) },
    location: { hash: '', pathname: '/', search: '', origin: 'http://localhost' },
    history: { state: null, replaceState(s, t, u) { const i = u.indexOf('#'); ctx.location.hash = i >= 0 ? u.slice(i) : ''; } },
    innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0,
    addEventListener(type, fn) { (listeners['win:' + type] = listeners['win:' + type] || []).push(fn); },
    setTimeout, clearTimeout, URLSearchParams, atob, Blob, Promise,
    fetch: fetchImpl || (() => Promise.reject(new Error('fetch not stubbed'))),
  });
  ctx.window = ctx;
  if (config) ctx.AEGIS_CONFIG = config;
  if (supabase) ctx.supabase = supabase;
  vm.createContext(ctx);
  return { ctx, els, errors, run: code => vm.runInContext(code, ctx), main: () => els.get('main') || { innerHTML: '' } };
}
async function start(opts) {
  const env = makeEnv(opts);
  env.run(mainScript());
  await env.run('booting||Promise.resolve()');
  await sleep(40);
  return env;
}

/* ---- render every view; returns counts ---- */
function renderAll(env, label) {
  const { run, ctx, els } = env;
  const counts = { views: 0, popouts: 0 };
  const view = (hash, setup) => {
    ctx.location.hash = hash; if (setup) run(setup);
    try { run('render()'); } catch (e) { ok(false, `${label} ${hash} threw: ${e.message}`); return; }
    const html = env.main().innerHTML;
    ok(html.length > 200, `${label} ${hash} rendered an empty #main`);
    ok(!/failed to render/.test(html), `${label} ${hash}: ${(html.match(/failed to render \(([^)]*)\)/) || [])[1]}`);
    counts.views++;
  };
  run("myAreas=new Set(['perimeter','identity']);stars=new Set();");
  ['mine', 'new', 'esc', 'viewed', 'starred'].forEach(t => view('#home', `state.tab='${t}'`));
  run('Object.keys(AREAS)').forEach(k => view('#area-' + k));
  view('#brief');
  run('DATES').forEach(d => view('#brief-' + d));
  view('#trends');
  const reports = run('REPORTS.map(r=>r.id)');
  [7, 14, 30].forEach(p => reports.forEach(id => view('#trends-' + id, `state.f.period=${p};state.sel=null;state.f.area=null`)));
  reports.forEach(id => view('#trends-' + id, `state.sel=TODAY_S`));
  view('#trends-byarea', "state.sel='perimeter'"); view('#trends-quiet', "state.sel='identity'");
  view('#trends-newres', "state.sel=null;state.cum=true;state.f.area='perimeter'");
  run("state.sel=null;state.cum=false;state.f.area=null");
  view('#archive');
  const ids = run('Object.keys(IDX.life)');
  ids.forEach(id => {
    ctx.location.hash = '#item-' + id;
    try { run('render()'); } catch (e) { ok(false, `${label} popout ${id} threw: ${e.message}`); return; }
    const ov = els.get('ov').innerHTML;
    ok(/role="dialog"/.test(ov) && ov.includes('Timeline'), `${label} popout ${id} did not render`);
    counts.popouts++;
  });
  ok(env.errors.length === 0, `${label} console.error: ${env.errors.slice(0, 3).join(' | ')}`);
  return counts;
}

/* ---- fake supabase-js (records calls) ---- */
function fakeSupabase(db) {
  const log = { otp: [], verify: [], queries: [], uploads: [], signOut: 0 };
  let cb = null, session = db.session || null;
  const qb = table => {
    const st = { table, ops: [] };
    const b = {
      select(c) { st.ops.push(['select', c]); return b; }, order(c, o) { st.ops.push(['order', c, o]); return b; },
      eq(c, v) { st.ops.push(['eq', c, v]); return b; }, maybeSingle() { st.ops.push(['maybeSingle']); return b; },
      upsert(row, o) { st.ops.push(['upsert', row, o]); return b; }, insert(row) { st.ops.push(['insert', row]); return b; },
      then(res, rej) { log.queries.push(st); return Promise.resolve(db.answer(st)).then(res, rej); },
    };
    return b;
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange(fn) { cb = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithOtp: async a => { log.otp.push(a); return { error: null }; },
      verifyOtp: async a => { log.verify.push(a); if (a.token !== '123456') return { error: new Error('Token has expired or is invalid') }; return { data: {}, error: null }; },
      signOut: async () => { log.signOut++; session = null; cb && cb('SIGNED_OUT', null); return { error: null }; },
    },
    from: qb,
    storage: { from: bucket => ({ upload: async (p, blob, o) => { log.uploads.push({ bucket, path: p, size: blob.size, o }); return { data: { path: p }, error: null }; } }) },
  };
  return { lib: { createClient: (url, key, opts) => { log.created = { url, key, opts }; return client; } }, log,
    signIn(s) { session = s; cb && cb('SIGNED_IN', s); } };
}

(async () => {
  const briefs = loadBriefs();
  const nBriefs = Object.keys(briefs).length;
  console.log(`briefs dir: ${BRIEFS_DIR} (${nBriefs} files)`);

  /* 1. no config: synthetic sample, unchanged behaviour */
  {
    const env = await start();
    ok(env.run('BOOTED') && env.run('MODE') === 'sample', 'no-config did not boot in sample mode');
    const c = renderAll(env, 'sample');
    console.log(`1. no config       ribbon="${env.els.get('ribbon').textContent}" briefs=${env.run('DATES.length')} views=${c.views} popouts=${c.popouts}`);
    ok(!/Stored page/.test((env.run("location.hash='#archive';render()"), env.main().innerHTML)), 'sample archive shows stored-page links');
  }

  /* 2a. container, no index in the response: the page computes it (buildIndex) */
  let computedIndex;
  {
    const fetchImpl = async url => { ok(url === '/api/archive', 'container fetched ' + url); return { ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify(briefs)), manifest: { retained: Object.keys(briefs) } }) }; };
    const env = await start({ config: { apiBase: '', mode: 'container' }, fetchImpl });
    ok(env.run('BOOTED') && env.run('HAS_REAL'), 'container (no index) did not boot');
    computedIndex = JSON.parse(env.run('JSON.stringify(IDX)'));
    if (DUMP) { fs.writeFileSync(DUMP, JSON.stringify(computedIndex, null, 1)); console.log('    wrote buildIndex output to ' + DUMP); }
    const c = renderAll(env, 'container/computed');
    console.log(`2a. container      index computed by buildIndex: life=${Object.keys(computedIndex.life).length} events=${computedIndex.events.length} daily=${computedIndex.daily.length}; views=${c.views} popouts=${c.popouts}`);
  }

  /* 2b. container with index from the response (shape of the page's own buildIndex) */
  {
    const idx = JSON.parse(JSON.stringify(computedIndex));
    idx.generated_from = Object.keys(briefs); idx.today = idx.generated_from[idx.generated_from.length - 1];
    idx.daily[0].__adopted = true;
    let calls = 0;
    const fetchImpl = async url => { calls++; return { ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify(briefs)), index: idx, manifest: { retained: idx.generated_from, max_briefs: 30, last_ingest: idx.today } }) }; };
    const env = await start({ config: { apiBase: '', mode: 'container' }, fetchImpl });
    ok(env.run('BOOTED'), 'container (index) did not boot');
    ok(env.run('IDX.daily[0].__adopted===true'), 'server index was not adopted');
    const ribbon = env.els.get('ribbon').textContent;
    ok(ribbon === `v1.3.2 · ${nBriefs} briefs · container`, 'ribbon is ' + ribbon);
    const c = renderAll(env, 'container/index');
    env.ctx.location.hash = '#archive'; env.run('render()');
    const arch = env.main().innerHTML;
    const links = (arch.match(/>Open stored page<\/a>/g) || []).length;
    ok(links === nBriefs && arch.includes('href="/briefs/2026-09-29.html" target="_blank" rel="noopener"'), 'archive stored-page links missing');
    console.log(`2b. container      ribbon="${ribbon}" fetches=${calls} index adopted, views=${c.views} popouts=${c.popouts}, stored-page links=${links}`);
  }

  /* 3. failure paths: HTTP 500, empty archive, single brief, requireAuth without Supabase */
  {
    const env = await start({ config: { apiBase: 'http://localhost:8080', mode: 'container' }, fetchImpl: async () => ({ ok: false, status: 500 }) });
    const html = env.main().innerHTML;
    ok(!env.run('BOOTED') && /role="alert"/.test(html) && /data-retry/.test(html) && /returned 500/.test(html), 'HTTP 500 did not show an error banner with Retry');
    let n = 0; env.ctx.fetch = async () => { n++; return { ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify(briefs)) }) }; };
    await env.run('boot()');
    ok(env.run('BOOTED') && n === 1 && env.main().innerHTML.includes('Your work'), 'Retry did not recover');
    console.log(`3a. HTTP 500       error banner with Retry shown; Retry recovered=${env.run('BOOTED')}`);
  }
  {
    const env = await start({ config: { apiBase: '' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ briefs: {} }) }) });
    ok(/no briefs yet/.test(env.main().innerHTML) && /data-retry/.test(env.main().innerHTML), 'empty archive message missing');
    console.log('3b. empty archive  "no briefs yet" banner with Retry');
  }
  {
    const one = { [Object.keys(briefs)[0]]: briefs[Object.keys(briefs)[0]] };
    const env = await start({ config: { apiBase: '' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify(one)) }) }) });
    const c = renderAll(env, 'one-brief');
    console.log(`3c. single brief   views=${c.views} popouts=${c.popouts}`);
  }
  {
    const env = await start({ config: { apiBase: '', requireAuth: true } });
    ok(/Sign-in is required/.test(env.main().innerHTML), 'requireAuth without Supabase did not error');
    console.log('3d. requireAuth, no Supabase: error banner');
  }

  /* 4. static mode with requireAuth and a fake supabase-js: sign-in screen, code sent and verified, session, settings, feedback, sign out */
  {
    const uid = '11111111-2222-3333-4444-555555555555';
    const fake = fakeSupabase({ answer(st) {
      const op = st.ops.map(o => o[0]);
      if (st.table === 'briefs') return { data: Object.keys(briefs).map(d => ({ date: d, data: JSON.parse(JSON.stringify(briefs[d])) })), error: null };
      if (st.table === 'archive_index') return { data: { data: JSON.parse(JSON.stringify(computedIndex)) }, error: null };
      if (st.table === 'user_settings' && op.includes('select')) return { data: { my_areas: ['perimeter'], stars: ['x1'], viewed: [], theme: 'light' }, error: null };
      return { data: null, error: null };
    } });
    const env = await start({ config: { apiBase: '', supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon', requireAuth: true, mode: 'static' }, supabase: fake.lib });
    await sleep(60);
    const m0 = env.main().innerHTML;
    ok(/id="signinForm"/.test(m0) && /<label for="signinEmail">/.test(m0) && env.ctx.__focused === 'signinEmail', 'sign-in screen or focus missing');
    ok(/Sign in required/.test(env.els.get('live').textContent), 'sign-in not announced');
    env.els.get('signinEmail').value = 'Analyst@syr.edu';
    await env.run('sendMagicLink()');
    const otp = fake.log.otp[0] || {};
    ok(otp.email === 'Analyst@syr.edu' && otp.options.emailRedirectTo === 'http://localhost/' && otp.options.shouldCreateUser === false, 'signInWithOtp args ' + JSON.stringify(otp));
    const m1 = env.main().innerHTML;
    ok(/id="codeForm"/.test(m1) && /id="signinCode"/.test(m1) && env.ctx.__focused === 'signinCode', 'code step or focus missing');
    ok(/Check Analyst@syr.edu for the code/.test(m1), 'code status not shown');
    env.els.get('signinCode').value = '000000';
    await env.run('verifyCode()');
    ok(/not valid any more/.test(env.els.get('signinStatus').textContent), 'bad code not reported');
    env.els.get('signinCode').value = '123456';
    await env.run('verifyCode()');
    const v = fake.log.verify[1] || {};
    ok(v.email === 'Analyst@syr.edu' && v.token === '123456' && v.type === 'email', 'verifyOtp args ' + JSON.stringify(v));
    fake.signIn({ access_token: 'tok', user: { id: uid, email: 'analyst@syr.edu' } });
    await sleep(80); await env.run('booting||Promise.resolve()'); await sleep(40);
    ok(env.run('BOOTED') && env.run('MODE') === 'static', 'static mode did not boot after sign-in');
    ok(env.els.get('ribbon').textContent === `v1.3.2 · ${nBriefs} briefs · static`, 'static ribbon');
    ok(env.els.get('avatarBtn').textContent === 'A' && /analyst@syr\.edu/.test(env.els.get('avatarBtn').getAttribute('aria-label')), 'avatar not updated');
    ok(env.run("myAreas.has('perimeter')&&stars.has('x1')") && env.ctx.document.documentElement.getAttribute('data-theme') === 'light', 'remote settings not applied');
    const c = renderAll(env, 'static');
    env.run("state.umenu=true;renderUmenu()");
    ok(/analyst@syr\.edu/.test(env.els.get('umenu').innerHTML) && /id="signOutBtn"/.test(env.els.get('umenu').innerHTML), 'user menu missing email/sign out');
    /* settings write-through, debounced */
    const before = fake.log.queries.filter(q => q.table === 'user_settings' && q.ops[0][0] === 'upsert').length;
    env.run("stars.add('x2');store.set('stars',[...stars]);stars.add('x3');store.set('stars',[...stars]);setTheme('dark')");
    ok(env.ctx.localStorage.getItem('aegis4-stars').includes('x3'), 'localStorage cache not written');
    await sleep(400);
    const ups = fake.log.queries.filter(q => q.table === 'user_settings' && q.ops[0][0] === 'upsert');
    ok(ups.length - before === 1, `expected one debounced upsert, got ${ups.length - before}`);
    const row = ups[ups.length - 1].ops[0][1];
    ok(row.user_id === uid && row.stars.includes('x3') && row.theme === 'dark' && Array.isArray(row.my_areas) && ups[ups.length - 1].ops[0][2].onConflict === 'user_id', 'upsert row ' + JSON.stringify(row));
    /* feedback */
    const gid = id => env.ctx.document.getElementById(id);
    gid('fb1').value = 'bug text'; gid('fb2').value = 'change text';
    env.run("fb.shot='data:image/jpeg;base64,'+'/9j/4AAQSkZJRg=='");
    env.run('fbSave()'); await sleep(60);
    const up = fake.log.uploads[0] || {};
    const ins = fake.log.queries.find(q => q.table === 'feedback') || { ops: [[]] };
    ok(up.bucket === 'feedback-screenshots' && new RegExp('^' + uid + '/\\d+\\.jpg$').test(up.path) && up.o.contentType === 'image/jpeg', 'upload ' + JSON.stringify(up));
    const fr = ins.ops[0][1] || {};
    ok(ins.ops[0][0] === 'insert' && fr.user_id === uid && fr.bug === 'bug text' && fr.change === 'change text' && fr.screenshot_path === up.path && 'page' in fr, 'feedback insert ' + JSON.stringify(fr));
    ok(/Saved to the team store/.test(env.els.get('fbroot').innerHTML) && env.run("fb.list.length===1&&fb.list[0].remote==='saved'"), 'feedback status/local list');
    await env.run('signOut()'); await sleep(40);
    ok(fake.log.signOut === 1 && /id="signinForm"/.test(env.main().innerHTML) && !env.run('BOOTED'), 'sign out did not return to sign-in');
    console.log(`4. static+auth     sign-in screen (focus=email), OTP sent (shouldCreateUser=false), session -> loaded ${env.run('DATES.length')} briefs from table briefs + archive_index, settings pulled and upserted once (300ms debounce), feedback uploaded to ${up.path.replace(uid, '<uid>')} and inserted, sign out -> sign-in; views=${c.views} popouts=${c.popouts}`);
    console.log('   supabase calls: ' + [...new Set(fake.log.queries.map(q => q.table + ':' + q.ops.map(o => o[0]).join('.')))].join(', '));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
