#!/usr/bin/env python3
"""Bedrock — generate FABRICATED claim boundaries for the demo project.

    python3 tools/make_demo_tenures.py

WHAT THIS REPLACES
------------------
The demo's claim layer used to be genuine: public BC mineral tenures around
a third-party issuer's ground, pulled by tools/fetch_bc_claims.py. Being real
was the point — a reader who could look a tenure number up should not see it
captioned "conceptual".

Two things made that untenable once the deposit itself became invented.

  1. The claims named 16 holders, 11 of whom are private individuals, by full
     legal name. That is public record in BC Mineral Titles Online, but a
     government registry and a commercial marketing site are not the same
     act, and none of those people had any part in this.

  2. Real ground under an invented orebody is the exact trap this repository
     already warns about in tools/make_synthetic_deposit.py: a fabricated
     deposit drawn on a real claim, at a believable grade, is the most
     misleading artifact it can produce. With the deposit now fabricated,
     keeping the claims real would have made every one of them a false
     implication about somebody's actual property.

So the ground is invented too, and labelled as invented. The holders below are
made up. If any of them collides with a real company it is coincidence, which
is why the viewer captions every one of these boundaries "(conceptual)" and
names claim boundaries in its fabricated-data banner.

GEOMETRY
--------
BC-style cell claims: axis-aligned rectangles on a regular lat/lon grid,
because that is what a cell-title claim block actually looks like. Twelve
cells for the subject property, a ring of neighbours around it.
"""
import json, random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "bc_tenures_elk.geojson"

SEED = 20260904
# The demo project's ground — remote Coast Mountains, matching the origin in
# tools/make_demo_model.py (UTM 10N E 270000 / N 5833000).
CLAT, CLON = 52.5983, -126.3963
DLAT, DLON = 0.0110, 0.0182          # one cell, roughly 1.2 x 1.2 km

SUBJECT = "BEDROCK DEMO"
# Invented. See the note above: these are not real companies, and the viewer
# labels every boundary conceptual so none of them reads as a land position.
NEIGHBOURS = ["Northline Metals Ltd.", "Ridgeway Exploration Inc.",
              "Coast Range Resources Corp.", "Halden Minerals Ltd.",
              "Perrin Gold Corp.",
              # Two holders in SURNAME, FIRSTNAME shape. The register the real
              # one replaced was mostly individuals, and the viewer has code
              # that reads that shape as a person rather than a company — it
              # sorts them below companies and never names them on a card. A
              # register of nothing but Ltd.s would leave that path untested,
              # so these keep it exercised. Deliberately not plausible names.
              "SAMPLE, ALEX J.", "SAMPLE, MORGAN K."]

# Subject block: a stepped, deliberately irregular run of cells rather than a
# neat rectangle. The viewer dissolves the issuer's claims into a single
# outline instead of drawing internal fences, and a rectangular block would
# dissolve to a rectangle — which is also what a bounding-box bug produces.
# A staircase makes the two distinguishable, and tools/verify_holders.mjs
# checks exactly that.
SUBJECT_CELLS = ([(cx, 1) for cx in (-2, -1, 0)]
                 + [(cx, 0) for cx in (-2, -1, 0, 1)]
                 + [(cx, -1) for cx in (-1, 0, 1, 2)]
                 + [(cx, -2) for cx in (0, 1)])


def cell(cx, cy):
    w, s = CLON + cx * DLON, CLAT + cy * DLAT
    e, n = w + DLON, s + DLAT
    return [[[round(w, 6), round(s, 6)], [round(e, 6), round(s, 6)],
             [round(e, 6), round(n, 6)], [round(w, 6), round(n, 6)],
             [round(w, 6), round(s, 6)]]]


def main():
    rng = random.Random(SEED)
    feats, tenure = [], 900_001

    def add(cx, cy, owner, subject):
        nonlocal tenure
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": cell(cx, cy)},
            "properties": {
                "TENURE_NUMBER_ID": tenure,
                "CLAIM_NAME": f"DEMO {tenure - 900_000:03d}",
                "OWNER_NAME": owner,
                "TENURE_TYPE_DESCRIPTION": "Mineral",
                "TENURE_SUB_TYPE_DESCRIPTION": "CLAIM",
                "TITLE_TYPE_DESCRIPTION": "Cell Title Submission",
                "AREA_IN_HECTARES": round(rng.uniform(168.0, 184.0), 4),
                "ISSUE_DATE": f"{rng.randint(2016, 2023)}-0{rng.randint(1,9)}-1{rng.randint(0,9)}Z",
                "GOOD_TO_DATE": f"{rng.randint(2027, 2031)}-0{rng.randint(1,9)}-1{rng.randint(0,9)}Z",
                "_subject": subject,
                "_neighbour": not subject,
            },
        })
        tenure += 1

    for cx, cy in SUBJECT_CELLS:
        add(cx, cy, SUBJECT, True)

    # A ring of neighbouring ground, so the land-package view has someone to
    # name. Each holder gets a contiguous run rather than scattered cells —
    # claim blocks are staked in blocks.
    ring = [(cx, cy) for cx in range(-4, 4) for cy in range(-3, 4)
            if (cx, cy) not in SUBJECT_CELLS]
    rng.shuffle(ring)
    per = max(1, len(ring) // len(NEIGHBOURS))
    for i, (cx, cy) in enumerate(ring[:per * len(NEIGHBOURS)]):
        add(cx, cy, NEIGHBOURS[min(i // per, len(NEIGHBOURS) - 1)], False)

    lons = [p[0] for f in feats for p in f["geometry"]["coordinates"][0]]
    lats = [p[1] for f in feats for p in f["geometry"]["coordinates"][0]]
    doc = {
        "type": "FeatureCollection",
        "synthetic": True,
        "data_source": "SYNTHETIC",
        "source_dataset": None,
        "source_endpoint": None,
        "licence": None,
        "attribution": "",
        "note": ("FABRICATED claim boundaries and holders. There is no such "
                 "property, and none of the holders named here is a real "
                 "company. Generated by tools/make_demo_tenures.py so the "
                 "demo can show a land package without drawing an invented "
                 "deposit on somebody's real ground."),
        "subject_owner": SUBJECT,
        "owners": sorted({f["properties"]["OWNER_NAME"] for f in feats}),
        "clip_extent_wgs84": [min(lons), min(lats), max(lons), max(lats)],
        "neighbour_extent_wgs84": [min(lons), min(lats), max(lons), max(lats)],
        "neighbour_radius_m": 4000,
        "crs_of_source_model": "EPSG:32610",
        "features": feats,
    }
    OUT.write_text(json.dumps(doc, indent=1))
    subj = sum(1 for f in feats if f["properties"]["_subject"])
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  {len(feats)} cells — {subj} subject, {len(feats) - subj} neighbouring")
    print(f"  holders: {SUBJECT} + {len(NEIGHBOURS)} invented neighbours")
    print(f"  flagged synthetic:true — the viewer must caption these conceptual")


if __name__ == "__main__":
    main()
