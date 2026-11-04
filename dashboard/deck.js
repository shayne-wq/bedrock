// Bedrock console — the deck: chapters, sharing, and who actually watched it.
//
// Three panels because they are three jobs: build the walkthrough, put it
// somewhere, find out whether it landed. The analytics panel is the one that
// justifies the embed existing at all — an IR team does not want a deck on
// their website, they want to know it was watched.

import {
  db, state, $, esc, fmtInt, fmtDur, fmtDate, fmtT, fmtOz,
  toast, fail, modal, closeModal, skeleton, wire,
} from "./lib/ui.js";
import { CONFIG } from "./config.js";
// Shared with the viewer: one definition of what a slide is.
import { projectCandidates, toChapter, defaultOrder } from "./lib/slides.js";

// The viewer is /pit/. This said "/index.html", which is the marketing site —
// Vercel's redirect for a share token matches the bare path "/" and nothing
// else, so every link and every embed snippet the console handed out opened the
// homepage instead of the deck.
// The standard renderer — see studio.js. Share links and embed snippets must
// point at the same product the studio previews.
const VIEWER = "/williams/";
let deck = null, chapters = [], project = null, links = [], LEADS = [];
let zones = [], datasets = [], candidates = [];
let isClient = false;
// The deck the data would build if nobody touched it — `{order, dropped, extra}`
// from defaultOrder(). Read by the panel's copy and by seedSuggested(), so it is
// module-scoped rather than local to renderDeck.
//
// This declaration was collateral damage when the builder came out: it shared a
// line with the builder's `order` array, and removing that took `suggestion`
// with it. A module is implicitly strict, so the assignment in renderDeck threw
// `ReferenceError: suggestion is not defined` instead of quietly creating a
// global — and the whole deck page failed to render. `node --check` parses an
// undeclared assignment happily; only running it in a browser found this.
let suggestion = { order: [], dropped: 0, extra: 0 };

