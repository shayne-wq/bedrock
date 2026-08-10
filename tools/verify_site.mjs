import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel:'chrome' });
let pass=0,fail=0;
const ok=(n,c,d='')=>c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(d?' — '+d:'')));
for (const [name,w,h] of [['desktop',1440,900],['tablet',900,1200],['phone',390,844]]) {
  const pg = await b.newPage({ viewport:{width:w,height:h} });
  const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
  const bad=[]; pg.on('response',r=>{ if(r.status()>=400) bad.push(r.status()+' '+r.url().split('/').pop()); });
  await pg.goto(process.argv[2],{waitUntil:'networkidle'});
  // Scroll the whole page first. Every figure below the fold is loading="lazy",
  // which is correct for a page whose content is five large screenshots — but
  // it means asserting on image state without scrolling measures nothing.
  await pg.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight / 2) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await pg.waitForLoadState('networkidle');
  await pg.waitForTimeout(1500);
  await pg.screenshot({path:`/tmp/site-${name}.png`, fullPage:true});
  const m = await pg.evaluate(()=>({
    imgs: [...document.images].length,
    broken: [...document.images].filter(i=>!i.complete||i.naturalWidth===0).map(i=>i.getAttribute('src')),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth, win: window.innerWidth,
    leftovers: document.querySelectorAll('x-dc, helmet, image-slot').length,
    title: document.title,
  }));
  ok(`${name}: no broken images`, m.broken.length===0, JSON.stringify(m.broken));
  ok(`${name}: no horizontal overflow`, !m.overflowX, `${m.scrollW} vs ${m.win}`);
  ok(`${name}: no design-canvas elements left`, m.leftovers===0, String(m.leftovers));
  ok(`${name}: no errors, no 404s`, errs.length===0 && bad.length===0, JSON.stringify([...errs,...bad].slice(0,3)));
  if (name==='desktop') { ok('title is set', /Bedrock/.test(m.title), m.title); ok('all figures have images', m.imgs>=6, String(m.imgs)); }
  await pg.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
