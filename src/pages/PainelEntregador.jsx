import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

function fmt(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function enderecoTexto(p) {
  return [p.endereco_rua, p.endereco_numero, p.endereco_bairro, p.endereco_cidade]
    .filter(Boolean).join(', ')
}

function mapsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(enderecoTexto(p))}`
}

// Só dígitos para o link do WhatsApp (wa.me abre a conversa, não gasta crédito).
function soDigitos(tel) {
  return String(tel || '').replace(/\D/g, '')
}

// ── Card de entrega ─────────────────────────────────────────
function CardEntrega({ pedido, mine, onAceitar, onSair, onConfirmar }) {
  const [codigo, setCodigo] = useState('')
  const [erro, setErro] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  const endereco = enderecoTexto(pedido)
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const tel = soDigitos(pedido.cliente_telefone)
  const emRota = pedido.status === 'saiu_entrega'
  const cor = !mine ? '#0d9488' : emRota ? '#7c3aed' : '#2563eb'

  async function run(fn) {
    setOcupado(true)
    await fn()
    setOcupado(false)
  }

  function confirmar() {
    if (pedido.codigo_entrega && codigo.trim() !== String(pedido.codigo_entrega).trim()) {
      setErro('Código incorreto.')
      return
    }
    run(() => onConfirmar(pedido))
  }

  return (
    <div style={{
      background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)',
      borderRadius: 14, padding: 16, borderTop: `4px solid ${cor}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--text)' }}>
            #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}
          </span>
          {pedido.origem === 'ifood' && (
            <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 20, background: '#ea1d2c', color: '#fff' }}>
              iFood{pedido.ifood_display_id ? ` #${pedido.ifood_display_id}` : ''}
            </span>
          )}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: `${cor}22`, color: cor }}>
          {!mine ? 'Disponível' : emRota ? 'Em rota' : 'Aceita'}
        </span>
      </div>

      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>{pedido.cliente_nome || 'Cliente'}</div>
      <div style={{ fontSize: 14, color: 'var(--text-muted)', margin: '4px 0 10px' }}>📍 {endereco}</div>

      {itens.length > 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          {itens.map((it, i) => (
            <div key={i}>{it.quantidade ?? it.qtd ?? 1}x {it.nome}</div>
          ))}
        </div>
      )}

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'var(--bg, #0f0f1a)', borderRadius: 10, padding: '8px 12px', marginBottom: 12,
      }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {pedido.forma_pagamento === 'pix' && (pedido.pix_status === 'pago' ? 'PIX pago ✓' : 'PIX')}
          {pedido.forma_pagamento === 'dinheiro' && 'Dinheiro'}
          {pedido.forma_pagamento && !['pix', 'dinheiro'].includes(pedido.forma_pagamento) && pedido.forma_pagamento}
          {pedido.forma_pagamento === 'dinheiro' && pedido.troco_para > 0 && (
            <span> · troco p/ {fmt(pedido.troco_para)}</span>
          )}
        </div>
        <strong style={{ fontSize: 16, color: 'var(--text)' }}>{fmt(pedido.total)}</strong>
      </div>

      {/* Contato / rota — só faz sentido depois de aceitar */}
      {mine && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <a href={mapsUrl(pedido)} target="_blank" rel="noopener noreferrer" style={btnLink('#7c3aed')}>🗺️ Rota</a>
          {tel && <a href={`tel:${tel}`} style={btnLink('#0891b2')}>📞 Ligar</a>}
          {tel && <a href={`https://wa.me/${tel}`} target="_blank" rel="noopener noreferrer" style={btnLink('#25d366')}>💬 Zap</a>}
        </div>
      )}

      {/* Ação principal */}
      {!mine ? (
        <button type="button" onClick={() => run(() => onAceitar(pedido))} disabled={ocupado}
          style={btnPrimario('#0d9488')}>
          {ocupado ? 'Aceitando...' : '✋ Aceitar entrega'}
        </button>
      ) : !emRota ? (
        <button type="button" onClick={() => run(() => onSair(pedido))} disabled={ocupado}
          style={btnPrimario('#7c3aed')}>
          {ocupado ? 'Salvando...' : '🛵 Sair para entrega'}
        </button>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={codigo}
              onChange={e => { setCodigo(e.target.value.replace(/\D/g, '').slice(0, 4)); setErro(null) }}
              inputMode="numeric"
              placeholder="Código"
              style={{
                flex: 1, minWidth: 0, width: '100%', padding: '10px 8px', borderRadius: 10, textAlign: 'center',
                fontSize: 18, fontWeight: 700, letterSpacing: 3,
                border: '1.5px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)', color: 'var(--text)',
              }}
            />
            <button type="button" onClick={confirmar} disabled={ocupado}
              style={{ ...btnPrimario('#16a34a'), width: 'auto', flexShrink: 0, padding: '0 16px', whiteSpace: 'nowrap' }}>
              {ocupado ? '...' : 'Entreguei'}
            </button>
          </div>
          {erro && <div style={{ fontSize: 12.5, color: 'var(--danger, #ef4444)', marginTop: 6 }}>{erro}</div>}
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
            Peça ao cliente os 4 dígitos que aparecem na tela do pedido dele.
          </div>
        </div>
      )}
    </div>
  )
}