// The list of layers a chapter can switch on used to live here, for the
// chapter-edit modal this page no longer has. `studio.js` owns that vocabulary
// now — one copy, in the screen that actually sets it.

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
  // `p`, not `project` — the module-level `project` is not assigned until the
  // next line, so passing it here would order the deck by the PREVIOUS
  // project's stage, or by null on a first load.
  suggestion = defaultOrder(candidates, zones, 14, p);
  project = p; chapters = ch || []; links = ln || [];
  // A client may edit chapters and read the embed snippet, and nothing else on
  // this page. The database refuses the rest either way — this is so we do not
  // draw a button whose only outcome is a silent failure.
  isClient = state.roles?.[project.org_id] === "client";
  const fabricated = (ds || []).filter((x) => x.synthetic);
  const blocks = (ds || []).find((x) => x.kind === "blocks");

  view.innerHTML = `
    <header class="page"><div class="row">
      <div class="grow">
        <span class="eyebrow"><a href="#/">Projects</a> /
          <a href="#/p/${project.id}">${esc(project.name)}</a></span>
        <h1 id="dtitle" ${isClient ? "" : 'contenteditable="plaintext-only"'}
            style="outline:none;border-bottom:1px dashed transparent"
            title="Click to rename">${esc(deck.title)}</h1>
        <!-- The subtitle is on the deck's opening card in the viewer and was
             readable everywhere and editable nowhere: set once at creation,
             then permanent. -->
        <p id="dsub" ${isClient ? "" : 'contenteditable="plaintext-only"'}
           style="outline:none;margin:4px 0 0;color:var(--ink-2);font-size:14px"
           data-placeholder="Add a subtitle"
           title="Click to edit">${esc(deck.subtitle || "")}</p>
      </div>
      <div class="row-actions">
        <span class="chip ${deck.status === "published" ? "live" : "draft"}"
              id="statuschip">${esc(deck.status)}</span>
        ${isClient ? "" : `<button class="btn" id="pub">${deck.status === "published" ? "Unpublish" : "Publish"}</button>`}
        <button class="btn" id="preview">Preview</button>
        <a class="btn" href="#/s/${deck.id}"
           title="Fly the deck and save the shots you land on">Edit slides</a>
        <button class="btn primary" id="present"
                title="Open the deck full screen to present, draw on it and record a walkthrough">Studio</button>
      </div>
    </div></header>

    ${fabricated.length ? `<div class="note warn" style="margin-bottom:16px">
      <b>Contains fabricated data.</b>
      ${esc(fabricated.map((f) => f.kind).join(", "))} —
      ${esc(fabricated[0].synthetic_note)}. Viewers see this on screen, and it is
      burned into exported images and recordings.
    </div>` : ""}

    ${blocks?.stats?.total ? `<div class="stats3">
      <div class="stat"><span class="l">Tonnage</span><b>${fmtT(blocks.stats.total.tonnes)}</b></div>
      <div class="stat"><span class="l">Grade</span><b>${blocks.stats.total.grade_gt} g/t</b></div>
      <div class="stat"><span class="l">Contained</span><b>${fmtOz(blocks.stats.total.oz)}</b></div>
    </div>` : ""}

    <!-- Audience leads the page. This deck exists to be watched, and the one
         question its owner opens the page with is whether it was — not how many
         slides it has. It also sits OUTSIDE the isClient guard, unlike the
         panels below: a client may read the numbers on their own deck. -->
    <div class="panel">
      <h2>Audience</h2>
      <div id="analytics">${skeleton(3)}</div>
    </div>

    ${isClient ? "" : `
    <div class="panel">
      <div class="row"><h2 class="grow">Slides</h2>
        <span class="hint">${chapters.length} in the deck</span></div>
      <!-- This used to be a two-column builder: a tray of every candidate the
           data supports, dragged across into a running order. It was the wrong
           place to judge a slide. A 64x40 card cannot answer "is the subject in
           frame", and a tray of nineteen unused slides is a chore rather than a
           choice. Edit slides flies the real deck at full size, which is what
           that question actually needs — so the deck page seeds and gets out of
           the way. -->
      <p class="lead" style="margin:0 0 14px">${chapters.length > 1
        ? `Open Edit slides to walk the deck, reframe a shot and cut what does
           not earn its place — it shows the real thing at full size, which is
           the only way to judge a slide.`
        : `Your data supports ${suggestion.order.length} slide${
             suggestion.order.length === 1 ? "" : "s"}, in an order that runs as
           an argument: the ground, what is under it, what was drilled, what it
           hit, what it adds up to. Seed them, then open Edit slides to walk the
           deck and change anything.`}</p>
      <div class="row-actions">
        ${suggestion.order.length ? `<button class="btn ${chapters.length > 1 ? "" : "primary"}" id="suggest">${
          chapters.length > 1 ? "Add any missing suggested slides" : `Use the suggested order (${
            suggestion.order.length} slide${suggestion.order.length === 1 ? "" : "s"})`}</button>` : ""}
        <a class="btn ${chapters.length > 1 ? "primary" : ""}" href="#/s/${deck.id}">Edit slides</a>
      </div>
    </div>`}

    <div class="panel" id="embedpanel"></div>

    <div class="panel">
      <h2>Sharing</h2>
      <div id="shares"></div>
      ${isClient ? "" : `<div class="row-actions" style="margin-top:14px">
        <button class="btn primary" id="newlink">Create a share link</button>
      </div>`}
    </div>

    <div class="panel">
      <div class="row"><h2 class="grow">Who is asking</h2>
        ${isClient ? "" : `<button class="btn sm" id="leadcsv">Export CSV</button>`}
      </div>
      <label class="check" style="display:flex;gap:9px;align-items:flex-start;margin:6px 0 14px">
        <input type="checkbox" id="gateon" ${deck.settings?.gate?.on ? "checked" : ""}
               ${isClient ? "disabled" : ""}>
        <span>
          <b style="font-weight:600">Ask for a name and email before the deck opens</b>
          <span class="hintline" style="display:block;margin-top:3px">
            A viewer can still decline — every gated deck carries a “continue
            without” link, and it opens either way. Anyone you have already sent
            the link to is asked the next time they open it.
          </span>
        </span>
      </label>
      <div id="leads">${skeleton(2)}</div>
    </div>`;

  wire(view);
  renderShares();
  renderEmbedPanel();
  renderAnalytics();
  renderLeads();

  // The gate is a deck setting, not a column: it travels in the payload the
  // viewer already fetches, so turning it on reaches every link at once.
  if ($("gateon")) $("gateon").onchange = async () => {
    const on = $("gateon").checked;
    const settings = Object.assign({}, deck.settings || {}, { gate: { on } });
    // `.select()` is what makes a refusal visible, and this setting is the one
    // that must never fail quietly. An update the row policy declines comes back
    // with NO error and no rows — so this said "the deck will ask for a name and
    // email", left the box ticked, wrote nothing, and the deck went on opening
    // ungated: the single outcome the toggle exists to prevent, reported as
    // success. Same trap as the RLS-silent storage delete in ingest.js.
    const { data, error } = await db.from("decks")
      .update({ settings }).eq("id", deck.id).select("id, settings");
    if (error || !data?.length) {
      $("gateon").checked = !on;
      return fail("Save setting", error ||
        new Error("this deck could not be changed — you may not have permission to edit it"));
    }
    // Trust what came back rather than what was sent, so the page agrees with
    // the database about a setting whose whole job is to be believed.
    deck.settings = data[0].settings || settings;
    toast(on ? "The deck will ask for a name and email" : "The deck opens without asking");
  };

  // Saved on blur, like the title, rather than per keystroke.
  if ($("dsub")) $("dsub").onblur = async () => {
    const v = $("dsub").textContent.trim();
    if (v === (deck.subtitle || "")) return;
    const { error } = await db.from("decks")
      .update({ subtitle: v || null }).eq("id", deck.id);
    if (error) return fail("Save subtitle", error);
    deck.subtitle = v || null;
    toast("Subtitle saved");
  };

  if ($("leadcsv")) $("leadcsv").onclick = () => {
    if (!LEADS.length) return toast("There is nobody to export yet");
    const name = (deck.title || "deck").toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([leadsCsv()], { type: "text/csv;charset=utf-8" }));
    a.download = `${name}-leads.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  };

  $("preview").onclick = () => {
    const t = links.find((l) => !l.revoked_at);
    // Preview through a real share token when one exists, so what the author
    // checks is exactly what a recipient gets rather than a privileged view.
    // shareUrl(), not a hand-built one. The viewer is a static file with no idea
    // which Supabase project it belongs to, so a link without `api` cannot open
    // a shared deck at all — it boots and then throws "this build has no API
    // configured". Preview was building exactly that link, so the button that
    // exists to show you what a recipient sees showed an error instead.
    window.open(t ? shareUrl(t.token, false) : `${VIEWER}?deck=${deck.id}`,
                "_blank", "noopener");
  };

  // Studio opens the deck in its own window: presenting means recording the
  // deck, and a deck recorded inside the console records the console — its
  // toolbar, its filmstrip and the author's own email address in the corner.
  // Deliberately NOT noopener: same origin, and the presenter's Exit button
  // closes the window it was opened from, which a severed opener forbids.
  $("present").onclick = () => {
    const t = links.find((l) => !l.revoked_at);
    // Presenting opens the deck the way a recipient does, so it needs a real
    // token. Without one the slide editor is where a link gets made.
    if (!t) { location.hash = `#/s/${deck.id}`; return; }
    const api = encodeURIComponent(CONFIG.url.replace(/\/$/, "") + "/functions/v1");
    const url = `${VIEWER}?t=${encodeURIComponent(t.token)}&api=${api}&present=1`;
    // A WINDOW, not a tab, and sized to the video. Studio records 1920x1080; a
    // window that already is that size gets captured 1:1 instead of scaled up
    // from whatever shape the tab happened to be. Chrome reads these as the
    // OUTER box, so the viewer trims its own chrome height once it can measure
    // it — the number that matters is the viewport, and only it knows that.
    // Taller than the video on purpose. Studio records the 16:9 STAGE, and the
    // presenter bar now parks in the letterbox band below it — on screen for
    // the operator, outside the recorded frame. At 1920 wide the stage is 1080
    // tall, so 1180 left about 20px of band once browser chrome took its cut:
    // not enough to hold the bar, and the bar fell back into shot. 1260 leaves
    // room for it. A screen too small to grant this is handled at the other
    // end — the viewer measures the band it actually got.
    const win = window.open(url, "bedrock-studio",
      "popup=yes,width=1920,height=1260,left=20,top=20," +
      "menubar=no,toolbar=no,location=no,status=no");
    if (!win) window.open(url, "_blank");          // popup blocked: a tab still works
  };

  if ($("pub")) $("pub").onclick = async () => {
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
  if (title.isContentEditable) {
    title.onblur = saveTitle;
    title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } };
  }

  if ($("newlink")) $("newlink").onclick = newLink;
  if (!isClient && $("suggest")) {
    $("suggest").onclick = (e) => seedSuggested(e.currentTarget);
  }
}

