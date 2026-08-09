// Orebody console — shell, auth and routing.
//
// Vanilla ES modules on purpose. The viewer is a single static file with no
// build step; splitting the product across a bundled framework app and an
// unbundled viewer would mean maintaining two toolchains for one thing.

import {
  db, state, CONFIGURED, $, esc, fmtT, fmtOz, fmtInt, fmtDate, slugify,
  toast, fail, modal, closeModal, skeleton, wire,
} from "./lib/ui.js";
import { ingestWizard, uploadAux, putAux, routeFiles } from "./ingest.js";
import { sniff } from "./lib/formats.js";
import { renderDeck } from "./deck.js";
import { renderStudio, teardownStudio } from "./studio.js";

const view = $("view");

// ------------------------------------------------------------------ boot ---
let booted = false;
async function boot() {
  if (!CONFIGURED) return renderSetup();
  view.innerHTML = skeleton(4);

  // Render from the auth listener so the first paint reflects a restored
  // session rather than the moment before it lands. Worth being precise about
  // the failure this guards against: RLS answers an unauthenticated read with an
  // empty set, not an error, so anything that queries too early looks like a
  // brand new account rather than a broken one.
  db.auth.onAuthStateChange(() => { booted = true; route(); });

  // INITIAL_SESSION always fires, but never leave the console on a skeleton if
  // it somehow does not.
  setTimeout(() => { if (!booted) route(); }, 2000);
}

function chromeOff() {
  document.querySelector("#rail nav").innerHTML = "";
  $("who").textContent = "";
  $("signout").style.display = "none";
}

function renderSetup() {
  chromeOff();
  view.innerHTML = `
    <header class="page">
      <span class="eyebrow">Setup</span>
      <h1>Connect a Supabase project</h1>
      <p>The console needs somewhere to keep projects, decks and view analytics.
         Create a Supabase project, apply the migrations in
         <code>supabase/migrations</code>, then paste its URL and anon key below.
         Step-by-step instructions are in <code>docs/BACKEND.md</code>.</p>
    </header>
    <div class="panel" style="max-width:560px">
      <div class="field">
        <label for="su">Project URL</label>
        <input type="text" id="su" placeholder="https://xxxxxxxx.supabase.co" spellcheck="false">
      </div>
      <div class="field">
        <label for="sk">Anon key</label>
        <input type="text" id="sk" placeholder="eyJhbGciOi…" spellcheck="false">
      </div>
      <p class="hintline">The anon key belongs in a browser — every table denies
         it by default. Never paste the service role key here.</p>
      <button class="btn primary" id="sv" style="margin-top:12px">Connect</button>
    </div>`;
  $("sv").onclick = () => {
    const u = $("su").value.trim(), k = $("sk").value.trim();
    if (!u || !k) return toast("Both fields are required.", true);
    window.orebodyUse(u, k);
  };
}

function renderAuth() {
  chromeOff();
  view.innerHTML = `
    <header class="page">
      <span class="eyebrow">Orebody</span>
      <h1>Sign in</h1>
      <p>We email you a link. There is no password to choose, forget or reuse.</p>
    </header>
    <div class="panel" style="max-width:420px">
      <div class="field">
        <label for="em">Work email</label>
        <input type="email" id="em" autocomplete="email" placeholder="you@company.com">
      </div>
      <button class="btn primary" id="send">Email me a link</button>
      <p class="hintline" id="authmsg"></p>
    </div>`;
  const send = async () => {
    const email = $("em").value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return toast("That does not look like an email address.", true);
    }
    $("send").disabled = true; $("send").textContent = "Sending…";
    const { error } = await db.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + location.pathname },
    });
    $("send").disabled = false; $("send").textContent = "Email me a link";
    if (error) return fail("Sign in", error);
    $("authmsg").textContent = `Link sent to ${email}. It expires in an hour.`;
  };
  $("send").onclick = send;
  $("em").onkeydown = (e) => { if (e.key === "Enter") send(); };
}

