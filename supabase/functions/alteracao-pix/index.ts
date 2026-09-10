import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// PIX da DIFERENÇA quando o cliente soma item num pedido já pago online.
//
// Por que não dá pra reaproveitar o create-pix-payment: aquele CRIA o pedido
// junto com a cobrança. Aqui o pedido já existe e está pago — o que falta é um
// pagamento novo, só da diferença, amarrado à alteração.
//
// Enquanto este PIX não cai, a alteração fica 'aguardando_pagamento' e a loja
// NÃO a vê (o gestor só lista 'pendente'). É a decisão do dono: cobrar na hora
// e estornar se a loja recusar, porque "é melhor que pagar depois e a pessoa
// não pagar".

const MP_ACCESS_TOKEN  = Deno.env.get('MP_ACCESS_TOKEN')!
const MP_CLIENT_ID     = Deno.env.get('MP_CLIENT_ID') ?? '736904729861760'
const MP_CLIENT_SECRET = Deno.env.get('MP_CLIENT_SECRET') ?? ''
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WEBHOOK_URL      = `${SUPABASE_URL}/functions/v1/mercadopago-webhook`

// deno-lint-ignore no-explicit-any
type SB = any

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Mesma regra do create-pix-payment: token da LOJA quando ela conectou o MP
// dela (o dinheiro cai lá, com a comissão da plataforma no split), senão a
// conta central e sem comissão.
async function resolverContaMp(sb: SB, empresaId: string, total: number) {
  const { data: conta } = await sb.from('mercadopago_contas')
    .select('access_token, refresh_token, expires_at').eq('empresa_id', empresaId).maybeSingle()
  if (!conta?.access_token) return { token: MP_ACCESS_TOKEN, applicationFee: 0 }

  let token = conta.access_token
  const expMs = conta.expires_at ? new Date(conta.expires_at).getTime() : 0
  if (expMs && expMs < Date.now() + 60_000 && conta.refresh_token) {
    const r = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: conta.refresh_token,
      }),
    })
    const tk = await r.json()
    if (r.ok && tk.access_token) {
      await sb.from('mercadopago_contas').update({
        access_token: tk.access_token,
        refresh_token: tk.refresh_token ?? conta.refresh_token,
        expires_at: new Date(Date.now() + Number(tk.expires_in ?? 15552000) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('empresa_id', empresaId)
      token = tk.access_token
    }
  }

  const { data: cfg } = await sb.from('configuracoes_plataforma')
    .select('valor').eq('chave', 'comissao_pix_percent').maybeSingle()
  const pct = Number(cfg?.valor ?? 0)
  return { token, applicationFee: pct > 0 ? Math.round(total * pct) / 100 : 0 }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { alteracao_id } = await req.json()
    if (!alteracao_id) return json({ erro: 'alteracao_id obrigatório' }, 400)

    const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

    const { data: alt } = await sb.from('pedido_alteracoes')
      .select('*').eq('id', alteracao_id).maybeSingle()
    if (!alt) return json({ erro: 'Alteração não encontrada' }, 404)
    if (alt.status !== 'aguardando_pagamento') return json({ erro: 'Esta alteração não espera pagamento' }, 400)
    if (!(Number(alt.valor_a_pagar) > 0)) return json({ erro: 'Não há diferença a pagar' }, 400)

    // Já gerou antes? Devolve o MESMO QR. Sem isto, recarregar a tela criava
    // uma cobrança nova a cada vez e o cliente ficaria com vários PIX abertos.
    if (alt.mp_payment_id && alt.pix_qr) {
      return json({ ok: true, mp_payment_id: alt.mp_payment_id, qr_code: alt.pix_qr, qr_code_base64: alt.pix_qr_base64 })
    }

    const { data: ped } = await sb.from('pedidos_delivery')
      .select('numero_pedido, cliente_nome, empresa_id').eq('id', alt.pedido_id).maybeSingle()
    const { data: emp } = await sb.from('empresas')
      .select('nome').eq('id', alt.empresa_id).maybeSingle()

    const valor = Number(alt.valor_a_pagar)
    const { token, applicationFee } = await resolverContaMp(sb, alt.empresa_id, valor)

    const nome = String(ped?.cliente_nome ?? 'Cliente').trim()
    const paymentBody: Record<string, unknown> = {
      transaction_amount: valor,
      description: `Itens a mais no pedido ${ped?.numero_pedido ?? ''} · ${emp?.nome ?? 'FWC Inter'}`,
      payment_method_id: 'pix',
      // 30 min é o mínimo que o MP aceita para PIX.
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      payer: {
        email: 'cliente@vendamais.app',
        first_name: nome.split(/\s+/)[0] || 'Cliente',
        last_name: nome.split(/\s+/).slice(1).join(' ') || 'Cliente',
      },
      notification_url: WEBHOOK_URL,
    }
    if (applicationFee > 0) paymentBody.application_fee = applicationFee

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(paymentBody),
    })
    const mp = await mpRes.json()
    if (!mpRes.ok) {
      console.error('MP error (alteracao-pix):', JSON.stringify(mp))
      return json({ erro: mp?.message ?? 'Erro no Mercado Pago' }, 400)
    }

    const qr = mp?.point_of_interaction?.transaction_data ?? {}
    await sb.from('pedido_alteracoes').update({
      mp_payment_id: String(mp.id),
      pix_qr: qr.qr_code ?? null,
      pix_qr_base64: qr.qr_code_base64 ?? null,
    }).eq('id', alt.id)

    return json({ ok: true, mp_payment_id: String(mp.id), qr_code: qr.qr_code, qr_code_base64: qr.qr_code_base64 })
  } catch (e) {
    console.error('alteracao-pix:', e)
    return json({ erro: String(e) }, 500)
  }
})
