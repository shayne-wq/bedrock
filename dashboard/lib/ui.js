// Orebody console — shared client, state and UI primitives.
//
// Kept separate from app.js so the feature modules (ingest, deck) depend on
// this rather than on the entry point. Importing helpers back out of the entry
// module makes a cycle, and a cycle here would put the Supabase client in a
// temporal dead zone for whichever module happened to evaluate first.

import { CONFIG, CONFIGURED } from "../config.js";

export { CONFIGURED };

// supabase-js is vendored (dashboard/vendor/supabase.js) and loaded by a plain
// script tag rather than imported from a CDN. A CDN import makes the console
// unopenable whenever that CDN has a bad minute — which it did, with a 504, the
// first time this was tested. The viewer is self-contained; the console that
// authors it should not be less robust than the thing it produces.
const createClient = globalThis.supabase?.createClient;
if (CONFIGURED && !createClient) {
  document.body.innerHTML =
    '<p style="font:14px system-ui;color:#EDEEEC;padding:34px">' +
    'The Supabase client failed to load. Reload the page; if it persists, ' +
    'check that dashboard/vendor/supabase.js was deployed.</p>';
}
export const db = CONFIGURED && createClient
  ? createClient(CONFIG.url, CONFIG.anonKey)
  : null;

/** Mutable app state. An object rather than exported `let`s so consumers always
 *  read the current value instead of a stale copy of the binding. */
export const state = { session: null, orgs: [] };

export const $ = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmtInt = (n) => Number(n || 0).toLocaleString();

export const fmtT = (t) => {
  const n = Number(t || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " Mt";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " kt";
  return n.toFixed(0) + " t";
};

export const fmtOz = (o) => {
  const n = Number(o || 0);
  return n >= 1e6 ? (n / 1e6).toFixed(2) + " Moz"
       : n >= 1e3 ? (n / 1e3).toFixed(0) + " koz"
       : n.toFixed(0) + " oz";
};

export const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s`
                : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

export const fmtBytes = (b) => {
  const n = Number(b || 0);
  return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB"
       : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB"
       : (n / 1e3).toFixed(0) + " kB";
};

export const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined,
  { year: "numeric", month: "short", day: "numeric" }) : "—";

export const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";

let toastTimer;
export function toast(msg, bad = false) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle("bad", !!bad);
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), bad ? 6000 : 3200);
}

/** Surface the real failure. A console that tells an engineer holding a
 *  Postgres error that "something went wrong" has thrown away the only useful
 *  information it had. */
export function fail(where, error) {
  console.error(where, error);
  toast(`${where}: ${error?.message || error}`, true);
}

export function modal(html) {
  $("modalinner").innerHTML = html;
  $("modal").classList.add("on");
}
export function closeModal() { $("modal").classList.remove("on"); }

export const skeleton = (rows = 3) =>
  `<div class="panel">${'<div class="skel row"></div>'.repeat(rows)}</div>`;

/** Wire up rows that navigate and buttons that need a handler, so every view
 *  does not repeat the same two querySelectorAll loops. */
export function wire(root) {
  root.querySelectorAll("[data-go]").forEach((el) => {
    el.onclick = () => { location.hash = el.dataset.go; };
  });
}
