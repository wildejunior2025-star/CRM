import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Credenciais (setar via: npx supabase secrets set CELCOIN_CLIENT_ID=xxx ...) ───
const CELCOIN_CLIENT_ID     = Deno.env.get('CELCOIN_CLIENT_ID')!
const CELCOIN_CLIENT_SECRET = Deno.env.get('CELCOIN_CLIENT_SECRET')!
const CELCOIN_ACCOUNT       = Deno.env.get('CELCOIN_ACCOUNT')!   // número da conta no Celcoin
const CELCOIN_ENV           = Deno.env.get('CELCOIN_ENV') ?? 'sandbox' // 'sandbox' | 'production'

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const BASE = CELCOIN_ENV === 'production'
  ? 'https://openfinance.celcoin.dev'
  : 'https://sandbox.openfinance.celcoin.dev'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─── 1. OAuth 2.0 — pega token ───────────────────────────────────────────────
async function getToken(): Promise<string> {
  const res = await fetch(`${BASE}/v5/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     CELCOIN_CLIENT_ID,
      client_secret: CELCOIN_CLIENT_SECRET,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Celcoin auth: ${data.error_description ?? data.error ?? JSON.stringify(data)}`)
  return data.access_token
}

// ─── 2. Decodifica código EMV (copia e cola) ─────────────────────────────────
async function decodeEMV(token: string, emv: string) {
  const res = await fetch(`${BASE}/pix/v1/emv/full`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emv }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Celcoin EMV: ${data.error?.message ?? JSON.stringify(data)}`)
  // body: { type: 'IMMEDIATE'|'STATIC'|'DUEDATE', key, transactionIdentification, amount: { final } }
  return data.body
}

// ─── 3. Consulta DICT — obtém endToEndId, banco (ISPB) e nome ────────────────
async function queryDICT(token: string, pixKey: string) {
  const url = `${BASE}/baas/v2/pix/dict/entry/external/${CELCOIN_ACCOUNT}?key=${encodeURIComponent(pixKey)}`
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Celcoin DICT: ${data.error?.message ?? JSON.stringify(data)}`)
  // body: { endtoEndId, account: { participant (ISPB), account, branch, accountType }, owner: { name } }
  return data.body
}

