#!/usr/bin/env bash
# Publica as funcoes do robo de WhatsApp.
#
# Uso:  bash subir-bot.sh
#
# O --no-verify-jwt e SO do webhook: quem chama ele e a Evolution, que nao tem
# token pra mandar. O send-whatsapp PRECISA da verificacao ligada, porque ele
# confere o usuario logado no painel — publicar ele com --no-verify-jwt abre a
# funcao pra qualquer um mandar mensagem pelas lojas.
set -e

REF=ycytrsqdvrviihkqfvno

echo "== whatsapp-webhook (robo que fala com o cliente)"
npx supabase functions deploy whatsapp-webhook --no-verify-jwt --project-ref "$REF"

# Descomente a linha abaixo quando mexer no envio pelo painel.
# echo "== send-whatsapp (mensagem que a loja manda pelo painel)"
# npx supabase functions deploy send-whatsapp --project-ref "$REF"

echo
echo "Pronto."
