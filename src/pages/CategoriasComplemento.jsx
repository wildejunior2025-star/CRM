import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './CategoriasComplemento.css'

// Normaliza pra busca: tira acento e deixa minúsculo ("frango" acha "Frangão").
const norm = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

// Painel pra vincular VÁRIOS produtos de uma vez à categoria: abre uma listinha
// com busca e caixinhas de seleção; marca quantos quiser e adiciona todos juntos.
function ProdutoMultiAdd({ produtos, disabled, onConfirm }) {
  const [aberto, setAberto] = useState(false)
  const [sel, setSel] = useState(() => new Set())
  const [q, setQ] = useState('')
  const filtrados = q ? produtos.filter(p => norm(p.nome).includes(norm(q))) : produtos

  function toggle(id) {
    setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function fechar() { setAberto(false); setSel(new Set()); setQ('') }
  function confirmar() {
    if (sel.size) onConfirm([...sel])
    fechar()
  }

  if (!aberto) {
    return (
      <button type="button" className="cc-input cc-add-select cc-add-btn" disabled={disabled} onClick={() => setAberto(true)}>
        + Adicionar a produtos…
      </button>
    )
  }
  const todosMarcados = filtrados.length > 0 && filtrados.every(p => sel.has(p.id))
  return (
    <div className="cc-multiadd">
      <div className="cc-multiadd-head">
        <input className="cc-input" autoFocus value={q} placeholder="Buscar produto…" onChange={e => setQ(e.target.value)} />
        <button type="button" className="cc-iconbtn" title="Fechar" onClick={fechar}>✕</button>
      </div>
      <div className="cc-multiadd-list">
        {filtrados.length === 0 && <p className="cc-empty">Nenhum produto encontrado.</p>}
        {filtrados.map(p => (
          <label key={p.id} className="cc-multiadd-item">
            <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
            <span>{p.nome}</span>
          </label>
        ))}
      </div>
      <div className="cc-multiadd-actions">
        <button type="button" className="btn btn-secondary btn-sm"
          onClick={() => setSel(todosMarcados ? new Set() : new Set(filtrados.map(p => p.id)))}>
          {todosMarcados ? 'Desmarcar todos' : 'Marcar todos'}
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!sel.size} onClick={confirmar}>
          Adicionar{sel.size ? ` ${sel.size}` : ''}
        </button>
      </div>
    </div>
  )
}

