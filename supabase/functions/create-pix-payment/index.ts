import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MP_ACCESS_TOKEN   = Deno.env.get('MP_ACCESS_TOKEN')!
const MP_CLIENT_ID      = Deno.env.get('MP_CLIENT_ID') ?? '736904729861760'
const MP_CLIENT_SECRET  = Deno.env.get('MP_CLIENT_SECRET') ?? ''
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WEBHOOK_URL       = `${SUPABASE_URL}/functions/v1/mercadopago-webhook`

// deno-lint-ignore no-explicit-any
type SB = any

// Renova o access_token da loja usando o refresh_token. Retorna o novo token ou null.
async function refreshSellerToken(sb: SB, empresaId: string, refreshToken: string): Promise<string | null> {
  const r = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: refreshToken,
    }),
  })
  const tk = await r.json()
  if (!r.ok || !tk.access_token) { console.error('MP refresh error:', JSON.stringify(tk)); return null }
  const expiresAt = new Date(Date.now() + Number(tk.expires_in ?? 15552000) * 1000).toISOString()
  await sb.from('mercadopago_contas').update({
    access_token: tk.access_token,
    refresh_token: tk.refresh_token ?? refreshToken,
    expires_at: expiresAt, updated_at: new Date().toISOString(),
  }).eq('empresa_id', empresaId)
  return tk.access_token
}

