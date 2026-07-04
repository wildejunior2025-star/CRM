import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtData = d => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
const LABEL_TIPO = { recarga_pix: 'PIX', recarga_cartao: 'Cartão', auto_recarga: 'Auto (cartão)', manual: 'Manual' }
const CifraTipo = tipo => tipo === 'recarga_pix' ? '#16a34a' : tipo === 'manual' ? '#6b7280' : '#3b82f6'
const FundoTipo = tipo => tipo === 'recarga_pix' ? 'rgba(37,211,102,.15)' : tipo === 'manual' ? 'rgba(107,114,128,.15)' : 'rgba(59,130,246,.15)'

const PERIODOS = [
  { label: 'Este mês',    valor: 'mes_atual' },
  { label: 'Mês passado', valor: 'mes_passado' },
  { label: '90 dias',     valor: '90d' },
  { label: 'Total',       valor: 'total' },
]

function getDateRange(periodo) {
  const now = new Date()
  if (periodo === 'mes_atual') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), end: null }
  }
  if (periodo === 'mes_passado') {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
      end:   new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    }
  }
  if (periodo === '90d') {
    return { start: new Date(Date.now() - 90 * 86400000).toISOString(), end: null }
  }
  return { start: null, end: null }
}

function Card({ label, valor, sub, cor, destaque }) {
  return (
    <div style={{
      background: destaque ? (cor || 'var(--primary)') : 'var(--card)',
      color: destaque ? '#fff' : 'var(--text)',
      border: destaque ? 'none' : '1px solid var(--border)',
      borderLeft: !destaque && cor ? `4px solid ${cor}` : undefined,
      borderRadius: 12, padding: '18px 20px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, opacity: destaque ? 0.8 : 1, color: destaque ? 'inherit' : 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 900 }}>{fmt(valor)}</div>
      {sub && <div style={{ fontSize: 12, marginTop: 4, opacity: 0.7 }}>{sub}</div>}
    </div>
  )
}

function Row({ label, valor, detalhe, cor, negativo }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{negativo ? '− ' : ''}{label}</span>
        {detalhe && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>· {detalhe}</span>}
      </div>
      <span style={{ fontWeight: 700, fontSize: 14, color: negativo ? 'var(--text)' : (cor || 'var(--primary)') }}>
        {negativo ? '−' : ''}{fmt(valor)}
      </span>
    </div>
  )
}

function RowDetalhe({ label, detalhe, total, pago, pendente, negativo }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{negativo ? '− ' : ''}{label}</span>
          {detalhe && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>· {detalhe}</span>}
        </div>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{negativo ? '−' : ''}{fmt(total)}</span>
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 5, paddingLeft: 2 }}>
        <span style={{ fontSize: 11, color: 'var(--warning)' }}>Pendente: {fmt(pendente)}</span>
        <span style={{ fontSize: 11, color: 'var(--success)' }}>Pago: {fmt(pago)}</span>
      </div>
    </div>
  )
}

