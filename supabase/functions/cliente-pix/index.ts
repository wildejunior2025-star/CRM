import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CLIENTE-PIX (mig 0149) — o freguês abre o link dele, vê o que deve e paga no PIX.
// Gera a cobrança na conta do Mercado Pago DA LOJA e devolve QR + copia e cola.
// Quem dá baixa é o mercadopago-webhook, quando o MP confirma.
//
// Diferença importante pro create-pix-payment (delivery): ali, loja sem MP conectado
// cai na conta central da plataforma. Aqui NÃO — é dinheiro do freguês pagando a
// dívida dele com a loja; se a loja não conectou o MP dela, a cobrança não existe.

const MP_CLIENT_ID     = Deno.env.get('MP_CLIENT_ID') ?? '736904729861760'
const MP_CLIENT_SECRET = Deno.env.get('MP_CLIENT_SECRET') ?? ''
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WEBHOOK_URL      = `${SUPABASE_URL}/functions/v1/mercadopago-webhook`

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// deno-lint-ignore no-explicit-any
type SB = any

// Token da loja, renovando pelo refresh_token se estiver perto de vencer.
async function tokenDaLoja(sb: SB, empresaId: string): Promise<string | null> {
  const { data: conta } = await sb.from('mercadopago_contas')
    .select('access_token, refresh_token, expires_at').eq('empresa_id', empresaId).maybeSingle()
  if (!conta?.access_token) return null

  const expMs = conta.expires_at ? new Date(conta.expires_at).getTime() : 0
  if (!expMs || expMs > Date.now() + 60_000 || !conta.refresh_token) return conta.access_token

  const r = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: conta.refresh_token,
    }),
  })
  const tk = await r.json()
  if (!r.ok || !tk.access_token) { console.error('MP refresh error:', JSON.stringify(tk)); return conta.access_token }
  await sb.from('mercadopago_contas').update({
    access_token:  tk.access_token,
    refresh_token: tk.refresh_token ?? conta.refresh_token,
    expires_at:    new Date(Date.now() + Number(tk.expires_in ?? 15552000) * 1000).toISOString(),
    updated_at:    new Date().toISOString(),
  }).eq('empresa_id', empresaId)
  return tk.access_token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { token, valor } = await req.json()
    if (!token) return json({ error: 'Link inválido.' }, 400)

    const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

    // ── Quem é o cliente e a loja dele ──
    const { data: cli } = await sb.from('clientes')
      .select('id, nome, telefone, empresa_id, empresas(nome, link_cliente_ativo)')
      .eq('token', token).maybeSingle()
    if (!cli) return json({ error: 'Link não encontrado.' }, 404)
    if (!cli.empresas?.link_cliente_ativo) return json({ error: 'A loja não está usando pedido por link agora.' }, 403)

    // ── Quanto ele deve (quem manda é o banco, não o que veio da tela) ──
    const { data: saldoRow } = await sb.from('clientes_saldo_fiado')
      .select('saldo_fiado').eq('cliente_id', cli.id).maybeSingle()
    const devendo = Math.round(Number(saldoRow?.saldo_fiado ?? 0) * 100) / 100
    if (devendo <= 0) return json({ error: 'Você não tem nada em aberto. 🙂' }, 400)

    // Valor pedido: default é tudo. Nunca deixa pagar mais do que deve (viraria
    // crédito solto que ninguém controla) nem menos que R$ 1 (mínimo prático do PIX).
    const pedido = Math.round(Number(valor ?? devendo) * 100) / 100
    if (!Number.isFinite(pedido) || pedido < 1) return json({ error: 'O valor mínimo é R$ 1,00.' }, 400)
    const totalCobrar = Math.min(pedido, devendo)

    // ── Conta do Mercado Pago DA LOJA (sem ela, não tem cobrança) ──
    const mpToken = await tokenDaLoja(sb, cli.empresa_id)
    if (!mpToken) return json({ error: 'A loja ainda não ligou o PIX. Pague direto com a equipe.' }, 503)

    // Comissão da plataforma, mesma regra do delivery.
    const { data: cfg } = await sb.from('configuracoes_plataforma')
      .select('valor').eq('chave', 'comissao_pix_percent').maybeSingle()
    const pct = Number(cfg?.valor ?? 0)
    const applicationFee = pct > 0 ? Math.round(totalCobrar * pct) / 100 : 0

    const primeiroNome = (String(cli.nome ?? '').trim().split(/\s+/)[0]) || 'Cliente'
    const sobrenome    = (String(cli.nome ?? '').trim().split(/\s+/).slice(1).join(' ')) || 'Cliente'

    // O MP exige no mínimo 30 min de validade pro PIX.
    const expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    const paymentBody: Record<string, unknown> = {
      transaction_amount: totalCobrar,
      description:        `Fiado ${cli.empresas?.nome ?? 'FWC Inter'}`,
      payment_method_id:  'pix',
      date_of_expiration: expiration,
      payer: { email: 'cliente@vendamais.app', first_name: primeiroNome, last_name: sobrenome },
      notification_url:   WEBHOOK_URL,
    }
    if (applicationFee > 0) paymentBody.application_fee = applicationFee

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization':     `Bearer ${mpToken}`,
        'Content-Type':      'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(paymentBody),
    })
    const mpData = await mpRes.json()
    if (!mpRes.ok) {
      console.error('MP error:', JSON.stringify(mpData))
      return json({ error: mpData.message ?? 'Erro no Mercado Pago' }, 400)
    }

    const { qr_code, qr_code_base64 } = mpData.point_of_interaction.transaction_data

    const { data: cob, error: dbErr } = await sb.from('cliente_pix_cobrancas').insert({
      empresa_id:     cli.empresa_id,
      cliente_id:     cli.id,
      valor:          totalCobrar,
      mp_payment_id:  String(mpData.id),
      qr_code, qr_code_base64,
      expira_em:      expiration,
    }).select('id').single()

    if (dbErr) {
      console.error('DB error:', dbErr.message)
      return json({ error: dbErr.message }, 500)
    }

    return json({ cobranca_id: cob.id, valor: totalCobrar, qr_code, qr_code_base64, expira_em: expiration })
  } catch (e) {
    console.error('cliente-pix error:', e)
    return json({ error: String(e) }, 500)
  }
})
