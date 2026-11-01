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
      started_on: '2026-08-04', expected_end: '2026-12-15',
      easting: RIG.e, northing: RIG.n, elev_m: null,
      operator: 'Cabo Drilling', note: 'Testing the north strike extension.',
      updated_at: '2026-10-28T12:00:00Z',
      updates: [
        // Newest, and words only — on purpose. The headline metre count must
        // fall through to the next report that has a figure rather than
        // blanking out because the latest one has none.
        { id: 'u3', as_of: '2026-10-28', metres_total: null, holes_done: null,
          holes_active: 2, body: 'Second rig mobilised to the north pad.',
          author: 'A. Geologist, VP Exploration', published_at: '2026-10-28T12:00:00Z' },
        { id: 'u2', as_of: '2026-10-24', metres_total: 4012, holes_done: 11,
          holes_active: 1, body: 'TC-26-011 completed to 412 m.',
          author: 'A. Geologist, VP Exploration', published_at: '2026-10-24T12:00:00Z' },
        { id: 'u1', as_of: '2026-10-17', metres_total: 3600, holes_done: 10,
          holes_active: 1, body: 'Rig turning on the 010 pad.',
          author: 'A. Geologist, VP Exploration', published_at: '2026-10-17T12:00:00Z' },
      ],
    },
    {
      // No position. It must appear in the panel and draw nothing on the
      // ground — the one thing it must never do is guess a location.
      id: 'prog-2', zone_id: null, name: 'Regional reconnaissance',
      status: 'planned', target_m: 2500, holes_planned: null,
      started_on: null, expected_end: null,
      easting: null, northing: null, elev_m: null,
      operator: null, note: null, updated_at: '2026-10-01T12:00:00Z',
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
await pg.waitForTimeout(1200);
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
               body: s.textContent.replace(/\s+/g, ' ') } : { present: false };
});

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
ok('every published report is listed', open.progReports === 3, String(open.progReports));
ok('the delta is computed, not typed', open.progDeltas.includes('+412 m'),
   JSON.stringify(open.progDeltas));
ok('the panel says who reported it and when',
   /Reported by the issuer, last updated\b.*\b28\b.*2026/.test(open.prognote), open.prognote);
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
   /Issuer-reported progress/.test(prov) && /as of\s+\S*\s*\b24\b.*2026/.test(prov),
   (prov.match(/DRILLING IN PROGRESS[\s\S]{0,400}/) || [''])[0]);
ok('the audit trail says a missing position draws no rig',
   /No collar coordinates were entered/.test(prov));
ok('the text edition carries the drilling', text.present === true);
ok('the text edition tabulates both programmes', text.rows === 2, String(text.rows));
ok('the text edition repeats the reports', /TC-26-011 completed to 412 m/.test(text.body || ''));
ok('the text edition carries the caveat',
   /not a mineral resource statement/i.test(text.body || ''));

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
