// Bedrock — what happens when a geologist drags their export folder onto a zone.
//
//   node tools/verify_dragdrop.mjs
//
// The console has a routing table (classify) and a format table (sniff), and
// between them they decide whether a dropped file lands in the right slot, is
// refused with advice, or vanishes into "could not tell what that file is".
// Nothing tested the first of those, and it was wrong in a way no unit test of
// the parsers could have caught: `classify` never returned "topography" at all,
// so the one dataset the geologists asked for by name — a DEM or a LiDAR
// surface — could not be dropped. A DEM called dem.tif went to geophysics and
// would have been drawn as a magnetics image.
//
// The filenames below are what Leapfrog, Micromine, Deswik and MinePlan
// actually write, or what a geologist actually types.

// ingest.js reaches ui.js reaches config.js, which touches window/localStorage
// at module scope. Shimmed rather than refactored: the point of this suite is
// to exercise the SHIPPED routing table, and a version of it rearranged to be
// testable would no longer be the thing that runs in the console.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = {
  getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
  addEventListener() {}, body: { classList: { add() {}, remove() {} } },
};
globalThis.location = { origin: "", pathname: "", hash: "" };
globalThis.addEventListener = () => {};

const { classify, routeFiles } = await import("../dashboard/ingest.js");
const { sniff } = await import("../dashboard/lib/formats.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") =>
  c ? (pass++, console.log("  ok   " + n))
    : (fail++, console.log("  FAIL " + n + (d ? " — " + d : "")));

const F = (name, size = 1000) => ({ name, size });
const to = (name, size) => { const c = classify(F(name, size)); return c ? c.kind : null; };

console.log("— routing: where a dropped file lands");
const cases = [
  // topography / LiDAR — the whole point of this suite
  ["dem.tif", "topography"], ["DTM_2m.tif", "topography"],
  ["macpass_topography.tif", "topography"], ["site_terrain.obj", "topography"],
  ["ground_surface.dxf", "topography"], ["lidar_dtm.asc", "topography"],
  ["elevation.asc", "topography"], ["contours.dxf", "topography"],
  ["survey.las", "topography"], ["cloud.laz", "topography"], ["scan.e57", "topography"],
  // geophysics keeps the bare and the magnetic grids
  ["grid.tif", "geophysics"], ["TMI_RTP.tif", "geophysics"],
  ["mag_1vd.png", "geophysics"], ["survey.tfw", "geophysics"],
  // vein/ore wireframes still go to surfaces
  ["vein_2400.obj", "surfaces"], ["orebody.ts", "surfaces"], ["shells.dxf", "surfaces"],
  // drilling, three parts
  ["collars.csv", "drills"], ["dh_survey.csv", "drills"], ["assays.csv", "drills"],
  // geochem beats drilling on the shared word "sample"
  ["soil_samples.csv", "geochem"], ["stream_sediment.csv", "geochem"],
  // boundaries
  ["claims.geojson", "site"], ["tenure.kml", "site"], ["property.zip", "site"],
  // OMF is a whole project; it lands in surfaces and reports the rest by name
  ["tom_deposit.omf", "surfaces"],
];
for (const [name, want] of cases) {
  const got = to(name);
  ok(`${name.padEnd(26)} -> ${want}`, got === want, `got ${got}`);
}
// A big CSV is a block model; a small nameless one is not guessed at.
ok("a large unnamed .csv is treated as a block model", to("export.csv", 9e6) === "blocks");
ok("a small unnamed .csv is not guessed at", to("export.csv", 1e3) === null);

console.log("\n— a whole export folder, dropped at once");
const drop = [F("collars.csv"), F("surveys.csv"), F("assays.csv"),
              F("dem.tif"), F("vein_solid.obj"), F("claims.geojson"),
              F("model.bmf"), F("notes.docx")];
const { byKind, unknown } = routeFiles(drop);
ok("drilling collected all three parts",
   (byKind.drills || []).length === 3,
   `${(byKind.drills || []).length}`);
ok("the DEM went to topography, not geophysics", !!byKind.topography && !byKind.geophysics);
ok("the wireframe went to surfaces", !!byKind.surfaces);
ok("the boundary went to site", !!byKind.site);
ok("the unreadable ones were not silently filed", unknown.length === 2,
   unknown.map((f) => f.name).join(","));