$("signout").onclick = async () => { await db.auth.signOut(); location.hash = ""; };

// ---------------------------------------------------------------- router ---
// No re-entrancy guard. Collapsing overlapping runs behind a flag was tried and
// removed: a run that never settles leaves the flag raised and freezes the
// console on whatever rendered last, which is a far worse failure than the brief
// double render it avoids. Renders here are a handful of DOM writes.
async function route() {
  if (!CONFIGURED) return renderSetup();
  // The client is the authority on whether we are signed in, not a cached copy.
  const { data: sess } = await db.auth.getSession();
  state.session = sess.session;
  if (!state.session) return renderAuth();
  $("signout").style.display = "";
  $("who").textContent = state.session.user.email;

  // Auth redirects come back as "#access_token=…", which is not a route. Only
  // a hash that starts with "#/" is one; anything else is home. Without this the
  // console renders a blank page the first time a user ever signs in, which is
  // the worst possible moment for it.
  teardownStudio();
  const raw = location.hash.startsWith("#/") ? location.hash.slice(2) : "";
  const h = raw.split("/");                        // "#/p/<id>" -> ["p", id]
  await loadOrgs();
  document.querySelector("#rail nav").innerHTML =
    `<a href="#/" class="${!h[0] ? "on" : ""}">Projects</a>`;
  try {
    if (h[0] === "p" && h[1]) return await renderProject(h[1]);
    if (h[0] === "s" && h[1]) return await renderStudio(h[1], view);
    if (h[0] === "d" && h[1]) return await renderDeck(h[1], view);
    return await renderHome();
  } catch (e) { fail("Load", e); }
}
addEventListener("hashchange", route);

async function loadOrgs() {
  const { data, error } = await db.from("orgs").select("id, name, slug").order("name");
  // Assign either way. Returning early on error left the previous value in
  // place, so a single failed load could strand the console showing "create
  // your first organisation" to someone who already had one.
  state.orgs = data || [];
  if (error) fail("Organisations", error);
}

// ------------------------------------------------------------------ home ---
async function renderHome() {
  view.innerHTML = `<header class="page"><span class="eyebrow">Orebody</span>
    <h1>Projects</h1></header>${skeleton(4)}`;

  if (!state.orgs.length) return renderFirstOrg();

  const { data: projects, error } = await db
    .from("projects")
    .select("id, name, commodity, location, created_at, decks(id)")
    .order("created_at", { ascending: false });
  if (error) return fail("Projects", error);

  view.innerHTML = `
    <header class="page"><div class="row">
      <div class="grow">
        <span class="eyebrow">${esc(state.orgs[0].name)}</span>
        <h1>Projects</h1>
      </div>
      <button class="btn primary" id="newp">New project</button>
    </div></header>
    ${!projects.length ? `
      <div class="empty">
        <h3>No projects yet</h3>
        <p>A project holds one deposit: its block model, its drilling, and the
           decks you build from them.</p>
        <button class="btn primary" id="newp2">Create the first one</button>
      </div>` : `
      <div class="panel"><div class="tablewrap"><table>
        <thead><tr><th>Project</th><th>Commodity</th><th>Location</th>
          <th class="n">Decks</th><th class="n">Created</th></tr></thead>
        <tbody>${projects.map((p) => `
          <tr style="cursor:pointer" data-go="#/p/${p.id}">
            <td><b>${esc(p.name)}</b></td>
            <td>${esc(p.commodity || "—")}</td>
            <td>${esc(p.location || "—")}</td>
            <td class="n mono">${p.decks?.length || 0}</td>
            <td class="n mono">${fmtDate(p.created_at)}</td>
          </tr>`).join("")}</tbody>
      </table></div></div>`}`;

  wire(view);
  for (const id of ["newp", "newp2"]) if ($(id)) $(id).onclick = newProject;
}

