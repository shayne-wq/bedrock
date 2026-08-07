#!/usr/bin/env python3
"""Orebody — block-model extractor (v2).

Reads the native MineSight export and emits the two files the viewer needs:

  data/elk_blocks_v2.csv   x,y,z,aueq,penv,cls,vein   (one row per mineralized block)
  data/elk_stats.json      exact grade-tonnage rollups, per vein and per class
  data/elk_buckets.json    share-weighted (vein, class, grade-bin) rollups

v1 carried only AuEq and Percent_Env — two columns out of ~280. This also carries
the block's **resource classification** and its **vein domain**, which is what
makes vein isolation and class colouring possible downstream.

VEIN TONNAGE IS SHARE-WEIGHTED, and that distinction matters. A block is not
owned by one vein: 18,367 of the 168,013 mineralized blocks (10.9%) straddle two
or more domains, and the source carries a Percent_<vein> column for each,
summing to Percent_Env. Crediting a whole block to its `Type` vein — the obvious
reading, and what the first cut of this script did — overstated vein 2400 by
34% in contained ounces and understated 1300E by 16%. Deposit totals still
reconciled, which is exactly what made it hard to notice. Per-vein tonnage here
is therefore split by each vein's own share.

The `vein` column in the CSV is the block's DOMINANT domain and exists only so
the viewer has one colour and one position per block. It is a rendering hint.
Never roll tonnage up from it — use elk_buckets.json, which is share-weighted.

Tonnage is real, not a proxy: blocks are 10 x 5 x 5 m on a uniform 2.7 t/m3
density, so a whole block is 675 t and a block's ore tonnage is 675 * Percent_Env.
Stats are computed over EVERY mineralized block here, at build time — the viewer
may decimate what it draws, but the numbers it reports stay exact.

Usage:  python3 tools/extract_blocks.py [path/to/source.csv]
"""
import bisect, csv, json, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "Siwash_North_BM_Nov_2021.csv"
OUT_CSV = ROOT / "data" / "elk_blocks_v2.csv"
OUT_JSON = ROOT / "data" / "elk_stats.json"
OUT_BUCKETS = ROOT / "data" / "elk_buckets.json"

# Block geometry + density, read off the source grid (x steps 10 m, y/z 5 m) and
# the FixedDensity column (uniform 2.7 across all 495,074 blocks).
BLOCK_M3 = 10.0 * 5.0 * 5.0
DENSITY = 2.7
TONNES_PER_BLOCK = BLOCK_M3 * DENSITY          # 675 t
G_PER_TROY_OZ = 31.10348

# MineSight classification codes. 0 = unclassified/waste.
# NOTE: the 1/2/3 -> Measured/Indicated/Inferred mapping follows the usual
# MineSight convention but has NOT been confirmed against the Nov-2021 NI 43-101.
# Among mineralized blocks the split is 53,380 / 111,317 / 1,209 plus 2,107
# unclassified — an odd shape for a normal resource (an Inferred category that
# small, and running 10.7 g/t, is unusual), so treat these labels as provisional
# until someone checks them against the technical report.
CLASS_LABELS = {0: "Unclassified", 1: "Measured", 2: "Indicated", 3: "Inferred"}
CLASS_CONFIRMED = False

