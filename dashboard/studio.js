// Bedrock console — the studio.
//
// Authoring a camera used to mean opening the preview, flying, pressing C,
// copying JSON, switching tab and pasting it into five number fields. Nobody
// was ever going to do that twenty times, and it did not work anyway: the form
// wrote `h` as a height in metres into the key the viewer reads as a heading in
// degrees, so every camera authored in the console produced a heading of some
// hundreds of degrees, a default pitch and a default range. Silently, because
// those are all legal numbers.
//
// So the deck is authored in the thing that renders it. The viewer runs framed,
// in `?author=1`, and reports what it is looking at. This side does the writing.
//
// The split is deliberate and is the reason it is a bridge rather than a
// session handed to the frame. The viewer is a public, anonymous document that
// anyone with a share link loads; giving it write credentials so it could save
// a chapter would put tenant write access into that document. Here we are
// already authenticated and already subject to RLS, so here is where writes
// belong.
//
// The studio is now the ONLY place a deck is edited. It used to author cameras
// and refuse to touch prose, which sent the person doing the work back to the
// deck page for every caption and every reorder — two surfaces, one job, and
// the camera you were looking at lost on the way. Filmstrip on the left,
// the deck as the recipient sees it in the middle, and everything about the
// selected slide on the right.
//
// TWO previews, not one. A shot framed for 16:9 is rarely the shot for 9:16 —
// the caption card takes far more of a phone's glass, and a range that showed
// the whole zone in landscape crops it in portrait. So the middle column is a
// desktop frame and a phone frame side by side, either one can be framed
// independently, and a chapter with no portrait camera falls back to its
// landscape one rather than being wrong on a phone.

import {
  db, $, esc, toast, fail, modal, closeModal, skeleton,
} from "./lib/ui.js";
import { CONFIG } from "./config.js";

// The viewer is /pit/, and has been since the marketing site took the root.
// This pointed at /index.html, which Vercel's redirect does NOT rewrite — that
// rule matches the bare path "/" and nothing else — so the studio framed the
// marketing page and waited forever for a viewer that was never loaded.
/* The standard renderer. `/pit/` is still here and still opens a deck with a
   block model in it; this is what every deck is drawn with otherwise, and it
   is the one the marketing page shows. Previewing in a different product from
   the one the audience gets is how the studio ended up showing a cut-off grade
   slider and an AuEq legend over a property with no estimated resource. */
const VIEWER = "/williams/";

let deck = null, chapters = [], project = null;
// Both previews, keyed the way everything else here is: 'wide' is 16:9 and
// writes `camera`; 'tall' is 9:16 and writes `camera_portrait`.
const FRAMES = ["wide", "tall"];
const COLUMN = { wide: "camera", tall: "camera_portrait" };
const LABEL  = { wide: "Desktop 16:9", tall: "Mobile 9:16" };
let frames = { wide: null, tall: null };
let ready  = { wide: false, tall: false };
let live   = { wide: null, tall: null };
let active = "wide";                     // which frame Set view writes to
let undo = null;                         // { ord, which, before } — one step, which is the one that matters
let sel = 0;                             // slide the inspector is editing
let shownFor = null;                     // chapter id the inspector was built for
let textTimer = null, textDirty = false;
// The filmstrip is a navigator, not the work. On a 1100px laptop it costs a
// quarter of the preview, so it folds away and remembers that it did.
let stripOpen = (() => { try { return localStorage.getItem("bedrock.strip") !== "0"; }
                         catch { return true; } })();
let captureTimer = null;                 // waiting on a viewer that may be too old to answer

// Measured transition times, keyed by ord, filled by the viewer's `transition`
// reply. This was read by the painter but never declared and never populated:
// in a module that is a ReferenceError, so every repaint of the chapter list
// threw before it drew anything.
const timings = {};

// A live share token. The studio opens the deck exactly the way a recipient
// does rather than through a privileged path, so what is authored is what is
// seen. No link, no studio — and it asks rather than minting one behind the
// author's back, because a share token is a thing that can leak.
async function tokenFor(deckId) {
  const { data } = await db.from("share_links")
    .select("token, revoked_at, expires_at")
    .eq("deck_id", deckId).order("created_at", { ascending: false });
  const now = Date.now();
  return (data || []).find((l) =>
    !l.revoked_at && (!l.expires_at || new Date(l.expires_at).getTime() > now))?.token || null;
}