/* Seed the deck with the slides the data supports, then hand over to Edit
 * slides.
 *
 * INSERT ONLY — never delete, never renumber. The builder this replaces had a
 * reconcile that could remove chapters, and an earlier version of it deleted
 * every chapter and re-inserted from the candidate template: a camera someone
 * had flown to, a title they rewrote, the body they corrected, all of it lived
 * in the chapter row and all of it was thrown away. Seeding has no business
 * touching a slide anybody has already worked on.
 *
 * Already-present candidates are skipped on `source`, which is the candidate id
 * `toChapter` writes into the row. Matching on TITLE — which the old builder
 * did — broke the moment somebody renamed a slide. */
async function seedSuggested(btn) {
  const have = new Set(chapters.map((c) => c.source).filter(Boolean));
  const add = suggestion.order.filter((c) => !have.has(c.id));
  if (!add.length) {
    toast("Every suggested slide is already in the deck");
    location.hash = `#/s/${deck.id}`;
    return;
  }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    // Appended after what is already there, so seeding a deck somebody has
    // started adds to it rather than reordering their work.
    const rows = add.map((c, i) => ({ deck_id: deck.id, ...toChapter(c, chapters.length + i) }));
    const { error } = await db.from("chapters").insert(rows);
    if (error) throw error;
    toast(`Added ${add.length} slide${add.length === 1 ? "" : "s"} — open each one to set its shot`);
    location.hash = `#/s/${deck.id}`;
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    fail("Add slides", e);
  }
}

