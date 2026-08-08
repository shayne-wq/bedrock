# Orebody — development tracking

Living backlog of what the product needs next. Each item is also a GitHub issue
in `shayne-wq/orebody`; this file is the at-a-glance index. Check items off here
and close the issue when done.

Status: 🔴 not started · 🟡 in progress · 🟢 done

---

## Context driving this backlog

Two facts reshape the roadmap:

1. **Most projects are pure exploration.** They have drilling, geophysics and
   geochem but **no block model and no economics** — a resource (and therefore
   tonnage/grade/ounces) comes much later. The console today *requires* a block
   model per zone, which locks these projects out. Making the block model
   optional is the highest-priority change.
2. **Magnetics is the backbone of exploration data.** The current geophysics
   slot only stores an uploaded image. Real magnetic grids — georeferenced,
   typed (TMI/RTP/1VD…), with a legend — need first-class support.

Already shipped: projects hold **multiple zones**, each with its own block
model, drills, surfaces, property and geophysics; a deck records the zones it
spans. The **authoring/upload path is done**; the viewer still renders a single
deposit (#3).

The tracking branch is now **merged into `main`** — it had diverged from a
night of viewer work (WebGL fallback, boot diagnostics, externalised block
model), and two sources of truth is one too many.

---

## P0 — exploration blockers

- [x] 🟢 **#1 — Support pure-exploration projects: make the block model optional.**
  <https://github.com/shayne-wq/orebody/issues/1>
  **Viewer done.** A deck with no `blocks` dataset no longer throws; it enters
  exploration mode. `N=0` is the mechanism — every model-driven loop walks
  `RUNS` or counts to `N`, so an empty model no-ops the render path without a
  conditional in it. What changed is what the deck *says*:
  - the readout reports `—` and "Exploration stage", never `0 t @ 0 g/t`,
    which would be a measurement claim rather than an absence of one;
  - cut-off, colour-by, class chips, vein select, surfaces, plan, section and
    the deposit switcher are hidden, not disabled — dead inputs invite a
    presenter to keep pressing them;
  - the audit trail lists the datasets that DO exist and states plainly that
    no resource has been established.
  A camera still needs an extent: taken from `deck.settings.extent` or any
  asset carrying `stats.bounds`, and refused with a clear message if neither
  exists, because an exploration deck pointed at the wrong hemisphere is worse
  than one that admits it cannot place itself.
  Verified against a fixture deck with drills + geophysics and no block model.
  **Console half outstanding:** `dashboard/app.js` still marks the block model
  `req: true`, so the UI presses for one. Flipping the flag is trivial; what
  needs thought is what the zone card shows in its place.
  Three Elk-specific lines were leaking into every hydrated deck and are now
  scoped: the class-mapping caveat (printed for projects with no classes), its
  orphaned second line, and "Silver is absent from the source".
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

## Log

- **2026-08-08** — #1 viewer half shipped (exploration mode). Tracking branch
  merged to `main`. Elk-specific audit caveats scoped so hydrated decks stop
  inheriting claims about a source file they have never seen.
- **2026-08-08** — Mobile: iOS Safari refused this page a WebGL context while
  granting one to a bare canvas. Chain of causes, all ours: the boot catch
  discarded the stack; the WebGL probe leaked the context it was testing for;
  the drawing buffer was full 3x; the document was 5.8 MB, of which 4.5 MB was
  a base64 block model. Model now travels as fetched OREB v1 and the page is
  1.1 MB. The service worker was also cache-first on the document, so every
  fix took two reloads to reach a returning visitor — now network-first.
  **Unresolved:** whether the iPhone renders 3D. Not reproducible here.
- **2026-08-08** — Deck payload: bucket rollups were named but never signed, so
  a hydrated deck could not total anything; and provenance leaked
  `<org_id>/…` storage paths, re-exposing the tenant UUID the payload
  deliberately omits. Both fixed; four assertions added. **Not yet run** —
  OrbStack has a pending update and will not start its daemon.

_Backlog opened 2026-08-08. Update this file and the linked issues as work lands._
