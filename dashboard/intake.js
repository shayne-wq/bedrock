// Bedrock console — client onboarding intake.
//
// One page per project, filled in by the client: who they are, what data they
// have (uploaded right here), what the deck should focus on, which neighbours
// matter, who it is for, and WHO MAY SEE IT. It ends with a named person
// signing a fixed set of statements; the database records that signature and
// creates the invitations from it (supabase/migrations/…_intake.sql).
//
// The access list is the reason the signature exists. Who sees a company's
// unreleased data is the company's call, so the console never offers us a way
// to add people to an intake on their behalf — it records whom THEY named.
//
// Everything the client types is saved per section as they go (intake_save),
// so two people filling in different sections do not overwrite each other.

import { db, state, $, esc, fmtDate, fmtBytes, toast, fail, wire } from "./lib/ui.js";
import { CONFIG } from "./config.js";
import { sniff } from "./lib/formats.js";
import { STAGES } from "./lib/stage.js";

// ------------------------------------------------------------ the form -----
// The data checklist. `spatial` rows are checked with sniff() at upload, so a
// Vulcan .bmf is named and the right export suggested while the person who has
// Vulcan open is still at their desk.
export const DATA_ROWS = [
  { key: "blocks", label: "Block model", spatial: true,
    need: "Block centroids X/Y/Z, block size, grade per element, density, resource class, domain, % in domain.",
    formats: "OMF (Leapfrog, Micromine, Deswik) or CSV. Not Datamine .dm or Vulcan .bmf." },
  { key: "resource", label: "Resource estimate",
    need: "Tonnes, grade and contained metal by category; cut-off; effective date; QP; link to the technical report.",
    formats: "PDF or spreadsheet." },
  { key: "geomodel", label: "Geological model (Leapfrog)", spatial: true,
    need: "Vein, lithology, mineralized-domain and fault wireframes, each named.",
    formats: "OMF, otherwise OBJ or DXF." },
  { key: "drill_collars", label: "Drill collars", spatial: true,
    need: "Hole ID, easting, northing, elevation, final depth, year, and completed vs planned.",
    formats: "CSV." },
  { key: "drill_surveys", label: "Drill surveys", spatial: true,
    need: "Hole ID, depth, azimuth, dip.", formats: "CSV." },
  { key: "drill_assays", label: "Assays and logs", spatial: true,
    need: "Hole ID, from, to, one column per element with its unit (e.g. au_ppm), lithology.",
    formats: "CSV." },
  { key: "intercepts", label: "Headline intercepts",
    need: "The intercepts you quote publicly, worded exactly as in your news releases.",
    formats: "List, spreadsheet or the releases themselves." },
  { key: "geophysics", label: "Geophysics", spatial: true,
    need: "Magnetics (TMI, RTP, 1VD), IP chargeability and resistivity, EM. One file per product, named.",
    formats: "GeoTIFF. Not Geosoft .grd." },
  { key: "geochem", label: "Geochemistry", spatial: true,
    need: "Soil, rock, till and stream-sediment samples with element values.",
    formats: "CSV, one file per sample type." },
  { key: "claims", label: "Claims / tenure", spatial: true,
    need: "Boundaries and tenure numbers. Tenure numbers alone are enough in BC, Yukon and Saskatchewan.",
    formats: "Zipped SHP, KML/KMZ or GeoJSON." },
  { key: "topography", label: "Topography", spatial: true,
    need: "DEM or LiDAR-derived surface. Without one we use public terrain.",
    formats: "GeoTIFF or ESRI ASCII grid. Not raw point clouds." },
  { key: "site", label: "Site and infrastructure", spatial: true,
    need: "Roads, camp, portals, workings, pit shells, plant, power.",
    formats: "DXF, SHP, KML or OBJ." },
  { key: "maps", label: "Geology / alteration maps", spatial: true,
    need: "Mapped units, structures, alteration.",
    formats: "GeoTIFF, or PNG/JPG with its world file." },
  { key: "brand", label: "Logo and existing material",
    need: "Logo, latest corporate deck, latest technical report.",
    formats: "SVG or PNG; PPTX or PDF." },
];

const HAVE = [
  { v: "yes", label: "Attached" },
  { v: "partial", label: "Partial" },
  { v: "later", label: "Coming later" },
  { v: "no", label: "Don't have" },
];

const SECTIONS = [
  { key: "company", label: "Company and project" },
  { key: "data", label: "Data and files" },
  { key: "focal", label: "Focal points" },
  { key: "neighbours", label: "Neighbouring properties" },
  { key: "audience", label: "Audience and disclosure" },
  { key: "access", label: "People and access" },
  { key: "timeline", label: "Timeline" },
  { key: "sign", label: "Review and sign" },
];

const EXPORTS = ["Web link", "Website embed", "MP4 video", "PowerPoint", "PDF"];

// What makes each section complete. Deliberately small: the point is that we
// can start building, not that every field is filled.
function sectionStatus(key, a, files) {
  const s = a[key] || {};
  const has = (v) => typeof v === "string" ? v.trim().length > 0 : !!v;
  switch (key) {
    case "company": {
      const req = ["legal_name", "project_name", "commodity", "location", "crs", "stage"];
      const miss = req.filter((k) => !has(s[k]));
      return { done: !miss.length, note: miss.length ? `${miss.length} required field${miss.length === 1 ? "" : "s"} left` : "" };
    }
    case "data": {
      const unanswered = DATA_ROWS.filter((r) => !s[r.key]?.have).length;
      const noFile = DATA_ROWS.filter((r) => s[r.key]?.have === "yes"
        && !files.some((f) => f.slot === r.key)).length;
      return {
        done: !unanswered,
        note: unanswered ? `${unanswered} row${unanswered === 1 ? "" : "s"} not answered`
            : noFile ? `${noFile} marked attached with no file` : "",
        warn: !!noFile,
      };
    }
    case "focal": {
      const n = (s.points || []).filter((p) => has(p?.point)).length;
      return { done: n >= 4, note: n >= 4 ? "" : `${n} of at least 4` };
    }
    case "neighbours": {
      const n = (s.rows || []).filter((r) => has(r?.company)).length;
      return { done: n > 0 || !!s.none, note: n || s.none ? "" : "Add one, or tick none" };
    }
    case "audience": {
      const miss = ["audience", "qp_name"].filter((k) => !has(s[k]));
      return { done: !miss.length, note: miss.length ? "Audience and QP needed" : "" };
    }
    case "access": {
      const n = (s.people || []).filter((p) => has(p?.email)).length;
      return { done: n > 0 && has(s.main_contact),
               note: !n ? "Name at least one person" : has(s.main_contact) ? "" : "Main contact needed" };
    }
    case "timeline":
      return { done: has(s.draft_date), note: has(s.draft_date) ? "" : "First-draft date needed" };
    default: return { done: false, note: "" };
  }
}

