// Conector Mercado Pago Point (mig 0447) — usado pelo comanda-maquininha e
// pelo mercadopago-webhook. Fica num lugar só porque as duas portas (o aviso
// do MP e o "conferir" da tela) têm que chegar à MESMA conclusão sobre uma order.
//
// O token aqui é o do app "FWC Inter Maquininha" (Point Platform), que é OUTRO
// app do Mercado Pago, não o do PIX. Ver mercadopago_point_contas.

// deno-lint-ignore no-explicit-any
type SB = any

export const MP_POINT_CLIENT_ID     = Deno.env.get('MP_POINT_CLIENT_ID') ?? '7353053578830333'
export const MP_POINT_CLIENT_SECRET = Deno.env.get('MP_POINT_CLIENT_SECRET') ?? ''

export const MP_API = 'https://api.mercadopago.com'

// Token da loja no app da maquininha, renovando se estiver perto de vencer.
export async function tokenPoint(sb: SB, empresaId: string): Promise<string | null> {
  const { data: conta } = await sb.from('mercadopago_point_contas')
    .select('access_token, refresh_token, expires_at').eq('empresa_id', empresaId).maybeSingle()
  if (!conta?.access_token) return null

  const expMs = conta.expires_at ? new Date(conta.expires_at).getTime() : 0
  if (!expMs || expMs > Date.now() + 60_000 || !conta.refresh_token) return conta.access_token

  const r = await fetch(`${MP_API}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: MP_POINT_CLIENT_ID, client_secret: MP_POINT_CLIENT_SECRET,
      grant_type: 'refresh_token', refresh_token: conta.refresh_token,
    }),
  })
  const tk = await r.json().catch(() => ({}))
  if (!r.ok || !tk.access_token) { console.error('[point] refresh falhou:', JSON.stringify(tk)); return conta.access_token }
  await sb.from('mercadopago_point_contas').update({
    access_token:  tk.access_token,
    refresh_token: tk.refresh_token ?? conta.refresh_token,
    expires_at:    new Date(Date.now() + Number(tk.expires_in ?? 15552000) * 1000).toISOString(),
    updated_at:    new Date().toISOString(),
  }).eq('empresa_id', empresaId)
  return tk.access_token
}

// Como o cliente pagou, no vocabulário do caixa do sistema.
// deno-lint-ignore no-explicit-any
export function formaDoOrder(order: any): string {
  const pg = order?.transactions?.payments?.[0] ?? {}
  const tipo = String(pg?.payment_method?.type ?? '').toLowerCase()
  const id   = String(pg?.payment_method?.id ?? '').toLowerCase()
  if (tipo.includes('debit') || id.startsWith('deb')) return 'debito'
  if (tipo.includes('credit')) return 'credito'
  if (tipo === 'qr' || tipo.includes('bank_transfer') || id === 'pix' || tipo === 'account_money') return 'pix'
  return 'cartao'
}

// Lê a order no MP e aplica o resultado na cobrança. Devolve o status no
// vocabulário da tela: 'pago' | 'liquidado' | 'pendente' | 'expirado' | 'cancelado'.
// deno-lint-ignore no-explicit-any
export async function aplicarOrder(sb: SB, cob: any, order: any): Promise<{ status: string; resultado?: unknown; detalhe?: string }> {
  const st = String(order?.status ?? '')
  const detalhe = String(order?.status_detail ?? '')

  if (st === 'processed') {
    if (cob.status === 'pago') return { status: 'liquidado' }
    const pg = order?.transactions?.payments?.[0]
    const { data: res, error } = await sb.rpc('confirmar_maquininha_comanda', {
      p_order_id: String(order.id), p_forma: formaDoOrder(order), p_payment_id: pg?.id ? String(pg.id) : null,
    })
    // Erro aqui = dinheiro aprovado e mesa que NÃO fechou. Tem que aparecer no log.
    if (error) console.error('[point] confirmar_maquininha_comanda:', error.message)
    else if (res && res.ok === false) console.error('[point] confirmar recusou:', JSON.stringify(res))
    return { status: 'pago', resultado: res }
  }

  if (['canceled', 'failed', 'expired', 'refunded'].includes(st)) {
    const novo = st === 'canceled' ? 'cancelado' : 'expirado'
    await sb.from('comanda_pix_cobrancas')
      .update({ status: novo, status_detalhe: detalhe || st })
      .eq('id', cob.id).eq('status', 'pendente')
    return { status: novo, detalhe: detalhe || st }
  }

  // created | at_terminal | action_required: a maquininha ainda está nisso.
  return { status: 'pendente', detalhe: st }
}

export async function lerOrder(token: string, orderId: string) {
  const r = await fetch(`${MP_API}/v1/orders/${orderId}`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, order: body }
}

// Motivo em português pra quem está na mesa. O MP responde em inglês técnico.
export function motivoLegivel(detalhe: string): string {
  const d = (detalhe || '').toLowerCase()
  if (d.includes('insufficient')) return 'Saldo/limite insuficiente no cartão.'
  if (d.includes('bad_filled') || d.includes('card_data')) return 'Dados do cartão não conferiram. Tente de novo.'
  if (d.includes('canceled_by_api')) return 'Cobrança cancelada pelo sistema.'
  if (d.includes('canceled') || d.includes('cancelled')) return 'Cancelada na maquininha.'
  if (d.includes('expired')) return 'O tempo da cobrança acabou na maquininha.'
  if (d.includes('rejected') || d.includes('failed')) return 'O pagamento foi recusado.'
  return detalhe ? `Não aprovado (${detalhe}).` : 'Não aprovado.'
}
