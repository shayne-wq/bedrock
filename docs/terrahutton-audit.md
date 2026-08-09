# Terrahutton — competitive audit

**Methodology note — read this first.** The VRIFY audit (`docs/vrify-audit.md`) was
built by directly opening live decks in a browser and interacting with them —
every feature in that document was hands-on verified. This audit could not be
done the same way: `terrahutton.io` and every subdomain under it (plus
`vimeo.com`, hosting their brand video) are blocked outright by this session's
network egress policy, and archive.org is blocked too. Everything below is
reconstructed from search-engine-indexed content — marketing copy, job
postings, LinkedIn/X posts, third-party press coverage of their case-study
customers. **Nothing here is a hands-on feature confirmation.** Where a
capability is inferred rather than stated outright, it's flagged as such. See
"Honest unknowns" and "Recommendation" at the end for what it would take to
close this gap to VRIFY-audit quality.

Purpose is the same as the VRIFY audit: feature parity and better craft for
Orebody. We match capability and craft; we do not copy their name, wordmark,
marketing copy, or their customers' project data.

---

## Audit 1 — product surfaces

Terrahutton is not one product surface but at least three, discovered via
`site:terrahutton.io` and social posts:

| Surface | URL pattern | What it appears to be |
|---|---|---|
| Marketing site | `terrahutton.io` | Home, Usage areas, About Us, Our purpose, Case Studies, Contact, Careers, `/calendar` (demo booking) |
| **Terrahutton View** | `<client-slug>.terrahutton.io` — e.g. `regulus.terrahutton.io` for Regulus Resources' AntaKori project | The actual investor-facing deliverable. Each customer appears to get a **dedicated subdomain**, not a share-token URL under one domain — closer to a white-labelled micro-site per project than Orebody's `?t=<token>` share link. |
| **Terrahutton Vault** | `vault.terrahutton.io` | Surfaced by site search and nav; no description found anywhere indexed. Named like a data room / document repository. **Unconfirmed** — could be a companion product bundling the pitch with diligence documents, or just an internal/login portal. |

