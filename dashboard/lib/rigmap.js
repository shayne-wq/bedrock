/* Placing the rig by pointing at the ground.
 *
 * The two number boxes are not going away — they are what a collar sheet
 * gives you, they are exact, and a surveyed pad is best typed. This is the
 * other half: for everybody who knows where the rig is because they have
 * stood there, and would have to go and find its easting before this console
 * would take it.
 *
 * ONE POSITION, TWO EDITORS. The pin and the boxes are the same number. Drag
 * the pin and the boxes follow it as it moves; type in the boxes and the pin
 * goes there. Neither is a draft of the other, and there is no apply step —
 * an "apply" button is how a screen ends up saving the one the issuer was not
 * looking at.
 *
 * The imagery is the SAME imagery the deck draws on (Esri World Imagery,
 * OpenStreetMap when it will not load) so that the picture an issuer places
 * the rig against is the picture a shareholder sees it on. Two different
 * basemaps would put the pin a building's width from where it was aimed and
 * nobody would ever know which one was wrong.
 */
import { gridToLonLat, lonLatToGrid, metresBetween } from "./geo.js";

const ESRI = "https://services.arcgisonline.com/arcgis/rest/services/" +
  "World_Imagery/MapServer/tile/{z}/{y}/{x}";
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/* Leaflet is loaded when a map is first asked for, not when the console is.
 * It is 147 KB that most sessions never open a modal to use, and the console
 * is the screen an issuer opens on a hotel wifi to post a figure. Vendored
 * rather than fetched from a CDN, like every other library here: a console
 * that cannot place a rig because somebody else's CDN is down is a console
 * that broke for a reason none of its users can see. */
let leafletReady = null;
export function ensureLeaflet() {
  if (window.L) return Promise.resolve(true);
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve) => {
    // Resolved against THIS MODULE, not against the document. The console is
    // one page under /dashboard/, but the test harness is served from / — a
    // document-relative path works in one and 404s in the other, and the one
    // it fails in is the one that would have caught it.
    const at = (f) => new URL("../vendor/" + f, import.meta.url).href;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = at("leaflet.css");
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = at("leaflet.js");
    js.onload = () => resolve(!!window.L);
    js.onerror = () => resolve(false);
    document.head.appendChild(js);
  });
  return leafletReady;
}

/** A rig position written back to the form. Metres, whole.
 *
 *  The box takes 0.1 m because a collar sheet does, and a surveyed collar
 *  genuinely is known to a decimetre. A point picked off satellite imagery is
 *  not — the imagery itself is georeferenced to a few metres — so a map-placed
 *  position is rounded to the metre rather than dressed up to match the
 *  typed one. Precision that was never measured is a claim like any other. */
const round = (v) => Math.round(v);

/**
 * @param {object} o
 * @param {HTMLElement} o.host     where the map goes
 * @param {number}      o.epsg     the project's grid
 * @param {[number,number]|null} o.value   current easting/northing, if any
 * @param {Array}       o.collars  [[e,n,id?], …] in the project grid
 * @param {Array}       o.claims   [{ring:[[lon,lat],…]}, …] already lon/lat
 * @param {Function}    o.onChange (easting, northing) — fires while dragging
 * @returns {{setGrid:Function, destroy:Function, map:object}|null}
 */
