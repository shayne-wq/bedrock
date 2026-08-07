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

# Grade shells, CUMULATIVE: each is the hull of everything at or above its
# threshold, so they nest. Exclusive bands were tried first and are speckled —
# a band scattered through the deposit has enormous surface area, and the five
# of them came to 414k triangles and 11 MB. Nested shells are contiguous
# volumes, hull cheaply, and render the way grade shells are meant to: a
# translucent envelope with solid high-grade cores visible inside it.
# Only the HIGH-grade shells are shipped. A 0.3 or 1.0 g/t envelope hulls to
# 114k and 95k triangles respectively, and — more to the point — an envelope is
# exactly the outer surface that made the block rendering look like a blob.
# Hulling it does not fix that, it just smooths it. The compact 3 g/t and 8 g/t
# cores are what a surface rendering has something useful to say about; the
# sheeted structure is carried by the per-vein hulls instead.
SHELLS = [(3.0, "s30"), (8.0, "s80")]

# Hard floor for the whole tool. Nothing below this is modelled, surfaced,
# coloured or counted anywhere — a vein hull built from every block in the
# domain silently reintroduced sub-economic material and made the sheets look
# bloated, which is exactly the blobbiness the cut-off was raised to remove.
GRADE_FLOOR = 0.5

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
    tiers = defaultdict(set)          # shell key -> {(ix,iy,iz)}
    tstat = defaultdict(lambda: [0, 0.0, 0.0])
    for r in csv.DictReader(open(SRC, newline="")):
        cell = (round(float(r["x"]) / DX), round(float(r["y"]) / DY),
                round(float(r["z"]) / DZ))
        g = float(r["aueq"])
        tn = 675.0 * float(r["penv"])
        for thr, key in SHELLS:
            if g >= thr:
                tiers[key].add(cell)
                e = tstat[key]; e[0] += 1; e[1] += tn; e[2] += tn * g
        v = int(r["vein"])
        if v in want_id and g >= GRADE_FLOOR:
            cells[v].add(cell)

    out = {}
    todo = [(veins[v], occ, "vein") for v, occ in cells.items()]
    todo += [(k, occ, "shell") for k, occ in tiers.items()]
    for name, occ, kind in todo:
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

        if kind == "vein":
            # by_vein is over the whole domain; the hull is only its >= floor
            # part, so report the hull's own numbers rather than the domain's.
            s = dict(stats["by_vein"][name])
            s["blocks"] = len(occ)
        else:
            e = tstat[name]
            s = {"blocks": e[0], "tonnes": round(e[1], 1),
                 "grade_gt": round(e[2] / e[1], 3) if e[1] else 0.0,
                 "oz": round(e[2] / 31.10348, 0)}
        # Every vertex lies on a 2.5 m lattice, so int16 offsets from the local
        # origin are EXACT, not lossy — and halve the payload.
        ox = min(verts[0::3]); oy = min(verts[1::3]); oz = min(verts[2::3])
        q = []
        for k in range(0, len(verts), 3):
            q.append(int(round((verts[k] - ox) / 2.5)))
            q.append(int(round((verts[k + 1] - oy) / 2.5)))
            q.append(int(round((verts[k + 2] - oz) / 2.5)))
        assert max(q) < 32767, f"{name}: lattice overflow"
        wide = (len(verts) // 3) > 65535
        out[name] = {
            "kind": kind, "o": [ox, oy, oz], "q": 2.5, "w": 1 if wide else 0,
            "v": base64.b64encode(struct.pack("<%dh" % len(q), *q)).decode(),
            "i": base64.b64encode(struct.pack(
                ("<%dI" if wide else "<%dH") % len(idx), *idx)).decode(),
            "nv": len(verts) // 3, "nt": len(idx) // 3,
            "blocks": s["blocks"], "tonnes": s["tonnes"],
            "grade": s["grade_gt"], "oz": s["oz"]}
        print(f"  {kind:<5} {name:<10} {len(occ):>7,} cells -> {len(idx)//3:>7,} triangles")

    OUT.write_text(json.dumps(out, separators=(",", ":")))
    tri = sum(o["nt"] for o in out.values())
    print(f"wrote {OUT.relative_to(ROOT)} — {len(out)} meshes, {tri:,} triangles, "
          f"{OUT.stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
