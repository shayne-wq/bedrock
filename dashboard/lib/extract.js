// Bedrock — block-model extraction, in the browser.
//
// This is the JS port of tools/extract_blocks.py, and it exists so a customer's
// block model never has to be uploaded. A raw MineSight export is over a
// gigabyte; the artifacts the viewer actually needs are a few megabytes. Doing
// the pass client-side means the sensitive file stays on the machine it was
// exported on, the upload is seconds rather than an hour, and there is no
// server bill for GB-scale ingest. The customer uploads conclusions, not data.
//
// Environment-agnostic on purpose: it consumes an async iterable of lines, so
// the same code runs inside a Web Worker and inside Node, which is how it gets
// verified against the Python's known-good rollups on the real 1.2 GB model.
//
// THE THING NOT TO GET WRONG — a block is not owned by one domain. Where a
// model carries per-domain share columns, a block straddling two veins belongs
// partly to each, and its tonnage must be split. Crediting whole blocks to a
// dominant domain overstated one vein by 34% in contained ounces on the
// reference dataset while deposit totals still reconciled exactly, which is
// what made it nearly invisible. Share-weighting is not an optimisation here.

export const LADDER = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0,
                       8.0, 12.0, 20.0, 50.0];
export const G_PER_TROY_OZ = 31.10348;

const num = (s) => {
  if (s === undefined || s === null) return NaN;
  const t = s.trim();
  return t === "" ? NaN : Number(t);
};

// ------------------------------------------------------------------ CSV ----
/** Split one CSV line, honouring quoted fields.
 *
 *  A quoted comma inside a field shifts every column index after it, which
 *  silently corrupts the whole extraction rather than failing — so the slow
 *  path is correct rather than clever. The fast path below skips it entirely
 *  when a line contains no quote character, which on a numeric block-model
 *  export is every line, and that is worth roughly 3x on a gigabyte. */
export function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Pull only the columns at `want` (sorted ascending) out of a line.
 *  Avoids materialising ~280 substrings per row when we need eight. */
function pick(line, want) {
  if (line.indexOf('"') >= 0) {
    const all = splitCsv(line);
    return want.map((i) => all[i]);
  }
  const out = new Array(want.length);
  let col = 0, start = 0, w = 0;
  for (let i = 0; i <= line.length && w < want.length; i++) {
    if (i === line.length || line.charCodeAt(i) === 44 /* , */) {
      if (col === want[w]) { out[w] = line.slice(start, i); w++; }
      col++; start = i + 1;
    }
  }
  return out;
}

// -------------------------------------------------------------- mapping ----
const FIRST = (names, ...pats) => {
  for (const p of pats) {
    const hit = names.find((n) => n.toLowerCase() === p);
    if (hit) return hit;
  }
  for (const p of pats) {
    const hit = names.find((n) => n.toLowerCase().includes(p));
    if (hit) return hit;
  }
  return null;
};

/** Guess a mapping from the header. Every field is overridable in the UI —
 *  block-model exports have no standard schema and a guess that cannot be
 *  corrected is worse than no guess. */
