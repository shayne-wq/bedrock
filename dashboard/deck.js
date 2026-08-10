// Orebody console — the deck: chapters, sharing, and who actually watched it.
//
// Three panels because they are three jobs: build the walkthrough, put it
// somewhere, find out whether it landed. The analytics panel is the one that
// justifies the embed existing at all — an IR team does not want a deck on
// their website, they want to know it was watched.

import {
  db, $, esc, fmtInt, fmtDur, fmtDate, fmtT, fmtOz,
  toast, fail, modal, closeModal, skeleton, wire,
} from "./lib/ui.js";
import { CONFIG } from "./config.js";
// Shared with the viewer: one definition of what a slide is.
import { projectCandidates, toChapter, candidateGlyph, defaultOrder } from "./lib/slides.js";

const VIEWER = "/index.html";
let deck = null, chapters = [], project = null, links = [];
let zones = [], datasets = [], candidates = [];

// The layers a chapter can turn on. Kept in one place so the editor and the
// viewer cannot drift apart on spelling.
const LAYERS = [
  ["blocks", "Block model"], ["drills", "Drill holes"], ["surfaces", "Vein surfaces"],
  ["site", "Site features"], ["highlights", "Intercept callouts"],
  ["depth", "Depth grid"], ["plan", "Plan grade map"], ["assetOnly", "Asset only"],
];

