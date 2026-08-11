// Bedrock — readers for the file formats mining software actually exports.
//
// TRACKING.md #13. Until now the only parsed input was a block-model CSV;
// everything else was stored as an opaque blob, so a customer could upload
// drilling and claims and see neither. These readers turn the common text
// formats into the shapes the viewer already draws.
//
// TWO PRINCIPLES, both learned the hard way in this codebase:
//
//   Fail loudly on what we cannot read. A reader that returns something
//   plausible from a format it does not understand is worse than no reader,
//   because the failure surfaces as a wrong picture rather than an error. Every
//   function here throws with a sentence naming the file and the problem.
//
//   Never infer provenance. Nothing here decides whether data is real or
//   fabricated. That is a claim about where the numbers came from, and no
//   parser can see it.
//
// Deliberately NOT attempted: Datamine .dm, Vulcan .bmf, Surpac .mdl, Micromine
// .dat, Deswik .dwbm. Those are binary, several are undocumented, and a parser
// written against a guess would mis-read silently. They are detected and named
// so the user is told what to export instead — see sniff().
//
// OMF is the exception, and it is read: see readOMF. The line is not "binary
// versus text", it is whether the file says what its own numbers mean. A Vulcan
// .bmf was taken apart to check — 576 MB of it, not one variable name — so any
// reader would have had to guess which column was zinc. OMF names every element
// and every attribute, is an open GMG-governed spec, and is what Leapfrog and
// Micromine already export.

// ------------------------------------------------------------- sniffing ----
const BINARY_FORMATS = [
  // Geosoft's binary grid. No viable open decoder exists, and reverse
  // engineering a proprietary geophysics format to save one export step is not
  // a good trade. Named, with the two things Oasis montaj exports in one click.
  { id: "geosoft-grd", ext: [".grd", ".gxf"], label: "Geosoft grid",
    advice: "Export the grid from Oasis montaj as GeoTIFF (which carries its " +
            "own georeferencing and is read directly), or as an ASCII grid " +
            "with a world file." },
  { id: "datamine", ext: [".dm"], label: "Datamine",
    advice: "Export the model to CSV (File > Export > CSV) and wireframes to DXF." },
  { id: "vulcan", ext: [".bmf", ".bdf"], label: "Maptek Vulcan block model",
    advice: "Export the block model to CSV, and triangulations (.00t) to OBJ or DXF." },
  { id: "surpac", ext: [".mdl"], label: "Surpac model",
    advice: "Export the model to CSV and DTMs to DXF." },
  { id: "deswik", ext: [".dwbm", ".dwcad", ".dwsolids", ".dwstrings"],
    label: "Deswik",
    advice: "In Deswik.CAD: File > Export > DXF for solids and strings. Block " +
            "models export to CSV from Deswik.BM." },
  // Micromine's own wireframe database and string files. `.dat` is NOT in this
  // list on purpose — see the note on ambiguity below.
  { id: "micromine", ext: [".tridb", ".mmpro", ".micromine"], label: "Micromine",
    advice: "Wireframes: Wireframe > Export > DXF or OBJ. Drilling and block " +
            "models: File > Export > CSV." },
  // `.msr` is MinePlan's, not Leapfrog's — it was listed under Leapfrog here
  // and would have told a MinePlan user to look for menus their software does
  // not have.
  { id: "leapfrog", ext: [".msh", ".lfm", ".lfr", ".aproj", ".lfview"],
    label: "Seequent Leapfrog",
    advice: "Meshes: right-click the mesh > Export > OBJ or DXF. Drilling and " +
            "block models: Export > CSV. Both load here directly." },
  { id: "mineplan", ext: [".msr", ".srg", ".msv", ".pcf"],
    label: "Hexagon MinePlan (formerly MineSight)",
    advice: "Export the block model to CSV, and surfaces or pit designs to DXF." },
  // A LiDAR point cloud is tens of millions of returns. Nothing useful here
  // consumes raw returns — what a deck wants is the surface derived from them,
  // which is the thing every LiDAR pipeline already produces on the way to
  // delivering the cloud.
  { id: "lidar", ext: [".las", ".laz", ".e57", ".ply"], label: "LiDAR point cloud",
    advice: "Point clouds are not read directly. Export the derived surface " +
            "instead — a DEM as GeoTIFF, or the triangulated surface as OBJ or " +
            "DXF — which is what a deck actually draws." },
  { id: "shapefile", ext: [".shp"], label: "Esri shapefile",
    advice: "A .shp needs its .dbf and .shx siblings to mean anything. Export " +
            "to GeoJSON or KML instead — both are single files and both load here." },
];

/**
 * What is this file, and can we read it?
 *
 * @returns {{readable:boolean, format:string, label?:string, advice?:string}}
 */
// Extensions several vendors use for entirely different things. Naming one
// vendor confidently is worse than naming none: a Datamine user told to look
// for Micromine's menus concludes the tool does not know what it is talking
// about, and they are right. These say what the file might be and give the
// export that is the same answer whichever it is.
const AMBIGUOUS = {
  ".dat": {
    label: "a binary model file — Micromine, Datamine and MinePlan all use .dat",
    advice: "Whichever it is, the export is the same: block models to CSV, " +
            "wireframes and surfaces to DXF or OBJ.",
  },
  ".str": {
    label: "a string file — Surpac and Micromine both use .str",
    advice: "Export the strings to DXF, which both write and this reads.",
  },
  ".00t": {
    label: "a Maptek Vulcan triangulation",
    advice: "Export the triangulation to OBJ or DXF.",
  },
};

