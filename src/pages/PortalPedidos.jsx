import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useNavigate } from 'react-router-dom'
import './PortalLoja.css'
import './Portal.css'

const STATUS_COLOR = {
  pedido:    { bg: 'var(--warning-bg)',  color: 'var(--warning)' },
  entregue:  { bg: 'var(--success-bg)', color: 'var(--success)' },
  cancelado: { bg: 'var(--danger-bg)',  color: 'var(--danger)'  },
}

const STATUS_LABEL = { pedido: 'Em andamento', entregue: 'Entregue', cancelado: 'Cancelado' }

export default function PortalPedidos() {
  const [vendas, setVendas] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detalhe, setDetalhe] = useState(null)
  const [detalheItens, setDetalheItens] = useState([])
  const [loadingItens, setLoadingItens] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    async function load() {
      // Busca todos os pedidos do cliente via clientes.user_id = auth.uid()
      const { data, error } = await supabase
        .from('vendas')
        .select('*, clientes(nome, empresa_id, empresas(nome))')
        .order('created_at', { ascending: false })

      if (error) setError(error.message)
      setVendas(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  async function openDetalhe(venda) {
    setDetalhe(venda)
    setLoadingItens(true)
    const { data } = await supabase
      .from('venda_itens')
      .select('*, produtos(nome)')
      .eq('venda_id', venda.id)
    setDetalheItens(data ?? [])
    setLoadingItens(false)
  }

  if (loading) return (
    <div className="loja-loading">
      <div className="loja-spinner" />
      <p>Carregando pedidos...</p>
    </div>
  )

  return (
    <div className="portal-section">
      {error && <div className="loja-aviso loja-aviso-erro">{error}</div>}

      {vendas.length === 0 ? (
        <div className="portal-empty">
          <div className="portal-empty-icon">📦</div>
          <p>Nenhum pedido ainda.</p>
          <span>Escolha uma loja e faça seu primeiro pedido!</span>
          <button
            className="loja-btn-add"
            style={{ marginTop: 16, width: 'auto', padding: '10px 24px' }}
            onClick={() => navigate('/portal')}
          >
            Ver lojas
          </button>
        </div>
      ) : (
        <div className="portal-pedidos-lista">
          {vendas.map(v => {
            const cores = STATUS_COLOR[v.status] ?? STATUS_COLOR.pedido
            const lojaNome = v.clientes?.empresas?.nome ?? '—'
            const data = new Date(v.created_at)

            return (
              <button key={v.id} className="portal-pedido-card" onClick={() => openDetalhe(v)}>
                <div className="portal-pedido-card-header">
                  <div className="portal-pedido-data">
                    <span className="portal-pedido-dia">
                      {data.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                    </span>
                    <span className="portal-pedido-hora">
                      {data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <span className="portal-pedido-status" style={{ background: cores.bg, color: cores.color }}>
                    {STATUS_LABEL[v.status] ?? v.status}
                  </span>
                </div>

                <div className="portal-pedido-card-body">
                  <span className="portal-pedido-forma">{lojaNome}</span>
                  <span className="portal-pedido-total">
                    R$ {Number(v.total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>

                <div className="portal-pedido-ver">Ver itens →</div>
              </button>
            )
          })}
        </div>
      )}

      {/* Drawer de detalhes */}
      {detalhe && (
        <div className="loja-drawer-overlay" onClick={() => setDetalhe(null)}>
          <div className="loja-drawer" onClick={e => e.stopPropagation()}>
            <div className="loja-drawer-header">
              <div>
                <h2 style={{ marginBottom: 2 }}>Detalhes do pedido</h2>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                  {detalhe.clientes?.empresas?.nome} · {new Date(detalhe.created_at).toLocaleString('pt-BR')}
                </p>
              </div>
              <button className="loja-drawer-close" onClick={() => setDetalhe(null)}>✕</button>
            </div>

            <div className="loja-drawer-itens">
              {loadingItens ? (
                <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)' }}>Carregando...</div>
              ) : detalheItens.map(item => (
                <div key={item.id} className="portal-detalhe-item">
                  <div className="portal-detalhe-item-info">
                    <span className="loja-drawer-item-nome">{item.produtos?.nome ?? '—'}</span>
                    <span className="loja-drawer-item-sub">
                      {item.quantidade} × R$ {Number(item.preco_unitario).toFixed(2)}
                    </span>
                  </div>
                  <span className="loja-drawer-item-total">
                    R$ {Number(item.subtotal).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>

            <div className="loja-drawer-total">
              <span>Total</span>
              <strong>R$ {Number(detalhe.total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
            </div>

            <button className="loja-btn-confirmar" onClick={() => setDetalhe(null)}>Fechar</button>
          </div>
        </div>
      )}
    </div>
  )
}
