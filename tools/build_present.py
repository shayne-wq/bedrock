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
import csv, struct, base64, json, bisect, math, re
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

# ------------------------------------------------------- ground vantages
# VRIFY's decks carry 360° site photography. There is none for Siwash North,
# and fabricating a photosphere is the one thing on this project I would not
# do: a photograph reads as evidence before anyone reaches the caption, so an
# invented picture of a real place is the fabricated layer a label cannot
# rescue. What the deck does instead is stand the camera on the actual
# mountain — real terrain, real satellite imagery — at positions derived from
# the block model, and sweep the horizon. Nothing below is synthesised, which
# is why none of it joins the fabricated-data paths.
#
# Each station stands `dist` metres out from a target on a compass bearing and
# looks back at it, so the deposit is always in frame on arrival. The eye
# height is above local TERRAIN, sampled in the browser — a build-time guess
# from ZTOP puts the camera underground on the high side of the ridge.
_gsum = sum(r[3] for r in rows) or 1.0
_mcE = sum(r[0] * r[3] for r in rows) / _gsum        # metal-weighted centroid
_mcN = sum(r[1] * r[3] for r in rows) / _gsum
_hg = [r for r in rows if r[3] >= 8.0]               # bonanza blocks only
_hcE = sum(r[0] for r in _hg) / len(_hg) if _hg else _mcE
_hcN = sum(r[1] for r in _hg) / len(_hg) if _hg else _mcN


def _station(name, note, tE, tN, brg, dist, eye=40, pitch=-8):
    a = math.radians(brg)
    return {"name": name, "note": note,
            "e": round(tE + math.sin(a) * dist, 1),
            "n": round(tN + math.cos(a) * dist, 1),
            "heading": round((brg + 180.0) % 360.0, 1),
            "pitch": pitch, "eye": eye}


STATIONS = [
    _station("West flank", "Looking east across the strike of the veins.",
             _mcE, _mcN, 258, 820),
    _station("South ridge", "Looking north up the length of the system.",
             _mcE, _mcN, 188, 950, eye=55),
    _station("Over the core", "Close in on the bonanza shells, looking southeast.",
             _hcE, _hcN, 318, 430, eye=30, pitch=-14),
    _station("North end", "Looking south, down-dip and away.",
             _mcE, _mcN, 12, 880, eye=50),
]


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

N = len(rows)

# The block model travels as a FETCHED BINARY, not as base64 in the document.
#
# It used to be inlined, which made the page one self-contained artifact — and
# a 5.8 MB one, of which 4.5 MB was a base64 string literal. That string is
# parsed, retained as source, decoded into typed arrays, and only then freed.
# On an iPhone the result was Safari refusing the page a WebGL context while
# happily granting one to a bare canvas on the same device: WebGL worked, this
# page was simply too heavy to be given a drawing buffer. Externalising takes
# the document to roughly 1.3 MB.
#
# Format is OREB v1 — the same struct-of-arrays layout dashboard/lib/extract.js
# writes and unpackOreb() reads, so the demo now loads through exactly the path
# a customer's own upload takes. One loader, exercised by everything.
#
# Order is NOT the extractor's. These rows are already sorted by
# (class, bin, depth band) and RUNS are index ranges into that order, so the
# file must preserve it — hence writing `rows` as-is rather than re-deriving.
# Origin is [EMIN, NMIN, 0] so x and y come back relative (as the viewer's F
# expects) while z stays absolute.
_cols = [
    ("x", "Float32Array", 4, "<f", [r[0] - EMIN for r in rows]),
    ("y", "Float32Array", 4, "<f", [r[1] - NMIN for r in rows]),
    ("z", "Float32Array", 4, "<f", [r[2] for r in rows]),
    ("g", "Float32Array", 4, "<f", [r[3] for r in rows]),
    ("p", "Float32Array", 4, "<f", [r[4] for r in rows]),
    ("c", "Uint8Array", 1, "<B", [r[5] for r in rows]),
    ("v", "Uint16Array", 2, "<H", [r[6] for r in rows]),
]
_layout, _off = [], 0
for _n, _t, _a, _f, _arr in _cols:
    if _off % _a:
        _off += _a - (_off % _a)
    _layout.append({"name": _n, "type": _t, "offset": _off, "count": len(_arr)})
    _off += len(_arr) * _a
_hdr = json.dumps({"format": "orebody-blocks/1", "n": N,
                   "origin": [EMIN, NMIN, 0.0], "arrays": _layout},
                  separators=(",", ":")).encode()
_pad = (16 - ((16 + len(_hdr)) % 16)) % 16
_base = 16 + len(_hdr) + _pad
_blob = bytearray(_base + _off)
struct.pack_into(">I", _blob, 0, 0x4F524542)      # "OREB"
struct.pack_into("<I", _blob, 4, 1)
struct.pack_into("<I", _blob, 8, len(_hdr))
struct.pack_into("<I", _blob, 12, _base)
_blob[16:16 + len(_hdr)] = _hdr
for (_n, _t, _a, _f, _arr), _lay in zip(_cols, _layout):
    _pos = _base + _lay["offset"]
    for _v in _arr:
        struct.pack_into(_f, _blob, _pos, _v)
        _pos += _a
BLOCKS_BIN = ROOT / "data" / "elk_blocks.bin"
BLOCKS_BIN.write_bytes(bytes(_blob))

assert len(VEINS) <= 256, f"{len(VEINS)} vein domains exceeds the uint8 packing in META"
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

# ---------------------------------------------------------- real tenures
# The claim boundaries are the one layer here that is NOT invented: public BC
# mineral tenures, clipped by tools/fetch_bc_claims.py. They are kept separate
# from SITE precisely so they do not inherit its `synthetic` flag — a reader
# who can verify a tenure number should not see it captioned "conceptual".
#
# This split also narrows what the fabricated banner has to condemn: areas,
# roads and pit stages remain invented and remain labelled; claims no longer
# drag real geography into that sentence.
_tenure_p = ROOT / "data" / "bc_tenures_elk.geojson"
REAL_CLAIMS: list = []
CLAIMS_ATTRIB = ""
CLAIMS_SUBJECT = ""

if _tenure_p.exists():
    _tj = json.loads(_tenure_p.read_text())
    if _tj.get("synthetic") is True:                 # refuse to mislabel
        raise SystemExit("bc_tenures_elk.geojson is flagged synthetic — "
                         "it must not be drawn as real tenure")
    CLAIMS_ATTRIB = _tj.get("attribution", "")
    CLAIMS_SUBJECT = _tj.get("subject_owner") or ""
    for _f in _tj.get("features", []):
        _p = _f.get("properties") or {}
        _g = _f.get("geometry") or {}
        if _g.get("type") == "Polygon":
            _rings = _g.get("coordinates") or []
        elif _g.get("type") == "MultiPolygon":
            _rings = [r for poly in (_g.get("coordinates") or []) for r in poly]
        else:
            _rings = []
        for _r in _rings:
            if len(_r) < 3:
                continue
            REAL_CLAIMS.append({
                "name": _p.get("CLAIM_NAME") or str(_p.get("TENURE_NUMBER_ID") or "Tenure"),
                "tenure": _p.get("TENURE_NUMBER_ID"),
                "owner": (_p.get("OWNER_NAME") or "").strip(),
                "kind": _p.get("TENURE_TYPE_DESCRIPTION") or "",
                "ha": round(float(_p.get("AREA_IN_HECTARES") or 0), 1),
                # Whose ground this is. The issuer's tenure and a neighbour's
                # must never render alike: a deck that draws someone else's
                # claims in its own colour is claiming them.
                "subject": bool(_p.get("_subject")),
                "neighbour": bool(_p.get("_neighbour")),
                # Already WGS84 — no proj4 hop, unlike the UTM site features.
                "ll": [round(c, 6) for pt in _r for c in pt[:2]],
            })
DRILL_SYNTHETIC = bool(DRILL_MAN.get("synthetic", True)) if HOLES else False

# ------------------------------------------------------- second deposit
# The demo held one model, so "multi-deposit" was untestable — there was
# nothing to switch to. Nicola South is FABRICATED (tools/make_synthetic_
# deposit.py) and sits inside real tenure 516750, ~2.5 km south of Siwash
# North. It is loaded through the OREB v1 path a customer's own upload takes,
# not a private back door, so the format stays exercised.
#
# `synthetic` here drives BLOCKS_SYNTHETIC in the viewer, which is the gravest
# of the fabricated flags: not a decoration over real numbers but every tonne
# and gram in the readout invented. It joins all five labelling paths.
_dep_p = DRILLDIR / "SYNTHETIC_nicola_south.json"
DEPOSITS = [{
    "key": "siwash", "name": "Siwash North", "synthetic": False, "baked": True,
    "note": "Real Nov-2021 MineSight block model, 46 vein domains.",
}]
if _dep_p.exists():
    _dj = json.loads(_dep_p.read_text())
    if not _dj.get("synthetic"):
        raise SystemExit("SYNTHETIC_nicola_south.json is not flagged synthetic — "
                         "an invented deposit must never load unflagged")
    DEPOSITS.append({
        "key": "nicola",
        "name": _dj.get("name", "Nicola South"),
        "synthetic": True,
        "baked": False,
        "note": _dj.get("warning", ""),
        "bin": "data/synthetic/" + _dj["blocks_file"],
        "buckets": "data/synthetic/" + _dj["buckets_file"],
        "stats": _dj["stats"],
    })

# ---------------------------------------------------- fabricated geophysics
# A magnetic survey that was never flown. It is synthesised FROM the block
# model, so its anomaly sits over the deposit by construction — it restates
# what you can already see rather than corroborating it. Worse, real gold
# systems are frequently magnetite-DESTRUCTIVE and would read as a magnetic
# LOW, so this is not merely unverified, it may be the wrong shape entirely.
#
# It exists to prove the layer plumbing, and it is labelled in five places:
# the on-screen banner, the export burn-in, the export footer, the provenance
# report and the embed snippet. A sixth fabricated layer must join all five
# again — the banner alone is not enough, because exports and embeds leave the
# page and the banner does not go with them.
_geo_p = DRILLDIR / "SYNTHETIC_geophysics.json"
GEOPHYS: dict = {}
GEOPHYS_SYNTHETIC = False
if _geo_p.exists():
    _gj = json.loads(_geo_p.read_text())
    _ex = _gj.get("extent_utm") or {}
    if not all(_ex.get(k) is not None for k in ("emin", "nmin", "emax", "nmax")):
        raise SystemExit("SYNTHETIC_geophysics.json carries no extent_utm — a "
                         "raster with no georeference must not be draped on "
                         "terrain; re-run tools/make_synthetic_geophysics.py")
    GEOPHYS_SYNTHETIC = bool(_gj.get("synthetic", True))
    GEOPHYS = {
        # Left in UTM and converted to a geographic rectangle in the browser by
        # proj4, the same hop the plan map makes. One projection path means the
        # raster and the blocks cannot drift apart about where they are.
        "emin": _ex["emin"], "nmin": _ex["nmin"],
        "emax": _ex["emax"], "nmax": _ex["nmax"],
        "grid": int(_gj.get("grid", 320)),
        "dir": "data/synthetic/",
        "products": [{"key": p["key"], "label": p["label"],
                      "unit": p.get("unit", ""), "note": p.get("note", ""),
                      "file": p["file"]}
                     for p in _gj.get("products", [])],
    }

