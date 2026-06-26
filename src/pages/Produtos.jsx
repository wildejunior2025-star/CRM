import { useCallback, useEffect, useRef, useState } from 'react'
import React from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const PAGE_SIZE = 50

// eslint-disable-next-line no-unused-vars
const EMBALAGENS = ['unidade', 'lata', 'garrafa', 'caixa', 'fardo']

const emptyForm = {
  nome: '',
  categoria: '',
  embalagem: 'caixa',
  unidades_por_caixa: 1,
  controla_casco: false,
  preco_custo: 0,
  preco_venda: 0,
  preco_app: 0,
  faixas_preco: [],
  estoque_minimo: 0,
  ativo: true,
  foto_url: '',
  descricao: '',
}

const CATALOGO_BASE = 'https://lojaonline.fwcinter.com'

export default function Produtos() {
  const { profile, empresa } = useAuth()
  const [copiadoLink, setCopiadoLink] = useState(false)

  const slug = empresa?.slug ?? null
  const linkCardapio = slug ? `${CATALOGO_BASE}/${slug}` : null

  function copiarLink() {
    if (!linkCardapio) return
    navigator.clipboard.writeText(linkCardapio)
    setCopiadoLink(true)
    setTimeout(() => setCopiadoLink(false), 2000)
  }
  const fileInputRef = useRef(null)

  const [produtos, setProdutos] = useState([])
  const [categorias, setCategorias] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [categoriaFiltro, setCategoriaFiltro] = useState('')
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const debounceRef = useRef(null)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [uploadingFoto, setUploadingFoto] = useState(false)

  const [showCategModal, setShowCategModal] = useState(false)
  const [novaCategoria, setNovaCategoria] = useState('')
  const [savingCateg, setSavingCateg] = useState(false)
  const [categError, setCategError] = useState(null)

  const [embalagens, setEmbalagens] = useState([])
  const [showEmbalagensModal, setShowEmbalagensModal] = useState(false)
  const [novaEmbalagem, setNovaEmbalagem] = useState('')
  const [savingEmb, setSavingEmb] = useState(false)
  const [embError, setEmbError] = useState(null)

  async function loadCategorias() {
    const { data } = await supabase
      .from('categorias')
      .select('id, nome')
      .order('nome', { ascending: true })
    setCategorias(data ?? [])
  }

  async function loadEmbalagens() {
    const { data } = await supabase
      .from('embalagens')
      .select('id, nome')
      .order('nome', { ascending: true })
    setEmbalagens(data ?? [])
  }

  const loadProdutos = useCallback(async (busca = '', categ = '', pg = 0) => {
    setLoading(true)
    setError(null)
    let query = supabase
      .from('produtos')
      .select('*', { count: 'exact' })
      .order('categoria', { ascending: true })
      .order('nome', { ascending: true })
      .range(pg * PAGE_SIZE, pg * PAGE_SIZE + PAGE_SIZE - 1)
    if (busca.trim()) query = query.ilike('nome', `%${busca.trim()}%`)
    if (categ) query = query.eq('categoria', categ)
    const { data, error, count } = await query
    if (error) setError(error.message)
    else { setProdutos(data ?? []); setTotal(count ?? 0) }
    setLoading(false)
  }, [])

  function handleSearch(val) {
    setSearch(val)
    setPage(0)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => loadProdutos(val, categoriaFiltro, 0), 400)
  }

  function handleCategoria(val) {
    setCategoriaFiltro(val)
    setPage(0)
    loadProdutos(search, val, 0)
  }

  function irParaPagina(pg) {
    setPage(pg)
    loadProdutos(search, categoriaFiltro, pg)
  }

  useEffect(() => {
    loadProdutos('', '', 0)
    loadCategorias()
    loadEmbalagens()
  }, [loadProdutos])

  async function handleSaveCategoria(e) {
    e.preventDefault()
    const nome = novaCategoria.trim()
    if (!nome) return
    if (!profile?.empresa_id) { setCategError('Empresa não identificada.'); return }
    setSavingCateg(true)
    setCategError(null)
    const { error } = await supabase.rpc('add_categoria', { p_nome: nome })
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

  async function handleAddEmbalagem(e) {
    e.preventDefault()
    const nome = novaEmbalagem.trim()
    if (!nome) return
    setSavingEmb(true)
    setEmbError(null)
    const { error } = await supabase.rpc('add_embalagem', { p_nome: nome })
    setSavingEmb(false)
    if (error) { setEmbError(error.message); return }
    setNovaEmbalagem('')
    loadEmbalagens()
  }

  async function handleDeleteEmbalagem(id) {
    if (!confirm('Excluir esta embalagem?')) return
    const { error } = await supabase.from('embalagens').delete().eq('id', id)
    if (error) { setEmbError(error.message); return }
    loadEmbalagens()
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
      preco_app: produto.preco_app ?? 0,
      faixas_preco: produto.faixas_preco ?? [],
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
      preco_app: Number(form.preco_app) || 0,
      estoque_minimo: Number(form.estoque_minimo) || 0,
      faixas_preco: form.faixas_preco ?? [],
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
    loadProdutos(search, categoriaFiltro, page)
  }

  async function handleDelete(id) {
    if (!confirm('Excluir este produto?')) return
    const { error } = await supabase.from('produtos').delete().eq('id', id)
    if (error) setError(error.message)
    else loadProdutos(search, categoriaFiltro, page)
  }

  const totalPaginas = Math.ceil(total / PAGE_SIZE)

  return (
    <div>
      <div className="page-header">
        <h1>Produtos</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={() => { setCategError(null); setShowCategModal(true) }}>
            + Nova categoria
          </button>
          <button className="btn btn-secondary" onClick={() => { setEmbError(null); setShowEmbalagensModal(true) }}>
            + Nova embalagem
          </button>
          <button className="btn btn-primary" onClick={openNew}>
            + Novo produto
          </button>
        </div>
      </div>

      {/* Banner link do cardápio */}
      {linkCardapio && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          background: 'var(--bg-secondary, #f9fafb)',
          border: '1px solid var(--border, #e5e7eb)',
          borderRadius: '10px', padding: '12px 16px', marginBottom: '1rem',
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
            🛒 Link do seu cardápio:
          </span>
          <span style={{
            fontSize: 13, color: 'var(--text-muted, #6b7280)',
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {linkCardapio}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
            <button className="btn btn-secondary btn-sm" onClick={copiarLink}>
              {copiadoLink ? '✓ Copiado!' : 'Copiar'}
            </button>
            <a href={linkCardapio} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
              Abrir
            </a>
          </div>
        </div>
      )}

      <div className="toolbar">
        <input
          placeholder="Buscar por nome..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
        />
        <select
          value={categoriaFiltro}
          onChange={(e) => handleCategoria(e.target.value)}
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
        ) : produtos.length === 0 ? (
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
                <th>Venda App</th>
                <th>Estoque mín.</th>
                <th>Status</th>
                <th style={{ position: 'sticky', right: 0, background: 'var(--bg)' }}></th>
              </tr>
            </thead>
            <tbody>
              {produtos.map((p, idx) => {
                const catAnterior = idx === 0 ? null : produtos[idx - 1].categoria
                const mudouCategoria = p.categoria !== catAnterior
                return (
                  <React.Fragment key={p.id}>
                    {mudouCategoria && (
                      <tr>
                        <td colSpan={11} style={{
                          padding: '10px 12px 6px',
                          fontWeight: 700,
                          fontSize: 12,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          color: 'var(--primary)',
                          background: 'var(--primary-bg)',
                          borderTop: idx !== 0 ? '2px solid var(--border)' : 'none',
                        }}>
                          {p.categoria || 'Sem categoria'}
                        </td>
                      </tr>
                    )}
                    <tr>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {p.foto_url ? (
                        <img
                          src={p.foto_url}
                          alt={p.nome}
                          style={{ width: 52, height: 52, borderRadius: 8, objectFit: 'cover', flexShrink: 0, border: '1px solid var(--border)' }}
                        />
                      ) : (
                        <div style={{ width: 52, height: 52, borderRadius: 8, background: 'var(--bg-hover)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 20 }}>
                          📷
                        </div>
                      )}
                      {p.nome}
                    </div>
                  </td>
                  <td>{p.categoria}</td>
                  <td>{p.embalagem}</td>
                  <td>{p.unidades_por_caixa}</td>
                  <td>{p.controla_casco ? 'Sim' : 'Não'}</td>
                  <td>R$ {Number(p.preco_custo).toFixed(2)}</td>
                  <td>R$ {Number(p.preco_venda).toFixed(2)}</td>
                  <td>R$ {Number(p.preco_app || 0).toFixed(2)}</td>
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
                  <td style={{ position: 'sticky', right: 0, background: 'var(--surface)', boxShadow: '-4px 0 8px rgba(0,0,0,0.15)' }}>
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
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {totalPaginas > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '16px 0' }}>
          <button className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => irParaPagina(page - 1)}>
            ← Anterior
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} de {total} produtos
          </span>
          <button className="btn btn-secondary btn-sm" disabled={page + 1 >= totalPaginas} onClick={() => irParaPagina(page + 1)}>
            Próximo →
          </button>
        </div>
      )}

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
                    <option value="">Selecione...</option>
                    {embalagens.map((e) => (
                      <option key={e.id} value={e.nome}>
                        {e.nome}
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
                  <label style={{color:'#f97316'}}>Preço de custo (R$)</label>
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
                  <label style={{color:'#22c55e'}}>Preço Público (R$) <span style={{fontWeight:400, fontSize:'0.8em', color:'var(--text-muted)'}}>WhatsApp / link</span></label>
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
                  <label style={{color:'#a855f7'}}>Preço App (R$) <span style={{fontWeight:400, fontSize:'0.8em', color:'var(--text-muted)'}}>FWC Inter app</span></label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="preco_app"
                    value={form.preco_app}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field full">
                  <label>
                    Preços por quantidade{' '}
                    <span style={{ fontWeight: 400, fontSize: '0.85em', color: 'var(--text-muted)' }}>
                      (opcional)
                    </span>
                  </label>

                  {form.faixas_preco.length > 0 && (
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr auto',
                      gap: '6px 8px',
                      marginBottom: 8,
                      alignItems: 'center',
                    }}>
                      <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Qtd mínima</span>
                      <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Preço (R$)</span>
                      <span />
                      {form.faixas_preco.map((f, i) => (
                        <React.Fragment key={i}>
                          <input
                            type="number"
                            min="2"
                            value={f.qtd_min}
                            onChange={e => {
                              const arr = [...form.faixas_preco]
                              arr[i] = { ...arr[i], qtd_min: Number(e.target.value) }
                              setForm(prev => ({ ...prev, faixas_preco: arr }))
                            }}
                            placeholder="Ex: 10"
                          />
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={f.preco}
                            onChange={e => {
                              const arr = [...form.faixas_preco]
                              arr[i] = { ...arr[i], preco: Number(e.target.value) }
                              setForm(prev => ({ ...prev, faixas_preco: arr }))
                            }}
                            placeholder="Ex: 8.50"
                          />
                          <button
                            type="button"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--danger, #e55)',
                              cursor: 'pointer',
                              fontSize: '1.1em',
                              padding: '2px 6px',
                              lineHeight: 1,
                            }}
                            onClick={() => {
                              const arr = form.faixas_preco.filter((_, idx) => idx !== i)
                              setForm(prev => ({ ...prev, faixas_preco: arr }))
                            }}
                            title="Remover faixa"
                          >
                            ✕
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setForm(prev => ({
                      ...prev,
                      faixas_preco: [...prev.faixas_preco, { qtd_min: '', preco: '' }],
                    }))}
                  >
                    + Adicionar faixa de preço
                  </button>
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

      {showEmbalagensModal && (
        <div className="modal-overlay" onClick={() => setShowEmbalagensModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Embalagens</h2>

            <form onSubmit={handleAddEmbalagem} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                placeholder="Nome da nova embalagem"
                value={novaEmbalagem}
                onChange={(e) => setNovaEmbalagem(e.target.value)}
                style={{ flex: 1 }}
                required
              />
              <button type="submit" className="btn btn-primary" disabled={savingEmb}>
                {savingEmb ? 'Salvando...' : 'Adicionar'}
              </button>
            </form>

            {embError && <p className="error-text">{embError}</p>}

            <div className="data-table">
              {embalagens.length === 0 ? (
                <div className="empty-state">Nenhuma embalagem cadastrada.</div>
              ) : (
                <table>
                  <tbody>
                    {embalagens.map((e) => (
                      <tr key={e.id}>
                        <td>{e.nome}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDeleteEmbalagem(e.id)}
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
              <button className="btn btn-secondary" onClick={() => setShowEmbalagensModal(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
