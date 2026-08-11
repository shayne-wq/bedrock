// Bedrock console — loading a block model.
//
// Three steps: pick the file, confirm how its columns map, watch it run. The
// third step is deliberately not a progress bar. An upload elsewhere tells you
// how many bytes have moved; this tells you how many rows were read, how many
// blocks survived the cut-off, how many straddle more than one domain — and
// finishes by showing that the share-weighted rollups still reconcile to the
// deposit total. That reconciliation is the product's entire claim to being
// trustworthy, so it is shown rather than asserted.

import {
  db, state, $, esc, fmtInt, fmtT, fmtOz, fmtBytes,
  toast, fail, modal, closeModal,
} from "./lib/ui.js";
import {
  sniff, readGeoJSON, readKML, readOBJ, readGOCAD, readDXF,
  readCollars, readSurveys, readAssays, desurvey,
  readWorldFile, worldExtent, magProduct, readGeochem, readGeoTiff, demToMesh,
  readAsciiGrid, readOMF, bandToBitmap, omfVolumeToFile
} from "./lib/formats.js";

let worker = null;
function getWorker() {
  if (!worker) worker = new Worker("./lib/ingest-worker.js", { type: "module" });
  return worker;
}
/** One request, one reply. The worker handles a single job at a time and the
 *  wizard is modal, so a per-call listener is enough and avoids leaking one
 *  handler per file the user changes their mind about. */
function ask(msg, onProgress) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const h = (e) => {
      if (e.data.cmd === "progress") return onProgress?.(e.data.rows);
      w.removeEventListener("message", h);
      e.data.ok ? resolve(e.data) : reject(new Error(e.data.error));
    };
    w.addEventListener("message", h);
    w.postMessage(msg);
  });
}

export function ingestWizard(project, zone, onDone, presetFile) {
  // Dropped straight onto the zone's slot: the picker step has already been
  // answered, so do not make the user answer it again.
  if (presetFile) return startBlocks(project, zone, presetFile, onDone);
  modal(`
    <h2>Load a block model${zone ? ` — ${esc(zone.name)}` : ""}</h2>
    <p class="sub">Read in this browser. The file is not uploaded — only the
       geometry and rollups a deck needs, which is a few megabytes.</p>
    <div class="drop" id="drop">
      <button class="btn primary" id="pick">Choose a file</button>
      <p>or drag it here — a CSV from MineSight, Vulcan, Datamine or Surpac,
         or an <b>OMF</b> file from Leapfrog, Micromine or Deswik</p>
      <input type="file" id="file" accept=".csv,.omf,text/csv" hidden>
    </div>
    <div class="note" style="margin-top:14px">
      A block-model export has no standard schema, so the next step shows what
      was detected and lets you correct any of it before anything is computed.
    </div>`);

  const drop = $("drop"), input = $("file");
  $("pick").onclick = () => input.click();
  input.onchange = () => { if (input.files[0]) startBlocks(project, zone, input.files[0], onDone); };
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault(); drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault(); drop.classList.remove("over");
  }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) startBlocks(project, zone, f, onDone);
  });
}

// A CSV goes straight to the mapping step. An OMF is a whole project and may
// hold several models, so it gets a step of its own first — which is a step
// that ASKS rather than guesses, because the file names its own contents.
async function startBlocks(project, zone, file, onDone) {
  if (!/\.omf$/i.test(file.name || "")) return step2(project, zone, file, onDone);

  modal(`<h2>Reading ${esc(file.name)}</h2>
    <p class="sub">Opening the project to see what is in it.</p>
    <div class="skel big"></div>`);
  let proj;
  try { proj = await readOMF(file); }
  catch (e) {
    modal(`<h2>Could not read that OMF</h2><p class="sub">${esc(e.message)}</p>
      <div class="row-actions" style="margin-top:16px">
        <button class="btn" id="back">Choose another file</button></div>`);
    $("back").onclick = () => ingestWizard(project, zone, onDone);
    return;
  }

  const vols = proj.elements.filter((e) => e.kind === "Volume" && e.grid);
  const others = proj.elements.filter((e) => e.kind !== "Volume");
  if (!vols.length) {
    modal(`<h2>No block model in that file</h2>
      <p class="sub">${esc(file.name)} holds
         ${esc(others.map((e) => `${e.name} (${e.kind})`).join(", ") || "nothing this reads")}.</p>
      <div class="note">Surfaces from an OMF load in the <b>Surfaces</b> slot.
        This slot is for the block model.</div>
      <div class="row-actions" style="margin-top:16px">
        <button class="btn" id="back">Choose another file</button></div>`);
    $("back").onclick = () => ingestWizard(project, zone, onDone);
    return;
  }

  const volOpts = vols.map((v, i) =>
    `<option value="${i}">${esc(v.name)} — ${fmtInt(v.blocks)} blocks</option>`).join("");
  const varsFor = (v) => (v.data || [])
    .filter((d) => /cell/i.test(d.location || ""))
    .map((d) => d.name);

  modal(`
    <h2>What should the deck show?</h2>
    <p class="sub">This file names its own contents, so nothing here is a
       guess — pick the model and the variable to grade it by.</p>
    <div class="field"><label for="ovol">Block model</label>
      <select id="ovol">${volOpts}</select></div>
    <div class="field"><label for="ograde">Grade variable</label>
      <select id="ograde"></select>
      <p class="hintline" id="ovarhint"></p></div>
    <div class="grid two">
      <div class="field"><label for="oden">Density variable</label>
        <select id="oden"></select></div>
      <div class="field"><label for="odom">Domain variable</label>
        <select id="odom"></select></div>
    </div>
    ${others.length ? `<div class="note">Also in this file, and not loaded here:
      ${esc(others.map((e) => `${e.name} (${e.kind})`).join(", "))}. Surfaces go
      in the Surfaces slot.</div>` : ""}
    <div class="row-actions" style="margin-top:16px">
      <button class="btn primary" id="ogo">Continue</button>
      <button class="btn" id="ocancel">Cancel</button>
    </div>`);

  const fill = () => {
    const v = vols[+$("ovol").value];
    const names = varsFor(v);
    const opts = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    const none = `<option value="">— none —</option>`;
    $("ograde").innerHTML = opts || none;
    $("oden").innerHTML = none + opts;
    $("odom").innerHTML = none + opts;
    $("ovarhint").textContent = names.length
      ? `${names.length} per-block variable${names.length === 1 ? "" : "s"} in this model.`
      : "This model carries no per-block values, so there is nothing to grade it by.";
    $("ogo").disabled = !names.length;
  };
  $("ovol").onchange = fill; fill();
  $("ocancel").onclick = closeModal;
  $("ogo").onclick = () => {
    const v = vols[+$("ovol").value];
    try {
      const conv = omfVolumeToFile(v, {
        grade: $("ograde").value || undefined,
        density: $("oden").value || undefined,
        domain: $("odom").value || undefined,
      });
      // Straight into the existing mapping step. The block size is STATED by
      // the file rather than inferred from spacing, so it is passed through and
      // the mapping step shows it as a fact instead of a best guess.
      step2(project, zone, conv.file, onDone,
            { dx: conv.dx, dy: conv.dy, dz: conv.dz, from: v.name, omf: file.name });
    } catch (e) {
      modal(`<h2>Cannot load that model</h2><p class="sub">${esc(e.message)}</p>
        <div class="row-actions" style="margin-top:16px">
          <button class="btn" id="back">Back</button></div>`);
      $("back").onclick = () => startBlocks(project, zone, file, onDone);
    }
  };
}

