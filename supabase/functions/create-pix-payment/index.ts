import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_ACCESS_TOKEN   = Deno.env.get('MP_ACCESS_TOKEN')!
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WEBHOOK_URL       = `${SUPABASE_URL}/functions/v1/mercadopago-webhook`

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = await req.json()
    const { pedido } = body
    // pedido: { empresa_id, empresa_nome, cliente_id, cliente_nome, cliente_telefone,
    //           itens, total, subtotal, taxa_entrega, forma_pagamento, tipo_entrega,
    //           endereco_rua, endereco_numero, endereco_complemento, endereco_bairro,
    //           endereco_cidade, observacoes, troco_para, codigo_entrega, payer_email }

    // MP exige mínimo 30 min para PIX — nosso cron cancela internamente aos 7 min
    const expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization':    `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type':     'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        transaction_amount: Number(pedido.total),
        description:        `Pedido ${pedido.empresa_nome ?? 'FWC Inter'}`,
        payment_method_id:  'pix',
        date_of_expiration: expiration,
        payer: {
          email:      pedido.payer_email ?? 'cliente@vendamais.app',
          first_name: (pedido.cliente_nome ?? 'Cliente').split(' ')[0],
          last_name:  (pedido.cliente_nome ?? '').split(' ').slice(1).join(' ') || 'Cliente',
        },
        notification_url: WEBHOOK_URL,
      }),
    })

    const mpData = await mpRes.json()

    if (!mpRes.ok) {
      console.error('MP error:', JSON.stringify(mpData))
      return new Response(JSON.stringify({ error: mpData.message ?? 'Erro Mercado Pago' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    const { id: mp_payment_id, point_of_interaction } = mpData
    const { qr_code, qr_code_base64 } = point_of_interaction.transaction_data

    // Insere pedido no banco com status aguardando_pagamento
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    const { data: order, error: dbErr } = await supabase
      .from('pedidos_delivery')
      .insert({
        empresa_id:            pedido.empresa_id,
        user_id:               pedido.user_id ?? null,
        cliente_id:            pedido.cliente_id ?? null,
        cliente_nome:          pedido.cliente_nome,
        cliente_telefone:      pedido.cliente_telefone,
        itens:                 pedido.itens,
        total:                 pedido.total,
        subtotal:              pedido.subtotal,
        taxa_entrega:          pedido.taxa_entrega,
        forma_pagamento:       'pix',
        pix_status:            'pendente',
        pix_copia_cola:        qr_code,
        pix_qrcode:            qr_code_base64,
        tipo_entrega:          pedido.tipo_entrega,
        endereco_rua:          pedido.endereco_rua,
        endereco_numero:       pedido.endereco_numero,
        endereco_complemento:  pedido.endereco_complemento,
        endereco_bairro:       pedido.endereco_bairro,
        endereco_cidade:       pedido.endereco_cidade,
        observacoes:           pedido.observacoes ?? null,
        troco_para:            pedido.troco_para ?? null,
        codigo_entrega:        pedido.codigo_entrega,
        status:                'aguardando_pagamento',
        mp_payment_id:         String(mp_payment_id),
        mp_payment_status:     'pending',
        pix_expira_em:         new Date(Date.now() + 7 * 60 * 1000).toISOString(),
        aguardando_desde:      null,
      })
      .select('id, numero_pedido')
      .single()

    if (dbErr) {
      console.error('DB error:', dbErr.message)
      return new Response(JSON.stringify({ error: dbErr.message }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    return new Response(
      JSON.stringify({ order_id: order.id, numero_pedido: order.numero_pedido, qr_code, qr_code_base64, mp_payment_id, expires_at: expiration }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    console.error('Unexpected error:', e)
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
