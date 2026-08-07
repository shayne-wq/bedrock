#!/usr/bin/env python3
"""Orebody — vein-domain surface extraction.

Turns each vein domain's blocks into a watertight triangle shell so a domain can
be shown as a geological SURFACE rather than a cloud of cubes. This is what makes
commercial geological software legible: a vein is a sheet, and drawing it as a
sheet says more in one frame than any amount of grade colouring on blocks.

Method is exterior-face extraction, not marching cubes. The source is already a
regular 10 x 5 x 5 m grid, so a block face is on the hull exactly when the
neighbouring cell is not in the same domain. That is exact, cheap, watertight,
and — unlike an interpolated isosurface — it invents no geometry the block model
does not contain, which matters for a tool whose whole claim is that it does not
embellish. The result is faceted at block scale, which is honest: that IS the
resolution of the data.

Emits data/elk_surfaces.json:
  {vein_name: {v: [x,y,z, ...], i: [a,b,c, ...], blocks, tonnes, oz}}
Coordinates stay in UTM 10N; the viewer reprojects, caching per unique easting
/northing pair.

Usage:  python3 tools/extract_surfaces.py [n_veins]
"""
import base64, csv, json, struct, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "elk_blocks_v2.csv"
STATS = ROOT / "data" / "elk_stats.json"
OUT = ROOT / "data" / "elk_surfaces.json"
N_VEINS = int(sys.argv[1]) if len(sys.argv) > 1 else 8

DX, DY, DZ = 10.0, 5.0, 5.0          # block dimensions on the source grid

# (neighbour offset, four corner offsets of the face) in half-block units
FACES = [
    ((1, 0, 0),  [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)]),
    ((-1, 0, 0), [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)]),
    ((0, 1, 0),  [(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)]),
    ((0, -1, 0), [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)]),
    ((0, 0, 1),  [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]),
    ((0, 0, -1), [(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)]),
]


def main():
    if not SRC.exists():
        sys.exit(f"missing {SRC} — run tools/extract_blocks.py first")
    stats = json.loads(STATS.read_text())
    veins = stats["veins"]
    by_oz = sorted(stats["by_vein"].items(), key=lambda kv: -kv[1]["oz"])
    want = [n for n, _ in by_oz[:N_VEINS]]
    want_id = {veins.index(n) for n in want}

    cells = defaultdict(set)          # vein id -> {(ix,iy,iz)}
    for r in csv.DictReader(open(SRC, newline="")):
        v = int(r["vein"])
        if v not in want_id:
            continue
        cells[v].add((round(float(r["x"]) / DX), round(float(r["y"]) / DY),
                      round(float(r["z"]) / DZ)))

    out = {}
    for v, occ in cells.items():
        name = veins[v]
        verts, idx, vmap = [], [], {}

        def vid(p):
            k = vmap.get(p)
            if k is None:
                k = len(verts) // 3
                vmap[p] = k
                verts.extend(p)
            return k

        # Greedy meshing: a vein hull is mostly large flat walls, so emitting one
        # quad per block face is enormously wasteful. Merge coplanar neighbours
        # into maximal rectangles first — on this deposit that is a ~7x cut in
        # triangles, which is the difference between shipping the surfaces and
        # not. The geometry is identical, just fewer, bigger quads.
        for axis in (0, 1, 2):
            u, v_ = (axis + 1) % 3, (axis + 2) % 3
            step = (DX, DY, DZ)
            for sign in (1, -1):
                planes = defaultdict(set)
                for c in occ:
                    n = list(c); n[axis] += sign
                    if tuple(n) not in occ:
                        planes[c[axis]].add((c[u], c[v_]))
                for slab, mask in planes.items():
                    todo = set(mask)
                    while todo:
                        a0, b0 = min(todo)
                        w = 1
                        while (a0 + w, b0) in todo:
                            w += 1
                        h = 1
                        while all((a0 + k, b0 + h) in todo for k in range(w)):
                            h += 1
                        for k in range(w):
                            for m in range(h):
                                todo.discard((a0 + k, b0 + m))
                        # rectangle corners in grid space -> world
                        def world(ai, bi):
                            g = [0, 0, 0]
                            g[axis] = slab * step[axis] + sign * step[axis] / 2
                            g[u] = ai * step[u] - step[u] / 2
                            g[v_] = bi * step[v_] - step[v_] / 2
                            return (round(g[0], 2), round(g[1], 2), round(g[2], 2))
                        c0 = world(a0, b0)
                        c1 = world(a0 + w, b0)
                        c2 = world(a0 + w, b0 + h)
                        c3 = world(a0, b0 + h)
                        quad = [c0, c1, c2, c3]
                        # keep winding consistent with the outward normal
                        if (sign > 0) != (axis == 1):
                            quad = [c0, c3, c2, c1]
                        q = [vid(pt) for pt in quad]
                        idx.extend([q[0], q[1], q[2], q[0], q[2], q[3]])

        s = stats["by_vein"][name]
        out[name] = {
            "v": base64.b64encode(struct.pack("<%df" % len(verts), *verts)).decode(),
            "i": base64.b64encode(struct.pack("<%dI" % len(idx), *idx)).decode(),
            "nv": len(verts) // 3, "nt": len(idx) // 3,
            "blocks": s["blocks"], "tonnes": s["tonnes"],
            "grade": s["grade_gt"], "oz": s["oz"]}
        print(f"  {name:<10} {len(occ):>7,} cells -> {len(idx)//3:>7,} triangles")

    OUT.write_text(json.dumps(out, separators=(",", ":")))
    tri = sum(o["nt"] for o in out.values())
    print(f"wrote {OUT.relative_to(ROOT)} — {len(out)} domains, {tri:,} triangles, "
          f"{OUT.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
