#!/usr/bin/env python3
"""Bedrock — SYNTHETIC drill-hole generator.

============================ READ THIS FIRST ============================
EVERY HOLE THIS SCRIPT PRODUCES IS FABRICATED. No drilling happened. These
are not Elk Gold drill results, they are not derived from any assay
certificate, and they must never be presented as real. They exist only so
the viewer's drill-trace feature can be built and demonstrated before real
collar/survey/assay data is obtained.

Guard rails, deliberately redundant:
  - every hole id is prefixed  SYN-
  - every output filename is prefixed  SYNTHETIC_
  - every ROW carries a data_source column reading SYNTHETIC_FABRICATED_NOT_REAL
    (a column, not a banner line — a header comment gets stripped the moment
    anyone opens the file in Excel or slices it in pandas; a column travels
    with every row no matter how the data is cut)
  - the manifest sets  "synthetic": true , which the viewer reads and uses
    to stamp a permanent on-screen warning that cannot be dismissed
Do not strip any of these. If real data arrives, replace the files and set
synthetic:false rather than editing the labels out.
=========================================================================

Holes are traced through the REAL block model so they look geologically
sensible — collars sit above the deposit, holes are angled across the
northwest-trending vein corridors, and sampled grades follow the actual
modelled AuEq with noise. The geometry is plausible; the data is invented.

Usage:  python3 tools/make_synthetic_drills.py [n_holes]
"""
import csv, json, math, random, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "elk_blocks_v2.csv"
OUTDIR = ROOT / "data" / "synthetic"
N_HOLES = int(sys.argv[1]) if len(sys.argv) > 1 else 40
SEED = 20211130                      # fixed so rebuilds are reproducible

TAINT = "SYNTHETIC_FABRICATED_NOT_REAL"   # stamped on every row, every file
SAMPLE_M = 1.5                       # downhole sample interval
COVER_M = 25.0                       # collar sits this far above the top block
BG_LO, BG_HI = 0.005, 0.06           # background (unmineralized) Au g/t
MIN_COMPOSITE = 0.10                 # g/t below which an interval is "waste"

rng = random.Random(SEED)


def load_blocks():
    """Index blocks on the 10 x 5 x 5 m grid for nearest-cell lookup."""
    grid = {}
    for r in csv.DictReader(open(SRC, newline="")):
        key = (round(float(r["x"]) / 10), round(float(r["y"]) / 5), round(float(r["z"]) / 5))
        g = float(r["aueq"])
        # keep the richest block if two land in one cell
        if key not in grid or g > grid[key]:
            grid[key] = g
    return grid


