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
    const { order_id, motivo } = await req.json()

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

    // Só reembolsa se houve pagamento aprovado
    if (pedido.mp_payment_id && pedido.mp_payment_status === 'approved') {
      // Token da LOJA dona do pagamento (fallback: central). Sem ele o MP recusa
      // o estorno de pagamentos feitos na conta da loja.
      const mpToken = await tokenDaLoja(supabase, pedido.empresa_id)
      const mpRes = await fetch(
        `https://api.mercadopago.com/v1/payments/${pedido.mp_payment_id}/refunds`,
        {
          method: 'POST',
          headers: {
            'Authorization':     `Bearer ${mpToken}`,
            'Content-Type':      'application/json',
            'X-Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({}), // reembolso total
        }
      )

      const refundData = await mpRes.json()

      if (!mpRes.ok) {
        console.error('MP refund error:', JSON.stringify(refundData))
        // Mesmo com erro no reembolso, cancela o pedido no banco
      }
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
