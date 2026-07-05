import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── PIX de SAÍDA via Efí (ex-Gerencianet) — pagar copia-e-cola / enviar chave ──
// Auth: Basic base64(clientId:clientSecret) + mTLS (certificado .p12 -> cert/key
// PEM em base64 nos secrets). Os endpoints Pix da Efí exigem o certificado.
const EFI_CLIENT_ID     = Deno.env.get('EFI_CLIENT_ID')!
const EFI_CLIENT_SECRET = Deno.env.get('EFI_CLIENT_SECRET')!
const EFI_CERT_B64      = Deno.env.get('EFI_CERT_B64')!
const EFI_KEY_B64       = Deno.env.get('EFI_KEY_B64')!
const EFI_ENV           = Deno.env.get('EFI_ENV') ?? 'homologacao'  // 'homologacao' | 'producao'
const EFI_CHAVE_PAGADOR = Deno.env.get('EFI_PIX_CHAVE_PAGADOR') ?? '' // chave Pix da conta que paga

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const BASE = EFI_ENV === 'producao'
  ? 'https://pix.api.efipay.com.br'
  : 'https://pix-h.api.efipay.com.br'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function b64ToStr(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
}

// Cliente HTTP com mTLS (certificado do cliente) — exigido pela API Pix da Efí.
const mtls = Deno.createHttpClient({ cert: b64ToStr(EFI_CERT_B64), key: b64ToStr(EFI_KEY_B64) })

// ─── 1. OAuth (Basic + mTLS) ────────────────────────────────────────────────
async function getToken(): Promise<string> {
  const auth = btoa(`${EFI_CLIENT_ID}:${EFI_CLIENT_SECRET}`)
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST', client: mtls,
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Efí auth (${res.status}): ${JSON.stringify(data)}`)
  return data.access_token
}

// idEnvio: alfanumérico, até 35 chars.
function novoIdEnvio(): string { return 'crm' + crypto.randomUUID().replace(/-/g, '') }

// ─── 2a. Pagar QR Code / copia-e-cola ───────────────────────────────────────
async function pagarCopiaCola(token: string, emv: string, info: string) {
  const id = novoIdEnvio()
  const payload: Record<string, unknown> = { pixCopiaECola: emv }
  if (EFI_CHAVE_PAGADOR) payload.pagador = { chave: EFI_CHAVE_PAGADOR, infoPagador: (info || 'Pagamento CRM').slice(0, 140) }
  const res = await fetch(`${BASE}/v2/gn/pix/${id}/qrcode`, {
    method: 'PUT', client: mtls,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Efí pagar QR (${res.status}): ${JSON.stringify(data)}`)
  return { id: data.idEnvio ?? id, e2e: data.e2eId ?? null, status: data.status ?? 'EM_PROCESSAMENTO' }
}