// ------------------------------------------------------- step 2: mapping ---
async function step2(project, zone, file, onDone, known = null) {
  modal(`
    <h2>Reading ${esc(file.name)}</h2>
    <p class="sub">Sampling the first rows to work out the grid.</p>
    <div class="skel big"></div>`);

  let p;
  try {
    p = (await ask({ cmd: "probe", file })).probe;
  } catch (e) {
    modal(`<h2>Could not read that file</h2>
      <p class="sub">${esc(e.message)}</p>
      <div class="note danger">Bedrock expects a CSV with one row per block and
        a header row naming the columns. If this is a binary or proprietary
        export, re-export it as CSV from your modelling package.</div>
      <div class="row-actions" style="margin-top:16px">
        <button class="btn" id="back">Choose another file</button></div>`);
    $("back").onclick = () => ingestWizard(project, zone, onDone);
    return;
  }

  const m = p.mapping;
  const opts = (sel) => p.header.map((h) =>
    `<option value="${esc(h)}"${h === sel ? " selected" : ""}>${esc(h)}</option>`).join("");
  const optional = (sel) =>
    `<option value=""${sel ? "" : " selected"}>— none —</option>` + opts(sel);

  modal(`
    <h2>Check the mapping</h2>
    <p class="sub">${fmtInt(p.header.length)} columns, sampled ${fmtInt(p.sampled)} rows.
       Correct anything that is wrong — tonnage depends on it.</p>

    <div class="grid two">
      <div class="field"><label for="mx">Easting</label><select id="mx">${opts(m.x)}</select></div>
      <div class="field"><label for="my">Northing</label><select id="my">${opts(m.y)}</select></div>
      <div class="field"><label for="mz">Elevation</label><select id="mz">${opts(m.z)}</select></div>
      <div class="field"><label for="mg">Grade</label><select id="mg">${opts(m.grade)}</select></div>
      <div class="field"><label for="mo">Ore fraction of block</label>
        <select id="mo">${optional(m.oreFraction)}</select></div>
      <div class="field"><label for="mc">Resource classification</label>
        <select id="mc">${optional(m.classification)}</select></div>
    </div>

    <div class="field">
      <label for="md">Domain</label>
      ${m.domainShare.length
        ? `<div class="note"><b>${m.domainShare.length} domain share columns found.</b>
             Tonnage will be split between domains by each block's own share.
             This matters: where blocks straddle two veins, crediting each block
             whole to its dominant domain overstates that domain — by 34% in
             contained ounces on our reference deposit, while the deposit total
             still reconciled exactly.</div>`
        : `<select id="md">${optional(m.domain)}</select>
           <p class="hintline">A single column naming each block's domain. No
             per-domain share columns were found, so a block will be credited
             entirely to the domain named here.</p>`}
    </div>

    <h2 style="margin-top:20px">Block size <span class="hint">${known
      ? "stated by the file" : "inferred from the grid"}</span></h2>
    <div class="grid three">
      <div class="field"><label for="dx">Easting (m)</label>
        <input type="number" id="dx" step="any" value="${known?.dx ?? p.dx ?? ""}"></div>
      <div class="field"><label for="dy">Northing (m)</label>
        <input type="number" id="dy" step="any" value="${known?.dy ?? p.dy ?? ""}"></div>
      <div class="field"><label for="dz">Bench (m)</label>
        <input type="number" id="dz" step="any" value="${known?.dz ?? p.dz ?? ""}"></div>
    </div>
    <p class="hintline">${known
      ? `Read from <b>${esc(known.omf || "the file")}</b>, which records the block ` +
        "widths rather than leaving them to be inferred. Nothing here was guessed."
      : "Block dimensions are not written in the file — these are the most " +
        "common spacings between block centres in the sample. Tonnage is " +
        "meaningless if they are wrong, so check them against the technical report."}</p>

    <div class="grid two" style="margin-top:14px">
      <div class="field"><label for="den">Density (t/m³)</label>
        <input type="number" id="den" step="any" value="${p.densityMedian ?? 2.7}">
        <p class="hintline">${p.densityUniform
          ? "Uniform across the sample."
          : m.density ? "Varies by block — clear this field to use each block's own value."
                      : "No density column found; this constant will be used."}</p></div>
      <div class="field"><label for="cut">Cut-off grade</label>
        <input type="number" id="cut" step="any" value="0">
        <p class="hintline">Blocks below this are not stored at all. Leave at 0
          to keep everything and set cut-off later in the deck.</p></div>
    </div>

    ${!p.dx || !p.dy || !p.dz ? `<div class="note warn">Could not infer every
      block dimension from the sample. Enter them by hand before continuing.</div>` : ""}

    ${!p.subBlocked && p.ragged ? `<div class="note warn">
      <b>The block centres are unevenly spaced.</b> Only
      ${Math.round(Math.min(p.spacingShare.x, p.spacingShare.y, p.spacingShare.z) * 100)}%
      of the gaps match the inferred cell size. That is normal for a model with
      a lot of empty ground, and it is also what a sub-blocked model looks
      like. Tonnage here assumes every block is
      ${p.dx} × ${p.dy} × ${p.dz} m — check that is true before you rely on it.
    </div>` : ""}

    ${p.subBlocked ? `<div class="note bad">
      <b>This looks like a sub-blocked model.</b>
      ${esc(p.uniformity.reasons[0] || "the cells are not all the same size")} —
      which means the cells are not all the same size. Bedrock computes tonnage
      from a single block volume, so it would report a confident wrong number
      for a model like this rather than fail. Re-block it onto a regular grid,
      or export the parent cells only, and load that instead.
    </div>` : ""}

    <!-- The confirmation exists because detection has a floor that cannot be
         raised. Sub-blocking on an ODD factor — 2.5 m cells inside a 7.5 m
         parent — puts every child centre and every surviving parent centre on
         the same fine lattice. The occupied coordinates are not merely similar
         to a patchy 2.5 m grid, they are the SAME SET. No coordinate test can
         separate them, and no amount of cleverness here will change that.

         So the last line of defence is not a detector, it is a person. One
         number, stated plainly, that somebody has to agree to — which turns a
         silent wrong tonnage into an assumption on the record. It is asked on
         every model, not only suspicious ones, because the undetectable case
         looks exactly like the clean one. -->
    <label class="checkline" style="margin-top:16px;align-items:flex-start">
      <input type="checkbox" id="dimok">
      <span style="font-size:13px;color:var(--ink-2);line-height:1.5">
        I confirm every block in this model is
        <b id="dimecho">${p.dx} × ${p.dy} × ${p.dz} m</b>.
        Tonnage is computed from that one volume; if some cells are smaller,
        every figure in the deck will be wrong and nothing will look wrong.
      </span>
    </label>

    <div class="row-actions" style="margin-top:14px">
      <button class="btn primary" id="run" ${p.subBlocked ? "disabled" : ""} disabled>Read the model</button>
      <button class="btn" id="cancel">Cancel</button>
    </div>`);

  // Keep the confirmation honest: it names the numbers currently in the boxes,
  // so editing a dimension after ticking re-states what is being agreed to.
  const echo = () => {
    const e = $("dimecho");
    if (e) e.textContent = `${$("dx").value} × ${$("dy").value} × ${$("dz").value} m`;
  };
  ["dx", "dy", "dz"].forEach((id) => { if ($(id)) $(id).oninput = echo; });
  $("dimok").onchange = () => {
    $("run").disabled = p.subBlocked || !$("dimok").checked;
  };

  $("cancel").onclick = closeModal;
  $("run").onclick = () => {
    const mapping = {
      ...m,
      x: $("mx").value, y: $("my").value, z: $("mz").value, grade: $("mg").value,
      oreFraction: $("mo").value || null,
      classification: $("mc").value || null,
      domain: $("md") ? ($("md").value || null) : m.domain,
    };
    const dx = Number($("dx").value), dy = Number($("dy").value), dz = Number($("dz").value);
    if (!(dx > 0 && dy > 0 && dz > 0)) {
      return toast("Block dimensions must all be greater than zero.", true);
    }
    const denRaw = $("den").value.trim();
    step3(project, zone, file, {
      mapping, dx, dy, dz,
      density: denRaw === "" ? null : Number(denRaw),
      cutoff: Number($("cut").value) || 0,
      // Carried through so extract() can refuse rather than compute a
      // confident wrong tonnage. Surfaced in step 2 as well, because being
      // told at the end of a two-minute read is a worse way to find out.
      subBlocked: p.subBlocked,
      subBlockedWhy: p.uniformity.reasons[0] || null,
    }, onDone);
  };
}

