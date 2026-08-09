import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage({ viewport:{width:1600,height:900} });
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(process.argv[2],{waitUntil:'load'});
await pg.waitForFunction(()=>window.__api&&document.querySelectorAll('#rail .c').length>0,null,{timeout:120000});
await pg.waitForTimeout(9000);
let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));

// Round-trip: fly a chapter with a known orbit triple, capture it back, and
// assert the capture reproduces the declaration. This is the only check that
// proves the derivation and not merely that it returns numbers.
const titles = await pg.evaluate(()=>window.__api.titles());
for (const i of [1, 4, 9, 14]) {
  await pg.evaluate(n=>window.__api.go(n), i);
  await pg.waitForTimeout(5200);
  const r = await pg.evaluate(n=>({want:window.__api.chapter(n), got:window.__api.capture()}), i);
  if (!r.want || r.want.property || r.want.free) { console.log('  skip ch '+i+' (property/free)'); continue; }
  const o=r.got.camera.orbit, w=r.want;
  const dh=Math.abs(((o.h-w.h)%360+540)%360-180);
  ok('ch '+i+' heading round-trips', dh<1.5, o.h+' vs '+w.h);
  ok('ch '+i+' pitch round-trips', Math.abs(o.p-w.p)<1.5, o.p+' vs '+w.p);
  ok('ch '+i+' range round-trips', Math.abs(o.r-w.r)/w.r<0.02, o.r+' vs '+w.r);
  const L=r.got.layers;
  ok('ch '+i+' mode captured', L.mode===(w.mode||'grade'), L.mode+' vs '+w.mode);
  ok('ch '+i+' ground captured', Math.abs(L.ground-(w.ground===undefined?L.ground:w.ground))<0.01,
     L.ground+' vs '+w.ground);
  ok('ch '+i+' drills captured', (!!L.drills)===(!!w.drills), JSON.stringify([L.drills,w.drills]));
  ok('ch '+i+' blocks captured', (L.blocks!==false)===(w.blocks!==false), JSON.stringify([L.blocks,w.blocks]));
}
console.log('\nerrors:', errs.length?errs:'none');
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail||errs.length?1:0);
