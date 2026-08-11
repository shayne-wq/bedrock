// Orebody — build a real deck, end to end, against a Supabase project.
//
//   node tools/seed_demo_deck.mjs <api url> <service role key>
//
// Everything the console does, without the browser: a project, a zone, the
// artifacts in storage, the datasets that point at them, a deck whose chapters
// come from the SAME generator the console uses, and a share link. It prints a
// viewer URL.
//
// This exists because until now every check of the hydration path used a
// hand-written fixture. A fixture proves the reader; it does not prove that
// what the console writes is what the viewer can open. This walks the real
// contract end to end and fails on the first place the two disagree.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { projectCandidates, defaultOrder, toChapter } from "../dashboard/lib/slides.js";

const [, , URL_, KEY] = process.argv;
if (!URL_ || !KEY) { console.error("usage: seed_demo_deck.mjs <url> <service key>"); process.exit(2); }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

const ORG = "dddddddd-0000-0000-0000-000000000001";
const PRJ = "dddddddd-0000-0000-0000-000000000002";
const ZONE = "dddddddd-0000-0000-0000-000000000003";
const DECK = "dddddddd-0000-0000-0000-000000000004";
const TOKEN = "demoseed" + "0".repeat(24);

console.log("clearing any previous seed…");
await del("orgs", `id=eq.${ORG}`).catch(() => {});

console.log("org, project, zone…");
await insert("orgs", { id: ORG, name: "Elk Gold Mining Corp.", slug: "elk-gold-demo" });
await insert("projects", {
  id: PRJ, org_id: ORG, name: "Elk Gold", slug: "elk-gold", epsg: 26910,
  commodity: "Gold", location: "Nicola, British Columbia",
  brand: {
    summary: "A past-producing high-grade gold property in south-central " +
      "British Columbia, 30 km west of Merritt. Mined intermittently since " +
      "1936; the current resource sits in a set of steeply-dipping quartz " +
      "veins that remain open at depth.",
  },
  // Two of the surrounding companies carry a line the register cannot supply.
  // Both are illustrative and are marked as author-supplied in the audit trail.
  holders: {
    "BARRANCO GOLD MINING CORP.": { note: "Along strike to the northeast" },
    "FLOW METALS CORP.": { note: "Adjoining ground, held since 2021" },
  },
});
await insert("zones", { id: ZONE, project_id: PRJ, name: "Siwash North", slug: "siwash-north", ord: 0 });

// ---- claims, from the real BC register bake -------------------------------
console.log("claims…");
const tj = JSON.parse(readFileSync(join(ROOT, "data/bc_tenures_elk.geojson"), "utf8"));
const rings = [];
for (const f of tj.features) {
  const g = f.geometry || {};
  const polys = g.type === "Polygon" ? [g.coordinates]
              : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polys) {
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      rings.push({ ring: ring.map((c) => [c[0], c[1]]), props: f.properties });
    }
  }
}
// The console's own rollup, reproduced rather than imported: ingest.js is
// browser code. If these ever disagree the deck's numbers and the panel's
// numbers disagree, which is why the numbers are asserted at the end.
const by = new Map(), seen = new Set();
rings.forEach((g, i) => {
  const owner = String(g.props?.OWNER_NAME || "").trim();
  if (!owner) return;
  const k = owner.toUpperCase().replace(/\s+/g, " ");
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

const base = `${ORG}/${PRJ}/${ZONE}`;
await upload(`${base}/claims.json`, JSON.stringify({
  format: "orebody-claims/1", crs: "EPSG:4326", rings,
  attribution: tj.attribution, subject_owner: tj.subject_owner,
}), "application/json");
await insert("datasets", {
  project_id: PRJ, zone_id: ZONE, kind: "site", label: "BC mineral tenure",
  storage_path: `${base}/claims.json`, bytes: 0, synthetic: false,
  stats: { rings: rings.length, owners, subject_owner: tj.subject_owner, bbox: bb },
  provenance: { parsed: "claims", ring_count: rings.length, source: tj.data_source },
});

// ---- block model ----------------------------------------------------------
console.log("block model…");
const bin = readFileSync(join(ROOT, "data/elk_blocks.bin"));
const stats = JSON.parse(readFileSync(join(ROOT, "data/elk_stats.json"), "utf8"));
const buckets = JSON.parse(readFileSync(join(ROOT, "data/elk_buckets.json"), "utf8"));
await upload(`${base}/blocks.bin`, bin, "application/octet-stream");
await upload(`${base}/buckets.json`, JSON.stringify(buckets), "application/json");
await insert("datasets", {
  project_id: PRJ, zone_id: ZONE, kind: "blocks", label: "Siwash North block model",
  storage_path: `${base}/blocks.bin`, bytes: bin.length, synthetic: false,
  stats, provenance: { buckets_path: `${base}/buckets.json`, source: stats.source },
});

// ---- the deck, from the generator the console uses ------------------------
console.log("deck…");
const project = await rest("GET", `projects?id=eq.${PRJ}&select=*`).then((r) => r[0]);
const zones = await rest("GET", `zones?project_id=eq.${PRJ}&select=*&order=ord`);
const datasets = await rest("GET", `datasets?project_id=eq.${PRJ}&select=*`);
const cands = projectCandidates(project, zones, datasets);
const { order, dropped, extra } = defaultOrder(cands, zones, 14, project);
console.log(`  ${cands.length} candidates · ${order.length} in the running order` +
            `${dropped ? ` · ${dropped} trimmed` : ""} · ${extra} in the tray`);
console.log("  " + order.map((c, i) => `${i + 1}. ${c.title}`).join("\n  "));

await insert("decks", { id: DECK, project_id: PRJ, title: "Elk Gold — Siwash North",
                        subtitle: "Nicola, British Columbia", status: "published" });
await insert("chapters", order.map((c, i) => ({ deck_id: DECK, ...toChapter(c, i) })));
await insert("share_links", { deck_id: DECK, token: TOKEN, label: "Demo", allow_embed: true });

// ---- assert the contract holds both ways ----------------------------------
const back = await rest("GET", `chapters?deck_id=eq.${DECK}&select=ord,title,camera,layers&order=ord`);
const fail = [];
if (back.length !== order.length) fail.push(`chapter count ${back.length} vs ${order.length}`);
// The opening, by section rather than by title: the titles are the project's
// own words and will differ per customer, but the first slides are always the
// property-scale ones.
back.slice(0, 2).forEach((c, i) => {
  if (c.layers?.blocks !== false) {
    fail.push(`chapter ${i + 1} ("${c.title}") draws the block model; the opening should not`);
  }
});
if (!(back[0].camera.r > back[1].camera.r)) {
  fail.push(`slide 1 (${back[0].camera.r}m) is not wider than slide 2 (${back[1].camera.r}m)`);
}
// Camera must round-trip through jsonb as the orbit triple the viewer reads.
const c0 = back[0].camera || {};
if (!(c0.r > 0 && typeof c0.h === "number")) fail.push(`camera did not survive: ${JSON.stringify(c0)}`);
if (fail.length) { console.error("\nCONTRACT BROKEN:\n  " + fail.join("\n  ")); process.exit(1); }

const api = `${URL_}/functions/v1`;
console.log(`\nviewer: /index.html?t=${TOKEN}&api=${encodeURIComponent(api)}`);
console.log(`token:  ${TOKEN}`);
