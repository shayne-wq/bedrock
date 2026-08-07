#!/usr/bin/env python3
"""Georeferenced Cesium viewer: Elk Gold blocks on real BC terrain (token-free).
Adds cutoff slider (grade-bucketed primitives), orbit-around-deposit + preset
views, live grade-tonnage stats."""
import csv, struct, base64

SRC = "elk_ore_blocks.csv"
OUT = "elk-terrain.html"
TOPN = 45000
DENS = 2.7
T_PER_BLOCK = 10 * 10 * 5 * DENS

rows = []
with open(SRC, newline="") as f:
    for x, y, z, aueq, penv in csv.reader(f):
        dg = float(aueq) * float(penv)
        if dg > 0:
            rows.append((float(x), float(y), float(z), dg))
rows.sort(key=lambda r: r[3], reverse=True)
rows = rows[:TOPN]
maxg = rows[0][3]
gvals = sorted(r[3] for r in rows)
RAMPMAX = max(1.0, round(gvals[int(len(gvals) * 0.90)], 1))

Es = [r[0] for r in rows]; Ns = [r[1] for r in rows]; Zs = [r[2] for r in rows]
EMIN, NMIN = min(Es), min(Ns)
cE = (EMIN + max(Es)) / 2
cN = (NMIN + max(Ns)) / 2
cZ = (min(Zs) + max(Zs)) / 2
EX = max(Es) - min(Es)
EY = max(Ns) - min(Ns)

buf = bytearray()
for x, y, z, g in rows:
    buf += struct.pack("<ffff", x - EMIN, y - NMIN, z, g)
b64 = base64.b64encode(bytes(buf)).decode()
N = len(rows)
print(f"blocks={N}  maxdil={maxg:.1f}  rampMax={RAMPMAX}  centre E={cE:.0f} N={cN:.0f} Z={cZ:.0f}")

HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elk Gold — Siwash North · Georeferenced Block Model</title>
<script>window.CESIUM_BASE_URL='https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/';</script>
<link href="https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Widgets/widgets.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}
  html,body,#cesiumContainer{height:100%;width:100%;overflow:hidden;background:#0A0D0C}
  body{font-family:Archivo,system-ui,sans-serif;color:#E8E9E6}
  .cesium-widget-credits,.cesium-viewer-bottom{display:none!important}
  .panel{position:fixed;background:rgba(12,16,15,.76);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.1);border-radius:4px;z-index:5}
  #hud{top:20px;left:20px;padding:17px 19px;max-width:320px}
  #hud .eyebrow{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#D3A64B;margin-bottom:7px}
  #hud h1{font-size:20px;font-weight:700;letter-spacing:-.02em;line-height:1.05;text-transform:uppercase}
  #hud .sub{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.05em;color:#8E958F;margin-top:7px;line-height:1.7}
  #stats{top:20px;right:20px;padding:15px 18px;min-width:200px}
  #stats .r{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:6px 0;border-top:1px solid rgba(255,255,255,.08)}
  #stats .r:first-child{border-top:none}
  #stats .k{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#8E958F}
  #stats .v{font-family:'JetBrains Mono',monospace;font-size:15px;color:#F2F3F0}
  #stats .v b{color:#D3A64B;font-weight:500}
  #ctrl{left:20px;bottom:20px;padding:15px 18px;width:340px}
  #ctrl .lab{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#8E958F;display:flex;justify-content:space-between}
  #ctrl .lab b{color:#D3A64B;font-weight:500}
  input[type=range]{width:100%;margin:11px 0 4px;accent-color:#D3A64B}
  #legend{display:flex;align-items:center;gap:9px}
  #ramp{height:8px;flex:1;border-radius:2px;background:linear-gradient(90deg,#14324f,#1c7fb8,#21b0a0,#8fd14f,#f2c14e,#e8532b)}
  #legend span{font-family:'JetBrains Mono',monospace;font-size:9.5px;color:#8E958F}
  .btns{display:flex;gap:6px;margin-top:14px}
  .btns button{flex:1;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#E8E9E6;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-radius:3px;padding:9px 4px;cursor:pointer}
  .btns button:hover{border-color:#D3A64B;color:#D3A64B}
  .btns button.on{background:#D3A64B;color:#0A0D0C;border-color:#D3A64B}
  #disc{font-family:'JetBrains Mono',monospace;font-size:8.5px;line-height:1.6;letter-spacing:.03em;color:#5f6560;margin-top:12px}
  #status{right:20px;bottom:20px;padding:9px 13px;font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.04em;color:#8E958F;max-width:320px}
  #load{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.2em;color:#8E958F;background:#0A0D0C;z-index:20}
</style>
</head>
<body>
<div id="cesiumContainer"></div>
<div id="load">LOADING TERRAIN &amp; MODEL…</div>

<div id="hud" class="panel">
  <div class="eyebrow">CSE · Georeferenced Model</div>
  <h1>Elk Gold<br>Siwash North</h1>
  <div class="sub">Block model on real BC terrain<br>UTM 10N NAD83 · Nicola region, BC<br>Terrain: Esri World Elevation</div>
</div>

<div id="stats" class="panel">
  <div class="r"><span class="k">Blocks shown</span><span class="v" id="s_blocks">—</span></div>
  <div class="r"><span class="k">Tonnes</span><span class="v" id="s_tonnes">—</span></div>
  <div class="r"><span class="k">Contained AuEq</span><span class="v"><b id="s_oz">—</b></span></div>
  <div class="r"><span class="k">Avg grade</span><span class="v" id="s_grade">—</span></div>
</div>

<div id="ctrl" class="panel">
  <div class="lab">AuEq Cut-off <b id="cut">0.10 g/t</b></div>
  <input id="slider" type="range" min="0" max="__RAMPMAX__" step="0.05" value="0.1">
  <div id="legend"><span>0</span><div id="ramp"></div><span id="rmax">g/t</span></div>
  <div class="btns">
    <button id="v3d" class="on">◨ 3D</button>
    <button id="vplan">▣ Plan</button>
    <button id="vsec">▤ Section</button>
    <button id="vflip">⟳ Flip</button>
  </div>
  <div class="btns">
    <button id="xray" class="on">◐ X-ray terrain</button>
  </div>
  <div id="disc">Illustrative · Nov 2021 block model · diluted AuEq · terrain alignment approximate · not a mineral resource statement.</div>
</div>

<div id="status" class="panel">booting…</div>

<script src="https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Cesium.js"></script>
<script src="https://cdn.jsdelivr.net/npm/proj4@2.11.0/dist/proj4.js"></script>
<script>
const DATA="__B64__", N=__N__, RAMPMAX=__RAMPMAX__, EMIN=__EMIN__, NMIN=__NMIN__, CE=__CE__, CN=__CN__, CZ=__CZ__, EX=__EX__, EY=__EY__, TPB=__TPB__;
proj4.defs('EPSG:26910','+proj=utm +zone=10 +datum=NAD83 +units=m +no_defs');
const GEOID=-18;
function decode(b){const s=atob(b);const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return new Float32Array(u.buffer);}
const F=decode(DATA);
const STOPS=[[0,[.078,.196,.31]],[.2,[.11,.5,.72]],[.4,[.13,.69,.63]],[.6,[.56,.82,.31]],[.8,[.95,.76,.31]],[1,[.91,.33,.17]]];
function ramp(g){const t=Math.max(0,Math.min(1,g/RAMPMAX));let a=STOPS[0],b=STOPS[STOPS.length-1];for(let i=0;i<STOPS.length-1;i++){if(t>=STOPS[i][0]&&t<=STOPS[i+1][0]){a=STOPS[i];b=STOPS[i+1];break}}const u=(t-a[0])/((b[0]-a[0])||1);return new Cesium.Color(a[1][0]+(b[1][0]-a[1][0])*u,a[1][1]+(b[1][1]-a[1][1])*u,a[1][2]+(b[1][2]-a[1][2])*u,1);}
const statusEl=document.getElementById('status'); const setStat=t=>statusEl.textContent=t;
const $=id=>document.getElementById(id);
const fmt=n=>n>=1e6?(n/1e6).toFixed(1)+' Mt':n>=1e3?(n/1e3).toFixed(0)+' kt':n.toFixed(0)+' t';
const fmtk=n=>n>=1e3?(n/1e3).toFixed(2)+' Moz':n.toFixed(0)+' koz';
$('rmax').textContent=RAMPMAX+'+ g/t';

(async()=>{
  let imagery, terrain, imgName='ArcGIS World Imagery', terName='Esri World Elevation';
  try{ imagery = await Cesium.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer'); }
  catch(e){ imgName='OpenStreetMap (fallback)'; imagery = new Cesium.UrlTemplateImageryProvider({url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',maximumLevel:19,credit:'© OpenStreetMap'}); }
  try{ terrain = await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl('https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'); }
  catch(e){ terName='flat'; terrain = new Cesium.EllipsoidTerrainProvider(); }
  const viewer = new Cesium.Viewer('cesiumContainer',{
    baseLayer:new Cesium.ImageryLayer(imagery), terrainProvider:terrain,
    baseLayerPicker:false, geocoder:false, homeButton:false, sceneModePicker:false,
    navigationHelpButton:false, animation:false, timeline:false, fullscreenButton:false,
    infoBox:false, selectionIndicator:false, requestRenderMode:false
  });
  viewer.scene.screenSpaceCameraController.enableCollisionDetection=false;
  viewer.scene.globe.tileLoadProgressEvent.addEventListener(q=>setStat(imgName+' · '+terName+' · tiles: '+q));
  // auto-recover from GPU/context loss instead of a black screen
  viewer.scene.canvas.addEventListener('webglcontextlost',ev=>{ev.preventDefault();setStat('WebGL context lost — reloading…');setTimeout(()=>location.reload(),1200);},false);

  // deposit centre
  const cll=proj4('EPSG:26910','WGS84',[CE,CN]);
  const center=Cesium.Cartesian3.fromDegrees(cll[0],cll[1],CZ+GEOID);

  // ---- grade-bucketed primitives (fast cutoff via primitive.show) ----
  const box=Cesium.BoxGeometry.fromDimensions({vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,dimensions:new Cesium.Cartesian3(10,10,5)});
  const BIN=0.1, NB=Math.ceil(RAMPMAX/BIN)+1;
  const buckets=Array.from({length:NB},(_,i)=>({lo:i*BIN,inst:[],count:0,tonnes:0,oz:0}));
  for(let i=0;i<N;i++){
    const E=F[i*4]+EMIN,Nn=F[i*4+1]+NMIN,h=F[i*4+2]+GEOID,g=F[i*4+3];
    const bi=Math.min(NB-1,Math.floor(g/BIN));
    const ll=proj4('EPSG:26910','WGS84',[E,Nn]);
    const pos=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],h);
    buckets[bi].inst.push(new Cesium.GeometryInstance({geometry:box,modelMatrix:Cesium.Transforms.eastNorthUpToFixedFrame(pos),attributes:{color:Cesium.ColorGeometryInstanceAttribute.fromColor(ramp(g))}}));
    buckets[bi].count++;buckets[bi].tonnes+=TPB;buckets[bi].oz+=g*TPB/31.1035;
  }
  const appearance=new Cesium.PerInstanceColorAppearance({flat:false,translucent:false});
  buckets.forEach(bk=>{ if(bk.inst.length){ bk.prim=new Cesium.Primitive({geometryInstances:bk.inst,appearance,asynchronous:true}); viewer.scene.primitives.add(bk.prim); } });

  function applyCut(cut){
    let c=0,t=0,oz=0;
    buckets.forEach(bk=>{ if(!bk.prim)return; const vis=bk.lo>=cut-1e-9; bk.prim.show=vis; if(vis){c+=bk.count;t+=bk.tonnes;oz+=bk.oz;} });
    $('s_blocks').textContent=c.toLocaleString(); $('s_tonnes').textContent=fmt(t);
    $('s_oz').textContent=fmtk(oz/1000); $('s_grade').textContent=(t>0?oz*31.1035/t:0).toFixed(2)+' g/t';
    $('cut').textContent=cut.toFixed(2)+' g/t';
  }
  $('slider').addEventListener('input',e=>applyCut(parseFloat(e.target.value)));
  applyCut(0.1);

  // ---- camera: lookAt => drag orbits the deposit ----
  const RANGE=Math.max(EX,EY)*1.6;
  let cur={h:20,p:-35,r:RANGE};
  function view(h,p,r){ cur={h,p,r:r||RANGE}; viewer.camera.lookAt(center,new Cesium.HeadingPitchRange(Cesium.Math.toRadians(cur.h),Cesium.Math.toRadians(cur.p),cur.r)); }
  function setActive(id){['v3d','vplan','vsec'].forEach(x=>$(x).classList.toggle('on',x===id));}
  $('v3d').onclick=()=>{view(20,-35);setActive('v3d');};
  $('vplan').onclick=()=>{view(0,-89.9,RANGE*1.05);setActive('vplan');};
  $('vsec').onclick=()=>{view(0,-4,RANGE*1.1);setActive('vsec');};
  $('vflip').onclick=()=>{view(cur.h+180,cur.p,cur.r);};
  view(20,-35);

  // ---- X-ray: disable terrain depth-test so the subsurface orebody shows
  // through the mountain (stable — avoids heavy globe translucency) ----
  function xray(on){ viewer.scene.globe.depthTestAgainstTerrain=!on; }
  let xr=true; xray(true);
  $('xray').onclick=e=>{xr=!xr;xray(xr);e.target.classList.toggle('on',xr);};

  $('load').style.display='none';
  window.__viewer=viewer;
})().catch(e=>setStat('FATAL: '+e.message));
</script>
</body>
</html>"""

for k, v in {
    "__B64__": b64, "__N__": str(N), "__RAMPMAX__": f"{RAMPMAX}", "__TPB__": str(T_PER_BLOCK),
    "__EMIN__": f"{EMIN:.1f}", "__NMIN__": f"{NMIN:.1f}", "__CE__": f"{cE:.1f}", "__CN__": f"{cN:.1f}",
    "__CZ__": f"{cZ:.1f}", "__EX__": f"{EX:.0f}", "__EY__": f"{EY:.0f}",
}.items():
    HTML = HTML.replace(k, v)

with open(OUT, "w") as f:
    f.write(HTML)
print(f"wrote {OUT}  ({len(HTML)/1e6:.1f} MB)")
