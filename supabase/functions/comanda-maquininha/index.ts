import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { MP_API, tokenPoint, aplicarOrder, lerOrder, motivoLegivel } from '../_shared/mpPoint.ts'

// COMANDA-MAQUININHA (mig 0447) — cobrar a mesa na maquininha Point da loja.
//
// O garçom aperta "Cobrar na maquininha": isto manda o valor da conta pra Point
// (API Orders do Mercado Pago). O cliente paga na máquina e quem fecha a conta
// é o aviso do MP (mercadopago-webhook, evento "Order") — ou o "conferir" desta
// função, que a tela chama de 15 em 15 s como cinto de segurança. A tela nunca
// marca "pago" sozinha.
//
// Ações:
//   terminais → pergunta ao MP quais maquininhas a conta da loja tem e guarda
//   modo_pdv  → põe a maquininha no modo PDV (recebe cobrança do sistema; ela reinicia)
//   criar     → manda a cobrança pra maquininha
//   conferir  → pergunta ao MP como está a cobrança
//   cancelar  → tira a cobrança da tela da maquininha

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY')!

// Tempo que a cobrança fica esperando na maquininha. Passou disso sem pagar,
// o MP expira e a mesa volta a poder cobrar de novo.
const MINUTOS_NA_MAQUININHA = 10

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// deno-lint-ignore no-explicit-any
type SB = any

const SEM_CONEXAO = 'Esta loja ainda não conectou a maquininha do Mercado Pago. Conecte em Loja → Pagamento.'

// Mesma conta do comanda-pix: quanto a mesa deve, contado AQUI e não na tela.
async function valorDaComanda(sb: SB, comandaId: string, empresaId: string, aplicarTaxa: boolean) {
  const { data: itens } = await sb.from('comanda_itens')
    .select('preco_unitario, quantidade, isento_taxa').eq('comanda_id', comandaId)
  const soma = (lista: { preco_unitario: number; quantidade: number }[]) =>
    lista.reduce((s, i) => s + Number(i.preco_unitario ?? 0) * Number(i.quantidade ?? 1), 0)
  const subtotal = soma(itens ?? [])
  const base = soma((itens ?? []).filter((i: { isento_taxa?: boolean }) => i.isento_taxa !== true))
  const { data: emp } = await sb.from('empresas').select('taxa_servico_pct, nome').eq('id', empresaId).maybeSingle()
  const pct = Number(emp?.taxa_servico_pct ?? 0)
  const taxa = aplicarTaxa ? Math.round(base * pct / 100 * 100) / 100 : 0
  return { total: Math.round((subtotal + taxa) * 100) / 100, empresaNome: emp?.nome ?? 'Loja' }
}