export async function renderDeck(id, view) {
  view.innerHTML = skeleton(6);

  const { data: d, error } = await db.from("decks")
    .select("id, title, subtitle, status, settings, project_id").eq("id", id).maybeSingle();
  if (error) return fail("Deck", error);
  if (!d) {
    view.innerHTML = `<div class="empty"><h3>Deck not found</h3>
      <p>It may have been deleted, or belongs to another organisation.</p>
      <a class="btn" href="#/">Back to projects</a></div>`;
    return;
  }
  deck = d;

  const [{ data: p }, { data: ch }, { data: ln }, { data: ds }] = await Promise.all([
    db.from("projects").select("id, name, org_id, commodity").eq("id", d.project_id).single(),
    db.from("chapters").select("*").eq("deck_id", id).order("ord"),
    db.from("share_links").select("*").eq("deck_id", id).order("created_at", { ascending: false }),
    db.from("datasets").select("id, zone_id, kind, synthetic, synthetic_note, stats")
      .eq("project_id", d.project_id),
  ]);
  const { data: zs } = await db.from("zones")
    .select("id, name, slug, ord").eq("project_id", d.project_id).order("ord");
  zones = zs || []; datasets = ds || [];
  // Every slide the uploaded data can justify. Proposals only — none of this
  // is written until it is dragged across.
  candidates = projectCandidates(p, zones, datasets);
  // The deck we would build if nobody touched it. Every candidate is still
  // offered; this is just the running order that reads as an argument.
  suggestion = defaultOrder(candidates, zones);
  project = p; chapters = ch || []; links = ln || [];
  const fabricated = (ds || []).filter((x) => x.synthetic);
  const blocks = (ds || []).find((x) => x.kind === "blocks");

  view.innerHTML = `
    <header class="page"><div class="row">
      <div class="grow">
        <span class="eyebrow"><a href="#/">Projects</a> /
          <a href="#/p/${project.id}">${esc(project.name)}</a></span>
        <h1 id="dtitle" contenteditable="plaintext-only"
            style="outline:none;border-bottom:1px dashed transparent"
            title="Click to rename">${esc(deck.title)}</h1>
        <!-- The subtitle is on the deck's opening card in the viewer and was
             readable everywhere and editable nowhere: set once at creation,
             then permanent. -->
        <p id="dsub" contenteditable="plaintext-only"
           style="outline:none;margin:4px 0 0;color:var(--ink-2);font-size:14px"
           data-placeholder="Add a subtitle"
           title="Click to edit">${esc(deck.subtitle || "")}</p>
      </div>
      <div class="row-actions">
        <span class="chip ${deck.status === "published" ? "live" : "draft"}"
              id="statuschip">${esc(deck.status)}</span>
        <button class="btn" id="pub">${deck.status === "published" ? "Unpublish" : "Publish"}</button>
        <button class="btn" id="preview">Preview</button>
        <a class="btn primary" href="#/s/${deck.id}"
           title="Fly the deck and save the shots you land on">Studio</a>
      </div>
    </div></header>

    ${fabricated.length ? `<div class="note warn" style="margin-bottom:16px">
      <b>Contains fabricated data.</b>
      ${esc(fabricated.map((f) => f.kind).join(", "))} —
      ${esc(fabricated[0].synthetic_note)}. Viewers see this on screen, and it is
      burned into exported images and recordings.
    </div>` : ""}

    ${blocks?.stats?.total ? `<div class="panel"><div class="grid three">
      <div class="stat"><span class="l">Tonnage</span><b>${fmtT(blocks.stats.total.tonnes)}</b></div>
      <div class="stat"><span class="l">Grade</span><b>${blocks.stats.total.grade_gt} g/t</b></div>
      <div class="stat"><span class="l">Contained</span><b>${fmtOz(blocks.stats.total.oz)}</b></div>
    </div></div>` : ""}

    <div class="panel">
      <div class="row"><h2 class="grow">Build the deck</h2>
        <span class="hint">${candidates.length} slides available from your data</span></div>
      <p class="lead" style="margin:0 0 12px">The suggested order is an argument:
         the ground, what is under it, what was drilled, what it hit, what it
         adds up to, and how well it is known. Everything else your data
         supports is in the tray. Nothing is saved until you press Save order.</p>
      <div class="row-actions" style="margin:0 0 14px">
        <button class="btn primary" id="suggest">Use the suggested order
          (${suggestion.order.length} slide${suggestion.order.length === 1 ? "" : "s"})</button>
        ${suggestion.dropped ? `<span class="hint">${suggestion.dropped} more
           would have made it too long for one sitting — they are in the tray.</span>` : ""}
      </div>
      <div class="builder">
        <div class="bcol">
          <h3>More slides <span class="hint" id="poolcount"></span></h3>
          <div id="pool" class="droplist"></div>
        </div>
        <div class="bcol">
          <h3>Running order <span class="hint" id="ordercount"></span></h3>
          <div id="order" class="droplist running"></div>
          <div class="row-actions" style="margin-top:12px">
            <button class="btn primary" id="saveorder">Save order</button>
            <button class="btn" id="addch">Add blank chapter</button>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <h2>Sharing</h2>
      <div id="shares"></div>
      <div class="row-actions" style="margin-top:14px">
        <button class="btn primary" id="newlink">Create a share link</button>
      </div>
    </div>

    <div class="panel">
      <h2>Audience <span class="hint">last 30 days</span></h2>
      <div id="analytics">${skeleton(3)}</div>
    </div>`;

  wire(view);
  renderChapters();
  renderShares();
  renderAnalytics();

  // Saved on blur, like the title, rather than per keystroke.
  $("dsub").onblur = async () => {
    const v = $("dsub").textContent.trim();
    if (v === (deck.subtitle || "")) return;
    const { error } = await db.from("decks")
      .update({ subtitle: v || null }).eq("id", deck.id);
    if (error) return fail("Save subtitle", error);
    deck.subtitle = v || null;
    toast("Subtitle saved");
  };

  $("preview").onclick = () => {
    const t = links.find((l) => !l.revoked_at);
    // Preview through a real share token when one exists, so what the author
    // checks is exactly what a recipient gets rather than a privileged view.
    window.open(t ? `${VIEWER}?t=${encodeURIComponent(t.token)}` : `${VIEWER}?deck=${deck.id}`,
                "_blank", "noopener");
  };

  $("pub").onclick = async () => {
    const next = deck.status === "published" ? "draft" : "published";
    const { error: e2 } = await db.from("decks").update({ status: next }).eq("id", deck.id);
    if (e2) return fail("Publish", e2);
    deck.status = next;
    $("statuschip").textContent = next;
    $("statuschip").className = `chip ${next === "published" ? "live" : "draft"}`;
    $("pub").textContent = next === "published" ? "Unpublish" : "Publish";
    toast(next === "published" ? "Deck published" : "Deck unpublished");
  };

  const title = $("dtitle");
  const saveTitle = async () => {
    const t = title.textContent.trim();
    if (!t || t === deck.title) { title.textContent = deck.title; return; }
    const { error: e2 } = await db.from("decks").update({ title: t }).eq("id", deck.id);
    if (e2) return fail("Rename", e2);
    deck.title = t;
    toast("Renamed");
  };
  title.onblur = saveTitle;
  title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } };

  $("addch").onclick = addChapter;
  $("newlink").onclick = newLink;

  // Seed the running order from what the deck already holds, matching saved
  // chapters back to candidates by title so re-opening the builder shows the
  // deck as it stands rather than an empty column beside a full pool.
  // An entry is either a chapter that already exists — carrying whatever the
  // studio authored into it — or a candidate that does not exist yet. Matching
  // by TITLE, which is what this did, broke the instant anybody renamed a
  // slide: the chapter fell out of the running order and the next save deleted
  // it as though it had been removed.
  seedOrder();
  paintBuilder();
  $("saveorder").onclick = (e) => saveOrder(e.currentTarget);
  $("suggest").onclick = useSuggested;
}

// --------------------------------------------------------------- builder ---
// TRACKING.md #10. Two columns and HTML5 drag-and-drop: the pool of what the
// data supports, and the running order. Deliberately not a modal wizard — the
// point is to see everything available at once and pick, which is the part a
// blank "Add chapter" button cannot do.
//
// The running order is the source of truth for `ord`; the pool hides whatever
// is already in it, matched on the candidate's stable id so re-opening the
// page does not offer duplicates of slides already chosen.
let order = [];      // entries, in presentation order
let suggestion = { order: [], dropped: 0, extra: 0 };

// Rebuild the running order from what is actually in the database. Called
// after every write as well as on load: leaving the pre-save entries in place
// would keep the newly inserted ones marked as not-yet-existing, and pressing
// Save order a second time would insert them all again.
function seedOrder() {
  order = chapters.map((c) => ({
    key: "ch:" + c.id, chapterId: c.id, row: c,
    cand: c.source ? candidates.find((x) => x.id === c.source) || null : null,
  }));
}

// What an entry displays as, whichever of the two it is.
const face = (o) => o.row || o.cand || {};