export function sniff(file) {
  const n = (file.name || "").toLowerCase();
  const ext = n.slice(n.lastIndexOf("."));
  const amb = AMBIGUOUS[ext];
  if (amb) {
    return { readable: false, format: "ambiguous", label: amb.label, advice: amb.advice };
  }
  const hit = BINARY_FORMATS.find((f) => f.ext.includes(ext));
  if (hit) {
    return { readable: false, format: hit.id, label: hit.label, advice: hit.advice };
  }
  if (/\.(geojson|json)$/.test(n)) return { readable: true, format: "geojson" };
  if (/\.(kml)$/.test(n)) return { readable: true, format: "kml" };
  if (/\.(obj)$/.test(n)) return { readable: true, format: "obj" };
  if (/\.(ts|gocad)$/.test(n)) return { readable: true, format: "gocad" };
  if (/\.(dxf)$/.test(n)) return { readable: true, format: "dxf" };
  // Grids. A GeoTIFF carries its own georeferencing and needs nothing beside
  // it; a PNG or JPEG needs its world file, which the geophysics step checks
  // for by name rather than here.
  if (/\.(tiff?)$/.test(n)) return { readable: true, format: "geotiff" };
  if (/\.(png|jpe?g)$/.test(n)) return { readable: true, format: "image" };
  if (/\.(csv|txt|tsv)$/.test(n)) return { readable: true, format: "csv" };
  // ESRI ASCII grid — the DEM every one of these packages exports without
  // argument, and the only raster here that needs no library to read.
  if (/\.asc$/.test(n)) return { readable: true, format: "ascgrid" };
  // Open Mining Format. The one binary here that is read rather than refused,
  // because it is an open spec and it is self-describing — see readOMF.
  if (/\.omf$/.test(n)) return { readable: true, format: "omf" };
  return { readable: false, format: "unknown", label: ext || "no extension",
           advice: "Supported: CSV for models, drilling and geochemistry; " +
                   "GeoJSON or KML for claims; OBJ, GOCAD .ts or DXF for " +
                   "surfaces; GeoTIFF or ESRI ASCII grid (.asc) for terrain " +
                   "and geophysics." };
}

// -------------------------------------------------------------- helpers ----
// Number("") is 0, which is how an empty easting becomes a sample at the
// origin and an empty grade becomes a barren interval. Blank is missing.
const num = (v) => {
  const t = String(v ?? "").trim();
  if (t === "") return NaN;
  const x = Number(t);
  return Number.isFinite(x) ? x : NaN;
};

/** Split a delimited line, honouring quotes. Comma or tab, sniffed per file. */
function splitRow(line, sep) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Header + rows from delimited text. Tab-separated exports are common enough
 *  (Micromine, some Surpac reports) that guessing the delimiter is worth it. */
export function parseTable(text, what = "file") {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error(`${what}: needs a header row and at least one row of data.`);
  const sep = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? "\t" : ",";
  const header = splitRow(lines[0], sep).map((h) => h.trim());
  const rows = lines.slice(1).map((l) => splitRow(l, sep));
  return { header, rows, sep };
}

/** Exact column match, punctuation and case ignored. */
export function colExact(header, ...names) {
  const low = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const want of names) {
    const i = low.indexOf(want.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Find a column by any of several candidate names.
 *
 * Exact first, then substring — but substring only for names of four
 * characters or more. Short names are catastrophic as substrings: "as" is
 * inside "east", so an arsenic lookup returned the EASTING column and would
 * have mapped a soil survey's coordinates as an assay. "x" is inside
 * "max_depth" for the same reason. Four is the shortest length at which the
 * mining vocabulary stops colliding with itself.
 */
export function col(header, ...names) {
  const exact = colExact(header, ...names);
  if (exact >= 0) return exact;
  const low = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const want of names) {
    const w = want.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (w.length < 4) continue;
    const i = low.findIndex((h) => h.includes(w));
    if (i >= 0) return i;
  }
  return -1;
}

// ----------------------------------------------------------- claims: geo ----
/** Rings (arrays of [lon,lat]) plus whatever properties came with them. */
export function readGeoJSON(text, what = "GeoJSON") {
  let g;
  try { g = JSON.parse(text); } catch (e) { throw new Error(`${what}: not valid JSON.`); }
  const feats = g.type === "FeatureCollection" ? (g.features || [])
              : g.type === "Feature" ? [g]
              : g.type ? [{ type: "Feature", geometry: g, properties: {} }]
              : null;
  if (!feats) throw new Error(`${what}: no FeatureCollection, Feature or geometry found.`);
  const out = [];
  for (const f of feats) {
    const geom = f.geometry; if (!geom) continue;
    const polys = geom.type === "Polygon" ? [geom.coordinates]
                : geom.type === "MultiPolygon" ? geom.coordinates
                : geom.type === "LineString" ? [[geom.coordinates]]
                : geom.type === "MultiLineString" ? [geom.coordinates]
                : [];
    for (const poly of polys) {
      for (const ring of poly) {
        if (!Array.isArray(ring) || ring.length < 3) continue;
        out.push({ ring: ring.map((c) => [Number(c[0]), Number(c[1])]),
                   props: f.properties || {} });
      }
    }
  }
  if (!out.length) throw new Error(`${what}: no polygon or line geometry in the file.`);
  return out;
}

/** KML polygons. Namespaces vary between exporters, so tags are matched
 *  loosely rather than through a namespace-aware parser. */
export function readKML(text, what = "KML") {
  const out = [];
  const placemarks = text.split(/<Placemark[\s>]/i).slice(1);
  const src = placemarks.length ? placemarks : [text];
  for (const pm of src) {
    const name = (pm.match(/<name>([\s\S]*?)<\/name>/i) || [])[1];
    const coordBlocks = [...pm.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/gi)];
    for (const cb of coordBlocks) {
      const ring = cb[1].trim().split(/\s+/).map((t) => {
        const [lon, lat] = t.split(",").map(Number);
        return [lon, lat];
      }).filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (ring.length >= 3) out.push({ ring, props: name ? { name: name.trim() } : {} });
    }
  }
  if (!out.length) throw new Error(`${what}: no <coordinates> with three or more points.`);
  return out;
}

// -------------------------------------------------------- surfaces: mesh ----
/** Wavefront OBJ. Only v and f are read — normals, materials and texture
 *  coordinates are irrelevant to a grade shell. */
export function readOBJ(text, what = "OBJ") {
  const verts = [], faces = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("v ")) {
      const p = t.split(/\s+/);
      verts.push([num(p[1]), num(p[2]), num(p[3])]);
    } else if (t.startsWith("f ")) {
      // "f a/b/c" and negative (relative) indices both occur in the wild.
      const idx = t.split(/\s+/).slice(1).map((tok) => {
        const i = parseInt(tok.split("/")[0], 10);
        return i < 0 ? verts.length + i : i - 1;
      });
      // Fan-triangulate anything with more than three corners.
      for (let k = 1; k + 1 < idx.length; k++) faces.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  if (!verts.length) throw new Error(`${what}: no vertices (no "v" lines).`);
  if (!faces.length) throw new Error(`${what}: vertices but no faces (no "f" lines).`);
  return { verts, faces };
}

