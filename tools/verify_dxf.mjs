// Bedrock — the DXF reader, against the shapes CAD-lineage tools actually write.
//
//   node tools/verify_dxf.mjs
//
// DXF was read for 3DFACE only, on the reasoning that it is what every package
// emits for a triangulation. Half right: Deswik, and the CAD side of Micromine
// and Surpac, write solids and surfaces as POLYFACE MESHES, so a Deswik.CAD
// "File > Export > DXF" produced a file the reader refused — and told the user
// to re-export as something their software may not offer.
//
// The fixtures below are hand-written to the DXF group-code spec rather than
// dumped from the reader, so they test agreement with the format and not with
// itself.

import { readDXF } from "../dashboard/lib/formats.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") =>
  c ? (pass++, console.log("  ok   " + n))
    : (fail++, console.log("  FAIL " + n + (d ? " — " + d : "")));

const pairs = (...kv) => kv.join("\n");
const P = (code, val) => `${code}\n${val}`;

// ---- 3DFACE, the case that already worked ---------------------------------
const face = pairs(
  P(0, "SECTION"), P(2, "ENTITIES"),
  P(0, "3DFACE"),
  P(10, 0), P(20, 0), P(30, 0),
  P(11, 10), P(21, 0), P(31, 0),
  P(12, 10), P(22, 10), P(32, 0),
  P(13, 0), P(23, 10), P(33, 0),
  P(0, "ENDSEC"), P(0, "EOF"));
const a = readDXF(face, "faces.dxf");
ok("3DFACE still reads", a.faces.length === 2 && a.verts.length === 4,
   `${a.verts.length} verts, ${a.faces.length} faces`);

// ---- POLYFACE MESH — what Deswik writes -----------------------------------
// 70 bit 64 = polyface. Coordinate vertices carry 128|64 = 192; a FACE record
// carries 128 alone and puts 1-based vertex indices in 71..74.
const polyface = pairs(
  P(0, "SECTION"), P(2, "ENTITIES"),
  P(0, "POLYLINE"), P(8, "SOLIDS"), P(66, 1), P(70, 64), P(71, 4), P(72, 2),
  P(0, "VERTEX"), P(70, 192), P(10, 100), P(20, 200), P(30, 300),
  P(0, "VERTEX"), P(70, 192), P(10, 110), P(20, 200), P(30, 300),
  P(0, "VERTEX"), P(70, 192), P(10, 110), P(20, 210), P(30, 300),
  P(0, "VERTEX"), P(70, 192), P(10, 100), P(20, 210), P(30, 310),
  // triangle 1-2-3, then a quad 1-2-3-4 with one edge marked invisible (-3)
  P(0, "VERTEX"), P(70, 128), P(71, 1), P(72, 2), P(73, 3),
  P(0, "VERTEX"), P(70, 128), P(71, 1), P(72, 2), P(73, -3), P(74, 4),
  P(0, "SEQEND"),
  P(0, "ENDSEC"), P(0, "EOF"));
const b = readDXF(polyface, "deswik.dxf");
ok("a polyface mesh is read at all", b.faces.length > 0, JSON.stringify(b.faces));
ok("its coordinate vertices come through, and only those",
   b.verts.length === 4, `${b.verts.length} verts`);
// The trap: a FACE record read as a point adds a vertex at (0,0,0), which drags
// a surface down to the origin and looks like a modelling error.
ok("no face record was mistaken for a point",
   b.verts.every((v) => v.every(Number.isFinite) && v[2] >= 300),
   JSON.stringify(b.verts));
ok("the triangle and the quad both became triangles",
   b.faces.length === 3, `${b.faces.length}`);
ok("indices are 0-based after conversion from DXF's 1-based",
   b.faces[0].join(",") === "0,1,2", b.faces[0].join(","));
// Negative index = invisible EDGE, not a missing vertex. Dropping it would
// silently delete a corner.
ok("a negative index is an invisible edge, not a dropped corner",
   b.faces.slice(1).flat().includes(2), JSON.stringify(b.faces));
ok("vertex positions survive", b.verts[0].join(",") === "100,200,300", b.verts[0].join(","));

// ---- 3D POLYGON MESH — an M x N gridded surface ---------------------------
// 70 bit 16 = polygon mesh; 71/72 are M and N; faces are implied by the grid.
const grid = [];
for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 2; c++) {
    grid.push(P(0, "VERTEX"), P(70, 64), P(10, c * 10), P(20, r * 10), P(30, r + c));
  }
}
const mesh = pairs(
  P(0, "SECTION"), P(2, "ENTITIES"),
  P(0, "POLYLINE"), P(66, 1), P(70, 16), P(71, 3), P(72, 2),
  ...grid, P(0, "SEQEND"), P(0, "ENDSEC"), P(0, "EOF"));
const c2 = readDXF(mesh, "dtm.dxf");
ok("a 3x2 polygon mesh becomes 4 triangles",
   c2.verts.length === 6 && c2.faces.length === 4,
   `${c2.verts.length} verts, ${c2.faces.length} faces`);

// ---- mixed file: both kinds in one export ---------------------------------
const mixed = face.replace(P(0, "ENDSEC") + "\n" + P(0, "EOF"), "") + "\n" +
  polyface.split(pairs(P(0, "SECTION"), P(2, "ENTITIES")))[1];
const d = readDXF(mixed, "mixed.dxf");
ok("3DFACE and polyface in one file both load",
   d.verts.length === 8 && d.faces.length === 5,
   `${d.verts.length} verts, ${d.faces.length} faces`);
// Two entity blocks, two index bases — if the polyface indices were not
// rebased, its triangles would point at the 3DFACE's vertices instead.
ok("the second entity's indices are rebased, not overlaid",
   d.faces.slice(2).flat().every((i) => i >= 4),
   JSON.stringify(d.faces.slice(2)));

// ---- what it still cannot read, said plainly ------------------------------
const solid = pairs(P(0, "SECTION"), P(2, "ENTITIES"),
  P(0, "3DSOLID"), P(1, "ACIS-ish"), P(0, "ENDSEC"), P(0, "EOF"));
let msg = "";
try { readDXF(solid, "solid.dxf"); } catch (e) { msg = e.message; }
ok("an ACIS solid is refused by name, with what to do",
   /3DSOLID/.test(msg) && /re-export/i.test(msg), msg);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