function btnLink(cor) {
  return {
    flex: 1, textAlign: 'center', textDecoration: 'none', padding: '9px 0', borderRadius: 10,
    border: `1.5px solid ${cor}`, color: cor, fontWeight: 700, fontSize: 13.5,
  }
}
function btnPrimario(cor) {
  return {
    width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
    background: cor, color: '#fff', fontWeight: 800, fontSize: 15,
  }
}

// ── Tela do entregador ──────────────────────────────────────
export default function PainelEntregador() {
  const { user, profile, empresa, logout } = useAuth()
  const [pedidos, setPedidos] = useState([])
  const [loading, setLoading] = useState(true)
  const [aba, setAba] = useState('ativas') // 'ativas' | 'historico'
  const [historico, setHistorico] = useState([])
  const [histLoading, setHistLoading] = useState(false)

  // A RLS já limita: cada entregador recebe os pedidos dele + os 'pronto' livres
  // da própria loja. Por isso basta filtrar por status e deixar o banco filtrar o resto.
  const carregar = useCallback(async () => {
    if (!user) return
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .in('status', ['pronto', 'saiu_entrega'])
      .order('created_at')
    setPedidos(data ?? [])
    setLoading(false)
  }, [user])

  useEffect(() => {
    carregar()
    if (!user) return
    // Sem filtro de coluna: o Realtime respeita a RLS, então só chegam eventos
    // dos pedidos que este entregador pode ver (os dele + o pool da loja).
    const canal = supabase
      .channel(`entregas_${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'pedidos_delivery' },
        () => carregar())
      .subscribe()
    return () => { canal.unsubscribe() }
  }, [user, carregar])

  async function notificarCliente(pedidoId, novoStatus) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      fetch(`${SUPABASE_URL}/functions/v1/whatsapp-pedido-notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ pedido_id: pedidoId, novo_status: novoStatus }),
      })
    } catch { /* best-effort */ }
  }

  async function aceitar(pedido) {
    // Otimista: marca como meu. Se outro pegou primeiro, o reload corrige.
    setPedidos(prev => prev.map(p => p.id === pedido.id ? { ...p, entregador_id: user.id } : p))
    await supabase.from('pedidos_delivery').update({ entregador_id: user.id }).eq('id', pedido.id).is('entregador_id', null)
    carregar()
  }

  async function sairParaEntrega(pedido) {
    const update = { status: 'saiu_entrega', saiu_entrega_at: new Date().toISOString() }
    if (!pedido.codigo_entrega) update.codigo_entrega = String(Math.floor(1000 + Math.random() * 9000))
    setPedidos(prev => prev.map(p => p.id === pedido.id ? { ...p, ...update } : p))
    await supabase.from('pedidos_delivery').update(update).eq('id', pedido.id)
    notificarCliente(pedido.id, 'saiu_entrega')
  }

  async function confirmarEntrega(pedido) {
    setPedidos(prev => prev.filter(p => p.id !== pedido.id))
    await supabase.from('pedidos_delivery').update({ status: 'entregue' }).eq('id', pedido.id)
    notificarCliente(pedido.id, 'entregue')
  }

  // Histórico: entregas já concluídas por este entregador (carrega ao abrir a aba)
  useEffect(() => {
    if (aba !== 'historico' || !user) return
    setHistLoading(true)
    supabase
      .from('pedidos_delivery')
      .select('id, numero_pedido, cliente_nome, total, forma_pagamento, endereco_bairro, endereco_cidade, created_at')
      .eq('entregador_id', user.id)
      .eq('status', 'entregue')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => { setHistorico(data ?? []); setHistLoading(false) })
  }, [aba, user])

  const minhas = pedidos.filter(p => p.entregador_id === user?.id)
  // Disponíveis pro motoboy: só ENTREGA (retirada o cliente busca) e sem dono.
  // iFood: como o pedido costuma ir direto pra "saiu_entrega" (despachado no
  // iFood), também liberamos esses pro entregador da loja pegar e levar.
  const disponiveis = pedidos.filter(p =>
    p.tipo_entrega !== 'retirada' && !p.entregador_id &&
    (p.status === 'pronto' || (p.origem === 'ifood' && p.status === 'saiu_entrega'))
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0f0f1a)' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', background: 'var(--surface, #16161f)',
        borderBottom: '1px solid var(--border, #2a2a3a)',
      }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--text)' }}>Minhas entregas</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {empresa?.nome || ''} · {profile?.nome || user?.email}
          </div>
        </div>
        <button type="button" onClick={logout}
          style={{ background: 'none', border: '1px solid var(--border, #2a2a3a)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>
          Sair
        </button>
      </header>

      {/* Abas */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '14px 16px 0', display: 'flex', gap: 8 }}>
        {[
          { id: 'ativas', label: 'Entregas' },
          { id: 'historico', label: 'Histórico' },
        ].map(t => (
          <button key={t.id} type="button" onClick={() => setAba(t.id)}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
              border: `1.5px solid ${aba === t.id ? '#7c3aed' : 'var(--border, #2a2a3a)'}`,
              background: aba === t.id ? 'rgba(124,58,237,.15)' : 'transparent',
              color: aba === t.id ? '#a78bfa' : 'var(--text)',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <main style={{ maxWidth: 560, margin: '0 auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {aba === 'ativas' ? (
          loading ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Carregando...</p>
          ) : pedidos.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🛵</div>
              Nenhuma entrega no momento. Os pedidos prontos aparecem aqui.
            </div>
          ) : (
            <>
              {minhas.length > 0 && (
                <>
                  <h2 style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 -4px' }}>Minhas ({minhas.length})</h2>
                  {minhas.map(p => (
                    <CardEntrega key={p.id} pedido={p} mine
                      onSair={sairParaEntrega} onConfirmar={confirmarEntrega} />
                  ))}
                </>
              )}
              <>
                <h2 style={{ fontSize: 14, color: 'var(--text-muted)', margin: '8px 0 -4px' }}>
                  Disponíveis ({disponiveis.length})
                </h2>
                {disponiveis.length === 0 ? (
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>
                    Nenhum pedido pronto esperando. Aguarde a cozinha liberar.
                  </p>
                ) : disponiveis.map(p => (
                  <CardEntrega key={p.id} pedido={p} mine={false} onAceitar={aceitar} />
                ))}
              </>
            </>
          )
        ) : (
          /* ── Histórico de entregas concluídas ── */
          histLoading ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Carregando...</p>
          ) : historico.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>📭</div>
              Você ainda não concluiu nenhuma entrega.
            </div>
          ) : (
            <>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)',
                borderRadius: 12, padding: '10px 14px', fontSize: 13, color: 'var(--text-muted)',
              }}>
                <span><strong style={{ color: 'var(--text)' }}>{historico.length}</strong> entregas concluídas</span>
                <span>Total: <strong style={{ color: 'var(--text)' }}>{fmt(historico.reduce((s, p) => s + Number(p.total || 0), 0))}</strong></span>
              </div>
              {historico.map(p => (
                <div key={p.id} style={{
                  background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)',
                  borderRadius: 12, padding: 14,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 800, color: 'var(--text)' }}>
                      #{p.numero_pedido ?? p.id.slice(-4).toUpperCase()}
                    </span>
                    <strong style={{ color: '#16a34a' }}>{fmt(p.total)}</strong>
                  </div>
                  <div style={{ fontSize: 13.5, color: 'var(--text)', marginTop: 4 }}>{p.cliente_nome || 'Cliente'}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                    {[p.endereco_bairro, p.endereco_cidade].filter(Boolean).join(', ')}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    {p.forma_pagamento ? ` · ${p.forma_pagamento}` : ''}
                  </div>
                </div>
              ))}
            </>
          )
        )}
      </main>
    </div>
  )
}
