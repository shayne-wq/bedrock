// Placing the rig by pointing at it, in a real browser.
//
// Two things are under test and only one of them is a user interface.
//
// The first is the projection. The console converts between the project's own
// grid and longitude/latitude with its own transverse Mercator — the viewer
// uses proj4 and the console does not carry it — and a projection that is
// quietly a few hundred metres out draws a rig in the next valley with total
// confidence. So the fixture below holds reference coordinates produced by
// PROJ itself, and `dashboard/lib/geo.js` has to agree with them to the
// centimetre. Regenerate them with:
//
//   python3 -c "from pyproj import Transformer; \
//     print(Transformer.from_crs(4326, 26910, always_xy=True).transform(-121.6, 49.8))"
//
// The second is the control: one position with two editors, and the rule that
// the pin and the boxes are never allowed to disagree.
//
// Tiles are intercepted and served locally. A test suite that reaches Esri is
// a test suite that fails on a train.
//
//   node tools/verify_rigmap.mjs
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

// Straight out of PROJ. Every point is INSIDE its own zone, which is not
// fussiness: Snyder's series is a series, and five degrees off a central
// meridian it and PROJ legitimately part company. A rig is always in its
// project's zone, so that is the range this has to be right over.
const REF = [
  { epsg: 26909, lon: -127.7754085, lat: 57.8081377, e: 572769.0016, n: 6408008.0009 },
  { epsg: 26910, lon: -121.6, lat: 49.8, e: 600747.8572, n: 5517334.3914 },
  { epsg: 26910, lon: -123.1207, lat: 49.2827, e: 491221.7707, n: 5458889.98 },
  { epsg: 26910, lon: -120.05, lat: 55.0, e: 688678.68, n: 6098771.7255 },
  { epsg: 26923, lon: -45.0, lat: 60.0, e: 500000.0, n: 6651411.1902 },
  { epsg: 32610, lon: -123.1207, lat: 49.2827, e: 491221.7707, n: 5458889.9801 },
  { epsg: 32601, lon: -177.0, lat: 0.5, e: 500000.0, n: 55265.0371 },
  { epsg: 32660, lon: 177.0, lat: 10.0, e: 500000.0, n: 1105412.4913 },
  { epsg: 32733, lon: 15.0, lat: -25.0, e: 500000.0, n: 7235052.2525 },
  { epsg: 32701, lon: -177.0, lat: -0.5, e: 500000.0, n: 9944734.9629 },
  { epsg: 28355, lon: 150.0, lat: -33.0, e: 780299.9895, n: 6344714.1457 },
  { epsg: 7855, lon: 150.0, lat: -33.0, e: 780299.9895, n: 6344714.1457 },
];

// The fixture property: six collars in a cluster, in EPSG:26910, and a claim
// outline around them already in lon/lat — which is how `orebody-claims/1` is
// stored, so it needs no conversion to draw.
const COLLARS = [
  [680900, 5520900, 1310], [681100, 5521100, 1290], [680750, 5521240, 1333],
  [681310, 5520780, 1270], [680980, 5521480, 1301], [681520, 5521190, 1288],
];
const CLAIM = [
  [-120.505509, 49.801083], [-120.463861, 49.800179],
  [-120.462451, 49.827135], [-120.504122, 49.82804],
];

