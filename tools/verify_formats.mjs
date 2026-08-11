// Orebody — exercise every format reader against a fixture written to spec.
//
//   node tools/verify_formats.mjs
//
// These readers exist so a customer's own export renders. The risk they carry
// is not crashing — it is returning something plausible from a file they have
// misread, because that surfaces as a wrong picture rather than an error. So
// each check asserts the NUMBERS that came back, not merely that a call
// returned, and the desurvey check verifies against geometry computed
// independently rather than against itself.

import * as F from "../dashboard/lib/formats.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? (pass++, console.log(`  ok   ${name}`))
       : (fail++, console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`));
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const threw = (fn, re) => {
  try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
};

console.log("== sniff: what we can and cannot read");
// OMF used to be in the refused list, told to export CSV instead. It is read
// now — it is an open, self-describing spec, which is the line: see readOMF and
// tools/verify_omf.mjs. The rest of the binaries below stay refused.
ok("OMF is read, not refused", F.sniff({ name: "project.omf" }).format === "omf");
ok("Datamine .dm is named", !F.sniff({ name: "model.dm" }).readable);
ok("Vulcan .bmf is named", /Vulcan/.test(F.sniff({ name: "bm.bmf" }).label));
ok("a lone .shp explains the missing siblings",
   /dbf/.test(F.sniff({ name: "claims.shp" }).advice));
ok("csv is readable", F.sniff({ name: "collars.csv" }).readable);
ok("obj is readable", F.sniff({ name: "veins.obj" }).readable);
ok("an unknown extension still advises", /Supported/.test(F.sniff({ name: "x.zzz" }).advice));

console.log("\n== claims");
const gj = JSON.stringify({
  type: "FeatureCollection",
  features: [{ type: "Feature", properties: { CLAIM_NAME: "ELK06F", OWNER_NAME: "Elk Gold" },
    geometry: { type: "Polygon", coordinates: [[[-120.31, 49.85], [-120.30, 49.85], [-120.30, 49.86], [-120.31, 49.85]]] } }],
});
const g1 = F.readGeoJSON(gj);
ok("GeoJSON: one ring", g1.length === 1, `got ${g1.length}`);
ok("GeoJSON: coordinates survive", near(g1[0].ring[0][0], -120.31, 1e-9));
ok("GeoJSON: properties survive", g1[0].props.OWNER_NAME === "Elk Gold");
ok("GeoJSON: MultiPolygon splits into rings",
   F.readGeoJSON(JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon",
     coordinates: [[[[0,0],[1,0],[1,1],[0,0]]], [[[5,5],[6,5],[6,6],[5,5]]]] } })).length === 2);
ok("GeoJSON: garbage throws", threw(() => F.readGeoJSON("{nope"), /not valid JSON/));
ok("GeoJSON: empty collection throws", threw(() => F.readGeoJSON('{"type":"FeatureCollection","features":[]}'), /no polygon/));

const kml = `<?xml version="1.0"?><kml><Document>
<Placemark><name>Home Brew</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
-120.31,49.85,0 -120.30,49.85,0 -120.30,49.86,0 -120.31,49.85,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
const k1 = F.readKML(kml);
ok("KML: one ring", k1.length === 1);
ok("KML: name survives", k1[0].props.name === "Home Brew");
ok("KML: altitude is dropped, lon/lat kept", near(k1[0].ring[1][0], -120.30, 1e-9));
ok("KML: no coordinates throws", threw(() => F.readKML("<kml></kml>"), /coordinates/));

console.log("\n== surfaces");
const obj = `# a quad and a tri
v 0 0 0
v 10 0 0
v 10 10 0
v 0 10 0
f 1 2 3 4
f 1//1 3//1 4//1
`;
const o1 = F.readOBJ(obj);
ok("OBJ: four vertices", o1.verts.length === 4);
ok("OBJ: quad fan-triangulates to 2, plus the tri = 3", o1.faces.length === 3, `got ${o1.faces.length}`);
ok("OBJ: v/vn indices are handled", o1.faces[2].join(",") === "0,2,3", o1.faces[2].join(","));
ok("OBJ: negative indices resolve", F.readOBJ("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n").faces[0].join(",") === "0,1,2");
ok("OBJ: no faces throws", threw(() => F.readOBJ("v 0 0 0\n"), /no faces/));

const ts = `GOCAD TSurf 1
VRTX 1 100 200 300
VRTX 2 110 200 300
VRTX 5 110 210 300
TRGL 1 2 5
END`;
const t1 = F.readGOCAD(ts);
ok("GOCAD: three vertices", t1.verts.length === 3);
ok("GOCAD: non-contiguous ids remap", t1.faces[0].join(",") === "0,1,2", t1.faces[0].join(","));
ok("GOCAD: coordinates survive", t1.verts[2][1] === 210);
ok("GOCAD: dangling TRGL throws", threw(() => F.readGOCAD("VRTX 1 0 0 0\nTRGL 1 9 9\n"), /not in the file/));

const dxf = ["0","SECTION","2","ENTITIES",
  "0","3DFACE","10","0","20","0","30","0","11","10","21","0","31","0","12","10","22","10","32","0","13","0","23","10","33","0",
  "0","3DFACE","10","0","20","0","30","5","11","10","21","0","31","5","12","10","22","10","32","5",
  "0","ENDSEC","0","EOF"].join("\n");
const d1 = F.readDXF(dxf);
ok("DXF: quad -> 2 triangles, tri -> 1", d1.faces.length === 3, `got ${d1.faces.length}`);
ok("DXF: z survives", d1.verts.some((v) => v[2] === 5));
// Polyface and polygon meshes ARE read now (see tools/verify_dxf.mjs) — Deswik
// writes them and this used to refuse them. A POLYLINE that is neither still
// throws, and still names what it found.
ok("DXF: a POLYLINE that is not a mesh throws and says so",
   threw(() => F.readDXF(["0","SECTION","0","POLYLINE","0","ENDSEC"].join("\n")), /POLYLINE/));

console.log("\n== drilling");
const collars = `HOLE_ID,EAST,NORTH,RL,TD
DDH-001,692500,5525500,1400,100
DDH-002,692600,5525600,1395,60`;
const surveys = `HOLEID,DEPTH,AZIMUTH,DIP
DDH-001,0,90,-60
DDH-001,100,90,-60
DDH-002,0,350,-90
DDH-002,60,10,-90`;
const assays = `Hole,From,To,Au_gt
DDH-001,20,23,5.4
DDH-001,40,44,12.1`;
const C = F.readCollars(collars), S = F.readSurveys(surveys), A = F.readAssays(assays);
ok("collars: two holes", C.length === 2);
ok("collars: alias RL -> elevation", C[0].z === 1400);
ok("surveys: grouped by hole", S.size === 2);
ok("assays: intervals grouped", A.byHole.get("DDH-001").length === 2);
ok("assays: grade column reported", A.gradeColumn === "Au_gt", A.gradeColumn);
ok("collars: missing easting throws with the header listed",
   threw(() => F.readCollars("HOLE,Y,Z\nA,1,2"), /easting.*Columns present/s));

const { traces, assumedVertical } = F.desurvey(C, S, 5);
const t = traces.find((x) => x.id === "DDH-001");
// 100 m at -60 dip on azimuth 090: horizontal run 100*cos60 = 50 due east,
// vertical drop 100*sin60 = 86.60. Computed here from trigonometry, not from
// the desurvey, so agreement means something.
const end = t.pts[t.pts.length - 1];
ok("desurvey: reaches total depth", near(end[0] - 692500, 50, 0.5), `east ${(end[0]-692500).toFixed(2)}`);
ok("desurvey: northing unchanged on an east-bearing hole", near(end[1] - 5525500, 0, 0.01));
ok("desurvey: drops by 100·sin60", near(1400 - end[2], 86.60, 0.5), `drop ${(1400-end[2]).toFixed(2)}`);
ok("desurvey: vertical hole stays under its collar", (() => {
  const v = traces.find((x) => x.id === "DDH-002");
  const e = v.pts[v.pts.length - 1];
  return near(e[0], 692600, 0.01) && near(e[1], 5525600, 0.01) && near(1395 - e[2], 60, 0.01);
})());
ok("desurvey: azimuth wrap 350->10 does not swing the long way", (() => {
  const v = traces.find((x) => x.id === "DDH-002");
  return v.pts.every((p) => near(p[0], 692600, 0.01));
})());
ok("desurvey: a hole with no survey is reported, not silently assumed vertical", (() => {
  const r = F.desurvey([{ id: "X", x: 0, y: 0, z: 0, td: 10 }], new Map(), 5);
  return r.assumedVertical.length === 1 && r.assumedVertical[0] === "X";
})());
ok("no holes were silently assumed vertical in this fixture", assumedVertical.length === 0);

const p50 = F.pointAt(t, 50);
ok("pointAt: halfway is halfway", near(p50[0] - 692500, 25, 0.5), `east ${(p50[0]-692500).toFixed(2)}`);

console.log("\n== geochemistry");
const soil = `SampleID,East,North,Au_ppb,Cu_ppm
S-001,692500,5525500,12,45
S-002,692520,5525510,<5,60
S-003,692540,5525520,-5,55
S-004,692560,5525530,340,120
S-005,,,99,10`;
const gc = F.readGeochem(soil, "soil");
ok("picks the first recognised element", gc.element === "Au_ppb", gc.element);
ok("unit read from the header", gc.unit === "ppb");
ok("a row with no coordinates is skipped, not placed at the origin",
   gc.stats.samples === 4 && gc.stats.skipped === 1, JSON.stringify(gc.stats));
ok("'<5' becomes half the detection limit", gc.points[1].v === 2.5);
ok("'-5' means the same thing and is treated the same", gc.points[2].v === 2.5);
ok("below-detection substitutions are counted", gc.stats.below_detection === 2);
ok("a named element wins", F.readGeochem(soil, "soil", "Cu_ppm").element === "Cu_ppm");
ok("lat/lon files are accepted", F.readGeochem("id,lon,lat,au_ppm\nA,-120.3,49.85,1.2").projected === false);
ok("no element column throws",
   threw(() => F.readGeochem("id,east,north\nA,1,2"), /element column/));
// The bug this file exists to prevent: "as" is a substring of "east".
ok("an element symbol never matches a coordinate column",
   F.colExact(["East", "North"], "as") === -1 && F.col(["East", "North"], "as") === -1);
ok("blank numeric fields are missing, not zero",
   F.readCollars("HOLE,EAST,NORTH,RL\nA,,5525500,1400\nB,692500,5525500,1400").length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
