#!/usr/bin/env bash
# Sobe a nova versao do app Impressora FWC pro bucket "downloads" do Supabase.
# Le a chave service_role do .env (SUPABASE_SERVICE_ROLE_KEY) — nunca commitar.
# Uso: bash print-agent/subir-impressora.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# carrega o .env (tira aspas e CR do Windows)
KEY="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' .env | head -1 | cut -d= -f2- | sed 's/\r$//; s/^"//; s/"$//; s/^'\''//; s/'\''$//')"
if [ -z "${KEY:-}" ]; then
  echo "ERRO: falta SUPABASE_SERVICE_ROLE_KEY no .env"
  exit 1
fi

URL="https://ycytrsqdvrviihkqfvno.supabase.co/storage/v1/object/downloads"
EXE="print-agent/dist/ImpressoraFWC.exe"
VER="print-agent/dist/impressora-version.json"

echo "==> Subindo o .exe ($(du -h "$EXE" | cut -f1))..."
curl -sS -X POST "$URL/ImpressoraFWC.exe" \
  -H "Authorization: Bearer $KEY" \
  -H "x-upsert: true" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$EXE" ; echo

echo "==> Subindo o version.json (depois do exe, pra ninguem baixar exe velho)..."
curl -sS -X POST "$URL/impressora-version.json" \
  -H "Authorization: Bearer $KEY" \
  -H "x-upsert: true" \
  -H "Content-Type: application/json" \
  --data-binary "@$VER" ; echo

echo "==> Conferindo a versao publicada:"
curl -sS "https://ycytrsqdvrviihkqfvno.supabase.co/storage/v1/object/public/downloads/impressora-version.json?t=$(date +%s)" ; echo
echo "PRONTO. Os apps vao se atualizar sozinhos (checam a cada 3h e 20s apos ligar)."
