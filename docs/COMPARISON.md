# Bedrock vs VRIFY Present vs Terrahutton

Scope: **the presenting product only**. VRIFY also sells Predict/DORA — AI
prospectivity mapping — and Terrahutton sells a data-integration service around
its visuals. Neither is compared here.

## How this was assessed, and its limits

Read this first, because it bounds everything below.

- **Bedrock** — assessed from the inside. Every claim about it is verifiable
  against this repository and its test suites.
- **VRIFY Present** — assessed from vrify.com (product and pricing pages, and
  the pricing FAQ, read August 2026), plus seven product screenshots the user
  captured from a live VRIFY deck.
- **Terrahutton** — assessed from terrahutton.io only. Their site is marketing
  copy with no technical detail: no formats, no pricing, no description of how
  a deck is built or shared. The three case studies name Quimbaya Gold, Mogotes
  Metals and Firefox Gold, and 20+ client logos include Lundin Mining and Abra
  Silver.

**Neither competitor product has been used.** No trial was run, no demo taken.
Where a row below says *unknown*, that is not a euphemism for "worse" — it means
their public material does not say and I did not guess. VRIFY explicitly offers
no free trial, so the only route to a real assessment is a sales demo.

---

## The structural difference

Everything else follows from this, so it belongs at the top rather than in a
feature table.

**VRIFY and Terrahutton both sell a done-for-you service.** VRIFY's pricing FAQ
is explicit: *"Our specialized data team collaborates to build 3D models and
360° imagery that bring your project to life."* Onboarding is *"10–15 business
days, depending on data availability."* Terrahutton's process is four steps —
data integration, platform development, continuous updates, presentation
readiness — with the platform built for you. Both are demo-led with no public
pricing and no self-serve entry.

**Bedrock is software the issuer operates.** Upload, generate, arrange, fly the
camera, publish. No data team in the loop.

That is a bet, not a victory. It cuts both ways:

| | Service model (VRIFY, Terrahutton) | Software model (Bedrock) |
|---|---|---|
| Time to first deck | 10–15 business days | Minutes, if the data is clean |
| Who does the work | Their geoscientists | The issuer |
| Cost structure | People — scales with headcount | Compute — scales with usage |
| Quality floor | High. Professionals build every deck | Whatever the tool enforces |
| Quality ceiling | Their team's taste | The issuer's, plus the tool's |
| Updating with new assays | Send it to them, wait | Re-upload |
| Who it suits | A team with money and no time | A team with data and no budget |

The service model's quality floor is the thing to respect. A junior IR manager
with a messy CSV will produce a worse deck in Bedrock than VRIFY's team would
produce from the same file. **Most of what this repository does about honesty
and slide generation exists to raise that floor** — because without a data team,
the floor is the product.

---

## Feature comparison

✅ shipped and tested · ⚠️ shipped, untested or partial · ❌ absent · ? unknown

### Getting data in

| | Bedrock | VRIFY Present | Terrahutton |
|---|---|---|---|
| Self-serve upload | ✅ | ❌ — their team ingests | ❌ — their team ingests |
| Block models | ✅ CSV, any column mapping | ✅ (via their team) | ? |
| Drilling | ✅ collars + surveys + assays, min-curvature desurvey | ✅ CSV | ? |
| Wireframes / solids | ✅ OBJ, GOCAD `.ts`, DXF 3DFACE | ✅ DXF shells | ? |
| Boundaries | ✅ GeoJSON, KML, + **fetched from the BC register** | ? | ? |
| Geophysics grids | ⚠️ georeferenced image + world file; no GeoTIFF or Geosoft `.grd` | ✅ GeoTIFF | ? |
| Geochemistry | ✅ percentile-scaled, detection limits handled | ? | ? |
| Refused with a reason | ✅ OMF, Datamine `.dm`, Vulcan `.bmf` named, with what to export instead | n/a — a human reads it | n/a |
| Sub-blocked models | ❌ refuses when it can detect them; **cannot always detect them** | ? | ? |

GeoTIFF is a real gap: it is the standard magnetics deliverable and VRIFY takes
it directly.

### Building the deck

| | Bedrock | VRIFY Present | Terrahutton |
|---|---|---|---|
| Slides proposed from your data | ✅ every view the data supports, gated on what exists | ❌ | ❌ |
| Opinionated default running order | ✅ | n/a — a person decides | n/a |
| Mandatory opening (district → property → zones) | ✅ | ? | ? |
| Drag-and-drop ordering | ✅ | ? | ? |
| Author the camera by flying to it | ✅ studio: fly, press *Set view* | ? | ? |
| Per-slide layer state | ✅ every switch captured | ? | ? |
| Per-slide map annotations | ✅ drawn in the viewer, published to the slide | ? | ? |
| Transition preview with timing | ✅ measures when camera and geometry land | ❌ seen | ❌ seen |

### Presenting

