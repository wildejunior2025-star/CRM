import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useNavigate } from 'react-router-dom'
import './PortalLoja.css'
import './Portal.css'

// ── Timer regressivo inline para o cliente acompanhar o aceite ──
// Mostra quanto tempo falta para a loja aceitar (7 min = padrão do painel).
function TimerSimples({ createdAt }) {
  const LIMITE = 7 * 60 * 1000
  const [restante, setRestante] = useState(() =>
    Math.max(0, LIMITE - (Date.now() - new Date(createdAt).getTime()))
  )

  useEffect(() => {
    if (restante <= 0) return
    const id = setTimeout(() => {
      setRestante(Math.max(0, LIMITE - (Date.now() - new Date(createdAt).getTime())))
    }, 1000)
    return () => clearTimeout(id)
  }, [restante, createdAt])

  const m = Math.floor(restante / 60000)
  const s = Math.floor((restante % 60000) / 1000)
  const cor = restante < 60000 ? '#ef4444' : restante < 180000 ? '#f59e0b' : '#10b981'

  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: cor }}>
      {String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
    </span>
  )
}

const STATUS = {
  aguardando_pagamento: { label: 'Aguardando pagamento', bg: 'rgba(245,158,11,.15)', color: '#d97706' },
  aguardando:    { label: 'Aguardando',         bg: 'rgba(234,179,8,.15)',  color: '#ca8a04' },
  confirmado:    { label: 'Confirmado',          bg: 'rgba(34,197,94,.12)',  color: '#16a34a' },
  em_preparo:    { label: 'Em preparo',          bg: 'rgba(59,130,246,.12)', color: '#2563eb' },
  saiu_entrega:  { label: 'Saiu para entrega',   bg: 'rgba(124,58,237,.12)', color: '#7c3aed' },
  entregue:      { label: 'Entregue',            bg: 'rgba(34,197,94,.12)',  color: '#16a34a' },
  cancelado:     { label: 'Cancelado',           bg: 'rgba(239,68,68,.12)',  color: '#dc2626' },
}

const ICON_STATUS = {
  aguardando_pagamento: '💳',
  aguardando:   '🕐',
  confirmado:   '✅',
  em_preparo:   '👨‍🍳',
  saiu_entrega: '🛵',
  entregue:     '🎉',
  cancelado:    '❌',
}

