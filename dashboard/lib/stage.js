// Bedrock — where a project is in its life, and whether the data agrees.
//
// Four stages, which is how the industry actually talks: discovery,
// exploration, development, mining. They are worth having because almost
// everything a deck should say depends on which one you are in — a discovery
// story is about ground and anomalies, a development story is about tonnes and
// confidence, and a deck that opens with the wrong one is answering a question
// nobody asked.
//
// THE DESIGN DECISION, and the reason this file is more than a dropdown:
//
//   The stage is a CLAIM. The datasets are the EVIDENCE.
//
// Every other figure in this product is derived from geometry and cannot be
// typed. The stage cannot be derived — no file says "we are in development" —
// so it is the one number-like thing an author asserts freely. That makes it
// the obvious place for a deck to overstate itself, and "development stage"
// on a project with no resource estimate is exactly the kind of sentence a
// securities regulator reads twice.
//
// So the stage is checked against what is loaded, and a stage that outruns its
// evidence is said out loud — in the console while you are building, and in the
// deck's audit trail after you publish. It is NOT blocked: a company can be in
// development while its model sits with a consultant, and refusing to let them
// say so would be this tool inventing a rule the industry does not have. It is
// reported, which is the same thing this codebase does with fabricated data.

export const STAGES = [
  {
    key: "discovery",
    label: "Discovery",
    blurb: "Ground held, targets forming. Anomalies and first-pass sampling.",
    // What a stage is expected to be able to SHOW. Not a definition of the
    // stage — a company is in discovery whether or not it has uploaded
    // anything — but of what a deck at this stage can be built from.
    expects: ["site"],
    // The story a deck leads with here.
    leads: ["site", "geophysics", "geochem"],
  },
  {
    key: "exploration",
    label: "Exploration",
    blurb: "Drilling underway. Intercepts, but no resource estimate yet.",
    expects: ["site", "drills"],
    leads: ["site", "geophysics", "geochem", "drills"],
  },
  {
    key: "development",
    label: "Development",
    blurb: "A resource is estimated. Confidence, sections and economics.",
    expects: ["site", "drills", "blocks"],
    leads: ["blocks", "drills", "site"],
  },
  {
    key: "mining",
    label: "Mining",
    blurb: "In production or built. Reserves, pit or workings, and depletion.",
    expects: ["site", "drills", "blocks"],
    leads: ["blocks", "surfaces", "drills", "site"],
  },
];

export const STAGE_KEYS = STAGES.map((s) => s.key);
export const stageOf = (project) =>
  STAGES.find((s) => s.key === (project?.stage || "")) || null;

const KIND_LABEL = {
  site: "a property boundary",
  drills: "drilling",
  blocks: "a block model",
  geochem: "geochemistry",
  geophysics: "geophysics",
  surfaces: "surfaces",
  topography: "topography",
};

/**
 * Does the evidence support the claim?
 *
 * @returns {{stage, label, has:string[], missing:string[], overreach:boolean,
 *            note:string|null}}
 *
 * `overreach` is the one that matters: the author has said a stage the loaded
 * data cannot demonstrate. The note is written to be readable in a deck's audit
 * trail by somebody who did not build it.
 */
export function stageEvidence(project, datasets) {
  const st = stageOf(project);
  const has = [...new Set((datasets || []).map((d) => d.kind))];
  if (!st) {
    return { stage: null, label: null, has, missing: [], overreach: false,
             note: null };
  }
  const missing = st.expects.filter((k) => !has.includes(k));
  const overreach = missing.length > 0;
  return {
    stage: st.key,
    label: st.label,
    has,
    missing,
    overreach,
    note: overreach
      ? `This project is presented as ${st.label.toLowerCase()} stage, but ` +
        `${missing.map((k) => KIND_LABEL[k] || k).join(" and ")} ` +
        `${missing.length === 1 ? "has" : "have"} not been loaded, so nothing ` +
        "in this deck demonstrates it."
      : null,
  };
}

/**
 * Order the stage's own story first.
 *
 * Deliberately a REORDER and never a filter. What a deck can show is decided by
 * what data exists — that gate is in the candidate generator and stays there.
 * A stage only says which of the things it CAN show should lead, so a discovery
 * project opens on ground and anomalies and a development project opens on the
 * resource. Setting the stage can never make a slide appear or disappear; if it
 * could, the stage would be deciding what is true.
 */
export function stageRank(project) {
  const st = stageOf(project);
  if (!st) return () => 0;
  const order = new Map(st.leads.map((k, i) => [k, i]));
  return (candidate) => {
    const needs = candidate?.needs || [];
    let best = 99;
    for (const n of needs) if (order.has(n)) best = Math.min(best, order.get(n));
    return best;
  };
}