// Decide qual token MP usar (o da loja, se conectou) e quanto de comissão cobrar.
async function resolverContaMp(sb: SB, empresaId: string, totalCobrar: number) {
  const { data: conta } = await sb.from('mercadopago_contas')
    .select('access_token, refresh_token, expires_at').eq('empresa_id', empresaId).maybeSingle()
  // Loja não conectou o MP dela → cai na conta central (comportamento antigo), sem comissão.
  if (!conta?.access_token) return { token: MP_ACCESS_TOKEN, applicationFee: 0 }

  let token = conta.access_token
  const expMs = conta.expires_at ? new Date(conta.expires_at).getTime() : 0
  if (expMs && expMs < Date.now() + 60_000 && conta.refresh_token) {
    token = (await refreshSellerToken(sb, empresaId, conta.refresh_token)) ?? token
  }

  // Comissão da plataforma (% do total), arredondada a centavos.
  const { data: cfg } = await sb.from('configuracoes_plataforma')
    .select('valor').eq('chave', 'comissao_pix_percent').maybeSingle()
  const pct = Number(cfg?.valor ?? 0)
  const applicationFee = pct > 0 ? Math.round(totalCobrar * pct) / 100 : 0
  return { token, applicationFee }
}

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
    //           endereco_cidade, endereco_estado, endereco_cep, endereco_lat,
    //           endereco_lng, observacoes, troco_para, codigo_entrega, payer_email,
    //           pontos_usados }

    const supabaseSrv = createClient(SUPABASE_URL, SUPABASE_KEY)

    // ── Desconto por pontos (validado no servidor) ──────────────────────────
    // O cliente informa pontos_usados, mas quem manda é o saldo real + a config.
    // Garante que a cobrança do PIX e os pontos a debitar batem com o saldo.
    const baseTotal = Number(pedido.subtotal ?? 0) + Number(pedido.taxa_entrega ?? 0)
    let pontosUsados = Math.max(0, Math.floor(Number(pedido.pontos_usados ?? 0)))
    let desconto = 0
    if (pontosUsados > 0 && pedido.user_id) {
      const { data: cfgRows } = await supabaseSrv
        .from('configuracoes_plataforma')
        .select('chave, valor')
        .in('chave', ['valor_resgate_ponto', 'pontos_minimo_resgate'])
      const valPonto = Number(cfgRows?.find((c: { chave: string; valor: string }) => c.chave === 'valor_resgate_ponto')?.valor ?? 0.02)
      const minResg  = Number(cfgRows?.find((c: { chave: string; valor: string }) => c.chave === 'pontos_minimo_resgate')?.valor ?? 100)

      const { data: saldo } = await supabaseSrv
        .from('saldo_pontos').select('pontos').eq('profile_id', pedido.user_id).single()
      const disponivel = Number(saldo?.pontos ?? 0)

      // Não pode descontar mais que o saldo nem mais que o valor do pedido (deixa ao menos R$0,01)
      const maxPorValor = Math.floor((baseTotal - 0.01) / valPonto)
      pontosUsados = Math.min(pontosUsados, disponivel, Math.max(0, maxPorValor))
      if (pontosUsados < minResg) pontosUsados = 0
      desconto = Math.round(pontosUsados * valPonto * 100) / 100
    } else {
      pontosUsados = 0
    }
    // Sem desconto: mantém exatamente o total enviado (não muda nada p/ bot e pedidos normais).
    // Com desconto por pontos: recalcula a cobrança a partir do subtotal+taxa-desconto.
    // IMPORTANTE: sempre arredondar a 2 casas — o Mercado Pago rejeita (400 "Invalid
    // transaction_amount") qualquer valor com 3+ casas decimais (ex.: 20.001).
    const totalCobrar = Math.round(
      (pontosUsados > 0
        ? Math.max(0.01, baseTotal - desconto)
        : Number(pedido.total ?? baseTotal)) * 100
    ) / 100

    // MP exige mínimo 30 min para PIX — nosso cron cancela internamente aos 5 min
    const expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    // Token da loja (marketplace) + comissão da plataforma. Fallback: conta central.
    const { token: mpToken, applicationFee } = await resolverContaMp(supabaseSrv, pedido.empresa_id, totalCobrar)

    // O Mercado Pago rejeita (400 "payer.email must be a valid email") qualquer e-mail
    // fora do formato. Se o e-mail do cliente vier vazio/inválido (ex.: telefone em branco
    // gerando "@wpp.vendamais.app"), usa um e-mail genérico válido — o PIX não depende dele.
    const emailInformado = String(pedido.payer_email ?? '').trim()
    const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInformado)
    const payerEmail = emailValido ? emailInformado : 'cliente@vendamais.app'

    const primeiroNome = (String(pedido.cliente_nome ?? '').trim().split(/\s+/)[0]) || 'Cliente'
    const sobrenome = (String(pedido.cliente_nome ?? '').trim().split(/\s+/).slice(1).join(' ')) || 'Cliente'

    const paymentBody: Record<string, unknown> = {
      transaction_amount: totalCobrar,
      description:        `Pedido ${pedido.empresa_nome ?? 'FWC Inter'}`,
      payment_method_id:  'pix',
      date_of_expiration: expiration,
      payer: {
        email:      payerEmail,
        first_name: primeiroNome,
        last_name:  sobrenome,
      },
      notification_url: WEBHOOK_URL,
    }
    // A comissão (application_fee) só vale com token obtido via OAuth (loja conectada).
    if (applicationFee > 0) paymentBody.application_fee = applicationFee

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization':    `Bearer ${mpToken}`,
        'Content-Type':     'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(paymentBody),
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
    const supabase = supabaseSrv

    const { data: order, error: dbErr } = await supabase
      .from('pedidos_delivery')
      .insert({
        empresa_id:            pedido.empresa_id,
        user_id:               pedido.user_id ?? null,
        cliente_id:            pedido.cliente_id ?? null,
        cliente_nome:          pedido.cliente_nome,
        cliente_telefone:      pedido.cliente_telefone,
        itens:                 pedido.itens,
        total:                 totalCobrar,
        subtotal:              pedido.subtotal,
        taxa_entrega:          pedido.taxa_entrega,
        desconto:              desconto,
        pontos_usados:         pontosUsados,
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
        // Estes 4 vinham no payload mas não eram repassados: pedido PIX nascia sem
        // estado/CEP e sem COORDENADA (o de dinheiro/cartão salvava tudo). Sem a
        // coordenada a rota do motoqueiro depende do Maps adivinhar o texto.
        endereco_estado:       pedido.endereco_estado ?? null,
        endereco_cep:          pedido.endereco_cep ?? null,
        endereco_lat:          pedido.endereco_lat ?? null,
        endereco_lng:          pedido.endereco_lng ?? null,
        observacoes:           pedido.observacoes ?? null,
        // Pedido agendado (mig 0222): o PIX é pago agora, a comida sai na hora
        // combinada. Sem isso o agendamento se perdia justamente em quem já pagou.
        agendado_para:         pedido.agendado_para ?? null,
        troco_para:            pedido.troco_para ?? null,
        codigo_entrega:        pedido.codigo_entrega,
        status:                'aguardando_pagamento',
        mp_payment_id:         String(mp_payment_id),
        mp_payment_status:     'pending',
        pix_expira_em:         new Date(Date.now() + 5 * 60 * 1000).toISOString(),
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
