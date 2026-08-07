#!/usr/bin/env python3
"""Orebody Present — a VRIFY-Present-style guided 3D walkthrough.

Builds a single self-contained index.html from the extracted block model.

  Phase 1  block model on real terrain, chapter walkthrough
  Phase 2  resource classification, vein isolation, exact grade-tonnage
  Phase 3  autoplay, narration, deep-links, scale bar + north arrow
  Phase 4  embed mode, and export to PNG / PPTX / PDF

Inputs
  data/elk_blocks_v2.csv     from tools/extract_blocks.py
  data/elk_stats.json        exact rollups, computed over every block
  data/elk_buckets.json      share-weighted (vein, class, bin) rollups
  tools/assets/fonts.css     self-hosted webfonts, inlined
  data/synthetic/*.csv       drill holes (optional; see manifest.json)

Rendering and reporting are deliberately decoupled. Geometry is bucketed by
(class, grade-ladder) so cut-off / class / colour changes are a handful of
primitive toggles rather than a rebuild. The numbers in the readout do NOT come
from what is drawn — they are summed from exact per-bucket rollups computed over
every mineralized block at build time. Filter the view however you like; the
tonnage stays honest.

Drill holes are desurveyed here rather than in the generator, so that when real
collar/survey/assay CSVs replace the synthetic ones the same path serves them.
If the drill manifest says synthetic:true the viewer stamps a permanent,
non-dismissable warning — do not weaken that.
"""
import csv, struct, base64, json, bisect, math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "elk_blocks_v2.csv"
STATS = ROOT / "data" / "elk_stats.json"
BUCKETS_JSON = ROOT / "data" / "elk_buckets.json"
DRILLDIR = ROOT / "data" / "synthetic"
OUT = ROOT / "index.html"

# Grade ladder for bucketing. Shaped like the cut-offs people actually pull
# (0.1 / 0.3 / 1.0 g/t), not a linear bin — a linear bin fragments into
# thousands of near-empty draw calls because the tail runs to 329 g/t.
LADDER = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0, 50.0]
TRACE_STEP = 5.0          # m between desurveyed trace points

stats = json.loads(STATS.read_text())
VEINS = stats["veins"]
CLASS_LABELS = stats["class_labels"]

# ---------------------------------------------------------------- blocks
rows = []
with open(SRC, newline="") as f:
    for r in csv.DictReader(f):
        rows.append((float(r["x"]), float(r["y"]), float(r["z"]),
                     float(r["aueq"]), float(r["penv"]), int(r["cls"]), int(r["vein"])))

gvals = sorted(r[3] for r in rows)
RAMPMAX = max(1.0, round(gvals[int(len(gvals) * 0.90)], 1))
Es = [r[0] for r in rows]; Ns = [r[1] for r in rows]; Zs = [r[2] for r in rows]
EMIN, NMIN = min(Es), min(Ns)
cE = (EMIN + max(Es)) / 2; cN = (NMIN + max(Ns)) / 2; cZ = (min(Zs) + max(Zs)) / 2
EX = max(Es) - min(Es); EY = max(Ns) - min(Ns)


def binof(g):
    return bisect.bisect_right(LADDER, g) - 1


# Sort by (class, ladder-bin) so each render bucket is one contiguous run —
# the viewer slices the buffer instead of shipping per-block indices.
rows.sort(key=lambda r: (r[5], binof(r[3]), r[6]))

buf = bytearray()
meta = bytearray()
for x, y, z, g, penv, cls, vein in rows:
    buf += struct.pack("<ffff", x - EMIN, y - NMIN, z, g)
    meta += struct.pack("<BB", cls, vein)
b64 = base64.b64encode(bytes(buf)).decode()
b64m = base64.b64encode(bytes(meta)).decode()
N = len(rows)
assert len(VEINS) <= 256, f"{len(VEINS)} vein domains exceeds the uint8 packing in META"

RUNS = []
start = 0
for i in range(1, N + 1):
    if i == N or (rows[i][5], binof(rows[i][3])) != (rows[start][5], binof(rows[start][3])):
        c, b = rows[start][5], binof(rows[start][3])
        RUNS.append({"c": c, "b": b, "lo": LADDER[b],
                     "hi": LADDER[b + 1] if b + 1 < len(LADDER) else None,
                     "s": start, "n": i - start})
        start = i

# Exact rollups per (vein, class, bin), SHARE-WEIGHTED — the readout sums these,
# never the pixels. Computed by tools/extract_blocks.py because only it can see
# the per-vein Percent_<vein> shares; 10.9% of blocks straddle two or more
# domains, so rolling tonnage up from the CSV's single dominant `vein` column
# would overstate some veins by a third. Do not recompute these here.
_bj = json.loads(BUCKETS_JSON.read_text())
assert _bj.get("share_weighted"), "elk_buckets.json is not share-weighted — re-run extract_blocks.py"
assert _bj["ladder"] == LADDER, "bucket ladder differs from the viewer's LADDER"
BUCKETS = _bj["buckets"]
BY_CB = _bj["by_cb"]


# ---------------------------------------------------------------- drill holes
def load_drills():
    """Read collar/survey/assay CSVs and desurvey each hole into a polyline.

    Minimum-curvature would be the rigorous choice; these holes are near-straight
    so segment-wise interpolation between survey stations is within a metre and
    keeps the build dependency-free. Returns [] when no drill data is present.
    """
    man_p = DRILLDIR / "manifest.json"

    def find(kind):
        """Accept either SYNTHETIC_<kind>.csv or a plain <kind>.csv, so real
        collar/survey/assay exports drop in without being renamed to look
        synthetic. Synthetic-ness is decided by the manifest, not the filename."""
        for name in (f"SYNTHETIC_{kind}.csv", f"{kind}.csv"):
            q = DRILLDIR / name
            if q.exists():
                return q
        return None

    col_p, sur_p, ass_p = find("collars"), find("surveys"), find("assays")
    if not (col_p and sur_p and ass_p):
        return [], {}
    man = json.loads(man_p.read_text()) if man_p.exists() else {"synthetic": True}

    collars = {r["hole_id"]: r for r in csv.DictReader(open(col_p, newline=""))}
    surveys = defaultdict(list)
    for r in csv.DictReader(open(sur_p, newline="")):
        surveys[r["hole_id"]].append((float(r["depth_m"]), float(r["azimuth"]), float(r["dip"])))
    for v in surveys.values():
        v.sort()
    assays = defaultdict(list)
    for r in csv.DictReader(open(ass_p, newline="")):
        assays[r["hole_id"]].append((float(r["from_m"]), float(r["to_m"]), float(r["au_gpt"])))

    def station(hid, d):
        s = surveys.get(hid)
        if not s:
            c = collars[hid]
            return float(c["azimuth"]), float(c["dip"])
        if d <= s[0][0]:
            return s[0][1], s[0][2]
        for i in range(len(s) - 1):
            d0, a0, p0 = s[i]; d1, a1, p1 = s[i + 1]
            if d0 <= d <= d1:
                u = (d - d0) / (d1 - d0) if d1 > d0 else 0
                # shortest-arc azimuth interpolation, so 359 -> 001 doesn't spin
                da = ((a1 - a0 + 180) % 360) - 180
                return a0 + da * u, p0 + (p1 - p0) * u
        return s[-1][1], s[-1][2]

    def pos_at(hid, depth):
        """Step the trace from the collar, honouring survey drift."""
        c = collars[hid]
        x, y, z = float(c["easting"]), float(c["northing"]), float(c["elevation"])
        d = 0.0
        while d < depth:
            step = min(TRACE_STEP, depth - d)
            az, dip = station(hid, d + step / 2)
            ar, dr = math.radians(az), math.radians(dip)
            x += math.sin(ar) * math.cos(dr) * step
            y += math.cos(ar) * math.cos(dr) * step
            z += math.sin(dr) * step
            d += step
        return [round(x, 2), round(y, 2), round(z, 2)]

    holes = []
    for hid, c in sorted(collars.items()):
        td = float(c["total_depth_m"])
        segs = []
        for a, b, au in sorted(assays.get(hid, [])):
            if b > td:
                b = td
            if b <= a:
                continue
            segs.append({"a": pos_at(hid, a), "b": pos_at(hid, b), "g": au,
                         "f": round(a, 1), "t": round(b, 1)})
        holes.append({
            "id": hid,
            "collar": [float(c["easting"]), float(c["northing"]), float(c["elevation"])],
            "td": td,
            "end": pos_at(hid, td),
            "segs": segs,
        })
    return holes, man


