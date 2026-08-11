// Bedrock — every slot the console shows can actually be filled.
//
//   node tools/verify_slots.mjs
//
// This exists because two of them could not, and nothing said so. The console
// renders seven dataset slots per zone; the upload path is driven by a separate
// table (AUX), and GEOCHEM and TOPOGRAPHY were missing from it. `uploadAux`
// returns early when a kind has no entry, so the Add button on those two slots
// — and a file dropped on them — did nothing at all. No error, no toast. They
// could only be loaded by dropping on the zone, which routes by another path
// entirely. Topography is the dataset the geologists asked for by name.
//
// The second failure was quieter still: the `accept` filters on the file
// pickers had not kept up with the readers, so Geophysics accepted
// ".png,.jpg,.jpeg" and a user clicking Add could not select the GeoTIFF their
// contractor delivered — a format that had been readable for weeks. An accept
// filter narrower than the parser is a feature nobody can reach.
//
// So: the slots the console offers, the kinds the uploader knows, the kinds the
// parser handles and the extensions the sniffer reads all have to agree. This
// asserts that they do.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ingest = readFileSync(join(ROOT, "dashboard/ingest.js"), "utf8");
const app = readFileSync(join(ROOT, "dashboard/app.js"), "utf8");

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
  addEventListener() {}, body: { classList: { add() {}, remove() {} } } };
globalThis.location = { origin: "", pathname: "", hash: "" };
globalThis.addEventListener = () => {};
const { sniff } = await import("../dashboard/lib/formats.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") =>
  c ? (pass++, console.log("  ok   " + n))
    : (fail++, console.log("  FAIL " + n + (d ? " — " + d : "")));

// The slots the console renders, read from the source rather than restated —
// a copy here would drift and the drift is the bug.
const slotKinds = [...app.matchAll(/\{\s*key:\s*"(\w+)",\s*label:/g)].map((m) => m[1]);
// The kinds the uploader can open a dialog for.
const auxBlock = ingest.slice(ingest.indexOf("const AUX = {"),
                              ingest.indexOf("export function uploadAux"));
const auxKinds = [...auxBlock.matchAll(/^  (\w+):\s*\{/gm)].map((m) => m[1]);
// The kinds parseAux actually knows how to turn into geometry.
const parsedKinds = [...ingest.matchAll(/kind === "(\w+)"/g)].map((m) => m[1]);

console.log("— the console's slots:", slotKinds.join(", "));
ok("the console renders slots at all", slotKinds.length >= 6, String(slotKinds.length));

for (const k of slotKinds) {
  if (k === "blocks") {
    // The block model has its own wizard rather than an AUX entry.
    ok(`${k.padEnd(11)} has a loader`, /ingestWizard/.test(app), "no wizard call");
    continue;
  }
  ok(`${k.padEnd(11)} can be opened from its slot`, auxKinds.includes(k),
     `not in AUX — the Add button on this slot silently does nothing`);
  ok(`${k.padEnd(11)} can be turned into geometry`, parsedKinds.includes(k),
     `parseAux has no branch for it`);
}

console.log("\n— accept filters are not narrower than the readers");
// Every extension a picker offers must be one the sniffer will accept, or the
// dialog invites a file the next step rejects.
const accepts = [...auxBlock.matchAll(/accept:\s*"([^"]+)"/g)].map((m) => m[1]);
ok("every slot declares an accept filter", accepts.length >= auxKinds.length,
   `${accepts.length} filters for ${auxKinds.length} kinds`);
const offered = new Set(accepts.flatMap((a) => a.split(",")).map((e) => e.trim()));
const worldFiles = new Set([".tfw", ".pgw", ".jgw", ".wld"]);
for (const ext of offered) {
  if (worldFiles.has(ext) || ext === ".json") continue;   // paired / viewer-native
  const s = sniff({ name: `x${ext}` });
  ok(`${ext.padEnd(9)} offered by a picker and read by the parser`,
     s.readable !== false, JSON.stringify(s.format));
}

// And the reverse: the formats this product advertises must be reachable from
// some picker, or they are readable in principle and unusable in practice.
console.log("\n— the formats we advertise are reachable from a picker");
for (const [ext, why] of [
  [".tif", "GeoTIFF is what a geophysics contractor delivers"],
  [".asc", "ESRI ASCII grid is the one raster every package exports"],
  [".kml", "KML is half of what a boundary arrives as"],
  [".ts", "GOCAD is what Leapfrog writes for surfaces"],
  [".omf", "OMF is the whole point of the Leapfrog/Deswik path"],
  [".dxf", "DXF is what the CAD-lineage tools write"],
  [".obj", "OBJ is the other half of every wireframe export"],
]) {
  ok(`${ext.padEnd(6)} is selectable somewhere — ${why}`, offered.has(ext),
     "no picker offers it");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