// ------------------------------------------------------------ page state ---
let ctx = null;   // { intake, project, org, files, terms, attestations, editor }
const timers = {};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Is the signed-in person on our side of this org (may change status)? */
function isEditor(orgId) {
  const r = state.roles?.[orgId];
  return !!r && r !== "client";
}

export async function renderIntake(projectId, view) {
  view.innerHTML = `<div class="panel"><div class="skel row"></div><div class="skel row"></div></div>`;

  const { data: project, error: pe } = await db.from("projects")
    .select("id, name, org_id, commodity, location, epsg, stage, brand")
    .eq("id", projectId).maybeSingle();
  if (pe) return fail("Project", pe);
  if (!project) {
    view.innerHTML = `<div class="empty"><h3>Project not found</h3>
      <p>It may have been deleted, or it belongs to an organisation you are not a member of.</p>
      <a class="btn" href="#/">Back to projects</a></div>`;
    return;
  }
  const org = state.orgs.find((o) => o.id === project.org_id) || { id: project.org_id, name: "" };

  let { data: intake, error: ie } = await db.from("intakes")
    .select("*").eq("project_id", projectId).maybeSingle();
  if (ie) {
    view.innerHTML = `<div class="empty"><h3>Onboarding is not available yet</h3>
      <p>It needs the <code>intake</code> migration. Run <code>supabase db push</code> and reload.</p>
      <a class="btn" href="#/p/${esc(projectId)}">Back to the project</a></div>`;
    return;
  }
  // The first visitor opens it. Seeded from what the project already knows, so
  // nobody is asked for a name we were given when the project was created.
  if (!intake) {
    const seed = { company: {
      legal_name: org.name || "", project_name: project.name || "",
      commodity: project.commodity || "", location: project.location || "",
      crs: project.epsg ? `EPSG ${project.epsg}` : "", stage: project.stage || "",
      description: project.brand?.summary || "",
    } };
    const ins = await db.from("intakes")
      .insert({ project_id: projectId, answers: seed }).select("*").single();
    // Two people opening it at once: the unique key refuses the second, who
    // then reads the row the first created.
    if (ins.error) {
      const again = await db.from("intakes").select("*").eq("project_id", projectId).maybeSingle();
      if (!again.data) return fail("Start onboarding", ins.error);
      intake = again.data;
    } else intake = ins.data;
  }

  const [{ data: files }, { data: terms }, { data: atts }] = await Promise.all([
    db.from("intake_files").select("*").eq("intake_id", intake.id).order("uploaded_at"),
    db.from("intake_terms").select("*").eq("current", true).maybeSingle(),
    db.from("intake_attestations").select("*").eq("intake_id", intake.id)
      .order("signed_at", { ascending: false }),
  ]);

  ctx = {
    intake, project, org, files: files || [], terms, attestations: atts || [],
    editor: isEditor(project.org_id),
    a: structuredClone(intake.answers || {}),
  };
  paint(view);
}

const open = () => ctx.intake.status === "open";

// ---------------------------------------------------------------- render ---
function paint(view) {
  const { project, intake, a, files } = ctx;
  const st = Object.fromEntries(SECTIONS.filter((s) => s.key !== "sign")
    .map((s) => [s.key, sectionStatus(s.key, a, files)]));
  const doneN = Object.values(st).filter((x) => x.done).length;
  const total = Object.keys(st).length;
  const chip = { open: ["draft", "In progress"], submitted: ["warn", "Submitted"],
                 accepted: ["live", "Accepted"] }[intake.status];

  view.innerHTML = `
    <header class="page"><div class="row">
      <div class="grow">
        <span class="eyebrow"><a href="#/">Projects</a> / <a href="#/p/${esc(project.id)}">${esc(project.name)}</a></span>
        <h1>Onboarding</h1>
        <p>Tell us about the project, upload what you have, and name who should
           have access. Everything saves as you type.</p>
      </div>
      <div class="row-actions">
        <span class="chip ${chip[0]}">${chip[1]}</span>
        <span class="savestate" id="savestate"></span>
      </div>
    </div></header>

    ${statusBanner()}

    <div class="intake">
      <nav class="inav" aria-label="Sections">
        <div class="iprog"><b>${doneN} of ${total}</b> sections complete
          <div class="ibar"><i style="width:${Math.round(doneN / total * 100)}%"></i></div></div>
        ${SECTIONS.map((s, i) => {
          const x = st[s.key];
          return `<a href="#isec-${s.key}" data-jump="${s.key}" class="${x?.done ? "done" : ""}">
            <span class="n">${x?.done ? "✓" : i + 1}</span>${esc(s.label)}</a>`;
        }).join("")}
      </nav>
      <div class="ibody ${open() ? "" : "locked"}">
        ${secCompany()}
        ${secData()}
        ${secFocal()}
        ${secNeighbours()}
        ${secAudience()}
        ${secAccess()}
        ${secTimeline()}
        ${secSign(st)}
      </div>
    </div>`;

  wire(view);
  bind(view);
}

