// Bedrock — a gated deck's sign-in.
//
// The deck asks for a name and an email before it opens, and posts them here.
// Called from wherever the deck is running, including inside an iframe on
// somebody else's site, so CORS is open and there is no session: the SHARE
// TOKEN is the only credential, exactly as in `track`.
//
// Runs on the service role because the anon key can reach nothing — and because
// the table is deliberately not writable by anon, so a leaked publishable key
// cannot be used to stuff a customer's lead list.
//
// What it will not do: accept a lead for a token it cannot verify, accept one
// for a revoked or expired link, or take anything the caller says about which
// deck it belongs to. The deck id comes from the token.
//
// POST /functions/v1/lead  { t, name, email, company?, ref? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { json, preflight, splitReferrer } from "../_shared/http.ts";

const POSTMARK = "https://api.postmarkapp.com/email";
const CONSOLE_URL = Deno.env.get("CONSOLE_URL") ?? "https://getbedrock.ca/dashboard/";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Deliberately loose. This is a business card, not an identity document: the
// job is to reject an obvious mistype, not to litigate what an address may
// contain. Anything stricter starts refusing real addresses.
const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const clip = (v: unknown, n: number) =>
  typeof v === "string" ? v.trim().slice(0, n) : "";

async function body(req: Request) {
  try { return await req.json(); } catch { return null; }
}

/* Telling the owner is the point of the feature — a lead nobody hears about
   until they next open the console is a lead that went cold. Never fatal: the
   capture is already saved, and an email that fails must not tell the viewer
   their details were rejected. */
async function notify(to: string, deckTitle: string, lead: Record<string, string>) {
  const token = Deno.env.get("POSTMARK_TOKEN");
  const from = Deno.env.get("POSTMARK_FROM");
  if (!token || !from || !to) return;
  const line = (k: string, v: string) => (v ? `${k}: ${v}\n` : "");
  const text =
    `${lead.name} opened "${deckTitle}".\n\n` +
    line("Name", lead.name) + line("Email", lead.email) +
    line("Company", lead.company) + line("Came from", lead.referrer_host) +
    `\nEvery lead on this deck: ${CONSOLE_URL}\n`;
  try {
    await fetch(POSTMARK, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Postmark-Server-Token": token },
      body: JSON.stringify({
        From: from, To: to, ReplyTo: lead.email,
        Subject: `${lead.name} opened ${deckTitle}`,
        TextBody: text,
        MessageStream: Deno.env.get("POSTMARK_STREAM") ?? "outbound",
      }),
    });
  } catch { /* the lead is saved; the email is a courtesy */ }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const b = await body(req);
  if (!b?.t) return json({ error: "missing token" }, 400);

  const name = clip(b.name, 120);
  const email = clip(b.email, 200).toLowerCase();
  const company = clip(b.company, 160);
  if (!name || !looksLikeEmail(email)) {
    return json({ error: "a name and a valid email are required" }, 400);
  }

  const { data: link } = await db
    .from("share_links")
    .select("id, deck_id, revoked_at, expires_at")
    .eq("token", b.t)
    .maybeSingle();
  const dead = !link || link.revoked_at ||
    (link.expires_at && new Date(link.expires_at) < new Date());
  // Same answer for a wrong token as for a revoked one, as everywhere else: a
  // gate that distinguishes them is a gate that enumerates decks.
  if (dead) return json({ error: "This link is not available." }, 404);

  const ref = splitReferrer(typeof b.ref === "string" ? b.ref : null);
  const { error } = await db.from("deck_leads").insert({
    deck_id: link.deck_id,
    share_link_id: link.id,
    name, email, company: company || null,
    referrer_host: ref.host, referrer_path: ref.path,
  });
  if (error) return json({ error: "could not record that" }, 500);

  // Who to tell: the deck's org owner. Read after the insert so a mail problem
  // can never cost the capture.
  const { data: deck } = await db
    .from("decks").select("title, project_id").eq("id", link.deck_id).maybeSingle();
  if (deck) {
    const { data: proj } = await db
      .from("projects").select("org_id").eq("id", deck.project_id).maybeSingle();
    if (proj) {
      const { data: owner } = await db
        .from("org_members").select("user_id")
        .eq("org_id", proj.org_id).eq("role", "owner").limit(1).maybeSingle();
      if (owner) {
        const { data: u } = await db.auth.admin.getUserById(owner.user_id);
        const to = u?.user?.email;
        if (to) {
          await notify(to, deck.title ?? "your deck",
            { name, email, company, referrer_host: ref.host ?? "" });
        }
      }
    }
  }

  return json({ ok: true });
});
