// Verify the second deposit's data path without a browser.
//
// Chrome DevTools dropped out mid-task, so the DOM and Cesium halves of the
// deposit switch are unverified. What CAN still be checked is the part that
// decides whether the readout tells the truth: that the OREB buffer the Python
// generator writes is the buffer the viewer's reader expects, that buildModel's
// run ranges tile the model exactly, and that the buckets reconcile to stats.
//
// unpackOreb and buildModel are lifted out of the generated index.html rather
// than reimplemented, so this tests the shipped code and not a copy of it.

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = process.argv[2];
const html = readFileSync(path.join(REPO, "index.html"), "utf8");

// Pull the two functions verbatim out of the built viewer.
function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found in index.html`);
  let i = html.indexOf("{", at), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (!depth) return html.slice(at, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const LADDER = [0,0.1,0.2,0.3,0.5,0.75,1.0,1.5,2.0,3.0,5.0,8.0,12.0,20.0,50.0];
const src = lift("unpackOreb") + "\n" + lift("buildModel") +
            "\nreturn {unpackOreb, buildModel};";
const { unpackOreb, buildModel } = new Function("LADDER", src)(LADDER);

const dir = path.join(REPO, "data", "synthetic");
const man = JSON.parse(readFileSync(path.join(dir, "SYNTHETIC_nicola_south.json"), "utf8"));
const bin = readFileSync(path.join(dir, man.blocks_file));
const bj = JSON.parse(readFileSync(path.join(dir, man.buckets_file), "utf8"));

let pass = 0, fail = 0;
const eq = (name, want, got, tol = 0) => {
  const ok = typeof want === "number" ? Math.abs(want - got) <= tol : String(want) === String(got);
  ok ? (pass++, console.log(`  ok   ${name}`))
     : (fail++, console.log(`  FAIL ${name}\n       want ${want}\n       got  ${got}`));
};

console.log("== manifest");
eq("flagged synthetic", true, man.synthetic);
eq("data_source is SYNTHETIC", "SYNTHETIC", man.data_source);
eq("carries a warning", true, /FABRICATED/.test(man.warning || ""));

console.log("\n== OREB round trip");
const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const cols = unpackOreb(buf);
const st = man.stats;
eq("block count matches stats", st.total.blocks, cols.n);
eq("origin matches the manifest", man.origin.join(","), cols.origin.join(","));
eq("has all seven columns", true, ["x","y","z","g","p","c","v"].every(k => cols[k]));
eq("column length matches n", true, ["x","y","z","g","p","c","v"].every(k => cols[k].length === cols.n));

// Positions are stored relative to origin, so absolute bounds must land on the
// manifest's — this is what catches a packer/reader disagreement on alignment.
const absMin = (k, o) => Math.min(...cols[k]) + o;
const absMax = (k, o) => Math.max(...cols[k]) + o;
eq("x bounds", st.bounds.x[0].toFixed(1), absMin("x", cols.origin[0]).toFixed(1));
eq("x bounds max", st.bounds.x[1].toFixed(1), absMax("x", cols.origin[0]).toFixed(1));
eq("y bounds", st.bounds.y[0].toFixed(1), absMin("y", cols.origin[1]).toFixed(1));
eq("z bounds", st.bounds.z[0].toFixed(1), absMin("z", cols.origin[2]).toFixed(1));
eq("grades clear the viewer floor", true, Math.min(...cols.g) >= 0.5 - 1e-6);
eq("vein ids fit a byte", true, Math.max(...cols.v) <= 255);

console.log("\n== buildModel");
const m = buildModel(cols, st, bj.ladder);
eq("N preserved", cols.n, m.N);
eq("F is 5 floats per block", cols.n * 5, m.F.length);
eq("M is 2 bytes per block", cols.n * 2, m.M.length);

// RUNS are index ranges into F. If they do not tile [0,N) exactly and in order,
// primitives draw the wrong blocks — the failure this check exists for.
let covered = 0, prev = -1, contiguous = true, ordered = true;
for (const r of m.RUNS) {
  if (r.s !== covered) contiguous = false;
  covered += r.n;
  const key = r.c * 1e6 + r.b * 1e3 + r.d;
  if (key <= prev) ordered = false;
  prev = key;
}
eq("runs tile the model exactly", cols.n, covered);
eq("runs are contiguous", true, contiguous);
eq("runs are strictly ordered by (class,bin,band)", true, ordered);
eq("every run has a ladder low", true, m.RUNS.every(r => bj.ladder[r.b] === r.lo));

// Every block must sit in the bin its run claims.
let misbinned = 0;
for (const r of m.RUNS) {
  for (let i = r.s; i < r.s + r.n; i++) {
    const g = m.F[i * 5 + 3];
    const hi = r.hi === null ? Infinity : r.hi;
    if (g < r.lo - 1e-6 || g >= hi - 1e-9) misbinned++;
  }
}
eq("no block sits outside its run's grade bin", 0, misbinned);

let wrongClass = 0;
for (const r of m.RUNS) for (let i = r.s; i < r.s + r.n; i++)
  if (m.M[i * 2] !== r.c) wrongClass++;
eq("no block sits outside its run's class", 0, wrongClass);

console.log("\n== rollups");
const bt = bj.buckets.reduce((s, b) => s + b.t, 0);
const bm = bj.buckets.reduce((s, b) => s + b.m, 0);
const cbT = bj.by_cb.reduce((s, b) => s + b.t, 0);
const cbN = bj.by_cb.reduce((s, b) => s + b.n, 0);
eq("buckets reconcile to total tonnes", st.total.tonnes, bt, Math.max(1, st.total.tonnes * 1e-6));
eq("by_cb reconciles to total tonnes", st.total.tonnes, cbT, Math.max(1, st.total.tonnes * 1e-6));
eq("by_cb reconciles to block count", st.total.blocks, cbN);
eq("grade reconciles", st.total.grade_gt, bm / bt, 0.002);
eq("ladder matches the viewer's", LADDER.join(","), bj.ladder.join(","));
eq("declared share-weighted", true, bj.share_weighted);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