function renderFirstOrg() {
  view.innerHTML = `
    <header class="page">
      <span class="eyebrow">Welcome</span>
      <h1>Create your organisation</h1>
      <p>Projects, decks, share links and view analytics all belong to an
         organisation. You will be its owner.</p>
    </header>
    <div class="panel" style="max-width:460px">
      <div class="field">
        <label for="on">Organisation name</label>
        <input type="text" id="on" placeholder="Northern Gold Corp">
      </div>
      <button class="btn primary" id="mk">Create organisation</button>
    </div>`;
  $("mk").onclick = async () => {
    const name = $("on").value.trim();
    if (!name) return toast("Give it a name first.", true);
    $("mk").disabled = true;
    // Slugs are globally unique; suffix rather than make the user resolve a
    // collision with a company they cannot see.
    const { error } = await db.from("orgs").insert({
      name, slug: slugify(name) + "-" + Math.random().toString(36).slice(2, 6),
    });
    $("mk").disabled = false;
    if (error) return fail("Create organisation", error);
    await loadOrgs();
    route();
  };
}

function newProject() {
  modal(`
    <h2>New project</h2>
    <p class="sub">A project holds one or more zones — add the first after it
       is created.</p>
    <div class="field"><label for="pn">Name</label>
      <input type="text" id="pn" placeholder="Siwash North"></div>
    <div class="grid two">
      <div class="field"><label for="pc">Commodity</label>
        <input type="text" id="pc" placeholder="Gold"></div>
      <div class="field"><label for="pl">Location</label>
        <input type="text" id="pl" placeholder="Cariboo, British Columbia"></div>
    </div>
    <div class="field"><label for="pe">Coordinate system (EPSG)</label>
      <input type="number" id="pe" value="26910">
      <p class="hintline">The projection your block model is in — 26910 is UTM
         zone 10N (NAD83). Data is stored in its native system and reprojected
         for display, so this is not a conversion you can lose precision to.</p>
    </div>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn primary" id="pgo">Create project</button>
      <button class="btn" id="pcancel">Cancel</button>
    </div>`);
  $("pcancel").onclick = closeModal;
  $("pgo").onclick = async () => {
    const name = $("pn").value.trim();
    if (!name) return toast("A project needs a name.", true);
    $("pgo").disabled = true;
    const { data, error } = await db.from("projects").insert({
      org_id: state.orgs[0].id, name, slug: slugify(name),
      commodity: $("pc").value.trim() || null,
      location: $("pl").value.trim() || null,
      epsg: Number($("pe").value) || 26910,
    }).select("id").single();
    $("pgo").disabled = false;
    if (error) return fail("Create project", error);
    closeModal();
    location.hash = `#/p/${data.id}`;
  };
}

