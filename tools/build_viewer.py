#!/usr/bin/env python3
"""Pack the Elk Gold ore blocks into a self-contained Three.js viewer HTML."""
import csv, struct, base64, statistics

SRC = "elk_ore_blocks.csv"
OUT = "elk-viewer.html"
BX, BY, BZ = 10.0, 10.0, 5.0          # block size: X(E), Y(N), Z(elev)
DENS = 2.7
T_PER_BLOCK = BX * BY * BZ * DENS      # tonnes per block = 500 m3 * 2.7 = 1350 t

rows = []
with open(SRC, newline="") as f:
    for x, y, z, aueq, penv in csv.reader(f):
        dg = float(aueq) * float(penv)     # diluted block grade (g/t AuEq)
        if dg > 0:
            rows.append((float(x), float(y), float(z), dg))

# deposit centre for local frame (keeps float32 precision)
xs = [r[0] for r in rows]; ys = [r[1] for r in rows]; zs = [r[2] for r in rows]
E0 = (min(xs) + max(xs)) / 2
N0 = (min(ys) + max(ys)) / 2
Z0 = (min(zs) + max(zs)) / 2
extent = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))

# sort by grade DESC -> cutoff slider just sets InstancedMesh.count
rows.sort(key=lambda r: r[3], reverse=True)
maxg = rows[0][3]
# colour-ramp ceiling = ~98th percentile so the ramp isn't dominated by outliers
gsorted = [r[3] for r in rows]
RAMPMAX = max(1.0, round(gsorted[int(len(gsorted) * 0.02)], 1))
print(f"diluted grade: max={maxg:.1f}  p98(rampMax)={RAMPMAX}  median={statistics.median(gsorted):.2f}")

# pack Float32 [tx, ty(up=elev), tz, grade] per block, three.js Y-up:
# tx = E-E0 ; ty = elev-Z0 ; tz = -(N-N0)
buf = bytearray()
for x, y, z, g in rows:
    buf += struct.pack("<ffff", x - E0, z - Z0, -(y - N0), g)
b64 = base64.b64encode(bytes(buf)).decode()

N = len(rows)
tot_tonnes = N * T_PER_BLOCK
print(f"blocks={N}  maxgrade={maxg:.1f}  extent={extent}  tonnes~{tot_tonnes/1e6:.1f}Mt")

HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elk Gold — Siwash North · 3D Block Model</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%;background:#0A0D0C;overflow:hidden;font-family:Archivo,system-ui,sans-serif;color:#E8E9E6}
  #c{position:fixed;inset:0;display:block}
  .panel{position:fixed;background:rgba(12,16,15,.72);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.1);border-radius:4px}
  #hud{top:22px;left:22px;padding:20px 22px;max-width:340px}
  #hud .eyebrow{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;color:#D3A64B;margin-bottom:9px}
  #hud h1{font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1.05;text-transform:uppercase}
  #hud .sub{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.06em;color:#8E958F;margin-top:8px;line-height:1.7}
  #stats{top:22px;right:22px;padding:18px 20px;min-width:210px}
  #stats .row{display:flex;justify-content:space-between;align-items:baseline;gap:18px;padding:7px 0;border-top:1px solid rgba(255,255,255,.08)}
  #stats .row:first-child{border-top:none}
  #stats .k{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#8E958F}
  #stats .v{font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:500;color:#F2F3F0}
  #stats .v b{color:#D3A64B;font-weight:500}
  #ctrl{left:22px;bottom:22px;padding:16px 20px 18px;width:340px}
  #ctrl label{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#8E958F;display:flex;justify-content:space-between}
  #ctrl label b{color:#D3A64B;font-weight:500}
  input[type=range]{width:100%;margin-top:12px;accent-color:#D3A64B}
  #legend{display:flex;align-items:center;gap:10px;margin-top:16px}
  #ramp{height:9px;flex:1;border-radius:2px;background:linear-gradient(90deg,#14324f,#1c7fb8,#21b0a0,#8fd14f,#f2c14e,#e8532b)}
  #legend span{font-family:'JetBrains Mono',monospace;font-size:9.5px;color:#8E958F}
  .btns{position:fixed;right:22px;bottom:22px;display:flex;gap:8px}
  .btns button{font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#E8E9E6;background:rgba(12,16,15,.72);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.14);border-radius:3px;padding:10px 14px;cursor:pointer}
  .btns button:hover{border-color:#D3A64B;color:#D3A64B}
  #load{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.2em;color:#8E958F;background:#0A0D0C;z-index:9}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="load">DECODING BLOCK MODEL…</div>

<div id="hud" class="panel">
  <div class="eyebrow">CSE&nbsp;·&nbsp;Resource Model</div>
  <h1>Elk Gold<br>Siwash North</h1>
  <div class="sub">3D Block Model · __N__ blocks<br>10 × 10 × 5 m · UTM 10N NAD83<br>Envelope __EX__ × __EY__ × __EZ__ m</div>
</div>

<div id="stats" class="panel">
  <div class="row"><span class="k">Blocks shown</span><span class="v" id="s_blocks">—</span></div>
  <div class="row"><span class="k">Tonnes</span><span class="v" id="s_tonnes">—</span></div>
  <div class="row"><span class="k">Contained AuEq</span><span class="v"><b id="s_oz">—</b></span></div>
  <div class="row"><span class="k">Avg grade</span><span class="v" id="s_grade">—</span></div>
</div>

<div id="ctrl" class="panel">
  <label>AuEq Cut-off <b id="cut">0.10 g/t</b></label>
  <input id="slider" type="range" min="0" max="__RAMPMAX__" step="0.02" value="0.1">
  <div id="legend"><span>0</span><div id="ramp"></div><span id="rmax">g/t</span></div>
  <div style="font-family:'JetBrains Mono',monospace;font-size:9px;line-height:1.6;letter-spacing:.04em;color:#5f6560;margin-top:12px">Illustrative · Nov 2021 block model · diluted AuEq (grade × envelope %) · not a mineral resource statement.</div>
</div>

<div class="btns">
  <button id="spin">⏸ Rotate</button>
  <button id="reset">Reset view</button>
</div>

<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<script>
const DATA="__B64__", N=__N__, TPB=__TPB__, MAXG=__MAXG__, RAMPMAX=__RAMPMAX__;
const EX=__EX__, EY=__EY__, EZ=__EZ__;

// decode base64 -> Float32Array [tx,ty,tz,grade]*N
function decode(b64){const bin=atob(b64);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return new Float32Array(u.buffer);}
const F=decode(DATA);

// cumulative tonnes/metal (blocks are grade-sorted DESC) for O(1) cutoff stats
const cumT=new Float64Array(N+1), cumM=new Float64Array(N+1), grades=new Float32Array(N);
for(let i=0;i<N;i++){const g=F[i*4+3];grades[i]=g;cumT[i+1]=cumT[i]+TPB;cumM[i+1]=cumM[i]+g*TPB/31.1035;}

// grade -> colour ramp
const STOPS=[[0,[0.078,0.196,0.31]],[0.2,[0.11,0.5,0.72]],[0.4,[0.13,0.69,0.63]],[0.6,[0.56,0.82,0.31]],[0.8,[0.95,0.76,0.31]],[1,[0.91,0.33,0.17]]];
function ramp(g){const t=Math.max(0,Math.min(1,g/RAMPMAX));let a=STOPS[0],b=STOPS[STOPS.length-1];for(let i=0;i<STOPS.length-1;i++){if(t>=STOPS[i][0]&&t<=STOPS[i+1][0]){a=STOPS[i];b=STOPS[i+1];break}}const u=(t-a[0])/((b[0]-a[0])||1);return[a[1][0]+(b[1][0]-a[1][0])*u,a[1][1]+(b[1][1]-a[1][1])*u,a[1][2]+(b[1][2]-a[1][2])*u];}

const renderer=new THREE.WebGLRenderer({canvas:document.getElementById('c'),antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);
const scene=new THREE.Scene();scene.background=new THREE.Color(0x0A0D0C);scene.fog=new THREE.Fog(0x0A0D0C,1600,4200);
const cam=new THREE.PerspectiveCamera(48,innerWidth/innerHeight,1,20000);
const R=Math.max(EX,EY); cam.position.set(R*0.9,R*0.7,R*1.1);
const controls=new THREE.OrbitControls(cam,renderer.domElement);
controls.enableDamping=true;controls.autoRotate=true;controls.autoRotateSpeed=0.55;controls.target.set(0,0,0);

scene.add(new THREE.HemisphereLight(0xbfd4ff,0x1a140a,0.9));
const dl=new THREE.DirectionalLight(0xfff2d8,0.8);dl.position.set(1,2,1.4);scene.add(dl);

// ground grid at deposit base
const grid=new THREE.GridHelper(Math.max(EX,EY)*1.6,26,0x2a3330,0x171d1b);
grid.position.y=-EZ/2-20;scene.add(grid);

// instanced blocks
const geo=new THREE.BoxGeometry(10,5,10);
const mat=new THREE.MeshLambertMaterial();
const mesh=new THREE.InstancedMesh(geo,mat,N);
mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
const m=new THREE.Matrix4(),col=new THREE.Color();
for(let i=0;i<N;i++){m.setPosition(F[i*4],F[i*4+1],F[i*4+2]);mesh.setMatrixAt(i,m);const c=ramp(F[i*4+3]);col.setRGB(c[0],c[1],c[2]);mesh.setColorAt(i,col);}
mesh.instanceColor.needsUpdate=true;scene.add(mesh);

// cutoff -> count (grades sorted desc: find last index >= cutoff via binary search)
function countAbove(cut){let lo=0,hi=N;while(lo<hi){const mid=(lo+hi)>>1;if(grades[mid]>=cut)lo=mid+1;else hi=mid;}return lo;}
const fmt=n=>n>=1e6?(n/1e6).toFixed(1)+' Mt':n>=1e3?(n/1e3).toFixed(0)+' kt':n.toFixed(0)+' t';
const fmtk=n=>n>=1e3?(n/1e3).toFixed(1)+' Moz':n.toFixed(0)+' koz';
function apply(cut){
  const n=countAbove(cut);mesh.count=n;
  const t=cumT[n],metalOz=cumM[n];
  document.getElementById('s_blocks').textContent=n.toLocaleString();
  document.getElementById('s_tonnes').textContent=fmt(t);
  document.getElementById('s_oz').textContent=fmtk(metalOz/1000);
  document.getElementById('s_grade').textContent=(t>0?(metalOz*31.1035/t):0).toFixed(2)+' g/t';
  document.getElementById('cut').textContent=cut.toFixed(2)+' g/t';
}
document.getElementById('rmax').textContent=RAMPMAX+'+ g/t';
const slider=document.getElementById('slider');
slider.addEventListener('input',()=>apply(parseFloat(slider.value)));
apply(0.1);

document.getElementById('spin').onclick=e=>{controls.autoRotate=!controls.autoRotate;e.target.textContent=(controls.autoRotate?'⏸':'▶')+' Rotate';};
const home=cam.position.clone();
document.getElementById('reset').onclick=()=>{cam.position.copy(home);controls.target.set(0,0,0);};
addEventListener('resize',()=>{cam.aspect=innerWidth/innerHeight;cam.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});

document.getElementById('load').style.display='none';
(function loop(){requestAnimationFrame(loop);controls.update();renderer.render(scene,cam);})();
</script>
</body>
</html>"""

HTML = (HTML
    .replace("__B64__", b64)
    .replace("__N__", str(N))
    .replace("__TPB__", str(T_PER_BLOCK))
    .replace("__MAXG__", f"{maxg:.4f}")
    .replace("__RAMPMAX__", f"{RAMPMAX}")
    .replace("__EX__", f"{extent[0]:.0f}")
    .replace("__EY__", f"{extent[1]:.0f}")
    .replace("__EZ__", f"{extent[2]:.0f}"))

with open(OUT, "w") as f:
    f.write(HTML)
print(f"wrote {OUT}  ({len(HTML)/1e6:.1f} MB)")
