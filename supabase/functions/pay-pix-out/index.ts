import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function parseEMVFields(code: string): Record<string, string> {
  const result: Record<string, string> = {}
  let pos = 0
  while (pos + 4 <= code.length) {
    const id = code.substring(pos, pos + 2)
    const len = parseInt(code.substring(pos + 2, pos + 4), 10)
    if (isNaN(len) || pos + 4 + len > code.length) break
    result[id] = code.substring(pos + 4, pos + 4 + len)
    pos += 4 + len
  }
  return result
}

function detectPixKeyType(key: string): string {
  if (key.includes('@')) return 'email'
  if (/^\+55\d{10,11}$/.test(key)) return 'phone'
  const digits = key.replace(/\D/g, '')
  if (digits.length === 11) return 'cpf'
  if (digits.length === 14) return 'cnpj'
  return 'random_code'
}

function extractPixFromEMV(emvCode: string): { key: string; keyType: string; merchantName?: string; amount?: number } | null {
  const fields = parseEMVFields(emvCode)
  // Field 26 = Merchant Account Information (PIX)
  const mai = fields['26']
  if (!mai) return null
  const maiFields = parseEMVFields(mai)
  const key = maiFields['01']
  if (!key) return null
  return {
    key,
    keyType: detectPixKeyType(key),
    merchantName: fields['59'],
    amount: fields['54'] ? parseFloat(fields['54']) : undefined,
  }
}

function addDays(date: string, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}
function addMonths(date: string, months: number) {
  const d = new Date(date)
  d.setMonth(d.getMonth() + months)
  return d.toISOString().split('T')[0]
}
function proximoVencimento(data: string, recorrencia: string): string | null {
  if (recorrencia === 'semanal')   return addDays(data, 7)
  if (recorrencia === 'quinzenal') return addDays(data, 15)
  if (recorrencia === 'mensal')    return addMonths(data, 1)
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { pagamento_id } = await req.json()
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: pag, error: pagErr } = await supabase
      .from('pagamentos_saas')
      .select('*')
      .eq('id', pagamento_id)
      .single()

    if (pagErr || !pag) throw new Error('Pagamento não encontrado.')
    if (pag.status === 'pago') throw new Error('Este pagamento já foi pago.')

    let pixKey: string
    let pixKeyType: string

    if (pag.forma_pagamento === 'pix_chave') {
      if (!pag.pix_chave) throw new Error('Chave PIX não informada.')
      pixKey = pag.pix_chave.trim()
      const typeMap: Record<string, string> = {
        'CPF': 'cpf',
        'CNPJ': 'cnpj',
        'E-mail': 'email',
        'Telefone': 'phone',
        'Chave aleatória': 'random_code',
      }
      pixKeyType = typeMap[pag.pix_tipo_chave ?? ''] ?? 'random_code'

    } else if (pag.forma_pagamento === 'pix_copia_cola') {
      if (!pag.pix_copia_cola) throw new Error('Código PIX não informado.')
      const parsed = extractPixFromEMV(pag.pix_copia_cola.trim())
      if (!parsed) {
        throw new Error(
          'Não foi possível extrair a chave PIX do código copia-e-cola. ' +
          'Cadastre o pagamento usando "PIX — Chave" para pagar automaticamente.'
        )
      }
      pixKey = parsed.key
      pixKeyType = parsed.keyType
    } else {
      throw new Error('Forma de pagamento não suportada para pagamento automático.')
    }

    // Enviar via Mercado Pago Transfers API
    const mpRes = await fetch('https://api.mercadopago.com/v1/transfers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        amount: Number(pag.valor),
        currency_id: 'BRL',
        receiver: {
          type: 'bank_account',
          bank_account: {
            pix: {
              type: pixKeyType,
              value: pixKey,
            },
          },
        },
      }),
    })

    const mpData = await mpRes.json()

    if (!mpRes.ok) {
      const msg = mpData?.message ?? mpData?.error ?? `Erro Mercado Pago (${mpRes.status})`
      throw new Error(msg)
    }

    const now = new Date().toISOString()
    const transferId = mpData.id ?? mpData.transfer_id ?? '?'
    const obsExtra = `Pago via MP. Transfer ID: ${transferId}`

    await supabase.from('pagamentos_saas').update({
      status: 'pago',
      pago_em: now,
      observacoes: pag.observacoes ? `${pag.observacoes}\n${obsExtra}` : obsExtra,
    }).eq('id', pagamento_id)

    // Cria próxima parcela se recorrente
    if (pag.recorrencia !== 'unico') {
      const proxData = proximoVencimento(pag.data_vencimento, pag.recorrencia)
      if (proxData) {
        await supabase.from('pagamentos_saas').insert({
          destinatario_tipo:  pag.destinatario_tipo,
          empresa_id:         pag.empresa_id,
          destinatario_nome:  pag.destinatario_nome,
          forma_pagamento:    pag.forma_pagamento,
          pix_tipo_chave:     pag.pix_tipo_chave,
          pix_chave:          pag.pix_chave,
          pix_copia_cola:     pag.pix_copia_cola,
          banco:              pag.banco,
          valor:              pag.valor,
          descricao:          pag.descricao,
          data_vencimento:    proxData,
          recorrencia:        pag.recorrencia,
          observacoes:        pag.observacoes,
          status:             'pendente',
          origem_id:          pag.id,
        })
      }
    }

    return new Response(JSON.stringify({ ok: true, transfer_id: transferId }), {
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