HOLES, DRILL_MAN = load_drills()
DRILL_SYNTHETIC = bool(DRILL_MAN.get("synthetic", True)) if HOLES else False

CHAPTERS = [
  {"h": 28, "p": -26, "r": 3600, "cut": 0.1, "xray": True, "mode": "grade", "dwell": 9,
   "title": "A high-grade gold system", "body": "The Elk Gold project sits in the Quesnel Highland of British Columbia's Cariboo District — a road-accessible, established mining region."},
  {"h": 30, "p": -22, "r": 2500, "cut": 0.1, "xray": True, "mode": "grade", "dwell": 9,
   "title": "On real ground", "body": "Every block is placed at its true UTM position on real terrain — this is the actual mountain the deposit sits inside."},
  {"h": 44, "p": -34, "r": 1950, "cut": 0.1, "xray": True, "mode": "grade", "dwell": 10,
   "title": "The orebody", "body": "A multi-vein gold system, roughly 1,440 by 1,385 metres, coloured by gold-equivalent grade — cool blues low, hot reds high."},
  {"h": 66, "p": -30, "r": 1450, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 10,
   "title": "The high-grade core", "body": "Raising the cut-off to 1 g/t strips away the halo and reveals the bonanza vein shells that carry most of the metal."},
  {"h": 52, "p": -30, "r": 1700, "cut": 0.1, "xray": True, "mode": "class", "dwell": 11,
   "title": "How well is it known?", "body": "Recoloured by resource classification. Confidence is not evenly distributed through a deposit — and this is the first question any technical reader asks."},
  # Cut-off lifted to 1.0 here so the low-grade halo stops burying the traces.
  {"h": 38, "p": -24, "r": 1900, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 11, "drills": True,
   "title": "Drilled from surface", "body": "Drill traces coloured by assay grade, hung from their collars on the ridge above. These holes are synthetic — traced through the modelled grades to show how drilling reads against the block model."},
  {"h": 0, "p": -89, "r": 2500, "cut": 0.3, "xray": True, "mode": "grade", "dwell": 9,
   "title": "Footprint in plan", "body": "Seen from directly above: northwest-trending vein corridors threading across the ridge."},
  {"h": 4, "p": -4, "r": 2650, "cut": 0.3, "xray": True, "mode": "grade", "dwell": 10,
   "title": "In profile", "body": "Turned on edge, the veins persist to roughly 475 metres below surface — and remain open at depth."},
  {"h": 26, "p": -27, "r": 3000, "cut": 0.15, "xray": True, "mode": "grade", "dwell": 10,
   "title": "Explore it yourself", "body": "Forty-six vein domains, each one isolatable, each with its own grade and tonnage. Open Explore and interrogate the model directly."},
]

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elk Gold — Siwash North · Orebody Present</title>
<script>window.CESIUM_BASE_URL='https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/';</script>
<link href="https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Widgets/widgets.css" rel="stylesheet"
      integrity="sha384-ghEeMdcWWzRv/BPeUcX835vcKDGrxvROXisl/Btpv3GeekBUXTSPVcFJpI1Tcrgp" crossorigin="anonymous">