/* The two-column builder and the flat chapter list that preceded it are both
 * gone (2026-09-17).
 *
 * The builder asked you to judge a slide from a 64x40 card in a tray of
 * nineteen, most of which were never going to be used. Edit slides flies the
 * real deck at full size, which is the only way that question can honestly be
 * answered — so the deck page now seeds and links, and everything that served
 * the tray went with it: the candidate pool, drag-and-drop, the running-order
 * reconcile, the hidden-viewer thumbnail engine and its cache, and the
 * click-to-preview modal built the same day.
 *
 * The chapters cluster below it (renderChapters/move/renumber/addChapter/
 * editChapter) had been unreachable for longer: it painted into #chlist, which
 * the builder had already removed from this page. It guarded with an early
 * return, so it failed silently rather than loudly, which is why it survived.
 */

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

/** The snippet, on the page, already filled in.
 *
 *  It used to live behind a button on a row of a table inside a panel called
 *  Sharing, which is three guesses away from "how do we put this on our
 *  website" — the single most common thing a customer wants from the console
 *  after the deck is built. */
function renderEmbedPanel() {
  const el = $("embedpanel");
  if (!el) return;
  const now = Date.now();
  const live = links.find((l) => !l.revoked_at && l.allow_embed &&
    (!l.expires_at || new Date(l.expires_at).getTime() > now));

  if (!live) {
    const blocked = links.some((l) => !l.revoked_at && !l.allow_embed);
    el.innerHTML = `<h2>Put this on your website</h2>
      <div class="empty sm"><p>${blocked
        ? `Your share links are set to <b>no embedding</b>. Create one with
           embedding allowed and the snippet appears here, ready to paste.`
        : `Create a share link below and the snippet appears here, ready to
           paste into your site.`}</p></div>`;
    return;
  }

  const src = shareUrl(live.token, true);
  const snippet =
`<!-- ${deck.title} -->
<div style="position:relative;width:100%;padding-top:56.25%;border-radius:6px;overflow:hidden;background:#07090A">
  <iframe src="${src}"
    title="${deck.title}" loading="lazy" allowfullscreen
    style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>
</div>`;

  el.innerHTML = `
    <div class="row">
      <div class="grow">
        <h2>Put this on your website</h2>
        <p class="sub" style="margin:2px 0 0">Paste into a WordPress Custom HTML
           block, an Elementor HTML widget, or a Squarespace code block. It holds
           a 16:9 shape at any width.</p>
      </div>
      <span class="chip live">${esc(live.label || "live link")}</span>
    </div>

    <pre class="snip embed">${esc(snippet)}</pre>
    <div class="row-actions">
      <button class="btn primary" data-copy-text="${esc(snippet)}">Copy the snippet</button>
      <button class="btn" data-copy-text="${esc(src)}">Copy the URL instead</button>
      <button class="btn" id="embedmore">Other platforms</button>
    </div>
    <p class="hintline">Wix, Notion and Confluence take the <b>URL</b>, not the
       markup. PowerPoint and Google Slides each need something different —
       <b>Other platforms</b> has the exact steps.</p>`;

  wire(el);
  $("embedmore").onclick = () => embedSnippet(live.token);
}

