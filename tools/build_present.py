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
OUT_SW = ROOT / "sw.js"

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
ZTOP = max(Zs); ZBOT = min(Zs)


def binof(g):
    return bisect.bisect_right(LADDER, g) - 1


# Depth below the top of each block's own column. The model outcrops, so the
# highest block in a column is a good stand-in for surface — good enough to
# drive an aerial-perspective fade, and it needs no terrain query.
DEPTH_BAND_M = 70.0
N_DEPTH_BANDS = 6
_tops = {}
for _r in rows:
    _k = (round(_r[0] / 10), round(_r[1] / 5))
    if _k not in _tops or _r[2] > _tops[_k]:
        _tops[_k] = _r[2]


def depth_band(x, y, z):
    top = _tops.get((round(x / 10), round(y / 5)), z)
    return max(0, min(N_DEPTH_BANDS - 1, int((top - z) / DEPTH_BAND_M)))


# Sort by (class, ladder-bin) so each render bucket is one contiguous run —
# the viewer slices the buffer instead of shipping per-block indices.
# Depth joins the bucket key so an aerial-perspective fade is a per-primitive
# uniform rather than a per-block attribute.
rows = [r + (depth_band(r[0], r[1], r[2]),) for r in rows]
rows.sort(key=lambda r: (r[5], binof(r[3]), r[7], r[6]))

buf = bytearray()
meta = bytearray()
# penv rides along so the viewer can total an arbitrary spatial selection (a
# cross-section slab) exactly, rather than reporting the whole deposit while
# showing a slice of it.
for x, y, z, g, penv, cls, vein, dband in rows:
    buf += struct.pack("<fffff", x - EMIN, y - NMIN, z, g, penv)
    meta += struct.pack("<BB", cls, vein)
b64 = base64.b64encode(bytes(buf)).decode()
b64m = base64.b64encode(bytes(meta)).decode()
N = len(rows)
assert len(VEINS) <= 256, f"{len(VEINS)} vein domains exceeds the uint8 packing in META"

def runkey(r):
    return (r[5], binof(r[3]), r[7])


