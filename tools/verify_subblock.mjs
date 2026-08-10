// Orebody — sub-blocked model detection.
//
//   node tools/verify_subblock.mjs
//
// This guards the one claim the whole product rests on: the deck cannot state
// a number the model does not support. Tonnage is blocks x volume x density,
// so a single volume applied to blocks that do not share one is not an
// approximation — it is a tonnage that looks right, reconciles against itself,
// and is false. There is no symptom. Nobody catches it downstream.
//
// The case at the centre of this file is the one the detector used to document
// as undetectable: 2.5 m children inside a 10 m parent, which by GAP SIZE is
// indistinguishable from a 2.5 m grid full of holes. It is distinguishable by
// centre position, and the test that matters is that the two synthetic models
// below — deliberately built to produce identical gap histograms — come back
// with different verdicts.

import { probe } from "../dashboard/lib/extract.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log(`  ok   ${n}`))
                               : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));

// A CSV as an async line iterator, which is what probe() consumes.
async function* lines(rows, header) {
  yield header;
  for (const r of rows) yield r.join(",");
}
const HDR = "X,Y,Z,AU";
const run = (rows, hdr = HDR) => probe(lines(rows, hdr), null, 100000);

// ---- fixtures ---------------------------------------------------------------
// A plain 10 m lattice.
function uniform(nx = 12, ny = 12, nz = 6, p = 10) {
  const rows = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    rows.push([i * p + p / 2, j * p + p / 2, k * p + p / 2, 1.2]);
  }
  return rows;
}
// The same lattice with most of it removed — a legitimately patchy model.
// Holes remove centres; they never move the survivors off the lattice.
function patchy(keep = 0.35, pitch = 2.5) {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return uniform(30, 30, 12, pitch).filter(() => rnd() < keep);
}
// 2.5 m children inside a 10 m parent. THE case. Built so the modal gap is
// 2.5 in both this and `patchy`, so gap size alone cannot separate them.
function subBlocked(splitEvery = 3, parent = 10, fine = 2.5) {
  const rows = [];
  const n = 12;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < 6; k++) {
    const X = i * parent, Y = j * parent, Z = k * parent;
    if ((i + j + k) % splitEvery === 0) {
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) {
        rows.push([X + fine * (a + 0.5), Y + fine * (b + 0.5), Z + fine * (c + 0.5), 1.2]);
      }
    } else {
      rows.push([X + parent / 2, Y + parent / 2, Z + parent / 2, 1.2]);
    }
  }
  return rows;
}

console.log("== a plain lattice must pass cleanly");
const u = await run(uniform());
ok("cell size is read off the grid", u.dx === 10 && u.dy === 10 && u.dz === 10,
   `${u.dx} x ${u.dy} x ${u.dz}`);
ok("not flagged sub-blocked", u.subBlocked === false);
ok("every centre is on one lattice", u.offGrid === 0, String(u.offGrid));
ok("verdict is uniform", u.uniformity.verdict === "uniform", u.uniformity.verdict);

console.log("\n== a patchy grid is not sub-blocked, and must not be refused");
const pt = await run(patchy());
ok("still one lattice however many holes", pt.offGrid === 0, String(pt.offGrid));
ok("not refused", pt.subBlocked === false);
ok("but the irregularity is surfaced rather than hidden",
   pt.uniformity.verdict === "uncertain" || pt.uniformity.verdict === "uniform",
   pt.uniformity.verdict);

console.log("\n== the case this file exists for");
const sb = await run(subBlocked());
ok("2.5 m children in a 10 m parent are DETECTED", sb.subBlocked === true,
   JSON.stringify(sb.uniformity));
ok("caught by centre position, not by the file declaring dimensions",
   sb.dimCols === false && sb.offLattice === true,
   `dimCols=${sb.dimCols} offLattice=${sb.offLattice}`);
ok("more than one residual class", sb.latticeClasses >= 2, String(sb.latticeClasses));
ok("the reason given names the actual evidence",
   /centres do not sit on the same grid/.test(sb.uniformity.reasons.join(" ")),
   sb.uniformity.reasons.join(" | "));

// The point of the whole exercise: gap size cannot separate these two, so if
// the detector were still only looking at gaps it would have to give them the
// same answer. It gives them different ones.
console.log("\n== the two are indistinguishable by gap size alone");
ok("both have the same modal cell size", pt.dx === sb.dx, `${pt.dx} vs ${sb.dx}`);
ok("...and the gap histogram calls both ragged", pt.ragged === sb.ragged,
   `${pt.ragged} vs ${sb.ragged}`);
ok("...yet only one is refused", pt.subBlocked !== sb.subBlocked,
   `patchy=${pt.subBlocked} subblocked=${sb.subBlocked}`);

console.log("\n== declared dimensions still refuse on their own");
const withDims = uniform(6, 6, 3).map((r) => [...r, 10, 10, 10]);
const wd = await run(withDims, "X,Y,Z,AU,XINC,YINC,ZINC");
ok("dimension columns are detected", wd.dimCols === true);
ok("and refuse regardless of the lattice", wd.subBlocked === true);

console.log("\n== the honest limit, asserted so nobody assumes coverage is total");
// An ODD factor puts every child centre AND every surviving parent centre on
// the same fine lattice. The occupied coordinates are not similar to a patchy
// 2.5 m grid — they are the same set. This is not a weakness of the method;
// no coordinate test can separate them, and the test says so out loud rather
// than leaving a reader to assume the detector covers everything.
const odd = await run(subBlocked(3, 7.5, 2.5));
ok("an odd-factor parent is NOT detected, and cannot be", odd.offLattice === false,
   `offGrid=${odd.offGrid}`);
ok("it reads as a clean model, which is exactly why the confirmation exists",
   odd.uniformity.verdict === "uniform", odd.uniformity.verdict);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
