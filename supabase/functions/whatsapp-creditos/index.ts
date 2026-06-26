import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')!
const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PACOTES = [
  { creditos: 100,  valor: 7.00  },
  { creditos: 500,  valor: 35.00 },
  { creditos: 2000, valor: 140.00 },
  { creditos: 5000, valor: 350.00 },
]

const DESCRICAO_TIPO: Record<string, string> = {
  compra_pix:    'Compra via PIX',
  compra_cartao: 'Compra via cartão',
  uso_bot:       'Resposta do bot',
  recarga_auto:  'Recarga automática',
  bonus:         'Bônus',
  ajuste:        'Ajuste manual',
}

async function mp(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  // Autenticação JWT
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

  // Busca empresa do usuário
  const { data: profile } = await supabase.from('profiles').select('empresa_id').eq('id', user.id).single()
  if (!profile?.empresa_id) return new Response(JSON.stringify({ error: 'Empresa não encontrada' }), { status: 400, headers: CORS })
  const empresa_id: string = profile.empresa_id

  const json = await req.json().catch(() => ({}))
  const { action } = json

  try {
    // ── GET BALANCE ──────────────────────────────────────────────────────────
    if (action === 'get_balance') {
      const [{ data: empresa }, { data: historico }] = await Promise.all([
        supabase.from('empresas').select(
          'whatsapp_creditos, mp_card_id, mp_card_last4, mp_card_brand, auto_recarga_ativo, auto_recarga_minimo, auto_recarga_valor'
        ).eq('id', empresa_id).single(),
        supabase.from('whatsapp_credito_historico')
          .select('id, tipo, creditos, valor_reais, created_at')
          .eq('empresa_id', empresa_id)
          .order('created_at', { ascending: false })
          .limit(50),
      ])

      return new Response(JSON.stringify({
        creditos: empresa?.whatsapp_creditos ?? 0,
        cartao: empresa?.mp_card_id ? {
          brand:   empresa.mp_card_brand,
          last4:   empresa.mp_card_last4,
          card_id: empresa.mp_card_id,
        } : null,
        auto_recarga: {
          ativo:   empresa?.auto_recarga_ativo   ?? false,
          minimo:  empresa?.auto_recarga_minimo  ?? 50,
          valor:   empresa?.auto_recarga_valor   ?? 50,
        },
        historico: (historico ?? []).map(h => ({
          ...h,
          descricao: DESCRICAO_TIPO[h.tipo] ?? h.tipo,
        })),
        pacotes: PACOTES,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── BUY PIX ──────────────────────────────────────────────────────────────
    if (action === 'buy_pix') {
      const { creditos } = json
      const pacote = PACOTES.find(p => p.creditos === creditos)
      if (!pacote) return new Response(JSON.stringify({ error: 'Pacote inválido' }), { status: 400, headers: CORS })

      const { data: empresa } = await supabase.from('empresas').select('nome').eq('id', empresa_id).single()
      const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1h

      const mpRes = await mp('/v1/payments', 'POST', {
        transaction_amount: pacote.valor,
        description: `${pacote.creditos} créditos WhatsApp Bot`,
        payment_method_id: 'pix',
        date_of_expiration: expiration,
        payer: { email: user.email ?? 'loja@vendamais.app' },
        notification_url: `${SUPABASE_URL}/functions/v1/mercadopago-webhook`,
        metadata: { tipo: 'credito_whatsapp', empresa_id, creditos },
      })

      if (!mpRes?.id) return new Response(JSON.stringify({ error: 'Falha ao criar PIX no MP', detail: mpRes }), { status: 500, headers: CORS })

      await supabase.from('whatsapp_credito_pagamentos').insert({
        empresa_id,
        mp_payment_id: String(mpRes.id),
        creditos,
        valor_reais: pacote.valor,
        status: 'pendente',
        tipo: 'pix',
      })

      return new Response(JSON.stringify({
        mp_payment_id: mpRes.id,
        qr_code:         mpRes.point_of_interaction?.transaction_data?.qr_code,
        qr_code_base64:  mpRes.point_of_interaction?.transaction_data?.qr_code_base64,
        valor: pacote.valor,
        creditos,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── SAVE CARD ─────────────────────────────────────────────────────────────
    if (action === 'save_card') {
      const { card_token, cpf } = json
      if (!card_token) return new Response(JSON.stringify({ error: 'card_token obrigatório' }), { status: 400, headers: CORS })

      const { data: empresa } = await supabase.from('empresas').select('mp_customer_id').eq('id', empresa_id).single()
      let mp_customer_id = empresa?.mp_customer_id

      // Cria customer MP se não existe
      if (!mp_customer_id) {
        const customer = await mp('/v1/customers', 'POST', { email: user.email ?? `loja_${empresa_id}@vendamais.app` })
        if (!customer?.id) return new Response(JSON.stringify({ error: 'Falha ao criar customer MP' }), { status: 500, headers: CORS })
        mp_customer_id = customer.id
      }

      // Salva cartão no customer
      const card = await mp(`/v1/customers/${mp_customer_id}/cards`, 'POST', { token: card_token })
      if (!card?.id) return new Response(JSON.stringify({ error: 'Falha ao salvar cartão no MP', detail: card }), { status: 500, headers: CORS })

      await supabase.from('empresas').update({
        mp_customer_id,
        mp_card_id:    card.id,
        mp_card_last4: card.last_four_digits,
        mp_card_brand: card.payment_method_id,
        mp_payer_cpf:  cpf ? cpf.replace(/\D/g, '') : null,
      }).eq('id', empresa_id)

      return new Response(JSON.stringify({
        ok: true,
        card_id: card.id,
        last4:   card.last_four_digits,
        brand:   card.payment_method_id,
      }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── CHARGE CARD ───────────────────────────────────────────────────────────
    if (action === 'charge_card') {
      const { creditos, token: frontendToken } = json
      const pacote = PACOTES.find(p => p.creditos === creditos)
      if (!pacote) return new Response(JSON.stringify({ error: 'Pacote inválido' }), { status: 400, headers: CORS })
      if (!frontendToken) return new Response(JSON.stringify({ error: 'Token do cartão não enviado' }), { status: 400, headers: CORS })

      const { data: empresa } = await supabase.from('empresas').select('mp_customer_id, mp_card_id, mp_card_brand, mp_payer_cpf').eq('id', empresa_id).single()
      if (!empresa?.mp_card_id) return new Response(JSON.stringify({ error: 'Nenhum cartão salvo' }), { status: 400, headers: CORS })

      const mpRes = await mp('/v1/payments', 'POST', {
        transaction_amount: pacote.valor,
        description: `${pacote.creditos} créditos WhatsApp Bot`,
        payment_method_id: empresa.mp_card_brand,
        installments: 1,
        token: frontendToken,
        payer: {
          id:    empresa.mp_customer_id,
          email: user.email ?? 'loja@vendamais.app',
          ...(empresa.mp_payer_cpf ? { identification: { type: 'CPF', number: empresa.mp_payer_cpf } } : {}),
        },
        binary_mode: true,
        notification_url: `${SUPABASE_URL}/functions/v1/mercadopago-webhook`,
        metadata: { tipo: 'credito_whatsapp', empresa_id, creditos },
      })

      console.log('[charge_card] mpRes:', JSON.stringify(mpRes))

      if (mpRes?.status === 'approved') {
        await supabase.rpc('adicionar_creditos_whatsapp', {
          p_empresa_id:   empresa_id,
          p_creditos:     creditos,
          p_tipo:         'compra_cartao',
          p_valor_reais:  pacote.valor,
          p_mp_payment_id: String(mpRes.id),
        })
        return new Response(JSON.stringify({ ok: true, status: 'approved', creditos }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
      }

      return new Response(JSON.stringify({ ok: false, status: mpRes?.status, detail: mpRes?.status_detail, mp_error: mpRes?.error, mp_message: mpRes?.message, mp_cause: mpRes?.cause }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── SET AUTO RECHARGE ─────────────────────────────────────────────────────
    if (action === 'set_auto_recharge') {
      const { ativo, minimo, valor } = json
      await supabase.from('empresas').update({
        auto_recarga_ativo:  ativo,
        auto_recarga_minimo: minimo,
        auto_recarga_valor:  valor,
      }).eq('id', empresa_id)
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    // ── REMOVE CARD ───────────────────────────────────────────────────────────
    if (action === 'remove_card') {
      const { data: empresa } = await supabase.from('empresas').select('mp_customer_id, mp_card_id').eq('id', empresa_id).single()
      if (empresa?.mp_customer_id && empresa?.mp_card_id) {
        await mp(`/v1/customers/${empresa.mp_customer_id}/cards/${empresa.mp_card_id}`, 'DELETE')
      }
      await supabase.from('empresas').update({
        mp_card_id:    null,
        mp_card_last4: null,
        mp_card_brand: null,
        auto_recarga_ativo: false,
      }).eq('id', empresa_id)
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'Ação desconhecida' }), { status: 400, headers: CORS })
  } catch (err) {
    console.error('[whatsapp-creditos]', err)
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS })
  }
})
