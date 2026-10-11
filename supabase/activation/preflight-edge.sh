#!/usr/bin/env bash
# KAZA F05 — contrôle de disponibilité de la nouvelle fonction Edge AVANT activation.
# Ne modifie aucune donnée. Variables d'environnement (jamais affichées) :
#   KAZA_F05_FUNCTION_URL     URL complète .../functions/v1/validate-file-upload[-v2]
#   KAZA_F05_WEBHOOK_SECRET   (optionnel) secret dédié : prouve qu'il correspond à celui de la fonction
set -u
url="${KAZA_F05_FUNCTION_URL:-}"
[ -n "$url" ] || { echo "KAZA_F05_FUNCTION_URL requis" >&2; exit 2; }
case "$url" in https://*.supabase.co/functions/v1/validate-file-upload|https://*.supabase.co/functions/v1/validate-file-upload-v2) ;; *) echo "URL inattendue" >&2; exit 2;; esac

fail=0
probe() { curl -sS -m 20 -o /tmp/f05_probe_body -w '%{http_code}' -X POST "$@" "$url" -H 'Content-Type: application/json' -d '{"type":"PING"}'; }

code=$(probe) ; body=$(cat /tmp/f05_probe_body)
if [ "$code" = 401 ] && printf '%s' "$body" | grep -q '"reason":"unauthorized"'; then echo "OK   sans secret -> 401 du handler (verify_jwt=false, secret exigé)"
else echo "FAIL sans secret : HTTP $code (attendu 401 du handler ; 404=non déployée, 401 JWT=verify_jwt actif, 503=secret non configuré)"; fail=1; fi

code=$(probe -H 'x-storage-validation-secret: wrong-secret-wrong-secret-wrong-secret') ; body=$(cat /tmp/f05_probe_body)
if [ "$code" = 401 ]; then echo "OK   mauvais secret -> 401"; else echo "FAIL mauvais secret : HTTP $code"; fail=1; fi

if [ -n "${KAZA_F05_WEBHOOK_SECRET:-}" ]; then
  code=$(probe -H "x-storage-validation-secret: ${KAZA_F05_WEBHOOK_SECRET}"); body=$(cat /tmp/f05_probe_body)
  if [ "$code" = 400 ] && printf '%s' "$body" | grep -q 'invalid webhook event'; then echo "OK   bon secret -> 400 'invalid webhook event' (aucune donnée touchée)"
  else echo "FAIL bon secret : HTTP $code (secret Vault ≠ secret de la fonction ?)"; fail=1; fi
else echo "SKIP secret valide non fourni"; fi
rm -f /tmp/f05_probe_body
exit $fail
