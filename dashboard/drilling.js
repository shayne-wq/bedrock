// Bedrock console — drilling programmes and the progress reported against them.
//
// Everything else this console collects is a FILE: a block model, a survey, a
// boundary, uploaded once and then finished. A drilling programme is the one
// thing an issuer comes back to. The rig turns, the metres climb, and the
// number that matters is whatever it was this morning — so the whole shape of
// this screen is different from the ingest slots beside it. There is nothing to
// upload. There is a plan, typed once, and then a short form that gets used
// once a week for three months.
//
// Which makes the ergonomics of that short form the whole feature. Two things
// in it earn their complexity:
//
// METRES TO DATE, NOT METRES SINCE. The field is cumulative, and the form says
// so, computes the delta, and refuses quietly to let a smaller total past
// without pointing at it. "We're at 4,000 metres today" is ambiguous in
// English and unambiguous here; getting that wrong by one report poisons every
// figure after it.
//
// POSTING IS A SEPARATE ACT FROM WRITING. These numbers go to the
// shareholders of a public company. A draft is saved and visible to nobody; a
// post is dated and goes out. Both buttons are on the form because both are
// real: a geologist prepares a number and whoever signs off on disclosure
// presses the other one.

import {
  db, state, $, esc, fmtInt, toast, fail, modal, closeModal,
} from "./lib/ui.js";

const STATUS = {
  planned: "Planned", active: "Drilling", paused: "Paused", complete: "Complete",
};
const CHIP = {
  planned: "draft", active: "live", paused: "warn", complete: "draft",
};