// --------------------------------------------------------------- project ---
async function renderProject(id) {
  view.innerHTML = skeleton(5);
  const { data: p, error } = await db.from("projects")
    .select("id, name, commodity, location, epsg, org_id, holders").eq("id", id).maybeSingle();
  if (error) return fail("Project", error);
  if (!p) {
    view.innerHTML = `<div class="empty"><h3>Project not found</h3>
      <p>It may have been deleted, or it belongs to an organisation you are not
         a member of.</p>
      <a class="btn" href="#/">Back to projects</a></div>`;
    return;
  }

  const [{ data: zones }, { data: datasets }, { data: decks }] = await Promise.all([
    db.from("zones").select("*").eq("project_id", id)
      .order("ord").order("created_at"),
    db.from("datasets").select("*").eq("project_id", id).order("created_at"),
    db.from("decks").select("id, title, status, updated_at, chapters(id)")
      .eq("project_id", id).order("updated_at", { ascending: false }),
  ]);

  const zs = zones || [];
  const dsByZone = {};
  (datasets || []).forEach((d) => { (dsByZone[d.zone_id] ||= []).push(d); });
  const zoneKind = (z, k) => (dsByZone[z.id] || []).find((d) => d.kind === k);
  const zonesWithBlocks = zs.filter((z) => zoneKind(z, "blocks"));
  // What makes a zone presentable is having ANY data, not having a resource.
  // Gating deck creation on a block model meant an exploration project — the
  // common case — could load its claims, magnetics and drilling and still be
  // told it had nothing to show.
  const zonesWithData = zs.filter((z) => (dsByZone[z.id] || []).length);
  const fabricated = (datasets || []).filter((d) => d.synthetic);

  // Project totals sum every zone's block model. Grade is tonnage-weighted —
  // backed out of the summed ounces and tonnes — so a small high-grade zone
  // does not drag the headline the way a plain average of grades would.
  let T = 0, OZ = 0, B = 0;
  zonesWithBlocks.forEach((z) => {
    const s = zoneKind(z, "blocks").stats?.total;
    if (s) { T += s.tonnes || 0; OZ += s.oz || 0; B += s.blocks || 0; }
  });
  const grade = T ? (OZ * 31.10348) / T : 0;

  // TRACKING.md #1. Nothing here is required. Most projects are pure
  // exploration — drilling, magnetics and geochem, no resource — and marking
  // the block model mandatory told the majority of users their project was
  // incomplete because they had not finished defining it yet. The viewer
  // renders an exploration deck properly; the console had to stop asking.
  //
  // Order is exploration-first for the same reason: the property outline and
  // the magnetics are what an early-stage project actually has.
  const KINDS = [
    { key: "site", label: "Property & claims" },
    { key: "geophysics", label: "Geophysics" },
    { key: "geochem", label: "Geochemistry" },
    { key: "drills", label: "Drill holes" },
    { key: "blocks", label: "Block model", note: "resource stage" },
    { key: "surfaces", label: "Surfaces" },
  ];
  const slot = (z, k) => {
    const ds = zoneKind(z, k.key);
    return `<div class="slot ${ds ? "on" : ""}">
      <span class="k">${k.label}${k.note ? ` <em class="opt">${k.note}</em>` : ""}</span>
      ${ds ? `<span class="chip ${ds.synthetic ? "warn" : "live"}">${ds.synthetic ? "Fabricated" : "Loaded"}</span>
        <button class="btn sm" data-load="${k.key}" data-zone="${z.id}">Replace</button>
        <button class="btn sm danger" data-del="${ds.id}">Remove</button>`
       : `<button class="btn sm" data-load="${k.key}" data-zone="${z.id}">Add</button>`}
    </div>`;
  };

  view.innerHTML = `
    <header class="page"><div class="row">
      <div class="grow">
        <span class="eyebrow"><a href="#/">Projects</a> / ${esc(p.commodity || "Project")}</span>
        <h1>${esc(p.name)}</h1>
        <p>${esc(p.location || "No location set")} · EPSG ${p.epsg}
           · ${zs.length} zone${zs.length === 1 ? "" : "s"}</p>
      </div>
      <button class="btn primary" id="newdeck" ${zonesWithData.length ? "" : "disabled"}>New deck</button>
    </div></header>

    ${fabricated.length ? `<div class="note warn" style="margin-bottom:16px">
      <b>This project contains fabricated data.</b>
      ${esc([...new Set(fabricated.map((d) => d.kind))].join(", "))} —
      ${esc(fabricated[0].synthetic_note || "not real")}.
      Every deck built from it carries the warning on screen and in exports.
    </div>` : ""}

    ${T ? `<div class="panel"><div class="grid three">
      <div class="stat"><span class="l">Tonnage</span><b>${fmtT(T)}</b>
        <span class="sub">${fmtInt(B)} blocks · ${zonesWithBlocks.length} zone${zonesWithBlocks.length === 1 ? "" : "s"}</span></div>
      <div class="stat"><span class="l">Grade</span><b>${grade.toFixed(2)} g/t</b>
        <span class="sub">tonnage-weighted across zones</span></div>
      <div class="stat"><span class="l">Contained metal</span><b>${fmtOz(OZ)}</b>
        <span class="sub">summed over all zones</span></div>
    </div></div>` : ""}

    <div class="panel">
      <div class="row"><h2 class="grow">Zones</h2>
        <button class="btn" id="addzone">Add zone</button></div>
      ${zs.length ? zs.map((z) => {
        const s = zoneKind(z, "blocks")?.stats?.total;
        const nk = (dsByZone[z.id] || []).length;
        return `<div class="zone">
          <div class="row"><div class="grow"><b>${esc(z.name)}</b>
            ${s ? `<span class="zsub">${fmtT(s.tonnes)} · ${s.grade_gt} g/t · ${fmtOz(s.oz)}</span>`
                : nk ? `<span class="zsub">Exploration stage — ${nk} dataset${nk === 1 ? "" : "s"} · no resource estimate</span>`
                : `<span class="zsub">Empty — add whatever this zone has</span>`}</div>
            <button class="btn sm danger" data-delzone="${z.id}">Delete zone</button></div>
          <div class="slots">${KINDS.map((k) => slot(z, k)).join("")}</div>
        </div>`;
      }).join("") : `
        <div class="empty">
          <h3>No zones yet</h3>
          <p>A zone is one deposit or target. Add your first, then load whatever
             it has — property outline, geophysics, drilling. Files are read in
             this browser and never leave your machine. A block model is only
             needed once the project has a resource.</p>
          <button class="btn primary" id="addzone2">Add the first zone</button>
        </div>`}
    </div>

    <div class="panel" id="nbpanel" hidden>
      <div class="row"><h2 class="grow">Neighbouring ground</h2>
        <span class="hint" id="nbcount"></span></div>
      <p class="lead" style="margin:0 0 12px">Companies whose tenure surrounds
         this project, read from the register in your uploaded boundary file.
         A logo is the difference between a name a generalist has never heard
         and one they recognise, which is most of why this layer is worth a
         slide. Private individuals are shown as one anonymous group and are
         not listed here.</p>
      <div id="nblist"></div>
    </div>

    <div class="panel">
      <h2>Decks</h2>
      ${!decks?.length ? `
        <div class="empty">
          <h3>No decks yet</h3>
          <p>${zonesWithData.length ? "A deck is the walkthrough you present, share and embed — one deck flies across every zone in this project."
                      : "Add a zone and load whatever this project has — a property outline, magnetics, drilling. A block model is only needed once there is a resource."}</p>
          ${zonesWithData.length ? `<button class="btn primary" id="newdeck2">Create a deck</button>` : ""}
        </div>` : `
        <div class="tablewrap"><table>
          <thead><tr><th>Deck</th><th>Status</th><th class="n">Chapters</th>
            <th class="n">Updated</th></tr></thead>
          <tbody>${decks.map((d) => `
            <tr style="cursor:pointer" data-go="#/d/${d.id}">
              <td><b>${esc(d.title)}</b></td>
              <td><span class="chip ${d.status === "published" ? "live" : "draft"}">${esc(d.status)}</span></td>
              <td class="n mono">${d.chapters?.length || 0}</td>
              <td class="n mono">${fmtDate(d.updated_at)}</td>
            </tr>`).join("")}</tbody>
        </table></div>`}
    </div>`;

  wire(view);
  renderHolders(p, datasets || []);
  view.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Remove this dataset? Decks that use it will stop rendering it.")) return;
      const { error: e2 } = await db.from("datasets").delete().eq("id", b.dataset.del);
      if (e2) return fail("Remove", e2);
      toast("Dataset removed");
      route();
    };
  });
  view.querySelectorAll("[data-delzone]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this zone and every dataset in it? This cannot be undone.")) return;
      const { error: e2 } = await db.from("zones").delete().eq("id", b.dataset.delzone);
      if (e2) return fail("Delete zone", e2);
      toast("Zone deleted");
      route();
    };
  });
  view.querySelectorAll("[data-load]").forEach((b) => {
    b.onclick = () => {
      const kind = b.dataset.load;
      const z = zs.find((x) => x.id === b.dataset.zone);
      if (!z) return;
      if (kind === "blocks") ingestWizard(p, z, route);
      else uploadAux(p, z, kind, route);
    };
  });

  // Drop a file straight onto the slot. This is the gesture everyone tries
  // first, and until now the boxes ignored it — you had to click Add, wait for
  // a modal, and drop into that instead. The modal still opens, because a
  // block model needs its columns confirmed and drills need three files, but
  // the file you dropped is already answered when it does.
  // Drop files anywhere on a zone and they are sorted into slots by what they
  // are. This is the actual gesture: a geologist has a folder of exports, not
  // a form to fill in five times.
  //
  // What is NOT inferred is whether anything is fabricated. That is a claim
  // about provenance rather than a property of the bytes, and it stays a
  // decision the person uploading makes — so a routed upload records real, and
  // the slot's chip is how you say otherwise.
  view.querySelectorAll(".zone").forEach((zel) => {
    const zid = zel.querySelector("[data-delzone]")?.dataset.delzone;
    const z = zs.find((x) => x.id === zid);
    if (!z) return;
    ["dragenter", "dragover"].forEach((t) => zel.addEventListener(t, (e) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault(); zel.classList.add("dropping");
    }));
    ["dragleave", "drop"].forEach((t) => zel.addEventListener(t, (e) => {
      e.preventDefault(); zel.classList.remove("dropping");
    }));
    zel.addEventListener("drop", async (e) => {
      // A slot handles its own drop; do not also route it at the zone level.
      if (e.target.closest?.(".slot")) return;
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      const { byKind, unknown } = routeFiles(files);
      const kinds = Object.keys(byKind);
      // Name what we cannot take. "Unrecognised" for a file we can identify
      // precisely as a Vulcan block model is a worse answer than telling the
      // user to export CSV — they came here to get their data in, not to be
      // told it is unfamiliar.
      const named = unknown.map((f) => sniff(f)).filter((x) => x.label && x.advice);
      if (!kinds.length) {
        if (named.length) return toast(`${named[0].label}: ${named[0].advice}`, true);
        return toast(`Could not tell what ${files.length === 1 ? "that file is" : "those files are"}. Use Add on the right slot.`, true);
      }
      const done = [];
      for (const kind of kinds) {
        const chosen = byKind[kind];
        // The block model is never routed silently: its column mapping has to
        // be confirmed before any tonnage is computed from it.
        if (kind === "blocks") { ingestWizard(p, z, route, chosen[0].file); return; }
        try {
          await putAux(p, z, kind, chosen, false, "");
          done.push(`${kind} (${chosen.length})`);
        } catch (err) { fail(`Save ${kind}`, err); return; }
      }
      const miss = unknown.length ? `, ${unknown.length} not recognised` : "";
      toast(`Loaded ${done.join(", ")} into ${z.name}${miss}`);
      route();
    });
  });

  view.querySelectorAll(".slot").forEach((el) => {
    const btn = el.querySelector("[data-load]");
    if (!btn) return;
    const kind = btn.dataset.load;
    const z = zs.find((x) => x.id === btn.dataset.zone);
    if (!z) return;
    ["dragenter", "dragover"].forEach((t) => el.addEventListener(t, (e) => {
      e.preventDefault(); el.classList.add("dropping");
    }));
    ["dragleave", "drop"].forEach((t) => el.addEventListener(t, (e) => {
      e.preventDefault(); el.classList.remove("dropping");
    }));
    el.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (kind === "blocks") ingestWizard(p, z, route, f);
      else uploadAux(p, z, kind, route, f);
    });
  });
  for (const k of ["addzone", "addzone2"]) if ($(k)) $(k).onclick = () => addZone(p);
  for (const k of ["newdeck", "newdeck2"]) if ($(k)) $(k).onclick = () => newDeck(p, zonesWithBlocks);
}

