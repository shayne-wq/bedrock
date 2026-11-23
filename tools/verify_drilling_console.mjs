// The console side of drilling programmes, in a real browser.
//
// The viewer half is verified against a stubbed edge function; this is the
// other half — the form a geologist uses every week for three months. It runs
// drilling.js against a stubbed Supabase client, so what is under test is the
// rendering, the wiring and the arithmetic, not the network.
//
// The assertion that matters most is the one about a LOWER total. "We're at
// 4,000 metres today" is ambiguous in English: it can mean the total or the
// week. Enter the week's figure into a cumulative field and every number after
// it is wrong. The form has to catch that, and this is what proves it does.
//
//   node tools/verify_drilling_console.mjs
//
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ||
  '/Users/' + (process.env.USER || 'shaynetaker') +
  '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/' +
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

// EVERY DATE IN THE FIXTURE IS RELATIVE TO TODAY. The card now prints what the
// deck is forecasting from these rows, which is arithmetic over the gap
// between a report and now — so a fixture written as fixed dates would test a
// different sentence every morning and, within a few months, a programme
// nobody had reported on since the spring. Same offsets as
// tools/verify_drilling.mjs, so both suites describe one programme.
const DAY = 864e5;
const T0 = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const d = (n) => new Date(T0 + n * DAY).toISOString().slice(0, 10);
const dayN = (iso) => String(Number(iso.slice(8, 10)));
const yrN = (iso) => iso.slice(0, 4);