console.log("\n— the vendors: refused, but by name and with the export to use");
const vendors = [
  ["model.bmf", /vulcan/i, /csv/i],
  ["pit.dwsolids", /deswik/i, /dxf|csv/i],
  ["model.msr", /mineplan|minesight/i, /csv/i],
  ["surfaces.tridb", /micromine/i, /dxf|obj|csv/i],
  ["geology.msh", /leapfrog/i, /obj|dxf|csv/i],
  ["block.dm", /datamine/i, /csv/i],
  ["model.mdl", /surpac/i, /csv|dxf/i],
  ["mag.grd", /geosoft/i, /geotiff|tif/i],
  ["claims.shp", /shapefile/i, /geojson|kml/i],
  ["cloud.las", /point cloud|lidar/i, /geotiff|obj|dxf|dem/i],
];
for (const [name, labelRe, adviceRe] of vendors) {
  const s = sniff(F(name));
  const named = !s.readable && labelRe.test(s.label || "");
  const useful = adviceRe.test(s.advice || "");
  ok(`${name.padEnd(16)} refused, named, and told what to export`,
     named && useful, `label=${s.label} advice=${(s.advice || "").slice(0, 60)}`);
}

console.log("\n— the formats a real export actually produces are readable");
for (const name of ["blocks.csv", "vein.obj", "vein.ts", "pit.dxf",
                    "claims.geojson", "claims.kml", "dem.tif", "dem.asc",
                    "project.omf"]) {
  const s = sniff(F(name));
  ok(`${name.padEnd(16)} is accepted`, s.readable !== false, JSON.stringify(s));
}

console.log("\n— the ESRI ASCII grid reader, on a grid with known geometry");
const { readAsciiGrid, demToMesh } = await import("../dashboard/lib/formats.js");
// 4 x 3 cells, 10 m, lower-left corner at 500000/6000000. Row 0 is the NORTH
// edge, so the first row is the highest ground.
const asc = [
  "ncols 4", "nrows 3", "xllcorner 500000", "yllcorner 6000000",
  "cellsize 10", "NODATA_value -9999",
  "300 301 302 303",
  "200 201 -9999 203",
  "100 101 102 103",
].join("\n");
const g = readAsciiGrid(asc, "dem.asc");
ok("reads the grid dimensions", g.width === 4 && g.height === 3, `${g.width}x${g.height}`);
ok("no projection is claimed, because the format carries none", g.epsg === null);
// Corner -> centre is half a cell. Getting this wrong shifts the whole terrain
// 5 m, which nothing downstream would notice.
ok("the west edge is the first cell CENTRE", g.extent.west === 500005, String(g.extent.west));
ok("the south edge is the first cell CENTRE", g.extent.south === 6000005, String(g.extent.south));
ok("the extent spans (n-1) cells", g.extent.east === 500035 && g.extent.north === 6000025,
   `${g.extent.east} ${g.extent.north}`);
ok("row 0 is the NORTH edge", g.band[0] === 300 && g.band[8] === 100,
   `${g.band[0]} ${g.band[8]}`);
ok("NODATA became NaN, not -9999", Number.isNaN(g.band[6]), String(g.band[6]));
const mesh = demToMesh(g);
ok("it turns into a mesh", mesh.verts.length === 12 && mesh.faces.length > 0,
   `${mesh.verts.length} verts, ${mesh.faces.length} faces`);
ok("the NODATA cell is not given a fake elevation",
   mesh.zMin === 100 && mesh.zMax === 303, `${mesh.zMin}..${mesh.zMax}`);
// A short file is a truncated download, and half a terrain drawn as whole is
// worse than a refusal.
let threw = false;
try { readAsciiGrid("ncols 4\nnrows 3\ncellsize 10\nxllcorner 0\nyllcorner 0\n1 2 3", "s.asc"); }
catch { threw = true; }
ok("a truncated grid is refused, not padded", threw);
// Cell-centre headers are as legal as corner ones.
const gc = readAsciiGrid(
  "ncols 2\nnrows 1\nxllcenter 1000\nyllcenter 2000\ncellsize 5\n7 8", "c.asc");
ok("xllcenter is honoured without the half-cell shift", gc.extent.west === 1000,
   String(gc.extent.west));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