const num = (v) => (v === null || v === undefined || v === "" || !isFinite(+v)) ? null : +v;
const metres = (m) => Math.round(m).toLocaleString() + " m";
// A plain `YYYY-MM-DD` parsed without a zone lands on local or UTC midnight
// depending on the engine, which moves a report a day either side of the date
// the issuer typed. Pinned at both ends.
const onDate = (s) => {
  if (!s) return "—";
  const d = new Date(String(s).slice(0, 10) + "T00:00:00Z");
  return isNaN(+d) ? String(s)
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const today = () => new Date().toISOString().slice(0, 10);

/** The newest report carrying a metre count. A report can legitimately be words
 *  only — "rig mobilised, first hole collared" — and reading the total off
 *  whatever happens to be newest would blank out yesterday's figure. */
const lastMetres = (ups) => (ups || []).find((u) => num(u.metres_total) !== null) || null;

// ------------------------------------------------- figures from the file ----
// A drilling programme used to be the one screen in this console with nothing
// to upload, and that was a false distinction. The collar file the issuer
// already loads carries the metres: `readCollars` splits drilled holes from
// proposed ones and the ingest records `holes`, `metres` and the newest
// finished collar on the dataset row. Retyping those into a form is retyping a
// number that is already on the server, and the one thing a retyped number can
// do that a read one cannot is disagree with its own source.
//
// So: the upload fills in the report, and the issuer posts it. The split is
// deliberate and it is the same split the schema makes. Reading a figure off a
// file is arithmetic; telling shareholders of a public company what it is, is
// disclosure. One of those can be automatic.

/** The drills dataset whose figures belong to this programme — its own zone
 *  first, then the project-level upload, which is where an unzoned project puts
 *  everything. */
export function drillFile(datasets, zoneId) {
  const zid = zoneId || null;
  const ds = (datasets || []).filter((d) => d.kind === "drills");
  const d = ds.find((x) => (x.zone_id || null) === zid)
         || ds.find((x) => !x.zone_id)
         || (ds.length === 1 ? ds[0] : null);
  // Zero is not a figure to offer. A collar file can legitimately hold nothing
  // but proposed holes — a programme announced before the rig arrives — and
  // "0 holes, 0 m" posted against it reads as a failed parse.
  if (!d || !(num(d.stats?.metres) > 0)) return null;
  return d;
}

/** Write the file's figures against a programme: a DRAFT progress report, and
 *  the rig moved to the newest finished collar where that can be answered
 *  honestly. Returns what it did so the caller can say so precisely.
 *
 *  Never publishes. `published_at` stays null and the deck never selects a
 *  draft, so no figure reaches a shareholder because somebody dropped a file. */
async function applyFigures(g, stats, prevHoleIds, ups) {
  const s = stats || {};
  const metres = num(s.metres), holes = num(s.holes);
  if (metres === null) return { nothing: true };

  // Against the newest report carrying a figure, published or not: a weekly
  // full re-export is the expected workflow and most weeks the second upload
  // of the same file should leave no trace at all.
  const prev = lastMetres(ups);
  const prevM = prev ? num(prev.metres_total) : null;
  const same = prevM !== null && Math.round(prevM) === Math.round(metres)
            && num(prev.holes_done) === holes;

  const asOf = today();
  const out = { metres, holes, lower: prevM !== null && metres < prevM ? prevM : null,
                unchanged: same, moved: null, latest: s.latest || null };

  if (!same) {
    const row = {
      metres_total: metres,
      holes_done: holes === null ? null : Math.round(holes),
      // A restatement of the two figures, which is what an issuer writes here
      // anyway, and nothing editorial: this text goes out under their name.
      // Proposed holes are deliberately absent — "17 planned" in a progress
      // report reads as progress.
      body: `${fmtInt(Math.round(holes || 0))} hole${holes === 1 ? "" : "s"}, ` +
            `${fmtInt(Math.round(metres))} m to date.`,
    };
    // Reuse today's DRAFT if there is one — uploading twice in a morning is
    // normal and should not leave two reports for the same date. A report
    // already POSTED for today is left alone and a draft is filed beside it:
    // withdrawing somebody's published figure is their decision, not a
    // side-effect of a file landing.
    const { data: ex } = await db.from("drill_updates")
      .select("id").eq("program_id", g.id).eq("as_of", asOf)
      .is("published_at", null).limit(1);
    const q = ex?.length
      ? db.from("drill_updates").update(row).eq("id", ex[0].id)
      : db.from("drill_updates").insert({
          ...row, program_id: g.id, as_of: asOf,
          created_by: state.session?.user?.id || null,
        });
    const { error } = await q;
    if (error) { fail("Fill in the report", error); return { failed: true }; }
  }

  // The rig. Moved when the programme has no position at all, or when the
  // newest finished hole is one that was not in the previous upload — that is
  // the rig having moved. If the newest finished hole is the same one as last
  // time, the rig has not finished anything since and its pin is left alone.
  //
  // Not moved at all when the total went BACKWARDS. A file that reports fewer
  // metres than the last one is a partial export, and the newest finished hole
  // in a partial export is the newest hole IN THAT SLICE — moving a rig onto it
  // puts the marker on whichever zone happened to be exported.
  const L = out.lower ? null : s.latest;
  if (L && Number.isFinite(+L.easting) && Number.isFinite(+L.northing)) {
    const unplaced = g.easting === null || g.easting === undefined;
    const isNew = !Array.isArray(prevHoleIds) || !prevHoleIds.includes(L.id);
    if (unplaced || isNew) {
      const patch = { easting: +L.easting, northing: +L.northing };
      if (Number.isFinite(+L.elev_m)) patch.elev_m = +L.elev_m;
      const { error } = await db.from("drill_programs").update(patch).eq("id", g.id);
      if (error) fail("Move the rig", error);
      else out.moved = L;
    }
  }
  return out;
}

/** What applyFigures did, in one sentence the issuer can act on. */
function sayFigures(r) {
  if (!r || r.nothing || r.failed) return;
  if (r.lower) {
    // The one failure mode that matters. metres_total is cumulative, so a
    // total BELOW the last one means a partial export, not progress — and
    // posting it would read as the programme going backwards.
    toast(`${fmtInt(Math.round(r.metres))} m is LOWER than the ` +
          `${fmtInt(Math.round(r.lower))} m already reported. Saved as a draft, ` +
          `not posted — check the file is the whole dataset and not one zone.`, true);
    return;
  }
  const bits = [];
  if (r.unchanged) bits.push("the figures are unchanged");
  else bits.push(`${fmtInt(Math.round(r.metres))} m in ` +
                 `${fmtInt(Math.round(r.holes || 0))} holes — a draft report is ready to post`);
  if (r.moved) bits.push(`rig moved to ${r.moved.id}`);
  toast(`Drilling: ${bits.join(", ")}.`);
}


/** Mount the drilling panel into `el` and keep re-rendering it in place.
 *  Deliberately NOT via route(): a page reload to show a posted update loses
 *  the scroll position, re-fetches every dataset, and importing route() from
 *  here would close an import cycle through app.js. */
export async function renderDrilling(project, zones, datasets, el) {
  if (!el) return;
  const editor = (state.roles?.[project.org_id] || "") !== "client";

  const { data: progs, error } = await db.from("drill_programs")
    .select("*").eq("project_id", project.id).order("created_at");
  if (error) {
    // The usual cause is a console deployed ahead of its migration. That is a
    // missing feature, not a broken project page, so the panel removes itself
    // rather than printing a Postgres error over someone's drilling.
    console.warn("Bedrock: drilling programmes unavailable", error);
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const ids = (progs || []).map((g) => g.id);
  let ups = [];
  if (ids.length) {
    const { data, error: ue } = await db.from("drill_updates")
      .select("*").in("program_id", ids).order("as_of", { ascending: false });
    if (ue) fail("Drilling reports", ue);
    ups = data || [];
  }
  const upsOf = (id) => ups.filter((u) => u.program_id === id);
  const zoneName = (id) => (zones || []).find((z) => z.id === id)?.name || null;

  // What the uploaded collar file says, beside what has been reported. Shown
  // whether or not they agree, because "they agree" is the useful half of the
  // time: it is the line that tells a geologist the deck is carrying the same
  // number as the file on their desk.
  const fileStrip = (g, u) => {
    const d = drillFile(datasets, g.zone_id);
    if (!d) return "";
    const st = d.stats || {};
    const m = num(st.metres), h = num(st.holes);
    const head = lastMetres(u);
    const cur = head ? num(head.metres_total) : null;
    const agrees = cur !== null && Math.round(cur) === Math.round(m);
    const bits = [`${fmtInt(Math.round(h || 0))} hole${h === 1 ? "" : "s"}`,
                  `${fmtInt(Math.round(m))} m`];
    const pl = num(st.planned_holes);
    if (pl) bits.push(`${fmtInt(pl)} proposed hole${pl === 1 ? "" : "s"} not counted`);
    if (st.latest?.id) {
      bits.push(`newest finished ${esc(st.latest.id)}` +
                (st.latest.on ? ` on ${onDate(st.latest.on)}` : ""));
    }
    return `<div class="row" style="margin:-4px 0 12px;gap:10px;align-items:baseline">
      <p class="hintline grow" style="margin:0">From your collar file${
        d.provenance?.uploaded_at ? `, uploaded ${onDate(d.provenance.uploaded_at)}` : ""
      }: ${bits.join(" &middot; ")}.${agrees
        ? " The latest report matches it."
        : " Using them files a draft."}</p>
      ${agrees ? "" : `<button class="btn sm" data-dpfile="${g.id}">Use these figures</button>`}
    </div>`;
  };

  el.innerHTML = `
    <div class="row">
      <div class="grow"><h2>Drilling</h2></div>
      <button class="btn" id="dpnew">${(progs || []).length ? "Add a programme" : "Add a drilling programme"}</button>
    </div>
    <p class="lead" style="margin:0 0 14px">The part of a deck that is still
       happening. Post the metres as they are drilled and every share link,
       every embed and the deck on your own website shows today's figure —
       without rebuilding anything. Shareholders see what you publish here and
       nothing else.</p>
    ${!(progs || []).length ? `
      <div class="empty sm">
        <h3>No programme on file</h3>
        <p>Add the plan once — metres, holes, dates, where the rig stands — then
           report progress against it as the programme runs. ${
          drillFile(datasets, null)
            ? "Your collar file already carries the holes and the metres, so most of it is filled in for you."
            : ""}</p>
        <button class="btn primary" id="dpnew2">${drillFile(datasets, null)
          ? "Start from your drill file" : "Add a drilling programme"}</button>
      </div>` : (progs || []).map((g) => {
        const u = upsOf(g.id);
        const pub = u.filter((x) => x.published_at);
        const head = lastMetres(pub);
        const m = head ? num(head.metres_total) : null;
        const t = num(g.target_m);
        const pct = (m !== null && t) ? Math.max(0, Math.min(1, m / t)) : null;
        const zn = zoneName(g.zone_id);
        return `<div class="zone" data-dp="${g.id}">
          <div class="row">
            <div class="grow">
              <b>${esc(g.name)}</b>
              <span class="chip ${CHIP[g.status] || "draft"}">${esc(STATUS[g.status] || g.status)}</span>
              <span class="zsub">${[
                m === null ? "no metres reported" : metres(m) + (t ? " of " + metres(t) : " to date"),
                zn ? esc(zn) : "whole project",
                g.easting === null || g.easting === undefined
                  ? "no rig position" : "rig placed",
              ].join(" · ")}</span>
            </div>
            <button class="btn sm primary" data-dppost="${g.id}">Post an update</button>
            <button class="btn sm" data-dpedit="${g.id}">Edit plan</button>
            ${editor ? `<button class="btn sm danger" data-dpdel="${g.id}">Delete</button>` : ""}
          </div>
          ${pct === null ? "" : `<div class="bar" style="margin:-4px 0 12px">
            <i style="width:${(pct * 100).toFixed(1)}%"></i></div>`}
          ${fileStrip(g, u)}
          ${(g.easting === null || g.easting === undefined) ? `
            <p class="hintline" style="margin:-4px 0 12px">No collar coordinates,
               so the deck draws no rig on the ground — the figures still show.
               Add an easting and northing in <b>Edit plan</b> and the rig
               appears where it stands.</p>` : ""}
          ${!u.length ? `<p class="hintline" style="margin:0">Nothing reported yet.</p>`
            : `<div class="tablewrap"><table>
              <thead><tr><th>As of</th><th class="n">Metres</th><th class="n">Since</th>
                <th>Report</th><th>Status</th><th></th></tr></thead>
              <tbody>${u.map((x, i) => {
                const cur = num(x.metres_total);
                // Delta against the previous report with a figure in it,
                // computed rather than typed: it is the one way it cannot
                // disagree with the totals it is derived from.
                let prev = null;
                for (let j = i + 1; j < u.length; j++) {
                  const p = num(u[j].metres_total);
                  if (p !== null) { prev = p; break; }
                }
                const d = (cur !== null && prev !== null) ? cur - prev : null;
                return `<tr>
                  <td class="mono">${onDate(x.as_of)}</td>
                  <td class="n mono">${cur === null ? "—" : fmtInt(Math.round(cur))}</td>
                  <td class="n mono">${d === null ? "—" : (d >= 0 ? "+" : "") + fmtInt(Math.round(d))}</td>
                  <td>${esc(x.body || "")}${x.author ? `<span class="sub"> — ${esc(x.author)}</span>` : ""}</td>
                  <td><span class="chip ${x.published_at ? "live" : "draft"}">${
                    x.published_at ? "Posted" : "Draft"}</span></td>
                  <td class="n">
                    <button class="btn sm" data-dppub="${x.id}" data-on="${x.published_at ? "1" : "0"}">${
                      x.published_at ? "Withdraw" : "Post"}</button>
                    <button class="btn sm danger" data-dpudel="${x.id}">Delete</button>
                  </td></tr>`;
              }).join("")}</tbody></table></div>`}
        </div>`;
      }).join("")}`;

  const again = () => renderDrilling(project, zones, datasets, el);
  const add = () => programModal(project, zones, datasets, null, again);
  if ($("dpnew")) $("dpnew").onclick = add;
  // The empty state offers the file when there is one: a new programme on a
  // project that has already uploaded collars should open with the position and
  // the figures in it, leaving the issuer only the thing no file can know —
  // how many metres they committed to.
  if ($("dpnew2")) {
    const d = drillFile(datasets, null);
    $("dpnew2").onclick = d
      ? () => programModal(project, zones, datasets, null,
          () => syncFromUpload(project, zones, datasets,
            { kind: "drills", zone_id: d.zone_id || null, stats: d.stats }, again),
          { zone_id: d.zone_id || null, stats: d.stats })
      : add;
  }

  el.querySelectorAll("[data-dpfile]").forEach((b) => {
    b.onclick = async () => {
      const g = (progs || []).find((x) => x.id === b.dataset.dpfile);
      const d = drillFile(datasets, g.zone_id);
      if (!g || !d) return;
      b.disabled = true;
      // No previous hole ids on a deliberate click: the issuer is asking for
      // this file's figures and this file's rig position, not for a diff.
      const r = await applyFigures(g, d.stats, null, upsOf(g.id));
      sayFigures(r);
      again();
    };
  });

  el.querySelectorAll("[data-dpedit]").forEach((b) => {
    b.onclick = () => programModal(project, zones, datasets,
      (progs || []).find((g) => g.id === b.dataset.dpedit), again);
  });
  el.querySelectorAll("[data-dppost]").forEach((b) => {
    const g = (progs || []).find((x) => x.id === b.dataset.dppost);
    b.onclick = () => updateModal(g, upsOf(g.id), again);
  });
  el.querySelectorAll("[data-dpdel]").forEach((b) => {
    b.onclick = async () => {
      const g = (progs || []).find((x) => x.id === b.dataset.dpdel);
      const n = upsOf(g.id).length;
      if (!confirm(`Delete "${g.name}"?` + (n
        ? `\n\nThis also deletes ${n} progress report${n === 1 ? "" : "s"} filed against it. It cannot be undone.`
        : ""))) return;
      const { error: de } = await db.from("drill_programs").delete().eq("id", g.id);
      if (de) return fail("Delete programme", de);
      toast("Programme deleted");
      again();
    };
  });
  el.querySelectorAll("[data-dppub]").forEach((b) => {
    b.onclick = async () => {
      const on = b.dataset.on === "1";
      // Withdrawing is honest about what it does and does not do: it stops the
      // deck serving the report from now on. Anyone who already read it has
      // read it, and saying otherwise would be the one thing worse than the
      // wrong number.
      if (on && !confirm("Withdraw this report?\n\nIt stops appearing in every deck immediately. People who have already seen it have already seen it.")) return;
      const { error: pe } = await db.from("drill_updates")
        .update({ published_at: on ? null : new Date().toISOString() })
        .eq("id", b.dataset.dppub);
      if (pe) return fail(on ? "Withdraw" : "Post", pe);
      toast(on ? "Withdrawn — the deck no longer shows it" : "Posted — every deck shows it now");
      again();
    };
  });
  el.querySelectorAll("[data-dpudel]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this report?")) return;
      const { error: xe } = await db.from("drill_updates").delete().eq("id", b.dataset.dpudel);
      if (xe) return fail("Delete report", xe);
      toast("Report deleted");
      again();
    };
  });
}