const HARNESS = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="/dashboard/app.css">
<style>body{padding:24px;background:#f6f7f6}</style>
</head><body>
<main id="view"><div class="panel" id="drillpanel" hidden></div></main>
<div id="toast" role="status"></div>
<div class="modal" id="modal"><div class="inner" id="modalinner"></div></div>
<script>
window.__calls = [];
const PROGS = [
  { id: 'p1', project_id: 'proj', zone_id: 'z1', name: 'Phase 2 diamond drilling',
    status: 'active', target_m: 10000, holes_planned: 24, started_on: null,
    expected_end: null, easting: 681000, northing: 5521000, elev_m: null,
    operator: 'Cabo Drilling', note: 'Testing the north strike extension.' },
  { id: 'p2', project_id: 'proj', zone_id: null, name: 'Regional reconnaissance',
    status: 'planned', target_m: null, holes_planned: null, started_on: null,
    expected_end: null, easting: null, northing: null, elev_m: null,
    operator: null, note: null },
];
function builder(table, op) {
  const rec = { table, op, filters: [], payload: null };
  window.__calls.push(rec);
  const self = {
    select(c) { rec.select = c; return self; },
    eq(k, v) { rec.filters.push(['eq', k, v]); return self; },
    in(k, v) { return self; }, not() { return self; }, is() { return self; },
    order() { return self; }, limit() { return self; },
    maybeSingle() { return self; }, single() { return self; },
    then(res) {
      const data = rec.op === 'select'
        ? (table === 'drill_programs' ? PROGS : []) : [];
      return Promise.resolve(res({ data, error: null }));
    },
  };
  return self;
}
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
  from(table) {
    return {
      select(c) { return builder(table, 'select').select(c); },
      insert(row) { const b = builder(table, 'insert');
        window.__calls[window.__calls.length - 1].payload = row; return b; },
      update(row) { const b = builder(table, 'update');
        window.__calls[window.__calls.length - 1].payload = row; return b; },
      delete() { return builder(table, 'delete'); },
    };
  },
  // Distinct files per path, unlike the single stub the drilling console suite
  // needs — this one has to tell a collar file from a claim file.
  storage: { from: () => ({
    createSignedUrl: async (p) => ({
      data: { signedUrl: String(p).includes('claims') ? '/__claims.json'
                                                      : '/__traces.json' },
      error: null }),
  }) },
}) };
</script>
<script type="module">
import { state } from '/dashboard/lib/ui.js';
import { renderDrilling } from '/dashboard/drilling.js';
import * as geo from '/dashboard/lib/geo.js';
window.__geo = geo;
state.session = { user: { id: 'user-1' } };
state.roles = { 'org-1': 'owner' };
const DATASETS = [
  { id: 'd1', kind: 'drills', zone_id: 'z1', storage_path: 'org/proj/drills.json',
    stats: { holes: 6, metres: 2400 }, provenance: {} },
  { id: 'd2', kind: 'site', zone_id: null, storage_path: 'org/proj/claims.json',
    stats: {}, provenance: {} },
];
const ZONES = [{ id: 'z1', name: 'Creek Zone' }];
const el = document.getElementById('drillpanel');
// epsg is a parameter here because three of the assertions below are about
// what this screen does with a grid it will not convert.
window.__render = (epsg, datasets) => renderDrilling(
  { id: 'proj', org_id: 'org-1', name: 'Test Creek', epsg: epsg || 26910 },
  ZONES, datasets || DATASETS, el);
window.__datasets = DATASETS;
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
    return res.end(JSON.stringify({ traces: COLLARS.map((c, i) => ({
      id: 'TC-26-' + String(i + 1).padStart(3, '0'), collar: c })) }));
  }
  if (u.pathname === '/__claims.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ format: 'orebody-claims/1', crs: 'EPSG:4326',
      rings: [{ ring: CLAIM, props: { OWNER_NAME: 'Test Creek Resources' } }] }));
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
const pg = await b.newPage({ viewport: { width: 1280, height: 1100 } });

// One flat grey PNG for every tile. The imagery is not what is being tested
// and reaching for it would make this suite depend on somebody else's uptime.
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9' +
  'awAAAABJRU5ErkJggg==', 'base64');
// RIGMAP_TILES=live lets the real imagery through, for when the point is to
// LOOK at the screenshot rather than to test it. Off by default: the suite
// must pass with no network, and grey tiles prove the control just as well.
const LIVE = process.env.RIGMAP_TILES === 'live';
let tileHits = 0;
await pg.route(/arcgisonline\.com|openstreetmap\.org/, (route) => {
  tileHits++;
  if (LIVE) return route.continue();
  route.fulfill({ status: 200, contentType: 'image/png', body: TILE });
});

const errs = [], missing = [];
pg.on('response', (r) => { if (r.status() >= 400) missing.push(r.status() + ' ' + r.url()); });
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await pg.goto(`${BASE}/__harness`, { waitUntil: 'load' });
await pg.waitForFunction(() => window.__ready, null, { timeout: 30000 });

let pass = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  — ' + extra : '')); }
};
const sec = (s) => console.log('\n== ' + s);

const openPlan = async (id = 'p1') => {
  await pg.click(`[data-dpedit="${id}"]`);
  await pg.waitForSelector('#dpe', { timeout: 10000 });
};
const mapUp = () => pg.waitForFunction(
  () => { const w = document.getElementById('dpmapwrap');
          return w && !w.hidden && document.querySelector('.rigpin'); },
  null, { timeout: 15000 });
