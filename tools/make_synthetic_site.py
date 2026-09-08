#!/usr/bin/env python3
"""Bedrock — SYNTHETIC site-features generator.

============================ READ THIS FIRST ============================
EVERYTHING THIS SCRIPT PRODUCES IS FABRICATED: the claim boundary, the pit
outline, the waste dump, the heap leach pad, the haul road and every map
label. None of it reflects any real permit, tenure, mine plan or facility at
Bedrock Demo. It exists so the map-annotation and infrastructure layers can be
built and demonstrated before real survey data is supplied.

Fabricated infrastructure is MORE dangerous than fabricated assays, because a
pit outline on a real mountain reads as a real mine plan to anyone glancing at
it. Same guard rails as the drill generator, and do not weaken them:
  - every feature id is prefixed  SYN-
  - the filename is prefixed  SYNTHETIC_
  - every feature carries data_source = SYNTHETIC_FABRICATED_NOT_REAL
  - manifest synthetic:true drives a permanent on-screen warning
=========================================================================

Geometry is derived from the real block model's footprint so the shapes sit
plausibly on the ground, but the shapes themselves are invented.

Usage:  python3 tools/make_synthetic_site.py
"""
import csv, json, math, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "demo_blocks_v2.csv"
OUT = ROOT / "data" / "synthetic" / "SYNTHETIC_site_features.json"
TAINT = "SYNTHETIC_FABRICATED_NOT_REAL"
SEED = 20211130
rng = random.Random(SEED)


def footprint():
    xs, ys, zs = [], [], []
    for r in csv.DictReader(open(SRC, newline="")):
        xs.append(float(r["x"])); ys.append(float(r["y"])); zs.append(float(r["z"]))
    return min(xs), max(xs), min(ys), max(ys), min(zs), max(zs)


def ring(cx, cy, rx, ry, n=28, jitter=0.06, rot=0.0):
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        j = 1 + rng.uniform(-jitter, jitter)
        px = rx * math.cos(a) * j
        py = ry * math.sin(a) * j
        pts.append([round(cx + px * math.cos(rot) - py * math.sin(rot), 1),
                    round(cy + px * math.sin(rot) + py * math.cos(rot), 1)])
    pts.append(pts[0])
    return pts


def main():
    if not SRC.exists():
        sys.exit(f"missing {SRC} — run tools/extract_blocks.py first")
    x0, x1, y0, y1, z0, z1 = footprint()
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w, h = x1 - x0, y1 - y0

    # The mine sits on the SOUTH ZONE, not on the deposit this file's footprint
    # describes. That is deliberate and it is the whole reason the two deposits
    # differ. The North Zone is 22 vein sheets a metre or two thick spread over
    # a kilometre and a half: a block there averages a tenth ore and nine
    # tenths waste, so bulk-mining it means moving a gigatonne to recover
    # three megatonnes — a strip ratio in the hundreds to one. It is an
    # underground target. The South Zone is the bulk-tonnage body near surface,
    # and it is the one a shovel can work. Put the pit where the pit belongs.
    SX, SY = 269950.0, 5830650.0        # South Zone metal centroid
    # 300 m, DOWN FROM 480. The old radius put the rim across 290 m of
    # hillside; crested at its highest point, which is what the renderer does,
    # the downhill third of the shell hung in the air and the pit read as a
    # mound. At 300 m the rim spans 155 m and the shell sits in the hill.
    #
    # Against the sampled ground (data/synthetic/pit_site_dem.json) a 300 m
    # shell 240 m deep moves 36.5 Mt to recover 15.7 Mt at 2.49 g/t — a strip
    # ratio of 1.33 : 1. Those four numbers come from tools/size_pit.py and
    # are the ones the deck prints; re-run it rather than editing them here.
    PIT_R = 300.0

    feats = {
        "synthetic": True,
        "warning": "FABRICATED site features — not a real mine plan, tenure or permit.",
        "generator": "tools/make_synthetic_site.py",
        "crs": "EPSG:26910 (UTM 10N, NAD83)",
        "data_source": TAINT,
        # Claim block: a generous polygon around the deposit.
        "claims": [{
            "id": "SYN-CLAIM-01", "name": "Bedrock Demo claim block (synthetic)",
            "data_source": TAINT,
            "ring": ring(cx, (cy + SY) / 2, w * 1.75,
                         (abs(cy - SY) + h + 1400) / 2, n=14, jitter=0.12),
        }],
        # Surface infrastructure, sitting on terrain.
        "areas": [
            {"id": "SYN-PIT-01", "name": "South Zone pit (conceptual)",
             "kind": "pit", "color": "#B9C2C9", "data_source": TAINT,
             "ring": ring(SX, SY, PIT_R, PIT_R * 0.88, jitter=0.09)},
            {"id": "SYN-WRSF-01", "name": "Waste rock facility (conceptual)",
             "kind": "dump", "color": "#8E9AA3", "data_source": TAINT,
             "ring": ring(SX + 900, SY - 300, 230, 190, jitter=0.12)},
            {"id": "SYN-HL-01", "name": "Heap leach pad (conceptual)",
             "kind": "pad", "color": "#C9B98A", "data_source": TAINT,
             "ring": ring(SX - 870, SY - 390, 200, 165, jitter=0.10)},
        ],
        # Haul road: a polyline wandering between the pit and the facilities.
        "roads": [{
            "id": "SYN-ROAD-01", "name": "Haul road (conceptual)",
            "data_source": TAINT,
            "path": [[round(SX - 1000 + 2000 * (i / 12), 1),
                      round(SY - 450 + 320 * math.sin(i / 12 * math.pi * 0.9)
                            + rng.uniform(-40, 40), 1)]
                     for i in range(13)],
        }],
        # Conceptual pit stages, for the mine-plan timeline. Each stage is a
        # larger, deeper shell than the last. Entirely invented.
        "stages": [
            {"id": f"SYN-STAGE-{i}", "name": nm, "year": yr, "data_source": TAINT,
             "depth": dep,
             "ring": ring(SX, SY, PIT_R * (0.42 + 0.19 * i),
                          PIT_R * 0.88 * (0.42 + 0.19 * i), jitter=0.07)}
            for i, (nm, yr, dep) in enumerate([
                ("Starter pit", "Year 1", 60),
                ("Stage 2", "Year 3", 120),
                ("Stage 3", "Year 5", 180),
                ("Final pit", "Year 8", 240)])
        ],
        # Point labels with leader lines.
        "labels": [
            {"id": "SYN-LBL-01", "name": "South Zone Deposit",
             "at": [round(SX, 1), round(SY, 1)], "dz": 230, "data_source": TAINT},
            {"id": "SYN-LBL-02", "name": "Waste Rock Facility",
             "at": [round(SX + 900, 1), round(SY - 300, 1)], "dz": 150, "data_source": TAINT},
            {"id": "SYN-LBL-03", "name": "Heap Leach Pad",
             "at": [round(SX - 870, 1), round(SY - 390, 1)], "dz": 150, "data_source": TAINT},
            {"id": "SYN-LBL-04", "name": "Haul Road",
             "at": [round(cx + w * 0.10, 1), round(cy - h * 0.06, 1)], "dz": 170, "data_source": TAINT},
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(feats, indent=2))
    print(f"SYNTHETIC site features -> {OUT.relative_to(ROOT)}")
    print(f"  {len(feats['claims'])} claim block, {len(feats['areas'])} areas, "
          f"{len(feats['roads'])} roads, {len(feats['labels'])} labels")
    print("  REMINDER: fabricated. This is NOT a mine plan, tenure or permit.")


if __name__ == "__main__":
    main()
