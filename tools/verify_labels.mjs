import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage({ viewport:{width:1500,height:900} });
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
pg.on('dialog', d => d.accept(d.type()==='prompt' ? 'Main vein outcrop' : ''));
await pg.goto(process.argv[2],{waitUntil:'load'});
await pg.waitForFunction(()=>{ try{ return !!window.viewerApi(); }catch(e){ return false; } },
  null,{timeout:120000});
await pg.waitForTimeout(9000);
let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));
const A = ()=>pg.evaluate(()=>window.viewerApi().areas());

// A plan-view chapter, so the clicks land on terrain rather than on sky.
const titles = await pg.evaluate(()=>window.titles());
const plan = titles.indexOf('Footprint in plan');
await pg.evaluate(i=>window.tell({type:'goto',ord:i}), plan);
await pg.waitForTimeout(7000);
ok('a fresh slide has no annotations', JSON.stringify(await A())
   .startsWith('{"auth":0,"local":0'), JSON.stringify(await A()));

// Draw one through the real tool, not a back door.
// globe.pick misses on a tile that has not streamed in yet, and the camera has
// just flown. Wait for the terrain rather than for a guessed number of seconds.
await pg.waitForFunction(()=>{
  try { return document.getElementById('f').contentWindow.__viewer.scene.globe.tilesLoaded; }
  catch(e){ return false; }}, null, {timeout:60000});
await pg.evaluate(()=>window.clickIn('areabtn'));
await pg.waitForTimeout(600);
const cv = await pg.evaluate(()=>{
  const r=document.getElementById('f').getBoundingClientRect();
  return {x:r.x,y:r.y,w:r.width,h:r.height};
});
for (const [dx,dy] of [[-90,-60],[100,-45],[55,85]]) {
  await pg.mouse.click(cv.x+cv.w/2+dx, cv.y+cv.h/2+dy);
  await pg.waitForTimeout(900);
}
ok('all three clicks landed on terrain', (await A()).pts===6, JSON.stringify((await A()).pts));
await pg.evaluate(()=>window.clickIn('areaDone'));
await pg.waitForTimeout(1500);
let a = await A();
ok('the drawn area is local to this slide', a.local===1 && a.auth===0, JSON.stringify(a));
ok('the label stuck', a.labels[0]==='Main vein outcrop', JSON.stringify(a.labels));
ok('Save labels appears once there is something to save',
   (await pg.evaluate(()=>document.getElementById('f').contentWindow
      .document.getElementById('authlab').hidden))===false);

// It must NOT follow you to the next slide.
await pg.evaluate(i=>window.tell({type:'goto',ord:i}), plan+1);
await pg.waitForTimeout(6000);
a = await A();
ok('annotations do not leak onto the next slide', a.local===0 && a.auth===0, JSON.stringify(a));
await pg.evaluate(i=>window.tell({type:'goto',ord:i}), plan);
await pg.waitForTimeout(6000);
a = await A();
ok('and they are still there when you come back', a.local===1, JSON.stringify(a));

// Publish.
await pg.evaluate(()=>window.clickIn('authlab'));
await pg.waitForTimeout(2000);
const saved = await pg.evaluate(()=>window.SAVED);
ok('Save labels sends the annotations', saved && saved.what==='areas', JSON.stringify(saved&&saved.what));
ok('it sends the geometry, not a count',
   saved && Array.isArray(saved.areas) && saved.areas[0]?.ll?.length>=6,
   JSON.stringify(saved&&saved.areas&&saved.areas[0]&&saved.areas[0].ll&&saved.areas[0].ll.length));
a = await A();
ok('published labels become the slide’s', a.auth===1 && a.local===0, JSON.stringify(a));
ok('and are not drawn twice', a.labels.length===1, JSON.stringify(a.labels));

console.log('\nerrors:', errs.length?errs:'none');
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail||errs.length?1:0);
