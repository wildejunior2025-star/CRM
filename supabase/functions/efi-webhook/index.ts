// =====================================================================
// efi-webhook
// ---------------------------------------------------------------------
// A Efí exige que a CHAVE PIX PAGADORA tenha um webhook cadastrado pra
// aceitar pagamento de copia-e-cola (senão devolve 400 "A chave informada
// não tem webhook cadastrado"). Este endpoint existe só pra satisfazer
// essa exigência: responde 200 pra qualquer POST que a Efí mandar.
//
// Deploy com --no-verify-jwt (a Efí não manda Authorization).
// A Efí acrescenta "/pix" na URL cadastrada — por isso responde em
// qualquer subcaminho.
// =====================================================================

Deno.serve(async (req) => {
  // Não processa nada: só confirma o recebimento. Se um dia a gente quiser
  // conciliar os Pix recebidos, é aqui que o payload chega.
  try { await req.text() } catch (_e) { /* corpo vazio, tudo bem */ }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})