// Tela de CATEGORIAS DE COMPLEMENTO compartilhadas.
// Uma categoria (ex.: "Proteínas") é criada UMA vez, com suas opções, e pode ser
// casada em vários produtos (via a ponte produto_complemento_grupos). Pausar uma
// opção aqui pausa em todos os produtos que usam a categoria — fonte única.
export default function CategoriasComplemento() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id ?? null

  const [cats, setCats] = useState([])       // [{id, nome, min, max, disponivel, opcoes:[], links:[{id,produto_id,max_override}]}]
  const [produtos, setProdutos] = useState([]) // [{id, nome}]
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [novaCat, setNovaCat] = useState('')
  const [busy, setBusy] = useState(null)      // id em operação (desabilita botão)
  const [busca, setBusca] = useState('')      // pesquisa (categoria/opção, sem acento)

  const nomeProduto = useMemo(() => {
    const m = {}
    for (const p of produtos) m[p.id] = p.nome
    return m
  }, [produtos])

  const load = useCallback(async () => {
    if (!empresaId) return
    setLoading(true)
    const [gruposRes, prodRes, linkRes] = await Promise.all([
      supabase.from('complemento_grupos')
        .select('id, nome, min, max, ordem, disponivel, complemento_opcoes(id, nome, preco_adicional, ordem, disponivel)')
        .eq('empresa_id', empresaId).order('nome'),
      supabase.from('produtos').select('id, nome').eq('empresa_id', empresaId).order('nome'),
      supabase.from('produto_complemento_grupos')
        .select('id, produto_id, grupo_id, max_override, produtos!inner(empresa_id)')
        .eq('produtos.empresa_id', empresaId),
    ])
    if (gruposRes.error) { setError(gruposRes.error.message); setLoading(false); return }
    const linksPorGrupo = {}
    for (const l of (linkRes.data ?? [])) (linksPorGrupo[l.grupo_id] ??= []).push(l)
    const lista = (gruposRes.data ?? []).map(g => ({
      id: g.id, nome: g.nome, min: g.min ?? 0, max: g.max ?? 1, disponivel: g.disponivel !== false,
      opcoes: (g.complemento_opcoes ?? []).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)),
      links: (linksPorGrupo[g.id] ?? []),
    }))
    setCats(lista)
    setProdutos(prodRes.data ?? [])
    setLoading(false)
  }, [empresaId])

  useEffect(() => { load() }, [load])

  // ── Categoria ──────────────────────────────────────────────────────────────
  async function criarCategoria() {
    const nome = novaCat.trim()
    if (!nome) return
    setBusy('nova')
    const { error } = await supabase.from('complemento_grupos')
      .insert({ empresa_id: empresaId, produto_id: null, nome, min: 1, max: 1 })
    setBusy(null)
    if (error) { setError(error.message); return }
    setNovaCat('')
    load()
  }
  async function salvarCategoria(cat, patch) {
    setCats(prev => prev.map(c => c.id === cat.id ? { ...c, ...patch } : c))
    await supabase.from('complemento_grupos').update(patch).eq('id', cat.id)
  }
  async function pausarCategoria(cat) {
    const novo = !cat.disponivel
    setCats(prev => prev.map(c => c.id === cat.id ? { ...c, disponivel: novo } : c))
    await supabase.from('complemento_grupos').update({ disponivel: novo }).eq('id', cat.id)
  }
  async function excluirCategoria(cat) {
    const usados = cat.links.length
    const onde = usados ? `\n\nEla está em ${usados} produto(s) e vai sumir de TODOS.` : ''
    const msg = `⚠️ EXCLUIR a categoria "${cat.nome}" DE VEZ?\n\n`
      + `Isso APAGA a categoria e todas as opções dela do sistema — NÃO dá pra desfazer.`
      + onde
      + `\n\n👉 Se você só quer que ela pare de aparecer, use o botão PAUSAR (não o Excluir).\n\nTem certeza que quer EXCLUIR?`
    if (!confirm(msg)) return
    setBusy(cat.id)
    // apaga vínculos, opções e a categoria (opções caem por cascade, mas garantimos)
    await supabase.from('produto_complemento_grupos').delete().eq('grupo_id', cat.id)
    await supabase.from('complemento_grupos').delete().eq('id', cat.id)
    setBusy(null)
    load()
  }

  // ── Opções ───────────────────────────────────────────────────────────────
  async function addOpcao(cat) {
    const ordem = (cat.opcoes.reduce((m, o) => Math.max(m, o.ordem ?? 0), 0) + 1)
    setBusy(cat.id)
    const { error } = await supabase.from('complemento_opcoes')
      .insert({ grupo_id: cat.id, nome: 'Nova opção', preco_adicional: 0, ordem })
    setBusy(null)
    if (error) { setError(error.message); return }
    load()
  }
  async function salvarOpcao(cat, op, patch) {
    setCats(prev => prev.map(c => c.id !== cat.id ? c : {
      ...c, opcoes: c.opcoes.map(o => o.id === op.id ? { ...o, ...patch } : o),
    }))
    await supabase.from('complemento_opcoes').update(patch).eq('id', op.id)
  }
  async function pausarOpcao(cat, op) {
    const novo = op.disponivel === false // se pausada, reativa
    salvarOpcao(cat, op, { disponivel: novo })
  }
  async function removerOpcao(cat, op) {
    const msg = `⚠️ EXCLUIR a opção "${op.nome}" DE VEZ?\n\n`
      + `Isso APAGA a opção do sistema — NÃO é o mesmo que pausar e NÃO dá pra desfazer.\n\n`
      + `👉 Se você só quer que ela pare de aparecer, use o botão PAUSAR (⏸), não o ✕.\n\n`
      + `Tem certeza que quer EXCLUIR?`
    if (!confirm(msg)) return
    setCats(prev => prev.map(c => c.id !== cat.id ? c : { ...c, opcoes: c.opcoes.filter(o => o.id !== op.id) }))
    await supabase.from('complemento_opcoes').delete().eq('id', op.id)
  }

  // ── Vínculos (quais produtos usam a categoria) ───────────────────────────
  // Vincula VÁRIOS produtos de uma vez (marca vários e adiciona todos juntos).
  async function vincularProdutos(cat, produtoIds) {
    const ids = (produtoIds ?? []).filter(Boolean)
    if (!ids.length) return
    setBusy(cat.id)
    const rows = ids.map(pid => ({ produto_id: pid, grupo_id: cat.id, ordem: 0 }))
    const { error } = await supabase.from('produto_complemento_grupos').insert(rows)
    setBusy(null)
    if (error) { setError(error.message); return }
    load()
  }
  async function desvincularProduto(cat, link) {
    setCats(prev => prev.map(c => c.id !== cat.id ? c : { ...c, links: c.links.filter(l => l.id !== link.id) }))
    await supabase.from('produto_complemento_grupos').delete().eq('id', link.id)
  }
  async function salvarMaxOverride(cat, link, valorRaw) {
    const valor = valorRaw === '' ? null : Math.max(1, Number(valorRaw) || 1)
    setCats(prev => prev.map(c => c.id !== cat.id ? c : {
      ...c, links: c.links.map(l => l.id === link.id ? { ...l, max_override: valor } : l),
    }))
    await supabase.from('produto_complemento_grupos').update({ max_override: valor }).eq('id', link.id)
  }

  if (loading) return (
    <div>
      <div className="page-header"><h1>Complementos</h1></div>
      <div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '70%' }} /><div className="skeleton-row" style={{ width: '85%' }} /></div>
    </div>
  )

  // Filtro da lupa: acha por nome da categoria OU da opção (ignora acento).
  // Se casar o nome da categoria, mostra ela inteira; senão, mostra só as opções que casam.
  const nt = norm(busca)
  const catsFiltradas = !nt ? cats : cats.map(cat => {
    if (norm(cat.nome).includes(nt)) return cat
    const opcoes = cat.opcoes.filter(o => norm(o.nome).includes(nt))
    return opcoes.length ? { ...cat, opcoes } : null
  }).filter(Boolean)

  return (
    <div>
      <div className="page-header">
        <h1>Complementos</h1>
        <span className="badge badge-neutral">{cats.length} categoria{cats.length === 1 ? '' : 's'}</span>
      </div>
      <p className="cc-sub">
        Monte cada categoria (ex.: “Proteínas”, “Saladas”) <b>uma vez</b> e use em vários produtos.
        Pausar uma opção aqui pausa em <b>todos</b> os produtos que a usam.
      </p>

      {error && <p className="error-text">{error}</p>}

      {/* Criar nova categoria */}
      <div className="cc-create">
        <input
          className="cc-input"
          value={novaCat}
          placeholder="Nome da nova categoria (ex.: Proteínas)"
          onChange={e => setNovaCat(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') criarCategoria() }}
        />
        <button className="btn btn-primary" disabled={busy === 'nova' || !novaCat.trim()} onClick={criarCategoria}>
          + Criar categoria
        </button>
      </div>

      {/* Lupa de pesquisa (categoria ou opção) */}
      {cats.length > 0 && (
        <div className="cc-search">
          <span className="cc-search-icon">🔍</span>
          <input
            className="cc-input"
            value={busca}
            placeholder="Pesquisar categoria ou opção (ex.: frango)…"
            onChange={e => setBusca(e.target.value)}
          />
          {busca && (
            <button className="cc-search-clear" title="Limpar" onClick={() => setBusca('')}>✕</button>
          )}
        </div>
      )}

      {cats.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 22 }}>🧩</div>
          <strong>Nenhuma categoria ainda</strong>
          <p>Crie a primeira lá em cima (ex.: “Proteínas”, “Saladas”, “Adicionais”).</p>
        </div>
      )}

      {cats.length > 0 && catsFiltradas.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 22 }}>🔍</div>
          <strong>Nada encontrado</strong>
          <p>Nenhuma categoria ou opção com “{busca}”.</p>
        </div>
      )}

      {catsFiltradas.map(cat => {
        const naoVinculados = produtos.filter(p => !cat.links.some(l => l.produto_id === p.id))
        return (
          <div key={cat.id} className={`card cc-card${cat.disponivel ? '' : ' paused'}`}>
            {/* Cabeçalho da categoria */}
            <div className="cc-head">
              <div className="cc-head-left">
                <input className="cc-name" defaultValue={cat.nome}
                  onBlur={e => { const v = e.target.value.trim(); if (v && v !== cat.nome) salvarCategoria(cat, { nome: v }) }} />
                <span className={`badge ${cat.disponivel ? 'badge-success' : 'badge-danger'}`}>
                  {cat.disponivel ? 'Ativa' : 'Pausada'}
                </span>
                <span className="cc-minmax">
                  mín <input className="cc-input" type="number" min="0" defaultValue={cat.min}
                    onBlur={e => salvarCategoria(cat, { min: Number(e.target.value) || 0 })} />
                  máx <input className="cc-input" type="number" min="1" defaultValue={cat.max}
                    onBlur={e => salvarCategoria(cat, { max: Number(e.target.value) || 1 })} />
                </span>
              </div>
              <div className="cc-head-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => pausarCategoria(cat)}>
                  {cat.disponivel ? '⏸ Pausar' : '▶ Reativar'}
                </button>
                <button className="btn btn-danger btn-sm" disabled={busy === cat.id} onClick={() => excluirCategoria(cat)}>
                  🗑 Excluir
                </button>
              </div>
            </div>

            <div className="cc-body">
              {/* Opções */}
              <div>
                <p className="cc-section-title">Opções · {cat.opcoes.length}</p>
                {cat.opcoes.length === 0 && <p className="cc-empty">Nenhuma opção ainda.</p>}
                {cat.opcoes.map(op => (
                  <div key={op.id} className={`cc-opt${op.disponivel === false ? ' paused' : ''}`}>
                    <input className="cc-input" defaultValue={op.nome}
                      onBlur={e => { const v = e.target.value.trim(); if (v && v !== op.nome) salvarOpcao(cat, op, { nome: v }) }} />
                    <div className="cc-price-wrap">
                      <span className="cc-price-prefix">R$</span>
                      <input className="cc-input" type="number" step="0.01" min="0" defaultValue={op.preco_adicional}
                        onBlur={e => salvarOpcao(cat, op, { preco_adicional: Number(e.target.value) || 0 })} />
                    </div>
                    <button className="btn btn-secondary btn-sm" title={op.disponivel === false ? 'Reativar' : 'Pausar'} onClick={() => pausarOpcao(cat, op)}>
                      {op.disponivel === false ? '▶' : '⏸'}
                    </button>
                    <button className="cc-iconbtn" title="Remover" onClick={() => removerOpcao(cat, op)}>✕</button>
                  </div>
                ))}
                <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} disabled={busy === cat.id} onClick={() => addOpcao(cat)}>
                  + Opção
                </button>
              </div>

              {/* Produtos que usam */}
              <div>
                <p className="cc-section-title">Usada em {cat.links.length} produto{cat.links.length === 1 ? '' : 's'}</p>
                {cat.links.length === 0 && <p className="cc-empty">Ainda não está em nenhum produto.</p>}
                {cat.links.map(link => (
                  <div key={link.id} className="cc-prod">
                    <span className="cc-prod-name">{nomeProduto[link.produto_id] ?? '—'}</span>
                    <span className="cc-prod-max">
                      máx
                      <input className="cc-input" type="number" min="1"
                        defaultValue={link.max_override ?? ''}
                        placeholder={String(cat.max)}
                        onBlur={e => salvarMaxOverride(cat, link, e.target.value)} />
                    </span>
                    <button className="cc-iconbtn" title="Tirar deste produto" onClick={() => desvincularProduto(cat, link)}>✕</button>
                  </div>
                ))}
                {naoVinculados.length > 0 && (
                  <ProdutoMultiAdd
                    produtos={naoVinculados}
                    disabled={busy === cat.id}
                    onConfirm={ids => vincularProdutos(cat, ids)}
                  />
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
