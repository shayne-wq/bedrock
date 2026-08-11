// Bedrock — project stage: discovery, exploration, development, mining.
//
//   node tools/verify_stage.mjs
//
// The stage is the only thing on a deck an author asserts outright. Every
// figure this product prints is derived from geometry and cannot be typed; no
// file anywhere says "we are in development". That makes the stage the obvious
// place for a deck to overstate itself, and "development stage" on a project
// with no resource estimate is a sentence a securities regulator reads twice.
//
// So the rule this file exists to hold: the stage is a CLAIM, the datasets are
// the EVIDENCE, and a claim the evidence cannot support is reported — never
// blocked, because a company can be in development with its model still at a
// consultant, and refusing to let them say so would be this tool inventing a
// rule the industry does not have.
//
// The second rule, which is subtler and easier to break later: the stage may
// REORDER a deck and must never FILTER one. What a deck can show is decided by
// what data exists. If setting a dropdown could add or remove a slide, the
// stage would be deciding what is true.

import { STAGES, STAGE_KEYS, stageOf, stageEvidence, stageRank }
  from "../dashboard/lib/stage.js";
import { projectCandidates, defaultOrder } from "../dashboard/lib/slides.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") =>
  c ? (pass++, console.log("  ok   " + n))
    : (fail++, console.log("  FAIL " + n + (d ? " — " + d : "")));

const ds = (...kinds) => kinds.map((k, i) => ({ id: `d${i}`, zone_id: "z1", kind: k }));

console.log("— the vocabulary");
ok("four stages, in life order",
   STAGE_KEYS.join(",") === "discovery,exploration,development,mining",
   STAGE_KEYS.join(","));
ok("each carries a plain-language blurb", STAGES.every((s) => s.blurb.length > 20));
ok("an unset stage is not invented", stageOf({}) === null && stageOf({ stage: "" }) === null);
ok("an unknown stage is not silently accepted", stageOf({ stage: "advanced" }) === null);

console.log("\n— the claim, against the evidence");
const dev = { stage: "development" };
const e1 = stageEvidence(dev, ds("site", "drills"));
ok("development without a block model is flagged", e1.overreach === true);
ok("it names what is missing rather than just failing",
   e1.missing.join() === "blocks", e1.missing.join());
ok("the note is a sentence a stranger could read",
   /development stage/i.test(e1.note) && /block model/i.test(e1.note) &&
   /not been loaded/i.test(e1.note), e1.note);

const e2 = stageEvidence(dev, ds("site", "drills", "blocks"));
ok("development WITH a block model is not flagged", e2.overreach === false && e2.note === null);

const e3 = stageEvidence({ stage: "discovery" }, ds("site"));
ok("discovery needs only ground", e3.overreach === false);
const e4 = stageEvidence({ stage: "discovery" }, []);
ok("discovery with nothing loaded is still flagged", e4.overreach === true,
   JSON.stringify(e4.missing));
const e5 = stageEvidence({ stage: "exploration" }, ds("site", "geochem"));
ok("exploration without drilling is flagged", e5.overreach === true,
   e5.missing.join());
ok("geochem is not mistaken for drilling", e5.missing.includes("drills"));

const e6 = stageEvidence({}, ds("site", "blocks"));
ok("no stage set means nothing to check, not a failure",
   e6.overreach === false && e6.stage === null && e6.note === null);

// The whole point: it reports, it does not block.
ok("an overreaching stage still returns a usable result",
   e1.stage === "development" && e1.label === "Development",
   JSON.stringify([e1.stage, e1.label]));

console.log("\n— it reorders, and never filters");
const zones = [{ id: "z1", name: "Main", ord: 0 }];
const data = [
  { id: "a", zone_id: "z1", kind: "site",
    stats: { rings: 4, owners: [{ owner: "X", ha: 10 }], subject_owner: "X",
             bbox: [-120.4, 49.8, -120.2, 49.9] } },
  { id: "b", zone_id: "z1", kind: "drills", stats: { holes: 12 } },
  { id: "c", zone_id: "z1", kind: "geophysics",
    stats: { grids: 1, products: [{ key: "tmi", label: "TMI" }] } },
];
const base = { id: "p", name: "P", location: "Somewhere", epsg: 26910 };
const counts = {};
for (const stage of [null, ...STAGE_KEYS]) {
  const proj = { ...base, stage };
  const cands = projectCandidates(proj, zones, data);
  const { order } = defaultOrder(cands, zones, 14, proj);
  counts[stage || "unset"] = { c: cands.length, o: order.length,
                               first: order.filter((x) => x.zone_id).map((x) => x.id)[0] };
}
const sizes = new Set(Object.values(counts).map((v) => `${v.c}/${v.o}`));
ok("every stage offers and orders the SAME slides", sizes.size === 1,
   JSON.stringify(counts));
// ...but not necessarily in the same order.
console.log("   first zone slide by stage:",
  Object.entries(counts).map(([k, v]) => `${k}=${v.first}`).join("  "));

const rankDisc = stageRank({ stage: "discovery" });
const rankDev = stageRank({ stage: "development" });
ok("discovery ranks ground ahead of a block model",
   rankDisc({ needs: ["site"] }) < rankDisc({ needs: ["blocks"] }));
ok("development ranks the block model ahead of ground",
   rankDev({ needs: ["blocks"] }) < rankDev({ needs: ["site"] }));
ok("an unset stage ranks everything equally",
   stageRank({})({ needs: ["blocks"] }) === stageRank({})({ needs: ["site"] }));
ok("a slide needing nothing is not pushed around by the stage",
   rankDev({ needs: [] }) === rankDisc({ needs: [] }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