const HARNESS = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/dashboard/app.css">
<style>body{padding:24px;background:var(--bg,#f6f5f2)}</style>
</head><body>
<main id="view"><div class="panel" id="drillpanel" hidden></div></main>
<div id="toast" role="status"></div>
<div class="modal" id="modal"><div class="inner" id="modalinner"></div></div>
<script>
// The vendored supabase client, replaced by a recorder. Every call drilling.js
// makes lands in window.__calls, and the reads come back from fixtures.
window.__calls = [];
const PROGS = [
  { id: 'p1', project_id: 'proj', zone_id: 'z1', name: 'Phase 2 diamond drilling',
    status: 'active', target_m: 10000, holes_planned: 24, started_on: '${d(-96)}',
    expected_end: '${d(37)}', easting: 681000, northing: 5521000, elev_m: null,
    operator: 'Cabo Drilling', note: 'Testing the north strike extension.' },
  { id: 'p2', project_id: 'proj', zone_id: null, name: 'Regional reconnaissance',
    status: 'planned', target_m: null, holes_planned: null, started_on: null,
    expected_end: null, easting: null, northing: null, elev_m: null,
    operator: null, note: null },
];
const UPS = [
  { id: 'u3', program_id: 'p1', as_of: '${d(-11)}', metres_total: null,
    holes_done: null, holes_active: 2, body: 'Second rig mobilised.',
    author: 'A. Geologist', published_at: null },
  { id: 'u2', program_id: 'p1', as_of: '${d(-15)}', metres_total: 4012,
    holes_done: 11, holes_active: 1, body: 'TC-26-011 completed to 412 m.',
    author: 'A. Geologist', published_at: '${d(-15)}T12:00:00Z' },
  { id: 'u1', program_id: 'p1', as_of: '${d(-22)}', metres_total: 3600,
    holes_done: 10, holes_active: 1, body: 'Rig turning.',
    author: 'A. Geologist', published_at: '${d(-22)}T12:00:00Z' },
];
const TRACES = { traces: [ { collar: [680900, 5520900, 1310] },
                           { collar: [681100, 5521100, 1290] } ] };
function builder(table, op) {
  const rec = { table, op, filters: [], payload: null };
  window.__calls.push(rec);
  const self = {
    select(c) { rec.select = c; return self; },
    eq(k, v) { rec.filters.push(['eq', k, v]); return self; },
    in(k, v) { rec.filters.push(['in', k, v]); return self; },
    not(k, o, v) { rec.filters.push(['not', k, o, v]); return self; },
    order(c, o) { rec.order = [c, o]; return self; },
    maybeSingle() { return self; },
    is(k, v) { rec.filters.push(['is', k, v]); return self; },
    limit(k) { rec.limit = k; return self; },
    single() { return self; },
    then(res) {
      let data = [];
      if (rec.op === 'select') {
        data = table === 'drill_programs' ? (window.__noProgs ? [] : PROGS)
             : table === 'drill_notices' ? (window.__notices || [])
             : UPS;
        // An is(published_at, null) filter is applyFigures asking whether a draft
        // already exists for today. Nothing in the fixture does, so it inserts.
        if (rec.filters.some((f) => f[0] === 'is' && f[1] === 'published_at')) data = [];
      }
      return Promise.resolve(res({ data, error: null }));
    },
  };
  return self;
}
window.supabase = { createClient: () => ({
  // A token, because telling the audience is the one action on this screen
  // that leaves for an edge function and has to carry the caller's JWT.
  auth: { getSession: async () => ({ data: { session: { access_token: 'test-jwt' } } }) },
  from(table) {
    return {
      select(c) { return builder(table, 'select').select(c); },
      insert(row) { const b = builder(table, 'insert'); b.payload = row;
        window.__calls[window.__calls.length - 1].payload = row; return b; },
      update(row) { const b = builder(table, 'update');
        window.__calls[window.__calls.length - 1].payload = row; return b; },
      delete() { return builder(table, 'delete'); },
    };
  },
  storage: { from: () => ({
    createSignedUrl: async () => ({ data: { signedUrl: '/__traces.json' }, error: null }),
  }) },
}) };
</script>
<script>
// The drill-notice function, stubbed. Recorded rather than mocked away: what
// is under test is that a PREVIEW happens first and that nothing is sent
// until the count has been confirmed.
window.__notices = [];
window.__fetches = [];
window.__preview = { ok: true, preview: true, recipients: 23, skipped: {} };
window.__send = { ok: true, recipients: 23, sent: 23, failed: 0, skipped: {} };
window.__noticeStatus = 200;
(function () {
  const real = window.fetch.bind(window);
  window.fetch = (u, o) => {
    if (String(u).includes('drill-notice')) {
      const body = JSON.parse(o.body);
      window.__fetches.push({ url: String(u), body: body,
                              auth: o.headers.Authorization });
      const payload = body.preview ? window.__preview : window.__send;
      return Promise.resolve({
        ok: window.__noticeStatus < 400, status: window.__noticeStatus,
        statusText: 'stub', json: async () => payload,
      });
    }
    return real(u, o);
  };
})();
</script>
<script type="module">
import { state } from '/dashboard/lib/ui.js';
import { renderDrilling, syncFromUpload } from '/dashboard/drilling.js';
state.session = { user: { id: 'user-1' } };
state.roles = { 'org-1': 'owner' };
// Shaped exactly as parseAux records a drills upload. Invented figures: 38
// drilled holes and 11,240 m, with 12 proposed holes and their 4,100 m
// deliberately not in the count.
const FILE_STATS = {
  files: 3, holes: 38, metres: 11240, intervals: 4810, assumed_vertical: 0,
  planned_holes: 12, planned_m: 4100,
  hole_ids: ['GC21-01', 'GC24-01', 'GC24-03'],
  latest: { id: 'GC24-03', on: '${d(-10)}',
            easting: 498168, northing: 5521008, elev_m: 1122.7 },
};
const PROJ = { id: 'proj', org_id: 'org-1', name: 'Test Creek', epsg: 26910 };
const ZONES = [{ id: 'z1', name: 'Creek Zone' }];
const DATASETS = [{ id: 'd1', kind: 'drills', zone_id: 'z1',
                    storage_path: 'org/proj/drills.json', stats: FILE_STATS,
                    provenance: { uploaded_at: '${d(-9)}T09:00:00Z' } }];
window.__render = () => renderDrilling(PROJ, ZONES, DATASETS,
  document.getElementById('drillpanel'));
// The same panel against a DIFFERENT collar file, so a fixture describing a
// file with open holes does not have to be the fixture every other assertion
// reads. FILE_STATS above is a finish-dates-only export, which is its own real
// case and the one the rig-moves-to-the-last-finished-hole tests describe.
window.__renderWith = (stats) => renderDrilling(PROJ, ZONES,
  [{ ...DATASETS[0], stats }], document.getElementById('drillpanel'));
window.__stats = FILE_STATS;
// What a drop hands over: putAux's return value.
window.__sync = (stats, prev, zid) => syncFromUpload(PROJ, ZONES, DATASETS,
  { kind: 'drills', zone_id: zid === undefined ? 'z1' : zid,
    stats: stats || FILE_STATS, prev_hole_ids: prev === undefined ? null : prev },
  () => {});
window.__render().then(() => { window.__ready = true; });
</script>
</body></html>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/__harness') {
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HARNESS);
  }
  if (u.pathname === '/__traces.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ traces: [{ collar: [680900, 5520900, 1310] },
                                              { collar: [681100, 5521100, 1290] }] }));
  }
  const f = path.join(ROOT, u.pathname);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404).end('no'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const pg = await b.newPage({ viewport: { width: 1280, height: 1000 } });
// The plan modal now carries a map, so opening one asks for basemap tiles.
// Served locally: a suite that reaches Esri is a suite that fails on a train,
// and the imagery is not what this file is about. The map itself is verified
// in tools/verify_rigmap.mjs.
await pg.route(/arcgisonline\.com|openstreetmap\.org/, (route) => route.fulfill({
  status: 200, contentType: 'image/png',
  body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN' +
                    'k+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
}));
const errs = [];
const missing = [];
pg.on('response', (r) => { if (r.status() >= 400) missing.push(r.status() + ' ' + r.url()); });
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await pg.goto(`${BASE}/__harness`, { waitUntil: 'load' });
await pg.waitForFunction(() => window.__ready, null, { timeout: 30000 });

const panel = await pg.evaluate(() => {
  const el = document.getElementById('drillpanel');
  return {
    hidden: el.hidden,
    text: el.textContent.replace(/\s+/g, ' '),
    cards: el.querySelectorAll('.zone').length,
    bar: el.querySelector('.bar > i')?.style.width,
    rows: el.querySelectorAll('tbody tr').length,
    since: [...el.querySelectorAll('tbody tr')].map((r) => r.children[2].textContent),
    chips: [...el.querySelectorAll('tbody .chip')].map((c) => c.textContent),
    useBtns: el.querySelectorAll('[data-dpfile]').length,
    // The line that tells the issuer what their own deck is now forecasting.
    fc: [...el.querySelectorAll('.zone')].map((z) =>
      (z.querySelector('.hintline')?.textContent || '').replace(/\s+/g, ' ').trim()),
  };
});
await pg.screenshot({ path: '/tmp/drill-console.png', fullPage: true });
if (!panel.cards) {
  console.log('panel never rendered. html:\n' +
    (await pg.evaluate(() => document.getElementById('drillpanel').outerHTML)).slice(0, 1200));
  console.log('errors:', errs);
  await b.close(); server.close(); process.exit(1);
}

// Post an update against the first programme.
await pg.evaluate(() => document.querySelector('[data-dppost="p1"]').click());
await pg.waitForTimeout(250);
const form = await pg.evaluate(() => ({
  open: document.getElementById('modal').classList.contains('on'),
  sub: document.querySelector('#modalinner .sub')?.textContent.replace(/\s+/g, ' '),
  author: document.getElementById('duau')?.value,
  asOf: document.getElementById('dua')?.value,
}));

// A figure LOWER than the last total: the "4,000 today" mistake.
await pg.fill('#dum', '412');
await pg.waitForTimeout(150);
const low = await pg.evaluate(() => ({
  text: document.getElementById('dudelta').textContent.replace(/\s+/g, ' '),
  colour: getComputedStyle(document.getElementById('dudelta')).color,
}));

// A sane cumulative figure.
await pg.fill('#dum', '4424');
await pg.waitForTimeout(150);
const good = await pg.evaluate(() =>
  document.getElementById('dudelta').textContent.replace(/\s+/g, ' '));

await pg.fill('#dub', 'TC-26-012 completed.');
await pg.evaluate(() => document.getElementById('dupost').click());
await pg.waitForTimeout(300);
const posted = await pg.evaluate(() => window.__calls.filter((c) => c.op === 'insert').pop());

// A draft, from a fresh form.
await pg.evaluate(() => document.querySelector('[data-dppost="p1"]').click());
await pg.waitForTimeout(200);
await pg.fill('#dum', '4500');
await pg.evaluate(() => document.getElementById('dudraft').click());
await pg.waitForTimeout(300);
const draft = await pg.evaluate(() => window.__calls.filter((c) => c.op === 'insert').pop());

// The plan form, and the collar centroid.
await pg.evaluate(() => document.querySelector('[data-dpedit="p1"]').click());
await pg.waitForTimeout(250);
const plan = await pg.evaluate(() => ({
  name: document.getElementById('dpname').value,
  target: document.getElementById('dptarget').value,
  zone: document.getElementById('dpzone').value,
  e: document.getElementById('dpe').value,
}));
await pg.evaluate(() => { document.getElementById('dpe').value = '';
                          document.getElementById('dpn').value = ''; });
await pg.evaluate(() => document.getElementById('dpmid').click());
await pg.waitForTimeout(600);
const mid = await pg.evaluate(() => ({
  e: document.getElementById('dpe').value, n: document.getElementById('dpn').value,
  note: document.getElementById('dpmidnote').textContent,
}));

// Half a position must be refused before it reaches the database.
await pg.evaluate(() => { document.getElementById('dpn').value = ''; });
await pg.evaluate(() => document.getElementById('dpsave').click());
await pg.waitForTimeout(250);
const half = await pg.evaluate(() => ({
  toast: document.getElementById('toast').textContent,
  updates: window.__calls.filter((c) => c.op === 'update').length,
}));

// ---- the figures that are already in the uploaded file ---------------------
// Nobody should retype a number the server computed when the collars landed.
const reset = async () => {
  await pg.evaluate(() => { window.__calls.length = 0; });
  await pg.evaluate(() => window.__render());
  await pg.waitForTimeout(250);
};

await reset();
await pg.evaluate(() => document.querySelector('[data-dpfile="p1"]').click());
await pg.waitForTimeout(600);
const used = await pg.evaluate(() => ({
  toast: document.getElementById('toast').textContent.replace(/\s+/g, ' '),
  bad: document.getElementById('toast').classList.contains('bad'),
  wrote: window.__calls.find((c) => c.op === 'insert' && c.table === 'drill_updates')?.payload,
  moved: window.__calls.find((c) => c.op === 'update' && c.table === 'drill_programs')?.payload,
}));

// A total BELOW what is already reported is a partial export, not progress.
// It is still only ever a draft, and it has to be said out loud.
await reset();
await pg.evaluate(() => window.__sync({ ...window.__stats, metres: 1000, holes: 4 }));
await pg.waitForTimeout(600);
const backwards = await pg.evaluate(() => ({
  toast: document.getElementById('toast').textContent.replace(/\s+/g, ' '),
  bad: document.getElementById('toast').classList.contains('bad'),
  wrote: window.__calls.find((c) => c.op === 'insert' && c.table === 'drill_updates')?.payload,
  moved: window.__calls.filter((c) => c.op === 'update' && c.table === 'drill_programs').length,
}));

// The expected weekly workflow is a full re-export. Most weeks nothing has
// changed and the second upload of the same file should leave no trace.
await reset();
await pg.evaluate(() => window.__sync({ ...window.__stats, metres: 4012, holes: 11 },
                                      ['GC21-01', 'GC24-01', 'GC24-03']));
await pg.waitForTimeout(600);
const quiet = await pg.evaluate(() => ({
  toast: document.getElementById('toast').textContent.replace(/\s+/g, ' '),
  writes: window.__calls.filter((c) => c.op === 'insert' || c.op === 'update').length,
}));

// No programme yet. The figures are not thrown away and a programme is not
// invented: the plan form opens with everything the file knows already in it.
await pg.evaluate(() => { window.__noProgs = true; window.__calls.length = 0; });
await pg.evaluate(() => window.__sync());
await pg.waitForTimeout(600);
const seeded = await pg.evaluate(() => ({
  open: document.getElementById('modal').classList.contains('on'),
  name: document.getElementById('dpname')?.value,
  e: document.getElementById('dpe')?.value,
  n: document.getElementById('dpn')?.value,
  target: document.getElementById('dptarget')?.value,
  zone: document.getElementById('dpzone')?.value,
  hint: [...document.querySelectorAll('#modalinner .hintline')]
    .map((x) => x.textContent.replace(/\s+/g, ' ')).join(' | '),
  writes: window.__calls.filter((c) => c.op === 'insert').length,
}));
await pg.evaluate(() => { window.__noProgs = false; });

let pass = 0, fail = 0;
const ok = (n, c, d = '') => c ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (d ? ' — ' + d : '')));

