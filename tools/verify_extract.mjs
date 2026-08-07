// Orebody — proves the browser extractor agrees with the Python one.
//
// The client-side ingest is only trustworthy if it lands on the same numbers as
// the reference implementation that produced the shipped demo. This drives the
// exact module the dashboard uses, over the real 1.2 GB MineSight export, and
// diffs every rollup against data/elk_stats.json.
//
//   node tools/verify_extract.mjs [path/to/source.csv]

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { detect, probe, extract, pack, linesOf } from "../dashboard/lib/extract.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = process.argv[2] || path.join(ROOT, "..", "Siwash_North_BM_Nov_2021.csv");
const REF = JSON.parse(await readFile(path.join(ROOT, "data", "elk_stats.json"), "utf8"));

let pass = 0, fail = 0;
const eq = (name, want, got, tol = 0) => {
  const ok = typeof want === "number"
    ? Math.abs(want - got) <= tol
    : String(want) === String(got);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       want ${want}\n       got  ${got}`); }
};

console.log(`source ${SRC}`);

// ---- probe: block dimensions are inferred, not assumed --------------------
const probed = await probe(linesOf(createReadStream(SRC)));
console.log("\n== probe");
eq("infers 10 m easting spacing", 10, probed.dx);
eq("infers 5 m northing spacing", 5, probed.dy);
eq("infers 5 m bench height", 5, probed.dz);
eq("finds a uniform density", true, probed.densityUniform);
eq("reads that density as 2.7", 2.7, probed.densityMedian, 1e-9);
eq("detects the grade column", "AuEq", probed.mapping.grade);
eq("detects the ore-fraction column", "Percent_Env", probed.mapping.oreFraction);
eq("detects 46 domain share columns", 46, probed.mapping.domainShare.length);

// ---- full pass ------------------------------------------------------------
console.log("\n== extract");
const t0 = Date.now();
let last = 0;
const out = await extract(linesOf(createReadStream(SRC)), {
  mapping: probed.mapping,
  dx: probed.dx, dy: probed.dy, dz: probed.dz,
  density: 2.7,
  onProgress: (n) => {
    if (n - last >= 100000) { last = n; process.stdout.write(`\r  ${n.toLocaleString()} rows`); }
  },
});
process.stdout.write("\r".padEnd(40) + "\r");
const secs = (Date.now() - t0) / 1000;
console.log(`  ${out.stats.scanned_rows.toLocaleString()} rows in ${secs.toFixed(1)}s`);

eq("scanned every row", REF.scanned_rows, out.stats.scanned_rows);
eq("same mineralized block count", REF.total.blocks, out.stats.total.blocks);
eq("same tonnage", REF.total.tonnes, out.stats.total.tonnes, 0.5);
eq("same grade", REF.total.grade_gt, out.stats.total.grade_gt, 0.001);
eq("same contained ounces", REF.total.oz, out.stats.total.oz, 1);
eq("same straddling count", REF.blocks_straddling_multiple_domains,
   out.stats.blocks_straddling_multiple_domains);
eq("same dropped count", REF.dropped_blocks, out.stats.dropped_blocks);
// The reference sorts domain names lexicographically, which files "1000" ahead
// of "950E". The extractor sorts them naturally instead, so compare as sets —
// the ordering difference is deliberate and the membership must still be exact.
eq("same domain set", [...REF.veins].sort().join(","),
   [...out.stats.veins].sort().join(","));
eq("domains are naturally ordered", "950E,975,1000", out.stats.veins.slice(0, 3).join(","));
eq("rollups reconcile", true, out.reconciled.ok);

console.log("\n== by class");
for (const k of Object.keys(REF.by_class)) {
  const a = REF.by_class[k], b = out.stats.by_class[k];
  eq(`class ${k} tonnes`, a.tonnes, b?.tonnes ?? -1, 0.5);
  eq(`class ${k} ounces`, a.oz, b?.oz ?? -1, 1);
}

// The share-weighting is the whole point, so check it vein by vein rather than
// trusting that a matching total implies matching parts — a total that
// reconciles while the parts are wrong is the exact bug this guards against.
console.log("\n== by vein (share-weighted)");
let worstT = 0, worstOz = 0, worstName = "", missing = 0;
for (const name of Object.keys(REF.by_vein)) {
  const a = REF.by_vein[name], b = out.stats.by_vein[name];
  if (!b) { missing++; continue; }
  const dt = Math.abs(a.tonnes - b.tonnes), doz = Math.abs(a.oz - b.oz);
  if (dt > worstT) { worstT = dt; worstName = name; }
  if (doz > worstOz) worstOz = doz;
}
eq(`all ${Object.keys(REF.by_vein).length} veins present`, 0, missing);
eq(`worst vein tonnage drift (${worstName})`, 0, Math.round(worstT * 10) / 10, 0.5);
eq("worst vein ounce drift", 0, worstOz, 1);

// ---- packing --------------------------------------------------------------
console.log("\n== pack");
const buf = pack(out.columns);
const dv = new DataView(buf);
eq("magic", 0x4f524542, dv.getUint32(0, false));
eq("version", 1, dv.getUint32(4, true));
const hlen = dv.getUint32(8, true), base = dv.getUint32(12, true);
const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, hlen)));
eq("header block count", out.stats.total.blocks, head.n);
eq("payload is 16-byte aligned", 0, base % 16);
eq("seven columns", 7, head.arrays.length);
const mb = buf.byteLength / 1e6;
console.log(`  ${mb.toFixed(1)} MB packed, from ${(1175108895 / 1e6).toFixed(0)} MB of source`);
eq("compresses by at least 100x", true, 1175108895 / buf.byteLength > 100);

// Positions are stored relative to the origin; confirm one round-trips.
const xs = new Float32Array(buf, base + head.arrays[0].offset, head.n);
eq("first easting round-trips", Math.round(out.columns.x[0] * 100) / 100,
   Math.round((xs[0] + head.origin[0]) * 100) / 100, 0.01);

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail ? 1 : 0);
