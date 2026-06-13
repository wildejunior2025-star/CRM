import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { CONDICOES_PAGAMENTO, FORMAS_RECEBIMENTO } from '../lib/constants'
import { sendWhatsApp, formatWaMessage } from '../lib/whatsapp'
import '../components/Page.css'
import './Financeiro.css'

const SALDO_ALTO_LIMITE = 100

const FORMA_BADGE = {
  dinheiro: 'badge-success',
  pix: 'badge-primary',
  transferencia: 'badge-warning',
  cartao: 'badge-neutral',
}

function FormaBadge({ value }) {
  const label = FORMAS_RECEBIMENTO.find((f) => f.value === value)?.label || value
  return <span className={`badge ${FORMA_BADGE[value] ?? 'badge-neutral'}`}>{label}</span>
}

export default function Financeiro() {
  const [clientes, setClientes] = useState([])
  const [saldos, setSaldos] = useState([])
  const [pagamentos, setPagamentos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [clienteId, setClienteId] = useState('')
  const [valor, setValor] = useState('')
  const [formaPagamento, setFormaPagamento] = useState('dinheiro')
  const [observacao, setObservacao] = useState('')

  const [historicoCliente, setHistoricoCliente] = useState(null)

  const [waConfig, setWaConfig] = useState(null)
  const [sendingWa, setSendingWa] = useState(null)
  const [waError, setWaError] = useState(null)
  const [waSuccess, setWaSuccess] = useState(null)

  async function loadAll() {
    setLoading(true)
    setError(null)

    const [clientesRes, saldosRes, pagamentosRes, waRes] = await Promise.all([
      supabase.from('clientes').select('id, nome, condicao_pagamento, telefone').order('nome'),
      supabase.from('clientes_saldo_fiado').select('*'),
      supabase
        .from('pagamentos')
        .select('*, clientes(nome)')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('whatsapp_config').select('ativo, notif_fiado, msg_fiado').maybeSingle(),
    ])

    const firstError = clientesRes.error || saldosRes.error || pagamentosRes.error
    if (firstError) setError(firstError.message)

    setClientes(clientesRes.data ?? [])
    setSaldos(saldosRes.data ?? [])
    setPagamentos(pagamentosRes.data ?? [])
    if (!waRes.error && waRes.data) setWaConfig(waRes.data)
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  function saldoDoCliente(clienteIdAlvo) {
    return Number(saldos.find((s) => s.cliente_id === clienteIdAlvo)?.saldo_fiado ?? 0)
  }

  const clientesComFiado = clientes
    .map((c) => ({ ...c, saldo: saldoDoCliente(c.id) }))
    .filter((c) => c.saldo > 0.009)
    .sort((a, b) => b.saldo - a.saldo)

  const totalFiado = clientesComFiado.reduce((sum, c) => sum + c.saldo, 0)

  function openNovoPagamento(cliente) {
    setClienteId(cliente?.id ?? clientesComFiado[0]?.id ?? '')
    setValor('')
    setFormaPagamento('dinheiro')
    setObservacao('')
    setFormError(null)
    setShowModal(true)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError(null)

    const valorNumerico = Number(valor)
    if (!clienteId) {
      setFormError('Selecione um cliente.')
      return
    }
    if (!(valorNumerico > 0)) {
      setFormError('Informe um valor de pagamento válido.')
      return
    }

    setSaving(true)

    const { error } = await supabase.from('pagamentos').insert({
      cliente_id: clienteId,
      valor: valorNumerico,
      forma_pagamento: formaPagamento,
      observacao: observacao || null,
    })

    setSaving(false)

    if (error) {
      setFormError(error.message)
      return
    }

    setShowModal(false)
    loadAll()
  }

  function abrirHistorico(cliente) {
    setHistoricoCliente(cliente)
  }

  async function handleCobrarWhatsApp(cliente) {
    setWaError(null)
    setWaSuccess(null)

    if (!waConfig?.ativo || !waConfig?.notif_fiado) {
      alert('WhatsApp não configurado. Acesse Configurações > WhatsApp.')
      return
    }
    if (!cliente.telefone) {
      alert('Cliente sem telefone cadastrado.')
      return
    }

    setSendingWa(cliente.id)
    try {
      await sendWhatsApp({
        phone: cliente.telefone,
        message: formatWaMessage(waConfig.msg_fiado, {
          nome: cliente.nome,
          valor: cliente.saldo.toFixed(2),
        }),
      })
      setWaSuccess(cliente.id)
      setTimeout(() => setWaSuccess(null), 3000)
    } catch (err) {
      setWaError(err?.message ?? 'Erro ao enviar WhatsApp.')
      setTimeout(() => setWaError(null), 4000)
    } finally {
      setSendingWa(null)
    }
  }

  const historicoPagamentos = historicoCliente
    ? pagamentos.filter((p) => p.cliente_id === historicoCliente.id)
    : []

  return (
    <div>
      <div className="page-header">
        <h1>Financeiro</h1>
        <button
          className="btn btn-primary"
          onClick={() => openNovoPagamento(null)}
          disabled={clientesComFiado.length === 0}
        >
          + Registrar pagamento
        </button>
      </div>

      <div className="dashboard-grid" style={{ marginBottom: 20 }}>
        <div className="card dashboard-card">
          <div className="label">Total fiado em aberto</div>
          <div className="value">{loading ? '-' : `R$ ${totalFiado.toFixed(2)}`}</div>
        </div>
        <div className="card dashboard-card">
          <div className="label">Clientes com fiado em aberto</div>
          <div className="value">{loading ? '-' : clientesComFiado.length}</div>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {waError && <p className="error-text">{waError}</p>}

      <h2 className="fin-table-title">Fiado em aberto por cliente</h2>
      <div className="data-table" style={{ marginBottom: 24 }}>
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : clientesComFiado.length === 0 ? (
          <div className="empty-state">Nenhum cliente com fiado em aberto.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Condição de pagamento</th>
                <th className="fin-amount-col">Saldo em aberto</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clientesComFiado.map((c) => (
                <tr key={c.id}>
                  <td className="fin-cliente-cell">{c.nome}</td>
                  <td>
                    {CONDICOES_PAGAMENTO.find((cp) => cp.value === c.condicao_pagamento)?.label ||
                      c.condicao_pagamento}
                  </td>
                  <td className="fin-amount-col">
                    <span
                      className={`fin-saldo ${c.saldo >= SALDO_ALTO_LIMITE ? 'fin-saldo-alto' : ''}`}
                    >
                      R$ {c.saldo.toFixed(2)}
                    </span>
                  </td>
                  <td className="fin-actions-col">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => abrirHistorico(c)}
                    >
                      Histórico
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => openNovoPagamento(c)}>
                      Receber
                    </button>
                    {waConfig?.ativo && waConfig?.notif_fiado && (
                      <button
                        className="btn btn-sm wa-btn"
                        onClick={() => handleCobrarWhatsApp(c)}
                        disabled={sendingWa === c.id}
                        title="Cobrar via WhatsApp"
                        aria-label={`Cobrar ${c.nome} via WhatsApp`}
                      >
                        {sendingWa === c.id ? (
                          '...'
                        ) : waSuccess === c.id ? (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
                        )}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="fin-table-title">Últimos recebimentos</h2>
      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : pagamentos.length === 0 ? (
          <div className="empty-state">Nenhum recebimento registrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Cliente</th>
                <th>Forma</th>
                <th className="fin-amount-col">Valor</th>
                <th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {pagamentos.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.created_at).toLocaleString('pt-BR')}</td>
                  <td>{p.clientes?.nome ?? '-'}</td>
                  <td>
                    <FormaBadge value={p.forma_pagamento} />
                  </td>
                  <td className="fin-amount-col">R$ {Number(p.valor).toFixed(2)}</td>
                  <td>{p.observacao ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Registrar pagamento</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label htmlFor="pagamento-cliente">Cliente</label>
                  <select
                    id="pagamento-cliente"
                    name="cliente"
                    value={clienteId}
                    onChange={(e) => setClienteId(e.target.value)}
                    required
                  >
                    {clientesComFiado.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome} (saldo: R$ {c.saldo.toFixed(2)})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label htmlFor="pagamento-valor">Valor recebido (R$)</label>
                  <input
                    id="pagamento-valor"
                    name="valor"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={valor}
                    onChange={(e) => setValor(e.target.value)}
                    required
                  />
                </div>

                <div className="form-field">
                  <label htmlFor="pagamento-forma">Forma de recebimento</label>
                  <select
                    id="pagamento-forma"
                    name="forma_pagamento"
                    value={formaPagamento}
                    onChange={(e) => setFormaPagamento(e.target.value)}
                  >
                    {FORMAS_RECEBIMENTO.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field full">
                  <label htmlFor="pagamento-observacao">Observação</label>
                  <textarea
                    id="pagamento-observacao"
                    name="observacao"
                    rows={2}
                    value={observacao}
                    onChange={(e) => setObservacao(e.target.value)}
                  />
                </div>
              </div>

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
                  {saving ? 'Salvando...' : 'Confirmar recebimento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {historicoCliente && (
        <div className="modal-overlay" onClick={() => setHistoricoCliente(null)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
            <h2>
              Histórico de <span className="fin-historico-cliente">{historicoCliente.nome}</span>
            </h2>
            <div className="data-table">
              {historicoPagamentos.length === 0 ? (
                <div className="empty-state">Nenhum recebimento registrado.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Forma</th>
                      <th className="fin-amount-col">Valor</th>
                      <th>Observação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historicoPagamentos.map((p) => (
                      <tr key={p.id}>
                        <td>{new Date(p.created_at).toLocaleString('pt-BR')}</td>
                        <td>
                          <FormaBadge value={p.forma_pagamento} />
                        </td>
                        <td className="fin-amount-col">R$ {Number(p.valor).toFixed(2)}</td>
                        <td>{p.observacao ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setHistoricoCliente(null)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