/** GOCAD TSurf — Leapfrog, Gocad and Paradigm all write it. VRTX/PVRTX give
 *  vertices with 1-based ids; TRGL references them. */
export function readGOCAD(text, what = "GOCAD") {
  const byId = new Map(); const tris = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (/^P?VRTX\s/i.test(t)) {
      const p = t.split(/\s+/);
      byId.set(parseInt(p[1], 10), [num(p[2]), num(p[3]), num(p[4])]);
    } else if (/^TRGL\s/i.test(t)) {
      const p = t.split(/\s+/);
      tris.push([parseInt(p[1], 10), parseInt(p[2], 10), parseInt(p[3], 10)]);
    }
  }
  if (!byId.size) throw new Error(`${what}: no VRTX lines.`);
  if (!tris.length) throw new Error(`${what}: vertices but no TRGL triangles.`);
  // Ids are not guaranteed contiguous, so remap rather than assume.
  const order = [...byId.keys()].sort((a, b) => a - b);
  const pos = new Map(order.map((id, i) => [id, i]));
  const verts = order.map((id) => byId.get(id));
  const faces = [];
  for (const t of tris) {
    const f = t.map((id) => pos.get(id));
    if (f.every((i) => i !== undefined)) faces.push(f);
  }
  if (!faces.length) throw new Error(`${what}: TRGL lines reference vertices that are not in the file.`);
  return { verts, faces };
}

/** DXF, ASCII, 3DFACE entities only.
 *
 *  DXF is a large format and this reads one corner of it deliberately: 3DFACE
 *  is what every package emits when asked for a triangulated surface, and
 *  attempting POLYLINE meshes and blocks as well would be a lot of code that
 *  is wrong in ways nobody notices. Anything else in the file is skipped, and
 *  the count of what was read is reported so a silent partial parse is visible. */
export function readDXF(text, what = "DXF") {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const verts = [], faces = [];
  let skipped = 0;
  for (let i = 0; i < lines.length - 1; i += 2) {
    if (lines[i] !== "0") continue;
    const entity = lines[i + 1];
    if (entity !== "3DFACE") { if (entity === "POLYLINE" || entity === "MESH") skipped++; continue; }
    // Group codes 10/20/30 .. 13/23/33 are the four corners.
    const pt = [[NaN, NaN, NaN], [NaN, NaN, NaN], [NaN, NaN, NaN], [NaN, NaN, NaN]];
    for (let j = i + 2; j < lines.length - 1; j += 2) {
      const code = parseInt(lines[j], 10);
      if (lines[j] === "0") break;
      const v = num(lines[j + 1]);
      if (code >= 10 && code <= 13) pt[code - 10][0] = v;
      else if (code >= 20 && code <= 23) pt[code - 20][1] = v;
      else if (code >= 30 && code <= 33) pt[code - 30][2] = v;
    }
    const good = pt.filter((p) => p.every(Number.isFinite));
    if (good.length < 3) continue;
    const base = verts.length;
    good.forEach((p) => verts.push(p));
    faces.push([base, base + 1, base + 2]);
    // A 3DFACE with four distinct corners is a quad; split it.
    if (good.length === 4) faces.push([base, base + 2, base + 3]);
  }
  if (!faces.length) {
    throw new Error(`${what}: no 3DFACE entities found` +
      (skipped ? `, though ${skipped} POLYLINE/MESH entities were skipped — ` +
                 "re-export as triangulated 3DFACEs." : "."));
  }
  return { verts, faces, skipped };
}

// ------------------------------------------------------------- drilling ----
// TRACKING.md #6. Collars, surveys and assays as three CSVs is the one thing
// every package exports the same way, which is why it is worth parsing
// properly rather than storing.
//
// Column names are not standardised, so they are matched loosely — HOLEID,
// HOLE_ID, BHID, DHID and "Hole" all name the same thing, and an export that
// calls depth "AT" is not wrong, just different.

const HOLE_NAMES = ["holeid", "hole_id", "hole", "bhid", "dhid", "drillhole", "id"];

