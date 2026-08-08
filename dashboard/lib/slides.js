// Orebody — propose every slide the data can justify.
//
// TRACKING.md #9. Authoring a deck from a blank page asks a geologist to be a
// presentation designer. This inverts it: the platform enumerates every view
// the uploaded data actually supports, and authoring becomes choosing and
// ordering rather than constructing.
//
// THE RULE THAT MATTERS: nothing is proposed that the data does not support.
// No resource slide without a block model, no intercept slide without assays,
// no classification reveal without classes. A candidate that cannot render is
// worse than a missing one — it teaches the user the tool is guessing.
//
// Candidates are PROPOSALS. They carry the same shape a chapter does (camera,
// layers, title, body) so choosing one is a copy rather than a translation,
// but they are not persisted until chosen. `id` is stable for a given zone and
// dataset set, so re-opening the builder does not duplicate what is already in
// the running order.
//
// Shared deliberately: the console offers these and the viewer renders them.
// A second implementation would drift, and the failure mode is a deck that
// promises a slide the viewer cannot draw.

/** Every distinct dataset kind present for a zone. */
function kindsOf(datasets, zoneId) {
  return new Set(
    (datasets || [])
      .filter((d) => (d.zone_id ?? null) === (zoneId ?? null))
      .map((d) => d.kind),
  );
}

function statsOf(datasets, zoneId, kind) {
  const d = (datasets || []).find(
    (x) => (x.zone_id ?? null) === (zoneId ?? null) && x.kind === kind,
  );
  return d?.stats || null;
}

/** Slug that survives re-generation, so the builder can tell "already added". */
const sid = (zoneId, key) => `${zoneId || "z"}:${key}`;

/**
 * Candidate slides for one zone.
 *
 * @param {object} zone      { id, name }
 * @param {Array}  datasets  every dataset row for the project
 * @param {object} project   { name, commodity, location }
 */