// -------------------------------------------------------- step 3: ledger ---
const line = (k, v, cls = "") =>
  `<div class="ln ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;

async function step3(project, zone, file, cfg, onDone) {
  modal(`
    <h2>Reading the model</h2>
    <p class="sub">${esc(file.name)} · ${fmtBytes(file.size)}</p>
    <div class="bar" style="margin-bottom:14px"><i id="bar"></i></div>
    <div class="ledger" id="ledger">
      ${line("File", esc(file.name))}
      ${line("Size", fmtBytes(file.size))}
      ${line("Rows read", "<span id='rows'>0</span>")}
    </div>`);

  const t0 = performance.now();
  // Row count is unknown until the file has been read, so the bar is driven by
  // an estimate from the average row length of the sample. It is a rough guide
  // that never reaches 100% until the run genuinely finishes.
  const est = Math.max(1, Math.round(file.size / 2400));
  let out;
  try {
    out = await ask({ cmd: "extract", file, ...cfg }, (rows) => {
      const r = $("rows");
      if (r) r.textContent = fmtInt(rows);
      const b = $("bar");
      if (b) b.style.width = Math.min(96, (rows / est) * 100).toFixed(1) + "%";
    });
  } catch (e) {
    modal(`<h2>Extraction failed</h2>
      <p class="sub">${esc(e.message)}</p>
      <div class="row-actions"><button class="btn" id="back">Try again</button></div>`);
    $("back").onclick = () => ingestWizard(project, zone, onDone);
    return;
  }

  const s = out.stats, rec = out.reconciled;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const packedBytes = out.packed.byteLength;

  $("bar").style.width = "100%";
  $("ledger").innerHTML = `
    ${line("File", esc(file.name))}
    ${line("Size", fmtBytes(file.size))}
    ${line("Rows read", fmtInt(s.scanned_rows))}
    ${line("Read in", secs + "s")}
    <div class="rule"></div>
    ${line("Blocks kept", fmtInt(s.total.blocks))}
    ${s.below_cutoff ? line("Below cut-off", fmtInt(s.below_cutoff) + " dropped") : ""}
    ${s.dropped_blocks ? line("No domain share", fmtInt(s.dropped_blocks) + " dropped", "bad") : ""}
    ${line("Block volume", s.block_m3 + " m³ (" + s.block_dims.join(" × ") + " m)")}
    ${line("Density", typeof s.density === "number" ? s.density + " t/m³" : "per block")}
    <div class="rule"></div>
    ${line("Tonnage", fmtT(s.total.tonnes))}
    ${line("Grade", s.total.grade_gt + " g/t")}
    ${line("Contained metal", fmtOz(s.total.oz))}
    ${line("Domains", fmtInt((s.veins || []).length) +
        (s.share_weighted ? " (share-weighted)" : ""))}
    ${s.share_weighted ? line("Straddling >1 domain",
        fmtInt(s.blocks_straddling_multiple_domains) + " blocks") : ""}
    <div class="rule"></div>
    ${line("Rollups reconcile", rec.ok
        ? `yes — drift ${rec.bucket_drift_t} t`
        : `NO — drift ${rec.bucket_drift_t} t`, rec.ok ? "ok" : "bad")}
    ${line("Packed to", fmtBytes(packedBytes) +
        `  (${(file.size / packedBytes).toFixed(0)}× smaller)`)}`;

  const warn = s.dropped_blocks
    ? `<div class="note warn"><b>${fmtInt(s.dropped_blocks)} mineralised blocks
        had no domain share and were dropped.</b> They are missing from every
        rollup above. Check the domain columns before publishing anything from
        this model.</div>` : "";

  const blocked = !rec.ok ? `<div class="note danger">
      <b>The rollups do not reconcile.</b> The per-domain tonnages add up to
      ${rec.bucket_drift_t} t away from the deposit total, which means the domain
      columns are not what they appear to be. Publishing a vein breakdown from
      this would be publishing a fiction, so saving is blocked.</div>` : "";

  document.querySelector(".modal .inner").insertAdjacentHTML("beforeend", `
    ${warn}${blocked}
    <div class="checkline" style="margin-top:14px">
      <input type="checkbox" id="synth">
      <label for="synth" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;font-family:var(--sans);color:var(--ink-2)">
        This data is fabricated or illustrative, not real results
      </label>
    </div>
    <div class="field" id="synthwrap" style="display:none">
      <label for="synthnote">What is fabricated about it</label>
      <input type="text" id="synthnote" placeholder="Synthetic model for demonstration">
      <p class="hintline">Required. It is shown on screen in every deck built
        from this data and burned into exported images and video.</p>
    </div>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn primary" id="save" ${rec.ok ? "" : "disabled"}>Save to project</button>
      <button class="btn" id="discard">Discard</button>
    </div>`);

  $("synth").onchange = () => {
    $("synthwrap").style.display = $("synth").checked ? "" : "none";
  };
  $("discard").onclick = closeModal;
  $("save").onclick = () => save(project, zone, file, out, onDone);
}

// ---------------------------------------------------------------- saving ---
async function save(project, zone, file, out, onDone) {
  const synthetic = $("synth").checked;
  const note = $("synthnote")?.value.trim() || "";
  if (synthetic && !note) {
    return toast("Say what is fabricated about it — that label travels with every deck.", true);
  }

  const btn = $("save");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    // Path is <org>/<project>/<zone>/<dataset>/… — the first segment is the
    // tenant boundary every storage policy checks, so org_id stays leading.
    const id = crypto.randomUUID();
    const base = `${project.org_id}/${project.id}/${zone.id}/${id}`;
    const blocksPath = `${base}/blocks.bin`;

    // Uploads of a few megabytes are quick, but a storage endpoint that accepts
    // the connection and then never answers leaves the button reading "Saving…"
    // for as long as the user is willing to wait. Bound it, and say so.
    const up = async (path, body, type) => {
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(
          "the storage service did not respond within two minutes")), 120000));
      const { error } = await Promise.race([
        db.storage.from("artifacts").upload(path, body, { contentType: type, upsert: true }),
        timeout,
      ]);
      if (error) throw error;
    };
    await up(blocksPath, new Blob([out.packed]), "application/octet-stream");
    await up(`${base}/buckets.json`,
      new Blob([JSON.stringify(out.buckets)]), "application/json");

    // Replace rather than accumulate: a zone has one block model, and leaving
    // the previous one would leave decks silently reading stale tonnages.
    const { data: old } = await db.from("datasets")
      .select("id").eq("zone_id", zone.id).eq("kind", "blocks");
    if (old?.length) {
      await db.from("datasets").delete().in("id", old.map((d) => d.id));
    }

    const { error } = await db.from("datasets").insert({
      project_id: project.id,
      zone_id: zone.id,
      kind: "blocks",
      label: file.name,
      storage_path: blocksPath,
      bytes: out.packed.byteLength,
      stats: out.stats,
      provenance: {
        source_file: file.name,
        source_bytes: file.size,
        read_at: new Date().toISOString(),
        read_in_browser: true,
        reconciled: out.reconciled,
        buckets_path: `${base}/buckets.json`,
      },
      synthetic,
      synthetic_note: synthetic ? note : null,
    });
    if (error) throw error;

    closeModal();
    toast(`Loaded ${fmtInt(out.stats.total.blocks)} blocks`);
    onDone?.();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Save to project";
    fail("Save", e);
  }
}

// ============================================================ aux datasets ===
// Block models are read in the browser and only their rollups are stored. The
// other four dataset kinds — drills, surfaces, site and geophysics — are small
// enough (a few MB at most) to store as uploaded, so this is a plainer flow:
// pick the file(s), say whether they are real, upload, record a dataset row.
// Parsing (desurveying drill traces, triangulating surfaces) happens later in
// the build; the console's job here is to collect the inputs, per zone.
const AUX = {
  drills: {
    label: "Drill holes",
    blurb: "Three CSVs — collars, downhole surveys and assays. Standard columns; "
         + "the build desurveys the traces and pulls the intercepts.",
    parts: [
      { key: "collars", label: "Collars",
        hint: "hole_id, easting, northing, elevation, total_depth_m, azimuth, dip", accept: ".csv" },
      { key: "surveys", label: "Downhole surveys",
        hint: "hole_id, depth_m, azimuth, dip", accept: ".csv" },
      { key: "assays", label: "Assays",
        hint: "hole_id, from_m, to_m, length_m, au_gpt", accept: ".csv" },
    ],
  },
  surfaces: {
    label: "Surfaces",
    blurb: "Vein or grade-shell wireframes as triangulated mesh (OBJ / DXF) or "
         + "the viewer's surfaces JSON. Optional — the build can also derive "
         + "shells from the block model itself.",
    parts: [{ key: "surfaces", label: "Surface mesh", hint: ".obj, .dxf or .json",
              accept: ".obj,.dxf,.json" }],
  },
  site: {
    label: "Property & claims",
    blurb: "Claim or tenure polygons as GeoJSON, in the project's coordinate "
         + "system or WGS84. Drives the property extent and the claim colour-pop.",
    parts: [{ key: "site", label: "Claims / tenure", hint: ".geojson or .json",
              accept: ".geojson,.json" }],
  },
  geophysics: {
    label: "Geophysics",
    blurb: "Georeferenced raster images (magnetics, radiometrics…) as PNG or "
         + "JPEG. Draped on the terrain over the deposit.",
    parts: [{ key: "images", label: "Raster image(s)", hint: ".png or .jpg — "
              + "you can pick several", accept: ".png,.jpg,.jpeg", multiple: true }],
  },
};

export function uploadAux(project, zone, kind, onDone, presetFile) {
  const spec = AUX[kind];
  if (!spec) return;
  // A file dropped on the slot fills the first part. Drills needs three files
  // and only the first can be inferred, so the modal still opens — it just
  // opens with one of them already answered.
  const preset = presetFile ? { key: spec.parts[0].key, file: presetFile } : null;
  modal(`
    <h2>${esc(spec.label)} — ${esc(zone.name)}</h2>
    <p class="sub">${esc(spec.blurb)}</p>
    ${spec.parts.map((pt) => `
      <div class="field">
        <label for="f_${pt.key}">${esc(pt.label)}</label>
        <div class="dropmini" id="dz_${pt.key}">
          <input type="file" id="f_${pt.key}" accept="${pt.accept}" ${pt.multiple ? "multiple" : ""}>
          <span class="dzname" id="dn_${pt.key}">${preset && preset.key === pt.key ? esc(preset.file.name) : "or drop a file here"}</span>
        </div>
        <p class="hintline">${esc(pt.hint)}</p>
      </div>`).join("")}
    <div class="checkline" style="margin-top:8px">
      <input type="checkbox" id="synth">
      <label for="synth" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;font-family:var(--sans);color:var(--ink-2)">
        This data is fabricated or illustrative, not real results
      </label>
    </div>
    <div class="field" id="synthwrap" style="display:none">
      <label for="synthnote">What is fabricated about it</label>
      <input type="text" id="synthnote" placeholder="Synthetic ${esc(kind)} for demonstration">
      <p class="hintline">Required. Shown on screen in every deck and burned into exports.</p>
    </div>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn primary" id="auxsave">Save to zone</button>
      <button class="btn" id="auxcancel">Cancel</button>
    </div>`);

  $("synth").onchange = () => { $("synthwrap").style.display = $("synth").checked ? "" : "none"; };
  $("auxcancel").onclick = closeModal;

  // Files dropped after the modal is open, per field. A File cannot be written
  // into an <input type=file> by script, so dropped files are held here and
  // saveAux prefers them over the input when both exist.
  const dropped = preset ? { [preset.key]: [preset.file] } : {};
  spec.parts.forEach((pt) => {
    const dz = $(`dz_${pt.key}`), nm = $(`dn_${pt.key}`), inp = $(`f_${pt.key}`);
    if (!dz) return;
    inp.onchange = () => {
      delete dropped[pt.key];
      nm.textContent = inp.files.length
        ? [...inp.files].map((f) => f.name).join(", ") : "or drop a file here";
    };
    ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => {
      e.preventDefault(); dz.classList.add("over");
    }));
    ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => {
      e.preventDefault(); dz.classList.remove("over");
    }));
    dz.addEventListener("drop", (e) => {
      const fs = [...(e.dataTransfer?.files || [])];
      if (!fs.length) return;
      dropped[pt.key] = pt.multiple ? fs : [fs[0]];
      nm.textContent = dropped[pt.key].map((f) => f.name).join(", ");
    });
  });

  $("auxsave").onclick = () => saveAux(project, zone, kind, spec, onDone, dropped);
}

async function saveAux(project, zone, kind, spec, onDone, dropped) {
  // Collect the chosen files part-by-part. Every part is required except where
  // a part is explicitly multiple (geophysics), which just needs at least one.
  const chosen = [];
  for (const pt of spec.parts) {
    const el = $(`f_${pt.key}`);
    // Dropped files win: the input is empty in that case, and an empty input
    // would otherwise report "choose the file" for one the user just dropped.
    const files = (dropped && dropped[pt.key]) || [...(el?.files || [])];
    if (!files.length) return toast(`Choose the ${pt.label.toLowerCase()} file.`, true);
    files.forEach((f) => chosen.push({ part: pt.key, file: f }));
  }
  const synthetic = $("synth").checked;
  const note = $("synthnote")?.value.trim() || "";
  if (synthetic && !note) {
    return toast("Say what is fabricated about it — that label travels with every deck.", true);
  }

  const btn = $("auxsave");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await putAux(project, zone, kind, chosen, synthetic, note);
    closeModal();
    toast(`${spec.label} saved`);
    onDone?.();
  } catch (e) {
    btn.disabled = false; btn.textContent = "Save to zone";
    fail("Save", e);
  }
}

/**
 * Upload files for one dataset kind and record the row. No DOM — so a drop
 * can call it directly without opening anything, which is the difference
 * between "drag and drop" and "drag, drop, then fill in a form".
 */
export async function putAux(project, zone, kind, chosen, synthetic, note) {
  {
    // Read the files before uploading anything. Storing first and parsing
    // later means a project accumulates blobs nobody can render and nobody is
    // told about — which is the state this replaces. A file we cannot read is
    // refused here, by name, with what to export instead.
    const derived = await parseAux(kind, chosen);
    const id = crypto.randomUUID();
    const base = `${project.org_id}/${project.id}/${zone.id}/${id}`;
    const up = async (path, body, type) => {
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error("the storage service did not respond within two minutes")), 120000));
      const { error } = await Promise.race([
        db.storage.from("artifacts").upload(path, body, { contentType: type, upsert: true }),
        timeout,
      ]);
      if (error) throw error;
    };

    const files = [];
    let total = 0;
    for (const c of chosen) {
      const safe = c.file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${base}/${c.part}__${safe}`;
      await up(path, c.file, c.file.type || "application/octet-stream");
      files.push({ part: c.part, name: c.file.name, path, bytes: c.file.size });
      total += c.file.size;
    }

    // One dataset of each kind per zone — replace, do not accumulate.
    const { data: old } = await db.from("datasets")
      .select("id").eq("zone_id", zone.id).eq("kind", kind);
    if (old?.length) await db.from("datasets").delete().in("id", old.map((d) => d.id));

    // Derived geometry rides alongside the originals, so the viewer never
    // re-parses a customer's CSV and the original stays available for audit.
    let derivedPath = null;
    if (derived?.payload) {
      derivedPath = `${base}/derived.json`;
      await up(derivedPath, new Blob([JSON.stringify(derived.payload)]), "application/json");
    }

    const { error } = await db.from("datasets").insert({
      project_id: project.id,
      zone_id: zone.id,
      kind,
      label: files.length === 1 ? files[0].name : `${files.length} files`,
      storage_path: derivedPath || files[0].path,
      bytes: total,
      stats: { files: files.length, ...(derived?.stats || {}) },
      provenance: { uploaded_at: new Date().toISOString(), files,
                    formats: chosen.map((c) => sniff(c.file).format),
                    derived_path: derivedPath,
                    ...(derived?.provenance || {}) },
      synthetic,
      synthetic_note: synthetic ? note : null,
    });
    if (error) throw error;
    // No closeModal here on purpose: a routed drop never opened one, and
    // putAux must not assume a UI it did not create.
  }
}