/** Collars: one row per hole, with a position and usually a total depth. */
export function readCollars(text, what = "collars") {
  const { header, rows } = parseTable(text, what);
  const ih = col(header, ...HOLE_NAMES);
  const ix = col(header, "east", "easting", "x", "xcollar", "collarx");
  const iy = col(header, "north", "northing", "y", "ycollar", "collary");
  const iz = col(header, "elev", "elevation", "rl", "z", "zcollar", "collarz");
  const it = col(header, "td", "totaldepth", "depth", "maxdepth", "eoh", "length");
  const missing = [["hole id", ih], ["easting", ix], ["northing", iy], ["elevation", iz]]
    .filter(([, i]) => i < 0).map(([n]) => n);
  if (missing.length) {
    throw new Error(`${what}: could not find ${missing.join(", ")}. ` +
      `Columns present: ${header.join(", ")}`);
  }
  const out = [];
  for (const r of rows) {
    const id = String(r[ih] ?? "").trim();
    const x = num(r[ix]), y = num(r[iy]), z = num(r[iz]);
    if (!id || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    out.push({ id, x, y, z, td: it >= 0 ? num(r[it]) : NaN });
  }
  if (!out.length) throw new Error(`${what}: no rows with a hole id and a complete position.`);
  return out;
}

/** Downhole surveys: depth, azimuth, dip per station. */
export function readSurveys(text, what = "surveys") {
  const { header, rows } = parseTable(text, what);
  const ih = col(header, ...HOLE_NAMES);
  const id_ = col(header, "depth", "at", "distance", "md", "from");
  const ia = col(header, "azimuth", "azi", "brg", "bearing", "dip_dir", "dipdirection");
  const ip = col(header, "dip", "inclination", "incl", "plunge");
  const missing = [["hole id", ih], ["depth", id_], ["azimuth", ia], ["dip", ip]]
    .filter(([, i]) => i < 0).map(([n]) => n);
  if (missing.length) {
    throw new Error(`${what}: could not find ${missing.join(", ")}. ` +
      `Columns present: ${header.join(", ")}`);
  }
  const byHole = new Map();
  for (const r of rows) {
    const id = String(r[ih] ?? "").trim();
    const d = num(r[id_]), a = num(r[ia]), p = num(r[ip]);
    if (!id || ![d, a, p].every(Number.isFinite)) continue;
    (byHole.get(id) || byHole.set(id, []).get(id)).push({ d, az: a, dip: p });
  }
  for (const v of byHole.values()) v.sort((m, n) => m.d - n.d);
  if (!byHole.size) throw new Error(`${what}: no usable survey stations.`);
  return byHole;
}

/** Assays: from/to intervals with a grade. */
export function readAssays(text, what = "assays") {
  const { header, rows } = parseTable(text, what);
  const ih = col(header, ...HOLE_NAMES);
  const ifr = col(header, "from", "depthfrom", "start", "top");
  const ito = col(header, "to", "depthto", "end", "bottom");
  const ig = col(header, "aueq", "au_gt", "au", "grade", "gold", "value", "assay");
  const missing = [["hole id", ih], ["from", ifr], ["to", ito], ["grade", ig]]
    .filter(([, i]) => i < 0).map(([n]) => n);
  if (missing.length) {
    throw new Error(`${what}: could not find ${missing.join(", ")}. ` +
      `Columns present: ${header.join(", ")}`);
  }
  const byHole = new Map();
  for (const r of rows) {
    const id = String(r[ih] ?? "").trim();
    const f = num(r[ifr]), t = num(r[ito]), g = num(r[ig]);
    if (!id || ![f, t, g].every(Number.isFinite) || t <= f) continue;
    (byHole.get(id) || byHole.set(id, []).get(id)).push({ f, t, g });
  }
  for (const v of byHole.values()) v.sort((m, n) => m.f - n.f);
  if (!byHole.size) throw new Error(`${what}: no usable intervals.`);
  return { byHole, gradeColumn: header[ig] };
}

/**
 * Desurvey: turn collars + surveys into a polyline per hole.
 *
 * Minimum-curvature, which is what the industry reports against. The simpler
 * tangent method is off by metres over a few hundred, and a drill trace that
 * misses its own intercepts by metres is worse than no trace — the whole point
 * of drawing it is to show where the grade is.
 *
 * A hole with no survey is treated as vertical, and SAID to be: assuming
 * vertical silently would put an angled hole in the wrong rock.
 */
export function desurvey(collars, surveysByHole, step = 5) {
  const rad = Math.PI / 180;
  const traces = [], assumedVertical = [];
  for (const c of collars) {
    let st = surveysByHole?.get(c.id);
    if (!st || !st.length) { st = [{ d: 0, az: 0, dip: -90 }]; assumedVertical.push(c.id); }
    if (st[0].d > 0) st = [{ d: 0, az: st[0].az, dip: st[0].dip }, ...st];
    const td = Number.isFinite(c.td) && c.td > 0 ? c.td : st[st.length - 1].d;
    if (!(td > 0)) continue;

    const at = (depth) => {
      let i = 0;
      while (i + 1 < st.length && st[i + 1].d <= depth) i++;
      const a = st[i], b = st[Math.min(i + 1, st.length - 1)];
      if (b === a || b.d === a.d) return { az: a.az, dip: a.dip };
      const f = (depth - a.d) / (b.d - a.d);
      // Interpolate azimuth the short way round: 350 -> 10 is 20 degrees.
      let da = ((b.az - a.az) % 360 + 540) % 360 - 180;
      return { az: a.az + da * f, dip: a.dip + (b.dip - a.dip) * f };
    };
    // Dip is negative downward, the near-universal convention in collar and
    // survey exports. Straight from dip rather than via an inclination angle:
    // the first version went through (90 + dip) and drilled every hole
    // upwards, which the fixture caught by asserting the sign of the drop.
    const unit = (s) => {
      const h = Math.cos(s.dip * rad);
      return [h * Math.sin(s.az * rad), h * Math.cos(s.az * rad), Math.sin(s.dip * rad)];
    };

    const pts = [[c.x, c.y, c.z]];
    let prev = 0, p = [c.x, c.y, c.z];
    for (let d = step; d <= td + 1e-9; d = Math.min(d + step, td)) {
      const s1 = at(prev), s2 = at(d), md = d - prev;
      const v1 = unit(s1), v2 = unit(s2);
      // Minimum curvature: the dogleg ratio straightens as the angle goes to
      // zero, and the guard below is what keeps a straight hole from dividing
      // by it.
      const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
      const dl = Math.acos(dot);
      const rf = dl < 1e-6 ? 1 : (2 / dl) * Math.tan(dl / 2);
      p = [p[0] + (md / 2) * (v1[0] + v2[0]) * rf,
           p[1] + (md / 2) * (v1[1] + v2[1]) * rf,
           p[2] + (md / 2) * (v1[2] + v2[2]) * rf];
      pts.push([p[0], p[1], p[2]]);
      prev = d;
      if (d >= td) break;
    }
    traces.push({ id: c.id, collar: [c.x, c.y, c.z], td, pts, step });
  }
  if (!traces.length) throw new Error("No holes could be desurveyed — check the collar depths.");
  return { traces, assumedVertical };
}

/** Position along a desurveyed trace at a given depth. */
export function pointAt(trace, depth) {
  const i = Math.min(trace.pts.length - 1, Math.max(0, Math.floor(depth / trace.step)));
  const j = Math.min(trace.pts.length - 1, i + 1);
  const a = trace.pts[i], b = trace.pts[j];
  const f = Math.min(1, Math.max(0, (depth - i * trace.step) / trace.step));
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// ----------------------------------------------------------- geophysics ----
// TRACKING.md #2. A magnetics grid is an image plus the six numbers that say
// where it sits. Those numbers live in a world file — .tfw beside a .tif, .pgw
// beside a .png — which every GIS and geophysics package writes and which is
// six lines of plain text.
//
// GeoTIFF IS decoded now — see readGeoTiff at the foot of this file. What
// follows described the world-file path, which remains the answer for PNG and
// JPEG grids.
// The old reasoning was that a TIFF reader written against a guess
// mis-georeferences silently — the survey lands in the wrong place and looks
// perfectly fine. That risk is real and is why this uses geotiff.js, a
// maintained reader, rather than a hand-rolled one. Image + world file remains
// and an explicit extent typed by the user covers the rest.

/** World file: six numbers, one per line — pixel size and rotation, then the
 *  centre of the top-left pixel. */
export function readWorldFile(text, what = "world file") {
  const n = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").map(Number);
  if (n.length < 6 || n.some((v) => !Number.isFinite(v))) {
    throw new Error(`${what}: expected six numbers (pixel size, rotation, rotation, ` +
      `pixel size, top-left x, top-left y); got ${n.length}.`);
  }
  const [A, D, B, E, C, F] = n;
  if (A === 0 || E === 0) throw new Error(`${what}: pixel size cannot be zero.`);
  if (D !== 0 || B !== 0) {
    throw new Error(`${what}: the grid is rotated (rotation terms are not zero). ` +
      `A rotated raster cannot be draped as a rectangle — re-export it north-up.`);
  }
  return { A, D, B, E, C, F };
}

/**
 * Corner coordinates of an image placed by a world file.
 *
 * The world file references the CENTRE of the top-left pixel, so the edge is
 * half a pixel further out. Half a pixel is nothing on a 2 m grid and metres
 * on a 200 m one, and getting it wrong shifts the whole survey.
 */
export function worldExtent(wf, widthPx, heightPx) {
  if (!(widthPx > 0 && heightPx > 0)) throw new Error("Image dimensions are unknown.");
  const x0 = wf.C - wf.A / 2, y0 = wf.F - wf.E / 2;
  const x1 = x0 + wf.A * widthPx, y1 = y0 + wf.E * heightPx;
  return { west: Math.min(x0, x1), east: Math.max(x0, x1),
           south: Math.min(y0, y1), north: Math.max(y0, y1),
           pixel: [Math.abs(wf.A), Math.abs(wf.E)] };
}

/** Product type from a filename. Advisory — the UI lets it be corrected — but
 *  right nearly always, because geophysicists name their grids carefully. */
export function magProduct(name) {
  const n = (name || "").toLowerCase();
  if (/1vd|firstvertical|first_vertical|fvd/.test(n)) return { key: "1vd", label: "RTP First Vertical Derivative", unit: "nT/m" };
  if (/2vd|secondvertical/.test(n)) return { key: "2vd", label: "RTP Second Vertical Derivative", unit: "nT/m²" };
  if (/rtp|reducedtopole|reduced_to_pole/.test(n)) return { key: "rtp", label: "TMI Reduced to Pole", unit: "nT" };
  if (/tmi|totalmag|total_mag/.test(n)) return { key: "tmi", label: "Total Magnetic Intensity", unit: "nT" };
  if (/analytic|asig|as_/.test(n)) return { key: "as", label: "Analytic Signal", unit: "nT/m" };
  if (/rad|k_|th_|u_|potass|thorium|uranium/.test(n)) return { key: "rad", label: "Radiometrics", unit: "" };
  if (/grav|bouguer/.test(n)) return { key: "grav", label: "Gravity", unit: "mGal" };
  return { key: "grid", label: "Geophysical grid", unit: "" };
}

// ---------------------------------------------------------- geochemistry ----
// TRACKING.md #5. Soil, rock-chip and stream-sediment sampling is often the
// only assay data an early project has, and it is what the first target map is
// drawn from. A sample file is points with values, which sounds trivial until
// you meet real ones: coordinates may be projected or lat/lon, values carry
// units in the header, and below-detection results are written as a negative
// number, a "<" prefix, or the detection limit itself.

/** Elements worth offering by default. Not exhaustive — any numeric column can
 *  be chosen — but these are recognised without being told. */
const ELEMENTS = ["au", "ag", "cu", "pb", "zn", "mo", "ni", "co", "as", "sb",
                  "bi", "w", "sn", "li", "u", "ce", "la", "s", "fe", "hg", "te"];

/**
 * Sample points with one chosen element.
 *
 * Below-detection handling is explicit rather than incidental. "<0.005" and
 * "-0.005" both mean "under the limit", and both are extremely common. Treating
 * the negative literally puts impossible values on the map; dropping the row
 * loses the fact that the sample was taken and came back clean. Convention is
 * half the detection limit, and the count of substitutions is reported so
 * nobody has to guess how much of a map is made of them.
 */
export function readGeochem(text, what = "geochem", element) {
  const { header, rows } = parseTable(text, what);
  const ix = col(header, "east", "easting", "x", "utme", "utm_e");
  const iy = col(header, "north", "northing", "y", "utmn", "utm_n");
  const ilon = col(header, "lon", "long", "longitude");
  const ilat = col(header, "lat", "latitude");
  const iid = col(header, "sampleid", "sample", "id", "station", "site");
  const projected = ix >= 0 && iy >= 0;
  if (!projected && !(ilon >= 0 && ilat >= 0)) {
    throw new Error(`${what}: no coordinates. Expected easting/northing or ` +
      `longitude/latitude. Columns present: ${header.join(", ")}`);
  }

  // Which element? Named one wins; otherwise the first recognised element
  // column. Never silently pick an arbitrary numeric column — "the third
  // column happened to be numeric" is not an assay.
  let iv = -1, name = element || null;
  if (element) iv = colExact(header, element);
  if (iv < 0) {
    for (const e of ELEMENTS) {
      // Exact only. An element symbol is one or two letters and matches inside
      // half the column names in a survey file.
      const i = colExact(header, e + "_ppm", e + "_ppb", e + "ppm", e + "ppb", e);
      if (i >= 0) { iv = i; name = header[i]; break; }
    }
  }
  if (iv < 0) {
    throw new Error(`${what}: could not find an element column. ` +
      `Columns present: ${header.join(", ")}`);
  }

  const pts = [];
  let belowDetection = 0, skipped = 0;
  for (const r of rows) {
    const raw = String(r[iv] ?? "").trim();
    let v;
    if (/^</.test(raw)) { v = num(raw.slice(1)) / 2; belowDetection++; }
    else {
      v = num(raw);
      if (Number.isFinite(v) && v < 0) { v = Math.abs(v) / 2; belowDetection++; }
    }
    const a = projected ? num(r[ix]) : num(r[ilon]);
    const b = projected ? num(r[iy]) : num(r[ilat]);
    if (![a, b, v].every(Number.isFinite)) { skipped++; continue; }
    pts.push({ id: iid >= 0 ? String(r[iid] ?? "").trim() : "", a, b, v });
  }
  if (!pts.length) throw new Error(`${what}: no rows with coordinates and a value.`);

  const sorted = pts.map((p) => p.v).sort((m, n) => m - n);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  return {
    element: name,
    // Units from the header where it says so; assays are quoted per-unit and a
    // ppb map read as ppm is off by a thousand.
    unit: /ppb/i.test(name) ? "ppb" : /pct|%/i.test(name) ? "%" : "ppm",
    projected, points: pts,
    stats: { samples: pts.length, below_detection: belowDetection, skipped,
             min: sorted[0], max: sorted[sorted.length - 1],
             p50: q(0.5), p90: q(0.9), p98: q(0.98) },
  };
}

// ------------------------------------------------------------- GeoTIFF ----
/**
 * Read a GeoTIFF: the pixels, and the georeferencing it carries in its own
 * tags.
 *
 * This is the format a geophysical contractor actually hands over. Refusing it
 * and asking for "a PNG with a .tfw" asked the customer to degrade their own
 * deliverable and then re-supply, by hand, the six numbers the file already
 * contained — a step that exists only for our convenience and that they can
 * get wrong.
 *
 * Decoded in the browser, like everything else here: the raw grid never leaves
 * the machine, and only the drawn image and its extent are uploaded.
 *
 * Returns null when the file is a plain TIFF with no georeferencing, so the
 * caller can fall back to a world file rather than treat "not a GeoTIFF" as a
 * failure.
 */
let _geotiffLib = null;
async function geotiffLib() {
  if (_geotiffLib) return _geotiffLib;
  if (globalThis.GeoTIFF) return (_geotiffLib = globalThis.GeoTIFF);
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js";
    s.crossOrigin = "anonymous";
    s.onload = res;
    s.onerror = () => rej(new Error(
      "The GeoTIFF reader could not be loaded. Check the connection, or " +
      "export the grid as PNG with its world file."));
    document.head.appendChild(s);
  });
  if (!globalThis.GeoTIFF) throw new Error("The GeoTIFF reader failed to start.");
  return (_geotiffLib = globalThis.GeoTIFF);
}

