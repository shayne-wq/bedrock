#!/usr/bin/env bash
# Orebody — the tenure lookup, against the live BC register.
#
#   tools/verify_tenure.sh <functions base url> <anon key> [user jwt]
#
# The failure this guards is the axis order. WFS 2.0 with an EPSG:4326 bbox is
# LATITUDE FIRST, and getting it backwards does not error — it returns an empty
# collection from the ocean off Somalia, which the console would render as
# "this property has no neighbours". So the test asserts we get back the
# holders we know are there, not merely that the call succeeded.
set -uo pipefail
BASE="${1:?usage: verify_tenure.sh <base> <anon key> [jwt]}"
ANON="${2:?}"
JWT="${3:-$ANON}"
pass=0; fail=0
ok(){ if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1 ${3:-}"; fi }

# Elk Gold, Nicola BC.
BBOX="-120.40,49.80,-120.25,49.90"
OUT=$(curl -s --max-time 90 -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  "$BASE/tenure?bbox=$BBOX")
N=$(printf '%s' "$OUT" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d.get('features',[])))" 2>/dev/null || echo 0)
ok "returns tenure for a known property" "$([ "${N:-0}" -gt 5 ] && echo 1 || echo 0)" "got $N features"
HAS=$(printf '%s' "$OUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
own={(f.get('properties') or {}).get('OWNER_NAME','') for f in d.get('features',[])}
print(1 if any('ELK GOLD' in o for o in own) else 0)" 2>/dev/null || echo 0)
ok "the axis order is right (the issuer is in the window)" "$HAS"
SYN=$(printf '%s' "$OUT" | python3 -c "import sys,json;print(0 if json.load(sys.stdin).get('synthetic') else 1)" 2>/dev/null || echo 0)
ok "not flagged synthetic — this is a real register" "$SYN"
ATT=$(printf '%s' "$OUT" | grep -c "Open Government Licence" || true)
ok "carries its licence attribution" "$([ "$ATT" -ge 1 ] && echo 1 || echo 0)"

BAD=$(curl -s --max-time 45 -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  "$BASE/tenure?bbox=-130,45,-110,60" | grep -c "too large" || true)
ok "refuses a province-sized window" "$([ "$BAD" -ge 1 ] && echo 1 || echo 0)"

INV=$(curl -s --max-time 45 -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  "$BASE/tenure?bbox=1,2,3" | grep -c "west,south" || true)
ok "rejects a malformed bbox" "$([ "$INV" -ge 1 ] && echo 1 || echo 0)"

OTH=$(curl -s --max-time 45 -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  "$BASE/tenure?bbox=$BBOX&jurisdiction=on" | grep -c "only wired up for British Columbia" || true)
ok "says plainly that other jurisdictions are not wired up" "$([ "$OTH" -ge 1 ] && echo 1 || echo 0)"

NOAUTH=$(curl -s --max-time 45 -o /dev/null -w "%{http_code}" "$BASE/tenure?bbox=$BBOX")
ok "not an open proxy" "$([ "$NOAUTH" = "401" ] && echo 1 || echo 0)" "got $NOAUTH"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
