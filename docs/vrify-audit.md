# VRIFY Present — competitive audit

Three passes: the marketing site, the live decks, and who actually uses it.
Purpose is feature parity and better craft for Orebody. We match capability and
UX; we do not copy their name, wordmark, marketing copy, or their customers'
project data.

---

## Audit 1 — the site

`vrify.com` product line is three things, only one of which we compete with:

| Product | What it is |
|---|---|
| **Present** | Interactive 3D geoscience presentations. Our competitor. |
| **Predict** | AI prospectivity. 10 deposit-type models, trained on their exploration database. Sub-brand "DORA". |
| **Signal** | Press releases rendered in 3D. Beta. |

Present's own claims: embeddable in a website · subsurface mineralisation in 3D ·
mine development and project evolution over time · bridges technical and
non-technical audiences · delivery across connected iPads, in person, online or
hybrid · downloadable in advance for low connectivity.

Site map: `/product`, `/product/present`, `/product/predict`, `/resources`,
`/case-studies/*`, `/media`, `/meetings`, `/about`, `/leadership-team`,
`/careers`, `/contact`, `/legal/*`, `/ai-demo` (a lead form, not a demo),
`/mining-company-solutions`, `share.vrify.com/product`.

`/ai-demo` is a booking form with no product in it. The real product is only
visible through the embedded decks.

---

## Audit 2 — the decks

The marketing page understates the product badly. The decks are where the
feature set actually lives.

### Equinox Gold — Valentine (17 slides, 5 sections)

Property Overview → Property w/ Pits → Property w/ Pits & Shear → AI Results ·
**Minotaur**: AI Results, Land Acquisition, Feature Importance, Drill Collars,
Drilling >0.3 g/t, Highlights, Section View · **Frank Zone**: Property w/ Pits &
Shear, Frank Zone, Highlights, Property Overview · **3D Appendix**

Techniques observed:
- **Colour-pop masking** — full-colour satellite inside the claim, near-black
  greyscale outside. The property is the only saturated thing on screen.
- **Progressive layer reveal on one persistent scene.** Each slide is a camera
  move plus a layer toggle, never a new scene.
- **Structural surfaces as translucent meshes** — the shear zone as a curved
  body plunging through terrain.
- **Drill assays as beads on hair-thin traces**, collars as small 3D gems.
- **Intercept callouts** — hole id over the assay on leader lines to red
  markers, fanned left and right to avoid stacking.
- **Analytical chart panels as slides** — SHAP beeswarm of feature importance
  with a model-performance gauge.
- **Floating scene captions** — pills placed next to what they describe.
- Pits as stepped bench cones carved into terrain, not flat polygons.
- Claim boundaries as heavy yellow polylines.

### Osisko Development — Tintic (66 slides, 11 sections)

Sections: PROJECT LOCATION · TRIXIE MINE · TRIXIE RESOURCES · FACE SAMPLING ·
EXPLORATION · GEOLOGY · GEOPHYSICS · BURGIN · SURROUNDING AREA.

This deck is where the depth of the platform shows. Additional capabilities:

- **Geophysical raster layers** draped on terrain — Total Magnetic Intensity,
  TMI Reduced-to-Pole, RTP First Vertical Derivative. Multiple derived products
  of the same survey as separate slides.
- **Cross-sections** — North-South, East-West, and five lettered USGS geologic
  sections as their own slides.
- **Progressive resource classification reveal** — Measured, then Measured and
  Indicated, then Measured/Indicated/Inferred, then a resource table. The
  category is revealed cumulatively across consecutive slides.
- **Face sampling by element** — Au, then Ag, then Au against resources.
- **360° site photography, including underground** — mining faces, portals,
  level stations, decline development, processing plant, assay lab.
- **Alteration and geology maps** draped on terrain.
- Autoplay control, and annotations bound to a keyboard shortcut.

Other public decks: Prime Mining (Apr 2024), Calibre Mining (Jan 2025),
G Mining Ventures feasibility study, Northern Miner Group, Cue Project.

---

## Audit 3 — who uses it

Named on their own case studies and public decks:

Equinox Gold · Osisko Development · Calibre Mining · Prime Mining ·
G Mining Ventures · Vizsla Copper · Avino Silver & Gold · Cartier Resources ·
Canterra Minerals · RUA GOLD · Southern Cross Gold · Nevada Sunrise ·
Northern Miner Group.

Distribution: a Mining Hub partnership pushes decks to ~5,300 monthly visitors.
Positioning is investor engagement first, technical communication second.

---

## Gap against Orebody

**Matched:** colour-pop masking · discrete opaque grade shells · ground cut-away
· depth grid labelled in metres · drill beads on thin traces · intercept
callouts · collar markers · floating scene captions · section-grouped rail with
thumbnails · chart slides · annotation with undo/colours · autoplay · narration ·
deep links · embed mode · offline · PNG/PPTX/PDF export · vein-domain surfaces ·
plan-view grade × thickness map · conceptual pit with benches · mine-plan
timeline.

**Where we are better:** the readout sums exact share-weighted rollups and is
provably consistent with what is drawn under every filter; nothing fabricated
can reach the screen or an export without a label; surfaces are exterior-face
extractions that invent no geometry between data points.

**Still open:**
1. **Cross-sections** — clipped N-S / E-W slices as their own slides. Their
   Tintic deck has seven. We have camera angles, which is not the same thing.
2. **Progressive classification reveal** — M → M+I → M+I+I across consecutive
   slides. We have a classification colour mode but no cumulative reveal.
3. **Geophysics raster layers** — needs survey data we do not have.
4. **360° site photography** — needs someone to go and shoot it.
5. **Multi-deposit decks** — structure supports it, data does not.
6. **Synced multi-device sessions** — needs a realtime backend.
7. **Content management** — needs auth and storage.
