import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage({ viewport:{width:1500,height:900} });
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(process.argv[2],{waitUntil:'load'});
await pg.waitForFunction(()=>{ try{ return !!window.viewerApi(); }catch(e){ return false; } },
  null,{timeout:120000});
await pg.waitForTimeout(9000);
let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));
const log = ()=>pg.evaluate(()=>window.LOG);

const L0 = await log();
ok('the viewer announces itself', L0.some(m=>m.type==='hello'));
ok('the console handshake is acknowledged', L0.some(m=>m.type==='ready'), JSON.stringify(L0.map(m=>m.type)));
ok('ready carries the chapter titles', (L0.find(m=>m.type==='ready')||{}).titles?.length>5);
ok('the authoring bar is shown only after the handshake', (await pg.evaluate(()=>window.barHidden()))===false);

await pg.evaluate(()=>window.tell({type:'goto', ord:6}));
await pg.waitForTimeout(6000);
const st = (await log()).filter(m=>m.type==='state').pop();
ok('goto moves the viewer', st && st.state.ord===6, JSON.stringify(st&&st.state.ord));
ok('state reports an orbit camera', !!(st&&st.state.camera.orbit), JSON.stringify(st&&st.state.camera));
ok('state reports layers', !!(st&&st.state.layers&&st.state.layers.mode));

// Fly somewhere else, then set the view: the saved camera must be where we
// ended up, not where the chapter said.
const before = st.state.camera.orbit;
await pg.evaluate(()=>{ const v=window.viewerApi(); });
await pg.evaluate(()=>{
  const w = document.getElementById('f').contentWindow;
  const c = w.__viewer.camera;
  c.rotateRight(0.35); c.zoomOut(600);
});
await pg.waitForTimeout(2500);
await pg.evaluate(()=>window.clickIn('authset'));
await pg.waitForTimeout(2500);
const saved = await pg.evaluate(()=>window.SAVED);
ok('Set view sends a capture', !!saved, JSON.stringify(saved));
ok('the capture is the camera we flew to, not the chapter', saved && Math.abs(saved.camera.r-before.r)>100,
   saved? saved.camera.r+' vs '+before.r : '');
ok('Set view alone does not send layers', saved && saved.what==='camera');

await pg.evaluate(()=>window.clickIn('authall'));
await pg.waitForTimeout(2500);
const saved2 = await pg.evaluate(()=>window.SAVED);
ok('Set view + layers sends layers', saved2 && saved2.what==='all' && !!saved2.layers.mode);

// The viewer must adopt what was stored, or navigating away and back replays
// the old shot and the author saves again.
await pg.evaluate(()=>window.tell({type:'goto', ord:2}));
await pg.waitForTimeout(5000);
await pg.evaluate(()=>window.tell({type:'goto', ord:6}));
await pg.waitForTimeout(6000);
const back = (await log()).filter(m=>m.type==='state').pop();
ok('the saved shot is what replays', back && Math.abs(back.state.camera.orbit.r-saved2.camera.r)<60,
   back? back.state.camera.orbit.r+' vs '+saved2.camera.r : '');

// A message that is not the console must be ignored.
await pg.evaluate(()=>{
  const w=document.getElementById('f').contentWindow;
  w.postMessage({source:'somebody-else',type:'goto',ord:0}, location.origin);
});
await pg.waitForTimeout(3000);
const after = (await log()).filter(m=>m.type==='state').pop();
ok('a message from anyone else is ignored', after.state.ord===6, String(after.state.ord));

console.log('\nerrors:', errs.length?errs:'none');
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail||errs.length?1:0);
