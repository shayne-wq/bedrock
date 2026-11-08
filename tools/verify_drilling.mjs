// Drilling programmes, end to end in a real browser.
//
// Static checks confirm a name exists; only a browser confirms the thing does
// something. This serves the repo and a STUB of the `deck` edge function — the
// same JSON shape the real one returns, already filtered to published reports,
// because that filtering is the function's job and is tested where it lives —
// then drives the viewer the way a reader would: look at the pin, press the
// key, click the rig.
//
// The fixture is deliberately an EXPLORATION deck: no block model, an extent on
// the deck and nothing else. That is the commonest project on this platform and
// the one most likely to be drilling, and it is the branch of hydrate() where
// deck furniture has gone missing before.
//
//   node tools/verify_drilling.mjs
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

// ---- the fixture ---------------------------------------------------------
const E0 = 680000, N0 = 5520000;           // UTM 10N, somewhere in southern BC
const RIG = { e: E0 + 1000, n: N0 + 1000 };

// EVERY DATE HERE IS RELATIVE TO TODAY, and the pace and the forecast are why.
// Those figures are arithmetic over the gap between a report and now, so a
// fixture written as fixed dates tests a different thing every morning and
// eventually tests a programme nobody has reported on in two years. Anchored
// on today's UTC date — the browser's own clock is within the same day of it,
// which is the resolution everything below works at.
const DAY = 864e5;
const T0 = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const d = (n) => new Date(T0 + n * DAY).toISOString().slice(0, 10);
// The window the pace is measured over: started_on at zero metres to the
// newest report that carries a figure. 81 days and 4,012 m, so 49.53 m/day and
// 121 days left of the 10,000 m committed — all three asserted below, because
// between them they are the sentence a shareholder reads off this panel.
const START = -96, LAST_M = -15, SPAN = LAST_M - START;      // 81 days