// ─── 2b. Enviar Pix para uma chave ──────────────────────────────────────────
async function enviarChave(token: string, chave: string, valor: number, info: string) {
  if (!EFI_CHAVE_PAGADOR) throw new Error('Configure a chave Pix pagadora (EFI_PIX_CHAVE_PAGADOR) para enviar por chave.')
  const id = novoIdEnvio()
  const payload = {
    valor: Number(valor).toFixed(2),
    pagador: { chave: EFI_CHAVE_PAGADOR, infoPagador: (info || 'Pagamento CRM').slice(0, 140) },
    favorecido: { chave },
  }
  const res = await fetch(`${BASE}/v3/gn/pix/${id}`, {
    method: 'PUT', client: mtls,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`Efí enviar (${res.status}): ${JSON.stringify(data)}`)
  return { id: data.idEnvio ?? id, e2e: data.e2eId ?? null, status: data.status ?? 'EM_PROCESSAMENTO' }
}

function addDays(date: string, days: number) { const d = new Date(date); d.setDate(d.getDate() + days); return d.toISOString().split('T')[0] }
function addMonths(date: string, months: number) { const d = new Date(date); d.setMonth(d.getMonth() + months); return d.toISOString().split('T')[0] }
function proximoVencimento(data: string, rec: string): string | null {
  if (rec === 'semanal') return addDays(data, 7)
  if (rec === 'quinzenal') return addDays(data, 15)
  if (rec === 'mensal') return addMonths(data, 1)
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json()
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const now = new Date().toISOString()

    const token = await getToken()

    // ── Teste de conexão (não move dinheiro) ──────────────────────────────
    if (body.test) {
      let scopes: string[] = []
      try { scopes = JSON.parse(atob(token.split('.')[1])).scopes ?? [] } catch (_e) { /* jwt opaco */ }
      return new Response(JSON.stringify({ ok: true, env: EFI_ENV, autenticado: true, scopes }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // ── Segurança: só super_admin movimenta dinheiro ──────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    const sbUser = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } })
    const { data: { user: caller } } = await sbUser.auth.getUser()
    if (!caller) throw new Error('Não autorizado.')
    const { data: callerProf } = await supabase.from('profiles').select('perfil').eq('id', caller.id).single()
    if (callerProf?.perfil !== 'super_admin') throw new Error('Apenas super_admin pode realizar pagamentos.')

    let amount: number, destinatarioNome: string, descricao: string | null
    let forma: string, pixChave: string | null = null, pixCopiaCola: string | null = null

    if (body.direct) {
      amount = Number(body.valor)
      destinatarioNome = (body.destinatario_nome ?? '').trim() || 'N/A'
      descricao = body.descricao || null
      forma = body.forma
      if (forma === 'pix_chave') pixChave = String(body.pix_chave ?? '').trim()
      else pixCopiaCola = String(body.pix_copia_cola ?? '').trim()
    } else {
      const { data: pag, error } = await supabase.from('pagamentos_saas').select('*').eq('id', body.pagamento_id).single()
      if (error || !pag) throw new Error('Pagamento não encontrado.')
      if (pag.status === 'pago') throw new Error('Este pagamento já foi pago.')
      amount = Number(pag.valor)
      destinatarioNome = pag.destinatario_nome
      descricao = pag.descricao
      forma = pag.forma_pagamento
      pixChave = pag.pix_chave
      pixCopiaCola = pag.pix_copia_cola
    }

    const info = `${descricao ?? 'Pagamento'} - ${destinatarioNome}`
    const r = forma === 'pix_chave'
      ? await enviarChave(token, pixChave!, amount, info)
      : await pagarCopiaCola(token, pixCopiaCola!, info)
    const transferId = r.id
    const obsExtra = `Pago via Efí. ID: ${transferId} | e2e: ${r.e2e ?? '-'} | status: ${r.status}`

    if (body.direct) {
      await supabase.from('pagamentos_saas').insert({
        destinatario_tipo: 'fornecedor', destinatario_nome: destinatarioNome,
        forma_pagamento: forma,
        pix_tipo_chave: forma === 'pix_chave' ? body.pix_tipo_chave : null,
        pix_chave: forma === 'pix_chave' ? pixChave : null,
        pix_copia_cola: forma === 'pix_copia_cola' ? pixCopiaCola : null,
        valor: amount, descricao, data_vencimento: now.split('T')[0],
        recorrencia: 'unico', status: 'pago', pago_em: now, observacoes: obsExtra,
      })
    } else {
      const { data: pag } = await supabase.from('pagamentos_saas').select('*').eq('id', body.pagamento_id).single()
      await supabase.from('pagamentos_saas').update({
        status: 'pago', pago_em: now,
        observacoes: pag?.observacoes ? `${pag.observacoes}\n${obsExtra}` : obsExtra,
      }).eq('id', body.pagamento_id)
      if (pag && pag.recorrencia !== 'unico') {
        const prox = proximoVencimento(pag.data_vencimento, pag.recorrencia)
        if (prox) {
          await supabase.from('pagamentos_saas').insert({
            destinatario_tipo: pag.destinatario_tipo, empresa_id: pag.empresa_id,
            destinatario_nome: pag.destinatario_nome, forma_pagamento: pag.forma_pagamento,
            pix_tipo_chave: pag.pix_tipo_chave, pix_chave: pag.pix_chave,
            pix_copia_cola: pag.pix_copia_cola, banco: pag.banco,
            valor: pag.valor, descricao: pag.descricao, data_vencimento: prox,
            recorrencia: pag.recorrencia, observacoes: pag.observacoes,
            status: 'pendente', origem_id: pag.id,
          })
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, transfer_id: transferId, status: r.status }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
