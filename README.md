# Orebody

Georeferenced 3D geological visualization + presentation for the mining sector —
a lightweight, embeddable alternative to VRIFY Present. Puts block models and
drill data on real terrain in the browser, with narrated fly-through tours and
export to video/stills for PowerPoint & PDF.

## Live demo
Elk Gold — Siwash North (Cariboo, BC): a real Nov-2021 MineSight block model
(168k mineralized blocks) rendered on real Esri terrain, grade-coloured, with a
live cut-off, orbit + preset views, and grade-tonnage stats.

## Stack
- **CesiumJS** — georeferenced globe, real terrain (Esri World Elevation) + satellite imagery
- **proj4** — UTM 10N (NAD83) → WGS84 reprojection
- Self-contained static build (block data inlined) — deploys anywhere

## Regenerate the viewer
`tools/build_cesium.py` reads `data/elk_ore_blocks.csv` (x,y,z,AuEq,Percent_Env)
and writes `index.html`. Source block-model CSV is git-ignored (too large).

## Status
Phase 1 POC — block model on terrain. Next: drill holes (collar/survey/assay),
narrated tours, embed widget, PPTX/PDF export.

_Illustrative visualization — not a mineral resource statement._
