#!/usr/bin/env python3
"""Orebody Present — a VRIFY-Present-style guided 3D walkthrough.
Cinematic chapter-by-chapter tour of the deposit on real terrain: title card,
chapter rail, captions, camera choreography. No stock/IR chrome."""
import csv, struct, base64, json

SRC = "data/elk_ore_blocks.csv"
OUT = "index.html"
TOPN = 45000

rows = []
with open(SRC, newline="") as f:
    for x, y, z, aueq, penv in csv.reader(f):
        dg = float(aueq) * float(penv)
        if dg > 0:
            rows.append((float(x), float(y), float(z), dg))
rows.sort(key=lambda r: r[3], reverse=True)
rows = rows[:TOPN]
gvals = sorted(r[3] for r in rows)
RAMPMAX = max(1.0, round(gvals[int(len(gvals) * 0.90)], 1))
Es = [r[0] for r in rows]; Ns = [r[1] for r in rows]; Zs = [r[2] for r in rows]
EMIN, NMIN = min(Es), min(Ns)
cE = (EMIN + max(Es)) / 2; cN = (NMIN + max(Ns)) / 2; cZ = (min(Zs) + max(Zs)) / 2
EX = max(Es) - min(Es); EY = max(Ns) - min(Ns)

buf = bytearray()
for x, y, z, g in rows:
    buf += struct.pack("<ffff", x - EMIN, y - NMIN, z, g)
b64 = base64.b64encode(bytes(buf)).decode()
N = len(rows)

# The narrated walkthrough — camera keyframe (heading,pitch,range) + cutoff + text
CHAPTERS = [
  {"h": 28, "p": -26, "r": 3600, "cut": 0.1, "xray": True,
   "title": "A high-grade gold system", "body": "The Elk Gold project sits in the Quesnel Highland of British Columbia's Cariboo District — a road-accessible, established mining region."},
  {"h": 30, "p": -22, "r": 2500, "cut": 0.1, "xray": True,
   "title": "On real ground", "body": "Every block is placed at its true UTM position on real terrain — this is the actual mountain the deposit sits inside."},
  {"h": 44, "p": -34, "r": 1950, "cut": 0.1, "xray": True,
   "title": "The orebody", "body": "A multi-vein gold-silver system, roughly 1,440 by 1,385 metres, coloured by gold-equivalent grade — cool blues low, hot reds high."},
  {"h": 66, "p": -30, "r": 1450, "cut": 1.0, "xray": True,
   "title": "The high-grade core", "body": "Raising the cut-off to 1 g/t strips away the halo and reveals the bonanza vein shells that carry most of the metal."},
  {"h": 0, "p": -89, "r": 2500, "cut": 0.3, "xray": True,
   "title": "Footprint in plan", "body": "Seen from directly above: northwest-trending vein corridors threading across the ridge."},
  {"h": 4, "p": -4, "r": 2650, "cut": 0.3, "xray": True,
   "title": "In profile", "body": "Turned on edge, the veins persist to roughly 475 metres below surface — and remain open at depth."},
  {"h": 26, "p": -27, "r": 3000, "cut": 0.15, "xray": True,
   "title": "Elk Gold — Siwash North", "body": "Drill-defined, high-grade, and road-accessible. This is the story, told in three dimensions."},
]

HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elk Gold — Siwash North · Orebody Present</title>
<script>window.CESIUM_BASE_URL='https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/';</script>
<link href="https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,300&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}
  html,body,#cesiumContainer{height:100%;width:100%;overflow:hidden;background:#07090A}
  body{font-family:Archivo,system-ui,sans-serif;color:#EDEEEC;-webkit-font-smoothing:antialiased}
  .cesium-widget-credits,.cesium-viewer-bottom{display:none!important}
  .cesium-viewer,.cesium-widget,.cesium-widget canvas{cursor:grab}

  /* brand */
  #brand{position:fixed;top:26px;left:30px;z-index:6}
  #brand .w{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.34em;color:#C99A3A;text-transform:uppercase}
  #brand .n{font-size:17px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;margin-top:5px;line-height:1}

  /* chapter rail */
  #rail{position:fixed;left:30px;top:96px;z-index:6;display:flex;flex-direction:column;gap:2px}
  #rail .c{display:flex;align-items:baseline;gap:11px;padding:7px 0;cursor:pointer;opacity:.5;transition:opacity .3s}
  #rail .c:hover{opacity:.85}
  #rail .c.on{opacity:1}
  #rail .num{font-family:'JetBrains Mono',monospace;font-size:10px;color:#C99A3A;width:20px}
  #rail .t{font-size:12.5px;font-weight:500;letter-spacing:.01em;max-width:190px;line-height:1.25}
  #rail .c.on .t{color:#fff}
  #rail .bar{width:2px;background:rgba(255,255,255,.12);margin-left:6px;flex:0 0 auto}

  /* caption bar */
  #bar{position:fixed;left:0;right:0;bottom:0;z-index:6;padding:70px 34px 26px;
       background:linear-gradient(180deg,rgba(7,9,10,0) 0%,rgba(7,9,10,.72) 44%,rgba(7,9,10,.92) 100%);
       display:flex;align-items:flex-end;justify-content:space-between;gap:36px}
  #cap{max-width:560px;opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease}
  #cap.in{opacity:1;transform:none}
  #cap .ey{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.22em;color:#C99A3A;text-transform:uppercase}
  #cap h2{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1.05;margin:12px 0 12px}
  #cap p{font-family:Newsreader,Georgia,serif;font-size:18px;line-height:1.55;color:#C6CAC5;text-wrap:pretty}
  #nav{display:flex;align-items:center;gap:14px;flex:0 0 auto;padding-bottom:4px}
  #nav button{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#EDEEEC;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:3px;padding:12px 18px;cursor:pointer;transition:.2s}
  #nav button:hover{border-color:#C99A3A;color:#C99A3A}
  #nav button:disabled{opacity:.3;cursor:default}
  #nav .count{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.14em;color:#8E948E;min-width:52px;text-align:center}

  /* legend */
  #legend{position:fixed;right:34px;top:28px;z-index:6;display:flex;align-items:center;gap:9px;opacity:.85}
  #ramp{height:8px;width:150px;border-radius:2px;background:linear-gradient(90deg,#14324f,#1c7fb8,#21b0a0,#8fd14f,#f2c14e,#e8532b)}
  #legend span{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.06em;color:#8E948E}

  /* progress */
  #prog{position:fixed;left:0;top:0;height:2px;background:#C99A3A;width:0;z-index:8;transition:width .6s ease}

  /* intro */
  #intro{position:fixed;inset:0;z-index:12;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
         background:radial-gradient(ellipse at center,rgba(7,9,10,.45),rgba(7,9,10,.86));transition:opacity .8s ease}
  #intro .eyebrow{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#C99A3A;margin-bottom:22px}
  #intro h1{font-size:clamp(42px,7vw,96px);font-weight:800;letter-spacing:-.035em;line-height:.94;text-transform:uppercase}
  #intro .sub{font-family:Newsreader,Georgia,serif;font-size:clamp(17px,1.6vw,22px);color:#C6CAC5;margin-top:22px;max-width:600px;line-height:1.5}
  #begin{margin-top:40px;font-family:'JetBrains Mono',monospace;font-size:12.5px;letter-spacing:.18em;text-transform:uppercase;color:#07090A;background:#C99A3A;border:none;border-radius:3px;padding:16px 32px;cursor:pointer;transition:filter .2s}
  #begin:hover{filter:brightness(1.12)}
  #load{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:#07090A;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.2em;color:#8E948E}
  #status{position:fixed;right:14px;bottom:12px;z-index:4;font-family:'JetBrains Mono',monospace;font-size:9px;color:#454b48}
  @media(max-width:760px){#rail{display:none}#cap h2{font-size:23px}#cap p{font-size:16px}}
</style>
</head>
<body>
<div id="cesiumContainer"></div>
<div id="load">PREPARING PRESENTATION…</div>
<div id="prog"></div>

<div id="brand"><div class="w">Orebody Present</div><div class="n">Elk Gold<br>Siwash North</div></div>
<div id="rail"></div>
<div id="legend"><span>AuEq</span><div id="ramp"></div><span id="rmax"></span></div>

<div id="bar">
  <div id="cap"><div class="ey" id="cap_ey">01 / 07</div><h2 id="cap_t"></h2><p id="cap_b"></p></div>
  <div id="nav">
    <button id="prev">‹ Back</button>
    <span class="count" id="count">1 / 7</span>
    <button id="next">Next ›</button>
  </div>
</div>

<div id="intro">
  <div class="eyebrow">Orebody Present · Interactive 3D Story</div>
  <h1>Elk Gold<br>Siwash North</h1>
  <div class="sub">A high-grade gold system in British Columbia's Cariboo District — presented in three dimensions, on real terrain.</div>
  <button id="begin">Begin the walkthrough ▸</button>
</div>
<div id="status">booting…</div>

<script src="https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Cesium.js"></script>
<script src="https://cdn.jsdelivr.net/npm/proj4@2.11.0/dist/proj4.js"></script>
<script>
const DATA="__B64__", N=__N__, RAMPMAX=__RAMPMAX__, EMIN=__EMIN__, NMIN=__NMIN__, CE=__CE__, CN=__CN__, CZ=__CZ__, EX=__EX__, EY=__EY__;
const CHAPTERS=__CHAPTERS__;
proj4.defs('EPSG:26910','+proj=utm +zone=10 +datum=NAD83 +units=m +no_defs');
const GEOID=-18, rad=Cesium.Math.toRadians, $=id=>document.getElementById(id);
const setStat=t=>$('status').textContent=t;
function decode(b){const s=atob(b);const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return new Float32Array(u.buffer);}
const F=decode(DATA);
const STOPS=[[0,[.078,.196,.31]],[.2,[.11,.5,.72]],[.4,[.13,.69,.63]],[.6,[.56,.82,.31]],[.8,[.95,.76,.31]],[1,[.91,.33,.17]]];
function ramp(g){const t=Math.max(0,Math.min(1,g/RAMPMAX));let a=STOPS[0],b=STOPS[STOPS.length-1];for(let i=0;i<STOPS.length-1;i++){if(t>=STOPS[i][0]&&t<=STOPS[i+1][0]){a=STOPS[i];b=STOPS[i+1];break}}const u=(t-a[0])/((b[0]-a[0])||1);return new Cesium.Color(a[1][0]+(b[1][0]-a[1][0])*u,a[1][1]+(b[1][1]-a[1][1])*u,a[1][2]+(b[1][2]-a[1][2])*u,1);}
$('rmax').textContent=RAMPMAX+'+ g/t';

(async()=>{
  let imagery, terrain;
  try{ imagery=await Cesium.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer'); }
  catch(e){ imagery=new Cesium.UrlTemplateImageryProvider({url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',maximumLevel:19,credit:'© OpenStreetMap'}); }
  try{ terrain=await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl('https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'); }
  catch(e){ terrain=new Cesium.EllipsoidTerrainProvider(); }
  const viewer=new Cesium.Viewer('cesiumContainer',{baseLayer:new Cesium.ImageryLayer(imagery),terrainProvider:terrain,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,animation:false,timeline:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,requestRenderMode:false});
  viewer.scene.screenSpaceCameraController.enableCollisionDetection=false;
  viewer.scene.skyAtmosphere.show=true;
  viewer.scene.globe.tileLoadProgressEvent.addEventListener(q=>setStat('terrain tiles: '+q));
  viewer.scene.canvas.addEventListener('webglcontextlost',ev=>{ev.preventDefault();setStat('context lost — reloading');setTimeout(()=>location.reload(),1200);},false);

  const cll=proj4('EPSG:26910','WGS84',[CE,CN]);
  const center=Cesium.Cartesian3.fromDegrees(cll[0],cll[1],CZ+GEOID);
  const RADIUS=Math.max(EX,EY)*0.62;

  // grade-bucketed primitives (cheap cut-off)
  const box=Cesium.BoxGeometry.fromDimensions({vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,dimensions:new Cesium.Cartesian3(10,10,5)});
  const BIN=0.1,NB=Math.ceil(RAMPMAX/BIN)+1;
  const buckets=Array.from({length:NB},(_,i)=>({lo:i*BIN,inst:[]}));
  for(let i=0;i<N;i++){
    const E=F[i*4]+EMIN,Nn=F[i*4+1]+NMIN,h=F[i*4+2]+GEOID,g=F[i*4+3];
    const bi=Math.min(NB-1,Math.floor(g/BIN));
    const pos=Cesium.Cartesian3.fromDegrees(...proj4('EPSG:26910','WGS84',[E,Nn]),h);
    buckets[bi].inst.push(new Cesium.GeometryInstance({geometry:box,modelMatrix:Cesium.Transforms.eastNorthUpToFixedFrame(pos),attributes:{color:Cesium.ColorGeometryInstanceAttribute.fromColor(ramp(g))}}));
  }
  const appearance=new Cesium.PerInstanceColorAppearance({flat:false,translucent:false});
  buckets.forEach(bk=>{ if(bk.inst.length){bk.prim=new Cesium.Primitive({geometryInstances:bk.inst,appearance,asynchronous:true});viewer.scene.primitives.add(bk.prim);} });
  const applyCut=cut=>buckets.forEach(bk=>{if(bk.prim)bk.prim.show=bk.lo>=cut-1e-9;});
  const xray=on=>{viewer.scene.globe.depthTestAgainstTerrain=!on;};

  // build chapter rail
  const rail=$('rail');
  CHAPTERS.forEach((c,i)=>{const d=document.createElement('div');d.className='c';d.innerHTML='<span class="num">'+String(i+1).padStart(2,'0')+'</span><span class="t">'+c.title+'</span>';d.onclick=()=>go(i);rail.appendChild(d);});
  const railItems=[...rail.children];

  let cur=0, flying=false;
  function frameFor(c,animate){
    const hpr=new Cesium.HeadingPitchRange(rad(c.h),rad(c.p),c.r);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if(animate){
      flying=true;
      viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center,RADIUS),{offset:hpr,duration:2.3,complete:()=>{flying=false;viewer.camera.lookAt(center,hpr);}});
    } else {
      viewer.camera.lookAt(center,hpr);
    }
  }
  function paintUI(){
    const c=CHAPTERS[cur];
    $('cap').classList.remove('in');
    setTimeout(()=>{
      $('cap_ey').textContent=String(cur+1).padStart(2,'0')+' / '+String(CHAPTERS.length).padStart(2,'0');
      $('cap_t').textContent=c.title; $('cap_b').textContent=c.body;
      $('cap').classList.add('in');
    },160);
    $('count').textContent=(cur+1)+' / '+CHAPTERS.length;
    $('prev').disabled=cur===0; $('next').disabled=cur===CHAPTERS.length-1;
    $('prog').style.width=((cur)/(CHAPTERS.length-1)*100)+'%';
    railItems.forEach((el,i)=>el.classList.toggle('on',i===cur));
  }
  function go(i,initial){
    if(i<0||i>=CHAPTERS.length) return;
    cur=i; const c=CHAPTERS[i];
    applyCut(c.cut); xray(c.xray); frameFor(c,!initial); paintUI();
  }
  $('next').onclick=()=>go(cur+1);
  $('prev').onclick=()=>go(cur-1);
  addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' '){go(cur+1);}else if(e.key==='ArrowLeft'){go(cur-1);}});

  // start on chapter 0 (no animation) behind the intro card
  applyCut(CHAPTERS[0].cut); xray(true); go(0,true);
  $('load').style.display='none';
  $('begin').onclick=()=>{$('intro').style.opacity='0';setTimeout(()=>$('intro').style.display='none',800);frameFor(CHAPTERS[0],true);};
  window.__viewer=viewer;
})().catch(e=>setStat('FATAL: '+e.message));
</script>
</body>
</html>"""

for k, v in {
    "__B64__": b64, "__N__": str(N), "__RAMPMAX__": f"{RAMPMAX}",
    "__EMIN__": f"{EMIN:.1f}", "__NMIN__": f"{NMIN:.1f}", "__CE__": f"{cE:.1f}",
    "__CN__": f"{cN:.1f}", "__CZ__": f"{cZ:.1f}", "__EX__": f"{EX:.0f}", "__EY__": f"{EY:.0f}",
    "__CHAPTERS__": json.dumps(CHAPTERS),
}.items():
    HTML = HTML.replace(k, v)

with open(OUT, "w") as f:
    f.write(HTML)
print(f"wrote {OUT} ({len(HTML)/1e6:.1f} MB) · {N} blocks · {len(CHAPTERS)} chapters")
