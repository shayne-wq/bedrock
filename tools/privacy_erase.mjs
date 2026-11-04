#!/usr/bin/env node
// Bedrock — carry out a verified privacy deletion request.
//
// The privacy policy promises deletion within 30 days of a verified request. The
// console cannot delete an account or an organization (orgs has no DELETE policy
// on purpose), so this is the path, run by an operator with the service role key.
//
//   node tools/privacy_erase.mjs <API_URL> <SERVICE_ROLE_KEY> --email person@company.com [--apply]
//   node tools/privacy_erase.mjs <API_URL> <SERVICE_ROLE_KEY> --org <org uuid> [--apply]
//
// Dry run unless --apply. Always read the plan first.
//
// --email  deletes the auth user, their memberships (cascade) and any invitations
//          addressed to them. An org they alone own is erased too when nobody else
//          is in it; if others are, it stops and says so — ownership has to be
//          transferred or the org closed first, never decided by a script.
// --org    deletes every stored file under <org>/ through the Storage API (SQL
//          deletes are refused by storage), then the org row, which cascades to
//          members, invites, projects, datasets, decks, share links and analytics.
//
// Backups: Supabase keeps daily backups for 7 days, so erased data is gone from
// them within a week. The policy says so.

const [API, KEY, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };
const APPLY = rest.includes("--apply");
const EMAIL = flag("--email")?.toLowerCase();
const ORG = flag("--org");

if (!API || !KEY || (!EMAIL && !ORG)) {
  console.error("usage: privacy_erase.mjs <API_URL> <SERVICE_ROLE_KEY> (--email <addr> | --org <uuid>) [--apply]");
  process.exit(2);
}

const H = { apikey: KEY, "content-type": "application/json" };
// Legacy keys are JWTs and go in Authorization too; sb_secret_ keys must not.
if (KEY.startsWith("eyJ")) H.authorization = `Bearer ${KEY}`;

async function call(method, path, body) {
  const r = await fetch(`${API.replace(/\/$/, "")}${path}`, {
    method, headers: { ...H, prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const say = (s) => console.log((APPLY ? "" : "[dry run] ") + s);

async function listFiles(prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await call("POST", "/storage/v1/object/list/artifacts",
      { prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    for (const o of page) {
      const path = `${prefix}${o.name}`;
      if (o.id) out.push(path);
      else out.push(...await listFiles(`${path}/`));   // a folder
    }
    if (page.length < 1000) return out;
  }
}

async function eraseOrg(orgId) {
  const [org] = await call("GET", `/rest/v1/orgs?id=eq.${orgId}&select=id,name`);
  if (!org) throw new Error(`no org ${orgId}`);
  const files = await listFiles(`${orgId}/`);
  say(`org "${org.name}" (${orgId}): ${files.length} stored file(s), then the org row and everything under it`);
  if (!APPLY) return;
  for (let i = 0; i < files.length; i += 100) {
    await call("DELETE", "/storage/v1/object/artifacts", { prefixes: files.slice(i, i + 100) });
  }
  const left = await listFiles(`${orgId}/`);
  if (left.length) throw new Error(`${left.length} file(s) survived deletion; org row NOT deleted`);
  await call("DELETE", `/rest/v1/orgs?id=eq.${orgId}`);
  say(`org ${orgId} erased`);
}

async function findUser(email) {
  for (let page = 1; ; page++) {
    const { users } = await call("GET", `/auth/v1/admin/users?page=${page}&per_page=200`);
    const hit = users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
}

async function eraseEmail(email) {
  const invites = await call("GET", `/rest/v1/invites?email=ilike.${encodeURIComponent(email)}&select=id,org_id`);
  say(`${invites.length} invitation(s) addressed to ${email}`);

  const user = await findUser(email);
  if (!user) say("no account with that email");

  const orgsToErase = [];
  if (user) {
    const mine = await call("GET", `/rest/v1/org_members?user_id=eq.${user.id}&select=org_id,role`);
    for (const m of mine) {
      if (m.role !== "owner") continue;
      const all = await call("GET", `/rest/v1/org_members?org_id=eq.${m.org_id}&select=user_id,role`);
      const otherOwners = all.filter((x) => x.user_id !== user.id && x.role === "owner");
      const others = all.filter((x) => x.user_id !== user.id);
      if (otherOwners.length) continue;                 // org survives under its other owner
      if (others.length) {
        throw new Error(`${email} is the only owner of org ${m.org_id}, which has ${others.length} other member(s). ` +
          "Transfer ownership or close the org first. Nothing was deleted.");
      }
      orgsToErase.push(m.org_id);
    }
    say(`account ${user.id}: ${mine.length} membership(s); ${orgsToErase.length} org(s) they alone belong to will be erased`);
  }

  for (const id of orgsToErase) await eraseOrg(id);
  if (!APPLY) return;
  if (invites.length) await call("DELETE", `/rest/v1/invites?email=ilike.${encodeURIComponent(email)}`);
  if (user) await call("DELETE", `/auth/v1/admin/users/${user.id}`);
  say(`${email} erased`);
}

try {
  if (ORG) await eraseOrg(ORG);
  else await eraseEmail(EMAIL);
  if (!APPLY) console.log("\nNothing was changed. Re-run with --apply to carry this out.");
} catch (e) {
  console.error(`stopped: ${e.message}`);
  process.exit(1);
}