| | Bedrock | VRIFY Present | Terrahutton |
|---|---|---|---|
| Real terrain, georeferenced | ✅ Cesium World Terrain, true UTM placement | ✅ | ✅ |
| 360° photospheres | ❌ deliberate — real terrain instead | ✅ a headline feature | ? |
| Live cut-off grade during a talk | ✅ held across slides | ? | ? |
| Terrain opacity, live | ✅ | ? | ? |
| Sections through the model | ✅ moveable slabs, readout re-totals per slice | ✅ (screenshots) | ? |
| Drill hole inspection | ✅ underground, broadside, downhole log | ✅ (screenshots) | ? |
| Neighbouring holders as assets | ✅ dissolved outlines, logos, notes | ❌ not seen in screenshots | ❌ not seen |
| Narration / autoplay | ✅ | ? | ? |
| Presenter annotation over the scene | ✅ ink + georeferenced areas | ? | ? |

### Getting it out

| | Bedrock | VRIFY Present | Terrahutton |
|---|---|---|---|
| Share link, revocable | ✅ + passcode, expiry, domain limits | ✅ | ? |
| Website embed | ✅ per-platform: WordPress, Wix, Notion, Squarespace | ✅ "on our website" | ? |
| PowerPoint | ✅ PPTX, one slide per chapter, links back to the live deck | ? | ? |
| Google Slides | ✅ via PPTX import — Slides cannot embed live web content | ? | ? |
| PDF | ✅ with link annotations | ? | ? |
| Audience analytics | ✅ per chapter, per embedding page, watch time | ? | ? |
| Works without WebGL | ✅ full text edition, every figure in a real table | ? | ? |

---

## Where Bedrock is genuinely ahead

Four things, and only the first is a feature.

**1. Nobody else is selling self-serve.** Both competitors require their staff
in the loop for every deck and every update. Every new assay batch is an email
and a wait. If self-serve authoring works, the update cycle collapses from
days to minutes, and that is the whole product.

**2. Provenance is enforced, not documented.** Fabricated data carries a banner
the presenter cannot remove, burned into exported images and recordings.
Author-written callout lines are visually separated from register-derived
figures and named in the audit trail. Every tonnage is derived from geometry,
never typed — the deck cannot state a number the model does not support. I have
seen nothing comparable claimed by either competitor. For a product used in
securities communication, this is the most defensible thing here.

**3. The neighbouring-asset layer.** Registered holders read from a public
register, dissolved into one outline per company, with logos, callouts and
figures. It is the one claim an issuer cannot make about itself, and neither
competitor's public material shows it.

**4. Format breadth at the door.** VRIFY names CSV, DXF, GeoTIFF and layered
PDF as the efficient set — with a human to handle the rest. Bedrock reads OBJ,
GOCAD, DXF, GeoJSON, KML, collar/survey/assay tables, geochemistry and world
files unattended, and names what it refuses.

---

## Where Bedrock is behind

**Track record.** VRIFY states 185+ clients and 35+ experts. Terrahutton shows
20+ logos including Lundin Mining. Bedrock has zero customers and one
end-to-end run, done yesterday. In a conservative industry buying a document
that goes to investors, that gap is larger than any feature difference in this
report.

**The service is a feature.** "Send us your data, get a deck in two weeks" is
an easier purchase than "learn our tool" for a CEO with a conference next
month. Self-serve is not automatically the winning side of this trade.

**360° imagery.** VRIFY leads with it. Bedrock deliberately chose real terrain
instead — defensible, and a real absence when a customer wants to stand people
on their outcrop.

**GeoTIFF and Geosoft `.grd`.** The standard magnetics deliverables. Currently
an image plus a world file, which asks the customer to export something they
would not otherwise make.

**Mobile is broken and unresolved.** Multiple attempts, never reproduced, no
diagnostic report received. An investor deck that fails on a phone fails in the
room it is most often opened in. This is the most serious open defect.

**Sub-blocked models.** Refused when detectable, and the coordinate-based
detector genuinely does not always detect them. A sub-blocked model read as a
regular one produces wrong tonnage with no symptom.

**Two paths have never had a real click** — neighbour logo upload, and the
registry fetch button. Everything behind them is tested; the buttons are not.

**Registry lookup is British Columbia only.** Every jurisdiction publishes
tenure differently. Elsewhere the customer uploads.

---

## What I cannot assess

Stated plainly, because a comparison that pretends to certainty is worth less
than one that does not.

- **How good VRIFY's decks actually look and feel in the room.** Seven
  screenshots is not a product evaluation. The screenshots showed genuinely
  strong work: clean assay tables, a grade-as-vertical-bar property view, a
  blackout-and-drills sequence. Several features in this repository were built
  after seeing them.
- **Terrahutton's product at all.** Their site describes an outcome, not a
  system. They may do everything in this table.
- **Pricing on either side.** Neither publishes. Without it, no statement about
  value is possible.
- **Reliability, support, and what happens to a deck when a subscription ends.**
  VRIFY's FAQ does not address the last one, and it matters: a deck embedded on
  an issuer's website is a dependency.

---

## The honest summary

Bedrock is ahead on **what the software does without a human in the loop**, and
on **provenance**, which nobody else appears to be treating as a feature. It is
behind on **evidence that it works** — no customers, one end-to-end run, a
broken mobile path, and two flows never clicked in anger.

The competitors are not selling better software. They are selling a team, and
they have the client lists to show it works. The bet is that issuers would
rather do it in an afternoon than wait two weeks, and that the guardrails here
make an unassisted deck safe enough to send to investors.

That bet is currently unvalidated. The next thing worth doing is not a feature.

---

*Written 2026-08-09. Competitor material read the same day; both sites change.
Nothing here is from using either product.*