const boxes = () => pg.evaluate(() => [
  document.getElementById('dpe').value, document.getElementById('dpn').value]);
// Measured against the MAP, not the viewport. Clicking a field scrolls the
// modal, and a viewport-relative read calls that the pin moving 196 px — which
// is how the first run of this suite reported a map flying off during typing
// that had not moved at all.
// Where the pin is ON THE PAGE, which is the only thing the mouse understands.
// Kept separate from pinAt rather than folded into it: one of these answers
// "has the pin moved on the map", the other "where do I press to grab it",
// and the run that conflated them dragged empty space for three assertions.
const pinPage = () => pg.evaluate(() => {
  const r = document.querySelector('.rigpin').getBoundingClientRect();
  return [Math.round(r.left + r.width / 2), Math.round(r.bottom - 7)];
});
const pinAt = () => pg.evaluate(() => {
  const p = document.querySelector('.rigpin').getBoundingClientRect();
  const m = document.getElementById('dpmap').getBoundingClientRect();
  return [Math.round(p.left + p.width / 2 - m.left), Math.round(p.bottom - m.top)];
});
const closePlan = () => pg.click('#dpcancel');

// -------------------------------------------------------- the projection ---
sec('the projection agrees with PROJ');
const proj = await pg.evaluate((ref) => ref.map((c) => {
  const g = window.__geo.lonLatToGrid(c.lon, c.lat, c.epsg);
  const ll = window.__geo.gridToLonLat(c.e, c.n, c.epsg);
  const back = ll ? window.__geo.lonLatToGrid(ll[0], ll[1], c.epsg) : null;
  return {
    epsg: c.epsg,
    dE: g ? Math.abs(g[0] - c.e) : null,
    dN: g ? Math.abs(g[1] - c.n) : null,
    trip: back ? Math.max(Math.abs(back[0] - c.e), Math.abs(back[1] - c.n)) : null,
  };
}), REF);
for (const r of proj) {
  ok(`EPSG ${r.epsg} forward is within a centimetre of PROJ`,
     r.dE !== null && r.dE < 0.01 && r.dN < 0.01, `dE=${r.dE} dN=${r.dN}`);
}
ok('the inverse round-trips to within a millimetre',
   proj.every((r) => r.trip !== null && r.trip < 0.001),
   String(Math.max(...proj.map((r) => r.trip ?? 9))));

sec('and refuses what it cannot answer for');
const refusals = await pg.evaluate(() => ({
  nad27: window.__geo.utmFor(26710),
  isN27: window.__geo.isNAD27(26710),
  notN27: window.__geo.isNAD27(26910),
  albers: window.__geo.utmFor(3005),
  rubbish: window.__geo.utmFor('banana'),
  // A longitude the far side of the antimeridian from the zone. Unwrapped,
  // this is an arc of twenty radians and an easting in the billions.
  wrap: window.__geo.lonLatToGrid(179.9, 0, 32601),
}));
ok('NAD27 gets no projection at all', refusals.nad27 === null);
ok('...and is named as NAD27, not just refused', refusals.isN27 === true);
ok('a NAD83 code is not mistaken for NAD27', refusals.notN27 === false);
ok('a non-UTM grid is refused', refusals.albers === null);
ok('a code that is not a number is refused', refusals.rubbish === null);
ok('a longitude across the antimeridian stays on the planet',
   refusals.wrap && Math.abs(refusals.wrap[0]) < 1e7, JSON.stringify(refusals.wrap));

// ------------------------------------------------------------ the screen ---
sec('the map opens on a programme that has a position');
await openPlan();
await mapUp();
const mounted = await pg.evaluate(() => ({
  hidden: document.getElementById('dpmapwrap').hidden,
  pin: !!document.querySelector('.rigpin'),
  // By class, not by element: Leaflet draws BOTH a collar dot and a claim
  // boundary as <path>, so counting paths cannot tell them apart and counting
  // <circle> finds neither.
  dots: document.querySelectorAll('path.rigmap-collar').length,
  rings: document.querySelectorAll('path.rigmap-claim').length,
  attrib: (document.querySelector('.leaflet-control-attribution') || {}).textContent || '',
  scale: !!document.querySelector('.leaflet-control-scale-line'),
  hint: document.getElementById('dpmaphint').textContent,
  readout: (document.querySelector('.rigmap-readout') || {}).textContent || '',
}));
ok('the map is shown', mounted.hidden === false);
ok('the rig pin is on it', mounted.pin);
ok('every collar in the file is drawn', mounted.dots === COLLARS.length,
   String(mounted.dots));