function renderShares() {
  const el = $("shares");
  if (!links.length) {
    el.innerHTML = `<div class="empty"><h3>Not shared yet</h3>
      <p>${isClient
        ? `A share link is what your deck is served through, and what an embed on
           your website points at. Ask us to issue one.`
        : `A share link is what you send, and what an embed on your website points
           at. Each one can be revoked on its own.`}</p></div>`;
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
          ${l.revoked_at || isClient ? "" : `<button class="btn sm danger" data-rev="${l.id}">Revoke</button>`}
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
      renderEmbedPanel();
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
    renderEmbedPanel();
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
function rangeTabs() {
  return `<div class="rtabs" role="tablist" aria-label="Time range">
    ${Object.entries(RANGES).map(([k, v]) => `
      <button role="tab" class="rtab ${k === range ? "on" : ""}" data-range="${k}"
              aria-selected="${k === range}">${v.label}</button>`).join("")}
  </div>`;
}
function wireRange() {
  document.querySelectorAll("[data-range]").forEach((b) => {
    b.onclick = () => { range = b.dataset.range; renderAnalytics(); };
  });
}

/* Three windows over the same figures. A month says whether the deck is being
   watched at all; a day says whether the email that went out this morning
   landed. Every rollup already takes `p_since`, so the range is one argument
   and not four queries' worth of new SQL. */
const RANGES = {
  "1d":  { label: "24 hours", hours: 24,      bucket: "hour" },
  "7d":  { label: "7 days",   hours: 24 * 7,  bucket: "day" },
  "30d": { label: "30 days",  hours: 24 * 30, bucket: "day" },
};
let range = "30d";

/* Every bucket in the window, whether anybody watched in it or not.
   The rollups return only the buckets that have sessions, so plotting them
   straight drew thirteen sessions as two bars — one full height, one nearly
   flat — which reads as "busy, then dead" rather than "two days out of thirty".
   The zeroes are the story. */
function fillBuckets(rows, key, bucket, count) {
  const step = bucket === "hour" ? 3600e3 : 86400e3;
  const now = new Date();
  const end = bucket === "hour"
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours())
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = new Map();
  for (const r of rows || []) {
    const t = new Date(r[key]);
    const k = bucket === "hour"
      ? new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours()).getTime()
      : new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
    at.set(k, (at.get(k) || 0) + Number(r.sessions));
  }
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = end.getTime() - i * step;
    out.push({ t, sessions: at.get(t) || 0 });
  }
  return out;
}

/* Everyone who filled in a gated deck's form. Read straight from the table —
   RLS already limits it to this org, so there is no rollup to maintain and no
   second definition of who counts. */
async function renderLeads() {
  const el = $("leads");
  if (!el) return;
  const { data, error } = await db.from("deck_leads")
    .select("name, email, company, referrer_host, created_at")
    .eq("deck_id", deck.id)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) { el.innerHTML = `<p class="hintline">Could not read the list.</p>`; return; }
  LEADS = data || [];
  if (!LEADS.length) {
    el.innerHTML = `<div class="empty"><h3>Nobody has signed in yet</h3>
      <p>${deck.settings?.gate?.on
        ? `The deck is asking. Names appear here as people open it.`
        : `Turn the switch above on and the deck will ask for a name and an
           email before it opens. Nobody is asked until you do.`}</p></div>`;
    return;
  }
  const when = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  el.innerHTML = `<div class="tablewrap"><table>
    <thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Came from</th><th>When</th></tr></thead>
    <tbody>${LEADS.map((l) => `<tr>
      <td>${esc(l.name)}</td>
      <td><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></td>
      <td>${esc(l.company || "—")}</td>
      <td>${esc(l.referrer_host || "—")}</td>
      <td class="mono">${when(l.created_at)}</td></tr>`).join("")}</tbody></table></div>
    <p class="hintline" style="margin-top:10px">${LEADS.length} ${LEADS.length === 1 ? "person" : "people"} ·
      kept for 24 months, then deleted · they were told this goes to you.</p>`;
}

