# Orebody — development tracking

Living backlog of what the product needs next. Each item is also a GitHub issue
in `shayne-wq/orebody`; this file is the at-a-glance index. Check items off here
and close the issue when done.

Status: 🔴 not started · 🟡 in progress · 🟢 done

---

## Context driving this backlog

Two facts reshape the roadmap:

1. **Most projects are pure exploration.** They have drilling, geophysics and
   geochem but **no block model and no economics**. A block model is a
   **production / feasibility-stage** artifact — built only once a mineable
   resource is being defined — so greenfield and drill-stage projects won't
   have one for years, if ever. Making the block model optional is the
   highest-priority change.
2. **Magnetics is the backbone of exploration data.** The current geophysics
   slot only stores an uploaded image. Real magnetic grids — georeferenced,
   typed (TMI/RTP/1VD…), with a legend — need first-class support.

Already shipped (branch `claude/mining-software-names-y8rql9`, commit `b916ee1`):
projects hold **multiple zones**, each with its own block model, drills,
surfaces, property and geophysics; a deck records the zones it spans. The
**authoring/upload path is done**; the viewer still renders a single deposit.

---

## P0 — exploration blockers

- [ ] 🟡 **#1 — Support pure-exploration projects: make the block model optional.**
  Console side **done** (block model no longer required; decks gate on any data;
  economics drop out without a model). Remaining: viewer/edge must boot & present
  a model-less hydrated deck. <https://github.com/shayne-wq/orebody/issues/1>
- [ ] 🔴 **#2 — First-class magnetic / geophysics data.** Grids (GeoTIFF, XYZ,
  Geosoft), georeferencing + CRS, product typing, legend, draped rendering.
  <https://github.com/shayne-wq/orebody/issues/2>

## P1 — makes multi-zone and exploration real

- [ ] 🔴 **#3 — Render multiple zones in the viewer.** Deposit switcher reads
  `decks.settings.zones`; edge function emits one deposit per zone.
  <https://github.com/shayne-wq/orebody/issues/3>
- [ ] 🔴 **#4 — Exploration-first deck template.** Property, geology, magnetics,
  geochem, drill highlights, targets, the ask — seeded from available data.
  <https://github.com/shayne-wq/orebody/issues/4>
- [ ] 🔴 **#5 — Geochemistry dataset kind** (soil / rock / stream sediment).
  <https://github.com/shayne-wq/orebody/issues/5>

## P2 — parsing & authoring polish

- [ ] 🔴 **#6 — Parse & desurvey drill data on upload** (traces + intercepts).
  Currently the collars/surveys/assays CSVs are stored but not parsed.
  <https://github.com/shayne-wq/orebody/issues/6>
- [ ] 🔴 **#7 — Parse surface meshes (OBJ/DXF)** into the viewer's format.
  <https://github.com/shayne-wq/orebody/issues/7>
- [ ] 🔴 **#8 — Deck editor: choose/reorder zones, per-zone cut-off & economics
  toggle.** <https://github.com/shayne-wq/orebody/issues/8>

---

## Data the deck can consume (per zone)

| Dataset | Required (resource) | Required (exploration) | Format | Notes |
|---|---|---|---|---|
| Block model | ✅ | ❌ (see #1) | native CSV, read in-browser | drives tonnage/grade/economics |
| Magnetics / geophysics | optional | often the primary evidence (#2) | grid/raster + CRS | TMI/RTP/1VD, legend |
| Drill holes | optional | common | collars/surveys/assays CSV (#6) | desurvey → traces + intercepts |
| Geochemistry | — | common (#5) | sample CSV | soil/rock/stream anomalies |
| Surfaces | optional | rare | OBJ/DXF/JSON (#7) | vein / grade shells |
| Property & claims | optional | recommended | GeoJSON | claim extent, colour-pop |

---

_Backlog opened 2026-08-08. Update this file and the linked issues as work lands._
