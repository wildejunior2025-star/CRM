import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { imprimirHtml, montarComandaCozinhaHtml } from '../utils/imprimirCupom'
import { separarItem } from '../lib/itensPedido'
import '../components/Page.css'

function tempoDesde(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'agora'
  if (min === 1) return '1 min'
  return `${min} min`
}

// Botão/estado de "Aceitar → Preparando → Pronto" (G1). Reusado por pedido e item.
function AcaoPreparo({ registro, meuId, onAceitar, onSoltar, onPronto, size = 'md' }) {
  const prep = registro.preparando_por
  const mine = prep && prep === meuId
  const pad = size === 'sm' ? '8px 12px' : '10px 12px'
  const fs = size === 'sm' ? 12.5 : 13
  if (!prep) {
    return (
      <button type="button" onClick={() => onAceitar(registro)}
        style={{ padding: pad, borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: fs,
          border: '1.5px solid #2563eb', background: 'rgba(37,99,235,.12)', color: '#2563eb', width: '100%' }}>
        ✋ Aceitar
      </button>
    )
  }
  if (mine) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#16a34a' }}>👨‍🍳 Você está preparando</div>
        <button type="button" onClick={() => onPronto(registro)}
          style={{ padding: pad, borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: fs,
            border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.12)', color: '#16a34a' }}>
          ✓ Pronto
        </button>
        <button type="button" onClick={() => onSoltar(registro)}
          style={{ padding: '4px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 11.5,
            border: 'none', background: 'none', color: 'var(--text-muted)' }}>
          Soltar
        </button>
      </div>
    )
  }
  return (
    <div style={{ padding: pad, borderRadius: 8, textAlign: 'center', fontWeight: 700, fontSize: fs,
      background: 'rgba(245,158,11,.12)', border: '1.5px solid #f59e0b', color: '#b45309' }}>
      🔒 {registro.preparando_nome || 'Outro'} está preparando
    </div>
  )
}

// Card de um pedido de delivery/iFood na cozinha (KDS).
function CardEntregaKDS({ pedido, meuId, onAceitar, onSoltar, onPronto, tempoDesde }) {
  const ehIfood = pedido.origem === 'ifood'
  const headerCor = ehIfood ? '#ea1d2c' : '#7c3aed'
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const isRetirada = (pedido.tipo_entrega || 'entrega') === 'retirada'
  const numero = pedido.numero_pedido ?? String(pedido.id).slice(-4).toUpperCase()
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ background: headerCor, color: '#fff', padding: '10px 14px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
          {ehIfood ? (
            <>
              <span>iFood #{pedido.ifood_display_id ?? numero}</span>
              <span style={{ fontSize: 11, fontWeight: 600, opacity: .8 }}>#{numero}</span>
            </>
          ) : (
            <span>#{numero}</span>
          )}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,.2)', borderRadius: 20, padding: '2px 8px' }}>
          {isRetirada ? '🥡 Retirada' : '🛵 Entrega'}
        </span>
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {itens.map((item, i) => {
          const { nome, complementos: comps } = separarItem(item)
          return (
            <div key={i}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {item.quantidade ?? item.qtd ?? 1}× {nome}
              </div>
              {comps.map((c, j) => (
                <div key={j} style={{ fontSize: 12.5, color: 'var(--text-muted)', paddingLeft: 14 }}>
                  {Number(c?.qtd) > 1 ? `${c.qtd}× ` : ''}{c?.nome ?? c}
                </div>
              ))}
              {item.observacao && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingLeft: 14, fontStyle: 'italic' }}>obs: {item.observacao}</div>
              )}
            </div>
          )
        })}
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>há {tempoDesde(pedido.created_at)}</div>
        <AcaoPreparo registro={pedido} meuId={meuId} onAceitar={onAceitar} onSoltar={onSoltar} onPronto={onPronto} />
      </div>
    </div>
  )
}

