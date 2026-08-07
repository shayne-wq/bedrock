#!/usr/bin/env python3
"""Clip REAL BC mineral tenures to the Elk Gold extent.

    python3 tools/fetch_bc_claims.py [path/to/bc-mineral-tenures.geojson]

Writes data/bc_tenures_elk.geojson.

This is the one layer in the deck that is NOT fabricated, and that is the whole
point of it. Claims are the most checkable thing in a mining deck — a reader can
put a tenure number into Mineral Titles Online and have an answer in under a
minute. A fabricated claim boundary is therefore the fabricated layer most
likely to be caught, and the one that costs the most credibility when it is.

Source is the BC government's public tenure dataset:
  openmaps.gov.bc.ca/geo/pub/ows — pub:WHSE_MINERAL_TENURE.MTA_ACQUIRED_TENURE_SVW
distributed under the Open Government Licence – British Columbia. The bulk
GeoJSON is baked by SmallCapContent/scripts/bake-bc-claims.mjs; this script only
clips it to the project and carries the attribution across.

`synthetic` is false here, deliberately and load-bearingly. Do not copy this
file as a template for a fabricated layer — the flag is the difference between
a claim a reader can verify and one that will embarrass you.
"""
import json, sys
from pathlib import Path

from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
SRC_DEFAULT = (ROOT.parent.parent / "SmallCapContent" / "data"
               / "bc-mineral-tenures.geojson")
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC_DEFAULT
BLOCKS = ROOT / "data" / "elk_blocks_v2.csv"
OUT = ROOT / "data" / "bc_tenures_elk.geojson"
MARGIN = 1500.0   # m beyond the model extent — neighbours give useful context

if not SRC.exists():
    raise SystemExit(f"tenure source not found: {SRC}\n"
                     "Run SmallCapContent/scripts/bake-bc-claims.mjs first.")

# ---- project extent, from the block model itself so the two cannot drift ----
import csv
xs, ys = [], []
with open(BLOCKS, newline="") as f:
    for r in csv.DictReader(f):
        xs.append(float(r["x"])); ys.append(float(r["y"]))
emin, emax = min(xs) - MARGIN, max(xs) + MARGIN
nmin, nmax = min(ys) - MARGIN, max(ys) + MARGIN

# EPSG:26910 = NAD83 / UTM zone 10N, the model's native CRS.
to_wgs = Transformer.from_crs("EPSG:26910", "EPSG:4326", always_xy=True)
lon0, lat0 = to_wgs.transform(emin, nmin)
lon1, lat1 = to_wgs.transform(emax, nmax)
W, E = min(lon0, lon1), max(lon0, lon1)
S, N = min(lat0, lat1), max(lat0, lat1)


def rings(geom):
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return geom["coordinates"]
    if geom["type"] == "MultiPolygon":
        return [r for poly in geom["coordinates"] for r in poly]
    return []


def hits(geom):
    """Bounding-box overlap. A true polygon intersection would need shapely;
    for picking the handful of tenures over one project a bbox test is both
    sufficient and honest about what it is — it may include a neighbour that
    merely brushes the window, which is the safe direction to err."""
    for ring in rings(geom):
        for lon, lat in ring:
            if W <= lon <= E and S <= lat <= N:
                return True
    return False


src = json.loads(SRC.read_text())
kept = [f for f in src.get("features", []) if hits(f.get("geometry"))]

out = {
    "type": "FeatureCollection",
    "synthetic": False,
    "data_source": "REAL — BC Mineral Titles Online (public)",
    "source_dataset": "pub:WHSE_MINERAL_TENURE.MTA_ACQUIRED_TENURE_SVW",
    "source_endpoint": "https://openmaps.gov.bc.ca/geo/pub/ows",
    "licence": "Open Government Licence – British Columbia",
    "attribution": "Contains information licensed under the Open Government "
                   "Licence – British Columbia.",
    "note": "Clipped by bounding box to the Elk Gold project extent. Tenure "
            "boundaries are authoritative as published by the Province; "
            "currency depends on when the bulk file was baked.",
    "clip_extent_wgs84": {"west": W, "south": S, "east": E, "north": N},
    "crs_of_source_model": "EPSG:26910",
    "features": kept,
}
OUT.write_text(json.dumps(out))

print(f"kept {len(kept)} REAL tenures of {len(src.get('features', [])):,}")
print(f"  window {W:.5f},{S:.5f} -> {E:.5f},{N:.5f}")
if kept:
    props = kept[0].get("properties", {}) or {}
    show = [k for k in props if any(t in k.upper() for t in
            ("TENURE", "TITLE", "OWNER", "CLAIM", "NAME", "EXPIR"))][:6]
    print("  sample:", {k: props[k] for k in show} or list(props)[:6])
print(f"  wrote {OUT.relative_to(ROOT)}")
