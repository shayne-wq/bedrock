import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel:'chrome' });
const pg = await b.newPage({ viewport:{width:1500,height:850} });
const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
await pg.goto(process.argv[2],{waitUntil:'load'});
await pg.waitForFunction(()=>window.__api&&document.querySelectorAll('#rail .c').length>0,null,{timeout:120000});
await pg.waitForTimeout(9000);
await pg.evaluate(()=>{const i=document.getElementById('intro'); if(i) i.style.display='none';});
const t=await pg.evaluate(()=>window.__api.titles());
// The site chapter, then an oblique camera close on the pit — the angle the
// reference shot uses, because a pit read from directly above is a ring.
await pg.evaluate(i=>window.__api.go(i), t.indexOf('Footprint in plan'));
await pg.waitForTimeout(9000);
await pg.evaluate(()=>{
  const v=window.__viewer, C=window.Cesium;
  const pit=v.entities.values.find(e=>/pit/i.test(e.name||'') && e.wall);
  const p=pit && pit.wall.positions.getValue(v.clock.currentTime);
  const sph=C.BoundingSphere.fromPoints(p);
  v.camera.lookAtTransform(C.Matrix4.IDENTITY);
  v.camera.flyToBoundingSphere(sph,{duration:0,
    offset:new C.HeadingPitchRange(C.Math.toRadians(35), C.Math.toRadians(-22), sph.radius*5)});
});
await pg.waitForTimeout(7000);
await pg.waitForFunction(()=>window.__viewer.scene.globe.tilesLoaded,null,{timeout:60000}).catch(()=>{});
await pg.waitForTimeout(3000);
await pg.screenshot({path:'/tmp/pit.png'});
console.log(JSON.stringify(await pg.evaluate(()=>{
  const v=window.__viewer;
  return {walls:v.entities.values.filter(e=>e.wall).length,
          clipped:!!v.scene.globe.clippingPolygons,
          clipCount:v.scene.globe.clippingPolygons?v.scene.globe.clippingPolygons.length:0};
})));
console.log('errors:', errs.length?errs.slice(0,3):'none');
await b.close();