// ------------------------------------------------------------------ zones ---
function addZone(p) {
  modal(`
    <h2>Add a zone</h2>
    <p class="sub">One deposit — its own block model, drills, surfaces, property
       and geophysics. A single deck flies across every zone in the project.</p>
    <div class="field"><label for="zn">Zone name</label>
      <input type="text" id="zn" placeholder="Siwash North"></div>
    <div class="row-actions" style="margin-top:16px">
      <button class="btn primary" id="zgo">Add zone</button>
      <button class="btn" id="zcancel">Cancel</button>
    </div>`);
  $("zcancel").onclick = closeModal;
  $("zn").onkeydown = (e) => { if (e.key === "Enter") $("zgo").click(); };
  $("zgo").onclick = async () => {
    const name = $("zn").value.trim();
    if (!name) return toast("A zone needs a name.", true);
    $("zgo").disabled = true;
    // Order after the last existing zone, and make the slug unique within the
    // project by suffixing if the base is taken.
    const { data: existing } = await db.from("zones")
      .select("slug, ord").eq("project_id", p.id);
    const taken = new Set((existing || []).map((z) => z.slug));
    let slug = slugify(name), n = 2;
    while (taken.has(slug)) slug = `${slugify(name)}-${n++}`;
    const ord = (existing || []).reduce((m, z) => Math.max(m, z.ord + 1), 0);
    const { error } = await db.from("zones")
      .insert({ project_id: p.id, name, slug, ord });
    $("zgo").disabled = false;
    if (error) return fail("Add zone", error);
    closeModal();
    route();
  };
}

