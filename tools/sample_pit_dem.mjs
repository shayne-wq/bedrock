// Bedrock — sample real Cesium terrain over the South Zone pit site to a file.
//
//   node tools/sample_pit_dem.mjs [url] [out.json]
//
// The pit's depth, movement and strip ratio were hand-computed once against a
// terrain sample that lives nowhere in this repository, so every later change
// to the pit had to either re-derive them by hand or leave them wrong. This
// writes the sample down, so tools/size_pit.py can compute those numbers from
// the same ground the viewer draws.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const URL_ = process.argv[2] || 'http://127.0.0.1:8901/index.html?autoplay=0';
const OUT  = process.argv[3] || 'data/synthetic/pit_site_dem.json';
// Centred on the South Zone metal centroid, the centre make_synthetic_site.py
// puts the pit on. Wide enough that a bigger pit than today's still lands
// inside the sampled box.
const CE = 269950.0, CN = 5830650.0, HALF = 800, STEP = 20;

const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto(URL_, { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__api && window.__viewer, null, { timeout: 120000 });

const grid = await p.evaluate(async ({ CE, CN, HALF, STEP }) => {
  const C = window.Cesium, v = window.__viewer;
  const pts = [], meta = [];
  for (let dn = -HALF; dn <= HALF; dn += STEP)
    for (let de = -HALF; de <= HALF; de += STEP) {
      const ll = proj4(PROJ, 'WGS84', [CE + de, CN + dn]);
      pts.push(C.Cartographic.fromDegrees(ll[0], ll[1]));
      meta.push([de, dn]);
    }
  // Most-detailed rather than globe.getHeight: this must not depend on which
  // tiles the camera happens to have pulled in.
  const got = await C.sampleTerrainMostDetailed(v.terrainProvider, pts);
  return { meta, h: got.map(c => (c.height === undefined ? null : +c.height.toFixed(2))) };
}, { CE, CN, HALF, STEP });

const nulls = grid.h.filter(h => h === null).length;
writeFileSync(OUT, JSON.stringify({
  note: 'Real Cesium world terrain sampled over the fabricated South Zone pit site.',
  crs: 'EPSG:26910', centre: [CE, CN], half_m: HALF, step_m: STEP,
  n: grid.h.length, unsampled: nulls,
  offsets: grid.meta, heights: grid.h,
}));
console.log(`sampled ${grid.h.length} points (${nulls} unsampled) -> ${OUT}`);
const ok = grid.h.filter(h => h !== null);
console.log(`  ground ${Math.min(...ok).toFixed(0)} m to ${Math.max(...ok).toFixed(0)} m`);
await b.close();