def main():
    if not SRC.exists():
        sys.exit(f"missing {SRC} — run tools/extract_blocks.py first")
    grid = load_blocks()

    # Column tops, so collars sit on something resembling the ridge.
    tops = defaultdict(lambda: -1e9)
    for (gx, gy, gz) in grid:
        tops[(gx, gy)] = max(tops[(gx, gy)], gz * 5)
    cols = sorted(tops.items(), key=lambda kv: -kv[1])

    OUTDIR.mkdir(parents=True, exist_ok=True)
    collars, surveys, assays = [], [], []

    # Spread collars across the footprint rather than clustering on the crest.
    picks, seen = [], set()
    rng.shuffle(cols)
    for (gx, gy), top in cols:
        cell = (gx // 6, gy // 12)          # ~60 x 60 m spacing
        if cell in seen:
            continue
        seen.add(cell)
        picks.append((gx * 10.0, gy * 5.0, top))
        if len(picks) >= N_HOLES:
            break

    for i, (cx, cy, top) in enumerate(picks, 1):
        hid = f"SYN-{i:03d}"
        cz = top + COVER_M
        # Veins trend NW; drill across them from the NE or SW.
        az = rng.choice([225.0, 45.0]) + rng.uniform(-18, 18)
        dip = rng.uniform(-72, -48)
        depth = rng.uniform(140, 340)

        collars.append({
            "hole_id": hid, "easting": round(cx, 1), "northing": round(cy, 1),
            "elevation": round(cz, 1), "total_depth_m": round(depth, 1),
            "azimuth": round(az % 360, 1), "dip": round(dip, 1),
        })
        # Straight-hole survey with a touch of drift, recorded every 30 m.
        d = 0.0
        while d <= depth:
            surveys.append({
                "hole_id": hid, "depth_m": round(d, 1),
                "azimuth": round((az + d * rng.uniform(-0.012, 0.012)) % 360, 1),
                "dip": round(min(-30.0, dip + d * rng.uniform(-0.006, 0.006)), 1),
            })
            d += 30.0

        # Sample the real model down the trace, then composite.
        araz, ardip = math.radians(az), math.radians(dip)
        dx = math.sin(araz) * math.cos(ardip)
        dy = math.cos(araz) * math.cos(ardip)
        dz = math.sin(ardip)
        samples = []
        d = 0.0
        while d < depth:
            px, py, pz = cx + dx * d, cy + dy * d, cz + dz * d
            cell = grid.get((round(px / 10), round(py / 5), round(pz / 5)))
            if cell is not None:
                # modelled grade, roughened so it doesn't look machine-made.
                # Symmetric in log space so the noise adds no net grade bias.
                g = max(0.0, cell * math.exp(rng.uniform(-0.55, 0.55)))
            else:
                g = rng.uniform(BG_LO, BG_HI)
            samples.append((d, min(d + SAMPLE_M, depth), round(g, 3)))
            d += SAMPLE_M

        # Merge adjacent samples that are both ore or both waste.
        run = None
        for a, b, g in samples:
            ore = g >= MIN_COMPOSITE
            if run and run["ore"] == ore:
                run["to"] = b
                run["gsum"] += g * (b - a)
                run["len"] += (b - a)
            else:
                if run:
                    assays.append(run)
                run = {"hole_id": hid, "from": a, "to": b, "ore": ore,
                       "gsum": g * (b - a), "len": (b - a)}
        if run:
            assays.append(run)

    def write(name, rows, cols_):
        """Standard, directly-parseable CSV — header on line 1, no banner row —
        with the taint carried as a real column on every record."""
        p = OUTDIR / name
        fields = cols_ + ["data_source"]
        with open(p, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow({**r, "data_source": TAINT})
        return p

    arows = [{"hole_id": a["hole_id"], "from_m": round(a["from"], 2),
              "to_m": round(a["to"], 2), "length_m": round(a["len"], 2),
              "au_gpt": round(a["gsum"] / a["len"], 3) if a["len"] else 0.0}
             for a in assays]

    write("SYNTHETIC_collars.csv", collars,
          ["hole_id", "easting", "northing", "elevation", "total_depth_m", "azimuth", "dip"])
    write("SYNTHETIC_surveys.csv", surveys, ["hole_id", "depth_m", "azimuth", "dip"])
    write("SYNTHETIC_assays.csv", arows, ["hole_id", "from_m", "to_m", "length_m", "au_gpt"])

    ore = [a for a in arows if a["au_gpt"] >= MIN_COMPOSITE]
    manifest = {
        "synthetic": True,
        "warning": "FABRICATED DATA — not real drill results. Demo use only.",
        "generator": "tools/make_synthetic_drills.py",
        "seed": SEED,
        "holes": len(collars),
        "total_metres": round(sum(c["total_depth_m"] for c in collars), 1),
        "assay_intervals": len(arows),
        "mineralized_intervals": len(ore),
        "best_interval_gpt": round(max((a["au_gpt"] for a in ore), default=0), 3),
        "crs": "EPSG:26910 (UTM 10N, NAD83)",
    }
    (OUTDIR / "manifest.json").write_text(json.dumps(manifest, indent=2))

    print(f"SYNTHETIC drill data -> {OUTDIR.relative_to(ROOT)}")
    print(f"  {manifest['holes']} holes, {manifest['total_metres']:,.0f} m")
    print(f"  {manifest['assay_intervals']:,} intervals "
          f"({manifest['mineralized_intervals']:,} >= {MIN_COMPOSITE} g/t), "
          f"best {manifest['best_interval_gpt']} g/t")
    print("  REMINDER: fabricated. Never present as real drill results.")


if __name__ == "__main__":
    main()