async function newDeck(p, zonesWithBlocks = []) {
  // A deck spans zones: it records which ones are in play so the viewer's
  // deposit switcher can offer them. Every zone that has a block model is
  // included by default — the presenter can narrow it later in the editor.
  const zoneIds = zonesWithBlocks.map((z) => z.id);
  const { data, error } = await db.from("decks")
    .insert({
      project_id: p.id, title: p.name, status: "draft",
      settings: { zones: zoneIds },
    })
    .select("id").single();
  if (error) return fail("Create deck", error);
  // A deck with no chapters cannot be previewed at all, so seed one.
  await db.from("chapters").insert({
    deck_id: data.id, ord: 0, kind: "scene", section: "Overview",
    title: p.name, body: "Set the scene here.", camera: {}, layers: { blocks: true },
  });
  location.hash = `#/d/${data.id}`;
}

$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

export { route };
boot();

// ------------------------------------------------- neighbouring holders ----
// The register names whoever holds the ground around a project, and the viewer
// draws the companies among them as their own assets — colour, parcel, name.
// The one thing it cannot derive is a logo, and the logo is most of the value:
// "Vizsla Copper Corp." means nothing to a generalist investor and its mark
// means a great deal.
//
// Supplied here, never fetched. A company's mark is its trademark, and pulling
// one off the web to put beside real tenure on an investor slide is not a
// thing to do automatically.

