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
    status: 'active', target_m: 10000, holes_planned: 24, started_on: '2026-08-04',
    expected_end: '2026-12-15', easting: 681000, northing: 5521000, elev_m: null,
    operator: 'Cabo Drilling', note: 'Testing the north strike extension.' },
  { id: 'p2', project_id: 'proj', zone_id: null, name: 'Regional reconnaissance',
    status: 'planned', target_m: 2500, holes_planned: null, started_on: null,
    expected_end: null, easting: null, northing: null, elev_m: null,
    operator: null, note: null },
];
const UPS = [
  { id: 'u3', program_id: 'p1', as_of: '2026-10-28', metres_total: null,
    holes_done: null, holes_active: 2, body: 'Second rig mobilised.',
    author: 'A. Geologist', published_at: null },
  { id: 'u2', program_id: 'p1', as_of: '2026-10-24', metres_total: 4012,
    holes_done: 11, holes_active: 1, body: 'TC-26-011 completed to 412 m.',
    author: 'A. Geologist', published_at: '2026-10-24T12:00:00Z' },
  { id: 'u1', program_id: 'p1', as_of: '2026-10-17', metres_total: 3600,
    holes_done: 10, holes_active: 1, body: 'Rig turning.',
    author: 'A. Geologist', published_at: '2026-10-17T12:00:00Z' },
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
        data = table === 'drill_programs' ? (window.__noProgs ? [] : PROGS) : UPS;
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
  auth: { getSession: async () => ({ data: { session: null } }) },
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
  latest: { id: 'GC24-03', on: '2026-10-29',
            easting: 498168, northing: 5521008, elev_m: 1122.7 },
};
const PROJ = { id: 'proj', org_id: 'org-1', name: 'Test Creek', epsg: 26910 };
const ZONES = [{ id: 'z1', name: 'Creek Zone' }];
const DATASETS = [{ id: 'd1', kind: 'drills', zone_id: 'z1',
                    storage_path: 'org/proj/drills.json', stats: FILE_STATS,
                    provenance: { uploaded_at: '2026-10-30T09:00:00Z' } }];
window.__render = () => renderDrilling(PROJ, ZONES, DATASETS,
  document.getElementById('drillpanel'));
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
ok('the form says what was last reported', /4,012 m on 24 Oct 2026|4,012 m on Oct 24, 2026/.test(form.sub || ''), form.sub);
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
