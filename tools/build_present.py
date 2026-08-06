#!/usr/bin/env python3
"""Orebody Present — a VRIFY-Present-style guided 3D walkthrough.

Cinematic chapter-by-chapter tour of the deposit on real terrain: title card,
chapter rail, captions, camera choreography. Plus an Explore mode that turns the
same scene into an interrogation tool — colour by resource class, isolate any of
the 46 vein domains, and read exact grade-tonnage for whatever is on screen.

Reads data/elk_blocks_v2.csv + data/elk_stats.json (see tools/extract_blocks.py).

Rendering vs. reporting are deliberately decoupled. Geometry is bucketed by
(class, grade-ladder) so cut-off / class / colour changes are a handful of
primitive toggles rather than a rebuild. The numbers in the readout do NOT come
from what is drawn — they are summed from exact per-bucket rollups computed over
every mineralized block at build time. Filter the view however you like; the
tonnage stays honest.
"""
import csv, struct, base64, json, bisect
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "elk_blocks_v2.csv"
STATS = ROOT / "data" / "elk_stats.json"
OUT = ROOT / "index.html"

# Grade ladder for bucketing. Shaped like the cut-offs people actually pull
# (0.1 / 0.3 / 1.0 g/t), not a linear bin — a linear bin fragments into
# thousands of near-empty draw calls because the tail runs to 329 g/t.
LADDER = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0, 50.0]
G_PER_OZ = 31.10348

stats = json.loads(STATS.read_text())
VEINS = stats["veins"]
CLASS_LABELS = stats["class_labels"]
TONNES_PER_BLOCK = stats["tonnes_per_block"]

rows = []
with open(SRC, newline="") as f:
    for r in csv.DictReader(f):
        g = float(r["aueq"])
        rows.append((float(r["x"]), float(r["y"]), float(r["z"]), g,
                     float(r["penv"]), int(r["cls"]), int(r["vein"])))

gvals = sorted(r[3] for r in rows)
RAMPMAX = max(1.0, round(gvals[int(len(gvals) * 0.90)], 1))
Es = [r[0] for r in rows]; Ns = [r[1] for r in rows]; Zs = [r[2] for r in rows]
EMIN, NMIN = min(Es), min(Ns)
cE = (EMIN + max(Es)) / 2; cN = (NMIN + max(Ns)) / 2; cZ = (min(Zs) + max(Zs)) / 2
EX = max(Es) - min(Es); EY = max(Ns) - min(Ns)

# Sort by (class, ladder-bin) so each render bucket is one contiguous run —
# the viewer slices the buffer instead of shipping per-block indices.
def binof(g):
    return bisect.bisect_right(LADDER, g) - 1

rows.sort(key=lambda r: (r[5], binof(r[3]), r[6]))

buf = bytearray()
meta = bytearray()
for x, y, z, g, penv, cls, vein in rows:
    buf += struct.pack("<ffff", x - EMIN, y - NMIN, z, g)
    meta += struct.pack("<BB", cls, vein)
b64 = base64.b64encode(bytes(buf)).decode()
b64m = base64.b64encode(bytes(meta)).decode()
N = len(rows)

# Contiguous (class, bin) runs -> the base render buckets.
RUNS = []
start = 0
for i in range(1, N + 1):
    if i == N or (rows[i][5], binof(rows[i][3])) != (rows[start][5], binof(rows[start][3])):
        c, b = rows[start][5], binof(rows[start][3])
        RUNS.append({"c": c, "b": b, "lo": LADDER[b],
                     "hi": LADDER[b + 1] if b + 1 < len(LADDER) else None,
                     "s": start, "n": i - start})
        start = i

# Exact rollups per (vein, class, bin). The readout sums these, never the pixels.
roll = defaultdict(lambda: [0, 0.0, 0.0])
for x, y, z, g, penv, cls, vein in rows:
    t = TONNES_PER_BLOCK * penv
    e = roll[(vein, cls, binof(g))]
    e[0] += 1; e[1] += t; e[2] += t * g
BUCKETS = [{"v": v, "c": c, "b": b, "n": e[0], "t": round(e[1], 1), "m": round(e[2], 1)}
           for (v, c, b), e in sorted(roll.items())]

