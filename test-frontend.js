/* Loads each page in jsdom against the live server with a real session,
   and reports JS errors plus whether the key regions actually rendered. */
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const BASE = 'http://localhost:3000';

async function login(email, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('login failed: ' + email);
  return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}

/* jsdom 30 routes subresource loads through an interceptor. Same-origin
   assets get the session cookie; the font CDN is blocked here, so skip it. */
function interceptorFor(cookie) {
  return {
    [requestInterceptor](req) {
      if (!req.url.startsWith(BASE)) {
        return { response: new Response('', { status: 204 }) };
      }
      req.headers.set('cookie', cookie);
      return undefined;
    },
  };
}

async function loadPage(path, cookie, checks) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => {
    const m = e.message || String(e);
    if (!/fonts\.googleapis|Could not load/.test(m)) errors.push('JS: ' + m);
  });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

  const html = await (await fetch(BASE + path, { headers: { cookie } })).text();

  const dom = new JSDOM(html, {
    url: BASE + path,
    runScripts: 'dangerously',
    resources: 'usable',
    ...interceptorFor(cookie),
    virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(w) {
      // jsdom ships no fetch or EventSource; point them at the real server.
      w.fetch = (u, opts = {}) =>
        fetch(new URL(u, BASE).href, {
          ...opts,
          headers: { ...(opts.headers || {}), cookie },
        });
      w.EventSource = class { constructor() {} close() {} addEventListener() {} };
      w.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
      w.alert = m => errors.push('alert: ' + m);
    },
  });

  const w = dom.window;
  await new Promise(r => setTimeout(r, 1500)); // let async render settle

  const results = checks.map(([label, sel, must]) => {
    const el = w.document.querySelector(sel);
    const text = el ? (el.textContent || '').trim() : '';
    const ok = !!el && (must ? text.includes(must) : text.length > 0);
    return ok ? `PASS  ${label}` : `FAIL  ${label} [${sel}] got "${text.slice(0, 60)}"`;
  });

  console.log(`\n--- ${path} ---`);
  results.forEach(r => console.log('  ' + r));
  errors.length ? errors.forEach(e => console.log('  ERROR ' + e))
                : console.log('  no JS errors');
  w.close();
  return !errors.length && results.every(r => r.startsWith('PASS'));
}

(async () => {
  const judge = await login('judge@veridict.local', 'judge1234');
  const admin = await login('admin@veridict.local', 'admin1234');

  const tid = (await (await fetch(BASE + '/api/tournaments',
    { headers: { cookie: judge } })).json()).tournaments[0].id;
  const td = await (await fetch(BASE + '/api/tournaments/' + tid,
    { headers: { cookie: judge } })).json();
  const rid = td.rounds[0].id;

  let ok = true;
  ok &= await loadPage('/', '', [
    ['hero headline', '.hero h1', 'clock'],
    ['nav renders', '#masthead', 'Veridict']]);
  ok &= await loadPage('/login', '', [
    ['title', '#title', 'Sign in'],
    ['demo accounts', '#demo-keys', 'Ade Bakare']]);
  ok &= await loadPage('/app', judge, [
    ['greeting', '#greeting', 'Ade'],
    ['tournament card', '#list', 'Michaelmas']]);
  ok &= await loadPage('/tournament?id=' + tid, judge, [
    ['name', '#tname', 'Michaelmas'],
    ['rounds', '#rounds', 'internships'],
    ['teams', '#teams', 'Trinity']]);
  ok &= await loadPage('/ballot?round=' + rid, judge, [
    ['motion', '#motion', 'internships'],
    ['flow strip', '#flow', 'PM'],
    ['speaker named', '#flow', 'Amara'],
    ['criteria', '#criteria', 'Matter'],
    ['band descriptor', '#criteria', 'warranted'],
    ['ranks', '#ranks', 'Trinity'],
    ['slot labels', '#ranks', 'Opening Government'],
    ['timer', '#t-name', 'Prime Minister'],
    ['tally', '#tally-total']]);
  ok &= await loadPage('/consent', admin, [
    ['speaker list', '#list', 'Amara'],
    ['consent status', '#list', 'granted'],
    ['storage usage', '#usage', 'MB']]);
  ok &= await loadPage('/me', judge, [
    ['heading', 'h1', 'My speeches'],
    ['list renders', '#list']]);
  ok &= await loadPage('/ballot?round=' + rid, judge, [
    ['recorder panel', '#rec-label'],
    ['feedback fields', '#fb-who']]);
  ok &= await loadPage('/tab', admin, [
    ['rounds', '#rounds', 'internships'],
    ['slot allocation', '#slots', 'Opening Government'],
    ['format options', '#tformat', 'British Parliamentary']]);

  console.log('\n' + (ok ? 'ALL PAGES OK' : 'SOME CHECKS FAILED'));
  process.exit(ok ? 0 : 1);
})();