# Slide chapters sit in the same deck as the 3D scenes, so a presenter can move
# between corporate narrative and the model without leaving the tool. The 3D
# view stays live behind them - the deposit never disappears mid-story.
_T = stats["total"]
_M = stats["by_class"]
CHAPTERS = [
  {"h": 26, "p": -28, "r": 4200, "dwell": 9, "ground": 1.0, "slide": {
     "eyebrow": "The project",
     "section": "The project", "title": "Elk Gold - Siwash North",
     "body": "A drill-defined, high-grade gold system in the Nicola region of "
             "southern British Columbia, southeast of Merritt. Road-accessible, in an established mining region, and open at depth.",
     "stats": [{"k": "Contained AuEq", "v": f"{_T['oz']/1e6:.2f} Moz"},
               {"k": "Tonnes", "v": f"{_T['tonnes']/1e6:.2f} Mt"},
               {"k": "Grade", "v": f"{_T['grade_gt']} g/t"},
               {"k": "Vein domains", "v": str(len(VEINS))}]}},
  # Cut-offs across the deck are authored, not left at the floor.
  #
  # GRADE_FLOOR (0.5) draws essentially the whole mineralized envelope: 168k
  # blocks over 46 domains, every bin opaque. That reads as one solid mass and
  # the structure disappears. An opening scene wants the shape of the system,
  # not its full extent, so these sit above the floor and let the eye find the
  # sheets. Where a body line quotes a grade, the two move together — a chapter
  # that says "above half a gram" while rendering 1.5 g/t is worse than blobby,
  # it is wrong.
  # Opens on surfaces, not blocks.
  #
  # Blocks are voxels: at any cut-off they fuse into one opaque mass, because
  # every bin at or above the cut draws solid and the outer bin hides the rest.
  # Tested at 0.5, 1.5 and 3.0 g/t — the silhouette barely changes, only the
  # colour does. The vein hulls are what carry the northwest structural grain,
  # so the deck's first look at the deposit uses them. Blocks still get their
  # turn at "The orebody", which is where the blocks-then-surfaces contrast in
  # the next chapter's copy actually lands.
  {"h": 28, "p": -26, "r": 3600, "cut": 1.5, "xray": True, "mode": "grade", "dwell": 9,
   "ground": 1.0, "surfaces": "veins", "section": "The project", "title": "A high-grade gold system", "body": "The Elk Gold project sits in the Nicola region of southern British Columbia, southeast of Merritt — road-accessible, in an established mining district. The vein domains are drawn as solid bodies, so the structural grain of the system reads immediately."},
  {"h": 30, "p": -22, "r": 2500, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 9,
   "ground": 1.0, "section": "The ground", "title": "On real ground", "body": "Every block is placed at its true UTM position on real terrain — this is the actual mountain the deposit sits inside."},
  # The one chapter whose copy has to argue against its own picture. A layer
  # this suggestive is exactly where a deck stops being a visualization and
  # starts being a claim, so the body text says what it is before the audience
  # can read anything into it. The banner fires here too, by design.
  {"h": 0, "p": -78, "r": 2900, "cut": 1.0, "xray": False, "mode": "grade", "dwell": 11,
   # Blocks off: with the ground intact they draw over the terrain, and a
   # survey read through a cloud of grade cubes is neither map nor model.
   "ground": 1.0, "geo": "rtp", "site": True, "blocks": False, "section": "The ground",
   "title": "The magnetic picture", "body": "Reduced-to-pole magnetics draped over the property, with the tenure boundaries on top. This survey is FABRICATED — nothing was flown, and the field was synthesised from the block model itself, so the anomaly sits over the deposit because it was built from it. It shows how a real survey would sit in the deck; it is not evidence for anything."},
  {"h": 52, "p": -24, "r": 2600, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 11,
   "ground": 0.42, "section": "The ground", "title": "The orebody", "body": "Forty-six vein domains threading the ridge, drawn as the blocks they are modelled as. Above a gram the sheets separate and the northwest structural grain of the system becomes obvious."},
  {"h": 50, "p": -22, "r": 2100, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 12,
   "ground": 0.0, "surfaces": "veins", "section": "The deposit",
   "title": "The veins as bodies", "body": "The same domains drawn as solid geological surfaces rather than blocks \u2014 the hull of each vein, extracted face by face from the model so nothing is invented between the data points.",
   "pin": {"at": [693500, 5525400], "dz": 520, "text": "Eight largest vein domains"}},
  {"h": 58, "p": -34, "r": 2450, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 11,
   "ground": 0.0, "surfaces": "cores", "section": "The deposit", "title": "The high-grade core", "body": "The richest fifth of the blocks carry 78% of the metal. Raising the cut-off strips the rest away and leaves the bonanza shells that actually matter."},
  # Cumulative reveal: Measured, then +Indicated, then +Inferred, the way a
  # resource statement is actually presented rather than all at once.
  # The classification reveal holds one cut-off across all three so the only
  # thing changing between them is the category. Move the cut-off here and the
  # reveal stops being a comparison.
  {"h": 52, "p": -30, "r": 1900, "cut": 1.0, "xray": True, "mode": "class", "dwell": 9,
   "ground": 0.0, "classes": [1], "section": "The deposit",
   "title": "Measured only",
   "body": "The part of the deposit with the most drilling behind it, on its own."},
  {"h": 52, "p": -30, "r": 1900, "cut": 1.0, "xray": True, "mode": "class", "dwell": 9,
   "ground": 0.0, "classes": [1, 2], "section": "The deposit",
   "title": "Measured and Indicated",
   "body": "Adding Indicated. This is the material a study would normally be built on."},
  {"h": 52, "p": -30, "r": 1700, "cut": 1.0, "xray": True, "mode": "class", "dwell": 11,
   "ground": 0.0, "classes": [0, 1, 2, 3], "section": "The deposit", "title": "How well is it known?", "body": "Recoloured by resource classification. Confidence is not evenly distributed through a deposit — and this is the first question any technical reader asks."},
  # Drills-only, so the model comes off automatically here. A grade-coloured
  # body directly behind a grade-coloured bead is the reason.
  {"h": 38, "p": -24, "r": 1900, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 11, "drills": True,
   "ground": 0.0, "section": "Drilling & geometry", "title": "Drilled from surface", "body": "Drill traces coloured by assay grade, hung from their collars on the ridge above, with nothing else in the scene. Click any hole in the ledger to drop underground and read it end to end. These holes are synthetic — traced through the modelled grades."},
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
  # A section set, not a single section. One slice proves the mechanism; a
  # fence of them is how a geologist actually interrogates continuity, and it
  # is what the competing decks ship. The readout re-totals per slab, so each
  # of these reports its own contained metal rather than the whole deposit's.
  {"h": 90, "p": -30, "r": 2700, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 10,
   "ground": 0.0, "section3d": "ns", "sectionAt": 30,
   "section": "Drilling & geometry", "title": "Stepping the section west",
   "body": "The same slab moved 20% west along the deposit. The vein sheets persist across the step \u2014 continuity between sections is the thing a section set is drawn to test.",
   "pin": {"at": [693100, 5525400], "dz": 420, "text": "N\u2013S section, west"}},
  {"h": 0, "p": -26, "r": 2700, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 11,
   "ground": 0.0, "section3d": "ew", "sectionAt": 50,
   "section": "Drilling & geometry", "title": "Across the grain",
   "body": "An east\u2013west slab, cut perpendicular to the first. The veins are sectioned across their strike here rather than along it, which is what shows their true dip and how steeply the system stands.",
   "pin": {"at": [693500, 5525400], "dz": 420, "text": "E\u2013W section, \u00b145 m"}},
  {"h": 4, "p": -4, "r": 2650, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 10,
   "ground": 0.0, "section": "Drilling & geometry", "title": "In profile", "body": "Turned on edge, the veins persist to roughly 475 metres below surface — and remain open at depth."},
  {"h": 44, "p": -18, "r": 1500, "cut": 1.0, "xray": True, "mode": "grade", "dwell": 12,
   "ground": 0.0, "drills": True, "highlights": True,
   "section": "Drilling & geometry", "title": "The intercepts behind it", "body": "The headline hits, each labelled where it sits in three dimensions \u2014 the drill-release table, put back in the ground it came out of."},
  {"h": 26, "p": -27, "r": 3000, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 10,
   "ground": 0.0, "section": "Appendix", "title": "Explore it yourself", "body": "Forty-six vein domains, each one isolatable, each with its own grade and tonnage. Open Explore and interrogate the model directly."},
  # Property scale. Grade x thickness as a column per 40 m cell across the whole
  # land package, every deposit at once — the orientation shot that no
  # per-deposit view can give. Blacked out, because once the ground has been
  # established it only competes with the thing being measured.
  {"h": 18, "p": -27, "r": 6000, "cut": 0.5, "mode": "grade", "dwell": 13,
   "ground": 1.0, "property": True, "black": True, "blocks": False,
   "section": "The property", "title": "Where the metal is",
   "body": "One column per 40 m cell, across the whole property. Height and colour carry accumulated grade × thickness — gram-metres, the same quantity the plan-view map colours — so a tall bar is a long, rich intersection under that ground. Both deposits are in this view, and one of them is fabricated."},
  {"h": 26, "p": -18, "r": 4200, "cut": 0.5, "mode": "grade", "dwell": 13,
   "ground": 1.0, "property": True, "black": True, "blocks": False,
   "drills": True, "highlights": True, "callouts": True,
   "section": "The property", "title": "And where it was drilled",
   "body": "The same columns with the drill traces beneath them, assays as beads on each trace, and the headline intercepts called out to the edge of the frame. The holes are synthetic; the columns above them are not, except where they come from the fabricated deposit."},
  # The multi-deposit beat. Both chapters name the fabrication in their own
  # copy — the banner fires too, but a presenter reads the body text aloud and
  # the banner is not read aloud by anyone.
  {"h": 24, "p": -30, "r": 2600, "cut": 0.5, "xray": True, "mode": "grade", "dwell": 12,
   "ground": 0.0, "deposit": "nicola", "section": "A second deposit",
   "title": "Nicola South", "body": "A second orebody on the same property, 2.5 km south, inside tenure 516750. THIS DEPOSIT IS FABRICATED — there is no Nicola South. It exists so the multi-deposit view could be built and shown; every tonne and gram in the readout for it was generated, not measured."},
  {"h": 40, "p": -34, "r": 2400, "cut": 1.0, "xray": True, "mode": "class", "dwell": 11,
   "ground": 0.0, "deposit": "nicola", "section": "A second deposit",
   "title": "A different kind of deposit", "body": "Broad disseminated zones on a coarser 12 × 12 × 8 m lattice rather than Siwash North's narrow high-grade sheets on 10 × 5 × 5 m — more tonnes, less grade. The deck carries both models and the readout re-totals for whichever is loaded. Still fabricated."},
  {"h": 34, "p": -28, "r": 3000, "dwell": 12, "ground": 1.0, "deposit": "siwash", "section": "Appendix", "slide": {
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
<!-- Inline, not a file. Without it every load 404s on /favicon.ico — harmless
     but visible in the console of a deck embedded on a customer's site, and a
     separate .ico would break the promise that this page is one artifact you
     can copy anywhere. -->
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%23090c0d'/><path d='M5 23 L12 9 L17 18 L22 11 L27 23 Z' fill='%23C99A3A'/></svg>">
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

  /* pointer-events:none matters more than it looks. This bar is full width,
     several hundred pixels tall on a chapter with a long caption, and its top
     70px are a fully TRANSPARENT gradient — so it covered the lower half of
     the scene while appearing to cover nothing, and silently ate every click
     that landed there. Drawing an area below the midline did nothing. Clicking
     a block did nothing. Clicking a drill hole did nothing. The controls take
     their events back explicitly; the caption is prose and does not need them,
     and text selection is not worth half the scene. */
  #bar{position:fixed;left:0;right:0;bottom:0;z-index:6;padding:70px 34px 26px;
       background:linear-gradient(180deg,rgba(7,9,10,0) 0%,rgba(7,9,10,.72) 44%,rgba(7,9,10,.92) 100%);
       display:flex;align-items:flex-end;justify-content:space-between;gap:36px;transition:opacity .4s;
       pointer-events:none}
  #bar #nav,#bar #nav *{pointer-events:auto}
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
  .btn.rec{border-color:#D9584A;color:#D9584A}
  #recdot{display:none;width:8px;height:8px;border-radius:50%;background:#D9584A;
          margin-right:7px;vertical-align:middle;animation:recpulse 1.4s infinite}
  #recdot.on{display:inline-block}
  #rectime{margin-left:7px;letter-spacing:.06em}
  @keyframes recpulse{0%,100%{opacity:1}50%{opacity:.35}}
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
  #geoleg{display:none;gap:3px!important;align-items:center}
  #geoleg .sw{width:16px;height:10px;border-radius:1px}
  #propleg{display:none;gap:3px!important;align-items:center}
  #gcleg{display:none;gap:3px!important;align-items:center}
  #gcleg .sw{width:14px;height:10px;border-radius:1px}
  #propleg .sw{width:16px;height:10px;border-radius:1px}
  #assayleg{display:none;gap:7px!important;align-items:center}
  #assayleg .sw{width:12px;height:12px;border-radius:2px}

  /* Callout cards. The SVG sits under the cards and over the canvas, and
     neither takes pointer events — the scene stays draggable through them. */
  #calloutsvg{position:fixed;inset:0;z-index:7;pointer-events:none;display:none}
  #callouts{position:fixed;inset:0;z-index:8;pointer-events:none;display:none}
  body.calloutson #calloutsvg,body.calloutson #callouts{display:block}
  .cocard{position:absolute;background:rgba(12,15,16,.93);
          border:1px solid rgba(255,255,255,.16);border-radius:5px;
          padding:7px 11px;max-width:230px;backdrop-filter:blur(6px)}
  .cocard .coid{font-family:'JetBrains Mono',monospace;font-size:11px;
                letter-spacing:.06em;color:#EDEEEC;text-align:right}
  .cocard .cov{font-size:12px;color:#C6CAC5;text-align:right;margin-top:2px}
  .cocard .cov b{color:#F2C14E;font-weight:600}
  .cocard .coincl{font-size:11px;color:#8C948C;text-align:right;margin-top:2px}
  .cocard.left .coid,.cocard.left .cov,.cocard.left .coincl{text-align:left}
  .cocard .cosyn{font-family:'JetBrains Mono',monospace;font-size:8.5px;
                 letter-spacing:.1em;color:#D9584A;text-transform:uppercase;margin-top:3px}
  /* Red, and in the label rather than under it — a fabricated layer should not
     be selectable without reading the word. */
  .syntag{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.08em;
          color:#D9584A;border:1px solid rgba(217,88,74,.5);border-radius:3px;
          padding:1px 4px;margin-left:6px;text-transform:uppercase}
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
  /* Presenter cut-off. Sits inline with Back/Next so it reads as part of the
     deck controls, not as a settings escapee. Goes gold when held, because a
     presenter who has overridden the deck needs to see that they have. */
  /* Terrain opacity, beside the cut-off. Two ends as buttons and a slider
     between them: "show me the mountain" and "take it away" are the two a
     presenter asks for mid-sentence, and hunting a slider to an end is not
     something anyone does while talking. */
  #pgnd{display:flex;align-items:center;gap:7px;margin-right:14px;
        padding:0 12px 0 0;border-right:1px solid rgba(255,255,255,.14)}
  #pgnd .pl{font-family:'JetBrains Mono',monospace;font-size:10px;
            letter-spacing:.09em;text-transform:uppercase;color:#8A8F98}
  #pgndr{width:88px;accent-color:#C99A3A}
  #pgndv{font-family:'JetBrains Mono',monospace;font-size:11px;color:#EDEEEC;
         min-width:62px;text-align:right}
  #pgnd.held .pl{color:#C99A3A}
  @media (max-width:1100px){ #pgnd{display:none} }

  #pcut{display:flex;align-items:center;gap:8px;margin-right:14px;
        padding:0 12px 0 0;border-right:1px solid rgba(255,255,255,.14)}
  #pcut .pl{font-family:'JetBrains Mono',monospace;font-size:10px;
            letter-spacing:.09em;text-transform:uppercase;color:#8A8F98}
  #pcutr{width:104px;accent-color:#C99A3A}
  #pcutv{font-family:'JetBrains Mono',monospace;font-size:11px;color:#EDEEEC;
         min-width:58px;text-align:right}
  #pcut.held .pl,#pcut.held #pcutv{color:#C99A3A}
  #pcutx{margin-left:2px}
  @media (max-width:900px){#pcut{display:none}}
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
  body.datamode #scalebar,body.datamode #inspect,
  body.datamode #stbar{display:none!important}
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
  #emb{position:fixed;inset:0;z-index:15;display:none;align-items:center;justify-content:center;
    background:rgba(4,7,9,.72);backdrop-filter:blur(3px);padding:24px}
  #emb.on{display:flex}
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
  #emb .pinner{max-width:760px}
  #emb label{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
    color:rgba(255,255,255,.5);margin:14px 0 5px}
  #emb input[type=text],#emb select{width:100%;background:#080b0d;color:#e8edf0;
    border:1px solid rgba(255,255,255,.16);border-radius:4px;padding:7px 9px;
    font-family:'JetBrains Mono',monospace;font-size:11.5px}
  #emb .row{display:flex;gap:12px}
  #emb .row>div{flex:1}
  #emb .chk{display:flex;gap:16px;margin-top:12px;font-size:12px;color:rgba(255,255,255,.78)}
  #emb .chk label{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;
    letter-spacing:0;text-transform:none;color:inherit;cursor:pointer}
  #emb .chk input{accent-color:#6FCF57}
  #emb pre{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.6;
    background:#080b0d;border:1px solid rgba(255,255,255,.12);border-radius:4px;
    padding:10px;margin:6px 0 0;white-space:pre-wrap;word-break:break-all;
    max-height:150px;overflow:auto;color:#9fd8c8}
  #emb .foot{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
  #emb .note{font-size:11px;line-height:1.6;color:rgba(255,255,255,.45);margin-top:12px}
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

  /* Top-centre: the rail owns the left edge and #tools the right, and the
     ground view is the one mode where the bottom of the frame is the horizon
     you are trying to look at. */
  #stbar{position:fixed;left:50%;transform:translateX(-50%);top:118px;z-index:9;
         display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;
         background:rgba(7,9,10,.86);border:1px solid rgba(255,255,255,.10);
         border-radius:6px;padding:8px 12px;backdrop-filter:blur(6px);max-width:min(760px,92vw)}
  #stbar[hidden]{display:none}
  #stbar .pl{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.16em;
             text-transform:uppercase;color:#8C948C}
  #stnote{flex-basis:100%;text-align:center;font-size:11.5px;color:#8C948C;line-height:1.5}
  #st360.on{background:#C99A3A;color:#0d0f10;border-color:#C99A3A}
  @media (max-width:900px){ #stbar{top:auto;bottom:196px} }

  #authbar{position:fixed;left:50%;transform:translateX(-50%);top:118px;z-index:24;
           display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;
           background:rgba(9,12,13,.95);border:1px solid rgba(201,154,58,.45);
           backdrop-filter:blur(8px)}
  #authbar[hidden]{display:none}
  #authbar .pl{font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.16em;
               text-transform:uppercase;color:#C99A3A}
  #authch,#authnote{font-family:'JetBrains Mono',monospace;font-size:10.5px;color:#8C948C}
  #authnote{color:#7FB77E}
  @media (max-width:900px){ #authbar{display:none} }

  #ledger{position:fixed;left:34px;top:104px;z-index:10;width:308px;max-height:46vh;
          display:flex;flex-direction:column;border-radius:6px;
          background:rgba(9,12,13,.93);border:1px solid rgba(255,255,255,.12);
          backdrop-filter:blur(8px);overflow:hidden}
  #ledger[hidden],#holegraph[hidden]{display:none}
  body.ledgeron #rail{display:none}
  .lhead{display:flex;align-items:center;gap:8px;padding:10px 12px;
         border-bottom:1px solid rgba(255,255,255,.10)}
  .lhead>span:first-child{flex:1;font-family:'JetBrains Mono',monospace;font-size:10px;
         letter-spacing:.14em;text-transform:uppercase;color:#C99A3A}
  #ledglist{overflow-y:auto;overscroll-behavior:contain}
  .lrow{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:9px 12px;cursor:pointer;
        border-bottom:1px solid rgba(255,255,255,.05)}
  .lrow:hover{background:rgba(201,154,58,.12)}
  .lrow.on{background:rgba(201,154,58,.20)}
  .lrow .hid{font-family:'JetBrains Mono',monospace;font-size:11.5px;color:#EDEEEC;letter-spacing:.04em}
  .lrow .htd{font-family:'JetBrains Mono',monospace;font-size:10px;color:#8C948C}
  .lrow .hbest{grid-column:1/3;font-size:11.5px;color:#C6CAC5}
  .lrow .hbest b{color:#F2C14E;font-weight:600}
  #ledgnote{padding:8px 12px;font-size:10.5px;line-height:1.5;color:#8C948C;
            border-top:1px solid rgba(255,255,255,.08)}
  #holegraph{position:fixed;left:34px;bottom:118px;z-index:10;width:340px;
             border-radius:6px;background:rgba(9,12,13,.95);
             border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px)}
  #hgbody{padding:10px 12px 12px}
  #hgbody svg{display:block;width:100%;height:auto}
  #hgbody .hgcap{font-family:'JetBrains Mono',monospace;font-size:9.5px;color:#8C948C;
                 letter-spacing:.08em;margin-top:6px}

  /* Only ever visible when boot failed, so it can afford to be ugly and
     complete rather than pretty and partial. */
  #bootstack{position:fixed;left:0;right:0;bottom:0;max-height:46vh;overflow:auto;z-index:99;
             margin:0;padding:14px 18px;background:rgba(7,9,10,.97);color:#C6CAC5;
             border-top:2px solid #D9584A;font-family:'JetBrains Mono',monospace;
             font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}

  #loadwhy{margin-top:14px;font-family:'JetBrains Mono',monospace;font-size:11px;
           letter-spacing:.06em;color:#8C948C;max-width:min(560px,86vw);line-height:1.6}
  #loadact{margin-top:16px;display:none;gap:8px;justify-content:center;flex-wrap:wrap}
  #loadact.on{display:flex}

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
  #areabar{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:11;
           display:none;align-items:center;gap:8px;padding:8px 12px;border-radius:5px;
           background:rgba(12,15,16,.94);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(8px)}
  #areabar.on{display:flex}
  #areaHint{border-color:transparent;background:transparent;color:#8C948C;cursor:default;
            min-width:150px;text-align:center}
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
    #cap,#intro,#prog,#dwell,#bar,.btn,.seg button,.chip,#slide,#rail .c,.isw,#toast,#offline,#recdot
      {transition:none!important;animation:none!important}
    .isw.on{transform:none}
    #dwell{display:none}
  }
  /* ---- phones ------------------------------------------------------------
     There was no phone layout. Not a broken one — none.

     The deck booted on iOS, rendered the terrain and the orebody, and was
     unusable. `#cap` is a desktop sidebar, so on a 402pt screen it became the
     whole page with the 3D as a dim wash behind the text. `#tools` and `#nav`
     are flex rows sized for 1600px, so they ran off BOTH edges with no wrap
     and no scroll — Next and Play were simply not on the screen.

     Six rounds went into hunting a WebGL boot failure that was never
     happening. Nothing threw, which is exactly why the boot diagnostics never
     caught it: there was nothing to report. The failure was visual, and it
     took an actual screen to see. */
  @media(max-width:760px){
    /* The scene is the product. Cap the caption at a third of the viewport and
       let a long body scroll inside itself rather than push the controls off
       the bottom of the phone. */
    #bar{padding:26px 14px calc(12px + env(safe-area-inset-bottom));gap:10px;
         flex-direction:column;align-items:stretch}
    #cap{max-width:none;max-height:31vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
    #cap h2{font-size:21px;margin:7px 0 8px}
    #cap p{font-size:15px;line-height:1.5}
    #cap .ey{font-size:10px}

    /* Back, the counter, Next, Play — always reachable, never off the edge.
       44px because that is the smallest target a thumb hits reliably. */
    #nav{width:100%;justify-content:space-between;gap:6px;padding-bottom:0}
    #nav .btn{padding:12px 10px;font-size:10px;min-height:44px;flex:0 1 auto}

    /* Fourteen buttons of authoring chrome, unreachable on a phone and beside
       the point for an audience. Leaving them to overflow is how they ended up
       bleeding off both edges. Text, Holes and Explore stay; the strip scrolls
       if even those do not fit. */
    /* Under the legend, not at the bottom: the bottom belongs to the nav, and
       putting the tool strip there laid Text/Holes/Explore directly on top of
       Back/Next/Play. */
    #tools{right:8px;left:8px;top:calc(58px + env(safe-area-inset-top));
           gap:6px;overflow-x:auto;overflow-y:hidden;padding-bottom:2px;
           -webkit-overflow-scrolling:touch;scrollbar-width:none;justify-content:flex-end}
    #tools::-webkit-scrollbar{display:none}
    #tools .btn{flex:0 0 auto;padding:10px 11px;font-size:10px}
    #recbtn,#assetbtn,#provbtn,#sitebtn,#drawbtn,#areabtn,#cobtn,
    #blackbtn,#propbtn,#sharebtn,#embedbtn{display:none}

    /* Two colour ramps and their labels, sized for a desktop gutter. Full
       width along the top, scrollable, clear of the scene. */
    #legend{left:8px;right:8px;top:calc(8px + env(safe-area-inset-top));
            gap:6px;padding:6px 8px;overflow-x:auto;
            -webkit-overflow-scrolling:touch;scrollbar-width:none}
    #legend::-webkit-scrollbar{display:none}
    #legend span{font-size:9px}
    #ramp{width:84px;height:7px}

    /* Panels written against a desktop gutter. A phone has no gutter. */
    #ledger,#holegraph{left:8px;right:8px;width:auto}
    #ledger{top:auto;bottom:calc(66px + env(safe-area-inset-bottom));max-height:36vh}
    #holegraph{bottom:calc(66px + env(safe-area-inset-bottom))}
    #compass,#scalebar{display:none}
    /* The brand block is a fixed top-left title. On a phone it lands on the
       caption's own eyebrow and title, and the deck already says its name in
       the caption and on the splash. */
    #brand{display:none}
    /* The tile-loading readout sits bottom-right, which is now Narrate. */
    #status{bottom:auto;top:calc(30px + env(safe-area-inset-top));right:10px;
            font-size:9px;opacity:.6}

    /* The splash is a radial gradient over the live scene: at desktop widths
       the deck's own text sits in the margins and the effect reads. On a phone
       everything is centred, so the title of chapter one lands directly under
       the splash title and the two interleave — which is precisely what "it
       does not work on my phone" looked like. Opaque here.
       (`.sub`, not `p` — the subtitle is not a paragraph.) */
    #intro{padding:22px;background:#07090A}
    #intro h1{font-size:31px;line-height:1.05}
    #intro .sub{font-size:15px;margin-top:16px}
    #intro .eyebrow{font-size:10px;letter-spacing:.24em;margin-bottom:14px}
    #begin{margin-top:26px;padding:15px 24px;font-size:11.5px;min-height:44px}

    /* Slide chapters are a full-bleed text layout with 60px gutters and a 34px
       floor on the headline — which on a phone is the whole screen, with the
       terrain a rumour behind it. Tighter gutters, a real floor on the
       headline, and the figures two-up instead of strung across a row. */
    #slide{align-items:flex-start;overflow-y:auto;-webkit-overflow-scrolling:touch;
           background:linear-gradient(180deg,rgba(7,9,10,.96) 0%,rgba(7,9,10,.92) 62%,rgba(7,9,10,.55) 100%)}
    #slide .sinner{max-width:none;padding:calc(70px + env(safe-area-inset-top)) 18px
                   calc(96px + env(safe-area-inset-bottom))}
    #slide .sey{font-size:10px;letter-spacing:.2em;margin-bottom:12px}
    #slide h2{font-size:26px;line-height:1.08}
    #slide p{font-size:15.5px;line-height:1.5;margin-top:14px}
    .sstats{gap:14px 22px;margin-top:20px}
    .sstats>div{flex:1 1 40%}
    .sstats .v{font-size:21px}
    .stab td{font-size:12px;padding:7px 10px 7px 0}
    .stab th{padding:0 10px 7px 0}
  }
  /* Landscape on a phone is shorter than it is narrow, so a vh cap on the
     caption is a fraction of the wrong axis. */
  @media(max-height:460px) and (orientation:landscape){
    #cap{max-height:26vh}
    #cap h2{font-size:18px;margin:4px 0 6px}
    #cap p{font-size:13.5px}
    #bar{padding-top:12px}
  }
  @media(max-width:900px){#rail{display:none}#panel{width:auto;left:16px;right:16px}#cap h2{font-size:23px}#cap p{font-size:16px}}
</style>
</head>
<body>
<div id="cesiumContainer"></div>
<div id="load">PREPARING PRESENTATION…<div id="loadwhy"></div>
  <div id="loadact"><button class="btn sm" id="loadtext">Read it as text instead</button>
  <button class="btn sm" id="loadcopy">Copy diagnostics</button></div></div>
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
  <div id="geoleg"></div>
  <div id="propleg"></div>
  <div id="gcleg"></div>
  <div id="assayleg"></div>
</div>

<!-- Intercept callouts, parked in the gutters rather than floated in the
     scene. Leader lines are drawn to the projected position of each intercept,
     so the card can sit somewhere readable while still pointing at the rock. -->
<svg id="calloutsvg" aria-hidden="true"></svg>
<div id="callouts"></div>

<div id="tools">
  <button id="recbtn" class="btn sm" title="Record a walkthrough to video (R)"><span id="recdot"></span>Rec<span id="rectime"></span></button>
  <button id="assetbtn" class="btn sm" title="Asset only — the orebody, nothing else (A)">Asset</button>
  <button id="datatoggle" class="btn sm" title="Text edition — no 3D required">Text</button>
  <button id="provbtn" class="btn sm" title="Audit trail — where every number comes from">Audit</button>
  <button id="sitebtn" class="btn sm" title="Ground-level site view">Site</button>
  <button id="drawbtn" class="btn sm" title="Annotate (D)">Draw</button>
  <button id="areabtn" class="btn sm" title="Outline an area on the ground (G)">Areas</button>
  <button id="ledgbtn" class="btn sm" title="Drill hole ledger (H)">Holes</button>
  <button id="cobtn" class="btn sm" title="Intercept callout cards (I)">Calls</button>
  <button id="blackbtn" class="btn sm" title="Drop the imagery to black (B)">Black</button>
  <button id="propbtn" class="btn sm" title="Property-wide grade columns (O)">Property</button>
  <button id="sharebtn" class="btn sm" title="Copy a link to this exact view">Link</button>
  <button id="embedbtn" class="btn sm" title="Put this deck on your own website">Embed</button>
  <button id="xbtn" class="btn">Explore ▸</button>
</div>

<div id="panel">
  <!-- Populated from DEPOSITS, and hidden entirely when there is only one:
       a switcher with one option reads as a broken control. -->
  <div id="deprow" hidden>
    <h3>Deposit</h3>
    <div class="seg" id="depseg"></div>
  </div>

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

  <!-- Hidden by JS when no geophysics is baked. The "synthetic" tag is part of
       the control, not a caption beside it: the reader has to pass the word to
       reach the button. -->
  <div id="georow">
  <h3>Geophysics <span class="syntag">synthetic</span></h3>
  <div class="seg" id="geoseg">
    <button data-gp="" class="on">Off</button>
    <button data-gp="tmi">TMI</button>
    <button data-gp="rtp">RTP</button>
    <button data-gp="1vd">1VD</button>
  </div>
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

  <h3>Assay cut-off <span class="hint" id="assayv"></span></h3>
  <div class="cutrow"><input type="range" id="assayr" min="0" max="5" step="1" value="0"></div>

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

<!-- Areas. Deliberately its own bar rather than a mode of the ink tool: ink is
     screen-space and is wiped on every chapter change, and an area a presenter
     drew round a target has to stay on that ground when the camera moves. -->
<div id="areabar">
  <span class="ibtn on" id="areaHint">Click the ground</span>
  <span class="isw asw" data-c="#38BDF8" style="background:#38BDF8"></span>
  <span class="isw asw" data-c="#A78BFA" style="background:#A78BFA"></span>
  <span class="isw asw" data-c="#4ADE80" style="background:#4ADE80"></span>
  <span class="isw asw" data-c="#FB7185" style="background:#FB7185"></span>
  <button class="ibtn" id="areaDone">Finish</button>
  <button class="ibtn" id="areaUndo">Undo point</button>
  <button class="ibtn" id="areaGeo" title="Download the areas as GeoJSON">GeoJSON</button>
  <button class="ibtn" id="areaClear">Clear all</button>
</div>

<main id="datamode" aria-hidden="true"></main>

<div id="emb"><div class="pinner">
  <div class="phead"><span>Embed on your site</span>
    <button class="btn sm" id="embclose">Close</button></div>
  <label for="emburl">Where this deck is hosted</label>
  <input type="text" id="emburl" spellcheck="false">
  <div class="row">
    <div><label for="embratio">Shape</label><select id="embratio">
      <option value="56.25">16:9 — widescreen</option>
      <option value="75">4:3 — classic</option>
      <option value="42.86">21:9 — cinematic</option>
      <option value="100">1:1 — square</option>
    </select></div>
    <div><label for="embstart">Opens on</label><select id="embstart">
      <option value="first">Chapter 1 — the whole story</option>
      <option value="here">This exact view</option>
    </select></div>
  </div>
  <div class="chk">
    <label><input type="checkbox" id="embauto" checked> Autoplay</label>
    <label><input type="checkbox" id="embcap" checked> Caption underneath</label>
  </div>
  <label>Paste this into a WordPress Custom HTML block, or an Elementor HTML widget</label>
  <pre id="embcode"></pre>
  <div class="foot">
    <button class="btn sm" id="embcopy">Copy snippet</button>
    <button class="btn sm" id="embhtml">Download .html</button>
    <button class="btn sm" id="embjson">Download .json</button>
  </div>
  <p class="note" id="embnote"></p>
</div></div>

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

<!-- Ground vantages. Hidden until the site view is entered, and populated from
     STATIONS at boot rather than hard-coded here. -->
<div id="stbar" hidden>
  <span class="pl">Vantage</span>
  <div class="seg" id="stseg"></div>
  <button id="st360" class="btn sm" title="Turn a full circle on the spot">360&deg;</button>
  <button id="stx" class="btn sm">Exit</button>
  <div id="stnote"></div>
</div>

<!-- Drill ledger. Left, where the rail lives, because during a drilling
     chapter the holes ARE the navigation — the rail hides while it is open
     rather than the two fighting for the same column. -->
<!-- Authoring bar. Only ever shown after the console has introduced itself,
     so a share link with ?author=1 pasted by hand shows nothing: there is
     nowhere for it to report to and nothing it could write. -->
<div id="authbar" hidden>
  <span class="pl">Authoring</span>
  <span id="authch">—</span>
  <button id="authset" class="btn sm" title="Write this camera to the current chapter">Set view</button>
  <button id="authall" class="btn sm" title="Write this camera AND every layer switch to the current chapter">Set view + layers</button>
  <button id="authlab" class="btn sm" hidden title="Publish the areas drawn on this slide so the audience sees them">Save labels</button>
  <button id="authplay" class="btn sm" title="Replay the flight into this slide from the one before it">Replay in</button>
  <span id="authnote"></span>
</div>

<div id="ledger" hidden>
  <div class="lhead">
    <span id="ledgt">Drill holes</span>
    <button class="btn sm" id="ledgsort" title="Sort order">Best</button>
    <button class="btn sm" id="ledgx">Close</button>
  </div>
  <div id="ledglist"></div>
  <div id="ledgnote"></div>
</div>

<div id="holegraph" hidden>
  <div class="lhead"><span id="hgt">Hole</span>
    <button class="btn sm" id="hgx">Close</button></div>
  <div id="hgbody"></div>
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
    <!-- Cut-off on the presenting chrome, not buried in Explore.
         The question "what if we only mined the good stuff" gets asked out
         loud, mid-presentation, and walking into a settings panel to answer it
         breaks the room. Touching this holds the value across chapter changes
         (see cutHold) so the answer survives the next slide instead of being
         silently reset by the deck. -->
    <div id="pcut" title="Cut-off grade — held across chapters once you move it">
      <span class="pl">Cut-off</span>
      <input type="range" id="pcutr" min="4" max="14" step="1" value="4"
             aria-label="Cut-off grade">
      <span id="pcutv">0.50 g/t</span>
      <button id="pcutx" class="btn sm" hidden title="Return to the chapter's cut-off">Reset</button>
    </div>
    <div id="pgnd" title="Terrain opacity — held across chapters once you move it">
      <span class="pl">Terrain</span>
      <button id="pgnd0" class="btn sm" title="Cut the ground away completely">0%</button>
      <input type="range" id="pgndr" min="0" max="100" step="5" value="0"
             aria-label="Terrain opacity">
      <button id="pgnd100" class="btn sm" title="Solid ground">100%</button>
      <span id="pgndv">cut away</span>
      <button id="pgndx" class="btn sm" hidden title="Return to the chapter's terrain">Reset</button>
    </div>
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
  <h1 id="intro_t">Elk Gold<br>Siwash North</h1>
  <div class="sub" id="intro_s">A high-grade gold system in British Columbia's Nicola region — presented in three dimensions, on real terrain.</div>
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
<!-- Polygon union, for dissolving a holder's tenure into one outline. A
     company with nine adjacent cell claims should read as one property, not as
     nine rectangles with the internal fences drawn in. Optional: if it fails
     to load the claims layer falls back to drawing each tenure separately,
     which is what it did before. -->
<script src="https://cdn.jsdelivr.net/npm/polygon-clipping@0.15.7/dist/polygon-clipping.umd.js"
        integrity="sha384-1rzjf0+iuELMhFIrp9iYaamoIVLnUjHj93MbKlIsn5PnIJDXT7ynaE0i6IhYsOOV"
        crossorigin="anonymous"></script>
<script>
// `let`, not `const`, for everything the model determines.
//
// This file used to be a hard-coded Elk Gold deck with a chapter list stapled
// on. A customer could push a block model through the console and still had no
// way to look at it — the console wrote artifacts nobody read. Opening the deck
// with ?t=<share token> now replaces every value below from the `deck` edge
// function before the scene is built. Bake-time values are the demo's defaults,
// not the viewer's assumptions; do not re-freeze them.
let N=__N__,
      EMIN=__EMIN__, NMIN=__NMIN__, CE=__CE__, CN=__CN__, CZ=__CZ__, EX=__EX__, EY=__EY__,
      ZTOP=__ZTOP__, ZBOT=__ZBOT__;
let CHAPTERS=__CHAPTERS__, RUNS=__RUNS__, BUCKETS=__BUCKETS__, VEINS=__VEINS__,
      LADDER=__LADDER__, CLASS_LABELS=__CLASS_LABELS__, CLASS_CONFIRMED=__CLASS_CONFIRMED__,
      PROV=__PROV__, THUMBS=__THUMBS__, BY_CB=__BY_CB__, HOLES=__HOLES__, HIGHLIGHTS=__HIGHLIGHTS__, SITE=__SITE__, SITE_SYNTHETIC=__SITE_SYNTHETIC__, REAL_CLAIMS=__REAL_CLAIMS__, CLAIMS_ATTRIB=__CLAIMS_ATTRIB__, CLAIMS_SUBJECT=__CLAIMS_SUBJECT__, HOLDER_LOGOS=__HOLDER_LOGOS__, HOLDER_META=__HOLDER_META__, BRAND=__BRAND__, GEOPHYS=__GEOPHYS__, GEOPHYS_SYNTHETIC=__GEOPHYS_SYNTHETIC__, STATIONS=__STATIONS__, DEPOSITS=__DEPOSITS__, VGROUP=__VGROUP__, VGROUP_NAMES=__VGROUP_NAMES__, DRILL_SYNTHETIC=__DRILL_SYNTHETIC__, G_PER_OZ=31.10348;
// ---- projections -------------------------------------------------------
// The viewer used to hard-code EPSG:26910 — NAD83 / UTM 10N, which is Elk
// Gold's grid and nobody else's. Every project outside one zone of British
// Columbia was refused at the door.
//
// Definitions are generated rather than listed: a UTM zone's proj4 string is
// a formula, and 180 of them typed out is 180 chances to fatfinger a zone
// number. Coverage is deliberate — WGS84 and NAD83 UTM cover most of the
// world's exploration ground, MGA covers Australia, and the named grids are
// the ones that turn up in mining data often enough to be worth the bytes.
const PROJ_NAMED={
  'EPSG:4326':'+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:3857':'+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
  'EPSG:3005':'+proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5 +x_0=1000000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  'EPSG:2154':'+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +datum=WGS84 +units=m +no_defs',
  'EPSG:2193':'+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:27700':'+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +datum=OSGB36 +units=m +no_defs'
};
function projDef(code){
  const c=+code;
  if(PROJ_NAMED['EPSG:'+c]) return PROJ_NAMED['EPSG:'+c];
  const utm=(z,extra)=>'+proj=utm +zone='+z+' '+extra+' +units=m +no_defs';
  if(c>=32601&&c<=32660) return utm(c-32600,'+datum=WGS84');           // WGS84 N
  if(c>=32701&&c<=32760) return utm(c-32700,'+south +datum=WGS84');    // WGS84 S
  if(c>=26901&&c<=26923) return utm(c-26900,'+datum=NAD83');           // NAD83 N
  if(c>=26701&&c<=26722) return utm(c-26700,'+datum=NAD27');           // NAD27 N
  if(c>=28348&&c<=28358) return utm(c-28300,'+south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0'); // GDA94 MGA
  if(c>=7846&&c<=7859)   return utm(c-7800,'+south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0');  // GDA2020 MGA
  return null;
}
// The grid the loaded model is in. A hydrated deck replaces it.
let PROJ='EPSG:26910';
function useProjection(code){
  const name='EPSG:'+(+code);
  if(proj4.defs(name)) return name;
  const def=projDef(code);
  if(!def) throw new Error('this project is in EPSG:'+code+', which this '+
    'viewer does not have a definition for. UTM (WGS84, NAD83, NAD27, MGA) '+
    'and a few national grids are built in.');
  proj4.defs(name,def);
  return name;
}
useProjection(26910);
// 10 x 5 x 5 m at 2.7 t/m3 for the demo. A hydrated deck takes its own value
// from stats.tonnes_per_block — a customer's model is not on this lattice, and
// carrying the demo's number across would misreport every tonne on screen.
let TONNES_PER_BLOCK=675;
// The lattice the boxes are drawn on, the click index is keyed to, and the
// inspector quotes. Baked for the demo; replaced by any other model's own
// stats.block_dims. Drawing a 12 m block as a 10 m box leaves gaps you can see.
let BLOCK_DIMS=[10,5,5], BLOCK_DENSITY=2.7;
let BLOCKS_SYNTHETIC=false;   // set by a hydrated deck or a fabricated deposit
// TRACKING.md #1. True when the deck has no block model — an exploration
// project, which is most of them. Nothing about that is an error state; it
// means there is no resource yet, so there is nothing to report a tonnage for.
let EXPLORATION=false;
// Meshes from a customer's OBJ / GOCAD / DXF upload. Raw {verts,faces} rather
// than the demo's packed int16 lattice, so they get their own builder.
let UPLOADED_SURFACES=[];
// Named places on the property that are not zones: targets, pits, portals,
// showings. The reference decks live on these — "Minotaur Target", "Marathon
// Pit" — because a land package with nothing named on it is a shape, and a
// presenter cannot talk over a shape.
//
// Each is {name, e, n, kind}. Kind only chooses the styling; it asserts
// nothing about the ground.
let TARGETS=[];
// Soil / rock-chip / stream samples. Often the only assay data an early
// project has, and what the first target map is drawn from.
let GEOCHEM=null;
const GEOID=-18, rad=Cesium.Math.toRadians, $=id=>document.getElementById(id);
const setStat=t=>$('status').textContent=t;
// Names the step boot is currently on, so a failure inside a vendor bundle can
// still be attributed to a call site. Cheap, and the difference between
// "something threw" and "the viewer threw while building block geometry".
let BOOT_PHASE='loading libraries';
// Set only when the deck has fallen back to text because 3D was impossible.
// buildDataMode reads it to explain itself; ?data=1 leaves it null, because
// that is a deliberate choice rather than a failure.
let TEXT_FALLBACK=null;

// Nothing in boot may wait forever.
//
// There were six unbounded awaits here — a 3.7 MB model fetch and two calls to
// external ArcGIS services among them — and not one timeout. A try/catch
// around an await handles a REJECTION; it does nothing for a HANG. A hung boot
// shows no error, reaches no fallback, and sits on "PREPARING PRESENTATION…"
// indefinitely, which from the outside is indistinguishable from a page that
// simply does not work. On a phone with a weak connection that is the most
// likely failure of all, and it was the one failure this file could not report.
function withTimeout(promise, ms, what){
  let t;
  return Promise.race([
    promise.finally(()=>clearTimeout(t)),
    new Promise((_,rej)=>{ t=setTimeout(()=>rej(
      new Error(what+' took longer than '+Math.round(ms/1000)+' seconds')), ms); }),
  ]);
}
const bootPhase=p=>{ BOOT_PHASE=p; };
const QS=new URLSearchParams(location.search);
const EMBED=QS.has('embed');
// Authoring mode. The viewer is framed by the console, reports what it is
// looking at, and never writes anything itself — see the bridge at the bottom.
const AUTHOR=QS.has('author');

// ---- audience telemetry -------------------------------------------------
// Reports engagement for decks opened through a share link, including — in
// fact especially — when the deck is running in an iframe on a customer's own
// website. That is the case the console exists to measure and the one where no
// ordinary web analytics can see anything, because the page belongs to someone
// else.
//
// What is deliberately not collected: no cookies, no cross-site identifier, no
// IP (a country is derived at the edge and the address discarded), and no query
// string off the embedding page — which is where tracking parameters and the
// occasional email address live. The session id lives in sessionStorage, so it
// is per TAB, not per person: closing the tab ends it and nothing links two
// visits together.
const API=(QS.get('api')||window.OREBODY_API||'').replace(/\/$/,'');
const TOKEN=QS.get('t')||'';
const TRACKING=Boolean(API&&TOKEN)&&!AUTHOR;
const TRK={s:null,watch:0,seen:new Set(),done:false,q:[],since:0,chapAt:0,chap:null};
try{ TRK.s=sessionStorage.getItem('orebody.s.'+TOKEN)||null; }catch(e){}

// Watch time counts only while the deck is actually visible. Wall-clock since
// the page opened would count a tab someone left open over lunch, which is the
// number that makes engagement dashboards worthless.
function trkTick(){
  const now=performance.now();
  if(TRK.since && document.visibilityState==='visible') TRK.watch+=now-TRK.since;
  TRK.since=document.visibilityState==='visible'?now:0;
}
function trkEvent(kind,extra){
  if(!TRACKING) return;
  trkTick();
  TRK.q.push(Object.assign({kind:kind,t_ms:Math.round(TRK.watch)},extra||{}));
  if(TRK.q.length>=12) trkFlush();
}
// Close off the chapter being left, so dwell is time actually spent on it.
function trkChapter(i){
  if(!TRACKING) return;
  trkTick();
  if(TRK.chap!==null && TRK.chap!==i){
    trkEvent('chapter',{chapter_ord:TRK.chap,
                        dwell_ms:Math.round(TRK.watch-TRK.chapAt)});
  }
  if(TRK.chap!==i){ TRK.chap=i; TRK.chapAt=TRK.watch; TRK.seen.add(i); }
  if(i===CHAPTERS.length-1 && !TRK.done){ TRK.done=true; trkEvent('complete'); }
}
function trkBody(){
  trkTick();
  return JSON.stringify({
    t:TOKEN, s:TRK.s, embed:EMBED,
    ref:document.referrer||null,
    watch_ms:Math.round(TRK.watch),
    chapters_seen:TRK.seen.size,
    completed:TRK.done,
    events:TRK.q.splice(0,200)});
}
function trkFlush(){
  if(!TRACKING) return;
  const body=trkBody();
  fetch(API+'/track',{method:'POST',headers:{'content-type':'application/json'},
                      body:body,keepalive:true})
    .then(r=>r.json()).then(j=>{
      if(j&&j.s&&!TRK.s){ TRK.s=j.s;
        try{ sessionStorage.setItem('orebody.s.'+TOKEN,j.s); }catch(e){} }
    }).catch(()=>{});
}
// The last flush must survive the page going away, so it goes out as a beacon.
// A normal fetch is cancelled on unload and the final — most interesting —
// chapter of every session would be lost.
function trkFinal(){
  if(!TRACKING) return;
  if(TRK.chap!==null){
    trkTick();
    TRK.q.push({kind:'chapter',t_ms:Math.round(TRK.watch),chapter_ord:TRK.chap,
                dwell_ms:Math.round(TRK.watch-TRK.chapAt)});
    TRK.chap=null;
  }
  TRK.q.push({kind:'close',t_ms:Math.round(TRK.watch)});
  const body=trkBody();
  if(navigator.sendBeacon){
    navigator.sendBeacon(API+'/track',new Blob([body],{type:'application/json'}));
  } else {
    fetch(API+'/track',{method:'POST',body:body,keepalive:true,
                        headers:{'content-type':'application/json'}}).catch(()=>{});
  }
}
if(TRACKING){
  TRK.since=document.visibilityState==='visible'?performance.now():0;
  trkEvent(EMBED?'embed_view':'open');
  trkFlush();
  setInterval(trkFlush,20000);
  addEventListener('visibilitychange',()=>{
    trkTick();
    if(document.visibilityState==='hidden') trkFlush();
  });
  // pagehide rather than unload: unload does not fire on iOS, which is a large
  // share of the people who open an investor deck from a phone.
  addEventListener('pagehide',trkFinal);
}
// Embedded decks autostart, unless the embed snippet asked them not to.
const EMBED_AUTOPLAY=QS.get('autoplay')!=='0';
const REDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;
if(EMBED) document.body.classList.add('embed');

function unb64(b){const s=atob(b);const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u;}
// F is [x,y,z,grade,orefraction] x N; M is [class,vein] x N. Both are filled by
// bootData() — fetched as OREB v1 for the demo, and for a hydrated deck too.
// One format, one loader, whoever the model belongs to.
let F=null, M=null;

// ---- reading a customer's block model -----------------------------------
// OREB v1 — the exact bytes dashboard/lib/extract.js pack() writes and
// ingest.js uploads. Parsed rather than re-derived: the artifact the customer's
// browser produced is the artifact this reads, so there is no second
// implementation of the extraction to drift out of step with the first.
function unpackOreb(buf){
  const dv=new DataView(buf);
  if(dv.byteLength<16||dv.getUint32(0,false)!==0x4f524542)
    throw new Error('that artifact is not an Orebody block model');
  if(dv.getUint32(4,true)!==1)
    throw new Error('block model format v'+dv.getUint32(4,true)+' is newer than this viewer');
  const hlen=dv.getUint32(8,true), base=dv.getUint32(12,true);
  const head=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,16,hlen)));
  const T={Float32Array:Float32Array,Uint8Array:Uint8Array,Uint16Array:Uint16Array};
  const cols={n:head.n, origin:head.origin};
  head.arrays.forEach(a=>{
    const C=T[a.type];
    if(!C) throw new Error('unsupported column type '+a.type);
    cols[a.name]=new C(buf, base+a.offset, a.count);});
  ['x','y','z','g','p','c','v'].forEach(k=>{
    if(!cols[k]) throw new Error('block model is missing the "'+k+'" column');});
  return cols;
}

// Rebuild the render buckets the Python build precomputes. Same key and same
// order — (class, grade bin, depth band) — because RUNS are index ranges into
// F, so the sort here and the runs must agree exactly or every primitive draws
// the wrong blocks.
// `ladder` is passed rather than read off the global: buildModel runs while a
// second deposit is being prepared in the background, and binning that model
// against whichever ladder happens to be current is a silent way to get every
// run boundary wrong.
function buildModel(cols, stats, ladder){
  const LAD=ladder||LADDER;
  const dims=(stats.block_dims&&stats.block_dims.length===3)?stats.block_dims:[10,5,5];
  const ox=cols.origin[0], oy=cols.origin[1], oz=cols.origin[2];
  const n=cols.n;
  // Depth below the top of each block's own column, on the model's OWN lattice
  // rather than the demo's 10x5 footprint — the band drives the aerial fade,
  // and a wrong cell size collapses every column into one bucket.
  const tops=new Map();
  const key=i=>Math.round((cols.x[i]+ox)/dims[0])+'|'+Math.round((cols.y[i]+oy)/dims[1]);
  for(let i=0;i<n;i++){ const k=key(i), z=cols.z[i]+oz;
    const t=tops.get(k); if(t===undefined||z>t) tops.set(k,z); }
  const DEPTH_BAND_M=70, N_BANDS=6;
  const band=i=>{ const t=tops.get(key(i)); const z=cols.z[i]+oz;
    return Math.max(0,Math.min(N_BANDS-1,Math.floor(((t===undefined?z:t)-z)/DEPTH_BAND_M))); };
  const binOf=g=>{ let b=0; while(b+1<LAD.length&&LAD[b+1]<=g) b++; return b; };

  const idx=new Int32Array(n); for(let i=0;i<n;i++) idx[i]=i;
  const bins=new Uint8Array(n), bands=new Uint8Array(n);
  for(let i=0;i<n;i++){ bins[i]=binOf(cols.g[i]); bands[i]=band(i); }
  // Vein is the last key in the Python sort but does not enter the run key, so
  // it only has to be stable, not ordered — sorting on it anyway keeps a
  // hydrated deck's primitive order reproducible between loads.
  const order=Array.prototype.slice.call(idx).sort((a,b)=>
    cols.c[a]-cols.c[b] || bins[a]-bins[b] || bands[a]-bands[b] || cols.v[a]-cols.v[b]);

  const f=new Float32Array(n*5), m=new Uint8Array(n*2);
  for(let k=0;k<n;k++){ const i=order[k];
    f[k*5]=cols.x[i]; f[k*5+1]=cols.y[i]; f[k*5+2]=cols.z[i]+oz;
    f[k*5+3]=cols.g[i]; f[k*5+4]=cols.p[i];
    m[k*2]=cols.c[i];
    // META packs vein into a byte, as the build asserts. A model with more than
    // 256 domains would silently alias one onto another, so say so instead.
    if(cols.v[i]>255) throw new Error('this model has more than 256 vein domains');
    m[k*2+1]=cols.v[i]; }

  const runs=[];
  let s=0;
  const rk=k=>{ const i=order[k]; return cols.c[i]+'|'+bins[i]+'|'+bands[i]; };
  for(let k=1;k<=n;k++){
    if(k===n||rk(k)!==rk(s)){
      const i=order[s];
      runs.push({c:cols.c[i], b:bins[i], d:bands[i], lo:LAD[bins[i]],
                 hi:bins[i]+1<LAD.length?LAD[bins[i]+1]:null, s:s, n:k-s});
      s=k; }
  }
  return {F:f, M:m, RUNS:runs, N:n};
}

// ---- uploaded artifacts -> the shapes the viewer already draws -----------
// The console parses a customer's drilling, surfaces and claims into
// orebody-drills/1, orebody-surfaces/1 and orebody-claims/1. Until these
// converters existed the parse was invisible: a customer uploaded collars and
// surveys, the desurvey ran, and their deck showed nothing. Reading the
// artifacts here is what closes that.
//
// Nothing new is rendered — these produce exactly the structures the baked
// demo builds, so drills, surfaces and tenure go down the same paths that are
// already tested rather than a second implementation for customer data.
function holesFromArtifact(a, floor){
  const out=[];
  const assayBy={};
  (a.assays||[]).forEach(x=>{assayBy[x.id]=x.iv||[];});
  (a.traces||[]).forEach(t=>{
    const pts=t.pts||[]; if(pts.length<2) return;
    const at=d=>{
      const i=Math.min(pts.length-1,Math.max(0,Math.floor(d/(t.step||5))));
      const j=Math.min(pts.length-1,i+1), A=pts[i], B=pts[j];
      const f=Math.min(1,Math.max(0,(d-i*(t.step||5))/(t.step||5)));
      return [A[0]+(B[0]-A[0])*f, A[1]+(B[1]-A[1])*f, A[2]+(B[2]-A[2])*f];
    };
    const segs=[];
    (assayBy[t.id]||[]).forEach(iv=>{
      if(!(iv.g>=floor)) return;
      const pa=at(iv.f), pb=at(iv.t);
      const mid=[(pa[0]+pb[0])/2,(pa[1]+pb[1])/2,(pa[2]+pb[2])/2];
      // The grade bar sticks out perpendicular to the hole and horizontal, so
      // it reads at any viewing angle — the same construction the baked
      // desurvey uses, kept identical so both look like one tool.
      const d=[pb[0]-pa[0], pb[1]-pa[1], pb[2]-pa[2]];
      const px=d[1], py=-d[0], m=Math.hypot(px,py)||1;
      const blen=Math.min(45, iv.g*2.2);
      const band=Math.max(0,Math.min(5,Math.floor((t.collar[2]-mid[2])/70)));
      segs.push({a:pa,b:pb,g:iv.g,mid:mid,
                 bar:[mid[0]+px/m*blen, mid[1]+py/m*blen, mid[2]],
                 d:band, f:iv.f, t:iv.t});
    });
    out.push({id:t.id, collar:t.collar, td:t.td,
              end:pts[pts.length-1], segs:segs});
  });
  return out;
}
// Is this registered holder a company or a person?
//
// It matters more than it sounds. Of the sixteen holders around Elk Gold, ten
// are private individuals — a public register is full of them. "A listed
// copper company holds the ground along strike" is the fact an investor came
// for; "RIPPON, DONALD JOHN holds three placer claims" is noise, and putting a
// named private citizen in a callout on an investor deck is a thing to do
// deliberately or not at all. Companies get a colour, a mark and their name.
// People get a quiet outline and a line in an aggregate.
//
// A corporate suffix decides it; failing that, the register's own "SURNAME,
// FIRST MIDDLE" comma says person. An unrecognised name with no comma is read
// as a company, which is the safer error: a real company shown quietly is a
// missed opportunity, a named individual is a decision nobody made.
const CORP_RE=/\b(CORP|CORPORATION|INC|INCORPORATED|LTD|LIMITED|LLC|LLP|PLC|COMPANY|RESOURCES|MINERALS|METALS|MINING|EXPLORATION|VENTURES|HOLDINGS|GROUP|PARTNERSHIP|TRUST|SOCIETY|NATION|BAND|MUNICIPALITY|PROVINCE|CROWN)\b/i;
const normOwner=x=>(x||'').trim().toUpperCase().replace(/\s+/g,' ');
function isCorporate(name){
  const n=(name||'').trim();
  if(!n) return false;
  if(CORP_RE.test(n)) return true;
  return n.indexOf(',')<0;
}

// One holder per registered owner, from whatever claims we have — baked or
// hydrated. Area is summed once per TENURE_NUMBER_ID, never once per ring: a
// MultiPolygon claim arrives as several entries, and summing those would
// report a holder as owning two or three times the ground the register says,
// on the one slide whose whole subject is who owns what.
function rollHolders(claims, subjectOwner){
  const SUBJ=normOwner(subjectOwner);
  const by={}, seen={};
  (claims||[]).forEach(c=>{
    const k=normOwner(c.owner);
    if(!k) return;
    const h=by[k]||(by[k]={owner:c.owner.trim(), claims:0, ha:0, rings:0,
                           subject:SUBJ?k===SUBJ:!!c.subject,
                           corporate:isCorporate(c.owner)});
    h.rings++;
    // COUNT and area both dedupe by tenure. A MultiPolygon claim arrives as
    // several entries — Elk Gold's 29 registered claims are 30 rings — and
    // counting rings put "30 claims" on a card next to a register that says
    // 29. Area was already deduped; the count was not, which is the more
    // visible of the two because it is the number in the caption.
    const t=c.tenure==null?('r:'+k+':'+h.rings):('t:'+c.tenure);
    if(!seen[t]){ seen[t]=1; h.claims++; h.ha+=(+c.ha||0); }
  });
  // Largest first, because the ranking drives colour assignment: the neighbour
  // worth talking about should get the strongest one rather than whichever
  // happened to come first out of the register.
  return Object.keys(by).map(k=>by[k])
    .map(h=>({...h, ha:Math.round(h.ha*10)/10}))
    .sort((a,b)=>(a.subject?0:1)-(b.subject?0:1) ||
                 (a.corporate?0:1)-(b.corporate?0:1) || b.ha-a.ha);
}

// Neighbour logos as supplied by the console, keyed the way the viewer
// normalises owner names — a public register's spacing is not consistent and
// an exact-string map would silently miss half the matches.
function applyHolderLogos(project){
  HOLDER_LOGOS={}; HOLDER_META={};
  BRAND=(project&&project.brand)||{};
  const hs=(project&&project.holders)||{};
  Object.keys(hs).forEach(k=>{
    const v=hs[k];
    const key=normOwner(k);
    const url=(v&&typeof v==='object')?v.logo:v;
    if(typeof url==='string'&&url) HOLDER_LOGOS[key]=url;
    if(v&&typeof v==='object'){
      HOLDER_META[key]={
        // undefined, not false: "the author has not decided" and "the author
        // hid this one" are different, and only the second should override the
        // default of featuring companies and not individuals.
        feature:(typeof v.feature==='boolean')?v.feature:undefined,
        note:(typeof v.note==='string'&&v.note.trim())?v.note.trim():'' };
    }
  });
}

function claimsFromArtifact(a){
  return (a.rings||[]).map(r=>{
    const p=r.props||{};
    return {name:p.CLAIM_NAME||p.name||p.NAME||'Claim',
            tenure:p.TENURE_NUMBER_ID||p.tenure||null,
            owner:(p.OWNER_NAME||p.owner||'').trim(),
            // Uploaded tenure is the issuer's own ground by definition —
            // nobody uploads their neighbour's claims — so it draws as
            // subject. Neighbours come from a register, not from a file.
            subject:true, neighbour:false,
            kind:p.TENURE_TYPE_DESCRIPTION||'',
            ha:+(p.AREA_IN_HECTARES||p.ha||0)||0,
            ll:r.ring.reduce((acc,c)=>{acc.push(c[0],c[1]);return acc;},[])};
  }).filter(c=>c.ll.length>=6);
}

