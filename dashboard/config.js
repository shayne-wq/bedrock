// Bedrock console — where the Supabase project lives.
//
// The anon key is meant to be public: it identifies the project, and every
// table is RLS-denied to it, so on its own it opens nothing. The service role
// key must NEVER appear here — it belongs only in edge function secrets.
//
// Fill these in after creating the project (see docs/BACKEND.md). A local
// override in localStorage wins, so development against `supabase start` does
// not require editing — or accidentally committing — this file.

const BAKED = {
  url: "https://czuaqwtngduvlisxonkh.supabase.co",
  anonKey: "sb_publishable_7Uv04ITIEFMNPFyiJgHD6g_INAhri9",
};

function stored() {
  try {
    // Renamed from "orebody.supabase" on 2026-08-10. Read the old key too:
    // losing this override does not fail loudly, it silently points a local
    // console at the production database.
    const raw = localStorage.getItem("bedrock.supabase") ||
                localStorage.getItem("orebody.supabase");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export const CONFIG = { ...BAKED, ...(stored() || {}) };
export const CONFIGURED = Boolean(CONFIG.url && CONFIG.anonKey);

/** Point the console at a different Supabase project from the console:
 *      bedrockUse("http://127.0.0.1:54421", "<anon key>")
 *  Used for local development and for pointing a staging build at staging. */
window.bedrockUse = (url, anonKey) => {
  localStorage.setItem("bedrock.supabase", JSON.stringify({ url, anonKey }));
  location.reload();
};
window.bedrockForget = () => {
  localStorage.removeItem("bedrock.supabase");
  location.reload();
};
