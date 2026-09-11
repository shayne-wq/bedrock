// Bedrock — send an invitation.
//
// The invitation itself is a row; this is the email that tells somebody it
// exists. Until now the console printed "forward them the link" and left the
// sending to a human, which meant most invitations were never sent.
//
// Runs on the CALLER'S JWT, not the service role. That is the whole security
// design: the function reads `invites` through RLS, so it can only see a row
// whose org the caller is an admin of, and there is no way to make it email an
// arbitrary address by guessing an id. A service-role version of this would be
// an open relay wearing our sender reputation.
//
// POST /functions/v1/invite  { "inviteId": "<uuid>" }
//   Authorization: Bearer <the signed-in user's access token>

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { json, preflight } from "../_shared/http.ts";
import { INVITE_HTML } from "../_shared/invite_email.ts";

const POSTMARK = "https://api.postmarkapp.com/email";

// Where the person is being sent. Set it per environment; the fallback is the
// address the console is actually served from today.
const CONSOLE_URL =
  Deno.env.get("CONSOLE_URL") ?? "https://getbedrock.ca/dashboard/";

const ROLE_SAYS: Record<string, string> = {
  client: "Accept the invitation to edit your deck — its slides, captions, camera framing and running order.",
  member: "Accept the invitation to view and help build the project's interactive resource models and investor decks.",
  admin: "Accept the invitation to build the project's decks and manage who else can reach them.",
  owner: "Accept the invitation to take ownership of the organisation.",
};
// "an Editor" vs "a Client" — the template has the article outside the bold.
const ARTICLE = (r: string) => /^[aeiou]/i.test(r) ? "an" : "a";
const TITLE = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = Deno.env.get("POSTMARK_TOKEN");
  const from = Deno.env.get("POSTMARK_FROM");
  // Say which one is missing. "Could not send" sends somebody to the dashboard
  // to check two settings when they only ever had to check one.
  if (!token || !from) {
    return json({
      error: "email is not configured",
      detail: !token && !from ? "POSTMARK_TOKEN and POSTMARK_FROM are unset"
            : !token ? "POSTMARK_TOKEN is unset" : "POSTMARK_FROM is unset",
    }, 501);
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "sign in first" }, 401);

  let inviteId = "";
  try { inviteId = (await req.json())?.inviteId ?? ""; }
  catch { return json({ error: "bad request body" }, 400); }
  if (!inviteId) return json({ error: "missing inviteId" }, 400);

  // The caller's own credentials. Every read below is subject to the same
  // policies the console is.
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } }, auth: { persistSession: false } },
  );

  const { data: invite } = await db
    .from("invites")
    .select("id, email, role, org_id, expires_at, accepted_at")
    .eq("id", inviteId)
    .maybeSingle();

  // Not found and not-allowed are the same answer on purpose: distinguishing
  // them turns this into a way to test whether an invitation id exists.
  if (!invite) return json({ error: "no such invitation" }, 404);
  if (invite.accepted_at) return json({ error: "already accepted" }, 409);

  const { data: org } = await db
    .from("orgs").select("name").eq("id", invite.org_id).maybeSingle();
  const orgName = org?.name ?? "a Bedrock organisation";

  const { data: me } = await db.auth.getUser();
  const inviter = me?.user?.email ?? "someone";

  const expires = new Date(invite.expires_at).toLocaleDateString("en-CA", {
    year: "numeric", month: "long", day: "numeric",
  });
  const note = ROLE_SAYS[invite.role] ?? "";

  // Plain text carries the whole message. The HTML is the same words with the
  // brand around them — an email that only works with images and CSS on is an
  // email that sometimes says nothing.
  const text = [
    `${inviter} has invited you to ${orgName} on Bedrock.`,
    "",
    note,
    "",
    `Sign in here with this address (${invite.email}) and the invitation`,
    "attaches itself automatically:",
    "",
    `  ${CONSOLE_URL}`,
    "",
    "There is no password. Bedrock emails you a link each time you sign in.",
    `This invitation expires on ${expires}.`,
    "",
    "If you were not expecting this, you can ignore it — nothing happens",
    "until you sign in.",
    "",
    "Bedrock",
  ].join("\n");

  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;" }[c]!));

  // The brand template, filled in. Tokens rather than a template engine so the
  // file stays diffable against what Claude Design exported.
  const html = INVITE_HTML
    .replaceAll("__INVITER__", esc(inviter))
    .replaceAll("__ORG__", esc(orgName))
    .replaceAll("__ROLE__", esc(TITLE(invite.role)))
    .replaceAll("__ROLE_ARTICLE__", ARTICLE(invite.role))
    .replaceAll("__ROLE_NOTE__", esc(note))
    .replaceAll("__EXPIRES__", esc(expires))
    .replaceAll("__URL__", esc(CONSOLE_URL));

  const res = await fetch(POSTMARK, {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": token,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      From: from,
      To: invite.email,
      Subject: `You have been invited to ${orgName} on Bedrock`,
      TextBody: text,
      HtmlBody: html,
      MessageStream: Deno.env.get("POSTMARK_STREAM") ?? "outbound",
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Postmark's own message is the useful one — an unconfirmed sender
    // signature and a bad token look identical from here otherwise.
    return json({ error: "postmark refused", detail: body?.Message ?? res.statusText,
                  code: body?.ErrorCode ?? null }, 502);
  }
  return json({ ok: true, to: invite.email, messageId: body?.MessageID ?? null });
});
