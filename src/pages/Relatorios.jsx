import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { exportToCsv } from '../lib/csv'
import { CONDICOES_PAGAMENTO, STATUS_VENDA } from '../lib/constants'
import '../components/Page.css'
import './Relatorios.css'

function toInputDate(date) {
  const d = new Date(date)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 10)
}

function primeiroDiaDoMes() {
  const d = new Date()
  d.setDate(1)
  return toInputDate(d)
}

function formaPagamentoLabel(value) {
  return CONDICOES_PAGAMENTO.find((o) => o.value === value)?.label || value
}

export default function Relatorios() {
  const [dataInicio, setDataInicio] = useState(primeiroDiaDoMes())
  const [dataFim, setDataFim] = useState(toInputDate(new Date()))
  const [incluirCancelados, setIncluirCancelados] = useState(false)

  const [vendas, setVendas] = useState([])
  const [itens, setItens] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)

    const inicioISO = new Date(`${dataInicio}T00:00:00`).toISOString()
    const fimExclusivo = new Date(`${dataFim}T00:00:00`)
    fimExclusivo.setDate(fimExclusivo.getDate() + 1)

    let vendasQuery = supabase
      .from('vendas')
      .select('*, clientes(nome)')
      .gte('created_at', inicioISO)
      .lt('created_at', fimExclusivo.toISOString())
      .order('created_at', { ascending: false })

    if (!incluirCancelados) {
      vendasQuery = vendasQuery.neq('status', 'cancelado')
    }

    const vendasRes = await vendasQuery

    if (vendasRes.error) {
      setError(vendasRes.error.message)
      setVendas([])
      setItens([])
      setLoading(false)
      return
    }

    const vendasData = vendasRes.data ?? []
    const vendaIds = vendasData.map((v) => v.id)

    let itensData = []
    if (vendaIds.length > 0) {
      const itensRes = await supabase
        .from('venda_itens')
        .select('*, produtos(nome, categoria)')
        .in('venda_id', vendaIds)

      if (itensRes.error) setError(itensRes.error.message)
      else itensData = itensRes.data ?? []
    }

    setVendas(vendasData)
    setItens(itensData)
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalVendido = vendas.reduce((sum, v) => sum + Number(v.total), 0)
  const qtdVendas = vendas.length
  const ticketMedio = qtdVendas > 0 ? totalVendido / qtdVendas : 0

  const porFormaPagamento = Object.values(
    vendas.reduce((acc, v) => {
      const key = v.forma_pagamento
      if (!acc[key]) acc[key] = { forma_pagamento: key, total: 0, qtd: 0 }
      acc[key].total += Number(v.total)
      acc[key].qtd += 1
      return acc
    }, {})
  ).sort((a, b) => b.total - a.total)

  const rankingClientes = Object.values(
    vendas.reduce((acc, v) => {
      const key = v.cliente_id
      if (!acc[key]) {
        acc[key] = { cliente_id: key, nome: v.clientes?.nome ?? '-', total: 0, qtd: 0 }
      }
      acc[key].total += Number(v.total)
      acc[key].qtd += 1
      return acc
    }, {})
  )
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)

  const rankingProdutos = Object.values(
    itens.reduce((acc, item) => {
      const key = item.produto_id
      if (!acc[key]) {
        acc[key] = {
          produto_id: key,
          nome: item.produtos?.nome ?? '-',
          categoria: item.produtos?.categoria ?? '-',
          quantidade: 0,
          subtotal: 0,
        }
      }
      acc[key].quantidade += Number(item.quantidade)
      acc[key].subtotal += Number(item.subtotal)
      return acc
    }, {})
  )
    .sort((a, b) => b.subtotal - a.subtotal)
    .slice(0, 10)

  function exportarVendas() {
    exportToCsv(`vendas_${dataInicio}_a_${dataFim}.csv`, [
      { label: 'Data', value: (v) => new Date(v.created_at).toLocaleString('pt-BR') },
      { label: 'Cliente', value: (v) => v.clientes?.nome ?? '-' },
      { label: 'Forma de pagamento', value: (v) => formaPagamentoLabel(v.forma_pagamento) },
      { label: 'Status', value: (v) => STATUS_VENDA.find((s) => s.value === v.status)?.label ?? v.status },
      { label: 'Total', value: (v) => Number(v.total).toFixed(2) },
    ], vendas)
  }

  function exportarRankingClientes() {
    exportToCsv(`ranking_clientes_${dataInicio}_a_${dataFim}.csv`, [
      { label: 'Cliente', value: (c) => c.nome },
      { label: 'Qtd. vendas', value: (c) => c.qtd },
      { label: 'Total comprado', value: (c) => c.total.toFixed(2) },
    ], rankingClientes)
  }

  function exportarRankingProdutos() {
    exportToCsv(`ranking_produtos_${dataInicio}_a_${dataFim}.csv`, [
      { label: 'Produto', value: (p) => p.nome },
      { label: 'Categoria', value: (p) => p.categoria },
      { label: 'Quantidade vendida', value: (p) => p.quantidade },
      { label: 'Total vendido', value: (p) => p.subtotal.toFixed(2) },
    ], rankingProdutos)
  }

  return (
    <div>
      <div className="page-header">
        <h1>Relatórios</h1>
        <button className="btn btn-secondary" onClick={() => window.print()}>
          Imprimir / PDF
        </button>
      </div>

      <div className="toolbar">
        <div className="form-field">
          <label htmlFor="rel-data-inicio">De</label>
          <input
            id="rel-data-inicio"
            name="data_inicio"
            type="date"
            value={dataInicio}
            onChange={(e) => setDataInicio(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label htmlFor="rel-data-fim">Até</label>
          <input
            id="rel-data-fim"
            name="data_fim"
            type="date"
            value={dataFim}
            onChange={(e) => setDataFim(e.target.value)}
          />
        </div>
        <div className="form-field" style={{ justifyContent: 'flex-end' }}>
          <label htmlFor="rel-incluir-cancelados">&nbsp;</label>
          <label className="rel-checkbox">
            <input
              id="rel-incluir-cancelados"
              name="incluir_cancelados"
              type="checkbox"
              checked={incluirCancelados}
              onChange={(e) => setIncluirCancelados(e.target.checked)}
            />
            Incluir vendas canceladas
          </label>
        </div>
        <div className="form-field" style={{ justifyContent: 'flex-end' }}>
          <span className="rel-spacer-label" aria-hidden="true">&nbsp;</span>
          <button className="btn btn-primary" onClick={load} disabled={loading}>
            {loading ? 'Carregando...' : 'Buscar'}
          </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="dashboard-grid" style={{ marginBottom: 24 }}>
        <div className="card dashboard-card">
          <div className="label">Total vendido no período</div>
          <div className="value">{loading ? '-' : `R$ ${totalVendido.toFixed(2)}`}</div>
        </div>
        <div className="card dashboard-card">
          <div className="label">Quantidade de vendas</div>
          <div className="value">{loading ? '-' : qtdVendas}</div>
        </div>
        <div className="card dashboard-card">
          <div className="label">Ticket médio</div>
          <div className="value">{loading ? '-' : `R$ ${ticketMedio.toFixed(2)}`}</div>
        </div>
      </div>

      <h2 className="rel-table-title">Vendas por forma de pagamento</h2>
      <div className="data-table" style={{ marginBottom: 24 }}>
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : porFormaPagamento.length === 0 ? (
          <div className="empty-state">Nenhuma venda no período.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Forma de pagamento</th>
                <th>Qtd. vendas</th>
                <th className="rel-amount-col">Total</th>
              </tr>
            </thead>
            <tbody>
              {porFormaPagamento.map((f) => (
                <tr key={f.forma_pagamento}>
                  <td>{formaPagamentoLabel(f.forma_pagamento)}</td>
                  <td>{f.qtd}</td>
                  <td className="rel-amount-col">R$ {f.total.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rel-section-header">
        <h2 className="rel-table-title">Ranking de clientes</h2>
        <button
          className="btn btn-secondary btn-sm"
          onClick={exportarRankingClientes}
          disabled={rankingClientes.length === 0}
        >
          Exportar CSV
        </button>
      </div>
      <div className="data-table" style={{ marginBottom: 24 }}>
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : rankingClientes.length === 0 ? (
          <div className="empty-state">Nenhuma venda no período.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Qtd. vendas</th>
                <th className="rel-amount-col">Total comprado</th>
              </tr>
            </thead>
            <tbody>
              {rankingClientes.map((c) => (
                <tr key={c.cliente_id}>
                  <td>{c.nome}</td>
                  <td>{c.qtd}</td>
                  <td className="rel-amount-col">R$ {c.total.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rel-section-header">
        <h2 className="rel-table-title">Ranking de produtos</h2>
        <button
          className="btn btn-secondary btn-sm"
          onClick={exportarRankingProdutos}
          disabled={rankingProdutos.length === 0}
        >
          Exportar CSV
        </button>
      </div>
      <div className="data-table" style={{ marginBottom: 24 }}>
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : rankingProdutos.length === 0 ? (
          <div className="empty-state">Nenhum item vendido no período.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Produto</th>
                <th>Categoria</th>
                <th>Quantidade</th>
                <th className="rel-amount-col">Total vendido</th>
              </tr>
            </thead>
            <tbody>
              {rankingProdutos.map((p) => (
                <tr key={p.produto_id}>
                  <td>{p.nome}</td>
                  <td>{p.categoria}</td>
                  <td>{p.quantidade}</td>
                  <td className="rel-amount-col">R$ {p.subtotal.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rel-section-header">
        <h2 className="rel-table-title">Vendas detalhadas</h2>
        <button
          className="btn btn-secondary btn-sm"
          onClick={exportarVendas}
          disabled={vendas.length === 0}
        >
          Exportar CSV
        </button>
      </div>
      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : vendas.length === 0 ? (
          <div className="empty-state">Nenhuma venda no período.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Cliente</th>
                <th>Pagamento</th>
                <th>Status</th>
                <th className="rel-amount-col">Total</th>
              </tr>
            </thead>
            <tbody>
              {vendas.map((v) => (
                <tr key={v.id}>
                  <td>{new Date(v.created_at).toLocaleString('pt-BR')}</td>
                  <td>{v.clientes?.nome ?? '-'}</td>
                  <td>{formaPagamentoLabel(v.forma_pagamento)}</td>
                  <td>{STATUS_VENDA.find((s) => s.value === v.status)?.label ?? v.status}</td>
                  <td className="rel-amount-col">R$ {Number(v.total).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