Nav items observed on the marketing site (via automated summarization of the
page, not manually confirmed): "Get started for free," "Pricing," "Contact
sales," "Watch demos." This implies **some self-serve tier exists** —
notably different from the fully sales-led motion the VRIFY audit describes
(VRIFY's own `/ai-demo` page is "a booking form with no product in it"). Worth
confirming firsthand; automated page summaries can misread nav structure.

---

## Audit 2 — positioning & claimed capabilities (reconstructed, not hands-on)

### Core framing
> "Redefines data visualization for resource projects, blending 3D
> visualization and interactive technology to transform complex project
> communication into clear, engaging experiences."

> "Brings geology, terrain, infrastructure and regional setting into one
> clear 3D environment" — helping investors understand "where the project
> sits, what surrounds it, and why the location matters."

### Capability claims found in marketing copy and social posts
- **Drill holes, targets, mineralisation and growth scenarios**, explorable
  in 3D (language mirrors VRIFY's "subsurface mineralisation in 3D" almost
  exactly).
- **Regional strategic-positioning as a named feature, not just a camera
  fly-out.** From a post on the Regulus Resources / AntaKori deployment:
  *"...several surrounding operators are approaching the end of their mine
  life, creating convergence of demand, infrastructure, and M&A
  opportunity."* This is a distinct narrative angle — Terrahutton explicitly
  sells the **district-consolidation / M&A thesis**, framed as a platform
  feature, not incidental context. Neither the VRIFY audit nor Orebody's
  current chapter set frames a deposit this way.
- **"The presentation evolves alongside the project"** — implies a
  CMS-like update path where the same URL/subdomain gets new data over time,
  similar in spirit to Orebody's console/ingest → deck model.
- Positioned for **"meetings, conferences, roadshows and stakeholder
  updates"** — same use case as Orebody and VRIFY.
- Explicit **"From Static PDFs to Immersive 3D"** contrast framing (LinkedIn
  post title) — same wedge VRIFY and Orebody use against static decks.

### Explicitly NOT found (absence of evidence, not evidence of absence)
No claim was found anywhere indexed, for or against, on: exact tonnage/grade/
ounce economics or a numeric readout, cut-off filtering, resource
classification handling, cross-sections, geophysics draping as a named
feature, an embed-on-website code snippet, offline/download mode, annotation
tools, audience/engagement analytics, export to PPTX/PDF/image, or a
chapter/section rail UI. Given the user's specific interest — **presenting
the asset for websites and decks** — this is the most important gap in what
I could verify: I found no public claim that a Terrahutton View deck can be
**embedded in a third-party website** the way VRIFY's decks and Orebody's
decks both can. It may exist and simply not be marketed; it may not exist.
Unconfirmed either way.

---

## Tech-stack signal (inferred from job postings — not confirmed architecture)

Terrahutton's careers page (as indexed) lists two open roles at once:

- **Unity Developer** — "hands-on coding in C#," Gothenburg office, on-site,
  EU-resident/Sweden-work-authorized only.
- **Interactive Web 3D Developer** — "expertise in WebGL, Three.js, and
  other 3D technologies," also described as wanting a "CG Generalist... with
  experience in Unity or Unreal Engine."

**Reading this cautiously**: it suggests their current live product (at
least some client deployments) may be a **Unity project exported to WebGL**
— a game-engine build rather than a native web stack — while a separate or
newer hiring track builds toward (or migrates to) a Three.js-based web
product. This is inference from job-ad requirements, not a confirmed
architecture; I could not load a live `*.terrahutton.io` page to check for
Unity's characteristic loading screen, `.wasm`/`.data` bundle requests, or a
`UnityLoader`/`framework.js` script tag.

**If true, the practical implications matter directly to "presenting the
asset for websites and decks":**
- Unity WebGL builds are typically **large downloads** (commonly tens to
  100+ MB) with a slow first paint — a real liability for a mobile investor
  opening a link at a conference, the exact scenario this session's own
  boot-diagnostics work was built to catch.
- Game-engine WebGL exports are usually **harder to deep-link and embed
  cleanly** in a third-party site (iframe sizing, load-blocking, less
  control over SEO/meta tags) than a plain DOM + Cesium page like Orebody's.
- A **CG Generalist** role also on the team suggests real bespoke 3D-asset
  production per client — plausibly a higher production cost/time per deck
  than Orebody's data-driven, code-generated approach (`tools/build_present.py`
  regenerates the whole deck from data with no manual art pass).

None of this is claimed by Terrahutton; it is my best reading of what two
job postings imply, and it should be verified before it's used in any
customer-facing claim.

---

## Audit 3 — who uses it

Confirmed via case-study pages, press coverage, or direct social posts:

