#!/usr/bin/env python3
"""Bedrock — size the FABRICATED demo pit against the real ground under it.

    node tools/sample_pit_dem.mjs            # once, writes the DEM
    BEDROCK_DUMP_ROWS=/tmp/sz_rows.csv python3 tools/make_synthetic_deposit.py
    python3 tools/size_pit.py [--search] [/tmp/sz_rows.csv]

WHY THIS EXISTS
---------------
The pit's depth, the rock it moves and its strip ratio were computed by hand,
once, against a terrain sample that was never written down — and then typed
into three files as literals. Change the pit and those numbers do not follow;
they just quietly become false, on a slide captioned as a measurement.

Worse, the pit as sized stood across 240 m of hillside relief. Crested at the
highest point on its own rim, which is what the renderer does, the downhill
third of the shell hangs in mid-air: it reads as a stepped mound sitting ON
the mountain rather than a hole cut INTO it.

So this measures instead. Given the sampled ground and the block centroids the
deposit generator emits, it reports, for a candidate pit, the relief it spans,
the rock it moves, the ore it captures and the resulting strip ratio. Every
number the deck prints about the pit should come from here.

THE SHELL
---------
Matches what build_present.py draws: an ellipse R x 0.88R at the rim, crested
8 m below the HIGHEST ground on that rim, narrowing linearly to (1 - taper) of
its radius at the floor. Sizing uses a smooth ellipse where the renderer uses
the jittered ring from the site file; the difference is a few percent of area
and none of the conclusion.
"""
import csv, json, math, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEM = json.loads((ROOT / "data/synthetic/pit_site_dem.json").read_text())
ROWS = Path(sys.argv[-1]) if sys.argv[-1].endswith(".csv") else Path("/tmp/sz_rows.csv")

CE, CN = DEM["centre"]
STEP, HALF = DEM["step_m"], DEM["half_m"]
CELL = STEP * STEP
# offsets -> height, on the lattice the sampler wrote.
G = {(int(de), int(dn)): h
     for (de, dn), h in zip(DEM["offsets"], DEM["heights"]) if h is not None}

def ground(de, dn):
    return G.get((int(round(de / STEP)) * STEP, int(round(dn / STEP)) * STEP))

BLOCKS = []
with open(ROWS) as fh:
    for r in csv.DictReader(fh):
        BLOCKS.append((float(r["x"]) - CE, float(r["y"]) - CN, float(r["z"]),
                       float(r["grade"]), float(r["penv"])))
T_PER_BLOCK = 12.0 * 12.0 * 8.0 * 2.68
G_PER_OZ = 31.10348
ROCK_T_PER_M3 = 2.68


def evaluate(dE, dN, R, depth, taper=0.82, ry=0.88):
    """One candidate pit. Returns everything the deck would want to say."""
    a, b = R, R * ry
    # Rim relief, sampled around the ellipse the renderer draws.
    rim = []
    for i in range(72):
        th = i / 72 * 2 * math.pi
        h = ground(dE + a * math.cos(th), dN + b * math.sin(th))
        if h is not None:
            rim.append(h)
    if not rim:
        return None
    crest = max(rim) - 8.0
    floor_z = crest - depth

    def shell_z(de, dn):
        """Elevation of the pit wall under a point, or None if outside the rim."""
        u = (de - dE) / a, (dn - dN) / b
        k = math.hypot(*u)
        if k > 1.0:
            return None
        return max(floor_z, crest - (1 - k) * depth / taper)

    moved_m3 = 0.0
    daylight = 0            # cells where the shell actually breaks surface
    for (de, dn), h in G.items():
        z = shell_z(de, dn)
        if z is None:
            continue
        if h > z:
            moved_m3 += (h - z) * CELL
            daylight += 1

    ore_t = ore_metal = 0.0
    for de, dn, z, grade, penv in BLOCKS:
        sz = shell_z(de, dn)
        if sz is None or z < sz:
            continue
        g = ground(de, dn)
        if g is None or z > g:            # a block above the hillside is not there
            continue
        t = T_PER_BLOCK * penv
        ore_t += t
        ore_metal += t * grade
    moved_t = moved_m3 * ROCK_T_PER_M3
    waste_t = max(0.0, moved_t - ore_t)
    return {
        "R": R, "depth": depth, "crest": crest, "floor": floor_z,
        "rim_relief": max(rim) - min(rim),
        "moved_mt": moved_t / 1e6, "ore_mt": ore_t / 1e6,
        "grade": (ore_metal / ore_t) if ore_t else 0.0,
        "oz": (ore_metal / G_PER_OZ) if ore_t else 0.0,
        "strip": (waste_t / ore_t) if ore_t else float("inf"),
        "daylight_ha": daylight * CELL / 1e4,
    }


def show(tag, r):
    if not r:
        print(f"{tag:>22}  — no ground sampled")
        return
    print(f"{tag:>22}  R{r['R']:>4.0f} m  deep {r['depth']:>3.0f} m  "
          f"rim relief {r['rim_relief']:>5.1f} m  "
          f"crest {r['crest']:.0f}->{r['floor']:.0f}  "
          f"moved {r['moved_mt']:>6.1f} Mt  ore {r['ore_mt']:>5.2f} Mt "
          f"@ {r['grade']:.2f} g/t  strip {r['strip']:>5.2f}:1")


if "--search" in sys.argv:
    # The body sits at 269698-270238 E, 5830410-5830878 N, 1278-1470 m. A pit
    # has to reach it, span ground flat enough to read as an excavation, and
    # move a defensible amount of rock. Those pull against each other, so look
    # at the trade rather than asserting one answer.
    print("== current ==")
    show("as shipped", evaluate(0, 0, 532, 384))
    print("\n== smaller, same centre ==")
    for R in (240, 280, 300, 340, 380):
        for depth in (140, 180, 220, 260):
            show(f"R{R}/d{depth}", evaluate(0, 0, R, depth))
    print("\n== smaller, hunting flatter ground within 400 m ==")
    best = []
    for dE in range(-400, 401, 50):
        for dN in range(-400, 401, 50):
            r = evaluate(dE, dN, 300, 200)
            if r:
                best.append((r["rim_relief"], dE, dN, r))
    best.sort(key=lambda x: x[0])
    for relief, dE, dN, r in best[:8]:
        show(f"E{dE:+d} N{dN:+d}", r)
else:
    # The shipped pit, and the file the deck reads its captions from. Writing
    # it is the whole point: a slide that prints a strip ratio should print
    # THIS strip ratio, not one somebody typed in when the pit was a different
    # size. tools/build_present.py fails loudly if this file is missing.
    R = float(sys.argv[1]) if len(sys.argv) > 2 else 300.0
    depth = float(sys.argv[2]) if len(sys.argv) > 2 else 240.0
    r = evaluate(0, 0, R, depth)
    show("pit", r)
    out = ROOT / "data/synthetic/pit_measured.json"
    r["note"] = ("Measured by tools/size_pit.py against real Cesium terrain "
                 "(data/synthetic/pit_site_dem.json) and the FABRICATED South "
                 "Zone block centroids. The pit is conceptual; the arithmetic "
                 "about it is not invented.")
    r["generator"] = "tools/size_pit.py"
    out.write_text(json.dumps(r, indent=2))
    print(f"  -> {out.relative_to(ROOT)}")