// ─── 4. Executa o pagamento ───────────────────────────────────────────────────
async function executePayment(token: string, payload: Record<string, unknown>) {
  const res = await fetch(`${BASE}/baas/v2/pix/payment`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Celcoin payment: ${data.error?.message ?? JSON.stringify(data)}`)
  return data // { status: 'PROCESSING', body: { id, endToEndId, ... } }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function addDays(date: string, days: number) {
  const d = new Date(date); d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}
function addMonths(date: string, months: number) {
  const d = new Date(date); d.setMonth(d.getMonth() + months)
  return d.toISOString().split('T')[0]
}
function proximoVencimento(data: string, rec: string): string | null {
  if (rec === 'semanal')   return addDays(data, 7)
  if (rec === 'quinzenal') return addDays(data, 15)
  if (rec === 'mensal')    return addMonths(data, 1)
  return null
}

const TIPO_CHAVE_MAP: Record<string, string> = {
  'CPF':             'CPF',
  'CNPJ':            'CNPJ',
  'E-mail':          'EMAIL',
  'Telefone':        'PHONE',
  'Chave aleatória': 'EVP',
}

// ─── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json()
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const now = new Date().toISOString()
    const clientCode = crypto.randomUUID().replace(/-/g, '').slice(0, 30)

    // ── Pega token Celcoin ──────────────────────────────────────────────────
    const token = await getToken()

    let pixKey: string
    let initiationType: string
    let transactionIdentification: string | null = null
    let amount: number
    let destinatarioNome: string
    let descricao: string | null

    // ── MODO DIRETO (sem agendamento) ───────────────────────────────────────
    if (body.direct) {
      amount         = Number(body.valor)
      destinatarioNome = (body.destinatario_nome ?? '').trim() || 'N/A'
      descricao      = body.descricao || null

      if (body.forma === 'pix_chave') {
        pixKey         = body.pix_chave.trim()
        initiationType = 'DICT'

      } else {
        // copia e cola → decodifica EMV via Celcoin
        const emvData = await decodeEMV(token, body.pix_copia_cola.trim())
        pixKey                  = emvData.key
        transactionIdentification = emvData.transactionIdentification
        // usa amount do QR se não tiver digitado (ou usa o digitado como override)
        if (!amount && emvData.amount?.final) amount = emvData.amount.final
        initiationType = emvData.type === 'STATIC' ? 'STATIC_QRCODE' : 'DYNAMIC_QRCODE'
      }

    // ── MODO AGENDADO (pagamento_id) ────────────────────────────────────────
    } else {
      const { data: pag, error: pagErr } = await supabase
        .from('pagamentos_saas').select('*').eq('id', body.pagamento_id).single()

      if (pagErr || !pag) throw new Error('Pagamento não encontrado.')
      if (pag.status === 'pago') throw new Error('Este pagamento já foi pago.')

      amount           = Number(pag.valor)
      destinatarioNome = pag.destinatario_nome
      descricao        = pag.descricao

      if (pag.forma_pagamento === 'pix_chave') {
        pixKey         = pag.pix_chave.trim()
        initiationType = 'DICT'

      } else if (pag.forma_pagamento === 'pix_copia_cola') {
        const emvData = await decodeEMV(token, pag.pix_copia_cola.trim())
        pixKey                  = emvData.key
        transactionIdentification = emvData.transactionIdentification
        initiationType = emvData.type === 'STATIC' ? 'STATIC_QRCODE' : 'DYNAMIC_QRCODE'

      } else {
        throw new Error('Forma de pagamento não suportada para pagamento automático.')
      }
    }

    // ── Consulta DICT → endToEndId + info do banco destino ─────────────────
    const dict = await queryDICT(token, pixKey)
    const endToEndId = dict.endtoEndId
    const bankISPB   = dict.account?.participant ?? ''
    const recipientName = dict.owner?.name ?? destinatarioNome

    // ── Monta payload do pagamento ──────────────────────────────────────────
    const paymentPayload: Record<string, unknown> = {
      amount,
      clientCode,
      endToEndId,
      initiationType,
      paymentType:     'IMMEDIATE',
      urgency:         'HIGH',
      transactionType: 'TRANSFER',
      debitParty: { account: CELCOIN_ACCOUNT },
      creditParty: {
        bank: bankISPB,
        key:  pixKey,
        name: recipientName,
      },
      remittanceInformation: (descricao ?? 'Pagamento via CRM').slice(0, 140),
    }

    if (transactionIdentification) {
      paymentPayload.transactionIdentification = transactionIdentification
    }

    // ── Executa pagamento ───────────────────────────────────────────────────
    const result = await executePayment(token, paymentPayload)
    const transferId = result.body?.id ?? result.body?.endToEndId ?? clientCode
    const obsExtra   = `Pago via Celcoin. ID: ${transferId}`

    // ── Salva no histórico ──────────────────────────────────────────────────
    if (body.direct) {
      await supabase.from('pagamentos_saas').insert({
        destinatario_tipo: 'fornecedor',
        destinatario_nome: destinatarioNome,
        forma_pagamento:   body.forma,
        pix_tipo_chave:    body.forma === 'pix_chave' ? body.pix_tipo_chave : null,
        pix_chave:         body.forma === 'pix_chave' ? body.pix_chave : null,
        pix_copia_cola:    body.forma === 'pix_copia_cola' ? body.pix_copia_cola : null,
        valor:             amount,
        descricao:         descricao,
        data_vencimento:   now.split('T')[0],
        recorrencia:       'unico',
        status:            'pago',
        pago_em:           now,
        observacoes:       obsExtra,
      })
    } else {
      const { data: pag } = await supabase
        .from('pagamentos_saas').select('*').eq('id', body.pagamento_id).single()

      await supabase.from('pagamentos_saas').update({
        status:      'pago',
        pago_em:     now,
        observacoes: pag?.observacoes ? `${pag.observacoes}\n${obsExtra}` : obsExtra,
      }).eq('id', body.pagamento_id)

      // Cria próxima parcela se recorrente
      if (pag && pag.recorrencia !== 'unico') {
        const proxData = proximoVencimento(pag.data_vencimento, pag.recorrencia)
        if (proxData) {
          await supabase.from('pagamentos_saas').insert({
            destinatario_tipo: pag.destinatario_tipo, empresa_id: pag.empresa_id,
            destinatario_nome: pag.destinatario_nome, forma_pagamento: pag.forma_pagamento,
            pix_tipo_chave:    pag.pix_tipo_chave,    pix_chave:       pag.pix_chave,
            pix_copia_cola:    pag.pix_copia_cola,    banco:           pag.banco,
            valor:             pag.valor,              descricao:       pag.descricao,
            data_vencimento:   proxData,               recorrencia:     pag.recorrencia,
            observacoes:       pag.observacoes,        status:          'pendente',
            origem_id:         pag.id,
          })
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, transfer_id: transferId, status: result.status }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
