#!/usr/bin/env bash
# EU4 Web Map smoke test — tüm uçtan uca doğrulama.
# Container içinden çalıştırılmalı (backend :8000, vite :5173 çalışıyor olmalı).

set -euo pipefail

API="${API:-http://localhost:8000}"
WEB="${WEB:-http://localhost:5173}"
DB="${DB:-/workspace/data/eu4.db}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# 1) SQLite sayıları
cc=$(sqlite3 "$DB" "SELECT COUNT(*) FROM countries;")
[ "$cc" -gt 500 ] || fail "countries=$cc (>500 beklenir)"
pass "countries=$cc"

pc=$(sqlite3 "$DB" "SELECT COUNT(*) FROM provinces;")
[ "$pc" -gt 3000 ] || fail "provinces=$pc (>3000 beklenir)"
pass "provinces=$pc"

rc=$(sqlite3 "$DB" "SELECT COUNT(*) FROM rulers;")
[ "$rc" -gt 1000 ] || fail "rulers=$rc (>1000 beklenir)"
pass "rulers=$rc"

# 2) Country endpoint — Ottoman
r=$(curl -fsS "$API/api/countries/TUR")
echo "$r" | grep -qi "Ottoman" || fail "TUR yanıtında Ottoman yok: $r"
pass "GET /countries/TUR içerir Ottoman"

# 3) Rulers at 1451-02-03 → Mehmed II Fatih
r=$(curl -fsS "$API/api/countries/TUR/rulers?at=1451-02-03")
echo "$r" | grep -q "Mehmed II Fatih" || fail "Mehmed II Fatih yok: $r"
pass "rulers@1451-02-03 Mehmed II Fatih"

# 4) Province 151 history — 1453.5.29 owner=TUR
r=$(curl -fsS "$API/api/provinces/151/history")
echo "$r" | grep -q "1453-05-29" || fail "151 history 1453-05-29 yok"
echo "$r" | grep -q "TUR" || fail "151 history TUR yok"
pass "province 151 history 1453-05-29 TUR"

# 5) Vite frontend — 200 + Cinzel referansı
r=$(curl -fsS "$WEB/")
echo "$r" | grep -q "Cinzel" || fail "HTML'de Cinzel yok"
pass "GET / içerir Cinzel"

# 6) Custom notes round-trip
nid=$(curl -fsS -X POST "$API/api/custom/countries/TUR/notes" \
  -H 'Content-Type: application/json' \
  -d '{"text":"smoke test notu"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
[ -n "$nid" ] || fail "note id dönmedi"
r=$(curl -fsS "$API/api/custom/countries/TUR/notes")
echo "$r" | grep -q "smoke test notu" || fail "note listede yok"
curl -fsS -X DELETE "$API/api/custom/countries/TUR/notes/$nid" >/dev/null
pass "custom notes round-trip (id=$nid)"

echo ""
echo "=== Tüm smoke testler OK ==="