ok('the claim outline is drawn, and only once', mounted.rings === 1,
   String(mounted.rings));
ok('the imagery is credited', /Esri/.test(mounted.attrib));
ok('there is a scale bar, because metres are the units of this screen',
   mounted.scale);
ok('tiles were asked for', tileHits > 0, String(tileHits));
ok('the hint says how to use it', /Drag the rig/.test(mounted.hint));
// The boxes are below a map in a form that scrolls, so during a drag they are
// often off the bottom of the screen. The figure that is changing is also on
// the thing being dragged.
ok('the live position is on the map, not only in the boxes below it',
   /E\s+681 000/.test(mounted.readout) && /N\s+5 521 000/.test(mounted.readout),
   mounted.readout);
ok('...and how far the pin is from the nearest hole',
   /Nearest collar \d+ m away/.test(mounted.hint), mounted.hint);

// The picture. Tiles are drawn on a canvas that has to actually arrive, and
// under a stub they arrive at once — with live imagery they do not, which is
// the only reason this waits.
await pg.waitForTimeout(LIVE ? 4000 : 500);
await pg.screenshot({ path: '/tmp/rig-map.png' });

sec('the pin and the boxes are one position');
const before = await boxes();
ok('the boxes open on the stored position',
   before[0] === '681000' && before[1] === '5521000', before.join(','));

// A real drag, with the boxes read BEFORE the button comes up. Waiting for
// the drop is the bug this is written against: the boxes would sit stale and
// wrong for as long as the drag lasted.
const p0 = await pinPage();
await pg.mouse.move(p0[0], p0[1]);
await pg.mouse.down();
await pg.mouse.move(p0[0] + 70, p0[1] - 46, { steps: 12 });
const during = await boxes();
const readDuring = await pg.textContent('.rigmap-readout');
await pg.mouse.up();
const after = await boxes();
ok('the boxes move WHILE the pin is being dragged',
   during[0] !== before[0] || during[1] !== before[1],
   `${before.join(',')} -> ${during.join(',')}`);
ok('dragging east increases the easting',
   Number(during[0]) > Number(before[0]), `${before[0]} -> ${during[0]}`);
ok('dragging up the screen increases the northing',
   Number(during[1]) > Number(before[1]), `${before[1]} -> ${during[1]}`);
ok('the drop does not undo the drag',
   after[0] === during[0] && after[1] === during[1],
   `${during.join(',')} -> ${after.join(',')}`);
// Imagery is georeferenced to a few metres; a tenth of a metre off a click is
// a precision nobody measured.
ok('a map-placed position is whole metres, not false decimals',
   /^-?\d+$/.test(after[0]) && /^-?\d+$/.test(after[1]), after.join(','));
ok('the nearest-collar distance follows the pin',
   /Nearest collar/.test(await pg.textContent('#dpmaphint')));
ok('the on-map readout counts up with the drag too',
   readDuring !== mounted.readout, `${mounted.readout} -> ${readDuring}`);
ok('...and reads the same position the boxes do',
   readDuring.replace(/[^0-9]/g, '') === (during[0] + during[1]).replace(/[^0-9]/g, ''),
   `${readDuring} vs ${during.join(',')}`);

sec('clicking the map puts the rig there');
const box = await pg.evaluate(() => {
  const r = document.getElementById('dpmap').getBoundingClientRect();
  return { page: [Math.round(r.left + r.width * 0.3), Math.round(r.top + r.height * 0.7)],
           inMap: [Math.round(r.width * 0.3), Math.round(r.height * 0.7)] };
});
await pg.mouse.click(box.page[0], box.page[1]);
await pg.waitForTimeout(150);
const clicked = await boxes();
ok('the boxes follow a click on the ground',
   clicked[0] !== after[0] || clicked[1] !== after[1],
   `${after.join(',')} -> ${clicked.join(',')}`);
const pinNow = await pinAt();
ok('...and the pin is where the click was',
   Math.abs(pinNow[0] - box.inMap[0]) < 6 && Math.abs(pinNow[1] - box.inMap[1]) < 6,
   `${pinNow.join(',')} vs ${box.inMap.join(',')}`);