export function zoneCandidates(zone, datasets, project) {
  const K = kindsOf(datasets, zone.id);
  const blocks = statsOf(datasets, zone.id, "blocks");
  const out = [];
  const push = (key, c) => out.push({ ...c, id: sid(zone.id, key), zone_id: zone.id });

  // ---- always, provided the zone has anything at all ---------------------
  if (!K.size) return out;

  push("overview", {
    section: zone.name, title: zone.name,
    body: `${project?.location || "The property"} — the ground this zone sits on.`,
    camera: { h: 24, p: -28, r: 4200 }, layers: { ground: 1.0, site: K.has("site") },
    needs: [],
  });

  // ---- property ----------------------------------------------------------
  if (K.has("site")) {
    push("claims", {
      section: zone.name, title: "The claim block",
      body: "Tenure boundaries as registered, with the surrounding ground and " +
            "who holds it.",
      camera: { h: 0, p: -70, r: 5200 }, layers: { ground: 1.0, site: true },
      needs: ["site"],
    });
  }

  // ---- geophysics: one slide per product, because that is how a survey is
  // read — total field, then reduced to pole, then the derivative that shows
  // edges. Collapsing them into one slide throws away the argument.
  if (K.has("geophysics")) {
    const g = statsOf(datasets, zone.id, "geophysics");
    const products = Array.isArray(g?.products) && g.products.length
      ? g.products
      : [{ key: "tmi", label: "Total Magnetic Intensity" }];
    products.forEach((prod) => {
      push(`geo-${prod.key}`, {
        section: zone.name, title: prod.label || prod.key.toUpperCase(),
        body: prod.note || `${prod.label || prod.key} draped over the property.`,
        camera: { h: 0, p: -78, r: 3400 },
        layers: { ground: 1.0, geo: prod.key, site: K.has("site"), blocks: false },
        needs: ["geophysics"],
      });
    });
  }

  // ---- geochemistry ------------------------------------------------------
  // Often the only assay data an early project has, and the slide a targeting
  // argument is actually made from.
  if (K.has("geochem")) {
    const g = statsOf(datasets, zone.id, "geochem");
    const el = g?.element ? String(g.element).replace(/_(ppm|ppb)$/i, "") : "Geochemistry";
    push("geochem", {
      section: zone.name, title: `${el} in soils`,
      body: g?.samples
        ? `${g.samples.toLocaleString()} samples, coloured on a percentile scale — ` +
          `a soil survey is lognormal and a linear ramp hides everything but the peak.`
        : "Surface sampling across the target area.",
      camera: { h: 0, p: -72, r: 3200 },
      layers: { ground: 1.0, geochem: true, site: K.has("site"), blocks: false },
      needs: ["geochem"],
    });
  }

  // ---- drilling ----------------------------------------------------------
  if (K.has("drills")) {
    push("drills", {
      section: zone.name, title: "Drilled from surface",
      body: "Drill traces hung from their collars, coloured by assay grade.",
      camera: { h: 34, p: -24, r: 2600 }, layers: { ground: 0.0, drills: true },
      needs: ["drills"],
    });
    push("intercepts", {
      section: zone.name, title: "The headline intercepts",
      body: "Each significant intersection called out where it sits in three " +
            "dimensions — the drill table, put back in the ground it came from.",
      camera: { h: 26, p: -18, r: 2400 },
      layers: { ground: 0.0, drills: true, highlights: true, callouts: true },
      needs: ["drills"],
    });
  }

  // ---- resource ----------------------------------------------------------
  // Everything below this line requires a block model, which most projects do
  // not have. That is the whole reason for `needs`.
  if (blocks?.total) {
    push("orebody", {
      section: zone.name, title: "The orebody",
      body: `${Math.round(blocks.total.tonnes).toLocaleString()} t at ` +
            `${blocks.total.grade_gt} g/t, on the real terrain it sits inside.`,
      camera: { h: 52, p: -24, r: 2600 },
      layers: { ground: 0.42, mode: "grade", cut: 0.5 },
      needs: ["blocks"],
    });
    push("core", {
      section: zone.name, title: "The high-grade core",
      body: "Raising the cut-off strips the halo and leaves the material that " +
            "carries the metal.",
      camera: { h: 50, p: -22, r: 2100 },
      layers: { ground: 0.0, mode: "grade", cut: 3.0 },
      needs: ["blocks"],
    });
    push("plan", {
      section: zone.name, title: "Grade × thickness",
      body: "Accumulated grade down each column, as a plan-view map.",
      camera: { h: 0, p: -80, r: 2600 },
      layers: { ground: 1.0, plan: true, blocks: false },
      needs: ["blocks"],
    });

    // Classification reveal, only when there is more than one class to reveal.
    // With a single class this is three identical slides.
    const classes = Object.keys(blocks.by_class || {})
      .map(Number).filter((c) => blocks.by_class[String(c)]?.tonnes).sort();
    if (classes.length > 1) {
      const NAMES = { 1: "Measured", 2: "Indicated", 3: "Inferred" };
      classes.forEach((_, i) => {
        const upto = classes.slice(0, i + 1);
        push(`class-${i}`, {
          section: zone.name,
          title: upto.map((c) => NAMES[c] || `Class ${c}`).join(" + "),
          body: "Confidence is not evenly distributed through a deposit, and " +
                "it is the first question a technical reader asks.",
          camera: { h: 40, p: -26, r: 2400 },
          layers: { ground: 0.0, mode: "class", cut: 1.0, classes: upto },
          needs: ["blocks"],
        });
      });
    }

    // Sections along both axes.
    [["ns", "N–S"], ["ew", "E–W"]].forEach(([ax, label]) => {
      push(`sect-${ax}`, {
        section: zone.name, title: `A ${label} section`,
        body: "A real slab through the model, with the readout re-totalled for " +
              "the slice rather than the whole deposit.",
        camera: { h: ax === "ns" ? 90 : 0, p: -6, r: 2200 },
        layers: { ground: 0.0, section3d: ax, sectionAt: 50, cut: 1.0 },
        needs: ["blocks"],
      });
    });

    if (K.has("surfaces")) {
      push("surfaces", {
        section: zone.name, title: "The domains as bodies",
        body: "Solid geological surfaces rather than blocks — the hull of each " +
              "domain, extracted face by face so nothing is invented between " +
              "the data points.",
        camera: { h: 50, p: -22, r: 2100 },
        layers: { ground: 0.0, surfaces: "veins", cut: 0.5 },
        needs: ["surfaces"],
      });
    }
  }

  return out;
}