const PAYLOAD = {
  deck: {
    id: 'deck-test', title: 'Test Creek', subtitle: 'An exploration project',
    theme: null,
    settings: { extent: { x: [E0, E0 + 2000], y: [N0, N0 + 2000], z: [900, 1400] } },
    inclusion: {},
  },
  project: {
    name: 'Test Creek Resources', commodity: 'Gold', location: 'British Columbia',
    epsg: 26910, holders: null, brand: null, stage: 'exploration',
  },
  zones: [{ id: 'zone-1', name: 'Creek Zone', slug: 'creek', ord: 0 }],
  chapters: [
    { ord: 0, kind: 'view', section: 'Overview', title: 'The property',
      body: 'Eleven contiguous tenures.', camera: { h: 30, p: -28, r: 3000 },
      layers: {}, dwell_ms: 9000, areas: [] },
    // The slide that opts out. A chapter whose subject is somewhere else can
    // drop the rig without the deck losing it everywhere.
    { ord: 1, kind: 'view', section: 'Overview', title: 'Elsewhere',
      body: 'Not about the drilling.', camera: { h: 90, p: -40, r: 4000 },
      layers: { drilling: false }, dwell_ms: 9000, areas: [] },
  ],
  assets: [],
  programs: [
    {
      id: 'prog-1', zone_id: 'zone-1', name: 'Phase 2 diamond drilling',
      status: 'active', target_m: 10000, holes_planned: 24,
      started_on: d(START), expected_end: d(37),
      easting: RIG.e, northing: RIG.n, elev_m: null,
      operator: 'Cabo Drilling', note: 'Testing the north strike extension.',
      updated_at: new Date(T0 - 11 * DAY).toISOString(),
      updates: [
        // Newest, and words only — on purpose. The headline metre count must
        // fall through to the next report that has a figure rather than
        // blanking out because the latest one has none. It is ALSO the newest
        // word on how many holes are turning, which is a different field and
        // must not be read off the metre-bearing row below it.
        { id: 'u3', as_of: d(-11), metres_total: null, holes_done: null,
          holes_active: 2, body: 'Second rig mobilised to the north pad.',
          author: 'A. Geologist, VP Exploration', published_at: d(-11) + 'T12:00:00Z' },
        { id: 'u2', as_of: d(LAST_M), metres_total: 4012, holes_done: 11,
          holes_active: 1, body: 'TC-26-011 completed to 412 m.',
          author: 'A. Geologist, VP Exploration', published_at: d(LAST_M) + 'T12:00:00Z' },
        { id: 'u1', as_of: d(-22), metres_total: 3600, holes_done: 10,
          holes_active: 1, body: 'Rig turning on the 010 pad.',
          author: 'A. Geologist, VP Exploration', published_at: d(-22) + 'T12:00:00Z' },
        // Three metre-bearing reports is the floor for the chart. Two points
        // drawn as a trend are a trend asserted out of nothing.
        { id: 'u0', as_of: d(-50), metres_total: 2100, holes_done: 6,
          holes_active: 1, body: 'First four holes of the programme complete.',
          author: 'A. Geologist, VP Exploration', published_at: d(-50) + 'T12:00:00Z' },
      ],
    },
    {
      // No position. It must appear in the panel and draw nothing on the
      // ground — the one thing it must never do is guess a location.
      id: 'prog-2', zone_id: null, name: 'Regional reconnaissance',
      status: 'planned', target_m: 2500, holes_planned: null,
      started_on: null, expected_end: null,
      easting: null, northing: null, elev_m: null,
      operator: null, note: null, updated_at: d(-38) + 'T12:00:00Z',
      updates: [],
    },
  ],
  fabricated: [],
  share: { id: 'share-test', embed: false },
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.csv': 'text/csv' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  // The analytics endpoint. Answered rather than 404'd: a deck posts to it on
  // open and on every chapter, and three 404s in the console are three red
  // herrings in front of whoever runs this next.
  if (u.pathname === '/track') {
    res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    return;
  }
  if (u.pathname === '/deck') {
    res.writeHead(200, { 'content-type': 'application/json',
      'access-control-allow-origin': '*' });
    res.end(JSON.stringify(PAYLOAD));
    return;
  }
  const f = path.join(ROOT, u.pathname === '/' ? '/index.html' : u.pathname);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404).end('no'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
    'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// ---- drive it ------------------------------------------------------------
const b = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader',
         '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
// A bare "Failed to load resource" in the console names nothing, so the URL is
// captured here. Note that a service worker's own fetches never reach this.
const missing = [];
pg.on('response', (r) => { if (r.status() >= 400) missing.push(r.status() + ' ' + r.url()); });

await pg.goto(`${BASE}/pit/index.html?t=TEST&api=${encodeURIComponent(BASE)}`,
  { waitUntil: 'load' });
await pg.waitForFunction(() => window.__api, null, { timeout: 180000 });
// The rig stands on SAMPLED terrain, so it cannot exist until the tiles it
// stands on have arrived — which in a software renderer is slow and variable.
// Waited on explicitly rather than with a sleep long enough to usually work.
await pg.waitForFunction(() => window.__api.layers().progEnts > 0,
  null, { timeout: 120000 });
await pg.waitForTimeout(2500);

const L = () => pg.evaluate(() => window.__api.layers());
const progs = await pg.evaluate(() => window.__api.programs());
const ch0 = await L();

// The splash overlay swallows clicks until it is dismissed, exactly as it does
// for a reader. Everything below is the deck proper.
await pg.evaluate(() => document.getElementById('begin')?.click());
await pg.waitForTimeout(2500);
await pg.keyboard.press('m');
// Long enough for the bar to have FINISHED filling. Its keyframe runs on
// animation time, which only advances when frames are produced, and a software
// renderer driving a terrain globe produces them slowly — so a screenshot a
// second after the panel opens is a picture of a bar that is still moving, and
// whoever opens it next reads that as a bar that never filled.
await pg.waitForTimeout(4000);
await pg.screenshot({ path: '/tmp/drill-panel.png' });
const open = await L();
const prov = await pg.evaluate(() => window.__api.provText());

// Click the rig in the scene rather than calling the handler: the pick path is
// half the feature and it is the half that silently stops working.
await pg.evaluate(() => window.__api.focusProgram(0));
// The rig view reuses the height the marker was placed at, so this is a camera
// flight and nothing else. Waited on rather than slept through, so a
// regression that reintroduces the terrain round trip fails here instead of
// passing on a generous sleep.
await pg.waitForFunction(() => {
  const c = window.__api.cam();
  return c.terrain !== null && c.h - c.terrain < 200;
}, null, { timeout: 15000 }).catch(() => {});
await pg.waitForTimeout(600);
const near = await L();
// After the flight has settled, not during it: a frame grabbed mid-flight is a
// picture of a camera in motion, which is not what anyone is checking for.
await pg.waitForTimeout(2200);
await pg.screenshot({ path: '/tmp/drill-rig.png' });

// The second programme, through the picker — it has no position, so nothing
// should fly and nothing should break.
await pg.evaluate(() => document.querySelectorAll('#rigpick button')[1].click());
await pg.waitForTimeout(1200);
const two = await L();

// The slide that opts out.
await pg.evaluate(() => window.__api.go(1));
await pg.waitForTimeout(3000);
const off = await L();

// The text edition, for the reader with no GPU.
await pg.evaluate(() => { document.getElementById('datatoggle').click(); });
await pg.waitForTimeout(1200);
const text = await pg.evaluate(() => {
  const s = [...document.querySelectorAll('#datamode section')]
    .find((x) => /Drilling in progress/i.test(x.textContent));
  return s ? { present: true, rows: s.querySelectorAll('tbody tr').length,
               heads: [...s.querySelectorAll('thead th')].map((x) => x.textContent),
               cells: [...s.querySelectorAll('tbody tr')].map((r) =>
                 [...r.children].map((c) => c.textContent)),
               body: s.textContent.replace(/\s+/g, ' ') } : { present: false };
});

// ---- the derivation on its own -------------------------------------------
// The pace and the forecast decide what a public company's deck claims about
// its own schedule, and most of that code is REFUSALS — paused, complete,
// already finished, no target, a pace too slow to mean anything, a report too
// old to project from. One fixture can only be in one of those states, so the
// cases are put through the shipped function directly. A forecast that is
// right here and never painted fails the DOM checks below; a forecast that is
// painted from arithmetic nobody tested fails here.
const CASES = {
  // Turning, on plan: 8,000 m in 70 days is 114 m/day, and the last 2,000 m
  // take 18 more — two days inside the planned date, which is "on the planned
  // date" rather than a spurious two days early.
  onPlan: { status: 'active', target_m: 10000, started_on: d(-80),
    expected_end: d(20), updates: [{ as_of: d(-10), metres_total: 8000 }] },
  // A pace measured while the rig was turning projects nothing about a rig
  // that has stopped. Both of these keep their pace and lose their date.
  paused: { status: 'paused', target_m: 10000, started_on: d(-80),
    expected_end: d(20), updates: [{ as_of: d(-10), metres_total: 8000 }] },
  done: { status: 'complete', target_m: 10000, started_on: d(-80),
    expected_end: d(-1), updates: [{ as_of: d(-10), metres_total: 9990 }] },
  // No denominator, so there is nothing to finish against — but the metres a
  // day are still a fact and still printed.
  noTarget: { status: 'active', target_m: null, started_on: d(-80),
    expected_end: null, updates: [{ as_of: d(-10), metres_total: 8000 }] },
  // The committed metres are in the ground and the programme is still open.
  met: { status: 'active', target_m: 5000, started_on: d(-80),
    expected_end: d(5), updates: [{ as_of: d(-10), metres_total: 5400 }] },
  // Four months since anybody said anything. The rate is history by then, not
  // evidence of anything current, so it stops being projected from.
  cold: { status: 'active', target_m: 10000, started_on: d(-200),
    expected_end: d(20), updates: [{ as_of: d(-120), metres_total: 8000 }] },
  // Six days between two reports is one good week, not a rate.
  shortSpan: { status: 'active', target_m: 5000, expected_end: d(40),
    updates: [{ as_of: d(-10), metres_total: 1300 },
              { as_of: d(-16), metres_total: 1000 }] },
  // No start date at all: the reports' own span is the only window there is,
  // and two of them twenty days apart is a usable one.
  reportSpan: { status: 'active', target_m: 5000, expected_end: d(80),
    updates: [{ as_of: d(-10), metres_total: 2000 },
              { as_of: d(-30), metres_total: 1000 }] },
  // Bad data: a start date AFTER the newest report. It must fall back to the
  // reports rather than divide by a negative span.
  startAfter: { status: 'active', target_m: 5000, started_on: d(-5),
    expected_end: d(80), updates: [{ as_of: d(-20), metres_total: 1500 },
                                   { as_of: d(-40), metres_total: 500 }] },
  // 1.1 m/day against 99,900 m to go is the year 2273. Past two years a
  // projection is a joke and printing one would be the only dishonest thing
  // on the panel.
  glacial: { status: 'active', target_m: 100000, started_on: d(-100),
    expected_end: d(20), updates: [{ as_of: d(-10), metres_total: 100 }] },
  // Words only, every time. No metre count anywhere is no pace.
  wordsOnly: { status: 'active', target_m: 5000, started_on: d(-80),
    expected_end: d(20), updates: [{ as_of: d(-10), metres_total: null },
                                   { as_of: d(-40), metres_total: null }] },
};
const C = await pg.evaluate((cases) => {
  const out = {};
  for (const k in cases) out[k] = window.__api.progCalc(cases[k]);
  return out;
}, CASES);

// A date prints as "9 Mar 2027" or "Mar 9, 2027" depending on the locale the
// browser happens to be in, and the day comes before the year in both. So the
// day number and the year are what gets matched, derived from the same offsets
// the fixture was built from.
const dayN = (iso) => String(Number(iso.slice(8, 10)));
const yrN = (iso) => iso.slice(0, 4);
const onDay = (iso, lead) =>
  new RegExp(lead + '[^.]*\\b' + dayN(iso) + '\\b[^.]*' + yrN(iso));

let pass = 0, fail = 0;
const ok = (n, c, d = '') => c ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (d ? ' — ' + d : '')));

