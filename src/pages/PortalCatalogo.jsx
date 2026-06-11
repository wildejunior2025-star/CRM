import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Portal.css'

export default function PortalCatalogo() {
  const { profile } = useAuth()
  const [produtos, setProdutos] = useState([])
  const [estoque, setEstoque] = useState({})
  const [cliente, setCliente] = useState(null)
  const [carrinho, setCarrinho] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [sucesso, setSucesso] = useState(null)

  async function loadAll() {
    setLoading(true)
    setError(null)

    const queries = [
      supabase.from('produtos').select('*').eq('ativo', true).order('nome'),
      supabase.from('estoque_saldo').select('produto_id, quantidade_atual'),
    ]

    if (profile?.cliente_id) {
      queries.push(supabase.from('clientes').select('*').eq('id', profile.cliente_id).maybeSingle())
    }

    const [produtosRes, estoqueRes, clienteRes] = await Promise.all(queries)

    const firstError = produtosRes.error || estoqueRes.error || clienteRes?.error
    if (firstError) setError(firstError.message)

    setProdutos(produtosRes.data ?? [])

    const mapaEstoque = {}
    for (const e of estoqueRes.data ?? []) {
      mapaEstoque[e.produto_id] = Number(e.quantidade_atual)
    }
    setEstoque(mapaEstoque)

    if (clienteRes) setCliente(clienteRes.data ?? null)
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.cliente_id])

  function setQuantidade(produtoId, quantidade) {
    setCarrinho((prev) => {
      const next = { ...prev }
      if (quantidade <= 0) delete next[produtoId]
      else next[produtoId] = quantidade
      return next
    })
  }

  const itensCarrinho = Object.entries(carrinho)
    .map(([produtoId, quantidade]) => {
      const produto = produtos.find((p) => p.id === produtoId)
      return produto ? { produto, quantidade } : null
    })
    .filter(Boolean)

  const total = itensCarrinho.reduce(
    (sum, item) => sum + item.quantidade * Number(item.produto.preco_venda),
    0
  )

  async function handleConfirmar() {
    setError(null)
    setSucesso(null)

    if (!profile?.cliente_id) {
      setError('Seu cadastro ainda não foi vinculado a um cliente. Entre em contato com o depósito.')
      return
    }

    if (itensCarrinho.length === 0) {
      setError('Adicione ao menos um produto ao pedido.')
      return
    }

    setEnviando(true)

    const { error } = await supabase.rpc('registrar_venda', {
      p_cliente_id: profile.cliente_id,
      p_forma_pagamento: cliente?.condicao_pagamento ?? 'a_vista',
      p_observacoes: 'Pedido feito pelo portal do cliente',
      p_itens: itensCarrinho.map((item) => ({
        produto_id: item.produto.id,
        quantidade: item.quantidade,
        preco_unitario: Number(item.produto.preco_venda),
      })),
    })

    setEnviando(false)

    if (error) {
      setError(error.message)
      return
    }

    setCarrinho({})
    setSucesso('Pedido enviado com sucesso! Acompanhe em "Meus pedidos".')
    loadAll()
  }

  return (
    <div>
      <div className="page-header">
        <h1>Catálogo</h1>
      </div>

      {!loading && !profile?.cliente_id && (
        <p className="error-text">
          Seu cadastro ainda não foi vinculado a um cliente. Entre em contato com o depósito para
          liberar pedidos.
        </p>
      )}

      {error && <p className="error-text">{error}</p>}
      {sucesso && <p className="portal-success">{sucesso}</p>}

      <div className="data-table" style={{ marginBottom: 24 }}>
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : produtos.length === 0 ? (
          <div className="empty-state">Nenhum produto disponível.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Produto</th>
                <th>Categoria</th>
                <th>Embalagem</th>
                <th className="portal-amount-col">Preço</th>
                <th>Disponível</th>
                <th>Quantidade</th>
              </tr>
            </thead>
            <tbody>
              {produtos.map((p) => (
                <tr key={p.id}>
                  <td>{p.nome}</td>
                  <td>{p.categoria}</td>
                  <td>{p.embalagem}</td>
                  <td className="portal-amount-col">R$ {Number(p.preco_venda).toFixed(2)}</td>
                  <td>{estoque[p.id] ?? 0}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      className="portal-qty-input"
                      value={carrinho[p.id] ?? ''}
                      placeholder="0"
                      onChange={(e) => setQuantidade(p.id, Number(e.target.value))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {itensCarrinho.length > 0 && (
        <div className="card portal-cart">
          <h2 className="portal-table-title">Resumo do pedido</h2>
          <ul className="portal-cart-list">
            {itensCarrinho.map((item) => (
              <li key={item.produto.id}>
                {item.quantidade}x {item.produto.nome} — R${' '}
                {(item.quantidade * Number(item.produto.preco_venda)).toFixed(2)}
              </li>
            ))}
          </ul>
          <div className="portal-total">
            Total: <strong>R$ {total.toFixed(2)}</strong>
          </div>
          <button className="btn btn-primary" onClick={handleConfirmar} disabled={enviando}>
            {enviando ? 'Enviando...' : 'Confirmar pedido'}
          </button>
        </div>
      )}
    </div>
  )
}