/**
 * A drills upload just landed. Fill in the progress report from it.
 *
 * Called by every path that can put a collar file on the server — the routed
 * drop on a zone card, the drop on the Drilling slot, and the slot's own modal
 * — with whatever `putAux` returned. Does nothing for any other dataset kind,
 * so callers can hand it every upload without checking first.
 *
 * `result.prev_hole_ids` is the hole list from the upload this one replaced,
 * and it is the whole reason the rig can move on a file with no dates: a
 * newest-finished hole that was not there last week is the rig having moved.
 */
export async function syncFromUpload(project, zones, datasets, result, onDone) {
  if (!result || result.kind !== "drills") { onDone?.(); return; }
  const stats = result.stats || {};
  if (!(num(stats.metres) > 0)) {
    // A file of nothing but proposed holes is a real thing to upload — the
    // collars are planned before the rig arrives — and it has no metres to
    // report. Say that, rather than filing a report of zero or saying nothing
    // and leaving the geologist wondering whether the parse failed.
    const pl = num(stats.planned_holes);
    if (pl) {
      toast(`${fmtInt(pl)} proposed hole${pl === 1 ? "" : "s"} loaded and nothing ` +
            `drilled yet, so there are no metres to report.`);
    }
    onDone?.();
    return;
  }

  const { data: progs, error } = await db.from("drill_programs")
    .select("*").eq("project_id", project.id).order("created_at");
  if (error) {
    // Same reasoning as renderDrilling: a console ahead of its migration is a
    // missing feature, not a failed upload. The file is already saved.
    console.warn("Bedrock: drilling programmes unavailable", error);
    onDone?.();
    return;
  }

  const zid = result.zone_id || null;
  // Which programme these metres belong to. Its own zone first; then a
  // project-level programme, which is what an unzoned project has; then, only
  // when there is exactly one programme on the whole project, that one — a
  // company with one campaign and one zone should not have to have filed the
  // two against each other for the figures to land.
  const g = (progs || []).find((x) => (x.zone_id || null) === zid)
         || (progs || []).find((x) => !x.zone_id)
         || ((progs || []).length === 1 ? progs[0] : null);

  if (!g) {
    // No programme to report against. The figures are not thrown away and a
    // programme is not invented either: the form opens with everything the
    // file knows already in it, leaving the one field no file can answer —
    // the metres that were committed to. Saving it comes straight back here,
    // which then finds the programme and files the report.
    toast("Drill file loaded. Name the programme and the figures go in.");
    programModal(project, zones, datasets, null,
      () => syncFromUpload(project, zones, datasets, result, onDone),
      { zone_id: zid, stats });
    return;
  }

  const { data: ups } = await db.from("drill_updates")
    .select("*").eq("program_id", g.id).order("as_of", { ascending: false });
  const r = await applyFigures(g, stats, result.prev_hole_ids, ups || []);
  sayFigures(r);
  onDone?.();
}