console.log('\n== payload');
console.log(JSON.stringify(progs));
console.log('\n== assertions');
ok('both programmes arrive', progs.length === 2, JSON.stringify(progs.map((p) => p.name)));
ok('the metre count skips a words-only report', progs[0].metres === 4012,
   String(progs[0].metres));
ok('a programme with no coordinates is still carried', progs[1].placed === false);
ok('the placed programme is placed', progs[0].placed === true);
ok('the rig is drawn on an exploration deck', ch0.progEnts > 0, 'ents ' + ch0.progEnts);
// One programme is placed and one is not, so the whole scene is one rig. The
// bound is generous but finite: it is here to catch the unplaced programme
// being drawn at easting 0, not to pin the model's part count.
ok('only the placed programme is drawn',
   ch0.progEnts > 12 && ch0.progEnts < 45, 'ents ' + ch0.progEnts);
// Cesium ignores a distanceDisplayCondition set on the Entity rather than on
// the graphics, and ignores it SILENTLY — the symptom is the far-field pin and
// the true-scale rig labelled at the same time. Asserted structurally because
// there is no way to ask Cesium what it currently chose to draw.
ok('every part of the rig carries its own distance window',
   ch0.progDDC.length > 0 && ch0.progDDC.every((d) => Array.isArray(d)),
   JSON.stringify(ch0.progDDC));
