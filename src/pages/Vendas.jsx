import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { CONDICOES_PAGAMENTO, STATUS_VENDA } from '../lib/constants'
import { sendWhatsApp, notificarEstoqueBaixo } from '../lib/whatsapp'
import '../components/Page.css'
import './Vendas.css'

const STATUS_BADGE = {
  pedido: 'badge-warning',
  entregue: 'badge-success',
  cancelado: 'badge-danger',
}

function emptyItem() {
  return { produto_id: '', quantidade: 1, preco_unitario: 0 }
}

export default function Vendas() {
  const [vendas, setVendas] = useState([])
  const [clientes, setClientes] = useState([])
  const [produtos, setProdutos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [statusFiltro, setStatusFiltro] = useState('')
  const [dataInicio, setDataInicio] = useState('')
  const [dataFim, setDataFim] = useState('')
  const [pagina, setPagina] = useState(1)
  const POR_PAGINA = 20

  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [clienteId, setClienteId] = useState('')
  const [formaPagamento, setFormaPagamento] = useState('a_vista')
  const [observacoes, setObservacoes] = useState('')
  const [itens, setItens] = useState([emptyItem()])

  const [detalheVenda, setDetalheVenda] = useState(null)
  const [detalheItens, setDetalheItens] = useState([])

  const [waConfig, setWaConfig] = useState(null)
  const [sendingWa, setSendingWa] = useState(null)

  async function loadAll() {
    setLoading(true)
    setError(null)

    const [vendasRes, clientesRes, produtosRes, waRes] = await Promise.all([
      supabase
        .from('vendas')
        .select('*, clientes(nome, telefone)')
        .order('created_at', { ascending: false }),
      supabase.from('clientes').select('*').eq('ativo', true).order('nome'),
      supabase.from('produtos').select('*').eq('ativo', true).order('nome'),
      supabase.from('whatsapp_config').select('ativo, notif_pedido, msg_pedido').maybeSingle(),
    ])

    const firstError = vendasRes.error || clientesRes.error || produtosRes.error
    if (firstError) setError(firstError.message)

    setVendas(vendasRes.data ?? [])
    setClientes(clientesRes.data ?? [])
    setProdutos(produtosRes.data ?? [])
    if (!waRes.error && waRes.data) setWaConfig(waRes.data)
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  function openNew() {
    setClienteId(clientes[0]?.id ?? '')
    setFormaPagamento('a_vista')
    setObservacoes('')
    setItens([emptyItem()])
    setFormError(null)
    setShowModal(true)
  }

  function handleClienteChange(id) {
    setClienteId(id)
    const cliente = clientes.find((c) => c.id === id)
    if (cliente) setFormaPagamento(cliente.condicao_pagamento)
  }

  function handleItemChange(index, field, value) {
    setItens((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item
        const next = { ...item, [field]: value }
        if (field === 'produto_id') {
          const produto = produtos.find((p) => p.id === value)
          next.preco_unitario = produto?.preco_venda ?? 0
        }
        return next
      })
    )
  }

  function addItem() {
    setItens((prev) => [...prev, emptyItem()])
  }

  function removeItem(index) {
    setItens((prev) => prev.filter((_, i) => i !== index))
  }

  const total = itens.reduce(
    (sum, item) => sum + (Number(item.quantidade) || 0) * (Number(item.preco_unitario) || 0),
    0
  )

  const clienteSelecionado = clientes.find((c) => c.id === clienteId)
  const limiteExcedido =
    formaPagamento !== 'a_vista' &&
    clienteSelecionado &&
    clienteSelecionado.limite_credito > 0 &&
    total > clienteSelecionado.limite_credito

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError(null)

    const itensValidos = itens.filter(
      (item) => item.produto_id && Number(item.quantidade) > 0
    )

    if (itensValidos.length === 0) {
      setFormError('Adicione ao menos um item válido.')
      return
    }

    if (limiteExcedido) {
      const confirmar = confirm(
        `O total (R$ ${total.toFixed(2)}) excede o limite de crédito do cliente ` +
          `(R$ ${clienteSelecionado.limite_credito.toFixed(2)}). Confirmar mesmo assim?`
      )
      if (!confirmar) return
    }

    setSaving(true)

    const { error } = await supabase.rpc('registrar_venda', {
      p_cliente_id: clienteId,
      p_forma_pagamento: formaPagamento,
      p_observacoes: observacoes || null,
      p_itens: itensValidos.map((item) => ({
        produto_id: item.produto_id,
        quantidade: Number(item.quantidade),
        preco_unitario: Number(item.preco_unitario),
      })),
    })

    setSaving(false)

    if (error) {
      setFormError(error.message)
      return
    }

    setShowModal(false)
    loadAll()
    notificarEstoqueBaixo()
  }

  async function handleCancelar(venda) {
    if (!confirm('Cancelar esta venda? O estoque e os cascos serão estornados.')) return
    const { error } = await supabase.rpc('cancelar_venda', { p_venda_id: venda.id })
    if (error) setError(error.message)
    else loadAll()
  }

  async function handleStatusChange(venda, status) {
    const { error } = await supabase.from('vendas').update({ status }).eq('id', venda.id)
    if (error) { setError(error.message); return }

    // Disparar WhatsApp de confirmação ao marcar como entregue
    if (status === 'entregue' && waConfig?.ativo && venda.clientes?.telefone) {
      setSendingWa(venda.id)
      sendWhatsApp({
        phone: venda.clientes.telefone,
        message: `Olá ${venda.clientes.nome}! Seu pedido foi entregue. Obrigado pela preferência!`,
      })
        .catch(() => {})
        .finally(() => setSendingWa(null))
    }

    loadAll()
  }

  async function openDetalhe(venda) {
    setDetalheVenda(venda)
    const { data, error } = await supabase
      .from('venda_itens')
      .select('*, produtos(nome)')
      .eq('venda_id', venda.id)

    if (error) setError(error.message)
    else setDetalheItens(data ?? [])
  }

  const filtered = vendas.filter((v) => {
    if (statusFiltro && v.status !== statusFiltro) return false
    if (dataInicio && v.created_at < dataInicio) return false
    if (dataFim && v.created_at > dataFim + 'T23:59:59') return false
    return true
  })

  const totalPaginas = Math.ceil(filtered.length / POR_PAGINA)
  const paginaAtual = Math.min(pagina, totalPaginas || 1)
  const visiveis = filtered.slice((paginaAtual - 1) * POR_PAGINA, paginaAtual * POR_PAGINA)

  return (
    <div>
      <div className="page-header">
        <h1>Vendas</h1>
        <button className="btn btn-primary" onClick={openNew} disabled={clientes.length === 0}>
          + Nova venda
        </button>
      </div>

      <div className="toolbar">
        <select value={statusFiltro} onChange={(e) => { setStatusFiltro(e.target.value); setPagina(1) }}>
          <option value="">Todos os status</option>
          {STATUS_VENDA.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={dataInicio}
          onChange={(e) => { setDataInicio(e.target.value); setPagina(1) }}
          title="Data início"
        />
        <input
          type="date"
          value={dataFim}
          onChange={(e) => { setDataFim(e.target.value); setPagina(1) }}
          title="Data fim"
        />
        {(dataInicio || dataFim) && (
          <button className="btn btn-secondary btn-sm" onClick={() => { setDataInicio(''); setDataFim(''); setPagina(1) }}>
            Limpar datas
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="data-table">
        {loading ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
              </svg>
            </div>
            <strong>Carregando vendas...</strong>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
                <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
              </svg>
            </div>
            <strong>Nenhuma venda encontrada</strong>
            <p>{statusFiltro || dataInicio || dataFim ? 'Tente ajustar os filtros.' : 'Clique em "+ Nova venda" para registrar.'}</p>
          </div>
        ) : (
          <>
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Cliente</th>
                <th>Pagamento</th>
                <th>Total</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((v) => (
                <tr key={v.id}>
                  <td>{new Date(v.created_at).toLocaleString('pt-BR')}</td>
                  <td>{v.clientes?.nome ?? '-'}</td>
                  <td>
                    {CONDICOES_PAGAMENTO.find((o) => o.value === v.forma_pagamento)?.label ||
                      v.forma_pagamento}
                  </td>
                  <td>R$ {Number(v.total).toFixed(2)}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[v.status] ?? 'badge-warning'}`}>
                      {STATUS_VENDA.find((s) => s.value === v.status)?.label ?? v.status}
                    </span>
                  </td>
                  <td>
                    <button className="btn btn-secondary btn-sm" onClick={() => openDetalhe(v)}>
                      Ver itens
                    </button>{' '}
                    {v.status === 'pedido' && (
                      <>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleStatusChange(v, 'entregue')}
                          disabled={sendingWa === v.id}
                        >
                          {sendingWa === v.id ? 'Enviando...' : 'Marcar entregue'}
                        </button>{' '}
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleCancelar(v)}
                        >
                          Cancelar
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalPaginas > 1 && (
            <div className="pagination">
              <button className="btn btn-secondary btn-sm" disabled={paginaAtual === 1} onClick={() => setPagina(p => p - 1)}>
                Anterior
              </button>
              <span className="pagination-info">{paginaAtual} / {totalPaginas}</span>
              <button className="btn btn-secondary btn-sm" disabled={paginaAtual === totalPaginas} onClick={() => setPagina(p => p + 1)}>
                Próxima
              </button>
            </div>
          )}
          </>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <h2>Nova venda</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-field">
                  <label>Cliente</label>
                  <select
                    value={clienteId}
                    onChange={(e) => handleClienteChange(e.target.value)}
                    required
                  >
                    {clientes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Forma de pagamento</label>
                  <select
                    value={formaPagamento}
                    onChange={(e) => setFormaPagamento(e.target.value)}
                  >
                    {CONDICOES_PAGAMENTO.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <h3 className="venda-itens-title">Itens</h3>
              <div className="venda-itens">
                {itens.map((item, index) => {
                  const produto = produtos.find((p) => p.id === item.produto_id)
                  const subtotal =
                    (Number(item.quantidade) || 0) * (Number(item.preco_unitario) || 0)
                  return (
                    <div className="venda-item-row" key={index}>
                      <select
                        value={item.produto_id}
                        onChange={(e) => handleItemChange(index, 'produto_id', e.target.value)}
                        required
                      >
                        <option value="">Selecione um produto</option>
                        {produtos.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.nome} ({p.embalagem})
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="Qtd"
                        value={item.quantidade}
                        onChange={(e) => handleItemChange(index, 'quantidade', e.target.value)}
                        required
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Preço unit."
                        value={item.preco_unitario}
                        onChange={(e) =>
                          handleItemChange(index, 'preco_unitario', e.target.value)
                        }
                        required
                      />
                      <span className="venda-item-subtotal">R$ {subtotal.toFixed(2)}</span>
                      {produto?.controla_casco && (
                        <span className="badge badge-warning venda-item-casco">casco</span>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => removeItem(index)}
                        disabled={itens.length === 1}
                      >
                        Remover
                      </button>
                    </div>
                  )
                })}
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addItem}>
                + Adicionar item
              </button>

              <div className="form-grid" style={{ marginTop: 16 }}>
                <div className="form-field full">
                  <label>Observações</label>
                  <textarea
                    rows={2}
                    value={observacoes}
                    onChange={(e) => setObservacoes(e.target.value)}
                  />
                </div>
              </div>

              <div className="venda-total">
                Total: <strong>R$ {total.toFixed(2)}</strong>
              </div>

              {limiteExcedido && (
                <p className="error-text">
                  Atenção: total excede o limite de crédito do cliente (R${' '}
                  {clienteSelecionado.limite_credito.toFixed(2)}).
                </p>
              )}

              {formError && <p className="error-text">{formError}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowModal(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando...' : 'Confirmar venda'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {detalheVenda && (
        <div className="modal-overlay" onClick={() => setDetalheVenda(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              Venda de {new Date(detalheVenda.created_at).toLocaleString('pt-BR')}
            </h2>
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
            <div className="venda-total">
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
