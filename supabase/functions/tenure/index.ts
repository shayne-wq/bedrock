// Orebody — fetch neighbouring mineral tenure from a public register.
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
// SCOPE, STATED PLAINLY: British Columbia only. Every jurisdiction publishes
// tenure differently, and there is no universal endpoint to point this at.
// Anywhere else, the upload path is still the answer, and the console says so
// rather than offering a button that quietly returns nothing.
//
// GET /functions/v1/tenure?bbox=<west>,<south>,<east>,<north>[&jurisdiction=bc]
// Authenticated: this is a console feature. The anon key gets nothing.

import { CORS, json, preflight } from "../_shared/http.ts";

const WFS = "https://openmaps.gov.bc.ca/geo/pub/ows";
const LAYER = "pub:WHSE_MINERAL_TENURE.MTA_ACQUIRED_TENURE_SVW";
const ATTRIBUTION =
  "Contains information licensed under the Open Government Licence – British Columbia.";

// A window big enough to be a neighbourhood and small enough to be a request.
// Roughly 55 km on a side at this latitude; past that the caller is asking for
// a province, and the honest answer is to say so rather than to time out.
const MAX_SPAN_DEG = 0.5;
const MAX_FEATURES = 1200;

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
  if (j !== "bc") {
    return json({
      error: `Automatic tenure lookup is only wired up for British Columbia. ` +
             `For ${j.toUpperCase()}, export the boundaries from the registry ` +
             `and upload them as GeoJSON or KML.`,
      unsupported_jurisdiction: j,
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

  // WFS 2.0 with an EPSG:4326 bbox is LATITUDE FIRST. Getting this backwards
  // does not error, it returns an empty collection from somewhere in the ocean
  // off Somalia, which reads as "no neighbours" — so the axis order is spelled
  // out here rather than left to a reader to remember.
  const q = new URLSearchParams({
    service: "WFS", version: "2.0.0", request: "GetFeature",
    typeNames: LAYER, outputFormat: "application/json",
    srsName: "EPSG:4326", count: String(MAX_FEATURES),
    bbox: `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`,
  });

  let body: { type?: string; features?: unknown[] };
  try {
    const r = await fetch(`${WFS}?${q}`, {
      signal: AbortSignal.timeout(45000),
      headers: { Accept: "application/json" },
    });
    if (!r.ok) {
      return json({ error: `The BC registry returned ${r.status}.` }, 502);
    }
    body = await r.json();
  } catch (err) {
    // Their outage, not ours, and the message should say which.
    return json({
      error: "The BC tenure registry did not respond. It is a public service " +
             "and does go down; the upload path still works.",
      detail: String((err as Error)?.message || err),
    }, 502);
  }

  const feats = Array.isArray(body?.features) ? body.features : [];
  const truncated = feats.length >= MAX_FEATURES;

  return json({
    type: "FeatureCollection",
    // Never `synthetic: true` — this is a public register, and the viewer
    // refuses to draw fabricated geometry as real tenure.
    synthetic: false,
    data_source: "BC Mineral Titles Online",
    source_endpoint: WFS,
    source_dataset: LAYER,
    licence: "Open Government Licence – British Columbia",
    attribution: ATTRIBUTION,
    fetched_bbox: [w, s, e, n],
    // A silent cap would read as "these are all the holders", which on a slide
    // about who surrounds you is the wrong thing to imply.
    truncated,
    features: feats,
  }, 200, { "Cache-Control": "private, max-age=600", ...CORS });
});
