// Orebody — the slide generator and the default running order.
//
// The generator's risk is not crashing, it is proposing a slide the data does
// not support, or proposing so many that the default deck stops being an
// argument. Both are checked against the candidate list itself rather than
// against a count that would drift the moment a beat is added.

import { projectCandidates, defaultOrder, toChapter } from "../dashboard/lib/slides.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log(`  ok   ${n}`))
                               : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));

const ds = (zone, kind, extra = {}) => ({ zone_id: zone, kind, ...extra });
const PROJ = { name: "Elk Gold", location: "Nicola, BC" };
const BLOCKS = {
  total: { tonnes: 8985428, grade_gt: 3.8, oz: 1097747 },
  by_class: { "1": { tonnes: 1e6 }, "2": { tonnes: 2e6 }, "3": { tonnes: 3e6 } },
};

console.log("== exploration: no block model");
const zEx = [{ id: "z1", name: "Siwash North" }];
const dEx = [ds("z1", "site"), ds("z1", "geochem", { stats: { element: "Au_ppb", samples: 900 } }),
             ds("z1", "geophysics", { stats: { products: [
               { key: "tmi", label: "Total field" }, { key: "rtp", label: "Reduced to pole" }] } })];
const cEx = projectCandidates(PROJ, zEx, dEx);
ok("no candidate needs a block model", !cEx.some((c) => c.needs.includes("blocks")));
ok("both magnetics products are offered", cEx.filter((c) => c.id.includes("geo-")).length === 2);
const sEx = defaultOrder(cEx, zEx);
ok("only ONE magnetics product is in the default deck",
   sEx.order.filter((c) => c.id.includes("geo-")).length === 1,
   String(sEx.order.filter((c) => c.id.includes("geo-")).length));
ok("the default deck is short enough to present", sEx.order.length <= 14, String(sEx.order.length));
ok("the second product is still reachable", sEx.extra >= 1, String(sEx.extra));

console.log("\n== resource: one zone with a model");
const zR = [{ id: "z1", name: "Siwash North" }];
const dR = [ds("z1", "site"), ds("z1", "drills"), ds("z1", "surfaces"),
            ds("z1", "blocks", { stats: BLOCKS })];
const cR = projectCandidates(PROJ, zR, dR);
const sR = defaultOrder(cR, zR);
ok("the default deck is a deck, not a queue", sR.order.length >= 8 && sR.order.length <= 14,
   String(sR.order.length));
ok("nothing was dropped from a single zone", sR.dropped === 0, String(sR.dropped));
ok("only the LAST classification step leads", sR.order.filter((c) => c.id.includes("class-")).length === 1);
ok("only one section axis leads", sR.order.filter((c) => c.id.includes("sect-")).length === 1);
ok("the intermediate reveals are still offered",
   cR.filter((c) => c.id.includes("class-")).length === 3);

// The order IS the argument, so assert the argument and not merely a length.
const ix = (frag) => sR.order.findIndex((c) => c.id.includes(frag));
ok("the ground comes before what is under it", ix("overview") < ix("orebody"));
ok("drilling comes before the resource it supports", ix("drills") < ix("orebody"));
ok("intercepts follow their drilling", ix("drills") < ix("intercepts"));
ok("confidence comes after the tonnage it qualifies", ix("orebody") < ix("class-"));

console.log("\n== two zones");
const z2 = [{ id: "z1", name: "North" }, { id: "z2", name: "South" }];
const d2 = [...dR, ds("z2", "drills"), ds("z2", "blocks", { stats: BLOCKS })];
const c2 = projectCandidates(PROJ, z2, d2);
const s2 = defaultOrder(c2, z2);
ok("a property opener leads", s2.order[0].id === "project:property", s2.order[0].id);
ok("the property columns close", s2.order[s2.order.length - 1].id === "project:columns",
   s2.order[s2.order.length - 1].id);
ok("still presentable in one sitting", s2.order.length <= 14, String(s2.order.length));
ok("overflow is reported, not silently truncated", s2.dropped > 0, String(s2.dropped));
ok("neither zone is stripped bare",
   ["z1", "z2"].every((z) => s2.order.filter((c) => c.zone_id === z).length >= 2));
ok("zones stay contiguous rather than interleaving", (() => {
  const zs = s2.order.filter((c) => c.zone_id).map((c) => c.zone_id);
  return zs.join(",") === [...new Set(zs)].map((z) => zs.filter((x) => x === z).join(",")).join(",");
})(), s2.order.filter((c) => c.zone_id).map((c) => c.zone_id).join(","));

console.log("\n== the row that gets written");
const row = toChapter(cR[0], 3);
ok("a chapter records the candidate it came from", row.source === cR[0].id, String(row.source));
ok("ord is carried", row.ord === 3);
ok("a hand-made chapter has no source", toChapter({ title: "x" }, 0).source === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
