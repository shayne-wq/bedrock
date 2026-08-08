// Orebody — readers for the file formats mining software actually exports.
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
// .dat, Deswik .dwbm and OMF. Those are binary, several are undocumented, and a
// parser written against a guess would mis-read silently. They are detected and
// named so the user is told what to export instead — see sniff().

// ------------------------------------------------------------- sniffing ----
const BINARY_FORMATS = [
  { id: "omf", ext: [".omf"], magic: ["\x84\x83\x82\x81"], label: "Open Mining Format",
    advice: "OMF support is planned and is the right long-term answer. For now, " +
            "export the block model as CSV and surfaces as OBJ or DXF." },
  { id: "datamine", ext: [".dm"], label: "Datamine",
    advice: "Export the model to CSV (File > Export > CSV) and wireframes to DXF." },
  { id: "vulcan", ext: [".bmf", ".bdf"], label: "Maptek Vulcan block model",
    advice: "Export the block model to CSV, and triangulations (.00t) to OBJ or DXF." },
  { id: "surpac", ext: [".mdl"], label: "Surpac model",
    advice: "Export the model to CSV and DTMs to DXF." },
  { id: "deswik", ext: [".dwbm", ".dwcad"], label: "Deswik",
    advice: "Export the block model to CSV and solids to DXF or OBJ." },
  { id: "micromine", ext: [".dat"], label: "Micromine",
    advice: "Export to CSV." },
  { id: "leapfrog", ext: [".lfview", ".msr"], label: "Leapfrog",
    advice: "Export the block model to CSV and meshes to OBJ." },
  { id: "shapefile", ext: [".shp"], label: "Esri shapefile",
    advice: "A .shp needs its .dbf and .shx siblings to mean anything. Export " +
            "to GeoJSON or KML instead — both are single files and both load here." },
];

/**
 * What is this file, and can we read it?
 *
 * @returns {{readable:boolean, format:string, label?:string, advice?:string}}
 */
export function sniff(file) {
  const n = (file.name || "").toLowerCase();
  const ext = n.slice(n.lastIndexOf("."));
  const hit = BINARY_FORMATS.find((f) => f.ext.includes(ext));
  if (hit) {
    return { readable: false, format: hit.id, label: hit.label, advice: hit.advice };
  }
  if (/\.(geojson|json)$/.test(n)) return { readable: true, format: "geojson" };
  if (/\.(kml)$/.test(n)) return { readable: true, format: "kml" };
  if (/\.(obj)$/.test(n)) return { readable: true, format: "obj" };
  if (/\.(ts|gocad)$/.test(n)) return { readable: true, format: "gocad" };
  if (/\.(dxf)$/.test(n)) return { readable: true, format: "dxf" };
  if (/\.(csv|txt)$/.test(n)) return { readable: true, format: "csv" };
  return { readable: false, format: "unknown", label: ext || "no extension",
           advice: "Supported: CSV for models and drilling, GeoJSON or KML for " +
                   "claims, OBJ, GOCAD .ts or DXF for surfaces." };
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
// GeoTIFF is deliberately not decoded. It would need a real TIFF reader for
// the tag soup, tiling and compression variants, and a reader written against
// a guess mis-georeferences silently: the survey lands in the wrong place and
// looks perfectly fine. Image + world file covers the same ground honestly,
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