// ----------------------------------------------------------- the plan ------
function programModal(project, zones, datasets, g, done, prefill = null) {
  const isNew = !g;
  const pf = (isNew && prefill) || null;
  const ps = pf?.stats || {};
  // Seeded from the collar file, never invented. The name takes the year off
  // the newest finished hole because that is what these programmes are called;
  // the position is the newest finished collar; and `target_m` is left EMPTY on
  // purpose — nothing in a data file records what a company committed to, and
  // a target guessed from metres already drilled would read as 100% complete
  // on the day it was created.
  const v = g || (pf ? {
    name: (ps.latest?.on ? ps.latest.on.slice(0, 4) + " " : "") + "drilling programme",
    zone_id: pf.zone_id || null,
    status: "active",
    easting: Number.isFinite(+ps.latest?.easting) ? +ps.latest.easting : null,
    northing: Number.isFinite(+ps.latest?.northing) ? +ps.latest.northing : null,
  } : {});
  const zs = zones || [];
  modal(`
    <h2>${isNew ? "Add a drilling programme" : "Edit the plan"}</h2>
    <p class="sub">What was committed to. Everything except the name is
       optional — a programme is often announced before the metres are budgeted,
       and a metre count with no target is still a metre count.</p>
    ${pf ? `<p class="hintline" style="margin:-6px 0 14px">Filled in from your
       collar file: ${fmtInt(Math.round(num(ps.metres) || 0))} m in
       ${fmtInt(Math.round(num(ps.holes) || 0))} holes${ps.latest?.id
         ? `, rig at ${esc(ps.latest.id)}` : ""}. Add <b>metres planned</b> and
       the progress bar has a denominator; the metres drilled are read from the
       file and filed as a draft report when you save.</p>` : ""}
    <div class="field"><label for="dpname">Programme</label>
      <input type="text" id="dpname" placeholder="2026 Phase 2 diamond drilling"
             value="${esc(v.name || "")}"></div>
    <div class="grid two">
      <div class="field"><label for="dpzone">Covers</label>
        <select id="dpzone">
          <option value="">The whole project</option>
          ${zs.map((z) => `<option value="${z.id}"${
            v.zone_id === z.id ? " selected" : ""}>${esc(z.name)}</option>`).join("")}
        </select></div>
      <div class="field"><label for="dpstatus">Status</label>
        <select id="dpstatus">${Object.keys(STATUS).map((k) => `
          <option value="${k}"${(v.status || "active") === k ? " selected" : ""}>${STATUS[k]}</option>`).join("")}
        </select></div>
      <div class="field"><label for="dptarget">Metres planned</label>
        <input type="number" id="dptarget" min="1" step="1" placeholder="10000"
               value="${v.target_m ?? ""}"></div>
      <div class="field"><label for="dpholes">Holes planned</label>
        <input type="number" id="dpholes" min="1" step="1" placeholder="24"
               value="${v.holes_planned ?? ""}"></div>
      <div class="field"><label for="dpstart">Started</label>
        <input type="date" id="dpstart" value="${esc(v.started_on || "")}"></div>
      <div class="field"><label for="dpend">Expected to finish</label>
        <input type="date" id="dpend" value="${esc(v.expected_end || "")}"></div>
    </div>
    <div class="field"><label for="dpop">Drilling contractor</label>
      <input type="text" id="dpop" placeholder="Optional — named on the deck if you fill it in"
             value="${esc(v.operator || "")}"></div>
    <div class="field"><label for="dpnote">What it is testing</label>
      <textarea id="dpnote" rows="2" placeholder="One line. Shown under the programme name in the deck.">${esc(v.note || "")}</textarea></div>

    <div class="field">
      <label>Where the rig stands</label>
      <div class="grid two">
        <input type="number" id="dpe" step="0.1" placeholder="Easting"
               value="${v.easting ?? ""}">
        <input type="number" id="dpn" step="0.1" placeholder="Northing"
               value="${v.northing ?? ""}">
      </div>
      <p class="hintline">In this project's own grid — EPSG ${project.epsg}, the
         same coordinates as your collar sheet. Leave both blank and the deck
         shows the figures with no rig on the ground; it will not invent a
         location.</p>
      <div class="row-actions" style="margin-top:8px">
        <button class="btn sm" id="dpmid">Use the centre of the drilling</button>
        <span class="hint" id="dpmidnote"></span>
      </div>
    </div>

    <div class="row-actions" style="margin-top:4px">
      <button class="btn primary" id="dpsave">${isNew ? "Add programme" : "Save plan"}</button>
      <button class="btn" id="dpcancel">Cancel</button>
    </div>`);
  $("dpcancel").onclick = closeModal;

  // The collar sheet is already uploaded, so the commonest position for a rig
  // is "in the middle of the holes" and nobody should have to go and average
  // it by hand. The drills artifact holds the collars; this reads them.
  $("dpmid").onclick = async () => {
    const zid = $("dpzone").value || null;
    const d = (datasets || []).find((x) => x.kind === "drills" && (x.zone_id || null) === zid)
      || (datasets || []).find((x) => x.kind === "drills");
    if (!d?.storage_path) {
      $("dpmidnote").textContent = "No drill collars are loaded for this project yet.";
      return;
    }
    $("dpmid").disabled = true;
    $("dpmidnote").textContent = "Reading the collars…";
    try {
      const { data: sg, error: se } = await db.storage.from("artifacts")
        .createSignedUrl(d.storage_path, 300);
      if (se || !sg?.signedUrl) throw se || new Error("could not read the collar file");
      const r = await fetch(sg.signedUrl);
      if (!r.ok) throw new Error("the collar file could not be fetched (" + r.status + ")");
      const body = await r.json();
      const cs = (body.traces || []).map((t) => t.collar)
        .filter((c) => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1]));
      if (!cs.length) throw new Error("that file has no readable collars");
      const e = cs.reduce((a, c) => a + c[0], 0) / cs.length;
      const n = cs.reduce((a, c) => a + c[1], 0) / cs.length;
      $("dpe").value = e.toFixed(1);
      $("dpn").value = n.toFixed(1);
      $("dpmidnote").textContent = `Centre of ${cs.length} collar${cs.length === 1 ? "" : "s"}. Move it if the rig is somewhere else.`;
    } catch (err) {
      $("dpmidnote").textContent = err.message || String(err);
    }
    $("dpmid").disabled = false;
  };

  $("dpsave").onclick = async () => {
    const name = $("dpname").value.trim();
    if (!name) return toast("A programme needs a name.", true);
    const e = num($("dpe").value), n = num($("dpn").value);
    // Half a position is a pin in the sea, and the database refuses it too.
    // Said here, where it can be fixed, rather than as a constraint violation.
    if ((e === null) !== (n === null)) {
      return toast("A rig position needs both an easting and a northing.", true);
    }
    const start = $("dpstart").value || null, end = $("dpend").value || null;
    if (start && end && end < start) {
      return toast("The finish date is before the start.", true);
    }
    const row = {
      project_id: project.id,
      zone_id: $("dpzone").value || null,
      name,
      status: $("dpstatus").value,
      target_m: num($("dptarget").value),
      holes_planned: num($("dpholes").value),
      started_on: start, expected_end: end,
      easting: e, northing: n,
      operator: $("dpop").value.trim() || null,
      note: $("dpnote").value.trim() || null,
    };
    $("dpsave").disabled = true;
    const q = g
      ? db.from("drill_programs").update(row).eq("id", g.id)
      : db.from("drill_programs")
          .insert({ ...row, created_by: state.session?.user?.id || null });
    const { error } = await q;
    $("dpsave").disabled = false;
    if (error) return fail(g ? "Save plan" : "Add programme", error);
    closeModal();
    toast(g ? "Plan saved" : "Programme added");
    done();
  };
}