function frameHtml(w, token) {
  const api = encodeURIComponent(CONFIG.url.replace(/\/$/, "") + "/functions/v1");
  return `
    <div class="stview ${w} ${w === "wide" ? "on" : ""}" id="stview_${w}" data-frame="${w}">
      <div class="stframehd">
        <span class="nm">${LABEL[w]}</span>
        <span class="st" id="stlive_${w}">Loading…</span>
      </div>
      <div class="stglass">
        <iframe id="stframe_${w}" title="${LABEL[w]} preview"
          allow="display-capture; microphone"
          src="${VIEWER}?t=${encodeURIComponent(token)}&api=${api}&author=1&frame=${
            w === "tall" ? "portrait" : "landscape"}"></iframe>
      </div>
    </div>`;
}

export async function renderStudio(id, view) {
  view.innerHTML = skeleton(4);
  ready = { wide: false, tall: false };
  live  = { wide: null, tall: null };
  frames = { wide: null, tall: null };
  active = "wide";
  undo = null; sel = 0; shownFor = null; textDirty = false;

  const { data: d, error } = await db.from("decks")
    .select("id, title, project_id").eq("id", id).maybeSingle();
  if (error) return fail("Deck", error);
  if (!d) {
    view.innerHTML = `<div class="empty"><h3>Deck not found</h3>
      <a class="btn" href="#/">Back to projects</a></div>`;
    return;
  }
  deck = d;

  const [{ data: p }, { data: ch }] = await Promise.all([
    db.from("projects").select("id, name").eq("id", d.project_id).single(),
    db.from("chapters").select("*").eq("deck_id", id).order("ord"),
  ]);
  project = p; chapters = ch || [];

  const token = await tokenFor(id);

  view.innerHTML = `
    <header class="page"><div class="row">
      <div class="grow">
        <span class="eyebrow"><a href="#/">Projects</a> /
          <a href="#/p/${project.id}">${esc(project.name)}</a> /
          <a href="#/d/${deck.id}">${esc(deck.title)}</a></span>
        <h1>Studio</h1>
      </div>
      <div class="row-actions">
        <span id="stsave" class="stsave"></span>
        <button class="btn" id="stundo" disabled title="Put the last camera back the way it was">Undo</button>
        <a class="btn primary" href="#/d/${deck.id}">Done</a>
      </div>
    </div></header>

    ${!token ? `<div class="empty"><h3>Needs a share link</h3>
      <p>The studio opens your deck the way a recipient sees it, so that what
         you author is what they get. That needs a live share link, and one is
         not created for you — a token is a thing that can be forwarded.</p>
      <button class="btn primary" id="stmklink">Create one now</button></div>`
    : `<div class="studio">
        <aside class="stchaps">
          <div class="stchaps-hd">
            <span>Slides</span>
            <button class="btn sm" id="stadd" title="Add a slide after the last one">Add</button>
            <button class="btn sm" id="stfold" title="Hide the slide list (\u2318\\)">Hide</button>
          </div>
          <div id="stlist"></div>
        </aside>
        <div class="stmain">
          <div class="stswitch" role="tablist" aria-label="Preview shape">
            <button class="swbtn strip" id="stunfold" title="Show the slide list (\u2318\\)"
                    aria-label="Show slides">Slides</button>
            ${FRAMES.map((w) => `
              <button role="tab" class="swbtn ${w === "wide" ? "on" : ""}"
                      id="sw_${w}" data-sw="${w}"
                      aria-selected="${w === "wide"}">${LABEL[w]}</button>`).join("")}
            <span class="swlive" id="swlive"></span>
          </div>
          ${frameHtml("wide", token)}
          ${frameHtml("tall", token)}
          <aside class="stinspect" id="stinspect"></aside>
        </div>
      </div>`}`;

  if (!token) {
    $("stmklink").onclick = () => makeLink(id);
    return;
  }

  for (const w of FRAMES) {
    frames[w] = $(`stframe_${w}`);
    // Clicking a preview is how you say which shape you are framing. It is the
    // whole interaction: Set view then writes to that frame's camera.
  }
  for (const w of FRAMES) $(`sw_${w}`).onclick = () => setActive(w);
  $("stfold").onclick = () => setStrip(false);
  $("stunfold").onclick = () => setStrip(true);
  setStrip(stripOpen);
  $("stundo").onclick = doUndo;
  $("stadd").onclick = addSlide;
  paintList();
  paintInspector();
  paintActive();
  addEventListener("message", onMessage);
  addEventListener("keydown", onKey);
}

