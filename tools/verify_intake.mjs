// Drives the client onboarding page in a real browser against a MOCKED
// Supabase API. The access rules are not tested here — the database enforces
// them and supabase/tests/intake_test.sql asserts them. This checks the page:
// it opens an intake, autosaves by section, uploads into the right slot, flags a
// format we cannot read, gates signing on completeness, and signs with the
// exact number of statements shown.
//
//   python3 -m http.server 8765 &   # from the repo root
//   node tools/verify_intake.mjs http://127.0.0.1:8765/dashboard/ [shots-dir]

import { createRequire } from "node:module";
// require() rather than import: it finds a globally installed Playwright.
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8765/dashboard/";
const SHOTS = process.argv[3] || null;
const API = "http://mockapi.test";

const UID = "11111111-0000-0000-0000-00000000000c";
const ORG = "22222222-0000-0000-0000-000000000001";
const PID = "33333333-0000-0000-0000-000000000001";
const TERMS = { version: "2026-10-27", current: true, statements: [
  "I am authorized by {company} to provide this.", "{company} owns this data.",
  "Confidential items identified.", "Access only for listed people.", "QP will review."] };

const db = {
  intake: null, files: [], atts: [], calls: [], objects: [],
};

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: UID, role: "authenticated",
  email: "ceo@issuer.test", exp: 4102444800 })}.sig`;

function reply(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json",
    headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "*" },
    body: body === undefined ? "" : JSON.stringify(body) });
}

async function api(route) {
  const req = route.request();
  const u = new URL(req.url());
  const m = req.method();
  if (m === "OPTIONS") return route.fulfill({ status: 204, headers: {
    "access-control-allow-origin": "*", "access-control-allow-headers": "*",
    "access-control-allow-methods": "*" } });
  const one = (req.headers().accept || "").includes("vnd.pgrst.object");
  const out = (rows) => one ? (rows[0] ? reply(route, rows[0]) : reply(route, { message: "none" }, 406))
                            : reply(route, rows);
  let body = null;
  try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { /* a file upload */ }
  const p = u.pathname;
  db.calls.push(`${m} ${p}`);

  if (p.startsWith("/auth/v1/user")) return reply(route, { id: UID, email: "ceo@issuer.test" });
  if (p === "/rest/v1/rpc/redeem_invites") return reply(route, 0);
  if (p === "/rest/v1/orgs") return out([{ id: ORG, name: "Issuer Gold Corp", slug: "issuer" }]);
  if (p === "/rest/v1/org_members") return out([{ org_id: ORG, role: "client" }]);
  if (p === "/rest/v1/projects") return out([{ id: PID, org_id: ORG, name: "Golden Ridge",
    commodity: "Gold", location: "BC", epsg: 26909, stage: null, brand: {}, holders: {},
    created_at: "2026-10-01", decks: [] }]);
  if (["/rest/v1/zones", "/rest/v1/datasets", "/rest/v1/decks"].includes(p)) return out([]);
  if (p === "/rest/v1/intakes") {
    if (m === "POST") {
      db.intake = { id: "44444444-0000-0000-0000-000000000001", project_id: PID, status: "open",
        answers: body.answers || {}, updated_at: new Date().toISOString() };
      return out([db.intake]);
    }
    return out(db.intake ? [db.intake] : []);
  }
  if (p === "/rest/v1/intake_terms") return out([TERMS]);
  if (p === "/rest/v1/intake_attestations") return out(db.atts);
  if (p === "/rest/v1/intake_files") {
    if (m === "POST") {
      const row = { id: `f${db.files.length + 1}`, uploaded_at: new Date().toISOString(), ...body };
      db.files.push(row);
      return out([row]);
    }
    if (m === "DELETE") { db.files = db.files.filter((f) => `id=eq.${f.id}` !== u.search.slice(1)); return reply(route, undefined, 204); }
    return out(db.files);
  }
  if (p === "/rest/v1/rpc/intake_save") {
    db.intake.answers[body.p_section] = body.p_value;
    return reply(route, new Date().toISOString());
  }
  if (p === "/rest/v1/rpc/submit_intake") {
    db.signed = body;
    db.intake.status = "submitted";
    db.intake.submitted_at = new Date().toISOString();
    db.atts = [{ id: "a1", signer_name: body.p_signer_name, signer_title: body.p_signer_title,
      signer_email: "ceo@issuer.test", signed_at: db.intake.submitted_at, company_name: "Issuer Gold Corp",
      project_name: "Golden Ridge", terms_version: body.p_terms_version,
      statements: TERMS.statements.map((s) => s.replaceAll("{company}", "Issuer Gold Corp")),
      people: db.intake.answers.access.people, files: db.files }];
    return reply(route, { attestation: "a1", invited: 1, already_members: 0 });
  }
  if (p.startsWith("/storage/v1/object/intake/")) {
    db.objects.push(decodeURIComponent(p.slice("/storage/v1/object/intake/".length)));
    return reply(route, { Key: p });
  }
  return reply(route, { message: `unmocked ${m} ${p}` }, 404);
}

let pass = 0, failN = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log("  ok   " + n))
                              : (failN++, console.log("  FAIL " + n + (d ? " — " + d : "")));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
page.on("dialog", (d) => d.accept());
await page.route(`${API}/**`, api);
await page.addInitScript(([url, token, uid]) => {
  localStorage.setItem("bedrock.supabase", JSON.stringify({ url, anonKey: "anon" }));
  localStorage.setItem("sb-mockapi-auth-token", JSON.stringify({
    access_token: token, token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
    refresh_token: "r", user: { id: uid, email: "ceo@issuer.test", aud: "authenticated" } }));
}, [API, jwt, UID]);

// --- the project page offers onboarding to a client -----------------------
await page.goto(`${BASE}#/p/${PID}`, { waitUntil: "load" });
await page.waitForSelector(".onbcard", { timeout: 15000 });
ok("project page shows the onboarding card", await page.isVisible("text=Start onboarding"));

// --- opening it creates the intake, seeded from the project ---------------
await page.click("text=Start onboarding");
await page.waitForSelector("#isec-company", { timeout: 10000 });
ok("intake row created on first visit", !!db.intake);
ok("seeded from the project", db.intake?.answers?.company?.project_name === "Golden Ridge");
ok("all eight sections render", (await page.$$(".isec")).length === 8);
ok("fourteen data rows", (await page.$$(".drow")).length === 14);
ok("sign is disabled while incomplete", await page.isDisabled("#signit"));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/intake-top.png` });

// --- autosave, by section -------------------------------------------------
await page.fill('[data-path="company.legal_name"]', "Issuer Gold Corp.");
await page.waitForTimeout(1200);
ok("typing saves the company section", db.intake.answers.company?.legal_name === "Issuer Gold Corp.");
ok("save indicator says Saved", (await page.textContent("#savestate")) === "Saved");

// --- uploads ---------------------------------------------------------------
await page.setInputFiles('[data-upload="drill_collars"]',
  { name: "collars.csv", mimeType: "text/csv", buffer: Buffer.from("hole,x,y,z\nA,1,2,3\n") });
await page.waitForSelector('.drow[data-slot="drill_collars"] .fline', { timeout: 10000 });
ok("file stored under org/project/", db.objects.some((o) => o.startsWith(`${ORG}/${PID}/`) && o.endsWith("collars.csv")));
ok("file row recorded in the right slot", db.files.some((f) => f.slot === "drill_collars" && f.format === "csv"));
ok("uploading marks the row as attached", db.intake.answers.data?.drill_collars?.have === "yes");

await page.setInputFiles('[data-upload="blocks"]',
  { name: "model.bmf", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3]) });
await page.waitForSelector('.drow[data-slot="blocks"] .fline', { timeout: 10000 });
ok("a Vulcan model is flagged as unreadable", await page.isVisible('.drow[data-slot="blocks"] .chip.warn'));
ok("with the export advice", /CSV/.test(await page.textContent('.drow[data-slot="blocks"] .fadvice')));

// --- fill the rest ----------------------------------------------------------
for (const [k, v] of Object.entries({ project_name: "Golden Ridge", commodity: "Gold",
  location: "Toodoggone, BC", crs: "EPSG 26909" })) await page.fill(`[data-path="company.${k}"]`, v);
await page.selectOption('[data-path="company.stage"]', "exploration");
for (const r of await page.$$("[data-have]")) {
  if (!(await r.inputValue())) await r.selectOption("later");
}
for (let i = 0; i < 4; i++) await page.fill(`[data-list="focal.points.${i}.point"]`, `Point ${i + 1}`);
await page.check('[data-check="neighbours.none"]');
await page.fill('[data-path="audience.audience"]', "Retail investors");
await page.fill('[data-path="audience.qp_name"]', "Jane Geo, P.Geo.");
await page.click("#addperson");
await page.waitForSelector('[data-list="access.people.0.email"]');
await page.fill('[data-list="access.people.0.name"]', "New Geologist");
await page.fill('[data-list="access.people.0.email"]', "geo@issuer.test");
await page.fill('[data-path="access.main_contact"]', "Jane Doe, CEO, ceo@issuer.test");
await page.fill('[data-path="timeline.draft_date"]', "2026-12-01");
await page.waitForTimeout(1200);
ok("every section reads complete", (await page.$$(".inav a.done")).length === 7,
   `${(await page.$$(".inav a.done")).length} of 7`);
ok("sign is enabled once complete", !(await page.isDisabled("#signit")));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/intake-sign.png`, fullPage: true });

// --- signing ----------------------------------------------------------------
await page.click("#signit");
await page.waitForTimeout(500);
ok("refuses to sign with statements unticked", !db.signed);
for (const b of await page.$$("[data-stmt]")) await b.check();
await page.fill("#sname", "Jane Doe");
await page.fill("#stitle", "CEO");
await page.click("#signit");
await page.waitForSelector(".sigrec", { timeout: 10000 });
ok("signed with every statement counted", db.signed?.p_accepted === 5);
ok("signed against the terms shown", db.signed?.p_terms_version === "2026-10-27");
ok("form is locked after signing", await page.isDisabled('[data-path="company.legal_name"]'));
ok("no upload buttons after signing", (await page.$$("[data-upload]")).length === 0);
if (SHOTS) {
  await page.screenshot({ path: `${SHOTS}/intake-signed.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}#/i/${PID}`);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#isec-company", { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/intake-phone.png`, fullPage: true });
}

ok("no page errors", !errs.length, errs.join(" | "));
console.log(`\n${pass} passed, ${failN} failed`);
await browser.close();
process.exit(failN ? 1 : 0);