// A chapter authored in the console is rows in a table; the walkthrough wants
// one flat object per beat. `layers` carries whatever the author set, so it is
// spread rather than enumerated — a layer added to the console should not need
// a matching change here to reach the deck.
function mapChapter(c){
  const cam=c.camera||{};
  const out=Object.assign({}, c.layers||{});
  // Two camera shapes, and they are now TAGGED, because they were not and it
  // cost the console its camera editor.
  //
  // Orbit — {h,p,r}: heading, pitch and range about the deposit centre. Almost
  // every shot wants this. It survives a deposit switch, and the transition
  // guard reasons about `r` to decide whether a jump needs an intermediate
  // frame. Every chapter written to date, by the candidate generator and by
  // the baked demo, is this shape.
  //
  // Free — {mode:'free',lon,lat,height,heading,pitch}: an absolute position,
  // for the shots whose subject is not the deposit. The property, a claim
  // block, one drill hole.
  //
  // The bug: the console's camera form collected lon/lat/h/heading/pitch and
  // wrote `h` as a HEIGHT IN METRES, into the key this reads as a HEADING IN
  // DEGREES. A camera authored in the console produced a heading of 1500°, a
  // default pitch and a default range — silently, because 1500° is a legal
  // number. It has never once done what it said. Untagged rows are read as
  // orbit, which is what all of them are.
  if(cam.mode==='free' && isFinite(+cam.lon) && isFinite(+cam.lat)){
    out.free={lon:+cam.lon, lat:+cam.lat,
              height:+(cam.height!==undefined?cam.height:1500),
              heading:+(cam.heading||0),
              pitch:+(cam.pitch===undefined?-30:cam.pitch)};
  }
  out.h=cam.h!==undefined?cam.h:30;
  out.p=cam.p!==undefined?cam.p:-26;
  out.r=cam.r!==undefined?cam.r:3000;
  out.section=c.section||null;
  out.title=c.title||'';
  out.body=c.body||'';
  out.dwell=Math.max(3,(c.dwell_ms||9000)/1000);
  // Authored annotations for this slide. Filtered on the way in rather than
  // trusted: a malformed ring is a crash inside Cesium's polygon tessellator,
  // several frames after the bad data arrived, with nothing in the message
  // that names the deck it came from.
  out.areas=Array.isArray(c.areas)
    ? c.areas.filter(a=>a&&Array.isArray(a.ll)&&a.ll.length>=6&&a.ll.every(n=>isFinite(n)))
    : [];
  if(c.slide) out.slide=c.slide;
  return out;
}

// Somewhere to start when a deck has a model but nobody has written chapters
// yet. Three beats, no claims — the alternative is a blank rail and a viewer
// that looks broken.
function defaultChapters(title){
  return [
    {h:30,p:-26,r:3200,ground:1.0,mode:'grade',dwell:9,section:'Overview',
     title:title||'The deposit', body:'The block model on real terrain, at its true position.'},
    {h:52,p:-24,r:2600,ground:0.0,mode:'grade',dwell:10,section:'Overview',
     title:'Grade', body:'Coloured by grade, with the ground cut away.'},
    {h:40,p:-30,r:2800,ground:0.0,mode:'class',dwell:10,section:'Overview',
     title:'Confidence', body:'Recoloured by resource classification.'}];
}

// ---- hydrate from a share token ----------------------------------------
// The whole point of the backend, and the reason the console was not yet worth
// anything to a customer. Everything the baked demo hard-codes is replaced here
// before the scene exists.
//
// This path FAILS rather than degrades. A viewer that renders a deposit but
// quietly reports the demo's tonnage, or draws a fabricated model with no
// banner, is worse than one that says it cannot open the deck.
async function hydrate(token){
  if(!API) throw new Error('this build has no API configured, so it cannot open a shared deck');
  setStat('opening deck…');
  let passcode=QS.get('passcode')||'';
  let payload=null;
  for(let attempt=0; attempt<4; attempt++){
    const u=API+'/deck?t='+encodeURIComponent(token)+
            (passcode?'&passcode='+encodeURIComponent(passcode):'')+
            (EMBED?'&embed=1':'');
    const r=await withTimeout(fetch(u,{credentials:'omit'}),20000,'opening the deck');
    const body=await r.json().catch(()=>({}));
    if(r.ok){ payload=body; break; }
    if(r.status===401&&body.needs_passcode){
      const given=prompt(attempt?'Incorrect passcode. Try again:':'This deck needs a passcode:');
      if(given===null) throw new Error('a passcode is required to open this deck');
      passcode=given; continue;
    }
    throw new Error(body.error||('the deck could not be opened ('+r.status+')'));
  }
  if(!payload) throw new Error('incorrect passcode');

  // ---- zones -> deposits ------------------------------------------------
  // TRACKING.md #3. A project holds one or more zones and a deck spans them;
  // the payload now says which dataset belongs to which. Zones that carry a
  // block model become entries in the deposit switcher, in the deck's order,
  // and the first is the one loaded now.
  //
  // Picking assets off a flat list — as this did — quietly rendered zone one's
  // geometry for a deck spanning three, and reported its tonnage as the deck's.
  const zones=(payload.zones&&payload.zones.length)?payload.zones:
    [{id:null,name:(payload.project||{}).name||'Deposit',slug:'zone',ord:0}];
  const assetsOf=zid=>(payload.assets||[]).filter(a=>(a.zone_id||null)===(zid||null));
  const modelled=zones
    .map(z=>({zone:z, blocks:assetsOf(z.id).find(a=>a.kind==='blocks'&&a.url)}))
    .filter(x=>x.blocks);
  const blocks=modelled.length?modelled[0].blocks:null;

  // ---- exploration decks: no block model, and that is not an error --------
  // TRACKING.md #1. Most projects are pure exploration — drilling, magnetics
  // and geochem, no resource and therefore no tonnage, grade or ounces. This
  // used to throw "this deck has no block model attached", which locked out
  // the majority of the market on the grounds that they had not finished yet.
  //
  // N=0 is the mechanism. Every model-driven loop in this file walks RUNS or
  // counts to N, so an empty model makes all of them no-ops without a single
  // conditional in the render path. What remains is to say the right thing
  // instead of reporting a deposit of zero tonnes, and to find a camera.
  if(!blocks||!blocks.url){
    EXPLORATION=true;
    N=0; F=new Float32Array(0); M=new Uint8Array(0);
    RUNS=[]; BUCKETS=[]; BY_CB=[]; VEINS=[]; VGROUP={}; VGROUP_NAMES=[];
    CLASS_LABELS={}; CLASS_CONFIRMED=false;

    // A camera still needs somewhere to look. Any dataset that knows its own
    // extent will do; a deck may also declare one. Guessing is not an option —
    // an exploration deck pointed at the wrong hemisphere is worse than one
    // that says it cannot place itself.
    const ext=(payload.deck&&payload.deck.settings&&payload.deck.settings.extent)||
      ((payload.assets||[]).map(a=>a.stats&&a.stats.bounds).filter(Boolean)[0])||null;
    if(!ext||!ext.x||!ext.y)
      throw new Error('this deck has no block model and nothing that declares '+
                      'where it is — add a property outline, a survey grid, or '+
                      'an extent on the deck');
    const z=ext.z||[0,0];
    EMIN=ext.x[0]; NMIN=ext.y[0];
    EX=Math.max(1,ext.x[1]-ext.x[0]); EY=Math.max(1,ext.y[1]-ext.y[0]);
    CE=(ext.x[0]+ext.x[1])/2; CN=(ext.y[0]+ext.y[1])/2; CZ=(z[0]+z[1])/2;
    ZTOP=z[1]; ZBOT=z[0];
    TONNES_PER_BLOCK=0;

    PROV={source:(payload.deck&&payload.deck.title)||null,
          exploration:true,
          total:{blocks:0,tonnes:0,grade_gt:0,oz:0}, by_class:{},
          class_confirmed:false, drills_synthetic:false, site_synthetic:false,
          geophys_synthetic:false, blocks_synthetic:false,
          datasets:(payload.assets||[]).map(a=>a.kind)};
    BLOCKS_SYNTHETIC=false;
    HOLES=[]; HIGHLIGHTS=[]; SITE={areas:[],roads:[],labels:[],claims:[]};
    SITE_SYNTHETIC=false; REAL_CLAIMS=[]; CLAIMS_ATTRIB='';
    GEOPHYS={}; GEOPHYS_SYNTHETIC=false; THUMBS=[]; STATIONS=[];
    await loadSideArtifacts(assetsOf(zones[0] && zones[0].id));

    const chs0=(payload.chapters||[]).map(mapChapter);
    CHAPTERS=chs0.length?chs0:[{h:30,p:-28,r:Math.max(2500,Math.max(EX,EY)*1.6),
      ground:1.0,mode:'grade',dwell:10,section:'Overview',
      title:(payload.deck&&payload.deck.title)||'The property',
      body:'An exploration-stage project. There is no resource estimate, so no '+
           'tonnage, grade or contained metal is reported.'}];
    if(payload.deck&&payload.deck.title){
      document.title=payload.deck.title+' · Orebody Present';
      applyHolderLogos(payload.project);
      const bn2=document.querySelector('#brand .n');
      if(bn2){ bn2.textContent=payload.deck.title;
        const pn=(payload.project||{}).name;
        if(pn){ bn2.appendChild(document.createElement('br'));
                bn2.appendChild(document.createTextNode(pn)); } }
      const it2=$('intro_t'), is2=$('intro_s');
      if(it2) it2.textContent=payload.deck.title;
      if(is2) is2.textContent=(payload.deck.subtitle)||
        [(payload.project||{}).name,(payload.project||{}).location].filter(Boolean).join(' — ')||
        'Exploration stage — no resource estimate.';
    }
    setStat('');
    return;
  }
  // Refuse rather than guess. The readout sums share-weighted rollups because
  // 10.9% of blocks in a typical vein model straddle two domains — deriving
  // vein tonnage from the dominant-domain column instead overstates some veins
  // by a third while the deposit total still reconciles, which is precisely the
  // error that is invisible once published.
  if(!blocks.buckets_url)
    throw new Error('this deck is missing its bucket rollups, so its tonnages cannot be shown');

  setStat('loading block model…');
  const [buf,bj]=await Promise.all([
    fetch(blocks.url).then(r=>{ if(!r.ok) throw new Error('the block model could not be downloaded'); return r.arrayBuffer(); }),
    fetch(blocks.buckets_url).then(r=>{ if(!r.ok) throw new Error('the bucket rollups could not be downloaded'); return r.json(); })]);

  const stats=blocks.stats||{};
  if(!stats.total) throw new Error('this block model carries no totals');
  if(bj.share_weighted===false && (stats.veins||[]).length>1)
    throw new Error('the rollups for this model are not share-weighted, so per-vein tonnage would be wrong');

  LADDER=bj.ladder||LADDER;
  BUCKETS=bj.buckets||[];
  BY_CB=bj.by_cb||[];

  const cols=unpackOreb(buf);
  const model=buildModel(cols,stats);
  F=model.F; M=model.M; RUNS=model.RUNS; N=model.N;

  // Extents come from the COLUMNS, not from the stats file.
  //
  // This used to be `stats.bounds || {x:[0,1],y:[0,1],z:[0,1]}`, and a stats
  // file without bounds therefore put the deposit's centre at easting 0.5,
  // northing 0.5 — which in UTM zone 10N is the Gulf of Guinea. The deck did
  // not fail. It rendered a working rail, correct chapter text and a correct
  // tonnage over a completely black screen, with the model twelve thousand
  // kilometres from the property and the camera pointed at open ocean. There
  // is no worse way to be wrong than silently and plausibly.
  //
  // The blocks are right here, so the extent is not something to be told: it
  // is something to measure. Derived bounds cannot disagree with the geometry
  // that gets drawn, which removes the failure rather than defaulting it.
  const b=(function(){
    if(!cols.n) throw new Error('this block model has no blocks in it');
    let xn=Infinity,xx=-Infinity,yn=Infinity,yx=-Infinity,zn=Infinity,zx=-Infinity;
    for(let i=0;i<cols.n;i++){
      const x=cols.x[i], y=cols.y[i], z=cols.z[i];
      if(x<xn)xn=x; if(x>xx)xx=x;
      if(y<yn)yn=y; if(y>yx)yx=y;
      if(z<zn)zn=z; if(z>zx)zx=z;
    }
    const o=cols.origin;
    const got={x:[o[0]+xn,o[0]+xx], y:[o[1]+yn,o[1]+yx], z:[o[2]+zn,o[2]+zx]};
    // If the extractor recorded bounds too, they should agree. They are not
    // used — the geometry wins — but a disagreement means one of the two is
    // describing a different model, and that is worth saying out loud.
    const dec=stats.bounds;
    if(dec&&dec.x&&dec.y){
      const dx=Math.abs((dec.x[0]+dec.x[1])/2-(got.x[0]+got.x[1])/2);
      const dy=Math.abs((dec.y[0]+dec.y[1])/2-(got.y[0]+got.y[1])/2);
      const span=Math.max(1,(got.x[1]-got.x[0])+(got.y[1]-got.y[0]));
      if(dx+dy>span*0.5)
        console.warn('Orebody: the recorded bounds disagree with the blocks — '+
                     'using the blocks.', dec, got);
    }
    return got;
  })();
  EMIN=cols.origin[0]; NMIN=cols.origin[1];
  EX=b.x[1]-b.x[0]; EY=b.y[1]-b.y[0];
  CE=(b.x[0]+b.x[1])/2; CN=(b.y[0]+b.y[1])/2; CZ=(b.z[0]+b.z[1])/2;
  ZTOP=b.z[1]; ZBOT=b.z[0];
  // A per-block density model has no single tonnes-per-block. Rather than
  // inventing one, fall back to the deposit total divided by its block count,
  // which is exact in aggregate and is all the readout uses it for.
  TONNES_PER_BLOCK=stats.tonnes_per_block ||
                   (stats.total.blocks?stats.total.tonnes/stats.total.blocks:675);

  VEINS=stats.veins||[];
  // No curated vein grouping for a hydrated deck: colour by domain index and
  // let the palette wrap. Inventing groupings for someone else's domains would
  // be asserting a geological interpretation nobody made.
  VGROUP={}; VGROUP_NAMES=VEINS.slice(0,9);
  VEINS.forEach((v,i)=>{VGROUP[i]=i%9;});

  const p=payload.project||{};
  // Whatever grid the project is in, provided we can define it.
  if(p.epsg) PROJ=useProjection(p.epsg);

  PROV={
    source:blocks.label||null,
    scanned_rows:stats.scanned_rows,
    mineralized_blocks:stats.total.blocks,
    dropped_blocks:stats.dropped_blocks||0,
    straddlers:stats.blocks_straddling_multiple_domains||0,
    block_m3:stats.block_m3, density:stats.density,
    tonnes_per_block:stats.tonnes_per_block,
    total:stats.total, by_class:stats.by_class||{},
    // Nobody has checked a hydrated deck's class mapping against a technical
    // report, and the viewer must not imply otherwise.
    class_confirmed:false,
    drills_synthetic:false, site_synthetic:false, geophys_synthetic:false,
    blocks_synthetic:!!blocks.synthetic,
  };
  CLASS_CONFIRMED=false;
  CLASS_LABELS=Object.keys(stats.by_class||{}).reduce((o,k)=>{o[k]='Class '+k;return o;},{});
  // The gravest fabricated layer there is: if the model itself is synthetic,
  // every number in the readout is invented, not just a decoration on top of
  // real ones. It joins the same five paths as the rest.
  BLOCKS_SYNTHETIC=!!blocks.synthetic;

  // Never inherited from the demo — showing Elk Gold's drill holes over
  // someone else's deposit would be the worst bug this viewer could have.
  HOLES=[]; HIGHLIGHTS=[]; SITE={areas:[],roads:[],labels:[],claims:[]};
  SITE_SYNTHETIC=false; REAL_CLAIMS=[]; CLAIMS_ATTRIB='';
  GEOPHYS={}; GEOPHYS_SYNTHETIC=false; THUMBS=[]; STATIONS=[];
  await loadSideArtifacts(assetsOf(modelled[0].zone.id));

  // Every modelled zone becomes a deposit. The first is already loaded, so it
  // is marked baked and reads from the live snapshot; the rest are fetched on
  // demand through the same OREB path the fabricated second deposit uses.
  DEPOSITS=modelled.map((m,i)=>({
    key:(m.zone.slug||('zone'+i)),
    name:m.zone.name||('Zone '+(i+1)),
    synthetic:!!m.blocks.synthetic,
    baked:i===0,
    note:m.blocks.synthetic_note||m.zone.name||'',
    bin:m.blocks.url, buckets:m.blocks.buckets_url, stats:m.blocks.stats||{},
  }));

  // Targets ride on the deck's settings rather than a dataset: they are a
  // handful of named points an author types, not a file anyone exports.
  TARGETS=(((payload.deck||{}).settings||{}).targets||[])
    .filter(t=>t&&t.name&&Number.isFinite(+t.e)&&Number.isFinite(+t.n))
    .map(t=>({name:String(t.name),e:+t.e,n:+t.n,kind:t.kind||'target',dz:+t.dz||0}));

  const chs=(payload.chapters||[]).map(mapChapter);
  CHAPTERS=chs.length?chs:defaultChapters((payload.deck||{}).title);
  if(payload.deck&&payload.deck.title){
    document.title=payload.deck.title+' · Orebody Present';
    applyHolderLogos(payload.project);
    // Built as nodes, not innerHTML. Deck and project names are tenant-authored
    // strings arriving over the wire; the one place they must never land is a
    // markup sink.
    const bn=document.querySelector('#brand .n');
    if(bn){ bn.textContent=payload.deck.title;
      if(p.name){ bn.appendChild(document.createElement('br'));
                  bn.appendChild(document.createTextNode(p.name)); } }
    // The opening card is baked marketing copy for the demo. Left alone it
    // greeted a hydrated deck with another company's deposit name and a claim
    // about a gold system in the Nicola region — over someone else's model.
    const it=$('intro_t'), is=$('intro_s');
    if(it) it.textContent=payload.deck.title;
    if(is) is.textContent=payload.deck.subtitle ||
      [p.name,p.location].filter(Boolean).join(' — ') ||
      'Presented in three dimensions, on real terrain.';
  }
  setStat('');
}

// Drills, surfaces and tenure for one zone. Each is optional and each failure
// is contained: a claims file that will not load must not stop the drilling
// from drawing, and neither must stop the deck opening. The console already
// refused anything unreadable at upload, so a failure here is a signed-URL or
// network problem and is reported as one.
async function loadSideArtifacts(assets){
  const grab=async kind=>{
    const a=(assets||[]).find(x=>x.kind===kind&&x.url);
    if(!a) return null;
    try{
      const r=await withTimeout(fetch(a.url),30000,'the '+kind+' data');
      if(!r.ok) throw new Error('HTTP '+r.status);
      const j=await r.json();
      return {json:j, asset:a};
    }catch(e){
      console.warn('Orebody: could not load the '+kind+' artifact',e);
      toast('The '+kind+' data for this deck could not be loaded',5000);
      return null;
    }
  };

  const d=await grab('drills');
  if(d&&d.json&&d.json.format==='orebody-drills/1'){
    HOLES=holesFromArtifact(d.json,GRADE_FLOOR);
    DRILL_SYNTHETIC=!!d.asset.synthetic;
    // Headline intercepts, ranked the way a drill release ranks them: grade
    // times length, capped at two per hole so one deep hole cannot own the
    // whole list.
    const cand=[];
    HOLES.forEach(h=>h.segs.forEach(sg=>{
      const len=sg.t-sg.f;
      if(sg.g>=GRADE_FLOOR&&len>=2)
        cand.push({id:h.id,g:sg.g,len:Math.round(len*10)/10,at:sg.mid,score:sg.g*len});
    }));
    cand.sort((x,y)=>y.score-x.score);
    HIGHLIGHTS=[];
    cand.forEach(c=>{ if(HIGHLIGHTS.filter(h=>h.id===c.id).length>=2) return;
      if(HIGHLIGHTS.length<10) HIGHLIGHTS.push(c); });
  }

  const c=await grab('site');
  if(c&&c.json&&c.json.format==='orebody-claims/1'){
    REAL_CLAIMS=claimsFromArtifact(c.json);
    CLAIMS_ATTRIB=c.asset.label?('Boundaries as supplied: '+c.asset.label):'';
    SITE_SYNTHETIC=!!c.asset.synthetic;
  }

  // A customer's own survey. The artifact carries an extent in project
  // coordinates per product; the viewer's GEOPHYS shape wants one extent for
  // the set, so the union is used and each product keeps its own image.
  const gp=await grab('geophysics');
  if(gp&&gp.json&&gp.json.format==='orebody-geophys/1'&&(gp.json.products||[]).length){
    const ps=gp.json.products;
    const W=Math.min(...ps.map(x=>x.extent.west)), E=Math.max(...ps.map(x=>x.extent.east));
    const S=Math.min(...ps.map(x=>x.extent.south)), Nn=Math.max(...ps.map(x=>x.extent.north));
    GEOPHYS={emin:W,nmin:S,emax:E,nmax:Nn,grid:ps[0].width||512,
             dir:'', products:ps.map(x=>({key:x.key,label:x.label,unit:x.unit||'',
               note:x.file, file:x.url||x.file, extent:x.extent}))};
    GEOPHYS_SYNTHETIC=!!gp.asset.synthetic;
  }

  const gcx=await grab('geochem');
  if(gcx&&gcx.json&&gcx.json.format==='orebody-geochem/1'){
    GEOCHEM=gcx.json; GEOCHEM.synthetic=!!gcx.asset.synthetic;
  }

  const sf=await grab('surfaces');
  if(sf&&sf.json&&sf.json.format==='orebody-surfaces/1'){
    UPLOADED_SURFACES=sf.json.meshes||[];
  }
}

// One entry point for both worlds, so the scene below never has to ask which
// it is looking at.
async function bootData(){
  const t=QS.get('t');
  if(!t){
    bootPhase('downloading the block model');
    setStat('loading block model…');
    // Generous: 3.7 MB over a poor cellular link is legitimately slow. But
    // bounded, because "slow" and "never" have to be distinguishable.
    const buf=await withTimeout(
      fetch('data/elk_blocks.bin').then(r=>{
        if(!r.ok) throw new Error('the block model could not be downloaded ('+r.status+')');
        return r.arrayBuffer(); }),
      60000, 'downloading the block model');
    const cols=unpackOreb(buf);
    if(cols.n!==N) throw new Error('block model has '+cols.n+' blocks, expected '+N);
    // Interleaved into F because everything downstream indexes it that way,
    // and in FILE order because RUNS are index ranges into exactly this order.
    F=new Float32Array(N*5); M=new Uint8Array(N*2);
    for(let i=0;i<N;i++){
      F[i*5]=cols.x[i]; F[i*5+1]=cols.y[i]; F[i*5+2]=cols.z[i];
      F[i*5+3]=cols.g[i]; F[i*5+4]=cols.p[i];
      M[i*2]=cols.c[i]; M[i*2+1]=cols.v[i];
    }
    setStat('');
    return; }
  await hydrate(t);
}

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

  // ---- state ----
  // Hoisted above the WebGL check on purpose. When no context is available the
  // module bails to the text edition and RETURNS, so everything declared below
  // that point never initialises — and the text edition reaches cutVal through
  // buildDataMode -> provText -> readout. Leaving these in place put the
  // fallback in its own temporal dead zone: "Cannot access 'cutVal' before
  // initialization", thrown by the very code meant to rescue a dead page.
  //
  // 0.5 g/t is the house default everywhere: below it the low-grade halo
  // bridges the gaps between veins and the whole system merges into one mass.
  const CUT_DEFAULT=GRADE_FLOOR, CUT_DEFAULT_IDX=LADDER.indexOf(CUT_DEFAULT);
  let blocksOn=true;
  // cutHold: the presenter has taken the cut-off off the deck's rails. Chapter
  // navigation stops writing to it until Reset, so an answer given live to
  // "what if we only mined above 5 grams" survives the next slide.
  let cutHold=false;
  // Same contract as the cut-off: once a presenter dials the terrain, chapter
  // navigation stops writing to it until Reset. Answering "what does it look
  // like with the mountain back on" and then losing it at the next slide is
  // the behaviour that makes a live control useless.
  let groundHold=false;
  let mode='grade', cutIdx=CUT_DEFAULT_IDX, vein=-1, clsOn={0:true,1:true,2:true,3:true},
      cur=0, drills=false, playing=false, narrating=false, dwellTimer=null, restoring=false;
  // Hole inspection. Hoisted for the same reason everything else here is:
  // showDrills() consults it and runs long before the ledger's own code does.
  let holeView=null, focusEnts=null;
  // The in-flight deposit switch, so a transition preview can time it against
  // the camera instead of guessing whether the geometry arrived first.
  let depPromise=null;
  // The authoring bridge's state, up here for the same reason: paintUI() reads
  // authOrigin and paintUI runs on the first go(), which is ~90 lines before
  // the bridge's own code. Declared where it is used it would be in the
  // temporal dead zone for that call and every viewer would fail to boot.
  let authOrigin=null, authNoteTimer=null;
  const cutVal=()=>LADDER[cutIdx];
  // Section state, for the same reason: readout() consults it on every call.
  let sectAxis=null, sectPos=0, sectStat=null, ledgerHole=null;

// Everything anyone needs to tell us why a deck did not open, in one tap.
// Reading a stack off a phone screen and retyping it is why three reports in a
// row arrived without one.
// Where a failure reports itself. Fixed rather than derived from ?api,
// because the whole point is that it works on a deck opened with no
// parameters at all — which is every deck anyone is actually sent.
const DIAG_URL='https://czuaqwtngduvlisxonkh.supabase.co/functions/v1/diag';
let diagSent=false;
// Reports ONLY on failure. Never on a load that worked. Carries the boot
// phase, the error, the user agent, screen geometry and whether WebGL exists —
// enough to reproduce a rendering failure, and nothing about who is looking or
// what they are looking at.
function reportFailure(message, stack){
  if(diagSent) return; diagSent=true;
  try{
    const body=JSON.stringify({
      phase:BOOT_PHASE, message:String(message||'').slice(0,500),
      stack:String(stack||'').slice(0,3000),
      ua:navigator.userAgent, build:'__SWVER__',
      screen:screen.width+'x'+screen.height, dpr:window.devicePixelRatio||1,
      online:navigator.onLine, memory:navigator.deviceMemory||null,
      href:location.origin+location.pathname,
      webgl:(()=>{try{const c=document.createElement('canvas');
        return c.getContext('webgl2')?'webgl2':c.getContext('webgl')?'webgl1':'none';}
        catch(e){return 'threw';}})(),
    });
    // sendBeacon survives the page going away; fetch is the fallback for
    // browsers that refuse a beacon of this type.
    // text/plain, not application/json. JSON is not a CORS-safelisted content
    // type, so a beacon carrying it needs a preflight — and sendBeacon cannot
    // preflight. It returns true, the request is dropped, and nothing ever
    // arrives. The body is still JSON; the function reads it with .text() and
    // parses it, so the header buys nothing and costs the whole report.
    const blob=new Blob([body],{type:'text/plain;charset=UTF-8'});
    if(!navigator.sendBeacon||!navigator.sendBeacon(DIAG_URL,blob)){
      fetch(DIAG_URL,{method:'POST',headers:{'content-type':'text/plain'},
                      body:body,keepalive:true,mode:'cors'}).catch(()=>{});
    }
  }catch(e){}
}

function diagnostics(extra){
  return ['Orebody diagnostics',
    'phase: '+BOOT_PHASE,
    'url: '+location.href,
    'ua: '+navigator.userAgent,
    'screen: '+screen.width+'x'+screen.height+' @'+(window.devicePixelRatio||1)+'x',
    'online: '+navigator.onLine,
    'memory: '+(navigator.deviceMemory||'unknown')+' GB',
    'webgl2: '+(()=>{try{return !!document.createElement('canvas').getContext('webgl2');}
                     catch(e){return 'threw';}})(),
    extra||''].join('\n');
}

// ---- offline, and the reason this runs FIRST ----------------------------
// This used to sit at the end of the boot sequence, after the model download,
// after the viewer was constructed, after the first chapter had been applied.
// Every one of those can fail — and on a device where one did, registration
// never ran. So the old cache-first worker kept serving the old index.html,
// the new worker was never fetched, and the next reload failed identically.
// A phone that broke once was pinned to that build permanently, and three
// rounds of fixes never reached it.
//
// Registration is the one thing that must happen whatever else does, because
// it is how a broken build gets replaced. Nothing above it may throw.
if('serviceWorker' in navigator && location.protocol!=='file:'){
  navigator.serviceWorker.register('sw.js').then(reg=>{
    reg.addEventListener('updatefound',()=>{
      const w=reg.installing;
      if(w) w.addEventListener('statechange',()=>{
        if(w.state==='installed'&&navigator.serviceWorker.controller){
          try{ toast('Updated build available — reload to apply',7000); }catch(e){}
        }});
    });
  }).catch(()=>{});
  const paint=()=>{ const el=document.getElementById('offline'); if(!el) return;
    const on=navigator.onLine;
    el.textContent=on?'':'Offline — running from cache';
    el.classList.toggle('on',!on); };
  addEventListener('online',paint); addEventListener('offline',paint);
  addEventListener('DOMContentLoaded',paint); paint();
}

// A way back for a device already pinned to a broken build: ?fresh=1 tears
// down every worker and cache, then reloads clean. Without it the only cure on
// iOS is clearing all website data, which is a lot to ask of someone who just
// wanted to look at a deck.
if(new URLSearchParams(location.search).get('fresh')==='1'){
  (async()=>{
    try{
      const rs=await navigator.serviceWorker.getRegistrations();
      await Promise.all(rs.map(r=>r.unregister()));
      const ks=await caches.keys();
      await Promise.all(ks.map(k=>caches.delete(k)));
    }catch(e){}
    const u=new URL(location.href);
    u.searchParams.delete('fresh');
    u.searchParams.set('r',String(Date.now()%100000));
    location.replace(u.toString());
  })();
}

