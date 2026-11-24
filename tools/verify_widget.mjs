// The drilling card an issuer puts on their own website, in a real browser.
//
// Two things are under test. The card itself — what it says at rest, what it
// says when opened, and what it refuses to say — and the embed, because the
// card lives in an iframe on somebody else's page and an iframe cannot paint
// outside its own box. The expand is a REQUEST to the host, so the host is
// here too: /__host loads widget/embed.js exactly the way an issuer would.
//
// The assertion that matters most is the one about disclosed results. An
// intercept is material scientific information that reaches the public through
// a news release with a qualified person's name on it, and this card is a
// marketing widget on a public company's homepage. It may POINT at a release;
// it may never carry a number somebody typed.
//
//   node tools/verify_widget.mjs
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

// Relative to today, like every other drilling fixture here: the staleness
// line and the projection are arithmetic over the gap between a report and
// now, so fixed dates would test a different sentence every morning.
const DAY = 864e5;
const T0 = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const d = (n) => new Date(T0 + n * DAY).toISOString().slice(0, 10);

const PROGRAM = {
  id: 'prog-1', zone_id: 'z1', name: 'Phase 2 diamond drilling',
  status: 'active', target_m: 10000, holes_planned: 24,
  started_on: d(-96), expected_end: d(37),
  easting: 681000, northing: 5521000, elev_m: 1310,
  operator: 'Cabo Drilling', note: 'Testing the north strike extension.',
  updates: [
    { id: 'u3', as_of: d(-11), metres_total: null, holes_done: null,
      holes_active: 2, body: 'Second rig mobilised.', published_at: d(-11) + 'T12:00:00Z' },
    { id: 'u2', as_of: d(-15), metres_total: 4012, holes_done: 11,
      holes_active: 1, body: 'TC-26-011 to 412 m.', published_at: d(-15) + 'T12:00:00Z' },
    { id: 'u1', as_of: d(-50), metres_total: 2100, holes_done: 6,
      holes_active: 1, body: 'First four holes complete.', published_at: d(-50) + 'T12:00:00Z' },
  ],
};

const payloadFor = (mode) => {
  const g = JSON.parse(JSON.stringify(PROGRAM));
  const project = { name: 'Test Creek Resources', commodity: 'Gold',
    location: 'British Columbia', epsg: 26910,
    brand: { logo: '/__logo.png' } };
  if (mode === 'nopos') { g.easting = null; g.northing = null; }
  if (mode === 'nad27') { project.epsg = 26710; }
  if (mode === 'stale') {
    g.updates = g.updates.map((u, i) => ({ ...u, as_of: d(-70 - i * 10) }));
  }
  if (mode === 'disclosed') {
    g.disclosures = [{ headline: '12.4 m of 3.1 g/t gold in TC-26-011',
                       url: 'https://example.com/news/tc-26-011',
                       released_on: d(-9) }];
  }
  if (mode === 'high') g.elev_m = 2250;       // above treeline
  if (mode === 'badlogo') project.brand = { logo: '/__missing.png' };
  if (mode === 'nolog') project.brand = null;
  return {
    deck: { id: 'deck-1', title: 'Test Creek', settings: {}, inclusion: {} },
    project, zones: [{ id: 'z1', name: 'Creek Zone' }], chapters: [],
    programs: mode === 'none' ? [] : [g],
    fabricated: [], share: { id: 'share-1', embed: true },
  };
};

