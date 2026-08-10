// Bedrock — boot failure reports.
//
// POST /functions/v1/diag
//
// Exists because three rounds of mobile fixes produced no change in symptom
// and no diagnostic ever reached the person fixing it. Asking someone to read
// a stack off a phone and retype it does not work, and neither does a button
// they have to find and press.
//
// Fires only on failure. Never on a successful load. Carries what is needed to
// reproduce a rendering failure and nothing else — no identifier, no cookie,
// no IP (this never reads one), no deck contents. Writes on the service role
// because RLS denies anon everything, and returns nothing readable.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { CORS, json, preflight } from "../_shared/http.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Anything a page can be tricked into sending is untrusted, and a report is
// written unauthenticated. Cap every field so this cannot be used as free
// storage, and cap the whole body before parsing it.
const cap = (v: unknown, n: number) =>
  typeof v === "string" ? v.slice(0, n) : v == null ? null : String(v).slice(0, n);

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const raw = await req.text();
  if (raw.length > 8000) return json({ ok: true }, 200, CORS);   // quietly drop

  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); } catch { return json({ ok: true }, 200, CORS); }

  await db.from("diag_reports").insert({
    phase: cap(b.phase, 120),
    message: cap(b.message, 500),
    stack: cap(b.stack, 3000),
    ua: cap(b.ua, 400),
    screen: cap(b.screen, 60),
    dpr: Number(b.dpr) || null,
    webgl: cap(b.webgl, 40),
    online: typeof b.online === "boolean" ? b.online : null,
    memory_gb: Number(b.memory) || null,
    href: cap(b.href, 500),
    build: cap(b.build, 60),
  });

  // Always 200, always empty. A report that fails must not produce a second
  // error on a page that is already broken, and the response must not tell a
  // caller anything about what was stored.
  return json({ ok: true }, 200, CORS);
});