# Grade ladder — must stay identical to the one in tools/build_present.py, since
# the bucket keys emitted here are what the viewer's readout sums.
LADDER = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0, 50.0]


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

    pcol = {v: col["Percent_" + v] for v in veins}
    per_vein = defaultdict(lambda: {"blocks": 0, "tonnes": 0.0, "metal_g": 0.0})
    per_class = defaultdict(lambda: {"blocks": 0, "tonnes": 0.0, "metal_g": 0.0})
    # Share-weighted (vein, class, grade-bin) rollups — the viewer's readout.
    per_bucket = defaultdict(lambda: [0, 0.0, 0.0])
    # Same rollup keyed WITHOUT the vein, so the all-veins readout can report a
    # distinct block count. Summing the share-weighted table across veins counts
    # a straddling block once per domain — right for tonnage, wrong for "blocks".
    per_cb = defaultdict(lambda: [0, 0.0, 0.0])
    total = {"blocks": 0, "tonnes": 0.0, "metal_g": 0.0}
    dropped = shared = 0
    scanned = 0

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(SRC, newline="") as f, open(OUT_CSV, "w", newline="") as out:
        rdr = csv.reader(f)          # proper CSV parse: a quoted comma would
        next(rdr)                    # otherwise shift every column index
        w = csv.writer(out)
        w.writerow(["x", "y", "z", "aueq", "penv", "cls", "vein"])
        for p in rdr:
            scanned += 1
            try:
                grade = float(p[ig])
                penv = float(p[ip])
            except (ValueError, IndexError):
                continue
            if grade <= 0 or penv <= 0:
                continue

            # A block's ore volume is split across the domains it straddles.
            shares = []
            for v in veins:
                try:
                    s = float(p[pcol[v]])
                except (ValueError, IndexError):
                    continue
                if s > 0:
                    shares.append((v, s))
            if not shares:
                dropped += 1
                continue
            if len(shares) > 1:
                shared += 1
            # Dominant domain drives rendering only — never tonnage.
            dom = max(shares, key=lambda kv: kv[1])[0]

            try:
                cls = int(float(p[ic]))
            except (ValueError, IndexError):
                cls = 0

            tonnes = TONNES_PER_BLOCK * penv
            metal_g = tonnes * grade          # AuEq g/t * t = grams
            gbin = bisect.bisect_right(LADDER, grade) - 1

            w.writerow([p[ix], p[iy], p[iz], f"{grade:.4f}", f"{penv:.4f}",
                        cls, vein_id[dom]])

            for v, s in shares:
                vt = TONNES_PER_BLOCK * s
                d = per_vein[v]
                d["blocks"] += 1                 # blocks TOUCHING this vein
                d["tonnes"] += vt
                d["metal_g"] += vt * grade
                e = per_bucket[(vein_id[v], cls, gbin)]
                e[0] += 1; e[1] += vt; e[2] += vt * grade

            e = per_cb[(cls, gbin)]
            e[0] += 1; e[1] += tonnes; e[2] += metal_g

            for bucket in (per_class[cls], total):
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
        "dropped_blocks": dropped,
        "blocks_straddling_multiple_domains": shared,
        "total": rollup(total),
        "by_class": {str(k): rollup(v) for k, v in sorted(per_class.items())},
        "by_vein": {k: rollup(v) for k, v in sorted(
            per_vein.items(), key=lambda kv: -kv[1]["tonnes"])},
    }
    OUT_JSON.write_text(json.dumps(stats, indent=2))

    buckets = [{"v": v, "c": c, "b": b, "n": e[0], "t": round(e[1], 1), "m": round(e[2], 1)}
               for (v, c, b), e in sorted(per_bucket.items())]
    cb = [{"c": c, "b": b, "n": e[0], "t": round(e[1], 1), "m": round(e[2], 1)}
          for (c, b), e in sorted(per_cb.items())]
    OUT_BUCKETS.write_text(json.dumps({
        "ladder": LADDER, "share_weighted": True, "buckets": buckets, "by_cb": cb}))

    # The share-weighted buckets must still reconcile to the deposit total,
    # because every block's shares sum to its Percent_Env.
    bt = sum(b["t"] for b in buckets)
    drift = abs(bt - total["tonnes"])
    assert drift < 1.0, f"bucket tonnes {bt} != total {total['tonnes']} (drift {drift})"
    cbt = sum(b["t"] for b in cb); cbn = sum(b["n"] for b in cb)
    assert abs(cbt - total["tonnes"]) < 1.0 and cbn == total["blocks"], \
        f"by_cb {cbn} blocks / {cbt} t != {total['blocks']} / {total['tonnes']}"

    t = stats["total"]
    print(f"scanned {scanned:,} rows -> {t['blocks']:,} mineralized blocks")
    print(f"  {t['tonnes']:,.0f} t @ {t['grade_gt']} g/t AuEq  =  {t['oz']:,.0f} oz")
    print(f"  {len(veins)} vein domains, {len(per_class)} classification codes")
    print(f"  {shared:,} blocks ({shared/max(1,t['blocks'])*100:.1f}%) straddle >1 domain "
          f"— vein tonnage is split by share, not credited whole")
    print(f"  {len(buckets):,} share-weighted buckets, reconcile drift {drift:.2f} t")
    if dropped:
        print(f"  WARNING: dropped {dropped:,} mineralized blocks with no vein share — "
              f"these are MISSING from every rollup; investigate before publishing")
    print(f"wrote {OUT_CSV.relative_to(ROOT)}, {OUT_JSON.relative_to(ROOT)}, "
          f"{OUT_BUCKETS.relative_to(ROOT)}")
    if not CLASS_CONFIRMED:
        print("  WARNING: class 1/2/3 -> Measured/Indicated/Inferred is UNCONFIRMED "
              "— verify against the Nov-2021 NI 43-101 before publishing")


if __name__ == "__main__":
    main()