/**
 * Candidates for a whole project: every zone, plus the slides that only make
 * sense across zones.
 */
export function projectCandidates(project, zones, datasets) {
  const out = [];

  // A property-scale opener earns its place only when there is more than one
  // zone, or a property outline to show. Otherwise it duplicates the zone
  // overview from a slightly different altitude.
  const anyData = (zones || []).some((z) => kindsOf(datasets, z.id).size);
  if (anyData && (zones.length > 1 || kindsOf(datasets, zones[0]?.id).has("site"))) {
    out.push({
      id: "project:property", zone_id: null,
      section: "The property", title: project?.name || "The property",
      body: `${project?.location || ""}${project?.location ? " — " : ""}` +
            `${zones.length} zone${zones.length === 1 ? "" : "s"} across the land package.`,
      camera: { h: 20, p: -30, r: 7000 }, layers: { ground: 1.0, site: true },
      needs: [],
    });
  }

  // Grade × thickness across every zone at once. Only worth a slide when more
  // than one zone carries a model — otherwise the zone's own plan view says
  // the same thing with less machinery.
  const modelled = (zones || []).filter((z) => statsOf(datasets, z.id, "blocks")?.total);
  if (modelled.length > 1) {
    out.push({
      id: "project:columns", zone_id: null,
      section: "The property", title: "Where the metal is",
      body: "One column per cell across the whole property, height and colour " +
            "carrying accumulated grade × thickness. Every zone in one frame.",
      camera: { h: 18, p: -27, r: 6000 },
      layers: { ground: 1.0, property: true, black: true, blocks: false },
      needs: ["blocks"],
    });
  }

  (zones || []).forEach((z) => out.push(...zoneCandidates(z, datasets, project)));
  return out;
}

/** Chapter row shape, for writing a chosen candidate to the database. */
export function toChapter(candidate, ord) {
  return {
    ord,
    kind: "scene",
    section: candidate.section || null,
    title: candidate.title || "",
    body: candidate.body || "",
    camera: candidate.camera || {},
    layers: candidate.layers || {},
    dwell_ms: 9000,
  };
}

// ------------------------------------------------------------ thumbnails ----
/**
 * A schematic glyph for a candidate.
 *
 * NOT a preview, and it must not pretend to be one. A real preview means
 * rendering the slide, and a candidate has not been rendered — it does not
 * exist until it is chosen. What a chooser actually needs is to tell a section
 * from a plan from a drill slide at a glance, which a shape does as well as a
 * photograph and instantly.
 *
 * Returns an inline SVG string, so there is no request, no cache and nothing
 * to invalidate when the data changes.
 */
