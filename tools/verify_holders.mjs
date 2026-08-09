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
   .toUpperCase().includes("ELK GOLD"), (H.find((h) => h.subject) || {}).owner);

// The bug this file exists for.
const coast = find("COAST COPPER");
ok("Coast Copper is present", !!coast);
ok("Coast Copper is NOT drawn as the issuer's ground", coast && coast.subject === false,
   JSON.stringify(coast));

console.log("\n== companies and people");
ok("Barranco is read as a company", (find("BARRANCO") || {}).corporate === true);
ok("Flow Metals is read as a company", (find("FLOW METALS") || {}).corporate === true);
ok("a SURNAME, FIRSTNAME holder is read as a person",
   (find("RIPPON") || {}).corporate === false, JSON.stringify(find("RIPPON")));
ok("companies outrank people in the ordering", (() => {
   const nb = H.filter((h) => !h.subject);
   const lastCorp = nb.map((h) => h.corporate).lastIndexOf(true);
   const firstPerson = nb.map((h) => h.corporate).indexOf(false);
   return firstPerson === -1 || lastCorp < firstPerson;
})(), H.filter((h) => !h.subject).map((h) => (h.corporate ? "C" : "p")).join(""));

console.log("\n== area, which is a figure on a slide");
// Elk Gold holds 29 claims; the register's own hectares for its unique tenures
// sum to 18,688. A per-ring sum would inflate any MultiPolygon holder.
const elk = H.find((h) => h.subject);
ok("the issuer's area matches the register", Math.abs(elk.ha - 18688) < 1, String(elk.ha));
ok("Barranco's area matches the register", Math.abs(find("BARRANCO").ha - 2228.1) < 1,
   String(find("BARRANCO").ha));
ok("claim counts are per tenure, not per ring",
   elk.claims === 29 && find("BARRANCO").claims === 5,
   `${elk.claims}, ${find("BARRANCO").claims}`);

console.log("\n== what gets drawn");
await pg.evaluate(() => { const i = document.getElementById("intro"); if (i) i.style.display = "none"; });
await pg.evaluate(() => window.__api.go(11));   // site layer on
await pg.waitForTimeout(9000);
const drawn = await pg.evaluate(() => {
  const v = window.__viewer, t = v.clock.currentTime;
  let cards = 0, fills = 0, gold = 0;
  v.entities.values.forEach((e) => {
    if (e.billboard) cards++;
    if (e.polygon) fills++;
    if (e.polyline && e.polyline.material && e.polyline.material.color) {
      const c = e.polyline.material.color.getValue(t);
      if (c && Math.abs(c.red - 0.949) < 0.02 && Math.abs(c.green - 0.757) < 0.02) gold++;
    }
  });
  return { cards, fills, gold };
});
const corps = H.filter((h) => !h.subject && h.corporate).length;
ok("one card per company, plus the issuer, plus one for the rest",
   drawn.cards === corps + 2, `${drawn.cards} cards, ${corps} companies`);
ok("neighbouring parcels are filled", drawn.fills > 0, String(drawn.fills));
ok("the issuer's ground is drawn gold", drawn.gold >= 29, String(drawn.gold));
// 30 rings for 29 registered claims — one is a MultiPolygon, and drawing both
// its rings is correct. Plus the issuer's own callout leader, also gold.
ok("gold is drawn for the issuer's rings and nothing else", drawn.gold === 31,
   String(drawn.gold));

console.log("\n== author overrides");
// Feature toggles, callout notes and the issuer's own mark are the only parts
// of this layer a register cannot supply, so they are the parts most likely to
// be wired up wrong and never noticed.
const before = drawn.cards;
await pg.evaluate(() => window.__api.applyProject({ holders: {
  "BARRANCO GOLD MINING CORP.": { note: "1.2 Moz Au \u00b7 TSXV:BAR" },
  "FLOW METALS CORP.": { feature: false },
  "RIPPON, DONALD JOHN": { feature: true },
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
   !meta.titles.some((t) => /Flow Metals/.test(t)), meta.titles.join(" | "));
ok("a featured individual gets their own card",
   meta.titles.some((t) => /Rippon/i.test(t)), meta.titles.join(" | "));
ok("the aggregate says 'Other holders' once a company is in it",
   meta.titles.some((t) => t === "Other holders"), meta.titles.join(" | "));
ok("a note is carried onto the card", meta.notes.includes("1.2 Moz Au · TSXV:BAR"),
   JSON.stringify(meta.notes));
const audit = await pg.evaluate(() => window.__api.provText());
ok("author-supplied notes are named in the audit trail",
   /author-supplied, not from the tenure register/.test(audit) &&
   /1\.2 Moz Au/.test(audit), audit.split("\n").filter((l) => /author-supplied|Moz/.test(l)).join(" / "));

console.log("\nerrors:", errs.length ? errs : "none");
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail || errs.length ? 1 : 0);