export async function readGeoTiff(file) {
  const GT = await geotiffLib();
  const buf = await file.arrayBuffer();
  let img;
  try {
    img = await (await GT.fromArrayBuffer(buf)).getImage();
  } catch (e) {
    throw new Error(`${file.name} could not be read as a TIFF: ${e.message}`);
  }
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  // A TIFF with no tie point and no pixel scale is just a picture. Say so by
  // returning null rather than by inventing an extent for it.
  if (!Number.isFinite(ox) || !Number.isFinite(rx) || !rx) return null;

  const w = img.getWidth(), h = img.getHeight();
  // getResolution's y is negative for a north-up image, which is the normal
  // case; the extent is written min/max so the sign cannot flip it upside down.
  const x0 = ox, x1 = ox + rx * w;
  const y0 = oy, y1 = oy + ry * h;
  const extent = {
    west: Math.min(x0, x1), east: Math.max(x0, x1),
    south: Math.min(y0, y1), north: Math.max(y0, y1),
  };

  const keys = img.getGeoKeys ? (img.getGeoKeys() || {}) : {};
  // The EPSG the grid was written in. Recorded, not converted: the deck places
  // the survey in the project's own projection, and a silent reprojection here
  // would be a second opinion about where the anomaly is.
  const epsg = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey || null;

  // Render to a bitmap the same way the PNG path does, so everything
  // downstream sees one kind of thing. Single-band grids are the common case
  // and get a linear grey ramp; 3-band files are already a picture.
  const rasters = await img.readRasters({ interleave: false });
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  const out = ctx.createImageData(w, h);
  // Number(null) is 0, and a DEM at sea level has real zeros. Coercing a
  // missing GDAL_NODATA tag to 0 would punch every genuine zero-metre cell out
  // of the ground as though it were a survey void. Same trap as Number("").
  const ndRaw = img.getGDALNoData ? img.getGDALNoData() : null;
  const nodata = (ndRaw === null || ndRaw === undefined || ndRaw === "")
    ? null : Number(ndRaw);

  if (rasters.length >= 3) {
    const [R, G, B] = rasters;
    for (let i = 0; i < w * h; i++) {
      out.data[i * 4] = R[i]; out.data[i * 4 + 1] = G[i];
      out.data[i * 4 + 2] = B[i]; out.data[i * 4 + 3] = 255;
    }
  } else {
    const band = rasters[0];
    // Percentile stretch, not min/max: one hot cell in a magnetics grid would
    // otherwise flatten the whole survey to black.
    const finite = [];
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      if (Number.isFinite(v) && !(nodata !== null && v === nodata)) finite.push(v);
    }
    finite.sort((a, b) => a - b);
    const lo = finite[Math.floor(finite.length * 0.02)] ?? 0;
    const hi = finite[Math.floor(finite.length * 0.98)] ?? 1;
    const span = hi - lo || 1;
    for (let i = 0; i < w * h; i++) {
      const v = band[i];
      const bad = !Number.isFinite(v) || (nodata !== null && v === nodata);
      const t = bad ? 0 : Math.max(0, Math.min(1, (v - lo) / span));
      const g = Math.round(t * 255);
      out.data[i * 4] = g; out.data[i * 4 + 1] = g; out.data[i * 4 + 2] = g;
      out.data[i * 4 + 3] = bad ? 0 : 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const bitmap = await createImageBitmap(cv);
  // The raw first band as well as the picture. A magnetics grid wants the
  // picture; a DEM wants the numbers, and the same file can be either.
  return { extent, bitmap, width: w, height: h, epsg, bands: rasters.length,
           band: rasters[0], nodata };
}

/**
 * Open Mining Format (.omf) — the one interchange format worth reading.
 *
 * Every other binary in BINARY_FORMATS is refused, and after taking a Vulcan
 * .bmf apart I am more confident that is right: 576 MB of it contained not one
 * variable name, so a reader would have had to GUESS which column was zinc.
 * OMF is the opposite of that in every way that matters. It is an open spec
 * governed by the Global Mining Guidelines Group, its reference implementation
 * is public, and — the part that decides it — **it is self-describing**. Every
 * element and every attribute carries its own name, so nothing is inferred.
 *
 * It is also what these packages export. Leapfrog writes OMF v0.9 directly;
 * Micromine imports and exports it; it was built to carry wireframes, block
 * models, points and drillhole traces in ONE file. A geologist exporting OMF
 * hands over the whole project instead of six files named by hand.
 *
 * Two container layouts, both handled:
 *   v1 (v0.9, what Leapfrog writes) — 60-byte header, binary blob, then a
 *      UTF-8 JSON dictionary at the end keyed by UID. Arrays are zlib blobs
 *      addressed by {start, length, dtype} into the blob.
 *   v2 — a ZIP holding project.json plus one file per array.
 *
 * Returns the project decoded but NOT interpreted: elements with their real
 * names, geometry, and named attributes. Deciding that a surface is a vein and
 * a volume is a resource is the caller's job, not this reader's.
 */
const OMF_MAGIC = [0x84, 0x83, 0x82, 0x81];

async function inflate(bytes) {
  // zlib.compress output — the wrapped format, which is DecompressionStream's
  // "deflate". "deflate-raw" would fail on the two-byte header.
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One {start,length,dtype} index into the binary blob, as numbers. */
async function omfArray(index, blob) {
  if (!index || typeof index.start !== "number") return null;
  const raw = await inflate(blob.subarray(index.start, index.start + index.length));
  // The spec permits exactly two: little-endian float64 and int64. Anything
  // else is a file this reader does not understand, and saying so beats
  // returning numbers that are not the numbers in the file.
  if (index.dtype === "<f8") return new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8);
  if (index.dtype === "<i8") {
    // int64 -> Number. Counts and indices in a mining model are far inside
    // 2^53; anything that is not would be a corrupt file rather than a big one.
    const big = new BigInt64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8);
    const out = new Float64Array(big.length);
    for (let i = 0; i < big.length; i++) out[i] = Number(big[i]);
    return out;
  }
  throw new Error(`OMF array has dtype ${index.dtype}, which the spec does not allow.`);
}

