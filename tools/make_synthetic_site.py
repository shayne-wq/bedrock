#!/usr/bin/env python3
"""Orebody — SYNTHETIC site-features generator.

============================ READ THIS FIRST ============================
EVERYTHING THIS SCRIPT PRODUCES IS FABRICATED: the claim boundary, the pit
outline, the waste dump, the heap leach pad, the haul road and every map
label. None of it reflects any real permit, tenure, mine plan or facility at
Elk Gold. It exists so the map-annotation and infrastructure layers can be
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
SRC = ROOT / "data" / "elk_blocks_v2.csv"
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

    feats = {
        "synthetic": True,
        "warning": "FABRICATED site features — not a real mine plan, tenure or permit.",
        "generator": "tools/make_synthetic_site.py",
        "crs": "EPSG:26910 (UTM 10N, NAD83)",
        "data_source": TAINT,
        # Claim block: a generous polygon around the deposit.
        "claims": [{
            "id": "SYN-CLAIM-01", "name": "Elk Gold claim block (synthetic)",
            "data_source": TAINT,
            "ring": ring(cx, cy, w * 1.55, h * 1.45, n=14, jitter=0.14),
        }],
        # Surface infrastructure, sitting on terrain.
        "areas": [
            {"id": "SYN-PIT-01", "name": "Siwash North pit (conceptual)",
             "kind": "pit", "color": "#B9C2C9", "data_source": TAINT,
             "ring": ring(cx - w * 0.06, cy + h * 0.05, w * 0.30, h * 0.24, jitter=0.09)},
            {"id": "SYN-WRSF-01", "name": "Waste rock facility (conceptual)",
             "kind": "dump", "color": "#8E9AA3", "data_source": TAINT,
             "ring": ring(cx + w * 0.72, cy - h * 0.34, w * 0.24, h * 0.20, jitter=0.12)},
            {"id": "SYN-HL-01", "name": "Heap leach pad (conceptual)",
             "kind": "pad", "color": "#C9B98A", "data_source": TAINT,
             "ring": ring(cx - w * 0.78, cy - h * 0.46, w * 0.21, h * 0.17, jitter=0.10)},
        ],
        # Haul road: a polyline wandering between the pit and the facilities.
        "roads": [{
            "id": "SYN-ROAD-01", "name": "Haul road (conceptual)",
            "data_source": TAINT,
            "path": [[round(cx - w * 0.72 + w * 1.5 * (i / 12), 1),
                      round(cy - h * 0.40 + h * 0.62 * math.sin(i / 12 * math.pi * 0.9)
                            + rng.uniform(-h * 0.03, h * 0.03), 1)]
                     for i in range(13)],
        }],
        # Point labels with leader lines.
        "labels": [
            {"id": "SYN-LBL-01", "name": "Siwash North Deposit",
             "at": [round(cx, 1), round(cy, 1)], "dz": 340, "data_source": TAINT},
            {"id": "SYN-LBL-02", "name": "Waste Rock Facility",
             "at": [round(cx + w * 0.72, 1), round(cy - h * 0.34, 1)], "dz": 210, "data_source": TAINT},
            {"id": "SYN-LBL-03", "name": "Heap Leach Pad",
             "at": [round(cx - w * 0.78, 1), round(cy - h * 0.46, 1)], "dz": 210, "data_source": TAINT},
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
