import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import './PortalLoja.css'

export default function PortalCatalogo() {
  const { profile } = useAuth()
  const [produtos, setProdutos] = useState([])
  const [estoque, setEstoque] = useState({})
  const [cliente, setCliente] = useState(null)
  const [carrinho, setCarrinho] = useState({}) // { [produtoId]: quantidade }
  const [categoriaAtiva, setCategoriaAtiva] = useState('Todos')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [carrinhoAberto, setCarrinhoAberto] = useState(false)
  const [pedidoFeito, setPedidoFeito] = useState(false)

  async function loadAll() {
    setLoading(true)
    setError(null)

    const queries = [
      supabase.from('produtos').select('*').eq('ativo', true).order('categoria').order('nome'),
      supabase.from('estoque_saldo').select('produto_id, quantidade_atual'),
    ]
    if (profile?.cliente_id) {
      queries.push(supabase.from('clientes').select('*').eq('id', profile.cliente_id).maybeSingle())
    }

    const [produtosRes, estoqueRes, clienteRes] = await Promise.all(queries)
    if (produtosRes.error || estoqueRes.error) setError((produtosRes.error || estoqueRes.error).message)

    setProdutos(produtosRes.data ?? [])

    const mapa = {}
    for (const e of estoqueRes.data ?? []) mapa[e.produto_id] = Number(e.quantidade_atual)
    setEstoque(mapa)

    if (clienteRes) setCliente(clienteRes.data ?? null)
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [profile?.cliente_id])

  /* ── Carrinho ── */
  function setQtd(id, qtd) {
    setCarrinho(prev => {
      const next = { ...prev }
      if (qtd <= 0) delete next[id]
      else next[id] = qtd
      return next
    })
  }

  function addOne(id) {
    setCarrinho(prev => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
  }

  function removeOne(id) {
    setCarrinho(prev => {
      const next = { ...prev }
      if ((next[id] ?? 0) <= 1) delete next[id]
      else next[id] = next[id] - 1
      return next
    })
  }

  const itensCarrinho = Object.entries(carrinho)
    .map(([id, qtd]) => {
      const produto = produtos.find(p => p.id === id)
      return produto ? { produto, qtd } : null
    })
    .filter(Boolean)

  const totalItens = itensCarrinho.reduce((s, i) => s + i.qtd, 0)
  const totalValor = itensCarrinho.reduce((s, i) => s + i.qtd * Number(i.produto.preco_venda), 0)

  /* ── Categorias ── */
  const categorias = ['Todos', ...new Set(produtos.map(p => p.categoria).filter(Boolean))]
  const produtosFiltrados = categoriaAtiva === 'Todos'
    ? produtos
    : produtos.filter(p => p.categoria === categoriaAtiva)

  /* ── Confirmar pedido ── */
  async function handleConfirmar() {
    setError(null)
    if (!profile?.cliente_id) {
      setError('Seu cadastro ainda não foi vinculado a um cliente. Fale com o depósito.')
      return
    }
    if (itensCarrinho.length === 0) return

    setEnviando(true)
    const { error } = await supabase.rpc('registrar_venda', {
      p_cliente_id: profile.cliente_id,
      p_forma_pagamento: cliente?.condicao_pagamento ?? 'a_vista',
      p_observacoes: 'Pedido pelo portal',
      p_itens: itensCarrinho.map(i => ({
        produto_id: i.produto.id,
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
    loadAll()
  }

  if (loading) {
    return (
      <div className="loja-loading">
        <div className="loja-spinner" />
        <p>Carregando produtos...</p>
      </div>
    )
  }

  return (
    <div className="loja-root">
      {/* Aviso se não vinculado */}
      {!profile?.cliente_id && (
        <div className="loja-aviso">
          Seu cadastro ainda não foi vinculado. Fale com o depósito para liberar pedidos.
        </div>
      )}

      {/* Sucesso */}
      {pedidoFeito && (
        <div className="loja-sucesso">
          <span>✓</span> Pedido enviado! Acompanhe em <strong>Pedidos</strong>.
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
            const saldo = estoque[p.id] ?? 0
            const semEstoque = saldo <= 0
            const qtdCarrinho = carrinho[p.id] ?? 0

            return (
              <div key={p.id} className={`loja-card${semEstoque ? ' indisponivel' : ''}`}>
                {/* Badge de disponibilidade */}
                <div className={`loja-badge ${semEstoque ? 'loja-badge-off' : 'loja-badge-on'}`}>
                  {semEstoque ? 'Indisponível' : `${saldo} em estoque`}
                </div>

                {/* Info */}
                <div className="loja-card-body">
                  <p className="loja-card-nome">{p.nome}</p>
                  <p className="loja-card-sub">{p.embalagem} {p.unidades_por_caixa > 1 ? `· ${p.unidades_por_caixa} un.` : ''}</p>
                  <p className="loja-card-preco">
                    R$ {Number(p.preco_venda).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </p>
                </div>

                {/* Controle de quantidade */}
                <div className="loja-card-acao">
                  {qtdCarrinho === 0 ? (
                    <button
                      className="loja-btn-add"
                      disabled={semEstoque}
                      onClick={() => addOne(p.id)}
                    >
                      + Adicionar
                    </button>
                  ) : (
                    <div className="loja-qty-ctrl">
                      <button className="loja-qty-btn" onClick={() => removeOne(p.id)}>−</button>
                      <span className="loja-qty-val">{qtdCarrinho}</span>
                      <button className="loja-qty-btn" disabled={qtdCarrinho >= saldo} onClick={() => addOne(p.id)}>+</button>
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
          <span>Ver pedido</span>
          <span className="loja-cart-total">
            R$ {totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </span>
        </button>
      )}

      {/* Drawer do carrinho */}
      {carrinhoAberto && (
        <div className="loja-drawer-overlay" onClick={() => setCarrinhoAberto(false)}>
          <div className="loja-drawer" onClick={e => e.stopPropagation()}>
            <div className="loja-drawer-header">
              <h2>Seu pedido</h2>
              <button className="loja-drawer-close" onClick={() => setCarrinhoAberto(false)}>✕</button>
            </div>

            <div className="loja-drawer-itens">
              {itensCarrinho.map(({ produto, qtd }) => (
                <div key={produto.id} className="loja-drawer-item">
                  <div className="loja-drawer-item-info">
                    <span className="loja-drawer-item-nome">{produto.nome}</span>
                    <span className="loja-drawer-item-sub">
                      R$ {Number(produto.preco_venda).toFixed(2)} cada
                    </span>
                  </div>
                  <div className="loja-qty-ctrl">
                    <button className="loja-qty-btn" onClick={() => removeOne(produto.id)}>−</button>
                    <span className="loja-qty-val">{qtd}</span>
                    <button className="loja-qty-btn" onClick={() => addOne(produto.id)}>+</button>
                  </div>
                  <span className="loja-drawer-item-total">
                    R$ {(qtd * Number(produto.preco_venda)).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>

            {cliente?.condicao_pagamento && (
              <div className="loja-drawer-pagamento">
                Pagamento: <strong>
                  {cliente.condicao_pagamento === 'a_vista' ? 'À vista'
                    : cliente.condicao_pagamento === 'fiado' ? 'Fiado'
                    : cliente.condicao_pagamento}
                </strong>
              </div>
            )}

            <div className="loja-drawer-total">
              <span>Total</span>
              <strong>R$ {totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
            </div>

            {error && <div className="loja-aviso loja-aviso-erro" style={{ margin: '0 0 12px' }}>{error}</div>}

            <button
              className="loja-btn-confirmar"
              onClick={handleConfirmar}
              disabled={enviando || !profile?.cliente_id}
            >
              {enviando ? 'Enviando pedido...' : 'Confirmar pedido'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