// Same rule as the viewer's, and the same reason: ten of the sixteen holders
// around the demo property are private individuals. They are not listed in
// this panel at all — there is nothing to brand, and a console that invites
// you to upload a logo for a named private citizen is asking a strange
// question.
const CORP_RE =
  /\b(CORP|CORPORATION|INC|INCORPORATED|LTD|LIMITED|LLC|LLP|PLC|COMPANY|RESOURCES|MINERALS|METALS|MINING|EXPLORATION|VENTURES|HOLDINGS|GROUP|PARTNERSHIP|TRUST|SOCIETY|NATION|BAND|MUNICIPALITY|PROVINCE|CROWN)\b/i;
const normOwner = (x) => (x || "").trim().toUpperCase().replace(/\s+/g, " ");
const isCorporate = (n) => !!n && (CORP_RE.test(n.trim()) || n.indexOf(",") < 0);

async function renderHolders(project, datasets) {
  const site = datasets.find((d) => d.kind === "site");
  const owners = site?.stats?.owners;
  const panel = $("nbpanel");
  if (!panel || !Array.isArray(owners) || !owners.length) return;

  const subject = normOwner(site.stats.subject_owner || "");
  const corps = owners
    .filter((o) => normOwner(o.owner) !== subject && isCorporate(o.owner))
    .sort((a, b) => (b.ha || 0) - (a.ha || 0));
  if (!corps.length) return;

  panel.hidden = false;
  const stored = project.holders || {};
  const logoOf = (name) => {
    const v = stored[name] ?? stored[normOwner(name)];
    return (v && typeof v === "object" ? v.logo : v) || "";
  };

  $("nbcount").textContent =
    `${corps.length} compan${corps.length === 1 ? "y" : "ies"}`;
  $("nblist").innerHTML = corps.map((o) => {
    const logo = logoOf(o.owner);
    return `<div class="nbrow" data-owner="${esc(o.owner)}">
      <div class="nblogo">${logo
        ? `<img src="${esc(logo)}" alt="">`
        : `<span>${esc(initials(o.owner))}</span>`}</div>
      <div class="grow">
        <b>${esc(o.owner)}</b>
        <span class="mono hint">${o.claims || 0} claim${o.claims === 1 ? "" : "s"}
          · ${Math.round(o.ha || 0).toLocaleString()} ha</span>
      </div>
      <div class="row-actions">
        <label class="btn sm">Logo<input type="file" accept="image/*" hidden
          data-logo="${esc(o.owner)}"></label>
        ${logo ? `<button class="btn sm danger" data-rmlogo="${esc(o.owner)}">Remove</button>` : ""}
      </div>
    </div>`;
  }).join("");

  const initialsOf = initials;
  $("nblist").querySelectorAll("[data-logo]").forEach((inp) => {
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const data = await shrinkLogo(f);
        await saveHolder(project, inp.dataset.logo, data);
      } catch (e) { fail("Logo", e); }
    };
  });
  $("nblist").querySelectorAll("[data-rmlogo]").forEach((b) => {
    b.onclick = () => saveHolder(project, b.dataset.rmlogo, null);
  });
  void initialsOf;
}