// --------------------------------------------------------- the report ------
function updateModal(g, ups, done) {
  const prev = lastMetres(ups);
  const prevM = prev ? num(prev.metres_total) : null;
  const t = num(g.target_m);
  // Whoever filed the last one is overwhelmingly whoever is filing this one.
  const who = (ups || []).find((u) => u.author)?.author || "";
  modal(`
    <h2>Report progress</h2>
    <p class="sub">${esc(g.name)}${prev
      ? ` — last reported ${esc(metres(prevM))} on ${esc(onDate(prev.as_of))}.`
      : " — the first report against this programme."}</p>

    <div class="grid two">
      <div class="field"><label for="dua">As of</label>
        <input type="date" id="dua" value="${today()}"></div>
      <div class="field"><label for="dum">Metres drilled to date</label>
        <input type="number" id="dum" min="0" step="1" inputmode="decimal"
               placeholder="${prevM !== null ? Math.round(prevM) : 4000}"></div>
    </div>
    <p class="hintline" id="dudelta" style="margin:-8px 0 14px">Cumulative —
       the total since the programme started, not the metres since the last
       report. The figure below is worked out for you.</p>

    <div class="grid two">
      <div class="field"><label for="duh">Holes finished</label>
        <input type="number" id="duh" min="0" step="1"
               placeholder="${g.holes_planned ? "of " + g.holes_planned : "optional"}"></div>
      <div class="field"><label for="dur">Holes turning now</label>
        <input type="number" id="dur" min="0" step="1" placeholder="optional"></div>
    </div>

    <div class="field"><label for="dub">What happened</label>
      <textarea id="dub" rows="3" placeholder="Two sentences. What was drilled, where, and what is next. No assay results unless they have already been disclosed."></textarea></div>
    <div class="field"><label for="duau">Reported by</label>
      <input type="text" id="duau" placeholder="Name and title — shown on the report"
             value="${esc(who)}"></div>

    <div class="note" style="margin-bottom:16px">Posting shows this to anyone
      holding a link to a deck for this project, immediately. A draft is visible
      to your team here and to nobody else.</div>

    <div class="row-actions">
      <button class="btn primary" id="dupost">Post to shareholders</button>
      <button class="btn" id="dudraft">Save as draft</button>
      <button class="btn" id="ducancel">Cancel</button>
    </div>`);
  $("ducancel").onclick = closeModal;

  // The delta, live, as it is typed. This is the one guard that catches the
  // ambiguity in "we're at 4,000 metres today": if the number entered is lower
  // than the last total, the field was read as metres-since, and the form says
  // so before the figure goes to a shareholder rather than after.
  const delta = () => {
    const m = num($("dum").value);
    const el = $("dudelta");
    if (m === null) {
      el.textContent = "Cumulative — the total since the programme started, not the metres since the last report.";
      el.style.color = "";
      return;
    }
    const bits = [];
    if (prevM !== null) {
      const d = m - prevM;
      if (d < 0) {
        el.style.color = "var(--bad)";
        el.textContent = `That is ${metres(-d)} LESS than the last report (${metres(prevM)} on ${onDate(prev.as_of)}). This field is metres to date, not metres since — ${metres(prevM + m)} would be the total if you meant ${metres(m)} this period.`;
        return;
      }
      bits.push(`+${metres(d)} since ${onDate(prev.as_of)}`);
    }
    if (t) bits.push(`${Math.round(Math.min(1, m / t) * 100)}% of ${metres(t)}`);
    el.style.color = "";
    el.textContent = bits.length ? bits.join(" · ") : "Cumulative total to date.";
  };
  $("dum").oninput = delta;
  delta();

  const save = async (publish) => {
    const m = num($("dum").value);
    const body = $("dub").value.trim();
    if (m === null && !body) {
      return toast("A report needs a metre count, a note, or both.", true);
    }
    const btn = publish ? $("dupost") : $("dudraft");
    btn.disabled = true;
    const { error } = await db.from("drill_updates").insert({
      program_id: g.id,
      as_of: $("dua").value || today(),
      metres_total: m,
      holes_done: num($("duh").value),
      holes_active: num($("dur").value),
      body: body || null,
      author: $("duau").value.trim() || null,
      published_at: publish ? new Date().toISOString() : null,
      created_by: state.session?.user?.id || null,
    });
    btn.disabled = false;
    if (error) return fail("Report progress", error);
    closeModal();
    toast(publish ? "Posted — every deck shows it now" : "Saved as a draft");
    done();
  };
  $("dupost").onclick = () => save(true);
  $("dudraft").onclick = () => save(false);
}