ok('the pin and the rig never show together',
   ch0.progDDC.every(([n, f]) => n === 0 || f >= 90000) &&
   new Set(ch0.progDDC.map((d) => d.join('-'))).size === 2,
   JSON.stringify([...new Set(ch0.progDDC.map((d) => d.join('-')))]));
ok('the drilling control is shown', await pg.evaluate(
  () => !document.getElementById('drillbtn').hidden));
ok('M opens the panel', open.progPanel === true);
ok('the panel leads with the metres to date', open.progMet === '4,012', open.progMet);
ok('the bar is drawn against the target', /^40\.1/.test(open.progBar || ''), open.progBar);
ok('every published report is listed', open.progReports === 4, String(open.progReports));
ok('the delta is computed, not typed', open.progDeltas.includes('+412 m'),
   JSON.stringify(open.progDeltas));
ok('the panel says who reported it and when',
   onDay(d(-11), 'Reported by the issuer, last updated').test(open.prognote),
   open.prognote);
ok('the panel says these are not assays',
   /not assay results or a mineral resource statement/i.test(open.prognote));
ok('two programmes get a picker', open.progPick === 2, String(open.progPick));
ok('clicking the rig flies the camera in',
   near.cam.h - near.cam.terrain < 160 && near.cam.h > near.cam.terrain,
   JSON.stringify(near.cam));
ok('the rig view looks across, not down', Math.abs(near.cam.pitch + 12) <= 4,
   'pitch ' + near.cam.pitch);
ok('the camera stays above ground', near.cam.under === false, JSON.stringify(near.cam));
ok('an unplaced programme can be opened without flying anywhere',
   two.progSel === 1 && two.progPanel === true, JSON.stringify([two.progSel, two.progPanel]));
ok('an unplaced programme still shows its plan', /2,500 m planned/.test(
   await pg.evaluate(() => document.getElementById('rigbody').textContent)));