(async()=>{
  // A boot that hangs is the one failure this file could not report: no error,
  // no fallback, and "PREPARING PRESENTATION…" forever. Every await is now
  // bounded, but a watchdog covers whatever is not — and it names the phase,
  // which is what turns "it doesn't load" into something actionable.
  let booted=false;
  const watchdog=setTimeout(()=>{
    if(booted) return;
    const why=$('loadwhy'), act=$('loadact');
    if(why) why.textContent='Still working on: '+BOOT_PHASE+
      '. On a slow connection the model can take a while — or something is stuck.';
    if(act) act.classList.add('on');
    reportFailure('boot stalled past the watchdog','');
  },20000);
  const stopWatchdog=()=>{ booted=true; clearTimeout(watchdog); };
  try{
    $('loadtext').onclick=()=>{ stopWatchdog();
      TEXT_FALLBACK='You chose the text version while the 3D was still loading';
      try{ $('load').style.display='none'; $('intro').style.display='none'; }catch(e){}
      setDataMode(true); const t=$('datatoggle'); if(t) t.textContent='3D'; };
    $('loadcopy').onclick=()=>{
      const d=diagnostics();
      navigator.clipboard?.writeText(d).then(
        ()=>toast('Diagnostics copied — paste them to whoever sent you this'),
        ()=>{ const w=$('loadwhy'); if(w) w.textContent=d; });
    };
  }catch(e){}

  // Before anything is built. A hydrated deck replaces the model, the extents,
  // the rollups and the chapters, and every line below reads those.
  bootPhase('loading the block model');
  await bootData();

  // ---- WebGL, or the honest alternative --------------------------------
  // iOS Safari refuses a WebGL context when it is out of them — the limit is
  // per process and shared across every open tab — and also under memory
  // pressure and in Low Power Mode. Cesium's response is to throw "Error
  // constructing CesiumWidget", which this file then reported as a dead page.
  // On an iPhone 18.7 that is exactly what happened.
  //
  // The whole deck already renders without WebGL at ?data=1, as semantic HTML
  // with every figure in a real table. Failing over to it beats failing.
  // ---- WebGL, or the honest alternative --------------------------------
  // iOS Safari refuses a context when it is out of them — the limit is per
  // process and shared across every open tab — and under memory pressure and
  // in Low Power Mode. Cesium's response is to throw "Error constructing
  // CesiumWidget", which this file used to report as a dead page.
  //
  // THERE IS NO PROBE. There was one, and it was the bug: it created a context
  // to prove a context was available, then released it with
  // WEBGL_lose_context. That call is ASYNCHRONOUS — it queues the loss and
  // fires webglcontextlost on a later turn — while Cesium asks for its context
  // in the same synchronous turn. So the check for a free context was still
  // holding one when the thing it was checking for went and asked. Attempting
  // the viewer answers the question definitively and costs nothing extra.
  bootPhase('creating the 3D viewer');
  function toTextMode(why){
    bootPhase('falling back to the text version');
    TEXT_FALLBACK=why;
    try{ $('load').style.display='none'; $('intro').style.display='none'; }catch(e){}
    setDataMode(true);
    const t=$('datatoggle'); if(t) t.textContent='3D';
    const st=$('status'); if(st){ st.className=''; st.textContent=''; }
    toast(why+' — showing the text version of the deck',9000);
    console.warn('Orebody: '+why+'; rendered as text instead.');
    reportFailure(why,'');
  }

  bootPhase('contacting terrain and imagery services');
  let imagery, terrain;
  // Both of these reach a third-party service, and both already had a
  // fallback for failure — but only for a REJECTION. Timed out, the fallback
  // is reachable when the service simply never answers, which is what a
  // captive portal or a saturated mobile link actually does.
  try{ imagery=await withTimeout(Cesium.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer'),12000,'satellite imagery'); }
  catch(e){ console.warn('Orebody: falling back to OpenStreetMap tiles',e);
    imagery=new Cesium.UrlTemplateImageryProvider({url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png',maximumLevel:19,credit:'© OpenStreetMap'}); }
  try{ terrain=await withTimeout(Cesium.ArcGISTiledElevationTerrainProvider.fromUrl('https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'),12000,'terrain'); }
  catch(e){ console.warn('Orebody: falling back to flat terrain',e);
    terrain=new Cesium.EllipsoidTerrainProvider(); }

  // Each attempt asks for less than the last. What costs memory in a WebGL
  // context is the drawing buffer, and on a 3x phone screen that is ~3 Mpx —
  // multiplied by antialiasing (MSAA is several samples per pixel), again by
  // the alpha and stencil planes, and again by preserveDrawingBuffer's second
  // copy. Only preserveDrawingBuffer was being dropped before, which is the
  // smallest of those.
  let noExport=false;
  const ATTEMPTS=[
    {name:'full',        opts:{preserveDrawingBuffer:true}},
    {name:'no export',   opts:{preserveDrawingBuffer:false}, noExport:true},
    {name:'lean',        opts:{preserveDrawingBuffer:false,antialias:false,
                               alpha:false,stencil:false,powerPreference:'low-power'},
                         noExport:true},
    {name:'lean webgl1', opts:{preserveDrawingBuffer:false,antialias:false,
                               alpha:false,stencil:false,powerPreference:'low-power'},
                         webgl1:true, noExport:true},
  ];
  const mkViewer=(a)=>new Cesium.Viewer('cesiumContainer',{
    baseLayer:new Cesium.ImageryLayer(imagery),terrainProvider:terrain,
    baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,
    animation:false,timeline:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,requestRenderMode:false,
    contextOptions:{requestWebgl1:!!a.webgl1,
      webgl:Object.assign({failIfMajorPerformanceCaveat:false},a.opts)}});
  let viewer=null;
  for(const a of ATTEMPTS){
    try{
      viewer=mkViewer(a);
      if(a.noExport) noExport=true;
      if(a.name!=='full') console.info('Orebody: got a context on the "'+a.name+'" attempt');
      break;
    }catch(err){
      console.warn('Orebody: no context on the "'+a.name+'" attempt',err);
      // Cesium leaves its half-built widget in the container on failure, and
      // the next attempt would append a second one beside it.
      const host=$('cesiumContainer'); if(host) host.innerHTML='';
    }
  }
  if(!viewer){
    // Only now is it worth asking whether WebGL exists at all — there is no
    // longer a context to lose by asking, and the answer picks the message.
    let any=false;
    try{ const c=document.createElement('canvas');
         any=!!(c.getContext('webgl2')||c.getContext('webgl')); }catch(e){}
    toTextMode(any ? 'Safari would not give this page a WebGL context'
                   : 'WebGL is unavailable in this browser');
    return;
  }
  // A phone does not need a 3x backing store for this, and on a device that
  // is refusing contexts the drawing buffer is the biggest thing to give back.
  // Set before the first render so the oversized buffer is never allocated.
  const DPR=window.devicePixelRatio||1;
  if(DPR>1.5 && Math.min(screen.width,screen.height)<=500){
    viewer.resolutionScale=Math.max(0.5,1/DPR);
    console.info('Orebody: reduced resolution scale to '+viewer.resolutionScale.toFixed(2)+
                 ' for a '+DPR+'x display');
  }
  if(noExport){
    // Say so rather than leaving three buttons that fail when pressed.
    ['expPng','expPptx','expPdf','recbtn'].forEach(id=>{
      const b=$(id); if(b){ b.disabled=true;
        b.title='Image export is unavailable on this device'; }});
    toast('Running in reduced-memory mode — image export is off',7000);
  }
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
  const sw=proj4(PROJ,'WGS84',[EMIN-30,NMIN-30]);
  const ne=proj4(PROJ,'WGS84',[EMIN+EX+30,NMIN+EY+30]);
  // Property extent for the colour-pop cutout — the claim ring if the site
  // layer supplies one, otherwise a margin around the deposit itself.
  const POP_RECT=(function(){
    // Real tenure first. This only ever consulted SITE.claims — the FABRICATED
    // ring the baked demo carries — so a hydrated deck, which has real
    // boundaries and no fabricated ones, fell through to a 700 m box around
    // the orebody. The result was a pinhole of colour in an otherwise black
    // world, on a slide captioned "the land package".
    if(REAL_CLAIMS.length){
      let w=180,e=-180,s2=90,n=-90;
      REAL_CLAIMS.forEach(c=>{ for(let i=0;i<c.ll.length;i+=2){
        w=Math.min(w,c.ll[i]); e=Math.max(e,c.ll[i]);
        s2=Math.min(s2,c.ll[i+1]); n=Math.max(n,c.ll[i+1]); } });
      if(w<e&&s2<n) return Cesium.Rectangle.fromDegrees(w,s2,e,n);
    }
    const ring=(SITE.claims&&SITE.claims[0]&&SITE.claims[0].ring)||null;
    if(ring){
      let w=180,e=-180,s=90,n=-90;
      ring.forEach(c=>{const ll=proj4(PROJ,'WGS84',c);
        w=Math.min(w,ll[0]); e=Math.max(e,ll[0]); s=Math.min(s,ll[1]); n=Math.max(n,ll[1]);});
      return Cesium.Rectangle.fromDegrees(w,s,e,n);
    }
    const a=proj4(PROJ,'WGS84',[EMIN-700,NMIN-700]);
    const b=proj4(PROJ,'WGS84',[EMIN+EX+700,NMIN+EY+700]);
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
  // iOS reclaims WebGL contexts under memory pressure, and reloading straight
  // into the same allocation is how a phone gets into a loop. Once is a blip;
  // twice in a session means the device cannot hold this scene, and the text
  // edition is a better answer than a third identical attempt.
  viewer.scene.canvas.addEventListener('webglcontextlost',ev=>{
    ev.preventDefault();
    let n=0; try{ n=+(sessionStorage.getItem('orebody.ctxlost')||0)+1;
                  sessionStorage.setItem('orebody.ctxlost',String(n)); }catch(e){ n=1; }
    if(n>=2){ toTextMode('This device kept losing the 3D context'); return; }
    setStat('context lost — reloading');
    setTimeout(()=>location.reload(),1200);
  },false);

  // Grade-fade on by default: 80% of the contained metal sits in 20% of the
  // blocks, so an opaque model shows mostly low-grade halo wrapped around the
  // part that matters. Fading by grade reveals the shells without deleting
  // context the way the cut-off does.
  let fade=true, EXAG=1, groundAlpha=0.0;
  // Recomputed on a deposit change: these are the frame of reference for the
  // camera, the scale bar and the translucency window, and a second deposit
  // 2.5 km away shares none of them.
  let center=null, RADIUS=0;
  function reframeModel(){
    const c=proj4(PROJ,'WGS84',[CE,CN]);
    center=Cesium.Cartesian3.fromDegrees(c[0],c[1],CZ+GEOID);
    RADIUS=Math.max(EX,EY)*0.62;
    const a=proj4(PROJ,'WGS84',[EMIN-30,NMIN-30]);
    const b=proj4(PROJ,'WGS84',[EMIN+EX+30,NMIN+EY+30]);
    viewer.scene.globe.translucency.rectangle=
      Cesium.Rectangle.fromDegrees(a[0],a[1],b[0],b[1]);
  }
  bootPhase('placing the model on the globe');
  reframeModel();
  const toCart=(E,Nn,h)=>Cesium.Cartesian3.fromDegrees(...proj4(PROJ,'WGS84',[E,Nn]),h+GEOID);

  // One geometry per grade tier so the low tiers can be drawn undersized
  // without touching the data. Dimensions come from the model rather than being
  // fixed at Siwash North's 10 x 5 x 5 m — a 12 m block drawn as a 10 m box
  // leaves a visible lattice of gaps through the whole deposit.
  let BOXES=[];
  function rebuildBoxes(){
    BOXES=TIER_SCALE.map(s=>Cesium.BoxGeometry.fromDimensions({
      vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      dimensions:new Cesium.Cartesian3(BLOCK_DIMS[0]*s,BLOCK_DIMS[1]*s,BLOCK_DIMS[2]*s)}));
  }
  rebuildBoxes();
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
  bootPhase('projecting block positions');
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
  bootPhase('building block geometry');
  buildBase();
  bootPhase('building the deck');

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
      trace.__hole=h; trace.__trace=true; drillEnts.push(trace);
      h.segs.forEach(s=>{ if(s.g<Math.max(GRADE_FLOOR,assayMin)) return;
        const col=depthShade(ramp(s.g,false),s.d||0);
        // Assayed intervals as beads strung on the trace rather than fat rods:
        // a bead reads as a discrete sample and does not occlude the blocks
        // behind it, which is how every drill section is drawn.
        const r=Math.min(9,2.4+Math.sqrt(s.g)*1.6);
        const bead=viewer.entities.add({position:P(s.mid),
          ellipsoid:{radii:new Cesium.Cartesian3(r,r,r),material:col}});
        bead.__hole=h; drillEnts.push(bead);
        // and the grade bar out the side, length scaled by assay
        const bar=viewer.entities.add({polyline:{
          positions:[P(s.mid),P(s.bar)], width:3, material:col,
          depthFailMaterial:ghost(col)}});
        bar.__hole=h; bar.__seg=s; drillEnts.push(bar);
      });
      // A collar is a physical thing on the ground; a solid marker reads as one
      // where a screen-space dot reads as a UI annotation.
      const collar=viewer.entities.add({position:P(h.collar),
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
               disableDepthTestDistance:Number.POSITIVE_INFINITY}});
      collar.__hole=h; drillEnts.push(collar);
    });
    return drillEnts;
  }
  const showDrills=on=>{ if(drillEnts) drillEnts.forEach(e=>{
    if(!on){ e.show=false; return; }
    // Inspecting one hole, everything here is the wrong size. These beads,
    // collar cubes and id tags are metres-in-the-world furniture proportioned
    // for a 2 km camera; from 400 m they are boulders, and forty holes' worth
    // of them buries the one hole that was clicked. So the neighbours keep
    // their traces, for context and for the fact that a drill programme is a
    // pattern, and everything else stands down in favour of the close-range
    // rendering built for the focused hole.
    if(holeView){
      const mine=e.__hole===ledgerHole;
      // The focused hole draws its own, heavier trace. Its overview one would
      // sit inside that and z-fight it.
      e.show=!!e.__trace && !mine;
      if(e.__trace) e.polylineVolume.material=new Cesium.ColorMaterialProperty(
        new Cesium.Color(0.80,0.83,0.80,0.13));
      return;
    }
    if(e.__trace) e.polylineVolume.material=new Cesium.ColorMaterialProperty(
      new Cesium.Color(0.87,0.89,0.87,0.55));
    e.show = !(hiOn && e.label);   // collar tags off while callouts are up
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
      const ll=proj4(PROJ,'WGS84',[d.at[0],d.at[1]]);
      const at=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],zf(d.at[2])+GEOID);
      const side=i%2?1:-1, tier=Math.floor(i/2);
      const off=proj4(PROJ,'WGS84',
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

  // ---- recorder ----
  // Capture whatever the presenter actually does — flying around, toggling
  // layers, drawing on it — as a video file they can drop into a deck or post.
  // The WebGL canvas alone would miss the ink and the burned-in disclaimer, so
  // a compositor canvas redraws the scene plus the overlay every frame and it
  // is THAT stream which gets recorded.
  let rec=null, recChunks=[], recTimer=null, recStart=0, recComp=null, recRAF=null;
  function recSupported(){
    return typeof MediaRecorder!=='undefined' &&
           !!HTMLCanvasElement.prototype.captureStream;
  }
  function pickMime(){
    const want=['video/mp4;codecs=avc1','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
    for(const m of want) if(MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }
  // One place that owns the recorder's UI state. It used to be set in startRec
  // and cleared in stopRec, so any path that ended a recording without going
  // through stopRec — an error, a stream ending, a double click — left the
  // button stuck showing "recording" with nothing recording.
  function recUI(on){
    $('recbtn').classList.toggle('rec',on);
    $('recdot').classList.toggle('on',on);
    if(!on){ clearInterval(recTimer); recTimer=null; $('rectime').textContent=''; }
  }
  function startRec(){
    if(rec) return;                       // already running
    if(!recSupported()){ toast('Recording not supported in this browser',4000); return; }
    const src=viewer.scene.canvas;
    recComp=document.createElement('canvas');
    recComp.width=src.width; recComp.height=src.height;
    const cx=recComp.getContext('2d');
    const draw=()=>{
      viewer.render();
      cx.drawImage(src,0,0);
      // presenter ink, scaled from CSS pixels into the capture buffer
      if(strokes.length){
        const sx=recComp.width/innerWidth, sy=recComp.height/innerHeight;
        cx.lineCap='round'; cx.lineJoin='round';
        for(const s of strokes){ if(s.pts.length<2) continue;
          cx.strokeStyle=s.c; cx.lineWidth=s.w*sx; cx.beginPath();
          cx.moveTo(s.pts[0][0]*recComp.width, s.pts[0][1]*recComp.height);
          for(let i=1;i<s.pts.length;i++)
            cx.lineTo(s.pts[i][0]*recComp.width, s.pts[i][1]*recComp.height);
          cx.stroke(); }
      }
      // the same disclaimer that is burned into stills — a video leaves the app
      // just as permanently, and fabricated layers must travel labelled.
      const S=recComp.width/1440, pad=Math.round(22*S);
      const f=foot();
      cx.font=Math.round(13*S)+'px ui-monospace, monospace';
      cx.textBaseline='bottom';
      const w=cx.measureText(f).width, h=Math.round(24*S);
      cx.fillStyle='rgba(7,9,10,.82)';
      cx.fillRect(pad-Math.round(9*S), recComp.height-pad-h, w+Math.round(18*S), h);
      cx.fillStyle='#C6CAC5';
      cx.fillText(f, pad, recComp.height-pad-Math.round(6*S));
      recRAF=requestAnimationFrame(draw);
    };
    draw();
    const mime=pickMime();
    recChunks=[];
    rec=new MediaRecorder(recComp.captureStream(30), mime?{mimeType:mime}:undefined);
    rec.ondataavailable=e=>{ if(e.data.size) recChunks.push(e.data); };
    rec.onerror=()=>{ recUI(false); cancelAnimationFrame(recRAF); rec=null;
      toast('Recording failed',4000); };
    rec.onstop=()=>{
      recUI(false);
      cancelAnimationFrame(recRAF);
      const type=rec.mimeType||mime||'video/webm';
      const ext=type.indexOf('mp4')>=0?'mp4':'webm';
      const blob=new Blob(recChunks,{type:type});
      dl('elk-gold-walkthrough.'+ext, URL.createObjectURL(blob));
      toast('Saved '+ext.toUpperCase()+' \u2014 '+(blob.size/1e6).toFixed(1)+' MB',5000);
      rec=null; recComp=null;
    };
    rec.start(1000);
    recStart=performance.now();
    recUI(true);
    recTimer=setInterval(()=>{
      const s=Math.round((performance.now()-recStart)/1000);
      $('rectime').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+
                               String(s%60).padStart(2,'0');
    },500);
    toast(pickMime().indexOf('mp4')>=0
      ? 'Recording — MP4' : 'Recording — WebM (this browser has no MP4 encoder)',4500);
  }
  function stopRec(){
    if(!rec){ recUI(false); return; }     // clear a stale badge either way
    try{ rec.stop(); }catch(e){ recUI(false); rec=null; }
  }

  // ---- asset only ----
  // One control for "show me the orebody and nothing else". Turning six toggles
  // off by hand to get a clean look at the zones is exactly the kind of thing
  // nobody does mid-presentation, so it needs to be a single press. It is a
  // MODE, not a one-shot: it survives chapter changes, because otherwise the
  // next slide's declared overlays would immediately undo it.
  let assetOnly=false, assetSaved=null;
  function setAssetOnly(on){
    assetOnly=on;
    if(on){
      assetSaved={drills:drills, hi:hiOn, site:siteOn, depth:depthOn,
                  stage:stageIdx, plan:planOn, sect:sectAxis, sectPos:sectPos,
                  geo:geoKey};
      setDrills(false); hiOn=false; siteOn=false; depthOn=false; planOn=false;
      if(stageIdx>=0){ showStage(-1); $('stage').value=-1; }
      if(sectAxis){ sectAxis=null; setSection(null); }
      setPin(null);
      inkClearAll();
      blocksOn=true;
    } else if(assetSaved){
      setDrills(assetSaved.drills); hiOn=assetSaved.hi; siteOn=assetSaved.site;
      depthOn=assetSaved.depth; planOn=assetSaved.plan;
      if(assetSaved.sect){ sectAxis=assetSaved.sect; setSection(sectAxis,assetSaved.sectPos); }
      if(assetSaved.stage>=0){ $('stage').value=assetSaved.stage; showStage(assetSaved.stage); }
      if(assetSaved.geo) geoShow(assetSaved.geo);
      assetSaved=null;
    }
    // Asset-only means the orebody and nothing else, and a presenter's markup
    // is very much something else. It comes back on exit rather than being
    // discarded — this is a view mode, not an eraser.
    if(on&&areaMode) setAreaMode(false);
    areaEnts.forEach(e=>e.show=!on);
    syncOverlayControls();
    $('assetbtn').classList.toggle('on',on);
    $('assetbtn').textContent=on?'Asset \u2713':'Asset';
    apply();
  }
  // Keep every overlay control showing the truth after a bulk change.
  function syncOverlayControls(){
    const seg=(id,attr,val)=>$(id) && $(id).querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset[attr]||'')===String(val)));
    seg('drillseg','d',drills?'1':'0');
    seg('hiseg','h',hiOn?'1':'0');
    seg('siteseg','s',siteOn?'1':'0');
    seg('depthseg','g',depthOn?'1':'0');
    seg('planseg','l',planOn?'1':'0');
    seg('blockseg','b',blocksOn?'1':'0');
    seg('sectseg','x',sectAxis||'');
    seg('geoseg','gp',geoKey||'');
  }

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
    h.appendChild(lead);
    // Only shown when this page IS the fallback. Context limits are per
    // process and shared across tabs, so closing a few and retrying genuinely
    // works — but only if there is something to retry with.
    if(TEXT_FALLBACK){
      const why=document.createElement('p'); why.className='lead';
      why.style.color='#8C948C';
      why.textContent=TEXT_FALLBACK+'. The 3D view needs WebGL. On iPhone the '+
        'usual causes are Lockdown Mode, which disables WebGL entirely, or too '+
        'many other Safari tabs — contexts are shared across all of them. '+
        'Close a few and try again.';
      const b=document.createElement('button');
      b.textContent='Try the 3D view again';
      b.style.cssText='margin-top:14px;font:600 13px system-ui;padding:12px 18px;'+
        'border-radius:5px;border:1px solid #C99A3A;background:#C99A3A;color:#07090A;cursor:pointer';
      b.onclick=()=>location.reload();
      h.appendChild(why); h.appendChild(b);
    }
    wrap.appendChild(h);

    const totals=document.createElement('section');
    totals.innerHTML='<h2>Deposit total</h2>';
    const tt=document.createElement('table');
    tt.innerHTML='<caption>At the '+GRADE_FLOOR+' g/t floor and above, by resource class</caption>'+
      '<thead><tr><th scope="col">Class</th><th scope="col">Tonnes</th>'+
      '<th scope="col">Grade</th><th scope="col">Contained</th></tr></thead>';
    const tb=document.createElement('tbody');
    Object.keys(PROV.by_class).forEach(k=>{
      const s=statsAbove(GRADE_FLOOR,{classes:[+k]});
      // Omitted rather than zeroed: "0 t" is a measurement claim, and when
      // known is false none has been made.
      if(!s.known||!s.tonnes) return;
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
    const pre=document.createElement('pre');
    // The audit trail reports what is CURRENTLY ON SCREEN, so it reads live
    // viewer state — the cut-off, the section, the surface mode. When this
    // page is the WebGL fallback there is no viewer and that state was never
    // initialised, so computing it throws and used to take the whole text
    // edition down with it. The chapters and their figures do not depend on
    // any of that, and they are the reason someone opened this page.
    try{
      pre.textContent=provText();
    }catch(err){
      console.warn('Orebody: audit trail unavailable in text mode',err);
      pre.textContent=
        'The audit trail is unavailable here because it describes the live 3D\n'+
        'view, and this device could not start WebGL.\n\n'+
        'Deposit total: '+Math.round(PROV.total.tonnes).toLocaleString()+' t @ '+
        PROV.total.grade_gt+' g/t = '+PROV.total.oz.toLocaleString()+' oz\n'+
        'Source: '+(PROV.source||'—')+'\n\n'+
        (PROV.blocks_synthetic?'THE BLOCK MODEL ITSELF IS FABRICATED.\n':'')+
        (PROV.drills_synthetic?'Drill holes are FABRICATED.\n':'')+
        (PROV.site_synthetic?'Site features and pit stages are FABRICATED.\n':'')+
        (PROV.geophys_synthetic?'Geophysics is FABRICATED.\n':'')+
        'Illustrative visualization — not a mineral resource statement.';
    }
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
    L.push('Source            '+(PROV.source||'—'));
    // Every line below describes a block model. An exploration deck has none,
    // and reaching through the absent fields threw — which took the audit
    // trail down on exactly the decks whose provenance matters most, because
    // there are no numbers to speak for themselves.
    const num=v=>(v===undefined||v===null)?'—':Number(v).toLocaleString();
    if(!PROV.exploration){
      L.push('Rows scanned      '+num(PROV.scanned_rows));
      L.push('Mineralized       '+num(PROV.mineralized_blocks)+' blocks');
      L.push('Dropped           '+(PROV.dropped_blocks||0)+' (blocks with no vein share)');
      L.push('Straddling >1 dom '+num(PROV.straddlers)+
             ' — vein tonnage is share-weighted, never credited whole');
      L.push('Block             '+PROV.block_m3+' m3 @ '+PROV.density+
             ' t/m3 = '+PROV.tonnes_per_block+' t; ore tonnes = that x Percent_Env');
      L.push('');
      L.push('DEPOSIT TOTAL (no cut-off)');
      L.push('  '+num(PROV.total.tonnes)+' t @ '+PROV.total.grade_gt+
             ' g/t = '+num(PROV.total.oz)+' oz');
    }
    L.push('');
    if(!PROV.exploration){
      L.push('CURRENTLY ON SCREEN');
      currentPredicate().forEach(x=>L.push('  '+x));
      L.push('  => '+fmt(r.t)+' @ '+r.g.toFixed(2)+' g/t = '+fmtoz(r.oz)+
             '  ('+r.n.toLocaleString()+' blocks)');
      L.push('');
    }
    if(Object.keys(PROV.by_class||{}).length) L.push('BY CLASS');
    Object.keys(PROV.by_class||{}).forEach(k=>{
      const v=PROV.by_class[k];
      if(!v.tonnes) return;
      L.push('  '+(CLASS_LABELS[k]+'              ').slice(0,14)+
             v.tonnes.toLocaleString()+' t @ '+v.grade_gt+' g/t = '+
             v.oz.toLocaleString()+' oz');
    });
    if(PROV.exploration){
      L.push('');
      L.push('EXPLORATION STAGE');
      L.push('  No block model, and therefore no resource estimate. Nothing in');
      L.push('  this deck states a tonnage, a grade or contained metal, because');
      L.push('  none has been established.');
      L.push('  Datasets present: '+((PROV.datasets||[]).join(', ')||'none'));
    }
    L.push('');
    L.push('CAVEATS');
    // Only when there are classes to caveat. On an exploration deck this read
    // "Resource class labels ... UNCONFIRMED against the Nov-2021 technical
    // report" for a project that has no classes, no resource and no technical
    // report — a caveat about something that does not exist reads as though it
    // does. The second line was also unconditional, so it printed even when the
    // sentence it continued had been suppressed.
    if(!PROV.class_confirmed && Object.keys(PROV.by_class||{}).length){
      L.push('  Resource class labels follow MineSight convention and are UNCONFIRMED');
      L.push('  against the source technical report.');
    }
    // Author-supplied lines on a holder's card are assertions, and on a
    // NEIGHBOUR's card they are assertions about a third party. Claims and
    // hectares come from the register; these do not, and the audit trail is
    // where that distinction has to be written down.
    (function(){
      const notes=Object.keys(HOLDER_META||{})
        .filter(k=>(HOLDER_META[k]||{}).note);
      if(!notes.length) return;
      L.push('  '+notes.length+' callout note'+(notes.length===1?' is':'s are')+
             ' author-supplied, not from the tenure register:');
      notes.forEach(k=>L.push('    '+k+' — "'+HOLDER_META[k].note+'"'));
    })();
    if(PROV.drills_synthetic) L.push('  Drill holes are FABRICATED. Not real results.');
    if(PROV.site_synthetic)   L.push('  Site features and pit stages are FABRICATED. Not a mine plan.');
    if(PROV.blocks_synthetic){
      L.push('  THE BLOCK MODEL ITSELF IS FABRICATED. Every tonne, grade and');
      L.push('  ounce in this report is invented. Nothing here describes a real');
      L.push('  deposit.');
    }
    if(PROV.geophys_synthetic){
      L.push('  Geophysics is FABRICATED. No survey was flown and no published');
      L.push('  geophysical data was used; the field was synthesised FROM this');
      L.push('  block model, so its anomaly restates the deposit rather than');
      L.push('  corroborating it. Real gold systems are frequently magnetite-');
      L.push('  destructive and could read as a magnetic LOW over this ground.');
    }
    // True of the baked Elk Gold export, and of nothing else. It was printed
    // unconditionally, so every hydrated deck inherited a claim about a source
    // file it has never seen.
    if(PROV.silver_absent)
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
      const k=Math.round(F[i*5]/BLOCK_DIMS[0])+'|'+Math.round(F[i*5+1]/BLOCK_DIMS[1])+
              '|'+Math.round(F[i*5+2]/BLOCK_DIMS[2]);
      cellIndex.set(k,i);
    }
    cellIndexBuilt=true;
  }
  function pickAt(win){
    const scene=viewer.scene;
    const picked=scene.pick(win);
    if(picked && picked.id && picked.id.__hole){
      return {kind:'hole', hole:picked.id.__hole, seg:picked.id.__seg};
    }
    const pos=scene.pickPosition(win);
    if(!Cesium.defined(pos)) return null;
    const carto=Cesium.Cartographic.fromCartesian(pos);
    const ll=[Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)];
    const utm=proj4('WGS84',PROJ,ll);
    let z=carto.height-GEOID;
    if(EXAG!==1) z=CZ+(z-CZ)/EXAG;
    buildCellIndex();
    // search a small neighbourhood: the click lands on a face, not a centre
    for(let dz=0;dz<=2;dz++) for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
      for(const s of [-1,1]){
        const k=(Math.round((utm[0]-EMIN)/BLOCK_DIMS[0])+dx)+'|'+
                (Math.round((utm[1]-NMIN)/BLOCK_DIMS[1])+dy)+'|'+
                (Math.round(z/BLOCK_DIMS[2])+s*dz);
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
            ['Block', BLOCK_DIMS.join(' \u00d7 ')+' m @ '+BLOCK_DENSITY+' t/m\u00b3']];
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
    // Drawing an area takes the click entirely: opening the block inspector on
    // every vertex would bury the ground you are trying to trace.
    if(areaMode){
      const ll=groundAt(m.position);
      if(!ll){ toast('Click on the terrain',2200); return; }
      areaPts.push(ll[0],ll[1]); areaLive();
      return;
    }
    const hit=pickAt(m.position);
    // Clicking the hole in the scene does what clicking its row does. They are
    // the same object, and reaching for the list to act on something already
    // under the cursor is the friction the ledger was built to remove.
    // Already inside that hole, the click falls through to the inspector so an
    // individual assay interval can still be interrogated.
    if(hit && hit.kind==='hole' && hit.hole!==ledgerHole){ focusHole(hit.hole); return; }
    showPick(hit);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  // Double-click closes the polygon, the way every map tool does it.
  viewer.screenSpaceEventHandler.setInputAction(()=>{
    if(areaMode) areaFinish();
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  // ---- exact statistics at an arbitrary cut-off ----
  // The bucket tables are keyed to the ladder, so they can only answer ladder
  // steps. An economic cut-off is a continuous function of price and cost and
  // almost never lands on one, so this sums the blocks directly. 168k rows is
  // a couple of milliseconds and it means the economics are exact rather than
  // snapped to the nearest step.
  function statsAbove(cut, opts){
    // F is null until the model has downloaded, and the text edition can be
    // reached before that — from the boot watchdog, when the download is what
    // is stuck. Scanning a null array threw and took the whole text edition
    // down, which is a poor way for the escape hatch to behave.
    // Same SHAPE, zeroed, plus a flag — rather than null. Returning null meant
    // every one of the several call sites had to remember to check, and the
    // one that forgot took the text edition down with "cannot read 'tonnes' of
    // null". `known:false` lets a caller distinguish "nothing above the
    // cut-off" from "we cannot say yet", which is a distinction this tool
    // cares about more than most.
    if(!F||!N) return {blocks:0, tonnes:0, grade:0, oz:0, metal_g:0, known:false};
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
  // sectAxis / sectPos / sectStat are declared at the top of the module, above
  // the WebGL check — readout() consults them and the text fallback calls
  // readout() before this line would ever run. Re-declaring them here shadowed
  // the hoisted pair and put the fallback straight back in a dead zone.
  let sectEnts=null, sectPrims=null;
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
    const sw2=proj4(PROJ,'WGS84',[EMIN-5,NMIN-2.5]);
    const ne2=proj4(PROJ,'WGS84',[EMIN+EX+5,NMIN+EY+2.5]);
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
    if(!ll){ ll=proj4(PROJ,'WGS84',[x,y]); utmCache.set(k,ll); }
    return Cesium.Cartesian3.fromDegrees(ll[0],ll[1],(EXAG===1?z:(CZ+(z-CZ)*EXAG))+GEOID);
  }
  async function buildSurfaces(){
    if(surfPrims||surfLoading) return surfPrims;

    // A customer's own meshes, from OBJ / GOCAD / DXF. Raw triangles in project
    // coordinates rather than the demo's packed int16 lattice, so they take a
    // separate build — but they land as the same Primitive objects, so every
    // control that already drives surfaces drives these too.
    if(UPLOADED_SURFACES.length){
      surfLoading=true; setStat('building surfaces…');
      surfPrims=UPLOADED_SURFACES.map((m,i)=>{
        const nv=m.verts.length;
        const pos=new Float64Array(nv*3);
        for(let k=0;k<nv;k++){
          const v=m.verts[k], c=utm2cart(v[0],v[1],v[2]);
          pos[k*3]=c.x; pos[k*3+1]=c.y; pos[k*3+2]=c.z;
        }
        // Uint32 indices unconditionally: a triangulated DTM passes 65k
        // vertices easily and a silent wrap would fold the mesh in on itself.
        const ix=new Uint32Array(m.faces.length*3);
        m.faces.forEach((f,j)=>{ix[j*3]=f[0];ix[j*3+1]=f[1];ix[j*3+2]=f[2];});
        let geom=new Cesium.Geometry({
          attributes:{position:new Cesium.GeometryAttribute({
            componentDatatype:Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute:3, values:pos})},
          indices:ix, primitiveType:Cesium.PrimitiveType.TRIANGLES,
          boundingSphere:Cesium.BoundingSphere.fromVertices(pos)});
        geom=Cesium.GeometryPipeline.computeNormal(geom);
        const prim=new Cesium.Primitive({
          geometryInstances:new Cesium.GeometryInstance({geometry:geom}),
          asynchronous:true, show:false,
          appearance:new Cesium.MaterialAppearance({
            flat:false, translucent:true, faceForward:true, closed:false,
            material:Cesium.Material.fromType('Color',{
              color:Cesium.Color.fromCssColorString(
                VEIN_COLORS[i%VEIN_COLORS.length]).withAlpha(0.55)})})});
        viewer.scene.primitives.add(prim);
        // Name it in the scene. A translucent body plunging through terrain is
        // the most striking thing in a deck and the least self-explanatory —
        // the reference decks label theirs "Valentine Lake Shear Zone", and an
        // unlabelled one is just a coloured shape.
        let cx=0,cy=0,cz=0;
        m.verts.forEach(v=>{cx+=v[0];cy+=v[1];cz+=v[2];});
        const k=m.verts.length||1;
        const lab=viewer.entities.add({
          position:utm2cart(cx/k,cy/k,cz/k+120),
          label:{text:m.name||('Surface '+(i+1)),
            font:'600 13px Archivo, system-ui, sans-serif',
            fillColor:Cesium.Color.fromCssColorString(VEIN_COLORS[i%VEIN_COLORS.length]),
            showBackground:true,
            backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.82),
            backgroundPadding:new Cesium.Cartesian2(9,6),
            verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
            scaleByDistance:new Cesium.NearFarScalar(1500,1.0,16000,0.55),
            disableDepthTestDistance:Number.POSITIVE_INFINITY}});
        lab.show=false;
        return {name:m.name||('Surface '+(i+1)), kind:'vein', prim:prim, label:lab};
      });
      surfLoading=false; setStat('');
      return surfPrims;
    }

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
      if(!mode){ s.prim.show=false; if(s.label) s.label.show=false; return; }
      if(mode==='cores') s.prim.show = s.kind==='shell';
      else s.prim.show = s.kind==='vein' && (vein===-1 || VEINS[vein]===s.name);
      if(s.label) s.label.show=s.prim.show;
    });
  }

  // ---- property columns --------------------------------------------------
  // The orientation view: one vertical bar per cell of a coarse grid over the
  // WHOLE property, height and colour carrying accumulated grade x thickness,
  // with every deposit labelled on a leader line. It answers "where is the
  // metal on this land package" in one frame, which no per-deposit view can.
  //
  // It is the plan map's accumulator extruded, not a new number: buildPlanMap
  // already sums grade x thickness x ore-fraction down each column to colour a
  // raster. Same quantity, same floor, shown as height instead of hue — so the
  // two views cannot disagree about where the metal is.
  //
  // Gram-metres is the honest unit here. It is NOT tonnes: a tall bar means a
  // long, rich intercept under that cell, and comparing bars compares
  // intersections rather than resources. The legend says so, because a bar
  // chart with no scale is decoration.
  const PROP_CELL=40;            // m of ground per column
  const PROP_MAXH=520;           // m of bar at the top of the scale
  const PROP_RAMP=['#2C5FA8','#3B82D6','#5EC8E8','#9B7BE8','#D053B8','#F472B6'];
  let propOn=false, propPrims=null, propLabelEnts=null, propMax=0,
      propSyn=false, propBusy=false;

  async function buildProperty(){
    if(propPrims||propBusy) return propPrims;
    propBusy=true; setStat('building property columns…');
    try{
      // Every deposit contributes, including ones not currently loaded. The
      // active one is read live rather than from its cached snapshot, so a
      // deposit the presenter just switched to is not one edit stale.
      const parts=[];
      for(const d of DEPOSITS){
        const st=(d.key===depKey)?modelState():await depState(d);
        parts.push({d:d,st:st});
        if(d.synthetic) propSyn=true;
      }
      let W=Infinity,S=Infinity,E=-Infinity,Nn=-Infinity;
      parts.forEach(p=>{const s=p.st;
        W=Math.min(W,s.EMIN); S=Math.min(S,s.NMIN);
        E=Math.max(E,s.EMIN+s.EX); Nn=Math.max(Nn,s.NMIN+s.EY);});
      const nx=Math.ceil((E-W)/PROP_CELL)+1, ny=Math.ceil((Nn-S)/PROP_CELL)+1;
      const acc=new Float64Array(nx*ny);
      const top=new Float64Array(nx*ny).fill(-1e9);
      parts.forEach(p=>{
        const s=p.st, th=s.BLOCK_DIMS[2];
        for(let i=0;i<s.N;i++){
          const g=s.F[i*5+3];
          if(g<GRADE_FLOOR-1e-9) continue;
          const gx=Math.round((s.F[i*5]+s.EMIN-W)/PROP_CELL);
          const gy=Math.round((s.F[i*5+1]+s.NMIN-S)/PROP_CELL);
          if(gx<0||gx>=nx||gy<0||gy>=ny) continue;
          const k=gy*nx+gx;
          // grade x thickness x ore fraction — the same product the plan map
          // accumulates, so a cell reads identically in both views.
          acc[k]+=g*th*s.F[i*5+4];
          const z=s.F[i*5+2];
          if(z>top[k]) top[k]=z;
        }
      });
      // Percentile-clipped, like the plan map: a couple of extreme columns
      // would otherwise flatten every other bar to nothing.
      const vals=[]; for(let k=0;k<acc.length;k++) if(acc[k]>0) vals.push(acc[k]);
      vals.sort((a,b)=>a-b);
      if(!vals.length){ setStat(''); propBusy=false; return null; }
      propMax=vals[Math.floor(vals.length*0.98)]||vals[vals.length-1];

      // One primitive per colour band rather than per column: 4,000 separate
      // primitives is 4,000 draw calls, and the bands are what the legend
      // decodes anyway.
      const bands=PROP_RAMP.map(()=>[]);
      for(let k=0;k<acc.length;k++){
        const v=acc[k]; if(v<=0) continue;
        const u=Math.min(1,v/propMax);
        const bi=Math.min(PROP_RAMP.length-1,Math.floor(u*PROP_RAMP.length));
        const gx=k%nx, gy=(k-gx)/nx;
        // Height on a gentle curve so the low tail stays visible rather than
        // collapsing onto the ground.
        const h=Math.max(18,PROP_MAXH*Math.pow(u,0.7));
        bands[bi].push({e:W+gx*PROP_CELL, n:S+gy*PROP_CELL,
                        base:top[k], h:h});
      }
      propPrims=[];
      bands.forEach((cells,bi)=>{
        if(!cells.length) return;
        const inst=cells.map(c=>{
          const geom=Cesium.BoxGeometry.fromDimensions({
            vertexFormat:Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            dimensions:new Cesium.Cartesian3(PROP_CELL*0.72,PROP_CELL*0.72,c.h)});
          const zc=c.base+c.h/2;
          return new Cesium.GeometryInstance({geometry:geom,
            modelMatrix:Cesium.Transforms.eastNorthUpToFixedFrame(
              toCart(c.e,c.n,EXAG===1?zc:(CZ+(zc-CZ)*EXAG)))});
        });
        const prim=new Cesium.Primitive({geometryInstances:inst,asynchronous:true,
          show:false,
          appearance:new Cesium.MaterialAppearance({flat:false,translucent:true,
            material:Cesium.Material.fromType('Color',{
              color:Cesium.Color.fromCssColorString(PROP_RAMP[bi]).withAlpha(0.92)})})});
        viewer.scene.primitives.add(prim);
        propPrims.push(prim);
      });

      // One leader-line label per deposit, at its own centroid — the thing the
      // reference decks do that turns a field of bars into a map you can talk
      // over.
      propLabelEnts=[];
      parts.forEach(p=>{
        const s=p.st;
        const e=s.EMIN+s.EX/2, n=s.NMIN+s.EY/2;
        const base=toCart(e,n,s.ZTOP);
        const tip=toCart(e,n,s.ZTOP+PROP_MAXH+260);
        propLabelEnts.push(viewer.entities.add({polyline:{positions:[base,tip],
          width:1,material:Cesium.Color.WHITE.withAlpha(.42),
          arcType:Cesium.ArcType.NONE}}));
        propLabelEnts.push(viewer.entities.add({position:tip,
          label:{text:p.d.name+(p.d.synthetic?'  (fabricated)':''),
            font:'600 14px Archivo, system-ui, sans-serif',
            fillColor:p.d.synthetic?Cesium.Color.fromCssColorString('#D9584A')
                                   :Cesium.Color.WHITE,
            showBackground:true,
            backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.86),
            backgroundPadding:new Cesium.Cartesian2(10,6),
            verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
            // Labels shrink with distance but never vanish, so the property
            // view stays readable from the altitude it is meant to be seen at.
            scaleByDistance:new Cesium.NearFarScalar(1500,1.0,14000,0.55),
            disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
      });
      setStat('');
      return propPrims;
    } finally { propBusy=false; }
  }

  async function showProperty(on){
    if(on) await buildProperty();
    if(propPrims) propPrims.forEach(p=>p.show=on);
    if(propLabelEnts) propLabelEnts.forEach(e=>e.show=on);
    $('propleg').style.display=on?'flex':'none';
    if(on&&propMax){
      $('propleg').innerHTML='<span>Grade &times; thickness</span>'+
        PROP_RAMP.map(c=>'<div class="k"><span class="sw" style="background:'+c+
          '"></span></div>').join('')+
        '<span>0 → '+Math.round(propMax).toLocaleString()+' g·m</span>';
    }
  }
  // Frame the whole land package rather than one orebody.
  function frameProperty(){
    if(!propPrims) return;
    let W=Infinity,S=Infinity,E=-Infinity,Nn=-Infinity,zt=-Infinity;
    DEPOSITS.forEach(d=>{
      const s=(d.key===depKey)?modelState():d._state||(d.baked?bakedSnap:null);
      if(!s) return;
      W=Math.min(W,s.EMIN); S=Math.min(S,s.NMIN);
      E=Math.max(E,s.EMIN+s.EX); Nn=Math.max(Nn,s.NMIN+s.EY);
      zt=Math.max(zt,s.ZTOP);});
    if(!isFinite(W)) return;
    const c=toCart((W+E)/2,(S+Nn)/2,zt);
    const r=Math.max(E-W,Nn-S)*0.75+PROP_MAXH;
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(c,r),
      {duration:REDUCED?0:2.2,
       offset:new Cesium.HeadingPitchRange(rad(18),rad(-27),r*2.6)});
  }

  // ---- site features: claims, infrastructure, roads, labels ----
  // Clamped to terrain rather than floated at a guessed elevation, so they sit
  // on the actual ground the deposit is under.
  let siteEnts=null, siteOn=false, targetsOn=true;
  // Holder logos, supplied and never scraped: a company's mark is its
  // trademark, and generating one for a neighbour would put a fake identity on
  // a real map. Decoded once at boot into a cache the card renderer can read
  // synchronously; the site layer rebuilds when they land so a logo that
  // arrives late still appears.
  const LOGO_IMG={};
  let BRAND_IMG=null, logosReady=false;
  // What the last build put on screen, for the checks that have to assert the
  // cards rather than the data behind them.
  const CARD_LOG=[];
  function preloadLogos(){
    const src=Object.assign({}, (typeof HOLDER_LOGOS==='object'&&HOLDER_LOGOS)||{});
    if(BRAND&&BRAND.logo) src['\u0000brand']=BRAND.logo;
    const keys=Object.keys(src);
    if(!keys.length){ logosReady=true; return Promise.resolve(); }
    return Promise.all(keys.map(k=>new Promise(res=>{
      const im=new Image();
      im.onload=()=>{
        if(k==='\u0000brand') BRAND_IMG=im;
        else LOGO_IMG[normOwner(k)]=im;
        res(); };
      // A logo that will not decode is not worth failing a deck over. The card
      // falls back to a monogram, which is what it does when none was supplied.
      im.onerror=()=>res();
      im.src=src[k];
    }))).then(()=>{ logosReady=true; });
  }

  // Registers shout. "BARRANCO GOLD MINING CORP." set in caps on a card is the
  // register's formatting, not a company's name as anyone writes it.
  function titleCase(n){
    const small=/^(and|of|the|de|du|von|van)$/i;
    const acronym=/^(BC|USA|UK|NL|JV|II|III|IV)$/;
    return (n||'').toLowerCase().replace(/\s+/g,' ').trim()
      .split(' ').map((w,i)=>{
        const up=w.toUpperCase().replace(/[^A-Z]/g,'');
        if(acronym.test(up)) return w.toUpperCase();
        if(i&&small.test(w)) return w;
        return w.replace(/^[a-z]/,ch=>ch.toUpperCase());
      }).join(' ')
      .replace(/\bCorp\b\.?/,'Corp.').replace(/\bLtd\b\.?/,'Ltd.')
      .replace(/\bInc\b\.?/,'Inc.');
  }

  function buildSite(){
    if(siteEnts||!SITE.areas) return siteEnts;
    siteEnts=[];
    const deg=r=>r.reduce((acc,c)=>{const ll=proj4(PROJ,'WGS84',c);acc.push(ll[0],ll[1]);return acc;},[]);
    // Claims are REAL public BC tenures, so they are drawn solid while every
    // fabricated site feature stays dashed. The dash is the tell across this
    // whole layer: invented geometry is dashed and captioned "conceptual",
    // surveyed geometry is not. Do not restyle one without the other.
    //
    // Already WGS84, so no proj4 hop — deg() is for the UTM site features.
    if(REAL_CLAIMS.length){
      // Naming the neighbour is the point. "A listed company holds the claims
      // along strike" is often the most interesting thing on this map, and it
      // is not something an issuer can assert about itself — only the register
      // can say it.
    const HOLDERS=rollHolders(REAL_CLAIMS, CLAIMS_SUBJECT);
    CARD_LOG.length=0;
    // Who owns what, and the one thing this layer must never get wrong.
    //
    // `_subject` on a tenure means it OVERLAPS THE DEPOSIT EXTENT, not that we
    // own it. Several neighbours do — Coast Copper's Home Brew sits right on
    // the deposit. The old test was `c.subject || !c.neighbour`, so that claim
    // rendered in the issuer's gold: the deck drew a competitor's ground as its
    // own, immediately beside the orebody, on the slide about who holds what.
    // Ownership is the owner name and nothing else. Where a supplied file
    // declares no subject owner there is nothing to compare against, and the
    // positional flags are the only thing left.
    const norm=normOwner;
    const SUBJ=norm(CLAIMS_SUBJECT);
    const isMine=c=>SUBJ ? norm(c.owner)===SUBJ : (c.subject||!c.neighbour);

    // A neighbour's palette. Cool tones only: it must share nothing with the
    // grade ramp, which owns green through magenta, and nothing with the gold
    // the issuer's own ground is drawn in. Assigned by rank, so the neighbour
    // worth talking about gets the strongest colour rather than whichever
    // happened to come first out of the register.
    const NB_HUES=['#4EC9B0','#5B8DEF','#A78BFA','#22D3EE','#7FB77E','#C0A16B'];
    const holderStyle={};
    let hi_=0;
    (HOLDERS||[]).filter(h=>!h.subject &&
        ((HOLDER_META&&HOLDER_META[norm(h.owner)]&&
          typeof HOLDER_META[norm(h.owner)].feature==='boolean')
            ? HOLDER_META[norm(h.owner)].feature : h.corporate))
      .forEach(h=>{ holderStyle[norm(h.owner)]=NB_HUES[hi_++%NB_HUES.length]; });
    const hueFor=c=>isMine(c) ? '#F2C14E' : (holderStyle[norm(c.owner)] || '#7C8792');

    // Trade-off worth stating: a company gets a coloured, filled parcel with
    // its name on it; a private individual gets a grey outline and no name.
    // Ten of the sixteen holders here are people. "A listed copper company
    // holds the ground along strike" is what an investor came for; a named
    // private citizen on an investor deck is a decision, not a default.
    // Featured, in this order of authority: what the author chose, then the
    // company/person default. A neighbour is only interesting when it is
    // somebody an audience has heard of, and only the author knows which.
    const metaOf=o=>(HOLDER_META&&HOLDER_META[norm(o)])||{};
    const featured=h=>{
      const m=metaOf(h.owner);
      return (m.feature===undefined) ? !!h.corporate : m.feature;
    };
    const featSet={};
    (HOLDERS||[]).forEach(h=>{ if(!h.subject&&featured(h)) featSet[norm(h.owner)]=1; });
    const named=c=>!isMine(c) && !!featSet[norm(c.owner)];

    // Dissolve each holder's tenure into one outline.
    //
    // A company with twenty-nine adjacent cell claims was drawn as
    // twenty-nine rectangles, and what an audience saw was a grid of internal
    // fences. Nobody holds "twenty-nine rectangles" — they hold one property,
    // and the line that matters is the one around the outside of it. The
    // internal boundaries are an artefact of how a registry issues ground, not
    // a fact about the asset.
    //
    // The union is real, not a convex hull or a buffer: a holder whose ground
    // is in two disconnected pieces draws as two pieces, and one whose claims
    // ring a gap they do not own draws with the hole in it. Both happen here.
    function dissolve(list){
      const polys=[];
      list.forEach(c=>{
        const ring=[];
        for(let i=0;i<c.ll.length;i+=2) ring.push([c.ll[i],c.ll[i+1]]);
        if(ring.length>=3) polys.push([ring]);
      });
      if(!polys.length) return [];
      // No library, or a degenerate geometry it refuses: fall back to the
      // individual claims. A layer that draws the fences is worse-looking; a
      // layer that draws nothing is a missing slide.
      if(typeof polygonClipping==='undefined') return polys;
      try{ return polygonClipping.union(polys[0], ...polys.slice(1)); }
      catch(e){
        console.warn('Orebody: could not dissolve tenure for one holder — '+
                     'drawing the claims individually.', e);
        return polys;
      }
    }

    const byHolder={};
    REAL_CLAIMS.forEach(c=>{ const k=norm(c.owner)||'\u0000'; (byHolder[k]=byHolder[k]||[]).push(c); });

    Object.keys(byHolder).forEach(k=>{
      const list=byHolder[k], c0=list[0];
      const mine=isMine(c0), hue=hueFor(c0), show=mine||named(c0);
      const label=(c0.owner?titleCase(c0.owner):'Tenure')+
        '  ·  '+list.length+(list.length===1?' claim':' claims');
      dissolve(list).forEach(poly=>{
        // Ring 0 is the outside; the rest are holes in it.
        const outer=poly[0]; if(!outer||outer.length<3) return;
        const flat=r=>{const a=[];r.forEach(pt=>{a.push(pt[0],pt[1]);});return a;};
        if(show && !mine){
          const hier=new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(flat(outer)),
            poly.slice(1).map(h=>new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(flat(h)))));
          siteEnts.push(viewer.entities.add({name:label,
            polygon:{hierarchy:hier,
              material:Cesium.Color.fromCssColorString(hue).withAlpha(0.13),
              classificationType:Cesium.ClassificationType.TERRAIN}}));
        }
        // Every ring gets a line, holes included — a doughnut of claims with
        // an undrawn hole reads as ground the holder owns and does not.
        poly.forEach(ring=>{
          if(ring.length<3) return;
          siteEnts.push(viewer.entities.add({name:label,
            polyline:{positions:Cesium.Cartesian3.fromDegreesArray(flat(ring)),
              width:mine?2.8:(show?2.2:1.2), clampToGround:true,
              material:Cesium.Color.fromCssColorString(hue)
                .withAlpha(mine?1:(show?0.95:0.5))}}));
        });
      });
    });

    // ---- the callouts ------------------------------------------------------
    // Composited to a canvas rather than assembled from a Cesium billboard
    // plus two labels, because the layout is the point: a mark, a name and a
    // figure, aligned, at a fixed size, that reads at a glance from across a
    // room. Three stacked entities cannot be made to do that reliably.
    function initials(name){
      const stop=/^(CORP|CORPORATION|INC|INCORPORATED|LTD|LIMITED|LLC|LLP|PLC|CO|COMPANY|THE|AND|OF)\.?$/i;
      const w=(name||'').split(/[\s.,]+/).filter(x=>x&&!stop.test(x));
      return (w.slice(0,2).map(x=>x[0]).join('')||'?').toUpperCase();
    }
    const nf=n=>Math.round(n).toLocaleString();

    function holderCard(title, sub, hue, img, note){
      const R=Math.min(2, Math.max(1, devicePixelRatio||1));
      const pad=12, logo=40, gap=12, h=note?82:64;
      const m=document.createElement('canvas').getContext('2d');
      m.font='600 15px Archivo, system-ui, sans-serif';
      const wT=m.measureText(title).width;
      m.font='500 11px "JetBrains Mono", monospace';
      const wS=m.measureText(sub).width;
      m.font='600 11.5px "JetBrains Mono", monospace';
      const wN=note?m.measureText(note).width:0;
      const w=Math.ceil(pad*2+logo+gap+Math.max(wT,wS,wN)+4);
      const cv=document.createElement('canvas');
      cv.width=Math.ceil(w*R); cv.height=Math.ceil(h*R);
      const g=cv.getContext('2d'); g.scale(R,R);
      const round=(x,y,ww,hh,r)=>{ g.beginPath(); g.moveTo(x+r,y);
        g.arcTo(x+ww,y,x+ww,y+hh,r); g.arcTo(x+ww,y+hh,x,y+hh,r);
        g.arcTo(x,y+hh,x,y,r); g.arcTo(x,y,x+ww,y,r); g.closePath(); };
      g.fillStyle='rgba(10,13,14,0.93)'; round(0.5,0.5,w-1,h-1,7); g.fill();
      g.strokeStyle=hue; g.globalAlpha=0.55; g.lineWidth=1; g.stroke(); g.globalAlpha=1;
      // Accent edge, so the card and the parcel it belongs to are obviously
      // the same object even when they are far apart on screen.
      g.fillStyle=hue; round(0.5,0.5,3.5,h-1,2); g.fill();
      const lx=pad+2, ly=note?16:(h-logo)/2;
      if(img){
        g.save(); round(lx,ly,logo,logo,5); g.clip();
        g.fillStyle='#FFFFFF'; g.fillRect(lx,ly,logo,logo);
        // contain, not cover: a wordmark cropped to a square is unreadable and
        // a logo distorted to fit is worse than no logo.
        const s=Math.min(logo/img.width, logo/img.height);
        const dw=img.width*s, dh=img.height*s;
        g.drawImage(img, lx+(logo-dw)/2, ly+(logo-dh)/2, dw, dh);
        g.restore();
      } else {
        // No mark supplied. A monogram in the holder's own colour, which is an
        // honest placeholder — inventing a company's logo would be putting a
        // fake identity on a real map.
        g.fillStyle=hue; g.globalAlpha=0.22; round(lx,ly,logo,logo,5); g.fill();
        g.globalAlpha=1; g.strokeStyle=hue; g.globalAlpha=0.5;
        round(lx+0.5,ly+0.5,logo-1,logo-1,5); g.stroke(); g.globalAlpha=1;
        g.fillStyle=hue; g.font='600 16px Archivo, system-ui, sans-serif';
        g.textAlign='center'; g.textBaseline='middle';
        g.fillText(initials(title), lx+logo/2, ly+logo/2+0.5);
        g.textAlign='left'; g.textBaseline='alphabetic';
      }
      const tx=lx+logo+gap;
      const y0=note?26:28;
      g.fillStyle='#EDEEEC'; g.font='600 15px Archivo, system-ui, sans-serif';
      g.fillText(title, tx, y0);
      g.fillStyle='#8C948C'; g.font='500 11px "JetBrains Mono", monospace';
      g.fillText(sub, tx, y0+17);
      if(note){
        // The author's own line, and it must not read as though the register
        // said it. Claims and hectares above come from a public register; a
        // note saying "1.2 Moz Au" is an assertion somebody typed — and on a
        // NEIGHBOUR's card it is an assertion about a third party. So it is
        // set apart: its own rule, the holder's colour rather than the data
        // grey, and it is counted in the audit trail.
        g.strokeStyle='rgba(255,255,255,.10)'; g.lineWidth=1;
        g.beginPath(); g.moveTo(tx, y0+27.5); g.lineTo(w-pad, y0+27.5); g.stroke();
        g.fillStyle=hue; g.font='600 11.5px "JetBrains Mono", monospace';
        g.fillText(note, tx, y0+43);
      }
      return cv.toDataURL('image/png');
    }

    function placeCard(lon, lat, title, sub, hue, img, lift, note){
      CARD_LOG.push({title:title, sub:sub, note:note||''});
      const base=Cesium.Cartesian3.fromDegrees(lon,lat,ZTOP+GEOID+40);
      const top=Cesium.Cartesian3.fromDegrees(lon,lat,ZTOP+GEOID+140+(lift||0));
      siteEnts.push(viewer.entities.add({polyline:{positions:[base,top],
        width:1.1, arcType:Cesium.ArcType.NONE,
        material:Cesium.Color.fromCssColorString(hue).withAlpha(0.55)}}));
      siteEnts.push(viewer.entities.add({position:base,
        point:{pixelSize:6, color:Cesium.Color.fromCssColorString(hue),
               outlineColor:new Cesium.Color(0.04,0.05,0.06,0.9), outlineWidth:1.5,
               disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
      siteEnts.push(viewer.entities.add({position:top,
        billboard:{image:holderCard(title,sub,hue,img,note),
          verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
          // The card is authored at 1x; the canvas is drawn at devicePixelRatio
          // so it stays sharp, which means scaling it back down here.
          scale:1/Math.min(2,Math.max(1,devicePixelRatio||1)),
          scaleByDistance:new Cesium.NearFarScalar(4000,1.0,42000,0.85),
          distanceDisplayCondition:new Cesium.DistanceDisplayCondition(0,60000),
          disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    }

    // Centroid of every ring a holder owns, area-weighted by ring vertex count
    // only as a tie-break — a plain mean of ring centroids puts the card on the
    // holder's ground, which is all it has to do.
    const centroids={};
    REAL_CLAIMS.forEach(c=>{
      const k=norm(c.owner); if(!k) return;
      let x=0,y=0; for(let i=0;i<c.ll.length;i+=2){x+=c.ll[i];y+=c.ll[i+1];}
      const n2=c.ll.length/2;
      const e=centroids[k]||(centroids[k]={x:0,y:0,n:0});
      e.x+=x/n2; e.y+=y/n2; e.n++;
    });

    (HOLDERS||[]).forEach(h=>{
      if(h.subject || !featured(h)) return;
      const k=norm(h.owner), ct=centroids[k];
      if(!ct) return;
      placeCard(ct.x/ct.n, ct.y/ct.n, titleCase(h.owner),
                h.claims+(h.claims===1?' claim':' claims')+'  ·  '+nf(h.ha)+' ha',
                holderStyle[k]||'#7C8792', LOGO_IMG[k]||null, 0,
                metaOf(h.owner).note);
    });

    const me=(HOLDERS||[]).find(h=>h.subject);
    if(me){
      const ct=centroids[norm(me.owner)];
      if(ct) placeCard(ct.x/ct.n, ct.y/ct.n, titleCase(me.owner),
                       me.claims+(me.claims===1?' claim':' claims')+'  ·  '+nf(me.ha)+' ha',
                       '#F2C14E', BRAND_IMG||LOGO_IMG[norm(me.owner)]||null,
                       // Clear of the site furniture, which sits at the
                       // deposit — the same place this card's centroid lands.
                       (SITE.labels||[]).length*130+260);
    }

    // Everyone else, as one card and no names. The register lists them; an
    // investor deck does not need to.
    const priv=(HOLDERS||[]).filter(h=>!h.subject&&!featured(h));
    if(priv.length){
      let x=0,y=0,n=0;
      priv.forEach(h=>{ const ct=centroids[norm(h.owner)];
        if(ct){ x+=ct.x/ct.n; y+=ct.y/ct.n; n++; } });
      if(n){
        const claims=priv.reduce((s,h)=>s+h.claims,0);
        const ha=priv.reduce((s,h)=>s+h.ha,0);
        const anyCorp=priv.some(h=>h.corporate);
        placeCard(x/n, y/n, anyCorp?'Other holders':'Privately held',
                  claims+' claims  ·  '+nf(ha)+' ha  ·  '+priv.length+' holders',
                  '#7C8792', null);
      }
    }
    } else {
      // No tenure file baked: fall back to the fabricated ring, dashed, so the
      // deck still draws a boundary and still tells the truth about it.
      (SITE.claims||[]).forEach(c=>siteEnts.push(viewer.entities.add({
        name:c.name+(SITE_SYNTHETIC?'  (conceptual)':''),
        polyline:{positions:Cesium.Cartesian3.fromDegreesArray(deg(c.ring)),
          width:2.5,clampToGround:true,
          material:new Cesium.PolylineDashMaterialProperty({
            color:Cesium.Color.fromCssColorString('#F2C14E'),dashLength:26})}})));
    }
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
            const ll=proj4(PROJ,'WGS84',
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
    // Every one of these declares its own dz, and from a plan view several of
    // them project to nearly the same point on screen — four captions stacked
    // on one another in the middle of the deposit, which is where the eye goes
    // first. Fanned by index so they at least miss each other, on top of
    // whatever height the feature asked for.
    (SITE.labels||[]).forEach((l,li)=>{
      const ll=proj4(PROJ,'WGS84',l.at);
      const fan=li*70;
      const base=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],ZTOP+GEOID-40);
      const tip=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],ZTOP+GEOID+(l.dz||250)+fan);
      siteEnts.push(viewer.entities.add({polyline:{positions:[base,tip],width:1,
        material:Cesium.Color.WHITE.withAlpha(.42),arcType:Cesium.ArcType.NONE}}));
      siteEnts.push(viewer.entities.add({position:tip,
        label:{text:l.name+(SITE_SYNTHETIC?'  (conceptual)':''),
          font:'500 13px Archivo, system-ui, sans-serif',
          fillColor:Cesium.Color.WHITE,showBackground:true,
          backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.82),
          backgroundPadding:new Cesium.Cartesian2(9,6),
          verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
          // World-space separation does almost nothing from directly overhead,
          // which is exactly the chapter these labels pile up on: a 250 m
          // difference in height projects to a few pixels at a pitch of -90.
          // The screen-space offset is what actually keeps them apart there.
          pixelOffset:new Cesium.Cartesian2(0,-li*30),
          disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    });
    return siteEnts;
  }
  const showSite=on=>{ if(on) buildSite(); if(siteEnts) siteEnts.forEach(e=>e.show=on); };
  // Logos decode asynchronously and the cards are drawn synchronously, so a
  // layer built before they land would show monograms forever. Drop it once
  // and let the next showSite rebuild with the marks in place.
  preloadLogos().then(()=>{
    if(!siteEnts||(!Object.keys(LOGO_IMG).length&&!BRAND_IMG)) return;
    const was=siteOn;
    siteEnts.forEach(e=>viewer.entities.remove(e));
    siteEnts=null;
    if(was) showSite(true);
  });

  // ---- geophysics: a survey that was never flown ------------------------
  // FABRICATED, and structurally so: the field is synthesised from the block
  // model, so the anomaly sits over the deposit because it was built from the
  // deposit — not because anything was measured. Real gold systems are often
  // magnetite-DESTRUCTIVE and would read as a magnetic LOW, so this may not
  // even be the right sign. It proves the layer plumbing; it is not evidence.
  //
  // Because of that it is joined to all five labelling paths, not just the
  // banner: syncWarn(), the export burn-in in stamp(), foot() on the export
  // slide, provText() in the provenance report, and embFabricated() in the
  // embed snippet. The banner does not travel with an exported PNG or an
  // iframe someone pastes into WordPress; the other four are what cover that.
  // The bead threshold. VRIFY's decks label their trace legend "> 0.3 g/t"
  // because a drill programme has thousands of assays and most of them are
  // background — drawing all of them turns the traces into a solid stripe and
  // hides the intercepts that matter. Filtering is a display choice and the
  // legend states the number, so nothing is hidden silently.
  let assayMin=GRADE_FLOOR;
  const GEO_PRODUCTS={}; (GEOPHYS.products||[]).forEach(p=>{GEO_PRODUCTS[p.key]=p;});
  const GEO_RAMP=['#0c165c','#125caa','#1a9e94','#68ba4e','#e8ce3e','#e27a2a','#b01a26'];
  let geoLayer=null, geoKey='';
  function geoShow(key){
    // Reuse is not worth it here: one 320 px tile per product, and keeping
    // three layers parked would leave the stacking order dependent on the
    // order the presenter happened to click them in.
    if(geoLayer){ viewer.imageryLayers.remove(geoLayer,true); geoLayer=null; }
    geoKey=GEO_PRODUCTS[key]?key:'';
    const p=GEO_PRODUCTS[geoKey];
    if(p){
      // Same proj4 hop as the plan map. Over 2.6 km the UTM grid's rotation in
      // geographic space is well under one raster cell, so a rectangle holds.
      // A product's own extent wins over the set's union: two grids of the
      // same property are rarely clipped identically, and stretching one to
      // the other's corners moves the anomaly.
      const ex=p.extent||{west:GEOPHYS.emin,south:GEOPHYS.nmin,
                          east:GEOPHYS.emax,north:GEOPHYS.nmax};
      // Switching deposits replaces GEOPHYS wholesale, and a deposit without a
      // survey gets an empty one. Its corners then arrive here as undefined,
      // proj4 throws "coordinates must be finite numbers", and the throw comes
      // out of go() — so a deck that switched to a second deposit and then hit
      // a magnetics chapter stopped changing slides entirely, with nothing on
      // screen to say why. There is no survey to drape; say that and carry on.
      const fin=v=>typeof v==='number'&&isFinite(v);
      if(!(fin(ex.west)&&fin(ex.south)&&fin(ex.east)&&fin(ex.north))){
        geoKey='';
        toast('This deposit has no geophysics to show',3000);
        return;
      }
      const sw=proj4(PROJ,'WGS84',[ex.west,ex.south]);
      const ne=proj4(PROJ,'WGS84',[ex.east,ex.north]);
      geoLayer=viewer.imageryLayers.addImageryProvider(
        new Cesium.SingleTileImageryProvider({
          url:GEOPHYS.dir+p.file,
          rectangle:Cesium.Rectangle.fromDegrees(sw[0],sw[1],ne[0],ne[1]),
          tileWidth:GEOPHYS.grid, tileHeight:GEOPHYS.grid}));
      geoLayer.alpha=0.72;
      // Under the grade map when both are on: the fabricated layer must never
      // sit on top of the one derived from real modelled grades.
      if(planLayer) viewer.imageryLayers.lower(geoLayer);
    }
    const el=$('geoleg');
    el.style.display=p?'flex':'none';
    // FABRICATED only when it is. This was unconditional, so a customer's own
    // airborne survey — real data, flown and paid for — came out captioned
    // fabricated. Crying wolf devalues the word everywhere else it appears,
    // which is the last thing this codebase can afford.
    if(p) el.innerHTML='<span>'+p.label+(p.unit?' ('+p.unit+')':'')+'</span>'+
      GEO_RAMP.map(c=>'<div class="k"><span class="sw" style="background:'+c+'"></span></div>').join('')+
      (GEOPHYS_SYNTHETIC?'<span style="color:#D9584A">FABRICATED</span>':'');
  }

  // ---- geochemistry ------------------------------------------------------
  // Sample points clamped to the ground, sized and coloured by value on a
  // percentile scale.
  //
  // Percentile, not linear: a soil survey's values are lognormal, and one
  // 40 g/t rock chip on a linear ramp renders every other sample the same
  // colour as background. The legend states the actual values at each stop so
  // the stretch is visible rather than flattering.
  let gcEnts=null, gcOn=false;
  const GC_RAMP=['#2C5FA8','#3B82D6','#5EC8E8','#9B7BE8','#D053B8','#F472B6'];
  function buildGeochem(){
    if(gcEnts||!GEOCHEM||!GEOCHEM.points.length) return gcEnts;
    gcEnts=[];
    const vs=GEOCHEM.points.map(p=>p.v).sort((a,b)=>a-b);
    const q=f=>vs[Math.min(vs.length-1,Math.floor(vs.length*f))];
    const stops=[q(0.20),q(0.50),q(0.75),q(0.90),q(0.97),q(0.995)];
    GEOCHEM.stops=stops;
    const band=v=>{let i=0;while(i<stops.length-1&&v>stops[i])i++;return i;};
    GEOCHEM.points.forEach(pt=>{
      const ll=GEOCHEM.projected?proj4(PROJ,'WGS84',[pt.a,pt.b]):[pt.a,pt.b];
      const b=band(pt.v);
      gcEnts.push(viewer.entities.add({
        position:Cesium.Cartesian3.fromDegrees(ll[0],ll[1]),
        name:(pt.id?pt.id+'  ·  ':'')+pt.v+' '+(GEOCHEM.unit||''),
        point:{pixelSize:6+b*2.6,
          color:Cesium.Color.fromCssColorString(GC_RAMP[b]).withAlpha(0.92),
          outlineColor:Cesium.Color.fromCssColorString('#07090A').withAlpha(0.6),
          outlineWidth:1, heightReference:Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    });
    return gcEnts;
  }
  function showGeochem(on){
    if(on) buildGeochem();
    if(gcEnts) gcEnts.forEach(e=>e.show=on);
    const el=$('gcleg');
    el.style.display=on&&GEOCHEM?'flex':'none';
    if(on&&GEOCHEM){
      const st=GEOCHEM.stops||[];
      el.innerHTML='<span>'+(GEOCHEM.element||'Geochem')+
        (GEOCHEM.unit?' ('+GEOCHEM.unit+')':'')+'</span>'+
        GC_RAMP.map((c,i)=>'<div class="k"><span class="sw" style="background:'+c+
          '"></span></div>').join('')+
        '<span>'+(st[0]!==undefined?(+st[0]).toPrecision(3):'')+' → '+
        (st[st.length-1]!==undefined?(+st[st.length-1]).toPrecision(3):'')+'</span>'+
        (GEOCHEM.synthetic?'<span style="color:#D9584A">FABRICATED</span>':'');
    }
  }

  // ---- named targets -----------------------------------------------------
  // Leader-line labels, like the site features, but driven by data rather than
  // baked. Scaled by distance so a property view stays readable and a close-up
  // does not have a label the size of the deposit.
  let targetEnts=null;
  function buildTargets(){
    if(targetEnts||!TARGETS.length) return targetEnts;
    targetEnts=[];
    const STYLE={
      target:{c:'#F2C14E', dz:340},
      pit:{c:'#E4EAF0', dz:260},
      portal:{c:'#4FD1C5', dz:220},
      showing:{c:'#A78BFA', dz:300},
    };
    TARGETS.forEach(t=>{
      const st=STYLE[t.kind]||STYLE.target;
      const ll=proj4(PROJ,'WGS84',[t.e,t.n]);
      const base=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],ZTOP+GEOID-40);
      const tip=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],ZTOP+GEOID+(t.dz||st.dz));
      targetEnts.push(viewer.entities.add({polyline:{positions:[base,tip],width:1,
        material:Cesium.Color.fromCssColorString(st.c).withAlpha(.45),
        arcType:Cesium.ArcType.NONE}}));
      targetEnts.push(viewer.entities.add({position:tip,
        label:{text:t.name,
          font:'600 13px Archivo, system-ui, sans-serif',
          fillColor:Cesium.Color.fromCssColorString(st.c),
          showBackground:true,
          backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.84),
          backgroundPadding:new Cesium.Cartesian2(9,6),
          verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
          scaleByDistance:new Cesium.NearFarScalar(1200,1.0,18000,0.5),
          disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    });
    return targetEnts;
  }
  const showTargets=on=>{ if(on) buildTargets();
    if(targetEnts) targetEnts.forEach(e=>e.show=on); };

  // ---- pinned scene captions ----
  // A caption that names a thing should sit next to the thing. A fixed bar at
  // the bottom of the frame makes the reader hunt for what it refers to.
  let pinEnt=null;
  function setPin(pin){
    if(pinEnt){ viewer.entities.remove(pinEnt); pinEnt=null; }
    if(!pin) return;
    const ll=proj4(PROJ,'WGS84',pin.at);
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
      const deg=st.ring.reduce((acc,c)=>{const ll=proj4(PROJ,'WGS84',c);
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
          const ll=proj4(PROJ,'WGS84',[mx+(c[0]-mx)*shrink, my+(c[1]-my)*shrink]);
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

  // ---- state ---- (hoisted to the top of this module; see there)
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
    if(geoKey&&GEOPHYS_SYNTHETIC) parts.push('geophysics');
    // Unconditional: a fabricated block model is not a layer you can switch
    // off, it is every tonne and every gram on screen.
    if(BLOCKS_SYNTHETIC) parts.unshift('block model');
    // The property view sums every deposit, so if any of them is invented the
    // columns on screen are part invention — even when the deposit currently
    // loaded is the real one.
    //
    // Its own sentence, not another item in the list: as a list item it came
    // out as "Synthetic one deposit in the property view — fabricated…", which
    // is not English. A warning nobody can parse is not a warning.
    const propMix=propOn&&propSyn&&!BLOCKS_SYNTHETIC;
    const el=$('synwarn');
    el.classList.toggle('on',parts.length>0||propMix);
    let msg='';
    if(parts.length) msg='Synthetic '+parts.join(' + ')+
      ' — fabricated, not real results or a real mine plan';
    if(propMix) msg=(msg?msg+'.  ':'')+
      'One of the deposits in this property view is FABRICATED';
    if(msg) el.textContent=msg;
  }

  // A decoration must never be able to stop the deck.
  //
  // Every overlay below is optional — drill traces, the depth grid, site
  // infrastructure, surfaces, the plan raster, the property columns. The
  // deposit and the camera are not. Before this, one Cesium throw anywhere in
  // that list took down apply(), and at boot that meant the whole viewer
  // refused to start over a layer nobody had asked for yet. Each is reported
  // once, by name, and then skipped.
  const layerFailed={};
  function layer(name,fn){
    if(layerFailed[name]) return;
    try{ fn(); }
    catch(err){
      layerFailed[name]=true;
      console.error('Orebody: the "'+name+'" layer failed and is disabled',err);
      toast(name+' unavailable on this device',5000);
    }
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
    // geoShow() rebuilds the imagery layer, so it is called only when the key
    // actually has to change — apply() runs on every cut-off tick, and
    // re-adding a tile per tick would flicker the survey off and on.
    if(assetOnly){ drills=false; hiOn=false; siteOn=false; depthOn=false; planOn=false;
                   if(geoKey) geoShow(''); }
    layer('drill traces',()=>{ if(drills) buildDrills(); showDrills(drills); });
    // The ledger follows the traces. A deposit with no drill data disables it
    // outright rather than leaving an empty panel that looks broken.
    $('ledgbtn').disabled=!HOLES.length;
    if(ledgerOn && (!drills || !HOLES.length)) setLedger(false);
    else if(ledgerOn) ledgerQueue();
    layer('intercept highlights',()=>showHi(hiOn&&drills));
    layer('depth grid',()=>showDepth(depthOn));
    layer('site features',()=>showSite(siteOn));
    layer('named targets',()=>showTargets(targetsOn&&!assetOnly));
    layer('geochemistry',()=>showGeochem(gcOn&&!assetOnly));
    layer('vein surfaces',()=>showSurfaces(surfOn));
    layer('grade map',()=>showPlan(planOn));
    // Async because the other deposit's model may still need fetching. Not
    // awaited — the rest of the frame applies now and the columns land when
    // they land — but the rejection must be caught or a failed fetch becomes a
    // silent unhandled rejection.
    showProperty(propOn).catch(e=>toast('Property view unavailable: '+e.message,5000));
    // The callouts read HIGHLIGHTS and the current projection, so they have to
    // repaint whenever anything that moves them changes.
    calloutQueue();
    // The assay legend belongs to the traces, so it lives and dies with them.
    $('assayleg').style.display=drills?'flex':'none';
    if(drills) $('assayleg').innerHTML=
      '<span>Drill assay g/t Au &gt; '+assayMin.toFixed(2)+'</span>'+
      TIERS.filter(T=>T.lo>=assayMin-1e-9).map(T=>'<div class="k"><span class="sw" style="background:'+T.css+
        '"></span><span>'+T.label+'</span></div>').join('')+
      (DRILL_SYNTHETIC?'<span style="color:#D9584A">FABRICATED</span>':'');
    // Surfaces, a plan map or the property columns all replace the block cloud
    // rather than layer on top of it — leaving the cubes underneath is what
    // made plan views blobby, and at property scale it is worse.
    if(surfOn||planOn||sectAxis||propOn) RUNS.forEach(r=>{ if(r.prim) r.prim.show=false; });
    layer('cross-section',()=>{
      if(sectAxis) buildSection();
      if(sectPrims) sectPrims.forEach(o=>o.prim.show=blocksOn); });
    syncWarn();

    readout(); syncHash();
  }

  // Numbers come from the exact per-bucket rollups, never from what is drawn.
  function readout(){
    if(EXPLORATION){
      // "0 t @ 0 g/t" is a claim, and a false one: it says the deposit was
      // measured and found empty. An exploration project has not been
      // measured. Say that instead.
      $('r_t').textContent='—'; $('r_g').textContent='—'; $('r_oz').textContent='—';
      $('r_n').textContent='—';
      $('r_nl').textContent='Exploration stage';
      $('veincav').textContent='No resource estimate for this project, so no '+
        'tonnage, grade or contained metal is reported.';
      return {t:0,g:0,oz:0,n:0};
    }
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
  $('recbtn').onclick=()=>rec?stopRec():startRec();
  $('assetbtn').onclick=()=>setAssetOnly(!assetOnly);
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
    $('emb').classList.remove('on');
    $('inspect').classList.remove('on');
    if(!$('holegraph').hidden){ $('holegraph').hidden=true; ledgerHole=null;
      exitHoleView(true); ledgerPaint(); }
    // Abandon a half-drawn area rather than leaving a dangling outline the
    // presenter has no obvious way to get rid of.
    if(areaMode&&areaPts.length){ areaPts=[]; areaLive(); }} });
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

  // ---- blackout -----------------------------------------------------------
  // Once the deposit has been shown, the ground has done its job. Dropping the
  // imagery to black leaves the drilling and the columns as the only lit things
  // in the frame, which is the difference between a map with holes on it and a
  // picture of a drill programme.
  //
  // Terrain GEOMETRY stays — collars still sit on the real surface and holes
  // still descend from it. Only the imagery goes, so this changes what you see
  // and not where anything is.
  let blackout=false, savedPop=null;
  function setBlackout(on){
    blackout=on;
    const base=viewer.imageryLayers.get(0);
    if(base) base.show=!on;
    if(on){ savedPop=popOn; if(maskLayer) maskLayer.show=false; }
    else if(savedPop!==null){ setPop(savedPop); savedPop=null; }
    viewer.scene.globe.baseColor=on?Cesium.Color.fromCssColorString('#07090A')
                                   :Cesium.Color.fromCssColorString('#101418');
    viewer.scene.skyAtmosphere.show=!on;
    viewer.scene.globe.showGroundAtmosphere=!on;
    if(viewer.scene.skyBox) viewer.scene.skyBox.show=!on;
    viewer.scene.backgroundColor=on?Cesium.Color.fromCssColorString('#07090A')
                                   :Cesium.Color.BLACK;
    $('blackbtn').classList.toggle('on',on);
  }
  $('blackbtn').onclick=()=>setBlackout(!blackout);

  // ---- intercept callouts in the gutters ---------------------------------
  // The reference decks park each intercept in a card at the edge of the frame
  // and run a leader line to the rock. That beats a label floating at the
  // intercept: the cards can be read in a column, they never sit on top of the
  // geometry they describe, and a dozen of them stay legible.
  //
  // Cards are DOM, leaders are SVG, positions come from projecting the
  // intercept's world position each frame. Left half of the screen parks left,
  // right half parks right, and each column is packed top-down so two cards
  // cannot overlap.
  let calloutsOn=false;
  const CO_W=232, CO_GAP=8, CO_TOP=112, CO_EDGE=26;
  function calloutClear(){
    $('callouts').innerHTML=''; $('calloutsvg').innerHTML='';
    document.body.classList.remove('calloutson');
  }
  function calloutPaint(){
    if(!calloutsOn||!HIGHLIGHTS.length||!hiOn){ calloutClear(); return; }
    const host=$('callouts'), svg=$('calloutsvg');
    const W=innerWidth, H=innerHeight;
    svg.setAttribute('viewBox','0 0 '+W+' '+H);
    svg.setAttribute('width',W); svg.setAttribute('height',H);
    // Project first, then lay out — a card's side depends on where its
    // intercept actually landed on screen this frame.
    const items=[];
    HIGHLIGHTS.forEach(hl=>{
      const z=EXAG===1?hl.at[2]:(CZ+(hl.at[2]-CZ)*EXAG);
      const win=toWindow(viewer.scene,toCart(hl.at[0],hl.at[1],z));
      if(!win||win.x<0||win.x>W||win.y<0||win.y>H) return;
      items.push({hl:hl,x:win.x,y:win.y,side:win.x<W/2?'left':'right'});
    });
    if(!items.length){ calloutClear(); return; }
    host.innerHTML=''; svg.innerHTML='';
    document.body.classList.add('calloutson');
    const cursor={left:CO_TOP,right:CO_TOP};
    items.sort((a,b)=>a.y-b.y);
    items.forEach(it=>{
      const card=document.createElement('div');
      card.className='cocard'+(it.side==='left'?' left':'');
      const id=document.createElement('div'); id.className='coid';
      id.textContent=it.hl.id;
      const v=document.createElement('div'); v.className='cov';
      v.appendChild(document.createTextNode(it.hl.g.toFixed(2)+' g/t Au over '));
      const b=document.createElement('b'); b.textContent=it.hl.len.toFixed(1)+' m';
      v.appendChild(b);
      // "over 13 m" with nothing after it reads as true width, and a drill
      // release quotes true width. Downhole length can overstate it by a
      // factor of two where a hole cuts a structure obliquely, so the word
      // has to be there. ETW is only claimed when the structure's orientation
      // is known — see intWidth() — and never inferred from the hole alone.
      const w=document.createElement('span');
      w.style.cssText='font-family:JetBrains Mono,monospace;font-size:9px;'+
        'letter-spacing:.08em;color:#8C948C;margin-left:4px';
      w.textContent=it.hl.etw?'ETW':'downhole';
      v.appendChild(w);
      card.appendChild(id); card.appendChild(v);
      if(it.hl.incl){
        const inc=document.createElement('div'); inc.className='coincl';
        inc.textContent='incl. '+it.hl.incl.g.toFixed(2)+' g/t over '+
                        it.hl.incl.len.toFixed(1)+' m';
        card.appendChild(inc);
      }
      if(DRILL_SYNTHETIC){
        const s=document.createElement('div'); s.className='cosyn';
        s.textContent='fabricated'; card.appendChild(s);
      }
      card.style.width=CO_W+'px';
      // Packed top-down per column so cards never overlap, and never below the
      // nav bar.
      const y=Math.min(H-150,Math.max(cursor[it.side],it.y-26));
      card.style.top=y+'px';
      if(it.side==='left') card.style.left=CO_EDGE+'px';
      else card.style.right=CO_EDGE+'px';
      host.appendChild(card);
      const h=card.offsetHeight||54;
      cursor[it.side]=y+h+CO_GAP;
      // Leader from the card's inner edge to the intercept.
      const ax=it.side==='left'?(CO_EDGE+CO_W):(W-CO_EDGE-CO_W);
      const ay=y+h/2;
      const line=document.createElementNS('http://www.w3.org/2000/svg','path');
      line.setAttribute('d','M '+ax+' '+ay+' L '+it.x.toFixed(1)+' '+it.y.toFixed(1));
      line.setAttribute('stroke','rgba(255,255,255,.55)');
      line.setAttribute('stroke-width','1');
      line.setAttribute('fill','none');
      svg.appendChild(line);
      const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');
      dot.setAttribute('cx',it.x.toFixed(1)); dot.setAttribute('cy',it.y.toFixed(1));
      dot.setAttribute('r','3.5'); dot.setAttribute('fill','#E8433C');
      svg.appendChild(dot);
    });
  }
  let coTimer=null;
  function calloutQueue(){
    if(!calloutsOn) return;
    clearTimeout(coTimer); coTimer=setTimeout(calloutPaint,120);
  }
  function setCallouts(on){
    calloutsOn=on;
    $('cobtn').classList.toggle('on',on);
    // Callouts annotate the headline intercepts, so asking for them is asking
    // for those. calloutPaint bails when highlights are off, which meant the
    // button did nothing at all on any chapter that had not already turned
    // them on — it looked broken rather than empty. Turn on what it needs,
    // the way clicking a ledger row turns the traces on.
    if(on&&HIGHLIGHTS.length&&(!hiOn||!drills)){
      if(!drills) setDrills(true);
      hiOn=true;
      $('hiseg').querySelectorAll('button').forEach(x=>
        x.classList.toggle('on',(x.dataset.h==='1')===hiOn));
      apply();                       // repaints the callouts on its way through
      return;
    }
    if(on) calloutPaint(); else calloutClear();
  }
  $('cobtn').onclick=()=>setCallouts(!calloutsOn);
  viewer.camera.changed.addEventListener(calloutQueue);
  viewer.camera.moveEnd.addEventListener(calloutQueue);
  addEventListener('resize',calloutQueue);

  // ---- drill ledger ------------------------------------------------------
  // A drill release is a table, and a 3D deck that shows holes without one
  // makes the audience read grades off a picture. This is that table, scoped
  // to what is actually on screen so it stays a legend for the view rather
  // than a directory of forty holes you have to search.
  //
  // Everything here is DERIVED from the same segs that draw the traces, so the
  // ledger cannot quote an intercept the geometry does not show.
  let ledgerOn=false, ledgerSort='best', ledgerRows=[], ledgerTimer=null;

  // Length-weighted, which is what a drill release reports. Taking the peak
  // assay instead would headline a 0.5 m sample and overstate every hole.
  function holeStats(h){
    if(h.__st) return h.__st;
    let best=null, metres=0, peak=0;
    for(const s of h.segs){
      const len=s.t-s.f;
      metres+=len; if(s.g>peak) peak=s.g;
      const score=s.g*len;
      if(len>=2 && (!best||score>best.score)) best={f:s.f,t:s.t,g:s.g,len:len,score:score};
    }
    const d=[h.end[0]-h.collar[0], h.end[1]-h.collar[1], h.end[2]-h.collar[2]];
    const horiz=Math.hypot(d[0],d[1]);
    let az=Math.atan2(d[0],d[1])*180/Math.PI; if(az<0) az+=360;
    const dip=-Math.atan2(d[2],horiz||1e-9)*180/Math.PI;
    h.__st={best:best, metres:Math.round(metres*10)/10, peak:peak,
            az:Math.round(az), dip:Math.round(dip)};
    return h.__st;
  }

  // Cesium renamed this around 1.111; accept either so a version bump does not
  // silently empty the ledger.
  const toWindow=(scene,c)=>(Cesium.SceneTransforms.worldToWindowCoordinates||
                             Cesium.SceneTransforms.wgs84ToWindowCoordinates)(scene,c);
  function holeOnScreen(h){
    const w=viewer.canvas.clientWidth, ht=viewer.canvas.clientHeight;
    for(const p of [h.collar,h.end]){
      const c=toCart(p[0],p[1],EXAG===1?p[2]:(CZ+(p[2]-CZ)*EXAG));
      const win=toWindow(viewer.scene,c);
      // undefined means behind the camera, which is not "in view".
      if(win && win.x>=-40 && win.x<=w+40 && win.y>=-40 && win.y<=ht+40) return true;
    }
    return false;
  }

  function ledgerPaint(){
    if(!ledgerOn) return;
    // Standing broadside to one hole, "what is on screen" is that hole — which
    // would collapse the ledger to a single row and strand the presenter with
    // no way to click through to the next one. So the row set freezes on the
    // way into a hole view and thaws on the way out.
    const vis=holeView?holeView.rows:HOLES.filter(holeOnScreen);
    ledgerRows=vis.slice();
    if(ledgerSort==='best')
      ledgerRows.sort((a,b)=>((holeStats(b).best||{}).score||0)-((holeStats(a).best||{}).score||0));
    else ledgerRows.sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
    $('ledgt').textContent=holeView
      ? 'Drill holes — underground'
      : 'Drill holes — '+vis.length+' of '+HOLES.length;
    const list=$('ledglist'); list.innerHTML='';
    if(!ledgerRows.length){
      const d=document.createElement('div'); d.className='lrow';
      d.style.cursor='default';
      d.innerHTML='<span class="hid" style="color:#8C948C">No holes in view</span>';
      list.appendChild(d);
    }
    ledgerRows.forEach(h=>{
      const st=holeStats(h);
      const row=document.createElement('div');
      row.className='lrow'+(ledgerHole===h?' on':'');
      const id=document.createElement('span'); id.className='hid';
      id.textContent=h.id+(DRILL_SYNTHETIC?'  ·  synthetic':'');
      const td=document.createElement('span'); td.className='htd';
      td.textContent='TD '+Math.round(h.td)+' m  ·  '+st.az+'°/'+st.dip+'°';
      const be=document.createElement('span'); be.className='hbest';
      if(st.best){
        be.innerHTML='';
        be.appendChild(document.createTextNode(st.best.len.toFixed(1)+' m @ '));
        const b=document.createElement('b'); b.textContent=st.best.g.toFixed(2)+' g/t';
        be.appendChild(b);
        be.appendChild(document.createTextNode(
          ' from '+st.best.f.toFixed(0)+' m'));
      } else be.textContent='no assay above the floor';
      row.appendChild(id); row.appendChild(td); row.appendChild(be);
      row.onclick=()=>focusHole(h);
      list.appendChild(row);
    });
    $('ledgnote').textContent=DRILL_SYNTHETIC
      ? 'These holes are FABRICATED. Not real assay results.'
      : 'Length-weighted best intercept per hole.';
    $('ledgnote').style.color=DRILL_SYNTHETIC?'#D9584A':'';
  }
  // Recomputed on camera rest rather than per frame: worldToWindowCoordinates
  // for every hole on every frame is real cost, and a list that reshuffles
  // mid-drag is unreadable anyway.
  function ledgerQueue(){
    if(!ledgerOn) return;
    clearTimeout(ledgerTimer);
    ledgerTimer=setTimeout(ledgerPaint,220);
  }

  // The downhole graph: grade against depth, which is how a geologist reads a
  // hole. Drawn from segs, so the bars are the same intervals the trace beads
  // are — one source, two views.
  function holeGraph(h){
    const st=holeStats(h);
    const W=316, H=190, padT=10, padB=22, padL=34, padR=10;
    const plotH=H-padT-padB, plotW=W-padL-padR;
    const gmax=Math.max(1, st.peak);
    const y=d=>padT+(d/Math.max(1,h.td))*plotH;
    const parts=[];
    parts.push('<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Downhole grade for '+
               h.id.replace(/[<>&"]/g,'')+'">');
    parts.push('<rect x="'+padL+'" y="'+padT+'" width="'+plotW+'" height="'+plotH+
               '" fill="rgba(255,255,255,.03)"/>');
    // depth ticks every 50 m
    for(let d=0;d<=h.td;d+=50){
      const yy=y(d).toFixed(1);
      parts.push('<line x1="'+padL+'" y1="'+yy+'" x2="'+(W-padR)+'" y2="'+yy+
                 '" stroke="rgba(255,255,255,.08)"/>');
      parts.push('<text x="'+(padL-5)+'" y="'+(+yy+3)+'" text-anchor="end" '+
                 'font-family="JetBrains Mono, monospace" font-size="8" fill="#8C948C">'+d+'</text>');
    }
    h.segs.forEach(s=>{
      const y0=y(s.f), y1=y(s.t);
      const w=Math.max(1.5,(s.g/gmax)*plotW);
      parts.push('<rect x="'+padL+'" y="'+y0.toFixed(1)+'" width="'+w.toFixed(1)+
                 '" height="'+Math.max(1.2,(y1-y0)).toFixed(1)+'" fill="'+
                 TIERS[tierOf(s.g)].css+'" opacity="0.92"/>');
    });
    if(st.best){
      const yb=y(st.best.f), yb2=y(st.best.t);
      parts.push('<rect x="'+(padL-2)+'" y="'+yb.toFixed(1)+'" width="'+(plotW+4)+
                 '" height="'+Math.max(2,(yb2-yb)).toFixed(1)+
                 '" fill="none" stroke="#F2C14E" stroke-width="1"/>');
    }
    parts.push('</svg>');
    let cap='Peak '+st.peak.toFixed(2)+' g/t  ·  '+st.metres.toFixed(1)+' m assayed  ·  0 → '+
            gmax.toFixed(1)+' g/t across';
    if(DRILL_SYNTHETIC) cap='FABRICATED — '+cap;
    $('hgbody').innerHTML=parts.join('')+
      '<div class="hgcap"'+(DRILL_SYNTHETIC?' style="color:#D9584A"':'')+'>'+cap+'</div>'+
      '<div class="hgcap">Underground, broadside to the hole · Esc returns to the chapter</div>';
    $('hgt').textContent=h.id+(DRILL_SYNTHETIC?' (synthetic)':'');
    $('holegraph').hidden=false;
  }

  // ---- hole view ----------------------------------------------------------
  // A drill hole seen from above is a dot. It is a vertical object a few
  // hundred metres long, and the only view that shows one whole is broadside
  // and underground: camera at the hole's own mid-depth, looking level into
  // the rock with the ground cut away. Flying nearer at a downward pitch —
  // which is what this used to do — gets you a foreshortened stick behind a
  // hillside.
  //
  // So a click is a mode, not a nudge. The model, the surfaces, the survey,
  // the grade map and the site furniture all come off; the depth grid comes on,
  // because once the surface is gone it is the only thing left that says how
  // deep you are.
  function enterHoleView(){
    if(holeView) return;
    holeView={blocks:blocksOn, surf:surfOn, geo:geoKey, plan:planOn, site:siteOn,
              gc:gcOn, targets:targetsOn, depth:depthOn,
              ground:groundAlpha, hold:groundHold, rows:ledgerRows.slice()};
    if(!holeView.rows.length) holeView.rows=HOLES.slice();
    blocksOn=false; surfOn=''; planOn=false; siteOn=false; gcOn=false;
    targetsOn=false; depthOn=true;
    if(geoKey) geoShow('');
    // Translucency is normally windowed to the deposit's own footprint, so
    // "ground cut away" only ever cut away the ground over the orebody. From
    // underground you are looking OUT of that window at the rest of the range,
    // which stays fully opaque and lit — a bright hillside across the top of
    // the frame, louder than any of the data beneath it. Drop the window for
    // the duration and ghost the back faces, so the surface reads as a ceiling
    // you are under rather than a landscape you are in.
    holeView.backFace=viewer.scene.globe.translucency.backFaceAlpha;
    holeView.rect=Cesium.Rectangle.clone(
      viewer.scene.globe.translucency.rectangle, new Cesium.Rectangle());
    holeView.sun=viewer.scene.sun && viewer.scene.sun.show;
    if(viewer.scene.sun) viewer.scene.sun.show=false;
    viewer.scene.globe.translucency.rectangle=undefined;
    viewer.scene.globe.translucency.backFaceAlpha=0.16;
    setGround(0);
    document.body.classList.add('holeview');
  }

  // refly is false when go() is unwinding this on the way into a new chapter:
  // the chapter is about to set its own layers and fly its own camera, and a
  // second flight racing it would land wherever it lost.
  function exitHoleView(refly){
    if(!holeView) return;
    const s=holeView; holeView=null;
    blocksOn=s.blocks; surfOn=s.surf; planOn=s.plan; siteOn=s.site;
    gcOn=s.gc; targetsOn=s.targets; depthOn=s.depth;
    if(s.geo!==geoKey) geoShow(s.geo);
    groundHold=s.hold; setGround(s.ground);
    viewer.scene.globe.translucency.backFaceAlpha=s.backFace;
    viewer.scene.globe.translucency.rectangle=s.rect;
    if(viewer.scene.sun) viewer.scene.sun.show=s.sun;
    clearFocus();
    document.body.classList.remove('holeview');
    syncOverlayControls(); apply();
    if(refly){
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      if(CHAPTERS[cur]) frameFor(CHAPTERS[cur],true);
    }
  }


  // The focused hole, drawn for the range you actually inspect one from.
  //
  // The overview rendering cannot be reused here. Its beads are 9 m spheres
  // and its collars 16 m cubes, which is right at 2 km and absurd at 400 m,
  // and beads sit BESIDE the assay rather than on it. Close in, the thing a
  // geologist reads is a downhole log: the interval itself thickened and
  // coloured by grade, a depth ladder beside it, and the headline intercept
  // named. That is what this builds, and it is thrown away on exit rather
  // than parked hidden, because it is rebuilt per hole anyway.
  function clearFocus(){
    if(!focusEnts) return;
    focusEnts.forEach(e=>viewer.entities.remove(e));
    focusEnts=null;
  }
  function buildFocus(h,head){
    clearFocus();
    focusEnts=[];
    const st=holeStats(h);
    const zf=z=>EXAG===1?z:(CZ+(z-CZ)*EXAG);
    const P=q=>toCart(q[0],q[1],zf(q[2]));
    const add=(o,seg)=>{const e=viewer.entities.add(o); e.__hole=h;
      if(seg) e.__seg=seg; focusEnts.push(e); return e;};
    // Depth along the hole, interpolated exactly the way the trace is drawn —
    // collar to toe. Anything that reads a depth off the geometry has to use
    // the same rule or the log and the trace disagree about where 130 m is.
    const at=d=>{const k=Math.max(0,Math.min(1,d/Math.max(1,h.td)));
      return [h.collar[0]+(h.end[0]-h.collar[0])*k,
              h.collar[1]+(h.end[1]-h.collar[1])*k,
              h.collar[2]+(h.end[2]-h.collar[2])*k];};
    // Everything is sized against the hole's own length, because the camera
    // range is too. A 150 m hole and a 400 m hole then read identically on
    // screen rather than one appearing three times the other's thickness.
    const L=Math.max(40,Math.hypot(h.end[0]-h.collar[0], h.end[1]-h.collar[1],
                                   (h.end[2]-h.collar[2])*EXAG));
    const u=Math.max(0.4,Math.min(2.5,L/300));
    const tube=(r,n)=>{const a=[];for(let i=0;i<n;i++){const t=2*Math.PI*i/n;
      a.push(new Cesium.Cartesian2(r*Math.cos(t),r*Math.sin(t)));}return a;};

    add({polylineVolume:{positions:[P(h.collar),P(h.end)],shape:tube(2.9*u,12),
      material:new Cesium.Color(0.84,0.87,0.84,0.95)}});

    // Assayed intervals thickened ON the hole. Thickness is the interval,
    // girth and colour are the grade, and there is no gap between a sample and
    // the metre of core it came out of.
    const gmax=Math.max(1,st.peak);
    h.segs.forEach(s=>{
      if(s.g<Math.max(GRADE_FLOOR,assayMin)) return;
      const r=(3.4+Math.min(1,Math.sqrt(s.g/gmax))*5.2)*u;
      add({polylineVolume:{positions:[P(at(s.f)),P(at(s.t))],shape:tube(r,12),
        material:ramp(s.g,false)}}, s);
    });

    // A depth ladder. Underground with the surface behind you there is no other
    // cue for how deep any of this is, and "how deep" is the first thing anyone
    // asks of a drill hole.
    const bear=rad(head+90), back=rad(head-90);
    const step=L>620?100:(L>260?50:25);
    for(let d=step; d<h.td-step*0.2; d+=step){
      const a0=at(d), a1=[a0[0]+Math.sin(bear)*15*u, a0[1]+Math.cos(bear)*15*u, a0[2]];
      add({polyline:{positions:[P(a0),P(a1)],width:1.3,arcType:Cesium.ArcType.NONE,
        material:Cesium.Color.WHITE.withAlpha(0.42)}});
      add({position:P(a1),label:{text:d+' m',
        font:'500 10px "JetBrains Mono", monospace',
        fillColor:Cesium.Color.WHITE.withAlpha(0.74),
        showBackground:true,backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.60),
        horizontalOrigin:Cesium.HorizontalOrigin.LEFT,
        pixelOffset:new Cesium.Cartesian2(6,0),
        disableDepthTestDistance:Number.POSITIVE_INFINITY}});
    }

    add({position:P(h.collar),
      box:{dimensions:new Cesium.Cartesian3(6*u,6*u,6*u),
           material:Cesium.Color.fromCssColorString('#F2C14E')},
      label:{text:h.id+(DRILL_SYNTHETIC?'  ·  synthetic':'')+'\n'+
                  'TD '+Math.round(h.td)+' m  ·  '+st.az+'° / '+st.dip+'°',
        font:'500 12px "JetBrains Mono", monospace',
        fillColor:DRILL_SYNTHETIC?Cesium.Color.fromCssColorString('#F0A9A2')
                                 :Cesium.Color.WHITE,
        showBackground:true,backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.84),
        horizontalOrigin:Cesium.HorizontalOrigin.RIGHT,
        pixelOffset:new Cesium.Cartesian2(-14,0),
        disableDepthTestDistance:Number.POSITIVE_INFINITY}});

    add({position:P(h.end),label:{text:'end of hole',
      font:'500 10px "JetBrains Mono", monospace',
      fillColor:Cesium.Color.WHITE.withAlpha(0.6),
      showBackground:true,backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.60),
      verticalOrigin:Cesium.VerticalOrigin.TOP,
      pixelOffset:new Cesium.Cartesian2(0,10),
      disableDepthTestDistance:Number.POSITIVE_INFINITY}});

    // The headline intercept, on the far side from the depth ladder so the two
    // sets of labels are not fighting for the same strip of screen.
    if(st.best){
      const m=at((st.best.f+st.best.t)/2);
      const off=[m[0]+Math.sin(back)*44*u, m[1]+Math.cos(back)*44*u, m[2]];
      add({polyline:{positions:[P(m),P(off)],width:1.2,arcType:Cesium.ArcType.NONE,
        material:Cesium.Color.fromCssColorString('#F2C14E').withAlpha(0.8)}});
      add({position:P(off),label:{
        text:st.best.len.toFixed(1)+' m @ '+st.best.g.toFixed(2)+' g/t\nfrom '+
             st.best.f.toFixed(0)+' m',
        font:'600 13px "JetBrains Mono", monospace',
        fillColor:Cesium.Color.fromCssColorString('#F2C14E'),
        showBackground:true,backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.86),
        horizontalOrigin:Cesium.HorizontalOrigin.RIGHT,
        pixelOffset:new Cesium.Cartesian2(-8,0),
        disableDepthTestDistance:Number.POSITIVE_INFINITY}});
    }
    return focusEnts;
  }

  function holeCamera(h){
    const zf=z=>EXAG===1?z:(CZ+(z-CZ)*EXAG);
    const a=toCart(h.collar[0],h.collar[1],zf(h.collar[2]));
    const b=toCart(h.end[0],h.end[1],zf(h.end[2]));
    const L=Math.max(40,Cesium.Cartesian3.distance(a,b));
    const st=holeStats(h);
    // Broadside. Looked at down its own azimuth a hole foreshortens to a point,
    // so stand off the trace at a right angle. Two headings do that; take the
    // shorter turn from where the camera already is, so the move reads as
    // going in rather than spinning round.
    const here=DEG(viewer.camera.heading);
    const vert=Math.abs(st.dip)>85;
    const head=vert?here:[st.az+90,st.az-90].reduce((p,q)=>
      Math.abs(shortestHeading(here,q)-here)<Math.abs(shortestHeading(here,p)-here)?q:p);
    // Range to fit the whole hole in the vertical of the frame. Sizing off the
    // 3D length rather than the vertical drop over-estimates for a dipping
    // hole, which errs towards one that fits rather than one that is cropped.
    const fovy=(viewer.camera.frustum&&viewer.camera.frustum.fovy)||rad(45);
    const range=Math.max(150,(L*1.22/2)/Math.tan(fovy/2));
    // The ledger and the downhole graph own the left third of the window, so a
    // hole centred in the viewport is a hole behind a panel. Centre the camera
    // to the LEFT of the trace, which puts the trace to the right of centre.
    const wide=viewer.canvas.clientWidth>1100;
    const aspect=viewer.canvas.clientWidth/Math.max(1,viewer.canvas.clientHeight);
    const dx=wide?range*Math.tan(fovy/2)*aspect*0.15:0;
    const right=rad(head+90);
    const cx=(h.collar[0]+h.end[0])/2-Math.sin(right)*dx;
    const cy=(h.collar[1]+h.end[1])/2-Math.cos(right)*dx;
    const cz=zf((h.collar[2]+h.end[2])/2);
    const target=toCart(cx,cy,cz);
    // Pitch is a few degrees off level, not the 24 it was: at level the camera
    // sits at the hole's own mid-depth, which is the whole point of the view.
    return {head:head, target:target,
            hpr:new Cesium.HeadingPitchRange(rad(head),rad(-6),range),
            sphere:new Cesium.BoundingSphere(target,L*0.5)};
  }

  function focusHole(h){
    ledgerHole=h;
    // Drills have to be on to fly to one, and a chapter that had them off is
    // not a reason to refuse — turn them on rather than doing nothing.
    if(!drills) setDrills(true);
    enterHoleView();
    const cam=holeCamera(h);
    buildFocus(h,cam.head);
    apply();
    // A chapter flight ends in lookAt(center,…), which locks the camera's
    // reference frame to the deposit centre. Left in place, the flight below
    // is computed in that frame and every subsequent orbit spins about the
    // orebody rather than the hole in front of you.
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    const land=()=>viewer.camera.lookAt(cam.target,cam.hpr);
    if(REDUCED) land();
    else viewer.camera.flyToBoundingSphere(cam.sphere,
      {duration:1.5, offset:cam.hpr, complete:land});
    holeGraph(h);
    ledgerPaint();
  }

  function setLedger(on){
    ledgerOn=on;
    $('ledger').hidden=!on;
    document.body.classList.toggle('ledgeron',on);
    $('ledgbtn').classList.toggle('on',on);
    if(!on){ $('holegraph').hidden=true; ledgerHole=null; exitHoleView(true); }
    else ledgerPaint();
  }
  $('ledgbtn').onclick=()=>setLedger(!ledgerOn);
  $('ledgx').onclick=()=>setLedger(false);
  $('hgx').onclick=()=>{ $('holegraph').hidden=true; ledgerHole=null;
    exitHoleView(true); ledgerPaint(); };
  $('ledgsort').onclick=()=>{
    ledgerSort=ledgerSort==='best'?'id':'best';
    $('ledgsort').textContent=ledgerSort==='best'?'Best':'Name';
    ledgerPaint(); };
  viewer.camera.changed.addEventListener(ledgerQueue);
  viewer.camera.moveEnd.addEventListener(ledgerQueue);

  // ---- areas: presenter-drawn polygons on the ground ---------------------
  // "Point at the thing you are talking about" is most of what a presenter
  // does, and the ink tool cannot do it: ink lives in screen space, so it
  // slides off the target the moment the camera moves, and go() wipes it on
  // every chapter. These are geometry — clamped to terrain, held in lon/lat,
  // and they stay where they were drawn for the rest of the deck.
  //
  // They are ANNOTATIONS, not data, and are styled to say so: a translucent
  // fill in a palette that shares nothing with the grade ramp, and a dashed
  // outline, so nobody mistakes one for the solid gold tenure lines, which are
  // surveyed. The export footer counts them for the same reason.
  // Per SLIDE, and in two tiers.
  //
  // Authored areas come down with the chapter and are what the audience sees:
  // they travel with the share link, they are the same on every machine, and
  // they belong to the slide they were drawn on rather than to every slide at
  // once. Pointing at the vein on the section and at the access road on the
  // site plan are not the same annotation.
  //
  // Locally drawn areas are the presenter's own, kept in this browser. They
  // have to keep working for someone marking up a deck they cannot write to —
  // an audience member, or an author on a machine they are not signed in on —
  // so they still persist locally. In the studio, Save labels promotes them.
  const AREA_KEY='orebody.areas.'+(document.title.split(' · ')[0]||'deck');
  let areasLocal={};                      // chapter ord -> drawn areas
  let areas=[], areasAuth=[];             // this chapter's drawn / authored
  let areaMode=false, areaPts=[], areaColor='#38BDF8', areaEnts=[], liveEnt=null;

  function areaSave(){
    areasLocal[cur]=areas;
    // Drop empty chapters rather than accumulating a key per slide visited.
    Object.keys(areasLocal).forEach(k=>{
      if(!areasLocal[k]||!areasLocal[k].length) delete areasLocal[k]; });
    try{ localStorage.setItem(AREA_KEY,JSON.stringify(areasLocal)); }catch(e){}
  }
  // Point the drawing tools at a chapter's own annotations. Called on every
  // chapter change, so what is on screen is always this slide's rather than
  // the previous slide's left behind.
  function areaSelect(){
    areas=areasLocal[cur]||(areasLocal[cur]=[]);
    areasAuth=((CHAPTERS[cur]||{}).areas)||[];
    areaPts=[]; areaLive(); areaDraw();
  }
  function areaCentroid(ll){
    let x=0,y=0; for(let i=0;i<ll.length;i+=2){x+=ll[i];y+=ll[i+1];}
    return [x/(ll.length/2), y/(ll.length/2)];
  }
  function areaDraw(){
    areaEnts.forEach(e=>viewer.entities.remove(e)); areaEnts=[];
    areasAuth.concat(areas).forEach(a=>{
      const pos=Cesium.Cartesian3.fromDegreesArray(a.ll);
      areaEnts.push(viewer.entities.add({polygon:{
        hierarchy:pos,
        material:Cesium.Color.fromCssColorString(a.color).withAlpha(0.28),
        classificationType:Cesium.ClassificationType.TERRAIN}}));
      areaEnts.push(viewer.entities.add({polyline:{
        positions:pos.concat([pos[0]]), width:2.4, clampToGround:true,
        material:new Cesium.PolylineDashMaterialProperty({
          color:Cesium.Color.fromCssColorString(a.color), dashLength:20})}}));
      if(a.label){
        const c=areaCentroid(a.ll);
        areaEnts.push(viewer.entities.add({
          position:Cesium.Cartesian3.fromDegrees(c[0],c[1],ZTOP+GEOID+180),
          label:{text:a.label,
            font:'600 13px Archivo, system-ui, sans-serif',
            fillColor:Cesium.Color.fromCssColorString(a.color),
            showBackground:true,
            backgroundColor:new Cesium.Color(0.03,0.04,0.05,0.86),
            backgroundPadding:new Cesium.Cartesian2(9,6),
            verticalOrigin:Cesium.VerticalOrigin.BOTTOM,
            disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
      }
    });
    if(areaEnts.length) areaEnts.forEach(e=>e.show=!assetOnly);
  }
  function areaLive(){
    if(liveEnt){ viewer.entities.remove(liveEnt); liveEnt=null; }
    if(areaPts.length<2) { areaHintText(); return; }
    liveEnt=viewer.entities.add({polyline:{
      positions:Cesium.Cartesian3.fromDegreesArray(
        areaPts.length>2?areaPts.concat(areaPts.slice(0,2)):areaPts),
      width:2, clampToGround:true,
      material:Cesium.Color.fromCssColorString(areaColor).withAlpha(0.9)}});
    areaHintText();
  }
  function areaHintText(){
    const n=areaPts.length/2;
    $('areaHint').textContent = n===0 ? 'Click the ground'
      : n<3 ? n+' point'+(n===1?'':'s')+' — need 3'
      : n+' points — Finish';
  }
  // Terrain, not the deposit. globe.pick returns the ground intersection and
  // ignores the block primitives, so an area drawn over the orebody still lands
  // on the mountain rather than on whichever cube happened to be in front.
  function groundAt(win){
    const ray=viewer.camera.getPickRay(win);
    if(!ray) return null;
    const c=viewer.scene.globe.pick(ray,viewer.scene);
    if(!c) return null;
    const g=Cesium.Cartographic.fromCartesian(c);
    return [Cesium.Math.toDegrees(g.longitude), Cesium.Math.toDegrees(g.latitude)];
  }
  function areaFinish(){
    if(areaPts.length<6){ toast('An area needs at least three points',2600); return; }
    const label=(prompt('Label this area:','')||'').trim();
    areas.push({ll:areaPts.slice(), color:areaColor, label:label});
    areaPts=[]; areaLive(); areaDraw(); areaSave();
    if(AUTHOR) authPaint();
    toast(label?('Added "'+label+'"'):'Area added');
  }
  function setAreaMode(on){
    areaMode=on;
    $('areabar').classList.toggle('on',on);
    $('areabtn').classList.toggle('on',on);
    viewer.canvas.style.cursor=on?'crosshair':'';
    if(!on){ areaPts=[]; areaLive(); }
    else { if(inking) setInking(false); areaHintText(); }
  }
  $('areabtn').onclick=()=>setAreaMode(!areaMode);
  $('areaDone').onclick=areaFinish;
  $('areaUndo').onclick=()=>{ areaPts.splice(-2,2); areaLive(); };
  $('areaClear').onclick=()=>{
    // Authored areas are only clearable while authoring, and even then only
    // locally until Save labels writes the empty set. An audience member
    // cannot delete the author's annotations.
    const n=areas.length+(AUTHOR?areasAuth.length:0);
    if(!n&&!areaPts.length) return;
    if(n&&!confirm('Remove all '+n+' area'+(n===1?'':'s')+' on this slide?')) return;
    areas.length=0; if(AUTHOR) areasAuth=[];
    areaPts=[]; areaLive(); areaDraw(); areaSave();
    if(AUTHOR) authPaint(); };
  document.querySelectorAll('.asw').forEach(sw=>{
    if(sw.dataset.c===areaColor) sw.classList.add('on');
    sw.onclick=()=>{ areaColor=sw.dataset.c;
      document.querySelectorAll('.asw').forEach(x=>x.classList.toggle('on',x===sw));
      areaLive(); };});
  // Georeferenced, so it leaves as georeferenced data rather than a picture.
  // WGS84 because that is what the polygons are stored in; converting to the
  // project's UTM here would be inventing a precision the click never had.
  $('areaGeo').onclick=()=>{
    const all=areasAuth.concat(areas);
    if(!all.length){ toast('No areas to export',2400); return; }
    const fc={type:'FeatureCollection',
      note:'Presenter annotations drawn in Orebody. Not surveyed boundaries.',
      crs_note:'WGS84 (EPSG:4326)',
      features:all.map(a=>{
        const ring=[]; for(let i=0;i<a.ll.length;i+=2) ring.push([a.ll[i],a.ll[i+1]]);
        ring.push(ring[0]);
        return {type:'Feature',
          properties:{label:a.label||null, color:a.color, source:'presenter annotation'},
          geometry:{type:'Polygon',coordinates:[ring]}};})};
    dlText('orebody-areas.geojson',JSON.stringify(fc,null,2),'application/geo+json');
    toast('GeoJSON saved');
  };
  // Areas survive a reload, unlike ink. A presenter who marked up a deck the
  // night before should find the marks still there.
  //
  // The stored shape used to be a flat array — one set of annotations for the
  // whole deck. Anything in that form is adopted onto the first slide rather
  // than discarded: it is somebody's work, and silently dropping it on upgrade
  // is worse than putting it somewhere they can find it.
  try{
    const saved=JSON.parse(localStorage.getItem(AREA_KEY)||'{}');
    const clean=v=>Array.isArray(v)
      ? v.filter(a=>a&&Array.isArray(a.ll)&&a.ll.length>=6) : [];
    if(Array.isArray(saved)){ const c=clean(saved); if(c.length) areasLocal={0:c}; }
    else if(saved&&typeof saved==='object')
      Object.keys(saved).forEach(k=>{ const c=clean(saved[k]); if(c.length) areasLocal[k]=c; });
  }catch(e){}
  areaSelect();


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
  function setCut(i){cutIdx=Math.max(CUT_DEFAULT_IDX,i);i=cutIdx;$('cut').value=i;$('cutv').textContent=cutVal().toFixed(2)+' g/t';
    // Both cut-off controls are views onto one value. Updating only the one
    // that was touched lets Explore and the presenter bar disagree about what
    // the model is showing, which is the same class of bug as a readout that
    // does not match the geometry.
    const pr=$('pcutr'); if(pr){ pr.value=i; $('pcutv').textContent=cutVal().toFixed(2)+' g/t'; }
    const pc=$('pcut'); if(pc) pc.classList.toggle('held',cutHold);
    const px=$('pcutx'); if(px) px.hidden=!cutHold;}

  // A cut-off above the ladder must clamp to the most restrictive bin, not
  // fall through to index 0 and reveal the entire model. A chapter that
  // declares no cut-off at all (slide chapters) is a different case — it
  // means "no opinion", not "hide everything", so fall back to the default.
  function applyChapterCut(c){
    const has=c&&c.cut!==undefined&&c.cut!==null;
    const want=Math.max(CUT_DEFAULT,has?c.cut:CUT_DEFAULT);
    const ci=LADDER.findIndex(v=>v>=want);
    setCut(ci<0?LADDER.length-1:ci);
  }
  function setDrills(on){
    drills=on;
    $('drillseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',(x.dataset.d==='1')===on));
  }
  setCut(cutIdx);
  // Moving either control counts as taking manual control of the cut-off, so
  // a value dialled in Explore is not silently discarded on the way back to
  // the deck.
  $('cut').oninput=e=>{cutHold=true;setCut(+e.target.value);apply();};
  $('pcutr').oninput=e=>{cutHold=true;setCut(+e.target.value);apply();};
  $('pcutx').onclick=()=>{cutHold=false;applyChapterCut(CHAPTERS[cur]);apply();};
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
  // Built from whatever products this deck actually has. The markup listed the
  // demo's three, so a hydrated deck offered TMI when it held only RTP and 1VD
  // — a button that selects nothing.
  (function(){
    const seg=$('geoseg'), prods=GEOPHYS.products||[];
    if(!prods.length){ $('georow').style.display='none'; return; }
    seg.innerHTML='';
    const mk=(k,label,on)=>{const b=document.createElement('button');
      b.dataset.gp=k; b.textContent=label; if(on) b.classList.add('on');
      seg.appendChild(b);};
    mk('','Off',true);
    prods.forEach(pr=>mk(pr.key,(pr.key||'').toUpperCase()||'GRID'));
    const tag=$('georow').querySelector('.syntag');
    if(tag) tag.style.display=GEOPHYS_SYNTHETIC?'':'none';
  })();
  $('geoseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    geoShow(b.dataset.gp||'');
    $('geoseg').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    // apply() owns the banner, so the warning appears in the same frame the
    // survey does. Toggling this without it would put fabricated magnetics on
    // screen unlabelled, which is the whole failure mode.
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
    const pct=Math.round(a*100), label=a===0?'cut away':pct+'%';
    $('ground').value=pct;
    $('groundv').textContent=label;
    // Both controls are views on one value. Updating only the one that was
    // touched lets Explore and the presenter bar disagree about what is on
    // screen — the same class of bug as a readout that does not match the
    // geometry.
    const pr=$('pgndr'); if(pr) pr.value=pct;
    const pv=$('pgndv'); if(pv) pv.textContent=label;
    const pg=$('pgnd'); if(pg) pg.classList.toggle('held',groundHold);
    const px=$('pgndx'); if(px) px.hidden=!groundHold;
  }
  const holdGround=a=>{ groundHold=true; setGround(a); };
  $('ground').oninput=e=>holdGround((+e.target.value)/100);
  $('pgndr').oninput=e=>holdGround((+e.target.value)/100);
  // The two ends get their own buttons because they are the two a presenter
  // actually wants mid-sentence: show me the mountain, now take it away.
  $('pgnd0').onclick=()=>holdGround(0);
  $('pgnd100').onclick=()=>holdGround(1);
  $('pgndx').onclick=()=>{ groundHold=false;
    const c=CHAPTERS[cur];
    setGround(c && c.ground!==undefined ? c.ground : groundAlpha); };
  // ---- deposits ----------------------------------------------------------
  // One deck, more than one orebody. Everything derived from the model is
  // swapped together: geometry, extents, rollups, lattice, class labels, the
  // vein list and the camera's frame of reference. The teardown below is the
  // same set the vertical-exaggeration rebuild clears, because it is the same
  // question — every one of these bakes model coordinates into static state.
  // Whatever the first deposit is called — 'siwash' for the baked demo, the
  // first zone's slug for a hydrated deck. Hard-coding the demo's key meant a
  // hydrated deck started out claiming to be on a deposit that was not in its
  // own list, so the switcher highlighted nothing and switching to the real
  // first zone was a no-op.
  let depKey=(DEPOSITS[0]&&DEPOSITS[0].key)||'siwash', depBusy=false, bakedSnap=null;
  const modelState=()=>({F:F,M:M,RUNS:RUNS,N:N,EMIN:EMIN,NMIN:NMIN,CE:CE,CN:CN,CZ:CZ,
    EX:EX,EY:EY,ZTOP:ZTOP,ZBOT:ZBOT,LADDER:LADDER,BUCKETS:BUCKETS,BY_CB:BY_CB,
    VEINS:VEINS,VGROUP:VGROUP,VGROUP_NAMES:VGROUP_NAMES,PROV:PROV,
    CLASS_LABELS:CLASS_LABELS,CLASS_CONFIRMED:CLASS_CONFIRMED,
    TONNES_PER_BLOCK:TONNES_PER_BLOCK,BLOCK_DIMS:BLOCK_DIMS,BLOCK_DENSITY:BLOCK_DENSITY,
    BLOCKS_SYNTHETIC:BLOCKS_SYNTHETIC,HOLES:HOLES,HIGHLIGHTS:HIGHLIGHTS,
    SITE:SITE,SITE_SYNTHETIC:SITE_SYNTHETIC,GEOPHYS:GEOPHYS,
    GEOPHYS_SYNTHETIC:GEOPHYS_SYNTHETIC,STATIONS:STATIONS});
  function loadModelState(s){
    F=s.F;M=s.M;RUNS=s.RUNS;N=s.N;EMIN=s.EMIN;NMIN=s.NMIN;CE=s.CE;CN=s.CN;CZ=s.CZ;
    EX=s.EX;EY=s.EY;ZTOP=s.ZTOP;ZBOT=s.ZBOT;LADDER=s.LADDER;BUCKETS=s.BUCKETS;
    BY_CB=s.BY_CB;VEINS=s.VEINS;VGROUP=s.VGROUP;VGROUP_NAMES=s.VGROUP_NAMES;
    PROV=s.PROV;CLASS_LABELS=s.CLASS_LABELS;CLASS_CONFIRMED=s.CLASS_CONFIRMED;
    TONNES_PER_BLOCK=s.TONNES_PER_BLOCK;BLOCK_DIMS=s.BLOCK_DIMS;BLOCK_DENSITY=s.BLOCK_DENSITY;
    BLOCKS_SYNTHETIC=s.BLOCKS_SYNTHETIC;HOLES=s.HOLES;HIGHLIGHTS=s.HIGHLIGHTS;
    SITE=s.SITE;SITE_SYNTHETIC=s.SITE_SYNTHETIC;GEOPHYS=s.GEOPHYS;
    GEOPHYS_SYNTHETIC=s.GEOPHYS_SYNTHETIC;STATIONS=s.STATIONS;
  }
  bakedSnap=modelState();

  async function depState(d){
    if(d.baked) return bakedSnap;
    if(d._state) return d._state;
    const [buf,bj]=await Promise.all([
      fetch(d.bin).then(r=>{ if(!r.ok) throw new Error('could not load '+d.name); return r.arrayBuffer(); }),
      fetch(d.buckets).then(r=>{ if(!r.ok) throw new Error('could not load the rollups for '+d.name); return r.json(); })]);
    const cols=unpackOreb(buf);
    const st=d.stats, b=st.bounds;
    const m=buildModel(cols,st,bj.ladder);
    const vg={}; (st.veins||[]).forEach((v,i)=>{vg[i]=i%9;});
    d._state={
      F:m.F,M:m.M,RUNS:m.RUNS,N:m.N,
      EMIN:cols.origin[0],NMIN:cols.origin[1],
      CE:(b.x[0]+b.x[1])/2,CN:(b.y[0]+b.y[1])/2,CZ:(b.z[0]+b.z[1])/2,
      EX:b.x[1]-b.x[0],EY:b.y[1]-b.y[0],ZTOP:b.z[1],ZBOT:b.z[0],
      LADDER:bj.ladder,BUCKETS:bj.buckets,BY_CB:bj.by_cb,
      VEINS:st.veins||[],VGROUP:vg,VGROUP_NAMES:(st.veins||[]).slice(0,9),
      CLASS_LABELS:Object.keys(st.by_class||{}).reduce((o,k)=>{
        o[k]=({'1':'Measured','2':'Indicated','3':'Inferred'})[k]||('Class '+k); return o;},{}),
      CLASS_CONFIRMED:false,
      TONNES_PER_BLOCK:st.tonnes_per_block,
      BLOCK_DIMS:st.block_dims,BLOCK_DENSITY:st.density,
      BLOCKS_SYNTHETIC:!!d.synthetic,
      PROV:{source:d.name,scanned_rows:st.scanned_rows,
            mineralized_blocks:st.total.blocks,dropped_blocks:0,
            straddlers:st.blocks_straddling_multiple_domains||0,
            block_m3:st.block_m3,density:st.density,
            tonnes_per_block:st.tonnes_per_block,
            total:st.total,by_class:st.by_class||{},class_confirmed:false,
            drills_synthetic:false,site_synthetic:false,geophys_synthetic:false,
            blocks_synthetic:!!d.synthetic},
      // Drill holes, infrastructure and the magnetics all belong to Siwash
      // North. Carrying them onto another deposit would put one orebody's
      // evidence over another's ground, which is worse than showing nothing.
      // The claim boundaries stay: they are real, property-wide tenures, and
      // this deposit sits inside one of them.
      HOLES:[],HIGHLIGHTS:[],SITE:{areas:[],roads:[],labels:[],claims:[]},
      SITE_SYNTHETIC:false,GEOPHYS:{},GEOPHYS_SYNTHETIC:false,STATIONS:[],
    };
    return d._state;
  }

  function clearModelGeometry(){
    RUNS.forEach(r=>{ if(r.prim) viewer.scene.primitives.remove(r.prim); r.prim=null; });
    if(vgPrims){ vgPrims.forEach(o=>viewer.scene.primitives.remove(o.prim)); vgPrims=null; }
    Object.keys(veinPrims).forEach(v=>{ veinPrims[v].forEach(g=>viewer.scene.primitives.remove(g.prim));
      delete veinPrims[v]; });
    if(drillEnts){ drillEnts.forEach(e=>viewer.entities.remove(e)); drillEnts=null; }
    if(hiEnts){ hiEnts.forEach(e=>viewer.entities.remove(e)); hiEnts=null; }
    if(surfPrims){ surfPrims.forEach(s=>viewer.scene.primitives.remove(s.prim));
      surfPrims=null; utmCache.clear(); }
    if(depthEnts){ depthEnts.forEach(e=>viewer.entities.remove(e)); depthEnts=null; }
    if(siteEnts){ siteEnts.forEach(e=>viewer.entities.remove(e)); siteEnts=null; }
    if(stageEnts){ stageEnts.forEach(es=>es.forEach(e=>viewer.entities.remove(e))); stageEnts=null; }
    if(planLayer){ viewer.imageryLayers.remove(planLayer,true); planLayer=null; planCutBuilt=null; }
    clearSection();
    geoShow('');
    cellIndex.clear(); cellIndexBuilt=false;
  }

  async function switchDeposit(key,opts){
    const d=DEPOSITS.find(x=>x.key===key);
    if(!d||depBusy||key===depKey) return;
    const forChapter=!!(opts&&opts.forChapter);
    depBusy=true;
    setStat('loading '+d.name+'…');
    try{
      const st=await depState(d);
      // Snapshot the CURRENT deposit before overwriting, so the demo's state
      // survives a round trip even though only the baked one starts with a
      // snapshot.
      const cur=DEPOSITS.find(x=>x.key===depKey);
      if(cur){ if(cur.baked) bakedSnap=modelState(); else cur._state=modelState(); }
      clearModelGeometry();
      loadModelState(st);
      depKey=key;
      rebuildBoxes(); reframeModel();
      POS=new Array(N); buildPositions(); buildBase();
      // Surfaces, drills and the magnetics are Siwash-only, so a deposit
      // without them must not be left holding their controls on.
      surfOn=''; drills=false; hiOn=false; planOn=false; siteOn=false; stageIdx=-1;
      paintModelUI(); syncOverlayControls();
      document.querySelectorAll('#depseg button').forEach(b=>
        b.classList.toggle('on',b.dataset.dp===key));
      // Vein surfaces, drill traces, intercepts, the grade map and the
      // magnetics are all Siwash North artifacts. Dimmed rather than removed,
      // so switching back restores the full control set — and so a presenter
      // can see that the controls exist but have nothing to act on here.
      ['surfseg','drillseg','hiseg','planseg','georow'].forEach(id=>{
        const el=$(id); if(!el) return;
        el.style.opacity=d.baked?'':'0.35';
        el.style.pointerEvents=d.baked?'':'none'; });
      apply();
      // Framing, and the one case that was getting this wrong.
      //
      // A chapter that names a deposit AND a camera fires this switch without
      // awaiting it — deliberately, so the walkthrough does not stall on a
      // fetch. go() then flies to the chapter's camera. A second or two later
      // the switch landed here and flew to its own default framing, throwing
      // away the shot the author had set. Every deposit-change slide in the
      // deck quietly ignored its own camera.
      //
      // And it cannot simply be skipped, because the chapter's camera is an
      // angle on the deposit CENTRE and the centre has just moved. So replay
      // the chapter's framing against the new one.
      if(forChapter){
        const c=CHAPTERS[cur];
        if(c) frameFor(c,true);
      } else {
        viewer.camera.flyToBoundingSphere(
          new Cesium.BoundingSphere(center,RADIUS*1.9),{duration:REDUCED?0:2.0});
      }
      toast(d.name+(d.synthetic?' — FABRICATED, not a real deposit':''),
            d.synthetic?6000:3000);
    }catch(e){
      toast('Could not switch deposit: '+e.message,6000);
    }finally{ depBusy=false; setStat(''); }
  }
  // The synthetic tag lives inside the button, not beside it — a fabricated
  // deposit must not be selectable without the word passing under the cursor.
  if(DEPOSITS.length>1){
    $('deprow').hidden=false;
    const seg=$('depseg'); seg.innerHTML='';
    DEPOSITS.forEach(d=>{
      const b=document.createElement('button');
      b.dataset.dp=d.key;
      b.textContent=d.name;
      if(d.synthetic){
        const t=document.createElement('span');
        t.className='syntag'; t.textContent='synthetic';
        b.appendChild(t);
      }
      b.title=d.note||d.name;
      if(d.key===depKey) b.classList.add('on');
      b.onclick=()=>switchDeposit(d.key);
      seg.appendChild(b);});
  }

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
  // Steps rather than a continuous slider: these are the numbers a release
  // actually quotes, and a presenter dragging to 0.37 g/t helps nobody.
  const ASSAY_STEPS=[GRADE_FLOOR,1,2,3,5,10];
  const paintAssay=()=>{ $('assayv').textContent='> '+assayMin.toFixed(2)+' g/t'; };
  $('assayr').max=String(ASSAY_STEPS.length-1);
  $('assayr').oninput=e=>{
    assayMin=ASSAY_STEPS[+e.target.value]||GRADE_FLOOR;
    paintAssay();
    // The beads are baked into the entity set, so changing which are drawn
    // means rebuilding it — cheap next to what it saves on a dense programme.
    if(drillEnts){ drillEnts.forEach(x=>viewer.entities.remove(x)); drillEnts=null; }
    apply();
  };
  paintAssay();
  $('drillseg').querySelectorAll('button').forEach(b=>b.onclick=()=>{setDrills(b.dataset.d==='1');apply();});
  // Legends are built from the same tables that colour the geometry, so they
  // cannot drift out of step with what is on screen.
  const key=(css,label)=>'<div class="k"><span class="sw" style="background:'+css+
    '"></span><span>'+label+'</span></div>';
  $('gradeleg').innerHTML='<span>AuEq g/t</span>'+TIERS.map(T=>key(T.css,T.label)).join('');
  // Rebuilt, not built once: every one of these reads the model, and switching
  // deposits changes all of them. Populated by clearing first so a second call
  // replaces rather than appends.
  function paintModelUI(){
    $('veinleg').innerHTML='<span>Domain</span>'+
      VGROUP_NAMES.map((n,i)=>key(VEIN_COLORS[i],n)).join('');
    const chips=$('clschips'); chips.innerHTML=''; $('clsleg').innerHTML='';
    clsOn={};
    Object.keys(CLASS_LABELS).map(Number).sort().forEach(c=>{
      clsOn[c]=true;
      const d=document.createElement('div'); d.className='chip on'; d.dataset.c=c;
      d.innerHTML='<span class="sw" style="background:'+CLS_COLOR[c]+'"></span>'+CLASS_LABELS[c];
      d.onclick=()=>{clsOn[c]=!clsOn[c];d.classList.toggle('on',clsOn[c]);apply();};
      chips.appendChild(d);
      const k2=document.createElement('div'); k2.className='k';
      k2.innerHTML='<span class="sw" style="background:'+CLS_COLOR[c]+'"></span><span>'+CLASS_LABELS[c]+'</span>';
      $('clsleg').appendChild(k2);
    });
    const vs=$('vsel'); vs.innerHTML=''; vein=-1;
    const veinOz={}; BUCKETS.forEach(b=>veinOz[b.v]=(veinOz[b.v]||0)+b.m/G_PER_OZ);
    // Vein names come from source CSV column headers, so build options through
    // the DOM rather than innerHTML — a header is untrusted input here.
    const mkOpt=(val,label)=>{const o=document.createElement('option');
      o.value=String(val);o.textContent=label;return o;};
    vs.appendChild(mkOpt(-1,'All veins ('+VEINS.length+')'));
    VEINS.map((nm,i)=>({nm:nm,i:i,oz:veinOz[i]||0})).sort((a,b)=>b.oz-a.oz)
      .forEach(v=>vs.appendChild(mkOpt(v.i,v.nm+' — '+Math.round(v.oz).toLocaleString()+' oz')));
    vs.value='-1';
    $('caveat').textContent=(CLASS_CONFIRMED?'':
      'Class labels follow the usual MineSight convention but are unconfirmed against the Nov-2021 technical report. ')+
      'Illustrative visualization — not a mineral resource statement.';
  }
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
  const vsel=$('vsel');
  paintModelUI();
  // Controls that interrogate a block model have nothing to act on without
  // one. Hidden rather than disabled: a row of dead inputs invites a presenter
  // to keep pressing them mid-sentence, and the honest statement is that this
  // project has no resource to filter, not that filtering is switched off.
  if(EXPLORATION){
    ['modeseg','cutrow','clschips','vsel','surfseg','planseg','sectseg',
     'blockseg','deprow'].forEach(id=>{
      const el=$(id); if(!el) return;
      el.style.display='none';
      const h=el.previousElementSibling;
      if(h&&h.tagName==='H3') h.style.display='none';
    });
    const cav=$('caveat');
    if(cav) cav.textContent='Exploration stage — no resource estimate. '+
      'Illustrative visualization, not a mineral resource statement.';
  }
  vsel.onchange=e=>{vein=+e.target.value;setStat(vein===-1?'all veins':'isolating '+VEINS[vein]);apply();};
  $('xbtn').onclick=()=>{const on=$('panel').classList.toggle('on');
    $('xbtn').classList.toggle('on',on); $('xbtn').textContent=on?'Explore ◂':'Explore ▸';
    $('bar').style.opacity=on?'0':'1'; $('bar').style.pointerEvents=on?'none':'auto';};
  // ---- ground-level site view ----
  // The remote-walkthrough equivalent: stand on the ridge above the deposit and
  // look around, rather than always orbiting it from the air. Rendered from the
  // same real terrain, so it is a view of the actual place, not stand-in
  // photography of somewhere else.
  var ground3d=false, savedFrame=null, savedDepth=null, stIdx=0, sweepRaf=null;

  // Terrain height under a station, not a guess from the model's top block.
  // The ridge climbs roughly 180 m across the property, so a single ZTOP-based
  // elevation buries the camera inside the mountain at the uphill stations and
  // leaves it ballooning over the downhill ones.
  async function stGround(lon,lat){
    try{
      const c=Cesium.Cartographic.fromDegrees(lon,lat);
      await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider,[c]);
      if(isFinite(c.height)) return c.height;
    }catch(e){}
    return ZTOP+GEOID;                     // last resort, and visibly wrong up high
  }
  async function stGo(i,fly){
    stIdx=Math.max(0,Math.min(STATIONS.length-1,i));
    const s=STATIONS[stIdx];
    const ll=proj4(PROJ,'WGS84',[s.e,s.n]);
    const h=await stGround(ll[0],ll[1])+(s.eye||40);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    const dest=Cesium.Cartesian3.fromDegrees(ll[0],ll[1],h);
    const or={heading:rad(s.heading),pitch:rad(s.pitch||-8),roll:0};
    if(fly&&!REDUCED) viewer.camera.flyTo({destination:dest,orientation:or,duration:2.2});
    else viewer.camera.setView({destination:dest,orientation:or});
    $('stseg').querySelectorAll('button').forEach((b,k)=>b.classList.toggle('on',k===stIdx));
    $('stnote').textContent=s.note;
  }
  // A full turn on the spot — the closest honest equivalent to a 360 photo,
  // except it is the real mountain rather than a picture of one. Position is
  // held and only heading advances, so it reads as standing still and turning.
  function sweepStop(){ if(sweepRaf){cancelAnimationFrame(sweepRaf);sweepRaf=null;}
    $('st360').classList.remove('on'); }
  function sweep(){
    if(sweepRaf){ sweepStop(); return; }
    $('st360').classList.add('on');
    const cam=viewer.camera, pos=Cesium.Cartesian3.clone(cam.position);
    const pitch=cam.pitch, start=cam.heading;
    let t0=null;
    const DUR=26000;                        // slow enough to read the ground
    const step=ts=>{
      if(t0===null) t0=ts;
      const u=(ts-t0)/DUR;
      if(u>=1){ cam.setView({destination:pos,orientation:{heading:start,pitch:pitch,roll:0}});
                sweepStop(); return; }
      cam.setView({destination:pos,
        orientation:{heading:start+u*Cesium.Math.TWO_PI,pitch:pitch,roll:0}});
      sweepRaf=requestAnimationFrame(step);
    };
    sweepRaf=requestAnimationFrame(step);
  }
  // Built from STATIONS rather than written into the markup, so adding a
  // vantage is a one-line change in Python.
  STATIONS.forEach((s,i)=>{
    const b=document.createElement('button');
    b.textContent=s.name; b.title=s.note;
    if(i===0) b.classList.add('on');
    b.onclick=()=>{ sweepStop(); stGo(i,true); };
    $('stseg').appendChild(b);});
  $('st360').onclick=sweep;
  $('stx').onclick=()=>$('sitebtn').click();
  // Any manual camera input abandons the sweep — fighting the user for the
  // camera is the fastest way to make a viewer feel broken.
  ['mousedown','wheel','touchstart'].forEach(ev=>
    viewer.canvas.addEventListener(ev,()=>{ if(sweepRaf) sweepStop(); },{passive:true}));

  $('sitebtn').onclick=()=>{
    ground3d=!ground3d;
    $('sitebtn').classList.toggle('on',ground3d);
    sweepStop();
    $('stbar').hidden=!ground3d;
    if(ground3d){
      stop();
      savedFrame=cur;
      if(!siteOn){ siteOn=true;
        document.querySelectorAll('#siteseg button').forEach(x=>
          x.classList.toggle('on',x.dataset.s==='1'));
        apply(); }
      // The depth grid measures metres below surface. From the surface it is
      // just numbers hanging in the sky.
      savedDepth=depthOn; depthOn=false; showDepth(false);
      syncOverlayControls();          // or Explore keeps claiming it is shown
      setGround(1.0);
      // setGround drops the terrain depth test so the deposit shows THROUGH
      // the mountain — right for an orbit, wrong from the ground, where it
      // paints grade cubes over the hillside you are standing on. From a
      // vantage the mountain has to occlude, or this is not a view of the
      // place at all.
      viewer.scene.globe.depthTestAgainstTerrain=true;
      // Slide chapters keep their card up over the canvas. Standing on the
      // ridge behind a full-bleed title is not a site view.
      $('slide').classList.remove('on');
      $('cap').classList.remove('in');
      stGo(stIdx,true);
      toast('Site view — pick a vantage, or sweep the horizon with 360°',4200);
    } else {
      if(savedDepth!==null){ depthOn=savedDepth; savedDepth=null; }
      syncOverlayControls();
      go(savedFrame===null?cur:savedFrame);
    }
  };
  $('sharebtn').onclick=()=>{syncHash();
    navigator.clipboard.writeText(location.href).then(()=>toast('Link copied'),()=>toast('Copy failed'));};

  // ---- embed kit -------------------------------------------------------
  // The deck is already iframe-able via ?embed=1. What was missing is the part
  // a non-technical person actually needs: the snippet, sized correctly, with
  // the caveats travelling attached to it. A caption that can be deleted is not
  // a disclosure, so the fabricated-data sentence is written into the snippet
  // itself AND into the JSON — the deck also carries its own on-screen banner,
  // so stripping the caption still cannot produce an unlabelled embed.
  const DECK=document.title.split(' \u00b7 ')[0];
  // Served from a real host, the deck knows its own address. Served from
  // localhost it does not, and a snippet pointing at 127.0.0.1 is useless to
  // everyone but its author — so fall back to the published alias. That is
  // orebody-FAWN, not orebody.vercel.app: the bare name belongs to an unrelated
  // project, and defaulting to it would have handed users a snippet that
  // embedded a stranger's website.
  const PUBLISHED='https://orebody-fawn.vercel.app/';
  function embBase(){
    const u=location.origin+location.pathname;
    return /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u)
      ? PUBLISHED : u;
  }
  function embFabricated(){
    // Static, not live state: an embed is interactive, so a viewer can switch
    // any of these on after the snippet is pasted. The disclosure has to cover
    // what the deck CAN show, not what happened to be visible when it was copied.
    const f=[]; if(PROV.blocks_synthetic) f.push('block model');
    if(PROV.drills_synthetic) f.push('drill holes');
    if(PROV.site_synthetic) f.push('site features','pit stages');
    if(PROV.geophys_synthetic) f.push('geophysics');
    return f;
  }
  // Oxford-less list join, so three fabricated layers do not read
  // "a and b and c".
  function embList(f){
    return f.length<2 ? (f[0]||'')
         : f.slice(0,-1).join(', ')+' and '+f[f.length-1];
  }
  function embCaption(){
    let s=DECK+' \u2014 '+Math.round(PROV.total.tonnes).toLocaleString()+' t @ '+
          PROV.total.grade_gt+' g/t AuEq. Illustrative visualization, not a '+
          'mineral resource statement.';
    const f=embFabricated();
    if(f.length) s+=' The '+embList(f)+' shown are FABRICATED and are not real data.';
    return s;
  }
  function embSrc(){
    let u=$('emburl').value.trim()||embBase();
    u=u.split('#')[0];
    const q=[]; q.push('embed=1');
    if(!$('embauto').checked) q.push('autoplay=0');
    u+=(u.indexOf('?')>=0?'&':'?')+q.join('&');
    if($('embstart').value==='here'){ syncHash(); u+=location.hash; }
    return u;
  }
  function embSnippet(){
    const pad=$('embratio').value, src=embSrc();
    let s='<!-- '+DECK+' \u2014 interactive 3D deck -->\n'+
      '<div style="position:relative;width:100%;padding-top:'+pad+'%;'+
      'border-radius:6px;overflow:hidden;background:#080b0d">\n'+
      '  <iframe src="'+src+'"\n'+
      '    title="'+DECK+'" loading="lazy" allowfullscreen\n'+
      '    style="position:absolute;inset:0;width:100%;height:100%;border:0">'+
      '</iframe>\n</div>';
    if($('embcap').checked)
      s+='\n<p style="font:12px/1.6 system-ui,-apple-system,sans-serif;'+
         'color:#6b7580;margin:8px 0 0">'+embCaption()+'</p>';
    return s;
  }
  function embRefresh(){
    $('embcode').textContent=embSnippet();
    const local=/localhost|127\.0\.0\.1/.test($('emburl').value);
    $('embnote').textContent=local
      ? 'This points at your own machine, so nobody else will be able to load it. '+
        'Replace the address above with wherever you publish the deck.'
      : 'The deck streams its own terrain and model data, so the snippet stays '+
        'tiny and updates whenever you republish. Works in any block that '+
        'accepts raw HTML.';
    $('embnote').style.color=local?'#E8A33C':'';
  }
  function embDoc(){
    return '<!doctype html>\n<html lang="en">\n<head>\n'+
      '<meta charset="utf-8">\n'+
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n'+
      '<title>'+DECK+'</title>\n'+
      '<style>html,body{margin:0;height:100%;background:#080b0d;'+
      'font-family:system-ui,-apple-system,sans-serif}'+
      '.wrap{max-width:1200px;margin:0 auto;padding:24px}</style>\n'+
      '</head>\n<body>\n<div class="wrap">\n'+embSnippet()+'\n</div>\n'+
      '</body>\n</html>\n';
  }
  function embJson(){
    return JSON.stringify({
      deck:DECK, generator:'Orebody', format:'orebody-embed/1',
      embed_url:embSrc(), caption:embCaption(),
      deposit:{tonnes:PROV.total.tonnes, grade_gt:PROV.total.grade_gt,
               oz:PROV.total.oz, blocks:PROV.mineralized_blocks,
               metal:'AuEq', cutoff_gt:GRADE_FLOOR},
      source:PROV.source,
      chapters:CHAPTERS.map((c,i)=>({n:i+1, section:c.section||null,
        title:(c.slide?c.slide.title:c.title)||('Chapter '+(i+1))})),
      caveats:{
        resource_class_labels_confirmed:!!PROV.class_confirmed,
        fabricated:embFabricated(),
        silver_absent:true,
        statement:'Illustrative visualization \u2014 not a mineral resource statement.'
      }
    },null,2);
  }
  function dlText(name,text,mime){
    const b=new Blob([text],{type:mime});
    const u=URL.createObjectURL(b), a=document.createElement('a');
    a.href=u; a.download=name; a.click();
    setTimeout(()=>URL.revokeObjectURL(u),4000);
  }
  $('embedbtn').onclick=()=>{
    if(!$('emburl').value) $('emburl').value=embBase();
    embRefresh(); $('emb').classList.add('on');
  };
  $('embclose').onclick=()=>$('emb').classList.remove('on');
  $('emb').onclick=e=>{ if(e.target===$('emb')) $('emb').classList.remove('on'); };
  ['emburl','embratio','embstart','embauto','embcap'].forEach(id=>{
    $(id).addEventListener('input',embRefresh);
    $(id).addEventListener('change',embRefresh);
  });
  $('embcopy').onclick=()=>navigator.clipboard.writeText(embSnippet())
    .then(()=>toast('Snippet copied \u2014 paste it into an HTML block'),
          ()=>toast('Copy failed'));
  $('embhtml').onclick=()=>{ dlText('orebody-embed.html',embDoc(),'text/html');
    toast('orebody-embed.html saved'); };
  $('embjson').onclick=()=>{ dlText('orebody-deck.json',embJson(),'application/json');
    toast('orebody-deck.json saved'); };

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

  // ---- transitions --------------------------------------------------
  // TRACKING.md #11. Getting from one chapter to the next is geometry, not
  // intelligence, and the failure modes are specific:
  //
  //   whip-pan     interpolating 350deg -> 10deg the long way round is 340
  //                degrees of spin for a 20 degree change. Normalise the
  //                target into +/-180 of where the camera already is.
  //   scale jump   5 km out to a 200 m close-up in one move reads as a cut.
  //                Beyond an order of magnitude, pull back through an
  //                establishing frame and come down from there.
  //   flat path    two viewpoints either side of the ridge joined by a
  //                straight line go through it. Arc over, by an amount
  //                proportional to how far apart they are.
  //   fixed time   2.3s for both a 5 km move and a 20 m nudge. Scale it.
  //
  // Layers are already armed before this runs — go() calls apply() first — so
  // the destination is drawn before the camera arrives rather than popping in
  // on landing.
  const DEG=x=>x*180/Math.PI;
  function shortestHeading(fromDeg,toDeg){
    let d=((toDeg-fromDeg)%360+540)%360-180;   // -> (-180,180]
    return fromDeg+d;
  }
  function flightFor(targetRange){
    const here=viewer.camera.positionWC;
    const metres=center?Math.abs(Cesium.Cartesian3.distance(here,center)-targetRange):0;
    // Roughly 1.1s of flight per kilometre of change, clamped either side.
    // Short enough not to bore, long enough to read as a move.
    const dur=Math.max(1.1,Math.min(4.2,1.1+metres/1000*1.1));
    // Arc height grows with separation: nothing for a nudge, a real lift for a
    // traverse. Cesium interprets this as the apex of the flight path.
    const arc=metres>900?Math.min(4200,metres*0.55):undefined;
    return {dur:dur, arc:arc, metres:metres};
  }
  function frameFor(c,animate){
    // A property chapter frames the land package, not the orebody — `center`
    // and RADIUS belong to whichever deposit is loaded and would put the
    // camera inside one corner of the view.
    if(c.property){ frameProperty(); return; }
    if(c.free){ frameFree(c.free,animate); return; }
    const curH=DEG(viewer.camera.heading);
    const h=shortestHeading(curH,c.h);
    const hpr=new Cesium.HeadingPitchRange(rad(h),rad(c.p),c.r);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    if(!(animate&&!REDUCED)){ viewer.camera.lookAt(center,hpr); return; }

    const f=flightFor(c.r);
    const sphere=new Cesium.BoundingSphere(center,RADIUS);
    const land=()=>viewer.camera.lookAt(center,hpr);

    // Scale-jump guard. Compare the range we are leaving with the one we are
    // arriving at; past ~8x, go via a frame that contains both so the viewer
    // keeps its bearings instead of being dollied blind through the gap.
    const prevR=lastRange||c.r;
    const ratio=Math.max(prevR,c.r)/Math.max(1,Math.min(prevR,c.r));
    if(ratio>8){
      const midR=Math.sqrt(prevR*c.r);
      const midHpr=new Cesium.HeadingPitchRange(rad(h),rad(Math.max(-52,c.p-14)),midR);
      viewer.camera.flyToBoundingSphere(sphere,{
        offset:midHpr, duration:Math.max(0.9,f.dur*0.45), maximumHeight:f.arc,
        complete:()=>viewer.camera.flyToBoundingSphere(sphere,{
          offset:hpr, duration:Math.max(0.9,f.dur*0.65), complete:land})});
    } else {
      viewer.camera.flyToBoundingSphere(sphere,{
        offset:hpr, duration:f.dur, maximumHeight:f.arc, complete:land});
    }
    lastRange=c.r;
  }
  // An absolute camera. No scale-jump guard and no lookAt frame: a free shot
  // is chosen for where it is, and orbiting it about a deposit centre it was
  // never aimed at is exactly what the author was avoiding by choosing it.
  function frameFree(f,animate){
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    const dest=Cesium.Cartesian3.fromDegrees(f.lon,f.lat,f.height);
    const orient={heading:rad(f.heading),pitch:rad(f.pitch),roll:0};
    // lastRange is the guard's memory of how far out we were. A free shot has
    // no comparable range, and leaving a stale one behind would have the next
    // orbit chapter compute a jump ratio against a number that means something
    // else. Forget it instead.
    lastRange=null;
    if(!(animate&&!REDUCED)){ viewer.camera.setView({destination:dest,orientation:orient}); return; }
    viewer.camera.flyTo({destination:dest,orientation:orient,
      duration:Math.max(1.2,Math.min(4.0,flightFor(f.height).dur))});
  }
  let lastRange=null;
  function paintUI(){
    const c=CHAPTERS[cur];
    if(AUTHOR) authPaint();
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
    trkChapter(i);
    // Unwind any hole view FIRST. It restores the layer state it borrowed, and
    // everything below this line is the new chapter writing that same state —
    // run in the other order the restore lands on top and the chapter loses.
    exitHoleView(false);
    // A chapter may declare which deposit it is about. The switch is async and
    // deliberately not awaited: the rest of the chapter applies immediately and
    // the geometry lands when it lands, rather than stalling the walkthrough on
    // a fetch. A chapter that says nothing leaves the deposit where it is, so a
    // presenter who switched by hand is not overridden on the next slide.
    depPromise=(c.deposit && c.deposit!==depKey)
      ? switchDeposit(c.deposit,{forChapter:true}) : null;
    // A cut-off above the ladder must clamp to the most restrictive bin, not
    // fall through to index 0 and reveal the entire model. A chapter that
    // declares no cut-off at all (slide chapters) is a different case — it
    // means "no opinion", not "hide everything", so fall back to the default.
    // Held cut-off wins over the chapter's. Refresh the control anyway so the
    // "held" badge repaints on every chapter change — otherwise the presenter
    // loses track of the fact that the deck is no longer driving.
    if(cutHold) setCut(cutIdx); else applyChapterCut(c);
    setMode(c.mode||'grade');
    setDrills(assetOnly?false:!!c.drills);
    if(c.section3d && !assetOnly){
      sectAxis=c.section3d;
      const pct=c.sectionAt===undefined?50:c.sectionAt;
      $('sect').value=pct;
      setSection(sectAxis,sectFrom(pct));
    } else if(sectAxis){ sectAxis=null; setSection(null); }
    $('sectseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.x||null)===(sectAxis||null)));
    planOn=assetOnly?false:!!c.plan;
    // Property columns, blackout and callouts are chapter state like anything
    // else — a chapter that does not ask for them turns them off, so none of
    // the three leaks forward into a slide whose copy never mentions it.
    propOn=assetOnly?false:!!c.property;
    $('propbtn').classList.toggle('on',propOn);
    // The colour-pop mask exists to make the orebody the only saturated thing
    // in the world. On a slide about the district that defeats the slide: the
    // neighbours, the roads and the ground they are all on go black, and the
    // one bright patch is the thing this chapter is deliberately not about.
    // Explicit rather than inferred from the camera range, so an author can
    // disagree.
    if(!assetOnly) setPop(c.pop!==false);
    // The depth grid was the one layer no chapter could turn off — it
    // persisted from wherever it was last left, so a surface slide inherited a
    // set of floating depth rectangles from three chapters earlier.
    if(!assetOnly && c.depth!==undefined){ depthOn=!!c.depth; showDepth(depthOn);
      $('depthseg').querySelectorAll('button').forEach(x=>
        x.classList.toggle('on',(x.dataset.g==='1')===depthOn)); }
    if(!assetOnly) setBlackout(!!c.black); else if(blackout) setBlackout(false);
    setCallouts(assetOnly?false:!!c.callouts);
    $('planseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.l==='1')===planOn));
    targetsOn=c.targets!==false;
    gcOn=!assetOnly&&!!c.geochem;
    if(c.site!==undefined && !assetOnly){ siteOn=!!c.site;
      $('siteseg').querySelectorAll('button').forEach(x=>
        x.classList.toggle('on',(x.dataset.s==='1')===siteOn)); }
    // Unconditional, unlike site: every chapter that does not ask for the
    // survey turns it off. A fabricated layer must not leak forward into
    // chapters whose copy says nothing about it.
    // A drilling chapter is about the holes, so it starts from an empty
    // scene. The block model, the vein surfaces and the geophysics are not
    // context at that range — a grade-coloured body sitting directly behind a
    // grade-coloured bead makes the assay unreadable, which is the one thing
    // the chapter exists to show. Any of it can still be asked for by name;
    // `blocks:true` on a drilling chapter is the deliberate against-the-model
    // beat. It just has to be asked for.
    const drillClean=!assetOnly && !!c.drills;
    const wantGeo=(drillClean && c.geo===undefined)?'':(c.geo||'');
    if(!assetOnly && wantGeo!==geoKey){
      geoShow(wantGeo);
      $('geoseg').querySelectorAll('button').forEach(x=>
        x.classList.toggle('on',(x.dataset.gp||'')===geoKey)); }
    blocksOn=c.blocks!==undefined?!!c.blocks:!drillClean;

    $('blockseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.b==='1')===blocksOn));
    surfOn=(drillClean && c.surfaces===undefined)?'':(c.surfaces||'');
    $('surfseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.f||'')===surfOn));
    hiOn=assetOnly?false:!!c.highlights;
    $('hiseg').querySelectorAll('button').forEach(x=>
      x.classList.toggle('on',(x.dataset.h==='1')===hiOn));
    vein=-1; vsel.value='-1';
    // Reset first, THEN honour any per-chapter selection — the reset used to run
    // afterwards and silently undid it, so every reveal step showed all classes.
    Object.keys(clsOn).forEach(k=>{clsOn[k]=!c.classes || c.classes.indexOf(+k)>=0;});
    chips.querySelectorAll('.chip').forEach(el=>el.classList.toggle('on',clsOn[el.dataset.c]));
    inkClearAll();
    areaSelect();
    setPin(assetOnly?null:c.pin);
    // A drilling chapter opens the ledger for you — it is the reason the
    // chapter exists, and reaching for a toolbar button mid-sentence is
    // exactly the friction the walkthrough is meant to remove.
    if(!assetOnly && c.drills && HOLES.length && !ledgerOn) setLedger(true);
    if(stageIdx>=0){ showStage(-1); $('stage').value=-1; }
    // Navigating away ends the ground view; leaving the flag set made the Site
    // button jump the user to a chapter they never asked for.
    if(ground3d){ ground3d=false; $('sitebtn').classList.remove('on');
                  sweepStop(); $('stbar').hidden=true;
                  // Leaving via the rail rather than Exit must still give the
                  // depth grid back, or it stays off for the rest of the deck.
                  if(savedDepth!==null){ depthOn=savedDepth; savedDepth=null;
                    $('depthseg').querySelectorAll('button').forEach(x=>
                      x.classList.toggle('on',(x.dataset.g==='1')===depthOn)); } }
    viewer.scene.globe.depthTestAgainstTerrain=true;
    // Cutting the ground away is a deliberate beat, not a permanent state:
    // overhead shots read better with the mountain intact and the deposit shown
    // through it, and the cut earns its impact when the subsurface is the point.
    // Held terrain wins over the chapter's. Refresh it anyway so the "held"
    // badge repaints on every chapter change — otherwise the presenter loses
    // track of the fact that the deck is no longer driving it.
    const ga=groundHold?groundAlpha:((c.ground===undefined)?groundAlpha:c.ground);
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
    // Capture the current camera for the deck editor. Typing five numbers out
    // of a 3D scene by hand is not something anyone should be asked to do.
    if(e.key==='c'||e.key==='C'){
      // The orbit triple, which is what a chapter stores. This used to copy
      // lon/lat/h/heading/pitch — a shape the viewer has never read, whose `h`
      // meant the opposite of the `h` it was pasted into.
      const cap=captureCamera();
      const s=JSON.stringify(cap.orbit||cap.free);
      navigator.clipboard.writeText(s).then(
        ()=>toast('Camera copied \u2014 paste it into the chapter'),
        ()=>toast('Camera: '+s,8000));
      return;
    }
    if(e.key==='ArrowRight'||e.key===' '){stop();go(cur+1);}
    else if(e.key==='ArrowLeft'){stop();go(cur-1);}
    // In embed mode the panel is display:none, so toggling it would only hide
    // the caption and nav with no visible way back.
    else if((e.key==='e'||e.key==='E')&&!EMBED) $('xbtn').click();
    else if(e.key==='p'||e.key==='P') $('play').click();
    else if(e.key==='n'||e.key==='N') $('narr').click();
    else if(e.key==='a'||e.key==='A') setAssetOnly(!assetOnly);
    else if(e.key==='r'||e.key==='R') rec?stopRec():startRec();
    else if(e.key==='d'||e.key==='D') setInking(!inking);
    else if(e.key==='g'||e.key==='G') setAreaMode(!areaMode);
    else if(e.key==='h'||e.key==='H'){ if(HOLES.length) setLedger(!ledgerOn); }
    // I, B, O — NOT C or P. C returns early above (copy camera for the deck
    // editor) and P is autoplay, so binding either here produced a shortcut
    // that silently never fired.
    else if(e.key==='i'||e.key==='I') setCallouts(!calloutsOn);
    else if(e.key==='b'||e.key==='B') setBlackout(!blackout);
    else if(e.key==='o'||e.key==='O'){ propOn=!propOn;
      $('propbtn').classList.toggle('on',propOn);
      showProperty(propOn).then(()=>{ if(propOn) frameProperty(); apply(); })
        .catch(err=>toast('Property view unavailable: '+err.message,5000)); }
    else if(e.key==='Enter'&&areaMode) areaFinish();
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
        // Same clause as foot(): a drawn area is captured into the bitmap like
        // any other geometry, and a labelled polygon in a still is otherwise
        // indistinguishable from something the model produced.
        const disc=(CLASS_CONFIRMED?'':'Resource class labels unconfirmed. ')+
                   'Illustrative visualization — not a mineral resource statement.'+
                   (areas.length?' '+areas.length+' area'+(areas.length===1?'':'s')+
                                 ' drawn by the presenter.':'');
        x.font=Math.round(13*S)+'px ui-monospace, monospace';
        x.textBaseline='bottom';
        const w=x.measureText(disc).width, h=Math.round(24*S);
        x.fillStyle='rgba(7,9,10,.82)';
        x.fillRect(pad-Math.round(9*S), c.height-pad-h, w+Math.round(18*S), h);
        x.fillStyle='#C6CAC5';
        x.fillText(disc, pad, c.height-pad-Math.round(6*S));
        const fabricated=(drills&&DRILL_SYNTHETIC)||(siteOn&&SITE_SYNTHETIC)||
                         (stageIdx>=0&&SITE_SYNTHETIC)||
                         (geoKey&&GEOPHYS_SYNTHETIC)||BLOCKS_SYNTHETIC;
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
    const snap={mode:mode,cutIdx:cutIdx,vein:vein,clsOn:Object.assign({},clsOn),
                geo:geoKey};
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
      if(snap.geo!==geoKey) geoShow(snap.geo);
      syncOverlayControls();
      apply();
      if(wasPanel) $('xbtn').click();
      exporting=false; ['expPng','expPptx','expPdf'].forEach(id=>$(id).disabled=false);
    }
    return shots;
  }
  // Recomputed per export rather than fixed at load: the footer has to describe
  // what is actually on the slide, not what might be.
  // The deck's own name, for exported files. This was hard-coded to
  // "Elk-Gold-Siwash-North", so every customer's PowerPoint arrived named
  // after the demo property — on a document they are about to send to an
  // investor.
  function deckName(){
    const t=(document.title||'').split(' · ')[0].trim();
    return (t||'orebody-deck').replace(/[^\w\- ]+/g,'').replace(/\s+/g,'-').slice(0,60);
  }
  // Where the live deck lives, so a static slide is a doorway rather than a
  // dead end. A PowerPoint is forwarded, opened offline, printed — and the one
  // thing it cannot do is show the model turning. The link is how somebody
  // gets from the picture to the thing.
  function liveUrl(){
    const u=new URL(location.href);
    u.searchParams.delete('embed'); u.searchParams.delete('author');
    u.searchParams.delete('data'); u.searchParams.delete('fresh');
    u.hash='';
    return u.toString();
  }
  function foot(){
    const f=[];
    if(drills&&DRILL_SYNTHETIC) f.push('drill holes');
    if(siteOn&&SITE_SYNTHETIC) f.push('site features');
    if(stageIdx>=0&&SITE_SYNTHETIC) f.push('pit stages');
    if(geoKey&&GEOPHYS_SYNTHETIC) f.push('geophysics');
    if(BLOCKS_SYNTHETIC) f.unshift('the block model itself');
    // Areas are the presenter's own marks, not fabricated data, so they get a
    // plain sentence rather than the red banner. They still get counted: a
    // coloured polygon labelled "high-priority target" burned into a slide is
    // otherwise indistinguishable from modelled geometry.
    const marks=areas.length
      ? ' '+areas.length+' area'+(areas.length===1?'':'s')+' drawn by the presenter.' : '';
    return (CLASS_CONFIRMED?'':'Resource class labels unconfirmed. ')+
      'Illustrative visualization — not a mineral resource statement.'+
      (f.length?' SYNTHETIC, fabricated: '+f.join(', ')+'.':'')+marks;
  }

  $('expPptx').onclick=async()=>{
    try{
      toast('Building deck…',60000);
      await loadJs('pptx');
      const shots=await shoot();
      const live=liveUrl();
      const p=new PptxGenJS(); p.layout='LAYOUT_16x9';
      shots.forEach(s=>{
        const sl=p.addSlide();
        sl.background={color:'07090A'};
        // The whole image is the link. A viewer who wants the live model
        // should not have to find a small piece of text to click.
        sl.addImage({data:s.img,x:0,y:0,w:'100%',h:'100%',
                     hyperlink:{url:live,tooltip:'Open the interactive 3D deck'}});
        sl.addShape(p.ShapeType.rect,{x:0,y:3.4,w:'100%',h:2.2,fill:{color:'07090A',transparency:22}});
        sl.addText(s.title,{x:0.5,y:3.6,w:8.5,h:0.6,fontSize:26,bold:true,color:'FFFFFF',fontFace:'Arial'});
        sl.addText(s.body,{x:0.5,y:4.25,w:8.5,h:0.9,fontSize:13,color:'C6CAC5',fontFace:'Arial'});
        sl.addText(fmt(s.stats.t)+'   ·   '+s.stats.g.toFixed(2)+' g/t AuEq   ·   '+fmtoz(s.stats.oz),
          {x:0.5,y:5.05,w:8.5,h:0.35,fontSize:12,color:'C99A3A',fontFace:'Consolas'});
        sl.addText(foot(),{x:0.5,y:5.32,w:8.5,h:0.34,fontSize:10,color:'C6CAC5',fontFace:'Arial'});
        sl.addText('Open in 3D  \u2192',{x:8.05,y:0.22,w:1.6,h:0.3,fontSize:11,
          color:'C99A3A',fontFace:'Arial',align:'right',
          hyperlink:{url:live,tooltip:'Open the interactive 3D deck'}});
      });
      await p.writeFile({fileName:deckName()+'.pptx'});
      toast('PPTX saved');
    }catch(e){ toast('PPTX failed: '+e.message,5000); }
  };

  $('expPdf').onclick=async()=>{
    try{
      toast('Building PDF…',60000);
      await loadJs('pdf');
      const shots=await shoot();
      const {jsPDF}=window.jspdf;
      const live=liveUrl();
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
        // Same reasoning as the PPTX: the page is the link.
        doc.link(0,0,960,360,{url:live});
        doc.setTextColor(201,154,58); doc.setFontSize(11);
        doc.text('Open in 3D \u2192',830,34);
        doc.link(820,20,110,20,{url:live});
      });
      doc.save(deckName()+'.pdf');
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
    // Wrapped for the same reason as the layers: a throw while applying the
    // opening chapter used to leave the viewer built, the data loaded, and the
    // user staring at "Could not start".
    try{ go(0,true); }
    catch(err){
      console.error('Orebody: the opening chapter failed to apply',err);
      toast('The opening view failed — use the chapter list',7000);
    }
  }
  stopWatchdog();
  $('load').style.display='none';
  $('begin').onclick=()=>{$('intro').style.opacity='0';setTimeout(()=>$('intro').style.display='none',800);
    frameFor(CHAPTERS[0],true); if(EMBED&&EMBED_AUTOPLAY&&!REDUCED) play();};

  // ---- capture: turn the live scene into a chapter row --------------------
  // Authoring a camera by typing five numbers out of a 3D scene is not a thing
  // anyone should be asked to do, and copying JSON through the clipboard into
  // another tab is barely better. This is the other half of the studio: what
  // the presenter is looking at, in exactly the shape a chapter stores.
  //
  // The orbit form is DERIVED rather than read off the camera. Cesium's
  // heading and pitch are relative to the camera's own local frame, which for
  // a camera that was free-flown is not the deposit centre's — so reading them
  // straight would write a shot that does not reproduce. Putting the camera
  // position into the centre's frame and inverting HeadingPitchRange gives the
  // triple that actually replays.
  function captureCamera(){
    const p=viewer.camera.positionCartographic;
    const free={mode:'free',
      lon:+Cesium.Math.toDegrees(p.longitude).toFixed(6),
      lat:+Cesium.Math.toDegrees(p.latitude).toFixed(6),
      height:Math.round(p.height),
      heading:+DEG(viewer.camera.heading).toFixed(1),
      pitch:+DEG(viewer.camera.pitch).toFixed(1)};
    let orbit=null;
    if(center){
      const inv=Cesium.Matrix4.inverseTransformation(
        Cesium.Transforms.eastNorthUpToFixedFrame(center), new Cesium.Matrix4());
      const l=Cesium.Matrix4.multiplyByPoint(inv, viewer.camera.positionWC,
                                             new Cesium.Cartesian3());
      const r=Math.sqrt(l.x*l.x+l.y*l.y+l.z*l.z);
      if(r>1){
        let hd=DEG(Math.atan2(-l.x,-l.y)); if(hd<0) hd+=360;
        orbit={h:+hd.toFixed(1), p:+DEG(Math.asin(-l.z/r)).toFixed(1), r:Math.round(r)};
      }
    }
    return {orbit:orbit, free:free};
  }

  // Every switched thing in the scene, in chapter-key form. Written sparsely:
  // a chapter that says nothing about a layer means "off", so emitting every
  // key at its default would bloat every row and, worse, would freeze today's
  // defaults into rows that should follow them.
  function captureLayers(){
    const L={mode:mode, cut:cutVal(), ground:groundAlpha};
    if(!blocksOn) L.blocks=false;
    if(drills) L.drills=true;
    if(hiOn) L.highlights=true;
    if(siteOn) L.site=true;
    if(planOn) L.plan=true;
    if(!depthOn) L.depth=false;
    if(surfOn) L.surfaces=surfOn;
    if(geoKey) L.geo=geoKey;
    if(gcOn) L.geochem=true;
    if(propOn) L.property=true;
    if(blackout) L.black=true;
    if(calloutsOn) L.callouts=true;
    if(assetOnly) L.assetOnly=true;
    if(!targetsOn) L.targets=false;
    if(sectAxis){ L.section3d=sectAxis; L.sectionAt=+$('sect').value; }
    if(vein!==-1) L.vein=vein;
    if(typeof depKey!=='undefined' && depKey) L.deposit=depKey;
    const cls=Object.keys(clsOn).filter(k=>clsOn[k]).map(Number);
    if(cls.length<4) L.classes=cls;
    return L;
  }

  // ---- authoring bridge ---------------------------------------------------
  // The viewer never gets write credentials, and this is the reason the studio
  // is built this way round. It is a public, anonymous renderer that anyone
  // with a share link loads; giving it a session so it could save a chapter
  // would put tenant write access into that document. So the console frames
  // it, this end reports what it is looking at, and the console — already
  // authenticated, already subject to RLS — decides what to store.
  //
  // The console's origin is learnt from its own handshake, never read off a
  // query parameter. A parameter is supplied by whoever wrote the URL, so
  // trusting one would let any page that can frame this one nominate itself
  // as the recipient of everything the bridge reports.
  const authPeer=()=>(parent&&parent!==window)?parent:(window.opener||null);
  function authSend(m){
    const peer=authPeer();
    if(authOrigin&&peer) peer.postMessage(Object.assign({source:'orebody-viewer'},m),authOrigin);
  }
  // Replay the flight INTO a chapter, from the one before it, and time what
  // actually happened. An authored deck's weak point is not any single shot,
  // it is the move between two of them — and the move a static reading of the
  // rows cannot predict is the deposit change, because the model download is
  // asynchronous and lands whenever it lands. So this measures rather than
  // estimates: when the camera came to rest, when the geometry finished, and
  // which of the two the audience would have been left waiting on.
  async function previewTransition(ord){
    const c=CHAPTERS[ord];
    if(!c) return null;
    stop();
    if(ord>0){
      go(ord-1,true);
      await new Promise(r=>setTimeout(r,850));
    }
    const t0=performance.now();
    depPromise=null;
    go(ord);
    const camMs=await new Promise(res=>{
      let off=null;
      const done=()=>{ if(off) off(); off=null; res(performance.now()-t0); };
      off=viewer.camera.moveEnd.addEventListener(done);
      // A chapter whose camera does not move fires no moveEnd at all, so this
      // is the answer for that case rather than a failsafe for a hang.
      setTimeout(done,12000);
    });
    let depMs=null;
    if(depPromise){ await depPromise; depMs=performance.now()-t0; }
    return {ord:ord, from:ord>0?(ord-1):null,
            camMs:Math.round(camMs),
            depMs:depMs===null?null:Math.round(depMs),
            deposit:c.deposit||null,
            // A quarter of a second is about where a late arrival stops being
            // a flourish and starts being the audience watching an empty frame.
            late:depMs!==null && depMs>camMs+250};
  }

  function authSnapshot(){
    return {ord:cur, total:CHAPTERS.length, title:(CHAPTERS[cur]||{}).title||'',
            camera:captureCamera(), layers:captureLayers(),
            areas:areasAuth.concat(areas)};
  }
  function authPaint(){
    if(!authOrigin) return;
    const lab=$('authlab');
    if(lab){
      // Offered when there is something unpublished to publish, and also when
      // the author has just cleared a slide's authored labels — otherwise
      // there would be no way to commit the deletion.
      const pending=areas.length || (areasAuth.length!==(((CHAPTERS[cur]||{}).areas)||[]).length);
      lab.hidden=!pending;
      lab.textContent=areas.length?('Save labels ('+areas.length+')'):'Save labels';
    }
    const c=captureCamera();
    const o=c.orbit;
    $('authch').textContent='Chapter '+(cur+1)+' / '+CHAPTERS.length+
      (o?('  ·  '+o.h+'\u00b0 / '+o.p+'\u00b0 / '+o.r+' m'):'');
  }
  function authNote(t,bad){
    const el=$('authnote'); if(!el) return;
    el.textContent=t||''; el.style.color=bad?'#D9584A':'#7FB77E';
    clearTimeout(authNoteTimer);
    authNoteTimer=setTimeout(()=>{el.textContent='';},4000);
  }
  if(AUTHOR){
    // No splash. The console framed this to work in, not to present, and a
    // full-screen "Begin the walkthrough" overlay swallowing every click is a
    // strange thing for an editor to open with. go(0) has already framed
    // chapter one by the time this runs, so there is nothing to resume.
    const sp=$('intro'); if(sp) sp.style.display='none';
    addEventListener('message',e=>{
      const d=e.data;
      if(!d||d.source!=='orebody-console') return;
      if(d.type==='hello'){
        authOrigin=e.origin;
        $('authbar').hidden=false;
        authPaint();
        authSend({type:'ready', total:CHAPTERS.length,
                  titles:CHAPTERS.map(c=>c.title||'')});
        return;
      }
      if(e.origin!==authOrigin) return;
      if(d.type==='goto' && typeof d.ord==='number'){
        stop(); go(d.ord); authSend({type:'state', state:authSnapshot()});
      } else if(d.type==='transition' && typeof d.ord==='number'){
        authNote('Replaying\u2026');
        previewTransition(d.ord).then(r=>{
          authSend({type:'transition', result:r});
          authSend({type:'state', state:authSnapshot()});
          authNote(!r ? '' : r.late
            ? ('Geometry landed '+(r.depMs-r.camMs)+' ms after the camera')
            : ('Settled in '+(r.camMs/1000).toFixed(1)+' s'), !!(r&&r.late));
        });
      } else if(d.type==='poll'){
        authSend({type:'state', state:authSnapshot()});
      } else if(d.type==='saved'){
        authNote(d.ok?('Saved to chapter '+(d.ord+1)):'Save failed \u2014 see the console',!d.ok);
        // Patch the in-memory chapter to what was actually stored. Without
        // this, setting a view and then navigating away and back replays the
        // OLD shot — the author would watch their own save appear not to have
        // taken, and the obvious response is to save it again.
        if(d.ok && d.chapter && CHAPTERS[d.ord]){
          CHAPTERS[d.ord]=mapChapter(d.chapter);
          // Published labels stop being the presenter's local scribble and
          // become the slide's. Leaving them in both places draws each twice.
          if(d.ord===cur && d.what==='areas'){ areas.length=0; areaSave(); areaSelect(); }
          authPaint();
        }
      }
    });
    $('authset').onclick=()=>{ authSend({type:'set', what:'camera', state:authSnapshot()});
                               authNote('Saving\u2026'); };
    $('authall').onclick=()=>{ authSend({type:'set', what:'all', state:authSnapshot()});
                               authNote('Saving\u2026'); };
    // Labels are saved on their own rather than folded into "Set view +
    // layers". A camera and a set of switches are the shot; an annotation is a
    // claim about the ground, and publishing one to an audience should be a
    // thing somebody pressed rather than a side effect of framing a slide.
    $('authlab').onclick=()=>{
      authSend({type:'set', what:'areas', state:authSnapshot()});
      authNote('Saving\u2026'); };
    $('authplay').onclick=()=>{
      authNote('Replaying\u2026');
      previewTransition(cur).then(r=>{
        authSend({type:'transition', result:r});
        authNote(!r ? '' : r.late
          ? ('Geometry landed '+(r.depMs-r.camMs)+' ms after the camera')
          : ('Settled in '+(r.camMs/1000).toFixed(1)+' s'), !!(r&&r.late));
      }); };
    // On every rest, not only on a chapter change. A chapter change reports
    // immediately so the console can highlight the row, but the camera is
    // still in flight at that moment — reporting only then would have the
    // console's readout, and anything that trusts it, describing where the
    // camera was a second and a half ago.
    viewer.camera.moveEnd.addEventListener(()=>{
      authPaint(); authSend({type:'state', state:authSnapshot()}); });
    // Announce. No payload, so a page that frames this one without being the
    // console learns only that a viewer exists — which it already knew.
    const peer=authPeer();
    if(peer) peer.postMessage({source:'orebody-viewer',type:'hello'},'*');
  }

  window.__viewer=viewer;
  // A small, stable surface for automated checks and for anyone debugging a
  // customer's deck: what loaded, and how much of it.
  // Where the camera actually is, which for the hole view is the whole claim:
  // "underground" is not a mode flag, it is the camera sitting below the
  // terrain surface at its own position, and only the globe can answer that.
  const camProbe=()=>{
    const c=Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    const t=viewer.scene.globe.getHeight(c);
    return {h:Math.round(c.height),
            terrain:(t===undefined||t===null)?null:Math.round(t),
            under:(t===undefined||t===null)?null:(c.height<t),
            pitch:Math.round(DEG(viewer.camera.pitch)),
            heading:Math.round(DEG(viewer.camera.heading))};
  };
  window.__api={go:go,play:play,stop:stop,readout:readout,shoot:shoot,grab:grab,
    cam:camProbe,
    layers:()=>({cur:cur, title:CHAPTERS[cur]&&CHAPTERS[cur].title,
      blocks:blocksOn, geo:geoKey, surf:surfOn, plan:planOn, site:siteOn,
      depth:depthOn, ground:groundAlpha, drills:drills,
      holeView:!!holeView, hole:ledgerHole?ledgerHole.id:null,
      graph:!$('holegraph').hidden, rows:$('ledglist').children.length,
      ents:viewer.entities.values.length, focus:focusEnts?focusEnts.length:0,
      tRectDeg:Math.round(Cesium.Math.toDegrees(
        viewer.scene.globe.translucency.rectangle.east -
        viewer.scene.globe.translucency.rectangle.west)*1000)/1000,
      sun:!!(viewer.scene.sun&&viewer.scene.sun.show),
      ledgt:$('ledgt').textContent, cam:camProbe()}),
    titles:()=>CHAPTERS.map(c=>c.title),
    chapter:(n)=>CHAPTERS[n],
    capture:()=>({camera:captureCamera(), layers:captureLayers()}),
    transition:previewTransition,
    holders:()=>rollHolders(REAL_CLAIMS, CLAIMS_SUBJECT),
    provText:provText,
    // The same call hydrate() makes, so a check exercises the real path into
    // these overrides rather than reaching past it to set a variable.
    applyProject:(project)=>{ applyHolderLogos(project);
      if(siteEnts){ siteEnts.forEach(e=>viewer.entities.remove(e)); siteEnts=null; }
      showSite(siteOn); },
    // Rebuild the site layer from scratch — the only way to see the effect of
    // a changed override without a reload.
    rebuildSite:()=>{ if(siteEnts){ siteEnts.forEach(e=>viewer.entities.remove(e));
                      siteEnts=null; } showSite(siteOn); },
    holderCards:()=>({titles:CARD_LOG.map(c=>c.title), notes:CARD_LOG.map(c=>c.note||'')}),
    areas:()=>({auth:areasAuth.length, local:areas.length,
                stored:Object.keys(areasLocal).length, pts:areaPts.length, mode:areaMode,
                labels:areasAuth.concat(areas).map(a=>a.label)}),
    state:()=>({holes:HOLES.length, highlights:HIGHLIGHTS.length,
      claims:REAL_CLAIMS.length, uploadedSurfaces:UPLOADED_SURFACES.length,
      targets:TARGETS.length, geochem:GEOCHEM?GEOCHEM.points.length:0,
      surfPrims:surfPrims?surfPrims.length:0, surfOn:surfOn,
      blocks:N, exploration:EXPLORATION, deposit:depKey, proj:PROJ})};
})().catch(e=>{
  // Never leave the opaque boot overlay covering an error the user can't read.
  const l=$('load'); if(l) l.style.display='none';
  const s=$('status'); s.className='fatal';
  const msg=(e&&e.message)||String(e)||'unknown error';
  // BOOT_PHASE and the stack are the whole diagnosis when the throw happens
  // inside a minified vendor bundle. This used to print e.message alone, which
  // for a Cesium failure reads "null is not an object (evaluating 'v[0]')" —
  // naming a variable that exists in no file we ship, from a call site the
  // message does not identify. Discarding the stack made a five-minute bug
  // unfindable.
  s.textContent='Could not start during "'+BOOT_PHASE+'" — '+msg;
  try{
    console.error('Orebody boot failed during "'+BOOT_PHASE+'"');
    console.error(e);
    if(e&&e.stack) console.error(e.stack);
    reportFailure(msg, e&&e.stack);
  }catch(_){}
  // On screen as well as in the console: most people who hit this are on a
  // phone or in someone else's meeting and will never open devtools, and
  // "it didn't load" is not a bug report anyone can act on.
  try{
    const pre=document.createElement('pre');
    pre.id='bootstack';
    pre.textContent=diagnostics(msg+'\n\n'+((e&&e.stack)||'(no stack)'));
    document.body.appendChild(pre);
    // One tap beats retyping a stack off a phone.
    const btn=document.createElement('button');
    btn.textContent='Copy diagnostics';
    btn.style.cssText='position:fixed;right:14px;bottom:14px;z-index:100;'+
      'font:600 12px system-ui;padding:10px 14px;border-radius:5px;border:0;'+
      'background:#C99A3A;color:#07090A';
    btn.onclick=()=>navigator.clipboard?.writeText(pre.textContent);
    document.body.appendChild(btn);
  }catch(_){}
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
    "__N__": str(N), "__RAMPMAX__": f"{RAMPMAX}",
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
        "geophys_synthetic": GEOPHYS_SYNTHETIC,
        # Ag_ppm is zero across all 495,074 source blocks. A property of THIS
        # export, so it is a flag rather than a sentence the viewer always says.
        "silver_absent": True,
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
    "__REAL_CLAIMS__": js(REAL_CLAIMS),
    # Logos are supplied, never scraped. A company's mark is its trademark, and
    # inventing one for a neighbour would put a fake identity on a real map.
    # Absent, the viewer draws a monogram instead.
    "__HOLDER_LOGOS__": js({}),
    # Per-holder presentation the register cannot supply: whether to feature a
    # neighbour at all, and any line the author wants on its card.
    "__HOLDER_META__": js({}),
    "__BRAND__": js({}),
    "__CLAIMS_ATTRIB__": js(CLAIMS_ATTRIB),
    "__CLAIMS_SUBJECT__": js(CLAIMS_SUBJECT),
    "__DRILL_SYNTHETIC__": "true" if DRILL_SYNTHETIC else "false",
    "__STATIONS__": js(STATIONS),
    "__DEPOSITS__": js(DEPOSITS),
    "__GEOPHYS__": js(GEOPHYS),
    "__GEOPHYS_SYNTHETIC__": "true" if GEOPHYS_SYNTHETIC else "false",
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
// What this cache must NOT touch.
//
// The worker is registered at the site root, so its scope is everything —
// including the authoring console at /dashboard/ and every API call the console
// makes. Cache-first over that scope is actively harmful: the console would
// serve users the JavaScript from whichever deploy they first visited, forever,
// and authenticated Supabase GETs would be stored and replayed as though the
// data had never changed. Tiles are the only thing here worth caching
// aggressively, so everything else is passed straight to the network.
function bypass(r){
  const u=new URL(r.url);
  if(u.origin===location.origin && u.pathname.startsWith('/dashboard/')) return true;
  // Supabase (or any) API surface — data, auth and edge functions.
  if(/\/(rest|auth|functions|storage)\/v\d/.test(u.pathname)) return true;
  // Anything carrying credentials is per-user and must never be shared.
  if(r.headers.get('authorization')||r.headers.get('apikey')) return true;
  return false;
}
self.addEventListener('fetch',e=>{
  const r=e.request;
  if(r.method!=='GET') return;
  if(bypass(r)) return;
  // The DOCUMENT is network-first. Everything else here can be cache-first
  // because it is immutable per build, but the page itself is the build, and
  // cache-first on it meant a returning visitor ran the previous deploy until
  // the new worker had activated AND they had loaded again — two reloads to
  // see a fix, with no way to tell which one you were looking at. On a tool
  // that quotes tonnage that is not a caching strategy, it is a correctness
  // bug. Offline still works: the cached copy is the fallback, not the
  // default.
  if(r.mode==='navigate'||(r.destination==='document')){
    e.respondWith(
      fetch(r).then(res=>{
        if(res&&res.status===200&&res.type!=='opaque'){
          const copy=res.clone();
          caches.open(CACHE).then(c=>c.put(r,copy)).catch(()=>{});
        }
        return res;
      }).catch(()=>caches.match(r).then(hit=>hit||caches.match('index.html'))));
    return;
  }
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