export default function PresencialCozinha() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  const [itens, setItens]     = useState([])
  const [entregas, setEntregas] = useState([]) // pedidos de delivery/iFood em preparo
  const [loading, setLoading] = useState(true)
  const [, setTick]           = useState(0)

  async function load() {
    if (!empresaId) return
    const [mesasRes, entregasRes] = await Promise.all([
      supabase
        .from('comanda_itens')
        .select('*, comandas!inner(numero_mesa, status)')
        .eq('empresa_id', empresaId)
        .eq('status', 'pendente')
        .eq('comandas.status', 'aberta')
        .order('created_at'),
      supabase
        .from('pedidos_delivery')
        .select('*')
        .eq('empresa_id', empresaId)
        .in('status', ['confirmado', 'em_preparo'])
        .order('created_at'),
    ])
    setItens(mesasRes.data ?? [])
    setEntregas(entregasRes.data ?? [])
    setLoading(false)
  }

  const meuId = profile?.id
  const meuNome = profile?.nome || 'Cozinha'

  async function marcarPedidoPronto(pedido) {
    // Otimista + atualiza no banco. O trigger avisa o iFood (readyToPickup) e
    // o pedido segue pro motoboy / retirada.
    setEntregas(prev => prev.filter(p => p.id !== pedido.id))
    await supabase.from('pedidos_delivery').update({ status: 'pronto' }).eq('id', pedido.id)
  }

  // G1 — aceitar trava o pedido na pessoa (só quem aceitou marca Pronto).
  // IMPORTANTE: NÃO muda o status (mantém confirmado) — só vincula quem pegou.
  // Assim NÃO dispara o WhatsApp do cliente (o gatilho avisa em 'em_preparo').
  // É controle 100% interno da loja.
  async function aceitarPedido(pedido) {
    const patch = { preparando_por: meuId, preparando_nome: meuNome, preparando_em: new Date().toISOString() }
    setEntregas(prev => prev.map(p => p.id === pedido.id ? { ...p, ...patch } : p))
    // .is(null) garante que só pega se ninguém pegou antes (evita 2 pegarem juntos)
    await supabase.from('pedidos_delivery').update(patch).eq('id', pedido.id).is('preparando_por', null)
    load()
  }
  async function soltarPedido(pedido) {
    const patch = { preparando_por: null, preparando_nome: null, preparando_em: null }
    setEntregas(prev => prev.map(p => p.id === pedido.id ? { ...p, ...patch } : p))
    await supabase.from('pedidos_delivery').update(patch).eq('id', pedido.id).eq('preparando_por', meuId)
    load()
  }

  useEffect(() => { load() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Atualiza o "tempo de espera" a cada 30s
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  // Realtime
  useEffect(() => {
    if (!empresaId) return
    const ch = supabase.channel(`kds_${empresaId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comanda_itens', filter: `empresa_id=eq.${empresaId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos_delivery', filter: `empresa_id=eq.${empresaId}` }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  async function marcarPronto(item) {
    await supabase.from('comanda_itens').update({ status: 'pronto' }).eq('id', item.id)
    load()
  }
  async function aceitarItem(item) {
    await supabase.from('comanda_itens')
      .update({ preparando_por: meuId, preparando_nome: meuNome, preparando_em: new Date().toISOString() })
      .eq('id', item.id).is('preparando_por', null)
    load()
  }
  async function soltarItem(item) {
    await supabase.from('comanda_itens')
      .update({ preparando_por: null, preparando_nome: null, preparando_em: null })
      .eq('id', item.id).eq('preparando_por', meuId)
    load()
  }

  const porMesa = useMemo(() => {
    const map = {}
    for (const it of itens) {
      const k = it.comandas?.numero_mesa ?? '—'
      ;(map[k] = map[k] || []).push(it)
    }
    return Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]))
  }, [itens])

  if (loading) return <div className="page"><p>Carregando cozinha...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Cozinha (KDS)</h1>
          <p className="page-subtitle">Itens aguardando preparo, ao vivo.</p>
        </div>
      </div>

      {porMesa.length === 0 && entregas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
          🍳 Nenhum item na fila. Tudo em dia!
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {/* Pedidos de delivery / iFood em preparo */}
          {entregas.map(pedido => (
            <CardEntregaKDS key={pedido.id} pedido={pedido} meuId={meuId}
              onAceitar={aceitarPedido} onSoltar={soltarPedido} onPronto={marcarPedidoPronto} tempoDesde={tempoDesde} />
          ))}

          {porMesa.map(([mesa, lista]) => (
            <div key={mesa} style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ background: 'var(--primary)', color: '#fff', padding: '10px 14px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Mesa {mesa}</span>
                <button type="button" title="Imprimir comanda"
                  onClick={() => imprimirHtml(montarComandaCozinhaHtml({ numeroMesa: mesa, itens: lista }))}
                  style={{ background: 'rgba(255,255,255,.2)', border: 'none', color: '#fff', borderRadius: 8, cursor: 'pointer', fontSize: 16, padding: '2px 8px' }}>
                  🖨️
                </button>
              </div>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {lista.map(item => {
                  const { nome, complementos: comps } = separarItem(item)
                  return (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {item.quantidade}× {nome}
                      </div>
                      {comps.map((c, j) => (
                        <div key={j} style={{ fontSize: 12.5, color: 'var(--text-muted)', paddingLeft: 14 }}>
                          {Number(c?.qtd) > 1 ? `${c.qtd}× ` : ''}{c?.nome ?? c}
                        </div>
                      ))}
                      {item.observacao && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{item.observacao}</div>}
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>há {tempoDesde(item.created_at)}</div>
                    </div>
                    <div style={{ minWidth: 130 }}>
                      <AcaoPreparo registro={item} meuId={meuId} size="sm"
                        onAceitar={aceitarItem} onSoltar={soltarItem} onPronto={marcarPronto} />
                    </div>
                  </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
