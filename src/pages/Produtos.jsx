import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const CATEGORIAS = [
  'cerveja',
  'refrigerante',
  'agua',
  'energetico',
  'destilado',
  'suco',
  'outros',
]
const EMBALAGENS = ['unidade', 'lata', 'garrafa', 'caixa', 'fardo']

const emptyForm = {
  nome: '',
  categoria: 'cerveja',
  embalagem: 'caixa',
  unidades_por_caixa: 1,
  controla_casco: false,
  preco_custo: 0,
  preco_venda: 0,
  estoque_minimo: 0,
  ativo: true,
}

export default function Produtos() {
  const [produtos, setProdutos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [categoriaFiltro, setCategoriaFiltro] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  async function loadProdutos() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('produtos')
      .select('*')
      .order('nome', { ascending: true })

    if (error) setError(error.message)
    else setProdutos(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadProdutos()
  }, [])

  function openNew() {
    setEditingId(null)
    setForm(emptyForm)
    setShowModal(true)
  }

  function openEdit(produto) {
    setEditingId(produto.id)
    setForm({
      nome: produto.nome ?? '',
      categoria: produto.categoria ?? 'cerveja',
      embalagem: produto.embalagem ?? 'caixa',
      unidades_por_caixa: produto.unidades_por_caixa ?? 1,
      controla_casco: produto.controla_casco ?? false,
      preco_custo: produto.preco_custo ?? 0,
      preco_venda: produto.preco_venda ?? 0,
      estoque_minimo: produto.estoque_minimo ?? 0,
      ativo: produto.ativo ?? true,
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
      unidades_por_caixa: Number(form.unidades_por_caixa) || 1,
      preco_custo: Number(form.preco_custo) || 0,
      preco_venda: Number(form.preco_venda) || 0,
      estoque_minimo: Number(form.estoque_minimo) || 0,
    }

    const { error } = editingId
      ? await supabase.from('produtos').update(payload).eq('id', editingId)
      : await supabase.from('produtos').insert(payload)

    setSaving(false)

    if (error) {
      setError(error.message)
      return
    }

    setShowModal(false)
    loadProdutos()
  }

  async function handleDelete(id) {
    if (!confirm('Excluir este produto?')) return
    const { error } = await supabase.from('produtos').delete().eq('id', id)
    if (error) setError(error.message)
    else loadProdutos()
  }

  const filtered = produtos.filter((p) => {
    const term = search.trim().toLowerCase()
    const matchesSearch = !term || p.nome?.toLowerCase().includes(term)
    const matchesCategoria = !categoriaFiltro || p.categoria === categoriaFiltro
    return matchesSearch && matchesCategoria
  })

  return (
    <div>
      <div className="page-header">
        <h1>Produtos</h1>
        <button className="btn btn-primary" onClick={openNew}>
          + Novo produto
        </button>
      </div>

      <div className="toolbar">
        <input
          placeholder="Buscar por nome..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={categoriaFiltro}
          onChange={(e) => setCategoriaFiltro(e.target.value)}
        >
          <option value="">Todas as categorias</option>
          {CATEGORIAS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Nenhum produto encontrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Categoria</th>
                <th>Embalagem</th>
                <th>Un./caixa</th>
                <th>Casco</th>
                <th>Custo</th>
                <th>Venda</th>
                <th>Estoque mín.</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>{p.nome}</td>
                  <td>{p.categoria}</td>
                  <td>{p.embalagem}</td>
                  <td>{p.unidades_por_caixa}</td>
                  <td>{p.controla_casco ? 'Sim' : 'Não'}</td>
                  <td>R$ {Number(p.preco_custo).toFixed(2)}</td>
                  <td>R$ {Number(p.preco_venda).toFixed(2)}</td>
                  <td>{p.estoque_minimo}</td>
                  <td>
                    <span
                      className={`badge ${
                        p.ativo ? 'badge-success' : 'badge-danger'
                      }`}
                    >
                      {p.ativo ? 'Ativo' : 'Inativo'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => openEdit(p)}
                    >
                      Editar
                    </button>{' '}
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(p.id)}
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
            <h2>{editingId ? 'Editar produto' : 'Novo produto'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Nome</label>
                  <input
                    name="nome"
                    value={form.nome}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="form-field">
                  <label>Categoria</label>
                  <select
                    name="categoria"
                    value={form.categoria}
                    onChange={handleChange}
                  >
                    {CATEGORIAS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Embalagem</label>
                  <select
                    name="embalagem"
                    value={form.embalagem}
                    onChange={handleChange}
                  >
                    {EMBALAGENS.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Unidades por caixa</label>
                  <input
                    type="number"
                    min="1"
                    name="unidades_por_caixa"
                    value={form.unidades_por_caixa}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>
                    <input
                      type="checkbox"
                      name="controla_casco"
                      checked={form.controla_casco}
                      onChange={handleChange}
                    />{' '}
                    Controla vasilhame (casco)
                  </label>
                </div>

                <div className="form-field">
                  <label>Preço de custo (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="preco_custo"
                    value={form.preco_custo}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Preço de venda (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="preco_venda"
                    value={form.preco_venda}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Estoque mínimo</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="estoque_minimo"
                    value={form.estoque_minimo}
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
