#!/usr/bin/env python3
"""Generate a FABRICATED second deposit, sited inside the real Elk Gold tenures.

    python3 tools/make_synthetic_deposit.py [n_blocks]

Writes data/synthetic/SYNTHETIC_nicola_south.{bin,buckets.json,json}

WHAT THIS IS
------------
An invented orebody. There is no Nicola South deposit. No drilling, no
sampling, no resource — the grades below come from a random number generator
seeded with a date, shaped into a body by a few ellipsoids.

It exists to make the multi-deposit path real: the viewer holds one model at a
time, and until there was a second model there was nothing to switch to. The
tenure it sits in IS real (516750, Elk Gold Mining Corp, ~2.5 km south of
Siwash North), because putting a fabricated deposit on fabricated ground would
have tested nothing about how the two coexist.

That is also the risk. A fabricated deposit drawn on a real claim, next to a
real deposit, at a believable grade, is the most misleading artifact in this
repository. It is why:

  * every filename carries SYNTHETIC_
  * the manifest sets synthetic:true and data_source:"SYNTHETIC"
  * the viewer's BLOCKS_SYNTHETIC flag fires from that manifest, and joins all
    five labelling paths — the banner, the export burn-in, the export footer,
    the audit report and the embed disclosure
  * the deposit switcher tags it in the control itself, so it cannot be chosen
    without reading the word

Do not remove any of those to make a screenshot look cleaner.

WHY IT IS DELIBERATELY UNLIKE SIWASH NORTH
------------------------------------------
Siwash North is 46 narrow high-grade vein domains: 9.0 Mt @ 3.80 g/t. This is
a bulk-tonnage disseminated body on a coarser lattice — more tonnes, a third
of the grade, a handful of broad zones. Two deposits of the same shape would
have proved nothing; the coarser block size in particular exercises the
viewer's stats.block_dims path, which was hard-coded to Siwash North's
10 x 5 x 5 m until the hydration work.

FORMAT
------
The block model is written as OREB v1 — byte for byte what
dashboard/lib/extract.js pack() produces and ingest.js uploads. The viewer
therefore loads this second deposit through the exact code path a customer's
own upload takes, rather than through a private back door that could rot
without anyone noticing.
"""
import json, math, random, struct, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "data" / "synthetic"
NAME = "nicola_south"
SEED = 20260807

# Inside real tenure 516750 (E 690540-695019, N 5520672-5524075), clear of the
# Siwash North model (N 5524922-5526308) by roughly 850 m at the closest point.
CE, CN = 692800.0, 5522400.0
CZ = 1180.0                     # m, roughly the local ridge elevation
DX, DY, DZ = 12.0, 12.0, 8.0    # coarser than Siwash North, on purpose
DENSITY = 2.68
TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 34000

random.seed(SEED)

# Broad zones rather than sheeted veins: centre, semi-axes, strike, grade core.
# The two smaller bodies are richer, so raising the cut-off leaves something
# behind rather than emptying the screen.
ZONES = [
    {"name": "NS Main",   "c": (0, 0, -60),      "r": (340, 230, 165), "g": 0.97, "az": 32},
    {"name": "NS North",  "c": (90, 330, -30),   "r": (225, 195, 120), "g": 1.33, "az": 20},
    {"name": "NS South",  "c": (-130, -350, -95), "r": (250, 180, 140), "g": 0.83, "az": 44},
    {"name": "NS Deep",   "c": (45, -60, -260),  "r": (180, 145, 130), "g": 1.66, "az": 32},
    {"name": "NS West",   "c": (-300, 90, -70),  "r": (165, 225, 105), "g": 0.65, "az": 10},
    {"name": "NS Halo",   "c": (0, 0, -90),      "r": (470, 380, 230), "g": 0.40, "az": 32},
]
VEINS = [z["name"] for z in ZONES]


def zone_strength(z, dx, dy, dz):
    """Normalised distance inside a rotated ellipsoid; 1 at the centre, 0 at the
    rim. Rotation is about vertical only — dip is carried by the z semi-axis."""
    a = math.radians(z["az"])
    rx = dx * math.cos(a) + dy * math.sin(a)
    ry = -dx * math.sin(a) + dy * math.cos(a)
    q = (rx / z["r"][0]) ** 2 + (ry / z["r"][1]) ** 2 + (dz / z["r"][2]) ** 2
    return max(0.0, 1.0 - math.sqrt(q))


