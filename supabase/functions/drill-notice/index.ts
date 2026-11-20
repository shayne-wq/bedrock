// Bedrock — tell the people who asked, when the metres move.
//
// A posted progress report changes every share link for the project and tells
// nobody. The leads a gated deck captured are exactly the people who asked to
// be told: the published privacy policy says their details are held for the
// issuer "to follow up", and this is that.
//
// MAILING IS A THIRD ACT. Writing a report is not posting it, and posting it is
// not broadcasting it to a list of named people — so this is not wired to
// `published_at` and nothing here fires on its own. The console shows a count
// and asks; this runs when somebody presses the button.
//
// AUTHORISATION IS RLS, NOT CODE. Every read below runs on the CALLER'S JWT, so
// the function can only ever see a report, a deck and a lead list the caller is
// already entitled to. The service role appears exactly twice, for the two
// writes the caller has no grant for: the send log, and an unsubscribe. A
// service-role version of the reads would be an open relay wearing our sender
// reputation — the same reasoning as `invite`.
//
//   POST /functions/v1/drill-notice  { update_id, preview? }
//     Authorization: Bearer <signed-in user's access token>
//     preview: true counts the recipients and sends nothing.
//
//   GET  /functions/v1/drill-notice?u=<unsub_token>        (public)
//     The unsubscribe link in the footer of every one of these emails.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { json, preflight, CORS } from "../_shared/http.ts";

const POSTMARK = "https://api.postmarkapp.com/email";

// Where a share token actually opens. NOT constructed from anything the caller
// says, and not guessed: the viewer path and the `&api=` parameter are both
// load-bearing — a link missing `api` renders a deck that reports nothing, and
// the viewer directory has silently broken every share link once already. The
// api base comes from this function's own SUPABASE_URL, which is the same value
// the console computes it from.
const VIEWER_URL = Deno.env.get("VIEWER_URL") ?? "https://getbedrock.ca/williams/";
const API_BASE = `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "")}/functions/v1`;

const fmt = (n: number) => Math.round(n).toLocaleString("en-CA");

