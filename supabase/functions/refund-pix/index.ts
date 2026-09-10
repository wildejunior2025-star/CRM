import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')!
const MP_CLIENT_ID     = Deno.env.get('MP_CLIENT_ID') ?? '736904729861760'
const MP_CLIENT_SECRET = Deno.env.get('MP_CLIENT_SECRET') ?? ''
const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// deno-lint-ignore no-explicit-any
type SB = any

// O pagamento pertence à conta da LOJA (marketplace) — o estorno TEM que ser feito
// com o token dela, não com o central (senão o MP recusa e o dinheiro não volta).
// Descobre a empresa do pedido, devolve o token da loja (renovando se expirou) e
// cai no token central só se a loja não tiver conta conectada.
async function tokenDaLoja(sb: SB, empresaId: string | null): Promise<string> {
  if (!empresaId) return MP_ACCESS_TOKEN
  const { data: conta } = await sb.from('mercadopago_contas')
    .select('access_token, refresh_token, expires_at').eq('empresa_id', empresaId).maybeSingle()
  if (!conta?.access_token) return MP_ACCESS_TOKEN
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
      const expiresAt = new Date(Date.now() + Number(tk.expires_in ?? 15552000) * 1000).toISOString()
      await sb.from('mercadopago_contas').update({
        access_token: tk.access_token, refresh_token: tk.refresh_token ?? conta.refresh_token,
        expires_at: expiresAt, updated_at: new Date().toISOString(),
      }).eq('empresa_id', empresaId)
      return tk.access_token
    }
  }
  return conta.access_token
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    // `valor` liga o estorno PARCIAL (mig 0250): o cliente tirou um item do
    // pedido, ou somou um e a quantidade caiu na faixa de atacado — o pedido
    // continua de pé, só volta a diferença. Sem `valor`, é o de sempre:
    // devolve tudo e cancela.
    const { order_id, motivo, valor, manter_pedido, pagamento_id, empresa_id } = await req.json()
    const parcial = Number(valor) > 0

    // ── Estorno de um pagamento AVULSO (mig 0252) ─────────────────────────
    //
    // A diferença de uma alteração de pedido é um pagamento separado, que não
    // vive em pedidos_delivery. A loja recusou a mudança: devolve aquele PIX
    // inteiro, sem encostar no pagamento do pedido original.
    if (pagamento_id) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const mpToken = await tokenDaLoja(supabase, empresa_id ?? null)
      const mpRes = await fetch(
        `https://api.mercadopago.com/v1/payments/${pagamento_id}/refunds`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${mpToken}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({}),   // devolve tudo daquele pagamento
        },
      )
      const rd = await mpRes.json()
      if (!mpRes.ok) {
        console.error('MP refund avulso:', JSON.stringify(rd))
        return new Response(JSON.stringify({
          ok: false, erro: rd?.message ?? 'O Mercado Pago recusou o estorno.',
        }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // Busca o pedido para pegar o mp_payment_id
    const { data: pedido, error: fetchErr } = await supabase
      .from('pedidos_delivery')
      .select('id, empresa_id, mp_payment_id, mp_payment_status, status')
      .eq('id', order_id)
      .single()

    if (fetchErr || !pedido) {
      return new Response(JSON.stringify({ error: 'Pedido não encontrado' }), {
        status: 404, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Nada pago online: não há o que devolver. No parcial isso é resposta, não
    // silêncio — quem está no balcão precisa saber que ninguém vai receber nada.
    if (parcial && !(pedido.mp_payment_id && pedido.mp_payment_status === 'approved')) {
      return new Response(JSON.stringify({ ok: false, erro: 'Este pedido não foi pago online.' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Só reembolsa se houve pagamento aprovado
    if (pedido.mp_payment_id && pedido.mp_payment_status === 'approved') {
      // Token da LOJA dona do pagamento (fallback: central). Sem ele o MP recusa
      // o estorno de pagamentos feitos na conta da loja.
      const mpToken = await tokenDaLoja(supabase, pedido.empresa_id)

      // Quanto AINDA dá pra devolver, perguntado ao MP.
      //
      // O valor pago não fica guardado aqui: `total` é o de agora, e no parcial
      // ele já mudou justamente por causa da alteração. E duas alterações
      // seguidas devolveriam duas vezes se ninguém contasse o que já voltou —
      // quem sabe isso é o Mercado Pago, então é ele quem responde.
      let valorFinal: number | null = null
      if (parcial) {
        const pgRes = await fetch(
          `https://api.mercadopago.com/v1/payments/${pedido.mp_payment_id}`,
          { headers: { 'Authorization': `Bearer ${mpToken}` } },
        )
        const pg = await pgRes.json()
        if (!pgRes.ok) {
          console.error('MP payment fetch error:', JSON.stringify(pg))
          return new Response(JSON.stringify({
            ok: false, erro: pg?.message ?? 'Não consegui falar com o Mercado Pago.',
          }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
        const pago      = Number(pg?.transaction_amount ?? 0)
        const jaVoltou  = Number(pg?.transaction_amount_refunded ?? 0)
        const disponivel = Math.round((pago - jaVoltou) * 100) / 100
        valorFinal = Math.min(Math.round(Number(valor) * 100) / 100, disponivel)
        if (!(valorFinal > 0)) {
          return new Response(JSON.stringify({
            ok: false, erro: `Não há saldo desse pagamento para devolver (pago R$ ${pago.toFixed(2)}, já voltou R$ ${jaVoltou.toFixed(2)}).`,
          }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
      }

      const mpRes = await fetch(
        `https://api.mercadopago.com/v1/payments/${pedido.mp_payment_id}/refunds`,
        {
          method: 'POST',
          headers: {
            'Authorization':     `Bearer ${mpToken}`,
            'Content-Type':      'application/json',
            'X-Idempotency-Key': crypto.randomUUID(),
          },
          // Sem corpo = devolve tudo. Com `amount` = devolve só a diferença.
          body: JSON.stringify(valorFinal != null ? { amount: valorFinal } : {}),
        }
      )

      const refundData = await mpRes.json()

      if (!mpRes.ok) {
        console.error('MP refund error:', JSON.stringify(refundData))
        // No parcial o erro TEM que subir. O pedido continua de pé e a loja
        // precisa saber que o dinheiro não voltou — senão ela acha que voltou e
        // o cliente cobra depois. No total, segue e cancela mesmo assim: pedido
        // recusado não pode ficar na tela por causa do MP fora do ar.
        if (parcial) {
          return new Response(JSON.stringify({
            ok: false,
            erro: refundData?.message ?? 'O Mercado Pago recusou o estorno. Confira o saldo da conta da loja.',
          }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
        }
      }

      // Parcial deu certo: o pedido CONTINUA de pé, só voltou a diferença.
      if (parcial) {
        return new Response(JSON.stringify({ ok: true, valor: valorFinal }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        })
      }
    }

    if (manter_pedido) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Cancela o pedido no banco
    await supabase
      .from('pedidos_delivery')
      .update({
        status: 'cancelado',
        motivo_cancelamento: motivo ?? 'Pedido recusado pela loja',
        mp_payment_status: pedido.mp_payment_status === 'approved' ? 'refunded' : pedido.mp_payment_status,
      })
      .eq('id', order_id)

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('Refund error:', e)
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
