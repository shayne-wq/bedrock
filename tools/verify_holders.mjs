// Orebody — the neighbouring-asset layer.
//
//   node tools/verify_holders.mjs <viewer url>
//
// This layer makes a claim about who owns what, next to a deposit, in front of
// investors. The failure that matters is not a missing card — it is drawing
// somebody else's ground in your own colour, which is what it used to do:
// `_subject` on a tenure means it OVERLAPS THE DEPOSIT EXTENT, and Coast
// Copper's Home Brew claim sits right on it, so the deck rendered a
// competitor's tenure as the issuer's own. Ownership is checked here against
// the registered owner name and nothing else.

import { chromium } from "playwright-core";

const URL_ = process.argv[2] || "http://127.0.0.1:8899/index.html";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log(`  ok   ${n}`))
                               : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));

const b = await chromium.launch({ channel: "chrome" });
const pg = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; pg.on("pageerror", (e) => errs.push(String(e)));
await pg.goto(URL_, { waitUntil: "load" });
await pg.waitForFunction(() => window.__api && document.querySelectorAll("#rail .c").length > 0,
  null, { timeout: 120000 });
await pg.waitForTimeout(9000);

const H = await pg.evaluate(() => window.__api.holders());
const st = await pg.evaluate(() => window.__api.state());
const find = (frag) => H.find((h) => h.owner.toUpperCase().includes(frag));

console.log("== the rollup");
ok("holders were derived from the claims", H.length > 5, String(H.length));
ok("exactly one holder is the issuer", H.filter((h) => h.subject).length === 1,
   JSON.stringify(H.filter((h) => h.subject).map((h) => h.owner)));
ok("and it is the declared subject owner", (H.find((h) => h.subject) || {}).owner
   .toUpperCase().includes("BEDROCK DEMO"), (H.find((h) => h.subject) || {}).owner);

// The bug this file exists for: a neighbouring holder being drawn as though
// it were the issuer's own ground.
const coast = find("COAST RANGE");
ok("Coast Range is present", !!coast);
ok("Coast Range is NOT drawn as the issuer's ground", coast && coast.subject === false,
   JSON.stringify(coast));

console.log("\n== companies and people");
ok("Northline is read as a company", (find("NORTHLINE") || {}).corporate === true);
ok("Perrin Gold is read as a company", (find("PERRIN") || {}).corporate === true);
ok("a SURNAME, FIRSTNAME holder is read as a person",
   (find("SAMPLE, ALEX") || {}).corporate === false, JSON.stringify(find("SAMPLE, ALEX")));
ok("companies outrank people in the ordering", (() => {
   const nb = H.filter((h) => !h.subject);
   const lastCorp = nb.map((h) => h.corporate).lastIndexOf(true);
   const firstPerson = nb.map((h) => h.corporate).indexOf(false);
   return firstPerson === -1 || lastCorp < firstPerson;
})(), H.filter((h) => !h.subject).map((h) => (h.corporate ? "C" : "p")).join(""));

console.log("\n== area, which is a figure on a slide");
// The issuer holds 12 cells; the register's own hectares for its unique
// tenures sum to 2,114.3. A per-ring sum would inflate any MultiPolygon holder.
const subj = H.find((h) => h.subject);
ok("the issuer's area matches the register", Math.abs(subj.ha - 2292.9) < 1, String(subj.ha));
ok("Coast Range's area matches the register", Math.abs(find("COAST RANGE").ha - 1072.1) < 1,
   String(find("COAST RANGE").ha));
ok("claim counts are per tenure, not per ring",
   subj.claims === 13 && find("COAST RANGE").claims === 6,
   `${subj.claims}, ${find("COAST RANGE").claims}`);