function statusBanner() {
  const { intake, attestations, editor } = ctx;
  const last = attestations[0];
  if (intake.status === "open") {
    return last ? `<div class="note" style="margin-bottom:16px">
      <b>Reopened.</b> Signed by ${esc(last.signer_name)} on ${fmtDate(last.signed_at)},
      then reopened for changes. It needs signing again once you are done.</div>` : "";
  }
  return `<div class="note ${intake.status === "accepted" ? "" : "warn"}" style="margin-bottom:16px">
      <b>${intake.status === "accepted" ? "Accepted by Bedrock." : "Submitted — Bedrock is reviewing it."}</b>
      Signed by ${esc(last?.signer_name || "—")}, ${esc(last?.signer_title || "")}
      (${esc(last?.signer_email || "")}) on ${fmtDate(last?.signed_at)}.
      ${editor ? "" : "To change anything, ask Bedrock to reopen it."}
      ${editor ? `<div class="row-actions" style="margin-top:10px">
        ${intake.status === "submitted" ? `<button class="btn sm primary" id="iaccept">Mark accepted</button>` : ""}
        <button class="btn sm" id="iapply">Copy answers to project settings</button>
        <button class="btn sm" id="ireopen">Reopen for changes</button>
      </div>` : ""}
    </div>`;
}

// Small field helpers. `data-path` is "section.field"; bind() writes it back.
// Placeholders are examples, so they are dropped once the intake is locked —
// on a signed record "TSXV: NGC" in grey reads as the client's answer.
const ph = (t) => open() && t ? ` placeholder="${esc(t)}"` : "";
const val = (path) => {
  const [s, k] = path.split(".");
  return ctx.a[s]?.[k] ?? "";
};
const dis = () => open() ? "" : "disabled";
const req = (r) => r ? ` <em class="req">required</em>` : "";

