// Bedrock — fetch neighbouring mineral tenure from a public register.
//
// "Show the companies whose ground surrounds ours" is the most persuasive
// thing on an early-stage deck, and it is the one claim an issuer cannot make
// about itself: only a register can say who holds the ground next door. Up to
// now that meant the customer exporting a boundary file and uploading it,
// which they will not do for their neighbours' claims.
//
// This has to be a server-side hop. BC's WFS returns no
// `access-control-allow-origin`, so a browser fetch from the console is
// blocked outright — the proxy is not a convenience, it is the only route.
//
// SCOPE: one bounded adapter per jurisdiction, never a generic abstraction.
// Registers do not agree on protocol, field names, licence, axis order or even
// whether they will hand you geometry at all, and pretending otherwise
// produces a layer that silently returns nothing somewhere.
//
// A register QUALIFIES only if it publishes, in one queryable layer, both the
// boundary and the HOLDER. The holder is the entire feature — "a listed copper
// company holds the ground along strike" is the claim an issuer cannot make
// about itself. Registers that fail that test are recorded in NOT_WIRED below
// so the next person does not spend an afternoon rediscovering it.
//
// GET /functions/v1/tenure?bbox=<west>,<south>,<east>,<north>[&jurisdiction=bc]
// Authenticated: this is a console feature. The anon key gets nothing.

import { CORS, json, preflight } from "../_shared/http.ts";

const BC_WFS = "https://openmaps.gov.bc.ca/geo/pub/ows";
const BC_LAYER = "pub:WHSE_MINERAL_TENURE.MTA_ACQUIRED_TENURE_SVW";
const SK_LAYER =
  "https://gis.saskatchewan.ca/arcgis/rest/services/Economy/" +
  "Mineral_Tenure_Crown_Dispositions/MapServer/0";
// GeoYukon. Two layers: quartz CLAIMS (36) and quartz LEASES (37), a lease
// being a claim that has been surveyed and converted.
//
// I first wired both on the assumption that a lease leaves the claims table,
// so querying claims alone would punch a hole in the outline exactly where the
// mine is. **That is wrong.** Checked against Macpass: all 182 of Fireweed's
// lease grant numbers also appear in the claims layer, so layer 37 returned no
// ground layer 36 had not already given us — it returned 182 duplicate
// polygons, which the artifact then stored twice.
//
// It is still queried, for one reason: a lease whose claim record is absent
// cannot be ruled out from one property, and missing ground is a worse failure
// than a redundant request. What makes that free is the dedupe below — without
// it, "both layers" is not thoroughness, it is double-counting.
const YT_BASE =
  "https://mapservices.gov.yk.ca/arcgis/rest/services/GeoYukon/GY_Mining/MapServer";
const YT_LAYERS = [
  { id: 36, kind: "Quartz claim" },
  { id: 37, kind: "Quartz lease" },
];

// Checked and rejected, with the reason, so this is not re-litigated:
//
//   fi  Tukes/GTK Kaivosrekisteri — the layer advertises Query on polygons and
//       then returns every attribute with a null geometry, in both Esri JSON
//       and GeoJSON, with or without an outSR. No boundary, no layer.
//   us  BLM Mining Claims (gis.blm.gov) — geometry is fine, but the public
//       spatial layer carries only CSE_NAME. The claimant lives in LR2000 and
//       is not joined to the polygon, so there is no holder to name.
//
// Both remain upload-path jurisdictions.
const NOT_WIRED: Record<string, string> = {
  fi: "Finland's mining register (Tukes) publishes tenure boundaries but " +
      "withholds the geometry from its public query endpoint",
  us: "the BLM claims layer publishes boundaries without the claimant, and " +
      "the holder is the whole point of this layer",
};

