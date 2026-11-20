// Orebody — the slide generator and the default running order.
//
// The generator's risk is not crashing, it is proposing a slide the data does
// not support, or proposing so many that the default deck stops being an
// argument. Both are checked against the candidate list itself rather than
// against a count that would drift the moment a beat is added.

import { projectCandidates, defaultOrder, toChapter, openingChapters } from "../dashboard/lib/slides.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log(`  ok   ${n}`))
                               : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));

const ds = (zone, kind, extra = {}) => ({ zone_id: zone, kind, ...extra });
const PROJ = { name: "Bedrock Demo", location: "Coast Mountains, BC" };
const BLOCKS = {
  total: { tonnes: 8985428, grade_gt: 3.8, oz: 1097747 },
  by_class: { "1": { tonnes: 1e6 }, "2": { tonnes: 2e6 }, "3": { tonnes: 3e6 } },
};

console.log("== exploration: no block model");
const zEx = [{ id: "z1", name: "North Zone" }];
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
const zR = [{ id: "z1", name: "North Zone" }];
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
ok("the district view leads", s2.order[0].id === "open:district", s2.order[0].id);
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

console.log("\n== the opening, which is not optional");
const SITE_STATS = { rings: 6, subject_owner: "BEDROCK DEMO", owners: [
  { owner: "BEDROCK DEMO", claims: 29, ha: 18688 },
  { owner: "BARRANCO GOLD MINING CORP.", claims: 5, ha: 2228 },
  { owner: "RIPPON, DONALD JOHN", claims: 3, ha: 3519 },
]};
const zO = [{ id: "z1", name: "North Zone" }];
const dO = [ds("z1", "site", { stats: SITE_STATS }), ds("z1", "drills")];
const PO = { name: "Bedrock Demo", location: "Coast Mountains, BC", commodity: "Gold",
             brand: { summary: "A past-producing high-grade gold property." } };
const open = openingChapters(PO, zO, dO);
// One zone: two opening slides, because a "the zones" slide and that zone's
// own overview would be the same slide with the same title, back to back.
ok("one zone opens on two slides", open.length === 2, String(open.length));
ok("in order: district, then the property",
   open.map((c) => c.id).join(",") === "open:district,open:property",
   open.map((c) => c.id).join(","));
const z2o = [{ id: "z1", name: "North" }, { id: "z2", name: "South" }];
const d2o = [ds("z1", "site", { stats: SITE_STATS }), ds("z1", "drills"), ds("z2", "drills")];
const open2 = openingChapters(PO, z2o, d2o);
ok("two zones earn the third slide",
   open2.map((c) => c.id).join(",") === "open:district,open:property,open:zones",
   open2.map((c) => c.id).join(","));
ok("and it names them", /North, South/.test(open2[2].body), open2[2].body);
ok("the district slide is the widest view",
   open[0].camera.r > open[1].camera.r && open[1].camera.r > 0,
   `${open[0].camera.r} then ${open[1].camera.r}`);
ok("it counts the neighbours it will name", /2 other holders/.test(open[0].body), open[0].body);
ok("the property slide uses the author's own words",
   open[1].body === PO.brand.summary, open[1].body);
ok("and prompts for one when there is none",
   /Add a description/.test(openingChapters({ name: "X" }, zO, dO)[1].body));
ok("no opening slide draws the block model",
   open.every((c) => c.layers.blocks === false));
ok("they lead the default order, with the zone's own overview third",
   defaultOrder(projectCandidates(PO, zO, dO), zO).order.slice(0, 3)
     .map((x) => x.id).join(",") === "open:district,open:property,z1:overview",
   defaultOrder(projectCandidates(PO, zO, dO), zO).order.slice(0, 3).map((x) => x.id).join(","));
ok("no two slides in a row share a title", (() => {
  const t = defaultOrder(projectCandidates(PO, zO, dO), zO).order.map((c) => c.title);
  return t.every((x, i) => i === 0 || x !== t[i - 1]);
})(), defaultOrder(projectCandidates(PO, zO, dO), zO).order.map((c) => c.title).join(" | "));

// A project with no tenure file has nothing to show at district scale.
const noSite = openingChapters(PO, zO, [ds("z1", "drills")]);
ok("no district slide without a boundary file",
   !noSite.some((c) => c.id === "open:district"), noSite.map((c) => c.id).join(","));
ok("but the deck still opens on the property", noSite[0].id === "open:property");

// Trimming a long multi-zone deck must never cost the opening.
const zMany = [{ id: "z1", name: "A" }, { id: "z2", name: "B" }, { id: "z3", name: "C" }];
const dMany = zMany.flatMap((z) => [ds(z.id, "site", { stats: SITE_STATS }),
  ds(z.id, "drills"), ds(z.id, "surfaces"), ds(z.id, "blocks", { stats: BLOCKS })]);
const sMany = defaultOrder(projectCandidates(PO, zMany, dMany), zMany);
ok("three zones overflow the cap", sMany.dropped > 0, String(sMany.dropped));
ok("and the opening survives it",
   sMany.order.slice(0, 3).map((c) => c.id).join(",") ===
   "open:district,open:property,open:zones",
   sMany.order.slice(0, 3).map((c) => c.id).join(","));
