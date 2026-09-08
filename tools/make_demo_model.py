#!/usr/bin/env python3
"""Bedrock — generate the FABRICATED demo block model.

    python3 tools/make_demo_model.py [out.csv]

WHAT THIS REPLACES
------------------
The demo used to be a real property, derived from a third-party issuer's
2021 MineSight export. That put someone else's resource model, their vein
domain names, their claim block and their surveyed coordinates into a public
repository and onto a public site.
Renaming it would not have fixed that — a block model is a fingerprint, and
168,000 blocks with a given geometry and grade distribution can be matched
back to a published resource by anyone who cares to try.

So there is no longer a real deposit anywhere in this repository. This script
invents one, and everything downstream is built from its output.

WHAT THIS IS
------------
An invented orebody. No drilling, no sampling, no resource. The grades come
from a seeded random number generator shaped into tabular bodies by a few
planes. The numbers are internally consistent — tonnage, grade and contained
metal all reconcile — because a demo that cannot survive its own arithmetic
teaches the viewer nothing. They describe nothing in the ground.

It is deliberately sited hundreds of kilometres from the property it
replaced, in remote Coast Mountains wilderness, and it is deliberately NOT
shaped like it: fewer domains, a different orientation, different tonnes and
a different grade. Anyone comparing the two should find nothing to line up.

The domains are named DZ-01..DZ-22 rather than given geological names,
because a plausible domain name is exactly the kind of detail that makes a
fabricated model read as a real one.

GRID
----
10 x 5 x 5 m blocks at 2.7 t/m3 — the same lattice tools/extract_blocks.py
assumes when it converts block counts to tonnes. Those constants are hard
coded there, so this must match them or every tonnage downstream is wrong.

FORMAT
------
Only the columns the extractor actually reads, in the same shape the native
export had: x, y, z, Classification, Type, AuEq, Percent_Env and one
Percent_<domain> per domain. The extractor discovers the domain list from
those Percent_ headers, so adding a domain here needs no change there.
"""
import csv, math, random, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "demo_model_source.csv"

SEED = 20260904
# Remote Coast Mountains wilderness, UTM 10N. Round numbers on purpose: a
# surveyed-looking origin invites someone to go looking for the survey.
ORIGIN_E, ORIGIN_N = 270_000.0, 5_833_000.0
# Sampled Cesium terrain over this footprint runs 1,107 m to 1,287 m. The
# model has to sit UNDER that: at the old value its top stood at 1,648 m,
# which put 500 m of orebody in mid-air above the mountain and left the
# underground hole view with no ground to be under. Top of the model now
# lands near 1,020 m — a little under 90 m below the lowest ground.
BASE_Z = 870.0

DX, DY, DZ_ = 10.0, 5.0, 5.0            # block dims — must match extract_blocks.py
PLANE_STEP = 2.5                         # sampling pitch over each vein plane
N_DOMAINS = 22


def domains(rng):
    """Tabular bodies on a common NE structural trend, fanned about it.

    One shared trend with scatter, rather than random orientations: a vein
    field with no structural grain looks like noise, and the viewer's whole
    argument is that the shape means something."""
    out = []
    for i in range(N_DOMAINS):
        name = f"DZ-{i + 1:02d}"
        strike = math.radians(rng.uniform(34, 52))       # NE trend, fanned
        dip = math.radians(rng.uniform(68, 86))
        # Spread the field across roughly 1.4 x 0.9 km in plan.
        cx = ORIGIN_E + rng.uniform(-700, 700)
        cy = ORIGIN_N + rng.uniform(-450, 450)
        cz = BASE_Z - rng.uniform(40, 260)
        out.append({
            "name": name,
            "c": (cx, cy, cz),
            "strike": strike,
            "dip": dip,
            "len": rng.uniform(260, 780),               # along strike, m
            "dip_ext": rng.uniform(150, 420),           # down dip, m
            "t_mean": rng.uniform(0.7, 2.1),            # true thickness, m
            "grade_mu": rng.uniform(-0.55, 0.20),       # lognormal mu
            "shoots": [(rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5),
                        rng.uniform(0.13, 0.30), rng.uniform(1.6, 5.2))
                       for _ in range(rng.randint(1, 3))],
        })
    return out


