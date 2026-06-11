import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { CONDICOES_PAGAMENTO } from '../lib/constants'
import '../components/Page.css'

const TIPOS = ['mercadinho', 'bar', 'restaurante', 'distribuidor', 'outro']
const DIAS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']

const emptyForm = {
  nome: '',
  tipo: 'mercadinho',
  cnpj_cpf: '',
  telefone: '',
  endereco: '',
  bairro: '',
  cidade: '',
  dia_visita: '',
  condicao_pagamento: 'a_vista',
  limite_credito: 0,
  observacoes: '',
  ativo: true,
}

export default function Clientes() {
  const [clientes, setClientes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  async function loadClientes() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('clientes')
      .select('*')
      .order('nome', { ascending: true })

    if (error) setError(error.message)
    else setClientes(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadClientes()
  }, [])

  function openNew() {
    setEditingId(null)
    setForm(emptyForm)
    setShowModal(true)
  }

  function openEdit(cliente) {
    setEditingId(cliente.id)
    setForm({
      nome: cliente.nome ?? '',
      tipo: cliente.tipo ?? 'mercadinho',
      cnpj_cpf: cliente.cnpj_cpf ?? '',
      telefone: cliente.telefone ?? '',
      endereco: cliente.endereco ?? '',
      bairro: cliente.bairro ?? '',
      cidade: cliente.cidade ?? '',
      dia_visita: cliente.dia_visita ?? '',
      condicao_pagamento: cliente.condicao_pagamento ?? 'a_vista',
      limite_credito: cliente.limite_credito ?? 0,
      observacoes: cliente.observacoes ?? '',
      ativo: cliente.ativo ?? true,
    })
    setShowModal(true)
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const payload = {
      ...form,
      limite_credito: Number(form.limite_credito) || 0,
    }

    const { error } = editingId
      ? await supabase.from('clientes').update(payload).eq('id', editingId)
      : await supabase.from('clientes').insert(payload)

    setSaving(false)

    if (error) {
      setError(error.message)
      return
    }

    setShowModal(false)
    loadClientes()
  }

  async function handleDelete(id) {
    if (!confirm('Excluir este cliente?')) return
    const { error } = await supabase.from('clientes').delete().eq('id', id)
    if (error) setError(error.message)
    else loadClientes()
  }

  const filtered = clientes.filter((c) => {
    const term = search.trim().toLowerCase()
    if (!term) return true
    return (
      c.nome?.toLowerCase().includes(term) ||
      c.cidade?.toLowerCase().includes(term) ||
      c.bairro?.toLowerCase().includes(term) ||
      c.cnpj_cpf?.toLowerCase().includes(term)
    )
  })

  return (
    <div>
      <div className="page-header">
        <h1>Clientes</h1>
        <button className="btn btn-primary" onClick={openNew}>
          + Novo cliente
        </button>
      </div>

      <div className="toolbar">
        <input
          placeholder="Buscar por nome, bairro, cidade ou documento..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Nenhum cliente encontrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th>Telefone</th>
                <th>Cidade / Bairro</th>
                <th>Dia de visita</th>
                <th>Pagamento</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>{c.nome}</td>
                  <td>{c.tipo}</td>
                  <td>{c.telefone}</td>
                  <td>
                    {c.cidade}
                    {c.bairro ? ` - ${c.bairro}` : ''}
                  </td>
                  <td>{c.dia_visita || '-'}</td>
                  <td>
                    {CONDICOES_PAGAMENTO.find((o) => o.value === c.condicao_pagamento)
                      ?.label || c.condicao_pagamento}
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        c.ativo ? 'badge-success' : 'badge-danger'
                      }`}
                    >
                      {c.ativo ? 'Ativo' : 'Inativo'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => openEdit(c)}
                    >
                      Editar
                    </button>{' '}
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(c.id)}
                    >
                      Excluir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? 'Editar cliente' : 'Novo cliente'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Nome / Razão social</label>
                  <input
                    name="nome"
                    value={form.nome}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="form-field">
                  <label>Tipo</label>
                  <select name="tipo" value={form.tipo} onChange={handleChange}>
                    {TIPOS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>CNPJ / CPF</label>
                  <input
                    name="cnpj_cpf"
                    value={form.cnpj_cpf}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Telefone</label>
                  <input
                    name="telefone"
                    value={form.telefone}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Dia de visita</label>
                  <select
                    name="dia_visita"
                    value={form.dia_visita}
                    onChange={handleChange}
                  >
                    <option value="">-</option>
                    {DIAS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field full">
                  <label>Endereço</label>
                  <input
                    name="endereco"
                    value={form.endereco}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Bairro</label>
                  <input
                    name="bairro"
                    value={form.bairro}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Cidade</label>
                  <input
                    name="cidade"
                    value={form.cidade}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Condição de pagamento</label>
                  <select
                    name="condicao_pagamento"
                    value={form.condicao_pagamento}
                    onChange={handleChange}
                  >
                    {CONDICOES_PAGAMENTO.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Limite de crédito (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="limite_credito"
                    value={form.limite_credito}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field full">
                  <label>Observações</label>
                  <textarea
                    name="observacoes"
                    rows={2}
                    value={form.observacoes}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>
                    <input
                      type="checkbox"
                      name="ativo"
                      checked={form.ativo}
                      onChange={handleChange}
                    />{' '}
                    Ativo
                  </label>
                </div>
              </div>

              {error && <p className="error-text">{error}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowModal(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
