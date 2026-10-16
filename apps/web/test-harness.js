#!/usr/bin/env node
/* Headless smoke test for apps/web/dashboard.html (no browser, no dependencies).
   Extracts the main inline script, runs it in a node:vm context against a small DOM stub, and renders every view
   in each data mode. Usage: node apps/web/test-harness.js [data/briefs dir] [--dump-index out.json]. Exit code 1 on any failure.
   --dump-index writes the page's own buildIndex output for the briefs dir (for the worker's index-equality test). */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = path.join(__dirname, 'dashboard.html');
const SRC = fs.readFileSync(HTML, 'utf8');
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
  return { ctx, els, errors, listeners, run: code => vm.runInContext(code, ctx), main: () => els.get('main') || { innerHTML: '' } };
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
  const log = { otp: [], verify: [], pw: [], update: [], queries: [], uploads: [], signOut: 0 };
  const flags = { net: false };   /* net: every auth call rejects like a dropped connection */
  const netDown = () => { if (flags.net) throw new TypeError('Failed to fetch'); };
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
      signInWithOtp: async a => { netDown(); log.otp.push(a); return { error: null }; },
      signInWithPassword: async a => { netDown(); log.pw.push(a); if (a.password !== 'correct horse battery') return { error: new Error('Invalid login credentials') }; session = { access_token: 'tokpw', user: { id: db.pwUid || 'pw-user', email: a.email } }; cb && cb('SIGNED_IN', session); return { data: { session }, error: null }; },
      updateUser: async a => { log.update.push(a); return { data: {}, error: null }; },
      verifyOtp: async a => { netDown(); log.verify.push(a); if (a.token !== '123456') return { error: new Error('Token has expired or is invalid') }; return { data: {}, error: null }; },
      signOut: async () => { log.signOut++; session = null; cb && cb('SIGNED_OUT', null); return { error: null }; },
    },
    from: qb,
    storage: { from: bucket => ({ upload: async (p, blob, o) => { log.uploads.push({ bucket, path: p, size: blob.size, o }); return { data: { path: p }, error: null }; } }) },
  };
  return { lib: { createClient: (url, key, opts) => { log.created = { url, key, opts }; return client; } }, log, flags,
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
    ok(ribbon === `v1.6.0 · ${nBriefs} briefs · container`, 'ribbon is ' + ribbon);
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
    env.ctx.location.hash = '#trends-movers'; env.run('render()');
    ok(/Only one brief in the window/.test(env.main().innerHTML) && !/vs \d{4}-\d{2}-\d{2}/.test(env.main().innerHTML), 'movers with a single brief shows dashes / vs today instead of an empty state');
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
      if (st.table === 'user_settings' && op.includes('select')) { const who = (st.ops.find(o => o[0] === 'eq') || [])[2]; return who === uid ? { data: { my_areas: ['perimeter'], stars: ['x1'], viewed: [], theme: 'light', pw_set: true }, error: null } : { data: null, error: null }; }
      return { data: null, error: null };
    } });
    const env = await start({ config: { apiBase: '', supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon', requireAuth: true, mode: 'static' }, supabase: fake.lib });
    await sleep(60);
    const m0 = env.main().innerHTML;
    ok(/id="signinForm"/.test(m0) && /<label for="signinEmail">/.test(m0) && /id="signinPw"/.test(m0) && /data-signin-mode="code"/.test(m0) && env.ctx.__focused === 'signinEmail', 'password sign-in screen or focus missing');
    ok(/Sign in required/.test(env.els.get('live').textContent), 'sign-in not announced');
    const gid = id => env.ctx.document.getElementById(id);
    /* regressions: auth. The toggle is a real button; the signed-out shell is gated; aria-invalid clears */
    ok(/<button[^>]*type="button"[^>]*data-signin-mode="code"/.test(m0) && !/<a [^>]*data-signin-mode/.test(m0), 'the password/code toggle is not a type=button button');
    ok(gid('q').disabled && gid('fbBtn').disabled && gid('q').getAttribute('title') === 'Sign in first' && gid('fbBtn').getAttribute('title') === 'Sign in first', 'search box and feedback button are not disabled while signed out');
    env.run('state.umenu=true;renderUmenu()');
    ok(!/data-tabgo/.test(env.els.get('umenu').innerHTML) && /id="menuSignInBtn"/.test(env.els.get('umenu').innerHTML), 'quick links are still offered while signed out');
    env.run('state.umenu=false;renderUmenu()');
    const fireInput = id => (env.listeners['doc:input'] || []).forEach(fn => fn({ target: gid(id) }));
    gid('signinEmail').value = 'Analyst@syr.edu'; gid('signinPw').value = '';
    await env.run('signInWithPassword()');
    ok(gid('signinPw').getAttribute('aria-invalid') === 'true', 'empty password did not set aria-invalid');
    fireInput('signinPw');
    ok(gid('signinPw').getAttribute('aria-invalid') === null, 'aria-invalid was not cleared by an input event');
    await env.run('signInWithPassword()');
    gid('signinPw').value = 'wrong';
    await env.run('signInWithPassword()');
    ok(gid('signinPw').getAttribute('aria-invalid') === null, 'aria-invalid was not cleared by a submit that passed validation');
    /* a dropped connection reads as a connection problem, not as "Failed to fetch" */
    fake.flags.net = true;
    gid('signinPw').value = 'wrong';
    await env.run('signInWithPassword()');
    ok(/Could not reach the sign-in service\. Check your connection and try again\./.test(gid('signinStatus').textContent) && !/Failed to fetch/.test(gid('signinStatus').textContent), 'password path network failure text: ' + gid('signinStatus').textContent);
    ok(!gid('signinSubmit').disabled, 'submit button still busy after a network failure');
    fake.flags.net = false;
    /* wrong password is reported and does not sign in */
    gid('signinEmail').value = 'Analyst@syr.edu'; gid('signinPw').value = 'wrong';
    await env.run('signInWithPassword()');
    ok(fake.log.pw.length === 2 && /did not match/.test(env.els.get('signinStatus').textContent) && !env.run('SESSION'), 'wrong password handling');
    ok(!gid('signinSubmit').disabled && gid('signinSubmit').getAttribute('aria-busy') === null && !gid('signinSubmit').classList.contains('busy'), 'submit button still busy after a failed sign-in');
    /* switch to the code path */
    env.run("showSignIn('code')");
    ok(/data-mode="code"/.test(env.main().innerHTML) && !/id="signinPw"/.test(env.main().innerHTML), 'code mode card missing');
    env.els.get('signinEmail').value = 'Analyst@syr.edu';
    fake.flags.net = true;
    await env.run('sendMagicLink()');
    ok(/Could not reach the sign-in service/.test(env.els.get('signinStatus').textContent) && !/Failed to fetch/.test(env.els.get('signinStatus').textContent) && fake.log.otp.length === 0, 'code-send network failure text: ' + env.els.get('signinStatus').textContent);
    fake.flags.net = false;
    await env.run('sendMagicLink()');
    const otp = fake.log.otp[0] || {};
    ok(otp.email === 'Analyst@syr.edu' && otp.options.emailRedirectTo === 'http://localhost/' && otp.options.shouldCreateUser === false, 'signInWithOtp args ' + JSON.stringify(otp));
    const m1 = env.main().innerHTML;
    ok(/id="codeForm"/.test(m1) && /id="signinCode"/.test(m1) && env.ctx.__focused === 'signinCode', 'code step or focus missing');
    ok(/Check Analyst@syr.edu for the code/.test(m1), 'code status not shown');
    env.els.get('signinCode').value = '12345';
    await env.run('verifyCode()');
    ok(/6 to 10 digits/.test(env.els.get('signinStatus').textContent), 'short code not rejected locally');
    env.els.get('signinCode').value = 'abc123456';
    await env.run('verifyCode()');
    ok(/6 to 10 digits/.test(env.els.get('signinStatus').textContent) && fake.log.verify.length === 0, 'letters in the code were stripped instead of rejected: ' + JSON.stringify(fake.log.verify));
    ok(env.els.get('signinCode').getAttribute('aria-invalid') === 'true', 'rejected code did not set aria-invalid');
    fireInput('signinCode');
    ok(env.els.get('signinCode').getAttribute('aria-invalid') === null, 'aria-invalid on the code field was not cleared by an input event');
    fake.flags.net = true;
    env.els.get('signinCode').value = '123456';
    await env.run('verifyCode()');
    ok(/Could not reach the sign-in service/.test(env.els.get('signinStatus').textContent) && !/Failed to fetch/.test(env.els.get('signinStatus').textContent) && fake.log.verify.length === 0, 'verify network failure text: ' + env.els.get('signinStatus').textContent);
    fake.flags.net = false;
    env.els.get('signinCode').value = '21229477';
    await env.run('verifyCode()');
    ok(/not valid any more/.test(env.els.get('signinStatus').textContent) && fake.log.verify[0].token === '21229477', '8-digit code not passed through');
    env.els.get('signinCode').value = ' 123 456 ';
    await env.run('verifyCode()');
    const v = fake.log.verify[1] || {};
    ok(v.email === 'Analyst@syr.edu' && v.token === '123456' && v.type === 'email', 'verifyOtp args ' + JSON.stringify(v));
    fake.signIn({ access_token: 'tok', user: { id: uid, email: 'analyst@syr.edu' } });
    await sleep(80); await env.run('booting||Promise.resolve()'); await sleep(40);
    ok(env.run('BOOTED') && env.run('MODE') === 'static', 'static mode did not boot after sign-in');
    ok(env.els.get('ribbon').textContent === `v1.6.0 · ${nBriefs} briefs · static`, 'static ribbon');
    ok(!gid('q').disabled && !gid('fbBtn').disabled && gid('q').getAttribute('title') === null && gid('fbBtn').getAttribute('title') !== 'Sign in first', 'search box / feedback button still disabled after sign-in');
    env.run('state.umenu=true;renderUmenu()');
    ok(/data-tabgo="mine"/.test(env.els.get('umenu').innerHTML), 'quick links missing after sign-in');
    env.run('state.umenu=false;renderUmenu()');
    ok(env.els.get('avatarBtn').textContent === 'A' && /analyst@syr\.edu/.test(env.els.get('avatarBtn').getAttribute('aria-label')), 'avatar not updated');
    ok(env.run("myAreas.has('perimeter')&&stars.has('x1')") && env.ctx.document.documentElement.getAttribute('data-theme') === 'light', 'remote settings not applied');
    const c = renderAll(env, 'static');
    env.run("state.umenu=true;renderUmenu()");
    ok(/analyst@syr\.edu/.test(env.els.get('umenu').innerHTML) && /id="signOutBtn"/.test(env.els.get('umenu').innerHTML), 'user menu missing email/sign out');
    /* settings write-through, debounced */
    const before = fake.log.queries.filter(q => q.table === 'user_settings' && q.ops[0][0] === 'upsert').length;
    env.run("stars.add('x2');store.set('stars',[...stars]);stars.add('x3');store.set('stars',[...stars]);setTheme('dark')");
    ok(env.ctx.localStorage.getItem('aegis4-' + uid.replace(/-/g, '').slice(0, 12) + '-stars').includes('x3') && env.ctx.localStorage.getItem('aegis4-stars') == null, 'per-user localStorage cache not written');
    await sleep(400);
    const ups = fake.log.queries.filter(q => q.table === 'user_settings' && q.ops[0][0] === 'upsert');
    ok(ups.length - before === 1, `expected one debounced upsert, got ${ups.length - before}`);
    const row = ups[ups.length - 1].ops[0][1];
    ok(row.user_id === uid && row.stars.includes('x3') && row.theme === 'dark' && Array.isArray(row.my_areas) && ups[ups.length - 1].ops[0][2].onConflict === 'user_id', 'upsert row ' + JSON.stringify(row));
    /* feedback */
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
    ok(env.run("stars.size===0&&myAreas.size===0&&fb.list.length===0"), 'user state still in memory after sign out');
    /* a second user on the same browser, with no row yet: must not inherit the first user's cache */
    const uid2 = '99999999-8888-7777-6666-555555555555';
    const upsBefore2 = fake.log.queries.filter(q => q.table === 'user_settings' && q.ops[0][0] === 'upsert').length;
    fake.signIn({ access_token: 'tok2', user: { id: uid2, email: 'second@syr.edu' } });
    await sleep(80); await env.run('booting||Promise.resolve()'); await sleep(400);
    const ups2 = fake.log.queries.filter(q => q.table === 'user_settings' && q.ops[0][0] === 'upsert');
    const seed = ups2.length > upsBefore2 ? ups2[ups2.length - 1].ops[0][1] : null;
    ok(env.run("stars.size===0&&myAreas.size===0&&fb.list.length===0"), 'second user inherited first user state');
    ok(!seed || (seed.user_id === uid2 && seed.stars.length === 0 && seed.my_areas.length === 0), 'second user seeded from first user cache: ' + JSON.stringify(seed));
    /* no pw_set row: the app is blocked behind the set-password card */
    ok(env.run('BOOTED') && !env.run('PW_SET') && /id="pwForm"/.test(env.main().innerHTML) && env.ctx.__focused === 'pw1', 'set-password gate not shown for a first-time user');
    gid('pw1').value = 'short'; gid('pw2').value = 'short';
    await env.run('savePassword()');
    ok(/at least 12/.test(gid('pwStatus').textContent) && fake.log.update.length === 0, 'short password accepted');
    gid('pw1').value = 'correct horse battery'; gid('pw2').value = 'correct horse batteries';
    await env.run('savePassword()');
    ok(/do not match/.test(gid('pwStatus').textContent) && fake.log.update.length === 0, 'mismatch accepted');
    gid('pw2').value = 'correct horse battery';
    await env.run('savePassword()'); await sleep(40);
    const pwUp = fake.log.queries.filter(q => q.table === 'user_settings' && q.ops[0][0] === 'upsert' && q.ops[0][1].pw_set === true);
    ok(fake.log.update.length === 1 && fake.log.update[0].password === 'correct horse battery' && pwUp.length === 1 && pwUp[0].ops[0][1].user_id === uid2, 'password not saved: ' + JSON.stringify(fake.log.update));
    ok(env.run('PW_SET') && !/id="pwForm"/.test(env.main().innerHTML) && /class="crumb"|sec-h/.test(env.main().innerHTML), 'app did not render after setting the password');
    /* change password from the menu is the non-forced card */
    env.run('showSetPassword(false)');
    ok(/Change your password/.test(env.main().innerHTML) && /data-pw-cancel/.test(env.main().innerHTML), 'change-password card missing');
    env.run('PW_FORCE=false;renderSide();render()');
    await env.run('signOut()'); await sleep(40);
    console.log(`4. static+auth     sign-in screen (focus=email), OTP sent (shouldCreateUser=false), session -> loaded ${env.run('DATES.length')} briefs from table briefs + archive_index, settings pulled and upserted once (300ms debounce), feedback uploaded to ${up.path.replace(uid, '<uid>')} and inserted, sign out -> sign-in; views=${c.views} popouts=${c.popouts}`);
    console.log('   supabase calls: ' + [...new Set(fake.log.queries.map(q => q.table + ':' + q.ops.map(o => o[0]).join('.')))].join(', '));
  }

  /* 4b. a magic-link hash whose tokens cannot be verified lands on the card with a message (auth-link-04) */
  {
    const fake = fakeSupabase({ answer: () => ({ data: null, error: null }) });
    const env = makeEnv({ config: { apiBase: '', supabaseUrl: 'https://p.supabase.co', supabaseAnonKey: 'anon', requireAuth: true, mode: 'static' }, supabase: fake.lib });
    env.ctx.location.hash = '#access_token=bogus&refresh_token=bogus&type=magiclink';
    env.run(mainScript()); await env.run('booting||Promise.resolve()'); await sleep(60);
    ok(/id="signinForm"/.test(env.main().innerHTML) && !env.run('SESSION'), 'bogus token hash did not land on the sign-in card');
    ok(env.main().innerHTML.includes('<p id="signinStatus" class="st err">That sign-in link could not be verified. Request a new code.</p>'), 'bogus token hash message missing from the card');
    await sleep(60);
    ok(/could not be verified/.test(env.els.get('live').textContent), 'unverifiable link not announced');
    ok(!/bogus/.test(env.main().innerHTML + env.els.get('live').textContent), 'token leaked into the page');
    console.log('4b. bogus token hash: sign-in card shows "could not be verified"');
  }

  /* 5. motion (v1.6.0, Wrike reference): skeleton while loading, enter animation keyed to route and intent changes,
     FLIP glide fallback in a DOM without layout, popout close without an overlay element, busy buttons, sidebar
     accordion markup, toast leaving phase */
  {
    const env = await start();
    const { run, ctx, els } = env;
    ok(run('reducedMotion()') === false, 'reducedMotion() is not false without matchMedia');
    run("showLoading('Loading the brief archive…')");
    const sk = env.main().innerHTML;
    ok(/class="skel"/.test(sk) && /role="status"/.test(sk) && /class="spin"/.test(sk) && /Loading the brief archive/.test(sk), 'showLoading did not render the skeleton with a status line and spinner');
    ok((sk.match(/class="b"/g) || []).length >= 24 && /aria-hidden="true"/.test(sk), 'skeleton bars missing or not hidden from assistive tech');
    ok(run('lastViewKey') === null, 'showLoading did not reset the view key');
    ctx.location.hash = '#home'; run('render()');
    ok(els.get('main').classList.contains('enter'), 'first render did not add the enter class to #main');
    ok(run('lastViewKey') === 'home|' + (run('state.area') || '') + '|' + run('state.date') + '|' + (run('state.report') || ''), 'view key is ' + run('lastViewKey'));
    ok(/data-flip="area:/.test(env.main().innerHTML), 'area cards lack data-flip');
    run("myAreas=new Set(['perimeter']);state.tab='mine';flipRender()");
    const home = env.main().innerHTML;
    ok(/data-flip="item:/.test(home), 'flipRender fallback did not render item cards with data-flip');
    ok(/class="go" aria-hidden="true">open ↗</.test(home), 'item header lacks the hover-revealed open hint');
    ok(/class="sub"><div class="in">/.test(els.get('side').innerHTML), 'sidebar groups lack the accordion wrapper');
    /* a tab change marks the list for the enter animation once; the mark is cleared after the render */
    run("state.anim={kind:'tab',key:'tabs'};render()");
    ok(/class="secbody enter"/.test(env.main().innerHTML) && run('state.anim') === null, 'tab enter class not applied once');
    run('render()');
    ok(!/class="secbody enter"/.test(env.main().innerHTML), 'enter class leaked into the next render');
    /* expanding an item marks only that item's body */
    const id = run('BRIEFS[TODAY_S].items[0].item_id');
    ctx.location.hash = '#brief';
    run(`state.level.set('${id}',3);state.anim={kind:'expand',key:'${id}'};render()`);
    const br = env.main().innerHTML;
    ok((br.match(/class="xb enter"/g) || []).length === 1, 'expanded item body enter class');
    ok(/class="go" aria-hidden="true">expand ▾</.test(br), 'collapsed brief items lack the expand hint');
    /* popout close: the stub has no overlay element to animate, so it navigates straight back */
    ctx.location.hash = '#item-' + id; run('render()');
    ok(/role="dialog"/.test(els.get('ov').innerHTML), 'popout did not open');
    run('closeOv()');
    ok(ctx.location.hash === '#brief', 'closeOv did not return to the page hash, got ' + ctx.location.hash);
    /* busy buttons */
    const b = ctx.document.getElementById('busyProbe');
    run("setBusy(document.getElementById('busyProbe'),true)");
    ok(b.disabled === true && b.getAttribute('aria-busy') === 'true' && b.classList.contains('busy'), 'setBusy(on) state');
    run("setBusy(document.getElementById('busyProbe'),false)");
    ok(b.disabled === false && b.getAttribute('aria-busy') === null && !b.classList.contains('busy'), 'setBusy(off) state');
    /* toast: the leaving phase is a new object carrying the same token */
    run("setToast('hello','ok')");
    ok(/class="fbtoast ok"/.test(els.get('fbroot').innerHTML) && typeof run('fb.toast.token') === 'number', 'toast not rendered with a token');
    run('fb.toast={...fb.toast,leaving:true};fbRender()');
    ok(/class="fbtoast ok leaving"/.test(els.get('fbroot').innerHTML), 'toast leaving class not rendered');
    run('fb.toast=null;fbRender()');
    /* popout: the entrance plays for a new item only; a re-render while it is open keeps the plain class */
    ctx.location.hash = '#brief'; run('render()');
    ctx.location.hash = '#item-' + id; run('render()');
    ok(/class="ov enter"/.test(els.get('ov').innerHTML), 'popout entrance class missing on first render');
    run('render()');
    ok(/class="ov"/.test(els.get('ov').innerHTML) && !/ov enter/.test(els.get('ov').innerHTML), 'popout entrance replayed on re-render');
    /* a direct #item- link after the loader: the page behind the overlay is painted, not left as the skeleton */
    run('showLoading()');
    ok(/class="skel"/.test(env.main().innerHTML), 'skeleton not shown');
    run('render()');
    ok(!/class="skel"/.test(env.main().innerHTML) && /role="dialog"/.test(els.get('ov').innerHTML), 'skeleton left behind the popout');
    /* same-route re-renders do not re-add the enter class; a route change does */
    const mainEl = els.get('main'); let adds = 0; const origAdd = mainEl.classList.add; mainEl.classList.add = c => { if (c === 'enter') adds++; return origAdd(c); };
    ctx.location.hash = '#home'; run('render()'); run('render()'); run('render()');
    ok(adds === 1, `enter added ${adds} times for one route change and two re-renders`);
    ctx.location.hash = '#brief'; run('render()');
    ok(adds === 2, 'route change did not re-add enter');
    mainEl.classList.add = origAdd;
    /* FLIP with a measurable DOM: a hidden (zero-rect) card is new, a moved card glides, an unmoved card and a card
       inside an entering section are left alone */
    const mkEl = (key, rects, parentEnter) => { let i = 0; const cls = new Set(); const calls = []; return { dataset: { flip: key }, calls, classList: { add: c => cls.add(c), contains: c => cls.has(c), remove: c => cls.delete(c) }, parentElement: { closest: () => (parentEnter ? {} : null) }, getBoundingClientRect: () => rects[Math.min(i++, rects.length - 1)], animate: (kf, o) => { calls.push([kf[0].transform, o.duration]); } }; };
    const rect = (top, left, w = 100, h = 40) => ({ top, left, width: w, height: h, bottom: top + h, right: left + w });
    const hidden = mkEl('item:h', [rect(0, 0, 0, 0), rect(120, 10)]);
    const moved = mkEl('item:m', [rect(100, 10), rect(300, 10)]);
    const still = mkEl('item:s', [rect(400, 10), rect(400, 10)]);
    const carried = mkEl('item:c', [rect(500, 10), rect(700, 10)], true);
    const fakes = [hidden, moved, still, carried];
    const origQSA = ctx.document.querySelectorAll;
    ctx.document.querySelectorAll = sel => (sel === '[data-flip]' ? fakes : []);
    run('flipRender()');
    ctx.document.querySelectorAll = origQSA;
    ok(hidden.classList.contains('enter') && hidden.calls.length === 0, 'zero-rect card was not treated as new');
    ok(moved.calls.length === 1 && moved.calls[0][0] === 'translate(0px,-200px)' && moved.calls[0][1] === 220, 'moved card did not glide from its old slot: ' + JSON.stringify(moved.calls));
    ok(still.calls.length === 0 && !still.classList.contains('enter'), 'unmoved card was animated');
    ok(carried.calls.length === 0 && !carried.classList.contains('enter'), 'card inside an entering section was animated on its own');
    /* closeOv with an overlay element: leaving class first, hash after the delay; a navigation made meanwhile wins */
    const ovCls = new Set(); const fakeOv = { classList: { add: c => ovCls.add(c), contains: c => ovCls.has(c), remove: c => ovCls.delete(c) } };
    const origQS = ctx.document.querySelector;
    ctx.document.querySelector = sel => (sel === '#ov .ov' ? fakeOv : null);
    ctx.location.hash = '#home'; run('render()');
    ctx.location.hash = '#item-' + id; run('render()');
    run('closeOv()');
    ok(ovCls.has('leaving') && ctx.location.hash === '#item-' + id, 'closeOv did not fade before navigating');
    await sleep(200);
    ok(ctx.location.hash === '#home', 'closeOv did not navigate after the fade, hash ' + ctx.location.hash);
    ovCls.clear();
    ctx.location.hash = '#item-' + id; run('render()');
    run('closeOv()'); ctx.location.hash = '#item-other';
    await sleep(200);
    ok(ctx.location.hash === '#item-other' && run('ovClosing') === false, 'closeOv overrode a navigation made during its fade');
    ctx.document.querySelector = origQS;
    ctx.location.hash = '#home'; run('render()');
    ok(env.errors.length === 0, `motion console.error: ${env.errors.slice(0, 3).join(' | ')}`);
    console.log('5. motion          skeleton + status line, enter keyed to route/tab/expand, FLIP fallback, closeOv, busy buttons, accordion markup, toast leaving');
  }

  /* --- regressions: home-area --- */
  {
    const clone = o => JSON.parse(JSON.stringify(o));
    const cfg = { apiBase: '', mode: 'container' };
    const boot = async set => start({ config: cfg, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ briefs: clone(set) }) }) });
    const countEv = h => (h.match(/class="ev"/g) || []).length;
    const dayHeads = h => [...h.matchAll(/<div class="day">(?:Today · )?(\d{4}-\d{2}-\d{2})<\/div>/g)].map(m => m[1]);
    const env = await boot(briefs);
    env.ctx.location.hash = '#home'; env.run("state.tab='mine';state.streamAll=false;state.f.area=null;render()");
    let h = env.main().innerHTML;
    const keys = env.run('Object.keys(AREAS)');
    const pris = keys.map(k => env.run(`areaStats('${k}',BRIEFS[TODAY_S]).maxPri`));
    ok(pris.some(p => p !== 'none'), 'area priority: maxPri is always none');
    keys.forEach((k, i) => { if (env.run(`areaStats('${k}',BRIEFS[TODAY_S]).items.length`) && pris[i] === 'none') ok(false, `area ${k} has items but maxPri none`); });
    const exp = env.run('DATES.slice(-2)');
    ok(h.includes('today and the previous brief'), 'stream subtitle lacks "today and the previous brief"');
    const heads = dayHeads(h);
    ok(heads.length > 0 && heads.every(d => exp.includes(d)) && heads.includes(exp[1]), 'stream shows dates ' + heads.join(',') + ' expected within ' + exp.join(','));
    const short = countEv(h), m = h.match(/Show all 30 days \((\d+)\)/);
    ok(m && /Show all/.test(h), 'Show all button missing');
    env.run('state.streamAll=true;render()'); h = env.main().innerHTML;
    ok(m && countEv(h) === Number(m[1]), `Show all N=${m && m[1]} but rendered ${countEv(h)}`);
    ok(/data-streamless/.test(h) && />Show less</.test(h), 'Show less control missing');
    env.run('state.streamAll=false;render()');
    ok(countEv(env.main().innerHTML) === short, 'Show less did not restore short window');
    ok(/feeds n\/a/.test(h) && !/null|undefined|NaN/.test(h.slice(h.indexOf('class="health"'))), 'health strip: feeds n/a missing or null/NaN present');
    env.ctx.location.hash = '#area-nope'; env.run('state.area="nope";state.page="area";render()');
    ok(/href="#home"/.test(env.main().innerHTML) && /Unknown area/.test(env.main().innerHTML), 'unknown area has no link back to #home');
    env.run('state.f.tier=3;state.f.status="new"');
    env.ctx.location.hash = '#area-' + keys[0]; env.run(`state.area="${keys[0]}";state.page="area";render()`);
    ok(!/No items in this area today/.test(env.main().innerHTML) || !env.run('state.f.tier'), 'filtered empty area still says today');
    env.run('state.f.tier=null;state.f.status=null');
    const tabH = (env.ctx.location.hash = '#home', env.run("state.tab='mine';state.page='home';render()"), env.main().innerHTML);
    ok(/New today<span class="sr-only">, <\/span><span class="c">/.test(tabH) || /New today[^<]*<span class="c" aria-label/.test(tabH), 'tab badge has no separator for accessible name');
    ok(env.errors.length === 0, 'home-area console.error: ' + env.errors.slice(0, 2).join(' | '));

    const first = Object.keys(briefs)[0];
    const one = await boot({ [first]: briefs[first] });
    one.ctx.location.hash = '#home'; one.run("state.tab='mine';state.streamAll=false;state.f.area=null;render()");
    h = one.main().innerHTML;
    ok(!/NaN/.test(h), 'single brief: NaN in home markup');
    ok(countEv(h) > 0, 'single brief: stream is empty');
    ok(one.errors.length === 0, 'single brief console.error: ' + one.errors.slice(0, 2).join(' | '));
    ok(one.run('sparkline([3])').indexOf('NaN') < 0 && one.run('sparkline([])').indexOf('NaN') < 0, 'sparkline emits NaN for 0/1 values');

    const two = Object.keys(briefs).slice(0, 2);
    const tw = await boot({ [two[0]]: briefs[two[0]], [two[1]]: briefs[two[1]] });
    tw.ctx.location.hash = '#home'; tw.run("state.streamAll=false;render()");
    ok(countEv(tw.main().innerHTML) > 0 && !/NaN/.test(tw.main().innerHTML), 'two briefs: stream empty or NaN');

    /* area-rail-01: when the rail wraps under the items its Activity stream spans the full width */
    ok(/\.two\.wrap \.rail \.sec>\.stream\{[^}]*grid-column:1\/-1/.test(SRC), 'area-rail-01: the wrapped stream does not span the grid');
    console.log('3e. home-area      priority rail, stream window/Show less, feeds n/a, unknown area link, single-brief NaN');
  }
  /* --- end regressions: home-area --- */

  /* --- regressions: shell --- */
  {
    const fire = (env, type, ev) => (env.listeners['doc:' + type] || []).forEach(fn => fn(ev));
    const fakeTarget = (extra = {}) => Object.assign({ id: '', matches: () => false, hasAttribute: () => false, closest: () => null }, extra);
    const env = await start();
    const { ctx, run, els } = env;
    /* skip link: #main is not a route */
    ctx.location.hash = '#brief'; run('render()');
    const titleBefore = ctx.document.title;
    ctx.location.hash = '#main'; run('render()');
    ok(run('state.page') === 'brief' && ctx.document.title === titleBefore, `#main changed the page or title: ${run('state.page')} / ${ctx.document.title}`);
    ok(ctx.location.hash === '#brief', '#main was left as the hash: ' + ctx.location.hash);
    ok(ctx.__focused === 'main', 'skip link did not focus #main, focused ' + ctx.__focused);
    /* unknown hashes render Home and normalise to #home */
    ctx.location.hash = '#bogus'; run('render()');
    ok(ctx.location.hash === '#home' && run('state.page') === 'home', 'unknown hash not normalised: ' + ctx.location.hash);
    /* plural helper */
    ok(run("plural(1,'brief')") === 'brief' && run("plural(0,'brief')") === 'briefs' && run("plural(2,'day')") === 'days' && run("plural(2,'city','cities')") === 'cities' && run("plural(1,'city','cities')") === 'city', 'plural() is wrong');
    /* Escape closes the account menu and the drawer */
    run('state.umenu=true;renderUmenu()');
    fire(env, 'keydown', { key: 'Escape', target: fakeTarget(), preventDefault() {} });
    ok(run('state.umenu') === false && els.get('umenu').hidden === true, 'Escape did not close the account menu');
    ok(ctx.__focused === 'avatarBtn', 'Escape did not return focus to the avatar, focused ' + ctx.__focused);
    run('state.sideOpen=true;renderSide()');
    fire(env, 'keydown', { key: 'Escape', target: fakeTarget(), preventDefault() {} });
    ok(run('state.sideOpen') === false && els.get('menubtn').getAttribute('aria-expanded') === 'false', 'Escape did not close the drawer and reset aria-expanded');
    /* menu markup: roles, no placeholder copy, theme group does not reuse the chart class */
    run('renderUmenu()');
    const menu = els.get('umenu').innerHTML;
    ok(/role="menuitem"/.test(menu) && !/to come|Sign out<span class="c">later/.test(menu), 'menu roles or placeholder copy wrong');
    ok(/class="tseg"/.test(menu) && !/class="seg"/.test(menu), 'theme group still uses the chart .seg class');
    ok(/<button[^>]*disabled[^>]*>Sign in/.test(menu) && /Supabase/.test(menu), 'disabled Sign in entry with the Supabase explanation is missing');
    ok(!/wireframe/.test(require('fs').readFileSync(HTML, 'utf8')), 'footer still says wireframe');
    /* focus restore: key by id or data attribute, refocus after the render */
    ok(run("focusKey({id:'sideTgl',hasAttribute:()=>false,closest:()=>null})") === '#sideTgl', 'focusKey ignored the id');
    ok(run(`focusKey({id:'',hasAttribute:a=>a==='data-tab',getAttribute:()=>'new',closest:()=>null})`) === '[data-tab="new"]', 'focusKey ignored data-tab');
    ok(run("focusKey({id:'x',hasAttribute:()=>false,closest:s=>s==='#ov'?{}:null})") === null, 'focusKey kept an element inside the popout');
    {
      let focused = 0; const target = { hasAttribute: () => false, focus: o => { focused++; ctx.document.activeElement = target; ok(o && o.preventScroll === true, 'restore focus lacks preventScroll'); } };
      const q0 = ctx.document.querySelector;
      ctx.document.activeElement = { id: '', hasAttribute: a => a === 'data-tab', getAttribute: () => 'new', closest: () => null };
      ctx.document.querySelector = sel => (sel === '[data-tab="new"]' ? target : null);
      ctx.location.hash = '#home'; run('render()');
      ctx.document.querySelector = q0; ctx.document.activeElement = null;
      ok(focused === 1, 'render did not restore focus to the home tab, calls ' + focused);
    }
    ok(env.errors.length === 0, 'shell console.error: ' + env.errors.slice(0, 2).join(' | '));

    /* single brief: ribbon grammar and the disabled neighbours */
    const first = Object.keys(briefs)[0];
    const one = await start({ config: { apiBase: '' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ briefs: { [first]: JSON.parse(JSON.stringify(briefs[first])) } }) }) });
    ok(one.els.get('ribbon').textContent === 'v1.6.0 · 1 brief · container', 'single-brief ribbon is "' + one.els.get('ribbon').textContent + '"');
    one.ctx.location.hash = '#home'; one.run('render()');
    ok(!/1 briefs/.test(one.main().innerHTML) && /Active · 1 brief</.test(one.main().innerHTML), 'single-brief Home still says "1 briefs"');
    one.ctx.location.hash = '#brief'; one.run('render()');
    const bh = one.main().innerHTML;
    ok((bh.match(/<span class="btn sm" aria-disabled="true"/g) || []).length === 2 && !/href="#"/.test(bh), 'disabled neighbours are not aria-disabled spans');

    /* Reset clears everything the page stores */
    env.run("setTheme('dark');fb.list=[{id:1}];store.set('feedback',fb.list);store.set('coll',['x']);store.set('sidecol',true);myAreas=new Set(['identity']);store.set('my',['identity'])");
    ok(ctx.localStorage.getItem('aegis4-theme') === 'dark', 'precondition: theme not stored');
    fire(env, 'click', { target: fakeTarget({ id: 'resetBtn' }) });
    ok(ctx.localStorage.getItem('aegis4-theme') === null, 'Reset kept the theme');
    ok(run('fb.list.length') === 0 && run("store.get('feedback',[]).length") === 0, 'Reset kept the feedback list');
    ok(run("store.get('coll',[]).length") === 0 && run("store.get('sidecol',false)") === false && run('myAreas.size') === 0, 'Reset kept collapsed sections, sidebar state or areas');
    ok(/Reset everything saved in this browser/.test(els.get('umenu').innerHTML), 'Reset button label not updated');

    /* sidebar group state persists, Space activates a card, the collapse control is visible to the mouse */
    {
      const clickGrp = (open) => { const g = { dataset: { grp: 'areas' }, getAttribute: () => String(open), setAttribute() {}, closest: () => null, querySelector: () => null };
        fire(env, 'click', { target: fakeTarget({ closest: s => (s === '[data-grp]' ? g : null) }) }); };
      const saved = () => run("JSON.stringify(store.get('sidegrp',[]))");
      clickGrp(false);
      ok(saved() === '["areas"]', 'side-group-persist: opening a group did not store it, got ' + saved());
      const re = makeEnv(); re.ctx.localStorage.setItem('aegis4-anon-sidegrp', ctx.localStorage.getItem('aegis4-anon-sidegrp'));
      re.run(mainScript()); await re.run('booting||Promise.resolve()'); await sleep(40);
      ok(re.run("state.side.has('areas')") === true, 'side-group-persist: the stored group was not open after a reload');
      ctx.location.hash = '#area-perimeter'; run('render()');
      ok(/class="grp open"><button class="hd2" data-grp="areas"/.test(els.get('side').innerHTML), 'side-group-persist: the group is not open after the area route');
      clickGrp(true);
      ok(saved() === '[]', 'side-group-persist: closing a group left it stored, got ' + saved());
      ctx.location.hash = '#brief'; run('render()');
      ok(/class="grp open"><button class="hd2" data-grp="briefs"/.test(els.get('side').innerHTML), 'side-group-persist: open-on-route broke for Briefs');
      run("store.set('sidegrp',['nope',3])"); run('state.side=loadSideGroups()');
      ok(run('state.side.size') === 0, 'side-group-persist: junk in storage was accepted');

      let clicks = 0, prevented = 0;
      const card = fakeTarget({ hasAttribute: a => a === 'data-expand', dataset: { expand: 'x' }, click: () => { clicks++; } });
      fire(env, 'keydown', { key: ' ', target: card, preventDefault: () => { prevented++; } });
      ok(clicks === 1 && prevented >= 1, 'kbd-space: Space on a card clicked ' + clicks + ' times, prevented ' + prevented);
      fire(env, 'keydown', { key: 'Enter', target: card, preventDefault: () => {} });
      ok(clicks === 2, 'kbd-space: Enter stopped working');
      const plain = fakeTarget({ hasAttribute: () => false, click: () => { clicks++; } });
      fire(env, 'keydown', { key: ' ', target: plain, preventDefault: () => {} });
      ok(clicks === 2, 'kbd-space: Space on a non-card element clicked it');

      ok(/<button id="sideTgl"[^>]*title="Collapse sidebar"[^>]*><svg/.test(els.get('side').innerHTML), 'side-collapse-mouse: the toggle has no icon or tooltip');
      ok(/@media \(min-width:901px\)\{[^@]*\.side \.tgl button\{[^}]*position:static/.test(SRC), 'side-collapse-mouse: no rule shows the toggle above 900px');
      ok(/\.side \.lnk \.dotc\{[^}]*text-overflow:ellipsis/.test(SRC), 'side-trends-badge-truncate: the link badge is not truncated');
      ok(/@media \(max-width:600px\)\{[^}]*\.tabs\{[^}]*flex-wrap:wrap/.test(SRC), 'home-tabs-overflow-390: tabs do not wrap under 600px');
    }
    console.log('6. shell           skip link, hash normalise, Escape, menu roles/copy, focus restore, plural, disabled neighbours, full reset');
  }
  /* --- end regressions: shell --- */

  /* --- regressions: trends --- */
  {
    const kpi = (html, label) => { const m = html.match(new RegExp('>' + label + '</span><div class="v"><span class="n">([0-9,.]+)<')); return m ? Number(m[1].replace(/,/g, '')) : null; };
    const selectTag = (html, key) => (html.match(new RegExp('<select[^>]*data-f="' + key + '"[^>]*>')) || [''])[0];
    const sweep = async (label, cfg) => {
      const env = await start(cfg);
      const ids = env.run('REPORTS.map(r=>r.id)');
      [7, 14, 30].forEach(p => ids.forEach(id => {
        env.ctx.location.hash = '#trends-' + id;
        try { env.run(`state.f.period=${p};state.sel=null;state.f.tarea=null;render()`); } catch (e) { ok(false, `${label} ${id}/${p} threw: ${e.message}`); return; }
        ok(!/NaN|undefined/.test(env.main().innerHTML), `${label} ${id} at ${p}: NaN or undefined in the rendered report`);
      }));
      ['#home', '#brief'].concat(env.run('Object.keys(AREAS)').map(k => '#area-' + k)).forEach(h => {
        env.ctx.location.hash = h; env.run('render()');
        ok(!/NaN/.test(env.main().innerHTML), `${label} ${h}: NaN in the rendered page`);
      });
      ok(env.errors.length === 0, `${label} trends console.error: ${env.errors.slice(0, 3).join(' | ')}`);
      return env;
    };
    const bigEnv = await sweep('trends/container', { config: { apiBase: '', mode: 'container' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify(briefs)), manifest: { retained: Object.keys(briefs) } }) }) });
    const firstKey = Object.keys(briefs)[0];
    const singleEnv = await sweep('trends/single', { config: { apiBase: '' }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify({ [firstKey]: briefs[firstKey] })) }) }) });

    const env = bigEnv;
    /* catalog "New items" tile and the New vs dropped report share one definition */
    [7, 14, 30].forEach(p => {
      env.ctx.location.hash = '#trends'; env.run(`state.f.period=${p};state.sel=null;state.f.tarea=null;render()`);
      const cat = kpi(env.main().innerHTML, 'New items');
      env.ctx.location.hash = '#trends-newres'; env.run('render()');
      const rep = kpi(env.main().innerHTML, 'New items');
      ok(cat !== null && cat === rep, `catalog New items (${cat}) differs from the New vs dropped report (${rep}) at period ${p}`);
    });
    env.ctx.location.hash = '#trends'; env.run('state.f.period=7;render()');
    ok(/first appearances/.test(env.main().innerHTML), 'catalog New items tile does not say it counts first appearances');
    /* source contribution: the bar value equals the selection count at period 7 */
    env.ctx.location.hash = '#trends-sources'; env.run('state.f.period=7;state.f.tarea=null;state.sel=null;render()');
    const top = env.run('(()=>{const m={};lifeIn(periodDays()).forEach(L=>L.sources.forEach(s=>m[s]=(m[s]||0)+1));return Object.entries(m).sort((a,b)=>b[1]-a[1])[0]})()');
    env.run(`state.sel=${JSON.stringify(top[0])};render()`);
    const mm = env.main().innerHTML.match(/(\d+) matching items?/);
    ok(mm && Number(mm[1]) === top[1], `source selection lists ${mm && mm[1]} items but the bar says ${top[1]} at period 7`);
    /* Items by area uses short labels */
    env.ctx.location.hash = '#trends-byarea'; env.run('state.sel=null;state.f.period=30;render()');
    const labels = [...env.main().innerHTML.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
    ['Identity', 'Endpoints', 'Network', 'Email', 'Web/LMS', 'Cloud', 'Supply', 'Research', 'AI'].forEach(n => ok(labels.includes(n), `byarea axis lacks short label ${n}`));
    ok(!labels.some(l => /&amp;|Chain|Systems/.test(l)), 'byarea axis still prints full area names');
    /* controls that a report ignores are disabled with an explanation */
    const ignoring = { movers: ['period'], actionsage: ['period'], quiet: ['period', 'tarea'], byarea: ['tarea'] };
    Object.entries(ignoring).forEach(([id, keys]) => {
      env.ctx.location.hash = '#trends-' + id; env.run('state.sel=null;render()');
      keys.forEach(k => { const t = selectTag(env.main().innerHTML, k); ok(t === '' || (/disabled/.test(t) && /title="/.test(t)), `${id}: ${k} select is enabled although the report ignores it`); });
    });
    env.ctx.location.hash = '#trends-newres'; env.run('render()');
    ok(!/disabled/.test(selectTag(env.main().innerHTML, 'period')) && selectTag(env.main().innerHTML, 'tarea') !== '', 'newres lost its Period/Area controls');
    /* movers with an area that has no items today shows an explicit empty state */
    env.ctx.location.hash = '#trends-movers';
    env.run("state.f.tarea=Object.keys(AREAS).find(k=>!BRIEFS[TODAY_S].items.some(i=>i.areas.includes(k)))||null;render()");
    if (env.run('state.f.tarea')) ok(/nothing to rank/.test(env.main().innerHTML), 'movers has no empty state for an area without items');
    /* the Trends area filter does not leak into the brief */
    env.run('state.f.tarea=null'); env.ctx.location.hash = '#brief'; env.run('render()');
    const base = env.main().innerHTML.match(/All items<span class="cnt">\((\d+)\)/);
    env.run("state.f.tarea='perimeter'"); env.run('render()');
    const after = env.main().innerHTML.match(/All items<span class="cnt">\((\d+)\)/);
    ok(base && after && base[1] === after[1], `Trends area filter changed the brief item count (${base && base[1]} -> ${after && after[1]})`);
    env.ctx.location.hash = '#trends-newres'; env.run('state.f.tarea=null;render()'); const allN = kpi(env.main().innerHTML, 'New items');
    env.run("state.f.tarea='perimeter';render()");
    ok(kpi(env.main().innerHTML, 'New items') !== allN, 'Trends area filter had no effect on the New vs dropped report');
    env.run('state.f.tarea=null');
    /* quiet tooltip wording */
    env.ctx.location.hash = '#trends-quiet'; env.run('state.sel=null;render()');
    ok(/days since Tier 1/.test(env.main().innerHTML), 'quiet tooltip does not say "days since Tier 1"');
    /* --- second audit pass --- */
    const NOPREV = 'no previous period in the archive';
    const countOf = (html, re) => (html.match(re) || []).length;
    const goto = (hash, code) => { env.ctx.location.hash = hash; env.run((code ? code + ';' : '') + 'render()'); return env.main().innerHTML; };
    const goto2 = (e, hash) => { e.ctx.location.hash = hash; e.run('state.f.period=30;state.sel=null;render()'); return e.main().innerHTML; };
    const RESET = 'state.sel=null;state.selAll=null;state.f.tarea=null;state.f.period=30';
    /* summary tiles: the "no previous period" note appears once, and the tile row is a balanced grid */
    const cat30 = goto('#trends', RESET);
    ok(countOf(cat30, new RegExp(NOPREV, 'g')) === 1, `catalog at period 30 repeats "${NOPREV}" ${countOf(cat30, new RegExp(NOPREV, 'g'))} times`);
    const kc = cat30.match(/class="kpis"[^>]*--kc:(\d+)/), tiles = countOf(cat30, /<div class="kpi">/g);
    ok(kc && tiles % Number(kc[1]) === 0 && Number(kc[1]) <= 5, `summary tiles (${tiles}) are not a balanced grid (columns ${kc && kc[1]})`);
    ['newres', 'recentnew', 't1cal'].forEach(id => { const h = goto('#trends-' + id, RESET); ok(countOf(h, new RegExp(NOPREV, 'g')) <= 1, `${id} repeats the no-previous-period note per tile`); });
    /* exposure age: a day with no day counts is a gap, not 0.0, and the series names agree */
    const real = env.run('HAS_REAL');
    const noCountDays = env.run("DATES.filter(d=>!BRIEFS[d].exposure||!BRIEFS[d].exposure.some(r=>r.days!=null&&r.state!=='mitigated'))");
    const avg = goto('#trends-avgage', RESET);
    if (real) {
      ok(noCountDays.length > 0, 'fixture has no day without exposure day counts, avgage gap test is vacuous');
      noCountDays.forEach(d => {
        const row = (avg.match(new RegExp('<tr><td>' + d + '</td>(.*?)</tr>')) || [])[1] || '';
        ok(row && !/>0\.0</.test(row) && /<td>–<\/td>/.test(row), `avgage table shows ${/>0\.0</.test(row) ? '0.0' : 'no dash'} for ${d}`);
        const tip = avg.match(new RegExp('data-day="' + d + '"[^>]*data-tip="([^"]*)"'));
        ok(tip && /no day counts/.test(tip[1]), `avgage tooltip for ${d} does not say the day has no day counts`);
      });
      ok(/class="gap-pt"/.test(avg), 'avgage chart has no gap marker for the missing day');
    }
    const names = real ? ['Avg item age', 'Avg exposure age'] : ['Avg item age', 'Avg action age'];
    const legend = (avg.match(/<div class="legend">(.*?)<\/div>/) || [])[1] || '', thead = (avg.match(/<thead>(.*?)<\/thead>/) || [])[1] || '';
    names.forEach(n => {
      ok(legend.includes(n), `avgage legend lacks series name "${n}"`);
      ok(thead.includes('>' + n + '<'), `avgage table lacks series name "${n}"`);
      ok(avg.includes('&quot;l&quot;:&quot;' + n + '&quot;'), `avgage tooltip lacks series name "${n}"`);
    });
    ok(!real || !/Actions<\/th>/.test(thead), 'avgage table still has an "Actions" column for the exposure register');
    /* Tier 1 calendar: one gap marker per calendar gap, tooltips on cells; movers rows too */
    [30, 14, 7].forEach(p => {
      const h = goto('#trends-t1cal', RESET + ';state.f.period=' + p);
      const want = env.run("periodDays().filter((d,i)=>i&&(Date.parse(d)-Date.parse(periodDays()[i-1]))/864e5>1).length");
      ok(countOf(h, /<g class="gap"/g) === want, `t1cal period ${p}: ${countOf(h, /<g class="gap"/g)} gap markers for ${want} calendar gaps`);
      if (p === 30) { ok(/6 days without a brief/.test(h), 't1cal gap marker lacks the "6 days without a brief" title'); ok(/1 day without a brief/.test(h), 't1cal gap marker lacks the singular title'); }
      const cells = countOf(h, /<g class="clk[^"]*" data-day=/g), tipped = countOf(h, /<g class="clk[^"]*" data-day="[^"]*"[^>]*data-tip="/g);
      ok(cells > 0 && tipped === cells, `t1cal period ${p}: only ${tipped} of ${cells} cells carry data-tip`);
      ok(/<div class="ctip">/.test(h), 't1cal has no tooltip container');
    });
    const mv = goto('#trends-movers', RESET), mrows = countOf(mv, /<g class="clk[^"]*" data-key=/g);
    ok(mrows > 0 && countOf(mv, /<g class="clk[^"]*" data-key="[^"]*"[^>]*data-tip="/g) === mrows && /<div class="ctip">/.test(mv), `movers: ${countOf(mv, /data-tip="/g)} tooltips for ${mrows} rows`);
    /* selection list is capped at 40 cards with a Show all button */
    goto('#trends-byarea', RESET);
    const big = env.run("Object.keys(AREAS).map(k=>[k,Object.values(IDX.life).filter(x=>x.areas.includes(k)&&x.days.some(dd=>periodDays().includes(dd))).length]).sort((a,b)=>b[1]-a[1])[0]");
    const capped = goto('#trends-byarea', `state.sel=${JSON.stringify(big[0])};state.selAll=null`);
    ok(big[1] > 40, `fixture has no area with more than 40 items (${big[1]})`);
    ok(countOf(capped, /<article class="item/g) === 40, `selection renders ${countOf(capped, /<article class="item/g)} cards, expected 40`);
    ok(new RegExp(`data-selall[^>]*>Show all ${big[1]}<`).test(capped) && new RegExp(`Showing 40 of ${big[1]} matching items`).test(capped), 'selection lacks the Show all button or the "Showing 40 of N" count');
    const full = goto('#trends-byarea', 'state.selAll=state.sel');
    ok(countOf(full, /<article class="item/g) === big[1] && !/data-selall/.test(full), `Show all renders ${countOf(full, /<article class="item/g)} cards, expected ${big[1]}`);
    goto('#trends-byarea', RESET);
    /* every report with clickable marks says what a click does */
    ['newres', 'avgage', 'byarea', 'recentnew', 'restime', 't1cal', 'movers', 'sources', 'actionsage', 'quiet', 'cve'].forEach(id => {
      const h = goto('#trends-' + id, RESET), lg = (h.match(/<div class="legend">(.*?)<\/div>/g) || []).join(' ') + (id === 'cve' ? h : '');
      ok(/click an? (bar|day|column|cell|row|point) to /.test(lg), `${id}: no click hint in the legend`);
    });
    ['byarea', 'quiet'].forEach(id => ok(/double-click to open the area/.test(goto('#trends-' + id, RESET)), `${id}: no double-click hint`));
    /* charts sit in a scroll wrapper with a cue; CVE columns are classed for phones */
    ['newres', 'byarea', 't1cal', 'movers'].forEach(id => { const h = goto('#trends-' + id, RESET); ok(/class="cscroll"/.test(h) && /class="scrollcue"/.test(h), `${id}: chart is not wrapped in .cscroll with a scroll cue`); });
    const cve = goto('#trends-cve', RESET);
    ok(countOf(cve, /<th class="hm"/g) >= 3 && /<td class="cvet" title="/.test(cve) && /<td class="mono nw"/.test(cve), 'cve table lacks the phone column classes or title attributes');
    ok(/The first archived brief counts every item as new./.test(goto('#trends-newres', RESET)), 'newres lacks the first-brief footnote');
    /* a lone source keeps its full name on the axis */
    ok(/>Vendor advisory</.test(goto('#trends-sources', RESET)), 'sources axis truncates the only source label');
    /* catalog thumbnails come from the archive */
    const thumbs = html => [...html.matchAll(/<div class="th">(.*?)<\/div>/g)].map(m => [...m[1].matchAll(/height:([^p]*)px/g)].map(x => x[1]));
    const tb = thumbs(goto('#trends', RESET)), ts = thumbs(goto2(singleEnv, '#trends'));
    ok(tb.length === 11 && tb.every(a => a.length >= 2 && a.length <= 10 && a.every(v => /^\d+(\.\d+)?$/.test(v))), 'catalog thumbnails are missing, too long or contain NaN');
    ok(tb.filter(a => new Set(a).size > 1).length >= 9, 'catalog thumbnails are flat; they should follow the data');
    const idxs = env.run('REPORTS.map(r=>r.id)');
    ['newres', 't1cal'].forEach(id => {
      const counts = env.run(id === 'newres' ? "DATES.slice(-10).map(d=>IDX.events.filter(e=>e.date===d&&e.type==='new').length)" : "DATES.slice(-10).map(d=>BRIEFS[d].items.filter(i=>i.tier===1).length)");
      const h = tb[idxs.indexOf(id)].map(Number);
      ok(counts.length === h.length && counts.every((c, i) => (c === Math.max(...counts)) === (h[i] === Math.max(...h)) && (c === 0) === (h[i] === 0)), `${id} thumbnail does not follow its archive series ${counts} vs ${h}`);
    });
    ['newres', 'avgage', 'recentnew', 't1cal', 'cve'].forEach(id => ok(new Set(ts[idxs.indexOf(id)]).size === 1, `${id} thumbnail with one brief is not a flat line`));
    ok(ts.every(a => a.every(v => /^\d+(\.\d+)?$/.test(v))), 'single-brief thumbnails contain NaN');
    console.log('6. trends          every report x 7/14/30 NaN-free in container and single-brief data, counts agree, short labels, controls, filter isolation');
  }
  /* --- end regressions: trends --- */

  /* --- regressions: archive-search-feedback --- */
  {
    const env = await start();
    const { run, ctx, els } = env;
    /* archive rows are keyboard reachable links */
    const arch = run('renderArchive()');
    const rows = arch.match(/<tr class="rowlink"[^>]*>/g) || [];
    ok(rows.length > 0 && rows.every(r => /tabindex="0"/.test(r) && /role="link"/.test(r) && /aria-label="Open brief \d{4}-\d{2}-\d{2}"/.test(r)), 'archive rows lack tabindex/role/aria-label');
    /* search results: listbox options, capped list says how many more */
    const q = ctx.document.getElementById('q');
    q.value = 'cve-'; ctx.document.activeElement = q;
    run('renderSearch()');
    const sres = els.get('sres');
    ok(!sres.hidden && /role="option"/.test(sres.innerHTML) && /id="sr-0"/.test(sres.innerHTML), 'search rows are not role="option"');
    ok(sres.getAttribute('role') === 'listbox' && q.getAttribute('role') === 'combobox', 'search box/list lack combobox/listbox roles');
    const total = run("searchMatches('cve-').length");
    if (total > 8) ok(new RegExp(`${total - 8} more, keep typing`).test(sres.innerHTML), 'capped search did not say how many more');
    run('searchChoose(0)');
    ok(sres.hidden === true && /^#item-/.test(ctx.location.hash), 'choosing a search result did not close the dropdown and open the item');
    /* search-area-name-68: an area name or key returns that area's items, tagged, today's first */
    {
      const ak = run("Object.keys(AREAS).find(k=>activeItems().some(i=>i.areas.includes(k)&&!i._carried)&&activeItems().some(i=>i.areas.includes(k)&&i._carried))") || run("Object.keys(AREAS)[0]");
      const an = run("AREAS['"+ak+"'].name");
      for (const qs of [an, an.toLowerCase(), ak, an.slice(0, 4)]) {
        const rows = run("searchMatches("+JSON.stringify(qs)+")");
        const tagged = rows.filter(r => r.inArea);
        ok(rows.length > 0, 'search-area-name-68: "' + qs + '" found nothing');
        if (qs === an) {
          ok(tagged.length > 0 && tagged.every(r => r.inArea === an), 'search-area-name-68: rows not tagged with the area name');
          const firstOld = tagged.findIndex(r => r.last_seen !== run('TODAY_S'));
          ok(firstOld < 0 || tagged.slice(firstOld).every(r => r.last_seen !== run('TODAY_S')), 'search-area-name-68: today items do not come first');
          ok(rows.slice(0, rows.length - tagged.length).every(r => !r.inArea), 'search-area-name-68: title matches do not rank first');
        }
      }
      ok(run("searchMatches('zzzz-no-such')").length === 0, 'search-area-name-68: nonsense matched');
      q.value = an; ctx.document.activeElement = q; run('renderSearch()');
      ok(sres.innerHTML.includes('in ' + an.replace(/&/g, '&amp;')), 'search-area-name-68: the result row lacks "in <area>"');
      q.value = 'cve-'; run('renderSearch()');
    }
    ctx.location.hash = '#home'; run('render()');
    /* feedback: skip message, saved toast, timestamp format */
    run('fbStart()'); run('fbSkip()');
    ok(/No screenshot attached\. The description still saves\./.test(els.get('fbroot').innerHTML) && !/capture library not loaded/.test(els.get('fbroot').innerHTML), 'skip message wrong');
    run('fbSave()');
    const root = els.get('fbroot').innerHTML;
    ok(/class="fbtoast ok"/.test(root) && /Feedback saved \(1 in this browser\)/.test(root) && /data-toastx/.test(root), 'save did not show the toast: ' + root);
    run('fb.toast=null;fbRender()');
    const when = run("fmtWhen('2026-10-15T13:04:05.678Z')");
    ok(typeof when === 'string' && !/T/.test(when) && !/\.678/.test(when) && /2026|26/.test(when), 'timestamp format: ' + when);
    ok(run("fmtWhen('not a date')") === 'not a date', 'fmtWhen did not fall back for a bad date');
    run('fb.mode="list";fbRender()');
    ok(/title="2026-|title="\d{4}-/.test(els.get('fbroot').innerHTML), 'list lacks the ISO value in a title attribute');
    ok(env.errors.length === 0, `archive-search-feedback console.error: ${env.errors.slice(0, 3).join(' | ')}`);
    console.log('6. archive/search/feedback  row a11y, listbox, more hint, skip text, saved toast, timestamps');
  }
  /* --- end regressions: archive-search-feedback --- */

  /* --- regressions: brief-item --- */
  {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify(briefs)), manifest: { retained: Object.keys(briefs) } }) });
    const env = await start({ config: { apiBase: '', mode: 'container' }, fetchImpl });
    const { run, ctx, els } = env;
    const go = hash => { ctx.location.hash = hash; run('render()'); };
    const multi = run("Object.keys(IDX.life).find(id=>IDX.life[id].days.length>=2)");
    ok(!!multi, 'brief-item: no multi-observation item in the container data');
    /* trajectory returns its svg, and no popout shows a bare undefined/NaN/null */
    const traj = run(`trajectory(IDX.life['${multi}'])`);
    ok(typeof traj === 'string' && /<svg[^>]*aria-label="Score trajectory"/.test(traj), 'brief-item: trajectory() did not return the svg string');
    go('#item-' + multi);
    ok(els.get('ov').innerHTML.includes('aria-label="Score trajectory"'), 'brief-item: popout lacks the trajectory svg');
    const strip = h => h.replace(/<[^>]+>/g, ' ');
    const bad = run('Object.keys(IDX.life)').filter(id => { go('#item-' + id); return /\b(undefined|NaN|null)\b/.test(strip(els.get('ov').innerHTML)); });
    ok(bad.length === 0, 'brief-item: popouts show undefined/NaN/null: ' + bad.slice(0, 3).join(','));
    /* timeline: same-day observations merge into one icon; the later tier wins and escalation is kept */
    const tl = run(`(()=>{const L=JSON.parse(JSON.stringify(IDX.life['${multi}']));const d0=L.days[0],d1=L.days.find(d=>d!==d0);L.days=[d0,d0,d1];L.tiers=[2,1,3];L.scores=[40,60,50];L.escDays=[d0];
      return timeline(L,itemAny('${multi}').it)})()`);
    const icons = tl.match(/class="ev [^"]*"/g).filter(c => !/cve/.test(c));
    ok(icons.length === 2, 'brief-item: duplicate same-day observations produced ' + icons.length + ' icons, expected 2');
    ok(/ev [^"]*t1 esc/.test(icons[0]), 'brief-item: merged icon did not take the later tier and keep escalation: ' + icons[0]);
    ok(/class="tl2wrap"[^>]*tabindex="0"/.test(tl), 'brief-item: timeline wrapper is not a focusable scroll region');
    /* bad brief hash: notice, today rendered, hash normalised */
    go('#brief-2026-01-01');
    ok(env.main().innerHTML.includes('No brief for 2026-01-01; showing today') && ctx.location.hash === '#brief' && run('state.date') === run('TODAY_S'), 'brief-item: bad date did not show the notice and normalise the hash (hash ' + ctx.location.hash + ')');
    run('render()');
    ok(env.main().innerHTML.includes('No brief for 2026-01-01'), 'brief-item: notice lost on re-render');
    go('#home'); go('#brief');
    ok(!env.main().innerHTML.includes('No brief for'), 'brief-item: notice survived navigating away');
    /* context open state follows the entry text, not its position */
    const pair = run(`(()=>{const ds=DATES.filter(d=>BRIEFS[d].context&&BRIEFS[d].context.geopolitical&&BRIEFS[d].context.geopolitical.length);for(let i=0;i<ds.length;i++)for(let j=0;j<ds.length;j++){const a=BRIEFS[ds[i]].context.geopolitical,b=BRIEFS[ds[j]].context.geopolitical;if(a[0].t!==b[0].t&&!b.some(x=>x.t===a[0].t))return [ds[i],ds[j],a[0].t]}return null})()`);
    ok(!!pair, 'brief-item: no date pair with differing first context entries');
    if (pair) {
      go('#brief-' + pair[0]);
      const key = (env.main().innerHTML.match(/data-ctx="([^"]+)"/) || [])[1];
      const keyText = key && key.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      ok(!!key && keyText.includes(pair[2]), 'brief-item: context key is not derived from the entry text: ' + key);
      run(`state.ctx.add(${JSON.stringify(keyText)})`);
      run('render()');
      ok(/<li class="open">/.test(env.main().innerHTML), 'brief-item: opened context entry is not open after render');
      go('#brief-' + pair[1]);
      ok(!/<li class="open">/.test(env.main().innerHTML), 'brief-item: opening a context entry carried to a different entry on another date');
      go('#brief-' + pair[0]);
      ok(/<li class="open">/.test(env.main().innerHTML), 'brief-item: context entry lost its open state on return to its date');
    }
    /* filters reset when the brief date changes, and persist on a re-render of the same date */
    go('#brief');
    run('state.f.tier=3;state.f.status="new";state.f.area="perimeter"');
    run('render()');
    ok(run('state.f.tier') === 3, 'brief-item: filters cleared by a same-date re-render');
    go('#brief-' + run('DATES[DATES.length-2]'));
    /* tier and status belong to one date's list and reset; the area filter is shared with the Home stream and stays */
    ok(run('state.f.tier') === null && run('state.f.status') === null, 'brief-item: tier/status filters carried to another date');
    ok(run('state.f.area') === 'perimeter', 'brief-item: the shared area filter was cleared by a date change');
    /* direct #item- load paints the page beneath the overlay */
    run("document.getElementById('main').innerHTML=''");
    go('#item-' + multi);
    ok(/Daily brief/.test(env.main().innerHTML) && /role="dialog"/.test(els.get('ov').innerHTML), 'brief-item: direct #item- load left #main empty beneath the overlay');
    run('closeOv()');
    ok(/^#brief/.test(ctx.location.hash), 'brief-item: closing a direct item load did not land on a brief, got ' + ctx.location.hash);
    /* copy buttons: a rejecting clipboard falls back to selecting the value and labels the button "select" for 1.5 s */
    const btn = { textContent: 'copy', dataset: { copy: 'abc' }, parentElement: { firstChild: {}, lastChild: {} } };
    let selected = 0;
    ctx.document.createRange = () => ({ selectNodeContents() {}, setEndBefore() {} });
    ctx.getSelection = () => ({ removeAllRanges() {}, addRange() { selected++; } });
    ctx.navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) };
    ctx.__btn = btn; run('copyValue(__btn,"abc")');
    await sleep(60);
    ok(btn.textContent === 'select' && selected === 1, 'brief-item: rejected clipboard did not fall back to select (label ' + btn.textContent + ', selections ' + selected + ')');
    await sleep(1600);
    ok(btn.textContent === 'copy', 'brief-item: copy label not restored after the fallback');
    ctx.navigator.clipboard = { writeText: () => Promise.resolve() };
    run('copyValue(__btn,"abc")');
    await sleep(60);
    ok(btn.textContent === 'copied', 'brief-item: successful copy label is ' + btn.textContent);
    await sleep(1600);
    ok(btn.textContent === 'copy', 'brief-item: copy label not restored after success');
    ctx.navigator.clipboard = undefined;
    run('copyValue(__btn,"abc")');
    await sleep(60);
    ok(btn.textContent === 'select', 'brief-item: a missing clipboard API did not fall back to select');
    await sleep(1600);
    ok(env.errors.length === 0, 'brief-item: console.error ' + env.errors.slice(0, 3).join(' | '));
    console.log('6. brief-item      trajectory svg, no undefined/NaN/null, timeline merge, bad-date notice, ctx key by text, filters reset per date, direct item load, copy fallback');
  }
  /* --- end regressions: brief-item --- */

  /* --- regressions: security --- */
  {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify(briefs)), manifest: { retained: Object.keys(briefs) } }) });
    const env = await start({ config: { apiBase: '', mode: 'container' }, fetchImpl });
    const { run, ctx } = env;
    /* a context bullet title from the brief must not be able to break out of the data-ctx attribute (the key is built from it) */
    const Q = 'String.fromCharCode(34)';
    run(`BRIEFS[TODAY_S].context.geopolitical=[{t:'x'+${Q}+' onfocus='+${Q}+'alert(1)',d:'d',w:'w'}].concat(BRIEFS[TODAY_S].context.geopolitical||[])`);
    ctx.location.hash = '#brief'; run('render()');
    const html = env.main().innerHTML;
    ok(!/data-ctx="geo:x" onfocus=/.test(html), 'security: a context bullet title breaks out of the data-ctx attribute');
    ok(/data-ctx="geo:x&quot; onfocus=&quot;alert\(1\)"/.test(html), 'security: data-ctx is not entity-escaped');
    ok(env.errors.length === 0, 'security console.error: ' + env.errors.slice(0, 2).join(' | '));
    console.log('7. security        brief content cannot break out of data-ctx');
  }
  /* --- end regressions: security --- */

  /* --- regressions: review-2 --- */
  {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ briefs: JSON.parse(JSON.stringify(briefs)), manifest: { retained: Object.keys(briefs) } }) });
    /* a fresh load whose hash is the skip-link target must still paint a page */
    const env = makeEnv({ config: { apiBase: '', mode: 'container' }, fetchImpl });
    env.ctx.location.hash = '#main';
    env.run(mainScript()); await env.run('booting||Promise.resolve()'); await sleep(40);
    ok(env.run('BOOTED') && /Your work/.test(env.main().innerHTML), 'review-2: a boot on #main left the loader in place');
    ok(env.ctx.location.hash === '#home', 'review-2: #main was not rewritten to #home at boot, got ' + env.ctx.location.hash);
    /* an unknown report id shows the catalog with a notice instead of a thrown render */
    env.ctx.location.hash = '#trends-bogus'; env.run('render()');
    const html = env.main().innerHTML;
    ok(!/failed to render/.test(html) && /No report named/.test(html) && /class="rcat"/.test(html), 'review-2: #trends-bogus did not fall back to the catalog with a notice');
    ok(env.ctx.location.hash === '#trends', 'review-2: unknown report hash not normalised, got ' + env.ctx.location.hash);
    ok(env.errors.length === 0, 'review-2 console.error: ' + env.errors.slice(0, 2).join(' | '));
    console.log('8. review-2        boot on #main paints, unknown report falls back to the catalog');
  }
  /* --- end regressions: review-2 --- */

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
