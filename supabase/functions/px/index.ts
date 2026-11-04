// Bedrock — outbound email open pixel.
//
// GET /functions/v1/px?t=<share token>  ->  1x1 transparent GIF, always.
//
// The image is returned whatever happens: a tracking pixel that can fail to
// render is a broken image in someone's email, which is worse than no data.
// Logging is best-effort and never blocks the response.
//
// WHAT IS NOT STORED: no IP address, no recipient address, no full user-agent.
// The share token already says which company the message went to, and the CRM
// holds the person. Adding either here would widen the record for no gain.
//
// WHAT AN OPEN ACTUALLY MEANS — the part that matters when reading this data:
//   • Mail security filters (Defender, Mimecast, Proofpoint) fetch every
//     remote image on DELIVERY. They are indistinguishable from a reader
//     except by timing, which is why `opened_at` is kept to the millisecond.
//   • Apple Mail Privacy Protection pre-fetches for EVERY recipient whether
//     or not the message is opened. Apple opens are therefore near-worthless
//     as a signal and are labelled so the reader can discount them.
//   • Google's image proxy fetches when the message is actually OPENED, so a
//     GoogleImageProxy hit is the one genuinely meaningful signal here.
// This function records the raw fetch and labels the agent; it does not
// pretend to know whether a human was present.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// 1x1 transparent GIF.
const GIF = Uint8Array.from(atob(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
), (c) => c.charCodeAt(0));

function pixel() {
  return new Response(GIF, {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(GIF.length),
      // Caches would otherwise swallow the second and later opens.
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "pragma": "no-cache",
    },
  });
}

function agent(ua: string) {
  const u = (ua || "").toLowerCase();
  if (u.includes("googleimageproxy")) return { proxy: "google", family: "Gmail proxy" };
  if (u.includes("applemail") || u.includes("apple mail")) return { proxy: "apple", family: "Apple Mail" };
  // Apple's MPP relay presents as a plain Safari/macOS string with no device
  // hints; it cannot be told apart from a real Safari here, so it is not
  // guessed at. Timing in the sync does that job instead.
  if (u.includes("outlook") || u.includes("microsoft") ||
      u.includes("bingpreview") || u.includes("skypeuripreview"))
    return { proxy: "microsoft", family: "Outlook/Microsoft" };
  if (u.includes("proofpoint") || u.includes("mimecast") || u.includes("barracuda") ||
      u.includes("symantec") || u.includes("forcepoint"))
    return { proxy: "filter", family: "Mail security filter" };
  if (u.includes("thunderbird")) return { proxy: null, family: "Thunderbird" };
  if (u.includes("chrome")) return { proxy: null, family: "Chrome" };
  if (u.includes("safari")) return { proxy: null, family: "Safari" };
  if (u.includes("firefox")) return { proxy: null, family: "Firefox" };
  return { proxy: null, family: "other" };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") || "";

  // A browser or client asking not to be tracked is not. Answered with the
  // image so nothing looks broken, and nothing is written.
  const gpc = req.headers.get("sec-gpc") === "1" || req.headers.get("dnt") === "1";
  if (!token || gpc) return pixel();

  try {
    const { data: link } = await db
      .from("share_links")
      .select("id, revoked_at")
      .eq("token", token)
      .maybeSingle();

    if (link && !link.revoked_at) {
      const a = agent(req.headers.get("user-agent") || "");
      await db.from("email_opens").insert({
        share_link_id: link.id,
        ua_family: a.family,
        proxy: a.proxy,
      });
    }
  } catch (_e) {
    // Never let a logging failure become a broken image.
  }
  return pixel();
});