function cardHtml(o, inOrder) {
  const c = face(o);
  // "Authored" is worth surfacing: it is the difference between a slide that
  // still is whatever the generator proposed and one somebody flew to and set,
  // and removing the second kind costs work the first does not.
  const authored = o.row && o.row.camera && Object.keys(o.row.camera).length &&
                   o.cand && JSON.stringify(o.row.camera) !== JSON.stringify(o.cand.camera);
  return `<div class="scard" draggable="true" data-cid="${esc(o.key)}">
    <span class="sglyph">${candidateGlyph(c)}</span>
    <div class="grow">
      <b>${esc(c.title || "Untitled")}${authored ? ` <i class="tagline">set</i>` : ""}</b>
      <span class="ssec">${esc(c.section || "")}</span>
      <span class="sbody">${esc(c.body || "")}</span>
    </div>
    <button class="btn sm ${inOrder ? "danger" : ""}" data-toggle="${esc(o.key)}"
      title="${inOrder ? "Remove from the deck" : "Add to the deck"}">${inOrder ? "Remove" : "Add"}</button>
  </div>`;
}

// Candidates not already represented in the running order, as entries.
function poolEntries() {
  const used = new Set(order.map((o) => o.cand?.id).filter(Boolean));
  return candidates.filter((c) => !used.has(c.id))
    .map((c) => ({ key: "cd:" + c.id, chapterId: null, row: null, cand: c }));
}

function paintBuilder() {
  const pool = poolEntries();
  $("pool").innerHTML = pool.length
    ? pool.map((o) => cardHtml(o, false)).join("")
    : `<div class="empty sm"><p>Every available slide is in the deck.</p></div>`;
  $("order").innerHTML = order.length
    ? order.map((o) => cardHtml(o, true)).join("")
    : `<div class="empty sm"><p>Nothing in the running order yet.</p></div>`;
  $("poolcount").textContent = `${pool.length}`;
  $("ordercount").textContent = `${order.length}`;
  const s = $("suggest");
  if (s) s.disabled = !suggestion.order.length;
  wireDrag();
}

// Fill the running order with the suggested deck. Additive: anything already
// in the order stays where it is, so pressing this on a deck someone has
// worked on tops it up rather than throwing their work away.
function useSuggested() {
  const have = new Set(order.map((o) => o.cand?.id).filter(Boolean));
  const add = suggestion.order.filter((c) => !have.has(c.id))
    .map((c) => ({ key: "cd:" + c.id, chapterId: null, row: null, cand: c }));
  if (!add.length) { toast("The suggested slides are already in the deck"); return; }
  // Insert each where the suggestion puts it relative to what is already here,
  // rather than appending a block to the end.
  const rank = new Map(suggestion.order.map((c, i) => [c.id, i]));
  order = [...order, ...add].sort((a, b) => {
    const A = rank.has(a.cand?.id) ? rank.get(a.cand.id) : Infinity;
    const B = rank.has(b.cand?.id) ? rank.get(b.cand.id) : Infinity;
    return A - B;
  });
  paintBuilder();
  toast(`Added ${add.length} slide${add.length === 1 ? "" : "s"} — press Save order to keep them`);
}

function wireDrag() {
  let dragId = null;
  const entry = (key) => order.find((o) => o.key === key) ||
                         poolEntries().find((o) => o.key === key);
  document.querySelectorAll(".scard").forEach((el) => {
    el.ondragstart = (e) => {
      dragId = el.dataset.cid;
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag without payload.
      e.dataTransfer.setData("text/plain", dragId);
      el.classList.add("dragging");
    };
    el.ondragend = () => { dragId = null; el.classList.remove("dragging"); };
  });
  document.querySelectorAll(".droplist").forEach((list) => {
    list.ondragover = (e) => {
      e.preventDefault();
      list.classList.add("over");
      // Insert relative to whichever card the pointer is over, so dropping is
      // positional rather than always appending.
      const after = [...list.querySelectorAll(".scard:not(.dragging)")]
        .find((el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
      list.dataset.beforeId = after ? after.dataset.cid : "";
    };
    list.ondragleave = () => list.classList.remove("over");
    list.ondrop = (e) => {
      e.preventDefault(); list.classList.remove("over");
      const id = dragId || e.dataTransfer.getData("text/plain");
      if (!id) return;
      const o = entry(id);
      if (!o) return;
      order = order.filter((x) => x.key !== id);
      if (list.id === "order") {
        const before = list.dataset.beforeId;
        const at = before ? order.findIndex((x) => x.key === before) : -1;
        if (at >= 0) order.splice(at, 0, o); else order.push(o);
      }
      paintBuilder();
    };
  });
  document.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.toggle;
      if (order.some((x) => x.key === id)) order = order.filter((x) => x.key !== id);
      else { const o = poolEntries().find((x) => x.key === id); if (o) order.push(o); }
      paintBuilder();
    };
  });
}

