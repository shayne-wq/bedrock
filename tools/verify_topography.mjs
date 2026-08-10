import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage();
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(process.argv[2],{waitUntil:'load'});
await pg.waitForFunction(()=>!!window.__dem,null,{timeout:30000});
let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));
const r = await pg.evaluate(([b,n])=>window.__dem(b,n),[Array.from(readFileSync('/tmp/dem.tif')),'dem.tif']);
console.log('  ', JSON.stringify(r));
ok('reads a float32 DEM', r.w===60 && r.h===40, `${r.w}x${r.h}`);
ok('carries the EPSG', r.epsg===26910, String(r.epsg));
ok('reads the no-data value', r.nodata===-9999, String(r.nodata));
ok('downsamples to the cap', Math.max(r.nx,r.ny)<=40, `${r.nx}x${r.ny}`);
ok('north-west corner is the tie point',
   Math.abs(r.corner[0]-692000)<0.01 && Math.abs(r.corner[1]-5527000)<0.01, JSON.stringify(r.corner));
ok('y runs SOUTH from the north edge, not north', r.last[1] < r.corner[1],
   `${r.last[1]} vs ${r.corner[1]}`);
ok('elevations are the ridge, not the void', r.zMin>1100 && r.zMax<1600, `${r.zMin}..${r.zMax}`);
ok('the void is a hole, not a spike to zero', r.zMin > 0, String(r.zMin));
ok('cells are dropped around the void',
   r.faces < (r.nx-1)*(r.ny-1)*2, `${r.faces} of ${(r.nx-1)*(r.ny-1)*2}`);
const las = await pg.evaluate(()=>window.__sniff('survey.laz'));
ok('LiDAR is named, not "unsupported"', /point cloud/i.test(las.label), las.label);
ok('...and says to export the surface', /GeoTIFF|OBJ/.test(las.advice), las.advice.slice(0,60));
const dat = await pg.evaluate(()=>window.__sniff('model.dat'));
ok('an ambiguous .dat names every vendor it could be',
   /Micromine/.test(dat.label) && /Datamine/.test(dat.label), dat.label);
const msr = await pg.evaluate(()=>window.__sniff('pit.msr'));
ok('.msr is MinePlan, not Leapfrog', /MinePlan/.test(msr.label), msr.label);
const msh = await pg.evaluate(()=>window.__sniff('vein.msh'));
ok('Leapfrog meshes are named', /Leapfrog/.test(msh.label), msh.label);
console.log('\nerrors:', errs.length?errs.slice(0,2):'none');
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail||errs.length?1:0);