function input(path, label, { ph: phText = "", req: r = false, type = "text", hint = "" } = {}) {
  const id = "f-" + path.replace(/\W/g, "-");
  return `<div class="field"><label for="${id}">${esc(label)}${req(r)}</label>
    <input type="${type}" id="${id}" data-path="${path}" value="${esc(val(path))}"
      ${ph(phText)} ${dis()}>${hint ? `<p class="hintline">${hint}</p>` : ""}</div>`;
}
function area(path, label, { ph: phText = "", req: r = false, rows = 3, hint = "" } = {}) {
  const id = "f-" + path.replace(/\W/g, "-");
  return `<div class="field"><label for="${id}">${esc(label)}${req(r)}</label>
    <textarea id="${id}" rows="${rows}" data-path="${path}" ${ph(phText)} ${dis()}>${esc(val(path))}</textarea>
    ${hint ? `<p class="hintline">${hint}</p>` : ""}</div>`;
}
function select(path, label, opts, { req: r = false, hint = "" } = {}) {
  const id = "f-" + path.replace(/\W/g, "-");
  const v = val(path);
  return `<div class="field"><label for="${id}">${esc(label)}${req(r)}</label>
    <select id="${id}" data-path="${path}" ${dis()}>
      <option value="">— choose —</option>
      ${opts.map((o) => `<option value="${esc(o.v)}"${v === o.v ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
    </select>${hint ? `<p class="hintline">${hint}</p>` : ""}</div>`;
}
const sec = (key, n, title, lead, body) => `
  <section class="panel isec" id="isec-${key}">
    <div class="row"><h2 class="grow"><span class="secn">${n}</span>${esc(title)}</h2>
      <span class="hint" data-secnote="${key}"></span></div>
    ${lead ? `<p class="lead" style="margin:0 0 16px">${lead}</p>` : ""}
    ${body}
  </section>`;

function secCompany() {
  return sec("company", 1, "Company and project", "", `
    <div class="grid two">
      ${input("company.legal_name", "Company legal name", { req: true, ph: "Northern Gold Corp." })}
      ${input("company.ticker", "Ticker(s)", { ph: "TSXV: NGC" })}
      ${input("company.project_name", "Project / property name", { req: true })}
      ${input("company.zones", "Zones or deposits to show", { ph: "North Zone, South Zone" })}
      ${input("company.commodity", "Primary commodity and by-products", { req: true, ph: "Gold, with silver" })}
      ${input("company.location", "Location", { req: true, ph: "Toodoggone, British Columbia; 40 km from Smithers" })}
      ${input("company.crs", "Coordinate system of your files", { req: true, ph: "NAD83 UTM 9N (EPSG 26909)",
        hint: "Every file you upload is read in this system. If different files use different systems, say so in their notes." })}
      ${select("company.stage", "Stage", STAGES.map((s) => ({ v: s.key, label: s.label })), { req: true,
        hint: "Checked against the data you send. A development-stage deck with no resource estimate is flagged." })}
      ${input("company.ownership", "Ownership, options, JVs, royalties", { ph: "100%, 2% NSR to …" })}
      ${input("company.claims", "Claims: count and total hectares", { ph: "11 tenures, 4,250 ha" })}
    </div>
    ${area("company.description", "Property description", { rows: 3,
      ph: "One paragraph. It opens the deck and is the sentence most people will remember." })}`);
}

function secData() {
  const { files } = ctx;
  const d = ctx.a.data || {};
  const me = state.session?.user?.id;
  return sec("data", 2, "Data and files",
    `Upload raw exports, not screenshots. Say what each row is in the notes if anything is
     modelled, planned or interpreted rather than measured, so it is labelled that way on screen.
     No block model yet is fine — exploration decks lead with ground, drilling, geophysics and geochemistry.`,
    `<div class="drows">${DATA_ROWS.map((r) => {
      const mine = files.filter((f) => f.slot === r.key);
      const have = d[r.key]?.have || "";
      return `<div class="drow" data-slot="${r.key}">
        <div class="dhead">
          <div class="grow"><b>${esc(r.label)}</b>
            <span class="sub">${esc(r.need)}</span>
            <span class="fmt">${esc(r.formats)}</span></div>
          <select data-have="${r.key}" aria-label="Do you have ${esc(r.label)}?" ${dis()}>
            <option value="">Have it?</option>
            ${HAVE.map((h) => `<option value="${h.v}"${have === h.v ? " selected" : ""}>${h.label}</option>`).join("")}
          </select>
        </div>
        ${mine.length ? `<div class="flist">${mine.map((f) => fileLine(f, me)).join("")}</div>` : ""}
        <div class="dfoot">
          ${open() ? `<label class="btn sm">Upload files<input type="file" multiple hidden data-upload="${r.key}"></label>
            <span class="hint dropnote">or drop files here</span>` : ""}
          <input type="text" class="dnote" data-note="${r.key}"${ph("Notes (optional)")}
            value="${esc(d[r.key]?.note || "")}" ${dis()}>
        </div>
        <div class="uprog" data-prog="${r.key}" hidden></div>
      </div>`;
    }).join("")}</div>`);
}

function fileLine(f, me) {
  const warn = f.readable === false;
  const canDel = (f.uploaded_by === me && open()) || ctx.editor;
  return `<div class="fline">
    <span class="fname" title="${esc(f.filename)}">${esc(f.filename)}</span>
    <span class="mono fsize">${fmtBytes(f.bytes)}</span>
    ${warn ? `<span class="chip warn" title="${esc(f.meta?.advice || "")}">We can't read this format</span>`
           : f.format ? `<span class="chip live">${esc(f.format)}</span>` : ""}
    <button class="btn sm" data-dl="${esc(f.id)}">Download</button>
    ${canDel ? `<button class="btn sm danger" data-rmfile="${esc(f.id)}">Remove</button>` : ""}
    ${warn && f.meta?.advice ? `<span class="fadvice">${esc(f.meta.advice)}</span>` : ""}
  </div>`;
}

function secFocal() {
  const f = ctx.a.focal || {};
  const pts = f.points || [];
  // Examples, shown as placeholders: [evidence, the point, the view].
  const ex = [
    ["Block model, resource estimate", "The resource is 527 koz and open at depth.", "Grade shells with the deepest holes"],
    ["Assays for hole 24-07", "Hole 24-07 hit 12 m at 8.4 g/t Au.", "Drill trace with a callout"],
    ["TMI and RTP grids", "A mag high 2 km east has never been drilled.", "Magnetics draped on terrain"],
    ["2025 and 2026 drilling", "2026 step-outs extended the vein 300 m.", "Before and after"],
    ["Roads and power line", "Road access, 40 km from grid power.", "Regional view with infrastructure"],
  ];
  return sec("focal", 3, "Focal points",
    "The 4 to 5 things an investor should remember. Each becomes a chapter or two of the deck, in this order.",
    `<div class="tablewrap"><table class="itable">
      <thead><tr><th class="n">#</th><th>Focal point (one sentence)</th><th>Data that proves it</th><th>The view you picture</th></tr></thead>
      <tbody>${[0, 1, 2, 3, 4].map((i) => `<tr>
        <td class="n mono">${i + 1}</td>
        <td><input type="text" data-list="focal.points.${i}.point" value="${esc(pts[i]?.point || "")}" ${ph(ex[i][1])} ${dis()}></td>
        <td><input type="text" data-list="focal.points.${i}.evidence" value="${esc(pts[i]?.evidence || "")}" ${ph(ex[i][0])} ${dis()}></td>
        <td><input type="text" data-list="focal.points.${i}.view" value="${esc(pts[i]?.view || "")}" ${ph(ex[i][2])} ${dis()}></td>
      </tr>`).join("")}</tbody></table></div>
    <div class="grid two" style="margin-top:16px">
      ${area("focal.key_slide", "The one slide you most want to get right", { rows: 2 })}
      ${area("focal.do_not_show", "Anything we must NOT show", { rows: 2,
        ph: "Confidential holes, pending assays, areas under negotiation…" })}
    </div>`);
}

function secNeighbours() {
  const n = ctx.a.neighbours || {};
  const rows = n.rows || [];
  const me = state.session?.user?.id;
  return sec("neighbours", 4, "Neighbouring properties",
    `We pull surrounding tenure from the government registry for BC, Yukon and Saskatchewan,
     so you only need to say which neighbours matter and why. We never take a company's logo
     off the web — upload it, or we show the name only. Quote only figures that are public.`,
    `${rows.map((r, i) => {
      const logo = ctx.files.filter((f) => f.slot === "neighbour_logo" && f.meta?.row === r.id);
      return `<div class="nrow" data-nrow="${esc(r.id)}">
        <div class="grid two">
          <div class="field"><label>Company</label><input type="text" data-list="neighbours.rows.${i}.company" value="${esc(r.company || "")}" ${dis()}></div>
          <div class="field"><label>Property / deposit</label><input type="text" data-list="neighbours.rows.${i}.property" value="${esc(r.property || "")}" ${dis()}></div>
          <div class="field"><label>Why it matters</label><input type="text" data-list="neighbours.rows.${i}.why" value="${esc(r.why || "")}" ${ph("Producer on the same trend")} ${dis()}></div>
          <div class="field"><label>Public figure to quote, with source</label><input type="text" data-list="neighbours.rows.${i}.figure" value="${esc(r.figure || "")}" ${ph("2.1 Moz M&I, NI 43-101, March 2025 (link)")} ${dis()}></div>
        </div>
        <div class="row-actions">
          ${logo.length ? logo.map((f) => fileLine(f, me)).join("")
            : open() ? `<label class="btn sm">Upload their logo<input type="file" accept="image/*,.svg" hidden data-logo="${esc(r.id)}"></label>` : ""}
          ${open() ? `<button class="btn sm danger" data-rmnrow="${i}">Remove neighbour</button>` : ""}
        </div>
      </div>`;
    }).join("")}
    ${open() ? `<button class="btn" id="addnrow">Add a neighbour</button>` : ""}
    <label class="checkline"><input type="checkbox" data-check="neighbours.none" ${n.none ? "checked" : ""} ${dis()}>
      No neighbours to feature</label>
    <div class="grid two" style="margin-top:12px">
      ${select("neighbours.scope", "How wide a view", [
        { v: "adjoining", label: "Adjoining claims only" },
        { v: "district", label: "The district" },
        { v: "belt", label: "The whole belt or trend" }])}
      ${input("neighbours.labels", "Regional features to label", { ph: "Golden Triangle, Kemess mine, Toodoggone fault" })}
    </div>
    ${input("neighbours.exclude", "Neighbours you do NOT want named")}`);
}

function secAudience() {
  const ex = ctx.a.audience?.exports || [];
  return sec("audience", 5, "Audience and disclosure", "", `
    <div class="grid two">
      ${input("audience.audience", "Main audience", { req: true, ph: "Retail investors, institutions, analysts, partners" })}
      ${input("audience.venues", "Where it will be used", { ph: "Website, PDAC booth, 1:1 meetings, social video" })}
      ${input("audience.event", "Event or deadline it is for", { ph: "PDAC 2027, financing, results release" })}
      ${input("audience.tone", "Tone", { ph: "Technical, investor-friendly, or both" })}
      ${input("audience.qp_name", "Qualified Person who will review the deck", { req: true, ph: "Name, P.Geo." })}
      ${input("audience.qp_email", "QP's email", { type: "email" })}
    </div>
    ${area("audience.confidential", "What is confidential or not yet public, and until when", { rows: 2,
      hint: "Nothing listed here will be published until you tell us it has been disclosed." })}
    ${area("audience.disclaimer", "Required disclaimer or cautionary wording", { rows: 2 })}
    <div class="grid two">
      ${input("audience.colours", "Brand colours and fonts", { ph: "Leave blank to take them from your logo" })}
      ${select("audience.narration", "Narration", [
        { v: "auto", label: "Automatic voice" }, { v: "own", label: "Our own voice-over" },
        { v: "none", label: "None" }])}
    </div>
    <div class="field"><label>Exports needed</label>
      <div class="checks">${EXPORTS.map((e) => `<label class="checkline">
        <input type="checkbox" data-multi="audience.exports" value="${esc(e)}" ${ex.includes(e) ? "checked" : ""} ${dis()}>${esc(e)}</label>`).join("")}</div>
    </div>`);
}

function secAccess() {
  const s = ctx.a.access || {};
  const people = s.people || [];
  return sec("access", 6, "People and access",
    `Only the people you list here are given access to this project. Each of them can see all
     of its data and files and edit its decks. Bedrock does not add anyone on your behalf —
     to change this list later, tell us in writing.`,
    `<div class="tablewrap"><table class="itable">
      <thead><tr><th>Full name</th><th>Work email</th><th>Title</th><th></th></tr></thead>
      <tbody>${people.map((p, i) => {
        const badEmail = p.email && !EMAIL_RE.test(p.email.trim());
        return `<tr>
        <td><input type="text" data-list="access.people.${i}.name" value="${esc(p.name || "")}" ${dis()}></td>
        <td><input type="email" class="${badEmail ? "bad" : ""}" data-list="access.people.${i}.email" value="${esc(p.email || "")}" ${dis()}></td>
        <td><input type="text" data-list="access.people.${i}.title" value="${esc(p.title || "")}" ${dis()}></td>
        <td class="n">${open() ? `<button class="btn sm danger" data-rmperson="${i}" aria-label="Remove">Remove</button>` : ""}</td>
      </tr>`;
      }).join("") || `<tr><td colspan="4" class="hint">Nobody listed yet.</td></tr>`}</tbody>
    </table></div>
    ${open() ? `<button class="btn" id="addperson" style="margin-top:12px">Add a person</button>` : ""}
    <div class="grid two" style="margin-top:16px">
      ${input("access.main_contact", "Main contact (name, role, email)", { req: true })}
      ${input("access.tech_contact", "Technical contact for data questions", { ph: "Geologist or GIS lead" })}
      ${input("access.signoff", "Who signs off before anything goes live")}
      ${input("access.transfer", "Anything too large to upload here? How will you send it?", { ph: "SharePoint link to follow" })}
    </div>`);
}

function secTimeline() {
  return sec("timeline", 7, "Timeline", "", `
    <div class="grid two">
      ${input("timeline.draft_date", "Target date for a first draft", { type: "date", req: true })}
      ${input("timeline.live_date", "Target date to go live", { type: "date" })}
    </div>
    ${input("timeline.cadence", "How often new data arrives", { ph: "Assays monthly during the field season" })}`);
}

function secSign(st) {
  const { terms, org, attestations } = ctx;
  const incomplete = Object.entries(st).filter(([, x]) => !x.done);
  const people = (ctx.a.access?.people || []).filter((p) => EMAIL_RE.test((p.email || "").trim()));
  const company = org.name || ctx.a.company?.legal_name || "the company";
  const stmts = (terms?.statements || []).map((s) => s.replaceAll("{company}", company));
  const me = state.session?.user?.email || "";

  if (!open()) {
    const a = attestations[0];
    return sec("sign", 8, "Signed record", "", a ? `
      <dl class="sigrec">
        <dt>Signed by</dt><dd>${esc(a.signer_name)}, ${esc(a.signer_title)} — ${esc(a.signer_email)}</dd>
        <dt>On</dt><dd>${new Date(a.signed_at).toLocaleString()}</dd>
        <dt>For</dt><dd>${esc(a.company_name)} — ${esc(a.project_name)}</dd>
        <dt>Terms</dt><dd>Version ${esc(a.terms_version)}</dd>
        <dt>People given access</dt><dd>${(a.people || []).map((p) => esc(`${p.name || ""} <${p.email}>`)).join("<br>") || "—"}</dd>
        <dt>Files at signing</dt><dd>${(a.files || []).length}</dd>
      </dl>
      <ol class="stmts">${(a.statements || []).map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      ${attestations.length > 1 ? `<p class="hintline">${attestations.length - 1} earlier signature${attestations.length > 2 ? "s" : ""} on record.</p>` : ""}`
      : `<p class="hint">No signature on record.</p>`);
  }

  return sec("sign", 8, "Review and sign",
    `Signing submits the intake to Bedrock and gives access to the
     <b id="signcount">${peopleLabel(people.length)}</b> you listed. After that it is locked;
     to change it, ask Bedrock to reopen it.`,
    `<div id="signready">${readyNote(incomplete)}</div>
    ${!terms ? `<div class="note danger">The signing terms could not be loaded. Reload the page.</div>` : `
    <ol class="stmts">${stmts.map((s, i) => `<li><label class="checkline top">
      <input type="checkbox" data-stmt="${i}"><span>${esc(s)}</span></label></li>`).join("")}</ol>
    <div class="grid two">
      <div class="field"><label for="sname">Your full name</label><input type="text" id="sname" autocomplete="name"></div>
      <div class="field"><label for="stitle">Your title</label><input type="text" id="stitle" placeholder="CEO, VP Exploration…"></div>
    </div>
    <p class="hintline">Signing as <b>${esc(me)}</b>. Typing your name is your signature. We record it with the
       date, the exact wording above, the people listed and the files uploaded.</p>
    <button class="btn primary" id="signit" style="margin-top:12px" ${incomplete.length ? "disabled" : ""}>Sign and submit</button>`}`);
}

const peopleLabel = (n) => `${n} ${n === 1 ? "person" : "people"}`;

function readyNote(incomplete) {
  if (!incomplete.length) return "";
  return `<div class="note warn" style="margin-bottom:14px"><b>Not ready to sign.</b>
    ${incomplete.map(([k, x]) => `<a href="#isec-${k}" data-jump="${k}">${esc(SECTIONS.find((s) => s.key === k).label)}</a>: ${esc(x.note)}`).join(" · ")}
  </div>`;
}

// ------------------------------------------------------------- behaviour ---
function setSaved(msg, bad = false) {
  const el = $("savestate");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("bad", bad);
}

function setPath(path, value) {
  // "focal.points.0.point" → a.focal.points[0].point
  const parts = path.split(".");
  let o = ctx.a;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i], nextIsIdx = /^\d+$/.test(parts[i + 1]);
    if (o[k] == null) o[k] = nextIsIdx ? [] : {};
    o = o[k];
  }
  o[parts.at(-1)] = value;
  return parts[0];
}

function queueSave(section, delay = 700) {
  setSaved("Saving…");
  clearTimeout(timers[section]);
  timers[section] = setTimeout(() => saveSection(section), delay);
}

async function saveSection(section) {
  const { error } = await db.rpc("intake_save", {
    p_intake: ctx.intake.id, p_section: section, p_value: ctx.a[section] ?? {},
  });
  if (error) { setSaved("Not saved", true); return fail("Save", error); }
  setSaved("Saved");
  refreshNav();
}

/** Repaint the progress without rebuilding the form (which would take the
 *  cursor out of whatever field someone is typing in). */
function refreshNav() {
  const view = $("view");
  const st = Object.fromEntries(SECTIONS.filter((s) => s.key !== "sign")
    .map((s) => [s.key, sectionStatus(s.key, ctx.a, ctx.files)]));
  const doneN = Object.values(st).filter((x) => x.done).length;
  const total = Object.keys(st).length;
  const prog = view.querySelector(".iprog");
  if (prog) prog.innerHTML = `<b>${doneN} of ${total}</b> sections complete
    <div class="ibar"><i style="width:${Math.round(doneN / total * 100)}%"></i></div>`;
  for (const [k, x] of Object.entries(st)) {
    const a = view.querySelector(`.inav a[data-jump="${k}"]`);
    if (a) {
      a.classList.toggle("done", x.done);
      a.querySelector(".n").textContent = x.done ? "✓" : SECTIONS.findIndex((s) => s.key === k) + 1;
    }
    const n = view.querySelector(`[data-secnote="${k}"]`);
    if (n) { n.textContent = x.done ? "Complete" : x.note; n.classList.toggle("warn", !!x.warn); }
  }
  const sign = $("signit");
  if (sign) sign.disabled = Object.values(st).some((x) => !x.done);
  // The sign section summarises the rest of the form, so it follows it live.
  const ready = $("signready");
  if (ready) {
    ready.innerHTML = readyNote(Object.entries(st).filter(([, x]) => !x.done));
    ready.querySelectorAll("[data-jump]").forEach((a) => a.onclick = (e) => {
      e.preventDefault();
      $(`isec-${a.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const count = $("signcount");
  if (count) count.textContent = peopleLabel((ctx.a.access?.people || [])
    .filter((p) => EMAIL_RE.test((p.email || "").trim())).length);
}

function bind(view) {
  refreshNav();

  view.querySelectorAll("[data-jump]").forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    $(`isec-${a.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  if (open()) {
    view.querySelectorAll("[data-path]").forEach((el) => {
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
        queueSave(setPath(el.dataset.path, el.value));
      });
    });
    view.querySelectorAll("[data-list]").forEach((el) => {
      el.addEventListener("input", () => {
        queueSave(setPath(el.dataset.list, el.value));
        if (el.type === "email") el.classList.toggle("bad", !!el.value && !EMAIL_RE.test(el.value.trim()));
      });
    });
    view.querySelectorAll("[data-check]").forEach((el) => el.onchange = () => {
      queueSave(setPath(el.dataset.check, el.checked), 0);
    });
    view.querySelectorAll("[data-multi]").forEach((el) => el.onchange = () => {
      const all = [...view.querySelectorAll(`[data-multi="${el.dataset.multi}"]:checked`)].map((x) => x.value);
      queueSave(setPath(el.dataset.multi, all), 0);
    });
    view.querySelectorAll("[data-have]").forEach((el) => el.onchange = () => {
      queueSave(setPath(`data.${el.dataset.have}.have`, el.value), 0);
    });
    view.querySelectorAll("[data-note]").forEach((el) => el.oninput = () => {
      queueSave(setPath(`data.${el.dataset.note}.note`, el.value));
    });

    // Lists that change shape repaint, after saving.
    const relist = async (section, mutate) => {
      mutate();
      clearTimeout(timers[section]);
      await saveSection(section);
      paint(view);
    };
    if ($("addperson")) $("addperson").onclick = () => relist("access", () => {
      ctx.a.access ||= {}; (ctx.a.access.people ||= []).push({ name: "", email: "", title: "" });
    });
    view.querySelectorAll("[data-rmperson]").forEach((b) => b.onclick = () => relist("access", () => {
      ctx.a.access.people.splice(Number(b.dataset.rmperson), 1);
    }));
    if ($("addnrow")) $("addnrow").onclick = () => relist("neighbours", () => {
      ctx.a.neighbours ||= {};
      (ctx.a.neighbours.rows ||= []).push({ id: crypto.randomUUID().slice(0, 8), company: "" });
      ctx.a.neighbours.none = false;
    });
    view.querySelectorAll("[data-rmnrow]").forEach((b) => b.onclick = () => relist("neighbours", () => {
      ctx.a.neighbours.rows.splice(Number(b.dataset.rmnrow), 1);
    }));

    // Uploads: the button, and dropping onto the row.
    view.querySelectorAll("[data-upload]").forEach((inp) => inp.onchange = () => {
      uploadFiles(view, inp.dataset.upload, [...inp.files]);
    });
    view.querySelectorAll("[data-logo]").forEach((inp) => inp.onchange = () => {
      uploadFiles(view, "neighbour_logo", [...inp.files], { row: inp.dataset.logo });
    });
    view.querySelectorAll(".drow").forEach((row) => {
      ["dragenter", "dragover"].forEach((t) => row.addEventListener(t, (e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault(); row.classList.add("dropping");
      }));
      ["dragleave", "drop"].forEach((t) => row.addEventListener(t, (e) => {
        e.preventDefault(); row.classList.remove("dropping");
      }));
      row.addEventListener("drop", (e) => {
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) uploadFiles(view, row.dataset.slot, files);
      });
    });

    if ($("signit")) $("signit").onclick = () => sign(view);
  }

  view.querySelectorAll("[data-rmfile]").forEach((b) => b.onclick = () => removeFile(view, b.dataset.rmfile));
  view.querySelectorAll("[data-dl]").forEach((b) => b.onclick = () => download(b.dataset.dl));

  // Our side.
  if ($("ireopen")) $("ireopen").onclick = () => setStatus(view, "open");
  if ($("iaccept")) $("iaccept").onclick = () => setStatus(view, "accepted");
  if ($("iapply")) $("iapply").onclick = () => applyToProject();
}

// ----------------------------------------------------------------- files ---
const safeName = (n) => n.normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(-120) || "file";

async function uploadFiles(view, slot, list, meta = {}) {
  if (!list.length) return;
  const prog = view.querySelector(`[data-prog="${slot}"]`);
  const show = (t) => { if (prog) { prog.hidden = !t; prog.textContent = t || ""; } else if (t) setSaved(t); };
  const row = DATA_ROWS.find((r) => r.key === slot);
  let ok = 0;
  for (const [i, file] of list.entries()) {
    const id = crypto.randomUUID();
    const path = `${ctx.project.org_id}/${ctx.project.id}/${id}/${safeName(file.name)}`;
    // What we can say about it now, while the person who exported it is here.
    let format = null, readable = null, advice = null;
    if (/\.(zip|7z|rar)$/i.test(file.name)) { format = "archive"; }
    else if (row?.spatial) {
      const s = sniff(file);
      format = s.readable ? s.format : (s.label || s.format);
      readable = s.readable;
      advice = s.readable ? null : s.advice;
    } else {
      format = (file.name.split(".").pop() || "").toLowerCase().slice(0, 12) || null;
    }
    try {
      const tag = list.length > 1 ? ` (${i + 1} of ${list.length})` : "";
      await putObject(path, file, (f) => show(`Uploading ${file.name}${tag} — ${Math.round(f * 100)}%`));
      const { data, error } = await db.from("intake_files").insert({
        intake_id: ctx.intake.id, slot, filename: file.name.slice(0, 255), storage_path: path,
        bytes: file.size, content_type: file.type || null, format, readable,
        meta: { ...meta, ...(advice ? { advice } : {}) },
        uploaded_by: state.session.user.id,
      }).select("*").single();
      if (error) {
        // The object is orphaned without its row; take it back.
        await db.storage.from("intake").remove([path]);
        throw error;
      }
      ctx.files.push(data);
      ok++;
      if (readable === false) toast(`${file.name}: we can't read this format. ${advice || ""}`, true);
    } catch (e) {
      show("");
      fail(`Upload ${file.name}`, e);
    }
  }
  show("");
  if (ok) {
    // Uploading is an answer: if they have not said whether they have it, they do.
    if (DATA_ROWS.some((r) => r.key === slot) && !ctx.a.data?.[slot]?.have) {
      setPath(`data.${slot}.have`, "yes");
      await saveSection("data");
    }
    toast(ok === 1 ? "File uploaded" : `${ok} files uploaded`);
  }
  paint(view);
}

const CHUNK = 6 * 1024 * 1024;   // Supabase's resumable endpoint requires exactly 6 MB parts.

/** Small files in one request; anything larger over the resumable (TUS)
 *  endpoint, so a 2 GB block model survives a dropped connection and is not
 *  held to the standard upload's size cap. */
async function putObject(path, file, onProgress) {
  if (file.size <= CHUNK) {
    const { error } = await withTimeout(
      db.storage.from("intake").upload(path, file, {
        contentType: file.type || "application/octet-stream", upsert: false }),
      120000);
    if (error) throw error;
    onProgress(1);
    return;
  }
  const base = `${CONFIG.url.replace(/\/$/, "")}/storage/v1/upload/resumable`;
  const auth = async () => {
    const { data } = await db.auth.getSession();
    return { Authorization: `Bearer ${data.session?.access_token}`, apikey: CONFIG.anonKey,
             "Tus-Resumable": "1.0.0" };
  };
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const meta = [["bucketName", "intake"], ["objectName", path],
                ["contentType", file.type || "application/octet-stream"], ["cacheControl", "3600"]]
    .map(([k, v]) => `${k} ${b64(v)}`).join(",");
  const created = await withTimeout(fetch(base, { method: "POST", headers: {
    ...(await auth()), "Upload-Length": String(file.size), "Upload-Metadata": meta, "x-upsert": "false",
  } }), 60000);
  if (created.status !== 201) throw new Error(`upload refused (${created.status}): ${(await created.text()).slice(0, 200)}`);
  const loc = new URL(created.headers.get("Location"), base).toString();

  let off = 0, tries = 0;
  while (off < file.size) {
    try {
      const r = await withTimeout(fetch(loc, { method: "PATCH", headers: {
        ...(await auth()), "Upload-Offset": String(off), "Content-Type": "application/offset+octet-stream",
      }, body: file.slice(off, off + CHUNK) }), 180000);
      if (r.status !== 204) throw new Error(`part refused (${r.status}): ${(await r.text()).slice(0, 200)}`);
      off = Number(r.headers.get("Upload-Offset")) || Math.min(off + CHUNK, file.size);
      tries = 0;
      onProgress(off / file.size);
    } catch (e) {
      // Ask the server where it got to, and carry on from there.
      if (++tries > 4) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** tries));
      const h = await fetch(loc, { method: "HEAD", headers: await auth() }).catch(() => null);
      const at = Number(h?.headers.get("Upload-Offset"));
      if (Number.isFinite(at) && at >= 0) off = at;
    }
  }
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() =>
    rej(new Error("the storage service did not respond in time")), ms))]);
}