export function detect(header) {
  const domainShare = header.filter(
    (n) => /^percent[_ ]/i.test(n) && !/^percent[_ ]env$/i.test(n));
  return {
    x: FIRST(header, "x", "xcentre", "xcenter", "east", "easting"),
    y: FIRST(header, "y", "ycentre", "ycenter", "north", "northing"),
    z: FIRST(header, "z", "zcentre", "zcenter", "elev", "rl", "level"),
    grade: FIRST(header, "aueq", "au_eq", "aueq_gt", "au", "grade", "gold"),
    // Fraction of the block that is ore. Absent means whole blocks.
    oreFraction: FIRST(header, "percent_env", "orepercent", "ore_frac", "partial"),
    classification: FIRST(header, "classification", "class", "resource_class"),
    density: FIRST(header, "fixeddensity", "density", "sg", "bulk_density"),
    // A single categorical domain column, used only when no share columns exist.
    domain: FIRST(header, "type", "domain", "vein", "zone", "lode"),
    // PER-ROW BLOCK DIMENSIONS. Their presence is the signature of a
    // sub-blocked model, where cells near a domain boundary are split finer
    // than the parent grid. Datamine writes XINC/YINC/ZINC, Vulcan and Deswik
    // export similar. We cannot yet honour them — see the guard in extract() —
    // but detecting them is what stops a wrong tonnage going out silently.
    dimX: FIRST(header, "xinc", "dx", "xsize", "xlength", "xdim", "blockx"),
    dimY: FIRST(header, "yinc", "dy", "ysize", "ylength", "ydim", "blocky"),
    dimZ: FIRST(header, "zinc", "dz", "zsize", "zlength", "zdim", "blockz"),
    domainShare,
    // Filled by probe(), overridable by the user.
    dx: null, dy: null, dz: null,
    densityConst: null,
    gradeUnit: "g/t",
  };
}

/** Compare names with any leading digits read as a number, so 950E sorts
 *  before 1000 rather than after it. */
export function naturalCompare(a, b) {
  const ma = /^(\d+)/.exec(a), mb = /^(\d+)/.exec(b);
  if (ma && mb) {
    const d = Number(ma[1]) - Number(mb[1]);
    if (d) return d;
    return a.slice(ma[1].length).localeCompare(b.slice(mb[1].length));
  }
  if (ma) return -1;          // numbered domains before named ones
  if (mb) return 1;
  return a.localeCompare(b);
}

/** Modal positive spacing, plus how dominant that mode actually is.
 *
 *  The share matters as much as the value. On a regular lattice nearly every
 *  gap is the cell size (larger gaps only appear across holes, and are
 *  multiples of it). On a sub-blocked model the gaps are a mixture, and taking
 *  the mode silently assigns one volume to cells that do not share it. */
function spacingProfile(values) {
  const u = [...new Set(values)].sort((a, b) => a - b);
  if (u.length < 2) return { value: null, share: 0 };
  const counts = new Map();
  let total = 0;
  for (let i = 1; i < u.length; i++) {
    const d = Math.round((u[i] - u[i - 1]) * 1000) / 1000;
    if (d > 0) { counts.set(d, (counts.get(d) || 0) + 1); total++; }
  }
  let best = null, n = -1;
  for (const [d, c] of counts) if (c > n) { best = d; n = c; }
  // Share of gaps that ARE the mode, exactly. Larger gaps are holes in the
  // grid and are expected; the number is a texture measure, not a verdict.
  //
  // What the SHARE cannot do: a 2.5 m sub-block inside a 10 m parent produces
  // gaps of 2.5 and 10, which by gap size alone is indistinguishable from a
  // 2.5 m grid with holes. That was true, and it was where this stopped.
  //
  // It is not where the evidence stops. See latticeProfile below: the gaps
  // cannot tell the two apart, but the CENTRES can.
  let exact = 0;
  for (const [d, c] of counts) if (Math.abs(d - best) < 1e-6) exact += c;
  return { value: best, share: total ? exact / total : 0 };
}
function spacing(values) { return spacingProfile(values).value; }

/** Do these coordinates sit on ONE lattice of the given pitch?
 *
 *  This is the signal the gap histogram misses, and it is decisive for the
 *  case this detector previously documented as undetectable.
 *
 *  On a uniform grid every centre is origin + pitch x k, so every coordinate
 *  leaves the SAME remainder modulo the pitch. One residual class, always,
 *  however many holes the grid has — a hole removes a centre, it does not
 *  move the survivors off the lattice.
 *
 *  Sub-block a 10 m parent into 2.5 m children and the children's centres are
 *  at 1.25, 3.75, 6.25, 8.75 while the surviving parent's centre is at 5.0.
 *  Modulo 2.5 that is 1.25 for every child and 0.0 for the parent: two
 *  classes, and no amount of holes in a real grid produces a second one.
 *
 *  The honest limit is the factor, not the method. A parent that is an ODD
 *  multiple of the child — 7.5 m over 2.5 m — puts the parent centre back on
 *  a child centre and this sees one class again. Sub-blocking is nearly always
 *  by two or four, so this catches the common case and misses an uncommon one;
 *  `ragged` still flags that as uncertain rather than passing it as clean.
 *
 *  @returns {{classes:number, offGrid:number}} how many residual classes, and
 *  the share of coordinates NOT in the largest one.
 */