ok("no opening slide leaves the depth grid on",
   openingChapters(PO, zMany, dMany).every((c) => c.layers.depth === false));
ok("and none of them lets the colour-pop mask black out the district",
   openingChapters(PO, zMany, dMany).slice(0, 2).every((c) => c.layers.pop === false));

console.log("\n== the row that gets written");
const row = toChapter(cR[0], 3);
ok("a chapter records the candidate it came from", row.source === cR[0].id, String(row.source));
ok("ord is carried", row.ord === 3);
ok("a hand-made chapter has no source", toChapter({ title: "x" }, 0).source === null);


console.log("\n== the rig gets a slide of its own");
// `layers.drilling` could always switch the rig OFF — it is on by default on
// every chapter, like the north arrow — and nothing could switch it on as the
// SUBJECT. So the most current fact in the deck had no slide, only a pin in
// the corner of a slide about something else.
const zRig = [{ id: "z1", name: "North Zone" }];
const dRig = [ds("z1", "site"), ds("z1", "drills")];
const GPROG = [{ id: "prog-1", zone_id: "z1", name: "2026 Phase 2", status: "active" }];
const cRig = projectCandidates(PROJ, zRig, dRig, GPROG);
const rig = cRig.find((c) => c.id === "z1:rig");
ok("a programme earns a chapter", !!rig, cRig.map((c) => c.id).join(","));
ok("...titled for a rig that is turning", rig?.title === "Drilling under way", rig?.title);
// The id, not `true`: a chapter row carries no zone, so `true` would leave a
// two-programme property guessing which rig the slide meant.
ok("...naming the programme by id, so the viewer cannot pick the wrong rig",
   rig?.layers?.rig === "prog-1", JSON.stringify(rig?.layers));
ok("...with the drilling layer on as the subject, not merely allowed",
   rig?.layers?.drilling === true && rig?.layers?.drills === true,
   JSON.stringify(rig?.layers));
// Every metre count in a deck is read when the deck is OPENED. A figure
// written into slide copy is frozen on the day it was generated and would
// eventually contradict the live panel on the same screen.
ok("...and no figure baked into its copy",
   !/\d{2,}/.test(rig?.body || ""), rig?.body);
ok("it is justified by a programme rather than a dataset kind",
   rig?.needs?.includes("programs") === true, JSON.stringify(rig?.needs));
// It reads after the holes and what they hit: here is what we drilled, here is
// what it hit, here is the rig still turning.
ok("it sits after the intercepts in the argument",
   rig?.spine > (cRig.find((c) => c.id === "z1:intercepts")?.spine ?? 0),
   `${rig?.spine} vs ${cRig.find((c) => c.id === "z1:intercepts")?.spine}`);
ok("...and makes the default deck", defaultOrder(cRig, zRig).order.some((c) => c.id === "z1:rig"));

// THE RULE THAT MATTERS, applied to this beat too: nothing is proposed that
// the data does not support. No programme, no slide about a rig.
ok("no programme, no rig chapter",
   !projectCandidates(PROJ, zRig, dRig).some((c) => c.id === "z1:rig"));
ok("...and a programme in ANOTHER zone does not put a rig in this one",
   !projectCandidates(PROJ, zRig, dRig,
     [{ id: "p9", zone_id: "z9", name: "Elsewhere", status: "active" }])
     .some((c) => c.id === "z1:rig"));
// A finished programme is still worth a slide; it just is not news.
const cDone = projectCandidates(PROJ, zRig, dRig,
  [{ id: "p2", zone_id: "z1", name: "2024 Phase 1", status: "complete" }]);
ok("a completed programme is titled in the past tense",
   cDone.find((c) => c.id === "z1:rig")?.title === "The programme, as drilled",
   cDone.find((c) => c.id === "z1:rig")?.title);
const cPlan = projectCandidates(PROJ, zRig, dRig,
  [{ id: "p3", zone_id: "z1", name: "2027 Phase 3", status: "planned" }]);
ok("a planned one is titled with its own name",
   cPlan.find((c) => c.id === "z1:rig")?.title === "2027 Phase 3",
   cPlan.find((c) => c.id === "z1:rig")?.title);
// Two programmes on one zone: lead with the one that is turning.
const cTwo = projectCandidates(PROJ, zRig, dRig, [
  { id: "old", zone_id: "z1", name: "2024 Phase 1", status: "complete" },
  { id: "now", zone_id: "z1", name: "2026 Phase 2", status: "active" },
]);
ok("with two programmes it leads with the live one",
   cTwo.find((c) => c.id === "z1:rig")?.layers?.rig === "now",
   JSON.stringify(cTwo.find((c) => c.id === "z1:rig")?.layers));
// And the flattening the viewer relies on: layers become chapter keys.
ok("toChapter carries the rig layer through to the row",
   toChapter(rig, 3).layers.rig === "prog-1",
   JSON.stringify(toChapter(rig, 3).layers));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
