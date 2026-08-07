# Orebody

Georeferenced 3D geological visualization + presentation for the mining sector —
a lightweight, embeddable alternative to VRIFY Present. Puts block models and
drill data on real terrain in the browser, with a narrated chapter walkthrough,
an analytical Explore mode, and export to PPTX/PDF/PNG for decks.

## Live demo

Elk Gold — Siwash North (Nicola region, BC — southeast of Merritt): a real Nov-2021 MineSight block model
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

**Presenting** — 15-chapter deck in five named sections, mixing corporate slides,
analytical charts and live 3D scenes ·
thumbnail slide navigator · autoplay with per-chapter dwell · speech-synthesis
narration · live freehand annotation over the 3D view · deep-linkable state ·
**asset-only mode** · **screen recording to MP4** · **embed kit** ·
export to PNG / PPTX / PDF · offline via service worker.

**The model** — discrete opaque grade shells · vein domains as watertight
geological surfaces · colour-pop property masking · colour by grade, resource class
or vein domain · cut-off ladder · isolation of any of the 46 vein domains with
exact share-weighted grade-tonnage · labelled depth grid · vertical
exaggeration · ground cut-away over the deposit.

**The site** — drill traces as rods with grade bars and collar labels · claim
boundary · conceptual pit, waste rock facility, heap leach pad and haul road ·
named labels on leader lines · mine-plan timeline of stepped pit stages ·
four ground-level vantages with a full-horizon sweep · fabricated magnetics
(TMI / RTP / 1VD) draped on terrain · pinned scene captions · presenter-drawn
areas clamped to the ground, coloured, labelled and exportable as GeoJSON ·
a drill ledger of the holes in view with downhole grade graphs · a deposit
switcher carrying a second, fabricated orebody.

## Build

```bash
python3 tools/extract_blocks.py [path/to/source_BM.csv]   # → data/*.csv, data/*.json
python3 tools/make_synthetic_drills.py 40                 # → data/synthetic/  (demo only)
python3 tools/make_synthetic_site.py                      # → data/synthetic/  (demo only)
python3 tools/extract_surfaces.py 8                       # → data/elk_surfaces.json
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

## Asset-only mode

`Asset` / `A` strips every overlay — drill traces, intercept highlights, site
infrastructure, pit stages, the depth grid, the plan raster, any section, pinned
captions and ink — leaving the orebody on terrain and nothing else. It is a
*mode*, not a one-shot: it survives chapter changes, and toggling it off
restores exactly the state you were in. For the moment in a meeting where
someone says "just show me the deposit."

## Recording

`Rec` / `R` records a walkthrough — every camera move, toggle and annotation —
straight to a file. It records a **compositor canvas**, not the WebGL canvas:
each frame redraws Cesium's output, then the presenter's ink, then the
fabricated-data disclaimer, and the recorder captures *that*. Recording the
WebGL canvas directly would have produced clean footage of fabricated drill
holes with no disclaimer on it. MP4 (`avc1`) where the browser supports it,
WebM otherwise.

## Embed kit

`Embed` builds the thing a non-technical person actually needs to get this onto
a corporate website: a responsive iframe snippet sized to a chosen aspect ratio,
optionally opening on the current view rather than chapter 1. It pastes into a
WordPress Custom HTML block or an Elementor HTML widget with no build step. Also
emits `orebody-embed.html` (a standalone page wrapping the same snippet) and
`orebody-deck.json` (deck manifest — chapters, deposit figures, caveats).

The caption carries the fabricated-data sentence, but a caption can be deleted,
so it is not the disclosure — the embedded deck renders its own on-screen banner
regardless. Stripping the caption cannot produce an unlabelled embed.

The snippet is a *link*, not a copy: the deck streams its own terrain and model
data, so republishing updates every embed. The hosting address is editable
because a deck served from `localhost` embeds an address only its author can
reach; that case is called out in the dialog rather than silently shipped.

## Controls

`←` `→` chapters · `P` autoplay · `N` narration · `E` Explore panel ·
`A` asset only · `R` record · `D` draw

`?embed=1` strips the chrome for iframe embedding and autostarts on Begin;
add `&autoplay=0` to embed it paused.
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
- **The second deposit is FABRICATED.** There is no Nicola South.
  `tools/make_synthetic_deposit.py` invents it — every tonne, grade and ounce
  reported for it was generated, not measured. It is sited inside a real mineral
  tenure (516750) so the multi-deposit view could be built and tested against
  real ground; that does not make any of it real. The viewer's
  `BLOCKS_SYNTHETIC` flag comes from `synthetic:true` in its manifest and joins
  all five labelling paths — it is the gravest of them, because it is not a
  decoration over real numbers but the numbers themselves.
- **The geophysics is FABRICATED.** `tools/make_synthetic_geophysics.py`
  synthesises TMI / RTP / 1VD **from the block model**, so the anomaly sits over
  the deposit because it was built from it — it restates the model rather than
  corroborating it. Real gold systems are frequently magnetite-*destructive* and
  a real survey here could as easily show a magnetic low, so this may not even
  have the right sign. It is joined to the same five labelling paths as the
  drills and site features. Replace the rasters and set `synthetic:false` in
  `SYNTHETIC_geophysics.json` when a real survey exists.
- **Silver is absent.** `Ag_ppm` is zero for all 495,074 source blocks, so the
  AuEq in this export is effectively gold-only. Chapter copy says "gold system",
  not "gold-silver" — do not reintroduce the silver claim without checking
  whether it was dropped on export.

_Illustrative visualization — not a mineral resource statement._

## Status

Phases 1–4 complete, plus the presentation and site layers above.

The viewer no longer only renders the baked demo. Opened as `?t=<share token>`
it fetches a deck from the `deck` edge function and rebuilds itself from the
customer's own uploaded block model — extents, rollups, vein domains, tonnes per
block and chapters all come from the payload. Verified by hydrating the real Elk
Gold artifact through `dashboard/lib/extract.js` and landing on the baked deck's
totals to the tonne, from a different artifact and a different code path.

Not built: **multi-device synced sessions** (needs a realtime backend).

**True 360° site photography** is not built and will not be faked. The deck
answers it with four ground-level vantages derived from the block model, each
placed on terrain sampled at runtime, with a 26-second sweep of the full
horizon — real terrain under real satellite imagery, so nothing is fabricated
and it joins no labelling path. A synthetic photosphere would be the one
fabrication worth refusing: a photograph reads as evidence before anyone reaches
the caption, so an invented picture of a real place is the fabricated layer a
label cannot rescue. Underground imagery has no honest equivalent at all —
there is no terrain model of a heading.

### Vein surfaces

`extract_surfaces.py` turns each domain's blocks into a watertight triangle hull
by exterior-face extraction — a face is on the hull exactly when the neighbouring
cell is absent. This is deliberately not marching cubes: an interpolated
isosurface would invent geometry between the data points, and this tool's whole
claim is that it does not embellish. The result is faceted at block scale, which
is honest — that is the resolution of the data. Greedy meshing merges coplanar
faces into maximal rectangles, cutting 261,800 triangles to 86,208 and 8.0 MB to
2.3 MB. It is fetched lazily and cached by the service worker rather than
inlined, so it stays off the critical path.

Next: real drill and survey data, multi-deposit projects, a hosted embed
service, and section-plane slicing.