async function saveOrder(btn) {
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    // Reconcile. This used to delete every chapter and re-insert from the
    // candidate template, which was defensible when a chapter was nothing but
    // a copy of its candidate — and became data loss the moment the studio
    // existed. A camera someone flew to, a title they rewrote, the body they
    // corrected: all of it lived only in the chapter row, and Save order threw
    // it away and put the generator's defaults back.
    const keep = new Set(order.filter((o) => o.chapterId).map((o) => o.chapterId));
    const gone = chapters.filter((c) => !keep.has(c.id)).map((c) => c.id);

    // Deletes first, so their ords are free before anything moves into them.
    if (gone.length) {
      const { error } = await db.from("chapters").delete().in("id", gone);
      if (error) throw error;
    }

    // Kept chapters, renumbered in ONE upsert. `unique (deck_id, ord)` is
    // deferrable initially deferred, so a single statement can shuffle them
    // past each other; renumbering one row at a time would collide the moment
    // a slide moved earlier in the deck.
    const moves = [];
    order.forEach((o, i) => {
      if (!o.chapterId) return;
      if (o.row.ord !== i) moves.push({ ...o.row, ord: i });
    });
    if (moves.length) {
      const { error } = await db.from("chapters").upsert(moves);
      if (error) throw error;
    }

    const fresh = [];
    order.forEach((o, i) => {
      if (o.chapterId) return;
      fresh.push({ deck_id: deck.id, ...toChapter(o.cand, i) });
    });
    if (fresh.length) {
      const { error } = await db.from("chapters").insert(fresh);
      if (error) throw error;
    }

    await reloadChapters();
    toast(`Saved ${order.length} chapter${order.length === 1 ? "" : "s"}` +
          (gone.length ? ` · ${gone.length} removed` : ""));
  } catch (e) { fail("Save order", e); }
  btn.disabled = false; btn.textContent = "Save order";
}