export async function readOMF(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let json, blob = buf, resolveArr;

  if (OMF_MAGIC.every((b, i) => buf[i] === b)) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const version = new TextDecoder().decode(buf.subarray(4, 36)).replace(/\0+$/, "");
    const jsonStart = Number(dv.getBigUint64(52, true));
    if (!(jsonStart > 60 && jsonStart <= buf.length)) {
      throw new Error(`${file.name} is an OMF file with a JSON offset outside ` +
        "the file — it is truncated or was not written completely.");
    }
    json = JSON.parse(new TextDecoder().decode(buf.subarray(jsonStart)));
    json.__version = version;
    resolveArr = (idx) => omfArray(idx, blob);
  } else if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // v2: a ZIP. project.json plus one member per array.
    const files = await unzipMembers(buf);
    const pj = files.get("project.json");
    if (!pj) throw new Error(`${file.name} is a ZIP but has no project.json, so it is not OMF v2.`);
    json = JSON.parse(new TextDecoder().decode(pj));
    resolveArr = async (idx) => {
      const key = typeof idx === "string" ? idx : idx && idx.array;
      const raw = files.get(String(key));
      if (!raw) return null;
      return new Float64Array(raw.buffer, raw.byteOffset, raw.byteLength / 8);
    };
  } else {
    throw new Error(`${file.name} does not start with the OMF magic number or a ZIP header.`);
  }

  const at = (uid) => (uid && json[uid]) || null;
  const projUid = Object.keys(json).find((k) => (json[k] || {}).__class__ === "Project");
  const proj = projUid ? json[projUid] : null;
  const elementUids = (proj && proj.elements) || Object.keys(json)
    .filter((k) => /Element$/.test((json[k] || {}).__class__ || ""));

  const elements = [];
  for (const uid of elementUids) {
    const el = at(uid);
    if (!el) continue;
    const geom = at(el.geometry) || {};
    const kind = String(el.__class__ || "").replace(/Element$/, "");
    const out = { name: el.name || "(unnamed)", description: el.description || "",
                  kind, geometryClass: geom.__class__ || "", data: [] };

    if (/Surface/.test(kind) && geom.vertices) {
      const v = await resolveArr(geom.vertices), t = await resolveArr(geom.triangles);
      const o = geom.origin || [0, 0, 0];
      out.verts = []; out.faces = [];
      for (let i = 0; i + 2 < v.length; i += 3) {
        out.verts.push([v[i] + o[0], v[i + 1] + o[1], v[i + 2] + o[2]]);
      }
      for (let i = 0; t && i + 2 < t.length; i += 3) out.faces.push([t[i], t[i + 1], t[i + 2]]);
    } else if (/PointSet|LineSet/.test(kind) && geom.vertices) {
      const v = await resolveArr(geom.vertices);
      const o = geom.origin || [0, 0, 0];
      out.verts = [];
      for (let i = 0; i + 2 < v.length; i += 3) {
        out.verts.push([v[i] + o[0], v[i + 1] + o[1], v[i + 2] + o[2]]);
      }
      if (geom.segments) {
        const s = await resolveArr(geom.segments);
        out.segments = [];
        for (let i = 0; s && i + 1 < s.length; i += 2) out.segments.push([s[i], s[i + 1]]);
      }
    } else if (/Volume/.test(kind)) {
      // A regular block model: three tensors of block widths, an origin and
      // three axes. Widths per block, not one size — OMF carries a variable
      // lattice natively, which is exactly the sub-blocked case this product
      // otherwise has to detect and refuse.
      out.grid = {
        origin: geom.origin || [0, 0, 0],
        axis_u: geom.axis_u || [1, 0, 0], axis_v: geom.axis_v || [0, 1, 0],
        axis_w: geom.axis_w || [0, 0, 1],
        tensor_u: Array.from(await resolveArr(geom.tensor_u) || []),
        tensor_v: Array.from(await resolveArr(geom.tensor_v) || []),
        tensor_w: Array.from(await resolveArr(geom.tensor_w) || []),
      };
      out.blocks = out.grid.tensor_u.length * out.grid.tensor_v.length *
                   out.grid.tensor_w.length;
    }

    // The attributes, by name. This is the thing .bmf could not give.
    for (const duid of el.data || []) {
      const d = at(duid);
      if (!d) continue;
      const arrRef = d.array;
      const arrObj = typeof arrRef === "string" ? at(arrRef) : arrRef;
      const idx = arrObj && (arrObj.array || arrObj);
      let values = null;
      try { values = await resolveArr(idx); } catch { values = null; }
      out.data.push({ name: d.name || "(unnamed)", location: d.location || "",
                      description: d.description || "",
                      values: values ? Array.from(values) : null });
    }
    elements.push(out);
  }
  return { version: json.__version || json.version || "unknown",
           name: (proj && proj.name) || file.name, elements };
}

