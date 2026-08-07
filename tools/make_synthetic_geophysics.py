#!/usr/bin/env python3
"""Generate a FABRICATED airborne magnetic survey over the Elk Gold extent.

    python3 tools/make_synthetic_geophysics.py [grid]

Writes data/synthetic/SYNTHETIC_geophys_{tmi,rtp,1vd}.png and a manifest.

WHAT THIS IS NOT
----------------
This is not a magnetic survey. No magnetometer was flown over Siwash North for
this, and no published geophysical data was used. It is a plausible-looking
field synthesised from the block model itself: the modelled grade shells are
treated as magnetic sources, smoothed, and given a regional gradient and some
correlated noise. It will look like magnetics to a geophysicist across a room
and like nonsense to one holding a mouse, which is exactly the risk.

That risk is why every product carries `synthetic: true`, a `data_source` of
SYNTHETIC, and a warning string in the manifest. The viewer refuses to draw a
synthetic layer without a banner, and burns the disclaimer into exports. If you
ever replace this with a real survey, set synthetic to false in the manifest
and the banner goes away on its own — do not strip the flag to hide the label.

Deliberately derived FROM the orebody, so the anomaly sits over the deposit and
the layer is pedagogically honest about being a restatement of what you already
see, rather than pretending to be independent evidence that confirms it.
"""
import csv, json, math, random, struct, sys, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "elk_blocks_v2.csv"
OUTDIR = ROOT / "data" / "synthetic"
SEED = 20260807
MARGIN = 600.0            # m of padding beyond the model extent
GRID = int(sys.argv[1]) if len(sys.argv) > 1 else 320

random.seed(SEED)

# ------------------------------------------------------------------ sources
xs, ys, gs = [], [], []
with open(SRC, newline="") as f:
    for r in csv.DictReader(f):
        xs.append(float(r["x"])); ys.append(float(r["y"])); gs.append(float(r["aueq"]))
if not xs:
    raise SystemExit("no blocks — run tools/extract_blocks.py first")

EMIN, EMAX = min(xs) - MARGIN, max(xs) + MARGIN
NMIN, NMAX = min(ys) - MARGIN, max(ys) + MARGIN
EX, EY = EMAX - EMIN, NMAX - NMIN

W = H = GRID
field = [[0.0] * W for _ in range(H)]
for x, y, g in zip(xs, ys, gs):
    c = int((x - EMIN) / EX * (W - 1))
    r = int((y - NMIN) / EY * (H - 1))
    # Grade stands in for magnetite content. Real gold systems are often
    # magnetite-DESTRUCTIVE, so a real survey over this could as easily show a
    # low. Another reason this must never be read as evidence.
    field[r][c] += g


def blur(a, passes=3, k=2):
    """Separable box blur. No numpy/scipy in this toolchain, and a hand-rolled
    box blur run a few times is a close enough Gaussian for a fake field."""
    h, w = len(a), len(a[0])
    for _ in range(passes):
        b = [[0.0] * w for _ in range(h)]
        for r in range(h):
            row = a[r]; acc = 0.0
            for c in range(w):
                lo, hi = max(0, c - k), min(w - 1, c + k)
                acc = sum(row[lo:hi + 1])
                b[r][c] = acc / (hi - lo + 1)
        a = b
        b = [[0.0] * w for _ in range(h)]
        for c in range(w):
            for r in range(h):
                lo, hi = max(0, r - k), min(h - 1, r + k)
                s = 0.0
                for rr in range(lo, hi + 1):
                    s += a[rr][c]
                b[r][c] = s / (hi - lo + 1)
        a = b
    return a


src = blur(field, passes=4, k=3)

# Regional gradient + long-wavelength noise: a real TMI grid is never just the
# target. Without a regional the anomaly reads as a sticker on a flat plate.
noise = [[random.gauss(0, 1) for _ in range(W)] for _ in range(H)]
noise = blur(noise, passes=5, k=4)
mx = max(max(r) for r in src) or 1.0
nx = max(abs(v) for r in noise for v in r) or 1.0

tmi = [[0.0] * W for _ in range(H)]
for r in range(H):
    for c in range(W):
        regional = 260.0 * (c / W) - 140.0 * (r / H)
        tmi[r][c] = 900.0 * (src[r][c] / mx) + 240.0 * (noise[r][c] / nx) + regional