function latticeProfile(values, pitch) {
  if (!(pitch > 0) || values.length < 8) return { classes: 1, offGrid: 0 };
  // Not Math.min(...values): a 40,000-row sample is past the argument limit
  // and would throw rather than answer.
  let base = Infinity;
  for (const v of values) if (v < base) base = v;
  // A hundredth of a cell. Survey coordinates carry rounding; a second class
  // 1.25 m away from the first is a different cell size, and 0.001 m is float.
  const tol = Math.max(pitch / 100, 1e-6);
  const res = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let r = ((values[i] - base) % pitch + pitch) % pitch;
    if (pitch - r < tol) r = 0;               // just under the pitch is zero
    res[i] = r;
  }
  res.sort((a, b) => a - b);
  let classes = 0, biggest = 0, start = 0;
  for (let i = 1; i <= res.length; i++) {
    if (i === res.length || res[i] - res[start] > tol) {
      classes++;
      if (i - start > biggest) biggest = i - start;
      start = i;
    }
  }
  return { classes, offGrid: 1 - biggest / res.length };
}

/** Read a sample to infer block dimensions and a representative density.
 *
 *  Block size is not in the file — it is implied by the grid — and tonnage is
 *  meaningless without it. Inferring it and showing the user what was inferred
 *  beats making them find it in a technical report, and beats guessing
 *  silently. */
export async function probe(lines, mapping, sampleRows = 40000) {
  const it = lines[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) throw new Error("The file is empty.");
  const header = splitCsv(first.value);
  const col = Object.fromEntries(header.map((n, i) => [n, i]));
  const m = mapping || detect(header);
  for (const k of ["x", "y", "z", "grade"]) {
    if (!m[k] || !(m[k] in col)) {
      throw new Error(`Could not find a column for ${k}. Map it by hand.`);
    }
  }
  const want = [col[m.x], col[m.y], col[m.z]];
  const dcol = m.density && col[m.density] !== undefined ? col[m.density] : null;
  if (dcol !== null) want.push(dcol);
  const order = [...want].sort((a, b) => a - b);
  const at = (vals, c) => vals[order.indexOf(c)];

  const xs = [], ys = [], zs = [], ds = [];
  let n = 0;
  for await (const line of it) {
    if (!line) continue;
    const v = pick(line, order);
    const x = num(at(v, col[m.x])), y = num(at(v, col[m.y])), z = num(at(v, col[m.z]));
    if (Number.isFinite(x)) xs.push(x);
    if (Number.isFinite(y)) ys.push(y);
    if (Number.isFinite(z)) zs.push(z);
    if (dcol !== null) { const d = num(at(v, dcol)); if (Number.isFinite(d) && d > 0) ds.push(d); }
    if (++n >= sampleRows) break;
  }
  ds.sort((a, b) => a - b);
  const px = spacingProfile(xs), py = spacingProfile(ys), pz = spacingProfile(zs);
  // Two independent signals that this is not one uniform lattice: the file
  // carries per-row dimensions, or the observed spacings do not agree on one
  // cell size. Either means a single dx*dy*dz is the wrong volume for some
  // proportion of the blocks, and tonnage is the output nobody checks.
  // Only the dimension columns block. `ragged` is advisory: a low share can
  // mean sub-blocking, or simply a grid with a lot of holes, and refusing a
  // legitimate patchy model would be its own kind of wrong.
  const dimCols = !!(m.dimX && m.dimY && m.dimZ);
  const ragged = Math.min(px.share, py.share, pz.share) < 0.55;

  // The third signal, and the one that closes the documented hole. A uniform
  // grid puts every centre in one residual class per axis; two classes means
  // two cell sizes in the same file, which is sub-blocking by definition.
  //
  // One percent, not zero: a handful of rows can be off-lattice for dull
  // reasons — a truncated coordinate, a hand-edited row — and refusing an
  // entire model over four bad rows would be its own kind of wrong.
  const lx = latticeProfile(xs, px.value);
  const ly = latticeProfile(ys, py.value);
  const lz = latticeProfile(zs, pz.value);
  const offGrid = Math.max(lx.offGrid, ly.offGrid, lz.offGrid);
  const offLattice = offGrid > 0.01;

  // What the user is told, in the order the evidence is worth. `uncertain` is
  // deliberately its own verdict: the issue this closes asked for the
  // uncertainty to be visible rather than collapsed into a yes or a no, and a
  // patchy-but-uniform model is a real thing people load.
  const reasons = [];
  if (dimCols) reasons.push("the file carries per-block dimension columns");
  if (offLattice) {
    reasons.push(`${Math.round(offGrid * 100)}% of block centres do not sit on ` +
                 "the same grid as the rest, which means more than one cell size");
  }
  if (!dimCols && !offLattice && ragged) {
    reasons.push("block spacing is irregular — which can be a patchy grid, or " +
                 "sub-blocking on an odd factor that the centre test cannot see");
  }
  const verdict = (dimCols || offLattice) ? "sub-blocked"
                : ragged ? "uncertain" : "uniform";

  return {
    header, mapping: m, sampled: n,
    dx: px.value, dy: py.value, dz: pz.value,
    spacingShare: { x: px.share, y: py.share, z: pz.share },
    offGrid, offLattice, latticeClasses: Math.max(lx.classes, ly.classes, lz.classes),
    uniformity: { verdict, reasons },
    dimCols, ragged, subBlocked: dimCols || offLattice,
    densityMedian: ds.length ? ds[ds.length >> 1] : null,
    densityUniform: ds.length ? ds[0] === ds[ds.length - 1] : false,
  };
}