console.log('\n== assertions');
ok('the panel renders', panel.hidden === false && panel.cards === 2, JSON.stringify(panel.cards));
ok('it leads with the metres against the plan',
   /4,012 m of 10,000 m/.test(panel.text), panel.text.slice(0, 200));
ok('a programme with no position says so', /no rig position/.test(panel.text));
ok('the bar is drawn from the published total', panel.bar === '40.1%', panel.bar);
ok('every report is listed, drafts included', panel.rows === 3, String(panel.rows));
ok('the since column is computed', panel.since.includes('+412'), JSON.stringify(panel.since));
ok('drafts are marked as drafts',
   panel.chips.filter((c) => c === 'Draft').length === 1 &&
   panel.chips.filter((c) => c === 'Posted').length === 2, JSON.stringify(panel.chips));
ok('posting opens a form', form.open === true);
ok('the form says what was last reported',
   new RegExp('4,012 m on [^.]*\\b' + dayN(d(-15)) + '\\b[^.]*' + yrN(d(-15)))
     .test(form.sub || ''), form.sub);
ok('it defaults to today', form.asOf === new Date().toISOString().slice(0, 10), form.asOf);
ok('it remembers who reports', /Geologist/.test(form.author || ''), form.author);
ok('a lower total is caught, not accepted',
   /LESS than the last report/.test(low.text) && /metres to date, not metres since/.test(low.text),
   low.text);