# RTP: reduction to the pole removes the dipole asymmetry that inclination puts
# into TMI, so the anomaly sits over its source instead of beside it. Faked by
# shifting the field back by the offset a ~73 degree inclination would produce.
shift = max(1, int(W * 0.012))
rtp = [[tmi[min(H - 1, r + shift)][c] for c in range(W)] for r in range(H)]
rtp = blur(rtp, passes=1, k=1)

# 1VD: first vertical derivative sharpens edges. High-pass = field minus a
# heavily smoothed copy of itself.
lowpass = blur(rtp, passes=6, k=5)
fvd = [[rtp[r][c] - lowpass[r][c] for c in range(W)] for r in range(H)]

# ------------------------------------------------------------------- colour
RAMP = [(0, (12, 22, 92)), (0.18, (18, 92, 170)), (0.36, (26, 158, 148)),
        (0.52, (104, 186, 78)), (0.68, (232, 206, 62)), (0.84, (226, 122, 42)),
        (1.0, (176, 26, 38))]


def ramp(t):
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    for i in range(len(RAMP) - 1):
        a, ca = RAMP[i]; b, cb = RAMP[i + 1]
        if a <= t <= b:
            k = 0.0 if b == a else (t - a) / (b - a)
            return tuple(int(ca[j] + (cb[j] - ca[j]) * k) for j in range(3))
    return RAMP[-1][1]


def png(path, grid, alpha=225):
    """Minimal RGBA PNG writer. Percentile-clipped so a couple of extreme cells
    cannot flatten the whole image into one colour."""
    flat = sorted(v for row in grid for v in row)
    lo = flat[int(len(flat) * 0.02)]
    hi = flat[int(len(flat) * 0.98)]
    rng = (hi - lo) or 1.0
    raw = b""
    # PNG rows are top-down; our grid row 0 is the SOUTH edge, so emit reversed
    # or the survey comes out mirrored against the terrain.
    for r in range(len(grid) - 1, -1, -1):
        raw += b"\x00"
        row = bytearray()
        for v in grid[r]:
            cr, cg, cb = ramp((v - lo) / rng)
            row += bytes((cr, cg, cb, alpha))
        raw += bytes(row)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", len(grid[0]), len(grid), 8, 6, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


OUTDIR.mkdir(parents=True, exist_ok=True)
products = [
    ("tmi", "Total Magnetic Intensity", tmi, "nT",
     "Total field, fabricated from the modelled grade shells."),
    ("rtp", "TMI Reduced to Pole", rtp, "nT",
     "Fabricated RTP — the anomaly moved over its source."),
    ("1vd", "RTP First Vertical Derivative", fvd, "nT/m",
     "Fabricated 1VD — edges of the fabricated bodies."),
]
for key, label, grid, unit, note in products:
    png(OUTDIR / f"SYNTHETIC_geophys_{key}.png", grid)

man = {
    "synthetic": True,
    "warning": "FABRICATED GEOPHYSICS — not a survey. Synthesised from the "
               "block model; no magnetometer data was used and no published "
               "geophysical data was consulted. Not evidence of anything.",
    "generator": "tools/make_synthetic_geophysics.py",
    "data_source": "SYNTHETIC",
    "seed": SEED,
    "crs": "EPSG:26910",
    "grid": GRID,
    "extent_utm": {"emin": EMIN, "nmin": NMIN, "emax": EMAX, "nmax": NMAX},
    "products": [{"key": k, "label": l, "unit": u, "note": n,
                  "file": f"SYNTHETIC_geophys_{k}.png"}
                 for k, l, _, u, n in products],
}
(OUTDIR / "SYNTHETIC_geophysics.json").write_text(json.dumps(man, indent=2))

print(f"wrote {len(products)} FABRICATED geophysics rasters ({GRID}x{GRID})")
for k, l, _, _, _ in products:
    print(f"  SYNTHETIC_geophys_{k}.png  {l}")
print(f"  extent {EMIN:.0f},{NMIN:.0f} -> {EMAX:.0f},{NMAX:.0f} (EPSG:26910)")