export function candidateGlyph(c) {
  const L = c.layers || {};
  const A = "#C99A3A", G = "#6b7580", W = "#8C948C";
  const wrap = (inner) =>
    `<svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">` +
    `<rect width="64" height="40" rx="3" fill="#0d1113"/>${inner}</svg>`;
  const horizon = `<path d="M0 26 Q18 20 32 24 T64 21 L64 40 L0 40 Z" fill="#161c1f"/>`;

  if (L.property) {                        // property-wide grade columns
    let bars = "";
    [6, 12, 18, 24, 30, 36, 42, 48, 54].forEach((x, i) => {
      const h = [7, 13, 22, 30, 18, 26, 11, 16, 8][i];
      bars += `<rect x="${x}" y="${32 - h}" width="4" height="${h}" fill="${
        h > 24 ? "#D053B8" : h > 16 ? "#9B7BE8" : "#3B82D6"}"/>`;
    });
    return wrap(`<rect width="64" height="40" fill="#07090A"/>${bars}`);
  }
  if (L.geo) {                             // a magnetics product
    return wrap(`<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#2C5FA8"/>` +
      `<stop offset=".5" stop-color="#5EC8E8"/><stop offset="1" stop-color="#D053B8"/></linearGradient></defs>` +
      `<rect x="6" y="8" width="52" height="24" rx="2" fill="url(#g)" opacity=".85"/>`);
  }
  if (L.geochem) {                         // sample points
    let dots = "";
    for (let i = 0; i < 22; i++) {
      const x = 8 + (i * 13) % 48, y = 9 + ((i * 7) % 22);
      const r = 1.2 + (i % 4) * 0.7;
      dots += `<circle cx="${x}" cy="${y}" r="${r}" fill="${
        i % 7 === 0 ? "#D053B8" : i % 3 === 0 ? "#5EC8E8" : "#3B82D6"}"/>`;
    }
    return wrap(dots);
  }
  if (L.plan) {                            // plan-view grade x thickness
    return wrap(`<ellipse cx="32" cy="20" rx="20" ry="11" fill="#E8433C" opacity=".55"/>` +
      `<ellipse cx="32" cy="20" rx="12" ry="6" fill="#F2A33C" opacity=".85"/>` +
      `<ellipse cx="32" cy="20" rx="5" ry="2.6" fill="#E05CC8"/>`);
  }
  if (L.section3d) {                       // a slab through the model
    const v = L.section3d === "ns";
    return wrap(horizon + (v
      ? `<rect x="28" y="4" width="8" height="32" fill="${A}" opacity=".5"/>`
      : `<rect x="4" y="16" width="56" height="8" fill="${A}" opacity=".5"/>`));
  }
  if (L.surfaces) {                        // solid bodies
    return wrap(`<path d="M12 26 C20 12 40 12 52 20 C44 30 22 32 12 26 Z" fill="#E8433C" opacity=".6"/>` +
      `<path d="M18 22 C26 14 38 15 45 20 C38 26 24 27 18 22 Z" fill="#E05CC8" opacity=".8"/>`);
  }
  if (L.callouts || L.highlights) {        // intercepts called out
    return wrap(horizon +
      `<line x1="20" y1="6" x2="30" y2="34" stroke="${W}" stroke-width="1"/>` +
      `<line x1="34" y1="6" x2="44" y2="34" stroke="${W}" stroke-width="1"/>` +
      `<circle cx="25" cy="20" r="2.6" fill="#E8433C"/><circle cx="39" cy="20" r="2.6" fill="#E8433C"/>` +
      `<rect x="46" y="15" width="14" height="4" rx="1" fill="${G}"/>`);
  }
  if (L.drills) {                          // traces with beads
    let holes = "";
    [16, 26, 36, 46].forEach((x, i) => {
      holes += `<line x1="${x}" y1="8" x2="${x + 5}" y2="34" stroke="${W}" stroke-width="1"/>`;
      holes += `<circle cx="${x + 2}" cy="20" r="1.8" fill="${A}"/>`;
      if (i % 2 === 0) holes += `<circle cx="${x + 3}" cy="26" r="1.4" fill="${A}"/>`;
    });
    return wrap(horizon + holes);
  }
  if (L.mode === "class") {                // classification reveal
    const n = (L.classes || [1]).length;
    let bands = "";
    ["#4FD1C5", "#F2C14E", "#D9584A"].slice(0, n).forEach((c, i) => {
      bands += `<ellipse cx="32" cy="${22 - i * 4}" rx="${20 - i * 5}" ry="${8 - i * 2}" fill="${c}" opacity=".7"/>`;
    });
    return wrap(horizon + bands);
  }
  if (L.site && !L.drills) {               // the claim block
    return wrap(`<path d="M10 10 L40 8 L54 16 L50 32 L16 34 Z" fill="none" stroke="${A}" stroke-width="1.6"/>` +
      `<path d="M18 16 L34 15 L40 20 L37 27 L22 28 Z" fill="${A}" opacity=".18"/>`);
  }
  // Default: the deposit on ground.
  return wrap(horizon +
    `<ellipse cx="32" cy="21" rx="16" ry="7" fill="#E8433C" opacity=".55"/>` +
    `<ellipse cx="32" cy="20" rx="8" ry="3.4" fill="#E05CC8" opacity=".9"/>`);
}