function setStrip(open) {
  stripOpen = open;
  try { localStorage.setItem("bedrock.strip", open ? "1" : "0"); } catch { /* private window */ }
  document.body.classList.toggle("stripoff", !open);
  const b = $("stunfold");
  if (b) b.hidden = open;
}

function setActive(w) {
  if (active === w) return;
  active = w;
  paintActive();
  paintCamera();
}

function paintActive() {
  for (const w of FRAMES) {
    const el = $(`stview_${w}`), tab = $(`sw_${w}`);
    // Both classes, because both mean something and they are not opposites:
    // `off` hides the frame you are not looking at, `on` marks the one Set view
    // writes to (its border, and its name in the header). Writing only `off`
    // left `on` wherever the markup first put it.
    if (el) { el.classList.toggle("off", active !== w); el.classList.toggle("on", active === w); }
    if (tab) {
      tab.classList.toggle("on", active === w);
      tab.setAttribute("aria-selected", String(active === w));
    }
  }
  const box = $("stinspect");
  if (box) box.querySelectorAll("[data-camrow]").forEach((r) =>
    r.classList.toggle("on", r.dataset.camrow === active));
  paintLive();
}

// The console must not stay subscribed after the route changes, or a second
// studio session ends up with two handlers writing the same chapter twice.
function onKey(e) {
  // Not while somebody is typing a caption.
  const t = e.target;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setStrip(!stripOpen); }
}

export function teardownStudio() {
  removeEventListener("message", onMessage);
  removeEventListener("keydown", onKey);
  document.body.classList.remove("stripoff");
  if (textTimer) { clearTimeout(textTimer); textTimer = null; }
  if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
  frames = { wide: null, tall: null };
  ready = { wide: false, tall: false };
  live = { wide: null, tall: null };
  undo = null; shownFor = null;
}

function makeLink(deckId) {
  modal(`<h2>Create a share link</h2>
    <p class="sub">The studio needs one, and so does anybody you send the deck
       to. It can be revoked at any time from the deck page.</p>
    <div class="field"><label for="lklabel">Label</label>
      <input type="text" id="lklabel" value="Studio" placeholder="Studio"></div>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn primary" id="lkgo">Create</button>
      <button class="btn" id="lkno">Cancel</button>
    </div>`);
  $("lkno").onclick = closeModal;
  $("lkgo").onclick = async () => {
    const token = crypto.randomUUID().replace(/-/g, "");
    const { error } = await db.from("share_links").insert({
      deck_id: deckId, token, label: $("lklabel").value.trim() || "Studio",
      allow_embed: false,
    });
    if (error) return fail("Create link", error);
    closeModal();
    toast("Link created");
    location.hash = `#/s/${deckId}`;      // same route; re-render picks it up
    dispatchEvent(new HashChangeEvent("hashchange"));
  };
}

// ------------------------------------------------------------- the bridge --

/** Which preview sent this, or null if it was not one of ours. Identity by
 *  contentWindow rather than by anything in the message: a frame can claim to
 *  be whatever it likes, but it cannot forge which window it posted from. */
function frameOf(source) {
  for (const w of FRAMES) {
    if (frames[w] && source === frames[w].contentWindow) return w;
  }
  return null;
}

function onMessage(e) {
  // Same origin as the console, and one of the exact frames we put there.
  // Neither check is sufficient alone: origin without source lets any
  // same-origin frame on the page speak, source without origin trusts whatever
  // a frame navigated to if it ever left our document.
  if (e.origin !== location.origin) return;
  const which = frameOf(e.source);
  if (!which) return;
  const d = e.data;
  if (!d || d.source !== "bedrock-viewer") return;

  if (d.type === "hello") {
    frames[which].contentWindow.postMessage(
      { source: "bedrock-console", type: "hello" }, location.origin);
    return;
  }
  if (d.type === "ready") { ready[which] = true; tell({ type: "poll" }, which); return; }
  if (d.type === "state") {
    live[which] = d.state;
    // Follow the viewer when IT moves — pressing next inside a frame should
    // bring the inspector with it, or you edit one slide while looking at
    // another. Only the frame you are working in gets to move the selection,
    // or the two would fight each other every time one is told to catch up.
    const st = live[which];
    if (which === active && typeof st.ord === "number" && st.ord !== sel) {
      sel = st.ord;
      paintInspector();
      // Bring the other frame along so both previews show the same slide.
      tell({ type: "goto", ord: sel }, other(which));
    }
    paintLive(which); paintList();
    return;
  }
  if (d.type === "set") {
    // Any `set` answers an outstanding capture request, whether we asked or
    // the author pressed the button inside that frame. It writes to the camera
    // belonging to the frame it came FROM, not to whichever is selected here —
    // pressing Set view inside the phone preview must never write the desktop
    // shot.
    if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
    save(d.state, d.what, which);
    return;
  }
  if (d.type === "transition") {
    const st = live[which];
    if (d.result && typeof d.result.ord === "number") timings[d.result.ord] = d.result;
    else if (st && typeof st.ord === "number" && d.result) timings[st.ord] = d.result;
    paintList();
    return;
  }
}

