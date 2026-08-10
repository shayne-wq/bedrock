// Shared HTTP helpers for the Bedrock edge functions.
//
// Both functions are called from arbitrary websites — the whole point of the
// embed is that a deck runs inside someone else's WordPress page — so CORS is
// wide open by necessity. That makes the token the only boundary, which is why
// neither function ever hands back anything the token did not entitle.

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export function json(body: unknown, status = 200, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", ...extra },
  });
}

export function preflight(req: Request) {
  return req.method === "OPTIONS" ? new Response("ok", { headers: CORS }) : null;
}

/** Deterministic passcode hash, salted by the share token so the same passcode
 *  on two links does not produce the same digest. Not a password store: this
 *  gates a marketing deck, and the token itself is the real secret. */
export async function passcodeHash(token: string, passcode: string) {
  const data = new TextEncoder().encode(`${token}:${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare, so a passcode cannot be recovered a byte at a time. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Split a referrer into host and path, dropping the query string.
 *
 *  "Which page is this deck on" is a question IR teams genuinely need answered.
 *  "Who is this person" is not one we want to be able to answer, and query
 *  strings are where tracking parameters and, occasionally, email addresses
 *  live — so they are discarded here rather than filtered later. */
export function splitReferrer(ref: string | null) {
  if (!ref) return { host: null, path: null };
  try {
    const u = new URL(ref);
    return { host: u.hostname.toLowerCase(), path: u.pathname.slice(0, 300) };
  } catch {
    return { host: null, path: null };
  }
}

/** Coarse device + browser family. Deliberately coarse: a full UA string is a
 *  fingerprinting surface, and "mobile / Safari" answers the only question
 *  anyone asks of it. */
export function uaFamily(ua: string | null) {
  const s = (ua || "").toLowerCase();
  const device = /ipad|tablet/.test(s)
    ? "tablet"
    : /mobi|iphone|android/.test(s)
    ? "mobile"
    : "desktop";
  const browser = /edg\//.test(s)
    ? "Edge"
    : /opr\/|opera/.test(s)
    ? "Opera"
    : /chrome|crios/.test(s)
    ? "Chrome"
    : /firefox|fxios/.test(s)
    ? "Firefox"
    : /safari/.test(s)
    ? "Safari"
    : "Other";
  return { device, browser };
}

/** Country from the edge, never the address it was derived from. */
export function country(req: Request) {
  return (
    req.headers.get("cf-ipcountry") ||
    req.headers.get("x-vercel-ip-country") ||
    req.headers.get("x-country-code") ||
    null
  );
}
