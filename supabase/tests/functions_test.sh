#!/usr/bin/env bash
# Bedrock — edge function integration tests.
#
# Exercises the two things an anonymous viewer can reach: reading a deck with a
# share token, and reporting analytics. Every failure mode of the token is
# asserted, because the token is the only boundary those endpoints have.
#
# Requires a running local stack and `supabase functions serve`.
#   bash supabase/tests/functions_test.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:54421/functions/v1}"
PSQL=(docker exec -i supabase_db_orebody psql -U postgres -d postgres -q -t -A)
TOK="testtoken123456789012345678901234"
DECK="aaaaaaaa-0000-0000-0000-000000000003"
pass=0; fail=0

ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n     %s\n' "$1" "$2"; }
check(){ # name expected actual
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}
sql()  { printf '%s' "$1" | "${PSQL[@]}" 2>/dev/null | tr -d '[:space:]'; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== deck: happy path"
BODY=$(curl -s "$BASE/deck?t=$TOK")
check "200 for a live token"      "200" "$(code "$BASE/deck?t=$TOK")"
check "returns the deck title"    "Siwash North" "$(jq -r .deck.title <<<"$BODY")"
check "returns both chapters"     "2" "$(jq -r '.chapters|length' <<<"$BODY")"
check "chapters are ordered"      "Opening" "$(jq -r '.chapters[0].title' <<<"$BODY")"
check "carries project metadata"  "Elk Gold" "$(jq -r .project.name <<<"$BODY")"
check "flags fabricated data"     "drills" "$(jq -r '.fabricated[0]' <<<"$BODY")"
check "synthetic note travels"    "Fabricated demo holes" \
      "$(jq -r '.assets[0].synthetic_note' <<<"$BODY")"
# The tenant must not leak: a viewer learns nothing about who owns the deck.
check "no org id in the payload"  "" "$(jq -r '..|objects|.org_id//empty' <<<"$BODY" | head -1)"
# ...including through provenance. Storage paths begin with the org UUID, so a
# surviving *_path key is the same leak through a second door. The seed row
# carries a buckets_path precisely so this cannot pass vacuously.
check "provenance keeps generator" "tools/make_synthetic_drills.py" \
      "$(jq -r '.assets[0].provenance.generator' <<<"$BODY")"
check "provenance drops paths"    "" \
      "$(jq -r '.assets[0].provenance|to_entries|map(select(.key|endswith("_path")))|.[0].key//empty' <<<"$BODY")"
check "no storage path anywhere"  "" \
      "$(jq -r '..|strings|select(test("aaaaaaaa-0000-0000-0000-000000000001"))' <<<"$BODY" | head -1)"
# The rollups have to be reachable, not merely named: the readout sums buckets,
# never pixels. The key must exist even when the object does not (signing a
# missing object yields null rather than throwing).
check "buckets url is present"    "true" \
      "$(jq -r '.assets[0]|has("buckets_url")' <<<"$BODY")"

echo "== deck: token failure modes"
check "unknown token is 404"      "404" "$(code "$BASE/deck?t=nope")"
check "missing token is 400"      "400" "$(code "$BASE/deck")"
check "same message for unknown"  "This link is not available." \
      "$(curl -s "$BASE/deck?t=nope" | jq -r .error)"

sql "update share_links set revoked_at=now() where token='$TOK';" >/dev/null
check "revoked is 404"            "404" "$(code "$BASE/deck?t=$TOK")"
check "revoked is indistinguishable" "This link is not available." \
      "$(curl -s "$BASE/deck?t=$TOK" | jq -r .error)"
sql "update share_links set revoked_at=null where token='$TOK';" >/dev/null

sql "update share_links set expires_at=now()-interval '1 day' where token='$TOK';" >/dev/null
check "expired is 404"            "404" "$(code "$BASE/deck?t=$TOK")"
sql "update share_links set expires_at=null where token='$TOK';" >/dev/null

echo "== deck: passcode"
# sha256("<token>:hunter2")
HASH=$(printf '%s' "$TOK:hunter2" | shasum -a 256 | cut -d' ' -f1)
sql "update share_links set passcode_hash='$HASH' where token='$TOK';" >/dev/null
check "no passcode is 401"        "401" "$(code "$BASE/deck?t=$TOK")"
check "signals passcode needed"   "true" \
      "$(curl -s "$BASE/deck?t=$TOK" | jq -r .needs_passcode)"
check "wrong passcode is 401"     "401" "$(code "$BASE/deck?t=$TOK&passcode=wrong")"
check "right passcode is 200"     "200" "$(code "$BASE/deck?t=$TOK&passcode=hunter2")"
sql "update share_links set passcode_hash=null where token='$TOK';" >/dev/null

echo "== deck: embedding"
sql "update share_links set allow_embed=false where token='$TOK';" >/dev/null
check "embed blocked when disallowed" "403" "$(code "$BASE/deck?t=$TOK&embed=1")"
check "direct view still works"       "200" "$(code "$BASE/deck?t=$TOK")"
sql "update share_links set allow_embed=true, domains='{ir.example.com}' where token='$TOK';" >/dev/null
check "wrong domain refused"      "403" \
      "$(code "$BASE/deck?t=$TOK&embed=1&ref=https://evil.example.net/page")"
check "listed domain allowed"     "200" \
      "$(code "$BASE/deck?t=$TOK&embed=1&ref=https://ir.example.com/projects")"
check "subdomain of listed allowed" "200" \
      "$(code "$BASE/deck?t=$TOK&embed=1&ref=https://www.ir.example.com/x")"
sql "update share_links set domains='{}' where token='$TOK';" >/dev/null

echo "== track: sessions"
sql "delete from view_events; delete from view_sessions;" >/dev/null
R1=$(curl -s -X POST "$BASE/track" -H 'content-type: application/json' -d "{
  \"t\":\"$TOK\",\"embed\":true,\"ref\":\"https://ir.example.com/elk?utm_source=x\",
  \"watch_ms\":5000,\"chapters_seen\":1,
  \"events\":[{\"kind\":\"open\",\"t_ms\":0},{\"kind\":\"chapter\",\"t_ms\":0,\"chapter_ord\":0,\"dwell_ms\":5000}]}")
SID=$(jq -r .s <<<"$R1")
check "mints a session id"        "36" "${#SID}"
check "one session exists"        "1" "$(sql 'select count(*) from view_sessions;')"
check "two events stored"         "2" "$(sql 'select count(*) from view_events;')"
check "records the embed flag"    "t" "$(sql 'select is_embed from view_sessions;')"
check "records referrer host"     "ir.example.com" "$(sql 'select referrer_host from view_sessions;')"
# The query string is where tracking parameters and stray PII live.
check "drops the query string"    "/elk" "$(sql 'select referrer_path from view_sessions;')"
check "stores no ip column"       "0" \
      "$(sql "select count(*) from information_schema.columns where table_name='view_sessions' and column_name ilike '%ip%';")"

echo "== track: continuation"
curl -s -X POST "$BASE/track" -H 'content-type: application/json' -d "{
  \"t\":\"$TOK\",\"s\":\"$SID\",\"watch_ms\":42000,\"chapters_seen\":2,\"completed\":true,
  \"events\":[{\"kind\":\"chapter\",\"t_ms\":5000,\"chapter_ord\":1,\"dwell_ms\":37000}]}" >/dev/null
check "reuses the session"        "1" "$(sql 'select count(*) from view_sessions;')"
check "watch time advanced"       "42000" "$(sql 'select watch_ms from view_sessions;')"
check "completion recorded"       "t" "$(sql 'select completed from view_sessions;')"

# A late or retried beacon must not walk the counters backwards.
curl -s -X POST "$BASE/track" -H 'content-type: application/json' \
  -d "{\"t\":\"$TOK\",\"s\":\"$SID\",\"watch_ms\":1000,\"chapters_seen\":0,\"completed\":false}" >/dev/null
check "counters are monotonic"    "42000" "$(sql 'select watch_ms from view_sessions;')"
check "completion is sticky"      "t" "$(sql 'select completed from view_sessions;')"

echo "== track: hostile input"
curl -s -X POST "$BASE/track" -H 'content-type: application/json' -d "{
  \"t\":\"$TOK\",\"s\":\"$SID\",\"events\":[{\"kind\":\"DROP TABLE\",\"t_ms\":0},
  {\"kind\":\"chapter\",\"t_ms\":-5,\"chapter_ord\":2,\"dwell_ms\":999999999}]}" >/dev/null
check "unknown event kind rejected" "0" "$(sql "select count(*) from view_events where kind='DROP TABLE';")"
check "negative time clamped"     "0" "$(sql 'select min(t_ms) from view_events;')"
check "absurd dwell clamped"      "21600000" "$(sql 'select max(dwell_ms) from view_events;')"

# The deck a session belongs to comes from the token, never the request body.
curl -s -X POST "$BASE/track" -H 'content-type: application/json' \
  -d "{\"t\":\"$TOK\",\"s\":\"$SID\",\"deck_id\":\"00000000-0000-0000-0000-000000000999\",
       \"events\":[{\"kind\":\"open\",\"t_ms\":1}]}" >/dev/null
check "client cannot choose deck" "0" \
      "$(sql "select count(*) from view_events where deck_id<>'$DECK';")"

# A session id from a different deck must be refused, not adopted.
OTHER=$(sql "insert into decks (project_id,title) values ('aaaaaaaa-0000-0000-0000-000000000002','Other') returning id;")
OSID=$(sql "insert into view_sessions (deck_id) values ('$OTHER') returning id;")
curl -s -X POST "$BASE/track" -H 'content-type: application/json' \
  -d "{\"t\":\"$TOK\",\"s\":\"$OSID\",\"watch_ms\":9999}" >/dev/null
check "foreign session not adopted" "0" "$(sql "select watch_ms from view_sessions where id='$OSID';")"

echo "== track: dead links stay quiet"
sql "update share_links set revoked_at=now() where token='$TOK';" >/dev/null
check "revoked link still 200s"   "200" \
      "$(code -X POST "$BASE/track" -H 'content-type: application/json' -d "{\"t\":\"$TOK\"}")"
check "but drops the data"        "true" \
      "$(curl -s -X POST "$BASE/track" -H 'content-type: application/json' -d "{\"t\":\"$TOK\"}" | jq -r .dropped)"
sql "update share_links set revoked_at=null where token='$TOK';" >/dev/null

echo "== CORS (the deck runs on other people's websites)"
check "preflight allowed"         "*" \
      "$(curl -s -o /dev/null -D - -X OPTIONS "$BASE/track" | grep -i 'access-control-allow-origin' | tr -d '\r' | awk '{print $2}')"

echo
echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
