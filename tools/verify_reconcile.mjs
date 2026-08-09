// Orebody — the deck builder's save, against real Postgres.
//
//   node tools/verify_reconcile.mjs <API_URL> <SERVICE_ROLE_KEY>
//
// This exists because Save order used to DELETE every chapter and re-insert
// from the candidate template. That was defensible while a chapter was nothing
// but a copy of its candidate; the studio made it data loss — a camera someone
// flew to lived only in the chapter row, and saving the running order put the
// generator's default back over it.
//
// The replacement reconciles, and the part that can actually go wrong is the
// renumber: `unique (deck_id, ord)` means a slide moving earlier collides with
// whatever is already there unless the whole shuffle lands in ONE statement
// against the deferred constraint. Reasoning about that is not evidence, so it
// runs here.

// Straight at PostgREST rather than through supabase-js: the same requests the
// browser client makes, minus a dependency this repo does not otherwise have,
// and it means the `Prefer: resolution=merge-duplicates` behaviour the whole
// renumber depends on is exercised on the wire rather than through a wrapper.
const [, , URL_, KEY] = process.argv;
if (!URL_ || !KEY) { console.error("usage: verify_reconcile.mjs <url> <service key>"); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(method, path, body, prefer) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers: prefer ? { ...H, Prefer: prefer } : H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  return r.ok ? { data } : { error: data || { message: `HTTP ${r.status}` } };
}
const db = {
  select: (t, q) => rest("GET", `${t}?${q}`),
  insert: (t, rows) => rest("POST", t, rows, "return=representation"),
  upsert: (t, rows) => rest("POST", t, rows, "resolution=merge-duplicates,return=representation"),
  update: (t, q, patch) => rest("PATCH", `${t}?${q}`, patch),
  del: (t, q) => rest("DELETE", `${t}?${q}`),
};

let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log(`  ok   ${n}`))
                               : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));
const die = (what, e) => { console.error(what, e); process.exit(1); };

// ---- fixture ---------------------------------------------------------------
const ORG = "cccccccc-0000-0000-0000-000000000001";
const PRJ = "cccccccc-0000-0000-0000-000000000002";
const DCK = "cccccccc-0000-0000-0000-000000000003";
await db.del("orgs", `id=eq.${ORG}`);
let r = await db.insert("orgs", { id: ORG, name: "Reconcile Co", slug: "reconcile-co" });
if (r.error) die("org", r.error);
r = await db.insert("projects", { id: PRJ, org_id: ORG, name: "P", slug: "recon-p", epsg: 26910 });
if (r.error) die("project", r.error);
r = await db.insert("decks", { id: DCK, project_id: PRJ, title: "D" });
if (r.error) die("deck", r.error);

const mk = (ord, title, source, camera) => ({
  deck_id: DCK, ord, title, source, camera: camera || { h: ord * 10, p: -26, r: 3000 },
  layers: {},
});
r = await db.insert("chapters", [
  mk(0, "A", "cand:a"), mk(1, "B", "cand:b"), mk(2, "C", "cand:c"),
  mk(3, "D", "cand:d"), mk(4, "E", "cand:e"),
]);
if (r.error) die("chapters", r.error);

const load = async () => (await db.select("chapters", `deck_id=eq.${DCK}&order=ord`)).data;

// Something the studio authored, which the old code destroyed.
let rows = await load();
const authored = { h: 137, p: -8, r: 640 };
await db.update("chapters", `id=eq.${rows.find((c) => c.source === "cand:b").id}`,
  { camera: authored, title: "B (flown)" });

// ---- the reconcile, exactly as deck.js runs it ------------------------------
async function saveOrder(order) {
  const all = await load();
  const keep = new Set(order.filter((o) => o.chapterId).map((o) => o.chapterId));
  const gone = all.filter((c) => !keep.has(c.id)).map((c) => c.id);
  if (gone.length) {
    const e = (await db.del("chapters", `id=in.(${gone.join(",")})`)).error;
    if (e) return { error: e };
  }
  const moves = [];
  order.forEach((o, i) => {
    if (!o.chapterId) return;
    if (o.row.ord !== i) moves.push({ ...o.row, ord: i });
  });
  if (moves.length) {
    const e = (await db.upsert("chapters", moves)).error;
    if (e) return { error: e };
  }
  const fresh = [];
  order.forEach((o, i) => {
    if (o.chapterId) return;
    fresh.push({ deck_id: DCK, ord: i, title: o.cand.title, source: o.cand.id,
                 camera: o.cand.camera, layers: {} });
  });
  if (fresh.length) {
    const e = (await db.insert("chapters", fresh)).error;
    if (e) return { error: e };
  }
  return {};
}
const entry = (c) => ({ key: "ch:" + c.id, chapterId: c.id, row: c });
const cand = (id, title) => ({ key: "cd:" + id, chapterId: null,
  cand: { id, title, camera: { h: 1, p: -2, r: 3 } } });

console.log("== a full reversal, which is the worst case for unique(deck_id, ord)");
rows = await load();
let res = await saveOrder([...rows].reverse().map(entry));
ok("the shuffle lands in one statement", !res.error, res.error?.message);
rows = await load();
ok("every slide is still there", rows.length === 5, String(rows.length));
ok("the order actually reversed",
   rows.map((c) => c.source).join(",") === "cand:e,cand:d,cand:c,cand:b,cand:a",
   rows.map((c) => c.source).join(","));
ok("ords are 0..4 with no holes", rows.map((c) => c.ord).join(",") === "0,1,2,3,4",
   rows.map((c) => c.ord).join(","));

console.log("\n== the thing this was written for");
const b = rows.find((c) => c.source === "cand:b");
ok("an authored camera survives a save", JSON.stringify(b.camera) === JSON.stringify(authored),
   JSON.stringify(b.camera));
ok("an edited title survives a save", b.title === "B (flown)", b.title);

console.log("\n== add, remove and move in one save");
rows = await load();
const keepThree = rows.filter((c) => c.source !== "cand:a" && c.source !== "cand:e");
res = await saveOrder([cand("cand:new1", "New one"), ...keepThree.map(entry),
                       cand("cand:new2", "New two")]);
ok("mixed save succeeds", !res.error, res.error?.message);
rows = await load();
ok("two removed, two added", rows.length === 5, String(rows.length));
ok("the new slides landed where they were put",
   rows[0].source === "cand:new1" && rows[4].source === "cand:new2",
   rows.map((c) => c.source).join(" "));
ok("the authored one is still authored",
   JSON.stringify(rows.find((c) => c.source === "cand:b").camera) === JSON.stringify(authored));
ok("removed slides are gone", !rows.some((c) => c.source === "cand:a"));

console.log("\n== a save that changes nothing");
rows = await load();
res = await saveOrder(rows.map(entry));
ok("no-op save succeeds", !res.error, res.error?.message);
const after = await load();
ok("no-op save changes nothing",
   JSON.stringify(after.map((c) => [c.id, c.ord])) ===
   JSON.stringify(rows.map((c) => [c.id, c.ord])));

await db.del("orgs", `id=eq.${ORG}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
