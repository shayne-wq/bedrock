#!/usr/bin/env python3
"""Orebody — block-model extractor (v2).

Reads the native MineSight export and emits the two files the viewer needs:

  data/elk_blocks_v2.csv   x,y,z,aueq,penv,cls,vein   (one row per mineralized block)
  data/elk_stats.json      exact grade-tonnage rollups, per vein and per class

v1 carried only AuEq and Percent_Env — two columns out of ~280. This also carries
the block's **resource classification** and its **vein domain**, which is what
makes vein isolation and class colouring possible downstream.

Tonnage is real, not a proxy: blocks are 10 x 5 x 5 m on a uniform 2.7 t/m3
density, so a whole block is 675 t and a block's ore tonnage is 675 * Percent_Env.
Stats are computed over EVERY mineralized block here, at build time — the viewer
may decimate what it draws, but the numbers it reports stay exact.

Usage:  python3 tools/extract_blocks.py [path/to/source.csv]
"""
import csv, json, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "Siwash_North_BM_Nov_2021.csv"
OUT_CSV = ROOT / "data" / "elk_blocks_v2.csv"
OUT_JSON = ROOT / "data" / "elk_stats.json"

# Block geometry + density, read off the source grid (x steps 10 m, y/z 5 m) and
# the FixedDensity column (uniform 2.7 across all 495,074 blocks).
BLOCK_M3 = 10.0 * 5.0 * 5.0
DENSITY = 2.7
TONNES_PER_BLOCK = BLOCK_M3 * DENSITY          # 675 t
G_PER_TROY_OZ = 31.10348

# MineSight classification codes. 0 = unclassified/waste.
# NOTE: the 1/2/3 -> Measured/Indicated/Inferred mapping follows the usual
# MineSight convention but has NOT been confirmed against the Nov-2021 NI 43-101.
# The block counts (86k / 125k / 1.2k) are an odd shape for a normal resource —
# an Inferred category that small is unusual — so treat these labels as
# provisional until someone checks them against the technical report.
CLASS_LABELS = {0: "Unclassified", 1: "Measured", 2: "Indicated", 3: "Inferred"}
CLASS_CONFIRMED = False


def main():
    if not SRC.exists():
        sys.exit(f"source block model not found: {SRC}")

    with open(SRC, newline="") as f:
        hdr = next(csv.reader(f))
    col = {n: i for i, n in enumerate(hdr)}
    for required in ("x", "y", "z", "AuEq", "Percent_Env", "Classification", "Type"):
        if required not in col:
            sys.exit(f"source is missing expected column: {required}")

    # Vein domains are declared by the per-vein Percent_<VEIN> columns.
    veins = sorted(n.split("Percent_", 1)[1] for n in hdr
                   if n.startswith("Percent_") and n != "Percent_Env")
    vein_id = {v: i for i, v in enumerate(veins)}

    ix, iy, iz = col["x"], col["y"], col["z"]
    ig, ip, ic, it = col["AuEq"], col["Percent_Env"], col["Classification"], col["Type"]

    per_vein = defaultdict(lambda: {"blocks": 0, "tonnes": 0.0, "metal_g": 0.0})
    per_class = defaultdict(lambda: {"blocks": 0, "tonnes": 0.0, "metal_g": 0.0})
    total = {"blocks": 0, "tonnes": 0.0, "metal_g": 0.0}
    type_mismatch = 0
    scanned = 0

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(SRC, newline="") as f, open(OUT_CSV, "w", newline="") as out:
        f.readline()
        w = csv.writer(out)
        w.writerow(["x", "y", "z", "aueq", "penv", "cls", "vein"])
        for line in f:
            p = line.rstrip("\n").split(",")
            scanned += 1
            try:
                grade = float(p[ig])
                penv = float(p[ip])
            except (ValueError, IndexError):
                continue
            if grade <= 0 or penv <= 0:
                continue

            vname = p[it].strip()
            if vname not in vein_id:
                # Fall back to the vein holding the largest share of the block.
                best, bestv = 0.0, None
                for v, i in vein_id.items():
                    try:
                        share = float(p[col["Percent_" + v]])
                    except (ValueError, IndexError):
                        continue
                    if share > best:
                        best, bestv = share, v
                if bestv is None:
                    continue
                vname = bestv
                type_mismatch += 1

            try:
                cls = int(float(p[ic]))
            except (ValueError, IndexError):
                cls = 0

            tonnes = TONNES_PER_BLOCK * penv
            metal_g = tonnes * grade          # AuEq g/t * t = grams

            w.writerow([p[ix], p[iy], p[iz], f"{grade:.4f}", f"{penv:.4f}",
                        cls, vein_id[vname]])

            for bucket in (per_vein[vname], per_class[cls], total):
                bucket["blocks"] += 1
                bucket["tonnes"] += tonnes
                bucket["metal_g"] += metal_g

    def rollup(d):
        t = d["tonnes"]
        return {
            "blocks": d["blocks"],
            "tonnes": round(t, 1),
            "grade_gt": round(d["metal_g"] / t, 3) if t else 0.0,
            "oz": round(d["metal_g"] / G_PER_TROY_OZ, 0),
        }

    stats = {
        "source": SRC.name,
        "scanned_rows": scanned,
        "block_m3": BLOCK_M3,
        "density": DENSITY,
        "tonnes_per_block": TONNES_PER_BLOCK,
        "class_labels": {str(k): v for k, v in CLASS_LABELS.items()},
        "class_mapping_confirmed": CLASS_CONFIRMED,
        "veins": veins,
        "total": rollup(total),
        "by_class": {str(k): rollup(v) for k, v in sorted(per_class.items())},
        "by_vein": {k: rollup(v) for k, v in sorted(
            per_vein.items(), key=lambda kv: -kv[1]["tonnes"])},
    }
    OUT_JSON.write_text(json.dumps(stats, indent=2))

    t = stats["total"]
    print(f"scanned {scanned:,} rows -> {t['blocks']:,} mineralized blocks")
    print(f"  {t['tonnes']:,.0f} t @ {t['grade_gt']} g/t AuEq  =  {t['oz']:,.0f} oz")
    print(f"  {len(veins)} vein domains, {len(per_class)} classification codes")
    if type_mismatch:
        print(f"  note: {type_mismatch:,} blocks had no usable Type — "
              f"assigned by dominant Percent_<vein> share")
    print(f"wrote {OUT_CSV.relative_to(ROOT)} + {OUT_JSON.relative_to(ROOT)}")
    if not CLASS_CONFIRMED:
        print("  WARNING: class 1/2/3 -> Measured/Indicated/Inferred is UNCONFIRMED "
              "— verify against the Nov-2021 NI 43-101 before publishing")


if __name__ == "__main__":
    main()