async function removeFile(view, id) {
  const f = ctx.files.find((x) => x.id === id);
  if (!f || !confirm(`Remove ${f.filename}?`)) return;
  const { error } = await db.from("intake_files").delete().eq("id", id);
  if (error) return fail("Remove file", error);
  await db.storage.from("intake").remove([f.storage_path]);
  ctx.files = ctx.files.filter((x) => x.id !== id);
  toast("File removed");
  paint(view);
}

async function download(id) {
  const f = ctx.files.find((x) => x.id === id);
  if (!f) return;
  const { data, error } = await db.storage.from("intake")
    .createSignedUrl(f.storage_path, 300, { download: f.filename });
  if (error) return fail("Download", error);
  location.assign(data.signedUrl);
}

// ------------------------------------------------------------------ sign ---
async function sign(view) {
  const boxes = [...view.querySelectorAll("[data-stmt]")];
  const accepted = boxes.filter((b) => b.checked).length;
  if (accepted !== boxes.length) return toast("Tick every statement to sign.", true);
  const name = $("sname").value.trim(), title = $("stitle").value.trim();
  if (name.length < 2 || title.length < 2) return toast("Type your full name and title.", true);
  const people = (ctx.a.access?.people || []).filter((p) => (p.email || "").trim());
  const bad = people.filter((p) => !EMAIL_RE.test(p.email.trim()));
  if (bad.length) return toast(`Fix the email address for ${bad[0].name || bad[0].email}.`, true);
  if (!confirm(`Sign and submit as ${name}, ${title}?\n\n${people.length} ${people.length === 1 ? "person" : "people"} will be given access to this project.`)) return;

  // Anything still waiting on the debounce goes first, so what is signed is
  // what is on screen.
  for (const s of Object.keys(timers)) { clearTimeout(timers[s]); await saveSection(s); }

  const btn = $("signit");
  btn.disabled = true; btn.textContent = "Signing…";
  const { data, error } = await db.rpc("submit_intake", {
    p_intake: ctx.intake.id, p_signer_name: name, p_signer_title: title,
    p_terms_version: ctx.terms.version, p_accepted: accepted,
    p_user_agent: navigator.userAgent,
  });
  if (error) {
    btn.disabled = false; btn.textContent = "Sign and submit";
    return fail("Sign", error);
  }
  const n = data?.invited || 0;
  toast(`Submitted. ${n ? `${n} ${n === 1 ? "invitation" : "invitations"} created.` : ""}`);
  await renderIntake(ctx.project.id, view);
}

