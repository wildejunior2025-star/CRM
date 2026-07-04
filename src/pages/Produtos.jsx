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
  controla_estoque: true,
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

  // Complementos / opções do produto (ex.: monte sua quentinha)
  const [grupos, setGrupos] = useState([])

  // Complementos na LISTA (accordion pausável estilo iFood, direto na tabela)
  const [compProd, setCompProd] = useState({})            // produtoId -> [grupos]
  const [compAberto, setCompAberto] = useState(() => new Set())
  const [pausandoComp, setPausandoComp] = useState(null)

  function toggleAbrirComp(produtoId) {
    setCompAberto(prev => {
      const n = new Set(prev)
      n.has(produtoId) ? n.delete(produtoId) : n.add(produtoId)
      return n
    })
  }
  async function togglePausarGrupoLista(produtoId, grupo) {
    const novo = grupo.disponivel === false
    setPausandoComp(grupo.id)
    const patch = (val) => setCompProd(prev => ({
      ...prev, [produtoId]: (prev[produtoId] ?? []).map(g => g.id === grupo.id ? { ...g, disponivel: val } : g),
    }))
    patch(novo)
    const { error } = await supabase.from('complemento_grupos').update({ disponivel: novo }).eq('id', grupo.id)
    setPausandoComp(null)
    if (error) patch(grupo.disponivel)
  }
  async function togglePausarOpcaoLista(produtoId, grupoId, op) {
    const novo = op.disponivel === false
    setPausandoComp(op.id)
    const patch = (val) => setCompProd(prev => ({
      ...prev, [produtoId]: (prev[produtoId] ?? []).map(g => g.id !== grupoId ? g : {
        ...g, opcoes: g.opcoes.map(o => o.id === op.id ? { ...o, disponivel: val } : o),
      }),
    }))
    patch(novo)
    const { error } = await supabase.from('complemento_opcoes').update({ disponivel: novo }).eq('id', op.id)
    setPausandoComp(null)
    if (error) patch(op.disponivel)
  }

  async function loadComplementos(produtoId) {
    const { data } = await supabase
      .from('complemento_grupos')
      .select('id, nome, min, max, ordem, complemento_opcoes(id, nome, preco_adicional, ordem)')
      .eq('produto_id', produtoId)
      .order('ordem')
    const gs = (data ?? []).map(g => ({
      id: g.id, nome: g.nome, min: g.min ?? 0, max: g.max ?? 1,
      opcoes: (g.complemento_opcoes ?? [])
        .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
        .map(o => ({ id: o.id, nome: o.nome, preco: o.preco_adicional ?? 0 })),
    }))
    setGrupos(gs)
  }

  function updGrupo(gi, patch) {
    setGrupos(prev => prev.map((g, i) => (i === gi ? { ...g, ...patch } : g)))
  }
  function updOpcao(gi, oi, patch) {
    setGrupos(prev => prev.map((g, i) =>
      i === gi ? { ...g, opcoes: g.opcoes.map((o, j) => (j === oi ? { ...o, ...patch } : o)) } : g))
  }

  const [showCategModal, setShowCategModal] = useState(false)
  const [dragIdx, setDragIdx] = useState(null)
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
      .select('id, nome, ordem, hora_inicio, hora_fim')
      .order('ordem', { ascending: true })
      .order('nome', { ascending: true })
    setCategorias(data ?? [])
  }

  // Salva o horário de disponibilidade da categoria (hora_inicio/hora_fim).
  // Vazio => null (sempre disponível). Otimista + persiste.
  async function salvarHorarioCategoria(id, campo, valor) {
    const v = valor ? valor : null
    setCategorias(cs => cs.map(c => (c.id === id ? { ...c, [campo]: v } : c)))
    await supabase.from('categorias').update({ [campo]: v }).eq('id', id)
  }

  // Persiste a ordem 1..n de uma nova lista de categorias (otimista)
  async function persistOrdem(novaLista) {
    setCategorias(novaLista.map((c, i) => ({ ...c, ordem: i + 1 })))
    await Promise.all(novaLista.map((c, i) =>
      supabase.from('categorias').update({ ordem: i + 1 }).eq('id', c.id)))
    loadCategorias()
  }

  // Setas (reserva / celular)
  function moverCategoria(index, dir) {
    const outro = index + dir
    if (outro < 0 || outro >= categorias.length) return
    const arr = [...categorias]
    ;[arr[index], arr[outro]] = [arr[outro], arr[index]]
    persistOrdem(arr)
  }

  // Arrastar e soltar
  function onSoltarCategoria(dropIdx) {
    const from = dragIdx
    setDragIdx(null)
    if (from == null || from === dropIdx) return
    const arr = [...categorias]
    const [movida] = arr.splice(from, 1)
    arr.splice(dropIdx, 0, movida)
    persistOrdem(arr)
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
    else {
      setProdutos(data ?? [])
      setTotal(count ?? 0)
      // Complementos dos produtos exibidos (accordion pausável na própria lista)
      const ids = (data ?? []).map(p => p.id)
      if (ids.length) {
        const { data: gs } = await supabase
          .from('complemento_grupos')
          .select('id, produto_id, nome, min, max, ordem, disponivel, complemento_opcoes(id, nome, preco_adicional, disponivel, ordem)')
          .in('produto_id', ids)
          .order('ordem')
        const map = {}
        for (const g of (gs ?? [])) {
          const opcoes = (g.complemento_opcoes ?? []).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
          ;(map[g.produto_id] ??= []).push({
            id: g.id, nome: g.nome, min: g.min ?? 0, max: g.max ?? 1, ordem: g.ordem ?? 0,
            disponivel: g.disponivel !== false, opcoes,
          })
        }
        for (const pid in map) map[pid].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
        setCompProd(map)
      } else setCompProd({})
    }
    setLoading(false)
  }, [])

  // Pausar/ativar disponibilidade do produto (1 clique na lista). Não é estoque —
  // é só ligar/desligar o item pra vender (loja online, bot, balcão).
  async function togglePausar(p) {
    const novo = !p.ativo
    setProdutos(prev => prev.map(x => x.id === p.id ? { ...x, ativo: novo } : x))
    const { error } = await supabase.from('produtos').update({ ativo: novo }).eq('id', p.id)
    if (error) {
      setProdutos(prev => prev.map(x => x.id === p.id ? { ...x, ativo: !novo } : x))
      setError(error.message)
    }
  }

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
    setGrupos([])
    setForm({ ...emptyForm, categoria: categorias[0]?.nome ?? '' })
    setShowModal(true)
  }

  function openEdit(produto) {
    setEditingId(produto.id)
    setGrupos([])
    loadComplementos(produto.id)
    setForm({
      nome: produto.nome ?? '',
      categoria: produto.categoria ?? categorias[0]?.nome ?? '',
      embalagem: produto.embalagem ?? 'caixa',
      unidades_por_caixa: produto.unidades_por_caixa ?? 1,
      controla_casco: produto.controla_casco ?? false,
      controla_estoque: produto.controla_estoque ?? true,
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

    const { data: saved, error } = editingId
      ? await supabase.from('produtos').update(payload).eq('id', editingId).select('id').single()
      : await supabase.from('produtos').insert(payload).select('id').single()

    if (error) {
      setSaving(false)
      setError(error.message)
      return
    }

    // Persiste os complementos (recria: apaga os antigos e insere os atuais)
    const produtoId = saved.id
    try {
      await supabase.from('complemento_grupos').delete().eq('produto_id', produtoId)
      for (const [gi, g] of grupos.entries()) {
        if (!g.nome.trim()) continue
        const { data: gIns } = await supabase
          .from('complemento_grupos')
          .insert({
            empresa_id: profile.empresa_id, produto_id: produtoId, nome: g.nome.trim(),
            min: Number(g.min) || 0, max: Number(g.max) || 1, ordem: gi,
          })
          .select('id').single()
        if (!gIns) continue
        const ops = (g.opcoes || [])
          .filter(o => o.nome.trim())
          .map((o, oi) => ({ grupo_id: gIns.id, nome: o.nome.trim(), preco_adicional: Number(o.preco) || 0, ordem: oi }))
        if (ops.length) await supabase.from('complemento_opcoes').insert(ops)
      }
    } catch (err) {
      setSaving(false)
      setError('Produto salvo, mas houve erro nos complementos: ' + (err?.message ?? err))
      return
    }

    setSaving(false)
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

  // Ordena os produtos exibidos seguindo a ordem personalizada das categorias
  const catOrdem = Object.fromEntries(categorias.map(c => [c.nome, c.ordem ?? 999]))
  const produtosOrdenados = [...produtos].sort((a, b) => {
    const oa = catOrdem[a.categoria] ?? 999
    const ob = catOrdem[b.categoria] ?? 999
    if (oa !== ob) return oa - ob
    return (a.nome ?? '').localeCompare(b.nome ?? '')
  })

  return (
    <div>
      <div className="page-header">
        <h1>Produtos</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={() => { setCategError(null); setShowCategModal(true) }}>
            ☰ Categorias
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
                <th>Disponível</th>
                <th style={{ position: 'sticky', right: 0, background: 'var(--bg)' }}></th>
              </tr>
            </thead>
            <tbody>
              {produtosOrdenados.map((p, idx) => {
                const catAnterior = idx === 0 ? null : produtosOrdenados[idx - 1].categoria
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
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                        <span>{p.nome}</span>
                        {(compProd[p.id]?.length > 0) && (
                          <button
                            type="button"
                            onClick={() => toggleAbrirComp(p.id)}
                            title="Ver e pausar os complementos"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                              padding: '3px 10px', borderRadius: 20, fontWeight: 700, fontSize: 12,
                              border: `1.5px solid ${compAberto.has(p.id) ? '#2563eb' : 'var(--border)'}`,
                              background: compAberto.has(p.id) ? 'rgba(37,99,235,.12)' : 'transparent',
                              color: compAberto.has(p.id) ? '#2563eb' : 'var(--text-muted)',
                            }}
                          >
                            Complementos
                            <span style={{ fontWeight: 800, background: 'rgba(148,163,184,.25)', borderRadius: 20, padding: '0 6px' }}>{compProd[p.id].length}</span>
                            <span style={{ transform: compAberto.has(p.id) ? 'rotate(180deg)' : 'none', transition: 'transform .15s', fontSize: 10 }}>▼</span>
                          </button>
                        )}
                      </div>
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
                    <button
                      type="button"
                      onClick={() => togglePausar(p)}
                      title={p.ativo ? 'Pausar — deixa indisponível pra vender' : 'Ativar — volta a aparecer pra vender'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                        padding: '5px 12px', borderRadius: 20, fontWeight: 700, fontSize: 13,
                        border: `1.5px solid ${p.ativo ? '#16a34a' : '#eab308'}`,
                        background: p.ativo ? 'rgba(22,163,74,.12)' : 'rgba(234,179,8,.16)',
                        color: p.ativo ? '#16a34a' : '#a16207',
                      }}
                    >
                      {p.ativo ? '⏸ Pausar' : '▶ Ativar'}
                    </button>
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
                {/* Complementos aninhados (grupos + opções) — estilo iFood */}
                {compAberto.has(p.id) && (compProd[p.id]?.length > 0) && (
                  <tr>
                    <td colSpan={11} style={{ padding: 0, background: 'var(--bg-hover)' }}>
                      <div style={{ padding: '8px 12px 12px 74px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {compProd[p.id].map(g => {
                          const gPausado = g.disponivel === false
                          const qtd = g.max > 1 ? `escolha até ${g.max}` : (g.min > 0 ? 'obrigatório' : 'opcional')
                          return (
                            <div key={g.id} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--surface)', opacity: gPausado ? 0.6 : 1 }}>
                              {/* Cabeçalho do grupo (subcategoria) */}
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px', background: 'var(--bg)' }}>
                                <div>
                                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>
                                    {g.nome}
                                    {gPausado && <span style={{ color: '#dc2626', fontWeight: 700 }}> · Pausado</span>}
                                  </div>
                                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{qtd} · {g.opcoes.length} {g.opcoes.length === 1 ? 'opção' : 'opções'}</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => togglePausarGrupoLista(p.id, g)}
                                  disabled={pausandoComp === g.id}
                                  style={{
                                    flexShrink: 0, padding: '6px 14px', borderRadius: 20, cursor: 'pointer',
                                    fontWeight: 700, fontSize: 13, border: '1.5px solid',
                                    borderColor: gPausado ? '#16a34a' : '#dc2626',
                                    background: gPausado ? 'rgba(22,163,74,.12)' : 'rgba(239,68,68,.12)',
                                    color: gPausado ? '#16a34a' : '#dc2626',
                                  }}
                                >
                                  {pausandoComp === g.id ? '...' : gPausado ? '▶ Ativar grupo' : '⏸ Pausar grupo'}
                                </button>
                              </div>
                              {/* Opções do grupo */}
                              {g.opcoes.map(op => {
                                const oPausado = op.disponivel === false
                                return (
                                  <div key={op.id} style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                                    padding: '7px 12px', borderTop: '1px solid var(--border)', opacity: oPausado ? 0.55 : 1,
                                  }}>
                                    <div style={{ fontSize: 13, color: 'var(--text)' }}>
                                      {op.nome}
                                      {Number(op.preco_adicional) > 0 && <span style={{ color: 'var(--text-muted)' }}> · +R$ {Number(op.preco_adicional).toFixed(2)}</span>}
                                      {oPausado && <span style={{ color: '#dc2626', fontWeight: 700 }}> · Pausado</span>}
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => togglePausarOpcaoLista(p.id, g.id, op)}
                                      disabled={pausandoComp === op.id}
                                      style={{
                                        flexShrink: 0, padding: '5px 14px', borderRadius: 20, cursor: 'pointer',
                                        fontWeight: 700, fontSize: 13, border: '1.5px solid',
                                        borderColor: oPausado ? '#16a34a' : '#dc2626',
                                        background: oPausado ? 'rgba(22,163,74,.12)' : 'rgba(239,68,68,.12)',
                                        color: oPausado ? '#16a34a' : '#dc2626',
                                      }}
                                    >
                                      {pausandoComp === op.id ? '...' : oPausado ? '▶ Ativar' : '⏸ Pausar'}
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })}
                      </div>
                    </td>
                  </tr>
                )}
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
                  <label>
                    <input
                      type="checkbox"
                      name="controla_estoque"
                      checked={form.controla_estoque}
                      onChange={handleChange}
                    />{' '}
                    Controla estoque{' '}
                    <span style={{ color: 'var(--text-muted, #888)', fontWeight: 400, fontSize: 13 }}>
                      (desmarque p/ self service / prato feito na hora)
                    </span>
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
                  <label style={{ display: 'block', marginBottom: 6 }}>Disponibilidade</label>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, ativo: !f.ativo }))}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                      padding: '9px 16px', borderRadius: 10, fontWeight: 700, fontSize: 14,
                      border: `1.5px solid ${form.ativo ? '#16a34a' : '#eab308'}`,
                      background: form.ativo ? 'rgba(22,163,74,.12)' : 'rgba(234,179,8,.16)',
                      color: form.ativo ? '#16a34a' : '#a16207',
                    }}
                  >
                    {form.ativo ? '⏸ Pausar item' : '▶ Ativar item'}
                  </button>
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    {form.ativo
                      ? 'Item aparecendo pra vender. Pause quando faltar / ficar indisponível.'
                      : 'Item pausado — não aparece pra vender. Dê play pra voltar.'}
                    {' '}(Isto não é estoque — estoque é o "Controla estoque" acima.)
                  </p>
                </div>

                {/* Complementos / opções (monte sua quentinha) */}
                <div className="form-field full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span>
                      Complementos / opções{' '}
                      <span style={{ fontWeight: 400, fontSize: '0.8em', color: 'var(--text-muted)' }}>
                        (ex.: monte sua quentinha — proteínas, saladas...)
                      </span>
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm"
                      onClick={() => setGrupos(prev => [...prev, { nome: '', min: 1, max: 1, opcoes: [] }])}>
                      + Grupo
                    </button>
                  </label>

                  {grupos.length === 0 && (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                      Nenhum complemento. Clique em “+ Grupo” pra criar (ex.: “Proteínas”, escolher de 1 a 2).
                    </p>
                  )}

                  {grupos.map((g, gi) => (
                    <div key={gi} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginTop: 10, background: 'var(--bg-secondary, #f9fafb)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 68px 68px auto', gap: 8, alignItems: 'end' }}>
                        <div>
                          <label style={{ fontSize: '0.72em', color: 'var(--text-muted)' }}>Nome do grupo</label>
                          <input value={g.nome} placeholder="Ex: Proteínas" onChange={e => updGrupo(gi, { nome: e.target.value })} />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.72em', color: 'var(--text-muted)' }}>Mín.</label>
                          <input type="number" min="0" value={g.min} onChange={e => updGrupo(gi, { min: e.target.value })} />
                        </div>
                        <div>
                          <label style={{ fontSize: '0.72em', color: 'var(--text-muted)' }}>Máx.</label>
                          <input type="number" min="1" value={g.max} onChange={e => updGrupo(gi, { max: e.target.value })} />
                        </div>
                        <button type="button" className="btn btn-danger btn-sm"
                          onClick={() => setGrupos(prev => prev.filter((_, i) => i !== gi))}>
                          Excluir
                        </button>
                      </div>

                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {(g.opcoes || []).map((o, oi) => (
                          <div key={oi} style={{ display: 'grid', gridTemplateColumns: '1fr 104px auto', gap: 8, alignItems: 'center' }}>
                            <input value={o.nome} placeholder="Opção (ex: Frango assado)" onChange={e => updOpcao(gi, oi, { nome: e.target.value })} />
                            <input type="number" step="0.01" min="0" value={o.preco} placeholder="+ R$ 0,00" onChange={e => updOpcao(gi, oi, { preco: e.target.value })} />
                            <button type="button" title="Remover opção"
                              style={{ background: 'none', border: 'none', color: 'var(--danger, #e55)', cursor: 'pointer', fontSize: '1.1em', padding: '2px 6px' }}
                              onClick={() => updGrupo(gi, { opcoes: g.opcoes.filter((_, i) => i !== oi) })}>
                              ✕
                            </button>
                          </div>
                        ))}
                        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}
                          onClick={() => updGrupo(gi, { opcoes: [...(g.opcoes || []), { nome: '', preco: 0 }] })}>
                          + Opção
                        </button>
                      </div>
                    </div>
                  ))}
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

            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
              🕒 Defina o horário que cada categoria fica disponível para venda. Deixe <strong>em branco</strong> = sempre disponível.
              Ex.: Quentinhas <strong>10:00 às 14:00</strong>, Janta <strong>17:00 às 22:00</strong>.
            </p>

            <div className="data-table">
              {categorias.length === 0 ? (
                <div className="empty-state">Nenhuma categoria cadastrada.</div>
              ) : (
                <table>
                  <tbody>
                    {categorias.map((c, i) => (
                      <tr
                        key={c.id}
                        draggable
                        onDragStart={() => setDragIdx(i)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => onSoltarCategoria(i)}
                        onDragEnd={() => setDragIdx(null)}
                        style={{
                          cursor: 'grab',
                          background: dragIdx === i ? 'var(--primary-bg)' : undefined,
                          borderTop: dragIdx != null && dragIdx !== i ? '2px dashed transparent' : undefined,
                        }}
                      >
                        <td style={{ width: 24, textAlign: 'center', color: 'var(--text-muted)', cursor: 'grab', userSelect: 'none' }} title="Arraste para reordenar">
                          ⠿
                        </td>
                        <td style={{ width: 74 }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            title="Subir"
                            disabled={i === 0}
                            onClick={() => moverCategoria(i, -1)}
                            style={{ padding: '2px 7px' }}
                          >
                            ↑
                          </button>{' '}
                          <button
                            className="btn btn-secondary btn-sm"
                            title="Descer"
                            disabled={i === categorias.length - 1}
                            onClick={() => moverCategoria(i, 1)}
                            style={{ padding: '2px 7px' }}
                          >
                            ↓
                          </button>
                        </td>
                        <td>{c.nome}</td>
                        <td style={{ whiteSpace: 'nowrap' }} onDragStart={(e) => e.preventDefault()}>
                          <input
                            type="time"
                            value={(c.hora_inicio || '').slice(0, 5)}
                            onChange={(e) => salvarHorarioCategoria(c.id, 'hora_inicio', e.target.value)}
                            title="Disponível a partir de"
                            style={{ width: 96 }}
                          />
                          <span style={{ margin: '0 5px', color: 'var(--text-muted)' }}>às</span>
                          <input
                            type="time"
                            value={(c.hora_fim || '').slice(0, 5)}
                            onChange={(e) => salvarHorarioCategoria(c.id, 'hora_fim', e.target.value)}
                            title="Disponível até"
                            style={{ width: 96 }}
                          />
                        </td>
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