const HOST = (q) => `<!doctype html><html><head><meta charset="utf-8">
<title>Issuer site</title>
<style>body{margin:0;font:15px system-ui;background:#fff}
  .page{display:flex;gap:24px;padding:24px}
  main{flex:1}aside{width:380px;flex:none}</style>
</head><body><div class="page">
<main><h1>Investor relations</h1><p>Their own page, their own markup.</p></main>
<aside><div data-bedrock-drill ${q}></div></aside>
</div><script src="/widget/embed.js"></script></body></html>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.mp4': 'video/mp4', '.jpg': 'image/jpeg',
  '.png': 'image/png' };

// A 1x1 PNG, for the issuer logo.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9' +
  'awAAAABJRU5ErkJggg==', 'base64');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/__host') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HOST(u.searchParams.get('q') || ''));
  }
  if (u.pathname === '/__logo.png') {
    res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG);
  }
  if (u.pathname === '/functions/v1/deck') {
    res.writeHead(200, { 'content-type': 'application/json',
      'access-control-allow-origin': '*' });
    return res.end(JSON.stringify(payloadFor(u.searchParams.get('t'))));
  }
  const f = path.join(ROOT, u.pathname === '/widget/' ? '/widget/index.html' : u.pathname);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404).end('no'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: CHROME,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });

// Imagery served locally. A suite that reaches Esri is a suite that fails on
// a train, and what the tiles contain is not what this file is about.
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9' +
  'awAAAABJRU5ErkJggg==', 'base64');
let tiles = 0;
await pg.route(/arcgisonline\.com/, (r) => {
  tiles++;
  r.fulfill({ status: 200, contentType: 'image/png', body: TILE });
});

const errs = [], missing = [];
pg.on('pageerror', (e) => errs.push(String(e)));
pg.on('console', (m) => {
  // The missing-logo case asks for a 404 on purpose; its console line is the
  // expected result of that test, not a defect in the page.
  if (m.type() === 'error' && !/__missing/.test(m.text() + m.location().url)) {
    errs.push('console: ' + m.text());
  }
});
pg.on('response', (r) => {
  // __missing.png is asked for on purpose, by the test for a logo that 404s.
  if (r.status() >= 400 && !r.url().includes('__missing')) {
    missing.push(r.status() + ' ' + r.url());
  }
});

let pass = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  — ' + extra : '')); }
};
const sec = (s) => console.log('\n== ' + s);

const open = async (mode, extra = '') => {
  await pg.goto(`${BASE}/widget/?t=${mode}&api=${encodeURIComponent(BASE)}${extra}`,
    { waitUntil: 'load' });
  await pg.waitForTimeout(700);
};
const txt = (sel) => pg.textContent(sel).then((t) => (t || '').trim());
const rows = () => pg.evaluate(() => window.__widget ? window.__widget.rows() : []);
const rowFor = async (k) => {
  const all = await rows();
  const hit = all.find((r) => r[0] === k);
  return hit ? hit[1] : null;
};

// ------------------------------------------------------------ at rest -----
sec('the resting card');
await open('ok');
ok('the card renders', await pg.isVisible('#w'));
ok('it opens 16:9, not expanded',
   await pg.evaluate(() => document.getElementById('w').classList.contains('rest-mode')));
ok('the issuer logo is shown, not ours',
   await pg.evaluate(() => !!document.querySelector('#brand img')));
ok('the programme is named', (await txt('#pname')) === 'Phase 2 diamond drilling');
ok('the status is on the card', /Drilling/i.test(await txt('#chip')));
ok('"As of" carries the newest report date',
   /^As of /.test(await txt('#asof')), await txt('#asof'));
ok('a current programme is not marked stale',
   !(await pg.evaluate(() => document.getElementById('asof').classList.contains('stale'))));
// Really gone, not merely carrying the attribute. `hidden` is the weakest rule
// in the browser and any class that sets display defeats it; asserting the
// attribute asks whether the markup INTENDS the panel to be hidden, which is
// never the thing in doubt.
ok('the figures are not shown until asked for',
   await pg.evaluate(() => {
     const e = document.getElementById('exp');
     return e.hidden && getComputedStyle(e).display === 'none' && e.offsetParent === null;
   }));
// The assertion that would have caught it on its own: whatever is under the
// button's own centre has to BE the button.
ok('and nothing invisible is sitting on top of the Details button',
   await pg.evaluate(() => {
     const b = document.getElementById('cta').getBoundingClientRect();
     const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
     return !!hit && hit.id === 'cta';
   }));
ok('satellite tiles are placed around the rig', tiles > 0, String(tiles));
// Counting tiles proves nothing about coverage: the first version painted the
// right NUMBER of tiles for a 480x270 box onto a 1280x720 card, because it
// measured the card while it was still hidden and got 0. What matters is that
// the imagery reaches every edge.
ok('...and they reach every edge of it', await pg.evaluate(() => {
  const box = document.getElementById('w').getBoundingClientRect();
  const t = [...document.querySelectorAll('.maplift img')].map((i) => i.getBoundingClientRect());
  if (!t.length) return false;
  return Math.min(...t.map((r) => r.left)) <= box.left
      && Math.max(...t.map((r) => r.right)) >= box.right
      && Math.min(...t.map((r) => r.top)) <= box.top
      && Math.max(...t.map((r) => r.bottom)) >= box.bottom;
}));

sec('the clip is not fetched until somebody opens it');
ok('no video source at rest',
   await pg.evaluate(() => !document.getElementById('vid').src));

// ------------------------------------------------------------ expanded ----
sec('opening it');
await pg.click('#cta');
await pg.waitForTimeout(1400);
ok('it expands', await pg.evaluate(() => window.__widget.isOpen()));
ok('the resting card is no longer the thing you read',
   await pg.evaluate(() => getComputedStyle(document.getElementById('rest')).opacity === '0'));
ok('the clip is loaded now, not before',
   await pg.evaluate(() => !!document.getElementById('vid').src));
ok('the clip loops', await pg.evaluate(() => document.getElementById('vid').loop));
ok('...and is muted, because it autoplays on someone else\'s page',
   await pg.evaluate(() => document.getElementById('vid').muted));
ok('the illustration mark is on the frame',
   (await txt('.illus')).toLowerCase() === 'illustration');
// 1310 m is below treeline, so forest is the right answer for this fixture —
// the first version of this check asserted alpine without reading the
// threshold it was testing, and failed the code for being correct.
ok('a pad below treeline gets the forest clip',
   await pg.evaluate(() => /forest/.test(document.getElementById('vid').src)),
   await pg.evaluate(() => document.getElementById('vid').src));

await open('high');
ok('a pad above treeline gets the alpine clip instead',
   await pg.evaluate(() => /alpine/.test(document.getElementById('vid').dataset.src)),
   await pg.evaluate(() => document.getElementById('vid').dataset.src));
await open('ok');
await pg.click('#cta'); await pg.waitForTimeout(1300);

sec('the figures');
ok('planned metreage', (await rowFor('Planned')) === '10,000 m');
ok('metres to date', (await rowFor('Drilled to date')) === '4,012 m');
ok('remaining is spelt out', (await rowFor('Remaining')) === '5,988 m');
ok('holes done of planned', (await rowFor('Holes')) === '11 of 24');
ok('holes turning comes off the newest report that said so',
   (await rowFor('Turning now')) === '2 holes');
ok('expected completion is the issuer\'s own date',
   !!(await rowFor('Expected completion')));
ok('the projection is NOT shown by default', (await rowFor('Projected finish')) === null);
ok('the progress bar has a denominator to draw against',
   await pg.evaluate(() => !document.getElementById('bar').hidden));

sec('and what the card says about itself');
const foot = await txt('#foot');
ok('it says the figures are operator-reported', /reported by the issuer/i.test(foot));
ok('...and are not assay results', /not assay results/i.test(foot));
ok('...and that the rig is an illustration', /illustration/i.test(foot));

// ------------------------------------------------- disclosed results ------
sec('disclosed results are a pointer, never a typed number');
ok('with none linked, it says so plainly',
   /None linked/i.test(await txt('#disc')), await txt('#disc'));
await open('disclosed');
await pg.click('#cta'); await pg.waitForTimeout(1200);
const disc = await txt('#disc');
ok('a linked release shows its headline', /12\.4 m of 3\.1 g\/t gold/.test(disc), disc);
ok('...named as a news release', /News release/i.test(disc), disc);
ok('...with the date it was released', /\d{4}/.test(disc), disc);
ok('...and it is a link out, opening away from the card',
   await pg.evaluate(() => {
     const a = document.querySelector('#disc a');
     return !!a && a.target === '_blank' && /noopener/.test(a.rel);
   }));

// ------------------------------------------------------------ refusals ----
sec('what it refuses to draw');
await open('nopos');
ok('a programme with no coordinates draws no map',
   await pg.evaluate(() => document.querySelector('.map').classList.contains('blank')));
ok('...and no tiles at all, rather than a map of somewhere else',
   await pg.evaluate(() => window.__widget.tiles()) === 0);
ok('...but the figures still work',
   await pg.isVisible('#w') && (await txt('#pname')).length > 0);

await open('nad27');
ok('a NAD27 grid draws no map either',
   await pg.evaluate(() => document.querySelector('.map').classList.contains('blank')));

await open('none');
ok('a deck with no programme says so instead of rendering an empty card',
   await pg.isVisible('#msg') && /No drilling programme/i.test(await txt('#msg')));

await pg.goto(`${BASE}/widget/`, { waitUntil: 'load' });
await pg.waitForTimeout(300);
ok('no share link at all is a sentence, not a blank box',
   /needs its share link/i.test(await txt('#msg')));

sec('a programme nobody has reported on in months says so');
await open('stale');
const asof = await txt('#asof');
ok('the staleness is on the resting card', /days ago/.test(asof), asof);
ok('...and marked, not just stated',
   await pg.evaluate(() => document.getElementById('asof').classList.contains('stale')));

sec('a logo that will not load');
await open('badlogo');
ok('falls back to the company name rather than a broken frame',
   /Test Creek Resources/.test(await txt('#brand')), await txt('#brand'));
await open('nolog');
ok('no logo on file does the same', /Test Creek Resources/.test(await txt('#brand')));

sec('the projection, when the issuer opts in');
await open('ok', '&forecast=1');
await pg.click('#cta'); await pg.waitForTimeout(1200);
const fc = await rowFor('Projected finish');
ok('it appears only with forecast=1', fc !== null, String(fc));
ok('...and says how it compares to the plan',
   /planned/.test(fc || ''), String(fc));

// ------------------------------------------------------- in a real page ---
sec('embedded on somebody else\'s page');
const msgs = [];
await pg.exposeFunction('__note', (m) => msgs.push(m));
await pg.goto(`${BASE}/__host?q=${encodeURIComponent('data-t="ok" data-api="' + BASE + '" data-terrain="winter"')}`,
  { waitUntil: 'load' });
await pg.evaluate(() => {
  window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'bedrock-drill') window.__note(e.data.type + ':' + Math.round(e.data.height));
  });
});
await pg.waitForTimeout(1200);
const frame = pg.frames().find((f) => /\/widget\//.test(f.url()));
ok('the snippet mounts an iframe', !!frame);
ok('...pointing at the same deployment it was served from',
   !!frame && frame.url().startsWith(BASE), frame ? frame.url() : '');
ok('...carrying the terrain the issuer chose',
   !!frame && /terrain=winter/.test(frame.url()));
ok('the chosen terrain wins over the one derived from elevation',
   await frame.evaluate(() => /winter/.test(document.getElementById('vid').dataset.src)));

const h0 = await pg.evaluate(() => document.querySelector('[data-bedrock-drill] iframe').clientHeight);
await frame.click('#cta');
await pg.waitForTimeout(1600);
const h1 = await pg.evaluate(() => document.querySelector('[data-bedrock-drill] iframe').clientHeight);
ok('opening it asks the host for more height, and gets it', h1 > h0 + 40,
   `${h0} -> ${h1}`);
ok('the host heard an expand', msgs.some((m) => m.startsWith('expand:')),
   msgs.join(' '));
await frame.click('#back');
await pg.waitForTimeout(900);
const h2 = await pg.evaluate(() => document.querySelector('[data-bedrock-drill] iframe').clientHeight);
ok('closing it gives the height back', h2 < h1 - 40, `${h1} -> ${h2}`);

sec('and the page it sits on stays clean');
ok('the host page does not scroll sideways',
   await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
ok('nothing the card needs is missing', missing.length === 0, missing.slice(0, 3).join(' | '));

// A phone-width sidebar, which is where most of these actually get read.
sec('at phone width');
await pg.setViewportSize({ width: 390, height: 844 });
await open('ok');
await pg.click('#cta'); await pg.waitForTimeout(1400);
ok('the figures stack under the clip rather than cramming beside it',
   await pg.evaluate(() => getComputedStyle(document.getElementById('exp')).gridTemplateColumns.split(' ').length === 1));
ok('nothing overflows the card',
   await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

// Where the overlay bug actually bit: at desktop width the video only reached
// halfway down the card and the button stayed clear, so every other assertion
// passed while the panel sat on top of it.
await open('ok');
ok('at sidebar width the Details button is still the thing under the pointer',
   await pg.evaluate(() => {
     const b = document.getElementById('cta').getBoundingClientRect();
     const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
     return !!hit && hit.id === 'cta';
   }));
await pg.click('#cta');
await pg.waitForTimeout(1400);
ok('...and it opens from there', await pg.evaluate(() => window.__widget.isOpen()));

await pg.screenshot({ path: '/tmp/widget-phone.png' });
await pg.setViewportSize({ width: 1280, height: 900 });
await open('ok');
await pg.waitForTimeout(400);
await pg.screenshot({ path: '/tmp/widget-rest.png', clip: { x: 0, y: 0, width: 1280, height: 740 } });
await pg.click('#cta'); await pg.waitForTimeout(1500);
await pg.screenshot({ path: '/tmp/widget-open.png', clip: { x: 0, y: 0, width: 1280, height: 740 } });

console.log(`\n${pass} passed, ${failed} failed`);
console.log('screenshots: /tmp/widget-rest.png /tmp/widget-open.png /tmp/widget-phone.png');
await b.close();
server.close();
process.exit(failed ? 1 : 0);
