# Orebody — development tracking

Living backlog of what the product needs next. Each item is also a GitHub issue
in `shayne-wq/orebody`; this file is the at-a-glance index. Check items off here
and close the issue when done.

Status: 🔴 not started · 🟡 in progress · 🟢 done

---

## Comparables-driven priorities (2026-08-10) — read this section first

Ranked from `docs/COMPARISON.md` and both competitive audits, not from the
exploration/magnetics backlog below (that predates this and may now overlap
with work already shipped on `main` — see the branch-reconciliation note at
the end of this file). These 5 were chosen over 5 other candidates (better
public-basemap terrain, a district/M&A narrative chapter, a custom/white-
label domain) because they **protect or extend the core differentiator**
`COMPARISON.md` identifies — self-serve is safe, provenance is exact, the
neighbour-registry advantage is real — rather than adding new surface area
on top of an unverified floor. Cesium/terrain-realism work stays exactly
where it was: Phase 2, issue #10, unchanged by this pass.

- [ ] 🔴 **#11 — Fix the mobile boot failure.** `COMPARISON.md`'s own words:
  "the most serious open defect." Everything else is moot if the deck
  doesn't open on the device it's most often opened on. Real blocker is
  access to real-device testing, not code — see the issue.
  <https://github.com/shayne-wq/orebody/issues/11>
- [ ] 🔴 **#12 — Harden sub-blocked model detection.** Protects the single
  stated differentiator over both competitors: "the deck cannot state a
  number the model does not support." A known gap here is a crack in that
  guarantee, not a feature gap.
  <https://github.com/shayne-wq/orebody/issues/12>
- [ ] 🔴 **#13 — GeoTIFF ingestion.** Named VRIFY advantage, fix already
  verified (`geotiff.js`, free, actively maintained, decodes client-side).
  Highest ROI item on the list.
  <https://github.com/shayne-wq/orebody/issues/13>
- [ ] 🔴 **#14 — Registry-lookup beyond BC.** The flagship differentiator
  (neighbours from a register, not self-asserted) only works in one
  Canadian province today; every confirmed Terrahutton customer sits
  outside it (Colombia, Argentina, Peru, Finland).
  <https://github.com/shayne-wq/orebody/issues/14>
- [ ] 🔴 **#15 — QA the two never-clicked flows.** Neighbour logo upload and
  the registry fetch button — "everything behind them is tested; the
  buttons are not." Do this before #14 extends the same flows further.
  <https://github.com/shayne-wq/orebody/issues/15>

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

Competitive audits: `docs/vrify-audit.md` (hands-on, feature-complete) and
`docs/terrahutton-audit.md` (mostly reconstructed from marketing copy — the
domain is network-blocked from this session — except one directly-viewed,
confirmed feature: neighbor logos on the surrounding-claims map, tracked as
#9 below).

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
- [ ] 🔴 **#9 — Neighbor/competitor logos on surrounding claims.** Upload a
  logo per neighboring operator so the district map shows whose ground is
  whose visually, not just a text label. Confirmed-by-viewing feature from
  the Terrahutton audit — the one fully hands-on-verified finding in it.
  <https://github.com/shayne-wq/orebody/issues/9>

## P2 — parsing & authoring polish

- [ ] 🔴 **#6 — Parse & desurvey drill data on upload** (traces + intercepts).
  Currently the collars/surveys/assays CSVs are stored but not parsed.
  <https://github.com/shayne-wq/orebody/issues/6>
- [ ] 🔴 **#7 — Parse surface meshes (OBJ/DXF)** into the viewer's format.
  <https://github.com/shayne-wq/orebody/issues/7>
- [ ] 🔴 **#8 — Deck editor: choose/reorder zones, per-zone cut-off & economics
  toggle.** <https://github.com/shayne-wq/orebody/issues/8>

---

## Phase 2 — enhanced maps & terrain realism (deferred by design)

Ship what exists now; this is its own phase, not mixed into the backlog
above. Scope corrected 2026-08-10: **no client-supplied imagery or footage
of any kind** — customer-uploaded orthophoto draping and a drone-
photogrammetry reality mesh were both cut. Reasoning: photography/footage
carries no backing number, unlike every other input this product handles,
and it's closer to VRIFY's art-directed, done-for-you model than to
Orebody's "nothing on screen the data doesn't support" thesis — see the
issue for the full writeup. What remains: sun-synced lighting/shadows/fog on
the existing **public** basemap (needs real visual QA before shipping — this
sandbox can't render-test Cesium changes) and a Cesium ion evaluation for
better **public** terrain/imagery (pricing researched 2026-08-09, see the
issue). The existing 360° ground-level vantage points are unaffected — they
already stand a virtual camera on real terrain under the public basemap, no
client imagery involved.

- [ ] 🔴 **#10 — Enhanced maps & terrain realism (public-data only).**
  <https://github.com/shayne-wq/orebody/issues/10>

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