rows = []
# Walk the lattice over the union of the zones' reach and keep whatever carries
# grade, rather than sampling blindly and hoping for a body.
#
# The threshold is the viewer's GRADE_FLOOR, not something lower. Anything
# beneath it is neither drawn nor counted anywhere in the tool, so generating it
# would only inflate the file with blocks that can never appear.
FLOOR = 0.50
HALF_E, HALF_N, TOP, BOT = 560, 500, 60, -520
ei = int(HALF_E / DX); ni = int(HALF_N / DY)
for gx in range(-ei, ei + 1):
    for gy in range(-ni, ni + 1):
        for gz in range(int(BOT / DZ), int(TOP / DZ) + 1):
            dx, dy, dz = gx * DX, gy * DY, gz * DZ
            best, bestz = 0.0, None
            grade = 0.0
            for z in ZONES:
                s = zone_strength(z, dx, dy, dz)
                if s <= 0:
                    continue
                # Grade falls off from each zone's core, plus lognormal noise —
                # a smooth ellipsoid reads as a CAD object, not an orebody.
                contrib = z["g"] * (s ** 1.5) * math.exp(random.gauss(0, 0.55))
                grade += contrib
                if s > best:
                    best, bestz = s, z
            if bestz is None or grade < FLOOR:
                continue
            # Ore fraction: interior blocks are whole, rim blocks partial.
            penv = min(1.0, 0.35 + best * 1.3)
            # Confidence falls with depth and distance from the main zone,
            # exactly as drilling density would. Measured is the SMALLEST
            # category, as it is in a real resource — the first cut of this had
            # 98% Measured, which is the shape of a model nobody would believe.
            d2 = math.hypot(dx, dy)
            cls = 1 if (d2 < 85 and dz > -85) else (2 if (d2 < 205 and dz > -195) else 3)
            rows.append((CE + dx, CN + dy, CZ + dz, round(grade, 4),
                         round(penv, 4), cls, VEINS.index(bestz["name"])))

# Thin to the target count deterministically, keeping the body's shape.
if len(rows) > TARGET:
    step = len(rows) / TARGET
    rows = [rows[int(i * step)] for i in range(TARGET)]

if not rows:
    raise SystemExit("no blocks generated — check the zone geometry")

BLOCK_M3 = DX * DY * DZ
T_PER_BLOCK = BLOCK_M3 * DENSITY
G_PER_OZ = 31.10348
LADDER = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0, 50.0]


def binof(g):
    b = 0
    while b + 1 < len(LADDER) and LADDER[b + 1] <= g:
        b += 1
    return b


def roll(e):
    return {"blocks": e[0], "tonnes": round(e[1], 1),
            "grade_gt": round(e[2] / e[1], 3) if e[1] else 0,
            "oz": round(e[2] / G_PER_OZ)}


total = [0, 0.0, 0.0]
per_class, per_vein, per_bucket, per_cb = {}, {}, {}, {}


def bump(d, k, n, t, m):
    e = d.setdefault(k, [0, 0.0, 0.0])
    e[0] += n; e[1] += t; e[2] += m


for x, y, z, g, penv, cls, vein in rows:
    t = T_PER_BLOCK * penv
    m = t * g
    b = binof(g)
    total[0] += 1; total[1] += t; total[2] += m
    bump(per_class, cls, 1, t, m)
    bump(per_vein, VEINS[vein], 1, t, m)
    # Single-domain blocks here: nothing straddles, so the share-weighted table
    # and the whole-block table agree by construction. Marked share_weighted so
    # the viewer's guard passes honestly — each block's share of its one domain
    # is 1.0, which is a share-weighted table with a trivial weighting.
    bump(per_bucket, (vein, cls, b), 1, t, m)
    bump(per_cb, (cls, b), 1, t, m)

stats = {
    "scanned_rows": len(rows),
    "block_m3": BLOCK_M3,
    "block_dims": [DX, DY, DZ],
    "density": DENSITY,
    "tonnes_per_block": T_PER_BLOCK,
    "veins": VEINS,
    "share_weighted": True,
    "dropped_blocks": 0,
    "below_cutoff": 0,
    "blocks_straddling_multiple_domains": 0,
    "bounds": {"x": [min(r[0] for r in rows), max(r[0] for r in rows)],
               "y": [min(r[1] for r in rows), max(r[1] for r in rows)],
               "z": [min(r[2] for r in rows), max(r[2] for r in rows)]},
    "total": roll(total),
    "by_class": {str(k): roll(v) for k, v in sorted(per_class.items())},
    "by_vein": {k: roll(v) for k, v in
                sorted(per_vein.items(), key=lambda kv: -kv[1][1])},
}