// -------------------------------------------------------------- extract ----
/** Growable Float32 column. A block model's row count is not known until the
 *  file has been read, and pre-allocating for the worst case would blow the
 *  tab's memory on a model that turns out to be small. */
class Col {
  constructor(Type) { this.T = Type; this.a = new Type(1 << 16); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) {
      const b = new this.T(this.a.length * 2);
      b.set(this.a); this.a = b;
    }
    this.a[this.n++] = v;
  }
  trimmed() { return this.a.subarray(0, this.n); }
}

/**
 * Single streaming pass. Emits the packed columns the viewer renders from and
 * the exact rollups it reports from — which are computed over every block here,
 * at ingest, so that filtering or decimating the render can never move a number.
 */
export async function extract(lines, opts) {
  const {
    mapping, dx, dy, dz, density, onProgress, cutoff = 0,
  } = opts;
  const it = lines[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) throw new Error("The file is empty.");
  const header = splitCsv(first.value);
  const col = Object.fromEntries(header.map((n, i) => [n, i]));

  const blockM3 = dx * dy * dz;
  if (!(blockM3 > 0)) throw new Error("Block dimensions must all be positive.");
  // Refuse a sub-blocked model rather than report a confident wrong number.
  // Every tonne here is blockM3 x density x ore fraction, so one volume for
  // blocks that do not share one volume is not an approximation — it is a
  // tonnage that looks right, reconciles against itself, and is false.
  if (opts.subBlocked && !opts.acceptUniform) {
    throw new Error(
      "This looks like a SUB-BLOCKED model: " + (opts.subBlockedWhy ||
        "the file carries per-block dimensions, or the block centres do not " +
        "sit on one regular grid") + ". " +
      "Bedrock computes tonnage from a single block volume, so it would " +
      "report a confident wrong number for a model like this. Export on a " +
      "regular grid, or re-block it, before loading.");
  }

  // Domain order is presentation, but it is also identity: a domain's index
  // here becomes its id in the packed column and in every bucket key. Sort it
  // once, deliberately, and naturally — a plain lexicographic sort files vein
  // "1000" ahead of "950E", which is not an order any geologist reading the
  // legend would expect.
  const shareCols = (mapping.domainShare || []).filter((n) => n in col)
    .sort((a, b) => naturalCompare(a.replace(/^percent[_ ]/i, ""),
                                   b.replace(/^percent[_ ]/i, "")));
  const domains = shareCols.length
    ? shareCols.map((n) => n.replace(/^percent[_ ]/i, ""))
    : [];
  const domainId = Object.fromEntries(domains.map((d, i) => [d, i]));

  const need = new Set([col[mapping.x], col[mapping.y], col[mapping.z], col[mapping.grade]]);
  const iOre = mapping.oreFraction && col[mapping.oreFraction] !== undefined
    ? col[mapping.oreFraction] : null;
  const iCls = mapping.classification && col[mapping.classification] !== undefined
    ? col[mapping.classification] : null;
  const iDen = mapping.density && col[mapping.density] !== undefined
    ? col[mapping.density] : null;
  const iDom = !shareCols.length && mapping.domain && col[mapping.domain] !== undefined
    ? col[mapping.domain] : null;
  for (const i of [iOre, iCls, iDen, iDom]) if (i !== null) need.add(i);
  for (const n of shareCols) need.add(col[n]);
  const order = [...need].sort((a, b) => a - b);
  const idx = Object.fromEntries(order.map((c, i) => [c, i]));

  const cx = new Col(Float32Array), cy = new Col(Float32Array), cz = new Col(Float32Array);
  const cg = new Col(Float32Array), cp = new Col(Float32Array);
  const cc = new Col(Uint8Array), cv = new Col(Uint16Array);

  const perDomain = new Map();   // name -> [blocks, tonnes, metal_g]
  const perClass = new Map();
  const perBucket = new Map();   // "d|c|b" share-weighted
  const perCb = new Map();       // "c|b" distinct blocks
  const total = [0, 0, 0];
  // Categorical domain labels when there are no share columns.
  const labelId = new Map();

  let scanned = 0, dropped = 0, straddling = 0, skipped = 0;
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;

  const bump = (map, key, blocks, t, m) => {
    let e = map.get(key);
    if (!e) map.set(key, (e = [0, 0, 0]));
    e[0] += blocks; e[1] += t; e[2] += m;
  };

  for await (const line of it) {
    if (!line) continue;
    scanned++;
    if (onProgress && (scanned & 0xffff) === 0) onProgress(scanned);
    const v = pick(line, order);

    const grade = num(v[idx[col[mapping.grade]]]);
    if (!Number.isFinite(grade) || grade <= 0) continue;

    let ore = 1;
    if (iOre !== null) {
      ore = num(v[idx[iOre]]);
      if (!Number.isFinite(ore) || ore <= 0) continue;
      // Some exports write a percentage rather than a fraction.
      if (ore > 1.0000001) ore = ore / 100;
    }
    if (grade < cutoff) { skipped++; continue; }

    const x = num(v[idx[col[mapping.x]]]);
    const y = num(v[idx[col[mapping.y]]]);
    const z = num(v[idx[col[mapping.z]]]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    const den = iDen !== null && density == null
      ? (num(v[idx[iDen]]) || 0) : density;
    if (!(den > 0)) continue;
    const tonnesWhole = blockM3 * den;

    let cls = 0;
    if (iCls !== null) {
      const c = num(v[idx[iCls]]);
      cls = Number.isFinite(c) ? Math.max(0, Math.min(255, Math.trunc(c))) : 0;
    }

    // Domain shares. A block may belong partly to several.
    let shares = null, dom = -1;
    if (shareCols.length) {
      shares = [];
      for (let i = 0; i < shareCols.length; i++) {
        let s = num(v[idx[col[shareCols[i]]]]);
        if (!Number.isFinite(s) || s <= 0) continue;
        if (s > 1.0000001) s = s / 100;
        shares.push([i, s]);
      }
      if (!shares.length) { dropped++; continue; }
      if (shares.length > 1) straddling++;
      // Dominant domain drives colour and position only. Never tonnage.
      dom = shares.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    } else if (iDom !== null) {
      const raw = (v[idx[iDom]] || "").trim() || "unassigned";
      if (!labelId.has(raw)) labelId.set(raw, labelId.size);
      dom = labelId.get(raw);
      shares = [[dom, ore]];
    } else {
      dom = 0;
      shares = [[0, ore]];
    }

    const tonnes = tonnesWhole * ore;
    const metal = tonnes * grade;
    let gbin = 0;
    while (gbin + 1 < LADDER.length && grade >= LADDER[gbin + 1]) gbin++;

    cx.push(x); cy.push(y); cz.push(z);
    cg.push(grade); cp.push(ore);
    cc.push(cls); cv.push(dom);
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;

    // Share-weighted, per domain. This is the load-bearing loop.
    for (const [di, s] of shares) {
      const dt = tonnesWhole * s;
      const name = shareCols.length ? domains[di] : null;
      bump(perDomain, name ?? di, 1, dt, dt * grade);
      bump(perBucket, `${di}|${cls}|${gbin}`, 1, dt, dt * grade);
    }
    bump(perCb, `${cls}|${gbin}`, 1, tonnes, metal);
    bump(perClass, cls, 1, tonnes, metal);
    total[0] += 1; total[1] += tonnes; total[2] += metal;
  }

  const roll = (e) => ({
    blocks: e[0],
    tonnes: Math.round(e[1] * 10) / 10,
    grade_gt: e[1] ? Math.round((e[2] / e[1]) * 1000) / 1000 : 0,
    oz: Math.round(e[2] / G_PER_TROY_OZ),
  });

  const veinNames = shareCols.length
    ? domains
    : [...labelId.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);

  const byDomain = {};
  for (const [k, e] of [...perDomain.entries()].sort((a, b) => b[1][1] - a[1][1])) {
    byDomain[shareCols.length ? k : (veinNames[k] ?? String(k))] = roll(e);
  }
  const byClass = {};
  for (const [k, e] of [...perClass.entries()].sort((a, b) => a[0] - b[0])) {
    byClass[String(k)] = roll(e);
  }

  const stats = {
    scanned_rows: scanned,
    block_m3: blockM3,
    block_dims: [dx, dy, dz],
    density: density ?? "per-block",
    tonnes_per_block: density != null ? blockM3 * density : null,
    veins: veinNames,
    share_weighted: shareCols.length > 0,
    dropped_blocks: dropped,
    below_cutoff: skipped,
    blocks_straddling_multiple_domains: straddling,
    bounds: { x: [minx, maxx], y: [miny, maxy], z: [minz, maxz] },
    total: roll(total),
    by_class: byClass,
    by_vein: byDomain,
  };

  const buckets = [...perBucket.entries()].map(([k, e]) => {
    const [v, c, b] = k.split("|").map(Number);
    return { v, c, b, n: e[0], t: Math.round(e[1] * 10) / 10, m: Math.round(e[2] * 10) / 10 };
  }).sort((p, q) => p.v - q.v || p.c - q.c || p.b - q.b);

  const by_cb = [...perCb.entries()].map(([k, e]) => {
    const [c, b] = k.split("|").map(Number);
    return { c, b, n: e[0], t: Math.round(e[1] * 10) / 10, m: Math.round(e[2] * 10) / 10 };
  }).sort((p, q) => p.c - q.c || p.b - q.b);

  // The same reconciliation the Python asserts. Every block's shares sum to its
  // ore fraction, so the share-weighted table must still add up to the deposit
  // total; if it does not, the domain columns are not what we think they are and
  // publishing the vein breakdown would be publishing a fiction.
  const bt = buckets.reduce((s, b) => s + b.t, 0);
  const drift = Math.abs(bt - stats.total.tonnes);
  const cbT = by_cb.reduce((s, b) => s + b.t, 0);
  const cbN = by_cb.reduce((s, b) => s + b.n, 0);
  const reconciled = {
    bucket_drift_t: Math.round(drift * 100) / 100,
    // Tolerance scales with the deposit: rounding each of thousands of buckets
    // to 0.1 t cannot be held to a fixed 1 t on a 100 Mt model.
    ok: drift < Math.max(1, stats.total.tonnes * 1e-6) &&
        Math.abs(cbT - stats.total.tonnes) < Math.max(1, stats.total.tonnes * 1e-6) &&
        cbN === stats.total.blocks,
  };

  return {
    stats, buckets: { ladder: LADDER, share_weighted: shareCols.length > 0, buckets, by_cb },
    reconciled,
    columns: {
      n: cx.n,
      origin: [minx, miny, minz],
      x: cx.trimmed(), y: cy.trimmed(), z: cz.trimmed(),
      g: cg.trimmed(), p: cp.trimmed(), c: cc.trimmed(), v: cv.trimmed(),
    },
  };
}

// ---------------------------------------------------------- packaging ------
/**
 * Pack the columns into one self-describing binary.
 *
 * Struct-of-arrays rather than interleaved records: the viewer filters on grade
 * and class constantly and touches positions rarely, so keeping each attribute
 * contiguous is both faster to scan and markedly more compressible. Positions
 * are stored relative to the model origin because a UTM easting near 600000
 * spends most of a float32's precision on the leading digits, and the offsets
 * do not.
 */
export function pack(columns) {
  const { n, origin } = columns;
  const parts = [
    ["x", Float32Array, columns.x], ["y", Float32Array, columns.y],
    ["z", Float32Array, columns.z], ["g", Float32Array, columns.g],
    ["p", Float32Array, columns.p], ["c", Uint8Array, columns.c],
    ["v", Uint16Array, columns.v],
  ];
  const layout = [];
  let off = 0;
  for (const [name, T, arr] of parts) {
    const align = T.BYTES_PER_ELEMENT;
    if (off % align) off += align - (off % align);
    layout.push({ name, type: T.name, offset: off, count: arr.length });
    off += arr.byteLength;
  }
  const header = JSON.stringify({ format: "orebody-blocks/1", n, origin, arrays: layout });
  const hb = new TextEncoder().encode(header);
  // 16-byte preamble keeps every typed-array view aligned once the header is
  // padded, so the viewer can map the buffer without copying.
  let hlen = hb.length;
  let pad = (16 - ((16 + hlen) % 16)) % 16;
  const base = 16 + hlen + pad;
  const buf = new ArrayBuffer(base + off);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x4f524542, false);        // "OREB"
  dv.setUint32(4, 1, true);                  // version
  dv.setUint32(8, hlen, true);
  dv.setUint32(12, base, true);
  new Uint8Array(buf, 16, hlen).set(hb);
  for (let i = 0; i < parts.length; i++) {
    const [, T, arr] = parts[i];
    new T(buf, base + layout[i].offset, arr.length).set(
      // relative positions, absolute everything else
      i < 3 ? arr.map((v) => v - origin[i]) : arr);
  }
  return buf;
}

/** Async line iterator over a whole-file stream. Works for a browser File and
 *  for a Node Readable alike, so the verification harness drives the same
 *  code path the product does. */
export async function* linesOf(stream) {
  const reader = stream.getReader ? stream.getReader() : null;
  const dec = new TextDecoder();
  let buf = "";
  const feed = function* (chunk) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  };
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* feed(dec.decode(value, { stream: true }));
    }
  } else {
    for await (const chunk of stream) yield* feed(dec.decode(chunk, { stream: true }));
  }
  buf += dec.decode();
  if (buf.length) yield buf.endsWith("\r") ? buf.slice(0, -1) : buf;
}