export function mountRigMap(o) {
  const L = window.L;
  if (!L || !o?.host) return null;

  // Everything that can anchor the opening view, best first. A map that opens
  // on the whole world and asks an issuer to find their own property is not a
  // feature, so when nothing here answers the caller is told to keep the boxes
  // and say why.
  const pts = [];
  const atValue = o.value ? gridToLonLat(o.value[0], o.value[1], o.epsg) : null;
  if (atValue) pts.push(atValue);
  for (const c of o.collars || []) {
    const ll = gridToLonLat(c[0], c[1], o.epsg);
    if (ll) pts.push(ll);
  }
  for (const cl of o.claims || []) for (const p of cl.ring || []) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) pts.push([p[0], p[1]]);
  }
  if (!pts.length) return null;

  o.host.innerHTML = "";
  const map = L.map(o.host, {
    zoomControl: true,
    attributionControl: true,
    // A map inside a form competes with the form for the wheel. Scrolling the
    // modal past the map must not zoom it; a deliberate press does.
    scrollWheelZoom: false,
    maxZoom: 21,
  });
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());

  let base = L.tileLayer(ESRI, {
    maxNativeZoom: 19, maxZoom: 21,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  }).addTo(map);

  // The same fallback the viewer makes, for the same reason: a property with
  // no imagery coverage, or a blocked request, must still give somewhere to
  // put the pin. Swapped once, on repeated failure rather than on the first —
  // a single missing tile at the edge of a pan is normal.
  let bad = 0, swapped = false;
  base.on("tileerror", () => {
    if (swapped || ++bad < 4) return;
    swapped = true;
    map.removeLayer(base);
    base = L.tileLayer(OSM, {
      maxNativeZoom: 19, maxZoom: 21, attribution: "© OpenStreetMap",
    }).addTo(map);
    if (o.onBasemap) o.onBasemap("osm");
  });

  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

  // The claim boundary, if the project has loaded one. Outline only: a filled
  // polygon over imagery hides the thing the issuer is looking at, which is
  // the ground.
  for (const cl of o.claims || []) {
    const ring = (cl.ring || []).filter((p) =>
      Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[1], p[0]]);
    if (ring.length >= 3) {
      L.polygon(ring, { color: "#e0b65a", weight: 1.5, fill: false,
                        interactive: false, className: "rigmap-claim" }).addTo(map);
    }
  }

  // The collars. These are the strongest reference on the screen — a rig
  // stands among the holes it has drilled — so they are drawn, named on
  // hover, and deliberately not clickable: clicking the map places the rig,
  // and a dot that swallowed that click would be a dead patch in the middle
  // of the one place the issuer most wants to put the pin.
  for (const c of o.collars || []) {
    const ll = gridToLonLat(c[0], c[1], o.epsg);
    if (!ll) continue;
    // Leaflet draws a circleMarker as an SVG <path>, the same element it draws
    // a claim boundary with, so the two are told apart by class — both here
    // and in the suite, which counted <circle> elements, found none, and was
    // perfectly happy about it.
    const m = L.circleMarker([ll[1], ll[0]], {
      radius: 3, weight: 1, color: "#ffffff", opacity: 0.9,
      fillColor: "#0088b0", fillOpacity: 0.95, interactive: !!c[2],
      className: "rigmap-collar",
    }).addTo(map);
    if (c[2]) m.bindTooltip(String(c[2]), { direction: "top", offset: [0, -4] });
  }

  // The pin. A DivIcon rather than Leaflet's default marker on purpose: the
  // default is a PNG fetched from the library's own images/ directory, which
  // means two more requests and two more things that can 404 on a console
  // that vendors one file.
  const icon = L.divIcon({
    className: "rigpin", iconSize: [26, 34], iconAnchor: [13, 32],
    html: '<span class="rigpin-mast"></span><span class="rigpin-dot"></span>',
  });
  const start = atValue || centroid(pts);
  const pin = L.marker([start[1], start[0]], {
    icon, draggable: true, autoPan: true, keyboard: true,
    title: "Drag to where the rig stands",
  }).addTo(map);

  // The live readout, on the map rather than only in the boxes below it.
  //
  // The boxes ARE the coordinates and they do update as the pin moves — but
  // the map is 280 px of a form that already scrolls, so during a drag they
  // are often off the bottom of the screen. Feedback that happens where the
  // user is not looking is feedback that did not happen. Same numbers, in the
  // same monospace as the fields, in the corner of the thing being dragged.
  const readout = document.createElement("div");
  readout.className = "rigmap-readout";
  o.host.appendChild(readout);
  const show = (e, n) => {
    // Grouped in threes. A seven-digit northing read off a map at a glance is
    // the one number on this screen nobody can check by eye otherwise.
    const sp = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    readout.textContent = `E ${sp(e)}   N ${sp(n)}`;
  };

  // Fired while dragging, not only on drop. Watching the easting count up as
  // the pin moves is what makes the two halves of this control legibly the
  // same number; waiting for the drop leaves the boxes stale and wrong for
  // however long the drag lasts.
  const emit = () => {
    const p = pin.getLatLng();
    const g = lonLatToGrid(p.lng, p.lat, o.epsg);
    if (!g) return;
    show(g[0], g[1]);
    if (o.onChange) o.onChange(round(g[0]), round(g[1]));
  };
  pin.on("drag", emit);
  pin.on("dragend", emit);
  map.on("click", (ev) => { pin.setLatLng(ev.latlng); emit(); });

  // The opening view. Around everything the project has when the rig is not
  // placed yet; tight on the rig when it is, because the question then is
  // "is that the right pad", not "where is this property".
  if (atValue) map.setView([atValue[1], atValue[0]], 16);
  else map.fitBounds(L.latLngBounds(pts.map((p) => [p[1], p[0]])).pad(0.15));
  // The readout opens showing where the pin IS, not blank waiting to be
  // dragged — a position already on file is the thing most worth reading.
  if (atValue) show(o.value[0], o.value[1]);
  else { const g = lonLatToGrid(start[0], start[1], o.epsg); if (g) show(g[0], g[1]); }

  // Leaflet measures its container when it is created. This one is created
  // inside a modal that may not have been laid out yet, and a map that
  // measured zero renders one grey tile in the corner.
  //
  // Both deferred calls are guarded, because the modal can be closed before
  // either lands — a quarter of a second is nothing, and Cancel is right next
  // to the thing that opened it. Calling invalidateSize on a map that has been
  // removed throws on `_leaflet_pos`, which surfaces as an unhandled error on
  // a screen the issuer has already walked away from.
  let dead = false;
  const settle = () => { if (!dead) map.invalidateSize(); };
  requestAnimationFrame(settle);
  const timer = setTimeout(settle, 250);

  return {
    map,
    /** The boxes moved: follow them, without echoing back a change the form
     *  already knows about — `fire: false` here is what stops a typed digit
     *  from being rounded out from under the person typing it. */
    setGrid(e, n) {
      const ll = gridToLonLat(e, n, o.epsg);
      if (!ll) return false;
      pin.setLatLng([ll[1], ll[0]]);
      if (!map.getBounds().contains([ll[1], ll[0]])) map.panTo([ll[1], ll[0]]);
      show(e, n);
      return true;
    },
    /** How far the pin is from the nearest collar, in metres, or null when
     *  the project has no collars. The one number that tells an issuer they
     *  have put the rig on the wrong property. */
    offFrom(e, n) {
      const here = gridToLonLat(e, n, o.epsg);
      if (!here || !(o.collars || []).length) return null;
      let best = Infinity;
      for (const c of o.collars) {
        const ll = gridToLonLat(c[0], c[1], o.epsg);
        if (ll) best = Math.min(best, metresBetween(here, ll));
      }
      return Number.isFinite(best) ? best : null;
    },
    destroy() {
      dead = true;
      clearTimeout(timer);
      try { map.remove(); } catch { /* already gone */ }
    },
  };
}

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}
