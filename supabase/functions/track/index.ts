// Bedrock — viewer analytics ingest.
//
// Called from wherever the deck is running, including inside an iframe on a
// customer's WordPress site, so CORS is open and no session cookie exists. The
// session id is minted here on first contact and echoed back for the viewer to
// keep in sessionStorage — per tab, not per person. There is no cross-site
// identifier and none is wanted.
//
// What is deliberately NOT collected: IP addresses (a country is derived at the
// edge and the address discarded), full user-agent strings, query strings from
// the embedding page, and anything a viewer types. An IR team wants to know
// which page the deck ran on and which slide lost the room. None of that
// requires knowing who was watching.
//
// POST /functions/v1/track

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { json, preflight, splitReferrer, uaFamily, country } from "../_shared/http.ts";

const MAX_EVENTS = 200;                  // per request
const MAX_SESSION_MS = 6 * 60 * 60 * 1000; // 6h; anything longer is a stuck tab
const KINDS = new Set([
  "open", "chapter", "complete", "toggle", "record", "export", "embed_view", "close",
]);

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// sendBeacon posts a Blob whose content-type we do not control, so parse the
// body by hand rather than trusting the header. A beacon that 400s is a beacon
// silently lost on page unload — exactly the events we least want to drop.
async function body(req: Request) {
  try {
    return JSON.parse(await req.text());
  } catch {
    return null;
  }
}

const clampInt = (v: unknown, lo: number, hi: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const b = await body(req);
  if (!b?.t) return json({ error: "missing token" }, 400);

  const { data: link } = await db
    .from("share_links")
    .select("id, deck_id, revoked_at, expires_at")
    .eq("token", b.t)
    .maybeSingle();
  const dead = !link || link.revoked_at ||
    (link.expires_at && new Date(link.expires_at) < new Date());
  // Swallow rather than error: a revoked link should stop reporting, not spew
  // console errors on a customer's website.
  if (dead) return json({ ok: true, dropped: true });

  const watch = clampInt(b.watch_ms, 0, MAX_SESSION_MS);
  const seen = clampInt(b.chapters_seen, 0, 10000);
  const done = b.completed === true;

  let sessionId: string | null = typeof b.s === "string" && b.s.length === 36 ? b.s : null;

  if (sessionId) {
    // Trust the session id only as far as it goes: verify it exists AND belongs
    // to this deck, so a session handed out for one deck cannot be used to
    // write engagement onto another.
    const { data: s } = await db
      .from("view_sessions").select("id, deck_id").eq("id", sessionId).maybeSingle();
    if (!s || s.deck_id !== link.deck_id) sessionId = null;
  }

  if (!sessionId) {
    const ref = splitReferrer(typeof b.ref === "string" ? b.ref : null);
    const { device, browser } = uaFamily(req.headers.get("user-agent"));
    const { data: created, error } = await db
      .from("view_sessions")
      .insert({
        deck_id: link.deck_id,
        share_link_id: link.id,
        is_embed: b.embed === true,
        referrer_host: ref.host,
        referrer_path: ref.path,
        country: country(req),
        device, browser,
        watch_ms: watch, chapters_seen: seen, completed: done,
      })
      .select("id").single();
    if (error) return json({ error: "could not start session" }, 500);
    sessionId = created.id;
  } else {
    // Counters only ever go up. A retried or out-of-order beacon must not be
    // able to walk a session's watch time backwards.
    const { data: prev } = await db
      .from("view_sessions").select("watch_ms, chapters_seen, completed")
      .eq("id", sessionId).single();
    await db.from("view_sessions").update({
      last_seen_at: new Date().toISOString(),
      watch_ms: Math.max(prev?.watch_ms ?? 0, watch),
      chapters_seen: Math.max(prev?.chapters_seen ?? 0, seen),
      completed: (prev?.completed ?? false) || done,
    }).eq("id", sessionId);
  }

  const raw = Array.isArray(b.events) ? b.events.slice(0, MAX_EVENTS) : [];
  const rows = raw
    .filter((e: Record<string, unknown>) => KINDS.has(String(e?.kind)))
    .map((e: Record<string, unknown>) => ({
      session_id: sessionId,
      deck_id: link.deck_id,          // from the token, never from the client
      t_ms: clampInt(e.t_ms, 0, MAX_SESSION_MS),
      kind: String(e.kind),
      chapter_ord: e.chapter_ord === null || e.chapter_ord === undefined
        ? null : clampInt(e.chapter_ord, 0, 10000),
      dwell_ms: e.dwell_ms === null || e.dwell_ms === undefined
        ? null : clampInt(e.dwell_ms, 0, MAX_SESSION_MS),
      meta: typeof e.meta === "object" && e.meta !== null ? e.meta : {},
    }));
  if (rows.length) await db.from("view_events").insert(rows);

  // No honesty gap here worth hiding: this endpoint is unauthenticated by
  // design, so anyone holding a share token can inflate that deck's numbers.
  // The alternative — signed beacons — would need a secret in client code,
  // which is not a secret. Treat these as marketing engagement figures, not
  // audited ones. The dashboard says the same.
  return json({ ok: true, s: sessionId });
});