export default function SuperAdminFinanceiro() {
  const [periodo, setPeriodo]       = useState('mes_atual')
  const [mrr, setMrr]               = useState(null)
  const [dados, setDados]           = useState(null)
  const [custoInput, setCustoInput] = useState('650')
  const [loading, setLoading]       = useState(true)

  async function load() {
    setLoading(true)
    const { start, end } = getDateRange(periodo)

    function applyDates(q) {
      if (start) q = q.gte('created_at', start)
      if (end)   q = q.lt('created_at', end)
      return q
    }

    const [empresasRes, cfgRes, creditosRes, vendasRes, mlmRes] = await Promise.all([
      supabase.from('empresas').select('status, valor_mensalidade'),
      supabase.from('configuracoes_plataforma').select('chave, valor')
        .in('chave', [
          'taxa_plataforma_pct', 'aliquota_simples_pct', 'custo_fixo_mensal',
          'cashback_pct',
          'mlm_pct_nivel_1','mlm_pct_nivel_2','mlm_pct_nivel_3','mlm_pct_nivel_4','mlm_pct_nivel_5',
        ]),
      applyDates(supabase.from('whatsapp_credito_historico')
        .select('creditos, valor_reais, tipo, created_at, empresas(nome)')
        .neq('tipo', 'consumo')
        .order('created_at', { ascending: false })),
      applyDates(supabase.from('pedidos_delivery').select('total, forma_pagamento').eq('origem', 'app').neq('status', 'cancelado')),
      applyDates(supabase.from('comissoes_indicacao').select('valor_comissao, status')),
    ])

    // MRR por status
    const byStatus = {}
    for (const e of empresasRes.data ?? []) {
      const s = e.status ?? 'desconhecido'
      if (!byStatus[s]) byStatus[s] = { qtd: 0, total: 0 }
      byStatus[s].qtd++
      byStatus[s].total += Number(e.valor_mensalidade || 0)
    }
    setMrr(byStatus)

    // Configs
    const cfgMap = {}
    for (const r of cfgRes.data ?? []) cfgMap[r.chave] = r.valor
    setCustoInput(cfgMap.custo_fixo_mensal ?? '650')

    const taxaPct     = Number(cfgMap.taxa_plataforma_pct  ?? 15)
    const impostosPct = Number(cfgMap.aliquota_simples_pct ?? 6)
    const custoFixo   = Number(cfgMap.custo_fixo_mensal    ?? 650)
    const cashbackPct = Number(cfgMap.cashback_pct         ?? 5)

    // Receitas
    const creditosLista     = creditosRes.data ?? []
    const receitaCreditos   = creditosLista.reduce((s, r) => s + Number(r.valor_reais || 0), 0)
    const pedidosApp        = vendasRes.data ?? []
    const volumeVendasApp   = pedidosApp.reduce((s, r) => s + Number(r.total || 0), 0)
    const qtdPedidosApp     = pedidosApp.length

    // Comissão 15% — PIX = pago (plataforma recebeu), dinheiro/cartão = pendente (loja repassa)
    const volPix       = pedidosApp.filter(p => p.forma_pagamento === 'pix').reduce((s, p) => s + Number(p.total || 0), 0)
    const volPendente  = pedidosApp.filter(p => p.forma_pagamento !== 'pix').reduce((s, p) => s + Number(p.total || 0), 0)
    const comissaoPago     = volPix      * taxaPct / 100
    const comissaoPendente = volPendente * taxaPct / 100
    const comissaoTotal    = comissaoPago + comissaoPendente

    // Unilevel real (comissoes_indicacao)
    const mlmRows      = mlmRes.data ?? []
    const mlmPago      = mlmRows.filter(r => r.status === 'pago').reduce((s, r) => s + Number(r.valor_comissao || 0), 0)
    const mlmPendente  = mlmRows.filter(r => r.status !== 'pago').reduce((s, r) => s + Number(r.valor_comissao || 0), 0)
    const totalMlm     = mlmPago + mlmPendente

    // Cashback estimado
    const totalCashback = volumeVendasApp * cashbackPct / 100

    const mrrAtivo      = byStatus.ativo?.total ?? 0
    const receitaTotal  = mrrAtivo + receitaCreditos + comissaoTotal
    const impostosEst   = receitaTotal * impostosPct / 100
    // Resultado operacional: receitas menos custos variáveis (unilevel + cashback)
    // Impostos e custo fixo ficam em bloco separado
    const resultadoOp   = receitaTotal - totalMlm - totalCashback

    setDados({
      taxaPct, impostosPct, custoFixo, cashbackPct,
      receitaCreditos, creditosLista, volumeVendasApp, qtdPedidosApp,
      comissaoTotal, comissaoPago, comissaoPendente,
      totalMlm, mlmPago, mlmPendente,
      totalCashback,
      mrrAtivo, receitaTotal, impostosEst, resultadoOp,
    })
    setLoading(false)
  }

  useEffect(() => { load() }, [periodo])

  async function salvarCusto(valor) {
    await supabase.from('configuracoes_plataforma')
      .upsert({ chave: 'custo_fixo_mensal', valor: String(valor) }, { onConflict: 'chave' })
    load()
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Financeiro</h1>
      </div>

      {/* ── MENSALIDADES (MRR) ── */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 }}>
          Mensalidades · Snapshot atual
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <Card label="Lojas ativas" valor={mrr?.ativo?.total ?? 0}    sub={`${mrr?.ativo?.qtd ?? 0} lojas`}    cor="var(--primary)" destaque />
          <Card label="Em atraso"    valor={mrr?.atrasado?.total ?? 0} sub={`${mrr?.atrasado?.qtd ?? 0} lojas`} cor="#dc2626" />
          <Card label="Em trial"     valor={mrr?.trial?.total ?? 0}    sub={`${mrr?.trial?.qtd ?? 0} lojas`}    cor="#0891b2" />
          <Card label="Suspenso"     valor={mrr?.suspenso?.total ?? 0} sub={`${mrr?.suspenso?.qtd ?? 0} lojas`} cor="#6b7280" />
        </div>
        {mrr && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            Potencial recuperável: {fmt((mrr.atrasado?.total ?? 0) + (mrr.trial?.total ?? 0))} · Cancelado: {fmt(mrr.cancelado?.total ?? 0)}
          </div>
        )}
      </section>

      {/* ── FILTRO DE PERÍODO ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 28, flexWrap: 'wrap' }}>
        {PERIODOS.map(p => (
          <button key={p.valor} onClick={() => setPeriodo(p.valor)} style={{
            padding: '6px 16px', borderRadius: 20, border: '1px solid var(--border)', cursor: 'pointer',
            fontWeight: 600, fontSize: 13,
            background: periodo === p.valor ? 'var(--primary)' : 'var(--card)',
            color:      periodo === p.valor ? '#fff' : 'var(--text)',
          }}>
            {p.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="empty-state">Calculando...</div>
      ) : (
        <>
          {/* ── VENDAS APP ── */}
          <section style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 }}>
              Vendas App / Portal
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderLeft: '4px solid #f97316', borderRadius: 12, padding: '18px 20px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Volume de vendas</div>
                <div style={{ fontSize: 24, fontWeight: 900 }}>{fmt(dados.volumeVendasApp)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{dados.qtdPedidosApp} pedidos no período</div>
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderLeft: '4px solid var(--primary)', borderRadius: 12, padding: '18px 20px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Comissão gerada ({dados.taxaPct}%)</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--primary)' }}>{fmt(dados.comissaoTotal)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  <span style={{ color: 'var(--success)' }}>{fmt(dados.comissaoPago)} pago</span>
                  {' · '}
                  <span style={{ color: 'var(--warning)' }}>{fmt(dados.comissaoPendente)} pendente</span>
                </div>
              </div>
            </div>
          </section>

          {/* ── RECEITAS ── */}
          <section style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 }}>
              Receitas do período
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '4px 20px 0' }}>
              <Row label="Mensalidades (MRR ativo)" valor={dados.mrrAtivo}        cor="#16a34a" detalhe="snapshot lojas ativas" />
              <Row label="Créditos WhatsApp"         valor={dados.receitaCreditos} cor="#25d366" detalhe="pagamentos confirmados" />
              <RowDetalhe
                label={`Comissão vendas app (${dados.taxaPct}%)`}
                detalhe={`${fmt(dados.volumeVendasApp)} em vendas no período`}
                total={dados.comissaoTotal}
                pago={dados.comissaoPago}
                pendente={dados.comissaoPendente}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0', fontWeight: 800 }}>
                <span style={{ fontSize: 14 }}>= Total receitas</span>
                <span style={{ fontSize: 16, color: 'var(--primary)' }}>{fmt(dados.receitaTotal)}</span>
              </div>
            </div>
          </section>

          {/* ── ABASTECIMENTO DE CRÉDITOS WHATSAPP ── */}
          <section style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                Abastecimento de créditos WhatsApp
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {dados.creditosLista.length} recarga{dados.creditosLista.length === 1 ? '' : 's'} · {fmt(dados.receitaCreditos)}
              </div>
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              {dados.creditosLista.length === 0 ? (
                <div style={{ padding: '18px 20px', fontSize: 13, color: 'var(--text-muted)' }}>
                  Nenhuma recarga confirmada no período.
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        <th style={{ padding: '10px 16px', fontWeight: 700 }}>Loja</th>
                        <th style={{ padding: '10px 16px', fontWeight: 700 }}>Forma</th>
                        <th style={{ padding: '10px 16px', fontWeight: 700, textAlign: 'right' }}>Créditos</th>
                        <th style={{ padding: '10px 16px', fontWeight: 700, textAlign: 'right' }}>Valor</th>
                        <th style={{ padding: '10px 16px', fontWeight: 700, textAlign: 'right' }}>Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dados.creditosLista.map((c, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '10px 16px', fontWeight: 600 }}>{c.empresas?.nome ?? '—'}</td>
                          <td style={{ padding: '10px 16px' }}>
                            <span style={{
                              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                              background: FundoTipo(c.tipo),
                              color: CifraTipo(c.tipo),
                            }}>
                              {LABEL_TIPO[c.tipo] ?? c.tipo}
                            </span>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 700 }}>{Number(c.creditos || 0).toLocaleString('pt-BR')}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 700, color: '#25d366' }}>{fmt(c.valor_reais)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtData(c.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {/* ── CUSTOS ── */}
          <section style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 }}>
              Custos do período
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '4px 20px 0' }}>
              <RowDetalhe
                label="Unilevel / Indicações"
                detalhe="valores reais da rede"
                total={dados.totalMlm}
                pago={dados.mlmPago}
                pendente={dados.mlmPendente}
                negativo
              />
              <Row label={`Cashback clientes (${dados.cashbackPct}%)`} valor={dados.totalCashback} detalhe="estimativa sobre vendas app" negativo />
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0', fontWeight: 800 }}>
                <span style={{ fontSize: 14 }}>= Total custos</span>
                <span style={{ fontSize: 16, color: '#dc2626' }}>
                  −{fmt(dados.totalMlm + dados.totalCashback)}
                </span>
              </div>
            </div>
          </section>

          {/* ── RESULTADO OPERACIONAL ── */}
          <div style={{
            borderRadius: 14, padding: '24px 28px', marginBottom: 24,
            background: dados.resultadoOp >= 0 ? 'var(--primary)' : '#dc2626',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ color: 'rgba(255,255,255,.85)', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
                RESULTADO OPERACIONAL
              </div>
              <div style={{ color: 'rgba(255,255,255,.65)', fontSize: 11 }}>
                MRR + Créditos + Comissão − (Unilevel + Cashback)
              </div>
            </div>
            <div style={{ fontSize: 36, fontWeight: 900, color: '#fff' }}>
              {dados.resultadoOp < 0 ? '−' : ''}{fmt(Math.abs(dados.resultadoOp))}
            </div>
          </div>

          {/* ── CUSTO FIXO (tabela separada) ── */}
          <section style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 }}>
              Custo fixo
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '4px 20px 0' }}>
              <Row label={`Simples Nacional (${dados.impostosPct}%)`} valor={dados.impostosEst} detalhe="sobre receita total" negativo />
              <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>− Infraestrutura / Contador</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>· infra + contador + domínio</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>R$</span>
                  <input
                    type="number" min="0" step="10"
                    value={custoInput}
                    onChange={e => setCustoInput(e.target.value)}
                    onBlur={e => salvarCusto(e.target.value)}
                    style={{
                      width: 90, padding: '4px 8px', borderRadius: 6,
                      border: '1px solid var(--border)', background: 'var(--bg)',
                      color: 'var(--text)', fontSize: 13, textAlign: 'right',
                    }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0', fontWeight: 800 }}>
                <span style={{ fontSize: 14 }}>= Total custo fixo</span>
                <span style={{ fontSize: 16, color: '#dc2626' }}>
                  −{fmt(dados.impostosEst + dados.custoFixo)}
                </span>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
