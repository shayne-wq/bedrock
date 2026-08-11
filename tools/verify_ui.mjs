// Orebody — drive the built deck in a real browser.
//
//   node tools/verify_ui.mjs [url] [screenshot.png]
//
// Static checks catch a typo; they do not catch a shortcut bound to a key that
// something else already claimed, or a button whose handler bails before it
// does anything. Both of those shipped, and both are why this exists.
//
// Needs playwright-core and a Chrome binary. It deliberately does NOT pull one:
//   npm i playwright-core
// and point EXE below at any Chrome/Chromium already on the machine.
//
// WebGL in headless Chrome needs the SwiftShader fallback, so this asks for it
// explicitly — without it Cesium fails to get a context and every check below
// would report a failure that has nothing to do with the code under test.

import { chromium } from "playwright-core";

const URL_BASE = process.argv[2] || "http://127.0.0.1:8899/index.html";
const EXE = "/Users/shaynetaker/Library/Caches/ms-playwright/chromium-1223/" +
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? (pass++, console.log(`  ok   ${name}`))
       : (fail++, console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`));
};

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
         "--ignore-gpu-blocklist", "--enable-webgl", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const badReqs = [];
page.on("response", (r) => { if (r.status() >= 400) badReqs.push(r.status() + " " + r.url()); });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

console.log(`opening ${URL_BASE}`);
await page.goto(URL_BASE + "?nocache=verify&autoplay=0", { waitUntil: "load", timeout: 60000 });
// Cesium boots asynchronously; the rail is only built once chapters exist.
await page.waitForFunction(() => document.querySelectorAll("#rail .c").length > 0,
                           null, { timeout: 60000 });
await page.waitForTimeout(9000);

console.log("\n== boot");
const boot = await page.evaluate(() => ({
  chapters: document.querySelectorAll("#rail .c").length,
  fatal: document.getElementById("status").className,
  status: document.getElementById("status").textContent,
  hasViewer: !!window.__viewer,
  deposits: [...document.querySelectorAll("#depseg button")].map((b) => b.textContent),
  deprowShown: !document.getElementById("deprow").hidden,
}));
ok("deck booted without a fatal", boot.fatal !== "fatal", boot.status);
ok("viewer exists", boot.hasViewer);
ok("25 chapters", boot.chapters === 25, `got ${boot.chapters}`);
ok("deposit switcher is populated", boot.deposits.length === 2, JSON.stringify(boot.deposits));
ok("switcher tags the fabricated deposit",
   boot.deposits.some((t) => /Nicola South/.test(t) && /synthetic/i.test(t)),
   JSON.stringify(boot.deposits));
ok("no page errors during boot", errors.length === 0, errors.slice(0, 3).join(" | "));

// dismiss the intro so overlays do not sit on top of everything
await page.evaluate(() => document.getElementById("begin")?.click());
await page.waitForTimeout(1500);

console.log("\n== drill ledger + callouts (chapter 11: 'Drilled from surface')");
const drillCh = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#rail .c")];
  const i = rows.findIndex((r) => /Drilled from surface/.test(r.textContent));
  if (i >= 0) rows[i].click();
  return i;
});
await page.waitForTimeout(7000);
const led = await page.evaluate(() => ({
  ledgerShown: !document.getElementById("ledger").hidden,
  railHidden: getComputedStyle(document.getElementById("rail")).display === "none",
  rows: document.querySelectorAll("#ledglist .lrow").length,
  title: document.getElementById("ledgt").textContent,
  note: document.getElementById("ledgnote").textContent,
  assayLeg: getComputedStyle(document.getElementById("assayleg")).display,
}));
ok("ledger auto-opened on a drilling chapter", led.ledgerShown);
ok("rail steps aside for it", led.railHidden);
ok("ledger lists holes in view", led.rows > 0, `rows=${led.rows} title="${led.title}"`);
ok("ledger declares the holes fabricated", /FABRICATED/i.test(led.note), led.note);
ok("assay legend visible with the traces", led.assayLeg === "flex");

const graph = await page.evaluate(async () => {
  document.querySelector("#ledglist .lrow")?.click();
  await new Promise((r) => setTimeout(r, 3500));
  return {
    open: !document.getElementById("holegraph").hidden,
    title: document.getElementById("hgt").textContent,
    bars: document.querySelectorAll("#hgbody svg rect").length,
    cap: document.querySelector("#hgbody .hgcap")?.textContent || "",
  };
});
ok("clicking a hole opens the downhole graph", graph.open);
ok("graph drew assay bars", graph.bars > 3, `rects=${graph.bars}`);
ok("graph caption marks it fabricated", /FABRICATED/i.test(graph.cap), graph.cap);

console.log("\n== intercept callouts");
const co = await page.evaluate(async () => {
  document.getElementById("cobtn").click();
  await new Promise((r) => setTimeout(r, 2500));
  const cards = [...document.querySelectorAll(".cocard")];
  const boxes = cards.map((c) => c.getBoundingClientRect());
  let overlap = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const sameSide = (a.left < 400) === (b.left < 400);
      if (sameSide && a.left < b.right && b.left < a.right &&
          a.top < b.bottom && b.top < a.bottom) overlap++;
    }
  return { cards: cards.length, overlap,
           leaders: document.querySelectorAll("#calloutsvg path").length,
           dots: document.querySelectorAll("#calloutsvg circle").length,
           syn: cards.filter((c) => /fabricated/i.test(c.textContent)).length };
});
ok("callout cards rendered", co.cards > 0, `cards=${co.cards}`);
ok("no two cards overlap in a column", co.overlap === 0, `overlaps=${co.overlap}`);
ok("each card has a leader line", co.leaders === co.cards, `${co.leaders} leaders / ${co.cards} cards`);
ok("each leader ends in a marker", co.dots === co.cards);
ok("cards carry the fabricated label", co.syn === co.cards);

console.log("\n== blackout");
const black = await page.evaluate(async () => {
  const btn = document.getElementById("blackbtn");
  // A CHAPTER can turn blackout on by itself — the drilling chapter does, since
  // an underground shot wants nothing behind it. So start from a known state
  // instead of assuming the button begins off, or this asserts that a toggle
  // turned something on when it actually turned it off.
  if (btn.classList.contains("on")) { btn.click(); await new Promise((r) => setTimeout(r, 900)); }
  btn.click();
  await new Promise((r) => setTimeout(r, 2000));
  const v = window.__viewer;
  return { on: document.getElementById("blackbtn").classList.contains("on"),
           imagery: v.imageryLayers.get(0).show,
           sky: v.scene.skyAtmosphere.show,
           terrainStillThere: !!v.terrainProvider };
});
ok("blackout engages", black.on);
ok("imagery is off", black.imagery === false);
ok("sky is off", black.sky === false);
ok("terrain provider is untouched", black.terrainStillThere);
await page.evaluate(() => document.getElementById("blackbtn").click());
await page.waitForTimeout(1200);

console.log("\n== property columns");
const prop = await page.evaluate(async () => {
  const before = window.__viewer.scene.primitives.length;
  document.getElementById("propbtn").click();
  return { before };
});
// the button only toggles class; drive the real path through the keyboard
await page.keyboard.press("o");
await page.waitForTimeout(14000);
const propRes = await page.evaluate(() => ({
  legend: getComputedStyle(document.getElementById("propleg")).display,
  legendText: document.getElementById("propleg").textContent,
  labels: window.__viewer.entities.values.filter(
    (e) => e.label && /Siwash North|Nicola South/.test(e.label.text?.getValue?.() ?? "")).length,
  warn: document.getElementById("synwarn").textContent,
  warnOn: document.getElementById("synwarn").classList.contains("on"),
  prims: window.__viewer.scene.primitives.length,
}));
ok("property legend appears", propRes.legend === "flex", propRes.legendText);
ok("legend states gram-metres", /g·m/.test(propRes.legendText), propRes.legendText);
ok("both deposits labelled on leader lines", propRes.labels === 2, `labels=${propRes.labels}`);
ok("banner flags the fabricated deposit in the property view",
   propRes.warnOn && /property view|block model/i.test(propRes.warn), propRes.warn);

console.log("\n== deposit switch");
const sw = await page.evaluate(async () => {
  const btns = [...document.querySelectorAll("#depseg button")];
  const nic = btns.find((b) => /Nicola/.test(b.textContent));
  nic.click();
  await new Promise((r) => setTimeout(r, 16000));
  const audit = (() => {
    document.getElementById("provbtn").click();
    const t = document.getElementById("provbody").textContent;
    document.getElementById("provclose").click();
    return t;
  })();
  return {
    on: nic.classList.contains("on"),
    warn: document.getElementById("synwarn").textContent,
    warnOn: document.getElementById("synwarn").classList.contains("on"),
    veins: document.getElementById("vsel").options.length,
    chips: document.querySelectorAll("#clschips .chip").length,
    audit,
  };
});
ok("switched to the fabricated deposit", sw.on);
ok("banner condemns the whole block model",
   sw.warnOn && /block model/i.test(sw.warn), sw.warn);
ok("audit says every number is invented",
   /BLOCK MODEL ITSELF IS FABRICATED/.test(sw.audit));
ok("audit reports Nicola South tonnage",
   /38,815,26\d|38,815,2/.test(sw.audit.replace(/\s+/g, " ")),
   (sw.audit.match(/DEPOSIT TOTAL[\s\S]{0,80}/) || [""])[0]);
ok("vein list repopulated for the new deposit", sw.veins === 7,
   `options=${sw.veins} (expect 6 zones + "All veins")`);
ok("class chips repopulated", sw.chips === 3, `chips=${sw.chips}`);

const back = await page.evaluate(async () => {
  [...document.querySelectorAll("#depseg button")].find((b) => /Siwash/.test(b.textContent)).click();
  await new Promise((r) => setTimeout(r, 14000));
  document.getElementById("provbtn").click();
  const t = document.getElementById("provbody").textContent;
  document.getElementById("provclose").click();
  return { veins: document.getElementById("vsel").options.length, audit: t };
});
ok("switching back restores 46 vein domains", back.veins === 47, `options=${back.veins}`);
ok("switching back restores the real tonnage",
   /8,985,428/.test(back.audit.replace(/\s+/g, " ")));
ok("no BLOCKS_SYNTHETIC caveat on the real deposit",
   !/BLOCK MODEL ITSELF IS FABRICATED/.test(back.audit));

await page.screenshot({ path: process.argv[3] || "/tmp/orebody-verify.png" });
console.log("\n== errors seen");
if (badReqs.length) console.log("  failing requests: " + badReqs.slice(0,5).join(" | "));
if (errors.length) errors.slice(0, 8).forEach((e) => console.log("  " + e.slice(0, 160)));
else console.log("  none");
ok("no runtime errors across the whole run", errors.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