CHAPTERS = [
  {"h": 28, "p": -26, "r": 3600, "cut": 0.1, "xray": True, "mode": "grade",
   "title": "A high-grade gold system", "body": "The Elk Gold project sits in the Quesnel Highland of British Columbia's Cariboo District — a road-accessible, established mining region."},
  {"h": 30, "p": -22, "r": 2500, "cut": 0.1, "xray": True, "mode": "grade",
   "title": "On real ground", "body": "Every block is placed at its true UTM position on real terrain — this is the actual mountain the deposit sits inside."},
  {"h": 44, "p": -34, "r": 1950, "cut": 0.1, "xray": True, "mode": "grade",
   "title": "The orebody", "body": "A multi-vein gold system, roughly 1,440 by 1,385 metres, coloured by gold-equivalent grade — cool blues low, hot reds high."},
  {"h": 66, "p": -30, "r": 1450, "cut": 1.0, "xray": True, "mode": "grade",
   "title": "The high-grade core", "body": "Raising the cut-off to 1 g/t strips away the halo and reveals the bonanza vein shells that carry most of the metal."},
  {"h": 52, "p": -30, "r": 1700, "cut": 0.1, "xray": True, "mode": "class",
   "title": "How well is it known?", "body": "Recoloured by resource classification. Confidence is not evenly distributed through a deposit — and this is the first question any technical reader asks."},
  {"h": 0, "p": -89, "r": 2500, "cut": 0.3, "xray": True, "mode": "grade",
   "title": "Footprint in plan", "body": "Seen from directly above: northwest-trending vein corridors threading across the ridge."},
  {"h": 4, "p": -4, "r": 2650, "cut": 0.3, "xray": True, "mode": "grade",
   "title": "In profile", "body": "Turned on edge, the veins persist to roughly 475 metres below surface — and remain open at depth."},
  {"h": 26, "p": -27, "r": 3000, "cut": 0.15, "xray": True, "mode": "grade",
   "title": "Explore it yourself", "body": "Forty-six vein domains, each one isolatable, each with its own grade and tonnage. Open Explore and interrogate the model directly."},
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

  /* caption bar */
  #bar{position:fixed;left:0;right:0;bottom:0;z-index:6;padding:70px 34px 26px;
       background:linear-gradient(180deg,rgba(7,9,10,0) 0%,rgba(7,9,10,.72) 44%,rgba(7,9,10,.92) 100%);
       display:flex;align-items:flex-end;justify-content:space-between;gap:36px;transition:opacity .4s}
  #cap{max-width:560px;opacity:0;transform:translateY(14px);transition:opacity .6s ease,transform .6s ease}
  #cap.in{opacity:1;transform:none}
  #cap .ey{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.22em;color:#C99A3A;text-transform:uppercase}
  #cap h2{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1.05;margin:12px 0 12px}
  #cap p{font-family:Newsreader,Georgia,serif;font-size:18px;line-height:1.55;color:#C6CAC5;text-wrap:pretty}
  #nav{display:flex;align-items:center;gap:14px;flex:0 0 auto;padding-bottom:4px}
  .btn{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#EDEEEC;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:3px;padding:12px 18px;cursor:pointer;transition:.2s}
  .btn:hover{border-color:#C99A3A;color:#C99A3A}
  .btn:disabled{opacity:.3;cursor:default}
  .btn.on{background:#C99A3A;border-color:#C99A3A;color:#07090A}
  #nav .count{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.14em;color:#8E948E;min-width:52px;text-align:center}

  /* legend */
  #legend{position:fixed;right:34px;top:28px;z-index:6;display:flex;align-items:center;gap:9px;opacity:.85}
  #ramp{height:8px;width:150px;border-radius:2px;background:linear-gradient(90deg,#14324f,#1c7fb8,#21b0a0,#8fd14f,#f2c14e,#e8532b)}
  #legend span{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.06em;color:#8E948E}
  #clsleg{display:none;gap:14px;align-items:center}
  #clsleg .k{display:flex;align-items:center;gap:6px}
  #clsleg .sw{width:10px;height:10px;border-radius:2px}

  /* explore panel */
  #xbtn{position:fixed;right:34px;top:64px;z-index:7}
  #panel{position:fixed;right:34px;top:108px;width:296px;z-index:7;background:rgba(12,15,16,.93);
         border:1px solid rgba(255,255,255,.13);border-radius:5px;padding:18px 18px 16px;display:none;
         backdrop-filter:blur(9px)}
  #panel.on{display:block}
  #panel h3{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;color:#8E948E;margin:0 0 9px}
  #panel h3:not(:first-child){margin-top:19px}
  .seg{display:flex;gap:0;border:1px solid rgba(255,255,255,.16);border-radius:3px;overflow:hidden}
  .seg button{flex:1;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;
              padding:8px 0;background:transparent;border:none;color:#8E948E;cursor:pointer;transition:.15s}
  .seg button.on{background:#C99A3A;color:#07090A}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{display:flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:10px;
        padding:6px 9px;border:1px solid rgba(255,255,255,.16);border-radius:3px;cursor:pointer;color:#8E948E;transition:.15s}
  .chip.on{color:#EDEEEC;border-color:rgba(255,255,255,.4)}
  .chip .sw{width:8px;height:8px;border-radius:2px;opacity:.35}
  .chip.on .sw{opacity:1}
  #cutrow{display:flex;align-items:center;gap:11px}
  #cut{flex:1;accent-color:#C99A3A}
  #cutv{font-family:'JetBrains Mono',monospace;font-size:11px;color:#C99A3A;min-width:56px;text-align:right}
  select{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:3px;
         color:#EDEEEC;font-family:'JetBrains Mono',monospace;font-size:11px;padding:9px;cursor:pointer}
  #readout{margin-top:18px;padding-top:15px;border-top:1px solid rgba(255,255,255,.11)}
  #readout .row{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0}
  #readout .l{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#8E948E}
  #readout .v{font-family:'JetBrains Mono',monospace;font-size:14px;color:#EDEEEC}
  #readout .v.hero{color:#C99A3A;font-size:16px}
  #caveat{margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:9px;line-height:1.5;color:#6b716d}

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
  @media(max-width:900px){#rail{display:none}#panel{display:none!important}#xbtn{display:none}#cap h2{font-size:23px}#cap p{font-size:16px}}
</style>
</head>
<body>
<div id="cesiumContainer"></div>
<div id="load">PREPARING PRESENTATION…</div>
<div id="prog"></div>

<div id="brand"><div class="w">Orebody Present</div><div class="n">Elk Gold<br>Siwash North</div></div>
<div id="rail"></div>
<div id="legend">
  <div id="gradeleg" style="display:flex;align-items:center;gap:9px"><span>AuEq</span><div id="ramp"></div><span id="rmax"></span></div>
  <div id="clsleg"></div>
</div>
<button id="xbtn" class="btn">Explore ▸</button>

<div id="panel">
  <h3>Colour by</h3>
  <div class="seg" id="modeseg">
    <button data-m="grade" class="on">Grade</button>
    <button data-m="class">Class</button>
  </div>

  <h3>Cut-off grade</h3>
  <div id="cutrow"><input type="range" id="cut" min="0" max="14" step="1" value="1"><span id="cutv"></span></div>

  <h3>Resource class</h3>
  <div class="chips" id="clschips"></div>

  <h3>Vein domain</h3>
  <select id="vsel"></select>

  <div id="readout">
    <div class="row"><span class="l">Tonnes</span><span class="v" id="r_t">—</span></div>
    <div class="row"><span class="l">Grade AuEq</span><span class="v" id="r_g">—</span></div>
    <div class="row"><span class="l">Contained</span><span class="v hero" id="r_oz">—</span></div>
    <div class="row"><span class="l">Blocks</span><span class="v" id="r_n">—</span></div>
  </div>
  <div id="caveat"></div>
</div>

<div id="bar">
  <div id="cap"><div class="ey" id="cap_ey">01 / 08</div><h2 id="cap_t"></h2><p id="cap_b"></p></div>
  <div id="nav">
    <button id="prev" class="btn">‹ Back</button>
    <span class="count" id="count">1 / 8</span>
    <button id="next" class="btn">Next ›</button>
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
const DATA="__B64__", META="__META__", N=__N__, RAMPMAX=__RAMPMAX__,
      EMIN=__EMIN__, NMIN=__NMIN__, CE=__CE__, CN=__CN__, CZ=__CZ__, EX=__EX__, EY=__EY__;
const CHAPTERS=__CHAPTERS__, RUNS=__RUNS__, BUCKETS=__BUCKETS__, VEINS=__VEINS__,
      LADDER=__LADDER__, CLASS_LABELS=__CLASS_LABELS__, CLASS_CONFIRMED=__CLASS_CONFIRMED__,
      TPB=__TPB__, TOTAL=__TOTAL__;
proj4.defs('EPSG:26910','+proj=utm +zone=10 +datum=NAD83 +units=m +no_defs');
const GEOID=-18, rad=Cesium.Math.toRadians, $=id=>document.getElementById(id);
const setStat=t=>$('status').textContent=t;
function unb64(b){const s=atob(b);const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u;}
const F=new Float32Array(unb64(DATA).buffer), M=unb64(META);

const STOPS=[[0,[.078,.196,.31]],[.2,[.11,.5,.72]],[.4,[.13,.69,.63]],[.6,[.56,.82,.31]],[.8,[.95,.76,.31]],[1,[.91,.33,.17]]];
function ramp(g){const t=Math.max(0,Math.min(1,g/RAMPMAX));let a=STOPS[0],b=STOPS[STOPS.length-1];
  for(let i=0;i<STOPS.length-1;i++){if(t>=STOPS[i][0]&&t<=STOPS[i+1][0]){a=STOPS[i];b=STOPS[i+1];break}}
  const u=(t-a[0])/((b[0]-a[0])||1);
  return new Cesium.Color(a[1][0]+(b[1][0]-a[1][0])*u,a[1][1]+(b[1][1]-a[1][1])*u,a[1][2]+(b[1][2]-a[1][2])*u,1);}
const CLS_COLOR={0:'#5b6470',1:'#3EA6D6',2:'#C99A3A',3:'#D9584A'};
const clsColor=c=>Cesium.Color.fromCssColorString(CLS_COLOR[c]||'#888');
$('rmax').textContent=RAMPMAX+'+ g/t';
const fmt=n=>n>=1e6?(n/1e6).toFixed(2)+' Mt':n>=1e3?Math.round(n).toLocaleString():n.toFixed(0);
const fmtoz=n=>n>=1e6?(n/1e6).toFixed(3)+' Moz':Math.round(n).toLocaleString()+' oz';

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

  // Blocks are 10 x 5 x 5 m on the source grid.
  const box=Cesium.BoxGeometry.fromDimensions({vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                                               dimensions:new Cesium.Cartesian3(10,5,5)});
  const posFor=i=>{const E=F[i*4]+EMIN,Nn=F[i*4+1]+NMIN,h=F[i*4+2]+GEOID;
    return Cesium.Cartesian3.fromDegrees(...proj4('EPSG:26910','WGS84',[E,Nn]),h);};

  // Base set: one uniform-colour primitive per (class, grade-bin) run. Uniform
  // colour means recolouring is a single material uniform, not 168k attributes.
  function makePrim(indices,color){
    const inst=indices.map(i=>new Cesium.GeometryInstance({geometry:box,
      modelMatrix:Cesium.Transforms.eastNorthUpToFixedFrame(posFor(i))}));
    const prim=new Cesium.Primitive({geometryInstances:inst,asynchronous:true,
      appearance:new Cesium.MaterialAppearance({flat:false,translucent:false,
        material:Cesium.Material.fromType('Color',{color})})});
    return prim;
  }
  setStat('building blocks…');
  RUNS.forEach(r=>{
    const idx=[]; for(let i=r.s;i<r.s+r.n;i++) idx.push(i);
    const mid=r.hi===null?r.lo*1.4:(r.lo+r.hi)/2;
    r.mid=mid;
    r.prim=makePrim(idx,ramp(mid));
    viewer.scene.primitives.add(r.prim);
  });

  // Per-vein sets are built lazily — isolation is a deliberate click, not a slider.
  const veinPrims={};
  function buildVein(v){
    if(veinPrims[v]) return veinPrims[v];
    const byKey={};
    for(const r of RUNS) for(let i=r.s;i<r.s+r.n;i++){
      if(M[i*2+1]!==v) continue;
      const k=r.c+'|'+r.b; (byKey[k]=byKey[k]||{c:r.c,b:r.b,lo:r.lo,mid:r.mid,idx:[]}).idx.push(i);
    }
    const set=Object.values(byKey).map(g=>{
      const p=makePrim(g.idx,ramp(g.mid)); p.show=false;
      viewer.scene.primitives.add(p); return {...g,prim:p};
    });
    veinPrims[v]=set; return set;
  }

  // ---- state ----
  let mode='grade', cutIdx=1, vein=-1, clsOn={0:true,1:true,2:true,3:true}, cur=0;
  const cutVal=()=>LADDER[cutIdx];

  function colorOf(g){ return mode==='grade'?ramp(g.mid):clsColor(g.c); }
  function apply(){
    const cut=cutVal();
    const vis=g=>g.lo>=cut-1e-9 && clsOn[g.c];
    RUNS.forEach(r=>{ if(r.prim){ r.prim.show = vein===-1 && vis(r);
      r.prim.appearance.material.uniforms.color=colorOf(r); } });
    if(vein!==-1) buildVein(vein).forEach(g=>{ g.prim.show=vis(g);
      g.prim.appearance.material.uniforms.color=colorOf(g); });
    Object.entries(veinPrims).forEach(([v,set])=>{ if(+v!==vein) set.forEach(g=>g.prim.show=false); });
    readout();
  }

  // Numbers come from the exact per-bucket rollups, never from what is drawn.
  function readout(){
    const cut=cutVal(); let n=0,t=0,m=0;
    for(const b of BUCKETS){
      if(LADDER[b.b]<cut-1e-9) continue;
      if(!clsOn[b.c]) continue;
      if(vein!==-1 && b.v!==vein) continue;
      n+=b.n; t+=b.t; m+=b.m;
    }
    $('r_t').textContent=t?fmt(t)+(t>=1e6?'':' t'):'—';
    $('r_g').textContent=t?(m/t).toFixed(2)+' g/t':'—';
    $('r_oz').textContent=t?fmtoz(m/31.10348):'—';
    $('r_n').textContent=n.toLocaleString();
  }

  // ---- explore UI ----
  $('cutv').textContent=cutVal().toFixed(2)+' g/t';
  $('cut').oninput=e=>{cutIdx=+e.target.value;$('cutv').textContent=cutVal().toFixed(2)+' g/t';apply();};
  $('modeseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    mode=b.dataset.m;
    $('modeseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    $('gradeleg').style.display=mode==='grade'?'flex':'none';
    $('clsleg').style.display=mode==='class'?'flex':'none';
    apply();});
  const chips=$('clschips');
  Object.keys(CLASS_LABELS).map(Number).sort().forEach(c=>{
    const d=document.createElement('div'); d.className='chip on';
    d.innerHTML='<span class="sw" style="background:'+CLS_COLOR[c]+'"></span>'+CLASS_LABELS[c];
    d.onclick=()=>{clsOn[c]=!clsOn[c];d.classList.toggle('on',clsOn[c]);apply();};
    chips.appendChild(d);
    const k=document.createElement('div'); k.className='k';
    k.innerHTML='<span class="sw" style="background:'+CLS_COLOR[c]+'"></span><span>'+CLASS_LABELS[c]+'</span>';
    $('clsleg').appendChild(k);
  });
  const vsel=$('vsel');
  const veinOz={}; BUCKETS.forEach(b=>veinOz[b.v]=(veinOz[b.v]||0)+b.m/31.10348);
  vsel.innerHTML='<option value="-1">All veins ('+VEINS.length+')</option>'+
    VEINS.map((nm,i)=>({nm,i,oz:veinOz[i]||0})).sort((a,b)=>b.oz-a.oz)
      .map(v=>'<option value="'+v.i+'">'+v.nm+' — '+Math.round(v.oz).toLocaleString()+' oz</option>').join('');
  vsel.onchange=e=>{vein=+e.target.value;setStat(vein===-1?'all veins':'isolating '+VEINS[vein]);apply();};
  $('caveat').textContent=CLASS_CONFIRMED?'':
    'Class labels follow the usual MineSight convention but are unconfirmed against the Nov-2021 technical report. Illustrative — not a mineral resource statement.';
  $('xbtn').onclick=()=>{const on=$('panel').classList.toggle('on');
    $('xbtn').classList.toggle('on',on); $('xbtn').textContent=on?'Explore ◂':'Explore ▸';
    $('bar').style.opacity=on?'0':'1'; $('bar').style.pointerEvents=on?'none':'auto';};

  // ---- chapters ----
  const rail=$('rail');
  CHAPTERS.forEach((c,i)=>{const d=document.createElement('div');d.className='c';
    d.innerHTML='<span class="num">'+String(i+1).padStart(2,'0')+'</span><span class="t">'+c.title+'</span>';
    d.onclick=()=>go(i);rail.appendChild(d);});
  const railItems=[...rail.children];

  function frameFor(c,animate){
    const hpr=new Cesium.HeadingPitchRange(rad(c.h),rad(c.p),c.r);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if(animate) viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center,RADIUS),
      {offset:hpr,duration:2.3,complete:()=>viewer.camera.lookAt(center,hpr)});
    else viewer.camera.lookAt(center,hpr);
  }
  function paintUI(){
    const c=CHAPTERS[cur];
    $('cap').classList.remove('in');
    setTimeout(()=>{
      $('cap_ey').textContent=String(cur+1).padStart(2,'0')+' / '+String(CHAPTERS.length).padStart(2,'0');
      $('cap_t').textContent=c.title; $('cap_b').textContent=c.body;
      $('cap').classList.add('in');},160);
    $('count').textContent=(cur+1)+' / '+CHAPTERS.length;
    $('prev').disabled=cur===0; $('next').disabled=cur===CHAPTERS.length-1;
    $('prog').style.width=(cur/(CHAPTERS.length-1)*100)+'%';
    railItems.forEach((el,i)=>el.classList.toggle('on',i===cur));
  }
  function go(i,initial){
    if(i<0||i>=CHAPTERS.length) return;
    cur=i; const c=CHAPTERS[i];
    cutIdx=Math.max(0,LADDER.findIndex(v=>v>=c.cut));
    $('cut').value=cutIdx; $('cutv').textContent=cutVal().toFixed(2)+' g/t';
    mode=c.mode||'grade';
    $('modeseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.m===mode));
    $('gradeleg').style.display=mode==='grade'?'flex':'none';
    $('clsleg').style.display=mode==='class'?'flex':'none';
    vein=-1; vsel.value='-1';
    viewer.scene.globe.depthTestAgainstTerrain=!c.xray;
    apply(); frameFor(c,!initial); paintUI();
  }
  $('next').onclick=()=>go(cur+1);
  $('prev').onclick=()=>go(cur-1);
  addEventListener('keydown',e=>{
    if(e.key==='ArrowRight'||e.key===' ') go(cur+1);
    else if(e.key==='ArrowLeft') go(cur-1);
    else if(e.key==='e'||e.key==='E') $('xbtn').click();});

  go(0,true);
  $('load').style.display='none';
  $('begin').onclick=()=>{$('intro').style.opacity='0';setTimeout(()=>$('intro').style.display='none',800);frameFor(CHAPTERS[0],true);};
  window.__viewer=viewer;
})().catch(e=>setStat('FATAL: '+e.message));
</script>
</body>
</html>"""

for k, v in {
    "__B64__": b64, "__META__": b64m, "__N__": str(N), "__RAMPMAX__": f"{RAMPMAX}",
    "__EMIN__": f"{EMIN:.1f}", "__NMIN__": f"{NMIN:.1f}", "__CE__": f"{cE:.1f}",
    "__CN__": f"{cN:.1f}", "__CZ__": f"{cZ:.1f}", "__EX__": f"{EX:.0f}", "__EY__": f"{EY:.0f}",
    "__CHAPTERS__": json.dumps(CHAPTERS),
    "__RUNS__": json.dumps([{k2: r[k2] for k2 in ("c", "b", "lo", "hi", "s", "n")} for r in RUNS]),
    "__BUCKETS__": json.dumps(BUCKETS),
    "__VEINS__": json.dumps(VEINS),
    "__LADDER__": json.dumps(LADDER),
    "__CLASS_LABELS__": json.dumps(CLASS_LABELS),
    "__CLASS_CONFIRMED__": "true" if stats.get("class_mapping_confirmed") else "false",
    "__TPB__": f"{TONNES_PER_BLOCK}",
    "__TOTAL__": json.dumps(stats["total"]),
}.items():
    HTML = HTML.replace(k, v)

OUT.write_text(HTML)
print(f"wrote {OUT.name} ({len(HTML)/1e6:.1f} MB)")
print(f"  {N:,} blocks · {len(RUNS)} base primitives · {len(BUCKETS)} stat buckets")
print(f"  {len(VEINS)} vein domains · {len(CHAPTERS)} chapters · ramp max {RAMPMAX} g/t")
print(f"  total {stats['total']['tonnes']:,.0f} t @ {stats['total']['grade_gt']} g/t = {stats['total']['oz']:,.0f} oz")
