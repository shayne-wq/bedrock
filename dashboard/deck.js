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

const VIEWER = "/index.html";
let deck = null, chapters = [], project = null, links = [];

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
    db.from("datasets").select("kind, synthetic, synthetic_note, stats")
      .eq("project_id", d.project_id),
  ]);
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
      </div>
      <div class="row-actions">
        <span class="chip ${deck.status === "published" ? "live" : "draft"}"
              id="statuschip">${esc(deck.status)}</span>
        <button class="btn" id="pub">${deck.status === "published" ? "Unpublish" : "Publish"}</button>
        <button class="btn primary" id="preview">Preview</button>
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
      <h2>Chapters <span class="hint">${chapters.length} in order</span></h2>
      <div id="chlist"></div>
      <div class="row-actions" style="margin-top:14px">
        <button class="btn" id="addch">Add chapter</button>
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
}

// -------------------------------------------------------------- chapters ---
function renderChapters() {
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
  renderChapters();
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
    <div class="grid three">
      <div class="field"><label for="clon">Longitude</label>
        <input type="number" id="clon" step="any" value="${cam.lon ?? ""}"></div>
      <div class="field"><label for="clat">Latitude</label>
        <input type="number" id="clat" step="any" value="${cam.lat ?? ""}"></div>
      <div class="field"><label for="ch">Height (m)</label>
        <input type="number" id="ch" step="any" value="${cam.h ?? ""}"></div>
      <div class="field"><label for="chead">Heading (°)</label>
        <input type="number" id="chead" step="any" value="${cam.heading ?? ""}"></div>
      <div class="field"><label for="cpitch">Pitch (°)</label>
        <input type="number" id="cpitch" step="any" value="${cam.pitch ?? ""}"></div>
    </div>
    <p class="hintline">Rather than typing these, open the preview, fly to the
       view you want and press <b>C</b> — it copies the camera to your clipboard
       in this shape. Paste it below.</p>
    <div class="field"><label for="cpaste">Paste a captured camera</label>
      <input type="text" id="cpaste" placeholder='{"lon":-120.5,"lat":49.6,"h":1500,…}'></div>

    <div class="row-actions" style="margin-top:18px">
      <button class="btn primary" id="csave">Save chapter</button>
      <button class="btn" id="ccancel">Cancel</button>
    </div>`);

  $("ccancel").onclick = closeModal;
  $("cpaste").oninput = () => {
    try {
      const v = JSON.parse($("cpaste").value);
      for (const [k, id] of [["lon", "clon"], ["lat", "clat"], ["h", "ch"],
                             ["heading", "chead"], ["pitch", "cpitch"]]) {
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
    const camera = {};
    for (const [k, id] of [["lon", "clon"], ["lat", "clat"], ["h", "ch"],
                           ["heading", "chead"], ["pitch", "cpitch"]]) {
      const v = numOrNull(id);
      if (v !== undefined && Number.isFinite(v)) camera[k] = v;
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
  const src = shareUrl(token, true);
  const snippet =
`<!-- ${deck.title} -->
<div style="position:relative;width:100%;padding-top:56.25%;border-radius:6px;overflow:hidden;background:#07090A">
  <iframe src="${src}"
    title="${deck.title}" loading="lazy" allowfullscreen
    style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>
</div>`;
  modal(`
    <h2>Embed on your website</h2>
    <p class="sub">Paste into a WordPress Custom HTML block, an Elementor HTML
       widget, or any page that accepts raw HTML.</p>
    <pre style="font-family:var(--mono);font-size:11px;line-height:1.6;background:var(--bg);
      border:1px solid var(--line);border-radius:var(--r-pan);padding:12px;overflow:auto;
      white-space:pre-wrap;word-break:break-all;color:#9fd8c8">${esc(snippet)}</pre>
    <div class="note" style="margin-top:12px">This links rather than copies, so
      republishing the deck updates every site it is embedded on. Views from
      those sites appear under <b>Audience</b>, broken down by which page they
      came from.</div>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn primary" id="csnip">Copy snippet</button>
      <button class="btn" id="cdone">Close</button>
    </div>`);
  $("cdone").onclick = closeModal;
  $("csnip").onclick = () => navigator.clipboard.writeText(snippet)
    .then(() => toast("Snippet copied"), () => toast("Copy failed", true));
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