/** Minimal ZIP member reader — enough for OMF v2, which is stored/deflated. */
async function unzipMembers(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map();
  // Walk local file headers rather than the central directory: OMF v2 writes
  // members in order and this avoids parsing two structures to read one file.
  let p = 0;
  while (p + 30 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    let csize = dv.getUint32(p + 18, true);
    const nlen = dv.getUint16(p + 26, true), elen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(buf.subarray(p + 30, p + 30 + nlen));
    const dataAt = p + 30 + nlen + elen;
    if (!csize) break;                       // streamed entry; not written here
    const raw = buf.subarray(dataAt, dataAt + csize);
    out.set(name, method === 8
      ? new Uint8Array(await new Response(
          new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
        ).arrayBuffer())
      : raw);
    p = dataAt + csize;
  }
  return out;
}

/**
 * ESRI ASCII grid (.asc) — a DEM as plain text.
 *
 * Worth reading because it is the one raster format every package in the list
 * writes without argument: Leapfrog, Micromine, Deswik, MinePlan and QGIS all
 * export it, and unlike GeoTIFF it needs no library. Six header lines, then the
 * grid, row 0 at the NORTH edge — the same orientation demToMesh already
 * assumes, so the output is the shape readGeoTiff returns and nothing
 * downstream has to know which reader produced it.
 *
 * It carries no CRS. That is a property of the format, not a gap here: a .asc
 * is bare numbers, and the projection travels in a sibling .prj or in the
 * reader's head. `epsg: null` says so rather than guessing, and the caller
 * falls back to the project's own grid — which for a customer's own survey of
 * their own ground is right far more often than any guess would be.
 */
