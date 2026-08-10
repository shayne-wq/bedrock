// Bedrock — seed the Macpass land package as a real, reviewable deck.
//
//   node tools/seed_macpass.mjs <api url> <service role key> <anon key>
//
// Why this exists: the Yukon tenure adapter can be proven at the data level
// (tools/verify_yukon.mjs), but "2,026 features came back" is not a review.
// The question a reader actually has is whether ~2,000 separately-issued
// parcels dissolve into ground you would put in front of an investor, and the
// only way to answer that is to look at it.
//
// So this builds the real thing through the real path: the deployed tenure
// function, the same claims artifact the console writes, the same candidate
// generator, a share link, and a viewer URL. Nothing here is a fixture and
// nothing is drawn by this script.
//
// It is deliberately the LAND PACKAGE ONLY. Fireweed's drill database is
// behind a signed disclaimer and has not arrived, so there is no drilling, no
// topography and no resource here — the deck runs in exploration mode and says
// so. Adding a zone per deposit before their data exists would be inventing
// structure, so there is one zone and the rest arrive with the drilling.

const [, , URL_, KEY, ANON] = process.argv;
if (!URL_ || !KEY || !ANON) {
  console.error("usage: seed_macpass.mjs <url> <service key> <anon key>");
  process.exit(2);
}

const { projectCandidates, defaultOrder, toChapter } =
  await import("../dashboard/lib/slides.js");

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(method, path, body, prefer) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers: prefer ? { ...H, Prefer: prefer } : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  const d = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(d)}`);
  return d;
}
const insert = (t, rows) => rest("POST", t, rows, "return=representation");
const del = (t, q) => rest("DELETE", `${t}?${q}`);
async function upload(path, body, type) {
  const r = await fetch(`${URL_}/storage/v1/object/artifacts/${path}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": type,
               "x-upsert": "true" },
    body,
  });
  if (!r.ok) throw new Error(`upload ${path}: ${r.status} ${await r.text()}`);
}

const ORG   = "eeeeeeee-0000-0000-0000-000000000001";
const PRJ   = "eeeeeeee-0000-0000-0000-000000000002";
const ZONE  = "eeeeeeee-0000-0000-0000-000000000003";
const DECK  = "eeeeeeee-0000-0000-0000-000000000004";
const TOKEN = "macpass" + "0".repeat(25);

const SUBJECT = "Fireweed Metals Corp.";
// Macpass sits at 63°10'N 130°09'W (NI 43-101, October 2024). The window is
// under the function's own 0.5° limit; asking for more is refused upstream.
const BBOX = [-130.35, 63.02, -129.85, 63.35];

// ---- the register, through the deployed function --------------------------
// Not a direct hit on GeoYukon: the point is to exercise the adapter that
// ships, including its paging and its owner normalisation. The anon key is a
// legitimate bearer here — the function only refuses an ABSENT one, because an
// open proxy pointed at a government endpoint is the failure it guards.
console.log("fetching Yukon tenure through the deployed function…");
const tr = await fetch(
  `${URL_}/functions/v1/tenure?bbox=${BBOX.join(",")}&jurisdiction=yt`,
  { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
const tj = await tr.json();
if (!tr.ok) throw new Error(`tenure: ${JSON.stringify(tj)}`);
if (tj.truncated) throw new Error("the register truncated — the outline would have holes");

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const SUBJ = norm(SUBJECT);

const rings = [];
for (const f of tj.features || []) {
  const pr = f.properties || {};
  const g = f.geometry || {};
  const polys = g.type === "Polygon" ? [g.coordinates]
              : g.type === "MultiPolygon" ? g.coordinates : [];
  const mine = norm(pr.OWNER_NAME) === SUBJ;
  for (const poly of polys) {
    for (const ring of poly || []) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      rings.push({
        ring: ring.map((c) => [c[0], c[1]]),
        props: { ...pr, _subject: mine, _neighbour: !mine },
      });
    }
  }
}
if (!rings.length) throw new Error("no tenure came back — nothing to seed");

// Same rollup the console computes on merge: deduped by tenure, never by ring,
// because a MultiPolygon parcel arrives as several rings and counting those
// reports a holder as owning ground several times over.
const by = new Map(), seen = new Set();
rings.forEach((g, i) => {
  const owner = String(g.props?.OWNER_NAME || "").trim();
  if (!owner) return;
  const k = norm(owner);
  const h = by.get(k) || { owner, claims: 0, ha: 0 };
  const t = g.props?.TENURE_NUMBER_ID ?? `r${i}`;
  if (!seen.has(`${k}|${t}`)) {
    seen.add(`${k}|${t}`);
    h.claims++; h.ha += Number(g.props?.AREA_IN_HECTARES || 0) || 0;
  }
  by.set(k, h);
});
const owners = [...by.values()].map((h) => ({ ...h, ha: Math.round(h.ha * 10) / 10 }))
  .sort((a, b) => b.ha - a.ha);
let bb = [Infinity, Infinity, -Infinity, -Infinity];
rings.forEach((g) => g.ring.forEach(([x, y]) => {
  bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)];
}));
console.log(`  ${rings.length} rings · ${owners.length} holders · ` +
            `${owners[0].owner} ${owners[0].claims} parcels / ${Math.round(owners[0].ha)} ha`);