const other = (w) => (w === "wide" ? "tall" : "wide");

/** Send to one frame, or to both when `which` is omitted — navigation goes to
 *  both so the two previews stay on the same slide; capture goes to one. */
function tell(msg, which) {
  for (const w of which ? [which] : FRAMES) {
    const f = frames[w];
    if (f && f.contentWindow) {
      f.contentWindow.postMessage(
        Object.assign({ source: "bedrock-console" }, msg), location.origin);
    }
  }
}

// ---------------------------------------------------------------- writing --

async function save(state, what, which) {
  const c = chapters[state.ord];
  const col = COLUMN[which] || "camera";
  if (!c) { tell({ type: "saved", ok: false, ord: state.ord }, which); return; }

  // Orbit unless there is no orbit to be had. Orbit survives a deposit switch
  // and the viewer's transition guard reasons about its range to decide whether
  // a jump needs an intermediate frame; a free camera gets neither, so it is
  // the fallback rather than the default.
  const patch = {};
  if (what === "areas") {
    // Annotations only. Saving labels must not also move the camera — the
    // author may have drawn them from a convenient angle that is not the shot.
    patch.areas = Array.isArray(state.areas) ? state.areas : [];
  } else {
    patch[col] = state.camera.orbit || state.camera.free;
    if (what === "all") {
      // Title, body and section are the author's prose and are NOT touched
      // here. Only what is switched on in the scene — and layers are shared
      // between the two shapes on purpose. Which layers a slide shows is what
      // the slide is ABOUT; only the framing differs between phone and desktop.
      patch.layers = state.layers || {};
    }
  }

  undo = { ord: state.ord, which,
           before: { [col]: c[col], layers: c.layers, areas: c.areas || [] } };
  $("stundo").disabled = false;

  const { error } = await db.from("chapters").update(patch).eq("id", c.id);
  if (error) {
    undo = null; $("stundo").disabled = true;
    fail("Save chapter", error);
    tell({ type: "saved", ok: false, ord: state.ord, what }, which);
    return;
  }
  Object.assign(c, patch);
  tell({ type: "saved", ok: true, ord: state.ord, what, chapter: c }, which);
  toast(what === "areas"
    ? `${patch.areas.length} label${patch.areas.length === 1 ? "" : "s"} published`
    : `${LABEL[which] || "View"} saved${what === "all" ? " with layers" : ""}`);
  paintList();
  if (chapters[sel] && chapters[sel].id === c.id) paintCamera();
}

async function doUndo() {
  if (!undo) return;
  const c = chapters[undo.ord];
  if (!c) return;
  const { error } = await db.from("chapters")
    .update(undo.before).eq("id", c.id);
  if (error) return fail("Undo", error);
  Object.assign(c, undo.before);
  tell({ type: "saved", ok: true, ord: undo.ord, what: "undo", chapter: c }, undo.which);
  tell({ type: "goto", ord: undo.ord });
  undo = null;
  $("stundo").disabled = true;
  toast("Reverted");
  paintList();
  paintCamera();
}

// ------------------------------------------------------------ slide edits --

/** Ask the viewer to store what is on screen right now.
 *
 *  Older builds of the viewer only ever sent `set` when somebody pressed the
 *  button inside the frame; they have no handler for this message and will
 *  answer nothing at all. Rather than leave a dead button, we wait — and if
 *  nothing comes back, say where the working one is. */
function requestCapture(what, which) {
  const w = which || active;
  if (!ready[w]) return toast(`The ${LABEL[w]} preview is still loading`, true);
  if (captureTimer) clearTimeout(captureTimer);
  setSaveNote("Capturing…");
  tell({ type: "capture", what }, w);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    setSaveNote("");
    toast("This viewer build can't be driven from here — use Set view inside the preview", true);
  }, 2500);
}

