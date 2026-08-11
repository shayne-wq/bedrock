# Bedrock — development tracking

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
  **Console half now done too.** Nothing is required: the slot order is
  exploration-first (property, geophysics, drills, then block model tagged
  "resource stage"), deck creation gates on a zone having ANY data rather than
  a resource, and a zone with data but no model reads "Exploration stage — N
  datasets · no resource estimate" instead of "No block model yet".
  Three Elk-specific lines were leaking into every hydrated deck and are now
  scoped: the class-mapping caveat (printed for projects with no classes), its
  orphaned second line, and "Silver is absent from the source".
- [x] 🟡 **#2 — First-class magnetic / geophysics data.** Mostly done.
  A grid is an image plus the six numbers that place it. World files (.tfw /
  .pgw / .jgw / .wld) are read, the half-pixel offset to the raster EDGE is
  handled, rotated grids are refused with a reason, product type is inferred
  from the filename (TMI / RTP / 1VD / 2VD / analytic signal / radiometrics /
  gravity), and each product drapes on its OWN extent rather than the set's
  union — two grids of one property are rarely clipped identically and
  stretching one to the other's corners moves the anomaly.
  The Explore control is built from the products the deck actually holds.
  **GeoTIFF is deliberately not decoded**: it needs a real TIFF reader for the
  tag soup, tiling and compression variants, and one written against a guess
  mis-georeferences *silently* — the survey lands in the wrong place and looks
  fine. PNG/JPEG plus a world file covers the same ground honestly.
  **Still open:** GeoTIFF, Geosoft .grd, gridding raw XYZ, and a colour ramp
  keyed to real nT values rather than percentile-clipped image colours.
  <https://github.com/shayne-wq/orebody/issues/2>

## P1 — makes multi-zone and exploration real

- [x] 🟢 **#3 — Render multiple zones in the viewer.**
  <https://github.com/shayne-wq/orebody/issues/3>
  The `deck` function now reads the `zones` table, honours
  `decks.settings.zones` for subset + order, and stamps `zone_id` on every
  asset. The viewer groups assets by zone, and every zone carrying a block
  model becomes an entry in the deposit switcher — loaded on demand through
  the same OREB path the fabricated second deposit uses.
  This closed a silent correctness bug, not just a gap: datasets were selected
  by project alone and returned flat, so a two-zone project handed the viewer
  two block models with nothing to say which was which. It took the first —
  rendering one zone's geometry under a deck spanning both, and reporting that
  zone's tonnage as the deck's, with no symptom.
  Verified on a two-zone fixture: both zones listed and named, first active,
  switching loads the second. Deployed to the hosted project.
