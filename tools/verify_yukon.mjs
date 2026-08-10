// Bedrock — the Yukon half of the tenure adapter, against the live register.
//
//   node tools/verify_yukon.mjs
//
// This mirrors the URL construction and normalisation in
// supabase/functions/tenure/index.ts and asserts against GeoYukon directly, so
// the adapter can be proven without a deploy. What it guards:
//
//   * Paging. GeoYukon caps a response at 2,500 and Fireweed's Macpass block is
//     larger than that. An unpaged adapter returns a property with its middle
//     missing, and the dissolve draws that hole as though it were fact.
//   * Two layers. Claims convert to leases once surveyed, so the surveyed
//     ground — which is the ground the deposits sit on — lives in a different
//     table from the rest of the property.
//   * The owner suffix. "Fireweed Metals Corp. - 100%" and
//     "Fireweed Metals Corp. - 60%" are one company; grouping on the raw string
//     draws one holder as two.
//   * Units. SHAPE.AREA is square metres in EPSG:3578, and a standard quartz
//     claim is ~21 ha. If that assertion breaks, the areas on the deck are
//     wrong by orders of magnitude and nothing else will say so.

const BASE =
  "https://mapservices.gov.yk.ca/arcgis/rest/services/GeoYukon/GY_Mining/MapServer";
const LAYERS = [36, 37];
const PAGE = 1000;
const MAX = 4000;

// Macpass — Tom, Jason, End Zone and Boundary Zone, 63°10'N 130°09'W.
const BBOX = [-130.35, 63.02, -129.85, 63.35];

let pass = 0, fail = 0;
const ok = (n, c, d = "") =>
  c ? (pass++, console.log("  ok   " + n))
    : (fail++, console.log("  FAIL " + n + (d ? " — " + d : "")));

const pageUrl = (layer, off) => `${BASE}/${layer}/query?` + new URLSearchParams({
  where: "1=1",
  geometry: BBOX.join(","),
  geometryType: "esriGeometryEnvelope",
  inSR: "4326", outSR: "4326",
  spatialRel: "esriSpatialRelIntersects",
  outFields: "CLAIM_LABEL,CLAIM_NAME,CLAIM_NUMBER,GRANT_NUMBER," +
             "OWNER_NAME,TENURE_STATUS,SHAPE.AREA",
  returnGeometry: "true", f: "geojson",
  resultOffset: String(off), resultRecordCount: String(PAGE),
});

// Same normalisation as the edge function.
const normalise = (f) => {
  const p = f.properties || {};
  const rawOwner = String(p.OWNER_NAME || "").trim();
  const m = rawOwner.match(/^(.*?)\s*-\s*([\d.]+)\s*%$/);
  const who = (m ? m[1] : rawOwner).trim();
  const label = String(p.CLAIM_LABEL || "").trim() ||
    [p.CLAIM_NAME, p.CLAIM_NUMBER]
      .filter((x) => x !== null && x !== undefined && String(x).trim() !== "")
      .join(" ").trim();
  return {
    ...f,
    properties: {
      OWNER_NAME: who,
      CLAIM_NAME: label,
      TENURE_NUMBER_ID: String(p.GRANT_NUMBER || label),
      AREA_IN_HECTARES: Number(p["SHAPE.AREA"] || 0) / 10000,
      TENURE_STATUS: String(p.TENURE_STATUS || ""),
    },
  };
};

const raw = [];
const perLayer = {};
let requests = 0;
for (const layer of LAYERS) {
  let got = 0;
  for (let off = 0; off < MAX; off += PAGE) {
    const r = await fetch(pageUrl(layer, off), { signal: AbortSignal.timeout(90000) });
    requests++;
    if (!r.ok) { console.log(`  registry ${layer} returned ${r.status}`); break; }
    const body = await r.json();
    const page = Array.isArray(body.features) ? body.features : [];
    raw.push(...page); got += page.length;
    if (page.length < PAGE) break;          // this layer is exhausted
    if (raw.length >= MAX) break;
  }
  perLayer[layer] = got;
  console.log(`  layer ${layer}: ${got} features`);
}
console.log(`  ${requests} requests, ${raw.length} features total\n`);

const feats = raw.map(normalise).filter((f) => f.geometry);

ok("both layers returned ground", perLayer[36] > 0 && perLayer[37] > 0,
   JSON.stringify(perLayer));
// The whole reason paging exists here. Asserted on the layer that actually
// pages rather than on the total: a bbox is capped at 0.5° a side upstream, so
// within one legal request the realistic ceiling is ~2,000 features and an
// assertion against the registry's own 2,500 limit would never fire — it would
// just look like a passing test that proves nothing.
ok("more than one page came back", raw.length > PAGE, String(raw.length));
ok("the claims layer needed paging", perLayer[36] > PAGE,
   `${perLayer[36]} from layer 36, page size ${PAGE}`);
ok("every feature carries a boundary", feats.length === raw.length,
   `${feats.length} of ${raw.length}`);

const owners = new Map();
for (const f of feats) {
  const o = f.properties.OWNER_NAME;
  owners.set(o, (owners.get(o) || 0) + 1);
}
const top = [...owners.entries()].sort((a, b) => b[1] - a[1]);
console.log("\n  holders:");
top.slice(0, 8).forEach(([o, n]) => console.log(`    ${String(n).padStart(5)}  ${o}`));

ok("every feature names a holder",
   feats.every((f) => f.properties.OWNER_NAME.length > 0));
// The suffix is the trap: it turns one company into several.
ok("the interest suffix is stripped",
   ![...owners.keys()].some((o) => /\d\s*%$/.test(o)),
   [...owners.keys()].filter((o) => /%$/.test(o))[0] || "");
// Majority as a share, not as a magic number — the count moves with the bbox.
ok("Fireweed is the majority holder",
   /^Fireweed/i.test(top[0][0]) && top[0][1] / feats.length > 0.5,
   `${top[0][0]} ${top[0][1]}/${feats.length}`);
ok("Fireweed reads as ONE holder, not one per interest",
   [...owners.keys()].filter((o) => /^Fireweed/i.test(o)).length === 1,
   [...owners.keys()].filter((o) => /^Fireweed/i.test(o)).join(" | "));
ok("real neighbours are named too", top.length >= 3, `${top.length} holders`);

const areas = feats.map((f) => f.properties.AREA_IN_HECTARES).filter((a) => a > 0);
const med = areas.sort((a, b) => a - b)[Math.floor(areas.length / 2)];
console.log(`\n  median parcel ${med.toFixed(1)} ha`);
// A Yukon quartz claim is 1,500 ft square, about 21 ha. This is the assertion
// that catches SHAPE.AREA silently changing units.
ok("a parcel is about 21 ha, so SHAPE.AREA is square metres",
   med > 5 && med < 60, `${med.toFixed(1)} ha`);

const labelled = feats.filter((f) => f.properties.CLAIM_NAME.length > 0).length;
ok("parcels carry a readable label", labelled / feats.length > 0.95,
   `${labelled}/${feats.length}`);

const fw = feats.filter((f) => /^Fireweed/i.test(f.properties.OWNER_NAME));
const ha = fw.reduce((t, f) => t + f.properties.AREA_IN_HECTARES, 0);
console.log(`\n  Fireweed: ${fw.length} parcels, ${Math.round(ha).toLocaleString()} ha`);
ok("Fireweed's ground is a real land package", ha > 20000, `${Math.round(ha)} ha`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