RUNS = []
start = 0
for i in range(1, N + 1):
    if i == N or runkey(rows[i]) != runkey(rows[start]):
        c, b, d = runkey(rows[start])
        RUNS.append({"c": c, "b": b, "d": d, "lo": LADDER[b],
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
            pa, pb = pos_at(hid, a), pos_at(hid, b)
            # Grade bar: a stick out the side of the hole, length scaled by
            # assay. This is the convention on every drill section — it reads
            # far faster than colour alone, and survives being seen edge-on.
            d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
            # perpendicular to the hole, kept horizontal (d x up)
            px_, py_ = d[1], -d[0]
            m = math.hypot(px_, py_) or 1.0
            blen = min(45.0, au * 2.2)
            mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]
            bar = [round(mid[0] + px_ / m * blen, 2),
                   round(mid[1] + py_ / m * blen, 2), round(mid[2], 2)]
            db = max(0, min(5, int((float(c["elevation"]) - mid[2]) / 70.0)))
            segs.append({"a": pa, "b": pb, "g": au, "mid": mid, "bar": bar,
                         "d": db, "f": round(a, 1), "t": round(b, 1)})
        holes.append({
            "id": hid,
            "collar": [float(c["easting"]), float(c["northing"]), float(c["elevation"])],
            "td": td,
            "end": pos_at(hid, td),
            "segs": segs,
        })
    return holes, man


# Top domains by contained metal get their own colour; the tail collapses to
# "other". 46 categorical colours would be noise, 8 reads as structure.
_voz = {}
for _b in BUCKETS:
    _voz[_b["v"]] = _voz.get(_b["v"], 0.0) + _b["m"]
TOP_VEINS = [v for v, _ in sorted(_voz.items(), key=lambda kv: -kv[1])[:8]]
VGROUP = [TOP_VEINS.index(i) if i in TOP_VEINS else 8 for i in range(len(VEINS))]
VGROUP_NAMES = [VEINS[v] for v in TOP_VEINS] + ["other (%d)" % (len(VEINS) - len(TOP_VEINS))]

HOLES, DRILL_MAN = load_drills()

# Headline intercepts — grade x length, which is how a drill release ranks them.
_int = []
for _h in HOLES:
    for _s in _h["segs"]:
        _len = _s["t"] - _s["f"]
        if _s["g"] >= 0.5 and _len >= 3:
            _int.append({"id": _h["id"], "g": _s["g"], "len": round(_len, 1),
                         "at": _s["mid"], "score": _s["g"] * _len})
_int.sort(key=lambda d: -d["score"])
HIGHLIGHTS = []
for _d in _int:                      # at most two headline hits per hole
    if sum(1 for h in HIGHLIGHTS if h["id"] == _d["id"]) >= 2:
        continue
    HIGHLIGHTS.append(_d)
    if len(HIGHLIGHTS) >= 10:
        break

_site_p = DRILLDIR / "SYNTHETIC_site_features.json"
SITE = json.loads(_site_p.read_text()) if _site_p.exists() else {}
SITE_SYNTHETIC = bool(SITE.get("synthetic", True)) if SITE else False
DRILL_SYNTHETIC = bool(DRILL_MAN.get("synthetic", True)) if HOLES else False

# Slide chapters sit in the same deck as the 3D scenes, so a presenter can move
# between corporate narrative and the model without leaving the tool. The 3D
# view stays live behind them - the deposit never disappears mid-story.
_T = stats["total"]
_M = stats["by_class"]
CHAPTERS = [
  {"h": 26, "p": -28, "r": 4200, "dwell": 9, "ground": 1.0, "slide": {
     "eyebrow": "The project",
     "section": "The project", "title": "Elk Gold - Siwash North",
     "body": "A drill-defined, high-grade gold system in British Columbia's Cariboo "
             "District. Road-accessible, in an established mining region, and open at depth.",
     "stats": [{"k": "Contained AuEq", "v": f"{_T['oz']/1e6:.2f} Moz"},
               {"k": "Tonnes", "v": f"{_T['tonnes']/1e6:.2f} Mt"},
               {"k": "Grade", "v": f"{_T['grade_gt']} g/t"},
               {"k": "Vein domains", "v": str(len(VEINS))}]}},
  {"h": 28, "p": -26, "r": 3600, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 9,
   "ground": 1.0, "section": "The project", "title": "A high-grade gold system", "body": "The Elk Gold project sits in the Quesnel Highland of British Columbia's Cariboo District — a road-accessible, established mining region."},
  {"h": 30, "p": -22, "r": 2500, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 9,
   "ground": 1.0, "section": "The ground", "title": "On real ground", "body": "Every block is placed at its true UTM position on real terrain — this is the actual mountain the deposit sits inside."},
  {"h": 52, "p": -24, "r": 2600, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 11,
   "ground": 0.42, "section": "The ground", "title": "The orebody", "body": "Forty-six vein domains threading the ridge, drawn as the blocks they are modelled as. Above half a gram the sheets separate and the northwest structural grain of the system becomes obvious."},
  {"h": 50, "p": -22, "r": 2100, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 12,
   "ground": 0.0, "surfaces": "veins", "section": "The deposit",
   "title": "The veins as bodies", "body": "The same domains drawn as solid geological surfaces rather than blocks \u2014 the hull of each vein, extracted face by face from the model so nothing is invented between the data points.",
   "pin": {"at": [693500, 5525400], "dz": 520, "text": "Eight largest vein domains"}},
  {"h": 58, "p": -34, "r": 2450, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 11,
   "ground": 0.0, "surfaces": "cores", "section": "The deposit", "title": "The high-grade core", "body": "The richest fifth of the blocks carry 78% of the metal. Raising the cut-off strips the rest away and leaves the bonanza shells that actually matter."},
  # Cumulative reveal: Measured, then +Indicated, then +Inferred, the way a
  # resource statement is actually presented rather than all at once.
  {"h": 52, "p": -30, "r": 1900, "cut": 0.5, "xray": True, "mode": "class", "dwell": 9,
   "ground": 0.0, "classes": [1], "section": "The deposit",
   "title": "Measured only",
   "body": "The part of the deposit with the most drilling behind it, on its own."},
  {"h": 52, "p": -30, "r": 1900, "cut": 0.5, "xray": True, "mode": "class", "dwell": 9,
   "ground": 0.0, "classes": [1, 2], "section": "The deposit",
   "title": "Measured and Indicated",
   "body": "Adding Indicated. This is the material a study would normally be built on."},
  {"h": 52, "p": -30, "r": 1700, "cut": 0.5, "xray": True, "mode": "class", "dwell": 11,
   "ground": 0.0, "classes": [0, 1, 2, 3], "section": "The deposit", "title": "How well is it known?", "body": "Recoloured by resource classification. Confidence is not evenly distributed through a deposit — and this is the first question any technical reader asks."},
  # Cut-off lifted to 1.0 here so the low-grade halo stops burying the traces.
  {"h": 38, "p": -24, "r": 1900, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 11, "drills": True,
   "ground": 0.0, "section": "Drilling & geometry", "title": "Drilled from surface", "body": "Drill traces coloured by assay grade, hung from their collars on the ridge above. These holes are synthetic — traced through the modelled grades to show how drilling reads against the block model."},
  # Straight down, ground intact, body replaced by the grade map. Overhead is
  # the one angle where the 3D model tells you least and the map tells you most.
  {"h": 0, "p": -90, "r": 2350, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 11,
   "ground": 1.0, "plan": True, "site": True, "section": "Drilling & geometry",
   "title": "Footprint in plan",
   "body": "Overhead, the body itself tells you nothing \u2014 you see the top of it and the ground disappears. So this is grade times thickness accumulated down every column, laid on the terrain: where the metal is, and how much of it, against the ground you would actually mine.",
   "pin": {"at": [693500, 5525900], "dz": 260, "text": "Grade \u00d7 thickness, g\u00b7m"}},
  # Looking straight down the section line, so the slab is seen edge-on.
  # Perpendicular to the slab and well above the ridge line — at a grazing
  # pitch the camera sits below the topography and the hillside fills the frame.
  {"h": 90, "p": -30, "r": 2700, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 12,
   "ground": 0.0, "section3d": "ns", "sectionAt": 50,
   "section": "Drilling & geometry", "title": "A section through it",
   "body": "A 90-metre slab taken north\u2013south through the middle of the deposit and viewed edge-on. Everything outside the slice is removed, so the veins read in true relationship instead of overlapping in projection \u2014 the view a geologist actually works from.",
   "pin": {"at": [693500, 5525400], "dz": 420, "text": "N\u2013S section, \u00b145 m"}},
  {"h": 4, "p": -4, "r": 2650, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 10,
   "ground": 0.0, "section": "Drilling & geometry", "title": "In profile", "body": "Turned on edge, the veins persist to roughly 475 metres below surface — and remain open at depth."},
  {"h": 44, "p": -18, "r": 1500, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 12,
   "ground": 0.0, "drills": True, "highlights": True,
   "section": "Drilling & geometry", "title": "The intercepts behind it", "body": "The headline hits, each labelled where it sits in three dimensions \u2014 the drill-release table, put back in the ground it came out of."},
  {"h": 26, "p": -27, "r": 3000, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 10,
   "ground": 0.0, "section": "Appendix", "title": "Explore it yourself", "body": "Forty-six vein domains, each one isolatable, each with its own grade and tonnage. Open Explore and interrogate the model directly."},
  {"h": 34, "p": -28, "r": 3000, "dwell": 12, "ground": 1.0, "section": "Appendix", "slide": {
     "eyebrow": "Grade-tonnage",
     "title": "What a cut-off costs you",
     "body": "Every cut-off trades tonnes for grade. This curve is computed from the "
             "same rollups the readout uses, so it cannot disagree with anything else "
             "in the deck.",
     "chart": "gradeTonnage"}},
  {"h": 40, "p": -30, "r": 2600, "dwell": 12, "ground": 1.0, "section": "Appendix", "slide": {
     "eyebrow": "Where the metal is",
     "title": "Ten domains carry it",
     "body": "Contained ounces by vein domain, share-weighted so blocks straddling "
             "two domains are split rather than double-counted.",
     "chart": "veinContribution"}},
  {"h": 30, "p": -26, "r": 3200, "dwell": 11, "ground": 1.0, "section": "Appendix", "slide": {
     "eyebrow": "Resource by confidence",
     "title": "What is known, and how well",
     "body": "Classification splits the deposit by how much drilling stands behind it. "
             "Labels follow the usual MineSight convention and remain unconfirmed "
             "against the Nov-2021 technical report.",
     "table": [["Class", "Tonnes", "Grade", "Contained"]] +
              [[stats["class_labels"][k], f"{v['tonnes']/1e6:.2f} Mt",
                f"{v['grade_gt']} g/t", f"{v['oz']:,.0f} oz"]
               for k, v in sorted(_M.items()) if v["tonnes"] > 0]}},
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

  #rail{position:fixed;left:30px;top:96px;z-index:6;display:flex;flex-direction:column;gap:2px;
        background:rgba(7,9,10,.72);border:1px solid rgba(255,255,255,.08);border-radius:5px;
        padding:8px 12px 8px 8px;backdrop-filter:blur(4px);max-height:calc(100vh - 260px);overflow-y:auto}
  #rail .c{display:flex;align-items:center;gap:10px;padding:6px 4px;min-height:44px;cursor:pointer;opacity:.72;transition:opacity .3s}
  #rail .sec{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.24em;
             text-transform:uppercase;color:#C99A3A;padding:12px 0 5px 4px;opacity:.9}
  #rail .th{width:54px;height:32px;border-radius:3px;flex:0 0 auto;background-size:cover;background-position:center;
            border:1px solid rgba(255,255,255,.16);background-color:#11161a}
  #rail .th.isslide{background-image:linear-gradient(120deg,#1e242a,#0d1114)}
  #rail .c.on .th{border-color:#C99A3A;box-shadow:0 0 0 1px rgba(201,154,58,.55)}
  #rail .c:hover{opacity:.85}
  #rail .c.on{opacity:1}
  #rail .num{font-family:'JetBrains Mono',monospace;font-size:10px;color:#C99A3A;width:20px}
  #rail .t{font-size:12px;font-weight:500;letter-spacing:.01em;max-width:150px;line-height:1.25}
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
  .btn.sm{padding:13px 14px;font-size:10px;min-height:44px}
  #nav .count{font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:.14em;color:#8E948E;min-width:52px;text-align:center}

  #legend{position:fixed;right:34px;top:28px;z-index:6;display:flex;align-items:center;gap:9px;
          background:rgba(7,9,10,.82);border:1px solid rgba(255,255,255,.10);border-radius:4px;
          padding:8px 12px;backdrop-filter:blur(6px)}
  #ramp{height:8px;width:150px;border-radius:2px;background:linear-gradient(90deg,#14324f,#1c7fb8,#21b0a0,#8fd14f,#f2c14e,#e8532b)}
  #legend span{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.05em;color:#C6CAC5;white-space:nowrap}
  #legend .sw{border:1px solid rgba(255,255,255,.25)}
  #depthleg{gap:3px!important}
  #depthleg .sw{width:13px;height:9px;border-radius:1px}
  #gtleg{display:none;gap:3px!important;align-items:center}
  #gtleg .sw{width:16px;height:10px;border-radius:1px}
  #gradeleg,#clsleg,#veinleg{display:none;gap:13px;align-items:center;flex-wrap:wrap;justify-content:flex-end;max-width:54vw}
  #gradeleg{display:flex}
  #legend .k{display:flex;align-items:center;gap:6px}
  .sw{width:10px;height:10px;border-radius:2px}

  #tools{position:fixed;right:34px;top:64px;z-index:9;display:flex;gap:8px}
  #panel{position:fixed;right:34px;top:108px;width:296px;z-index:9;background:rgba(12,15,16,.93);
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
  .cutrow{display:flex;align-items:center;gap:11px}
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
  .erow{display:flex;align-items:center;gap:9px;margin:7px 0}
  .erow label{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.1em;
              text-transform:uppercase;color:#8E948E;width:74px;flex:0 0 auto}
  .erow input{flex:1;accent-color:#C99A3A;min-width:0}
  .erow span{font-family:'JetBrains Mono',monospace;font-size:11px;color:#EDEEEC;
             width:52px;text-align:right;flex:0 0 auto}
  #econout{margin-top:12px;padding-top:11px;border-top:1px solid rgba(255,255,255,.11)}
  #econout .row{display:flex;justify-content:space-between;align-items:baseline;padding:3px 0}
  #econout .l{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.14em;
              text-transform:uppercase;color:#8E948E}
  #econout .v{font-family:'JetBrains Mono',monospace;font-size:13px;color:#EDEEEC}
  #econout .v.hero{color:#C99A3A;font-size:15px}
  #e_note{margin-top:9px;font-family:'JetBrains Mono',monospace;font-size:9.5px;
          line-height:1.5;color:#A8AEA9}
  #e_note.warn{color:#0d0f10;background:#D9584A;padding:6px 9px;border-radius:3px;font-weight:600}
  #caveat{margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:10px;line-height:1.55;color:#A8AEA9}
  .xrow{display:flex;gap:6px;margin-top:8px}
  .xrow .btn{flex:1;text-align:center}

  /* Text edition: light, high contrast, prints cleanly, no canvas involved. */
  #datamode{display:none;position:fixed;inset:0;z-index:18;overflow:auto;
            background:#F7F6F3;color:#14181b;padding:56px 24px 96px}
  body.datamode #datamode{display:block}
  body.datamode #cesiumContainer,body.datamode #bar,body.datamode #rail,
  body.datamode #legend,body.datamode #panel,body.datamode #brand,
  body.datamode #intro,body.datamode #slide,body.datamode #ink,
  body.datamode #inkbar,body.datamode #synwarn,body.datamode #compass,
  body.datamode #scalebar,body.datamode #inspect{display:none!important}
  #datamode header,#datamode section,#datamode footer{max-width:760px;margin:0 auto 40px}
  #datamode .eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;
    letter-spacing:.24em;text-transform:uppercase;color:#8a6a1f;margin-bottom:10px}
  #datamode h1{font-size:40px;font-weight:800;letter-spacing:-.03em;line-height:1.05}
  #datamode h2{font-size:20px;font-weight:700;margin:34px 0 10px;letter-spacing:-.01em}
  #datamode .lead{font-family:Newsreader,Georgia,serif;font-size:19px;line-height:1.55;
    color:#3a4045;margin-top:14px}
  #datamode p{font-family:Newsreader,Georgia,serif;font-size:17px;line-height:1.6;color:#23282c}
  #datamode .sect{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.2em;
    text-transform:uppercase;color:#6c7278;margin:0 0 8px}
  #datamode .fig{font-family:'JetBrains Mono',monospace;font-size:13px;color:#14181b;
    background:#ECEAE4;border-left:3px solid #8a6a1f;padding:11px 14px;margin-top:12px}
  #datamode table{border-collapse:collapse;width:100%;margin-top:14px;
    font-family:'JetBrains Mono',monospace;font-size:13px}
  #datamode caption{text-align:left;font-size:12px;color:#4a5054;padding-bottom:8px}
  #datamode th,#datamode td{text-align:left;padding:8px 12px 8px 0;
    border-bottom:1px solid #D9D5CC}
  #datamode thead th{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#4a5054}
  #datamode tr.tot th,#datamode tr.tot td{font-weight:700;border-top:2px solid #14181b}
  #datamode dl{display:grid;grid-template-columns:auto 1fr;gap:4px 18px;margin-top:14px;
    font-family:'JetBrains Mono',monospace;font-size:13px}
  #datamode dt{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#4a5054}
  #datamode pre{font-family:'JetBrains Mono',monospace;font-size:11.5px;line-height:1.6;
    background:#ECEAE4;padding:16px;overflow:auto;white-space:pre-wrap;color:#23282c}
  @media print{ #datamode{position:static;padding:0} #datatoggle{display:none} }
  #prov{position:fixed;inset:0;z-index:15;display:none;align-items:center;justify-content:center;
        background:rgba(4,6,7,.82);backdrop-filter:blur(5px);padding:36px}
  #prov.on{display:flex}
  #prov .pinner{background:#0d1114;border:1px solid rgba(255,255,255,.16);border-radius:6px;
                max-width:780px;width:100%;max-height:100%;display:flex;flex-direction:column}
  .phead{display:flex;justify-content:space-between;align-items:center;
         padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.10)}
  .phead>span{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.24em;
              text-transform:uppercase;color:#C99A3A}
  .phead>div{display:flex;gap:8px}
  #provbody{font-family:'JetBrains Mono',monospace;font-size:11.5px;line-height:1.65;
            color:#C6CAC5;padding:18px 20px;overflow:auto;white-space:pre-wrap;margin:0}
  #inspect{position:fixed;left:30px;bottom:120px;z-index:10;width:290px;display:none;
           background:rgba(12,15,16,.95);border:1px solid rgba(255,255,255,.14);
           border-radius:5px;padding:14px 16px;backdrop-filter:blur(8px)}
  #inspect.on{display:block}
  .ihead{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px}
  .ihead span{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.22em;
              text-transform:uppercase;color:#C99A3A}
  .ihead button{background:none;border:none;color:#C6CAC5;font-size:18px;cursor:pointer;
                line-height:1;padding:0 4px;min-height:44px;min-width:44px}
  .irow{display:flex;justify-content:space-between;gap:14px;padding:3px 0}
  .ik{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.1em;
      text-transform:uppercase;color:#8E948E}
  .iv{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#EDEEEC;text-align:right}
  #synwarn{position:fixed;left:50%;transform:translateX(-50%);bottom:118px;z-index:9;display:none;
           font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;text-transform:uppercase;
           color:#0d0f10;background:#D9584A;padding:7px 15px;border-radius:3px;font-weight:600}
  #synwarn.on{display:block}

  #compass{position:fixed;right:40px;bottom:118px;z-index:6;width:52px;height:52px;opacity:.75}
  #scalebar{position:fixed;right:34px;bottom:86px;z-index:6;text-align:right;opacity:.75}
  #scalebar .l{height:3px;background:#EDEEEC;margin-left:auto;border-left:1px solid #EDEEEC;border-right:1px solid #EDEEEC}
  #scalebar .t{font-family:'JetBrains Mono',monospace;font-size:9.5px;color:#C6CAC5;margin-top:4px;letter-spacing:.08em}

  /* Presenter ink: a transparent canvas over the scene. pointer-events flips
     on only while drawing, so the globe stays draggable the rest of the time. */
  #ink{position:fixed;inset:0;z-index:5;pointer-events:none;touch-action:none}
  #ink.arm{pointer-events:auto;cursor:crosshair}
  #inkbar{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:11;
          display:none;align-items:center;gap:8px;padding:8px 12px;border-radius:5px;
          background:rgba(12,15,16,.94);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(8px)}
  #inkbar.on{display:flex}
  .ibtn{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;
        color:#C6CAC5;background:transparent;border:1px solid rgba(255,255,255,.18);border-radius:3px;
        padding:13px 16px;min-height:44px;cursor:pointer}
  .ibtn.on{background:#C99A3A;border-color:#C99A3A;color:#07090A}
  .isw{width:34px;height:34px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,.25);
       flex:0 0 auto}
  .isw.on{border-color:#fff;transform:scale(1.15)}
  /* Slide chapters: a panel over the live 3D view rather than a separate mode,
     so the model stays visible behind the narrative. */
  /* The right two-thirds of the slide gradient is fully transparent, so it must
     not swallow clicks there — it was covering the toolbar and making Explore,
     Draw, Link and Site unclickable on every slide chapter. Only the text block
     takes pointer events. */
  #slide{position:fixed;inset:0;z-index:7;display:none;align-items:center;pointer-events:none;
         background:linear-gradient(100deg,rgba(7,9,10,.96) 0%,rgba(7,9,10,.90) 46%,rgba(7,9,10,.30) 78%,rgba(7,9,10,0) 100%);
         opacity:0;transition:opacity .55s ease}
  #slide.on{display:flex;opacity:1}
  #slide .sinner{max-width:620px;padding:0 60px;pointer-events:auto}
  #slide .sey{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.26em;
              text-transform:uppercase;color:#C99A3A;margin-bottom:20px}
  #slide h2{font-size:clamp(34px,4.2vw,58px);font-weight:800;letter-spacing:-.03em;line-height:1.02}
  #slide p{font-family:Newsreader,Georgia,serif;font-size:19px;line-height:1.55;color:#C6CAC5;
           margin-top:20px;text-wrap:pretty}
  .sstats{display:flex;flex-wrap:wrap;gap:34px;margin-top:36px}
  .sstats .k{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.16em;
             text-transform:uppercase;color:#8E948E}
  .sstats .v{font-size:28px;font-weight:700;letter-spacing:-.02em;color:#C99A3A;margin-top:5px}
  .stab{margin-top:30px;border-collapse:collapse;width:100%;display:none}
  .stab.on{display:table}
  .stab th{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.16em;
           text-transform:uppercase;color:#8E948E;text-align:left;padding:0 18px 9px 0;font-weight:500}
  .stab td{font-family:'JetBrains Mono',monospace;font-size:14px;color:#EDEEEC;
           padding:9px 18px 9px 0;border-top:1px solid rgba(255,255,255,.10)}
  .stab td:first-child{color:#C6CAC5}
  #s_chart{margin-top:26px;display:none}
  #s_chart.on{display:block}
  #s_chart text{font-family:'JetBrains Mono',monospace;fill:#8E948E;font-size:10px}
  #s_chart .ax{stroke:rgba(255,255,255,.16);stroke-width:1}
  #s_chart .gl{stroke:rgba(255,255,255,.07);stroke-width:1}
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
  #status{position:fixed;right:14px;bottom:12px;z-index:4;font-family:'JetBrains Mono',monospace;
          font-size:10px;color:#C6CAC5;background:rgba(7,9,10,.7);padding:3px 7px;border-radius:3px}
  #status.fatal{color:#0d0f10;background:#D9584A;padding:7px 13px;border-radius:3px;font-size:11px;z-index:30;font-weight:600}
  #offline{position:fixed;left:30px;bottom:12px;z-index:9;display:none;
           font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;
           text-transform:uppercase;color:#07090A;background:#C99A3A;padding:6px 12px;border-radius:3px}
  #offline.on{display:block}
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
    #cap,#intro,#prog,#dwell,#bar,.btn,.seg button,.chip,#slide,#rail .c,.isw,#toast,#offline
      {transition:none!important;animation:none!important}
    .isw.on{transform:none}
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
  <div id="gradeleg"></div>
  <div id="clsleg"></div>
  <div id="veinleg"></div>
  <div id="depthleg" style="display:flex"></div>
  <div id="gtleg"></div>
</div>

<div id="tools">
  <button id="datatoggle" class="btn sm" title="Text edition — no 3D required">Text</button>
  <button id="provbtn" class="btn sm" title="Audit trail — where every number comes from">Audit</button>
  <button id="sitebtn" class="btn sm" title="Ground-level site view">Site</button>
  <button id="drawbtn" class="btn sm" title="Annotate (D)">Draw</button>
  <button id="sharebtn" class="btn sm" title="Copy a link to this exact view">Link</button>
  <button id="xbtn" class="btn">Explore ▸</button>
</div>

<div id="panel">
  <h3>Colour by</h3>
  <div class="seg" id="modeseg">
    <button data-m="grade" class="on">Grade</button>
    <button data-m="class">Class</button>
    <button data-m="vein">Vein</button>
  </div>

  <h3>Intercept highlights</h3>
  <div class="seg" id="hiseg">
    <button data-h="0" class="on">Hidden</button>
    <button data-h="1">Shown</button>
  </div>

  <h3>Mine plan timeline</h3>
  <div class="cutrow"><input type="range" id="stage" min="-1" max="3" step="1" value="-1"><span id="stagev" style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#C99A3A;min-width:96px;text-align:right">none</span></div>

  <h3>Block model</h3>
  <div class="seg" id="blockseg">
    <button data-b="1" class="on">Shown</button>
    <button data-b="0">Hidden</button>
  </div>

  <h3>Economic scenario</h3>
  <div class="erow"><label for="e_price">Gold price</label>
    <input type="range" id="e_price" min="1200" max="4000" step="50" value="2400">
    <span id="e_pricev">$2,400</span></div>
  <div class="erow"><label for="e_cost">Cost / t</label>
    <input type="range" id="e_cost" min="15" max="180" step="5" value="65">
    <span id="e_costv">$65</span></div>
  <div class="erow"><label for="e_rec">Recovery</label>
    <input type="range" id="e_rec" min="50" max="98" step="1" value="90">
    <span id="e_recv">90%</span></div>
  <div class="chips" style="margin-top:9px">
    <div class="chip" id="e_inf"><span class="sw" style="background:#D9584A"></span>Include Inferred</div>
  </div>
  <div id="econout">
    <div class="row"><span class="l">Break-even cut-off</span><span class="v hero" id="e_be">—</span></div>
    <div class="row"><span class="l">Tonnes above it</span><span class="v" id="e_t">—</span></div>
    <div class="row"><span class="l">Grade</span><span class="v" id="e_g">—</span></div>
    <div class="row"><span class="l">Contained</span><span class="v" id="e_oz">—</span></div>
    <div class="row"><span class="l">In-situ revenue</span><span class="v" id="e_rev">—</span></div>
    <div class="row"><span class="l">Less op cost</span><span class="v" id="e_mar">—</span></div>
  </div>
  <div id="e_note"></div>

  <h3>Cross section</h3>
  <div class="seg" id="sectseg">
    <button data-x="" class="on">Off</button>
    <button data-x="ns">N–S</button>
    <button data-x="ew">E–W</button>
  </div>
  <div class="cutrow" style="margin-top:8px">
    <input type="range" id="sect" min="0" max="100" step="2" value="50">
    <span id="sectv" style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#C99A3A;min-width:96px;text-align:right">off</span>
  </div>

  <h3>Plan view</h3>
  <div class="seg" id="planseg">
    <button data-l="0" class="on">3D body</button>
    <button data-l="1">Grade map</button>
  </div>

  <h3>Vein surfaces</h3>
  <div class="seg" id="surfseg">
    <button data-f="" class="on">Blocks</button>
    <button data-f="veins">Veins</button>
    <button data-f="cores">Cores</button>
  </div>

  <h3>Property highlight</h3>
  <div class="seg" id="popseg">
    <button data-p="1" class="on">On</button>
    <button data-p="0">Off</button>
  </div>

  <h3>Site features</h3>
  <div class="seg" id="siteseg">
    <button data-s="0" class="on">Hidden</button>
    <button data-s="1">Shown</button>
  </div>

  <h3>Depth grid</h3>
  <div class="seg" id="depthseg">
    <button data-g="1" class="on">Shown</button>
    <button data-g="0">Hidden</button>
  </div>

  <h3>Ground over deposit</h3>
  <div class="cutrow"><input type="range" id="ground" min="0" max="100" step="5" value="0"><span id="groundv">cut away</span></div>

  <h3>Vertical exaggeration</h3>
  <div class="seg" id="exagseg">
    <button data-x="1" class="on">1&times;</button>
    <button data-x="1.5">1.5&times;</button>
    <button data-x="2">2&times;</button>
  </div>

  <h3>Cut-off grade</h3>
  <div class="cutrow" id="cutrow"><input type="range" id="cut" min="4" max="14" step="1" value="4"><span id="cutv"></span></div>

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

<canvas id="ink"></canvas>
<div id="inkbar">
  <button class="ibtn on" id="inkPen" title="Draw (D)">Draw</button>
  <span class="isw" data-c="#FF6A1F" style="background:#FF6A1F"></span>
  <span class="isw" data-c="#FFD23F" style="background:#FFD23F"></span>
  <span class="isw" data-c="#4FD1C5" style="background:#4FD1C5"></span>
  <span class="isw" data-c="#FFFFFF" style="background:#FFFFFF"></span>
  <button class="ibtn" id="inkUndo" title="Undo (\u2318Z)">Undo</button>
  <button class="ibtn" id="inkClear">Clear</button>
</div>

<main id="datamode" aria-hidden="true"></main>

<div id="prov"><div class="pinner">
  <div class="phead"><span>Audit trail</span>
    <div><button class="btn sm" id="provcopy">Copy</button>
         <button class="btn sm" id="provclose">Close</button></div></div>
  <pre id="provbody"></pre>
</div></div>

<div id="inspect">
  <div class="ihead"><span id="i_title">Block</span>
    <button id="i_close" title="Close">\u00d7</button></div>
  <div id="i_body"></div>
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

<div id="slide"><div class="sinner">
  <div class="sey" id="s_ey"></div>
  <h2 id="s_t"></h2>
  <p id="s_b"></p>
  <div class="sstats" id="s_stats"></div>
  <table class="stab" id="s_tab"></table>
  <div id="s_chart"></div>
</div></div>

<div id="intro">
  <div class="eyebrow">Orebody Present · Interactive 3D Story</div>
  <h1>Elk Gold<br>Siwash North</h1>
  <div class="sub">A high-grade gold system in British Columbia's Cariboo District — presented in three dimensions, on real terrain.</div>
  <button id="begin">Begin the walkthrough ▸</button>
</div>
<div id="offline"></div>
<div id="status">booting…</div>

<script src="https://cdn.jsdelivr.net/npm/cesium@1.120/Build/Cesium/Cesium.js"
        integrity="sha384-u6lI9nKeZ0sgcSQty6qC4XQHU/ZG7JJ8PfRvtUQTH83OstsiEivIu3F9k012EB3W"
        crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/proj4@2.11.0/dist/proj4.js"
        integrity="sha384-BIsA8GBrihzaRmijjpqTCihj8D5Vox3hyBFg9sJiTGAEOv6KusZ8QOCKbTFEAfhm"
        crossorigin="anonymous"></script>
<script>
const DATA="__B64__", META="__META__", N=__N__,
      EMIN=__EMIN__, NMIN=__NMIN__, CE=__CE__, CN=__CN__, CZ=__CZ__, EX=__EX__, EY=__EY__,
      ZTOP=__ZTOP__, ZBOT=__ZBOT__;
const CHAPTERS=__CHAPTERS__, RUNS=__RUNS__, BUCKETS=__BUCKETS__, VEINS=__VEINS__,
      LADDER=__LADDER__, CLASS_LABELS=__CLASS_LABELS__, CLASS_CONFIRMED=__CLASS_CONFIRMED__,
      PROV=__PROV__, THUMBS=__THUMBS__, BY_CB=__BY_CB__, HOLES=__HOLES__, HIGHLIGHTS=__HIGHLIGHTS__, SITE=__SITE__, SITE_SYNTHETIC=__SITE_SYNTHETIC__, VGROUP=__VGROUP__, VGROUP_NAMES=__VGROUP_NAMES__, DRILL_SYNTHETIC=__DRILL_SYNTHETIC__, G_PER_OZ=31.10348;
proj4.defs('EPSG:26910','+proj=utm +zone=10 +datum=NAD83 +units=m +no_defs');
const TONNES_PER_BLOCK=675;   // 10 x 5 x 5 m at 2.7 t/m3
const GEOID=-18, rad=Cesium.Math.toRadians, $=id=>document.getElementById(id);
const setStat=t=>$('status').textContent=t;
const EMBED=new URLSearchParams(location.search).has('embed');
const REDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;
if(EMBED) document.body.classList.add('embed');

function unb64(b){const s=atob(b);const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u;}
const F=new Float32Array(unb64(DATA).buffer), M=unb64(META);

// Discrete grade tiers, not a continuous ramp. Half the model sits under
// 1 g/t; smoothly interpolating across it renders as fog, whereas stepped
// bands read as structure. Alpha carries the same signal as hue so the
// low-grade halo can recede without being deleted.
// Alpha climbs steeply, not linearly: the sub-1 g/t tiers hold 55% of the
// blocks but ~4% of the metal, so they exist only as context and must recede
// hard. The 3+ tiers carry the deposit and stay solid.
// Grade shells, after the convention the category already uses: a small number
// of discrete, SOLID, strongly separated bands. Translucency was the wrong
// instinct — stacking 20 semi-transparent blocks down any line of sight just
// makes fog, and washing the whole model to see through it costs the very
// contrast that lets you read grade. Solid shells + a hidden halo reads far
// better than a transparent everything.
//
// The halo is the other half of it: 55% of blocks sit under 1 g/t and carry ~4%
// of the metal. Drawn, they ARE the blob. Off by default, available as context.
// GRADE_FLOOR is a hard floor for the entire tool, not a default. Nothing below
// it is drawn, coloured, surfaced or counted. Sub-economic material was what
// bridged the gaps between the veins and merged the system into one mass; with
// it gone the sheets stand apart. Must match tools/extract_surfaces.py.
const GRADE_FLOOR=0.5;
const TIERS=[
  {lo:0.5,  css:'#6FCF57', a:1.00, label:'0.5 – 1'},
  {lo:1.0,  css:'#F2A33C', a:1.00, label:'1 – 3'},
  {lo:3.0,  css:'#E8433C', a:1.00, label:'3 – 8'},
  {lo:8.0,  css:'#E05CC8', a:1.00, label:'8+ g/t'}];
const TIER_SCALE=[1.0,1.0,1.0,1.0];
// Aerial perspective: things seen through more rock get fainter and drift
// toward the cold background, exactly as haze works in air. Without it a 475 m
// thick deposit viewed from above is a flat sheet with no way to tell any of it
// is underground. Band 0 is at surface, band 5 is ~350 m down.
// Depth darkens rather than dissolves. On solid shells a fade would only bring
// the fog back; a graded shift toward the cold background still reads as "this
// is further into the rock" while every shell stays legible.
const DEPTH_MIX  =[0.00,0.13,0.26,0.38,0.50,0.60];
const HAZE={r:0.055,g:0.075,b:0.105};
function depthShade(col,d){
  const k=DEPTH_MIX[d]||0;
  return new Cesium.Color(col.red*(1-k)+HAZE.r*k, col.green*(1-k)+HAZE.g*k,
                          col.blue*(1-k)+HAZE.b*k, col.alpha);
}
function tierOf(g){let k=0;for(let i=0;i<TIERS.length;i++) if(g>=TIERS[i].lo) k=i; return k;}
function ramp(g,fade){const T=TIERS[tierOf(g)];
  return Cesium.Color.fromCssColorString(T.css).withAlpha(fade?T.a:1);}
const VEIN_COLORS=['#E8532B','#F2C14E','#21B0A0','#3EA6D6','#B07BD1','#7FD14F','#E88CB0','#D8843A','#55606B'];
const vgColor=(v,fade)=>Cesium.Color.fromCssColorString(VEIN_COLORS[VGROUP[v]!==undefined?VGROUP[v]:8])
  .withAlpha(fade?0.85:1);
const CLS_COLOR={0:'#5b6470',1:'#3EA6D6',2:'#C99A3A',3:'#D9584A'};
const clsColor=c=>Cesium.Color.fromCssColorString(CLS_COLOR[c]||'#888');
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
  // Chapters ran with depthTestAgainstTerrain off, which paints the deposit ON
  // TOP of the mountain — the single biggest reason it never read as buried.
  // A translucent globe keeps the surface visible while letting the subsurface
  // show through, so the model is unmistakably beneath the ground.
  viewer.scene.globe.translucency.enabled=true;
  viewer.scene.globe.translucency.frontFaceAlpha=0.0;
  // Confine the transparency to the deposit's own footprint. Making the whole
  // globe translucent turns the surrounding landscape into a dark wash, which
  // costs the terrain context that made this worth georeferencing. A rectangle
  // leaves the mountain solid and cuts a window over the orebody instead.
  const sw=proj4('EPSG:26910','WGS84',[EMIN-30,NMIN-30]);
  const ne=proj4('EPSG:26910','WGS84',[EMIN+EX+30,NMIN+EY+30]);
  // Property extent for the colour-pop cutout — the claim ring if the site
  // layer supplies one, otherwise a margin around the deposit itself.
  const POP_RECT=(function(){
    const ring=(SITE.claims&&SITE.claims[0]&&SITE.claims[0].ring)||null;
    if(ring){
      let w=180,e=-180,s=90,n=-90;
      ring.forEach(c=>{const ll=proj4('EPSG:26910','WGS84',c);
        w=Math.min(w,ll[0]); e=Math.max(e,ll[0]); s=Math.min(s,ll[1]); n=Math.max(n,ll[1]);});
      return Cesium.Rectangle.fromDegrees(w,s,e,n);
    }
    const a=proj4('EPSG:26910','WGS84',[EMIN-700,NMIN-700]);
    const b=proj4('EPSG:26910','WGS84',[EMIN+EX+700,NMIN+EY+700]);
    return Cesium.Rectangle.fromDegrees(a[0],a[1],b[0],b[1]);
  })();
  viewer.scene.globe.translucency.rectangle=Cesium.Rectangle.fromDegrees(sw[0],sw[1],ne[0],ne[1]);
  viewer.scene.globe.undergroundColor=Cesium.Color.fromCssColorString('#141a1f');
  // Colour-pop masking. Two copies of the same imagery: the base stays in full
  // colour, and a desaturated near-black copy sits on top with a hole cut out
  // over the property. The claim block is then the only saturated thing in the
  // world, which reads far harder than desaturating everything uniformly.
  const baseLayer=viewer.imageryLayers.get(0);
  baseLayer.saturation=1.15; baseLayer.brightness=1.0;
  let maskLayer=null, popOn=true;
  function buildMask(){
    if(maskLayer) return maskLayer;
    maskLayer=viewer.imageryLayers.addImageryProvider(imagery);
    maskLayer.saturation=0.0;
    maskLayer.brightness=0.42;
    maskLayer.contrast=1.25;
    return maskLayer;
  }
  function setPop(on){
    popOn=on;
    buildMask();
    maskLayer.show=on;
    // The cutout is the claim block when there is one, otherwise the deposit.
    maskLayer.cutoutRectangle=on?POP_RECT:undefined;
  }
  viewer.scene.skyAtmosphere.show=true;
  viewer.scene.globe.tileLoadProgressEvent.addEventListener(q=>setStat('terrain tiles: '+q));
  viewer.scene.canvas.addEventListener('webglcontextlost',ev=>{ev.preventDefault();setStat('context lost — reloading');setTimeout(()=>location.reload(),1200);},false);

  // Grade-fade on by default: 80% of the contained metal sits in 20% of the
  // blocks, so an opaque model shows mostly low-grade halo wrapped around the
  // part that matters. Fading by grade reveals the shells without deleting
  // context the way the cut-off does.
  let fade=true, EXAG=1, groundAlpha=0.0;
  const cll=proj4('EPSG:26910','WGS84',[CE,CN]);
  const center=Cesium.Cartesian3.fromDegrees(cll[0],cll[1],CZ+GEOID);
  const RADIUS=Math.max(EX,EY)*0.62;
  const toCart=(E,Nn,h)=>Cesium.Cartesian3.fromDegrees(...proj4('EPSG:26910','WGS84',[E,Nn]),h+GEOID);

  // Blocks are 10 x 5 x 5 m on the source grid.
  // Blocks are 10 x 5 x 5 m on the source grid; one geometry per grade tier so
  // the low tiers can be drawn undersized without touching the data.
  const BOXES=TIER_SCALE.map(s=>Cesium.BoxGeometry.fromDimensions({
    vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    dimensions:new Cesium.Cartesian3(10*s,5*s,5*s)}));
  const boxFor=g=>BOXES[tierOf(g)];
  // proj4 + Cartesian conversion is the expensive part of a rebuild, so do it
  // once for all 168k blocks and reuse for every primitive set built later.
  let POS=new Array(N);
  function buildPositions(){
    for(let i=0;i<N;i++){
      const z=F[i*5+2], h=EXAG===1?z:(CZ+(z-CZ)*EXAG);
      POS[i]=toCart(F[i*5]+EMIN,F[i*5+1]+NMIN,h);
    }
  }

  // One uniform-colour primitive per bucket: recolouring is a single material
  // uniform rather than 168k per-instance attribute writes.
  function makePrim(indices,color,gradeMid){
    const geom=boxFor(gradeMid===undefined?99:gradeMid);
    const inst=indices.map(i=>new Cesium.GeometryInstance({geometry:geom,
      modelMatrix:Cesium.Transforms.eastNorthUpToFixedFrame(POS[i])}));
    return new Cesium.Primitive({geometryInstances:inst,asynchronous:true,
      appearance:new Cesium.MaterialAppearance({flat:false,translucent:true,
        material:Cesium.Material.fromType('Color',{color})})});
  }
  setStat('building blocks…');
  buildPositions();
  function buildBase(){
    RUNS.forEach(r=>{
      if(r.prim) viewer.scene.primitives.remove(r.prim);
      const idx=[]; for(let i=r.s;i<r.s+r.n;i++) idx.push(i);
      r.mid=r.hi===null?r.lo*1.4:(r.lo+r.hi)/2;
      r.prim=makePrim(idx,depthShade(ramp(r.mid,fade),r.d||0),r.mid);
      viewer.scene.primitives.add(r.prim);
    });
  }
  buildBase();

  // Per-vein sets are built lazily and cached — isolation is a deliberate click.
  const veinPrims={};
  function buildVein(v){
    if(veinPrims[v]) return veinPrims[v];
    const byKey={};
    for(const r of RUNS) for(let i=r.s;i<r.s+r.n;i++){
      if(M[i*2+1]!==v) continue;
      const k=r.c+'|'+r.b+'|'+r.d;
      (byKey[k]=byKey[k]||{c:r.c,b:r.b,d:r.d,lo:r.lo,mid:r.mid,idx:[]}).idx.push(i);
    }
    const set=Object.values(byKey).map(g=>{
      const p=makePrim(g.idx,depthShade(ramp(g.mid,fade),g.d||0),g.mid); p.show=false;
      viewer.scene.primitives.add(p); return Object.assign({},g,{prim:p});
    });
    veinPrims[v]=set; return set;
  }

  // ---- drill traces ----
  // Entity polylines rather than a PolylineCollection: entities support
  // depthFailMaterial, so a hole stays legible as a ghost where it passes
  // behind blocks. Without it the traces vanish inside the ore halo, which is
  // exactly where they matter most.
  let drillEnts=null, hiEnts=null, hiOn=false;
  function buildDrills(){
    if(drillEnts||!HOLES.length) return drillEnts;
    drillEnts=[];
    const ghost=c=>new Cesium.ColorMaterialProperty(c.withAlpha(0.32));
    // A circular cross-section turns the trace into a solid rod instead of a
    // flat line, so it shades, occludes and reads as a real object against the
    // block model. Lines of any width stay flat and get lost.
    const tube=(r,n)=>{const s=[];for(let i=0;i<n;i++){const a=2*Math.PI*i/n;
      s.push(new Cesium.Cartesian2(r*Math.cos(a),r*Math.sin(a)));}return s;};
    const ROD=tube(1.1,6);
    const P=(p_)=>toCart(p_[0],p_[1],EXAG===1?p_[2]:(CZ+(p_[2]-CZ)*EXAG));
    HOLES.forEach(h=>{
      const trace=viewer.entities.add({polylineVolume:{
        positions:[P(h.collar),P(h.end)], shape:ROD,
        material:new Cesium.Color(0.87,0.89,0.87,0.55),
        outline:false}});
      trace.__hole=h; drillEnts.push(trace);
      h.segs.forEach(s=>{ if(s.g<GRADE_FLOOR) return;
        const col=depthShade(ramp(s.g,false),s.d||0);
        // Assayed intervals as beads strung on the trace rather than fat rods:
        // a bead reads as a discrete sample and does not occlude the blocks
        // behind it, which is how every drill section is drawn.
        const r=Math.min(9,2.4+Math.sqrt(s.g)*1.6);
        drillEnts.push(viewer.entities.add({position:P(s.mid),
          ellipsoid:{radii:new Cesium.Cartesian3(r,r,r),material:col}}));
        // and the grade bar out the side, length scaled by assay
        const bar=viewer.entities.add({polyline:{
          positions:[P(s.mid),P(s.bar)], width:3, material:col,
          depthFailMaterial:ghost(col)}});
        bar.__hole=h; bar.__seg=s; drillEnts.push(bar);
      });
      // A collar is a physical thing on the ground; a solid marker reads as one
      // where a screen-space dot reads as a UI annotation.
      drillEnts.push(viewer.entities.add({position:P(h.collar),
        box:{dimensions:new Cesium.Cartesian3(16,16,16),
             material:Cesium.Color.fromCssColorString('#F2C14E'),
             outline:true,outlineColor:Cesium.Color.fromCssColorString('#07090A')},
        label:{text:h.id,font:'500 11px monospace',fillColor:Cesium.Color.WHITE.withAlpha(.85),
               showBackground:true,backgroundColor:new Cesium.Color(0.03,0.04,0.04,0.72),
               pixelOffset:new Cesium.Cartesian2(0,-16),scale:0.9,
               // Forty collar tags at once is noise. Show them only close in,
               // and stand down entirely when the intercept callouts are up —
               // those carry the hole id already.
               distanceDisplayCondition:new Cesium.DistanceDisplayCondition(0,1300),
               disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    });
    return drillEnts;
  }
  const showDrills=on=>{ if(drillEnts) drillEnts.forEach(e=>{
    e.show = on && !(hiOn && e.label);   // collar tags off while callouts are up
  }); };

  // Headline intercepts: hole id over the assay, on a leader line back to a
  // marker at the intercept. This is the shape of every drill-results release,
  // and it is the one view a mining audience reads without being taught.
  hiEnts=null;
  function buildHighlights(){
    if(hiEnts||!HIGHLIGHTS.length) return hiEnts;
    hiEnts=[];
    const zf=z=>EXAG===1?z:(CZ+(z-CZ)*EXAG);
    HIGHLIGHTS.forEach((d,i)=>{
      const ll=proj4('EPSG:26910','WGS84',[d.at[0],d.at[1]]);
      const at=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],zf(d.at[2])+GEOID);
      const side=i%2?1:-1, tier=Math.floor(i/2);
      const off=proj4('EPSG:26910','WGS84',
        [d.at[0]+side*(430+tier*70), d.at[1]-tier*130]);
      const lab=Cesium.Cartesian3.fromDegrees(off[0],off[1],
        zf(d.at[2])+GEOID+150+tier*45);
      hiEnts.push(viewer.entities.add({polyline:{positions:[at,lab],width:1.2,
        arcType:Cesium.ArcType.NONE,material:Cesium.Color.WHITE.withAlpha(.62)}}));
      hiEnts.push(viewer.entities.add({position:at,
        point:{pixelSize:9,color:Cesium.Color.fromCssColorString('#E8433C'),
               outlineColor:Cesium.Color.WHITE.withAlpha(.85),outlineWidth:1.5,
               disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
      hiEnts.push(viewer.entities.add({position:lab,
        label:{text:d.id+(DRILL_SYNTHETIC?'  (synthetic)':'')+'\n'+
                    d.g.toFixed(2)+' g/t Au over '+d.len+'m',
          font:'500 13px Archivo, system-ui, sans-serif',
          fillColor:Cesium.Color.WHITE,showBackground:true,
          backgroundColor:new Cesium.Color(0.10,0.11,0.12,0.92),
          backgroundPadding:new Cesium.Cartesian2(11,8),
          horizontalOrigin:side>0?Cesium.HorizontalOrigin.LEFT:Cesium.HorizontalOrigin.RIGHT,
          disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    });
    return hiEnts;
  }
  const showHi=on=>{ if(on) buildHighlights(); if(hiEnts) hiEnts.forEach(e=>e.show=on); };

  // ---- accessible data mode ----
  // A WebGL deck is unreadable to a screen reader, unusable without a GPU,
  // invisible to search, and impossible to print. This renders the whole deck
  // as semantic HTML with every figure in a real table — same content, no
  // canvas. Reachable at ?data=1 and from the toolbar.
  function buildDataMode(){
    const wrap=$('datamode');
    if(wrap.dataset.built) return;
    wrap.dataset.built='1';
    const h=document.createElement('header');
    h.innerHTML='<p class="eyebrow">Orebody \u00b7 text edition</p>'+
      '<h1>Elk Gold \u2014 Siwash North</h1>';
    const lead=document.createElement('p'); lead.className='lead';
    lead.textContent='Every chapter of the presentation, with its figures, as text. '+
      'No 3D required. Figures are computed from the same rollups the interactive '+
      'view uses.';
    h.appendChild(lead); wrap.appendChild(h);

    const totals=document.createElement('section');
    totals.innerHTML='<h2>Deposit total</h2>';
    const tt=document.createElement('table');
    tt.innerHTML='<caption>At the '+GRADE_FLOOR+' g/t floor and above, by resource class</caption>'+
      '<thead><tr><th scope="col">Class</th><th scope="col">Tonnes</th>'+
      '<th scope="col">Grade</th><th scope="col">Contained</th></tr></thead>';
    const tb=document.createElement('tbody');
    Object.keys(PROV.by_class).forEach(k=>{
      const s=statsAbove(GRADE_FLOOR,{classes:[+k]});
      if(!s.tonnes) return;
      const tr=document.createElement('tr');
      [CLASS_LABELS[k], Math.round(s.tonnes).toLocaleString()+' t',
       s.grade.toFixed(2)+' g/t', Math.round(s.oz).toLocaleString()+' oz']
        .forEach((v,i)=>{ const c=document.createElement(i?'td':'th');
          if(!i) c.scope='row'; c.textContent=v; tr.appendChild(c); });
      tb.appendChild(tr);
    });
    const all=statsAbove(GRADE_FLOOR);
    const trf=document.createElement('tr'); trf.className='tot';
    ['All classes', Math.round(all.tonnes).toLocaleString()+' t',
     all.grade.toFixed(2)+' g/t', Math.round(all.oz).toLocaleString()+' oz']
      .forEach((v,i)=>{ const c=document.createElement(i?'td':'th');
        if(!i) c.scope='row'; c.textContent=v; trf.appendChild(c); });
    tb.appendChild(trf); tt.appendChild(tb); totals.appendChild(tt);
    wrap.appendChild(totals);

    CHAPTERS.forEach((c,i)=>{
      const sec=document.createElement('section');
      const t2=document.createElement('h2');
      t2.textContent=(i+1)+'. '+((c.slide?c.slide.title:c.title)||'Chapter '+(i+1));
      sec.appendChild(t2);
      if(c.section){ const s=document.createElement('p'); s.className='sect';
        s.textContent=c.section; sec.appendChild(s); }
      const body=(c.slide?c.slide.body:c.body)||'';
      if(body){ const b=document.createElement('p'); b.textContent=body; sec.appendChild(b); }
      if(c.slide&&c.slide.stats){
        const dl=document.createElement('dl');
        c.slide.stats.forEach(x=>{
          const dt=document.createElement('dt'); dt.textContent=x.k;
          const dd=document.createElement('dd'); dd.textContent=x.v;
          dl.appendChild(dt); dl.appendChild(dd);});
        sec.appendChild(dl);
      }
      if(c.slide&&c.slide.table){
        const tb2=document.createElement('table'); const th=document.createElement('thead');
        const hr=document.createElement('tr');
        c.slide.table[0].forEach(x=>{const th2=document.createElement('th');
          th2.scope='col'; th2.textContent=x; hr.appendChild(th2);});
        th.appendChild(hr); tb2.appendChild(th);
        const bd=document.createElement('tbody');
        c.slide.table.slice(1).forEach(row=>{const tr=document.createElement('tr');
          row.forEach((x,j)=>{const cell=document.createElement(j?'td':'th');
            if(!j) cell.scope='row'; cell.textContent=x; tr.appendChild(cell);});
          bd.appendChild(tr);});
        tb2.appendChild(bd); sec.appendChild(tb2);
      }
      if(!c.slide){
        const cut=Math.max(GRADE_FLOOR, c.cut===undefined?GRADE_FLOOR:c.cut);
        const s=statsAbove(cut,{classes:c.classes||null});
        const p2=document.createElement('p'); p2.className='fig';
        p2.textContent='At '+cut.toFixed(2)+' g/t'+
          (c.classes?' ('+c.classes.map(k=>CLASS_LABELS[k]).join(', ')+')':'')+': '+
          Math.round(s.tonnes).toLocaleString()+' t at '+s.grade.toFixed(2)+
          ' g/t AuEq, '+Math.round(s.oz).toLocaleString()+' oz contained, from '+
          s.blocks.toLocaleString()+' blocks.';
        sec.appendChild(p2);
      }
      wrap.appendChild(sec);
    });

    const foot=document.createElement('footer');
    const pre=document.createElement('pre'); pre.textContent=provText();
    foot.innerHTML='<h2>Audit trail</h2>'; foot.appendChild(pre);
    wrap.appendChild(foot);
  }
  function setDataMode(on){
    if(on) buildDataMode();
    document.body.classList.toggle('datamode',on);
    $('datamode').setAttribute('aria-hidden', on?'false':'true');
    if(on) window.scrollTo(0,0);
  }

  // ---- provenance ----
  // Nothing in a competing deck tells you where a number came from. Every
  // headline figure here resolves to a source file, a predicate and a
  // reconciliation, and the whole trail copies to the clipboard — the
  // difference between showing a picture and showing your work.
  function currentPredicate(){
    const p=[];
    p.push('AuEq >= '+Math.max(cutVal(),GRADE_FLOOR).toFixed(2)+' g/t (hard floor '+GRADE_FLOOR+')');
    const on=Object.keys(clsOn).filter(c=>clsOn[c]).map(c=>CLASS_LABELS[c]);
    p.push('classes: '+(on.length?on.join(', '):'none'));
    p.push(vein===-1?'all '+VEINS.length+' vein domains':'domain '+VEINS[vein]+' (share-weighted)');
    if(sectAxis) p.push('cross section '+sectAxis.toUpperCase()+' at '+
      Math.round(sectPos)+', slab \u00b1'+SECT_HALF+' m (totalled per block)');
    if(surfOn) p.push('geometry: '+surfOn+' surfaces');
    if(planOn) p.push('geometry: plan grade\u00d7thickness raster');
    return p;
  }
  function provText(){
    const r=readout();
    const L=[];
    L.push('OREBODY — AUDIT TRAIL');
    L.push('');
    L.push('Source            '+PROV.source);
    L.push('Rows scanned      '+PROV.scanned_rows.toLocaleString());
    L.push('Mineralized       '+PROV.mineralized_blocks.toLocaleString()+' blocks');
    L.push('Dropped           '+PROV.dropped_blocks+' (blocks with no vein share)');
    L.push('Straddling >1 dom '+PROV.straddlers.toLocaleString()+
           ' — vein tonnage is share-weighted, never credited whole');
    L.push('Block             '+PROV.block_m3+' m3 @ '+PROV.density+
           ' t/m3 = '+PROV.tonnes_per_block+' t; ore tonnes = that x Percent_Env');
    L.push('');
    L.push('DEPOSIT TOTAL (no cut-off)');
    L.push('  '+PROV.total.tonnes.toLocaleString()+' t @ '+PROV.total.grade_gt+
           ' g/t = '+PROV.total.oz.toLocaleString()+' oz');
    L.push('');
    L.push('CURRENTLY ON SCREEN');
    currentPredicate().forEach(x=>L.push('  '+x));
    L.push('  => '+fmt(r.t)+' @ '+r.g.toFixed(2)+' g/t = '+fmtoz(r.oz)+
           '  ('+r.n.toLocaleString()+' blocks)');
    L.push('');
    L.push('BY CLASS');
    Object.keys(PROV.by_class).forEach(k=>{
      const v=PROV.by_class[k];
      if(!v.tonnes) return;
      L.push('  '+(CLASS_LABELS[k]+'              ').slice(0,14)+
             v.tonnes.toLocaleString()+' t @ '+v.grade_gt+' g/t = '+
             v.oz.toLocaleString()+' oz');
    });
    L.push('');
    L.push('CAVEATS');
    if(!PROV.class_confirmed)
      L.push('  Resource class labels follow MineSight convention and are UNCONFIRMED');
    L.push('  against the Nov-2021 technical report.');
    if(PROV.drills_synthetic) L.push('  Drill holes are FABRICATED. Not real results.');
    if(PROV.site_synthetic)   L.push('  Site features and pit stages are FABRICATED. Not a mine plan.');
    L.push('  Silver is absent from the source; AuEq is effectively gold-only.');
    L.push('  Illustrative visualization — not a mineral resource statement.');
    return L.join('\n');
  }
  function showProv(){ $('provbody').textContent=provText(); $('prov').classList.add('on'); }

  // ---- click to interrogate ----
  // Their decks are something you watch. This makes the model answerable: click
  // anywhere on the deposit and get the actual block behind that pixel, not a
  // tooltip someone authored. Blocks are batched into primitives so they cannot
  // be picked individually; instead the click is turned into a world position,
  // taken back to UTM, and matched against the source grid.
  const cellIndex=new Map();
  let cellIndexBuilt=false;
  function buildCellIndex(){
    if(cellIndexBuilt) return;
    for(let i=0;i<N;i++){
      const k=Math.round(F[i*5]/10)+'|'+Math.round(F[i*5+1]/5)+'|'+Math.round(F[i*5+2]/5);
      cellIndex.set(k,i);
    }
    cellIndexBuilt=true;
  }
  function pickAt(win){
    const scene=viewer.scene;
    const picked=scene.pick(win);
    if(picked && picked.id && picked.id.polyline && picked.id.__hole){
      return {kind:'hole', hole:picked.id.__hole, seg:picked.id.__seg};
    }
    const pos=scene.pickPosition(win);
    if(!Cesium.defined(pos)) return null;
    const carto=Cesium.Cartographic.fromCartesian(pos);
    const ll=[Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)];
    const utm=proj4('WGS84','EPSG:26910',ll);
    let z=carto.height-GEOID;
    if(EXAG!==1) z=CZ+(z-CZ)/EXAG;
    buildCellIndex();
    // search a small neighbourhood: the click lands on a face, not a centre
    for(let dz=0;dz<=2;dz++) for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      for(const s of [-1,1]){
        const k=(Math.round((utm[0]-EMIN)/10)+dx)+'|'+
                (Math.round((utm[1]-NMIN)/5)+dy)+'|'+
                (Math.round(z/5)+s*dz);
        const i=cellIndex.get(k);
        if(i!==undefined) return {kind:'block', i:i};
      }
    }
    return null;
  }
  function showPick(p){
    const el=$('inspect');
    if(!p){ el.classList.remove('on'); return; }
    let rows=[];
    if(p.kind==='block'){
      const i=p.i, g=F[i*5+3], penv=F[i*5+4];
      const tn=TONNES_PER_BLOCK*penv;
      const topKey=Math.round(F[i*5]/10)+'|'+Math.round(F[i*5+1]/5);
      rows=[['Grade', g.toFixed(2)+' g/t AuEq'],
            ['Ore tonnes', Math.round(tn).toLocaleString()+' t'],
            ['Contained', (tn*g/G_PER_OZ).toFixed(2)+' oz'],
            ['Ore fraction', (penv*100).toFixed(1)+'%'],
            ['Class', CLASS_LABELS[M[i*2]]+(CLASS_CONFIRMED?'':' (unconfirmed)')],
            ['Domain', VEINS[M[i*2+1]]],
            ['Easting', Math.round(F[i*5]+EMIN).toLocaleString()],
            ['Northing', Math.round(F[i*5+1]+NMIN).toLocaleString()],
            ['Elevation', Math.round(F[i*5+2])+' m'],
            ['Block', '10 \u00d7 5 \u00d7 5 m @ 2.7 t/m\u00b3']];
      $('i_title').textContent='Block';
    } else {
      const h=p.hole, s=p.seg;
      rows=[['Hole', h.id+(DRILL_SYNTHETIC?'  (synthetic)':'')],
            ['Collar', Math.round(h.collar[0]).toLocaleString()+' E, '+
                       Math.round(h.collar[1]).toLocaleString()+' N'],
            ['Total depth', h.td.toFixed(1)+' m']];
      if(s) rows.push(['Interval', s.f+'\u2013'+s.t+' m'],
                      ['Assay', s.g.toFixed(2)+' g/t Au over '+(s.t-s.f).toFixed(1)+' m']);
      $('i_title').textContent='Drill hole';
    }
    $('i_body').innerHTML='';
    rows.forEach(r=>{
      const d=document.createElement('div'); d.className='irow';
      const k=document.createElement('span'); k.className='ik'; k.textContent=r[0];
      const v=document.createElement('span'); v.className='iv'; v.textContent=r[1];
      d.appendChild(k); d.appendChild(v); $('i_body').appendChild(d);
    });
    el.classList.add('on');
  }
  viewer.screenSpaceEventHandler.setInputAction(m=>{
    if(inking) return;
    showPick(pickAt(m.position));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // ---- exact statistics at an arbitrary cut-off ----
  // The bucket tables are keyed to the ladder, so they can only answer ladder
  // steps. An economic cut-off is a continuous function of price and cost and
  // almost never lands on one, so this sums the blocks directly. 168k rows is
  // a couple of milliseconds and it means the economics are exact rather than
  // snapped to the nearest step.
  function statsAbove(cut, opts){
    opts=opts||{};
    const useCls=opts.classes||null;
    let n=0,t=0,m=0;
    for(let i=0;i<N;i++){
      const g=F[i*5+3];
      if(g<cut-1e-9 || g<GRADE_FLOOR-1e-9) continue;
      if(useCls && useCls.indexOf(M[i*2])<0) continue;
      const tn=TONNES_PER_BLOCK*F[i*5+4];
      n++; t+=tn; m+=tn*g;
    }
    return {blocks:n, tonnes:t, grade:t?m/t:0, oz:m/G_PER_OZ, metal_g:m};
  }

  // ---- economic scenario ----
  // Cut-off is not a preference, it is arithmetic: the grade at which a tonne
  // pays for itself. Presenting it as a fixed number someone chose hides the
  // only question an investor is actually asking.
  //   value of 1 t at grade g  =  (g / 31.1035) * price * recovery
  //   break-even when that equals cost  =>  g = cost * 31.1035 / (price * rec)
  const ECON={price:2400, cost:65, rec:0.90, inferred:false};
  function breakEven(){
    const denom=ECON.price*ECON.rec;
    return denom>0 ? (ECON.cost*G_PER_OZ)/denom : GRADE_FLOOR;
  }
  function econ(){
    const be=Math.max(GRADE_FLOOR, breakEven());
    // NI 43-101 does not permit Inferred material in economic analysis. It is
    // excluded here by default and can only be added deliberately, with the
    // output relabelled — the guard belongs in the tool, not in a footnote.
    const cls=ECON.inferred?[0,1,2,3]:[0,1,2];
    const s=statsAbove(be,{classes:cls});
    const revenue=s.oz*ECON.price*ECON.rec;
    const opcost=s.tonnes*ECON.cost;
    return {be:be, s:s, revenue:revenue, opcost:opcost, margin:revenue-opcost,
            capped:breakEven()<GRADE_FLOOR};
  }
  function paintEcon(){
    const e=econ();
    const money=v=>(Math.abs(v)>=1e9?(v/1e9).toFixed(2)+' B':(v/1e6).toFixed(0)+' M');
    $('e_be').textContent=e.be.toFixed(2)+' g/t'+(e.capped?'  (floored)':'');
    $('e_t').textContent=fmt(e.s.tonnes);
    $('e_g').textContent=e.s.grade.toFixed(2)+' g/t';
    $('e_oz').textContent=fmtoz(e.s.oz);
    $('e_rev').textContent='$'+money(e.revenue);
    $('e_mar').textContent='$'+money(e.margin);
    $('e_mar').style.color=e.margin>=0?'#6FCF57':'#E8433C';
    $('e_note').textContent=ECON.inferred
      ? 'INCLUDES INFERRED — not permissible for economic analysis under NI 43-101. Illustrative only.'
      : 'Inferred excluded, as NI 43-101 requires. Illustrative scenario, not an economic study.';
    $('e_note').className=ECON.inferred?'warn':'';
    return e;
  }

  // ---- cross sections ----
  // A slice through the deposit on a fixed bearing, which is how a geologist
  // actually interrogates a vein system: everything outside a narrow slab is
  // removed so the sheets read in true relationship instead of overlapping in
  // projection. Cesium primitives do not take clipping planes, so the slab is
  // built as its own geometry from the blocks inside it and cached per section.
  let sectEnts=null, sectPrims=null, sectAxis=null, sectPos=0, sectStat=null;
  const SECT_HALF=45;                       // slab half-width, metres
  function clearSection(){
    sectStat=null;
    if(sectPrims){ sectPrims.forEach(o=>viewer.scene.primitives.remove(o.prim)); sectPrims=null; }
    if(sectEnts){ sectEnts.forEach(e=>viewer.entities.remove(e)); sectEnts=null; }
  }
  function buildSection(){
    clearSection();
    if(!sectAxis) return;
    const by={};
    for(const r of RUNS){
      if(r.lo<Math.max(cutVal(),GRADE_FLOOR)-1e-9) continue;
      if(!clsOn[r.c]) continue;
      for(let i=r.s;i<r.s+r.n;i++){
        const v=sectAxis==='ns' ? F[i*5]+EMIN : F[i*5+1]+NMIN;
        if(Math.abs(v-sectPos)>SECT_HALF) continue;
        const k=r.c+'|'+r.b+'|'+r.d;
        (by[k]=by[k]||{c:r.c,b:r.b,d:r.d,lo:r.lo,mid:r.mid,idx:[]}).idx.push(i);
      }
    }
    // Exact totals for the slab, summed per block. The rollup tables have no
    // spatial key, so a section cannot be answered from them — and reporting
    // the whole deposit next to a picture of a slice is the divergence this
    // build has been bitten by twice already.
    sectStat={n:0,t:0,m:0};
    Object.values(by).forEach(o=>o.idx.forEach(i=>{
      const tn=TONNES_PER_BLOCK*F[i*5+4];
      sectStat.n++; sectStat.t+=tn; sectStat.m+=tn*F[i*5+3];
    }));
    sectPrims=Object.values(by).map(o=>{
      const pr=makePrim(o.idx,depthShade(ramp(o.mid,true),o.d||0),o.mid);
      viewer.scene.primitives.add(pr); return Object.assign({},o,{prim:pr});
    });
    // frame of the slice, so the viewer can see where the cut was taken
    sectEnts=[];
    const a=sectAxis==='ns'
      ? [[sectPos,NMIN-40],[sectPos,NMIN+EY+40]]
      : [[EMIN-40,sectPos],[EMIN+EX+40,sectPos]];
    [ZTOP+40, ZBOT-40].forEach(z=>{
      const zz=EXAG===1?z:(CZ+(z-CZ)*EXAG);
      sectEnts.push(viewer.entities.add({polyline:{
        positions:a.map(c=>toCart(c[0],c[1],zz)), width:1.4,
        arcType:Cesium.ArcType.NONE,
        material:new Cesium.PolylineDashMaterialProperty({
          color:Cesium.Color.WHITE.withAlpha(.5), dashLength:16})}}));
    });
    const lab=sectAxis==='ns'?('Section '+Math.round(sectPos)+' E'):('Section '+Math.round(sectPos)+' N');
    sectEnts.push(viewer.entities.add({
      position:toCart(a[0][0],a[0][1],(EXAG===1?ZTOP:(CZ+(ZTOP-CZ)*EXAG))+120),
      label:{text:lab+'   \u00b1'+SECT_HALF+' m',
        font:'500 13px "JetBrains Mono", monospace',fillColor:Cesium.Color.WHITE,
        showBackground:true,backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.85),
        backgroundPadding:new Cesium.Cartesian2(10,7),
        disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
  }
  function setSection(axis,pos){
    sectAxis=axis||null;
    // CE/CN are the injected constants; cE/cN are Python-side names and do not
    // exist in the browser — this threw on every navigation away from a section.
    sectPos=pos!==undefined?pos:(axis==='ns'?CE:CN);
    buildSection();
    $('sectv').textContent=sectAxis
      ? (sectAxis==='ns'?'N–S at '+Math.round(sectPos)+' E':'E–W at '+Math.round(sectPos)+' N')
      : 'off';
  }

  // ---- plan-view grade x thickness map ----
  // From directly overhead a block model is an opaque blanket: you see its top
  // surface and nothing else, so the terrain and any pit underneath vanish.
  // That is what makes every plan view read as a blob no matter how the shells
  // are tuned. The fix is to stop drawing the body in plan and draw what a mine
  // plan actually shows — grade x thickness accumulated down each column,
  // draped on the ground as a raster. Terrain reads through it, the pit stays
  // visible, and the deposit reads as a map instead of a lump.
  let planLayer=null, planOn=false;
  const GT_STOPS=[[0,'#1b3550'],[0.12,'#1668a6'],[0.30,'#17a89a'],
                  [0.55,'#F2A33C'],[0.78,'#E8433C'],[1,'#E05CC8']];
  function gtColor(u){
    let a=GT_STOPS[0],b=GT_STOPS[GT_STOPS.length-1];
    for(let i=0;i<GT_STOPS.length-1;i++)
      if(u>=GT_STOPS[i][0]&&u<=GT_STOPS[i+1][0]){a=GT_STOPS[i];b=GT_STOPS[i+1];break;}
    const f=(u-a[0])/((b[0]-a[0])||1);
    const hx=c=>[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];
    const ca=hx(a[1]), cb=hx(b[1]);
    return [Math.round(ca[0]+(cb[0]-ca[0])*f), Math.round(ca[1]+(cb[1]-ca[1])*f),
            Math.round(ca[2]+(cb[2]-ca[2])*f)];
  }
  let GT_MAX=0;
  let planCutBuilt=null;
  function buildPlanMap(){
    // The raster has to honour the same cut-off as everything else, or the map
    // shows one deposit and the readout reports another.
    if(planLayer && planCutBuilt===cutVal()) return planLayer;
    if(planLayer){ viewer.imageryLayers.remove(planLayer,true); planLayer=null; }
    planCutBuilt=cutVal();
    // Accumulate grade x thickness (gram-metres) down each 10 x 5 m column.
    const nx=Math.round(EX/10)+1, ny=Math.round(EY/5)+1;
    const acc=new Float32Array(nx*ny);
    for(let i=0;i<N;i++){
      const g=F[i*5+3];
      if(g<planCutBuilt-1e-9 || g<GRADE_FLOOR-1e-9) continue;
      const gx=Math.round(F[i*5]/10), gy=Math.round(F[i*5+1]/5);
      if(gx<0||gx>=nx||gy<0||gy>=ny) continue;
      acc[gy*nx+gx]+=g*5;                 // grade x 5 m block height
    }
    const sorted=Array.from(acc).filter(v=>v>0).sort((a,b)=>a-b);
    GT_MAX=sorted.length?sorted[Math.floor(sorted.length*0.985)]:1;
    const cv=document.createElement('canvas'); cv.width=nx; cv.height=ny;
    const cx=cv.getContext('2d');
    const img=cx.createImageData(nx,ny);
    for(let y=0;y<ny;y++) for(let x=0;x<nx;x++){
      const v=acc[y*nx+x];
      // image row 0 is north, grid row 0 is south
      const o=(((ny-1-y)*nx)+x)*4;
      if(v<=0){ img.data[o+3]=0; continue; }
      const c=gtColor(Math.min(1,v/GT_MAX));
      img.data[o]=c[0]; img.data[o+1]=c[1]; img.data[o+2]=c[2];
      // Low columns must be near-invisible, not a 47% wash. A floor of 120 put
      // a pale haze over the whole footprint — the same blanket problem the
      // map was built to remove, just flatter.
      const u=Math.min(1,v/GT_MAX);
      img.data[o+3]=Math.round(18+232*Math.pow(u,0.7));
    }
    cx.putImageData(img,0,0);
    const sw2=proj4('EPSG:26910','WGS84',[EMIN-5,NMIN-2.5]);
    const ne2=proj4('EPSG:26910','WGS84',[EMIN+EX+5,NMIN+EY+2.5]);
    // A UTM grid is not exactly axis-aligned in geographic space, but over
    // 1.4 km the rotation is well under a block, so a rectangle is fine here.
    planLayer=viewer.imageryLayers.addImageryProvider(
      new Cesium.SingleTileImageryProvider({
        url:cv.toDataURL('image/png'),
        rectangle:Cesium.Rectangle.fromDegrees(sw2[0],sw2[1],ne2[0],ne2[1]),
        tileWidth:nx, tileHeight:ny}));
    planLayer.alpha=0.88;
    return planLayer;
  }
  function showPlan(on){
    planOn=on;
    if(on) buildPlanMap();          // rebuilds itself if the cut-off moved
    if(planLayer) planLayer.show=on;
    $('gtleg').style.display=on?'flex':'none';
    if(on) $('gtleg').innerHTML='<span>Grade &times; thickness</span>'+
      [0,0.25,0.5,0.75,1].map(u=>{const c=gtColor(u);
        return '<div class="k"><span class="sw" style="background:rgb('+c.join(',')+')"></span></div>';}).join('')+
      '<span>0 \u2192 '+Math.round(GT_MAX)+' g\u00b7m</span>';
  }

  // ---- vein domain surfaces ----
  // Fetched rather than inlined: 2.3 MB of hull geometry does not belong in the
  // critical path for a viewer that opens on a slide. The service worker caches
  // it on first sight, so offline still works once the deck has been opened.
  let surfPrims=null, surfLoading=false, surfOn=false;
  const utmCache=new Map();
  function utm2cart(x,y,z){
    const k=x+','+y;
    let ll=utmCache.get(k);
    if(!ll){ ll=proj4('EPSG:26910','WGS84',[x,y]); utmCache.set(k,ll); }
    return Cesium.Cartesian3.fromDegrees(ll[0],ll[1],(EXAG===1?z:(CZ+(z-CZ)*EXAG))+GEOID);
  }
  async function buildSurfaces(){
    if(surfPrims||surfLoading) return surfPrims;
    surfLoading=true; setStat('loading vein surfaces…');
    let data;
    try{ data=await (await fetch('data/elk_surfaces.json')).json(); }
    catch(e){ setStat(''); surfLoading=false; toast('Vein surfaces unavailable',4000); return null; }
    const unb=s=>{const b=atob(s);const u=new Uint8Array(b.length);
      for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;};
    // The 3 g/t shell is translucent so the 8 g/t bonanza core reads INSIDE it.
    // Two opaque nested shells would show only the outer one, which is the same
    // mistake as hulling a low-grade envelope.
    const SHELL_COLOR={s30:'#E8433C', s80:'#E05CC8'};
    const SHELL_ALPHA={s30:0.50, s80:1.0};
    surfPrims=Object.keys(data).map((name,i)=>{
      const d=data[name];
      // int16 lattice offsets, exact because every vertex sits on a 2.5 m grid
      const vs=new Int16Array(unb(d.v));
      const ix=d.w?new Uint32Array(unb(d.i)):new Uint16Array(unb(d.i));
      const pos=new Float64Array(d.nv*3);
      for(let k=0;k<d.nv;k++){
        const c=utm2cart(d.o[0]+vs[k*3]*d.q, d.o[1]+vs[k*3+1]*d.q, d.o[2]+vs[k*3+2]*d.q);
        pos[k*3]=c.x; pos[k*3+1]=c.y; pos[k*3+2]=c.z;
      }
      let geom=new Cesium.Geometry({
        attributes:{position:new Cesium.GeometryAttribute({
          componentDatatype:Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute:3, values:pos})},
        indices:ix,
        primitiveType:Cesium.PrimitiveType.TRIANGLES,
        boundingSphere:Cesium.BoundingSphere.fromVertices(pos)});
      geom=Cesium.GeometryPipeline.computeNormal(geom);
      const prim=new Cesium.Primitive({
        geometryInstances:new Cesium.GeometryInstance({geometry:geom}),
        asynchronous:true, show:false,
        appearance:new Cesium.MaterialAppearance({
          flat:false, translucent:true, faceForward:true, closed:false,
          material:Cesium.Material.fromType('Color',{
            color:d.kind==='shell'
              ? Cesium.Color.fromCssColorString(SHELL_COLOR[name]||'#E8433C')
                  .withAlpha(SHELL_ALPHA[name]||0.6)
              : Cesium.Color.fromCssColorString(VEIN_COLORS[i%VEIN_COLORS.length]).withAlpha(0.55)
            })})});
      viewer.scene.primitives.add(prim);
      return {name:name, kind:d.kind, prim:prim, oz:d.oz, tonnes:d.tonnes,
              grade:d.grade, nt:d.nt};
    });
    surfLoading=false; setStat('');
    return surfPrims;
  }
  // 'veins' shows the sheeted structure, 'cores' the compact high-grade bodies.
  // There is deliberately no low-grade envelope shell: hulling the outer surface
  // of a 46-sheet deposit produces a smoother blob, not a clearer picture.
  async function showSurfaces(mode){
    if(mode) await buildSurfaces();
    if(!surfPrims) return;
    surfPrims.forEach(s=>{
      if(!mode){ s.prim.show=false; return; }
      if(mode==='cores') s.prim.show = s.kind==='shell';
      else s.prim.show = s.kind==='vein' && (vein===-1 || VEINS[vein]===s.name);
    });
  }

  // ---- site features: claims, infrastructure, roads, labels ----
  // Clamped to terrain rather than floated at a guessed elevation, so they sit
  // on the actual ground the deposit is under.
  let siteEnts=null, siteOn=false;
  function buildSite(){
    if(siteEnts||!SITE.areas) return siteEnts;
    siteEnts=[];
    const deg=r=>r.reduce((acc,c)=>{const ll=proj4('EPSG:26910','WGS84',c);acc.push(ll[0],ll[1]);return acc;},[]);
    (SITE.claims||[]).forEach(c=>siteEnts.push(viewer.entities.add({name:c.name,
      polyline:{positions:Cesium.Cartesian3.fromDegreesArray(deg(c.ring)),
        width:2.5,clampToGround:true,
        material:new Cesium.PolylineDashMaterialProperty({
          color:Cesium.Color.fromCssColorString('#F2C14E'),dashLength:26})}})));
    (SITE.areas||[]).forEach(a=>{
      // A pit is a hole, not a painted patch. Filling it flat put a pale slab
      // over the exact ground the plan view exists to show, which is the same
      // blobbiness the grade map was built to remove. Outline plus descending
      // bench rings reads as an excavation and leaves the terrain visible.
      const isPit=a.kind==='pit';
      if(!isPit){
        siteEnts.push(viewer.entities.add({name:a.name,
          polygon:{hierarchy:Cesium.Cartesian3.fromDegreesArray(deg(a.ring)),
            material:Cesium.Color.fromCssColorString(a.color).withAlpha(0.30),
            classificationType:Cesium.ClassificationType.TERRAIN}}));
      }
      siteEnts.push(viewer.entities.add({name:a.name,
        polyline:{positions:Cesium.Cartesian3.fromDegreesArray(deg(a.ring)),
          width:isPit?2.6:1.6,clampToGround:true,
          material:Cesium.Color.fromCssColorString(isPit?'#E4EAF0':a.color)
            .withAlpha(isPit?1:0.95)}}));
      if(isPit){
        const mx=a.ring.reduce((s,q)=>s+q[0],0)/a.ring.length;
        const my=a.ring.reduce((s,q)=>s+q[1],0)/a.ring.length;
        const NB=5, depth=240;
        for(let b=1;b<=NB;b++){
          const shrink=1-(b/NB)*0.66;
          const z=ZTOP+GEOID-(depth*b/NB);
          const pos=a.ring.map(c=>{
            const ll=proj4('EPSG:26910','WGS84',
              [mx+(c[0]-mx)*shrink, my+(c[1]-my)*shrink]);
            return Cesium.Cartesian3.fromDegrees(ll[0],ll[1],
              EXAG===1?z:(CZ+GEOID+(z-CZ-GEOID)*EXAG));});
          pos.push(pos[0]);
          siteEnts.push(viewer.entities.add({polyline:{positions:pos,width:1.8,
            arcType:Cesium.ArcType.NONE,
            material:Cesium.Color.fromCssColorString('#C7D0D8').withAlpha(0.9-b*0.11)}}));
        }
      }
    });
    (SITE.roads||[]).forEach(rd=>siteEnts.push(viewer.entities.add({name:rd.name,
      polyline:{positions:Cesium.Cartesian3.fromDegreesArray(deg(rd.path)),
        width:4,clampToGround:true,
        material:Cesium.Color.fromCssColorString('#E8B33C').withAlpha(0.9)}})));
    // Labels on leader lines, the way a map annotation reads.
    (SITE.labels||[]).forEach(l=>{
      const ll=proj4('EPSG:26910','WGS84',l.at);
      const base=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],ZTOP+GEOID-40);
      const tip=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],ZTOP+GEOID+(l.dz||250));
      siteEnts.push(viewer.entities.add({polyline:{positions:[base,tip],width:1,
        material:Cesium.Color.WHITE.withAlpha(.42),arcType:Cesium.ArcType.NONE}}));
      siteEnts.push(viewer.entities.add({position:tip,
        label:{text:l.name+(SITE_SYNTHETIC?'  (conceptual)':''),
          font:'500 13px Archivo, system-ui, sans-serif',
          fillColor:Cesium.Color.WHITE,showBackground:true,
          backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.82),
          backgroundPadding:new Cesium.Cartesian2(9,6),
          verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    });
    return siteEnts;
  }
  const showSite=on=>{ if(on) buildSite(); if(siteEnts) siteEnts.forEach(e=>e.show=on); };

  // ---- pinned scene captions ----
  // A caption that names a thing should sit next to the thing. A fixed bar at
  // the bottom of the frame makes the reader hunt for what it refers to.
  let pinEnt=null;
  function setPin(pin){
    if(pinEnt){ viewer.entities.remove(pinEnt); pinEnt=null; }
    if(!pin) return;
    const ll=proj4('EPSG:26910','WGS84',pin.at);
    pinEnt=viewer.entities.add({
      position:Cesium.Cartesian3.fromDegrees(ll[0],ll[1],
        (EXAG===1?ZTOP:(CZ+(ZTOP-CZ)*EXAG))+GEOID+(pin.dz||300)),
      label:{text:pin.text,font:'500 16px Archivo, system-ui, sans-serif',
        fillColor:Cesium.Color.WHITE,showBackground:true,
        backgroundColor:new Cesium.Color(0.10,0.11,0.12,0.90),
        backgroundPadding:new Cesium.Cartesian2(16,12),
        horizontalOrigin:Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance:Number.POSITIVE_INFINITY}});
  }

  // ---- mine-plan timeline ----
  // Conceptual pit stages as stacked shells: scrubbing the timeline shows how
  // the excavation would grow and deepen against the orebody it is chasing.
  // Every stage is invented; the warning banner covers it with the site layer.
  let stageEnts=null, stageIdx=-1;
  const STAGES=(SITE.stages||[]);
  function buildStages(){
    if(stageEnts||!STAGES.length) return stageEnts;
    stageEnts=STAGES.map(st=>{
      const deg=st.ring.reduce((acc,c)=>{const ll=proj4('EPSG:26910','WGS84',c);
        acc.push(ll[0],ll[1]);return acc;},[]);
      const ents=[];
      // benches: concentric rings stepping down, the way a pit actually reads
      const NB=5;
      for(let b=1;b<=NB;b++){
        const z=ZTOP+GEOID-(st.depth*b/NB);
        const shrink=1-(b/NB)*0.62;
        const pos=[];
        const mx=st.ring.reduce((s,q)=>s+q[0],0)/st.ring.length;
        const my=st.ring.reduce((s,q)=>s+q[1],0)/st.ring.length;
        for(let i=0;i<st.ring.length;i++){
          const c=st.ring[i];
          const ll=proj4('EPSG:26910','WGS84',[mx+(c[0]-mx)*shrink, my+(c[1]-my)*shrink]);
          pos.push(Cesium.Cartesian3.fromDegrees(ll[0],ll[1],EXAG===1?z:(CZ+GEOID+(z-CZ-GEOID)*EXAG)));
        }
        ents.push(viewer.entities.add({polyline:{positions:pos,width:2,
          arcType:Cesium.ArcType.NONE,
          material:Cesium.Color.fromCssColorString('#C7D0D8').withAlpha(0.85-b*0.09)}}));
      }
      ents.push(viewer.entities.add({
        polygon:{hierarchy:Cesium.Cartesian3.fromDegreesArray(deg),
          material:Cesium.Color.fromCssColorString('#AEB9C4').withAlpha(0.30),
          classificationType:Cesium.ClassificationType.TERRAIN}}));
      ents.forEach(e=>e.show=false);
      return ents;
    });
    return stageEnts;
  }
  function showStage(i){
    stageIdx=i; buildStages();
    if(!stageEnts) return;
    stageEnts.forEach((ents,k)=>ents.forEach(e=>e.show=(i>=0&&k<=i)));
    $('stagev').textContent=i<0?'none':(STAGES[i].year+' — '+STAGES[i].name+
      ' (' + STAGES[i].depth + ' m)');
    syncWarn();
  }

  // ---- depth reference grid ----
  // The single clearest way to say "this is underground" is to label how far
  // underground it is. Level rectangles every 100 m below the deposit's
  // outcrop, each tagged with its depth, give the eye a ruler to read the
  // model against — far more legible than any amount of shading.
  const DEPTH_STEP=100;
  let depthEnts=null, depthOn=true;
  function buildDepthGrid(){
    if(depthEnts) return depthEnts;
    depthEnts=[];
    const zAt=z=>EXAG===1?z:(CZ+(z-CZ)*EXAG);
    const pad=90;
    const corners=[[EMIN-pad,NMIN-pad],[EMIN+EX+pad,NMIN-pad],
                   [EMIN+EX+pad,NMIN+EY+pad],[EMIN-pad,NMIN+EY+pad]];
    for(let d=DEPTH_STEP; ZTOP-d>=ZBOT-DEPTH_STEP; d+=DEPTH_STEP){
      const z=zAt(ZTOP-d);
      const ring=corners.concat([corners[0]]).map(c=>toCart(c[0],c[1],z));
      depthEnts.push(viewer.entities.add({polyline:{
        positions:ring, width:1.5, arcType:Cesium.ArcType.NONE,
        material:new Cesium.PolylineDashMaterialProperty({
          color:new Cesium.Color(1,1,1,0.30), dashLength:18})}}));
      depthEnts.push(viewer.entities.add({
        position:toCart(EMIN+EX+pad,NMIN-pad,z),
        label:{text:d+' m',font:'500 12px "JetBrains Mono", monospace',
               fillColor:Cesium.Color.WHITE.withAlpha(.9),showBackground:true,
               backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.78),
               horizontalOrigin:Cesium.HorizontalOrigin.LEFT,
               pixelOffset:new Cesium.Cartesian2(8,0),
               disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    }
    return depthEnts;
  }
  const showDepth=on=>{ if(on) buildDepthGrid();
    if(depthEnts) depthEnts.forEach(e=>e.show=on); };

  // ---- state ----
  // 0.5 g/t is the house default everywhere: below it the low-grade halo
  // bridges the gaps between veins and the whole system merges into one mass.
  const CUT_DEFAULT=GRADE_FLOOR, CUT_DEFAULT_IDX=LADDER.indexOf(CUT_DEFAULT);
  let blocksOn=true;
  let mode='grade', cutIdx=CUT_DEFAULT_IDX, vein=-1, clsOn={0:true,1:true,2:true,3:true},
      cur=0, drills=false, playing=false, narrating=false, dwellTimer=null, restoring=false;
  const cutVal=()=>LADDER[cutIdx];
  // Vein-identity colouring needs geometry grouped by domain rather than by
  // (class, grade-bin), so it gets its own primitive set, built lazily once.
  let vgPrims=null;
  function buildVeinGroups(){
    if(vgPrims) return vgPrims;
    setStat('grouping by vein domain…');
    const by={};
    for(const r of RUNS) for(let i=r.s;i<r.s+r.n;i++){
      const k=VGROUP[M[i*2+1]]+'|'+r.b+'|'+r.d;
      (by[k]=by[k]||{g:VGROUP[M[i*2+1]],b:r.b,d:r.d,lo:r.lo,mid:r.mid,idx:[]}).idx.push(i);
    }
    vgPrims=Object.values(by).map(o=>{
      const pr=makePrim(o.idx,depthShade(Cesium.Color.fromCssColorString(VEIN_COLORS[o.g]).withAlpha(fade?0.85:1),o.d),o.mid);
      pr.show=false; viewer.scene.primitives.add(pr); return Object.assign({},o,{prim:pr});
    });
    return vgPrims;
  }
  const colorOf=g=>depthShade(mode==='grade'?ramp(g.mid,true):clsColor(g.c),g.d||0,true);

  // ONE authority for the fabricated-data banner. It previously lived in two
  // places — apply() and showStage() — and they did not know about each other,
  // so setting a pit stage then touching any other control left conceptual mine
  // geometry on screen with the warning switched off. Every fabricated layer
  // must be enumerated here, and nothing else may write to #synwarn.
  function syncWarn(){
    const parts=[];
    if(drills&&DRILL_SYNTHETIC) parts.push('drill data');
    if(siteOn&&SITE_SYNTHETIC) parts.push('site features');
    if(stageIdx>=0&&SITE_SYNTHETIC) parts.push('pit stages');
    const el=$('synwarn');
    el.classList.toggle('on',parts.length>0);
    if(parts.length) el.textContent='Synthetic '+parts.join(' + ')+
      ' — fabricated, not real results or a real mine plan';
  }

  function apply(){
    const cut=cutVal();
    const vis=g=>g.lo>=cut-1e-9 && g.lo>=GRADE_FLOOR-1e-9 && clsOn[g.c];
    const veinMode=mode==='vein';
    RUNS.forEach(r=>{ r.prim.show = blocksOn && !veinMode && vein===-1 && vis(r);
      r.prim.appearance.material.uniforms.color=colorOf(r); });
    if(veinMode){
      buildVeinGroups().forEach(o=>{ o.prim.show = blocksOn && vein===-1 && o.lo>=cut-1e-9 && o.lo>=GRADE_FLOOR-1e-9;
        o.prim.appearance.material.uniforms.color=depthShade(
          Cesium.Color.fromCssColorString(VEIN_COLORS[o.g]).withAlpha(fade?0.85:1),o.d||0); });
    } else if(vgPrims){ vgPrims.forEach(o=>o.prim.show=false); }
    if(vein!==-1) buildVein(vein).forEach(g=>{ g.prim.show=blocksOn&&vis(g);
      g.prim.appearance.material.uniforms.color=colorOf(g); });
    // Drop non-active vein sets rather than parking them hidden — cycling all
    // 46 would otherwise leave a second full copy of the model resident.
    Object.keys(veinPrims).forEach(v=>{ if(+v!==vein){
      veinPrims[v].forEach(g=>viewer.scene.primitives.remove(g.prim));
      delete veinPrims[v]; } });
    if(drills) buildDrills();
    showDrills(drills);
    showHi(hiOn&&drills);
    showDepth(depthOn);
    showSite(siteOn);
    showSurfaces(surfOn);
    showPlan(planOn);
    // Surfaces or a plan map both replace the block cloud rather than layer on
    // top of it — leaving the cubes underneath is what made plan views blobby.
    if(surfOn||planOn||sectAxis) RUNS.forEach(r=>{ if(r.prim) r.prim.show=false; });
    if(sectAxis) buildSection();
    if(sectPrims) sectPrims.forEach(o=>o.prim.show=blocksOn);
    syncWarn();

    readout(); syncHash();
  }

  // Numbers come from the exact per-bucket rollups, never from what is drawn.
  function readout(){
    const cut=cutVal(); let n=0,t=0,m=0;
    if(sectAxis && sectStat){
      $('r_t').textContent=sectStat.t?fmt(sectStat.t):'—';
      $('r_g').textContent=sectStat.t?(sectStat.m/sectStat.t).toFixed(2)+' g/t':'—';
      $('r_oz').textContent=sectStat.t?fmtoz(sectStat.m/G_PER_OZ):'—';
      $('r_n').textContent=sectStat.n.toLocaleString();
      $('r_nl').textContent='Blocks in slab';
      $('veincav').textContent='Totals are for the '+(SECT_HALF*2)+
        ' m section slab only, not the whole deposit.';
      return {t:sectStat.t,g:sectStat.t?sectStat.m/sectStat.t:0,
              oz:sectStat.m/G_PER_OZ,n:sectStat.n};
    }
    // All veins: use the vein-free table so "Blocks" is a distinct count.
    // Summing the share-weighted table instead would tally a block once per
    // domain it straddles — correct for tonnage, wrong for a block count.
    const src=vein===-1?BY_CB:BUCKETS;
    for(const b of src){
      if(LADDER[b.b]<cut-1e-9) continue;
      if(!clsOn[b.c]) continue;
      if(vein!==-1 && b.v!==vein) continue;
      // Hiding the halo removes blocks from the scene, so it must remove them
      // from the number too. Without this the readout over-reported the drawn
      // model by 0.92 Mt at the default view — and the whole claim of this tool
      // is that the figure matches the picture under every filter.
      if(LADDER[b.b] < GRADE_FLOOR-1e-9) continue;
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
    const bodyDrawn = blocksOn || surfOn || planOn;
    if(!bodyDrawn){
      $('veincav').textContent='Block model hidden. Figures still describe the '+
        'current selection \u2014 they are simply not being drawn.';
      return {t:t,g:t?m/t:0,oz:m/G_PER_OZ,n:n};
    }
    $('veincav').textContent = vein===-1 ? '' :
      'Shell shows blocks whose dominant domain is '+VEINS[vein]+
      '; tonnage above is share-weighted across all blocks touching it, so it counts more than is drawn.';
    return {t:t,g:t?m/t:0,oz:m/G_PER_OZ,n:n};
  }

  // ---- slide chapters ----
  function paintSlide(c){
    const s=c.slide, el=$('slide');
    if(!s){ el.classList.remove('on'); return; }
    $('s_ey').textContent=s.eyebrow||'';
    $('s_t').textContent=s.title||'';
    $('s_b').textContent=s.body||'';
    const st=$('s_stats'); st.innerHTML='';
    (s.stats||[]).forEach(x=>{
      const d=document.createElement('div');
      const k=document.createElement('div'); k.className='k'; k.textContent=x.k;
      const v=document.createElement('div'); v.className='v'; v.textContent=x.v;
      d.appendChild(k); d.appendChild(v); st.appendChild(d);});
    const tab=$('s_tab'); tab.innerHTML=''; tab.classList.toggle('on',!!s.table);
    (s.table||[]).forEach((row,ri)=>{
      const tr=document.createElement('tr');
      row.forEach(cell=>{ const td=document.createElement(ri?'td':'th');
        td.textContent=cell; tr.appendChild(td); });
      tab.appendChild(tr);});
    const ch=$('s_chart');
    ch.classList.toggle('on',!!s.chart);
    ch.innerHTML = s.chart && CHARTS[s.chart] ? CHARTS[s.chart]() : '';
    el.classList.add('on');
  }

  // Mirrors the #slide CSS onto a canvas so exports carry the same content the
  // audience saw. Hand-drawn rather than via a DOM-rasteriser to keep the build
  // dependency-free and offline-capable.
  function drawSlide(x,W,H,s){
    const S=W/1440;
    const g=x.createLinearGradient(0,0,W,0);
    g.addColorStop(0,'rgba(7,9,10,.96)'); g.addColorStop(.46,'rgba(7,9,10,.90)');
    g.addColorStop(.78,'rgba(7,9,10,.30)'); g.addColorStop(1,'rgba(7,9,10,0)');
    x.fillStyle=g; x.fillRect(0,0,W,H);
    const L=60*S; let y=H*0.30;
    const wrap=(txt,font,fill,size,lh,maxW)=>{
      x.font=font; x.fillStyle=fill;
      const words=String(txt||'').split(' '); let line='';
      for(const w of words){
        const test=line?line+' '+w:w;
        if(x.measureText(test).width>maxW && line){ x.fillText(line,L,y); y+=lh; line=w; }
        else line=test;
      }
      if(line){ x.fillText(line,L,y); y+=lh; }
    };
    x.textBaseline='alphabetic';
    if(s.eyebrow){
      x.font='500 '+(11*S)+'px "JetBrains Mono", monospace';
      x.fillStyle='#C99A3A';
      x.fillText(String(s.eyebrow).toUpperCase(),L,y); y+=34*S;
    }
    wrap(s.title,'800 '+(52*S)+'px Archivo, sans-serif','#EDEEEC',52*S,58*S,620*S);
    y+=16*S;
    wrap(s.body,''+(19*S)+'px Newsreader, Georgia, serif','#C6CAC5',19*S,30*S,600*S);
    y+=22*S;
    (s.stats||[]).forEach((st,i)=>{
      const cx=L+i*(170*S);
      x.font='500 '+(9.5*S)+'px "JetBrains Mono", monospace'; x.fillStyle='#8E948E';
      x.fillText(String(st.k).toUpperCase(),cx,y);
      x.font='700 '+(28*S)+'px Archivo, sans-serif'; x.fillStyle='#C99A3A';
      x.fillText(st.v,cx,y+32*S);
    });
    if(s.table){
      let ty=y+10*S;
      s.table.forEach((row,ri)=>{
        row.forEach((cell,ci)=>{
          x.font=(ri?'':'500 ')+(ri?14*S:9.5*S)+'px "JetBrains Mono", monospace';
          x.fillStyle=ri?(ci?'#EDEEEC':'#C6CAC5'):'#8E948E';
          x.fillText(ri?String(cell):String(cell).toUpperCase(),L+ci*(150*S),ty);
        });
        ty+=(ri?26:22)*S;
      });
    }
  }

  // Grade-tonnage: the first chart any technical reader asks for, and it falls
  // straight out of the rollups the readout already uses, so it cannot disagree
  // with the rest of the deck.
  function gradeTonnage(){
    const pts=LADDER.map(cut=>{
      let tn=0,m=0;
      for(const b of BY_CB){ if(LADDER[b.b]<cut-1e-9) continue; tn+=b.t; m+=b.m; }
      return {cut:cut, t:tn, g:tn?m/tn:0};
    }).filter(p=>p.t>0);
    const W=560,H=250,L=54,R=54,T=14,B=30;
    const maxT=Math.max(...pts.map(p=>p.t)), maxG=Math.max(...pts.map(p=>p.g));
    const X=i=>L+(W-L-R)*(i/(pts.length-1));
    const Yt=v=>T+(H-T-B)*(1-v/maxT);
    const Yg=v=>T+(H-T-B)*(1-v/maxG);
    const path=(f,acc)=>pts.map((p,i)=>(i?'L':'M')+X(i)+' '+f(acc(p))).join(' ');
    let s='<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" '+
      'aria-label="Grade-tonnage curve: tonnes and average grade above each cut-off">';
    for(let k=0;k<=4;k++){const y=T+(H-T-B)*k/4;
      s+='<line class="gl" x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'"/>';}
    s+='<line class="ax" x1="'+L+'" y1="'+(H-B)+'" x2="'+(W-R)+'" y2="'+(H-B)+'"/>';
    s+='<path d="'+path(Yt,p=>p.t)+'" fill="none" stroke="#C99A3A" stroke-width="2.5"/>';
    s+='<path d="'+path(Yg,p=>p.g)+'" fill="none" stroke="#17a89a" stroke-width="2.5" stroke-dasharray="5 4"/>';
    pts.forEach((p,i)=>{ if(i%3) return;
      s+='<text x="'+X(i)+'" y="'+(H-10)+'" text-anchor="middle">'+p.cut+'</text>'; });
    s+='<text x="'+L+'" y="'+(T+9)+'" text-anchor="start" fill="#C99A3A">'+
       (maxT/1e6).toFixed(1)+' Mt</text>';
    s+='<text x="'+(W-R)+'" y="'+(T+9)+'" text-anchor="end" fill="#17a89a">'+
       maxG.toFixed(1)+' g/t</text>';
    s+='<text x="'+((L+W-R)/2)+'" y="'+(H-10)+'" text-anchor="middle" opacity="0"> </text>';
    s+='</svg>';
    return s+'<div style="display:flex;gap:22px;margin-top:10px;font-family:\'JetBrains Mono\',monospace;font-size:10px;color:#8E948E">'+
      '<span><span style="color:#C99A3A">\u2014</span> tonnes above cut-off</span>'+
      '<span><span style="color:#17a89a">- -</span> average grade</span>'+
      '<span>x-axis: cut-off g/t AuEq</span></div>';
  }
  function veinContribution(){
    const oz={}; BUCKETS.forEach(b=>oz[b.v]=(oz[b.v]||0)+b.m/G_PER_OZ);
    const top=Object.keys(oz).map(k=>({n:VEINS[k],oz:oz[k]}))
      .sort((a,b)=>b.oz-a.oz).slice(0,10);
    const max=top[0].oz;
    let s='<div role="img" aria-label="Contained ounces by vein domain">';
    top.forEach(d=>{
      s+='<div style="display:flex;align-items:center;gap:10px;margin:7px 0">'+
        '<span style="width:64px;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:#C6CAC5">'+d.n+'</span>'+
        '<span style="flex:1;height:12px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden">'+
        '<span style="display:block;height:100%;width:'+(d.oz/max*100).toFixed(1)+'%;background:#C99A3A"></span></span>'+
        '<span style="width:78px;text-align:right;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:#EDEEEC">'+
        Math.round(d.oz).toLocaleString()+' oz</span></div>';
    });
    return s+'</div>';
  }
  const CHARTS={gradeTonnage:gradeTonnage, veinContribution:veinContribution};

  // ---- presenter ink ----
  // Live annotation over the 3D view: the thing a presenter reaches for when
  // someone asks "which part?". Strokes are stored in normalised coordinates
  // so they survive a window resize, and they clear on chapter change because
  // an annotation belongs to the moment it was drawn.
  const ink=$('ink'), ictx=ink.getContext('2d');
  let strokes=[], drawing=null, inkColor='#FF6A1F', inking=false;
  function inkResize(){
    const dpr=devicePixelRatio||1;
    ink.width=innerWidth*dpr; ink.height=innerHeight*dpr;
    ink.style.width=innerWidth+'px'; ink.style.height=innerHeight+'px';
    ictx.setTransform(dpr,0,0,dpr,0,0); inkRedraw();
  }
  function inkRedraw(){
    ictx.clearRect(0,0,innerWidth,innerHeight);
    ictx.lineCap='round'; ictx.lineJoin='round';
    for(const s of strokes){
      if(s.pts.length<2) continue;
      ictx.strokeStyle=s.c; ictx.lineWidth=s.w;
      ictx.shadowColor='rgba(0,0,0,.55)'; ictx.shadowBlur=4;
      ictx.beginPath();
      ictx.moveTo(s.pts[0][0]*innerWidth,s.pts[0][1]*innerHeight);
      for(let i=1;i<s.pts.length;i++) ictx.lineTo(s.pts[i][0]*innerWidth,s.pts[i][1]*innerHeight);
      ictx.stroke();
    }
    ictx.shadowBlur=0;
  }
  addEventListener('resize',inkResize); inkResize();
  const inkPt=e=>[e.clientX/innerWidth, e.clientY/innerHeight];
  ink.addEventListener('pointerdown',e=>{ if(!inking) return;
    ink.setPointerCapture(e.pointerId);
    drawing={c:inkColor,w:4,pts:[inkPt(e)]}; strokes.push(drawing);});
  ink.addEventListener('pointermove',e=>{ if(!drawing) return;
    drawing.pts.push(inkPt(e)); inkRedraw();});
  ink.addEventListener('pointerup',()=>{drawing=null;});
  ink.addEventListener('pointercancel',()=>{drawing=null;});
  function setInking(on){
    inking=on; ink.classList.toggle('arm',on);
    $('inkbar').classList.toggle('on',on);
    $('inkPen').classList.toggle('on',on);
  }
  $('datatoggle').onclick=()=>{
    const on=!document.body.classList.contains('datamode');
    setDataMode(on); $('datatoggle').textContent=on?'3D':'Text';};
  if(new URLSearchParams(location.search).get('data')==='1'){
    setDataMode(true); $('datatoggle').textContent='3D';
    $('intro').style.display='none';
  }
  $('provbtn').onclick=showProv;
  $('provclose').onclick=()=>$('prov').classList.remove('on');
  $('provcopy').onclick=()=>navigator.clipboard.writeText(provText())
    .then(()=>toast('Audit trail copied'),()=>toast('Copy failed'));
  addEventListener('keydown',e=>{ if(e.key==='Escape'){$('prov').classList.remove('on');
    $('inspect').classList.remove('on');} });
  $('i_close').onclick=()=>$('inspect').classList.remove('on');
  $('inkPen').onclick=()=>setInking(!inking);
  $('drawbtn').onclick=()=>setInking(!inking);
  $('inkUndo').onclick=()=>{strokes.pop();inkRedraw();};
  $('inkClear').onclick=()=>{strokes=[];inkRedraw();};
  document.querySelectorAll('.isw').forEach(sw=>{
    if(sw.dataset.c===inkColor) sw.classList.add('on');
    sw.onclick=()=>{inkColor=sw.dataset.c;
      document.querySelectorAll('.isw').forEach(x=>x.classList.toggle('on',x===sw));};});
  const inkClearAll=()=>{strokes=[];drawing=null;inkRedraw();};

  // ---- deep links ----
  let hashTimer=null;
  function syncHash(){
    if(restoring) return;
    // '-' rather than '' for "no classes selected": an empty value round-trips
    // through the ||'0123' default and would silently re-enable all four.
    const on=Object.keys(clsOn).filter(c=>clsOn[c]).join('')||'-';
    const h='#c='+cur+'&m='+mode+'&k='+cutIdx+'&v='+vein+'&s='+on+'&d='+(drills?1:0)+
            '&b='+(blocksOn?1:0);
    // Dragging the cut-off fires apply() per tick; replaceState instead of
    // location.replace keeps that off the navigation path entirely.
    clearTimeout(hashTimer);
    hashTimer=setTimeout(()=>history.replaceState(null,'',h),200);
  }
  function readHash(){
    const h=new URLSearchParams(location.hash.slice(1));
    if(!h.has('c')) return null;
    return {c:+h.get('c')||0, m:(['class','vein'].indexOf(h.get('m'))>=0?h.get('m'):'grade'), k:h.has('k')?Math.max(CUT_DEFAULT_IDX,Math.min(LADDER.length-1,+h.get('k'))):CUT_DEFAULT_IDX,
            v:+h.get('v'), s:h.has('s')?h.get('s'):'0123', d:h.get('d')==='1',
            b:h.has('b')?h.get('b')==='1':true};
  }

  // ---- explore UI ----
  function setMode(m){
    mode=m;
    $('modeseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.m===m));
    $('gradeleg').style.display=m==='grade'?'flex':'none';
    $('clsleg').style.display=m==='class'?'flex':'none';
    $('veinleg').style.display=m==='vein'?'flex':'none';
  }
  function setCut(i){cutIdx=Math.max(CUT_DEFAULT_IDX,i);i=cutIdx;$('cut').value=i;$('cutv').textContent=cutVal().toFixed(2)+' g/t';}
  function setDrills(on){
    drills=on;
    $('drillseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',(x.dataset.d==='1')===on));
  }
  setCut(cutIdx);
  $('cut').oninput=e=>{setCut(+e.target.value);apply();};
  $('modeseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{setMode(b.dataset.m);apply();});
  $('hiseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    hiOn=b.dataset.h==='1';
    $('hiseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    if(hiOn&&!drills) setDrills(true);
    apply();});
  $('stage').max=String(STAGES.length-1);
  $('stage').oninput=e=>showStage(+e.target.value);
  const sectFrom=pct=>sectAxis==='ns' ? EMIN+EX*pct/100 : NMIN+EY*pct/100;
  // Moving any economic input re-derives the cut-off and drives the model with
  // it, so the picture and the economics can never describe different deposits.
  function applyEcon(sync){
    const e=paintEcon();
    if(sync!==false){
      let i=0; for(let k=0;k<LADDER.length;k++) if(LADDER[k]<=e.be+1e-9) i=k;
      setCut(Math.max(CUT_DEFAULT_IDX,i));
      apply();
    }
  }
  $('blockseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    blocksOn=b.dataset.b==='1';
    $('blockseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    apply();});
  $('e_price').oninput=e=>{ECON.price=+e.target.value;
    $('e_pricev').textContent='$'+ECON.price.toLocaleString(); applyEcon();};
  $('e_cost').oninput=e=>{ECON.cost=+e.target.value;
    $('e_costv').textContent='$'+ECON.cost; applyEcon();};
  $('e_rec').oninput=e=>{ECON.rec=(+e.target.value)/100;
    $('e_recv').textContent=e.target.value+'%'; applyEcon();};
  $('e_inf').onclick=()=>{ECON.inferred=!ECON.inferred;
    $('e_inf').classList.toggle('on',ECON.inferred); applyEcon();};
  $('sectseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    $('sectseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    const ax=b.dataset.x||null;
    sectAxis=ax;
    setSection(ax, ax?sectFrom(+$('sect').value):undefined);
    apply();});
  $('sect').oninput=e=>{ if(!sectAxis) return; setSection(sectAxis,sectFrom(+e.target.value)); };
  $('planseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    planOn=b.dataset.l==='1';
    $('planseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    apply();});
  $('surfseg').querySelectorAll('button').forEach(b=>b.onclick=async()=>{
    surfOn=b.dataset.f||'';
    $('surfseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    apply();});
  $('popseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    setPop(b.dataset.p==='1');
    $('popseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));});
  $('siteseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    siteOn=b.dataset.s==='1';
    $('siteseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    apply();});
  $('depthseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    depthOn=b.dataset.g==='1';
    $('depthseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    showDepth(depthOn);});
  function setGround(a){
    groundAlpha=a;
    viewer.scene.globe.translucency.frontFaceAlpha=a;
    // With the ground intact the deposit must draw over it, or it disappears
    // inside the mountain entirely.
    viewer.scene.globe.depthTestAgainstTerrain=a<0.9;
    $('ground').value=Math.round(a*100);
    $('groundv').textContent=a===0?'cut away':Math.round(a*100)+'%';
  }
  $('ground').oninput=e=>setGround((+e.target.value)/100);
  $('exagseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    const k=parseFloat(b.dataset.x); if(k===EXAG) return;
    $('exagseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    EXAG=k; setStat('rebuilding at '+k+'x…');
    // Stretching Z moves every block, so geometry must be rebuilt. Terrain is
    // stretched about the same datum so the two stay registered.
    viewer.scene.verticalExaggeration=k;
    viewer.scene.verticalExaggerationRelativeHeight=CZ+GEOID;
    buildPositions();
    if(vgPrims){ vgPrims.forEach(o=>viewer.scene.primitives.remove(o.prim)); vgPrims=null; }
    Object.keys(veinPrims).forEach(v=>{ veinPrims[v].forEach(g=>viewer.scene.primitives.remove(g.prim));
      delete veinPrims[v]; });
    if(drillEnts){ drillEnts.forEach(e=>viewer.entities.remove(e)); drillEnts=null; }
    if(hiEnts){ hiEnts.forEach(e=>viewer.entities.remove(e)); hiEnts=null; }
    if(surfPrims){ surfPrims.forEach(s=>viewer.scene.primitives.remove(s.prim));
      surfPrims=null; utmCache.clear(); }
    if(depthEnts){ depthEnts.forEach(e=>viewer.entities.remove(e)); depthEnts=null; }
    clearSection();
    // These bake EXAG into static Cartesians at build time, so they detach from
    // the stretched terrain unless they are rebuilt too.
    if(siteEnts){ siteEnts.forEach(e=>viewer.entities.remove(e)); siteEnts=null; }
    if(stageEnts){ stageEnts.forEach(es=>es.forEach(e=>viewer.entities.remove(e))); stageEnts=null; }
    buildBase(); apply(); if(stageIdx>=0) showStage(stageIdx); setStat('');});
  $('drillseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{setDrills(b.dataset.d==='1');apply();});
  // Legends are built from the same tables that colour the geometry, so they
  // cannot drift out of step with what is on screen.
  const key=(css,label)=>'<div class="k"><span class="sw" style="background:'+css+
    '"></span><span>'+label+'</span></div>';
  $('gradeleg').innerHTML='<span>AuEq g/t</span>'+TIERS.map(T=>key(T.css,T.label)).join('');
  $('veinleg').innerHTML='<span>Domain</span>'+VGROUP_NAMES.map((n,i)=>key(VEIN_COLORS[i],n)).join('');
  // Built from DEPTH_MIX, which is what actually shades the blocks. It used to
  // map DEPTH_ALPHA — all 1.0 since shells went solid — so it rendered six
  // identical swatches and decoded nothing.
  const hazeMix=k=>{const b={r:0x8f,g:0xd6,b:0xcf};
    const m=c=>Math.round(c*(1-k)+ (k===0?c:[14,19,27][0])*0);
    const r=Math.round(b.r*(1-k)+0.055*255*k), gg=Math.round(b.g*(1-k)+0.075*255*k),
          bb=Math.round(b.b*(1-k)+0.105*255*k);
    return 'rgb('+r+','+gg+','+bb+')';};
  $('depthleg').innerHTML='<span>Depth</span>'+DEPTH_MIX.map(k=>
    '<div class="k"><span class="sw" style="background:'+hazeMix(k)+'"></span></div>').join('')+
    '<span>0 \u2192 '+(DEPTH_MIX.length*70)+' m</span>';
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
  // ---- ground-level site view ----
  // The remote-walkthrough equivalent: stand on the ridge above the deposit and
  // look around, rather than always orbiting it from the air. Rendered from the
  // same real terrain, so it is a view of the actual place, not stand-in
  // photography of somewhere else.
  var ground3d=false, savedFrame=null;
  $('sitebtn').onclick=()=>{
    ground3d=!ground3d;
    $('sitebtn').classList.toggle('on',ground3d);
    if(ground3d){
      stop();
      savedFrame=cur;
      if(!siteOn){ siteOn=true;
        document.querySelectorAll('#siteseg button').forEach(x=>
          x.classList.toggle('on',x.dataset.s==='1'));
        apply(); }
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      const ll=proj4('EPSG:26910','WGS84',[EMIN-160,NMIN-160]);
      viewer.camera.flyTo({
        destination:Cesium.Cartesian3.fromDegrees(ll[0],ll[1],ZTOP+GEOID+55),
        orientation:{heading:rad(46),pitch:rad(-11),roll:0},
        duration:REDUCED?0:2.4});
      setGround(1.0);
      toast('Site view — drag to look around, scroll to move',3800);
    } else {
      go(savedFrame===null?cur:savedFrame);
    }
  };
  $('sharebtn').onclick=()=>{syncHash();
    navigator.clipboard.writeText(location.href).then(()=>toast('Link copied'),()=>toast('Copy failed'));};

  // ---- chapters ----
  const rail=$('rail');
  let lastSection=null;
  CHAPTERS.forEach((c,i)=>{
    if(c.section && c.section!==lastSection){
      lastSection=c.section;
      const h=document.createElement('div'); h.className='sec';
      h.textContent=c.section; rail.appendChild(h);
    }
    const d=document.createElement('div'); d.className='c';
    const num=document.createElement('span'); num.className='num';
    num.textContent=String(i+1).padStart(2,'0');
    const th=document.createElement('span'); th.className='th';
    if(THUMBS[i]) th.style.backgroundImage='url('+THUMBS[i]+')';
    if(c.slide) th.classList.add('isslide');
    const tt=document.createElement('span'); tt.className='t';
    tt.textContent=(c.slide?c.slide.title:c.title)||('Chapter '+(i+1));
    d.appendChild(num); d.appendChild(th); d.appendChild(tt);
    d.onclick=()=>{stop();go(i);}; rail.appendChild(d);});
  const railItems=[].slice.call(rail.querySelectorAll('.c'));

  function frameFor(c,animate){
    const hpr=new Cesium.HeadingPitchRange(rad(c.h),rad(c.p),c.r);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if(animate&&!REDUCED) viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center,RADIUS),
      {offset:hpr,duration:2.3,complete:()=>viewer.camera.lookAt(center,hpr)});
    else viewer.camera.lookAt(center,hpr);
  }
  function paintUI(){
    const c=CHAPTERS[cur];
    paintSlide(c);
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
    // fall through to index 0 and reveal the entire model. A chapter that
    // declares no cut-off at all (slide chapters) is a different case — it
    // means "no opinion", not "hide everything", so fall back to the default.
    const want=Math.max(CUT_DEFAULT,(c.cut===undefined||c.cut===null)?CUT_DEFAULT:c.cut);
    const ci=LADDER.findIndex(v=>v>=want); setCut(ci<0?LADDER.length-1:ci);
    setMode(c.mode||'grade');
    setDrills(!!c.drills);
    if(c.section3d){
      sectAxis=c.section3d;
      const pct=c.sectionAt===undefined?50:c.sectionAt;
      $('sect').value=pct;
      setSection(sectAxis,sectFrom(pct));
    } else if(sectAxis){ sectAxis=null; setSection(null); }
    $('sectseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.x||null)===(sectAxis||null)));
    planOn=!!c.plan;
    $('planseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.l==='1')===planOn));
    if(c.site!==undefined){ siteOn=!!c.site;
      $('siteseg').querySelectorAll('button').forEach(x=>
        x.classList.toggle('on',(x.dataset.s==='1')===siteOn)); }
    blocksOn=c.blocks!==false;
    $('blockseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.b==='1')===blocksOn));
    surfOn=c.surfaces||'';
    $('surfseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.f||'')===surfOn));
    hiOn=!!c.highlights;
    $('hiseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.h==='1')===hiOn));
    vein=-1; vsel.value='-1';
    // Reset first, THEN honour any per-chapter selection — the reset used to run
    // afterwards and silently undid it, so every reveal step showed all classes.
    Object.keys(clsOn).forEach(k=>{clsOn[k]=!c.classes || c.classes.indexOf(+k)>=0;});
    chips.querySelectorAll('.chip').forEach(el=>el.classList.toggle('on',clsOn[el.dataset.c]));
    inkClearAll();
    setPin(c.pin);
    if(stageIdx>=0){ showStage(-1); $('stage').value=-1; }
    // Navigating away ends the ground view; leaving the flag set made the Site
    // button jump the user to a chapter they never asked for.
    if(ground3d){ ground3d=false; $('sitebtn').classList.remove('on'); }
    viewer.scene.globe.depthTestAgainstTerrain=true;
    // Cutting the ground away is a deliberate beat, not a permanent state:
    // overhead shots read better with the mountain intact and the deposit shown
    // through it, and the cut earns its impact when the subsurface is the point.
    const ga=(c.ground===undefined)?groundAlpha:c.ground;
    setGround(ga);
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
    else if(e.key==='d'||e.key==='D') setInking(!inking);
    else if((e.metaKey||e.ctrlKey)&&e.key==='z'){ strokes.pop(); inkRedraw(); }
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
        // Presenter ink lives on its own canvas, so composite it in or an
        // exported still would silently drop what was drawn on screen.
        if(strokes.length){
          const sx=c.width/innerWidth, sy=c.height/innerHeight;
          x.lineCap='round'; x.lineJoin='round';
          for(const s of strokes){ if(s.pts.length<2) continue;
            x.strokeStyle=s.c; x.lineWidth=s.w*sx; x.beginPath();
            x.moveTo(s.pts[0][0]*c.width,s.pts[0][1]*c.height);
            for(let i=1;i<s.pts.length;i++) x.lineTo(s.pts[i][0]*c.width,s.pts[i][1]*c.height);
            x.stroke(); }
        }
        // Slide chapters are a DOM overlay, so the WebGL grab misses them
        // entirely — the two most numerically loaded slides were exporting as
        // bare terrain. Draw them into the bitmap.
        const chNow=CHAPTERS[cur];
        if(chNow && chNow.slide) drawSlide(x,c.width,c.height,chNow.slide);
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
        const fabricated=(drills&&DRILL_SYNTHETIC)||(siteOn&&SITE_SYNTHETIC)||
                         (stageIdx>=0&&SITE_SYNTHETIC);
        if(fabricated){
          const warn=$('synwarn').textContent.toUpperCase();
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
        const ch=CHAPTERS[i];
      // Slide chapters carry their text under .slide; passing undefined here
      // threw jsPDF on the first iteration and killed the whole PDF export.
      shots.push({title:(ch.slide?ch.slide.title:ch.title)||'',
                  body:(ch.slide?ch.slide.body:ch.body)||'',
                  img:await grab(), stats:s});
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
  // Recomputed per export rather than fixed at load: the footer has to describe
  // what is actually on the slide, not what might be.
  function foot(){
    const f=[];
    if(drills&&DRILL_SYNTHETIC) f.push('drill holes');
    if(siteOn&&SITE_SYNTHETIC) f.push('site features');
    if(stageIdx>=0&&SITE_SYNTHETIC) f.push('pit stages');
    return (CLASS_CONFIRMED?'':'Resource class labels unconfirmed. ')+
      'Illustrative visualization — not a mineral resource statement.'+
      (f.length?' SYNTHETIC, fabricated: '+f.join(', ')+'.':'');
  }

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
        sl.addText(foot(),{x:0.5,y:5.32,w:8.5,h:0.34,fontSize:10,color:'C6CAC5',fontFace:'Arial'});
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
        doc.text(doc.splitTextToSize(foot(),880),40,512);
      });
      doc.save('Elk-Gold-Siwash-North.pdf');
      toast('PDF saved');
    }catch(e){ toast('PDF failed: '+e.message,5000); }
  };

  setPop(true);
  paintEcon();

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
    blocksOn=st.b;
    $('blockseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.b==='1')===blocksOn));
    restoring=false;
    apply();
    $('intro').style.display='none';
  } else {
    go(0,true);
  }
  $('load').style.display='none';
  $('begin').onclick=()=>{$('intro').style.opacity='0';setTimeout(()=>$('intro').style.display='none',800);
    frameFor(CHAPTERS[0],true); if(EMBED&&!REDUCED) play();};
  // ---- offline ----
  if('serviceWorker' in navigator && location.protocol!=='file:'){
    navigator.serviceWorker.register('sw.js').then(reg=>{
      // Cache-first means a returning viewer would otherwise run the previous
      // build for the whole session — bad on a tool that quotes tonnage.
      reg.addEventListener('updatefound',()=>{
        const w=reg.installing;
        if(w) w.addEventListener('statechange',()=>{
          if(w.state==='installed'&&navigator.serviceWorker.controller)
            toast('Updated build available — reload to apply',7000);});
      });
      const paint=()=>{ const on=navigator.onLine;
        $('offline').textContent=on?'':'Offline — running from cache';
        $('offline').classList.toggle('on',!on); };
      addEventListener('online',paint); addEventListener('offline',paint); paint();
    }).catch(()=>{});
  }

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

# Chapter thumbnails captured from a previous build by tools/capture_thumbs.py.
# Absent on a first build; the rail falls back to plain tiles until then.
_thumbs_p = ROOT / "tools" / "assets" / "thumbs.json"
THUMBS = json.loads(_thumbs_p.read_text()) if _thumbs_p.exists() else {}


def js(o):
    """JSON for embedding in a <script> block: '</' would close the tag early."""
    return json.dumps(o).replace("</", "<\\/")


for k, v in {
    "__FONTS__": FONTS,
    "__B64__": b64, "__META__": b64m, "__N__": str(N), "__RAMPMAX__": f"{RAMPMAX}",
    "__EMIN__": f"{EMIN:.1f}", "__NMIN__": f"{NMIN:.1f}", "__CE__": f"{cE:.1f}",
    "__CN__": f"{cN:.1f}", "__CZ__": f"{cZ:.1f}", "__EX__": f"{EX:.0f}", "__EY__": f"{EY:.0f}",
    "__ZTOP__": f"{ZTOP:.0f}", "__ZBOT__": f"{ZBOT:.0f}",
    "__CHAPTERS__": js(CHAPTERS),
    "__RUNS__": js([{k2: r[k2] for k2 in ("c", "b", "d", "lo", "hi", "s", "n")} for r in RUNS]),
    "__BUCKETS__": js(BUCKETS),
    "__BY_CB__": js(BY_CB),
    "__THUMBS__": js(THUMBS),
    "__PROV__": js({
        "source": stats.get("source"),
        "scanned_rows": stats.get("scanned_rows"),
        "mineralized_blocks": stats["total"]["blocks"],
        "dropped_blocks": stats.get("dropped_blocks", 0),
        "straddlers": stats.get("blocks_straddling_multiple_domains", 0),
        "block_m3": stats.get("block_m3"),
        "density": stats.get("density"),
        "tonnes_per_block": stats.get("tonnes_per_block"),
        "total": stats["total"],
        "by_class": stats["by_class"],
        "class_confirmed": stats.get("class_mapping_confirmed", False),
        "drills_synthetic": DRILL_SYNTHETIC,
        "site_synthetic": SITE_SYNTHETIC,
    }),
    "__VGROUP__": js(VGROUP),
    "__VGROUP_NAMES__": js(VGROUP_NAMES),
    "__VEINS__": js(VEINS),
    "__LADDER__": js(LADDER),
    "__CLASS_LABELS__": js(CLASS_LABELS),
    "__CLASS_CONFIRMED__": "true" if stats.get("class_mapping_confirmed") else "false",
    "__HOLES__": js(HOLES),
    "__HIGHLIGHTS__": js(HIGHLIGHTS),
    "__SITE__": js(SITE),
    "__SITE_SYNTHETIC__": "true" if SITE_SYNTHETIC else "false",
    "__DRILL_SYNTHETIC__": "true" if DRILL_SYNTHETIC else "false",
}.items():
    HTML = HTML.replace(k, v)

# Offline: presentations get given in basements, core sheds and mine sites with
# no signal. A runtime-caching service worker means a deck opened once on the
# hotel wifi still runs with the aeroplane mode on. Cesium pulls its workers,
# shaders and imagery lazily, so cache-on-first-sight beats trying to enumerate
# a precache list that would rot on every Cesium bump.
SW = """// Orebody offline cache. Generated by tools/build_present.py.
const CACHE='orebody-v__SWVER__';
self.addEventListener('install',e=>{self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));});
// Tiles are effectively unbounded, so the cache is capped and trimmed FIFO.
// Opaque responses are NOT cached: their status is always 0, so an opaque 404
// would be stored as a permanent success that can never be corrected, and they
// are padding-inflated against the storage quota.
const MAX_ENTRIES=1200;
let writes=0;
async function trim(){
  const c=await caches.open(CACHE);
  const ks=await c.keys();
  if(ks.length<=MAX_ENTRIES) return;
  for(const k of ks.slice(0, ks.length-MAX_ENTRIES)) await c.delete(k);
}
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET') return;
  e.respondWith(caches.match(r).then(hit=>{
    if(hit) return hit;
    return fetch(r).then(res=>{
      if(res && res.status===200 && res.type!=='opaque'){
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put(r,copy)).then(()=>{
          if(++writes%200===0) return trim();
        }).catch(()=>{});
      }
      return res;
    }).catch(()=>hit);
  }));
});
self.addEventListener('message',e=>{
  if(e.data==='usage'){
    caches.open(CACHE).then(c=>c.keys()).then(ks=>{
      e.source.postMessage({cached:ks.length});});
  }
});
"""
import hashlib
SWVER = hashlib.sha1(HTML.encode()).hexdigest()[:10]
OUT_SW.write_text(SW.replace("__SWVER__", SWVER))

OUT.write_text(HTML)
print(f"wrote {OUT.name} ({len(HTML)/1e6:.1f} MB) + {OUT_SW.name}")
print(f"  {N:,} blocks · {len(RUNS)} base primitives · {len(BUCKETS)} stat buckets")
print(f"  {len(VEINS)} vein domains · {len(CHAPTERS)} chapters · ramp max {RAMPMAX} g/t")
print(f"  {len(HOLES)} drill holes" + (" (SYNTHETIC)" if DRILL_SYNTHETIC else "") +
      f" · {sum(len(h['segs']) for h in HOLES)} assay intervals")
print(f"  total {stats['total']['tonnes']:,.0f} t @ {stats['total']['grade_gt']} g/t = {stats['total']['oz']:,.0f} oz")