function scheduleTextSave() {
  textDirty = true;
  setSaveNote("Unsaved changes");
  if (textTimer) clearTimeout(textTimer);
  textTimer = setTimeout(saveText, 700);
}

async function saveText() {
  if (textTimer) { clearTimeout(textTimer); textTimer = null; }
  const c = chapters[sel];
  if (!c || !textDirty) return;
  const titleEl = $("insp_title");
  if (!titleEl) return;                     // inspector was replaced mid-flight

  const dwell = Math.min(120, Math.max(1, Number($("insp_dwell").value) || 9));
  const patch = {
    title: titleEl.value.trim() || null,
    body: $("insp_body").value.trim() || null,
    section: $("insp_section").value.trim() || null,
    dwell_ms: dwell * 1000,
  };

  setSaveNote("Saving…");
  const { error } = await db.from("chapters").update(patch).eq("id", c.id);
  if (error) { setSaveNote("Not saved"); return fail("Save slide", error); }
  Object.assign(c, patch);
  textDirty = false;
  setSaveNote("Saved");
  // The viewer holds its own copy of every chapter; without this the preview
  // keeps showing the old caption until the whole deck is reloaded.
  tell({ type: "saved", ok: true, ord: sel, what: "text", chapter: c });
  paintList();
}

function setSaveNote(msg) {
  const el = $("stsave");
  if (el) el.textContent = msg;
}

async function selectSlide(i) {
  if (i === sel) { tell({ type: "goto", ord: i }); return; }
  if (textDirty) await saveText();
  sel = i;
  paintInspector();
  paintList();
  tell({ type: "goto", ord: i });
}

/** Reordering swaps two `ord` values. The unique constraint on (deck_id, ord)
 *  is DEFERRABLE precisely so both sides of a swap can be written before it is
 *  checked — without that, every reorder would need a temporary hole. */
async function moveSlide(i, dir) {
  const j = i + dir;
  if (i < 0 || j < 0 || j >= chapters.length) return;
  if (textDirty) await saveText();
  const a = chapters[i], b = chapters[j];
  [chapters[i], chapters[j]] = [b, a];
  const { error } = await db.from("chapters").upsert([
    { id: a.id, deck_id: deck.id, ord: j },
    { id: b.id, deck_id: deck.id, ord: i },
  ]);
  if (error) { await reload(); return fail("Reorder", error); }
  a.ord = j; b.ord = i;
  sel = j;
  paintList(); paintInspector();
  reloadViewer();
}

/** Drag lands a slide at an arbitrary index, so every ord from the lower of the
 *  two positions onward has to be rewritten — a swap is not enough. */
async function dropSlide(from, to) {
  if (from === to || from < 0 || to < 0) return;
  if (textDirty) await saveText();
  const moved = chapters.splice(from, 1)[0];
  chapters.splice(to, 0, moved);
  const rows = chapters.map((c, i) => ({ id: c.id, deck_id: deck.id, ord: i }));
  const { error } = await db.from("chapters").upsert(rows);
  if (error) { await reload(); return fail("Reorder", error); }
  chapters.forEach((c, i) => { c.ord = i; });
  sel = to;
  paintList(); paintInspector();
  reloadViewer();
}

async function deleteSlide(i) {
  const c = chapters[i];
  if (!c) return;
  const name = c.title || `Slide ${i + 1}`;
  if (!confirm(`Delete "${name}"?\n\nThe deck will renumber. This cannot be undone.`)) return;

  const { error } = await db.from("chapters").delete().eq("id", c.id);
  if (error) return fail("Delete slide", error);
  chapters.splice(i, 1);

  if (chapters.length) {
    const rows = chapters.map((ch, n) => ({ id: ch.id, deck_id: deck.id, ord: n }));
    const { error: e2 } = await db.from("chapters").upsert(rows);
    if (e2) { await reload(); return fail("Renumber", e2); }
    chapters.forEach((ch, n) => { ch.ord = n; });
  }

  sel = Math.max(0, Math.min(sel, chapters.length - 1));
  textDirty = false;
  toast("Slide deleted");
  paintList(); paintInspector();
  reloadViewer();
}