/* CSV, not XLSX: it opens in every CRM and every spreadsheet, and a lead list
   is a column of addresses rather than a formatted report. Quotes doubled and
   every field quoted, so a company name with a comma in it cannot shift the
   columns. */
function leadsCsv() {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Name", "Email", "Company", "Came from", "When"];
  const rows = LEADS.map((l) => [l.name, l.email, l.company || "", l.referrer_host || "",
                                 new Date(l.created_at).toISOString()]);
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

async function renderAnalytics() {
  const el = $("analytics");
  const R = RANGES[range];
  const since = new Date(Date.now() - R.hours * 3600e3).toISOString();
  const arg = { p_deck: deck.id, p_since: since };
  const [{ data: sum, error: e1 }, { data: funnel }, { data: refs }, { data: series }] =
    await Promise.all([
      db.rpc("deck_summary", arg),
      db.rpc("deck_chapter_funnel", arg),
      db.rpc("deck_referrers", arg),
      R.bucket === "hour" ? db.rpc("deck_hourly", arg) : db.rpc("deck_daily", arg),
    ]);
  if (e1) return fail("Analytics", e1);

  const s = sum?.[0] || { sessions: 0, embed_sessions: 0, completions: 0,
                          median_watch_ms: 0, total_watch_ms: 0, avg_chapters: 0 };
  if (!Number(s.sessions)) {
    el.innerHTML = rangeTabs() + `<div class="empty">
      <h3>${range === "30d" ? "Nobody has opened this yet"
                            : `Nothing in the last ${R.label}`}</h3>
      <p>${range === "30d"
        ? `Once the deck is shared or embedded, this shows how many people
           watched, how long they stayed, which chapter lost them, and which
           website they came from.`
        : `No sessions in this window. Try a longer one.`}</p></div>`;
    wireRange();
    return;
  }

  const maxReach = Math.max(1, ...(funnel || []).map((f) => Number(f.reached)));
  const bars = fillBuckets(series, R.bucket === "hour" ? "hour" : "day",
                           R.bucket, R.bucket === "hour" ? 24 : R.hours / 24);
  const maxBar = Math.max(1, ...bars.map((b) => b.sessions));
  const titleOf = (ord) => chapters.find((c) => c.ord === ord)?.title || `Chapter ${ord + 1}`;
  const stamp = (t) => R.bucket === "hour"
    ? new Date(t).toLocaleTimeString([], { hour: "numeric" })
    : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });

  el.innerHTML = rangeTabs() + `
    <div class="grid three" style="margin-bottom:20px">
      <div class="stat"><span class="l">Sessions</span><b>${fmtInt(s.sessions)}</b>
        <span class="sub">${fmtInt(s.embed_sessions)} from embeds</span></div>
      <div class="stat"><span class="l">Median watch</span><b>${fmtDur(s.median_watch_ms)}</b>
        <span class="sub">${fmtDur(s.total_watch_ms)} in total</span></div>
      <div class="stat"><span class="l">Reached the end</span>
        <b>${Math.round((Number(s.completions) / Number(s.sessions)) * 100)}%</b>
        <span class="sub">${fmtInt(s.completions)} of ${fmtInt(s.sessions)}</span></div>
    </div>

    <div style="margin-bottom:22px">
      <div class="eyebrow" style="margin-bottom:7px">Sessions per ${R.bucket}</div>
      <div class="bars" role="img"
           aria-label="Sessions per ${R.bucket} over the last ${R.label}">
        ${bars.map((b) => `
          <div class="bar" title="${stamp(b.t)} — ${b.sessions} session${b.sessions === 1 ? "" : "s"}">
            <i style="height:${Math.round((b.sessions / maxBar) * 100)}%"
               class="${b.sessions ? "" : "zero"}"></i>
          </div>`).join("")}
      </div>
      <div class="barsx">
        <span>${stamp(bars[0].t)}</span>
        <span class="mx">${maxBar} max</span>
        <span>${stamp(bars[bars.length - 1].t)}</span>
      </div>
    </div>

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
      cross-site identifiers are collected, browsers that send Do Not Track or
      Global Privacy Control are not counted, and sessions are deleted after 13
      months. These are engagement figures for your own use, not
      audited numbers: anyone holding a share link could inflate them.</p>`;
  wireRange();
}