sec('typing moves the pin, but only once the number is finished');
const pinBeforeTyping = await pinAt();
await pg.click('#dpe', { clickCount: 3 });
await pg.keyboard.type('6815');
const midType = await pinAt();
ok('a half-typed easting does not fly the map somewhere else',
   Math.abs(midType[0] - pinBeforeTyping[0]) < 3 &&
   Math.abs(midType[1] - pinBeforeTyping[1]) < 3,
   `${pinBeforeTyping.join(',')} -> ${midType.join(',')}`);
await pg.fill('#dpe', '681500');
await pg.fill('#dpn', '5521500');
await pg.evaluate(() => document.getElementById('dpn').blur());
await pg.waitForTimeout(250);
const pinTyped = await pinAt();
ok('a finished number moves the pin',
   Math.abs(pinTyped[0] - pinBeforeTyping[0]) > 3 ||
   Math.abs(pinTyped[1] - pinBeforeTyping[1]) > 3,
   `${pinBeforeTyping.join(',')} -> ${pinTyped.join(',')}`);
ok('typing is not rounded out from under the person typing',
   (await boxes())[0] === '681500');

sec('the centre button moves the map too');
await pg.click('#dpmid');
await pg.waitForFunction(
  () => /Centre of \d+ collar/.test(document.getElementById('dpmidnote').textContent),
  null, { timeout: 10000 });
const centred = await boxes();
ok('the centre of the collars lands in the boxes',
   Math.abs(Number(centred[0]) - 681093) < 60, centred[0]);
const pinCentred = await pinAt();
await pg.waitForTimeout(150);
ok('the pin went with it, so the screen shows one answer not two',
   Math.abs(pinCentred[0] - pinTyped[0]) > 2 ||
   Math.abs(pinCentred[1] - pinTyped[1]) > 2);

sec('a programme with no position still gets a map');
await closePlan();
await openPlan('p2');
await mapUp();
ok('the map opens around what the project has instead',
   (await pg.evaluate(() => !document.getElementById('dpmapwrap').hidden)));
ok('...and the boxes stay empty until the issuer says otherwise',
   (await boxes()).join('') === '');
await closePlan();

// ------------------------------------------------------- what it refuses ---
sec('the grids it will not draw say so, in the sentence under the boxes');
await pg.evaluate(() => window.__render(26710));   // NAD27 / UTM 10N
await pg.waitForTimeout(400);
await openPlan();
await pg.waitForTimeout(600);
let note = await pg.textContent('#dpgridnote');
ok('no map for a NAD27 project',
   await pg.evaluate(() => document.getElementById('dpmapwrap').hidden));
ok('...and the reason names NAD27', /NAD27/.test(note), note);
ok('...and says it is the datum, not the console being unhelpful',
   /datum shift/.test(note), note);
await closePlan();

await pg.evaluate(() => window.__render(3005));    // BC Albers
await pg.waitForTimeout(400);
await openPlan();
await pg.waitForTimeout(600);
note = await pg.textContent('#dpgridnote');
ok('no map for a grid that is not UTM',
   await pg.evaluate(() => document.getElementById('dpmapwrap').hidden));
ok('...and the sentence names the grid it got', /3005/.test(note), note);
ok('...and a NAD27 reason is not given for a non-NAD27 grid',
   !/NAD27/.test(note), note);
await closePlan();

sec('nothing to anchor on is a sentence, not an empty ocean');
await pg.evaluate(() => window.__render(26910, []));
await pg.waitForTimeout(400);
await pg.click('[data-dpedit="p2"]');     // p2 has no position either
await pg.waitForSelector('#dpe', { timeout: 10000 });
await pg.waitForTimeout(900);
note = await pg.textContent('#dpgridnote');
ok('no map when the project has no collars, no claims and no position',
   await pg.evaluate(() => document.getElementById('dpmapwrap').hidden));
ok('...and it says which file would fix that',
   /property outline or a collar file/.test(note), note);
await closePlan();

sec('and the console is still clean');
ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
// Leaflet's stylesheet names marker images this console never asks for,
// because the pin is a DivIcon. If that ever changes, these 404s are how.
ok('nothing the map needs is missing', missing.length === 0,
   missing.slice(0, 3).join(' | '));

console.log(`\n${pass} passed, ${failed} failed`);
console.log('screenshot: /tmp/rig-map.png' + (LIVE ? ' (live imagery)' : ' (stubbed tiles)'));
await b.close();
server.close();
process.exit(failed ? 1 : 0);
