import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// COMANDA-PIX (mig 0193) — cobrança PIX da MESA, na conta do Mercado Pago DA LOJA.
//
// O garçom escolhe "PIX online" ao fechar a conta; isto gera a cobrança com o
// valor exato da comanda e devolve o QR. Quem fecha a conta é o
// mercadopago-webhook, quando o MP confirma que o dinheiro caiu — nunca a tela.
// Print de comprovante não fecha mesa aqui.
//
// Igual ao cliente-pix (fiado) e diferente do create-pix-payment (delivery):
// loja sem Mercado Pago conectado NÃO cobra. É dinheiro do freguês indo pra
// loja; sem a conta dela, não existe pra onde mandar.

const MP_CLIENT_ID     = Deno.env.get('MP_CLIENT_ID') ?? '736904729861760'
const MP_CLIENT_SECRET = Deno.env.get('MP_CLIENT_SECRET') ?? ''
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON    = Deno.env.get('SUPABASE_ANON_KEY')!
const WEBHOOK_URL      = `${SUPABASE_URL}/functions/v1/mercadopago-webhook`

// O PIX do MP tem mínimo de 30 min. Na mesa isso é bom: dá tempo do cliente
// procurar o app do banco sem o QR morrer na mão dele.
const MINUTOS_VALIDADE = 30

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// deno-lint-ignore no-explicit-any
type SB = any

// Token da loja, renovando pelo refresh_token se estiver perto de vencer.
async function tokenDaLoja(sb: SB, empresaId: string): Promise<string | null> {
  const { data: conta } = await sb.from('mercadopago_contas')
    .select('access_token, refresh_token, expires_at').eq('empresa_id', empresaId).maybeSingle()
  if (!conta?.access_token) return null

  const expMs = conta.expires_at ? new Date(conta.expires_at).getTime() : 0
  if (!expMs || expMs > Date.now() + 60_000 || !conta.refresh_token) return conta.access_token

  const r = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: MP_CLIENT_ID, client_secret: MP_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: conta.refresh_token,
    }),
  })
  const tk = await r.json()
  if (!r.ok || !tk.access_token) { console.error('MP refresh error:', JSON.stringify(tk)); return conta.access_token }
  await sb.from('mercadopago_contas').update({
    access_token:  tk.access_token,
    refresh_token: tk.refresh_token ?? conta.refresh_token,
    expires_at:    new Date(Date.now() + Number(tk.expires_in ?? 15552000) * 1000).toISOString(),
    updated_at:    new Date().toISOString(),
  }).eq('empresa_id', empresaId)
  return tk.access_token
}