export default function PortalPedidos() {
  const [pedidos, setPedidos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detalhe, setDetalhe] = useState(null)
  const [userId, setUserId] = useState(null)
  const navigate = useNavigate()

  async function load(uid) {
    if (!uid) return

    // busca cliente_id vinculado ao user
    const { data: clienteRow } = await supabase
      .from('clientes')
      .select('id')
      .eq('user_id', uid)
      .maybeSingle()
    const clienteId = clienteRow?.id ?? null

    let query = supabase
      .from('pedidos_delivery')
      .select('*, empresas(nome, logo_url)')
      .order('created_at', { ascending: false })

    if (clienteId) {
      query = query.or(`user_id.eq.${uid},cliente_id.eq.${clienteId}`)
    } else {
      query = query.eq('user_id', uid)
    }

    const { data, error: err } = await query
    if (err) setError(err.message)
    setPedidos(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      setUserId(user.id)
      load(user.id)
    })

    const channel = supabase
      .channel('portal_pedidos_status')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'pedidos_delivery' },
        payload => {
          setPedidos(prev =>
            prev.map(p => p.id === payload.new.id ? { ...p, ...payload.new } : p)
          )
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'pedidos_delivery' },
        () => { load(user.id) }
      )
      .subscribe()

    const poll = setInterval(() => load(user.id), 30_000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(poll)
    }
  }, [])

  if (loading) return (
    <div className="loja-loading">
      <div className="loja-spinner" />
      <p>Carregando pedidos...</p>
    </div>
  )

  return (
    <div className="portal-section">
      {error && <div className="loja-aviso loja-aviso-erro">{error}</div>}

      {pedidos.length === 0 ? (
        <div className="portal-empty">
          <div className="portal-empty-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
              <line x1="3" y1="6" x2="21" y2="6"/>
              <path d="M16 10a4 4 0 0 1-8 0"/>
            </svg>
          </div>
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
          {pedidos.map(p => {
            const st = STATUS[p.status] ?? STATUS.aguardando
            const icon = ICON_STATUS[p.status] ?? '📦'
            const dt = new Date(p.created_at)

            return (
              <button key={p.id} className="portal-pedido-card" onClick={() => setDetalhe(p)}>
                <div className="portal-pedido-card-header">
                  <div className="portal-pedido-data">
                    <span className="portal-pedido-icon">{icon}</span>
                    <div>
                      <span className="portal-pedido-loja">{p.empresas?.nome ?? 'Loja'}</span>
                      <span className="portal-pedido-hora">
                        {dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} · {dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                  <span className="portal-pedido-status" style={{ background: st.bg, color: st.color }}>
                    {st.label}
                  </span>
                </div>

                <div className="portal-pedido-card-body">
                  <span className="portal-pedido-forma">
                    {p.forma_pagamento === 'pix' ? 'Pix' : 'Dinheiro'}
                    {p.tipo_entrega === 'retirada'
                      ? ' · 🏪 Retirada'
                      : ' · 🛵 Delivery'}
                  </span>
                  <span className="portal-pedido-total">
                    R$ {Number(p.total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>

                {/* Mensagem de status contextual */}
                {p.status === 'aguardando_pagamento' && (
                  <div style={{ marginTop: 8, padding: '10px 12px', background: 'rgba(245,158,11,.1)', borderRadius: 8, border: '1px solid rgba(245,158,11,.3)', fontSize: 13, color: '#d97706', fontWeight: 600 }}>
                    💳 Aguardando confirmação do pagamento PIX...
                  </div>
                )}
                {p.status === 'aguardando' && (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
                    Aguardando aceite da loja · <TimerSimples createdAt={p.created_at} />
                  </div>
                )}
                {p.status === 'confirmado' && (
                  <div style={{ fontSize: 13, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>
                    ✅ Pedido confirmado pela loja!
                  </div>
                )}
                {p.status === 'em_preparo' && (
                  <div style={{ fontSize: 13, color: '#2563eb', marginTop: 6, fontWeight: 600 }}>
                    👨‍🍳 Seu pedido está sendo preparado...
                  </div>
                )}
                {p.status === 'saiu_entrega' && p.tipo_entrega !== 'retirada' && (
                  <div style={{ marginTop: 8, padding: '10px 12px', background: 'rgba(124,58,237,.12)', borderRadius: 8, border: '1px solid rgba(124,58,237,.3)' }}>
                    <div style={{ fontSize: 13, color: '#7c3aed', fontWeight: 600, marginBottom: 6 }}>
                      🛵 Seu pedido saiu para entrega!
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                      Código de confirmação — passe ao entregador:
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '0.4em', color: '#7c3aed', fontVariantNumeric: 'tabular-nums' }}>
                      {p.codigo_entrega ?? '----'}
                    </div>
                  </div>
                )}
                {p.status === 'saiu_entrega' && p.tipo_entrega === 'retirada' && (
                  <div style={{ marginTop: 8, padding: '10px 12px', background: 'rgba(124,58,237,.12)', borderRadius: 8, border: '1px solid rgba(124,58,237,.3)' }}>
                    <div style={{ fontSize: 13, color: '#7c3aed', fontWeight: 600, marginBottom: 6 }}>
                      🏪 Seu pedido está pronto para retirada!
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                      Código de retirada — apresente na loja:
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '0.4em', color: '#7c3aed', fontVariantNumeric: 'tabular-nums' }}>
                      {p.codigo_entrega ?? '----'}
                    </div>
                  </div>
                )}
                {p.status === 'entregue' && (
                  <div style={{ fontSize: 13, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>
                    🎉 Pedido entregue. Obrigado!
                  </div>
                )}
                {p.status === 'cancelado' && (
                  <div style={{ fontSize: 13, color: '#dc2626', marginTop: 6 }}>
                    ❌ Pedido cancelado
                    {p.motivo_cancelamento ? ` · ${p.motivo_cancelamento}` : ''}
                  </div>
                )}

                <div className="portal-pedido-ver">Ver detalhes →</div>
              </button>
            )
          })}
        </div>
      )}

      {/* Drawer de detalhes */}
      {detalhe && (
        <div className="loja-drawer-overlay" onClick={() => setDetalhe(null)}>
          <div className="loja-drawer" onClick={e => e.stopPropagation()}>
            <div className="loja-drawer-handle" />
            <div className="loja-drawer-header">
              <div>
                <h2 style={{ marginBottom: 2 }}>Detalhes do pedido</h2>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                  {detalhe.empresas?.nome} · {new Date(detalhe.created_at).toLocaleString('pt-BR')}
                </p>
              </div>
              <button className="loja-drawer-close" onClick={() => setDetalhe(null)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {/* Status badge */}
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              {(() => {
                const st = STATUS[detalhe.status] ?? STATUS.aguardando
                return (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '6px 14px', borderRadius: 999, fontSize: 14, fontWeight: 700,
                    background: st.bg, color: st.color,
                  }}>
                    {ICON_STATUS[detalhe.status]} {st.label}
                  </span>
                )
              })()}
            </div>

            <div className="loja-drawer-itens">
              {/* Itens */}
              {(detalhe.itens ?? []).map((item, i) => (
                <div key={i} className="portal-detalhe-item">
                  <div className="portal-detalhe-item-info">
                    <span className="loja-drawer-item-nome">{item.nome}</span>
                    <span className="loja-drawer-item-sub">
                      {item.quantidade} × R$ {Number(item.preco_unitario).toFixed(2)}
                    </span>
                  </div>
                  <span className="loja-drawer-item-total">
                    R$ {Number(item.subtotal).toFixed(2)}
                  </span>
                </div>
              ))}

              {/* Endereço / tipo de entrega */}
              <div style={{ paddingTop: 14, borderTop: '1px solid var(--border)', marginTop: 4 }}>
                <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                  {detalhe.tipo_entrega === 'retirada' ? 'Tipo' : 'Endereço'}
                </p>
                {detalhe.tipo_entrega === 'retirada' ? (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>
                    Retirada na loja
                  </p>
                ) : (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>
                    {[detalhe.endereco_rua, detalhe.endereco_numero, detalhe.endereco_complemento, detalhe.endereco_bairro, detalhe.endereco_cidade]
                      .filter(Boolean).join(', ') || '—'}
                  </p>
                )}
              </div>

              {/* Pagamento */}
              <div style={{ paddingTop: 14 }}>
                <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                  Pagamento
                </p>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>
                  {detalhe.forma_pagamento === 'pix'
                    ? 'Pix'
                    : `Dinheiro${detalhe.troco_para ? ` (troco p/ R$ ${Number(detalhe.troco_para).toFixed(2)})` : ''}`
                  }
                </p>
              </div>

              {detalhe.observacoes && (
                <div style={{ paddingTop: 14, borderTop: '1px solid var(--border)', marginTop: 14 }}>
                  <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                    Observações
                  </p>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>{detalhe.observacoes}</p>
                </div>
              )}
            </div>

            <div className="loja-drawer-total">
              {Number(detalhe.taxa_entrega) > 0 && (
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                  +R$ {Number(detalhe.taxa_entrega).toFixed(2)} entrega
                </span>
              )}
              <strong>
                R$ {Number(detalhe.total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
              </strong>
            </div>

            <button className="loja-btn-confirmar" style={{ margin: '0 20px 20px' }} onClick={() => setDetalhe(null)}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
