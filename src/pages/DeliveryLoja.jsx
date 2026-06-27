import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import './DeliveryLoja.css'

function IconArrowLeft() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

function IconPlus({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function IconMinus({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  )
}

function IconCart() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  )
}

function IconImage() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

function IconX() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function fmt(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function DeliveryLoja() {
  const { id, slug } = useParams()
  const navigate = useNavigate()

  const [loja, setLoja] = useState(null)
  const [produtos, setProdutos] = useState([])
  const [loading, setLoading] = useState(true)
  const [catAtiva, setCatAtiva] = useState(null)
  const catRefs = useRef({})
  const navRef = useRef(null)
  const [carrinho, setCarrinho] = useState({})
  // Carrinho é chaveado pelo id REAL da loja (uuid) — bate com a limpeza do checkout.
  const cartKey = loja?.id ? `sacola_${loja.id}` : null
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerRef = useRef(null)
  const [filtroEstoqueBaixo, setFiltroEstoqueBaixo] = useState(false)
  const [busca, setBusca] = useState('')

  // Sincroniza carrinho com localStorage (chave = id real da loja)
  useEffect(() => {
    if (!cartKey) return
    try {
      if (Object.keys(carrinho).length === 0) {
        localStorage.removeItem(cartKey)
      } else {
        localStorage.setItem(cartKey, JSON.stringify(carrinho))
      }
    } catch { /* localStorage indisponível */ }
  }, [carrinho, cartKey])

  // Após produtos carregarem, filtra itens do carrinho restaurado:
  // remove produtos que não existem mais e atualiza preços
  useEffect(() => {
    if (produtos.length === 0) return
    setCarrinho(prev => {
      const atualizado = {}
      for (const [pid, item] of Object.entries(prev)) {
        const produtoAtual = produtos.find(p => String(p.id) === String(pid))
        if (produtoAtual) {
          atualizado[pid] = { ...item, preco: produtoAtual.preco }
        }
      }
      return atualizado
    })
  }, [produtos])

  useEffect(() => {
    async function load() {
      // Resolve a loja por slug (lojaonline.fwcinter.com/slug) ou por id (link antigo /loja/:id)
      let lojaQuery = supabase.from('empresas').select('*').eq('aceita_delivery', true)
      lojaQuery = slug ? lojaQuery.eq('slug', slug) : lojaQuery.eq('id', id)
      const { data: lojaData } = await lojaQuery.maybeSingle()

      if (!lojaData) { setLoja(null); setLoading(false); return }

      const { data: produtosData } = await supabase.from('produtos')
        .select('id, nome, descricao, preco:preco_venda, foto_url, categoria, disponivel_delivery, estoque_minimo')
        .eq('empresa_id', lojaData.id)
        .eq('ativo', true)
        .eq('disponivel_delivery', true)
        .order('categoria')
        .order('nome')

      // Restaura carrinho salvo desta loja (chave = id real)
      let savedCart = {}
      try { savedCart = JSON.parse(localStorage.getItem(`sacola_${lojaData.id}`) || '{}') } catch { savedCart = {} }

      setLoja(lojaData)
      setProdutos(produtosData ?? [])
      setCarrinho(savedCart)
      setLoading(false)
    }
    load()
  }, [id, slug])

  useEffect(() => {
    if (!drawerOpen) return
    function onKey(e) {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  function addOne(prod) {
    setCarrinho(prev => ({ ...prev, [prod.id]: { ...prod, quantidade: (prev[prod.id]?.quantidade ?? 0) + 1 } }))
  }

  function removeOne(id) {
    setCarrinho(prev => {
      const next = { ...prev }
      if (!next[id] || next[id].quantidade <= 1) {
        delete next[id]
      } else {
        next[id] = { ...next[id], quantidade: next[id].quantidade - 1 }
      }
      return next
    })
  }

  function removeItem(id) {
    setCarrinho(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const itens = Object.values(carrinho)
  const totalItens = itens.reduce((s, i) => s + i.quantidade, 0)
  const subtotal = itens.reduce((s, i) => s + i.quantidade * Number(i.preco), 0)
  const taxaEntrega = loja ? Number(loja.taxa_entrega ?? 0) : 0
  const total = subtotal + taxaEntrega

  const produtosFiltrados = filtroEstoqueBaixo
    ? produtos.filter(p => p.estoque != null && p.estoque_minimo != null && p.estoque <= p.estoque_minimo)
    : produtos

  const categorias = [...new Set(produtosFiltrados.map(p => p.categoria).filter(Boolean))]
  const semCategoria = produtosFiltrados.filter(p => !p.categoria)
  const todasCats = semCategoria.length > 0 ? [...categorias, '__sem__'] : categorias

  // Busca por nome do produto (filtra tudo, ignorando a divisão por categoria)
  const buscaTrim = busca.trim().toLowerCase()
  const resultadosBusca = buscaTrim
    ? produtosFiltrados.filter(p =>
        (p.nome ?? '').toLowerCase().includes(buscaTrim) ||
        (p.descricao ?? '').toLowerCase().includes(buscaTrim))
    : null

  // Define categoria ativa inicial
  useEffect(() => {
    if (todasCats.length > 0 && !catAtiva) setCatAtiva(todasCats[0])
  }, [todasCats.join(',')])

  // Reset categoria ativa quando filtro muda
  useEffect(() => {
    if (todasCats.length > 0) setCatAtiva(todasCats[0])
  }, [filtroEstoqueBaixo])

  // IntersectionObserver: atualiza categoria ativa ao scrollar
  useEffect(() => {
    if (todasCats.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) setCatAtiva(entry.target.dataset.cat)
        })
      },
      { rootMargin: '-100px 0px -55% 0px', threshold: 0 }
    )
    todasCats.forEach(cat => {
      const el = catRefs.current[cat]
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [todasCats.join(',')])

  function scrollToCategoria(cat) {
    const el = catRefs.current[cat]
    if (el) {
      const offset = 130
      const top = el.getBoundingClientRect().top + window.scrollY - offset
      window.scrollTo({ top, behavior: 'smooth' })
    }
    setCatAtiva(cat)
    // Scroll do nav para manter botão ativo visível
    if (navRef.current) {
      const btn = navRef.current.querySelector(`[data-nav="${cat}"]`)
      btn?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  }

  function handleFinalizar() {
    setDrawerOpen(false)
    navigate('/checkout', {
      state: {
        empresaId: loja.id,
        empresaNome: loja.nome,
        itens: itens.map(i => ({
          id: i.id,
          nome: i.nome,
          quantidade: i.quantidade,
          preco: Number(i.preco),
        })),
        subtotal,
        taxaEntrega,
      },
    })
  }

  if (loading) {
    return (
      <div className="dloja-loading">
        <div className="dloja-spinner" />
        <p>Carregando cardápio...</p>
      </div>
    )
  }

  if (!loja) {
    return (
      <div className="dloja-loading">
        <p style={{ color: '#94a3b8' }}>Loja não encontrada.</p>
        <button className="dloja-back-btn" onClick={() => navigate('/lojas')}>
          <IconArrowLeft /> Voltar
        </button>
      </div>
    )
  }

  return (
    <div className="dloja-root">
      <header className="dloja-header">
        {/* Banner da loja */}
        <div
          className="dloja-banner"
          style={loja.banner_url ? { backgroundImage: `url(${loja.banner_url})` } : undefined}
        >
          <button className="dloja-banner-btn dloja-banner-back" onClick={() => navigate(-1)} aria-label="Voltar">
            <IconArrowLeft />
          </button>
          {totalItens > 0 && (
            <button className="dloja-banner-btn dloja-banner-cart" onClick={() => setDrawerOpen(true)} aria-label="Abrir carrinho">
              <IconCart />
              <span className="dloja-cart-count">{totalItens}</span>
            </button>
          )}
        </div>

        {/* Logo + nome da loja */}
        <div className="dloja-store-head">
          <div className="dloja-store-logo">
            {loja.logo_url
              ? <img src={loja.logo_url} alt={loja.nome} />
              : <span>{(loja.nome ?? 'F').trim().charAt(0).toUpperCase()}</span>}
          </div>
          <div className="dloja-store-info">
            <span className="dloja-store-nome">{loja.nome}</span>
            <span className={`dloja-status-badge ${loja.delivery_ativo ? 'dloja-status--open' : 'dloja-status--closed'}`}>
              {loja.delivery_ativo ? 'Aberto' : 'Fechado'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/meus-pedidos?loja=${loja.id}`)}
            style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
              background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)',
              color: '#fff', borderRadius: 10, padding: '8px 12px', cursor: 'pointer',
              fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
            }}
          >
            🧾 Meus pedidos
          </button>
        </div>
      </header>

      {/* ── Busca flutuante (fixa no topo ao rolar) ── */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 30,
        background: 'var(--dloja-bg, #0f0f1a)',
        padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,.06)',
      }}>
        <div style={{ position: 'relative', maxWidth: 720, margin: '0 auto' }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', pointerEvents: 'none' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </span>
          <input
            type="search"
            value={busca}
            onChange={e => setBusca(e.target.value)}
            placeholder="Buscar produto..."
            style={{
              width: '100%', boxSizing: 'border-box', padding: '11px 38px', borderRadius: 12,
              border: '1.5px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.06)',
              color: '#fff', fontSize: 15, outline: 'none',
            }}
          />
          {busca && (
            <button type="button" onClick={() => setBusca('')} aria-label="Limpar busca"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: 4, display: 'flex' }}>
              <IconX />
            </button>
          )}
        </div>
      </div>

      {/* ── Barra de categorias (some durante a busca) ── */}
      {!buscaTrim && (
      <nav className="dloja-cat-nav" ref={navRef} aria-label="Categorias">
        <div className="dloja-cat-nav-inner">
          {categorias.map(cat => (
            <button
              key={cat}
              data-nav={cat}
              className={`dloja-cat-nav-btn${catAtiva === cat ? ' ativo' : ''}`}
              onClick={() => scrollToCategoria(cat)}
            >
              {cat}
            </button>
          ))}
          {semCategoria.length > 0 && (
            <button
              data-nav="__sem__"
              className={`dloja-cat-nav-btn${catAtiva === '__sem__' ? ' ativo' : ''}`}
              onClick={() => scrollToCategoria('__sem__')}
            >
              Outros
            </button>
          )}
        </div>
      </nav>
      )}

      {!loja.delivery_ativo && (
        <div className="dloja-closed-banner">
          <strong>Loja fechada no momento</strong> — você pode ver o cardápio, mas não é possível fazer pedidos.
        </div>
      )}

      <main className="dloja-main">
        {resultadosBusca ? (
          resultadosBusca.length === 0 ? (
            <div className="dloja-empty">
              <IconImage />
              <p>Nenhum produto encontrado para “{busca.trim()}”.</p>
            </div>
          ) : (
            <section className="dloja-section">
              <h2 className="dloja-cat-title">Resultados ({resultadosBusca.length})</h2>
              <div className="dloja-produtos">
                {resultadosBusca.map(p => (
                  <ProdutoCard
                    key={p.id}
                    produto={p}
                    quantidade={carrinho[p.id]?.quantidade ?? 0}
                    lojaAberta={loja.delivery_ativo}
                    onAdd={() => addOne(p)}
                    onRemove={() => removeOne(p.id)}
                  />
                ))}
              </div>
            </section>
          )
        ) : categorias.length === 0 && semCategoria.length === 0 ? (
          <div className="dloja-empty">
            <IconImage />
            <p>{filtroEstoqueBaixo ? 'Nenhum produto com estoque baixo.' : 'Nenhum produto disponível para delivery.'}</p>
            {filtroEstoqueBaixo && (
              <button className="dloja-cat-nav-btn" style={{ marginTop: 12 }} onClick={() => setFiltroEstoqueBaixo(false)}>
                Ver todos
              </button>
            )}
          </div>
        ) : (
          <>
            {categorias.map(cat => (
              <section key={cat} className="dloja-section" ref={el => { catRefs.current[cat] = el }} data-cat={cat}>
                <h2 className="dloja-cat-title">{cat}</h2>
                <div className="dloja-produtos">
                  {produtosFiltrados.filter(p => p.categoria === cat).map(p => (
                    <ProdutoCard
                      key={p.id}
                      produto={p}
                      quantidade={carrinho[p.id]?.quantidade ?? 0}
                      lojaAberta={loja.delivery_ativo}
                      onAdd={() => addOne(p)}
                      onRemove={() => removeOne(p.id)}
                    />
                  ))}
                </div>
              </section>
            ))}

            {semCategoria.length > 0 && (
              <section className="dloja-section" ref={el => { catRefs.current['__sem__'] = el }} data-cat="__sem__">
                <h2 className="dloja-cat-title">Outros</h2>
                <div className="dloja-produtos">
                  {semCategoria.map(p => (
                    <ProdutoCard
                      key={p.id}
                      produto={p}
                      quantidade={carrinho[p.id]?.quantidade ?? 0}
                      lojaAberta={loja.delivery_ativo}
                      onAdd={() => addOne(p)}
                      onRemove={() => removeOne(p.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {totalItens > 0 && !drawerOpen && (
        <button className="dloja-cart-bar" onClick={() => setDrawerOpen(true)}>
          <span className="dloja-cart-bar-badge">{totalItens} {totalItens === 1 ? 'item' : 'itens'}</span>
          <span>Ver carrinho</span>
          <span className="dloja-cart-bar-total">R$ {fmt(subtotal)}</span>
        </button>
      )}

      {drawerOpen && (
        <div className="dloja-overlay" onClick={() => setDrawerOpen(false)}>
          <aside
            ref={drawerRef}
            className="dloja-drawer"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Carrinho"
          >
            <div className="dloja-drawer-header">
              <h2 className="dloja-drawer-title">Carrinho</h2>
              <button className="dloja-drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Fechar">
                <IconX />
              </button>
            </div>

            <div className="dloja-drawer-body">
              {itens.map(item => (
                <div key={item.id} className="dloja-drawer-item">
                  <div className="dloja-drawer-item-info">
                    <span className="dloja-drawer-item-nome">{item.nome}</span>
                    <span className="dloja-drawer-item-preco">R$ {fmt(item.preco)} cada</span>
                  </div>
                  <div className="dloja-drawer-item-ctrl">
                    <div className="dloja-qty">
                      <button className="dloja-qty-btn" onClick={() => removeOne(item.id)} aria-label="Remover um">
                        <IconMinus />
                      </button>
                      <span className="dloja-qty-val">{item.quantidade}</span>
                      <button className="dloja-qty-btn" onClick={() => addOne(item)} aria-label="Adicionar um">
                        <IconPlus />
                      </button>
                    </div>
                    <span className="dloja-drawer-item-sub">R$ {fmt(item.quantidade * Number(item.preco))}</span>
                    <button className="dloja-drawer-item-del" onClick={() => removeItem(item.id)} aria-label={`Remover ${item.nome}`}>
                      <IconTrash />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="dloja-drawer-footer">
              <div className="dloja-drawer-linha">
                <span>Subtotal</span>
                <span>R$ {fmt(subtotal)}</span>
              </div>
              <div className="dloja-drawer-linha">
                <span>Taxa de entrega</span>
                <span>{taxaEntrega === 0 ? 'Grátis' : `R$ ${fmt(taxaEntrega)}`}</span>
              </div>
              <div className="dloja-drawer-linha dloja-drawer-total">
                <span>Total</span>
                <strong>R$ {fmt(total)}</strong>
              </div>
              <button
                className="dloja-btn-finalizar"
                onClick={handleFinalizar}
                disabled={!loja.delivery_ativo}
              >
                {loja.delivery_ativo ? 'Finalizar pedido' : 'Loja fechada'}
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

function ProdutoCard({ produto, quantidade, lojaAberta, onAdd, onRemove }) {
  return (
    <div className="dloja-prod-card">
      <div className="dloja-prod-foto">
        {produto.foto_url
          ? <img src={produto.foto_url} alt={produto.nome} className="dloja-prod-img" />
          : (
            <div className="dloja-prod-placeholder">
              <IconImage />
            </div>
          )
        }
      </div>
      <div className="dloja-prod-info">
        <p className="dloja-prod-nome">{produto.nome}</p>
        {produto.descricao && (
          <p className="dloja-prod-desc">{produto.descricao}</p>
        )}
        <p className="dloja-prod-preco">R$ {fmt(produto.preco)}</p>
      </div>
      <div className="dloja-prod-acao">
        {quantidade === 0 ? (
          <button
            className="dloja-btn-add"
            onClick={onAdd}
            disabled={!lojaAberta}
            aria-label={`Adicionar ${produto.nome}`}
          >
            <IconPlus size={14} />
          </button>
        ) : (
          <div className="dloja-qty dloja-qty--card">
            <button className="dloja-qty-btn" onClick={onRemove} aria-label="Remover um">
              <IconMinus size={14} />
            </button>
            <span className="dloja-qty-val">{quantidade}</span>
            <button className="dloja-qty-btn dloja-qty-btn--primary" onClick={onAdd} disabled={!lojaAberta} aria-label="Adicionar um">
              <IconPlus size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