| Customer | Project | Region |
|---|---|---|
| Quimbaya Gold | Tahami South | Segovia district, Colombia |
| Mogotes Metals | Filo Sur | Vicuña district, Argentina (adjacent to Lundin/BHP's Filo del Sol) |
| Firefox Gold | Lapland Greenstone Belt projects | Northern Finland |
| Regulus Resources | AntaKori | Cajamarca district, Peru |
| AbraSilver Resource Corp | Diablillos | Salta, Argentina — referenced via a LinkedIn hashtag post only, **not** yet a confirmed full case study |

**Company signal**: HQ in Gothenburg, Sweden. A handful of named LinkedIn
profiles found (a Key Account/Client Director role among them); two
developer roles open as of these postings. Reads as an **early-stage,
smaller team** than VRIFY — the existing VRIFY audit documents a named
leadership team, a dedicated Mining Hub distribution partnership reaching
~5,300 monthly visitors, and a longer named-customer list (Equinox Gold,
Osisko Development, Calibre Mining, G Mining Ventures, and others).

**Geographic pattern worth noting**: every confirmed customer is a LatAm or
Nordic-Europe junior explorer — no confirmed flagship North American
TSXV/NYSE-American customer the way VRIFY has. That said, both Mogotes
Metals and Regulus Resources are TSXV-listed and Terrahutton has posted
about attending a Vancouver conference, so they are actively reaching into
that market — just apparently more recently than VRIFY has.

---

## Gap analysis vs Orebody

**Where Terrahutton may be ahead (confirmed claim or plausible inference):**
- **District/M&A strategic-positioning as a named, marketed feature.**
  Orebody's viewer renders property, tenure, and surrounding claims, but
  nothing in the codebase explicitly narrates a neighboring operator's
  mine-life stage or an M&A thesis as a chapter/feature. Worth considering
  as a chapter type.
- **Per-client subdomain/branding** (`<client>.terrahutton.io`) may read as
  more "their own site" to a customer than a share-token URL off
  `orebody-fawn.vercel.app`. A custom-domain or white-label option is a
  packaging question worth thinking about, independent of anything visual.
- **A possible companion data-room product ("Vault")** bundling the pitch
  with the documents an investor needs next. Orebody has no equivalent.
  Unconfirmed as a real product, but worth watching.

**Where Orebody is likely ahead or at parity, based on what's actually in
this repo and confirmed by hands-on development (not marketing copy):**
- **Exact, share-weighted, reconciled tonnage/grade/ounce readout**, with a
  fabricated-data labelling system that reaches the on-screen banner, export
  burn-in, audit text and embed disclosure (see `docs/vrify-audit.md`'s
  closing note). No evidence anywhere in Terrahutton's public materials of
  this level of numeric rigor or provenance — their language stays narrative
  ("explore drill holes, targets, mineralisation"), never mentions exact
  rollups, reconciliation, or synthetic-data disclosure.
- **Confirmed technical depth** already shipped: real cross-section
  clipping, progressive resource-classification reveal, geophysics draping,
  a drill ledger tied to the same geometry as the rendered traces. Nothing
  in Terrahutton's indexed materials claims this specificity.
- **If the Unity-WebGL inference above is correct**, Orebody's plain-web
  Cesium + proj4 stack likely loads faster, is lighter on mobile, and is
  easier to embed — directly relevant to "presenting the asset for websites
  and decks," which was the ask here.
- **Embeddability**: Orebody has a confirmed embed path (`EMBED` query
  param, an embed kit, autoplay control — see `index.html` and the console's
  embed-snippet code referenced in the VRIFY audit). I found **no public
  claim** that a Terrahutton View deck can be embedded in a third-party
  website at all. This is the single largest gap in what I could verify on
  the exact question asked.

---

## Honest unknowns

Could not verify, for or against, any of: annotation tools, chapter/rail
navigation UX, export formats (PNG/PPTX/PDF/video), offline or
download-in-advance mode, viewer engagement analytics, actual page-load
performance, real mobile behaviour, pricing tiers, whether an embed
capability exists, section/cross-section views, resource-classification
handling, cut-off-grade filtering, or whether "Vault" is a real second
product or an internal portal.

## Recommendation

To bring this to VRIFY-audit quality, someone needs actual hands-on access
to a live Terrahutton View deck (e.g. `regulus.terrahutton.io`) — this
session's network policy blocks the entire domain. Two ways to close that:

1. **You open it yourself** in a normal browser and share a screen recording
   or walk through what you see (chapters, layers, embed option, load time,
   mobile behaviour) — I can fold that straight into this document.
2. **Run this same audit from an environment without the domain block**, the
   way the VRIFY audit was evidently done, and replace the "reconstructed"
   sections above with hands-on findings.

---

_Audit opened 2026-08-09, built entirely from search-indexed content —
marketing copy, job postings, and social/press coverage of named customers.
No live Terrahutton product surface was directly inspected. Update this file
once hands-on access is available._
