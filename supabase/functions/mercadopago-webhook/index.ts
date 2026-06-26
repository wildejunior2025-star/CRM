import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_ACCESS_TOKEN   = Deno.env.get('MP_ACCESS_TOKEN')!
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const EVOLUTION_API_URL = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/$/, '')
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? ''

Deno.serve(async (req) => {
  try {
    const body = await req.json()

    if (body.type !== 'payment') return new Response('ok', { status: 200 })

    const paymentId = body.data?.id
    if (!paymentId) return new Response('ok', { status: 200 })

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    })
    const payment = await mpRes.json()

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    if (payment.status === 'approved') {
      // Atualiza pedido para aguardando (entra na fila da loja)
      const { data: pedido } = await supabase
        .from('pedidos_delivery')
        .update({ status: 'aguardando', mp_payment_status: 'approved', pix_status: 'pago', aguardando_desde: new Date().toISOString() })
        .eq('mp_payment_id', String(paymentId))
        .eq('status', 'aguardando_pagamento')
        .select('numero_pedido, cliente_telefone, empresa_id')
        .single()

      // Notifica cliente via WhatsApp
      if (pedido?.cliente_telefone) {
        const { data: waCfg } = await supabase
          .from('whatsapp_config')
          .select('instance_name')
          .eq('empresa_id', pedido.empresa_id)
          .eq('ativo', true)
          .single()

        if (waCfg?.instance_name) {
          const phone = pedido.cliente_telefone.replace(/\D/g, '')
          const phoneWpp = phone.startsWith('55') ? phone : `55${phone}`

          await fetch(`${EVOLUTION_API_URL}/message/sendText/${waCfg.instance_name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
            body: JSON.stringify({
              number: phoneWpp,
              text: `✅ *Recebemos seu pagamento!*\n\nPedido *#${pedido.numero_pedido}* pago com sucesso. Aguardando a loja confirmar o pedido.\n\nVocê receberá uma mensagem assim que a loja confirmar! 🎉`,
            }),
          })
        }
      }

    } else if (['cancelled', 'rejected', 'expired'].includes(payment.status)) {
      const { data: pedido } = await supabase
        .from('pedidos_delivery')
        .update({
          status:              'cancelado',
          mp_payment_status:   payment.status,
          motivo_cancelamento: 'Pagamento PIX não concluído',
        })
        .eq('mp_payment_id', String(paymentId))
        .eq('status', 'aguardando_pagamento')
        .select('numero_pedido, cliente_telefone, empresa_id')
        .single()

      // Notifica cliente sobre falha
      if (pedido?.cliente_telefone) {
        const { data: waCfg } = await supabase
          .from('whatsapp_config')
          .select('instance_name')
          .eq('empresa_id', pedido.empresa_id)
          .eq('ativo', true)
          .single()

        if (waCfg?.instance_name) {
          const phone = pedido.cliente_telefone.replace(/\D/g, '')
          const phoneWpp = phone.startsWith('55') ? phone : `55${phone}`

          await fetch(`${EVOLUTION_API_URL}/message/sendText/${waCfg.instance_name}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
            body: JSON.stringify({
              number: phoneWpp,
              text: `⚠️ O PIX do pedido *#${pedido.numero_pedido}* não foi confirmado e o pedido foi cancelado.\n\nSe quiser tentar novamente é só chamar aqui! 😊`,
            }),
          })
        }
      }
    }

    return new Response('ok', { status: 200 })
  } catch (e) {
    console.error('Webhook error:', e)
    return new Response('ok', { status: 200 })
  }
})
