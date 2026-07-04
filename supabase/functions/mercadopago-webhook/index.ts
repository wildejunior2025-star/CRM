import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_ACCESS_TOKEN   = Deno.env.get('MP_ACCESS_TOKEN')!
const MP_CLIENT_ID      = Deno.env.get('MP_CLIENT_ID') ?? '736904729861760'
const MP_CLIENT_SECRET  = Deno.env.get('MP_CLIENT_SECRET') ?? ''
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const EVOLUTION_API_URL = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/$/, '')
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? ''

// deno-lint-ignore no-explicit-any
type SB = any

// O pagamento pertence à conta da LOJA (marketplace); pra consultá-lo é preciso
// o token dela. Descobre a empresa pelo mp_payment_id e devolve o token certo
// (renovando se expirou). Sem loja conectada → token da conta central.
async function tokenDoPagamento(sb: SB, paymentId: string): Promise<string> {
  const { data: pedido } = await sb.from('pedidos_delivery')
    .select('empresa_id').eq('mp_payment_id', String(paymentId)).maybeSingle()
  if (!pedido?.empresa_id) return MP_ACCESS_TOKEN
  const { data: conta } = await sb.from('mercadopago_contas')
    .select('access_token, refresh_token, expires_at').eq('empresa_id', pedido.empresa_id).maybeSingle()
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
      }).eq('empresa_id', pedido.empresa_id)
      return tk.access_token
    }
  }
  return conta.access_token
}

Deno.serve(async (req) => {
  try {
    const body = await req.json()

    if (body.type !== 'payment') return new Response('ok', { status: 200 })

    const paymentId = body.data?.id
    if (!paymentId) return new Response('ok', { status: 200 })

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // Consulta o pagamento com o token da loja dona dele (fallback: conta central).
    const mpToken = await tokenDoPagamento(supabase, paymentId)
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${mpToken}` },
    })
    const payment = await mpRes.json()

    // ── COMPRA DE CRÉDITOS DO BOT (SaaS — conta central, separado dos pedidos) ──
    // O mp_payment_id de um crédito nunca existe em pedidos_delivery, então os dois
    // fluxos jamais se cruzam. Se este pagamento é de crédito, trata aqui e retorna.
    {
      const { data: compra } = await supabase
        .from('whatsapp_credito_pagamentos')
        .select('empresa_id, creditos, valor_reais, status')
        .eq('mp_payment_id', String(paymentId))
        .maybeSingle()

      if (compra) {
        if (payment.status === 'approved') {
          // .eq('status','pendente') = trava anti-duplicação: só credita 1x
          const { data: pago } = await supabase
            .from('whatsapp_credito_pagamentos')
            .update({ status: 'pago' })
            .eq('mp_payment_id', String(paymentId))
            .eq('status', 'pendente')
            .select('empresa_id, creditos, valor_reais')
            .maybeSingle()
          if (pago) {
            await supabase.rpc('adicionar_creditos_whatsapp', {
              p_empresa_id:    pago.empresa_id,
              p_creditos:      pago.creditos,
              p_tipo:          'compra_pix',
              p_valor_reais:   pago.valor_reais,
              p_mp_payment_id: String(paymentId),
            })
          }
        } else if (['cancelled', 'rejected', 'expired'].includes(payment.status)) {
          await supabase
            .from('whatsapp_credito_pagamentos')
            .update({ status: 'cancelado' })
            .eq('mp_payment_id', String(paymentId))
            .eq('status', 'pendente')
        }
        return new Response('ok', { status: 200 })
      }
    }

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
