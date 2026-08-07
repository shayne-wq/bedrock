// Orebody console — loading a block model.
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

export function ingestWizard(project, onDone) {
  modal(`
    <h2>Load a block model</h2>
    <p class="sub">Read in this browser. The file is not uploaded — only the
       geometry and rollups a deck needs, which is a few megabytes.</p>
    <div class="drop" id="drop">
      <button class="btn primary" id="pick">Choose a CSV</button>
      <p>or drag it here — MineSight, Vulcan, Datamine, Surpac and Leapfrog
         exports all work</p>
      <input type="file" id="file" accept=".csv,text/csv" hidden>
    </div>
    <div class="note" style="margin-top:14px">
      A block-model export has no standard schema, so the next step shows what
      was detected and lets you correct any of it before anything is computed.
    </div>`);

  const drop = $("drop"), input = $("file");
  $("pick").onclick = () => input.click();
  input.onchange = () => { if (input.files[0]) step2(project, input.files[0], onDone); };
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault(); drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault(); drop.classList.remove("over");
  }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) step2(project, f, onDone);
  });
}

// ------------------------------------------------------- step 2: mapping ---
async function step2(project, file, onDone) {
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
      <div class="note danger">Orebody expects a CSV with one row per block and
        a header row naming the columns. If this is a binary or proprietary
        export, re-export it as CSV from your modelling package.</div>
      <div class="row-actions" style="margin-top:16px">
        <button class="btn" id="back">Choose another file</button></div>`);
    $("back").onclick = () => ingestWizard(project, onDone);
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

    <h2 style="margin-top:20px">Block size <span class="hint">inferred from the grid</span></h2>
    <div class="grid three">
      <div class="field"><label for="dx">Easting (m)</label>
        <input type="number" id="dx" step="any" value="${p.dx ?? ""}"></div>
      <div class="field"><label for="dy">Northing (m)</label>
        <input type="number" id="dy" step="any" value="${p.dy ?? ""}"></div>
      <div class="field"><label for="dz">Bench (m)</label>
        <input type="number" id="dz" step="any" value="${p.dz ?? ""}"></div>
    </div>
    <p class="hintline">Block dimensions are not written in the file — these are
      the most common spacings between block centres in the sample. Tonnage is
      meaningless if they are wrong, so check them against the technical report.</p>

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

    <div class="row-actions" style="margin-top:18px">
      <button class="btn primary" id="run">Read the model</button>
      <button class="btn" id="cancel">Cancel</button>
    </div>`);

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
    step3(project, file, {
      mapping, dx, dy, dz,
      density: denRaw === "" ? null : Number(denRaw),
      cutoff: Number($("cut").value) || 0,
    }, onDone);
  };
}

// -------------------------------------------------------- step 3: ledger ---
const line = (k, v, cls = "") =>
  `<div class="ln ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;

async function step3(project, file, cfg, onDone) {
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
    $("back").onclick = () => ingestWizard(project, onDone);
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
  $("save").onclick = () => save(project, file, out, onDone);
}

// ---------------------------------------------------------------- saving ---
async function save(project, file, out, onDone) {
  const synthetic = $("synth").checked;
  const note = $("synthnote")?.value.trim() || "";
  if (synthetic && !note) {
    return toast("Say what is fabricated about it — that label travels with every deck.", true);
  }

  const btn = $("save");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    // Path is <org>/<project>/<dataset>/… — the first segment is the tenant
    // boundary every storage policy checks.
    const id = crypto.randomUUID();
    const base = `${project.org_id}/${project.id}/${id}`;
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

    // Replace rather than accumulate: a project has one block model, and
    // leaving the previous one would leave decks silently reading stale
    // tonnages.
    const { data: old } = await db.from("datasets")
      .select("id").eq("project_id", project.id).eq("kind", "blocks");
    if (old?.length) {
      await db.from("datasets").delete().in("id", old.map((d) => d.id));
    }

    const { error } = await db.from("datasets").insert({
      project_id: project.id,
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