// ------------------------------------------------------------ unsubscribe ----
// Public, idempotent, and it answers the same way whether or not the token was
// real: a token that says "no such subscriber" is a token oracle, and there is
// nothing to gain from distinguishing the two to the person clicking.
async function unsubscribe(tok: string) {
  // PLAIN TEXT, DELIBERATELY. The first version served a styled HTML page and
  // the platform rewrote the content type to text/plain on the way out —
  // Supabase sanitises HTML from functions on the shared *.supabase.co domain,
  // which is why `px` can return image/gif and `deck` application/json but
  // this cannot return text/html. The page rendered as its own markup.
  //
  // So it says so in the type it is actually served as. An unsubscribe
  // confirmation has one job and a stylesheet is not it; serving it prettily
  // would mean a static page on getbedrock.ca and a 302, which is a second
  // thing to keep working for no gain to the person reading it.
  const page = (msg: string) =>
    new Response(
      msg + "\n\n" +
      "You will not get drilling updates for this deck again.\n\n" +
      "The company that sent you the deck still holds the details you entered.\n" +
      "Ask them to delete those, or write to us and we will pass it on.\n",
      {
        status: 200,
        headers: {
          ...CORS,
          "content-type": "text/plain; charset=utf-8",
          // Nothing may cache an unsubscribe: a cached copy is a link that
          // looks like it worked the second time without doing anything.
          "cache-control": "no-store",
        },
      },
    );
  // The same answer whether or not the token was real. A reply that says "no
  // such subscriber" is a token oracle, and there is nothing to gain from
  // telling the two apart to the person who clicked.
  if (!tok || tok.length > 80) return page("Unsubscribed.");
  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  // Only ever sets it, never clears it: opting back in is their decision to
  // make again, not ours to undo on their behalf.
  await svc.from("deck_leads").update({ unsubscribed_at: new Date().toISOString() })
    .eq("unsub_token", tok).is("unsubscribed_at", null);
  return page("Unsubscribed.");
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  if (req.method === "GET") return unsubscribe(url.searchParams.get("u") ?? "");
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "sign in first" }, 401);

  let updateId = "", preview = false;
  try {
    const b = await req.json();
    updateId = b?.update_id ?? "";
    preview = b?.preview === true;
  } catch { return json({ error: "bad request body" }, 400); }
  if (!updateId) return json({ error: "missing update_id" }, 400);

  const postmark = Deno.env.get("POSTMARK_TOKEN");
  const from = Deno.env.get("POSTMARK_FROM");
  // Checked even for a preview. A count of people we are about to be unable to
  // mail is a button that lies about what pressing it will do.
  if (!postmark || !from) {
    return json({
      error: "email is not configured",
      detail: !postmark && !from ? "POSTMARK_TOKEN and POSTMARK_FROM are unset"
            : !postmark ? "POSTMARK_TOKEN is unset" : "POSTMARK_FROM is unset",
    }, 501);
  }

  // The caller's own credentials, for every read.
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } }, auth: { persistSession: false } },
  );

  const { data: up } = await db.from("drill_updates")
    .select("id, program_id, as_of, metres_total, holes_done, holes_active, body, author, published_at")
    .eq("id", updateId).maybeSingle();
  // Not-found and not-allowed are deliberately the same answer: telling them
  // apart turns this into a way to test whether a report id exists.
  if (!up) return json({ error: "no such report" }, 404);
  // THE LINE THE WHOLE FEATURE RESTS ON. A draft is an unfinished number and
  // this is the audience it must never reach — and unlike a deck, an email
  // cannot be taken back once it is wrong.
  if (!up.published_at) return json({ error: "post the report before sending it" }, 409);

  const { data: prog } = await db.from("drill_programs")
    .select("id, project_id, zone_id, name, status, target_m")
    .eq("id", up.program_id).maybeSingle();
  if (!prog) return json({ error: "no such programme" }, 404);

  const { data: project } = await db.from("projects")
    .select("id, name").eq("id", prog.project_id).maybeSingle();

  // Which decks actually SHOW this programme. A lead who opened a deck that
  // excludes this zone never saw this rig and is not an audience for it.
  //
  // The rule is the deck function's: a programme with no zone belongs to the
  // whole project, otherwise the deck must span its zone. Second copy, named
  // here because drift between the two means mailing somebody about a rig their
  // deck does not draw — worth extracting into _shared/ next time one of them
  // is touched. See supabase/functions/deck/index.ts.
  const { data: decks } = await db.from("decks")
    .select("id, title, settings").eq("project_id", prog.project_id);
  const carries = (settings: Record<string, unknown> | null) => {
    if (!prog.zone_id) return true;
    const picked = Array.isArray(settings?.zones) ? settings!.zones as string[] : null;
    return picked ? picked.includes(prog.zone_id) : true;
  };
  const deckIds = (decks ?? []).filter((d) => carries(d.settings as never)).map((d) => d.id);
  if (!deckIds.length) return json({ ok: true, recipients: 0, sent: 0, reason: "no deck shows this programme" });

  // The audience. Three exclusions, and each one is a correctness rule rather
  // than a nicety:
  //   unsubscribed — they asked not to be mailed, and that is the whole point
  //                  of having a working unsubscribe at all;
  //   dead link    — their share link is revoked or expired, so the deck the
  //                  email points at will not open for them;
  //   already sent — the unique index refuses the duplicate anyway, but filtering
  //                  here is what makes the count on the button honest.
  const { data: leads } = await db.from("deck_leads")
    .select("id, deck_id, name, email, share_link_id, unsubscribed_at, unsub_token")
    .in("deck_id", deckIds);
  const { data: links } = await db.from("share_links")
    .select("id, deck_id, token, revoked_at, expires_at").in("deck_id", deckIds);
  const { data: already } = await db.from("drill_notices")
    .select("lead_id, status").eq("update_id", updateId);

  const sentTo = new Set((already ?? []).filter((n) => n.status === "sent").map((n) => n.lead_id));
  const failedTo = new Set((already ?? []).filter((n) => n.status === "failed").map((n) => n.lead_id));
  const now = Date.now();
  const liveLink = (deckId: string, linkId: string | null) => {
    const pool = (links ?? []).filter((l) =>
      l.deck_id === deckId && !l.revoked_at &&
      (!l.expires_at || new Date(l.expires_at).getTime() > now));
    // The link they actually came through, so the email opens the deck they
    // were given. If that one is gone, any live link to the same deck is a
    // better answer than no link at all.
    return pool.find((l) => l.id === linkId) ?? pool[0] ?? null;
  };

  type Target = { lead: Record<string, string>; token: string };
  const targets: Target[] = [];
  const skipped = { unsubscribed: 0, no_link: 0, already: 0 };
  for (const l of leads ?? []) {
    if (l.unsubscribed_at) { skipped.unsubscribed++; continue; }
    if (sentTo.has(l.id)) { skipped.already++; continue; }
    const link = liveLink(l.deck_id, l.share_link_id);
    if (!link) { skipped.no_link++; continue; }
    targets.push({ lead: l as never, token: link.token });
  }

  if (preview) {
    return json({ ok: true, preview: true, recipients: targets.length, skipped });
  }
  if (!targets.length) return json({ ok: true, recipients: 0, sent: 0, skipped });

  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // A previous run that failed mid-send left `failed` rows, and the unique
  // index would refuse the retry. Clearing them is what makes the button
  // retryable without making it re-send to anybody it already reached.
  const retry = targets.filter((t) => failedTo.has(t.lead.id)).map((t) => t.lead.id);
  if (retry.length) {
    await svc.from("drill_notices").delete()
      .eq("update_id", updateId).eq("status", "failed").in("lead_id", retry);
  }

  const metres = Number(up.metres_total);
  const holes = Number(up.holes_done);
  const subject = Number.isFinite(metres)
    ? `${project?.name ?? "Drilling"} — ${fmt(metres)} m drilled`
    : `${project?.name ?? "Drilling"} — drilling update`;

  let sent = 0, failed = 0;
  for (const t of targets) {
    const deckUrl = `${VIEWER_URL}?t=${encodeURIComponent(t.token)}` +
                    `&api=${encodeURIComponent(API_BASE)}`;
    const unsub = `${API_BASE}/drill-notice?u=${encodeURIComponent(t.lead.unsub_token)}`;
    const lines = [
      `${project?.name ?? "The project"} has filed a drilling update.`,
      "",
    ];
    if (Number.isFinite(metres)) {
      lines.push(`Metres drilled to date: ${fmt(metres)} m` +
        (Number(prog.target_m) ? ` of ${fmt(Number(prog.target_m))} m planned` : ""));
    }
    if (Number.isFinite(holes)) lines.push(`Holes finished: ${fmt(holes)}`);
    if (Number.isFinite(Number(up.holes_active))) {
      lines.push(`Holes turning now: ${fmt(Number(up.holes_active))}`);
    }
    lines.push(`As of: ${String(up.as_of).slice(0, 10)}`);
    // The issuer's own words, unaltered. Whoever posted this affirmed in the
    // console that anything result-shaped in it is already public; it is on
    // the deck either way, and paraphrasing somebody's disclosure would be a
    // worse idea than quoting it.
    if (up.body) lines.push("", String(up.body));
    if (up.author) lines.push("", `Reported by ${up.author}`);
    lines.push("", `See it on the deck: ${deckUrl}`, "",
      `You are getting this because you entered your details to open this ` +
      `deck. Unsubscribe: ${unsub}`);

    // Claimed BEFORE it is sent. At-most-once is the right failure mode for
    // an email: a report that misses one recipient can be retried, where one
    // that reaches somebody twice cannot be un-sent.
    const { error: claim } = await svc.from("drill_notices").insert({
      update_id: updateId, lead_id: t.lead.id, deck_id: t.lead.deck_id,
    });
    if (claim) { skipped.already++; continue; }

    try {
      const r = await fetch(POSTMARK, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Postmark-Server-Token": postmark },
        body: JSON.stringify({
          From: from, To: t.lead.email,
          Subject: subject,
          TextBody: lines.join("\n"),
          MessageStream: Deno.env.get("POSTMARK_STREAM") ?? "outbound",
        }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out?.Message ?? `Postmark ${r.status}`);
      sent++;
      await svc.from("drill_notices")
        .update({ provider_id: out?.MessageID ?? null })
        .eq("update_id", updateId).eq("lead_id", t.lead.id);
    } catch (e) {
      failed++;
      await svc.from("drill_notices")
        .update({ status: "failed", error: String((e as Error).message).slice(0, 400) })
        .eq("update_id", updateId).eq("lead_id", t.lead.id);
    }
  }

  return json({ ok: true, recipients: targets.length, sent, failed, skipped });
});