buckets = {
    "ladder": LADDER,
    "share_weighted": True,
    "buckets": [{"v": v, "c": c, "b": b, "n": e[0],
                 "t": round(e[1], 1), "m": round(e[2], 1)}
                for (v, c, b), e in sorted(per_bucket.items())],
    "by_cb": [{"c": c, "b": b, "n": e[0], "t": round(e[1], 1), "m": round(e[2], 1)}
              for (c, b), e in sorted(per_cb.items())],
}


def pack(rows):
    """OREB v1 — the same layout dashboard/lib/extract.js pack() writes.

    Positions are stored relative to the model origin because a UTM easting
    near 700000 spends most of a float32's precision on the leading digits and
    the offsets do not. Struct-of-arrays, not interleaved: the viewer filters on
    grade constantly and touches positions rarely.
    """
    ox = min(r[0] for r in rows); oy = min(r[1] for r in rows); oz = min(r[2] for r in rows)
    cols = [
        ("x", "Float32Array", 4, [r[0] - ox for r in rows]),
        ("y", "Float32Array", 4, [r[1] - oy for r in rows]),
        ("z", "Float32Array", 4, [r[2] - oz for r in rows]),
        ("g", "Float32Array", 4, [r[3] for r in rows]),
        ("p", "Float32Array", 4, [r[4] for r in rows]),
        ("c", "Uint8Array", 1, [r[5] for r in rows]),
        ("v", "Uint16Array", 2, [r[6] for r in rows]),
    ]
    layout, off = [], 0
    for name, typ, align, arr in cols:
        if off % align:
            off += align - (off % align)
        layout.append({"name": name, "type": typ, "offset": off, "count": len(arr)})
        off += len(arr) * align
    header = json.dumps({"format": "orebody-blocks/1", "n": len(rows),
                         "origin": [ox, oy, oz], "arrays": layout},
                        separators=(",", ":")).encode()
    hlen = len(header)
    pad = (16 - ((16 + hlen) % 16)) % 16
    base = 16 + hlen + pad
    buf = bytearray(base + off)
    struct.pack_into(">I", buf, 0, 0x4F524542)          # "OREB", big-endian
    struct.pack_into("<I", buf, 4, 1)                   # version
    struct.pack_into("<I", buf, 8, hlen)
    struct.pack_into("<I", buf, 12, base)
    buf[16:16 + hlen] = header
    fmt = {"Float32Array": "<f", "Uint8Array": "<B", "Uint16Array": "<H"}
    for (name, typ, align, arr), lay in zip(cols, layout):
        p = base + lay["offset"]
        f = fmt[typ]
        for v in arr:
            struct.pack_into(f, buf, p, v if typ != "Float32Array" else float(v))
            p += align
    return bytes(buf), [ox, oy, oz]


OUTDIR.mkdir(parents=True, exist_ok=True)
blob, origin = pack(rows)
(OUTDIR / f"SYNTHETIC_{NAME}.bin").write_bytes(blob)
(OUTDIR / f"SYNTHETIC_{NAME}_buckets.json").write_text(json.dumps(buckets))
(OUTDIR / f"SYNTHETIC_{NAME}.json").write_text(json.dumps({
    "synthetic": True,
    "data_source": "SYNTHETIC",
    "warning": "FABRICATED DEPOSIT — Nicola South does not exist. No drilling, "
               "no sampling, no resource. Every tonne and gram below was "
               "generated by tools/make_synthetic_deposit.py. It is sited in a "
               "real mineral tenure (516750) so the multi-deposit view could be "
               "built and tested; that does not make any of it real.",
    "generator": "tools/make_synthetic_deposit.py",
    "seed": SEED,
    "name": "Nicola South",
    "tenure_context": "Sited within real BC tenure 516750 (Elk Gold Mining Corp)",
    "crs": "EPSG:26910",
    "format": "orebody-blocks/1",
    "origin": origin,
    "blocks_file": f"SYNTHETIC_{NAME}.bin",
    "buckets_file": f"SYNTHETIC_{NAME}_buckets.json",
    "stats": stats,
}, indent=2))

t = stats["total"]
print(f"FABRICATED deposit 'Nicola South'")
print(f"  {t['blocks']:,} blocks on a {DX:g} x {DY:g} x {DZ:g} m lattice "
      f"@ {DENSITY} t/m3 ({T_PER_BLOCK:,.0f} t/block)")
print(f"  {t['tonnes']:,.0f} t @ {t['grade_gt']} g/t = {t['oz']:,} oz")
print(f"  {len(VEINS)} zones, classes " +
      ", ".join(f"{k}:{v['blocks']:,}" for k, v in stats["by_class"].items()))
print(f"  centre E {CE:.0f} N {CN:.0f}, {len(blob)/1e6:.2f} MB OREB v1")