- [ ] 🟡 **#4 — Exploration-first deck template.** Largely covered by #9: the
  candidate generator already emits property, claims, each magnetics product,
  drilling and intercepts, and proposes no resource slides without a model —
  8 candidates for an exploration zone. **Still missing:** geology, geochem
  (#5), a targets slide, and "the ask" — the slide that says what the money
  is for, which no dataset implies and an author has to write.
  <https://github.com/shayne-wq/orebody/issues/4>
- [x] 🟢 **#5 — Geochemistry dataset kind.** Soil, rock-chip, stream sediment
  and till. Reader, ingest slot, viewer rendering, legend and a candidate slide.
  Coordinates may be projected or lat/lon. Below-detection results are handled
  explicitly — `<5` and `-5` both mean "under the limit" and both become half
  of it, which is convention, and **the substitution count travels in the
  provenance** because a map where a third of the points are half a detection
  limit is a different map. Points are coloured on a **percentile** scale: a
  soil survey is lognormal and one 40 g/t rock chip on a linear ramp renders
  every other sample as background.
  <https://github.com/shayne-wq/orebody/issues/5>

## P1 — authoring: generate, curate, transition

The shape Shayne asked for (2026-08-08): once the data is uploaded, the
platform proposes **every slide the data can justify**; the user drags the ones
they want into a running order; the platform works out how to move between
them. Authoring becomes curation rather than construction.

- [x] 🟢 **#9 — Generate slide candidates from the data.** Walk what each zone
  has and emit every defensible view, each with camera, layers, title and a
  one-line body: property overview · claim block · each magnetics product ·
  each zone at 2–3 cut-offs · classification reveal · N–S and E–W sections ·
  drill forest · each headline intercept · property columns · asset-only.
  Twenty is realistic for a full project; an exploration zone with claims and
  magnetics yields eight. **Nothing is proposed that the data does not support**
  — no resource slides without a block model, no intercept slides without
  assays. Candidates are proposals, not chapters: they live unsaved until
  chosen.
- [x] 🟢 **#10 — Deck builder: drag candidates into a running order.** Two
  columns, pool and order. Drag in, reorder, drop out. Writes `chapters` with
  `ord`. **Shipped** on the deck page: pool and running order side by side,
  HTML5 drag-and-drop with positional insert, Add/Remove, and Save order which
  replaces `chapters` wholesale (the running order IS the deck — diffing would
  only risk orphans). Re-opening seeds the order from saved chapters.
  **Thumbnails done**, as schematic glyphs rather than previews — and the
  distinction is deliberate. A real preview means rendering the slide, and a
  candidate has not been rendered; it does not exist until it is chosen. What a
  chooser needs is to tell a section from a plan from a drill slide at a
  glance, which a shape does as well as a photograph and instantly, with no
  request and nothing to invalidate.
- [x] 🟢 **#11 — Computed transitions between consecutive slides.**
  This is geometry, not intelligence, and should be built as rules that can be
  reasoned about:
  - **shortest-arc heading** — interpolating 350° → 10° the long way is the
    whip-pan that makes a deck feel amateur;
  - **arc over terrain** — two points either side of the ridge must not be
    joined by a straight line through it; lift proportional to separation;
  - **duration from distance**, not a constant — a 5 km move and a 200 m
    nudge cannot share a 2.3 s flight;
  - **scale-jump guard** — beyond roughly an order of magnitude, pull back
    through an establishing frame rather than dollying the whole way;
  - **arm the next slide's layers before arrival**, so the destination does
    not pop into existence on landing.
  **Shipped** in `frameFor()`: shortest-arc heading normalisation, duration
  scaled from the distance actually being covered (1.1–4.2 s), an arc height
  proportional to separation so a traverse lifts over the ridge instead of
  through it, and a scale-jump guard that routes anything beyond 8× via an
  establishing frame. Layers were already armed before the camera moves — go()
  calls apply() first — so the destination is drawn before arrival.
  Measured across three chapter changes: worst per-step heading delta 19°/40°/18°,
  no runaway spin. **Not done:** storing the resolved path on the chapter so an
  export and a live present provably take the same route.

- [x] 🟢 **#12 — Claims by registry lookup, including the neighbours.**
  **Decision: look them up, do not ask the issuer to upload them.** Three
  reasons, in order of weight:
  1. **Neighbours cannot be uploaded.** A company does not hold its
     neighbours' tenure data and has no standing to assert it. Only the public
     register can say who owns the ground along strike — and that is often the
     most interesting fact on the map.
  2. **Claims are the most checkable thing in a mining deck.** A reader can
     put a tenure number into Mineral Titles Online and have an answer in a
     minute, so real tenure is a credibility asset and a fabricated boundary
     is the fabrication most likely to be caught.
  3. It already caught a real error — the owner records are how we learned the
     deck had the project in the wrong district.
  Shipped for BC: `tools/fetch_bc_claims.py` now takes two windows — the
  subject property (1.5 km) and the neighbourhood (6 km) — identifies the
  issuer as whoever holds the ground the deposit sits on, and stamps every
  tenure `_subject` / `_neighbour`. The viewer draws the issuer's ground gold
  and heavy, everyone else's thin and grey, with one label per neighbouring
  **holder** (not per tenure). Elk Gold: 54 tenures, 12 on the property, 42
  surrounding, held by Vizsla Copper, Barranco Gold, Flow Metals and five
  individuals.

  **Still to do, and each is a real constraint rather than polish:**
  - **Jurisdiction coverage.** BC, Ontario, Québec, WA, NSW and Queensland
    publish good open cadastres. US BLM is poor — claims are described by
    section rather than surveyed geometry. Much of Latin America and Africa is
    patchy or paywalled. So: look up where a register exists, **allow upload as
    a fallback, never require it.**
  - **Never render looked-up and uploaded claims identically.** Same
    discipline as real-versus-fabricated: registry tenure carries its number
    and the licence attribution; supplied tenure is styled apart and captioned
    "as supplied by the issuer".
  - **Currency.** Tenures lapse. The bake date must travel with the data and
    be shown — a lapsed claim drawn as current is a misstatement in an
    investor deck, not a stale cache.
  - **Logos: own only.** Dragging your own logo onto your own ground is fine.
    Putting a neighbour's logo on their claims is someone else's trademark
    implying a relationship that does not exist. The registered holder's
    **name** is a fact from a public register; a logo is branding. Names by
    default.

- [x] 🟡 **#13 — Ingest beyond a CSV export.** Substantially done; OMF outstanding. Today the answer to "can you
  take data from the popular mining packages" is: only via CSV, and only the
  block model is actually parsed.
  - **Formats — SHIPPED** in `dashboard/lib/formats.js`, 43 assertions in
    `tools/verify_formats.mjs`:
    | Data | Formats read |
    |---|---|
    | Block model | CSV / TSV, columns detected and correctable |
    | Drill holes | collars + surveys + assays CSV / TSV → **desurveyed by minimum curvature** |
    | Surfaces | **OBJ**, **GOCAD TSurf `.ts`**, **DXF** (3DFACE) |
    | Claims | **GeoJSON**, **KML** |
    Column names are matched loosely, so `HOLEID`/`BHID`/`DHID`, `RL`/`ELEV`/`Z`
    and `AT`/`DEPTH`/`MD` all resolve. Tab-separated exports work.
    Every non-block upload is now **parsed before it is stored** — a file that
    cannot be read is refused by name with what to export instead, rather than
    landing as a green slot containing a blob nothing can draw.
    Unreadable formats are *named*: `.omf`, `.dm`, `.bmf`, `.mdl`, `.dwbm`,
    `.dat`, `.lfview`, a lone `.shp`. Each says what to export instead.
    **Still open: OMF.** It remains the right long-term answer — one reader for
    most of the market — and is deliberately not attempted from a guess at the
    binary layout, because a parser written blind mis-reads silently.
  - **Sub-blocked models.** Tonnage is `dx·dy·dz × density × ore fraction`, one
    volume for every block. A sub-blocked model breaks that. Now REFUSED when
    the file carries per-block dimension columns (XINC/YINC/ZINC and friends).
    **Honest limit:** coordinates alone cannot detect it — a 2.5 m sub-block in
    a 10 m parent is indistinguishable from a 2.5 m grid with holes, verified
    on a synthetic case. A sub-blocked export with no dimension columns still
    gets through, and would report a confident wrong tonnage.
  - **Rotated models.** Not representable at all; no bearing/dip/plunge.
  - **Projections — SHIPPED.** `useProjection()` generates proj4 definitions
    rather than listing them: WGS84 UTM (both hemispheres), NAD83, NAD27, GDA94
    and GDA2020 MGA — around 180 zones — plus BC Albers, NZTM, OSGB, RGF93 and
    Web Mercator. A project's EPSG drives every reprojection in the viewer; an
    unknown code fails with a sentence naming it rather than rendering the
    deposit in the wrong hemisphere.
  - **One grade column.** No multi-element, no by-element cut-offs.
  - **Only blocks are parsed.** Drills, surfaces, geophysics and claims are
    stored as opaque blobs (#2, #6, #7).

## P2 — parsing & authoring polish

- [x] 🟢 **#6 — Parse & desurvey drill data on upload.** Collars, surveys and
  assays are read (CSV or TSV, column names matched loosely) and desurveyed by
  **minimum curvature** — the tangent method is off by metres over a few
  hundred, and a trace that misses its own intercepts is worse than no trace.
  A hole with no survey is drawn vertical and *reported* as assumed, never
  silently. Headline intercepts are derived grade × length, two per hole.
  <https://github.com/shayne-wq/orebody/issues/6>
- [x] 🟢 **#7 — Parse surface meshes.** OBJ (quads fan-triangulated, negative
  indices resolved), GOCAD TSurf (non-contiguous VRTX ids remapped) and DXF
  3DFACE. Uint32 indices unconditionally — a triangulated DTM passes 65k
  vertices easily and a silent wrap folds the mesh in on itself. Rendered and
  labelled in scene.
  <https://github.com/shayne-wq/orebody/issues/7>
- [ ] 🔴 **#8 — Deck editor: choose/reorder zones, per-zone cut-off & economics
  toggle.** <https://github.com/shayne-wq/orebody/issues/8>

---

## P0 — protect the differentiator (comparables-driven, 2026-08-10)

From `docs/COMPARISON.md` and the two competitive audits (`vrify-audit.md`,
`terrahutton-audit.md`), not from the exploration/magnetics work above.
**Updated 2026-08-10 night** — real work landed on all six items below in
one session; status per item reflects what actually shipped, not what was
originally asked for. Where a commit found a genuine floor (not everything
is fixable) that is recorded rather than smoothed over.

**A numbering note, so this doesn't read as contradicting the sections
above**: #9–#13 in the P1/P2 sections above are this file's own local task
numbers — they were never filed as GitHub issues (only #1–#8 have a real
`/issues/N` link). The items below **are** real, filed GitHub issues, and
their numbers (#10–#15) collide with those local ones by coincidence.

- [x] 🟡 **Issue #11 — Fix the mobile boot failure.** **It was never a boot
  failure.** Booted a real iPhone 17 Pro simulator and looked at the screen:
  WebGL renders fine, nothing throws — six rounds of boot diagnostics never
  caught it because there was nothing to report. It was pure layout: a
  desktop sidebar took over the entire phone screen, `#tools`/`#nav` ran off
  both edges with no wrap, and the splash gradient piled the title into
  chapter one's. Real ≤760px layout shipped (safe-area insets, 44px targets,
  a landscape rule, authoring buttons hidden on a phone). Verified on
  simulator: 37/37 UI, 24/24 holders, desktop untouched.
  **Still open, correctly**: not yet confirmed on the specific *physical*
  device that was failing — a simulator shares WebKit but not the memory
  ceiling. That confirmation is what closes this.
  <https://github.com/shayne-wq/orebody/issues/11>
- [x] 🟡 **Issue #12 — Harden sub-blocked model detection.** New signal
  found: sub-block a 10 m parent into 2.5 m children and the surviving
  centres land in a different residual class modulo the cell pitch — the
  gap-histogram method couldn't see this, coordinate residuals can. The case
  the code previously documented as undetectable is now detected.
  **A real, permanent floor is documented, not fixed**: odd-factor
  sub-blocking (2.5 m inside 7.5 m) puts every child and surviving-parent
  centre on the same fine lattice — mathematically indistinguishable from a
  patchy grid, no coordinate test can ever separate them. Answer: an
  explicit human cell-size confirmation is now asked on **every** model, not
  just suspicious ones, since the undetectable case looks identical to the
  clean one. Turns a silent wrong tonnage into a recorded assumption — the
  issue's own stated fallback. 18 new assertions, 36/36 extract.
  <https://github.com/shayne-wq/orebody/issues/12>
- [x] 🟢 **Issue #13 — GeoTIFF ingestion.** Shipped. `geotiff.js` decodes
  client-side, raw grid never leaves the machine. 2–98 percentile stretch
  (not min/max — one hot cell in a magnetics survey would otherwise flatten
  everything to black). The file's own EPSG tags win over a `.tfw` sitting
  beside it — a world file is a copy somebody made, the tags are what the
  grid was written with. `.grd`/`.gxf` refused by name, pointing at what
  Oasis montaj exports in one click — same call already made for OMF,
  Datamine, Vulcan. A byte-written fixture (`data/fixture_geotiff.tif`)
  keeps the georeferencing assertions honest. 12 assertions + 54/54 formats.
  <https://github.com/shayne-wq/orebody/issues/13>
- [x] 🟡 **Issue #14 — Registry lookup beyond BC.** Saskatchewan added as a
  second jurisdiction, correctly built as its own bounded adapter rather
  than a generic abstraction — BC's WFS takes bbox latitude-first,
  Saskatchewan's ArcGIS takes it longitude-first, and neither errors on the
  mistake. Real negative-result work too: Finland's registry advertises a
  polygon query and returns every attribute with null geometry (boundaries
  exist, won't hand them over); BLM's is clean geometry with no holder
  joined to it. Both rejected and the reason recorded so nobody re-checks
  them. 14 assertions against both live registers.
  **Still open relative to the original ask**: the issue was scoped to
  where Terrahutton's actual customers are (Colombia, Argentina, Peru,
  Finland) — Finland was checked and correctly rejected; the LatAm
  jurisdictions aren't covered yet. The adapter pattern is proven, not the
  coverage.
  <https://github.com/shayne-wq/orebody/issues/14>
- [x] 🟡 **Issue #15 — QA the two never-clicked flows.** Both driven for
  real, signed in through the app's actual auth path against live systems.
  **Registry fetch confirmed working**: 234 boundaries added against the
  live BC register, holder list 15→67, and pressed a second time it
  correctly reports no new holders rather than duplicating — idempotency
  nobody had checked. **Logo upload confirmed at the database**, catching
  the test's own first mistake: reading it back with the bare anon key
  returns nothing (RLS doing its job), not a failed write.
  **One real bug found and left open**: every save in this panel triggers a
  full `route()` page rebuild, so uploading a logo flashes a slow full-page
  skeleton. A targeted repaint was tried and reverted rather than shipped
  half-understood — cosmetic, the writes are correct. 13/14 assertions (the
  one failure is that same flash).
  <https://github.com/shayne-wq/orebody/issues/15>

Cesium/terrain-realism work is tracked separately as **Issue #10**, deferred
by design (Phase 2). **Decision, 2026-08-10: no client-supplied imagery or
footage of any kind** — a customer-uploaded orthophoto drape and a
drone-photogrammetry reality mesh were both in its original scope and both
are cut (reasoning: photography carries no backing number, unlike every
other input this product handles). **Tier 1 partially shipped the same
night**: fog (additive, low density — atmosphere, not weather) and a
tightened screen-space error, checked on screen. **Lighting/shadows tried
and deliberately reverted** — `globe.enableLighting` does make terrain
relief read, but the ore blocks already render lit (`MaterialAppearance`
`flat:false`), tuned against the current flat illumination; a real sun
re-shades every grade shell by facing, desyncing it from its own legend.
Exactly the risk flagged when this was first deferred. Needs a shader-level
fix (light the terrain without lighting the blocks), not a flag — left for
whoever reaches for it next, with the reasoning in the code. 37/37 UI,
24/24 holders, 32/32 hole view.
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

## Log

- **2026-08-10** — **Renamed Orebody → Bedrock.** 44 files. Three categories
  were deliberately left alone, and one mistake was worth the whole exercise.

  **Not renamed:** the stored artifact format ids (`orebody-claims/1` and
  friends) are a wire contract written into files already in storage — renaming
  them breaks every existing artifact and nobody ever sees the string.
  Infrastructure names stay too: the Vercel project, the git remote, the
  Supabase local `project_id` (which names the docker containers and would
  orphan the running stack), and the live embed host, because a published URL
  is somebody's website, not a brand surface.

  **Migrated rather than dropped:** presenter annotations were keyed
  `orebody.areas.*` and the console's Supabase override `orebody.supabase`.
  Both read the old key as a fallback. A rename is not a reason for somebody's
  drawn annotations to disappear, and a silently lost console override points a
  local console at production.

  **THE MISTAKE, and it nearly shipped.** The sweep renamed the *geology*. An
  orebody is a mineralised body; bedrock is the rock under the soil. A slide
  went out titled **"The bedrock"**, `push("orebody")` became
  `push("bedrock")`, and 105 lowercase occurrences of a geological noun had
  been replaced with the company name — in front of the one audience that would
  certainly notice. Caught by two slide-ordering assertions that looked up
  candidates by id, not by anything about brand.

  Lowercase is now the geological term and capitalised is the product,
  everywhere.

- **2026-08-10** — **The four platforms a geologist named, and topography.**
  Leapfrog, Micromine, Deswik, MinePlan.

  The useful finding is that **all four are already readable**: every one of
  them exports CSV for drilling and block models, and DXF/OBJ for wireframes,
  which is exactly what this reads. The gap was never ingestion — it was that a
  Leapfrog user dropping a `.msh` got "unsupported extension" and reasonably
  concluded the tool did not know their software.

  So the vendor table is corrected and extended. **`.msr` was listed under
  Leapfrog and is MinePlan's** — it would have sent a MinePlan user hunting for
  menus their software does not have. MinePlan was not named at all despite the
  demo's own provenance citing MineSight class conventions. Leapfrog now covers
  `.msh/.lfm/.lfr/.aproj`, Micromine `.tridb/.mmpro`, Deswik its four, each
  naming the actual menu path.

  **Ambiguous extensions get an honest answer.** `.dat` was mapped confidently
  to Micromine; Datamine and MinePlan use it too. Naming one vendor wrongly is
  worse than naming none, so `.dat`, `.str` and `.00t` now say what the file
  might be and give the export that is the same answer whichever it is.

  **Topography is a new dataset kind.** A GeoTIFF DEM becomes a mesh — the same
  {verts, faces} the vein surfaces already render — downsampled to ~320 a side,
  because a 4,000² DEM is sixteen million vertices nobody can perceive on a
  hillside. Survey voids stay voids: a cell with any no-data corner is dropped
  rather than spiked to zero. A triangulated DTM as OBJ/GOCAD/DXF loads the
  same way, which is what Leapfrog, Deswik and MinePlan all export.

  **LiDAR is named and refused**, pointing at the DEM or surface every LiDAR
  pipeline already produces. Nothing in a deck draws raw returns.

  One bug worth recording: `Number(null)` is `0`, and the GeoTIFF reader was
  coercing a missing GDAL_NODATA tag to zero — so a DEM at sea level would have
  had every genuine zero-metre cell punched out as a void. Same trap as
  `Number("")`, found earlier this session in the geochem reader.

  14 topography assertions against a hand-written float32 DEM with a deliberate
  void.

- **2026-08-10** — **Terrain defaults to 10% whenever there is rock on screen.**
  An orebody drawn over solid ground is a coloured blob pasted on a hillside:
  you see its silhouette and nothing about where it sits. The entire reason
  this is georeferenced is that the body is INSIDE the mountain, and that only
  reads when the mountain is see-through.

  So the default is now DERIVED from what is on screen rather than inherited
  from whatever the last chapter left: block model or drilling on → 0.1. A
  chapter about the surface still says `ground: 1.0` and gets it. Six baked
  chapters that declared solid ground while drawing the model had the
  declaration removed so the rule applies to them, and the headline "The
  orebody" chapter went from 0.42 — at which the hillside still reads as a
  surface the body sits on — to 0.1.

  Two things fell out of doing it. The plan-view chapter's own copy says the
  body tells you nothing from above, and it was drawing it anyway, as a blob
  over the grade map it exists to show: `blocks: false` now. And the
  translucency window had a **30 metre** margin, so at the new default its edge
  drew a hard dark rectangle right around the deposit on every model chapter —
  widened to 2.5 km so the transition happens off-frame at the ranges these
  chapters use, while the far terrain stays solid.

  Still visible and worth doing next: that window edge is only pushed out of
  shot, not softened, and the underground colour it reveals is nearly black.

- **2026-08-10** — **The open pit is an excavation now, not a scribble.** Five
  wireframe rings drawn BELOW the terrain, which then occluded them — so the
  one feature whose whole job is to read as a hole read as a faint contour
  under a hillside.

  Two changes make it an excavation. The terrain is **clipped inside the rim**
  (`ClippingPolygonCollection`), so there is a real hole in the ground rather
  than geometry hidden behind it. And each of twelve benches is a solid annular
  floor with a vertical face above it, faces darker than floors, so the steps
  catch the light and the pit has a bottom you can see. Annular, not disc — a
  disc at each level would bury every bench below it.

  The rim is sampled from the **ground**, not from `ZTOP`. Pinned to the top of
  the block model it sat proud of the hillside like a bowl set down on it,
  which is the one thing an excavation must not look like. The terrain tile
  under the pit has not loaded on a cold open, so the layer rebuilds itself
  once the ground exists.

  Note this raises the stakes on labelling rather than lowering them: the pit
  is **fabricated**, the banner and the per-feature "(conceptual)" tags are
  untouched, and something that now looks this much like a mine plan needs them
  more than the old wireframe did.

- **2026-08-10** — **Terrain opacity now applies to all terrain.**

  Reported from a screenshot: a hard-edged black rectangle lying on a fully lit
  hillside, covering the shallow part of the orebody it was meant to reveal.

  Translucency was confined to a rectangle around the deposit, so the control
  labelled TERRAIN 10% left about 99% of the terrain at 100% and cut a window in
  the map instead. Inside the window the ground went transparent onto
  `undergroundColor` #141a1f — the black tarp.

  The window had already been diagnosed once and nominally widened to 2.5 km.
  **That widening never took effect**: `reframeModel()` runs after the setup
  block and reset it to a 30 m margin, which is the assignment that was live the
  whole time. Two writers, last one wins, and the fix was written into the
  loser. Both are gone; `translucency.rectangle` is `undefined`, so the slider
  fades the whole globe uniformly.

  `enterHoleView()` had reached the same conclusion independently and dropped
  the window for its own duration, with a comment about looking out of it at a
  bright hillside. That is now the default rather than a special case.

  The trade the original comment feared is real and is now visible at low alpha:
  what is behind transparent ground is the inside of the earth, so at 10% the
  landscape goes dark rather than staying a lit backdrop. At 35% it reads as an
  x-ray of the mountain with the deposit inside it, which is the look the
  windowed version was reaching for. **Open question for Shayne:** the derived
  default for rock chapters is 10%, set when the surrounding terrain stayed
  lit — on "On real ground", whose caption is "this is the actual mountain the
  deposit sits inside", 35% now serves that sentence better. Not changed
  unasked.

  Three assertions in `verify_holeview` asserted the old shape (narrow window
  before, global inside, restored after). Rewritten to assert translucency is
  global on all three paths, so nothing re-introduces a window. Re-run green:
  holeview 32, capture 28, ui 37, labels 11, transition 11, pit clean.

- **2026-08-10** — **Deswik. Covered twice, and the second way was a real gap.**

  Applied the same test as OMF: does the format say what its own numbers mean?

  **Route one — OMF, already done.** Deswik is one of four vendors that publicly
  committed to OMF (with Seequent, Dassault and Micromine) and built an
  OMF-compliant block model export. `readOMF` shipped this morning, so a Deswik
  OMF export already loads — solids and block model in one file, every attribute
  named. Advice for Deswik, Leapfrog and Micromine now offers OMF first, worded
  conditionally because their version may not write it.

  **Route two — DXF, and this was broken for Deswik specifically.** `readDXF`
  read **3DFACE only**. Its comment defended that: POLYLINE meshes "would be a
  lot of code that is wrong in ways nobody notices". Half right — 3DFACE is the
  common case, but the CAD-lineage tools, Deswik above all, write solids and
  surfaces as **POLYFACE MESHES**. So "File > Export > DXF" out of Deswik.CAD
  produced a file this refused, with advice to re-export as 3DFACEs — something
  their software may not offer. The caution was about scope, not about the
  format being unknowable: a polyface mesh is precisely specified, so it can be
  read *and tested*. `tools/verify_dxf.mjs` is new, 12 assertions, fixtures
  hand-written to the group-code spec rather than dumped from the reader.

  Now read: **POLYFACE MESH** (POLYLINE flag 64, VERTEX runs, SEQEND) and **3D
  POLYGON MESH** (flag 16, an M x N grid with faces implied) alongside 3DFACE.
  Three traps the tests pin:

  - A polyface VERTEX is either a COORDINATE (flags 128|64) or a **FACE record**
    (flags 128 alone) carrying 1-based indices in 71..74. Reading a face record
    as a point puts a stray vertex at (0,0,0) and drags the surface to the
    origin — it looks like a modelling error, not a parser error.
  - A **negative index means an invisible edge**, not a missing corner.
    Dropping it silently deletes a vertex from the face.
  - Indices are per-entity, so a file with two meshes needs the second rebased.
    Overlaid, its triangles point at the first mesh's vertices.

  What is still refused is now named in the error — 3DSOLID, BODY, MESH and
  non-mesh POLYLINEs are counted by type, so a partial parse stays visible
  instead of producing a hole.

- **2026-08-10** — **OMF is read now. Leapfrog and MinePlan, answered properly.**

  Shayne asked what happens with the two packages he named. The honest audit:

  **MinePlan was never theoretical — it is the demo.** `Siwash_North_BM_Nov_2021.csv`
  is a real MineSight export and `tools/extract_blocks.py` opens by saying so:
  495,074 rows scanned, 168,013 blocks, 46 vein domains. The block-model path
  has been fed a MinePlan export since the beginning.

  **Leapfrog worked via CSV/OBJ/DXF/GOCAD, and that was underselling it.**
  Leapfrog exports **OMF** directly, and OMF was sitting in the refused list
  with the note "support is planned and is the right long-term answer". It is
  implemented now — `readOMF` in `dashboard/lib/formats.js`, 18 assertions in
  `tools/verify_omf.mjs` against a fixture written from the published v0.9 spec
  rather than by the reader itself.

  **Why OMF and not the rest**, which is the whole argument and is now in the
  file header: the line is not binary-versus-text, it is **whether a file says
  what its own numbers mean**. Taking a Vulcan `.bmf` apart settled it — 576 MB,
  not one variable name, so any reader would have had to guess which column was
  zinc. OMF names every element and every attribute, is an open GMG-governed
  spec with a public reference implementation, and carries surfaces, block
  models, points and drillhole traces in ONE file. Nothing is inferred.

  Both container layouts are handled: v1 (the 60-byte header, binary blob, then
  a JSON dictionary at the end — what Leapfrog writes) and v2 (a ZIP with
  project.json). Arrays are zlib blobs addressed by `{start,length,dtype}`;
  `DecompressionStream("deflate")` reads them in the browser and in Node, so the
  test exercises the shipped path.

  Two traps the tests pin down. **Geometry origins**: OMF stores vertices
  RELATIVE to an origin, and ignoring it puts a vein at the map origin off West
  Africa rather than on the property. **Named attributes**: a surface's "Au g/t"
  and a model's "Zn %" arrive as names, so the deck labels them from the file
  instead of from a column guess.

  Wired into the console: `.omf` sniffs readable, drops into the surfaces slot,
  and loads every Surface element under **the name its author gave it** — not
  the filename, which would put "export.omf" on nine different veins. Anything
  else in the file (a block model, points, linesets) is reported by name in
  stats and provenance as *not loaded*, because silently dropping a customer's
  resource model is how somebody concludes the upload worked and their deck is
  missing.

  **Not done, and it is the obvious next step:** loading an OMF VolumeElement as
  the block model. The reader already decodes the grid — origin, axes and
  per-block width tensors, so OMF states a sub-blocked lattice natively rather
  than needing the CSV path's detector — but the ingest wizard is CSV-only
  through its worker, and routing a volume into it is a separate piece of work.

- **2026-08-10** — **Drag-and-drop ingest audited against what the four packages
  actually export. Three routing bugs, all silent.**

  Shayne is sourcing data from real companies, so the question stopped being
  "can we parse this" and became "does a dropped folder land in the right
  slots". The parsers were fine. The **router** was not, and nothing tested it —
  `tools/verify_dragdrop.mjs` is new, 63 assertions, filenames these packages
  actually write.

  1. **Topography could not be dropped at all.** `parseAux` has handled it since
     the GeoTIFF work — DEM or triangulated DTM, with a proper refusal for point
     clouds — but `classify()` never returned `"topography"` in any branch. The
     slot could only ever be filled by clicking Add on it. The one dataset the
     geologists asked for by name was the one you could not drag in.
  2. **A DEM was filed as magnetics.** Every `.tif` went to geophysics, so
     `dem.tif` would have been draped as a magnetics image; a triangulated DTM
     named `topo.obj` went to vein surfaces. Topography is now matched by name
     (dem/dtm/dsm/topo/terrain/elevation/ground/lidar/contour/bathy) ahead of
     both, because nothing in a raster's bytes says whether it is ground or
     magnetics — but a bare `grid.tif` still falls through to geophysics, which
     is the commoner case.
  3. **"survey" is a word that belongs to half the industry.** The drill rules
     matched it anywhere in a filename regardless of extension, so `survey.las`
     (a LiDAR scan) and `TMI_survey.tfw` (a world file) were both filed as drill
     surveys — silently, because a drills slot with the wrong file in it looks
     exactly like a drills slot. Those rules are now gated on a tabular
     extension; collars, surveys and assays are always a table.

  Point clouds (`.las/.laz/.e57`) now route to topography as well, so they are
  refused with "export the derived surface" rather than "could not tell what
  that file is" — a better answer for a file that is unmistakably terrain.

  **Added: ESRI ASCII grid (`.asc`).** The one raster all four packages export
  without argument, and the only one that needs no library. Its own new test
  caught a **half-cell inversion in it**: `xllcorner` is the outer corner and
  `xllcenter` is the centre, and I had the offset backwards in both directions —
  which shifts an entire terrain by half a cell, silently, forever. It carries
  no CRS, so `epsg: null` is returned and the project's own grid is used rather
  than a guess, and the provenance line says so.

  Standing position on the vendor formats, now asserted rather than assumed: all
  eleven — Vulcan, Deswik, MinePlan, Micromine, Leapfrog, Datamine, Surpac, OMF,
  Geosoft, shapefile, LiDAR — are refused **by name, with the export to use**.
  That is the product: the honest answer to a `.bmf` is "export CSV", not a
  parser that guesses what its columns mean.

- **2026-08-10** — **Vulcan .bmf reader: attempted, and abandoned on evidence.**

  Asked to read Lisheen's block model so one demo could carry both real drilling
  and real resource geometry. Probed it properly before building. **It cannot be
  done honestly, and the reason is not difficulty.**

  What was checked, against the real file (streamed out of the 578 MB zip over
  HTTP range requests, no full download):

  - **No independent reader exists.** MiningPy's `bmf_to_csv` wraps Maptek's
    licensed Vulcan Python SDK; it is not a format implementation.
  - **The records are partly legible.** `lismre2015_v45_cla.bmf` is a fixed
    222-byte stride, and the first field of each record decodes as a sensible
    double (93.07, 93.06, 89.06). Subsequent fields decode as garbage under a
    plain-doubles assumption, so the layout is mixed-width and would need real
    reversing — hard, but only hard.
  - **The schema is not in the file.** Inflated all **576,081,390 bytes** and
    scanned for text: 167,576 distinct string-runs, **every one of them three
    characters of float noise**. Not one word of four characters or more. No
    ZN, PB, AG, SG, DENSITY, CLASS. Nothing.

  So even a perfect binary parse ends with unlabelled columns, and somebody
  would have to **guess** which number is zinc and which is density. That is the
  precise thing this product exists to refuse: the guess would be invisible in
  the output, and would produce a confident, plausible, wrong deck — the same
  class of failure as the sub-blocking trap and the vein share-weighting bug,
  both of which reconciled at the deposit total while being wrong underneath.
  A reader here is not a feature, it is a fabrication with a parser in front.

  The obvious fallback also fails: the `Ore.TRI/*.00t` triangulated ore solids
  open with magic `ea fb a7 8a` + `"vulZ"` — a **compressed** Vulcan container —
  and no vertex coordinates are recoverable as raw float32 or float64 anywhere
  in the first 200 KB. A triangulation would have needed no schema, which is why
  it was worth checking; it is just as closed.

  **What Lisheen still gives, free and ungated:** `SAMPLE_DDH_V45.csv` (15 MB) —
  real drillhole assays with per-interval XYZ, zn, pb, fe, zneq, sulph and SG —
  plus readable ISIS `.dsf` schemas and a 1 GB Access sample database. Real
  drilling, no orebody geometry. The Z carries a mine-datum offset of roughly
  800 m and would put the deposit in the air if ingested naively.

  **Standing conclusion, so this is not re-litigated:** no public source found
  to date supplies block-model geometry in a format that can be read without
  guessing what its numbers mean. Real 3D orebody geometry has to come from an
  issuer who exports it — CSV, OBJ or DXF — not from reversing a vendor format.

- **2026-08-10** — **A reviewable Macpass deck, and three bugs it exposed.**

  `tools/seed_macpass.mjs` builds the Macpass land package as a real deck —
  through the deployed tenure function, the console's own claims artifact, the
  same candidate generator, a share link. Land package only: the drill database
  is still behind the disclaimer, so this runs in exploration mode and says so,
  and there is one zone rather than four because a zone with no data in it is a
  promise rather than a fact.

  Token `macpass0000000000000000000000000`. Four chapters, 1,844 parcels,
  Fireweed 1,762 tenures / 31,257 ha, five holders. It renders on real Yukon
  terrain with no fabricated anything.

  **Three real bugs, none of which any test would have caught, because all three
  needed a non-BC exploration project to exist:**

  1. **The exploration path never applied the project's EPSG.** `PROJ` was set
     only in the block-model branch, several hundred lines below the exploration
     branch's early return, so an exploration deck was placed with the baked
     demo's UTM zone 10N. Macpass is 9N — one zone, ~300 km of easting. It would
     have drawn confidently on the wrong mountains and said nothing. Moved above
     both branches.
  2. **The console and the viewer disagreed about where a property is.** Claims
     ingest writes `stats.bbox` — `[w,s,e,n]` in degrees, because a boundary file
     arrives as lon/lat. The viewer read only `stats.bounds` — `{x,y,z}` in the
     project grid. So a project whose only dataset was its property outline — the
     commonest exploration project there is — found no extent and refused to
     open. The viewer now accepts either, converting the degree box through the
     project's own projection. Fixed in the viewer rather than the writer so
     artifacts already in storage work without a re-upload.
  3. **A private individual was rendered as a company, named, on a slide about
     who surrounds the property.** `isCorporate()` read any comma-less name as a
     company — which held in BC, where the register writes people as
     "BILLINGSLEY, RICHARD JOHN", and fails in Yukon, which writes "Patrick
     Etzel". The comment justifying the old default argued, in the same
     sentence, that "a named individual is a decision nobody made" — the
     implementation was on the wrong side of its own argument. Now it requires
     positive evidence of a company (suffix, ampersand, bracketed year,
     registered number) and defaults to person. Checked against 17 real owner
     strings from all three registers: all 17 classify correctly.

  Also corrected from the entry below: **leases do not add ground.** All 182 of
  Fireweed's lease grant numbers also appear in the claims layer, so layer 37
  returned 182 duplicate polygons rather than the surveyed ground I claimed it
  contributed. Both layers are still read — a lease with no claim record cannot
  be ruled out from one property — but the response now dedupes by tenure and
  reports `duplicate_tenures_dropped`, which is also what proves the second
  layer ran. Without that dedupe, "both layers" was double-counting hectares on
  the one slide whose whole subject is who owns how much.

  Re-run: tenure 22, ui 37, holeview 32, labels 11, pit clean.

- **2026-08-10** — **Yukon wired up as the third tenure jurisdiction, for Macpass.**

  Chasing a real dataset to replace the fabricated drill holes. Fireweed
  Metals' **Macpass** (Yukon, Zn-Pb-Ag + Ge/Ga) publishes a full drill database
  — collars, surveys, sample-by-sample assays, bulk density, LiDAR DEMs — in
  **EPSG:26909**, four deposits (Tom, Jason, End Zone, Boundary Zone), ~544
  holes. That package sits behind a signed disclaimer form; submitted, and the
  link is emailed to `shayne@lfgmanagement.ca`, which the Gmail connector cannot
  read (it is on `admin@almondprotein.ca`). **Still waiting on the link.**

  What did not need the link: the neighbouring-ground layer. GeoYukon qualifies
  on the rule this function has always applied — one queryable layer carrying
  both the boundary and the holder — so `yt` is now wired alongside `bc`
  and `sk`, deployed and green.

  Yukon broke two assumptions the first two jurisdictions shared, and both
  would have failed silently:

  - **A property spans two registry tables** — claims and leases. ~~Querying
    claims alone punches a hole in the outline where the mine is.~~ **Wrong, and
    corrected the same day in the entry above:** every lease grant also appears
    in the claims layer, so the second layer adds no ground and returns
    duplicates. Both are still read, and deduped.
  - **A Yukon parcel is ~21 ha**, so a property that is dozens of tenures in BC
    is thousands here; Fireweed's block is ~2,000 within one legal bbox. The
    register caps a response at 2,500, and `MAX_FEATURES` was 1,200. Unpaged,
    the dissolve would have drawn a property with its middle missing and
    reported it as fact. Yukon has its own ceiling (4,000) and pages at 1,000,
    and `truncated` is now judged against the source's own cap rather than a
    global one — otherwise a complete Yukon property cries wolf at 1,200.

  Also: the holder is stated as `"Fireweed Metals Corp. - 100%"`. Left attached,
  the interest splits one company into several outlines the moment a parcel is
  jointly held, because the dissolve groups on the name.

  `tools/verify_yukon.mjs` (12 assertions) proves the adapter against the live
  register without a deploy; `verify_tenure.sh` grew seven Yukon assertions and
  runs 21 across all three jurisdictions. Two of my own assertions failed first
  and were wrong rather than the code — a >2,500 threshold that a 0.5° bbox can
  never reach, and a hard parcel count where a share was meant.

  Verified live: 2,026 parcels, 0 without geometry, Fireweed 1,944 parcels /
  34,114 ha as a single holder, with Rackla Metals, Senoa Gold and two named
  individuals as neighbours. BC and SK re-run unchanged.

- **2026-08-10** — **Renamed to Bedrock, and the console rebuilt on the brand.**

  **The rename.** GitHub repo → `shayne-wq/bedrock`, Supabase project → `bedrock`
  (the ref `czuaqwtngduvlisxonkh` is immutable, so no Supabase URL moved),
  Vercel project → `bedrock` with `bedrock-fawn.vercel.app` aliased to
  production. `orebody-fawn.vercel.app` still answers 200 and is left alone —
  every share link and website embed already issued points at it, and revoking
  a host to tidy a name would break decks sitting on customers' sites. The
  Supabase auth `uri_allow_list` gained the new host alongside the old.
  `supabase/config.toml` keeps `project_id = "orebody"`; it is the local
  docker stack's directory name, not a product name.

  **The console.** Implemented the `Orebody Console.dc.html` design against the
  real console rather than as a new page — every existing class kept its name,
  so the studio, the ingest ledger, the embed tabs and the analytics panels
  came across without markup churn. Light ground, per the brand guidelines'
  "a light ground carries the whole system — no dark surfaces". Type is
  Space Grotesk / Inter / JetBrains Mono, the same three faces as the marketing
  page, which also drops the 344 KB base64 `assets/fonts.css` the console had
  been loading for a different stack. The viewer stays dark: it is a 3D scene of
  rock, and the slide thumbnails in the deck builder are miniatures of it, so
  they stay dark too — they are previews, not swatches.

  Three colours were moved off the design file's values, all to clear WCAG AA
  on a light ground, and the first two on the brand guidelines' own instruction
  that accent-coloured *text* takes Accent 700:
  - `--accent` #0088b0 is 3.7:1 on the page. Kept for fills, borders and rules;
    `--accent-700` #006786 (5.7:1) carries every accent-coloured word and the
    primary button, where white on #0088b0 was 4.1:1.
  - `--good` #1a8a5c was 3.5:1 on its own chip, and it carries the `LOADED` tag.
    Darkened to #146c49 (5.7:1).
  - `--ink-mute` #8d9490 was 2.8:1 and set every column header, breadcrumb, stat
    caption and slot sub-label. Darkened to #6d7472 (4.6:1); #8d9490 survives as
    `--ink-faint` for the logo's third seam and other things that are not read.

  Two layout bugs found by screenshotting the result rather than by any test,
  both pre-existing and both invisible in the dark theme:
  - **`.row` was never given `display:flex`.** Only `header.page .row` and
    `.zone > .row` were styled, so every panel header in the console —
    Zones/Add zone, Build the deck/slide count, Neighbouring ground/Fetch —
    had been stacking its button under its title the whole time.
  - **The sticky rail is one viewport tall**, so on any page longer than the
    fold its white background stopped mid-page and left a grey stripe. The grid
    column carries the white now.

  Also: register controls moved out of the Neighbouring ground heading and down
  to the list they act on; a loaded slot's chip and buttons became a right-hand
  column so it stays the same height as an empty one; the single nav item reads
  active on every route, since every route is inside Projects; favicon added
  (the symbol-only lockup the guidelines reserve for it), which also silenced a
  404 on every console load.

  **Not implemented from the design, deliberately:** the drag handles on the
  dataset slots. In the design they reorder a layer list; here the slot order is
  a code constant, deliberately exploration-first (property → geophysics →
  geochem → drilling → block model), and `datasets` has no `ord` column. A
  handle that reorders on screen and persists nothing is worse than no handle.
  If layer order should drive anything in the viewer, that is a real feature and
  wants its own issue.

  Regression: 10 modules parse, and holeview 32 / capture 28 / labels 11 /
  transition 11 / ui 37 / deposit 28 / slides 40 / formats 54 / extract 36 /
  subblock 18 all green. `verify_console_flows` and `verify_console_inputs` need
  the local Supabase stack and were not run.

- **2026-08-10 (night)** — Real work landed on all six items from the
  comparables-driven P0 section above, same session: mobile turned out to be
  a pure layout bug, not a boot/WebGL failure (fixed, pending physical-device
  confirmation); sub-blocked detection gained a real new signal and an
  honestly-documented permanent floor; GeoTIFF ingestion shipped complete;
  registry lookup proved out on a second jurisdiction (Saskatchewan) plus
  useful negative results (Finland, BLM rejected and why); both never-clicked
  console flows were driven for real and one real cosmetic bug found; Cesium
  terrain Tier 1 (fog, tile sharpness) shipped, lighting tried and correctly
  reverted after being checked on screen. Full detail per item is in the P0
  section, sourced from each commit rather than summarised from memory.
  Also, unprompted by any filed issue: a stray double-comma from the GeoTIFF
  patch had been silently shipping the console as a **blank page** in
  production — caught because the syntax check that should have caught it
  was itself broken (it stripped `import` lines before parsing, deleting the
  exact construct that was wrong). Replaced with a real ES-module parse.
  Project settings, zone names and deck subtitle also made editable
  post-creation while fixing this, since the audit that found the blank page
  was originally about that.

- **2026-08-10** — **Console input audit, and a syntax error that had taken the
  whole console down.**

  Audited what the viewer consumes against what the console can supply. Three
  things were readable everywhere and editable nowhere, all set once at
  creation and then permanent: **the project itself** (name, commodity,
  location, EPSG — a wrong EPSG put the deposit somewhere else on earth with no
  way back short of deleting the project and re-loading every file), **zone
  names**, and **the deck subtitle**. All three are editable now. Changing EPSG
  warns, on change rather than as boilerplate, that it moves everything already
  loaded.

  While testing it: `import { … readGeochem,, readGeoTiff }` — a double comma
  my own patch script wrote into `ingest.js` during the GeoTIFF work. A syntax
  error in one module takes down every module that imports it, so **the entire
  console was a blank page**, shipped and deployed.

  The check that should have caught it reported success the whole time. It
  parsed each file with `new vm.Script(src)` after stripping `import` lines
  with a regex — deleting exactly the thing that was broken. Replaced with
  `tools/verify_modules.mjs`, which compiles every browser module as a real ES
  module, imports and all, nothing stripped.

  15 input assertions driven in a signed-in browser. Two assertions were also
  removed from the console-flow suite: they asserted a mark appears on screen
  within N seconds of a save, which measures the length of the full-page
  re-render flash rather than whether the write worked — flaky between runs and
  uninformative when red. The writes are proven against the database instead;
  the flash stays a known open issue.

- **2026-08-10** — **The five comparables-driven issues, worked.** #11, #12,
  #15, #13, #14 shipped; #10 tier 1 shipped with lighting deliberately not
  taken.

  **#13 GeoTIFF** is read directly now, georeferencing from its own tags. The
  old path asked a customer to degrade their contractor's deliverable to PNG
  and then re-supply by hand the six numbers the file already carried. A
  single-band grid gets a 2–98 percentile stretch, not min/max, or one hot cell
  flattens a magnetics survey to black. The EPSG is recorded, never converted.
  Geosoft `.grd`/`.gxf` refused by name pointing at what Oasis montaj exports
  in one click. The fixture is written byte by byte so the expected tie point
  is known rather than assumed — a decoder subtly wrong about georeferencing
  puts a survey in the wrong place and looks fine doing it.

  **#14 Saskatchewan** wired as a second bounded adapter. BC's WFS takes a bbox
  latitude-first and Saskatchewan's ArcGIS takes it longitude-first, and
  neither errors when you get it wrong — which is the argument against a
  generic abstraction. Two registers **checked and rejected, recorded by name**:
  Finland (Tukes) advertises Query on polygons and returns every attribute with
  a null geometry; BLM returns clean geometry but no claimant, and the holder
  is the entire point. A register qualifies only if one queryable layer carries
  both the boundary and the holder — that criterion now lives beside the
  adapters.

  **#10 tier 1**: fog and a tighter screen-space error. **Lighting was tried and
  left off deliberately** — the ore shells already render lit, and the grade
  ramp's discrete bands were tuned against flat illumination, so a real sun
  re-shades each shell by its facing and two blocks in the same band stop
  matching each other and stop matching the legend. The legend is the contract.
  Doing it properly means lighting terrain without lighting blocks, which is a
  shader change, not a flag. Verified visually on the high-grade-core chapter
  rather than reasoned about.

- **2026-08-10** — **#11 was never a boot failure, and #12 has a floor that
  cannot be raised.** Both P0s worked; both turned out to be different problems
  than the tracker described.

  **#11.** Booted an iPhone 17 Pro simulator — real Mobile Safari — and looked.
  WebGL is fine. Terrain renders, the orebody renders, nothing throws. Nothing
  ever threw, which is why six rounds of boot diagnostics found nothing: there
  was nothing to report. The deck was unusable because **there was no phone
  layout**. `#cap` is a desktop sidebar and became the whole page; `#tools` and
  `#nav` are flex rows sized for 1600px and ran off both edges with Next and
  Play off-screen; `#intro` is a gradient over the live scene, so on a centred
  phone layout the splash title and chapter one's title interleaved into an
  unreadable pile. That last one is what "it doesn't work on my phone" actually
  looked like. Fixed and verified on the simulator. **Still owed: a pass on the
  physical device** — a simulator shares WebKit but not the memory ceiling.

  **#12.** Added the signal the detector said did not exist. Its comment read
  *"coordinates cannot answer this question"*; they can, just not from the gap
  histogram it was looking at. A uniform grid puts every centre in ONE residual
  class modulo the cell pitch — holes remove centres, they never move the
  survivors off the lattice. Sub-block a 10 m parent into 2.5 m children and the
  children sit at 1.25/3.75/6.25/8.75 while the surviving parent sits at 5.0:
  two classes, decisively. The 2.5-in-10 case the code documented as
  undetectable is now caught.

  **The floor**: an ODD factor — 2.5 m inside 7.5 m — puts every child centre
  and every surviving parent centre on the same fine lattice. Those coordinates
  are not merely similar to a patchy 2.5 m grid, they are the *same set*. No
  coordinate test separates them, and the suite asserts the miss so nobody
  reads the detector as total. The mitigation is the issue's own fallback: an
  explicit cell-size confirmation at ingest, asked on **every** model because
  the undetectable case looks exactly like the clean one. A silent wrong
  tonnage becomes an assumption somebody put their name to.

  18 sub-block assertions, including that a patchy grid and a sub-blocked model
  built to produce identical gap histograms come back with different verdicts.

- **2026-08-10** — Reviewed `docs/COMPARISON.md` and both competitive audits;
  synthesised the highest-value features per platform (Bedrock / VRIFY
  Present / Terrahutton) and a "10 candidates, cut to 5" pass on what to
  build next. Decision: **no client-supplied imagery or footage of any
  kind** anywhere in the terrain/maps work — cuts the customer-orthophoto
  and reality-mesh ideas from issue #10's original scope (full reasoning on
  the issue and in the new P0 section above). Filed 5 new issues (#11–#15)
  for the items that survived the cut — all protect or extend the core
  differentiator rather than add new surface area. Closed issue #9
  (neighbour logos) as already shipped in `0369229`. Flagged a numbering
  collision: this file's own local #9–#13 (below) were never filed as real
  GitHub issues and are unrelated to GitHub's actual #9–#15.

- **2026-08-09** — Competitive comparison written up in `docs/COMPARISON.md`,
  scoped to the presenting product: Bedrock vs VRIFY Present vs Terrahutton.
  Assessed from public material only — neither competitor product has been
  used, VRIFY offers no free trial, and the doc says so rather than implying a
  depth of assessment it does not have.

  The finding that matters is structural rather than featural: **both
  competitors sell a done-for-you service.** VRIFY's own FAQ says their data
  team builds the models and onboarding runs 10–15 business days; Terrahutton's
  process is the same shape. Neither offers self-serve authoring. So the
  competition is not feature-for-feature — it is a service with a high quality
  floor against software with a faster update cycle, and most of what this
  repository does about honesty and slide generation exists to raise the floor
  that a data team would otherwise provide.

  Recorded honestly on our side too: no customers against VRIFY's stated 185+,
  one end-to-end run, mobile still broken, and two flows never clicked in
  anger. The doc's closing line is that the next thing worth doing is not a
  feature.

- **2026-08-09** — **First real end-to-end run: console contract → viewer.**
  `tools/seed_demo_deck.mjs` builds a project, zone, artifacts in storage,
  datasets, a deck whose chapters come from the same generator the console
  uses, and a share link — then opens it. Every hydration check before this
  used a hand-written fixture, which proves the reader and not the contract.
  The first run found three things a fixture never would.

  **The deposit was being placed in the Gulf of Guinea.** `stats.bounds ||
  {x:[0,1],y:[0,1],z:[0,1]}` — a stats file without bounds put the centre at
  easting 0.5, northing 0.5. The deck did not fail: correct rail, correct
  chapter text, correct tonnage, a completely black screen, and the camera
  twelve thousand kilometres from the property. Extents are derived from the
  columns now, which are right there and cannot disagree with the geometry that
  gets drawn; a recorded bounds that contradicts them is logged, not obeyed.

  **The colour-pop cutout only ever consulted the FABRICATED site ring**, so a
  hydrated deck — real boundaries, no fabricated ones — fell through to a 700 m
  box around the orebody and rendered a pinhole of colour in a black world, on
  a slide captioned "the land package". It uses the real tenure now, and
  chapters can turn the mask off: on a slide about the district, blacking out
  everything outside the claim block defeats the slide.

  **The depth grid was the one layer no chapter could turn off.** It persisted
  from wherever it was last left, so a surface slide inherited floating depth
  rectangles from three chapters earlier.

  Also: with a single zone the opening's third slide and that zone's own
  overview were the same slide with the same title, back to back — the third
  beat is now only generated when there is more than one zone. And the
  classification reveal's last step was titled "Class 0 + Measured + Indicated
  + Inferred"; it reads "Everything, by confidence".

  40 slide assertions · 22 holder · full regression green.

- **2026-08-09** — **Every deck opens the same way**, and the pieces that
  opening needs.

  Three slides, generated always and exempt from trimming: the **district**,
  wide, with the neighbouring companies named on their own ground; the
  **property**, with the issuer's mark and their paragraph; then the **zones**.
  A deck that begins inside the orebody asks an audience to care about a body
  of rock before it has been told where the rock is or who owns it, and the
  answer to both is what makes the rest worth watching. The district slide is
  the exception to "generate everything": with no boundary loaded it is a slide
  about nothing, so it is not offered.

  **The issuer's own brand** — logo and a one-paragraph description — on
  `projects.brand`. It is the only part of slide two a database cannot derive,
  and the fallback text is deliberately a visible placeholder: a generated
  paragraph that sounds authored is worse, because nobody edits what reads as
  finished.

  **Per-holder overrides.** Which neighbours to feature (the company/person
  split is now only the default — a numbered company can be the interesting one
  and a named individual can be a vendor with a royalty), and a free line on
  each card for the thing the register does not know: *1.2 Moz Au · TSXV:BAR*.
  That line is set apart on the card — its own rule, the holder's colour rather
  than the data grey — and named in the audit trail, because claims and
  hectares come from a public register and this does not. On a NEIGHBOUR's card
  it is an assertion about a third party.

  **The register is fetched now, not uploaded.** New `tenure` edge function
  proxying BC Mineral Titles Online; the console widens the property's own
  extent by ~5 km, pulls the surrounding ground, and merges it into the
  boundary dataset without touching a single ring the customer supplied. It has
  to be server-side: BC's WFS sends no `access-control-allow-origin`, so a
  browser fetch is blocked outright.

  The trap there is worth recording. **WFS 2.0 with an EPSG:4326 bbox is
  latitude first.** Getting it backwards does not error — it returns an empty
  collection from the ocean off Somalia, which a console would render as "this
  property has no neighbours". The test asserts the known holders come back,
  not merely that the call succeeded.

  **British Columbia only**, and the function says so by name for any other
  jurisdiction rather than returning nothing. Every register publishes tenure
  differently and there is nothing to generalise to; elsewhere, upload.

  22 holder assertions · 35 slide assertions · 8 tenure assertions against the
  live register. Full regression green.

- **2026-08-09** — **Neighbouring assets.** Companies whose tenure surrounds
  the project now render as assets in their own right: a colour, a filled
  parcel, and a callout carrying a mark, the registered name and the figures —
  `Barranco Gold Mining Corp. · 5 claims · 2,228 ha`. Cards are composited to a
  canvas rather than assembled from a billboard plus two labels, because the
  layout is the point and three stacked entities cannot be made to align.

  **Two bugs, and the first is the reason this layer needs care.** `_subject`
  on a tenure means it OVERLAPS THE DEPOSIT EXTENT, not that we own it — and
  Coast Copper's Home Brew claim sits right on the deposit. The test was
  `c.subject || !c.neighbour`, so that claim rendered in the issuer's gold: the
  deck drew a competitor's ground as its own, next to the orebody, on the slide
  about who holds what. Ownership is the registered owner name and nothing
  else. Second: claim COUNTS were per ring rather than per tenure, so Elk
  Gold's 29 registered claims were captioned as 30. Area was already deduped;
  the count was not, and the count is the number in the caption.

  **A judgement, stated because it is one.** Ten of the sixteen holders here
  are private individuals. Companies get a colour, a mark and their name;
  people get a quiet outline and one aggregate card reading *Privately held ·
  16 claims · 6,272 ha · 11 holders*. "A listed copper company holds the ground
  along strike" is what an investor came for; a named private citizen on an
  investor deck is a decision, not a default.

  Logos are **supplied, never fetched** — a company's mark is its trademark,
  and putting one we found beside real tenure would be an identity we invented
  on a real map. Uploaded per holder in the console (downscaled to 160 px, PNG
  so wordmarks keep their transparency), stored on `projects.holders`, signed
  through the deck payload. Absent, the card draws a monogram, which is honest
  about being a placeholder.

  The rollup moved out of the Python bake into the viewer, so a hydrated
  customer deck gets the same layer the demo does rather than a second
  implementation that drifts. Ingest computes the same rollup so the console
  can offer a logo slot without re-reading the boundary file.

  Also: the conceptual site captions were stacking on one point in plan view.
  Fanned in screen space, because a world-space offset projects to nothing at a
  pitch of −90, which is precisely the chapter they pile up on.

  16 holder assertions — including that Coast Copper is not drawn as ours, that
  areas and counts match the register, and that gold appears only on the
  issuer's own rings. Full regression green.

- **2026-08-09** — **Embedding, per destination.** Four places people actually
  want to put a deck, and they want four different things: WordPress and
  Elementor take markup, Wix and Notion take a bare URL, PowerPoint takes a URL
  through the Web Viewer add-in, and Google Slides takes none of them, because
  **Google Slides cannot embed live web content at all.** There is no iframe
  and no add-in equivalent, and nothing we can ship changes it. The panel says
  so rather than leaving somebody to find out ten minutes before a meeting; the
  route there is the PPTX import.

  The embed panel also now surfaces whether the token it is building a snippet
  for actually *permits* embedding, and any domain restriction on it. It was
  happily generating an iframe for a link whose `allow_embed` is false, which
  renders as a 403 on the customer's website.

  **The exports are doorways now.** A PowerPoint gets forwarded, opened
  offline, printed — the one thing it cannot do is show the model turning. Both
  the PPTX and the PDF carry a link back to the live deck on every slide, with
  the image itself as the target rather than a small piece of text.

  And the export filename was the literal string `Elk-Gold-Siwash-North`, so
  every customer's PowerPoint arrived named after our demo property, on a
  document they were about to send to an investor. Derived from the deck now,
  and the test proves derivation by renaming the deck and looking at the file
  rather than by reading the code.

  9 export assertions, made against the bytes: slide count, the external
  hyperlink relationship in the .pptx, `/URI` link annotations in the PDF, and
  the filename. Full regression green.

- **2026-08-09** — **The studio.** Four pieces of the authoring loop, and five
  bugs found underneath them — three of which were losing people's work.

  **The deck is authored in the thing that renders it.** The viewer runs framed
  by the console in `?author=1`, reports what it is looking at, and the console
  does the writing. That split is the point: the viewer is a public, anonymous
  document anybody with a share link loads, so giving it a session to save a
  chapter with would put tenant write access into that document. The console's
  origin is learnt from its own handshake, never read off a query parameter.
  *Set view* and *Set view + layers* write the camera and every switched layer
  exactly as they are on screen.

  **The camera contract was broken and had never worked.** The console's form
  collected lon/lat/h/heading/pitch and wrote `h` as a HEIGHT IN METRES into
  the key the viewer reads as a HEADING IN DEGREES. Every camera ever authored
  in the console produced a heading of some hundreds of degrees, a default
  pitch and a default range — silently, because those are all legal numbers.
  Camera shapes are tagged now (`orbit` by default, `free` for shots whose
  subject is not the deposit), and the orbit triple is derived by inverting
  HeadingPitchRange in the deposit centre's frame, so the value written is the
  value that replays. Round-tripped against four chapters.

  **Save order was deleting every chapter and re-inserting from the candidate
  template.** Defensible while a chapter was nothing but a copy of its
  candidate; data loss the moment the studio existed. It also matched chapters
  to candidates BY TITLE, so renaming a slide dropped it out of the running
  order and the next save deleted it. Chapters carry a `source` now and the
  save reconciles — the renumber goes through one upsert against the deferred
  unique constraint, proven against real Postgres including a full reversal.

  **A deposit change threw away the slide's camera.** `switchDeposit` ended
  with its own `flyToBoundingSphere`, which landed a second or two after the
  chapter's camera and overwrote it. Every deposit-change slide in the deck was
  ignoring its own shot. Chapter-driven switches now replay the chapter's
  framing against the new centre — which is also required, because an orbit
  camera is an angle on a centre that just moved.

  **The caption bar was eating clicks across the lower half of the screen.**
  `#bar` is full width, several hundred pixels tall on a long caption, and its
  top 70px are a fully transparent gradient. Drawing an area below the midline
  did nothing. Clicking a block did nothing. Clicking a drill hole did nothing.
  `pointer-events:none`, with the controls taking theirs back.

  **A deposit without geophysics crashed the deck.** Switching deposits
  replaces `GEOPHYS` wholesale; the replacement is empty, its corners reach
  proj4 as `undefined`, and the throw comes out of `go()` — so the deck stopped
  changing slides with nothing on screen to say why.

  Also: **a default running order** (#4), an argument rather than a triage
  queue — the ground, what is under it, what was drilled, what it hit, what it
  adds up to, how well it is known. Every candidate is still offered; the
  overflow count is reported rather than silently truncated. **Per-slide
  labels** — presenter areas moved out of localStorage into `chapters.areas`,
  so they travel with the share link and belong to the slide they were drawn
  on. Locally drawn ones still work for anyone who cannot write to the deck,
  and *Save labels* promotes them. **Replay in** flies the transition from the
  previous slide and MEASURES it: when the camera came to rest, when the
  geometry finished, and which the audience was left waiting on.

  Green: 37 UI · 32 hole view · 28 capture · 13 bridge · 11 labels · 11
  transition · 54 formats · 28 deposit · 23 slides · 36 extract · 13 reconcile
  · 47 edge function · RLS clean · text fallback with WebGL refused.

- **2026-08-08** — **Drill hole inspection rebuilt.** Clicking a hole used to
  fly closer at a downward pitch, which frames a several-hundred-metre vertical
  object as a foreshortened stick behind a hillside, among the other thirty-nine.
  It is now a mode: the camera drops to the hole's own mid-depth and stands
  broadside — genuinely underground, verified against `globe.getHeight` at the
  camera rather than against an intent flag — and the hole gets a rendering
  built for that range. The overview's 9 m beads and 16 m collar cubes are
  furniture proportioned for a 2 km camera; close in they are boulders. In
  their place: assay intervals thickened and coloured **on** the trace as a
  downhole log, a depth ladder, and the headline intercept named. Neighbours
  drop to ghost traces. Everything is sized against the hole's own length, so a
  150 m hole and a 400 m hole read identically on screen.

  Three defects found while building it. Translucency is **windowed to the
  deposit footprint**, so "ground cut away" only ever cut the ground over the
  orebody — from underneath you looked out of that window at a fully lit
  hillside across the top of the frame. Saving that rectangle to restore it
  later saved a *live reference* to the object Cesium then overwrites, so the
  restore put `MAX_VALUE` back and the window was gone for the rest of the
  deck; the first assertion written for it (`!!rectangle`) passed anyway,
  because Cesium turns `undefined` into `MAX_VALUE` rather than null. And the
  depth ladder was offset at right angles to the *hole*, which with a broadside
  camera is straight into the screen — every label landed on the trace it was
  meant to sit beside. Offsets are now relative to the camera.

  Also: any chapter that turns drills on now starts from an empty scene — no
  block model, no vein surfaces, no geophysics — because a grade-coloured body
  directly behind a grade-coloured bead makes the assay unreadable, which is
  the one thing such a chapter exists to show. `blocks:true` still opts back
  in. And the rod itself is pickable now; it was not, so the largest thing on
  screen and the only part anyone aims at did nothing when clicked.

  32 hole-view assertions, including no entity leak across repeated focus and
  full restoration of translucency, sun and layer state on exit.

- **2026-08-08** — **The backend suites finally ran.** 47/47 edge-function
  assertions and 25/25 RLS assertions, both green — including the four written
  days ago for the org-id-leak fix that had been deployed on the strength of
  reading the diff. OrbStack refuses to start its daemon from the app icon
  while an update is pending; `orbctl start` works. Adding `seed.sql` had also
  quietly broken `rls_test.sql` — both claimed the `aaaa…` id space and
  collided on `orgs_pkey`, so the suite that proves tenants cannot read each
  other's data had stopped being runnable at all. RLS fixtures now live in
  `bbbb…`.

- **2026-08-08** — #5 geochemistry shipped end to end, and the deck builder got
  thumbnails. Two latent bugs in the shared readers surfaced while testing it,
  both affecting every reader written so far: `Number("")` is 0, so a blank
  easting placed a sample at the origin and a blank grade read as barren; and
  `col()` matched short names as substrings, so looking up arsenic (`"as"`)
  returned the **easting** column — a soil survey's coordinates read as an
  assay. Substring matching is now limited to names of four characters or more.

- **2026-08-08** — Tracker correction: #6 and #7 were still marked not-started
  and had in fact shipped. #4 downgraded to partial — the candidate generator
  covers most of it.

- **2026-08-08** — Uploaded data now renders: drills (desurveyed, with beads,
  grade bars and headline intercepts), surfaces (OBJ/GOCAD/DXF, labelled in
  scene) and claims. Geophysics grids parse and drape from a world file (#2).
  Named targets from `deck.settings.targets`. Assay threshold control. And
  intercepts are labelled **downhole** rather than implying true width.
  Two honesty bugs found and fixed on the way: the geophysics legend said
  FABRICATED unconditionally, so a customer's own airborne survey was captioned
  fabricated; and the product buttons were the demo's, so a hydrated deck
  offered TMI when it held only RTP and 1VD.

- **2026-08-08** — #13 largely done. Projections unblocked (~180 UTM zones +
  named grids, generated not listed). Readers for OBJ / GOCAD / DXF / GeoJSON /
  KML and full collar-survey-assay desurvey by minimum curvature. Aux uploads
  now parse before storing, so an unreadable file is refused by name instead of
  becoming a green slot with nothing behind it. 43 format assertions; the
  desurvey ones check against independently computed trigonometry, which is how
  an inverted dip sign that drilled every hole upwards got caught.
  **Open: OMF, geophysics grids (#2), sub-blocked models without dimension
  columns.**

- **2026-08-08** — Ingest audit (#13). Found that a sub-blocked model would
  have been read at one block volume and reported a confident wrong tonnage,
  silently. Now refused when the file declares per-block dimensions. Verified
  the real Elk Gold export still passes 36/36, so the guard does not
  false-positive on a regular grid.

- **2026-08-08** — Upload is drag-and-drop properly now: drop a folder of
  exports onto a zone and they are classified by filename and routed into
  slots, uploaded without a modal. Block models still open the mapping step
  (their columns must be confirmed before tonnage is computed) and anything
  unrecognised is reported rather than guessed. **Never inferred: whether data
  is fabricated** — that is a claim about provenance, not a property of the
  bytes, so a routed upload records real and the user says otherwise.

- **2026-08-08** — Upload UX: slots are now drop targets. Previously only the
  block-model modal accepted a dropped file; the aux modals (property,
  geophysics, drills, surfaces) had bare file inputs, and the slot boxes
  themselves ignored drops entirely — so the first gesture anyone tries did
  nothing. Dropping on a slot now opens the right modal with the file already
  answered, and every field inside accepts a drop too.

- **2026-08-08** — #9/#10/#11 shipped: candidate generation (shared module),
  the drag-and-drop builder, and computed transitions. Found and fixed a
  latent crash on the deck page — renderChapters() dereferenced a #chlist the
  builder had replaced, and route()'s catch turned a dead page into a toast.
  **Still open: #2 magnetics as first-class data, #4 exploration deck
  template, #5 geochem, #6 drill parsing, #7 surface meshes, #8 deck editor
  zone controls.** Untouched, not started.

- **2026-08-08** — #12 claims-by-lookup shipped for BC, with neighbouring
  holders named. Decision recorded: registry lookup over issuer upload,
  because neighbours cannot be self-asserted.

- **2026-08-08** — #1 console half done: nothing is a required dataset, slots
  reordered exploration-first, deck creation gated on data rather than on a
  resource. #9/#10/#11 opened for generate → curate → transition.

- **2026-08-08** — #3 shipped. `deck` fn is zone-aware and deployed; viewer
  builds the deposit switcher from zones. Fixed the flat-asset-list bug that
  would have mis-rendered any multi-zone deck. **The upload → zones → 3D chain
  is now connected end to end**, with two caveats: the console still asks for a
  block model (#1 console half) and no real multi-zone project has been put
  through it — only fixtures.

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