// A window big enough to be a neighbourhood and small enough to be a request.
// Roughly 55 km on a side at this latitude; past that the caller is asking for
// a province, and the honest answer is to say so rather than to time out.
const MAX_SPAN_DEG = 0.5;
const MAX_FEATURES = 1200;
// Yukon gets its own ceiling because a Yukon parcel is a different size of
// thing. A quartz claim is ~21 ha, so a property that would be a few dozen
// tenures in BC is a few thousand here — Fireweed's Macpass block alone is
// ~2,300. Capping it at 1,200 would not return "most of the property", it
// would return a shape with the middle missing, and the dissolve would draw
// that as fact. The layers page at 2,500; we ask for 1,000 at a time.
const YT_MAX_FEATURES = 4000;
const YT_PAGE = 1000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  // Verified by the platform before we are reached, so its absence means the
  // function was deployed with --no-verify-jwt by mistake. Fail rather than
  // become an open proxy that anybody can point at a government endpoint.
  const auth = req.headers.get("Authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return json({ error: "Sign in to fetch tenure." }, 401);
  }

  const url = new URL(req.url);
  const j = (url.searchParams.get("jurisdiction") || "bc").toLowerCase();
  if (j !== "bc" && j !== "sk" && j !== "yt") {
    const known = NOT_WIRED[j];
    return json({
      error: known
        ? `Not available for ${j.toUpperCase()}: ${known}. Export the ` +
          `boundaries from the registry and upload them as GeoJSON or KML.`
        : `Automatic tenure lookup is wired up for British Columbia, ` +
          `Saskatchewan and Yukon. For ${j.toUpperCase()}, export the ` +
          `boundaries from the registry and upload them as GeoJSON or KML.`,
      unsupported_jurisdiction: j,
      supported: ["bc", "sk", "yt"],
    }, 400);
  }

  const parts = (url.searchParams.get("bbox") || "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return json({ error: "bbox must be west,south,east,north in degrees" }, 400);
  }
  const [w, s, e, n] = parts;
  if (!(w < e && s < n)) return json({ error: "bbox is inside out" }, 400);
  if (e - w > MAX_SPAN_DEG || n - s > MAX_SPAN_DEG) {
    return json({
      error: `That area is too large — ask for under ${MAX_SPAN_DEG}° a side.`,
    }, 400);
  }

  // Each adapter returns features already normalised to the field names the
  // console's rollup reads — OWNER_NAME, CLAIM_NAME, TENURE_NUMBER_ID,
  // AREA_IN_HECTARES. Translating here rather than downstream means adding a
  // jurisdiction never touches the console.
  // One GET, or several. BC and SK answer in a single request; Yukon needs two
  // layers and pages within each, so a source declares the requests it takes
  // rather than a single url.
  // Grouped by layer, one group per registry table, pages in order within a
  // group. A short page ends its own group without abandoning the next one.
  const ytUrls: string[][] = [];
  for (const L of YT_LAYERS) {
    const pages: string[] = [];
    for (let off = 0; off < YT_MAX_FEATURES; off += YT_PAGE) {
      pages.push(`${YT_BASE}/${L.id}/query?` + new URLSearchParams({
        where: "1=1",
        // ArcGIS envelope, longitude first — same axis order as SK, the
        // opposite of the WFS above.
        geometry: `${w},${s},${e},${n}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326", outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "CLAIM_LABEL,CLAIM_NAME,CLAIM_NUMBER,GRANT_NUMBER," +
                   "OWNER_NAME,TENURE_STATUS,SHAPE.AREA",
        returnGeometry: "true", f: "geojson",
        resultOffset: String(off), resultRecordCount: String(YT_PAGE),
      }));
    }
    ytUrls.push(pages);
  }

  const source = j === "bc"
    ? {
      name: "BC Mineral Titles Online",
      endpoint: BC_WFS,
      dataset: BC_LAYER,
      licence: "Open Government Licence – British Columbia",
      attribution:
        "Contains information licensed under the Open Government Licence – British Columbia.",
      // WFS 2.0 with an EPSG:4326 bbox is LATITUDE FIRST. Getting this
      // backwards does not error — it returns an empty collection from the
      // ocean off Somalia, which reads as "no neighbours".
      urls: [[`${BC_WFS}?` + new URLSearchParams({
        service: "WFS", version: "2.0.0", request: "GetFeature",
        typeNames: BC_LAYER, outputFormat: "application/json",
        srsName: "EPSG:4326", count: String(MAX_FEATURES),
        bbox: `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`,
      })]],
      cap: MAX_FEATURES, page: MAX_FEATURES,
      // Already in the shape we want.
      normalise: (f: Record<string, unknown>) => f,
    }
    : j === "sk"
    ? {
      name: "Saskatchewan Mineral Tenure — Crown Dispositions",
      endpoint: SK_LAYER,
      dataset: "Mineral Dispositions",
      licence: "Government of Saskatchewan open data",
      attribution: "Contains information provided by the Government of Saskatchewan.",
      // ArcGIS takes the envelope as west,south,east,north — LONGITUDE first,
      // the opposite of the WFS above. Two registers, two axis orders, and
      // neither errors when you get it wrong.
      urls: [[`${SK_LAYER}/query?` + new URLSearchParams({
        where: "1=1",
        geometry: `${w},${s},${e},${n}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326", outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "DISPOSIT_1,OWNERS,DISPOSIT_3,SHAPE.AREA",
        returnGeometry: "true", f: "geojson",
        resultRecordCount: String(MAX_FEATURES),
      })]],
      cap: MAX_FEATURES, page: MAX_FEATURES,
      normalise: (f: Record<string, unknown>) => {
        const p = (f.properties || {}) as Record<string, unknown>;
        // "URACAN RESOURCES LTD.: 100.000%" — and on jointly held ground,
        // several of those comma-separated. Take the largest share and say so,
        // rather than inventing a single owner for a joint venture.
        const raw = String(p.OWNERS || "");
        const parties = raw.split(/,(?=[^,]*:\s*[\d.]+%)/)
          .map((t) => {
            const m = t.match(/^(.*?):\s*([\d.]+)%\s*$/);
            return m
              ? { who: m[1].trim(), share: parseFloat(m[2]) }
              : { who: t.trim(), share: 100 };
          })
          .filter((x) => x.who)
          .sort((a, b) => b.share - a.share);
        const lead = parties[0];
        return {
          ...f,
          properties: {
            OWNER_NAME: lead ? lead.who : "",
            CLAIM_NAME: String(p.DISPOSIT_1 || ""),
            TENURE_NUMBER_ID: String(p.DISPOSIT_1 || ""),
            // SHAPE.AREA is square metres in the layer's own projection.
            AREA_IN_HECTARES: Number(p["SHAPE.AREA"] || 0) / 10000,
            TENURE_TYPE_DESCRIPTION: String(p.DISPOSIT_3 || "Mineral disposition"),
            OWNER_PARTIES: parties.length > 1 ? raw : undefined,
          },
        };
      },
    }
    : {
      name: "GeoYukon — Quartz Claims and Leases",
      endpoint: YT_BASE,
      dataset: "Quartz Claims - 50k; Quartz Leases - 50k",
      licence: "Open Government Licence – Yukon",
      attribution:
        "Contains information licensed under the Open Government Licence – Yukon.",
      urls: ytUrls,
      cap: YT_MAX_FEATURES, page: YT_PAGE,
      normalise: (f: Record<string, unknown>) => {
        const p = (f.properties || {}) as Record<string, unknown>;
        // "Fireweed Metals Corp. - 100%". The interest is a separate fact from
        // the name, and leaving it attached would make one holder look like
        // several the moment a parcel is jointly held at 60/40 — the dissolve
        // groups on the name, so it would draw two outlines for one company.
        const rawOwner = String(p.OWNER_NAME || "").trim();
        const m = rawOwner.match(/^(.*?)\s*-\s*([\d.]+)\s*%$/);
        const who = (m ? m[1] : rawOwner).trim();
        const share = m ? parseFloat(m[2]) : 100;
        // CLAIM_LABEL is the surveyed label where one exists; otherwise the
        // label a geologist would say out loud is name + number ("Mac 98").
        const label = String(p.CLAIM_LABEL || "").trim() ||
          [p.CLAIM_NAME, p.CLAIM_NUMBER].filter((x) =>
            x !== null && x !== undefined && String(x).trim() !== ""
          ).join(" ").trim();
        return {
          ...f,
          properties: {
            OWNER_NAME: who,
            CLAIM_NAME: label,
            TENURE_NUMBER_ID: String(p.GRANT_NUMBER || label),
            // SHAPE.AREA is square metres in the layer's own projection
            // (EPSG:3578, Yukon Albers). A standard quartz claim comes back
            // near 209,000 — about 21 ha — which is the check that this is
            // metres and not something else.
            AREA_IN_HECTARES: Number(p["SHAPE.AREA"] || 0) / 10000,
            TENURE_TYPE_DESCRIPTION: String(p.GRANT_NUMBER || "").startsWith("YD")
              ? "Quartz claim"
              : "Quartz claim or lease",
            TENURE_STATUS: String(p.TENURE_STATUS || ""),
            OWNER_PARTIES: share !== 100 ? rawOwner : undefined,
          },
        };
      },
    };

  const raw0: unknown[] = [];
  let hitCap = false;
  try {
    for (const group of source.urls) {
      for (const u of group) {
        const r = await fetch(u, {
          signal: AbortSignal.timeout(45000),
          headers: { Accept: "application/json" },
        });
        if (!r.ok) {
          return json({ error: `The ${j.toUpperCase()} registry returned ${r.status}.` }, 502);
        }
        const body = await r.json() as { features?: unknown[] };
        const page = Array.isArray(body?.features) ? body.features : [];
        raw0.push(...page);
        // Pages are generated up front, so a short one means this layer is
        // exhausted and its remaining pages would be empty round-trips. Break
        // the group, not the loop — the next layer still has to be asked.
        if (page.length < source.page) break;
        if (raw0.length >= source.cap) { hitCap = true; break; }
      }
      if (hitCap) break;
    }
  } catch (err) {
    // Their outage, not ours, and the message should say which.
    return json({
      error: `The ${j.toUpperCase()} tenure registry did not respond. It is a ` +
             "public service and does go down; the upload path still works.",
      detail: String((err as Error)?.message || err),
    }, 502);
  }

  const raw = raw0;
  // A feature with no geometry is not a boundary. Finland's register returns
  // nothing but these, and dropping them here means a half-working register
  // surfaces as "no holders found" rather than as claims that draw nowhere.
  const normed = raw
    .map((f) => source.normalise(f as Record<string, unknown>))
    .filter((f) => (f as { geometry?: unknown }).geometry);
  // One parcel, one feature. Yukon returns the same ground from two layers when
  // a claim has been converted to a lease, and shipping both would draw the
  // parcel twice and — worse — count its hectares twice on the one slide whose
  // whole subject is who owns how much. Keyed on the registry's own identifier,
  // so this only ever collapses records the register itself calls the same
  // tenure; a jurisdiction that does not repeat itself loses nothing.
  const byTenure = new Set<string>();
  const feats: unknown[] = [];
  for (const f of normed) {
    const p = ((f as { properties?: Record<string, unknown> }).properties) || {};
    const id = String(p.TENURE_NUMBER_ID || "");
    if (id) {
      if (byTenure.has(id)) continue;
      byTenure.add(id);
    }
    feats.push(f);
  }
  const duplicates = normed.length - feats.length;
  // Against the source's own ceiling, not a global one — Yukon's is higher
  // because its parcels are smaller, and comparing it to MAX_FEATURES would
  // stamp "truncated" on a complete Yukon property at 1,200 parcels.
  const truncated = hitCap || raw.length >= source.cap;

  return json({
    type: "FeatureCollection",
    // Never `synthetic: true` — this is a public register, and the viewer
    // refuses to draw fabricated geometry as real tenure.
    synthetic: false,
    jurisdiction: j,
    data_source: source.name,
    source_endpoint: source.endpoint,
    source_dataset: source.dataset,
    licence: source.licence,
    attribution: source.attribution,
    // Features the register returned without a boundary. Worth reporting: it
    // is the difference between "there is nobody there" and "we were not given
    // the shapes".
    without_geometry: raw.length - normed.length,
    // The same tenure returned by more than one layer of the same register.
    // Reported rather than swallowed: it is the evidence that the second layer
    // was actually read, and if it ever drops to zero on Yukon that means the
    // claims/lease relationship changed and the assumption above needs
    // re-checking.
    duplicate_tenures_dropped: duplicates,
    fetched_bbox: [w, s, e, n],
    // A silent cap would read as "these are all the holders", which on a slide
    // about who surrounds you is the wrong thing to imply.
    truncated,
    features: feats,
  }, 200, { "Cache-Control": "private, max-age=600", ...CORS });
});