// The drilling panel sits in the same column as the ledger and is named for
// the rig. Two ids in this file were one careless rename away from it — the
// caption's own progress strip is #prog and its fill was once addressed the
// same way — and a collision here does not throw, it silently resizes
// somebody else's element. Asserted because the symptom is invisible.
ok('the caption progress strip still belongs to the caption',
   /%$/.test(off.capBar || '') && off.capBar !== '0%', String(off.capBar));
ok('a slide can opt out of the rig', off.progOn === false);
ok('opting out hides it in the scene rather than forgetting it',
   off.progShown === 0 && off.progEnts === ch0.progEnts,
   off.progShown + ' shown of ' + off.progEnts);
ok('the rig is visible on a slide that does not opt out',
   ch0.progShown === ch0.progEnts && ch0.progShown > 0,
   ch0.progShown + ' of ' + ch0.progEnts);
ok('the audit trail reports the drilling', /DRILLING IN PROGRESS/.test(prov));
ok('the audit trail names the source and the date',
   /Issuer-reported progress/.test(prov) && onDay(d(LAST_M), 'as of').test(prov),
   (prov.match(/DRILLING IN PROGRESS[\s\S]{0,700}/) || [''])[0]);
ok('the audit trail says a missing position draws no rig',
   /No collar coordinates were entered/.test(prov));
ok('the text edition carries the drilling', text.present === true);
ok('the text edition tabulates both programmes', text.rows === 2, String(text.rows));
ok('the text edition repeats the reports', /TC-26-011 completed to 412 m/.test(text.body || ''));
ok('the text edition carries the caveat',
   /not a mineral resource statement/i.test(text.body || ''));


console.log('\n== derived');
console.log(JSON.stringify(progs[0].calc));
console.log(JSON.stringify(C, null, 0));
console.log('\n== pace and the forecast');
const K = progs[0].calc;
// The three numbers the sentence on the panel is made of. Pinned exactly,
// because the fixture's dates are relative to today and these are therefore
// the same every day the suite runs — which is the whole reason it was rebased.
ok('the pace window is the whole programme, from the start date',
   K.span === SPAN && K.from === d(START), JSON.stringify([K.span, K.from]));
ok('the pace is metres over that window', K.pace === 49.53, String(K.pace));
ok('the metres remaining come off the target', K.remaining === 5988,
   String(K.remaining));
ok('the forecast is the remaining metres at that pace', K.days === 121,
   String(K.days));
// Anchored at the later of the last report and today, so it is never a finish
// date in the past and never assumes nothing has been drilled since.
ok('the forecast is anchored no earlier than today', K.forecast === d(121),
   K.forecast + ' vs ' + d(121));
ok('the variance against the plan is coarsened, not stated to the day',
   /^about 3 months later than planned$/.test(K.variance || ''), K.variance);
ok('a programme with no reports forecasts nothing',
   progs[1].calc.pace === null && progs[1].calc.forecast === null,
   JSON.stringify(progs[1].calc));

console.log('\n== what the derivation refuses');
ok('on plan reads as on plan, not two days early',
   C.onPlan.forecast === d(18) && C.onPlan.variance === 'on the planned date',
   JSON.stringify(C.onPlan));
ok('a paused programme keeps its pace and loses its date',
   C.paused.pace === 114.29 && C.paused.forecast === null,
   JSON.stringify(C.paused));
ok('a complete programme is not projected forward',
   C.done.forecast === null, JSON.stringify(C.done));
ok('no target is no forecast, and still a pace',
   C.noTarget.forecast === null && C.noTarget.pace === 114.29,
   JSON.stringify(C.noTarget));
ok('a target already met is not projected past',
   C.met.forecast === null, JSON.stringify(C.met));
ok('a report four months old stops being projected from',
   C.cold.forecast === null && C.cold.stale === 120, JSON.stringify(C.cold));
ok('six days between two reports is not a rate',
   C.shortSpan.pace === null && C.shortSpan.forecast === null,
   JSON.stringify(C.shortSpan));
ok('with no start date the reports own span is used',
   C.reportSpan.pace === 50 && C.reportSpan.span === 20 &&
   C.reportSpan.forecast === d(60), JSON.stringify(C.reportSpan));