export function readAsciiGrid(text, name = "grid.asc") {
  const head = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  // Header keys are case-insensitive and the count varies: yllcenter is as
  // legal as yllcorner, and half a cell is a whole cell of error if ignored.
  for (; i < lines.length && i < 12; i++) {
    const m = lines[i].trim().match(/^([A-Za-z_]+)\s+(-?[\d.eE+]+)\s*$/);
    if (!m) break;
    head[m[1].toLowerCase()] = parseFloat(m[2]);
  }
  const w = head.ncols, h = head.nrows, cell = head.cellsize;
  if (!(w > 0 && h > 0 && cell > 0)) {
    throw new Error(`${name} is not an ESRI ASCII grid — it needs ncols, ` +
                    "nrows and cellsize in its header.");
  }
  // xllcorner is the OUTER corner of the lower-left cell; xllcenter is that
  // cell's centre. The extent this returns is in cell CENTRES, matching what a
  // GeoTIFF gives demToMesh — so a corner header gains half a cell and a centre
  // header gains nothing. Half a cell is a whole terrain shifted sideways, and
  // at a 10 m grid nothing downstream would ever mention it.
  const isCentre = head.xllcenter !== undefined;
  const west = isCentre ? head.xllcenter : head.xllcorner + cell / 2;
  const south = isCentre ? head.yllcenter : head.yllcorner + cell / 2;
  const nodata = head.nodata_value ?? -9999;

  const band = new Float32Array(w * h);
  let k = 0;
  for (; i < lines.length && k < band.length; i++) {
    const row = lines[i];
    if (!row) continue;
    // split on runs of whitespace; a row may wrap across several lines
    for (const tok of row.trim().split(/\s+/)) {
      if (tok === "") continue;
      if (k >= band.length) break;
      const v = +tok;
      band[k++] = v === nodata ? NaN : v;
    }
  }
  if (k < band.length) {
    throw new Error(`${name} ends early: ${k.toLocaleString()} values for a ` +
      `${w} x ${h} grid, which needs ${(w * h).toLocaleString()}.`);
  }
  return {
    width: w, height: h, band, nodata: null, epsg: null, bands: 1, bitmap: null,
    extent: { west, south, east: west + (w - 1) * cell, north: south + (h - 1) * cell },
  };
}

/**
 * A digital elevation model, as a mesh.
 *
 * LiDAR is delivered as tens of millions of returns, and nothing in a deck
 * consumes returns — what it draws is the surface derived from them, which is
 * what every LiDAR pipeline already produces on the way to handing over the
 * cloud. So the input here is the DEM, and the output is the same
 * {verts, faces} the viewer already builds vein surfaces from.
 *
 * Downsampled hard and on purpose. A 4,000 x 4,000 DEM is sixteen million
 * vertices; nobody can see that on a hillside, and a deck that takes a minute
 * to open has spent its budget on detail the audience cannot perceive.
 */
export function demToMesh(dem, maxSide = 320) {
  const { width: w, height: h, band, extent, nodata } = dem;
  if (!band || !w || !h) throw new Error("That file has no elevation band to read.");
  const step = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
  const nx = Math.floor((w - 1) / step) + 1;
  const ny = Math.floor((h - 1) / step) + 1;
  const dx = (extent.east - extent.west) / (w - 1 || 1);
  const dy = (extent.north - extent.south) / (h - 1 || 1);

  const verts = new Array(nx * ny);
  const good = new Uint8Array(nx * ny);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const sx = i * step, sy = j * step;
      const z = band[sy * w + sx];
      const ok = Number.isFinite(z) && (nodata === null || z !== nodata);
      // Row 0 of a north-up raster is the NORTH edge, so y runs down from it.
      // Getting this backwards mirrors the topography and nothing complains.
      verts[j * nx + i] = [extent.west + sx * dx, extent.north - sy * dy, ok ? z : 0];
      good[j * nx + i] = ok ? 1 : 0;
      if (ok) { if (z < lo) lo = z; if (z > hi) hi = z; }
    }
  }
  if (!Number.isFinite(lo)) throw new Error("Every cell in that DEM is no-data.");

  // Two triangles per cell, and a cell is skipped when any corner is no-data —
  // a void in a survey is a hole in the ground, not a spike down to zero.
  const faces = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (!(good[a] && good[b] && good[c] && good[d])) continue;
      faces.push([a, c, b], [b, c, d]);
    }
  }
  if (!faces.length) throw new Error("That DEM has no continuous ground in it.");
  return { verts, faces, nx, ny, step, zMin: lo, zMax: hi };
}