async function addSlide() {
  const prev = chapters[chapters.length - 1];
  const { data, error } = await db.from("chapters").insert({
    deck_id: deck.id, ord: chapters.length, kind: "scene",
    section: prev?.section || "Overview",
    title: "New slide", body: "",
    camera: prev?.camera || {},
    layers: prev?.layers || { blocks: true },
  }).select("*").single();
  if (error) return fail("Add slide", error);
  chapters.push(data);
  sel = chapters.length - 1;
  paintList(); paintInspector();
  reloadViewer();
  toast("Slide added");
}

async function reload() {
  const { data } = await db.from("chapters").select("*").eq("deck_id", deck.id).order("ord");
  chapters = data || [];
  sel = Math.max(0, Math.min(sel, chapters.length - 1));
  paintList(); paintInspector();
}

/** The viewer builds its chapter array once, at load. Adding, deleting or
 *  reordering changes that array's shape, and there is no bridge message for
 *  "your running order moved" — so the honest way to keep the preview truthful
 *  is to load it again. Text and camera edits patch in place and do not. */
function reloadViewer() {
  let any = false;
  for (const w of FRAMES) {
    if (!frames[w] || !frames[w].contentWindow) continue;
    ready[w] = false; live[w] = null;
    frames[w].contentWindow.location.reload();
    any = true;
  }
  if (!any) return;
  setSaveNote("Reloading previews…");
  setTimeout(() => setSaveNote(""), 1400);
}

// ----------------------------------------------------------------- paint ---

function camLabel(cam) {
  if (!cam || !Object.keys(cam).length) return "no camera set";
  if (cam.mode === "free") {
    return `free · ${cam.height} m · ${cam.heading}° / ${cam.pitch}°`;
  }
  const h = cam.h ?? 30, p = cam.p ?? -26, r = cam.r ?? 3000;
  return `${h}° / ${p}° / ${r} m`;
}

// What is on in a chapter, in the order someone reads a slide: what you are
// looking at, then how it is coloured, then how much of the ground is left.
function layerChips(L) {
  L = L || {};
  const on = [];
  if (L.property) on.push("property");
  if (L.blocks !== false) on.push("model");
  if (L.drills) on.push("drills");
  if (L.highlights) on.push("callouts");
  if (L.surfaces) on.push("surfaces");
  if (L.geo) on.push(String(L.geo));
  if (L.geochem) on.push("geochem");
  if (L.plan) on.push("plan");
  if (L.site) on.push("site");
  if (L.section3d) on.push(`section ${L.section3d}`);
  if (L.black) on.push("blackout");
  if (L.mode && L.mode !== "grade") on.push(L.mode);
  if (L.cut !== undefined) on.push(`cut ${L.cut}`);
  if (L.ground !== undefined) on.push(`terrain ${Math.round(L.ground * 100)}%`);
  return on;
}

function paintLive(which) {
  for (const w of which ? [which] : FRAMES) {
    const el = $(`stlive_${w}`);
    if (el) {
      const st = live[w];
      const o = st && st.camera?.orbit;
      el.textContent = !st ? "Loading…" : (o ? `${o.h}° / ${o.p}° / ${o.r} m` : "free camera");
    }
  }
  const hd = $("swlive");
  if (hd) {
    const st = live[active];
    const o = st && st.camera?.orbit;
    hd.textContent = !st ? "loading…" : (o ? `${o.h}° / ${o.p}° / ${o.r} m` : "free camera");
  }
}