// Quanto a mesa deve, contado AQUI e não na tela. A tela do garçom pode estar
// velha (item lançado noutro aparelho), e o QR precisa nascer com o valor certo.
// A taxa não pega item de categoria isenta — mesma regra da mig 0192.
async function valorDaComanda(sb: SB, comandaId: string, empresaId: string, aplicarTaxa: boolean) {
  const { data: itens } = await sb.from('comanda_itens')
    .select('preco_unitario, quantidade, isento_taxa').eq('comanda_id', comandaId)
  const soma = (lista: { preco_unitario: number; quantidade: number }[]) =>
    lista.reduce((s, i) => s + Number(i.preco_unitario ?? 0) * Number(i.quantidade ?? 1), 0)

  const subtotal = soma(itens ?? [])
  const base = soma((itens ?? []).filter((i: { isento_taxa?: boolean }) => i.isento_taxa !== true))

  const { data: emp } = await sb.from('empresas')
    .select('taxa_servico_pct, nome').eq('id', empresaId).maybeSingle()
  const pct = Number(emp?.taxa_servico_pct ?? 0)
  const taxa = aplicarTaxa ? Math.round(base * pct / 100 * 100) / 100 : 0

  // O MP recusa (400 "Invalid transaction_amount") valor com 3+ casas decimais.
  return { total: Math.round((subtotal + taxa) * 100) / 100, subtotal, taxa, empresaNome: emp?.nome ?? 'Loja' }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth) return json({ error: 'Faça login de novo pra cobrar no PIX.' }, 401)

    const body = await req.json()
    const acao = String(body.acao ?? 'criar')

    // Cliente COM o login de quem chamou: é a RLS que responde "esta comanda é
    // sua?". Sem isto, um token qualquer cobraria a mesa de outra loja.
    const sbUser = createClient(SUPABASE_URL, SUPABASE_ANON, { global: { headers: { Authorization: auth } } })
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

    // ── Conferir agora: pergunta o status direto pro MP ─────────────────────
    // O webhook é o caminho normal, mas ele pode atrasar (ou a loja estar num
    // wi-fi ruim). Este é o botão "já paguei" da tela, e o resultado é o mesmo:
    // quem fecha a conta é a RPC, com o MP tendo dito 'approved'.
    if (acao === 'conferir') {
      const { data: cob } = await sbUser.from('comanda_pix_cobrancas')
        .select('id, empresa_id, mp_payment_id, status, comanda_id').eq('id', body.cobranca_id).maybeSingle()
      if (!cob) return json({ error: 'Cobrança não encontrada.' }, 404)
      if (cob.status === 'pago') return json({ status: 'pago' })

      const token = await tokenDaLoja(sb, cob.empresa_id)
      if (!token) return json({ error: 'Mercado Pago não conectado.' }, 400)

      const r = await fetch(`https://api.mercadopago.com/v1/payments/${cob.mp_payment_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const pg = await r.json()
      if (pg.status === 'approved') {
        const { data: res } = await sb.rpc('confirmar_pix_comanda', { p_mp_payment_id: String(cob.mp_payment_id) })
        return json({ status: 'pago', resultado: res })
      }
      if (['cancelled', 'rejected', 'expired'].includes(pg.status)) {
        await sb.from('comanda_pix_cobrancas').update({ status: 'expirado' }).eq('id', cob.id).eq('status', 'pendente')
        return json({ status: 'expirado' })
      }
      return json({ status: 'pendente' })
    }

    // ── Cancelar: o cliente desistiu do PIX e vai pagar de outro jeito ──────
    if (acao === 'cancelar') {
      const { data: cob } = await sbUser.from('comanda_pix_cobrancas')
        .select('id, empresa_id, mp_payment_id, status').eq('id', body.cobranca_id).maybeSingle()
      if (!cob) return json({ error: 'Cobrança não encontrada.' }, 404)
      if (cob.status === 'pago') return json({ status: 'pago' })

      // Cancela também no MP: QR vivo é QR que alguém ainda pode pagar depois,
      // e aí entra dinheiro sem conta aberta pra receber.
      const token = await tokenDaLoja(sb, cob.empresa_id)
      if (token) {
        await fetch(`https://api.mercadopago.com/v1/payments/${cob.mp_payment_id}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'cancelled' }),
        }).catch(() => { /* se o MP não deixar, a cobrança expira sozinha em 30 min */ })
      }
      await sb.from('comanda_pix_cobrancas').update({ status: 'cancelado' }).eq('id', cob.id).eq('status', 'pendente')
      return json({ status: 'cancelado' })
    }

    // ── Criar a cobrança ───────────────────────────────────────────────────
    const comandaId = String(body.comanda_id ?? '')
    if (!comandaId) return json({ error: 'Comanda não informada.' }, 400)
    const aplicarTaxa = body.aplicar_taxa !== false

    // A RLS decide se quem chamou enxerga esta comanda.
    const { data: com } = await sbUser.from('comandas')
      .select('id, empresa_id, status, cliente_id').eq('id', comandaId).maybeSingle()
    if (!com) return json({ error: 'Comanda não encontrada.' }, 404)
    if (!['aberta', 'aguardando_conferencia'].includes(com.status)) {
      return json({ error: 'Esta conta já foi fechada.' }, 400)
    }

    const token = await tokenDaLoja(sb, com.empresa_id)
    if (!token) {
      return json({ error: 'Esta loja ainda não conectou o Mercado Pago. Conecte em Loja → Pagamento pra cobrar no PIX online.' }, 400)
    }

    const { total, subtotal, taxa, empresaNome } = await valorDaComanda(sb, comandaId, com.empresa_id, aplicarTaxa)
    if (!(total > 0)) return json({ error: 'A conta está zerada.' }, 400)

    // O que já está aberto ou pago nesta mesa. Na conta dividida cada pessoa tem
    // o seu QR (mig 0195), então o que limita não é "um por mesa" — é a soma não
    // passar do total. Cobrar a mais é a loja devolvendo dinheiro depois.
    const { data: jaTem } = await sb.from('comanda_pix_cobrancas')
      .select('id, valor, qr_code, qr_base64, expira_em, status')
      .eq('comanda_id', comandaId).in('status', ['pendente', 'pago'])
    const jaCobrado = (jaTem ?? []).reduce((soma: number, c: { valor: number }) => soma + Number(c.valor ?? 0), 0)

    // Sem valor informado = cobrar o que falta (o caso normal, conta inteira).
    const pedido = Number(body.valor ?? 0)
    const valorCobrar = Math.round((pedido > 0 ? pedido : total - jaCobrado) * 100) / 100

    if (valorCobrar <= 0) {
      return json({ error: 'Esta mesa já tem PIX cobrindo a conta inteira.' }, 400)
    }
    if (jaCobrado + valorCobrar > total + 0.05) {
      return json({
        error: `Passa do total: a conta é ${total.toFixed(2)} e já tem ${jaCobrado.toFixed(2)} em PIX. Cabe no máximo ${(total - jaCobrado).toFixed(2)}.`,
      }, 400)
    }

    // Mesma pessoa, mesmo valor, QR ainda vivo: devolve o que já existe em vez de
    // criar outro. É o toque repetido no botão — e dois QR iguais é a mesa
    // pagando duas vezes.
    const igual = (jaTem ?? []).find((c: { status: string; valor: number }) =>
      c.status === 'pendente' && Math.abs(Number(c.valor) - valorCobrar) < 0.005)
    if (igual) {
      return json({
        cobranca_id: igual.id, valor: Number(igual.valor),
        qr_code: igual.qr_code, qr_base64: igual.qr_base64, expira_em: igual.expira_em, reaproveitada: true,
      })
    }

    const expira = new Date(Date.now() + MINUTOS_VALIDADE * 60 * 1000)

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        transaction_amount: valorCobrar,
        description: `Mesa · ${empresaNome}`,
        payment_method_id: 'pix',
        date_of_expiration: expira.toISOString(),
        payer: { email: 'cliente@fwcinter.com', first_name: 'Cliente', last_name: 'Mesa' },
        notification_url: WEBHOOK_URL,
      }),
    })
    const mp = await mpRes.json()
    if (!mpRes.ok) {
      console.error('MP error:', JSON.stringify(mp))
      return json({ error: mp.message ?? 'O Mercado Pago recusou a cobrança.' }, 400)
    }

    const td = mp.point_of_interaction?.transaction_data ?? {}
    const { data: cob, error: dbErr } = await sb.from('comanda_pix_cobrancas').insert({
      empresa_id:    com.empresa_id,
      comanda_id:    comandaId,
      valor:         valorCobrar,
      aplicar_taxa:  aplicarTaxa,
      cliente_id:    body.cliente_id ?? com.cliente_id ?? null,
      mp_payment_id: String(mp.id),
      qr_code:       td.qr_code ?? null,
      qr_base64:     td.qr_code_base64 ?? null,
      criada_por:    body.criada_por ?? null,
      expira_em:     expira.toISOString(),
    }).select('id').single()

    if (dbErr) {
      console.error('DB error:', dbErr.message)
      return json({ error: dbErr.message }, 500)
    }

    return json({
      cobranca_id: cob.id, valor: valorCobrar, total, subtotal, taxa,
      qr_code: td.qr_code, qr_base64: td.qr_code_base64, expira_em: expira.toISOString(),
    })
  } catch (e) {
    console.error('Unexpected error:', e)
    return json({ error: String(e) }, 500)
  }
})
