// Bedrock — the Open Mining Format reader.
//
//   node tools/verify_omf.mjs
//
// The fixture here is written to the published v0.9 spec, from scratch, in this
// file: 60-byte header (magic, version, uid, JSON offset), a binary blob of
// zlib'd little-endian arrays, then the JSON dictionary keyed by UID. That is
// deliberate — a fixture produced by the same code that reads it proves nothing
// about whether we can open what Leapfrog writes. Written from the spec, it at
// least proves we agree with the spec.
//
// Why OMF and not the others: every other binary format in the table is refused
// on principle, and taking a Vulcan .bmf apart showed why — 576 MB of it held
// not one variable name, so any reader would have had to guess which column was
// zinc. OMF is open, governed, and self-describing: every element and every
// attribute carries its own name. That is the whole difference, and the
// assertions below are mostly about names surviving the trip.

import zlib from "node:zlib";
import { readOMF } from "../dashboard/lib/formats.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") =>
  c ? (pass++, console.log("  ok   " + n))
    : (fail++, console.log("  FAIL " + n + (d ? " — " + d : "")));

// ---- build a real OMF v1 file ---------------------------------------------
const blobParts = [];
let cursor = 60;
const putF8 = (nums) => {
  const b = Buffer.alloc(nums.length * 8);
  nums.forEach((v, i) => b.writeDoubleLE(v, i * 8));
  const z = zlib.deflateSync(b);                 // zlib wrapper, per the spec
  const idx = { start: cursor, length: z.length, dtype: "<f8" };
  blobParts.push(z); cursor += z.length;
  return idx;
};
const putI8 = (nums) => {
  const b = Buffer.alloc(nums.length * 8);
  nums.forEach((v, i) => b.writeBigInt64LE(BigInt(v), i * 8));
  const z = zlib.deflateSync(b);
  const idx = { start: cursor, length: z.length, dtype: "<i8" };
  blobParts.push(z); cursor += z.length;
  return idx;
};

// A two-triangle surface, offset by an origin, with a named grade attribute.
const verts = putF8([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 5]);
const tris = putI8([0, 1, 2, 0, 2, 3]);
const gradeArr = putF8([1.2, 3.4, 5.6, 7.8]);
// A 2 x 2 x 1 block model with an uneven lattice — OMF carries per-block widths
// natively, which is the sub-blocked case this product otherwise has to refuse.
const tu = putF8([10, 20]), tv = putF8([10, 10]), tw = putF8([5]);
const znArr = putF8([0.5, 1.5, 2.5, 3.5]);

const J = {
  "proj-uid": { __class__: "Project", name: "Tom Deposit",
                elements: ["surf-uid", "vol-uid"] },
  "surf-uid": { __class__: "SurfaceElement", name: "Vein 2400",
                description: "modelled shell", geometry: "sgeom", data: ["gdata"] },
  sgeom: { __class__: "SurfaceGeometry", origin: [500000, 6000000, 1200],
           vertices: verts, triangles: tris },
  gdata: { __class__: "ScalarData", name: "Au g/t", location: "vertices",
           array: "garr" },
  garr: { __class__: "ScalarArray", array: gradeArr },
  "vol-uid": { __class__: "VolumeElement", name: "Resource model",
               geometry: "vgeom", data: ["zndata"] },
  vgeom: { __class__: "VolumeGridGeometry", origin: [500000, 6000000, 1000],
           axis_u: [1, 0, 0], axis_v: [0, 1, 0], axis_w: [0, 0, 1],
           tensor_u: tu, tensor_v: tv, tensor_w: tw },
  zndata: { __class__: "ScalarData", name: "Zn %", location: "cells", array: "znarr" },
  znarr: { __class__: "ScalarArray", array: znArr },
};

const jsonBuf = Buffer.from(JSON.stringify(J), "utf8");
const header = Buffer.alloc(60);
header.set([0x84, 0x83, 0x82, 0x81], 0);
header.write("OMF-v0.9.0", 4, "ascii");
header.writeBigUInt64LE(BigInt(cursor), 52);
const omf = Buffer.concat([header, ...blobParts, jsonBuf]);

