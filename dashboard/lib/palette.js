// Two brand colours, read off the issuer's logo.
//
// This reads the actual pixels rather than asking a model what colour the logo
// is. A model would need the image uploaded, cost a round trip per logo, and
// still be guessing at something the file states exactly — and it would be
// confidently wrong on the cases that matter, like a wordmark whose only
// saturated pixels are in a small device beside it. Counting pixels is exact,
// instant, offline, and the logo never leaves the browser.
//
// What comes out has to survive one hard constraint the logo knows nothing
// about: **the deck is rendered on #07090A**. A navy that reads beautifully on
// letterhead is invisible there. So every colour is lifted until it clears
// contrast against that ground, keeping its hue.

const GROUND = [0x07, 0x09, 0x0a];      // the viewer's background
const MIN_CONTRAST = 4.5;               // WCAG AA for body-sized text
const FALLBACK = ["#C99A3A", "#F2C14E"];   // Bedrock's own gold

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function hexOf([r, g, b]) {
  return "#" + [r, g, b].map((v) =>
    clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function rgbOf(hex) {
  const h = String(hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

// ---------------------------------------------------------------- colour --

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function toRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360;
  if (!s) { const v = l * 255; return [v, v, v]; }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60)];
  return seg.map((v) => (v + m) * 255);
}

const lum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Lift a colour until it is readable on the deck's ground, keeping its hue.
 *  A brand navy stays navy — it just stops being invisible. */
export function legible(rgb, ground = GROUND, min = MIN_CONTRAST) {
  if (contrast(rgb, ground) >= min) return rgb;
  const [h, s] = toHsl(rgb);
  // Walk lightness up rather than blending toward white, which would wash the
  // hue out of a saturated mark.
  for (let l = 0.35; l <= 0.92; l += 0.02) {
    const c = toRgb([h, Math.max(s, 0.18), l]);
    if (contrast(c, ground) >= min) return c.map(Math.round);
  }
  return toRgb([h, Math.max(s, 0.18), 0.92]).map(Math.round);
}

// -------------------------------------------------------------- extract ---

/** Read the two most characteristic colours out of an image.
 *
 *  `dataUrl` is whatever the console already stored — the logo is downscaled
 *  at upload, so this is small and synchronous in practice.
 *
 *  Returns { colors: [primary, secondary], monochrome: boolean }. A logo that
 *  is only black and white has no colours to take, and says so rather than
 *  returning two greys that would make the deck look broken. */
export function paletteFrom(dataUrl) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onerror = () => reject(new Error("Could not read that logo."));
    im.onload = () => {
      const N = 128;
      const s = Math.min(1, N / Math.max(im.width, im.height));
      const w = Math.max(1, Math.round(im.width * s));
      const h = Math.max(1, Math.round(im.height * s));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(im, 0, 0, w, h);

      let px;
      try { px = cx.getImageData(0, 0, w, h).data; }
      catch { return reject(new Error("That image could not be inspected.")); }

      // Buckets of 32 per channel. Finer than this and a gradient in the mark
      // splits its own vote across a dozen near-identical bins.
      const bins = new Map();
      for (let i = 0; i < px.length; i += 4) {
        const a = px[i + 3];
        if (a < 128) continue;                       // transparent
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const [hu, sa, li] = toHsl([r, g, b]);
        if (li > 0.94 || li < 0.06) continue;        // page white, ink black
        if (sa < 0.12) continue;                     // greys carry no brand
        const key = (r >> 5) * 1024 + (g >> 5) * 32 + (b >> 5);
        const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0, sa: 0 };
        e.n++; e.r += r; e.g += g; e.b += b; e.sa += sa;
        bins.set(key, e);
      }

      if (!bins.size) {
        return resolve({ colors: FALLBACK.slice(), monochrome: true });
      }

      // Weight by how much of the mark it is AND how saturated it is: a large
      // muted field should not beat the small vivid device that is the brand.
      const ranked = [...bins.values()]
        .map((e) => ({
          rgb: [e.r / e.n, e.g / e.n, e.b / e.n],
          hue: toHsl([e.r / e.n, e.g / e.n, e.b / e.n])[0],
          score: e.n * (0.35 + (e.sa / e.n)),
        }))
        .sort((a, b) => b.score - a.score);

      const primary = ranked[0];
      // A second colour only earns its place if it is actually a different
      // one. Failing that, the deck gets a lighter tint of the first, which is
      // a deliberate monochrome scheme rather than two colours that clash by a
      // few degrees of hue.
      const apart = ranked.slice(1).find((c) => {
        const d = Math.abs(c.hue - primary.hue);
        return Math.min(d, 360 - d) > 40 && c.score > primary.score * 0.12;
      });

      const p = legible(primary.rgb.map(Math.round));
      let q;
      if (apart) {
        q = legible(apart.rgb.map(Math.round));
      } else {
        const [hh, ss, ll] = toHsl(p);
        q = legible(toRgb([hh, ss * 0.9, Math.min(0.86, ll + 0.18)]).map(Math.round));
      }

      resolve({ colors: [hexOf(p), hexOf(q)], monochrome: false });
    };
    im.src = dataUrl;
  });
}

export const BRAND_FALLBACK = FALLBACK;
