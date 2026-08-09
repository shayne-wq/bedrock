// Orebody — the PowerPoint and PDF exports, as files.
//
//   node tools/verify_export.mjs <viewer url>
//
// These are the artifact that leaves the building. A deck link can be fixed
// after it is sent; a .pptx sitting in somebody's inbox cannot, so the things
// that matter are checked against the bytes rather than the code that wrote
// them: that every chapter produced a slide, that the file is named after the
// deck rather than after our demo property, and that each slide carries a link
// back to the live model — which is the only thing a static picture cannot do
// on its own.

import { chromium } from "playwright-core";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const URL_ = process.argv[2] || "http://127.0.0.1:8899/index.html";
let pass = 0, fail = 0;
const ok = (n, c, d = "") => c ? (pass++, console.log(`  ok   ${n}`))
                               : (fail++, console.log(`  FAIL ${n}${d ? " — " + d : ""}`));

const b = await chromium.launch({ channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
const pg = await ctx.newPage();
const errs = []; pg.on("pageerror", (e) => errs.push(String(e)));
await pg.goto(URL_, { waitUntil: "load" });
await pg.waitForFunction(() => window.__api && document.querySelectorAll("#rail .c").length > 0,
  null, { timeout: 120000 });
await pg.waitForTimeout(9000);

const chapters = (await pg.evaluate(() => window.__api.titles())).length;
// The export filename used to be the string "Elk-Gold-Siwash-North", so every
// customer's PowerPoint arrived named after our demo property — on a document
// they were about to send to an investor. It is derived from the deck now, and
// the only way to prove derivation is to change the deck and look.
await pg.evaluate(() => { document.title = "Cariboo Ridge · Orebody Present"; });
const dir = mkdtempSync(join(tmpdir(), "oreb-exp-"));

async function grab(buttonId, label) {
  await pg.evaluate(() => { const i = document.getElementById("intro"); if (i) i.style.display = "none"; });
  const wait = pg.waitForEvent("download", { timeout: 300000 });
  await pg.evaluate((id) => document.getElementById(id).click(), buttonId);
  const dl = await wait;
  const path = join(dir, dl.suggestedFilename());
  await dl.saveAs(path);
  console.log(`  (${label}: ${dl.suggestedFilename()})`);
  return { path, name: dl.suggestedFilename() };
}

console.log("== PowerPoint");
const pptx = await grab("expPptx", "pptx");
ok("named after the deck, not a hard-coded demo property",
   pptx.name === "Cariboo-Ridge.pptx", pptx.name);
const list = execFileSync("unzip", ["-Z1", pptx.path], { encoding: "utf8" }).split("\n");
const slides = list.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
ok("one slide per chapter", slides.length === chapters, `${slides.length} vs ${chapters}`);
const rels = execFileSync("unzip", ["-p", pptx.path, "ppt/slides/_rels/slide1.xml.rels"],
  { encoding: "utf8" });
ok("slide 1 carries an external hyperlink", /TargetMode="External"/.test(rels));
ok("and it points at the deck", /http/.test(rels), rels.slice(0, 200));
const xml1 = execFileSync("unzip", ["-p", pptx.path, "ppt/slides/slide1.xml"], { encoding: "utf8" });
ok("the image itself is the link, not only a caption",
   /<a:blip[\s\S]*?<a:hlinkClick|hlinkClick[\s\S]*?<a:blip/.test(xml1) ||
   (xml1.match(/hlinkClick/g) || []).length >= 2,
   String((xml1.match(/hlinkClick/g) || []).length));

console.log("\n== PDF");
const pdf = await grab("expPdf", "pdf");
const bytes = readFileSync(pdf.path, "latin1");
ok("named after the deck", pdf.name === "Cariboo-Ridge.pdf", pdf.name);
ok("one page per chapter",
   (bytes.match(/\/Type\s*\/Page[^s]/g) || []).length === chapters,
   String((bytes.match(/\/Type\s*\/Page[^s]/g) || []).length) + " vs " + chapters);
ok("carries link annotations", /\/Subtype\s*\/Link/.test(bytes));
ok("pointing at a real URL", /\/URI\s*\(https?:/.test(bytes),
   (bytes.match(/\/URI\s*\((.{0,60})/) || [])[1] || "none");

console.log("\nerrors:", errs.length ? errs : "none");
console.log(`${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail || errs.length ? 1 : 0);
