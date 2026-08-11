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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
