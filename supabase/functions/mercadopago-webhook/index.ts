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
// Dois lugares podem ter gerado o pagamento: um pedido de delivery ou um PIX do
// fiado feito pelo link do cliente (mig 0149).
async function tokenDoPagamento(sb: SB, paymentId: string): Promise<string> {
  const { data: pedido } = await sb.from('pedidos_delivery')
    .select('empresa_id').eq('mp_payment_id', String(paymentId)).maybeSingle()
  let empresaId: string | null = pedido?.empresa_id ?? null
  if (!empresaId) {
    const { data: cob } = await sb.from('cliente_pix_cobrancas')
      .select('empresa_id').eq('mp_payment_id', String(paymentId)).maybeSingle()
    empresaId = cob?.empresa_id ?? null
  }
  if (!empresaId) {
    // PIX da MESA (mig 0193): a cobrança nasce na conta do MP da própria loja.
    const { data: mesa } = await sb.from('comanda_pix_cobrancas')
      .select('empresa_id').eq('mp_payment_id', String(paymentId)).maybeSingle()
    empresaId = mesa?.empresa_id ?? null
  }
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
          // Atômico: credita saldo + histórico + marca 'pago' numa transação só.
          // Idempotente (trava status='pendente' + FOR UPDATE) — nunca credita 2x
          // nem fica 'pago' sem creditar.
          await supabase.rpc('confirmar_pagamento_credito', { p_mp_payment_id: String(paymentId) })
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

    // ── COMPRA DE SALDO DO ASSISTENTE DE IA (conta central, como os créditos) ──
    // Mesmo raciocínio do bloco acima: o mp_payment_id de uma compra de saldo
    // nunca existe em pedidos_delivery, então os fluxos não se cruzam. Quem
    // credita é a RPC — atômica e idempotente, porque o MP repete o aviso.
    {
      const { data: compraIa } = await supabase
        .from('ia_saldo_pagamentos')
        .select('empresa_id, valor_reais, status')
        .eq('mp_payment_id', String(paymentId))
        .maybeSingle()

      if (compraIa) {
        if (payment.status === 'approved') {
          await supabase.rpc('confirmar_pagamento_ia', { p_mp_payment_id: String(paymentId) })
        } else if (['cancelled', 'rejected', 'expired'].includes(payment.status)) {
          await supabase
            .from('ia_saldo_pagamentos')
            .update({ status: 'cancelado' })
            .eq('mp_payment_id', String(paymentId))
            .eq('status', 'pendente')
        }
        return new Response('ok', { status: 200 })
      }
    }

    // ── PIX DO FIADO PELO LINK DO CLIENTE (mig 0149) ──
    // Também não cruza com os pedidos: o mp_payment_id de uma cobrança de fiado
    // nunca existe em pedidos_delivery. Quem lança o recebimento é a RPC, que é
    // atômica e idempotente (webhook repetido não dá baixa duas vezes).
    {
      const { data: cob } = await supabase
        .from('cliente_pix_cobrancas')
        .select('id, status, empresa_id')
        .eq('mp_payment_id', String(paymentId))
        .maybeSingle()

      if (cob) {
        if (payment.status === 'approved') {
          const { data: res } = await supabase.rpc('confirmar_pix_fiado', { p_mp_payment_id: String(paymentId) })

          // Avisa a loja no WhatsApp (número de contato da empresa, pela instância
          // da plataforma — mesmo caminho do alertas-loja).
          if (res?.ok && res?.telefone_loja) {
            const fone = String(res.telefone_loja).replace(/\D/g, '')
            if (fone.length >= 10) {
              const { data: cfgG } = await supabase.from('config_global')
                .select('valor').eq('chave', 'admin_sender_instance').maybeSingle()
              const instance = (cfgG?.valor ?? '').trim() || 'crmadmin'
              const brl = (v: number) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
              const restante = Number(res.saldo_restante ?? 0)
              let msg = `💰 *PIX do fiado recebido!*\n\n`
              msg += `*${res.cliente_nome}* acabou de pagar *${brl(Number(res.valor))}* pelo link.\n`
              msg += restante > 0.004
                ? `Ainda deve ${brl(restante)}.\n`
                : `Ficou *quitado* ✅\n`
              msg += res.caixa_aberto
                ? `\nJá entrou no caixa aberto como "fiado em PIX".`
                : `\n⚠️ Não tinha caixa aberto — a dívida foi abatida, mas esse valor não entra em caixa nenhum.`
              msg += `\n\n_FWC Inter_`
              await fetch(`${EVOLUTION_API_URL}/message/sendText/${instance}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
                body: JSON.stringify({ number: fone.startsWith('55') ? fone : `55${fone}`, text: msg }),
              })
            }
          }
        } else if (['cancelled', 'rejected', 'expired'].includes(payment.status)) {
          await supabase.from('cliente_pix_cobrancas')
            .update({ status: 'expirado' })
            .eq('mp_payment_id', String(paymentId))
            .eq('status', 'pendente')
        }
        return new Response('ok', { status: 200 })
      }
    }

    // ── PIX DA MESA (mig 0193) ──
    // Também não cruza com os outros: o mp_payment_id de uma mesa só existe em
    // comanda_pix_cobrancas. Quem fecha a conta é a RPC — atômica e idempotente,
    // então aviso repetido do MP não vira duas vendas.
    {
      const { data: cob } = await supabase
        .from('comanda_pix_cobrancas')
        .select('id, status')
        .eq('mp_payment_id', String(paymentId))
        .maybeSingle()

      if (cob) {
        if (payment.status === 'approved') {
          const { data: res, error } = await supabase.rpc('confirmar_pix_comanda', { p_mp_payment_id: String(paymentId) })
          // Erro aqui é conta que NÃO fechou com dinheiro já recebido: tem que
          // aparecer no log, senão vira mesa aberta com PIX pago e ninguém sabe.
          if (error) console.error('confirmar_pix_comanda:', error.message)
          else if (res && res.ok === false) console.error('confirmar_pix_comanda recusou:', JSON.stringify(res))
        } else if (['cancelled', 'rejected', 'expired'].includes(payment.status)) {
          await supabase
            .from('comanda_pix_cobrancas')
            .update({ status: 'expirado' })
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
        .maybeSingle()

      // ── Pagamento chegou DEPOIS do pedido já ter sido cancelado (PIX expirou
      //    antes do cliente pagar). O QR do Mercado Pago fica válido ~30 min, mas
      //    a loja cancela em ~5 min. Se o cliente pagar fora do prazo, NÃO adianta
      //    "aceitar" um pedido cancelado — estorna automático e avisa o cliente. ──
      if (!pedido) {
        const { data: canc } = await supabase
          .from('pedidos_delivery')
          .select('id, numero_pedido, cliente_telefone, empresa_id, status, mp_payment_status')
          .eq('mp_payment_id', String(paymentId))
          .maybeSingle()

        if (canc && canc.status === 'cancelado' && canc.mp_payment_status !== 'refunded') {
          // Reembolso total com o token da loja dona do pagamento.
          const refundRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}/refunds`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${mpToken}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify({}),
          })
          if (refundRes.ok) {
            await supabase.from('pedidos_delivery')
              .update({ mp_payment_status: 'refunded', pix_status: 'reembolsado' })
              .eq('id', canc.id)

            if (canc.cliente_telefone) {
              const { data: waCfg } = await supabase
                .from('whatsapp_config').select('instance_name')
                .eq('empresa_id', canc.empresa_id).eq('ativo', true).maybeSingle()
              if (waCfg?.instance_name) {
                const phone = canc.cliente_telefone.replace(/\D/g, '')
                const phoneWpp = phone.startsWith('55') ? phone : `55${phone}`
                await fetch(`${EVOLUTION_API_URL}/message/sendText/${waCfg.instance_name}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
                  body: JSON.stringify({
                    number: phoneWpp,
                    text: `⚠️ *Ops! O PIX chegou fora do tempo.*\n\nO pedido *#${canc.numero_pedido}* já tinha sido cancelado porque o pagamento passou do prazo, então *estornamos o valor pra você* (cai de volta na sua conta em alguns minutos).\n\nSe ainda quiser o pedido, é só chamar aqui que a gente refaz rapidinho! 😊`,
                  }),
                })
              }
            }
          } else {
            console.error('Reembolso tardio falhou:', await refundRes.text())
          }
        }
        return new Response('ok', { status: 200 })
      }

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