function initials(name) {
  const stop = /^(CORP|CORPORATION|INC|INCORPORATED|LTD|LIMITED|LLC|LLP|PLC|CO|COMPANY|THE|AND|OF)\.?$/i;
  const w = (name || "").split(/[\s.,]+/).filter((x) => x && !stop.test(x));
  return (w.slice(0, 2).map((x) => x[0]).join("") || "?").toUpperCase();
}

// Downscaled here rather than stored as uploaded. These live in a jsonb column
// that ships inside the deck payload on every open, so a 900 KB press-kit PNG
// would be paid for by every viewer, every time, to draw a 40 px square.
function shrinkLogo(file, max = 160) {
  return new Promise((res, rej) => {
    if (!/^image\//.test(file.type)) return rej(new Error("That is not an image."));
    if (file.size > 8 * 1024 * 1024) return rej(new Error("That image is over 8 MB."));
    const fr = new FileReader();
    fr.onerror = () => rej(new Error("Could not read that file."));
    fr.onload = () => {
      const im = new Image();
      im.onerror = () => rej(new Error("Could not decode that image."));
      im.onload = () => {
        const s = Math.min(1, max / Math.max(im.width, im.height));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(im.width * s));
        cv.height = Math.max(1, Math.round(im.height * s));
        // PNG, not JPEG: a logo on a dark card needs its transparency, and a
        // white JPEG box around a wordmark looks like a mistake.
        cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
        res(cv.toDataURL("image/png"));
      };
      im.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

async function saveHolder(project, owner, logo) {
  const holders = { ...(project.holders || {}) };
  const key = normOwner(owner);
  // Drop any legacy key for the same holder under different spacing, so the
  // register's inconsistency cannot leave two entries fighting.
  Object.keys(holders).forEach((k) => { if (normOwner(k) === key) delete holders[k]; });
  if (logo) holders[key] = { logo };
  const { error } = await db.from("projects").update({ holders }).eq("id", project.id);
  if (error) return fail("Save logo", error);
  project.holders = holders;
  toast(logo ? "Logo saved" : "Logo removed");
  route();
}
