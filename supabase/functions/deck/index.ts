// Orebody — token-gated deck read.
//
// This is the only way an anonymous viewer obtains a deck. RLS denies the anon
// key everything; this function runs on the service role and hands back exactly
// what a valid, live, unrevoked share token entitles the caller to — and
// nothing that would let them enumerate the tenant it belongs to.
//
// GET /functions/v1/deck?t=<token>[&passcode=…][&ref=<embedding page url>]

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { CORS, json, preflight, passcodeHash, safeEqual, splitReferrer } from "../_shared/http.ts";

const SIGNED_URL_TTL = 60 * 60; // an hour: long enough for a presentation

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!token) return json({ error: "missing token" }, 400);

  const { data: link } = await db
    .from("share_links")
    .select("id, deck_id, token, expires_at, passcode_hash, allow_embed, domains, revoked_at")
    .eq("token", token)
    .maybeSingle();

  // One message for every failure mode. Distinguishing "no such token" from
  // "revoked" would turn this into an oracle for guessing tokens.
  const dead = !link || link.revoked_at ||
    (link.expires_at && new Date(link.expires_at) < new Date());
  if (dead) return json({ error: "This link is not available." }, 404);

  if (link.passcode_hash) {
    const given = url.searchParams.get("passcode");
    if (!given) return json({ error: "passcode required", needs_passcode: true }, 401);
    const h = await passcodeHash(link.token, given);
    if (!safeEqual(h, link.passcode_hash)) {
      return json({ error: "Incorrect passcode.", needs_passcode: true }, 401);
    }
  }

  // Embedding restrictions.
  //
  // Be straight about what this is: `ref` is the embedding page as reported by
  // the viewer, and a viewer can report anything. Framing genuinely cannot be
  // policed from here — the request an iframe makes carries the iframe's own
  // origin, not its parent's. Real enforcement would need a per-deck
  // `frame-ancestors` CSP on the viewer document, which a static host cannot
  // vary per token.
  //
  // So this stops a link being casually re-pasted onto another site, and does
  // not stop anyone determined. Expiry, passcode and revocation are the
  // controls that actually hold. The dashboard says so rather than implying a
  // guarantee this cannot make.
  const ref = splitReferrer(url.searchParams.get("ref"));
  const framed = url.searchParams.get("embed") === "1";
  if (framed && !link.allow_embed) {
    return json({ error: "This deck may not be embedded." }, 403);
  }
  if (framed && link.domains?.length && ref.host) {
    const ok = link.domains.some((d: string) => {
      const want = d.toLowerCase().replace(/^\*\./, "");
      return ref.host === want || ref.host!.endsWith(`.${want}`);
    });
    if (!ok) return json({ error: "This deck is not permitted on this site." }, 403);
  }

  const { data: deck } = await db
    .from("decks")
    .select("id, title, subtitle, status, theme, settings, project_id")
    .eq("id", link.deck_id)
    .maybeSingle();
  if (!deck || deck.status === "archived") {
    return json({ error: "This link is not available." }, 404);
  }

  // Note the absent org_id: a viewer needs the project's name and projection to
  // render it, and nothing about the tenancy that owns it. Selecting the whole
  // row and passing it through handed every anonymous visitor the org's UUID.
  const { data: project } = await db
    .from("projects")
    .select("name, commodity, location, epsg")
    .eq("id", deck.project_id)
    .maybeSingle();

  const { data: chapters } = await db
    .from("chapters")
    .select("ord, kind, section, title, body, camera, layers, slide, dwell_ms")
    .eq("deck_id", deck.id)
    .order("ord");

  // Zones. A project holds one or more; a zone owns the block model, drills,
  // surfaces, property and geophysics describing that one deposit.
  //
  // Datasets were being selected by project alone and handed over as a flat
  // list, so a two-zone project returned two block models with nothing to say
  // which belonged to which. The viewer took the first — rendering one zone's
  // geometry under a deck that spans both, and reporting its tonnage, with no
  // symptom. Emitting zone_id is what makes the multi-zone authoring path
  // already in the console mean anything downstream.
  const { data: allZones } = await db
    .from("zones")
    .select("id, name, slug, ord")
    .eq("project_id", deck.project_id)
    .order("ord");

  // A deck may span a subset of its project's zones, and in a chosen order.
  const picked = Array.isArray((deck.settings as Record<string, unknown> | null)?.zones)
    ? ((deck.settings as Record<string, unknown>).zones as string[])
    : null;
  const zones = picked
    ? picked.map((id) => (allZones ?? []).find((z) => z.id === id)).filter(Boolean)
    : (allZones ?? []);

  const { data: datasets } = await db
    .from("datasets")
    .select("id, zone_id, kind, label, storage_path, bytes, stats, provenance, synthetic, synthetic_note")
    .eq("project_id", deck.project_id);

  // Artifacts live in a private bucket, so hand out short-lived signed URLs
  // rather than making the bucket public. A leaked deck link expires; a public
  // bucket does not.
  //
  // Two artifacts, not one. A block model is useless to the viewer without its
  // share-weighted bucket rollups — the readout sums those, never the pixels —
  // and ingest.js writes them beside blocks.bin, recording the path under
  // provenance.buckets_path. That path was being passed through unsigned, so a
  // viewer received a location it could not fetch and no way to total anything.
  //
  // Storage paths are also SCRUBBED from the provenance that goes out. Every
  // path begins `<org_id>/<project_id>/…`, so passing provenance through whole
  // handed every anonymous visitor the tenant UUID that the `project` select
  // above deliberately omits — the same leak, through a second door.
  const sign = async (path: string | null | undefined) => {
    if (!path) return null;
    const { data } = await db.storage.from("artifacts")
      .createSignedUrl(path, SIGNED_URL_TTL);
    return data?.signedUrl ?? null;
  };
  const assets: Record<string, unknown>[] = [];
  for (const d of datasets ?? []) {
    const prov = { ...(d.provenance ?? {}) } as Record<string, unknown>;
    const bucketsPath = typeof prov.buckets_path === "string" ? prov.buckets_path : null;
    for (const k of Object.keys(prov)) {
      if (k.endsWith("_path") || k === "storage_path") delete prov[k];
    }
    assets.push({
      id: d.id, zone_id: d.zone_id ?? null,
      kind: d.kind, label: d.label, bytes: d.bytes,
      stats: d.stats, provenance: prov,
      synthetic: d.synthetic, synthetic_note: d.synthetic_note,
      url: await sign(d.storage_path),
      buckets_url: await sign(bucketsPath),
    });
  }

  // A fabricated dataset must arrive already flagged. The viewer refuses to
  // render one without a banner, but it should never have to infer that from
  // absence — the payload states it outright.
  const fabricated = assets.filter((a) => a.synthetic).map((a) => a.kind);

  return json({
    deck: {
      id: deck.id, title: deck.title, subtitle: deck.subtitle,
      theme: deck.theme, settings: deck.settings,
    },
    project,
    zones,
    chapters: chapters ?? [],
    assets,
    fabricated,
    share: { id: link.id, embed: framed },
  }, 200, {
    // Signed URLs expire, so this must not be cached beyond their life, and
    // must never be cached by a shared proxy.
    "Cache-Control": "private, max-age=300",
    ...CORS,
  });
});