// ---- project ---------------------------------------------------------------
console.log("org, project, zone…");
await del("orgs", `id=eq.${ORG}`).catch(() => {});
await insert("orgs", { id: ORG, name: "Fireweed Metals Corp.", slug: "fireweed-macpass" });
await insert("projects", {
  id: PRJ, org_id: ORG, name: "Macpass", slug: "macpass", epsg: 26909,
  commodity: "Zinc, Lead, Silver", location: "Eastern Yukon, Canada",
  brand: {
    // Description only — every figure on this deck comes from the register or
    // from geometry. Nothing here asserts a resource, because none of the
    // resource data is in hand.
    summary: "A zinc-lead-silver district in eastern Yukon, 200 km northeast " +
      "of Ross River, held as one contiguous land package across quartz " +
      "claims and leases. Four deposits have been defined on it — Tom, " +
      "Jason, End Zone and Boundary Zone. The ground shown here is read " +
      "from the Yukon register; the drilling is not yet loaded.",
  },
});
// One zone. The other three deposits are real and named in the technical
// report, but a zone with no data in it is a promise rather than a fact, and
// they arrive with the drill package.
await insert("zones", { id: ZONE, project_id: PRJ, name: "Tom", slug: "tom", ord: 0 });

// ---- claims ----------------------------------------------------------------
console.log("claims artifact…");
const base = `${ORG}/${PRJ}/${ZONE}`;
await upload(`${base}/claims.json`, JSON.stringify({
  format: "orebody-claims/1", crs: "EPSG:4326", rings,
  attribution: tj.attribution, subject_owner: SUBJECT,
  neighbours_source: tj.data_source, neighbours_licence: tj.licence,
}), "application/json");
await insert("datasets", {
  project_id: PRJ, zone_id: ZONE, kind: "site", label: "Yukon quartz tenure",
  storage_path: `${base}/claims.json`, bytes: 0, synthetic: false,
  stats: { rings: rings.length, owners, subject_owner: SUBJECT, bbox: bb },
  provenance: { parsed: "claims", ring_count: rings.length, source: tj.data_source,
                source_dataset: tj.source_dataset, licence: tj.licence,
                fetched_bbox: tj.fetched_bbox },
});

// ---- deck, from the generator the console uses -----------------------------
console.log("deck…");
const project = await rest("GET", `projects?id=eq.${PRJ}&select=*`).then((r) => r[0]);
const zones = await rest("GET", `zones?project_id=eq.${PRJ}&select=*&order=ord`);
const datasets = await rest("GET", `datasets?project_id=eq.${PRJ}&select=*`);
const cands = projectCandidates(project, zones, datasets);
const { order, extra } = defaultOrder(cands, zones);
console.log(`  ${cands.length} candidates · ${order.length} in the running order` +
            `${extra ? ` · ${extra} in the tray` : ""}`);
console.log("  " + order.map((c, i) => `${i + 1}. ${c.title}`).join("\n  "));

await insert("decks", { id: DECK, project_id: PRJ, title: "Macpass",
                        subtitle: "Eastern Yukon, Canada", status: "published" });
await insert("chapters", order.map((c, i) => ({ deck_id: DECK, ...toChapter(c, i) })));
await insert("share_links", { deck_id: DECK, token: TOKEN, label: "Macpass review",
                              allow_embed: true });

// ---- assert the thing that would make this deck a lie ----------------------
const fail = [];
if (!order.length) fail.push("the generator proposed nothing to show");
// Exploration mode is the whole point: there is no block model here, and a
// deck that proposes resource slides anyway is claiming a resource we do not
// have. This is the assertion that matters on this project.
const back = await rest("GET",
  `chapters?deck_id=eq.${DECK}&select=ord,title,layers&order=ord`);
const claimsResource = back.filter((c) => c.layers?.blocks === true);
if (claimsResource.length) {
  fail.push(`${claimsResource.length} chapter(s) draw a block model that does not exist: ` +
            claimsResource.map((c) => c.title).join(", "));
}
if (owners.length < 2) fail.push("only one holder — the neighbour layer has nothing to say");
if (fail.length) { console.error("\nWRONG:\n  " + fail.join("\n  ")); process.exit(1); }

const api = `${URL_}/functions/v1`;
console.log(`\nviewer: /index.html?t=${TOKEN}&api=${encodeURIComponent(api)}`);
console.log(`token:  ${TOKEN}`);
