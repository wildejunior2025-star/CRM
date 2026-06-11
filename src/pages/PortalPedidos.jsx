import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { CONDICOES_PAGAMENTO, STATUS_VENDA } from '../lib/constants'
import '../components/Page.css'
import './Portal.css'

const STATUS_BADGE = {
  pedido: 'badge-warning',
  entregue: 'badge-success',
  cancelado: 'badge-danger',
}

export default function PortalPedidos() {
  const [vendas, setVendas] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detalheVenda, setDetalheVenda] = useState(null)
  const [detalheItens, setDetalheItens] = useState([])

  async function loadAll() {
    setLoading(true)
    setError(null)

    const { data, error } = await supabase
      .from('vendas')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) setError(error.message)
    setVendas(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function openDetalhe(venda) {
    setDetalheVenda(venda)
    const { data, error } = await supabase
      .from('venda_itens')
      .select('*, produtos(nome)')
      .eq('venda_id', venda.id)

    if (error) setError(error.message)
    else setDetalheItens(data ?? [])
  }

  return (
    <div>
      <div className="page-header">
        <h1>Meus pedidos</h1>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : vendas.length === 0 ? (
          <div className="empty-state">Nenhum pedido encontrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Pagamento</th>
                <th className="portal-amount-col">Total</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vendas.map((v) => (
                <tr key={v.id}>
                  <td>{new Date(v.created_at).toLocaleString('pt-BR')}</td>
                  <td>
                    {CONDICOES_PAGAMENTO.find((o) => o.value === v.forma_pagamento)?.label ||
                      v.forma_pagamento}
                  </td>
                  <td className="portal-amount-col">R$ {Number(v.total).toFixed(2)}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[v.status] ?? 'badge-warning'}`}>
                      {STATUS_VENDA.find((s) => s.value === v.status)?.label ?? v.status}
                    </span>
                  </td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => openDetalhe(v)}>
                      Ver itens
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detalheVenda && (
        <div className="modal-overlay" onClick={() => setDetalheVenda(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Pedido de {new Date(detalheVenda.created_at).toLocaleString('pt-BR')}</h2>
            <div className="data-table">
              <table>
                <thead>
                  <tr>
                    <th>Produto</th>
                    <th>Qtd</th>
                    <th>Preço unit.</th>
                    <th>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {detalheItens.map((item) => (
                    <tr key={item.id}>
                      <td>{item.produtos?.nome ?? '-'}</td>
                      <td>{item.quantidade}</td>
                      <td>R$ {Number(item.preco_unitario).toFixed(2)}</td>
                      <td>R$ {Number(item.subtotal).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="portal-total">
              Total: <strong>R$ {Number(detalheVenda.total).toFixed(2)}</strong>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDetalheVenda(null)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
