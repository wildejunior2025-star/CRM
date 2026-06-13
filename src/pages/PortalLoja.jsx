import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../context/BrandingContext'
import './PortalLoja.css'

export default function PortalLoja() {
  const { empresaId } = useParams()
  const navigate = useNavigate()
  useAuth()
  const { empresaParceira } = useBranding()
  const dominioExclusivo = !!empresaParceira

  const [empresa, setEmpresa] = useState(null)
  const [produtos, setProdutos] = useState([])
  const [carrinho, setCarrinho] = useState({})
  const [categoriaAtiva, setCategoriaAtiva] = useState('Todos')
  const [busca, setBusca] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [carrinhoAberto, setCarrinhoAberto] = useState(false)
  const [pedidoFeito, setPedidoFeito] = useState(false)

  useEffect(() => {
    if (!empresaId) return
    async function load() {
      setLoading(true)
      const [empRes, prodRes] = await Promise.all([
        supabase.from('empresas').select('id, nome, banner_url, logo_url, descricao').eq('id', empresaId).maybeSingle(),
        supabase.from('estoque_catalogo').select('*').eq('empresa_id', empresaId).order('categoria').order('nome'),
      ])
      if (empRes.error || prodRes.error) setError((empRes.error || prodRes.error).message)
      setEmpresa(empRes.data ?? null)
      setProdutos(prodRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [empresaId])

  /* ── Carrinho ── */
  function addOne(id) { setCarrinho(p => ({ ...p, [id]: (p[id] ?? 0) + 1 })) }
  function removeOne(id) {
    setCarrinho(p => {
      const n = { ...p }
      if ((n[id] ?? 0) <= 1) delete n[id]
      else n[id]--
      return n
    })
  }

  const itensCarrinho = Object.entries(carrinho)
    .map(([id, qtd]) => ({ produto: produtos.find(p => p.produto_id === id), qtd }))
    .filter(i => i.produto)

  const totalItens = itensCarrinho.reduce((s, i) => s + i.qtd, 0)
  const totalValor = itensCarrinho.reduce((s, i) => s + i.qtd * Number(i.produto.preco_venda), 0)

  /* ── Categorias ── */
  const categorias = ['Todos', ...new Set(produtos.map(p => p.categoria).filter(Boolean))]

  /* ── Filtro ── */
  const produtosFiltrados = produtos.filter(p => {
    const matchCategoria = categoriaAtiva === 'Todos' || p.categoria === categoriaAtiva
    const termo = busca.trim().toLowerCase()
    const matchBusca = !termo
      || p.nome?.toLowerCase().includes(termo)
      || p.descricao?.toLowerCase().includes(termo)
    return matchCategoria && matchBusca
  })

  /* ── Agrupamento por categoria para renderização ── */
  const categoriasDeProdutos = categorias.filter(c => c !== 'Todos')
  const secoes = categoriaAtiva === 'Todos'
    ? categoriasDeProdutos
        .map(cat => ({
          nome: cat,
          produtos: produtosFiltrados.filter(p => p.categoria === cat),
        }))
        .filter(s => s.produtos.length > 0)
    : [{
        nome: categoriaAtiva,
        produtos: produtosFiltrados,
      }].filter(s => s.produtos.length > 0)

  // Produtos sem categoria agrupados numa seção extra
  const semCategoria = produtosFiltrados.filter(p => !p.categoria)

  /* ── Confirmar ── */
  async function handleConfirmar() {
    if (!empresaId || itensCarrinho.length === 0) return
    setEnviando(true)
    setError(null)
    const { error } = await supabase.rpc('registrar_pedido_portal', {
      p_empresa_id: empresaId,
      p_itens: itensCarrinho.map(i => ({
        produto_id: i.produto.produto_id,
        quantidade: i.qtd,
        preco_unitario: Number(i.produto.preco_venda),
      })),
    })
    setEnviando(false)
    if (error) { setError(error.message); return }
    setCarrinho({})
    setCarrinhoAberto(false)
    setPedidoFeito(true)
    setTimeout(() => setPedidoFeito(false), 4000)

    // Tentar enviar WhatsApp de confirmação (silencioso — não bloqueia se falhar)
    try {
      const { data: clienteData } = await supabase
        .from('clientes')
        .select('nome, telefone')
        .limit(1)
        .single()
      if (clienteData?.telefone) {
        const { sendWhatsApp } = await import('../lib/whatsapp')
        await sendWhatsApp({
          phone: clienteData.telefone,
          message: `Olá ${clienteData.nome ?? 'cliente'}! Seu pedido foi recebido com sucesso. Em breve entraremos em contato para confirmar a entrega.`,
          empresaId: empresaId,
        })
      }
    } catch { /* silencioso */ }

    const { data } = await supabase.from('estoque_catalogo').select('*').eq('empresa_id', empresaId).order('categoria').order('nome')
    setProdutos(data ?? [])
  }

  if (loading) return (
    <div className="loja-loading">
      <div className="loja-spinner" />
      <p>Carregando cardápio...</p>
    </div>
  )

  return (
    <div className="loja-root">
      {/* ── Banner hero full-bleed ── */}
      <div className="loja-hero">
        {empresa?.banner_url
          ? <img className="loja-hero-img" src={empresa.banner_url} alt={empresa?.nome} />
          : <div className="loja-hero-placeholder" />
        }
        {!dominioExclusivo && (
          <button className="loja-back-btn" onClick={() => navigate('/portal')} aria-label="Voltar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
        )}
      </div>

      {/* ── Store identity ── */}
      <div className="loja-identity">
        <div className="loja-identity-logo">
          {empresa?.logo_url
            ? <img src={empresa.logo_url} alt={empresa?.nome} />
            : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <path d="M16 10a4 4 0 0 1-8 0"/>
              </svg>
            )
          }
        </div>
        <div className="loja-identity-info">
          <h1 className="loja-identity-nome">{empresa?.nome ?? 'Loja'}</h1>
          <span className="loja-identity-sub">Catálogo de produtos</span>
        </div>
      </div>

      {/* ── Feedbacks ── */}
      {pedidoFeito && (
        <div className="loja-sucesso">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Pedido enviado! Veja em <strong>Pedidos</strong>.
        </div>
      )}
      {error && <div className="loja-aviso loja-aviso-erro">{error}</div>}

      {/* ── Busca ── */}
      <div className="loja-search-wrap">
        <svg className="loja-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          className="loja-search-input"
          type="search"
          placeholder="Buscar no cardápio..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
        />
        {busca && (
          <button className="loja-search-clear" onClick={() => setBusca('')} aria-label="Limpar busca">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      {/* ── Categorias pills sticky ── */}
      <div className="loja-categorias-sticky">
        <div className="loja-categorias">
          {categorias.map(cat => (
            <button
              key={cat}
              className={`loja-cat-pill${categoriaAtiva === cat ? ' active' : ''}`}
              onClick={() => setCategoriaAtiva(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* ── Conteúdo de produtos ── */}
      <div className="loja-catalogo">
        {produtosFiltrados.length === 0 ? (
          <div className="loja-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p>Nenhum produto encontrado.</p>
            {busca && <span>Tente outro termo de busca.</span>}
          </div>
        ) : (
          <>
            {secoes.map(secao => (
              <section key={secao.nome} className="loja-secao">
                <h3 className="loja-secao-titulo">{secao.nome}</h3>
                <div className="loja-lista">
                  {secao.produtos.map(p => (
                    <ProdutoCard
                      key={p.produto_id}
                      produto={p}
                      qtd={carrinho[p.produto_id] ?? 0}
                      onAdd={addOne}
                      onRemove={removeOne}
                    />
                  ))}
                </div>
              </section>
            ))}

            {semCategoria.length > 0 && (
              <section className="loja-secao">
                <h3 className="loja-secao-titulo">Outros</h3>
                <div className="loja-lista">
                  {semCategoria.map(p => (
                    <ProdutoCard
                      key={p.produto_id}
                      produto={p}
                      qtd={carrinho[p.produto_id] ?? 0}
                      onAdd={addOne}
                      onRemove={removeOne}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {/* ── Barra flutuante da sacola ── */}
      {totalItens > 0 && (
        <button className="loja-cart-bar" onClick={() => setCarrinhoAberto(true)}>
          <span className="loja-cart-badge">{totalItens}</span>
          <span className="loja-cart-label">Ver sacola</span>
          <span className="loja-cart-total">
            R$ {totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </span>
        </button>
      )}

      {/* ── Drawer da sacola ── */}
      {carrinhoAberto && (
        <div className="loja-drawer-overlay" onClick={() => setCarrinhoAberto(false)}>
          <div className="loja-drawer" onClick={e => e.stopPropagation()}>
            <div className="loja-drawer-handle" />
            <div className="loja-drawer-header">
              <h2>Sua sacola</h2>
              <button className="loja-drawer-close" onClick={() => setCarrinhoAberto(false)} aria-label="Fechar sacola">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div className="loja-drawer-itens">
              {itensCarrinho.map(({ produto, qtd }) => (
                <div key={produto.produto_id} className="loja-drawer-item">
                  <div className="loja-drawer-item-info">
                    <span className="loja-drawer-item-nome">{produto.nome}</span>
                    <span className="loja-drawer-item-sub">
                      R$ {Number(produto.preco_venda).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} cada
                    </span>
                  </div>
                  <div className="loja-qty-ctrl">
                    <button className="loja-qty-btn" onClick={() => removeOne(produto.produto_id)}>−</button>
                    <span className="loja-qty-val">{qtd}</span>
                    <button className="loja-qty-btn" onClick={() => addOne(produto.produto_id)}>+</button>
                  </div>
                  <span className="loja-drawer-item-total">
                    R$ {(qtd * Number(produto.preco_venda)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>

            <div className="loja-drawer-total">
              <span>Total</span>
              <strong>R$ {totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
            </div>

            {error && (
              <div className="loja-aviso loja-aviso-erro" style={{ margin: '0 20px 12px' }}>
                {error}
              </div>
            )}

            <button className="loja-btn-confirmar" onClick={handleConfirmar} disabled={enviando}>
              {enviando
                ? (
                  <>
                    <span className="loja-btn-spinner" />
                    Enviando...
                  </>
                )
                : 'Confirmar pedido'
              }
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Card de produto horizontal (iFood style) ── */
function ProdutoCard({ produto: p, qtd, onAdd, onRemove }) {
  const saldo = Number(p.quantidade_atual ?? 0)
  const semEstoque = saldo <= 0

  return (
    <div className={`loja-card${semEstoque ? ' indisponivel' : ''}`}>
      {/* Info à esquerda */}
      <div className="loja-card-info">
        <p className="loja-card-nome">{p.nome}</p>
        {p.descricao && (
          <p className="loja-card-descricao">{p.descricao}</p>
        )}
        <p className="loja-card-meta">
          {[p.embalagem, p.unidades_por_caixa > 1 ? `${p.unidades_por_caixa} un.` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="loja-card-preco">
          R$ {Number(p.preco_venda).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
        </p>
      </div>

      {/* Imagem à direita com controle sobreposto */}
      <div className="loja-card-img-wrap">
        {semEstoque && <span className="loja-card-off-badge">Indisponível</span>}

        {p.foto_url
          ? <img className="loja-card-img" src={p.foto_url} alt={p.nome} loading="lazy" />
          : (
            <div className="loja-card-img loja-card-img-placeholder">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </div>
          )
        }

        {/* Controle de quantidade sobre a imagem */}
        {qtd === 0
          ? (
            <button
              className="loja-add-btn"
              disabled={semEstoque}
              onClick={() => onAdd(p.produto_id)}
              aria-label={`Adicionar ${p.nome}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          )
          : (
            <div className="loja-qty-overlay">
              <button
                className="loja-qty-mini-btn"
                onClick={() => onRemove(p.produto_id)}
                aria-label="Remover um"
              >−</button>
              <span className="loja-qty-mini-val">{qtd}</span>
              <button
                className="loja-qty-mini-btn"
                disabled={qtd >= saldo}
                onClick={() => onAdd(p.produto_id)}
                aria-label="Adicionar um"
              >+</button>
            </div>
          )
        }
      </div>
    </div>
  )
}