function paintList() {
  const el = $("stlist");
  if (!el) return;
  const keepScroll = el.parentElement ? el.parentElement.scrollTop : 0;

  if (!chapters.length) {
    el.innerHTML = `<div class="stempty">No slides yet.<br>
      <button class="btn sm primary" id="stadd2">Add the first</button></div>`;
    const b = $("stadd2"); if (b) b.onclick = addSlide;
    return;
  }

  // Static warning, distinct from the measured one beside it: a slide that
  // changes deposit is the transition most likely to disappoint, and saying so
  // before anybody presses play is cheaper than finding out live.
  const depOf = (c) => (c.layers || {}).deposit || null;
  el.innerHTML = chapters.map((c, i) => {
    const chips = layerChips(c.layers);
    const nlab = Array.isArray(c.areas) ? c.areas.length : 0;
    if (nlab) chips.push(`${nlab} label${nlab === 1 ? "" : "s"}`);
    const swaps = i > 0 && depOf(c) && depOf(c) !== depOf(chapters[i - 1]);
    const t = timings[i];
    const onNow = live[active] && live[active].ord === i;
    return `<div class="stchap ${sel === i ? "sel" : ""} ${onNow ? "on" : ""}"
                 draggable="true" data-i="${i}">
      <button class="stgo" data-go="${i}">
        <span class="n">${String(i + 1).padStart(2, "0")}</span>
        <span class="grow">
          <b>${esc(c.title || "Untitled")}</b>
          <span class="cam">${esc(camLabel(c.camera))}${
            c.camera_portrait && Object.keys(c.camera_portrait).length
              ? ` <i class="pf" title="Has its own 9:16 framing">9:16</i>` : ""}</span>
          <span class="chips">${chips.map((x) => `<i>${esc(x)}</i>`).join("")}</span>
        </span>
      </button>
      <div class="strow">
        <button class="ico" data-up="${i}" ${i === 0 ? "disabled" : ""}
          title="Move up" aria-label="Move up">↑</button>
        <button class="ico" data-down="${i}" ${i === chapters.length - 1 ? "disabled" : ""}
          title="Move down" aria-label="Move down">↓</button>
        <button class="ico" data-play="${i}" ${i === 0 ? "disabled" : ""}
          title="${i === 0 ? "Nothing to transition from" : "Fly in from the slide before"}"
          aria-label="Replay the fly-in">▶</button>
        <button class="ico rm" data-rm="${i}" title="Delete this slide"
          aria-label="Delete slide">✕</button>
        ${swaps ? `<span class="stwarn" title="The model for this deposit downloads while the camera is already moving">deposit change</span>` : ""}
        ${t ? `<span class="sttime ${t.late ? "bad" : ""}">${
          t.late ? `geometry ${t.depMs - t.camMs} ms late`
                 : `${(t.camMs / 1000).toFixed(1)} s`}</span>` : ""}
      </div>
    </div>`;
  }).join("");

  el.querySelectorAll("[data-go]").forEach((b) =>
    b.onclick = () => selectSlide(+b.dataset.go));
  el.querySelectorAll("[data-up]").forEach((b) =>
    b.onclick = (e) => { e.stopPropagation(); moveSlide(+b.dataset.up, -1); });
  el.querySelectorAll("[data-down]").forEach((b) =>
    b.onclick = (e) => { e.stopPropagation(); moveSlide(+b.dataset.down, 1); });
  el.querySelectorAll("[data-rm]").forEach((b) =>
    b.onclick = (e) => { e.stopPropagation(); deleteSlide(+b.dataset.rm); });
  el.querySelectorAll("[data-play]").forEach((b) =>
    b.onclick = (e) => {
      e.stopPropagation();
      delete timings[+b.dataset.play];
      paintList();
      tell({ type: "transition", ord: +b.dataset.play });
    });

  wireDrag(el);
  if (el.parentElement) el.parentElement.scrollTop = keepScroll;
}

let dragFrom = null;
function wireDrag(el) {
  el.querySelectorAll(".stchap").forEach((row) => {
    row.ondragstart = (e) => {
      dragFrom = +row.dataset.i;
      e.dataTransfer.effectAllowed = "move";
      // Firefox will not start a drag without payload.
      e.dataTransfer.setData("text/plain", String(dragFrom));
      row.classList.add("dragging");
    };
    row.ondragend = () => {
      dragFrom = null;
      el.querySelectorAll(".stchap").forEach((r) =>
        r.classList.remove("dragging", "over"));
    };
    row.ondragover = (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("over");
    };
    row.ondragleave = () => row.classList.remove("over");
    row.ondrop = (e) => {
      e.preventDefault();
      row.classList.remove("over");
      const to = +row.dataset.i;
      if (dragFrom !== null && dragFrom !== to) dropSlide(dragFrom, to);
      dragFrom = null;
    };
  });
}

/** Only rebuilt when the selected slide changes. Repainting it on every state
 *  message would tear the caption out from under whoever is typing into it. */
