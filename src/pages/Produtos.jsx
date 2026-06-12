import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const EMBALAGENS = ['unidade', 'lata', 'garrafa', 'caixa', 'fardo']

const emptyForm = {
  nome: '',
  categoria: '',
  embalagem: 'caixa',
  unidades_por_caixa: 1,
  controla_casco: false,
  preco_custo: 0,
  preco_venda: 0,
  estoque_minimo: 0,
  ativo: true,
  foto_url: '',
  descricao: '',
}

export default function Produtos() {
  const { profile } = useAuth()
  const fileInputRef = useRef(null)

  const [produtos, setProdutos] = useState([])
  const [categorias, setCategorias] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [categoriaFiltro, setCategoriaFiltro] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [uploadingFoto, setUploadingFoto] = useState(false)

  const [showCategModal, setShowCategModal] = useState(false)
  const [novaCategoria, setNovaCategoria] = useState('')
  const [savingCateg, setSavingCateg] = useState(false)
  const [categError, setCategError] = useState(null)

  async function loadCategorias() {
    const { data } = await supabase
      .from('categorias')
      .select('id, nome')
      .order('nome', { ascending: true })
    setCategorias(data ?? [])
  }

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
    loadCategorias()
  }, [])

  async function handleSaveCategoria(e) {
    e.preventDefault()
    const nome = novaCategoria.trim()
    if (!nome) return
    setSavingCateg(true)
    setCategError(null)
    const { error } = await supabase.from('categorias').insert({ nome })
    setSavingCateg(false)
    if (error) { setCategError(error.message); return }
    setNovaCategoria('')
    loadCategorias()
  }

  async function handleDeleteCategoria(id) {
    if (!confirm('Excluir esta categoria?')) return
    const { error } = await supabase.from('categorias').delete().eq('id', id)
    if (error) { setCategError(error.message); return }
    loadCategorias()
  }

  function openNew() {
    setEditingId(null)
    setForm({ ...emptyForm, categoria: categorias[0]?.nome ?? '' })
    setShowModal(true)
  }

  function openEdit(produto) {
    setEditingId(produto.id)
    setForm({
      nome: produto.nome ?? '',
      categoria: produto.categoria ?? categorias[0]?.nome ?? '',
      embalagem: produto.embalagem ?? 'caixa',
      unidades_por_caixa: produto.unidades_por_caixa ?? 1,
      controla_casco: produto.controla_casco ?? false,
      preco_custo: produto.preco_custo ?? 0,
      preco_venda: produto.preco_venda ?? 0,
      estoque_minimo: produto.estoque_minimo ?? 0,
      ativo: produto.ativo ?? true,
      foto_url: produto.foto_url ?? '',
      descricao: produto.descricao ?? '',
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

  async function handleFotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!profile?.empresa_id) { setError('Empresa não identificada para upload.'); return }

    setUploadingFoto(true)
    setError(null)

    const path = `${profile.empresa_id}/${Date.now()}_${file.name}`
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('produto-fotos')
      .upload(path, file, { upsert: true })

    setUploadingFoto(false)

    if (uploadError) { setError(`Erro no upload: ${uploadError.message}`); return }

    const { data: urlData } = supabase.storage
      .from('produto-fotos')
      .getPublicUrl(uploadData.path)

    setForm(prev => ({ ...prev, foto_url: urlData.publicUrl }))
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
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={() => { setCategError(null); setShowCategModal(true) }}>
            + Nova categoria
          </button>
          <button className="btn btn-primary" onClick={openNew}>
            + Novo produto
          </button>
        </div>
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
          {categorias.map((c) => (
            <option key={c.id} value={c.nome}>
              {c.nome}
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

                <div className="form-field full">
                  <label>Descrição (aparece no portal do cliente)</label>
                  <textarea
                    name="descricao"
                    value={form.descricao}
                    onChange={handleChange}
                    rows={2}
                    placeholder="Ex: Cerveja gelada, 350ml, sabor original..."
                    style={{ resize: 'vertical', minHeight: 56 }}
                  />
                </div>

                <div className="form-field full">
                  <label>Foto do produto</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleFotoChange}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingFoto}
                  >
                    {uploadingFoto ? 'Enviando...' : 'Escolher foto'}
                  </button>
                  {form.foto_url && (
                    <img
                      src={form.foto_url}
                      alt="Preview"
                      style={{ width: '100%', maxHeight: 180, objectFit: 'cover', borderRadius: 8, marginTop: 8 }}
                    />
                  )}
                </div>

                <div className="form-field">
                  <label>Categoria</label>
                  <select
                    name="categoria"
                    value={form.categoria}
                    onChange={handleChange}
                    required
                  >
                    <option value="">Selecione...</option>
                    {categorias.map((c) => (
                      <option key={c.id} value={c.nome}>
                        {c.nome}
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

      {showCategModal && (
        <div className="modal-overlay" onClick={() => setShowCategModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Categorias</h2>

            <form onSubmit={handleSaveCategoria} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                placeholder="Nome da nova categoria"
                value={novaCategoria}
                onChange={(e) => setNovaCategoria(e.target.value)}
                style={{ flex: 1 }}
                required
              />
              <button type="submit" className="btn btn-primary" disabled={savingCateg}>
                {savingCateg ? 'Salvando...' : 'Adicionar'}
              </button>
            </form>

            {categError && <p className="error-text">{categError}</p>}

            <div className="data-table">
              {categorias.length === 0 ? (
                <div className="empty-state">Nenhuma categoria cadastrada.</div>
              ) : (
                <table>
                  <tbody>
                    {categorias.map((c) => (
                      <tr key={c.id}>
                        <td>{c.nome}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDeleteCategoria(c.id)}
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

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowCategModal(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