def main():
    rng = random.Random(SEED)
    doms = domains(rng)
    names = [d["name"] for d in doms]

    # block key -> {domain: ore volume m3}, and -> accumulated metal grams
    vol = defaultdict(lambda: defaultdict(float))
    metal = defaultdict(float)

    for d in doms:
        cx, cy, cz = d["c"]
        sa, dip = d["strike"], d["dip"]
        # Strike unit vector, and the down-dip vector in the vein plane.
        sx, sy, sz = math.sin(sa), math.cos(sa), 0.0
        dx_ = math.cos(sa) * math.cos(dip)
        dy_ = -math.sin(sa) * math.cos(dip)
        dz_ = -math.sin(dip)

        ns = max(2, int(d["len"] / PLANE_STEP))
        nd = max(2, int(d["dip_ext"] / PLANE_STEP))
        cell = PLANE_STEP * PLANE_STEP          # plane area each sample carries

        for i in range(ns):
            u = (i / (ns - 1) - 0.5)            # -0.5 .. 0.5 along strike
            for j in range(nd):
                v = (j / (nd - 1) - 0.5)        # -0.5 .. 0.5 down dip

                # Taper to zero at the edges so bodies end, rather than being
                # cut off square by the loop bounds.
                taper = math.cos(math.pi * u) ** 0.6 * math.cos(math.pi * v) ** 0.5
                if taper <= 0.04:
                    continue
                t = d["t_mean"] * taper * rng.uniform(0.55, 1.45)
                if t <= 0.02:
                    continue

                su, sv = u * d["len"], v * d["dip_ext"]
                x = cx + sx * su + dx_ * sv
                y = cy + sy * su + dy_ * sv
                z = cz + sz * su + dz_ * sv

                # Grade: lognormal background, lifted inside high-grade shoots.
                g = rng.lognormvariate(d["grade_mu"], 0.34)
                for su0, sv0, rad, amp in d["shoots"]:
                    r = math.hypot(u - su0, v - sv0)
                    g += amp * math.exp(-(r * r) / (2 * rad * rad))
                g = min(g, 62.0)                # cap wild lognormal tails
                if g <= 0.02:
                    continue

                bx = math.floor(x / DX) * DX + DX / 2
                by = math.floor(y / DY) * DY + DY / 2
                bz = math.floor(z / DZ_) * DZ_ + DZ_ / 2
                dv = cell * t
                vol[(bx, by, bz)][d["name"]] += dv
                metal[(bx, by, bz)] += dv * g

    block_m3 = DX * DY * DZ_
    rows = 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["x", "y", "z", "FixedDensity", "Classification", "Type",
                    "AuEq", "Percent_Env"] + [f"Percent_{n}" for n in names])

        for (bx, by, bz), shares in sorted(vol.items()):
            total_v = sum(shares.values())
            if total_v <= 0:
                continue
            grade = metal[(bx, by, bz)] / total_v
            if grade <= 0:
                continue
            penv = min(total_v / block_m3, 1.0)
            if penv < 0.0005:                   # below this a block is noise
                continue
            scale = penv * block_m3 / total_v   # renormalise if capped

            # Classification by how well tested the block would be: a drilled
            # core near surface, then a step out, then depth. Provisional by
            # construction — there is no drilling behind any of it.
            r = math.hypot(bx - ORIGIN_E, by - ORIGIN_N)
            depth = BASE_Z - bz
            if r < 420 and depth < 190:
                cls = 1
            elif r < 900 and depth < 330:
                cls = 2
            else:
                cls = 3

            dom = max(shares.items(), key=lambda kv: kv[1])[0]
            raw = {n: shares.get(n, 0.0) * scale / block_m3 for n in names}

            # The domain shares must sum to Percent_Env EXACTLY at the four
            # decimals written here, not merely close to it. Downstream,
            # extract_blocks.py rolls tonnage up two ways — once per domain
            # from these shares, once per block from Percent_Env — and asserts
            # the two agree to within a tonne. Rounding each share on its own
            # drifts by a fraction of a percent per block, which over 120,000
            # blocks is enough to trip that check. So round, then give the
            # residue to the largest domain, which is also the one whose own
            # figure it perturbs least.
            penv_r = round(penv, 4)
            per = {n: round(raw[n], 4) for n in names}
            resid = round(penv_r - sum(per.values()), 4)
            if resid:
                per[dom] = round(per[dom] + resid, 4)

            w.writerow([f"{bx:.1f}", f"{by:.1f}", f"{bz:.1f}", f"{2.7:.4f}",
                        cls, dom, f"{grade:.4f}", f"{penv_r:.4f}"]
                       + [f"{per[n]:.4f}" for n in names])
            rows += 1

    # Report what was made, so the numbers can be sanity-checked before the
    # rest of the pipeline bakes them in.
    tonnes = sum(min(sum(s.values()) / block_m3, 1.0) for s in vol.values()) * block_m3 * 2.7
    grams = sum(metal.values()) * 2.7
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  blocks     {rows:,}")
    print(f"  domains    {len(names)}")
    print(f"  tonnes     {tonnes / 1e6:,.2f} Mt")
    print(f"  grade      {grams / tonnes:,.2f} g/t AuEq")
    print(f"  ounces     {grams / 31.10348 / 1e3:,.0f} koz")


if __name__ == "__main__":
    main()
