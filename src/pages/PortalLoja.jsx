import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../context/BrandingContext'
import './PortalLoja.css'

export default function PortalLoja() {
  const { empresaId } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { empresaParceira } = useBranding()
  const dominioExclusivo = !!empresaParceira

  const [empresa, setEmpresa] = useState(null)
  const [produtos, setProdutos] = useState([])
  const [carrinho, setCarrinho] = useState({})
  const [categoriaAtiva, setCategoriaAtiva] = useState('Todos')
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
        supabase.from('empresas').select('id, nome').eq('id', empresaId).maybeSingle(),
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
  const produtosFiltrados = categoriaAtiva === 'Todos'
    ? produtos
    : produtos.filter(p => p.categoria === categoriaAtiva)

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
    // Recarrega estoque
    const { data } = await supabase.from('estoque_catalogo').select('*').eq('empresa_id', empresaId).order('categoria').order('nome')
    setProdutos(data ?? [])
  }

  if (loading) return (
    <div className="loja-loading">
      <div className="loja-spinner" />
      <p>Carregando catálogo...</p>
    </div>
  )

  return (
    <div className="loja-root">
      {/* Cabeçalho da loja */}
      <div className="loja-store-header">
        {!dominioExclusivo && (
          <button className="loja-back-btn" onClick={() => navigate('/portal')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
        )}
        <div className="loja-store-info">
          <h2 className="loja-store-nome">{empresa?.nome ?? 'Loja'}</h2>
          <span className="loja-store-sub">Catálogo de produtos</span>
        </div>
      </div>

      {pedidoFeito && (
        <div className="loja-sucesso">
          <span>✓</span> Pedido enviado! Veja em <strong>Pedidos</strong>.
        </div>
      )}

      {error && <div className="loja-aviso loja-aviso-erro">{error}</div>}

      {/* Filtro por categoria */}
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

      {/* Grid de produtos */}
      {produtosFiltrados.length === 0 ? (
        <div className="loja-empty">Nenhum produto nesta categoria.</div>
      ) : (
        <div className="loja-grid">
          {produtosFiltrados.map(p => {
            const saldo = Number(p.quantidade_atual ?? 0)
            const semEstoque = saldo <= 0
            const qtd = carrinho[p.produto_id] ?? 0

            return (
              <div key={p.produto_id} className={`loja-card${semEstoque ? ' indisponivel' : ''}`}>
                <div className={`loja-badge ${semEstoque ? 'loja-badge-off' : 'loja-badge-on'}`}>
                  {semEstoque ? 'Indisponível' : `${saldo} un.`}
                </div>
                <div className="loja-card-body">
                  <p className="loja-card-nome">{p.nome}</p>
                  <p className="loja-card-sub">{p.embalagem}{p.unidades_por_caixa > 1 ? ` · ${p.unidades_por_caixa} un.` : ''}</p>
                  <p className="loja-card-preco">
                    R$ {Number(p.preco_venda).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="loja-card-acao">
                  {qtd === 0 ? (
                    <button className="loja-btn-add" disabled={semEstoque} onClick={() => addOne(p.produto_id)}>
                      + Adicionar
                    </button>
                  ) : (
                    <div className="loja-qty-ctrl">
                      <button className="loja-qty-btn" onClick={() => removeOne(p.produto_id)}>−</button>
                      <span className="loja-qty-val">{qtd}</span>
                      <button className="loja-qty-btn" disabled={qtd >= saldo} onClick={() => addOne(p.produto_id)}>+</button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Barra flutuante do carrinho */}
      {totalItens > 0 && (
        <button className="loja-cart-bar" onClick={() => setCarrinhoAberto(true)}>
          <span className="loja-cart-badge">{totalItens}</span>
          <span>Ver sacola</span>
          <span className="loja-cart-total">
            R$ {totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </span>
        </button>
      )}

      {/* Drawer da sacola */}
      {carrinhoAberto && (
        <div className="loja-drawer-overlay" onClick={() => setCarrinhoAberto(false)}>
          <div className="loja-drawer" onClick={e => e.stopPropagation()}>
            <div className="loja-drawer-header">
              <h2>Sua sacola</h2>
              <button className="loja-drawer-close" onClick={() => setCarrinhoAberto(false)}>✕</button>
            </div>

            <div className="loja-drawer-itens">
              {itensCarrinho.map(({ produto, qtd }) => (
                <div key={produto.produto_id} className="loja-drawer-item">
                  <div className="loja-drawer-item-info">
                    <span className="loja-drawer-item-nome">{produto.nome}</span>
                    <span className="loja-drawer-item-sub">R$ {Number(produto.preco_venda).toFixed(2)} cada</span>
                  </div>
                  <div className="loja-qty-ctrl">
                    <button className="loja-qty-btn" onClick={() => removeOne(produto.produto_id)}>−</button>
                    <span className="loja-qty-val">{qtd}</span>
                    <button className="loja-qty-btn" onClick={() => addOne(produto.produto_id)}>+</button>
                  </div>
                  <span className="loja-drawer-item-total">
                    R$ {(qtd * Number(produto.preco_venda)).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>

            <div className="loja-drawer-total">
              <span>Total</span>
              <strong>R$ {totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
            </div>

            {error && <div className="loja-aviso loja-aviso-erro" style={{ margin: '0 20px 12px' }}>{error}</div>}

            <button className="loja-btn-confirmar" onClick={handleConfirmar} disabled={enviando}>
              {enviando ? 'Enviando...' : 'Confirmar pedido'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