// ------------------------------------------------------------- routing ----
/**
 * Decide what a dropped file is, from its name and extension.
 *
 * Deliberately conservative. Returning null means "ask", and asking is a fine
 * outcome — guessing wrong puts a magnetics grid in the drill slot and the
 * user finds out three screens later. The one thing never inferred is whether
 * data is fabricated: that is a claim about provenance, not a property of the
 * bytes, and it stays a decision the person uploading makes.
 *
 * @returns {{kind:string, part?:string}|null}
 */
export function classify(file) {
  const n = (file.name || "").toLowerCase();
  const ext = n.slice(n.lastIndexOf("."));

  // Drills come as three named files. Match the part, not just the kind, so a
  // multi-file drop can fill all three at once.
  //
  // Gated on a TABULAR extension, and it has to be: these rules match a word
  // anywhere in the name, and "survey" is a word that belongs to half the
  // industry. `survey.las` is a LiDAR scan and `TMI_survey.tfw` is the world
  // file for a magnetics image, and both were being filed as drill surveys —
  // silently, because a drills slot with the wrong file in it looks exactly
  // like a drills slot. Collars, surveys and assays are always a table.
  const tabular = /\.(csv|txt|tsv)$/.test(n);
  // Geochem before drilling: a file called "soil_assays.csv" is a soil survey,
  // not a drill assay table, and "assay" would otherwise claim it.
  if (tabular && /soil|stream|silt|rockchip|rock_chip|talus|geochem|till/.test(n)) {
    return { kind: "geochem", part: "samples" };
  }
  if (tabular && /collar/.test(n)) return { kind: "drills", part: "collars" };
  if (tabular && /survey|desurvey/.test(n)) return { kind: "drills", part: "surveys" };
  if (tabular && /assay|sample/.test(n)) return { kind: "drills", part: "assays" };

  // Topography BEFORE surfaces and before the grid rules, and it has to be:
  // every route below would otherwise claim it. A DEM named dem.tif went to
  // geophysics and was treated as a magnetics image; a triangulated DTM named
  // topo.obj went to vein surfaces. And `classify` never returned "topography"
  // at all, so the slot could only ever be filled by clicking Add on it — the
  // one dataset the geologists asked for by name was the one you could not
  // drop.
  //
  // Named, not sniffed. A .tif is a DEM or a magnetics grid depending entirely
  // on what it is of, and nothing in the bytes distinguishes them; the export
  // is called dtm/dem/topo by every package that writes one. A bare grid.tif
  // still falls through to geophysics, which is the commoner case.
  if (/(^|[^a-z])(dem|dtm|dsm|topo|topography|terrain|elevation|ground|lidar|contour|bathy)/
        .test(n) && /\.(tiff?|obj|dxf|ts|asc)$/.test(n)) {
    return { kind: "topography", part: "surface" };
  }
  // Point clouds route here too. They are refused — a deck draws a surface, not
  // returns — but refused with the advice to export a DEM or a triangulated
  // ground, which beats "could not tell what that file is" for a file that is
  // unmistakably terrain.
  if (/\.(las|laz|e57)$/.test(n)) return { kind: "topography", part: "surface" };

  // An OMF is a whole project, not one dataset — it can hold surfaces, a block
  // model, points and drillhole traces at once. It routes to surfaces because
  // that is what Leapfrog users export most, and the surfaces branch reports
  // by name whatever else was in the file rather than dropping it quietly.
  if (/\.omf$/.test(n)) return { kind: "surfaces", part: "mesh" };
  if (/\.(obj|dxf|ts)$/.test(n)) return { kind: "surfaces", part: "mesh" };

  // Magnetics and other grids. Name carries the product more reliably than the
  // extension does — a .tif could be anything.
  if (/\.(tif|tiff|grd|ers|gxf)$/.test(n)) return { kind: "geophysics", part: "grids" };
  // An ESRI ASCII grid that is not terrain is a geophysics product — it is what
  // Oasis montaj exports in one click, and the advice this console gives for a
  // Geosoft .grd literally says "or as an ASCII grid", which until now it could
  // not then read.
  if (/\.asc$/.test(n)) return { kind: "geophysics", part: "grids" };
  // The world file travels with its image and belongs in the same slot.
  if (/\.(tfw|pgw|jgw|wld)$/.test(n)) return { kind: "geophysics", part: "grids" };
  if (/(mag|tmi|rtp|1vd|vd1|analytic|geophys)/.test(n) && /\.(png|jpg|jpeg)$/.test(n)) {
    return { kind: "geophysics", part: "grids" };
  }

  if (/\.(geojson|kml)$/.test(n) ||
      /(claim|tenure|property|boundary|outline)/.test(n)) {
    return { kind: "site", part: "outline" };
  }
  // .kmz/.shp/.zip look like claims but are not readable, so they are routed
  // there deliberately: putAux refuses them by name and says what to export
  // instead, which beats "unrecognised" for a file that plainly is a boundary.
  if (/\.(kmz|shp|zip)$/.test(n)) return { kind: "site", part: "outline" };

  // A CSV is the ambiguous one: it could be a block model, or collars whose
  // filename says nothing. Size is the only honest discriminator here — a
  // block model is large — and below the threshold we ask rather than guess.
  if (ext === ".csv") {
    if (file.size > 5e6) return { kind: "blocks" };
    return null;
  }
  return null;
}