// ------------------------------------------------------------- our side ---
async function setStatus(view, status) {
  const msg = status === "open"
    ? "Reopen this intake? The client can edit it again and will need to sign again."
    : "Mark this intake accepted?";
  if (!confirm(msg)) return;
  const patch = { status };
  if (status === "accepted") Object.assign(patch, { accepted_at: new Date().toISOString(), accepted_by: state.session.user.id });
  const { error } = await db.from("intakes").update(patch).eq("id", ctx.intake.id);
  if (error) return fail("Update intake", error);
  toast(status === "open" ? "Reopened" : "Accepted");
  await renderIntake(ctx.project.id, view);
}

/** Copy what the project settings can hold. Never the coordinate system on
 *  its own say-so: changing it moves data that is already loaded, so it is
 *  only filled in when a number can be read AND the project has no data yet. */
async function applyToProject() {
  const c = ctx.a.company || {};
  const patch = {};
  if (c.commodity) patch.commodity = c.commodity.trim();
  if (c.location) patch.location = c.location.trim();
  if (STAGES.some((s) => s.key === c.stage)) patch.stage = c.stage;
  const epsg = Number((String(c.crs || "").match(/\b(\d{4,5})\b/) || [])[1]);
  const { count } = await db.from("datasets").select("id", { count: "exact", head: true })
    .eq("project_id", ctx.project.id);
  if (epsg && epsg !== ctx.project.epsg && !count) patch.epsg = epsg;
  if (c.description) patch.brand = { ...(ctx.project.brand || {}), summary: c.description.trim() };
  if (!Object.keys(patch).length) return toast("Nothing to copy.");
  const list = Object.keys(patch).map((k) => k === "brand" ? "description" : k).join(", ");
  if (!confirm(`Copy ${list} into the project settings?`)) return;
  const { error } = await db.from("projects").update(patch).eq("id", ctx.project.id);
  if (error) return fail("Copy to project", error);
  toast(`Project updated: ${list}`);
  if (epsg && epsg !== ctx.project.epsg && count) {
    toast(`Coordinate system left at EPSG ${ctx.project.epsg} — data is already loaded. Change it in Project settings if it is wrong.`, true);
  }
}

// ----------------------------------------------- the project page's card ---
/** A one-line summary for the project page and the projects list. */
export async function intakeSummary(projectIds) {
  if (!projectIds.length) return {};
  const { data, error } = await db.from("intakes").select("project_id, status, submitted_at")
    .in("project_id", projectIds);
  if (error) return {};
  return Object.fromEntries((data || []).map((r) => [r.project_id, r]));
}