function paintInspector() {
  const el = $("stinspect");
  if (!el) return;
  const c = chapters[sel];

  if (!c) {
    shownFor = null;
    el.innerHTML = `<div class="stempty">Nothing selected.</div>`;
    return;
  }
  // `shownFor` alone is not enough to skip the rebuild: it says which chapter
  // was last WRITTEN, not whether that markup is still on screen. route() has
  // no re-entrancy guard by design, and both the auth listener and hashchange
  // call it — so two renderStudio runs overlap routinely. The second one
  // replaced the whole view, and this then declined to draw into it because the
  // FIRST run had already claimed the same chapter id. The inspector stayed
  // permanently blank, with no error anywhere. Ask the DOM instead.
  if (shownFor === c.id && el.querySelector("#insp_title")) { paintCamera(); return; }
  shownFor = c.id;

  el.innerHTML = `
    <div class="insp-hd">
      <span class="n">Slide ${sel + 1} of ${chapters.length}</span>
      <button class="btn sm danger" id="insp_rm">Delete</button>
    </div>

    <div class="field">
      <label for="insp_title">Title</label>
      <input type="text" id="insp_title" value="${esc(c.title || "")}"
             placeholder="What this slide is about">
    </div>

    <div class="field">
      <label for="insp_body">Caption</label>
      <textarea id="insp_body" rows="5"
        placeholder="Shown beside the scene, and read aloud when narration is on."
        >${esc(c.body || "")}</textarea>
    </div>

    <div class="grid two">
      <div class="field">
        <label for="insp_section">Section</label>
        <input type="text" id="insp_section" value="${esc(c.section || "")}"
               placeholder="The property">
      </div>
      <div class="field">
        <label for="insp_dwell">Dwell (s)</label>
        <input type="number" id="insp_dwell" min="1" max="120"
               value="${Math.round((c.dwell_ms || 9000) / 1000)}">
      </div>
    </div>

    <div class="insp-cam">
      <span class="lbl">Framing</span>
      <p class="hint">Fly a preview to the shot you want, then store it against
         that shape. The phone can have its own — leave it unset and it uses the
         desktop one.</p>
      ${FRAMES.map((w) => {
        const cam = w === "tall" ? c.camera_portrait : c.camera;
        const set = cam && Object.keys(cam).length;
        return `
        <div class="camrow ${active === w ? "on" : ""}" data-camrow="${w}">
          <div class="camhd">
            <span class="nm">${LABEL[w]}</span>
            ${w === "tall" && !set ? `<span class="inherit">inherits desktop</span>` : ""}
          </div>
          <div class="camval" id="insp_cam_${w}">${esc(
            set ? camLabel(cam) : camLabel(c.camera))}</div>
          <div class="row-actions">
            <button class="btn sm primary" data-set="${w}">Set view</button>
            <button class="btn sm" data-setall="${w}"
              title="Also stores cut-off, terrain, mode, sections and every switched layer">+ layers</button>
            ${w === "tall" && set
              ? `<button class="btn sm danger" id="insp_clearp">Clear</button>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>`;

  for (const id of ["insp_title", "insp_body", "insp_section", "insp_dwell"]) {
    const f = $(id);
    f.oninput = scheduleTextSave;
    f.onblur = () => { if (textDirty) saveText(); };
  }
  $("insp_rm").onclick = () => deleteSlide(sel);
  el.querySelectorAll("[data-set]").forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    setActive(b.dataset.set);
    requestCapture("camera", b.dataset.set);
  });
  el.querySelectorAll("[data-setall]").forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    setActive(b.dataset.setall);
    requestCapture("all", b.dataset.setall);
  });
  el.querySelectorAll("[data-camrow]").forEach((r) =>
    r.onclick = () => setActive(r.dataset.camrow));
  if ($("insp_clearp")) $("insp_clearp").onclick = () => clearPortrait();
}

/** Drop a slide's phone framing so it goes back to inheriting the desktop one.
 *  An empty object, not null — the column is NOT NULL, and the viewer's test is
 *  "has any keys", so this is the same answer a never-framed chapter gives. */
async function clearPortrait() {
  const c = chapters[sel];
  if (!c) return;
  const { error } = await db.from("chapters")
    .update({ camera_portrait: {} }).eq("id", c.id);
  if (error) return fail("Clear framing", error);
  c.camera_portrait = {};
  shownFor = null;                        // the row's controls change shape
  paintInspector(); paintList();
  tell({ type: "saved", ok: true, ord: sel, what: "camera", chapter: c }, "tall");
  toast("Phone framing cleared");
}

function paintCamera() {
  const c = chapters[sel];
  if (!c) return;
  for (const w of FRAMES) {
    const el = $(`insp_cam_${w}`);
    if (!el) continue;
    const cam = w === "tall" ? c.camera_portrait : c.camera;
    const set = cam && Object.keys(cam).length;
    el.textContent = camLabel(set ? cam : c.camera);
  }
}