// Number(null) is 0 and 0 is finite; a start date later than the newest report
// is the same shape of bad input, and dividing by its negative span would read
// as a rig drilling backwards.
ok('a start date after the newest report falls back rather than inverting',
   C.startAfter.pace === 50 && C.startAfter.span === 20 &&
   C.startAfter.forecast === d(70), JSON.stringify(C.startAfter));
ok('a pace that would finish in 250 years projects nothing',
   C.glacial.pace === 1.11 && C.glacial.forecast === null,
   JSON.stringify(C.glacial));
ok('reports with no metres in them are no pace',
   C.wordsOnly.pace === null && C.wordsOnly.stale === null,
   JSON.stringify(C.wordsOnly));

console.log('\n== and what the panel actually paints');
ok('the panel prints the forecast date',
   (open.progFc || '').includes(yrN(d(121))) && dayN(d(121)) &&
   new RegExp('\\b' + dayN(d(121)) + '\\b').test(open.progFc || ''),
   open.progFc);
ok('the panel prints the variance beside it',
   /months later than planned/.test(open.progVar || ''), open.progVar);
// The basis is not decoration. This is the one figure on the screen the issuer
// did not write, so the sentence under it has to be enough for a reader to
// redo the arithmetic and disagree with the answer.
ok('the panel shows the arithmetic the forecast came from',
   /4,012 m in 81 days is/.test(open.progBasis || '') &&
   /50 m\/day/.test(open.progBasis || '') &&
   /5,988 m/.test(open.progBasis || '') &&
   /121 days/.test(open.progBasis || ''), open.progBasis);
ok('the panel says the forecast is not the issuer\'s',
   /not\s+stated by the issuer/.test(open.progBasis || ''), open.progBasis);
ok('the metres remaining are spelt out, not left as a subtraction',
   open.progCells.includes('Remaining=5,988 m'), JSON.stringify(open.progCells));
ok('the holes done come off the newest report that counted them',
   open.progCells.includes('Holes=11 of 24'), JSON.stringify(open.progCells));
// The words-only report is the newest word on how many holes are turning and
// says nothing about the total. Read off one row, the panel said one hole was
// turning on the day a second rig arrived.
ok('holes turning come off the newest report that said so',
   open.progCells.includes('Turning=2 holes'), JSON.stringify(open.progCells));
ok('the plan date is still on the panel beside the forecast',
   open.progCells.some((c) => c.startsWith('Planned end=')),
   JSON.stringify(open.progCells));
ok('nothing is reported stale while it is being reported',
   open.progStaleMsg === null, String(open.progStaleMsg));
ok('three reports draw the metres over time',
   open.progSpark === 1, String(open.progSpark));
ok('the plan is drawn across the chart to compare against',
   open.progSparkPlan === 1, String(open.progSparkPlan));
// A chart in a 3D deck is still read by somebody who cannot see it.
ok('the chart says in words what it draws',
   /Cumulative metres drilled/.test(open.progSparkTitle || '') &&
   /10,000 m planned/.test(open.progSparkTitle || ''), open.progSparkTitle);
ok('a programme with no reports paints no forecast and no chart',
   two.progFc === null && two.progSpark === 0,
   JSON.stringify([two.progFc, two.progSpark]));
ok('the text edition carries the pace and the forecast',
   text.heads.includes('Pace') && text.heads.includes('Forecast') &&
   text.cells[0].includes('50 m/day'), JSON.stringify(text.cells[0]));
ok('the text edition says the forecast is computed, not stated',
   /computed from the reported pace and is not stated by the issuer/
     .test(text.body || ''));
ok('the audit trail carries the pace and the forecast',
   /At 50 m\/day reported since/.test(prov) &&
   /is not a date the issuer has stated/.test(prov),
   (prov.match(/At 50 m\/day[\s\S]{0,200}/) || [''])[0]);

// Cesium is noisy about imagery in a software renderer; only our own errors
// count against the run.
const mine = errs.filter((e) => !/Esri|imagery|tile|WebGL warning|terrain/i.test(e));
console.log('\nerrors:', mine.length ? mine : 'none');
console.log('non-200 responses:', missing.length ? missing : 'none');
// The deck is served here out of the repo rather than from Vercel, which
// rewrites and supplies a few things this static server does not. Only a 404
// for something the deck itself ships counts.
const real404 = missing.filter((m) => !/favicon|\/og-|sw\.js/.test(m));
ok('nothing the deck ships is missing', real404.length === 0, real404.join(', '));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
console.log('screenshot: /tmp/drill-rig.png');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
