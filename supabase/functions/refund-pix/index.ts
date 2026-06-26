import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')!
const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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
      .select('id, mp_payment_id, mp_payment_status, status')
      .eq('id', order_id)
      .single()

    if (fetchErr || !pedido) {
      return new Response(JSON.stringify({ error: 'Pedido não encontrado' }), {
        status: 404, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    // Só reembolsa se houve pagamento aprovado
    if (pedido.mp_payment_id && pedido.mp_payment_status === 'approved') {
      const mpRes = await fetch(
        `https://api.mercadopago.com/v1/payments/${pedido.mp_payment_id}/refunds`,
        {
          method: 'POST',
          headers: {
            'Authorization':     `Bearer ${MP_ACCESS_TOKEN}`,
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
