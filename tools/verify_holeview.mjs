import { chromium } from 'playwright-core';
const U = process.argv[2];
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage({ viewport:{width:1600,height:900} });
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(U,{waitUntil:'load'});
await pg.waitForFunction(()=>window.__api&&document.querySelectorAll('#rail .c').length>0,
  null,{timeout:120000});
await pg.waitForTimeout(9000);
const L = ()=>pg.evaluate(()=>window.__api.layers());
const step = async (label,fn,wait=3200)=>{ await fn(); await pg.waitForTimeout(wait);
  const r=await L(); console.log(label.padEnd(20), JSON.stringify(r)); return r; };

const titles = await pg.evaluate(()=>window.__api.titles());
const idx = titles.indexOf('Drilled from surface');
const modelIdx = titles.indexOf('How well is it known?');
console.log('drilling ch', idx, '| model ch', modelIdx);

const a = await step('drilling chapter', ()=>pg.evaluate(i=>window.__api.go(i), idx), 6000);
const c1 = await step('click hole 1', ()=>pg.evaluate(()=>document.querySelectorAll('#ledglist .lrow')[0].click()), 6000);
await pg.screenshot({path:'/tmp/hv-1.png'});
const c2 = await step('click hole 3', ()=>pg.evaluate(()=>document.querySelectorAll('#ledglist .lrow')[2].click()), 6000);
await pg.screenshot({path:'/tmp/hv-3.png'});
const c4 = await step('click hole 3 again', ()=>pg.evaluate(()=>document.querySelectorAll('#ledglist .lrow')[2].click()), 5000);
const e1 = await step('esc', ()=>pg.keyboard.press('Escape'), 6000);
const m = await step('model chapter', ()=>pg.evaluate(i=>window.__api.go(i), modelIdx), 6000);

let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));
console.log('\n== assertions');
ok('drilling chapter drops the block model', a.blocks===false);
ok('drilling chapter drops the survey', a.geo==='');
ok('drilling chapter drops vein surfaces', a.surf==='');
ok('drilling chapter still draws the holes', a.drills===true);
ok('drilling chapter opens the ledger', a.rows>1, 'rows '+a.rows);
ok('click enters hole view', c1.holeView===true);
ok('hole view names the hole', !!c1.hole, String(c1.hole));
ok('hole view opens the downhole graph', c1.graph===true);
ok('hole view cuts the terrain', c1.ground===0);
ok('hole view turns the depth grid on', c1.depth===true);
ok('hole view keeps the model off', c1.blocks===false);
ok('camera is BELOW the terrain surface', c1.cam.under===true, JSON.stringify(c1.cam));
ok('camera is near level, not looking down', Math.abs(c1.cam.pitch)<=15, 'pitch '+c1.cam.pitch);
ok('ledger holds its rows in hole view', c1.rows===a.rows, c1.rows+' vs '+a.rows);
ok('ledger says underground', /underground/.test(c1.ledgt), c1.ledgt);
ok('a second hole is still clickable', c2.hole!==c1.hole && c2.holeView===true, c2.hole+' vs '+c1.hole);
ok('second hole is also underground', c2.cam.under===true, JSON.stringify(c2.cam));
ok('esc leaves hole view', e1.holeView===false);
ok('esc closes the graph', e1.graph===false);
ok('esc restores the chapter terrain', e1.ground===0);
ok('esc comes back above ground', e1.cam.under===false, JSON.stringify(e1.cam));
ok('a model chapter still shows the model', m.blocks===true);
ok('a model chapter leaves hole view behind', m.holeView===false);
ok('the focused hole gets its own rendering', c1.focus>4, 'ents '+c1.focus);
ok('re-focusing does not leak entities', c4.ents===c2.ents, c4.ents+' vs '+c2.ents);
ok('exit removes the focus rendering', e1.focus===0, 'ents '+e1.focus);
ok('exit returns every entity it added', e1.ents===a.ents, e1.ents+' vs '+a.ents);
// Terrain opacity used to be windowed to the deposit's footprint, and hole view
// was the one place that dropped the window. It is global everywhere now — the
// window was a black tarp on a lit hillside — so these three assert that no
// path re-introduces one, on the way in, inside, or on the way out.
ok('terrain translucency is global before hole view', a.tRectDeg===360, String(a.tRectDeg));
ok('hole view keeps translucency on the whole globe', c1.tRectDeg===360, String(c1.tRectDeg));
ok('exit leaves translucency global', e1.tRectDeg===360, String(e1.tRectDeg));
ok('hole view hides the sun', c1.sun===false);
ok('exit restores the sun', e1.sun===a.sun, e1.sun+' vs '+a.sun);
console.log('\nerrors:', errs.length?errs:'none');
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail?1:0);
