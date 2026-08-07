# Orebody

Georeferenced 3D geological visualization + presentation for the mining sector —
a lightweight, embeddable alternative to VRIFY Present. Puts block models and
drill data on real terrain in the browser, with a narrated chapter walkthrough,
an analytical Explore mode, and export to PPTX/PDF/PNG for decks.

## Live demo

Elk Gold — Siwash North (Cariboo, BC): a real Nov-2021 MineSight block model
rendered on real Esri terrain.

- **168,013 mineralized blocks** — 8,985,428 t @ 3.80 g/t AuEq = **1,097,747 oz**
- **46 vein domains**, each isolatable with its own grade-tonnage
- Resource classification colouring, live cut-off, 11-chapter deck

## Stack

- **CesiumJS** — georeferenced globe, real terrain (Esri World Elevation) + satellite imagery
- **proj4** — UTM 10N (NAD83) → WGS84 reprojection
- Self-contained static build — block data, fonts and drill traces all inlined;
  deploys anywhere as a single file

## Features

**Presenting** — 11-chapter deck mixing corporate slides with live 3D scenes ·
thumbnail slide navigator · autoplay with per-chapter dwell · speech-synthesis
narration · live freehand annotation over the 3D view · deep-linkable state ·
embed mode · export to PNG / PPTX / PDF · offline via service worker.

**The model** — discrete opaque grade shells · colour by grade, resource class
or vein domain · cut-off ladder · isolation of any of the 46 vein domains with
exact share-weighted grade-tonnage · labelled depth grid · vertical
exaggeration · ground cut-away over the deposit.

**The site** — drill traces as rods with grade bars and collar labels · claim
boundary · conceptual pit, waste rock facility, heap leach pad and haul road ·
named labels on leader lines · mine-plan timeline of stepped pit stages ·
ground-level site view.

## Build

```bash
python3 tools/extract_blocks.py [path/to/source_BM.csv]   # → data/*.csv, data/*.json
python3 tools/make_synthetic_drills.py 40                 # → data/synthetic/  (demo only)
python3 tools/make_synthetic_site.py                      # → data/synthetic/  (demo only)
python3 tools/build_present.py                            # → index.html + sw.js
python3 tools/capture_thumbs.py                           # → tools/assets/thumbs.json
python3 tools/build_present.py                            # again, to embed them
```

The source block-model CSV (1.2 GB) is git-ignored. `extract_blocks.py` reads it
once and emits the small files everything else builds on. Thumbnails are
two-pass because they are pictures of the built page.

## How the numbers stay honest

Rendering and reporting are deliberately decoupled.

Geometry is bucketed by `(class, grade-bin, depth-band)` into 268 uniform-colour primitives,
so changing the cut-off, toggling a class, or recolouring is a handful of
primitive toggles rather than a rebuild of 168k boxes. But the figures in the
readout are **not** derived from what is drawn — they are summed from exact
rollups computed over every mineralized block at build time. Filter the view
however you like; the tonnage does not drift.

The corollary matters just as much: every filter that removes geometry must also
remove it from the sum. Hiding the low-grade halo once changed the picture and
not the number, over-reporting the drawn model by 0.92 Mt. The readout applies
the same predicate the renderer does.

Two rollup tables exist, and picking the wrong one is the trap:

| Table | Keyed by | Used when | Why |
|---|---|---|---|
| `buckets` | vein, class, grade-bin | a vein is isolated | tonnage **share-weighted** per vein |
| `by_cb` | class, grade-bin | all veins | block count stays **distinct** |

**A block is not owned by one vein.** 18,367 of 168,013 mineralized blocks
(10.9%) straddle two or more domains, and the source carries a `Percent_<vein>`
share for each. Crediting a whole block to its `Type` vein — the obvious reading —
overstated vein 2400 by 34% in contained ounces and understated 1300E by 16%,
while deposit totals still reconciled exactly, which is what made it easy to
miss. The `vein` column in `elk_blocks_v2.csv` is the *dominant* domain and is a
rendering hint only. Never roll tonnage up from it.

Tonnage is real, not a proxy: blocks are 10 × 5 × 5 m at a uniform 2.7 t/m³, so a
whole block is 675 t and its ore tonnage is `675 × Percent_Env`. Both rollup
tables assert-reconcile to the deposit total at build time.

## Controls

`←` `→` chapters · `P` autoplay · `N` narration · `E` Explore panel

`?embed=1` strips the chrome for iframe embedding and autostarts on Begin.
The URL hash carries full state (chapter, colour mode, cut-off, vein, classes,
drills), so any view can be linked to — the **Link** button copies it.

## Data caveats

Read these before showing anything to anyone.

- **Resource class labels are unconfirmed.** The 1/2/3 → Measured/Indicated/Inferred
  mapping follows the usual MineSight convention but has not been checked against
  the Nov-2021 technical report. The split (53,380 / 111,317 / 1,209 blocks, with
  class 3 running 10.7 g/t) is an unusual shape for a normal resource. The viewer
  surfaces this as a caveat and it also appears on every exported slide.
- **Drill holes AND all site features are FABRICATED.** `data/synthetic/` is generated by
  `tools/make_synthetic_drills.py`; no drilling happened and these are not Elk
  Gold results. They exist so the drill-trace feature could be built before real
  collar/survey/assay data was obtained. They are labelled four ways: `SYN-` hole
  ids, `SYNTHETIC_` filenames, a `data_source` column on every row, and
  `manifest.json: synthetic:true`, which drives a permanent on-screen warning.
  To swap in real data, replace the CSVs and set `synthetic:false`.
  The same applies to `SYNTHETIC_site_features.json` — the claim boundary, pit,
  waste rock facility, heap leach pad, haul road and pit stages are **invented**
  and are not a mine plan, tenure or permit. Fabricated infrastructure drawn on
  a real mountain reads as a real mine plan, so a single function enumerates
  every fabricated layer that is visible and drives one banner; the same
  enumeration is burned into exported bitmaps and printed on every deck slide.
- **Silver is absent.** `Ag_ppm` is zero for all 495,074 source blocks, so the
  AuEq in this export is effectively gold-only. Chapter copy says "gold system",
  not "gold-silver" — do not reintroduce the silver claim without checking
  whether it was dropped on export.

_Illustrative visualization — not a mineral resource statement._

## Status

Phases 1–4 complete, plus the presentation and site layers above.

Not built, because each needs infrastructure this static build does not have:
**multi-device synced sessions** (needs a realtime backend), **content
management** (needs auth + storage), and **true 360° site photography** (needs
someone to go and shoot it — the ground-level view renders real terrain
instead, which is honest but is not the same thing).

Next: real drill and survey data, multi-deposit projects, a hosted embed
service, and section-plane slicing.