// The reader takes anything with .arrayBuffer() and .name — a File in the
// browser, this here.
const asFile = (buffer, name) => ({
  name, size: buffer.length,
  arrayBuffer: async () => buffer.buffer.slice(
    buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
});

console.log("— OMF v1, the layout Leapfrog writes");
const p = await readOMF(asFile(omf, "tom.omf"));
ok("reads the version out of the header", p.version === "OMF-v0.9.0", p.version);
ok("finds the project's own name", p.name === "Tom Deposit", p.name);
ok("finds both elements", p.elements.length === 2, String(p.elements.length));

const surf = p.elements.find((e) => e.kind === "Surface");
ok("the surface keeps the name the geologist gave it",
   surf && surf.name === "Vein 2400", surf && surf.name);
ok("the triangulation came through", surf.verts.length === 4 && surf.faces.length === 2,
   `${surf.verts.length} verts, ${surf.faces.length} faces`);
// The origin is the trap: OMF stores vertices RELATIVE to it, and ignoring it
// puts the vein at the map origin off West Africa rather than on the property.
ok("vertices are offset by the geometry origin",
   surf.verts[0][0] === 500000 && surf.verts[2][1] === 6000010,
   JSON.stringify(surf.verts[0]) + " " + JSON.stringify(surf.verts[2]));
ok("faces index the vertices", surf.faces[1][2] === 3, JSON.stringify(surf.faces[1]));
ok("the surface's attribute is NAMED, not positional",
   surf.data[0] && surf.data[0].name === "Au g/t", JSON.stringify(surf.data[0]?.name));
ok("its values survived the round trip",
   surf.data[0].values[3] === 7.8, String(surf.data[0].values[3]));
ok("and it says where the values live", surf.data[0].location === "vertices");

const vol = p.elements.find((e) => e.kind === "Volume");
ok("the block model is found and named", vol && vol.name === "Resource model", vol && vol.name);
ok("the block count is the product of the three tensors", vol.blocks === 4,
   String(vol.blocks));
// Per-block widths, not one block size — this is the sub-blocked model the CSV
// path has to detect and refuse, and OMF simply states it.
ok("an uneven lattice is carried as widths",
   JSON.stringify(vol.grid.tensor_u) === "[10,20]", JSON.stringify(vol.grid.tensor_u));
ok("the grid keeps its origin", vol.grid.origin[0] === 500000);
ok("the model's variable is named", vol.data[0].name === "Zn %", vol.data[0].name);
ok("its values are per cell", vol.data[0].values.length === 4 &&
   vol.data[0].location === "cells");

console.log("\n— it refuses what it cannot read, by name");
let msg = "";
try { await readOMF(asFile(Buffer.from("not an omf at all"), "x.omf")); }
catch (e) { msg = e.message; }
ok("a file that is not OMF is named as such", /magic number|ZIP/i.test(msg), msg);

msg = "";
const trunc = Buffer.from(omf.subarray(0, 60));
trunc.writeBigUInt64LE(BigInt(999999), 52);
try { await readOMF(asFile(trunc, "t.omf")); } catch (e) { msg = e.message; }
ok("a truncated file is refused rather than half-read",
   /truncated|outside/i.test(msg), msg);

// ---- the block model, converted into the rows the CSV pipeline eats --------
console.log("\n— OMF volume -> block-model rows");
const { omfVolumeToRows } = await import("../dashboard/lib/formats.js");
// The fixture's own tensor_u is [10,20] on purpose, to prove the reader carries
// a variable lattice. The conversion is tested on a REGULAR copy, and the
// original is used below for the sub-blocked refusal.
const vRaw = p.elements.find((e) => e.kind === "Volume");
const v2 = JSON.parse(JSON.stringify(vRaw));
v2.grid.tensor_u = [10, 10];
const conv = omfVolumeToRows(v2, { grade: "Zn %" });
const lines = [...conv.rows()];
ok("the block size is STATED, not inferred",
   conv.dx === 10 && conv.dy === 10 && conv.dz === 5,
   `${conv.dx} ${conv.dy} ${conv.dz}`);
ok("one header plus one row per block", lines.length === 1 + 4, String(lines.length));
ok("the header names the columns the pipeline looks for",
   lines[0] === "X,Y,Z,GRADE", lines[0]);
// Centres, not corners: a block at the origin sits half a block in from it.
ok("rows carry block CENTRES", lines[1].startsWith("500005,6000005,1002.5"), lines[1]);
// u fastest, then v, then w. Getting this wrong does not error — it transposes
// the deposit, and the totals still reconcile, which is why it is asserted on a
// known corner rather than on a sum.
ok("cell order is u fastest, then v, then w",
   lines[1].endsWith(",0.5") && lines[2].endsWith(",1.5") &&
   lines[3].endsWith(",2.5") && lines[4].endsWith(",3.5"),
   lines.slice(1).join(" | "));
ok("the second row steps east by one block width",
   lines[2].startsWith("500015,6000005,"), lines[2]);
ok("the third row steps north, not east",
   lines[3].startsWith("500005,6000015,"), lines[3]);
ok("it reports the variables it found", conv.variables.join() === "Zn %",
   conv.variables.join());

let m2 = "";
try { omfVolumeToRows(v2, { grade: "Cu %" }); } catch (e) { m2 = e.message; }
ok("a variable that is not there is named, with what is",
   /Cu %/.test(m2) && /Zn %/.test(m2), m2);

// A rotated model renders as a staircase, so it is refused rather than drawn.
const rot = JSON.parse(JSON.stringify(v2));
rot.grid.axis_u = [Math.cos(0.35), Math.sin(0.35), 0];
m2 = "";
try { omfVolumeToRows(rot, { grade: "Zn %" }); } catch (e) { m2 = e.message; }
ok("a rotated model is refused, with the angle", /rotated 20/.test(m2), m2);

// A variable lattice IS a sub-blocked model. The CSV path has to detect those
// from coordinates and cannot always; OMF states it, so this refusal is certain.
m2 = "";
try { omfVolumeToRows(vRaw, { grade: "Zn %" }); } catch (e) { m2 = e.message; }
ok("a sub-blocked model is refused by name, from the file rather than a guess",
   /sub-blocked/i.test(m2) && /easting/.test(m2) && /10, 20/.test(m2), m2);


// ---- and through the REAL pipeline, not just into rows ---------------------
// The point of converting rather than writing a second tonnage path is that
// extract.js does the arithmetic. This proves the rows it produces are rows
// that pipeline actually accepts, and that the tonnage comes out to the
// hand-computed answer.
console.log("\n— converted rows through extract.js");
const { probe, extract } = await import("../dashboard/lib/extract.js");
async function* iter(arr) { for (const l of arr) yield l; }

const pr = await probe(iter(lines));
ok("the pipeline detects the columns the conversion writes",
   pr.mapping.x === "X" && pr.mapping.y === "Y" && pr.mapping.z === "Z" &&
   pr.mapping.grade === "GRADE",
   JSON.stringify(pr.mapping));
// It infers a block size from spacing; the file STATED one. They should agree,
// and if they ever do not, the stated one is the truth.
ok("the size the pipeline infers matches the size the file states",
   pr.dx === conv.dx && pr.dy === conv.dy,
   `inferred ${pr.dx}x${pr.dy}, stated ${conv.dx}x${conv.dy}`);

const out = await extract(iter(lines), {
  mapping: pr.mapping, dx: conv.dx, dy: conv.dy, dz: conv.dz,
  density: 2.7, cutoff: 0,
});
ok("every block survived", out.stats.total.blocks === 4, String(out.stats.total.blocks));
// 4 blocks x 10 x 10 x 5 m x 2.7 t/m3 = 5,400 t.
ok("tonnage is the hand-computed answer",
   Math.round(out.stats.total.tonnes) === 5400, String(out.stats.total.tonnes));
// Grades 0.5,1.5,2.5,3.5 on equal blocks -> mean 2.0.
ok("grade is the tonnage-weighted mean of the four blocks",
   Math.abs(out.stats.total.grade_gt - 2) < 1e-6, String(out.stats.total.grade_gt));
ok("the rollups reconcile, which is the whole claim", out.reconciled !== false,
   JSON.stringify(out.reconciled));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