ok('and it says what the total would have been', /4,424 m/.test(low.text), low.text);
ok('the warning is marked as one', /rgb\(/.test(low.colour) && low.colour !== 'rgb(0, 0, 0)', low.colour);
ok('a sane figure shows the delta and the share',
   /\+412 m/.test(good) && /44% of 10,000 m/.test(good), good);
ok('posting writes a published report',
   posted?.table === 'drill_updates' && !!posted?.payload?.published_at &&
   Number(posted?.payload?.metres_total) === 4424, JSON.stringify(posted?.payload));
ok('a draft is written unpublished',
   draft?.payload?.published_at === null && Number(draft?.payload?.metres_total) === 4500,
   JSON.stringify(draft?.payload));
ok('the plan form opens filled in',
   plan.name === 'Phase 2 diamond drilling' && plan.target === '10000' && plan.zone === 'z1',
   JSON.stringify(plan));
ok('the collar centroid is offered', mid.e === '681000.0' && mid.n === '5521000.0',
   JSON.stringify(mid));
ok('and it says where the number came from', /2 collars/.test(mid.note), mid.note);
ok('half a position is refused before it is written',
   /both an easting and a northing/.test(half.toast) && half.updates === 0,
   half.toast + ' / updates ' + half.updates);

console.log('\n== the figures come out of the file');
ok('the panel says what the collar file holds',
   /38 holes/.test(panel.text) && /11,240 m/.test(panel.text), panel.text.slice(-400));
ok('proposed holes are accounted for, not silently dropped',
   /12 proposed holes not counted/.test(panel.text), panel.text.slice(-400));
ok('it names the hole the rig finished last',
   /newest finished GC24-03/.test(panel.text), panel.text.slice(-400));
// One per programme: p1 matches its own zone, and p2 — project level — takes
// the project's only drills upload, the same fallback syncFromUpload makes.
ok('both programmes are offered the figures', panel.useBtns === 2, String(panel.useBtns));

ok('using them writes the metres read from the file',
   Number(used.wrote?.metres_total) === 11240 && Number(used.wrote?.holes_done) === 38,
   JSON.stringify(used.wrote));
ok('...as a DRAFT, never posted', used.wrote?.published_at === undefined,
   JSON.stringify(used.wrote));
ok('...and says so rather than claiming it published',
   /draft report is ready to post/.test(used.toast) && !/^Posted/.test(used.toast), used.toast);
ok('the rig moves to the newest finished collar',
   Number(used.moved?.easting) === 498168 && Number(used.moved?.northing) === 5521008,
   JSON.stringify(used.moved));
ok('...and says which hole', /rig moved to GC24-03/.test(used.toast), used.toast);

ok('a total below the last report is called out',
   /LOWER than the 4,012 m/.test(backwards.toast) && backwards.bad === true, backwards.toast);
ok('...and blamed on the file, not on the programme',
   /whole dataset/.test(backwards.toast), backwards.toast);
ok('...and still only ever a draft',
   backwards.wrote?.published_at === undefined, JSON.stringify(backwards.wrote));
// The newest finished hole in a partial export is the newest hole in that
// SLICE. Moving the rig onto it puts the marker on whichever zone was exported.
ok('...and the rig is not moved on a file that looks partial',
   backwards.moved === 0, String(backwards.moved));

ok('re-uploading an unchanged file writes nothing', quiet.writes === 0,
   String(quiet.writes));
ok('...and says the figures are unchanged', /unchanged/.test(quiet.toast), quiet.toast);

ok('with no programme the plan form opens instead', seeded.open === true);
ok('...named from the newest hole', seeded.name === '2026 drilling programme', seeded.name);
ok('...with the rig where the file puts it',
   seeded.e === '498168' && seeded.n === '5521008', JSON.stringify(seeded));
ok('...covering the zone the file was loaded into', seeded.zone === 'z1', seeded.zone);
// Nothing in a data file records what a company committed to, and a target
// guessed from metres already drilled reads as 100% complete on day one.
ok('...and metres planned left empty, because no file knows it',
   seeded.target === '', JSON.stringify(seeded.target));
ok('...saying where the numbers came from',
   /Filled in from your collar file: 11,240 m in 38 holes/.test(seeded.hint), seeded.hint);
ok('nothing is written until the plan is saved', seeded.writes === 0, String(seeded.writes));

// ---- the deck's forecast, said back to the issuer -------------------------
// The metres and the plan are the issuer's own figures and they are
// accountable for them. The finish date is not: the deck divides them and
// publishes a date to anybody holding a share link. So the console has to say
// what that date is — and when the deck is deliberately silent, why, because
// three of the five reasons are things only the issuer can fix.
console.log('\n== what the deck is forecasting');
console.log(JSON.stringify(panel.fc, null, 0));
ok('the card says what the deck is forecasting',
   /Your deck shows 50 m\/day and a forecast finish of/.test(panel.fc[0] || ''),
   panel.fc[0]);
ok('...and how that compares with the plan on file',
   /months later than planned/.test(panel.fc[0] || ''), panel.fc[0]);
// The one the collar-file seeding makes common: a programme created from an
// upload gets no target, deliberately, because no file records what a company
// committed to. Showing nothing there reads as a feature that is broken.
ok('a programme with nothing reported says so plainly',
   /Nothing is reported yet/.test(panel.fc[1] || ''), panel.fc[1]);
// A programme seeded from a collar file gets no target by design, because no
// file records what a company committed to. The first build of the forecast
// just showed nothing there, which reads as a feature that is broken rather
// than one waiting for a number only the issuer has.
ok('...and is told what the missing target costs it',
   /no planned metres on file/i.test(panel.fc[1] || '') &&
   /Edit plan/.test(panel.fc[1] || ''), panel.fc[1]);

// The states the fixture is not in, put through the same module the card and
// the deck both read. A sentence about a forecast that disagrees with the
// forecast is worse than no sentence.
const FC = await pg.evaluate(async () => {
  const M = await import('/dashboard/lib/drill-forecast.js');
  const base = { status: 'active', target_m: 10000, started_on: '@S',
                 expected_end: '@E', updates: [{ as_of: '@L', metres_total: 8000 }] };
  const sub = (o, p) => JSON.parse(JSON.stringify(o)
    .replace('@S', p.s).replace('@E', p.e).replace('@L', p.l));
  const day = (n) => new Date(Date.parse(new Date().toISOString().slice(0, 10) +
    'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const mk = (over) => Object.assign(
    sub(base, { s: day(-80), e: day(20), l: day(-10) }), over);
  return {
    live: M.drillCalc(mk({})),
    paused: M.drillCalc(mk({ status: 'paused' })),
    cold: M.drillCalc(mk({ updates: [{ as_of: day(-120), metres_total: 8000 }],
                           started_on: day(-200) })),
    noTarget: M.drillCalc(mk({ target_m: null })),
  };
});
ok('the console reads the same rules the deck does',
   FC.live.pace === 114.29 && FC.live.forecast !== null &&
   FC.paused.forecast === null && FC.cold.forecast === null &&
   FC.noTarget.forecast === null, JSON.stringify(FC));

// ------------------------------------------------- assay discipline --------
// The detector, through the shipped function rather than a copy of its rules,
// and from both directions. The false-positive half is the half that decides
// whether this guard survives: a warning on "4,012 m to date" is dismissed by
// week two, and a dismissed warning is worse than none at all.
const GRADES = await pg.evaluate(async () => {
  const M = await import('/dashboard/drilling.js');
  const fires = [
    'TC-26-011 returned 4.5 g/t Au over 12 m.',
    'Best interval 1,200 ppm Cu.',
    '850 ppb Au in the second hole.',
    'Assays up to 1.2% Cu.',
    'Copper grade of 0.8%.',
    '12 m @ 4.5 from TC-26-014.',
    '2.1 g/t AuEq across the zone.',
    '0.35 oz/t in the quartz.',
    'Visible gold logged in TC-26-014.',
    'Massive sulphides from 210 m.',
  ];
  const quiet = [
    // The body applyFigures writes for itself. If the guard fires on this,
    // every upload would ask to be affirmed.
    '38 holes, 11,240 m to date.',
    'TC-26-011 completed to 412 m.',
    'Drilled 4,012 m of the 10,000 m programme; 40% complete.',
    'Second rig mobilised.',
    'The property is 100% owned and in good standing.',
    'Assays pending for holes 12 to 14.',
    'Hole TC-26-014 intersected the target horizon at 250 m.',
    'Standdown 3 days for 50 m of casing.',
  ];
  return {
    fires: fires.map((t) => [t, M.gradeClaims(t)]),
    quiet: quiet.map((t) => [t, M.gradeClaims(t)]),
  };
});
ok('every result-shaped sentence is caught',
   GRADES.fires.every(([, h]) => h.length > 0),
   JSON.stringify(GRADES.fires.filter(([, h]) => !h.length)));
ok('no ordinary progress sentence is',
   GRADES.quiet.every(([, h]) => h.length === 0),
   JSON.stringify(GRADES.quiet.filter(([, h]) => h.length)));
ok('it quotes back what it found, for the person to check',
   GRADES.fires[0][1].some((h) => /4\.5\s*g\s*\/\s*t/i.test(h)),
   JSON.stringify(GRADES.fires[0][1]));

// And in the form. A grade typed into the body warns as it is typed...
await pg.evaluate(() => document.querySelector('[data-dppost="p1"]').click());
await pg.waitForTimeout(200);
await pg.fill('#dum', '4600');
await pg.fill('#dub', 'TC-26-015 returned 4.5 g/t Au over 12 m.');
await pg.waitForTimeout(150);
const warned = await pg.evaluate(() => ({
  shown: !document.getElementById('dubwarn').hidden,
  text: document.getElementById('dubwarn').textContent.replace(/\s+/g, ' '),
  colour: getComputedStyle(document.getElementById('dubwarn')).color,
  btn: document.getElementById('dupost').textContent,
}));
ok('a grade in the report body warns as it is typed',
   warned.shown && /already public/i.test(warned.text), JSON.stringify(warned));
ok('...in the warning colour, not the error colour',
   warned.colour === 'rgb(138, 100, 16)', warned.colour);

// ...and the first press of Post does not post it.
const before = await pg.evaluate(() => window.__calls.filter((c) => c.op === 'insert').length);
await pg.evaluate(() => document.getElementById('dupost').click());
await pg.waitForTimeout(250);
const held = await pg.evaluate(() => ({
  inserts: window.__calls.filter((c) => c.op === 'insert').length,
  btn: document.getElementById('dupost').textContent,
  text: document.getElementById('dubwarn').textContent.replace(/\s+/g, ' '),
  colour: getComputedStyle(document.getElementById('dubwarn')).color,
  open: document.getElementById('modal').classList.contains('on'),
}));
ok('the first press of Post does not post a grade',
   held.inserts === before && held.open, JSON.stringify(held));
ok('...it asks, in the button itself',
   /already public/i.test(held.btn), held.btn);
ok('...and escalates the line to the error colour',
   held.colour === 'rgb(194, 58, 46)', held.colour);

// Editing the text withdraws the affirmation: affirm, paste something else in,
// and the guard has to ask again about the new sentence.
await pg.fill('#dub', 'TC-26-015 returned 9.9 g/t Au.');
await pg.waitForTimeout(150);
const withdrawn = await pg.evaluate(() => document.getElementById('dupost').textContent);
ok('editing the body withdraws the affirmation', /Post to shareholders/.test(withdrawn), withdrawn);

// Two presses do post it.
await pg.evaluate(() => document.getElementById('dupost').click());
await pg.waitForTimeout(150);
await pg.evaluate(() => document.getElementById('dupost').click());
await pg.waitForTimeout(300);
const affirmed = await pg.evaluate(() => {
  const ins = window.__calls.filter((c) => c.op === 'insert');
  return { n: ins.length, last: ins[ins.length - 1]?.payload };
});
ok('affirmed, it posts — published, with the body intact',
   affirmed.n === before + 1 && affirmed.last?.published_at &&
   /9\.9 g\/t/.test(affirmed.last?.body || ''), JSON.stringify(affirmed));

// A DRAFT is not disclosure and is never interrupted, however it reads.
await pg.evaluate(() => document.querySelector('[data-dppost="p1"]').click());
await pg.waitForTimeout(200);
await pg.fill('#dum', '4700');
await pg.fill('#dub', 'Visible gold in TC-26-016, 12 m @ 4.5.');
await pg.evaluate(() => document.getElementById('dudraft').click());
await pg.waitForTimeout(300);
const drafted = await pg.evaluate(() => window.__calls.filter((c) => c.op === 'insert').pop());
ok('a draft carrying a grade saves on the first press',
   drafted?.payload?.published_at === null &&
   /Visible gold/.test(drafted?.payload?.body || ''), JSON.stringify(drafted?.payload));

// The programme note is the MORE exposed of the two fields, because a
// programme has no draft state: there is no "save it for later" press on this
// form, so the guard is the only thing between the sentence and the deck.
await pg.evaluate(() => document.querySelector('[data-dpedit="p1"]').click());
await pg.waitForTimeout(250);
await pg.fill('#dpnote', 'Testing the north extension — 1.2% Cu in trenching.');
await pg.waitForTimeout(150);
const noteWarn = await pg.evaluate(() => ({
  shown: !document.getElementById('dpnotewarn').hidden,
  text: document.getElementById('dpnotewarn').textContent.replace(/\s+/g, ' '),
}));
ok('a grade in the programme note warns too',
   noteWarn.shown && /already public/i.test(noteWarn.text), JSON.stringify(noteWarn));
// Its warning says SAVING publishes it, not posting — there is no post here.
ok('...and says that saving is what publishes it',
   /Save it only if it is already public/i.test(noteWarn.text) &&
   !/\bPost it\b/.test(noteWarn.text), noteWarn.text);

const nBefore = await pg.evaluate(() =>
  window.__calls.filter((c) => c.op === 'update' || c.op === 'insert').length);
await pg.evaluate(() => document.getElementById('dpsave').click());
await pg.waitForTimeout(250);
const nHeld = await pg.evaluate(() => ({
  writes: window.__calls.filter((c) => c.op === 'update' || c.op === 'insert').length,
  btn: document.getElementById('dpsave').textContent,
  open: document.getElementById('modal').classList.contains('on'),
}));
ok('the first press of Save does not publish a grade in the note',
   nHeld.writes === nBefore && nHeld.open && /already public/i.test(nHeld.btn),
   JSON.stringify(nHeld));

await pg.evaluate(() => document.getElementById('dpsave').click());
await pg.waitForTimeout(300);
const nSaved = await pg.evaluate(() => {
  const w = window.__calls.filter((c) => c.op === 'update' || c.op === 'insert');
  return { n: w.length, last: w[w.length - 1]?.payload };
});
ok('affirmed, the plan saves with the note intact',
   nSaved.n === nBefore + 1 && /1\.2% Cu/.test(nSaved.last?.note || ''),
   JSON.stringify(nSaved.last));

// ------------------------------------------- which hole the rig is on ------
// The programme knew its metres and not its holes, so the rig stood on the
// newest hole it FINISHED — "it is on the next hole, which by definition has
// no finish date yet". A collar file with start dates answers the question
// outright, and then it should not be approximated.
//
// OPEN carries a hole that was started and never finished, 2 km from the
// newest finished one so the two answers cannot be confused for each other.
const OPEN = {
  files: 3, holes: 39, metres: 11450, intervals: 4810, assumed_vertical: 0,
  planned_holes: 12, planned_m: 4100,
  hole_ids: ['GC21-01', 'GC24-01', 'GC24-03', 'GC24-04'],
  latest: { id: 'GC24-03', on: '2026-10-02',
            easting: 498168, northing: 5521008, elev_m: 1122.7 },
  holes_turning: 1,
  turning: [{ id: 'GC24-04', on: '2026-10-03', td: 210 }],
  rig: { id: 'GC24-04', on: '2026-10-03', turning: true,
         easting: 500200, northing: 5523000, elev_m: 1180.4 },
};
await pg.evaluate(() => { window.__calls.length = 0;
  document.getElementById('toast').textContent = ''; });
await pg.evaluate((st) => window.__sync(st, ['GC21-01', 'GC24-01', 'GC24-03']), OPEN);
await pg.waitForTimeout(600);
const onHole = await pg.evaluate(() => ({
  toast: document.getElementById('toast').textContent.replace(/\s+/g, ' '),
  wrote: window.__calls.find((c) => c.op === 'insert' && c.table === 'drill_updates')?.payload,
  moved: window.__calls.find((c) => c.op === 'update' && c.table === 'drill_programs')?.payload,
}));
ok('the rig stands on the hole the file has OPEN, not the last one finished',
   Number(onHole.moved?.easting) === 500200 && Number(onHole.moved?.northing) === 5523000,
   JSON.stringify(onHole.moved));
ok('...and the sentence says that is why', /which the file has open/.test(onHole.toast),
   onHole.toast);
// A file with only finish dates cannot answer it, and the older sentence has
// to keep being true for that file rather than quietly claiming more.
ok('a finish-dates-only file still says it is the last hole finished',
   /the last hole it finished/.test(used.toast), used.toast);
ok('holes turning now is filled in from the file, not left to be counted',
   Number(onHole.wrote?.holes_active) === 1, JSON.stringify(onHole.wrote));

// Panel and form, against that same file.
await pg.evaluate((st) => window.__renderWith(st), OPEN);
await pg.waitForTimeout(400);
const openPanel = await pg.evaluate(() =>
  document.getElementById('drillpanel').textContent.replace(/\s+/g, ' '));
ok('the panel names the hole that is turning, not just a count',
   /GC24-04 turning since/.test(openPanel), openPanel.slice(-400));

await pg.evaluate(() => document.querySelector('[data-dppost="p1"]').click());
await pg.waitForTimeout(250);
const prefill = await pg.evaluate(() => ({
  turning: document.getElementById('dur').value,
  hint: [...document.querySelectorAll('#modalinner .hintline')]
    .map((h) => h.textContent.replace(/\s+/g, ' ')).join(' | '),
}));
ok('the report form opens with holes turning already in it',
   prefill.turning === '1', JSON.stringify(prefill));
ok('...and names which hole, so the figure can be checked rather than trusted',
   /GC24-04 started and not yet finished/.test(prefill.hint), prefill.hint);
await pg.evaluate(() => document.getElementById('ducancel').click());

// Zero open holes is a fact worth stating; it is NOT the same as a file that
// cannot answer, which must leave the field alone rather than file a zero
// that reads as "the rig has stopped".
const CLOSED = { ...OPEN, holes_turning: 0, turning: [], rig: undefined };
await pg.evaluate((st) => window.__renderWith(st), CLOSED);
await pg.waitForTimeout(300);
await pg.evaluate(() => document.querySelector('[data-dppost="p1"]').click());
await pg.waitForTimeout(250);
const zero = await pg.evaluate(() => ({
  turning: document.getElementById('dur').value,
  hint: [...document.querySelectorAll('#modalinner .hintline')]
    .map((h) => h.textContent.replace(/\s+/g, ' ')).join(' | '),
}));
ok('a file with every hole finished says so',
   zero.turning === '0' && /no hole standing open/.test(zero.hint), JSON.stringify(zero));
await pg.evaluate(() => document.getElementById('ducancel').click());

await pg.evaluate(() => window.__renderWith(window.__stats));
await pg.waitForTimeout(300);
await pg.evaluate(() => document.querySelector('[data-dppost="p1"]').click());
await pg.waitForTimeout(250);
const cannot = await pg.evaluate(() => ({
  turning: document.getElementById('dur').value,
  hint: [...document.querySelectorAll('#modalinner .hintline')]
    .map((h) => h.textContent.replace(/\s+/g, ' ')).join(' | '),
}));
ok('a file that cannot answer leaves the field empty rather than filing a zero',
   cannot.turning === '' && !/standing open/.test(cannot.hint), JSON.stringify(cannot));
await pg.evaluate(() => document.getElementById('ducancel').click());

// --------------------------------------------- telling the audience --------
// Posting a report changes every share link and tells nobody. Mailing it is a
// THIRD act — the schema already separates writing from posting for the same
// reason, and a deck can be withdrawn where an email cannot.
await pg.evaluate(() => window.__renderWith(window.__stats));
await pg.waitForTimeout(400);
const tellBtns = await pg.evaluate(() => {
  const rows = [...document.querySelectorAll('#drillpanel tbody tr')];
  return rows.map((r) => ({
    status: r.children[4].textContent.replace(/\s+/g, ' ').trim(),
    tell: !!r.querySelector('[data-dptell]'),
  }));
});
// The fixture holds two posted reports and one draft.
ok('only a POSTED report can be mailed',
   tellBtns.filter((r) => r.tell).length === 2 &&
   tellBtns.every((r) => r.tell === /Posted/.test(r.status)),
   JSON.stringify(tellBtns));

// Pressing it COUNTS first and sends nothing.
await pg.evaluate(() => { window.__fetches.length = 0; });
await pg.evaluate(() => document.querySelector('[data-dptell]').click());
await pg.waitForTimeout(400);
const asked = await pg.evaluate(() => ({
  calls: window.__fetches.map((f) => ({ preview: f.body.preview, id: f.body.update_id })),
  auth: window.__fetches[0]?.auth,
  open: document.getElementById('modal').classList.contains('on'),
  head: document.querySelector('#modalinner h2')?.textContent,
  note: document.querySelector('#modalinner .note')?.textContent.replace(/\s+/g, ' '),
  go: document.getElementById('tellgo')?.textContent,
}));
ok('it asks the server for the count before it asks the user',
   asked.calls.length === 1 && asked.calls[0].preview === true, JSON.stringify(asked.calls));
ok('...carrying the caller\'s token, because authorisation is the server\'s job',
   asked.auth === 'Bearer test-jwt', String(asked.auth));
ok('...and puts the number in the question, not just "are you sure"',
   /Tell 23 people/.test(asked.head || '') && /Send to 23/.test(asked.go || ''),
   JSON.stringify([asked.head, asked.go]));
ok('...and says plainly that this one cannot be taken back',
   /cannot be withdrawn/.test(asked.note || ''), asked.note);

// Cancelling sends nothing. The preview already happened; no second call may.
await pg.evaluate(() => document.getElementById('tellno').click());
await pg.waitForTimeout(250);
const cancelled = await pg.evaluate(() => ({
  calls: window.__fetches.length,
  open: document.getElementById('modal').classList.contains('on'),
}));
ok('cancelling sends nothing', cancelled.calls === 1 && cancelled.open === false,
   JSON.stringify(cancelled));

// Confirming does.
await pg.evaluate(() => document.querySelector('[data-dptell]').click());
await pg.waitForTimeout(400);
await pg.evaluate(() => document.getElementById('tellgo').click());
await pg.waitForTimeout(500);
const went = await pg.evaluate(() => ({
  calls: window.__fetches.map((f) => f.body.preview === true),
  toast: document.getElementById('toast').textContent.replace(/\s+/g, ' '),
  bad: document.getElementById('toast').classList.contains('bad'),
}));
ok('confirming sends, as a second call that is not a preview',
   went.calls.length === 3 && went.calls[2] === false, JSON.stringify(went.calls));
ok('...and reports how many actually went', /Sent to 23 people/.test(went.toast), went.toast);
ok('...without an error style on a clean run', went.bad === false, went.toast);

// A partial send is reported as one. "Sent" over a run where four bounced is
// the kind of reassurance that costs somebody a follow-up they thought they
// had already made.
await pg.evaluate(() => {
  window.__send = { ok: true, recipients: 23, sent: 19, failed: 4, skipped: {} };
  document.getElementById('toast').textContent = '';
});
await pg.evaluate(() => document.querySelector('[data-dptell]').click());
await pg.waitForTimeout(400);
await pg.evaluate(() => document.getElementById('tellgo').click());
await pg.waitForTimeout(500);
const partial = await pg.evaluate(() => ({
  toast: document.getElementById('toast').textContent.replace(/\s+/g, ' '),
  bad: document.getElementById('toast').classList.contains('bad'),
}));
ok('a partial send is reported as a partial send',
   /19/.test(partial.toast) && /4 did not go out/.test(partial.toast) && partial.bad === true,
   partial.toast);

// Nobody to tell is a toast, not a dialog with a zero in it — and the two
// reasons for it are different facts.
await pg.evaluate(() => {
  window.__preview = { ok: true, preview: true, recipients: 0, skipped: {} };
  document.getElementById('toast').textContent = '';
});
await pg.evaluate(() => document.querySelector('[data-dptell]').click());
await pg.waitForTimeout(400);
const none = await pg.evaluate(() => ({
  open: document.getElementById('modal').classList.contains('on'),
  toast: document.getElementById('toast').textContent.replace(/\s+/g, ' '),
}));
ok('no audience at all explains how to get one',
   none.open === false && /no audience to tell/.test(none.toast) &&
   /sign-in form/.test(none.toast), none.toast);

await pg.evaluate(() => {
  window.__preview = { ok: true, preview: true, recipients: 0,
                       skipped: { already: 23, unsubscribed: 2, no_link: 1 } };
  document.getElementById('toast').textContent = '';
});
await pg.evaluate(() => document.querySelector('[data-dptell]').click());
await pg.waitForTimeout(400);
const allTold = await pg.evaluate(() =>
  document.getElementById('toast').textContent.replace(/\s+/g, ' '));
ok('everybody already told is a different sentence from nobody to tell',
   /Nobody new to tell/.test(allTold) && /23 already told/.test(allTold) &&
   /2 unsubscribed/.test(allTold) && /revoked or expired/.test(allTold), allTold);

// Email not configured must not read as "sent".
await pg.evaluate(() => {
  window.__noticeStatus = 501;
  document.getElementById('toast').textContent = '';
});
await pg.evaluate(() => document.querySelector('[data-dptell]').click());
await pg.waitForTimeout(400);
const unconf = await pg.evaluate(() => ({
  open: document.getElementById('modal').classList.contains('on'),
  toast: document.getElementById('toast').textContent.replace(/\s+/g, ' '),
}));
ok('an unconfigured mail service says so instead of claiming a send',
   unconf.open === false && /not set up/.test(unconf.toast), unconf.toast);
await pg.evaluate(() => { window.__noticeStatus = 200; });

// Once people have been told, the table says so and the button changes to
// offer only the difference.
await pg.evaluate(() => {
  window.__notices = [{ update_id: 'u2', lead_id: 'l1', status: 'sent' },
                      { update_id: 'u2', lead_id: 'l2', status: 'sent' },
                      { update_id: 'u2', lead_id: 'l3', status: 'failed' }];
});
await pg.evaluate(() => window.__renderWith(window.__stats));
await pg.waitForTimeout(400);
const counted = await pg.evaluate(() => {
  const rows = [...document.querySelectorAll('#drillpanel tbody tr')];
  const r = rows.find((x) => /Posted/.test(x.children[4].textContent) &&
                             /2 told/.test(x.children[4].textContent));
  return { found: !!r, label: r?.querySelector('[data-dptell]')?.textContent };
});
// Two sent, one failed: the count is what reached somebody, not what was tried.
ok('the table says how many were told, counting only the ones that arrived',
   counted.found === true, JSON.stringify(counted));
ok('...and the button then offers only anyone new',
   counted.label === 'Tell anyone new', String(counted.label));
await pg.evaluate(() => { window.__notices = []; });

console.log('\nerrors:', errs.length ? errs : 'none');
console.log('non-200:', missing.length ? missing : 'none');
// The harness page has no favicon; nothing else may be missing.
const real = missing.filter((m) => !/favicon/.test(m));
ok('no page errors', errs.filter((e) => !/Failed to load resource/.test(e)).length === 0, errs.join('; '));
ok('nothing the console needs is missing', real.length === 0, real.join(', '));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
console.log('screenshot: /tmp/drill-console.png');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