/** Group classified files by kind, keeping their part assignment. */
export function routeFiles(files) {
  const byKind = {}, unknown = [];
  for (const f of files) {
    const c = classify(f);
    if (!c) { unknown.push(f); continue; }
    (byKind[c.kind] ||= []).push({ part: c.part, file: f });
  }
  return { byKind, unknown };
}

// --------------------------------------------------------- parsing aux ----
/**
 * Turn uploaded files into the geometry the viewer draws.
 *
 * Refuses rather than stores. Before this, every non-block upload was kept as
 * an opaque blob: a customer could load drilling and claims, see the slot go
 * green, and find nothing in their deck. Green meant "a file arrived", not
 * "we can render this", and nothing said so.
 *
 * @returns {{payload:object, stats:object, provenance:object}|null}
 */
async function parseAux(kind, chosen) {
  const textOf = (f) => f.text();
  const readable = (f) => {
    const s = sniff(f);
    if (!s.readable) {
      throw new Error(`${f.name} is ${s.label ? "a " + s.label + " file" : "not a format this reads"}. ${s.advice}`);
    }
    return s.format;
  };

  // Whose ground is this file? An uploaded boundary is the issuer's own — you
  // do not upload your neighbour's claims — so the holder with the most ground
  // in it is the subject. Guessing wrong here is what makes a deck draw
  // somebody else's tenure in its own colour, so it is recorded rather than
  // inferred again downstream.
  const ringsBbox = (rings) => {
    let w = Infinity, s2 = Infinity, e = -Infinity, n = -Infinity;
    rings.forEach((g) => g.ring.forEach(([lon, lat]) => {
      if (lon < w) w = lon; if (lon > e) e = lon;
      if (lat < s2) s2 = lat; if (lat > n) n = lat;
    }));
    return Number.isFinite(w) ? [w, s2, e, n] : null;
  };

  const subjectOwner = (rings) => {
    const t = new Map();
    rings.forEach((g) => {
      const o = String(g.props?.OWNER_NAME || g.props?.owner || "").trim();
      if (o) t.set(o, (t.get(o) || 0) + (Number(g.props?.AREA_IN_HECTARES) || 1));
    });
    let best = "", n = -1;
    t.forEach((v, k) => { if (v > n) { n = v; best = k; } });
    return best;
  };

  if (kind === "site") {
    const rings = [];
    for (const c of chosen) {
      const fmt = readable(c.file);
      const text = await textOf(c.file);
      const got = fmt === "kml" ? readKML(text, c.file.name)
                : fmt === "geojson" ? readGeoJSON(text, c.file.name)
                : (() => { throw new Error(`${c.file.name}: claims must be GeoJSON or KML.`); })();
      got.forEach((g) => rings.push(g));
    }
    // Roll the register up per holder at ingest, so the console can offer a
    // logo slot per company without re-reading the boundary file, and so the
    // count and hectares it shows are the same numbers the viewer draws.
    //
    // Deduped by tenure id, never by ring: a MultiPolygon claim arrives as
    // several rings, and counting those reports a holder as owning more ground
    // and more claims than the register says — on the one panel whose entire
    // subject is who owns what.
    const by = new Map(), seen = new Set();
    rings.forEach((g, i) => {
      const pr = g.props || {};
      const owner = String(pr.OWNER_NAME || pr.owner || "").trim();
      if (!owner) return;
      const k = owner.toUpperCase().replace(/\s+/g, " ");
      const h = by.get(k) || { owner, claims: 0, ha: 0 };
      const t = pr.TENURE_NUMBER_ID ?? pr.tenure ?? `r${i}`;
      if (!seen.has(`${k}|${t}`)) {
        seen.add(`${k}|${t}`);
        h.claims++;
        h.ha += Number(pr.AREA_IN_HECTARES || pr.ha || 0) || 0;
      }
      by.set(k, h);
    });
    const owners = [...by.values()]
      .map((h) => ({ ...h, ha: Math.round(h.ha * 10) / 10 }))
      .sort((a, b) => b.ha - a.ha);

    return {
      payload: { format: "orebody-claims/1", crs: "EPSG:4326", rings },
      // The extent goes in stats so the console knows WHERE this project is
      // without downloading the artifact again — which is what the registry
      // lookup needs in order to ask for the ground around it.
      stats: { rings: rings.length, owners, subject_owner: subjectOwner(rings),
               bbox: ringsBbox(rings) },
      provenance: { parsed: "claims", ring_count: rings.length,
                    holders: owners.length },
    };
  }

  if (kind === "topography") {
    // The customer's own ground, at their own resolution.
    //
    // Cesium's global terrain is ~30 m and smoothed; a project that has flown
    // LiDAR or a photogrammetric survey has something far better, and it is the
    // difference between a generic hillside and their hillside. This is
    // structured survey data, not photography — the standing decision against
    // client imagery (issue #10) is about pictures, and a DEM is measurement.
    const c = chosen[0];
    if (!c) throw new Error("No file chosen.");
    const nm = c.file.name.toLowerCase();
    if (/\.(las|laz|e57|ply)$/.test(nm)) {
      throw new Error(
        `${c.file.name} is a point cloud. Nothing in a deck draws raw returns — ` +
        "export the derived surface instead: a DEM as GeoTIFF, or the " +
        "triangulated ground as OBJ or DXF.");
    }

    let mesh, extent = null, epsg = null, note = "";
    if (/\.asc$/.test(nm)) {
      // Plain text, no library, and the format every one of these packages
      // exports without complaint.
      const dem = readAsciiGrid(await textOf(c.file), c.file.name);
      mesh = demToMesh(dem);
      extent = dem.extent; epsg = dem.epsg;
      note = `${dem.width} x ${dem.height} ESRI ASCII grid, sampled every ` +
             `${mesh.step} cell${mesh.step === 1 ? "" : "s"}` +
             " — no projection in the file, read as the project's own grid";
    } else if (/\.(tiff?)$/.test(nm)) {
      const dem = await readGeoTiff(c.file);
      if (!dem) {
        throw new Error(`${c.file.name} is a TIFF with no georeferencing, so ` +
          "there is nothing to say where the ground is. Export it as a GeoTIFF.");
      }
      mesh = demToMesh(dem);
      extent = dem.extent; epsg = dem.epsg;
      note = `${dem.width} x ${dem.height} DEM, sampled every ${mesh.step} cell` +
             `${mesh.step === 1 ? "" : "s"}`;
    } else {
      // Already a surface. The same readers the vein surfaces use, so a
      // triangulated DTM out of Leapfrog, Micromine, Deswik or MinePlan loads
      // with no extra work on either side.
      const fmt = readable(c.file);
      const text = await textOf(c.file);
      const m = fmt === "obj" ? readOBJ(text, c.file.name)
              : fmt === "gocad" ? readGOCAD(text, c.file.name)
              : fmt === "dxf" ? readDXF(text, c.file.name)
              : (() => { throw new Error(
                  `${c.file.name}: topography must be a GeoTIFF DEM, an ESRI ` +
                  "ASCII grid (.asc), or a triangulated surface as OBJ, " +
                  "GOCAD .ts or DXF."); })();
      mesh = { verts: m.verts, faces: m.faces };
      const zs = m.verts.map((v) => v[2]).filter(Number.isFinite);
      mesh.zMin = Math.min(...zs); mesh.zMax = Math.max(...zs);
      note = `${m.verts.length.toLocaleString()} vertices`;
    }

    return {
      payload: { format: "orebody-topography/1", extent, epsg,
                 mesh: { verts: mesh.verts, faces: mesh.faces } },
      stats: { vertices: mesh.verts.length, faces: mesh.faces.length,
               z_min: Math.round(mesh.zMin), z_max: Math.round(mesh.zMax),
               source: note },
      provenance: { parsed: "topography", note },
    };
  }

  if (kind === "surfaces") {
    const meshes = [];
    const alsoInFile = [];
    for (const c of chosen) {
      const fmt = readable(c.file);
      if (fmt === "omf") {
        // One file, the whole project. Every surface in it is loaded and keeps
        // the name its author gave it — not the filename, which for OMF would
        // put "export.omf" on nine different veins.
        const p = await readOMF(c.file);
        const surfaces = p.elements.filter((e) => e.kind === "Surface" && e.verts);
        if (!surfaces.length) {
          throw new Error(`${c.file.name} is OMF but holds no surfaces. It ` +
            `contains: ${p.elements.map((e) => `${e.name} (${e.kind})`).join(", ") ||
            "nothing this reads"}.`);
        }
        surfaces.forEach((s) => meshes.push({ name: s.name, verts: s.verts, faces: s.faces }));
        // What was in the file and did NOT come in. A block model inside an OMF
        // is real data the customer handed over, and silently dropping it is
        // how somebody concludes the upload worked and their resource is
        // missing from the deck. It says where to load it, because the block
        // model slot takes this same file.
        p.elements.filter((e) => e.kind !== "Surface")
          .forEach((e) => alsoInFile.push(
            `${e.name} (${e.kind}${e.kind === "Volume"
              ? " — load this file in the Block model slot" : ""})`));
        continue;
      }
      const text = await textOf(c.file);
      const m = fmt === "obj" ? readOBJ(text, c.file.name)
              : fmt === "gocad" ? readGOCAD(text, c.file.name)
              : fmt === "dxf" ? readDXF(text, c.file.name)
              : (() => { throw new Error(`${c.file.name}: surfaces must be OBJ, GOCAD .ts, DXF or OMF.`); })();
      meshes.push({ name: c.file.name, verts: m.verts, faces: m.faces });
    }
    const nv = meshes.reduce((a, m) => a + m.verts.length, 0);
    const nf = meshes.reduce((a, m) => a + m.faces.length, 0);
    return {
      payload: { format: "orebody-surfaces/1", meshes },
      stats: { meshes: meshes.length, vertices: nv, triangles: nf,
               names: meshes.map((m) => m.name).slice(0, 40),
               not_loaded: alsoInFile.length ? alsoInFile : undefined },
      provenance: { parsed: "surfaces", vertices: nv, triangles: nf,
                    not_loaded: alsoInFile.length
                      ? `${alsoInFile.length} other element(s) in the OMF were not ` +
                        `loaded here: ${alsoInFile.join(", ")}`
                      : undefined },
    };
  }

  if (kind === "drills") {
    const byPart = {};
    for (const c of chosen) { readable(c.file); byPart[c.part] = c.file; }
    if (!byPart.collars) throw new Error("Drilling needs a collars file at minimum.");
    const collars = readCollars(await textOf(byPart.collars), byPart.collars.name);
    const surveys = byPart.surveys
      ? readSurveys(await textOf(byPart.surveys), byPart.surveys.name) : new Map();
    const assays = byPart.assays
      ? readAssays(await textOf(byPart.assays), byPart.assays.name) : null;
    const { traces, assumedVertical } = desurvey(collars, surveys, 5);
    return {
      payload: {
        format: "orebody-drills/1", traces,
        assays: assays ? [...assays.byHole.entries()].map(([id, iv]) => ({ id, iv })) : [],
      },
      stats: {
        holes: traces.length,
        metres: Math.round(traces.reduce((a, t) => a + t.td, 0)),
        intervals: assays ? [...assays.byHole.values()].reduce((a, v) => a + v.length, 0) : 0,
        assumed_vertical: assumedVertical.length,
      },
      // Said out loud rather than buried: a hole drawn vertical because no
      // survey came with it is a guess, and it is the reader's job to admit it.
      provenance: {
        parsed: "drills", desurvey: "minimum-curvature", step_m: 5,
        grade_column: assays?.gradeColumn || null,
        assumed_vertical: assumedVertical,
      },
    };
  }

  if (kind === "geochem") {
    const all = [];
    let element = null, unit = null, st = null;
    for (const c of chosen) {
      readable(c.file);
      const g = readGeochem(await textOf(c.file), c.file.name);
      element = element || g.element; unit = unit || g.unit; st = g.stats;
      g.points.forEach((pt) => all.push({ ...pt, projected: g.projected }));
    }
    return {
      payload: { format: "orebody-geochem/1", element, unit,
                 projected: all[0]?.projected !== false, points: all },
      stats: { samples: all.length, element, unit, ...st },
      // Below-detection substitution is a decision about someone's data and
      // has to travel with it. A map where a third of the points are half a
      // detection limit is a different map, and only the provenance says so.
      provenance: { parsed: "geochem", element, unit,
                    below_detection_halved: st?.below_detection || 0,
                    rows_skipped: st?.skipped || 0 },
    };
  }

  if (kind === "geophysics") {
    // A grid, and the numbers that say where it goes.
    //
    // A GeoTIFF carries those numbers itself, in its own tags, which is why it
    // is the format a geophysical contractor actually delivers. This used to
    // refuse them and ask for a PNG plus a hand-written .tfw — asking the
    // customer to degrade their own deliverable and then re-supply, by hand,
    // the georeferencing the file already contained. Decoded in the browser
    // now, same as everything else here: the raw file is read locally and only
    // what the deck needs is uploaded.
    const imgs = [], worlds = {};
    for (const c of chosen) {
      const n = c.file.name.toLowerCase();
      if (/\.(tfw|pgw|jgw|wld)$/.test(n)) { worlds[n.replace(/\.[^.]+$/, "")] = c.file; continue; }
      imgs.push(c.file);
    }
    if (!imgs.length) throw new Error("No grid image found — add the .tif or .png as well as the world file.");

    const products = [];
    for (const f of imgs) {
      const stem = f.name.toLowerCase().replace(/\.[^.]+$/, "");
      const isTiff = /\.(tiff?)$/.test(f.name.toLowerCase());
      let wfFile = worlds[stem];
      let ext = null, bmp = null, vLo, vHi, units = null;

      // A GeoTIFF's own tags win over a world file sitting next to it. If both
      // disagree the file is the authority — the .tfw is a copy somebody made,
      // and the tags are what the grid was written with.
      if (isTiff) {
        const geo = await readGeoTiff(f).catch((e) => { throw e; });
        if (geo) { ext = geo.extent; bmp = geo.bitmap; wfFile = null; }
      }

      // An ASCII grid is VALUES, not a picture, so the picture is made here and
      // the range travels with it. That is the difference between a legend that
      // says "low to high" and one that says 54,300 to 54,900 nT.
      if (/\.asc$/.test(f.name.toLowerCase())) {
        const g = readAsciiGrid(await textOf(f), f.name);
        const pic = await bandToBitmap(g.band, g.width, g.height, null);
        bmp = pic.bitmap; vLo = pic.lo; vHi = pic.hi; units = "grid units";
        if (!pic.samples) {
          throw new Error(`${f.name} has no readings in it — every cell is NODATA.`);
        }
        // A .asc states its own corner and cell size, so it places itself and
        // needs no world file. It carries no projection, so it is read in the
        // project's grid, same as a terrain .asc.
        ext = { west: g.extent.west, south: g.extent.south,
                east: g.extent.east, north: g.extent.north };
        wfFile = null;
      }

      if (!ext) {
        if (!wfFile) {
          throw new Error(`${f.name} has no world file. Add ${stem}` +
            (isTiff ? ".tfw" : ".pgw") +
            " — six numbers saying where the grid sits — or the survey cannot be placed.");
        }
        const wf = readWorldFile(await wfFile.text(), wfFile.name);
        // Pixel dimensions come from the image itself; nothing else knows them.
        bmp = await createImageBitmap(f).catch(() => null);
        if (!bmp) {
          throw new Error(`${f.name} could not be decoded as an image. ` +
            "Export the grid as GeoTIFF, or as PNG or JPEG with its world file.");
        }
        ext = worldExtent(wf, bmp.width, bmp.height);
      }
      const prod = magProduct(f.name);
      products.push({ ...prod, file: f.name, width: bmp.width, height: bmp.height,
                      extent: ext, units: units || undefined,
                      value_low: vLo, value_high: vHi });
      bmp.close?.();
    }
    return {
      payload: { format: "orebody-geophys/1", products },
      stats: { grids: products.length, products: products.map((p) => ({ key: p.key, label: p.label })) },
      provenance: { parsed: "geophysics", georeferencing: "world file",
                    pixel_m: products[0].extent.pixel },
    };
  }
  return null;
}