// -------------------------------------------------------------- chapters ---
function renderChapters() {
  // The builder replaced the flat chapter list, so #chlist is gone on this
  // page. Without this guard the null deref threw partway through render and
  // took every later line with it — including the builder's own wiring — and
  // route()'s catch turned a broken page into a toast nobody reads.
  if (!$("chlist")) return;
  const el = $("chlist");
  if (!chapters.length) {
    el.innerHTML = `<div class="empty"><h3>No chapters</h3>
      <p>A chapter is one camera position and one set of layers. Together they
         are the walkthrough.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="tablewrap"><table>
    <thead><tr><th class="n">#</th><th>Section</th><th>Title</th>
      <th class="n">Dwell</th><th>Layers</th><th></th></tr></thead>
    <tbody>${chapters.map((c, i) => `<tr>
      <td class="n mono">${i + 1}</td>
      <td>${esc(c.section || "—")}</td>
      <td><b>${esc(c.title || "Untitled")}</b></td>
      <td class="n mono">${Math.round((c.dwell_ms || 0) / 1000)}s</td>
      <td>${Object.entries(c.layers || {}).filter(([, v]) => v)
            .map(([k]) => `<span class="chip">${esc(k)}</span>`).join(" ") || "—"}</td>
      <td class="n"><div class="row-actions" style="justify-content:flex-end">
        <button class="btn sm" data-up="${c.id}" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="btn sm" data-down="${c.id}" ${i === chapters.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn sm" data-edit="${c.id}">Edit</button>
        <button class="btn sm danger" data-rm="${c.id}">Delete</button>
      </div></td>
    </tr>`).join("")}</tbody></table></div>`;

  el.querySelectorAll("[data-up]").forEach((b) =>
    b.onclick = () => move(b.dataset.up, -1));
  el.querySelectorAll("[data-down]").forEach((b) =>
    b.onclick = () => move(b.dataset.down, 1));
  el.querySelectorAll("[data-edit]").forEach((b) =>
    b.onclick = () => editChapter(chapters.find((c) => c.id === b.dataset.edit)));
  el.querySelectorAll("[data-rm]").forEach((b) =>
    b.onclick = async () => {
      if (!confirm("Delete this chapter?")) return;
      const { error } = await db.from("chapters").delete().eq("id", b.dataset.rm);
      if (error) return fail("Delete", error);
      chapters = chapters.filter((c) => c.id !== b.dataset.rm);
      await renumber();
      renderChapters();
      toast("Chapter deleted");
    });
}

/** Reordering swaps two `ord` values. The unique constraint on (deck_id, ord)
 *  is DEFERRABLE precisely so both sides of a swap can be written before it is
 *  checked — without that, every reorder would need a temporary hole. */
async function move(id, dir) {
  const i = chapters.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= chapters.length) return;
  const a = chapters[i], b = chapters[j];
  [chapters[i], chapters[j]] = [b, a];
  const { error } = await db.from("chapters").upsert([
    { id: a.id, deck_id: deck.id, ord: j },
    { id: b.id, deck_id: deck.id, ord: i },
  ]);
  if (error) { await reloadChapters(); return fail("Reorder", error); }
  a.ord = j; b.ord = i;
  renderChapters();
}

async function renumber() {
  const rows = chapters.map((c, i) => ({ id: c.id, deck_id: deck.id, ord: i }));
  if (!rows.length) return;
  const { error } = await db.from("chapters").upsert(rows);
  if (error) fail("Renumber", error);
  else chapters.forEach((c, i) => { c.ord = i; });
}

async function reloadChapters() {
  const { data } = await db.from("chapters").select("*").eq("deck_id", deck.id).order("ord");
  chapters = data || [];
  seedOrder();
  renderChapters();
  paintBuilder();
}

async function addChapter() {
  const ord = chapters.length;
  const { data, error } = await db.from("chapters").insert({
    deck_id: deck.id, ord, kind: "scene",
    section: chapters[ord - 1]?.section || "Overview",
    title: "New chapter", body: "",
    camera: chapters[ord - 1]?.camera || {},
    layers: chapters[ord - 1]?.layers || { blocks: true },
  }).select("*").single();
  if (error) return fail("Add chapter", error);
  chapters.push(data);
  renderChapters();
  editChapter(data);
}

function editChapter(c) {
  if (!c) return;
  const cam = c.camera || {};
  modal(`
    <h2>Chapter ${c.ord + 1}</h2>
    <p class="sub">What the camera looks at, and what is switched on when it
       gets there.</p>

    <div class="grid two">
      <div class="field"><label for="csec">Section</label>
        <input type="text" id="csec" value="${esc(c.section || "")}"
               placeholder="The deposit"></div>
      <div class="field"><label for="cdwell">Dwell on autoplay (seconds)</label>
        <input type="number" id="cdwell" min="1" max="120"
               value="${Math.round((c.dwell_ms || 9000) / 1000)}"></div>
    </div>
    <div class="field"><label for="ctitle">Title</label>
      <input type="text" id="ctitle" value="${esc(c.title || "")}"></div>
    <div class="field"><label for="cbody">Narration</label>
      <textarea id="cbody" rows="3"
        placeholder="Read aloud when narration is on, and shown as the caption.">${esc(c.body || "")}</textarea></div>

    <h2 style="margin-top:18px">Layers</h2>
    <div class="grid two">${LAYERS.map(([k, label]) => `
      <div class="checkline">
        <input type="checkbox" id="ly_${k}" ${c.layers?.[k] ? "checked" : ""}>
        <label for="ly_${k}" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;font-family:var(--sans);color:var(--ink-2)">${label}</label>
      </div>`).join("")}</div>

    <h2 style="margin-top:18px">Camera</h2>
    ${cam.mode === "free" ? `
      <p class="hintline">This slide uses an <b>absolute</b> camera — a fixed
         position rather than an angle on the deposit. Those are set in the
         <a href="#/s/${deck.id}">studio</a>, by flying there. Editing it here
         would mean typing a latitude.</p>
      <div class="grid three">
        <div class="stat"><span class="l">Position</span>
          <b class="mono">${esc(String(cam.lat))}, ${esc(String(cam.lon))}</b></div>
        <div class="stat"><span class="l">Height</span><b>${esc(String(cam.height))} m</b></div>
        <div class="stat"><span class="l">Look</span>
          <b>${esc(String(cam.heading))}° / ${esc(String(cam.pitch))}°</b></div>
      </div>` : `
      <p class="hintline">Heading, pitch and range — an angle on the deposit
         centre, which is the shape the viewer replays. Rather than typing them,
         fly to the shot in the <a href="#/s/${deck.id}">studio</a> and press
         <b>Set view</b>.</p>
      <div class="grid three">
        <div class="field"><label for="chd">Heading (°)</label>
          <input type="number" id="chd" step="any" value="${cam.h ?? 30}"></div>
        <div class="field"><label for="cpt">Pitch (°)</label>
          <input type="number" id="cpt" step="any" value="${cam.p ?? -26}"></div>
        <div class="field"><label for="crg">Range (m)</label>
          <input type="number" id="crg" step="any" value="${cam.r ?? 3000}"></div>
      </div>
      <div class="field"><label for="cpaste">Paste a captured camera</label>
        <input type="text" id="cpaste" placeholder='{"h":38,"p":-24,"r":1900}'></div>`}

    <div class="row-actions" style="margin-top:18px">
      <button class="btn primary" id="csave">Save chapter</button>
      <button class="btn" id="ccancel">Cancel</button>
    </div>`);

  $("ccancel").onclick = closeModal;
  if ($("cpaste")) $("cpaste").oninput = () => {
    try {
      const v = JSON.parse($("cpaste").value);
      for (const [k, id] of [["h", "chd"], ["p", "cpt"], ["r", "crg"]]) {
        if (v[k] !== undefined) $(id).value = v[k];
      }
      toast("Camera pasted");
    } catch { /* still typing */ }
  };
  $("csave").onclick = async () => {
    const layers = {};
    for (const [k] of LAYERS) if ($(`ly_${k}`).checked) layers[k] = true;
    const numOrNull = (id) => {
      const v = $(id).value.trim();
      return v === "" ? undefined : Number(v);
    };
    // A free camera has no editable fields here, so keep the one that is
    // stored rather than replacing it with an empty object. Opening a slide's
    // settings to change its dwell must not silently throw away its camera.
    let camera = c.camera || {};
    if (camera.mode !== "free") {
      camera = {};
      for (const [k, id] of [["h", "chd"], ["p", "cpt"], ["r", "crg"]]) {
        const v = numOrNull(id);
        if (v !== undefined && Number.isFinite(v)) camera[k] = v;
      }
    }
    const patch = {
      section: $("csec").value.trim() || null,
      title: $("ctitle").value.trim() || null,
      body: $("cbody").value.trim() || null,
      dwell_ms: Math.min(120, Math.max(1, Number($("cdwell").value) || 9)) * 1000,
      layers, camera,
    };
    const { error } = await db.from("chapters").update(patch).eq("id", c.id);
    if (error) return fail("Save chapter", error);
    Object.assign(c, patch);
    closeModal();
    renderChapters();
    toast("Chapter saved");
  };
}

// ---------------------------------------------------------------- sharing --
function shareUrl(token, embed) {
  const base = location.origin + VIEWER;
  // The viewer is a static file with no idea which Supabase project it belongs
  // to, so the share link carries it. Without this an embedded deck renders
  // perfectly and reports nothing, and the Audience panel stays empty for the
  // one case it exists to measure.
  const api = `${CONFIG.url.replace(/\/$/, "")}/functions/v1`;
  return `${base}?t=${encodeURIComponent(token)}` +
         `&api=${encodeURIComponent(api)}${embed ? "&embed=1" : ""}`;
}

function renderShares() {
  const el = $("shares");
  if (!links.length) {
    el.innerHTML = `<div class="empty"><h3>Not shared yet</h3>
      <p>A share link is what you send, and what an embed on your website points
         at. Each one can be revoked on its own.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="tablewrap"><table>
    <thead><tr><th>Label</th><th>Status</th><th>Restrictions</th>
      <th class="n">Created</th><th></th></tr></thead>
    <tbody>${links.map((l) => {
      const dead = l.revoked_at ||
        (l.expires_at && new Date(l.expires_at) < new Date());
      const bits = [];
      if (l.passcode_hash) bits.push("passcode");
      if (l.expires_at) bits.push("expires " + fmtDate(l.expires_at));
      if (l.domains?.length) bits.push(l.domains.join(", "));
      if (!l.allow_embed) bits.push("no embedding");
      return `<tr>
        <td><b>${esc(l.label || "Untitled link")}</b></td>
        <td><span class="chip ${dead ? "danger" : "live"}">${
          l.revoked_at ? "revoked" : dead ? "expired" : "live"}</span></td>
        <td>${bits.length ? esc(bits.join(" · ")) : "none"}</td>
        <td class="n mono">${fmtDate(l.created_at)}</td>
        <td class="n"><div class="row-actions" style="justify-content:flex-end">
          <button class="btn sm" data-copy="${esc(l.token)}" ${dead ? "disabled" : ""}>Copy link</button>
          <button class="btn sm" data-embed="${esc(l.token)}" ${dead || !l.allow_embed ? "disabled" : ""}>Embed</button>
          ${l.revoked_at ? "" : `<button class="btn sm danger" data-rev="${l.id}">Revoke</button>`}
        </div></td></tr>`;
    }).join("")}</tbody></table></div>`;

  el.querySelectorAll("[data-copy]").forEach((b) =>
    b.onclick = () => navigator.clipboard.writeText(shareUrl(b.dataset.copy, false))
      .then(() => toast("Link copied"), () => toast("Copy failed", true)));
  el.querySelectorAll("[data-embed]").forEach((b) =>
    b.onclick = () => embedSnippet(b.dataset.embed));
  el.querySelectorAll("[data-rev]").forEach((b) =>
    b.onclick = async () => {
      if (!confirm("Revoke this link? Anywhere it is embedded will stop working.")) return;
      const { error } = await db.from("share_links")
        .update({ revoked_at: new Date().toISOString() }).eq("id", b.dataset.rev);
      if (error) return fail("Revoke", error);
      const l = links.find((x) => x.id === b.dataset.rev);
      if (l) l.revoked_at = new Date().toISOString();
      renderShares();
      toast("Link revoked");
    });
}

function newLink() {
  modal(`
    <h2>New share link</h2>
    <p class="sub">Each link is revocable on its own, so you can put one on your
       website and email another without them sharing a fate.</p>
    <div class="field"><label for="ll">Label</label>
      <input type="text" id="ll" placeholder="Investor relations page"></div>
    <div class="grid two">
      <div class="field"><label for="lx">Expires on</label>
        <input type="date" id="lx"><p class="hintline">Leave empty for no expiry.</p></div>
      <div class="field"><label for="lp">Passcode</label>
        <input type="text" id="lp" placeholder="Optional">
        <p class="hintline">Asked for before the deck loads.</p></div>
    </div>
    <div class="checkline">
      <input type="checkbox" id="le" checked>
      <label for="le" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;font-family:var(--sans);color:var(--ink-2)">Allow embedding on a website</label>
    </div>
    <div class="field"><label for="ld">Restrict to domains</label>
      <input type="text" id="ld" placeholder="ir.company.com, company.com">
      <p class="hintline">Comma separated, subdomains included. Be aware this is
        a deterrent rather than a guarantee: a browser tells us the embedding
        page only via a value the page itself controls. Expiry, a passcode and
        revoking are the controls that actually hold.</p></div>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn primary" id="lgo">Create link</button>
      <button class="btn" id="lcancel">Cancel</button>
    </div>`);
  $("lcancel").onclick = closeModal;
  $("lgo").onclick = async () => {
    const pass = $("lp").value.trim();
    const row = {
      deck_id: deck.id,
      label: $("ll").value.trim() || null,
      expires_at: $("lx").value ? new Date($("lx").value + "T23:59:59").toISOString() : null,
      allow_embed: $("le").checked,
      domains: $("ld").value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    };
    const { data, error } = await db.from("share_links").insert(row).select("*").single();
    if (error) return fail("Create link", error);

    // The passcode is hashed against the token, which the database generates —
    // so it can only be computed after the row exists.
    if (pass) {
      const buf = await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(`${data.token}:${pass}`));
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const { error: e2 } = await db.from("share_links")
        .update({ passcode_hash: hex }).eq("id", data.id);
      if (e2) return fail("Set passcode", e2);
      data.passcode_hash = hex;
    }
    links.unshift(data);
    closeModal();
    renderShares();
    toast("Share link created");
  };
}

function embedSnippet(token) {
  const link = links.find((l) => l.token === token) || {};
  const src = shareUrl(token, true);        // carries embed=1, for attribution
  const plain = shareUrl(token, false);     // no embed flag, for openers
  const snippet =
`<!-- ${deck.title} -->
<div style="position:relative;width:100%;padding-top:56.25%;border-radius:6px;overflow:hidden;background:#07090A">
  <iframe src="${src}"
    title="${deck.title}" loading="lazy" allowfullscreen
    style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>
</div>`;

  // Each of these wants a different artifact, and handing everyone the same
  // iframe is why "embed it on our site" turns into a support thread. Wix's
  // element takes a URL, not HTML. PowerPoint's add-in takes a URL. Google
  // Slides takes neither, because it cannot embed live web content at all —
  // which is a fact about Google Slides and is said here rather than left for
  // somebody to discover ten minutes before a meeting.
  const TABS = [
    ["web", "WordPress · Elementor · Squarespace"],
    ["url", "Wix · Notion · Confluence"],
    ["ppt", "PowerPoint"],
    ["gs", "Google Slides"],
  ];

  const codeBox = (t) => `<pre class="snip">${esc(t)}</pre>`;

  const panes = {
    web: `
      <p class="sub">Paste into a <b>WordPress Custom HTML block</b>, an
         <b>Elementor HTML widget</b>, or a <b>Squarespace Code block</b>.
         It keeps a 16:9 shape at any width.</p>
      ${codeBox(snippet)}
      <button class="btn primary" data-copy-text="${esc(snippet)}">Copy the snippet</button>
      <div class="note" style="margin-top:12px">If the iframe disappears when you
        save, your host is stripping HTML — that is WordPress.com on the lower
        plans, and some security plugins. Use the URL on the next tab with an
        “Embed” block instead.</div>`,
    url: `
      <p class="sub">These take a <b>URL</b>, not markup. In Wix add
         <b>Embed → Embed a Site</b>; in Notion paste the link and choose
         <b>Embed</b>; in Confluence use the <b>iframe</b> macro.</p>
      ${codeBox(src)}
      <button class="btn primary" data-copy-text="${esc(src)}">Copy the URL</button>`,
    ppt: `
      <p class="sub">Two ways, and they are for different rooms.</p>
      <h3 style="margin:14px 0 6px">Live, inside the slide</h3>
      <p class="sub">Insert → Get Add-ins → search <b>Web Viewer</b> → add it to
         a slide and paste this URL. It is a real 3D deck on the slide, and it
         needs an internet connection at the moment you present.</p>
      ${codeBox(src)}
      <button class="btn" data-copy-text="${esc(src)}">Copy the URL</button>
      <h3 style="margin:18px 0 6px">Static, with a way back</h3>
      <p class="sub">Open the deck, press <b>Explore → PPTX</b>. You get one
         slide per chapter as a rendered image with its caption and figures, and
         every slide links back to the live deck. That is the one to send, and
         the one that survives a room with no wifi.</p>
      <a class="btn" href="${esc(plain)}" target="_blank" rel="noopener">Open the deck</a>`,
    gs: `
      <p class="sub"><b>Google Slides cannot embed live web content.</b> There is
         no iframe, no add-in equivalent to Web Viewer, and nothing we can ship
         that changes it. So the route is the export:</p>
      <ol class="steps">
        <li>Open the deck and press <b>Explore → PPTX</b>.</li>
        <li>In Google Slides: <b>File → Import slides</b>, upload the .pptx,
            select all.</li>
        <li>Every slide keeps its link back to the live deck, so clicking one in
            presentation mode opens the 3D in a browser tab.</li>
      </ol>
      <p class="sub">If you want the model actually moving inside Slides, the
         only thing that works is video: record a flythrough with <b>REC</b> in
         the viewer, upload it to Drive, and insert it as a video.</p>
      <a class="btn" href="${esc(plain)}" target="_blank" rel="noopener">Open the deck</a>`,
  };

  modal(`
    <h2>Embed this deck</h2>
    ${!link.allow_embed ? `<div class="note warn" style="margin-bottom:12px">
      <b>This link does not permit embedding.</b> It will load on its own page
      but refuse to run in a frame, so the snippet below would show an error.
      Create a link with embedding allowed, or turn it on for this one.</div>` : ""}
    ${link.domains?.length ? `<div class="note" style="margin-bottom:12px">
      Restricted to <b>${esc(link.domains.join(", "))}</b>. Embedded anywhere
      else it refuses to load.</div>` : ""}
    <div class="tabs" id="etabs">${TABS.map(([k, label], i) =>
      `<button class="tab ${i ? "" : "on"}" data-tab="${k}">${esc(label)}</button>`).join("")}</div>
    <div id="epane">${panes.web}</div>
    <div class="note" style="margin-top:14px">Every one of these links rather
      than copies, so republishing updates each place it appears. Views arrive
      under <b>Audience</b>, split by which page they came from.</div>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn" id="cdone">Close</button>
    </div>`);

  const wireCopies = () => {
    document.querySelectorAll("[data-copy-text]").forEach((b) =>
      b.onclick = () => navigator.clipboard.writeText(b.dataset.copyText)
        .then(() => toast("Copied"), () => toast("Copy failed", true)));
  };
  wireCopies();
  $("cdone").onclick = closeModal;
  document.querySelectorAll("#etabs .tab").forEach((b) =>
    b.onclick = () => {
      document.querySelectorAll("#etabs .tab").forEach((x) => x.classList.toggle("on", x === b));
      $("epane").innerHTML = panes[b.dataset.tab];
      wireCopies();
    });
}

// ------------------------------------------------------------- analytics ---
async function renderAnalytics() {
  const el = $("analytics");
  const [{ data: sum, error: e1 }, { data: funnel }, { data: refs }, { data: daily }] =
    await Promise.all([
      db.rpc("deck_summary", { p_deck: deck.id }),
      db.rpc("deck_chapter_funnel", { p_deck: deck.id }),
      db.rpc("deck_referrers", { p_deck: deck.id }),
      db.rpc("deck_daily", { p_deck: deck.id }),
    ]);
  if (e1) return fail("Analytics", e1);

  const s = sum?.[0] || { sessions: 0, embed_sessions: 0, completions: 0,
                          median_watch_ms: 0, total_watch_ms: 0, avg_chapters: 0 };
  if (!Number(s.sessions)) {
    el.innerHTML = `<div class="empty">
      <h3>Nobody has opened this yet</h3>
      <p>Once the deck is shared or embedded, this shows how many people watched,
         how long they stayed, which chapter lost them, and which website they
         came from.</p></div>`;
    return;
  }

  const maxReach = Math.max(1, ...(funnel || []).map((f) => Number(f.reached)));
  const maxDay = Math.max(1, ...(daily || []).map((d) => Number(d.sessions)));
  const titleOf = (ord) => chapters.find((c) => c.ord === ord)?.title || `Chapter ${ord + 1}`;

  el.innerHTML = `
    <div class="grid three" style="margin-bottom:20px">
      <div class="stat"><span class="l">Sessions</span><b>${fmtInt(s.sessions)}</b>
        <span class="sub">${fmtInt(s.embed_sessions)} from embeds</span></div>
      <div class="stat"><span class="l">Median watch</span><b>${fmtDur(s.median_watch_ms)}</b>
        <span class="sub">${fmtDur(s.total_watch_ms)} in total</span></div>
      <div class="stat"><span class="l">Reached the end</span>
        <b>${Math.round((Number(s.completions) / Number(s.sessions)) * 100)}%</b>
        <span class="sub">${fmtInt(s.completions)} of ${fmtInt(s.sessions)}</span></div>
    </div>

    ${daily?.length ? `<div style="margin-bottom:22px">
      <div class="eyebrow" style="margin-bottom:7px">Sessions per day</div>
      <div class="spark">${daily.map((d) =>
        `<i style="height:${(Number(d.sessions) / maxDay) * 100}%"
            title="${fmtDate(d.day)} — ${d.sessions} sessions"></i>`).join("")}</div>
    </div>` : ""}

    ${funnel?.length ? `<div style="margin-bottom:22px">
      <div class="eyebrow" style="margin-bottom:9px">Where attention went</div>
      <div class="funnel">${funnel.map((f) => `
        <div class="f">
          <span class="o">${Number(f.chapter_ord) + 1}</span>
          <div class="track">
            <i style="width:${(Number(f.reached) / maxReach) * 100}%"></i>
            <span>${esc(titleOf(Number(f.chapter_ord)))}</span>
          </div>
          <span class="m">${fmtInt(f.reached)} · ${fmtDur(f.median_dwell_ms)}</span>
        </div>`).join("")}</div>
      <p class="hintline">Sessions that reached each chapter, and how long they
         stayed. A sharp drop is where the deck lost the room.</p>
    </div>` : ""}

    ${refs?.length ? `<div>
      <div class="eyebrow" style="margin-bottom:9px">Where they watched it</div>
      <div class="tablewrap"><table>
        <thead><tr><th>Website</th><th class="n">Sessions</th><th class="n">Watch time</th></tr></thead>
        <tbody>${refs.map((r) => `<tr>
          <td>${esc(r.referrer_host)}</td>
          <td class="n mono">${fmtInt(r.sessions)}</td>
          <td class="n mono">${fmtDur(r.watch_ms)}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>` : ""}

    <p class="hintline" style="margin-top:16px">No IP addresses, cookies or
      cross-site identifiers are collected — a country is derived at the edge and
      the address discarded. These are engagement figures for your own use, not
      audited numbers: anyone holding a share link could inflate them.</p>`;
}