<style>__FONTS__</style>
<style>
  *{box-sizing:border-box;margin:0}
  html,body,#cesiumContainer{height:100%;width:100%;overflow:hidden;background:#07090A}
  body{font-family:Archivo,system-ui,sans-serif;color:#EDEEEC;-webkit-font-smoothing:antialiased}
  .cesium-widget-credits,.cesium-viewer-bottom{display:none!important}
  .cesium-viewer,.cesium-widget,.cesium-widget canvas{cursor:grab}

  #brand{position:fixed;top:26px;left:30px;z-index:6}
  #brand .w{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.34em;color:#C99A3A;text-transform:uppercase}
  #brand .n{font-size:17px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;margin-top:5px;line-height:1}

  #rail{position:fixed;left:30px;top:96px;z-index:6;display:flex;flex-direction:column;gap:2px}
  #rail .c{display:flex;align-items:baseline;gap:11px;padding:7px 0;cursor:pointer;opacity:.5;transition:opacity .3s}
  #rail .c:hover{opacity:.85}
  #rail .c.on{opacity:1}
  #rail .num{font-family:'JetBrains Mono',monospace;font-size:10px;color:#C99A3A;width:20px}
  #rail .t{font-size:12.5px;font-weight:500;letter-spacing:.01em;max-width:190px;line-height:1.25}
  #rail .c.on .t{color:#fff}

  #bar{position:fixed;left:0;right:0;bottom:0;z-index:6;padding:70px 34px 26px;
       background:linear-gradient(180deg,rgba(7,9,10,0) 0%,rgba(7,9,10,.72) 44%,rgba(7,9,10,.92) 100%);
       display:flex;align-items:flex-end;justify-content:space-between;gap:36px;transition:opacity .4s}
  /* Visible by default — the caption IS the story. The .in class animates a
     transform-only enter on top; it must never be what makes text appear. */
  #cap{max-width:560px;transform:translateY(14px);opacity:.999;transition:opacity .6s ease,transform .6s ease}
  #cap.in{opacity:1;transform:none}
  #cap .ey{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.22em;color:#C99A3A;text-transform:uppercase}
  #cap h2{font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1.05;margin:12px 0 12px}
  #cap p{font-family:Newsreader,Georgia,serif;font-size:18px;line-height:1.55;color:#C6CAC5;text-wrap:pretty}
  #nav{display:flex;align-items:center;gap:10px;flex:0 0 auto;padding-bottom:4px}
  .btn{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#EDEEEC;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);border-radius:3px;padding:12px 18px;cursor:pointer;transition:.2s}
  .btn:hover{border-color:#C99A3A;color:#C99A3A}
  .btn:disabled{opacity:.3;cursor:default}
  .btn.on{background:#C99A3A;border-color:#C99A3A;color:#07090A}
  .btn.sm{padding:9px 12px;font-size:10px}
  #nav .count{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.14em;color:#8E948E;min-width:52px;text-align:center}

  #legend{position:fixed;right:34px;top:28px;z-index:6;display:flex;align-items:center;gap:9px;opacity:.85}
  #ramp{height:8px;width:150px;border-radius:2px;background:linear-gradient(90deg,#14324f,#1c7fb8,#21b0a0,#8fd14f,#f2c14e,#e8532b)}
  #legend span{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.06em;color:#8E948E}
  #clsleg{display:none;gap:14px;align-items:center}
  #clsleg .k{display:flex;align-items:center;gap:6px}
  .sw{width:10px;height:10px;border-radius:2px}

  #tools{position:fixed;right:34px;top:64px;z-index:7;display:flex;gap:8px}
  #panel{position:fixed;right:34px;top:108px;width:296px;z-index:7;background:rgba(12,15,16,.93);
         border:1px solid rgba(255,255,255,.13);border-radius:5px;padding:18px 18px 16px;display:none;
         backdrop-filter:blur(9px);max-height:calc(100vh - 150px);overflow-y:auto}
  #panel.on{display:block}
  #panel h3{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;color:#8E948E;margin:0 0 9px}
  #panel h3:not(:first-child){margin-top:19px}
  .seg{display:flex;border:1px solid rgba(255,255,255,.16);border-radius:3px;overflow:hidden}
  .seg button{flex:1;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;
              padding:8px 0;background:transparent;border:none;color:#8E948E;cursor:pointer;transition:.15s}
  .seg button.on{background:#C99A3A;color:#07090A}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{display:flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:10px;
        padding:6px 9px;border:1px solid rgba(255,255,255,.16);border-radius:3px;cursor:pointer;color:#8E948E;transition:.15s}
  .chip.on{color:#EDEEEC;border-color:rgba(255,255,255,.4)}
  .chip .sw{width:8px;height:8px;opacity:.35}
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
  #veincav{margin-top:10px;font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.55;color:#E3BE79}
  #caveat{margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.55;color:#A8AEA9}
  .xrow{display:flex;gap:6px;margin-top:8px}
  .xrow .btn{flex:1;text-align:center}

  #synwarn{position:fixed;left:50%;transform:translateX(-50%);bottom:118px;z-index:9;display:none;
           font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;
           color:#0d0f10;background:#D9584A;padding:7px 15px;border-radius:3px;font-weight:600}
  #synwarn.on{display:block}

  #compass{position:fixed;right:40px;bottom:118px;z-index:6;width:52px;height:52px;opacity:.75}
  #scalebar{position:fixed;right:34px;bottom:86px;z-index:6;text-align:right;opacity:.75}
  #scalebar .l{height:3px;background:#EDEEEC;margin-left:auto;border-left:1px solid #EDEEEC;border-right:1px solid #EDEEEC}
  #scalebar .t{font-family:'JetBrains Mono',monospace;font-size:9.5px;color:#C6CAC5;margin-top:4px;letter-spacing:.08em}

  #prog{position:fixed;left:0;top:0;height:2px;background:#C99A3A;width:0;z-index:8;transition:width .6s ease}
  #dwell{position:fixed;left:0;top:0;height:2px;background:rgba(201,154,58,.35);width:0;z-index:7}

  #intro{position:fixed;inset:0;z-index:12;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
         background:radial-gradient(ellipse at center,rgba(7,9,10,.45),rgba(7,9,10,.86));transition:opacity .8s ease}
  #intro .eyebrow{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.3em;text-transform:uppercase;color:#C99A3A;margin-bottom:22px}
  #intro h1{font-size:clamp(42px,7vw,96px);font-weight:800;letter-spacing:-.035em;line-height:.94;text-transform:uppercase}
  #intro .sub{font-family:Newsreader,Georgia,serif;font-size:clamp(17px,1.6vw,22px);color:#C6CAC5;margin-top:22px;max-width:600px;line-height:1.5}
  #begin{margin-top:40px;font-family:'JetBrains Mono',monospace;font-size:12.5px;letter-spacing:.18em;text-transform:uppercase;color:#07090A;background:#C99A3A;border:none;border-radius:3px;padding:16px 32px;cursor:pointer;transition:filter .2s}
  #begin:hover{filter:brightness(1.12)}
  #load{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:#07090A;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.2em;color:#8E948E}
  #status{position:fixed;right:14px;bottom:12px;z-index:4;font-family:'JetBrains Mono',monospace;font-size:10px;color:#8E948E}
  #status.fatal{color:#0d0f10;background:#D9584A;padding:7px 13px;border-radius:3px;font-size:11px;z-index:30;font-weight:600}
  #toast{position:fixed;left:50%;top:26px;transform:translateX(-50%);z-index:14;background:rgba(12,15,16,.95);
         border:1px solid rgba(255,255,255,.18);border-radius:3px;padding:11px 18px;display:none;
         font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.1em;color:#EDEEEC}
  #toast.on{display:block}

  /* embed mode: strip the chrome, keep the story */
  body.embed #brand,body.embed #rail,body.embed #tools,body.embed #panel{display:none!important}
  body.embed #bar{padding:48px 22px 18px}
  body.embed #cap h2{font-size:22px}
  body.embed #cap p{font-size:15px}
  body.embed #intro h1{font-size:clamp(30px,6vw,54px)}
  /* A 2.3s camera flight per chapter, fired every 9-11s on autoplay, is the
     canonical vestibular trigger. Honour the OS setting: cut the flight to a
     snap, stop autoplay starting itself, and flatten the CSS transitions. */
  @media(prefers-reduced-motion:reduce){
    #cap,#intro,#prog,#dwell,#bar,.btn,.seg button,.chip{transition:none!important}
    #dwell{display:none}
  }
  @media(max-width:900px){#rail{display:none}#panel{width:auto;left:16px;right:16px}#cap h2{font-size:23px}#cap p{font-size:16px}}
</style>
</head>
<body>
<div id="cesiumContainer"></div>
<div id="load">PREPARING PRESENTATION…</div>
<div id="prog"></div><div id="dwell"></div>
<div id="toast"></div>

<div id="brand"><div class="w">Orebody Present</div><div class="n">Elk Gold<br>Siwash North</div></div>
<div id="rail"></div>
<div id="legend">
  <div id="gradeleg" style="display:flex;align-items:center;gap:9px"><span>AuEq</span><div id="ramp"></div><span id="rmax"></span></div>
  <div id="clsleg"></div>
</div>

<div id="tools">
  <button id="sharebtn" class="btn sm" title="Copy a link to this exact view">Link</button>
  <button id="xbtn" class="btn">Explore ▸</button>
</div>

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

  <h3>Drill holes</h3>
  <div class="seg" id="drillseg">
    <button data-d="0" class="on">Hidden</button>
    <button data-d="1">Shown</button>
  </div>

  <div id="readout">
    <div class="row"><span class="l">Tonnes</span><span class="v" id="r_t">—</span></div>
    <div class="row"><span class="l">Grade AuEq</span><span class="v" id="r_g">—</span></div>
    <div class="row"><span class="l">Contained</span><span class="v hero" id="r_oz">—</span></div>
    <div class="row"><span class="l" id="r_nl">Blocks</span><span class="v" id="r_n">—</span></div>
  </div>

  <h3>Export</h3>
  <div class="xrow">
    <button class="btn sm" id="expPng">PNG</button>
    <button class="btn sm" id="expPptx">PPTX</button>
    <button class="btn sm" id="expPdf">PDF</button>
  </div>
  <div id="veincav"></div>
  <div id="caveat"></div>
</div>

<div id="synwarn">Synthetic drill data — fabricated, not real results</div>

<svg id="compass" viewBox="0 0 100 100"><g id="cneedle">
  <circle cx="50" cy="50" r="34" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"/>
  <polygon points="50,14 58,50 50,44 42,50" fill="#C99A3A"/>
  <polygon points="50,86 42,50 50,56 58,50" fill="rgba(255,255,255,.5)"/>
  <text x="50" y="10" text-anchor="middle" fill="#EDEEEC" font-size="13" font-family="monospace">N</text>
</g></svg>
<div id="scalebar"><div class="l" id="sbline" style="width:120px"></div><div class="t" id="sbtext">—</div></div>

<div id="bar">
  <div id="cap"><div class="ey" id="cap_ey">01 / 09</div><h2 id="cap_t"></h2><p id="cap_b"></p></div>
  <div id="nav">
    <button id="prev" class="btn">‹ Back</button>
    <span class="count" id="count">1 / 9</span>
    <button id="next" class="btn">Next ›</button>
    <button id="play" class="btn" title="Autoplay (P)">▶ Play</button>
    <button id="narr" class="btn sm" title="Narration (N)">Narrate</button>
  </div>
</div>

<div id="intro">
  <div class="eyebrow">Orebody Present · Interactive 3D Story</div>
  <h1>Elk Gold<br>Siwash North</h1>
  <div class="sub">A high-grade gold system in British Columbia's Cariboo District — presented in three dimensions, on real terrain.</div>
  <button id="begin">Begin the walkthrough ▸</button>
</div>
<div id="status">booting…</div>

<script src="https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Cesium.js"
        integrity="sha384-u6lI9nKeZ0sgcSQty6qC4XQHU/ZG7JJ8PfRvtUQTH83OstsiEivIu3F9k012EB3W"
        crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/proj4@2.11.0/dist/proj4.js"
        integrity="sha384-BIsA8GBrihzaRmijjpqTCihj8D5Vox3hyBFg9sJiTGAEOv6KusZ8QOCKbTFEAfhm"
        crossorigin="anonymous"></script>
<script>
const DATA="__B64__", META="__META__", N=__N__, RAMPMAX=__RAMPMAX__,
      EMIN=__EMIN__, NMIN=__NMIN__, CE=__CE__, CN=__CN__, CZ=__CZ__, EX=__EX__, EY=__EY__;
const CHAPTERS=__CHAPTERS__, RUNS=__RUNS__, BUCKETS=__BUCKETS__, VEINS=__VEINS__,
      LADDER=__LADDER__, CLASS_LABELS=__CLASS_LABELS__, CLASS_CONFIRMED=__CLASS_CONFIRMED__,
      BY_CB=__BY_CB__, HOLES=__HOLES__, DRILL_SYNTHETIC=__DRILL_SYNTHETIC__, G_PER_OZ=31.10348;
proj4.defs('EPSG:26910','+proj=utm +zone=10 +datum=NAD83 +units=m +no_defs');
const GEOID=-18, rad=Cesium.Math.toRadians, $=id=>document.getElementById(id);
const setStat=t=>$('status').textContent=t;
const EMBED=new URLSearchParams(location.search).has('embed');
const REDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;
if(EMBED) document.body.classList.add('embed');

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
const fmt=n=>n>=1e6?(n/1e6).toFixed(2)+' Mt':Math.round(n).toLocaleString()+' t';
const fmtoz=n=>n>=1e6?(n/1e6).toFixed(3)+' Moz':Math.round(n).toLocaleString()+' oz';
function toast(msg,ms){$('toast').textContent=msg;$('toast').classList.add('on');
  clearTimeout(toast._t);toast._t=setTimeout(()=>$('toast').classList.remove('on'),ms||2600);}

(async()=>{
  let imagery, terrain;
  try{ imagery=await Cesium.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer'); }
  catch(e){ imagery=new Cesium.UrlTemplateImageryProvider({url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',maximumLevel:19,credit:'© OpenStreetMap'}); }
  try{ terrain=await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl('https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'); }
  catch(e){ terrain=new Cesium.EllipsoidTerrainProvider(); }
  const viewer=new Cesium.Viewer('cesiumContainer',{baseLayer:new Cesium.ImageryLayer(imagery),terrainProvider:terrain,
    baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,
    animation:false,timeline:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,requestRenderMode:false,
    contextOptions:{webgl:{preserveDrawingBuffer:true}}});   // needed for PNG/PPTX/PDF capture
  viewer.scene.screenSpaceCameraController.enableCollisionDetection=false;
  viewer.scene.skyAtmosphere.show=true;
  viewer.scene.globe.tileLoadProgressEvent.addEventListener(q=>setStat('terrain tiles: '+q));
  viewer.scene.canvas.addEventListener('webglcontextlost',ev=>{ev.preventDefault();setStat('context lost — reloading');setTimeout(()=>location.reload(),1200);},false);

  const cll=proj4('EPSG:26910','WGS84',[CE,CN]);
  const center=Cesium.Cartesian3.fromDegrees(cll[0],cll[1],CZ+GEOID);
  const RADIUS=Math.max(EX,EY)*0.62;
  const toCart=(E,Nn,h)=>Cesium.Cartesian3.fromDegrees(...proj4('EPSG:26910','WGS84',[E,Nn]),h+GEOID);

  // Blocks are 10 x 5 x 5 m on the source grid.
  const box=Cesium.BoxGeometry.fromDimensions({vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                                               dimensions:new Cesium.Cartesian3(10,5,5)});
  const posFor=i=>toCart(F[i*4]+EMIN,F[i*4+1]+NMIN,F[i*4+2]);

  // One uniform-colour primitive per bucket: recolouring is a single material
  // uniform rather than 168k per-instance attribute writes.
  function makePrim(indices,color){
    const inst=indices.map(i=>new Cesium.GeometryInstance({geometry:box,
      modelMatrix:Cesium.Transforms.eastNorthUpToFixedFrame(posFor(i))}));
    return new Cesium.Primitive({geometryInstances:inst,asynchronous:true,
      appearance:new Cesium.MaterialAppearance({flat:false,translucent:false,
        material:Cesium.Material.fromType('Color',{color})})});
  }
  setStat('building blocks…');
  RUNS.forEach(r=>{
    const idx=[]; for(let i=r.s;i<r.s+r.n;i++) idx.push(i);
    r.mid=r.hi===null?r.lo*1.4:(r.lo+r.hi)/2;
    r.prim=makePrim(idx,ramp(r.mid));
    viewer.scene.primitives.add(r.prim);
  });

  // Per-vein sets are built lazily and cached — isolation is a deliberate click.
  const veinPrims={};
  function buildVein(v){
    if(veinPrims[v]) return veinPrims[v];
    const byKey={};
    for(const r of RUNS) for(let i=r.s;i<r.s+r.n;i++){
      if(M[i*2+1]!==v) continue;
      const k=r.c+'|'+r.b;
      (byKey[k]=byKey[k]||{c:r.c,b:r.b,lo:r.lo,mid:r.mid,idx:[]}).idx.push(i);
    }
    const set=Object.values(byKey).map(g=>{
      const p=makePrim(g.idx,ramp(g.mid)); p.show=false;
      viewer.scene.primitives.add(p); return Object.assign({},g,{prim:p});
    });
    veinPrims[v]=set; return set;
  }

  // ---- drill traces ----
  // Entity polylines rather than a PolylineCollection: entities support
  // depthFailMaterial, so a hole stays legible as a ghost where it passes
  // behind blocks. Without it the traces vanish inside the ore halo, which is
  // exactly where they matter most.
  let drillEnts=null;
  function buildDrills(){
    if(drillEnts||!HOLES.length) return drillEnts;
    drillEnts=[];
    const ghost=c=>new Cesium.ColorMaterialProperty(c.withAlpha(0.30));
    HOLES.forEach(h=>{
      const white=new Cesium.Color(1,1,1,.55);
      drillEnts.push(viewer.entities.add({polyline:{
        positions:[toCart(h.collar[0],h.collar[1],h.collar[2]),toCart(h.end[0],h.end[1],h.end[2])],
        width:1.6,material:white,depthFailMaterial:ghost(white)}}));
      h.segs.forEach(s=>{ if(s.g<0.1) return;
        const col=ramp(s.g);
        drillEnts.push(viewer.entities.add({polyline:{
          positions:[toCart(s.a[0],s.a[1],s.a[2]),toCart(s.b[0],s.b[1],s.b[2])],
          width:7,material:col,depthFailMaterial:ghost(col)}}));
      });
      // collar marker on the ridge
      drillEnts.push(viewer.entities.add({position:toCart(h.collar[0],h.collar[1],h.collar[2]),
        point:{pixelSize:5,color:Cesium.Color.WHITE.withAlpha(.85),
               disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    });
    return drillEnts;
  }
  const showDrills=on=>{ if(drillEnts) drillEnts.forEach(e=>e.show=on); };

  // ---- state ----
  let mode='grade', cutIdx=1, vein=-1, clsOn={0:true,1:true,2:true,3:true},
      cur=0, drills=false, playing=false, narrating=false, dwellTimer=null, restoring=false;
  const cutVal=()=>LADDER[cutIdx];
  const colorOf=g=>mode==='grade'?ramp(g.mid):clsColor(g.c);

  function apply(){
    const cut=cutVal();
    const vis=g=>g.lo>=cut-1e-9 && clsOn[g.c];
    RUNS.forEach(r=>{ r.prim.show = vein===-1 && vis(r);
      r.prim.appearance.material.uniforms.color=colorOf(r); });
    if(vein!==-1) buildVein(vein).forEach(g=>{ g.prim.show=vis(g);
      g.prim.appearance.material.uniforms.color=colorOf(g); });
    // Drop non-active vein sets rather than parking them hidden — cycling all
    // 46 would otherwise leave a second full copy of the model resident.
    Object.keys(veinPrims).forEach(v=>{ if(+v!==vein){
      veinPrims[v].forEach(g=>viewer.scene.primitives.remove(g.prim));
      delete veinPrims[v]; } });
    if(drills) buildDrills();
    showDrills(drills);
    $('synwarn').classList.toggle('on',drills&&DRILL_SYNTHETIC);
    readout(); syncHash();
  }

  // Numbers come from the exact per-bucket rollups, never from what is drawn.
  function readout(){
    const cut=cutVal(); let n=0,t=0,m=0;
    // All veins: use the vein-free table so "Blocks" is a distinct count.
    // Summing the share-weighted table instead would tally a block once per
    // domain it straddles — correct for tonnage, wrong for a block count.
    const src=vein===-1?BY_CB:BUCKETS;
    for(const b of src){
      if(LADDER[b.b]<cut-1e-9) continue;
      if(!clsOn[b.c]) continue;
      if(vein!==-1 && b.v!==vein) continue;
      n+=b.n; t+=b.t; m+=b.m;
    }
    $('r_t').textContent=t?fmt(t):'—';
    $('r_g').textContent=t?(m/t).toFixed(2)+' g/t':'—';
    $('r_oz').textContent=t?fmtoz(m/G_PER_OZ):'—';
    $('r_n').textContent=n.toLocaleString();
    // A block can belong to more than one domain, so under isolation this is
    // "blocks touching this vein", not an exclusive count. Say so.
    $('r_nl').textContent=vein===-1?'Blocks':'Blocks in domain';
    // The shell on screen is filtered on each block's DOMINANT domain, but the
    // tonnage above is share-weighted across every domain a block touches. For
    // veins with many straddlers the two differ by up to ~36%, so say so rather
    // than let a geologist assume the boxes are the number.
    $('veincav').textContent = vein===-1 ? '' :
      'Shell shows blocks whose dominant domain is '+VEINS[vein]+
      '; tonnage above is share-weighted across all blocks touching it, so it counts more than is drawn.';
    return {t:t,g:t?m/t:0,oz:m/G_PER_OZ,n:n};
  }

  // ---- deep links ----
  let hashTimer=null;
  function syncHash(){
    if(restoring) return;
    // '-' rather than '' for "no classes selected": an empty value round-trips
    // through the ||'0123' default and would silently re-enable all four.
    const on=Object.keys(clsOn).filter(c=>clsOn[c]).join('')||'-';
    const h='#c='+cur+'&m='+mode+'&k='+cutIdx+'&v='+vein+'&s='+on+'&d='+(drills?1:0);
    // Dragging the cut-off fires apply() per tick; replaceState instead of
    // location.replace keeps that off the navigation path entirely.
    clearTimeout(hashTimer);
    hashTimer=setTimeout(()=>history.replaceState(null,'',h),200);
  }
  function readHash(){
    const h=new URLSearchParams(location.hash.slice(1));
    if(!h.has('c')) return null;
    return {c:+h.get('c')||0, m:h.get('m')==='class'?'class':'grade', k:Math.max(0,Math.min(LADDER.length-1,+h.get('k')||0)),
            v:+h.get('v'), s:h.has('s')?h.get('s'):'0123', d:h.get('d')==='1'};
  }

  // ---- explore UI ----
  function setMode(m){
    mode=m;
    $('modeseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.m===m));
    $('gradeleg').style.display=m==='grade'?'flex':'none';
    $('clsleg').style.display=m==='class'?'flex':'none';
  }
  function setCut(i){cutIdx=i;$('cut').value=i;$('cutv').textContent=cutVal().toFixed(2)+' g/t';}
  function setDrills(on){
    drills=on;
    $('drillseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',(x.dataset.d==='1')===on));
  }
  setCut(cutIdx);
  $('cut').oninput=e=>{setCut(+e.target.value);apply();};
  $('modeseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{setMode(b.dataset.m);apply();});
  $('drillseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{setDrills(b.dataset.d==='1');apply();});
  const chips=$('clschips');
  Object.keys(CLASS_LABELS).map(Number).sort().forEach(c=>{
    const d=document.createElement('div'); d.className='chip on'; d.dataset.c=c;
    d.innerHTML='<span class="sw" style="background:'+CLS_COLOR[c]+'"></span>'+CLASS_LABELS[c];
    d.onclick=()=>{clsOn[c]=!clsOn[c];d.classList.toggle('on',clsOn[c]);apply();};
    chips.appendChild(d);
    const k=document.createElement('div'); k.className='k';
    k.innerHTML='<span class="sw" style="background:'+CLS_COLOR[c]+'"></span><span>'+CLASS_LABELS[c]+'</span>';
    $('clsleg').appendChild(k);
  });
  const vsel=$('vsel');
  const veinOz={}; BUCKETS.forEach(b=>veinOz[b.v]=(veinOz[b.v]||0)+b.m/G_PER_OZ);
  // Vein names come from source CSV column headers, so build options through
  // the DOM rather than innerHTML — a header is untrusted input here.
  const mkOpt=(val,label)=>{const o=document.createElement('option');o.value=String(val);o.textContent=label;return o;};
  vsel.appendChild(mkOpt(-1,'All veins ('+VEINS.length+')'));
  VEINS.map((nm,i)=>({nm:nm,i:i,oz:veinOz[i]||0})).sort((a,b)=>b.oz-a.oz)
    .forEach(v=>vsel.appendChild(mkOpt(v.i,v.nm+' — '+Math.round(v.oz).toLocaleString()+' oz')));
  vsel.onchange=e=>{vein=+e.target.value;setStat(vein===-1?'all veins':'isolating '+VEINS[vein]);apply();};
  $('caveat').textContent=(CLASS_CONFIRMED?'':
    'Class labels follow the usual MineSight convention but are unconfirmed against the Nov-2021 technical report. ')+
    'Illustrative visualization — not a mineral resource statement.';
  $('xbtn').onclick=()=>{const on=$('panel').classList.toggle('on');
    $('xbtn').classList.toggle('on',on); $('xbtn').textContent=on?'Explore ◂':'Explore ▸';
    $('bar').style.opacity=on?'0':'1'; $('bar').style.pointerEvents=on?'none':'auto';};
  $('sharebtn').onclick=()=>{syncHash();
    navigator.clipboard.writeText(location.href).then(()=>toast('Link copied'),()=>toast('Copy failed'));};

  // ---- chapters ----
  const rail=$('rail');
  CHAPTERS.forEach((c,i)=>{const d=document.createElement('div');d.className='c';
    d.innerHTML='<span class="num">'+String(i+1).padStart(2,'0')+'</span><span class="t">'+c.title+'</span>';
    d.onclick=()=>{stop();go(i);};rail.appendChild(d);});
  const railItems=[].slice.call(rail.children);

  function frameFor(c,animate){
    const hpr=new Cesium.HeadingPitchRange(rad(c.h),rad(c.p),c.r);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if(animate&&!REDUCED) viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center,RADIUS),
      {offset:hpr,duration:2.3,complete:()=>viewer.camera.lookAt(center,hpr)});
    else viewer.camera.lookAt(center,hpr);
  }
  function paintUI(){
    const c=CHAPTERS[cur];
    $('cap').classList.remove('in');
    setTimeout(function(){
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
    // A cut-off above the ladder must clamp to the most restrictive bin, not
    // fall through to index 0 and reveal the entire model.
    const ci=LADDER.findIndex(v=>v>=c.cut); setCut(ci<0?LADDER.length-1:ci);
    setMode(c.mode||'grade');
    setDrills(!!c.drills);
    vein=-1; vsel.value='-1';
    Object.keys(clsOn).forEach(k=>{clsOn[k]=true;});
    chips.querySelectorAll('.chip').forEach(el=>el.classList.add('on'));
    viewer.scene.globe.depthTestAgainstTerrain=!c.xray;
    apply(); frameFor(c,!initial); paintUI();
    if(narrating) speak(c);
    if(playing) armDwell(c);
  }

  // ---- narration + autoplay ----
  const synth=window.speechSynthesis;
  let narrGuard=null;
  function speak(c){
    if(!synth){ armDwell(c); return; }
    synth.cancel(); clearTimeout(narrGuard);
    const u=new SpeechSynthesisUtterance(c.title+'. '+c.body);
    u.rate=0.96; u.pitch=1.0;
    let done=false;
    const finish=()=>{ if(done) return; done=true; clearTimeout(narrGuard);
                       if(playing&&narrating) advance(); };
    u.onend=finish;
    // Chrome silently kills utterances around 15s and some devices have no
    // voices at all, in which case onend never fires and the deck stalls with
    // the button still reading Pause. Watchdog so playback always progresses.
    u.onerror=finish;
    narrGuard=setTimeout(finish,((c.dwell||9)*1000)*2.5);
    synth.speak(u);
  }
  function advance(){ if(cur<CHAPTERS.length-1) go(cur+1); else stop(); }
  function armDwell(c){
    clearTimeout(dwellTimer);
    // With narration on, the utterance's end drives the advance instead —
    // otherwise a long caption gets cut off by a short dwell.
    if(narrating) return;
    const ms=(c.dwell||9)*1000;
    const d=$('dwell'); d.style.transition='none'; d.style.width='0';
    requestAnimationFrame(()=>{d.style.transition='width '+ms+'ms linear';d.style.width='100%';});
    dwellTimer=setTimeout(advance,ms);
  }
  function play(){
    playing=true; $('play').classList.add('on'); $('play').textContent='❚❚ Pause';
    const c=CHAPTERS[cur];
    if(narrating) speak(c); else armDwell(c);
  }
  function stop(){
    playing=false; $('play').classList.remove('on'); $('play').textContent='▶ Play';
    clearTimeout(dwellTimer); clearTimeout(narrGuard); if(synth) synth.cancel();
    const d=$('dwell'); d.style.transition='none'; d.style.width='0';
  }
  $('play').onclick=()=>playing?stop():play();
  $('narr').onclick=()=>{
    narrating=!narrating; $('narr').classList.toggle('on',narrating);
    if(!narrating&&synth) synth.cancel();
    if(playing){ stop(); play(); }
    toast(narrating?'Narration on':'Narration off',1600);
  };
  $('next').onclick=()=>{stop();go(cur+1);};
  $('prev').onclick=()=>{stop();go(cur-1);};
  addEventListener('keydown',e=>{
    // Space on a focused <select> or the slider must not also advance the deck.
    const el=document.activeElement, tag=el&&el.tagName;
    if(tag==='SELECT'||tag==='INPUT'||tag==='TEXTAREA') return;
    if(e.key==='ArrowRight'||e.key===' '){stop();go(cur+1);}
    else if(e.key==='ArrowLeft'){stop();go(cur-1);}
    // In embed mode the panel is display:none, so toggling it would only hide
    // the caption and nav with no visible way back.
    else if((e.key==='e'||e.key==='E')&&!EMBED) $('xbtn').click();
    else if(e.key==='p'||e.key==='P') $('play').click();
    else if(e.key==='n'||e.key==='N') $('narr').click();
  });

  // ---- scale bar + compass ----
  function hud(){
    const cam=viewer.camera, sc=viewer.scene;
    const h=Cesium.Cartesian3.distance(cam.positionWC,center);
    // metres per pixel at the target distance, via the frustum's vertical FOV
    const fov=sc.camera.frustum.fovy||rad(60);
    const mpp=2*h*Math.tan(fov/2)/sc.canvas.clientHeight;
    let target=mpp*140, pow=Math.pow(10,Math.floor(Math.log10(target)));
    const nice=[1,2,5,10].map(k=>k*pow).filter(v=>v>=target*0.45);
    const len=nice.length?nice[0]:pow;
    const px=Math.max(28,Math.min(220,len/mpp));
    $('sbline').style.width=px+'px';
    $('sbtext').textContent=len>=1000?(len/1000)+' km':len+' m';
    $('cneedle').setAttribute('transform','rotate('+(-Cesium.Math.toDegrees(cam.heading))+' 50 50)');
  }
  viewer.scene.postRender.addEventListener(hud);

  // ---- export ----
  // toDataURL captures the WebGL canvas ONLY — every DOM overlay, including the
  // synthetic-drill warning, is absent from it. An exported still of the drill
  // chapter would otherwise show fabricated holes with nothing marking them as
  // fabricated, which is the worst way this tool could be misused. So the
  // disclaimer is burned into the bitmap rather than left to the page chrome.
  function stamp(dataUrl){
    return new Promise((res,rej)=>{
      const img=new Image();
      img.onload=()=>{
        const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
        const x=c.getContext('2d'); x.drawImage(img,0,0);
        const S=c.width/1440, pad=Math.round(22*S);
        const disc=(CLASS_CONFIRMED?'':'Resource class labels unconfirmed. ')+
                   'Illustrative visualization — not a mineral resource statement.';
        x.font=Math.round(13*S)+'px ui-monospace, monospace';
        x.textBaseline='bottom';
        const w=x.measureText(disc).width, h=Math.round(24*S);
        x.fillStyle='rgba(7,9,10,.82)';
        x.fillRect(pad-Math.round(9*S), c.height-pad-h, w+Math.round(18*S), h);
        x.fillStyle='#C6CAC5';
        x.fillText(disc, pad, c.height-pad-Math.round(6*S));
        if(drills&&DRILL_SYNTHETIC){
          const warn='SYNTHETIC DRILL DATA — FABRICATED, NOT REAL RESULTS';
          x.font='600 '+Math.round(15*S)+'px ui-monospace, monospace';
          const ww=x.measureText(warn).width, wh=Math.round(30*S);
          const wy=c.height-pad-h-Math.round(10*S)-wh;
          x.fillStyle='#D9584A';
          x.fillRect(pad-Math.round(9*S), wy, ww+Math.round(18*S), wh);
          x.fillStyle='#0d0f10';
          x.fillText(warn, pad, wy+wh-Math.round(8*S));
        }
        res(c.toDataURL('image/png'));
      };
      // Fail CLOSED. Resolving the unstamped original here would emit a
      // bitmap of fabricated drill holes carrying no label at all, while
      // still reporting success — the exact misuse this guard exists to stop.
      img.onerror=()=>rej(new Error('could not stamp the export — aborted'));
      img.src=dataUrl;
    });
  }
  function grab(){ viewer.render(); return stamp(viewer.scene.canvas.toDataURL('image/png')); }
  function dl(name,href){const a=document.createElement('a');a.download=name;a.href=href;a.click();}
  // Pinned by hash like the head deps: a poisoned CDN response here would run
  // in-origin at the moment a deck is generated, and could strip the synthetic
  // disclaimer off every slide. Cached so repeat clicks don't re-evaluate.
  const LIBS={
    pptx:{src:'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
          sri:'sha384-Cck14aA9cifjYolcnjebXRfWGkz5ltHMBiG4px/j8GS+xQcb7OhNQWZYyWjQ+UwQ'},
    pdf:{src:'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
         sri:'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk'}};
  const _libs={};
  function loadJs(key){
    const L=LIBS[key];
    if(_libs[key]) return _libs[key];
    return _libs[key]=new Promise((res,rej)=>{
      const s=document.createElement('script');
      s.src=L.src; s.integrity=L.sri; s.crossOrigin='anonymous';
      s.onload=res;
      s.onerror=()=>{ delete _libs[key]; rej(new Error('could not load '+key+' (integrity check or network)')); };
      document.head.appendChild(s);});
  }
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  $('expPng').onclick=async()=>{
    try{ dl('elk-gold-'+(cur+1)+'.png',await grab()); toast('PNG saved'); }
    catch(e){ toast('Export aborted: '+e.message,5000); }
  };

  let exporting=false;
  async function shoot(){
    if(exporting) throw new Error('an export is already running');
    // Walk every chapter, let the camera settle and tiles land, capture.
    // Exporting is a side trip: put the viewer back where the user left it.
    const wasPanel=$('panel').classList.contains('on'), wasChapter=cur;
    // Exporting walks every chapter, which resets mode/cut/vein/classes. Snapshot
    // the user's exploration so a deck export isn't a destructive act.
    const snap={mode:mode,cutIdx:cutIdx,vein:vein,clsOn:Object.assign({},clsOn)};
    exporting=true; ['expPng','expPptx','expPdf'].forEach(id=>$(id).disabled=true);
    if(wasPanel) $('xbtn').click();
    stop();
    const shots=[];
    try{
      for(let i=0;i<CHAPTERS.length;i++){
        go(i); await sleep(3200);
        const s=readout();
        shots.push({title:CHAPTERS[i].title,body:CHAPTERS[i].body,img:await grab(),stats:s});
        toast('Capturing '+(i+1)+' / '+CHAPTERS.length,1500);
      }
    } finally {
      go(wasChapter);
      setMode(snap.mode); setCut(snap.cutIdx);
      vein=snap.vein; vsel.value=String(vein);
      Object.keys(snap.clsOn).forEach(k=>{clsOn[k]=snap.clsOn[k];});
      chips.querySelectorAll('.chip').forEach(el=>el.classList.toggle('on',clsOn[el.dataset.c]));
      apply();
      if(wasPanel) $('xbtn').click();
      exporting=false; ['expPng','expPptx','expPdf'].forEach(id=>$(id).disabled=false);
    }
    return shots;
  }
  const FOOT=(CLASS_CONFIRMED?'':'Resource class labels unconfirmed. ')+
    'Illustrative visualization — not a mineral resource statement.'+
    (HOLES.length&&DRILL_SYNTHETIC?' Drill holes shown are SYNTHETIC and fabricated.':'');

  $('expPptx').onclick=async()=>{
    try{
      toast('Building deck…',60000);
      await loadJs('pptx');
      const shots=await shoot();
      const p=new PptxGenJS(); p.layout='LAYOUT_16x9';
      shots.forEach(s=>{
        const sl=p.addSlide();
        sl.background={color:'07090A'};
        sl.addImage({data:s.img,x:0,y:0,w:'100%',h:'100%'});
        sl.addShape(p.ShapeType.rect,{x:0,y:3.4,w:'100%',h:2.2,fill:{color:'07090A',transparency:22}});
        sl.addText(s.title,{x:0.5,y:3.6,w:8.5,h:0.6,fontSize:26,bold:true,color:'FFFFFF',fontFace:'Arial'});
        sl.addText(s.body,{x:0.5,y:4.25,w:8.5,h:0.9,fontSize:13,color:'C6CAC5',fontFace:'Arial'});
        sl.addText(fmt(s.stats.t)+'   ·   '+s.stats.g.toFixed(2)+' g/t AuEq   ·   '+fmtoz(s.stats.oz),
          {x:0.5,y:5.05,w:8.5,h:0.35,fontSize:12,color:'C99A3A',fontFace:'Consolas'});
        sl.addText(FOOT,{x:0.5,y:5.32,w:8.5,h:0.34,fontSize:10,color:'C6CAC5',fontFace:'Arial'});
      });
      await p.writeFile({fileName:'Elk-Gold-Siwash-North.pptx'});
      toast('PPTX saved');
    }catch(e){ toast('PPTX failed: '+e.message,5000); }
  };

  $('expPdf').onclick=async()=>{
    try{
      toast('Building PDF…',60000);
      await loadJs('pdf');
      const shots=await shoot();
      const {jsPDF}=window.jspdf;
      const doc=new jsPDF({orientation:'landscape',unit:'pt',format:[960,540]});
      shots.forEach((s,i)=>{
        if(i) doc.addPage([960,540],'landscape');
        doc.setFillColor(7,9,10); doc.rect(0,0,960,540,'F');
        doc.addImage(s.img,'PNG',0,0,960,540);
        doc.setFillColor(7,9,10); doc.rect(0,360,960,180,'F');
        doc.setTextColor(255,255,255); doc.setFontSize(22); doc.text(s.title,40,404);
        doc.setTextColor(198,202,197); doc.setFontSize(11);
        doc.text(doc.splitTextToSize(s.body,880),40,428);
        doc.setTextColor(201,154,58); doc.setFontSize(11);
        doc.text(fmt(s.stats.t)+'   ·   '+s.stats.g.toFixed(2)+' g/t AuEq   ·   '+fmtoz(s.stats.oz),40,492);
        doc.setTextColor(198,202,197); doc.setFontSize(10);
        doc.text(doc.splitTextToSize(FOOT,880),40,512);
      });
      doc.save('Elk-Gold-Siwash-North.pdf');
      toast('PDF saved');
    }catch(e){ toast('PDF failed: '+e.message,5000); }
  };

  // ---- boot ----
  const st=readHash();
  if(st){
    restoring=true;
    cur=Math.max(0,Math.min(CHAPTERS.length-1,st.c));
    go(cur,true);
    setMode(st.m); setCut(st.k);
    vein=(st.v>=0&&st.v<VEINS.length)?st.v:-1; vsel.value=String(vein);
    Object.keys(clsOn).forEach(k=>{clsOn[k]=st.s.indexOf(k)>=0;});
    chips.querySelectorAll('.chip').forEach(el=>el.classList.toggle('on',clsOn[el.dataset.c]));
    setDrills(st.d);
    restoring=false;
    apply();
    $('intro').style.display='none';
  } else {
    go(0,true);
  }
  $('load').style.display='none';
  $('begin').onclick=()=>{$('intro').style.opacity='0';setTimeout(()=>$('intro').style.display='none',800);
    frameFor(CHAPTERS[0],true); if(EMBED&&!REDUCED) play();};
  window.__viewer=viewer; window.__api={go:go,play:play,stop:stop,readout:readout,shoot:shoot,grab:grab};
})().catch(e=>{
  // Never leave the opaque boot overlay covering an error the user can't read.
  const l=$('load'); if(l) l.style.display='none';
  const s=$('status'); s.className='fatal';
  s.textContent='Could not start: '+((e&&e.message)||e||'unknown error');
});
</script>
</body>
</html>"""

FONTS = (ROOT / "tools" / "assets" / "fonts.css").read_text()


def js(o):
    """JSON for embedding in a <script> block: '</' would close the tag early."""
    return json.dumps(o).replace("</", "<\\/")


for k, v in {
    "__FONTS__": FONTS,
    "__B64__": b64, "__META__": b64m, "__N__": str(N), "__RAMPMAX__": f"{RAMPMAX}",
    "__EMIN__": f"{EMIN:.1f}", "__NMIN__": f"{NMIN:.1f}", "__CE__": f"{cE:.1f}",
    "__CN__": f"{cN:.1f}", "__CZ__": f"{cZ:.1f}", "__EX__": f"{EX:.0f}", "__EY__": f"{EY:.0f}",
    "__CHAPTERS__": js(CHAPTERS),
    "__RUNS__": js([{k2: r[k2] for k2 in ("c", "b", "lo", "hi", "s", "n")} for r in RUNS]),
    "__BUCKETS__": js(BUCKETS),
    "__BY_CB__": js(BY_CB),
    "__VEINS__": js(VEINS),
    "__LADDER__": js(LADDER),
    "__CLASS_LABELS__": js(CLASS_LABELS),
    "__CLASS_CONFIRMED__": "true" if stats.get("class_mapping_confirmed") else "false",
    "__HOLES__": js(HOLES),
    "__DRILL_SYNTHETIC__": "true" if DRILL_SYNTHETIC else "false",
}.items():
    HTML = HTML.replace(k, v)

OUT.write_text(HTML)
print(f"wrote {OUT.name} ({len(HTML)/1e6:.1f} MB)")
print(f"  {N:,} blocks · {len(RUNS)} base primitives · {len(BUCKETS)} stat buckets")
print(f"  {len(VEINS)} vein domains · {len(CHAPTERS)} chapters · ramp max {RAMPMAX} g/t")
print(f"  {len(HOLES)} drill holes" + (" (SYNTHETIC)" if DRILL_SYNTHETIC else "") +
      f" · {sum(len(h['segs']) for h in HOLES)} assay intervals")
print(f"  total {stats['total']['tonnes']:,.0f} t @ {stats['total']['grade_gt']} g/t = {stats['total']['oz']:,.0f} oz")
