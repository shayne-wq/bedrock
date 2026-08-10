// Orebody — GeoTIFF ingestion.
//
//   node tools/verify_geotiff.mjs <url to a page exposing __run/__sniff> [tif]
//
// The fixture at data/fixture_geotiff.tif was written by hand, byte by byte,
// precisely so the right answers are known rather than assumed: 8x6 pixels,
// tie point 692000/5527000, 40 m cells, EPSG:26910. A decoder that is subtly
// wrong about georeferencing puts a survey in the wrong place and looks
// completely fine doing it, so the test compares against numbers nobody
// derived from the decoder.

import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage();
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(process.argv[2],{waitUntil:'load'});
await pg.waitForFunction(()=>!!window.__run,null,{timeout:30000});
let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));

const bytes = Array.from(readFileSync(process.argv[3]||'/tmp/mag.tif'));
const g = await pg.evaluate(([b,n])=>window.__run(b,n), [bytes,'mag.tif']);
console.log('  decoded:', JSON.stringify(g));
// The fixture was written by hand, so the right answers are known exactly:
// 8x6 pixels, origin 692000/5527000, 40 m cells, EPSG:26910.
ok('decodes without a world file', !!g);
ok('pixel dimensions', g.w===8 && g.h===6, `${g.w}x${g.h}`);
ok('west edge is the tie point', Math.abs(g.extent.west-692000)<0.001, String(g.extent.west));
ok('north edge is the tie point', Math.abs(g.extent.north-5527000)<0.001, String(g.extent.north));
ok('east = west + 8 cells of 40 m', Math.abs(g.extent.east-(692000+320))<0.001, String(g.extent.east));
ok('south = north - 6 cells of 40 m', Math.abs(g.extent.south-(5527000-240))<0.001, String(g.extent.south));
ok('the EPSG in the tags is carried, not converted', g.epsg===26910, String(g.epsg));
ok('a drawable bitmap comes back', g.bmp===true);
ok('single band read as one', g.bands===1, String(g.bands));

const grd = await pg.evaluate(()=>window.__sniff('mag_rtp.grd'));
ok('.grd is refused by name', grd.readable===false && /Geosoft/.test(grd.label), JSON.stringify(grd.label));
ok('...and names GeoTIFF as the way out', /GeoTIFF/.test(grd.advice), grd.advice.slice(0,70));
const tif = await pg.evaluate(()=>window.__sniff('mag_rtp.tif'));
ok('.tif is no longer refused', tif.readable !== false, JSON.stringify(tif));

console.log('\nerrors:', errs.length?errs.slice(0,3):'none');
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail||errs.length?1:0);
