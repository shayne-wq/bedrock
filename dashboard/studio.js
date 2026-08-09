// Orebody console — the studio.
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

import {
  db, $, esc, toast, fail, modal, closeModal, skeleton,
} from "./lib/ui.js";
import { CONFIG } from "./config.js";

const VIEWER = "/index.html";

let deck = null, chapters = [], project = null, frame = null;
let ready = false, live = null;          // live = last state reported by the viewer
let undo = null;                         // { ord, before } — one step, which is the one that matters

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

export async function renderStudio(id, view) {
  view.innerHTML = skeleton(4);
  ready = false; live = null; undo = null;

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
        <button class="btn" id="stundo" disabled title="Put the last chapter back the way it was">Undo</button>
        <a class="btn primary" href="#/d/${deck.id}">Done</a>
      </div>
    </div></header>

    ${!chapters.length ? `<div class="empty"><h3>No chapters yet</h3>
      <p>Build a running order first — the studio adjusts slides, it does not
         choose them.</p>
      <a class="btn primary" href="#/d/${deck.id}">Back to the deck</a></div>`
    : !token ? `<div class="empty"><h3>Needs a share link</h3>
      <p>The studio opens your deck the way a recipient sees it, so that what
         you author is what they get. That needs a live share link, and one is
         not created for you — a token is a thing that can be forwarded.</p>
      <button class="btn primary" id="stmklink">Create one now</button></div>`
    : `<p class="lead" style="margin:-6px 0 14px">Fly to the shot you want, then
        press <b>Set view</b> in the viewer. <b>Set view + layers</b> also stores
        the cut-off, terrain, mode, sections and every switched layer exactly as
        they are on screen.</p>
      <div class="studio">
        <aside class="stchaps"><div id="stlist"></div></aside>
        <div class="stview">
          <div id="stlive" class="stlive">Waiting for the viewer…</div>
          <iframe id="stframe" title="Deck preview"
            src="${VIEWER}?t=${encodeURIComponent(token)}&api=${
              encodeURIComponent(CONFIG.url.replace(/\/$/, "") + "/functions/v1")
            }&author=1"></iframe>
        </div>
      </div>`}`;

  if (!chapters.length) return;
  if (!token) {
    $("stmklink").onclick = () => makeLink(id);
    return;
  }

  frame = $("stframe");
  $("stundo").onclick = doUndo;
  paintList();
  addEventListener("message", onMessage);
}

// The console must not stay subscribed after the route changes, or a second
// studio session ends up with two handlers writing the same chapter twice.
export function teardownStudio() {
  removeEventListener("message", onMessage);
  frame = null; ready = false; live = null; undo = null;
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

function onMessage(e) {
  // Same origin as the console, and the exact frame we put there. Neither check
  // is sufficient alone: origin without source lets any same-origin frame on
  // the page speak, source without origin trusts whatever the frame navigated
  // to if it ever left our document.
  if (e.origin !== location.origin) return;
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data;
  if (!d || d.source !== "orebody-viewer") return;

  if (d.type === "hello") {
    frame.contentWindow.postMessage({ source: "orebody-console", type: "hello" },
                                    location.origin);
    return;
  }
  if (d.type === "ready") { ready = true; poll(); return; }
  if (d.type === "state") { live = d.state; paintLive(); paintList(); return; }
  if (d.type === "set") { save(d.state, d.what); return; }
}

function tell(msg) {
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage(
      Object.assign({ source: "orebody-console" }, msg), location.origin);
  }
}
const poll = () => tell({ type: "poll" });

// ---------------------------------------------------------------- writing --

async function save(state, what) {
  const c = chapters[state.ord];
  if (!c) { tell({ type: "saved", ok: false, ord: state.ord }); return; }

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
    patch.camera = state.camera.orbit || state.camera.free;
    if (what === "all") {
      // Title, body and section are the author's prose and are NOT touched
      // here. Only what is switched on in the scene.
      patch.layers = state.layers || {};
    }
  }

  undo = { ord: state.ord,
           before: { camera: c.camera, layers: c.layers, areas: c.areas || [] } };
  $("stundo").disabled = false;

  const { error } = await db.from("chapters").update(patch).eq("id", c.id);
  if (error) {
    undo = null; $("stundo").disabled = true;
    fail("Save chapter", error);
    tell({ type: "saved", ok: false, ord: state.ord, what });
    return;
  }
  Object.assign(c, patch);
  tell({ type: "saved", ok: true, ord: state.ord, what, chapter: c });
  toast(what === "areas"
    ? `${patch.areas.length} label${patch.areas.length === 1 ? "" : "s"} published`
    : what === "all" ? "View and layers saved" : "View saved");
  paintList();
}

async function doUndo() {
  if (!undo) return;
  const c = chapters[undo.ord];
  if (!c) return;
  const { error } = await db.from("chapters")
    .update(undo.before).eq("id", c.id);
  if (error) return fail("Undo", error);
  Object.assign(c, undo.before);
  tell({ type: "saved", ok: true, ord: undo.ord, what: "undo", chapter: c });
  tell({ type: "goto", ord: undo.ord });
  undo = null;
  $("stundo").disabled = true;
  toast("Reverted");
  paintList();
}

// ----------------------------------------------------------------- paint ---

function camLabel(cam) {
  if (!cam) return "no camera";
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

function paintLive() {
  const el = $("stlive");
  if (!el) return;
  if (!live) { el.textContent = "Waiting for the viewer…"; return; }
  const o = live.camera?.orbit;
  el.innerHTML = `<span class="k">On screen</span>
    <b>${esc(live.title || "Chapter " + (live.ord + 1))}</b>
    <span class="v">${o ? `${o.h}° / ${o.p}° / ${o.r} m` : "free camera"}</span>`;
}

function paintList() {
  const el = $("stlist");
  if (!el) return;
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
    return `<div class="stchap ${live && live.ord === i ? "on" : ""}">
      <button class="stgo" data-go="${i}">
        <span class="n">${String(i + 1).padStart(2, "0")}</span>
        <span class="grow">
          <b>${esc(c.title || "Untitled")}</b>
          <span class="cam">${esc(camLabel(c.camera))}</span>
          <span class="chips">${chips.map((x) => `<i>${esc(x)}</i>`).join("")}</span>
        </span>
      </button>
      <div class="strow">
        <button class="btn sm" data-play="${i}" ${i === 0 ? "disabled" : ""}
          title="${i === 0 ? "Nothing to transition from" : "Fly in from the slide before"}">Replay in</button>
        ${swaps ? `<span class="stwarn" title="The model for this deposit downloads while the camera is already moving">deposit change</span>` : ""}
        ${t ? `<span class="sttime ${t.late ? "bad" : ""}">${
          t.late ? `geometry ${t.depMs - t.camMs} ms late`
                 : `${(t.camMs / 1000).toFixed(1)} s`}</span>` : ""}
      </div>
    </div>`;
  }).join("");
  el.querySelectorAll("[data-go]").forEach((b) =>
    b.onclick = () => tell({ type: "goto", ord: +b.dataset.go }));
  el.querySelectorAll("[data-play]").forEach((b) =>
    b.onclick = () => {
      delete timings[+b.dataset.play];
      paintList();
      tell({ type: "transition", ord: +b.dataset.play });
    });
}
