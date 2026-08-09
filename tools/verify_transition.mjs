import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage({ viewport:{width:1500,height:900} });
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(process.argv[2],{waitUntil:'load'});
await pg.waitForFunction(()=>{try{return !!window.viewerApi()}catch(e){return false}},null,{timeout:120000});
await pg.waitForTimeout(9000);
let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));
const V = (e,a) => pg.evaluate(e,a);

const titles = await V(()=>window.titles());
const nicola = titles.indexOf('Nicola South');
console.log('deposit-change chapter:', nicola);

// The bug: a chapter that names a deposit AND a camera had its camera thrown
// away a second later by the deposit switch's own default framing.
const want = await V(i=>window.viewerApi().chapter(i), nicola);
ok('the chapter declares both a deposit and a camera',
   !!want.deposit && want.r>0, JSON.stringify([want.deposit, want.h, want.p, want.r]));

const t = await pg.evaluate(async i=>await window.viewerApi().transition(i), nicola);
console.log('measured:', JSON.stringify(t));
ok('the transition reports a measurement', !!t && t.camMs>0, JSON.stringify(t));
ok('it noticed the deposit switch', t.depMs !== null, JSON.stringify(t.depMs));
ok('it says which landed last', typeof t.late === 'boolean');

// Let the deposit switch fully settle, then check the camera is the AUTHORED
// one and not the switch's default framing.
await pg.waitForTimeout(9000);
const got = await V(()=>window.viewerApi().capture());
const o = got.camera.orbit;
const dh = Math.abs(((o.h-want.h)%360+540)%360-180);
ok('the authored heading survived the deposit switch', dh<3, o.h+' vs '+want.h);
ok('the authored pitch survived', Math.abs(o.p-want.p)<3, o.p+' vs '+want.p);
ok('the authored range survived', Math.abs(o.r-want.r)/want.r<0.06, o.r+' vs '+want.r);
ok('and it is orbiting the NEW deposit, not the old one',
   (await V(()=>window.viewerApi().state())).deposit==='nicola',
   (await V(()=>window.viewerApi().state())).deposit);

// A normal transition, for contrast.
const t2 = await pg.evaluate(async i=>await window.viewerApi().transition(i), 4);
ok('a transition with no deposit change reports none', t2.depMs===null, JSON.stringify(t2));
ok('and is not flagged late', t2.late===false, JSON.stringify(t2.late));

// And through the bridge, which is how the studio asks.
await V(()=>{ window.LOG.length=0; window.tell({type:'transition', ord:3}); });
await pg.waitForTimeout(12000);
const msg = (await V(()=>window.LOG)).filter(m=>m.type==='transition').pop();
ok('the bridge returns the measurement', !!(msg && msg.result && msg.result.camMs>0),
   JSON.stringify(msg && msg.result));

console.log('\nerrors:', errs.length?errs:'none');
console.log(pass+' passed, '+fail+' failed');
await b.close();
process.exit(fail||errs.length?1:0);
