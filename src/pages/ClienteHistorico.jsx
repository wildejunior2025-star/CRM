import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import './ClienteHistorico.css'

const TIPO_LABEL = { visita: 'Visita', anotacao: 'Anotação' }
const STATUS_CLASS = { entregue: 'badge-success', cancelado: 'badge-danger', pedido: 'badge-warning' }

function formatDate(d) {
  return new Date(d).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function nowLocal() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

export default function ClienteHistorico({ cliente, onClose }) {
  const { user } = useAuth()
  const [timeline, setTimeline] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ tipo: 'visita', descricao: '', data: nowLocal() })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function loadTimeline() {
    setLoading(true)
    const [{ data: interacoes }, { data: vendas }] = await Promise.all([
      supabase
        .from('interacoes_cliente')
        .select('id, tipo, descricao, data, created_at')
        .eq('cliente_id', cliente.id)
        .order('data', { ascending: false }),
      supabase
        .from('vendas')
        .select('id, status, total, forma_pagamento, created_at')
        .eq('cliente_id', cliente.id)
        .order('created_at', { ascending: false }),
    ])

    const items = [
      ...(interacoes ?? []).map(i => ({ ...i, _tipo: i.tipo, _date: i.data ?? i.created_at })),
      ...(vendas ?? []).map(v => ({ ...v, _tipo: 'pedido', _date: v.created_at })),
    ].sort((a, b) => new Date(b._date) - new Date(a._date))

    setTimeline(items)
    setLoading(false)
  }

  useEffect(() => { loadTimeline() }, [cliente.id])

  function openForm(tipo) {
    setForm({ tipo, descricao: '', data: nowLocal() })
    setError(null)
    setShowForm(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!form.descricao.trim()) return
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.from('interacoes_cliente').insert({
      cliente_id: cliente.id,
      tipo: form.tipo,
      descricao: form.descricao.trim(),
      data: new Date(form.data).toISOString(),
      created_by: user.id,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    setShowForm(false)
    loadTimeline()
  }

  async function handleDelete(id) {
    if (!confirm('Remover esta interação?')) return
    await supabase.from('interacoes_cliente').delete().eq('id', id)
    loadTimeline()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="historico-panel" onClick={e => e.stopPropagation()}>

        <div className="historico-header">
          <div>
            <h2 className="historico-title">Histórico de interações</h2>
            <p className="historico-subtitle">{cliente.nome}</p>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Fechar</button>
        </div>

        <div className="historico-actions">
          <button className="btn btn-primary btn-sm" onClick={() => openForm('visita')}>+ Visita</button>
          <button className="btn btn-secondary btn-sm" onClick={() => openForm('anotacao')}>+ Anotação</button>
        </div>

        {showForm && (
          <form className="historico-form" onSubmit={handleSave}>
            <div className="hform-row">
              <div className="form-field">
                <label>Tipo</label>
                <select value={form.tipo} onChange={e => setForm(f => ({ ...f, tipo: e.target.value }))}>
                  <option value="visita">Visita</option>
                  <option value="anotacao">Anotação</option>
                </select>
              </div>
              <div className="form-field">
                <label>Data / Hora</label>
                <input
                  type="datetime-local"
                  value={form.data}
                  onChange={e => setForm(f => ({ ...f, data: e.target.value }))}
                />
              </div>
            </div>
            <div className="form-field">
              <label>Descrição</label>
              <textarea
                rows={2}
                value={form.descricao}
                onChange={e => setForm(f => ({ ...f, descricao: e.target.value }))}
                placeholder={form.tipo === 'visita' ? 'O que foi discutido na visita?' : 'Observação importante...'}
                required
              />
            </div>
            {error && <p className="error-text">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                {saving ? 'Salvando...' : 'Registrar'}
              </button>
            </div>
          </form>
        )}

        <div className="historico-timeline">
          {loading ? (
            <div className="empty-state">Carregando...</div>
          ) : timeline.length === 0 ? (
            <div className="empty-state">Nenhuma interação registrada ainda.<br />Use os botões acima para registrar uma visita ou anotação.</div>
          ) : (
            timeline.map((item, i) => (
              <div key={item.id ?? i} className={`tl-item tl-${item._tipo}`}>
                <div className="tl-line" />
                <div className="tl-dot" />
                <div className="tl-body">
                  <div className="tl-meta">
                    <span className="tl-tipo">
                      {item._tipo === 'pedido' ? 'Pedido' : TIPO_LABEL[item._tipo]}
                    </span>
                    <span className="tl-date">{formatDate(item._date)}</span>
                  </div>
                  {item._tipo === 'pedido' ? (
                    <p className="tl-desc">
                      {item.forma_pagamento} — <strong>R$ {Number(item.total).toFixed(2)}</strong>
                      {' '}<span className={`badge ${STATUS_CLASS[item.status] ?? 'badge-warning'}`}>{item.status}</span>
                    </p>
                  ) : (
                    <p className="tl-desc">{item.descricao}</p>
                  )}
                  {item._tipo !== 'pedido' && (
                    <button className="tl-delete" onClick={() => handleDelete(item.id)} title="Remover">×</button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