// Quem chamou, e de que loja. A empresa vem do perfil, nunca do corpo da chamada.
async function quemChamou(sb: SB, sbUser: SB) {
  const { data: { user } } = await sbUser.auth.getUser()
  if (!user) return null
  const { data: p } = await sb.from('profiles').select('empresa_id, perfil').eq('id', user.id).maybeSingle()
  if (!p?.empresa_id) return null
  return { userId: user.id as string, empresaId: p.empresa_id as string, perfil: String(p.perfil ?? '') }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const auth = req.headers.get('Authorization') ?? ''
    if (!auth) return json({ error: 'Faça login de novo.' }, 401)

    const body = await req.json().catch(() => ({}))
    const acao = String(body.acao ?? '')

    const sbUser = createClient(SUPABASE_URL, SUPABASE_ANON, { global: { headers: { Authorization: auth } } })
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

    // ── Lista as maquininhas da conta MP da loja ────────────────────────────
    if (acao === 'terminais') {
      const eu = await quemChamou(sb, sbUser)
      if (!eu) return json({ error: 'Faça login de novo.' }, 401)
      const token = await tokenPoint(sb, eu.empresaId)
      if (!token) return json({ error: SEM_CONEXAO }, 400)

      const r = await fetch(`${MP_API}/terminals/v1/list?limit=50`, { headers: { Authorization: `Bearer ${token}` } })
      const out = await r.json().catch(() => ({}))
      if (!r.ok) {
        console.error('[point] terminais:', r.status, JSON.stringify(out))
        return json({ error: `O Mercado Pago não listou as maquininhas (${r.status}). ${out?.message ?? ''}`.trim() }, 400)
      }
      const lista = out?.data?.terminals ?? out?.terminals ?? []
      for (const t of lista) {
        const terminalId = String(t.id ?? '')
        if (!terminalId) continue
        const { data: ja } = await sb.from('maquininhas')
          .select('id, empresa_id').eq('provedor', 'mercadopago').eq('terminal_id', terminalId).maybeSingle()
        if (ja && ja.empresa_id !== eu.empresaId) {
          // A maquininha mudou de dono no MP (loja vendeu/emprestou): passa pra quem tem o token agora.
          await sb.from('maquininhas').update({ empresa_id: eu.empresaId, modo: t.operating_mode ?? null, ativa: true }).eq('id', ja.id)
        } else if (ja) {
          await sb.from('maquininhas').update({ modo: t.operating_mode ?? null }).eq('id', ja.id)
        } else {
          await sb.from('maquininhas').insert({
            empresa_id: eu.empresaId, provedor: 'mercadopago', terminal_id: terminalId,
            modo: t.operating_mode ?? null, ativa: true,
          })
        }
      }
      const { data: minhas } = await sb.from('maquininhas')
        .select('id, terminal_id, apelido, modo, ativa').eq('empresa_id', eu.empresaId).order('created_at')
      return json({ maquininhas: minhas ?? [], total_mp: lista.length })
    }

    // ── Liga o modo PDV (a maquininha passa a receber cobrança do sistema) ──
    if (acao === 'modo_pdv') {
      const eu = await quemChamou(sb, sbUser)
      if (!eu) return json({ error: 'Faça login de novo.' }, 401)
      if (!['admin', 'super_admin'].includes(eu.perfil)) return json({ error: 'Só o dono da loja muda o modo da maquininha.' }, 403)
      const { data: maq } = await sb.from('maquininhas')
        .select('id, terminal_id').eq('id', body.maquininha_id).eq('empresa_id', eu.empresaId).maybeSingle()
      if (!maq) return json({ error: 'Maquininha não encontrada.' }, 404)
      const token = await tokenPoint(sb, eu.empresaId)
      if (!token) return json({ error: SEM_CONEXAO }, 400)

      const modo = body.modo === 'STANDALONE' ? 'STANDALONE' : 'PDV'
      const r = await fetch(`${MP_API}/terminals/v1/setup`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminals: [{ id: maq.terminal_id, operating_mode: modo }] }),
      })
      const out = await r.json().catch(() => ({}))
      if (!r.ok) {
        console.error('[point] setup:', r.status, JSON.stringify(out))
        return json({ error: `O Mercado Pago não mudou o modo (${r.status}). ${out?.message ?? ''}`.trim() }, 400)
      }
      await sb.from('maquininhas').update({ modo }).eq('id', maq.id)
      return json({ ok: true, modo })
    }

    // ── Conferir: pergunta pro MP como está ─────────────────────────────────
    if (acao === 'conferir') {
      const { data: cob } = await sbUser.from('comanda_pix_cobrancas')
        .select('id, empresa_id, mp_order_id, status, canal').eq('id', body.cobranca_id).maybeSingle()
      if (!cob || cob.canal !== 'maquininha') return json({ error: 'Cobrança não encontrada.' }, 404)
      if (cob.status === 'pago') return json({ status: 'liquidado' })
      if (cob.status !== 'pendente') return json({ status: cob.status })

      const token = await tokenPoint(sb, cob.empresa_id)
      if (!token) return json({ error: SEM_CONEXAO }, 400)
      const { ok, order } = await lerOrder(token, cob.mp_order_id)
      if (!ok) return json({ status: 'pendente' })
      const res = await aplicarOrder(sb, cob, order)
      return json({ ...res, motivo: res.status === 'pendente' ? null : motivoLegivel(res.detalhe ?? '') })
    }

    // ── Cancelar: tira a cobrança da maquininha ─────────────────────────────
    if (acao === 'cancelar') {
      const { data: cob } = await sbUser.from('comanda_pix_cobrancas')
        .select('id, empresa_id, mp_order_id, status, canal').eq('id', body.cobranca_id).maybeSingle()
      if (!cob || cob.canal !== 'maquininha') return json({ error: 'Cobrança não encontrada.' }, 404)
      if (cob.status === 'pago') return json({ status: 'pago' })
      if (cob.status !== 'pendente') return json({ status: cob.status })

      const token = await tokenPoint(sb, cob.empresa_id)
      if (token) {
        const r = await fetch(`${MP_API}/v1/orders/${cob.mp_order_id}/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            'X-Idempotency-Key': crypto.randomUUID(),
            // Sem isto o MP não cancela o que já apareceu na tela da maquininha.
            'x-allow-cancelable-status': 'at_terminal',
          },
        })
        if (!r.ok) {
          // Não deixou cancelar: pode ser que o cliente acabou de pagar. Pergunta
          // antes de dizer que cancelou — senão a mesa fica aberta com o dinheiro
          // já na conta da loja.
          const { ok, order } = await lerOrder(token, cob.mp_order_id)
          if (ok) {
            const res = await aplicarOrder(sb, cob, order)
            if (res.status !== 'pendente') return json(res)
          }
          const txt = await r.text().catch(() => '')
          console.error('[point] cancel:', r.status, txt)
          return json({ error: 'A maquininha não deixou cancelar agora. Cancele direto nela (botão vermelho) e tente de novo.' }, 400)
        }
      }
      await sb.from('comanda_pix_cobrancas')
        .update({ status: 'cancelado', status_detalhe: 'canceled_by_api' })
        .eq('id', cob.id).eq('status', 'pendente')
      return json({ status: 'cancelado' })
    }

    // ── Criar: manda a conta pra maquininha ─────────────────────────────────
    if (acao === 'criar') {
      const comandaId = String(body.comanda_id ?? '')
      if (!comandaId) return json({ error: 'Comanda não informada.' }, 400)
      const aplicarTaxa = body.aplicar_taxa !== false

      // A RLS decide se quem chamou enxerga esta comanda (e esta maquininha).
      const { data: com } = await sbUser.from('comandas')
        .select('id, empresa_id, status, cliente_id, mesa_id').eq('id', comandaId).maybeSingle()
      if (!com) return json({ error: 'Comanda não encontrada.' }, 404)
      if (!['aberta', 'aguardando_conferencia'].includes(com.status)) return json({ error: 'Esta conta já foi fechada.' }, 400)

      const { data: maq } = await sbUser.from('maquininhas')
        .select('id, terminal_id, apelido, ativa, modo').eq('id', body.maquininha_id).maybeSingle()
      if (!maq || !maq.ativa) return json({ error: 'Escolha uma maquininha ativa.' }, 400)

      const token = await tokenPoint(sb, com.empresa_id)
      if (!token) return json({ error: SEM_CONEXAO }, 400)

      // A maquininha só faz uma cobrança por vez.
      const { data: ocupada } = await sb.from('comanda_pix_cobrancas')
        .select('id, comanda_id, valor, status, mp_order_id').eq('maquininha_id', maq.id).eq('status', 'pendente').maybeSingle()
      if (ocupada) {
        // Pode ser uma cobrança que já morreu na máquina e o aviso não chegou: confere antes de recusar.
        const { ok, order } = await lerOrder(token, ocupada.mp_order_id)
        const ainda = ok ? (await aplicarOrder(sb, ocupada, order)).status : 'pendente'
        if (ainda === 'pendente') {
          return json({
            error: ocupada.comanda_id === comandaId
              ? 'Esta mesa já está esperando o pagamento nessa maquininha.'
              : `A maquininha ${maq.apelido ? `"${maq.apelido}" ` : ''}está ocupada com a cobrança de outra mesa. Espere terminar ou cancele aquela.`,
          }, 409)
        }
      }

      const { total, empresaNome } = await valorDaComanda(sb, comandaId, com.empresa_id, aplicarTaxa)
      if (!(total > 0)) return json({ error: 'A conta está zerada.' }, 400)

      // O que já está aberto ou pago nesta mesa (PIX e maquininha somam juntos).
      const { data: jaTem } = await sb.from('comanda_pix_cobrancas')
        .select('valor').eq('comanda_id', comandaId).in('status', ['pendente', 'pago'])
      const jaCobrado = (jaTem ?? []).reduce((s: number, c: { valor: number }) => s + Number(c.valor ?? 0), 0)

      const pedido = Number(body.valor ?? 0)
      const valorCobrar = Math.round((pedido > 0 ? pedido : total - jaCobrado) * 100) / 100
      if (valorCobrar <= 0) return json({ error: 'Esta mesa já tem cobrança cobrindo a conta inteira.' }, 400)
      if (jaCobrado + valorCobrar > total + 0.05) {
        return json({
          error: `Passa do total: a conta é ${total.toFixed(2)} e já tem ${jaCobrado.toFixed(2)} cobrado. Cabe no máximo ${(total - jaCobrado).toFixed(2)}.`,
        }, 400)
      }

      let rotulo = 'Conta'
      if (com.mesa_id) {
        const { data: mesa } = await sb.from('mesas').select('numero').eq('id', com.mesa_id).maybeSingle()
        if (mesa?.numero != null) rotulo = `Mesa ${mesa.numero}`
      }

      const cobrancaId = crypto.randomUUID()
      const tipo = body.tipo === 'debito' ? 'debit_card' : body.tipo === 'credito' ? 'credit_card' : null
      const orderBody: Record<string, unknown> = {
        type: 'point',
        external_reference: cobrancaId,
        expiration_time: `PT${MINUTOS_NA_MAQUININHA}M`,
        description: `${rotulo} · ${empresaNome}`.slice(0, 150),
        transactions: { payments: [{ amount: valorCobrar.toFixed(2) }] },
        config: {
          point: { terminal_id: maq.terminal_id, print_on_terminal: 'no_ticket' },
          ...(tipo ? { payment_method: { default_type: tipo } } : {}),
        },
      }

      const r = await fetch(`${MP_API}/v1/orders`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'X-Idempotency-Key': cobrancaId,
        },
        body: JSON.stringify(orderBody),
      })
      const order = await r.json().catch(() => ({}))
      if (!r.ok || !order?.id) {
        console.error('[point] criar:', r.status, JSON.stringify(order))
        const msg = JSON.stringify(order).toLowerCase()
        if (msg.includes('pdv') || msg.includes('operating_mode') || msg.includes('standalone')) {
          return json({ error: 'A maquininha não está no modo PDV. O dono liga em Loja → Pagamento → Maquininha.' }, 400)
        }
        if (msg.includes('terminal') && msg.includes('busy')) {
          return json({ error: 'A maquininha está ocupada. Termine ou cancele o que está na tela dela.' }, 409)
        }
        return json({ error: `O Mercado Pago recusou a cobrança (${r.status}). ${order?.message ?? order?.errors?.[0]?.message ?? ''}`.trim() }, 400)
      }

      const expira = new Date(Date.now() + MINUTOS_NA_MAQUININHA * 60 * 1000)
      const parte = Number.isInteger(body?.parte) ? body.parte as number : null
      const { error: dbErr } = await sb.from('comanda_pix_cobrancas').insert({
        id:            cobrancaId,
        empresa_id:    com.empresa_id,
        comanda_id:    comandaId,
        valor:         valorCobrar,
        aplicar_taxa:  aplicarTaxa,
        cliente_id:    body.cliente_id ?? com.cliente_id ?? null,
        canal:         'maquininha',
        mp_order_id:   String(order.id),
        maquininha_id: maq.id,
        criada_por:    body.criada_por ?? null,
        parte,
        expira_em:     expira.toISOString(),
      })
      if (dbErr) {
        // A cobrança já está na maquininha e não ficou registrada: tira de lá,
        // senão o cliente paga uma conta que o sistema não conhece.
        console.error('[point] DB error:', dbErr.message)
        await fetch(`${MP_API}/v1/orders/${order.id}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'X-Idempotency-Key': crypto.randomUUID(), 'x-allow-cancelable-status': 'at_terminal' },
        }).catch(() => {})
        return json({ error: 'Não consegui registrar a cobrança. Tente de novo.' }, 500)
      }

      return json({
        cobranca_id: cobrancaId, canal: 'maquininha', valor: valorCobrar, total,
        maquininha: maq.apelido || maq.terminal_id, expira_em: expira.toISOString(),
      })
    }

    return json({ error: 'Ação inválida.' }, 400)
  } catch (e) {
    console.error('[point] inesperado:', e)
    return json({ error: String(e) }, 500)
  }
})
