import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const BASE = process.argv[2];          // dashboard url
const API  = process.argv[3];          // supabase url
const ANON = process.argv[4];
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage({ viewport:{width:1500,height:950} });
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
pg.on('console',m=>{ if(m.type()==='error') errs.push('con: '+m.text().slice(0,160)); });
const bad=[]; pg.on('response',r=>{ if(r.status()>=400) bad.push(r.status()+' '+r.request().method()+' '+r.url().slice(0,110)); });
// Local supabase signs storage against its own docker hostname.
await pg.route('**/*',(r)=>{ const u=r.request().url();
  if(u.includes('kong:8000')) return r.continue({url:u.replace('http://kong:8000','http://127.0.0.1:54421')});
  return r.continue(); });

let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));

// Point the console at local supabase, and sign in, before the app boots.
await pg.addInitScript(([url,key])=>{
  localStorage.setItem('orebody.supabase', JSON.stringify({url, anonKey:key}));
}, [API, ANON]);
await pg.addInitScript(()=>{ window.__rej=[];
  addEventListener('unhandledrejection', e=>window.__rej.push(String(e.reason&&e.reason.stack||e.reason)));
  addEventListener('error', e=>window.__rej.push('ERR '+e.message));
});
await pg.goto(BASE, {waitUntil:'load'});
await pg.waitForTimeout(3000);
// The console signs in by magic link, which cannot be clicked here. Use the
// SAME supabase client the app uses, so the session lands in the same storage
// key the app reads — this exercises the app's real auth path, not a bypass.
const signedIn = await pg.evaluate(async ([url,key])=>{
  const c = globalThis.supabase.createClient(url, key);
  const { data, error } = await c.auth.signInWithPassword(
    { email:'qa@orebody.test', password:'qa-password-123' });
  return error ? ('ERR '+error.message) : (data.session ? 'ok' : 'no session');
}, [API, ANON]);
console.log('    auth:', signedIn);
await pg.reload({waitUntil:'load'});
await pg.waitForTimeout(6000);
ok('signed in to the console', !/sign in/i.test(await pg.locator('#view').innerText().catch(()=>'sign in')),
   (await pg.locator('#view').innerText().catch(()=>'')).slice(0,90));

// Into the project.
await pg.goto(BASE + '#/p/dddddddd-0000-0000-0000-000000000002', {waitUntil:'load'});
await pg.waitForTimeout(7000);
await pg.screenshot({path:'/tmp/qa-project.png', fullPage:true});
const txt = await pg.locator('#view').innerText();
ok('the project page loads', /Elk Gold/.test(txt), txt.slice(0,100));
ok('the neighbouring-ground panel is shown', /Neighbouring ground/i.test(txt));
ok('it lists the companies from the register', /Barranco/i.test(txt), 
   (txt.match(/Barranco[^\n]*/)||[''])[0]);

// ---- flow 1: upload a logo for a neighbour ---------------------------------
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAXklEQVR42u3PQREAAAgDINe/9Cq' +
  'Dg1sPWpKq6xIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAPwaHm8AAdWLzZcAAAAASUVORK5CYII=', 'base64');
writeFileSync('/tmp/qa-logo.png', png);
const fileInput = pg.locator('#nblist input[type=file]').first();
ok('there is a logo input to click', await fileInput.count() > 0);
if (await fileInput.count()) {
  await fileInput.setInputFiles('/tmp/qa-logo.png');
  await pg.waitForTimeout(9000);
  const after = await pg.locator('#view').innerText();
  ok('the upload reports success rather than failing', !/could not|failed|error/i.test(
     (await pg.locator('.toast, #toast').innerText().catch(()=>''))), 
     (await pg.locator('.toast, #toast').innerText().catch(()=>'')).slice(0,80));
  // Read it back AS THE SIGNED-IN USER. Reading with the bare anon key returns
  // nothing — which is RLS doing its job, not the write failing, and is worth
  // not mistaking for a bug.
  const stored = await pg.evaluate(async ([url,key]) => {
    const c = globalThis.supabase.createClient(url, key);
    await c.auth.signInWithPassword({email:'qa@orebody.test', password:'qa-password-123'});
    const { data } = await c.from('projects')
      .select('holders').eq('id','dddddddd-0000-0000-0000-000000000002').single();
    return data?.holders || {};
  }, [API, ANON]);
  const keys = Object.keys(stored);
  ok('a logo was written to projects.holders', keys.some(k=>stored[k]?.logo), JSON.stringify(keys));
  const logo = keys.map(k=>stored[k]?.logo).find(Boolean) || '';
  ok('stored as a PNG data URI', logo.startsWith('data:image/png;base64,'), logo.slice(0,40));
  ok('downscaled, not the raw upload', logo.length < 40000, `${logo.length} chars`);
  ok('the row now shows the mark', await pg.locator('#nblist img').count() > 0);
}
await pg.screenshot({path:'/tmp/qa-logo-after.png', fullPage:true});
console.log('    rejections:', (await pg.evaluate(()=>window.__rej||[])).slice(0,3));
  console.log('    after-upload DOM:', await pg.evaluate(()=>({
  panel: !!document.getElementById('nbpanel'),
  hidden: document.getElementById('nbpanel')?.hidden,
  fetchBtn: !!document.getElementById('nbfetch'),
  rows: document.querySelectorAll('#nblist .nbrow').length,
  imgs: document.querySelectorAll('#nblist img').length,
  skeleton: document.querySelectorAll('#view .sk, #view .skeleton').length,
  head: (document.getElementById('view')?.innerText||'').slice(0,60),
})));

// ---- flow 2: fetch neighbours from the register ----------------------------
const fetchBtn = pg.locator('#nbfetch');
ok('there is a fetch button', await fetchBtn.count() > 0);
if (await fetchBtn.count()) {
  ok('it is enabled (the boundary file recorded an extent)', !(await fetchBtn.isDisabled()));
  const before = await pg.locator('#nblist .nbrow').count();
  await fetchBtn.click();
  await pg.waitForTimeout(45000);
  const note = await pg.locator('.toast, #toast').innerText().catch(()=>'');
  console.log('    toast:', note.slice(0,120));
  const after = await pg.locator('#nblist .nbrow').count();
  ok('the fetch completed without a stuck button',
     !(await fetchBtn.isDisabled()) && !/fetching/i.test(await fetchBtn.innerText()),
     await fetchBtn.innerText());
  ok('it resolved real tenure or said plainly there was none',
     /Added \d+|no other holders/i.test(note), note.slice(0,120));
  console.log(`    holders before ${before}, after ${after}`);
}
await pg.screenshot({path:'/tmp/qa-fetch-after.png', fullPage:true});

console.log('\npage errors:', errs.length?errs.slice(0,5):'none');
console.log('failed requests:', bad.length?bad.slice(0,6):'none');
console.log(`${pass} passed, ${fail} failed`);
await b.close();
