import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

const LABEL_STATUS = {
  confirmado:   'Preparando',
  em_preparo:   'Preparando',
  saiu_entrega: 'Em rota',
}
const COR_STATUS = {
  confirmado:   '#1d4ed8',
  em_preparo:   '#1d4ed8',
  saiu_entrega: '#7c3aed',
}

function fmt(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function enderecoTexto(p) {
  return [p.endereco_rua, p.endereco_numero, p.endereco_bairro, p.endereco_cidade]
    .filter(Boolean).join(', ')
}

function mapsUrl(p) {
  const addr = enderecoTexto(p)
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`
}

// Telefone só com dígitos para o link do WhatsApp (wa.me não consome crédito —
// abre a conversa, o entregador fala manualmente).
function soDigitos(tel) {
  return String(tel || '').replace(/\D/g, '')
}

// ── Card de entrega ─────────────────────────────────────────
function CardEntrega({ pedido, onSair, onConfirmar }) {
  const [codigo, setCodigo] = useState('')
  const [erro, setErro] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  const emRota = pedido.status === 'saiu_entrega'
  const endereco = enderecoTexto(pedido)
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const tel = soDigitos(pedido.cliente_telefone)

  async function sair() {
    setOcupado(true)
    await onSair(pedido)
    setOcupado(false)
  }

  async function confirmar() {
    if (pedido.codigo_entrega && codigo.trim() !== String(pedido.codigo_entrega).trim()) {
      setErro('Código incorreto.')
      return
    }
    setOcupado(true)
    await onConfirmar(pedido)
    setOcupado(false)
  }

  return (
    <div style={{
      background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)',
      borderRadius: 14, padding: 16, borderTop: `4px solid ${COR_STATUS[pedido.status] || '#7c3aed'}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--text)' }}>
          #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}
        </span>
        <span style={{
          fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
          background: `${COR_STATUS[pedido.status]}22`, color: COR_STATUS[pedido.status],
        }}>
          {LABEL_STATUS[pedido.status] || pedido.status}
        </span>
      </div>

      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>{pedido.cliente_nome || 'Cliente'}</div>
      <div style={{ fontSize: 14, color: 'var(--text-muted)', margin: '4px 0 10px' }}>📍 {endereco}</div>

      {/* Itens resumidos */}
      {itens.length > 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          {itens.map((it, i) => (
            <div key={i}>{it.quantidade ?? it.qtd ?? 1}x {it.nome}</div>
          ))}
        </div>
      )}

      {/* Pagamento a receber */}
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

      {/* Ações de contato/rota */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <a href={mapsUrl(pedido)} target="_blank" rel="noopener noreferrer"
          style={btnLink('#7c3aed')}>🗺️ Rota</a>
        {tel && (
          <a href={`tel:${tel}`} style={btnLink('#0891b2')}>📞 Ligar</a>
        )}
        {tel && (
          <a href={`https://wa.me/${tel}`} target="_blank" rel="noopener noreferrer"
            style={btnLink('#25d366')}>💬 WhatsApp</a>
        )}
      </div>

      {/* Ação principal */}
      {!emRota ? (
        <button type="button" onClick={sair} disabled={ocupado}
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
              placeholder="Código do cliente"
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 10, textAlign: 'center',
                fontSize: 18, fontWeight: 700, letterSpacing: 4,
                border: '1.5px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)', color: 'var(--text)',
              }}
            />
            <button type="button" onClick={confirmar} disabled={ocupado}
              style={{ ...btnPrimario('#16a34a'), width: 'auto', padding: '0 18px' }}>
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

  const carregar = useCallback(async () => {
    if (!user) return
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('entregador_id', user.id)
      .in('status', ['confirmado', 'em_preparo', 'saiu_entrega'])
      .order('created_at')
    setPedidos(data ?? [])
    setLoading(false)
  }, [user])

  useEffect(() => {
    carregar()
    if (!user) return
    const canal = supabase
      .channel(`entregas_${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'pedidos_delivery', filter: `entregador_id=eq.${user.id}` },
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

  async function sairParaEntrega(pedido) {
    const update = {
      status: 'saiu_entrega',
      saiu_entrega_at: new Date().toISOString(),
    }
    // Gera o código de confirmação se ainda não houver
    if (!pedido.codigo_entrega) {
      update.codigo_entrega = String(Math.floor(1000 + Math.random() * 9000))
    }
    setPedidos(prev => prev.map(p => p.id === pedido.id ? { ...p, ...update } : p))
    await supabase.from('pedidos_delivery').update(update).eq('id', pedido.id)
    notificarCliente(pedido.id, 'saiu_entrega')
  }

  async function confirmarEntrega(pedido) {
    setPedidos(prev => prev.filter(p => p.id !== pedido.id))
    await supabase.from('pedidos_delivery').update({ status: 'entregue' }).eq('id', pedido.id)
    notificarCliente(pedido.id, 'entregue')
  }

  const emRota = pedidos.filter(p => p.status === 'saiu_entrega')
  const aguardando = pedidos.filter(p => p.status !== 'saiu_entrega')

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0f0f1a)' }}>
      {/* Topo */}
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

      <main style={{ maxWidth: 560, margin: '0 auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Carregando...</p>
        ) : pedidos.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🛵</div>
            Nenhuma entrega atribuída a você no momento.
          </div>
        ) : (
          <>
            {emRota.length > 0 && (
              <>
                <h2 style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 -4px' }}>Em rota ({emRota.length})</h2>
                {emRota.map(p => (
                  <CardEntrega key={p.id} pedido={p} onSair={sairParaEntrega} onConfirmar={confirmarEntrega} />
                ))}
              </>
            )}
            {aguardando.length > 0 && (
              <>
                <h2 style={{ fontSize: 14, color: 'var(--text-muted)', margin: '8px 0 -4px' }}>A caminho da cozinha ({aguardando.length})</h2>
                {aguardando.map(p => (
                  <CardEntrega key={p.id} pedido={p} onSair={sairParaEntrega} onConfirmar={confirmarEntrega} />
                ))}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
