import { chromium } from 'playwright-core';
const [BASE, API, ANON] = process.argv.slice(2);
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage({ viewport:{width:1500,height:950} });
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
let promptWith = '';
pg.on('dialog', d => d.accept(d.type() === 'prompt' ? promptWith : ''));
pg.on('console',m=>{ if(m.type()==='error') errs.push('con: '+m.text().slice(0,140)); });
await pg.route('**/*',(r)=>{ const u=r.request().url();
  if(u.includes('kong:8000')) return r.continue({url:u.replace('http://kong:8000','http://127.0.0.1:54421')});
  return r.continue(); });
await pg.addInitScript(([url,key])=>localStorage.setItem('orebody.supabase',JSON.stringify({url,anonKey:key})),[API,ANON]);
await pg.goto(BASE,{waitUntil:'load'});
await pg.waitForTimeout(2500);
await pg.evaluate(async ([url,key])=>{
  const c = globalThis.supabase.createClient(url,key);
  await c.auth.signInWithPassword({email:'qa@orebody.test',password:'qa-password-123'});
},[API,ANON]);
await pg.reload({waitUntil:'load'});
await pg.waitForTimeout(5000);

let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));
const PRJ='dddddddd-0000-0000-0000-000000000002', DECK='dddddddd-0000-0000-0000-000000000004';
const read = (t,q) => pg.evaluate(async ([url,key,t,q])=>{
  const c = globalThis.supabase.createClient(url,key);
  await c.auth.signInWithPassword({email:'qa@orebody.test',password:'qa-password-123'});
  const { data } = await c.from(t).select(q.sel).eq('id',q.id).single();
  return data;
},[API,ANON,t,q]);

// ---- project settings ------------------------------------------------------
await pg.goto(`${BASE}#/p/${PRJ}`,{waitUntil:'load'});
// Wait for the element, and time it: the project route re-fetches the project,
// its zones, its datasets and its decks, and with logos in the holders payload
// it is slow enough that a fixed wait is a coin flip.
const t0=Date.now();
await pg.waitForSelector('#editproj',{timeout:90000}).catch(()=>{});
console.log('    project page rendered in', ((Date.now()-t0)/1000).toFixed(1)+'s');
ok('there is a project settings button', await pg.locator('#editproj').count()>0);
await pg.locator('#editproj').click();
await pg.waitForTimeout(1200);
for (const f of ['epn','epc','epl','epe']) ok(`settings exposes ${f}`, await pg.locator('#'+f).count()>0);
ok('the EPSG warning is hidden until it changes', await pg.locator('#epsgwarn').isHidden());
await pg.locator('#epe').fill('26911');
await pg.waitForTimeout(400);
ok('changing EPSG warns that data will move', await pg.locator('#epsgwarn').isVisible());
await pg.locator('#epe').fill('26910');
await pg.locator('#epl').fill('Nicola Valley, British Columbia');
await pg.locator('#epc').fill('Gold, Silver');
await pg.locator('#epgo').click();
await pg.waitForTimeout(6000);
const proj = await read('projects',{id:PRJ, sel:'name,commodity,location,epsg'});
ok('location saves', proj.location==='Nicola Valley, British Columbia', proj.location);
ok('commodity saves', proj.commodity==='Gold, Silver', proj.commodity);
ok('EPSG unchanged when set back', proj.epsg===26910, String(proj.epsg));

// ---- zone rename -----------------------------------------------------------
await pg.waitForSelector('[data-renamezone]',{timeout:60000}).catch(()=>{});
const rn = pg.locator('[data-renamezone]').first();
ok('zones can be renamed', await rn.count()>0);
if (await rn.count()) {
  promptWith = 'Siwash North Extension';
  await rn.click();
  await pg.waitForTimeout(6000);
  const z = await pg.evaluate(async ([url,key])=>{
    const c=globalThis.supabase.createClient(url,key);
    await c.auth.signInWithPassword({email:'qa@orebody.test',password:'qa-password-123'});
    const {data}=await c.from('zones').select('name,slug').eq('project_id','dddddddd-0000-0000-0000-000000000002');
    return data;
  },[API,ANON]);
  ok('the new zone name persists', z[0].name==='Siwash North Extension', JSON.stringify(z[0]));
  ok('and its slug follows', z[0].slug==='siwash-north-extension', z[0].slug);
}

// ---- deck subtitle ---------------------------------------------------------
await pg.goto(`${BASE}#/d/${DECK}`,{waitUntil:'load'});
await pg.waitForSelector('#dsub',{timeout:90000}).catch(()=>{});
ok('the deck subtitle is editable', await pg.locator('#dsub').count()>0);
if (await pg.locator('#dsub').count()) {
  await pg.locator('#dsub').click();
  await pg.locator('#dsub').fill('');
  await pg.keyboard.type('Nicola, British Columbia — August 2026');
  await pg.locator('#dtitle').click();
  await pg.waitForTimeout(5000);
  const d = await read('decks',{id:DECK, sel:'subtitle'});
  ok('the subtitle persists', d.subtitle==='Nicola, British Columbia — August 2026', String(d.subtitle));
}

console.log('\npage errors:', errs.length?errs.slice(0,4):'none');
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail||errs.length?1:0);
