/* Between the project's own grid and the round earth.
 *
 * Every coordinate an issuer types into this console is in the project's grid
 * — the same numbers as their collar sheet, because that is the sheet they are
 * reading off. A map is in longitude and latitude. This is the only place that
 * converts between the two, and it is deliberately small enough to read.
 *
 * The viewer solves the same problem with proj4 and a generated definition per
 * UTM zone (see `epsgProj` in pit/index.html). The console does not carry
 * proj4, so the transverse Mercator is written out here instead — Snyder's
 * series, the same one proj4 evaluates. `tools/verify_rigmap.mjs` drives the
 * VIEWER's proj4 and this module side by side on the same coordinates and
 * fails if they disagree by more than a centimetre, because two
 * implementations of the same projection in one product is exactly the kind of
 * thing that drifts quietly until a rig is drawn in the wrong valley.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED: NAD27. The projection maths is the same,
 * but NAD27 coordinates sit 10 s to 200 m away from WGS84 ones on the ground,
 * and closing that gap needs a datum transformation this file does not do.
 * Drawing the pin anyway would put it confidently in the wrong place on the
 * imagery, which is worse than not drawing it — so `utmFor` returns null and
 * the map does not open. The number boxes still work, and still mean exactly
 * what the collar sheet means.
 */

// Ellipsoids, by the only thing that distinguishes them here.
const GRS80 = { a: 6378137, f: 1 / 298.257222101 };   // NAD83, GDA94, GDA2020
const WGS84 = { a: 6378137, f: 1 / 298.257223563 };   // WGS84 / ITRF

/** The UTM parameters behind an EPSG code, or null if this module will not
 *  answer for it. The families mirror the viewer's generated proj4
 *  definitions — a zone's parameters are a formula, so they are computed
 *  rather than listed, and the ranges are the authority on what is in scope. */
export function utmFor(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return null;
  const mk = (zone, south, ell, datum) => ({ zone, south, ...ell, datum });
  if (c >= 32601 && c <= 32660) return mk(c - 32600, false, WGS84, "WGS 84");
  if (c >= 32701 && c <= 32760) return mk(c - 32700, true, WGS84, "WGS 84");
  if (c >= 26901 && c <= 26923) return mk(c - 26900, false, GRS80, "NAD83");
  if (c >= 28348 && c <= 28358) return mk(c - 28300, true, GRS80, "GDA94");
  if (c >= 7846 && c <= 7859) return mk(c - 7800, true, GRS80, "GDA2020");
  // 26701–26722 is NAD27, and is refused on purpose. See the header.
  return null;
}

/** True where the pin would be drawn against imagery it is not registered to.
 *  Separated from `utmFor` returning null so the console can say WHICH of the
 *  two reasons it is — "that grid is NAD27" is a different sentence from "that
 *  grid is one this console does not know", and only one of them is the
 *  issuer's to act on. */
export function isNAD27(code) {
  const c = Number(code);
  return Number.isFinite(c) && c >= 26701 && c <= 26722;
}

const K0 = 0.9996, FE = 500000, FN_S = 10000000;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** Project grid → [lon, lat]. Returns null when the code is out of scope or
 *  either number is not finite — a half-position is not a position. */
export function gridToLonLat(easting, northing, code) {
  const p = utmFor(code);
  const E = Number(easting), N = Number(northing);
  if (!p || !Number.isFinite(E) || !Number.isFinite(N)) return null;

  const { a, f } = p;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const lon0 = (p.zone * 6 - 183) * D2R;

  const M = (N - (p.south ? FN_S : 0)) / K0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);

  const s = Math.sin(phi1), c = Math.cos(phi1), t = Math.tan(phi1);
  const C1 = ep2 * c * c, T1 = t * t;
  const n1 = a / Math.sqrt(1 - e2 * s * s);
  const r1 = a * (1 - e2) / (1 - e2 * s * s) ** 1.5;
  const D = (E - FE) / (n1 * K0);

  const lat = phi1 - (n1 * t / r1) * (
    D ** 2 / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6 / 720);
  const lon = lon0 + (
    D
    - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5 / 120) / c;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lon * R2D, lat * R2D];
}

/** [lon, lat] → project grid. Returns null on the same terms. */
export function lonLatToGrid(lon, lat, code) {
  const p = utmFor(code);
  const LO = Number(lon), LA = Number(lat);
  if (!p || !Number.isFinite(LO) || !Number.isFinite(LA)) return null;

  const { a, f } = p;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const lon0 = (p.zone * 6 - 183) * D2R;
  const phi = LA * D2R;

  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * s * s);
  const T = t * t, C = ep2 * c * c;
  // Longitude difference wrapped into ±180°, so a project whose grid straddles
  // the antimeridian does not get an A of twenty radians and an easting in the
  // billions.
  let dl = LO * D2R - lon0;
  while (dl > Math.PI) dl -= 2 * Math.PI;
  while (dl < -Math.PI) dl += 2 * Math.PI;
  const A = dl * c;

  const M = a * (
    (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));

  const E = FE + K0 * n * (
    A
    + (1 - T + C) * A ** 3 / 6
    + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120);
  const N = (p.south ? FN_S : 0) + K0 * (M + n * t * (
    A ** 2 / 2
    + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
    + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720));

  if (!Number.isFinite(E) || !Number.isFinite(N)) return null;
  return [E, N];
}

/** Metres between two lon/lat points. Used to size a map's opening view
 *  around whatever the project has, and to keep "how far did I just drag the
 *  rig" answerable in the units the rest of this screen is in. */
export function metresBetween(a, b) {
  const R = 6371008.8;
  const p1 = a[1] * D2R, p2 = b[1] * D2R;
  const dp = p2 - p1, dl = (b[0] - a[0]) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