console.log("\n== what gets drawn");
await pg.evaluate(() => { const i = document.getElementById("intro"); if (i) i.style.display = "none"; });
await pg.evaluate(() => window.__api.go(3));   // "Footprint in plan" — site layer on
await pg.waitForTimeout(9000);
const drawn = await pg.evaluate(() => {
  const v = window.__viewer, t = v.clock.currentTime;
  let cards = 0, fills = 0, gold = 0, goldVerts = 0, split = 0;
  v.entities.values.forEach((e) => {
    if (e.billboard) cards++;
    if (e.polygon) fills++;
    if (e.polyline && e.polyline.material && e.polyline.material.color) {
      const c = e.polyline.material.color.getValue(t);
      if (c && Math.abs(c.red - 0.949) < 0.02 && Math.abs(c.green - 0.757) < 0.02) {
        gold++;
        const p = e.polyline.positions.getValue(t);
        if (p && p.length > goldVerts) goldVerts = p.length;
      }
    }
    if (/Sample, Alex/i.test(e.name || "") && e.polyline) split++;
  });
  return { cards, fills, gold, goldVerts, split };
});
const drawnVerts = drawn.goldVerts;
const splitParts = drawn.split;
const corps = H.filter((h) => !h.subject && h.corporate).length;
ok("one card per company, plus the issuer, plus one for the rest",
   drawn.cards === corps + 2, `${drawn.cards} cards, ${corps} companies`);
ok("neighbouring parcels are filled", drawn.fills > 0, String(drawn.fills));
ok("the issuer's ground is drawn gold", drawn.gold >= 1, String(drawn.gold));
// The dissolve is the point of this block. The issuer holds 13 adjacent cell
// claims; drawn separately that is 13 gold rectangles and an audience sees a
// grid of internal fences. Dissolved it is ONE outline — plus the callout's
// own leader line, which is also gold.
ok("the issuer's claims are dissolved into one outline", drawn.gold === 2,
   `${drawn.gold} gold lines for 13 claims`);
ok("and the outline is the union, not a box around everything", (() => {
  // A convex hull or a bounding box closes in four or five vertices. The
  // issuer's block is staked as a staircase precisely so the union cannot be
  // mistaken for either — see SUBJECT_CELLS in tools/make_demo_tenures.py.
  const v = drawnVerts;
  return v > 8 && v < 200;
})(), String(drawnVerts) + " vertices");
ok("a holder whose ground is in two pieces still draws two",
   splitParts >= 2, `the split holder drew ${splitParts} parts`);

console.log("\n== author overrides");
// Feature toggles, callout notes and the issuer's own mark are the only parts
// of this layer a register cannot supply, so they are the parts most likely to
// be wired up wrong and never noticed.
const before = drawn.cards;
await pg.evaluate(() => window.__api.applyProject({ holders: {
  "Northline Metals Ltd.": { note: "Adjoining ground \u00b7 conceptual" },
  "Halden Minerals Ltd.": { feature: false },
  "SAMPLE, ALEX J.": { feature: true },
}}));
await pg.waitForTimeout(2500);
const after = await pg.evaluate(() => {
  const v = window.__viewer;
  return { cards: v.entities.values.filter((e) => e.billboard).length };
});
ok("hiding a company removes its card", after.cards === before,
   `${before} then ${after.cards}`);   // one lost, one gained
const meta = await pg.evaluate(() => window.__api.holderCards());
ok("a hidden company is folded into the aggregate",
   !meta.titles.some((t) => /Halden/.test(t)), meta.titles.join(" | "));
ok("a featured individual gets their own card",
   meta.titles.some((t) => /Sample, Alex/i.test(t)), meta.titles.join(" | "));
ok("the aggregate says 'Other holders' once a company is in it",
   meta.titles.some((t) => t === "Other holders"), meta.titles.join(" | "));
ok("a note is carried onto the card", meta.notes.includes("Adjoining ground · conceptual"),
   JSON.stringify(meta.notes));
const audit = await pg.evaluate(() => window.__api.provText());
ok("author-supplied notes are named in the audit trail",
   /author-supplied, not from the tenure register/.test(audit) &&
   /Adjoining ground/.test(audit), audit.split("\n").filter((l) => /author-supplied|Adjoining/.test(l)).join(" / "));

console.log("\nerrors:", errs.length ? errs : "none");
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail || errs.length ? 1 : 0);
