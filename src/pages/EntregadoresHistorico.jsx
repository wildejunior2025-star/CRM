import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// Filtro de período por data (created_at). 'tudo' | 'hoje' | '7d' | '30d'
function dentroDoPeriodo(iso, periodo) {
  if (periodo === 'tudo' || !iso) return true
  const d = new Date(iso).getTime()
  if (periodo === 'hoje') { const s = new Date(); s.setHours(0, 0, 0, 0); return d >= s.getTime() }
  if (periodo === '7d') return d >= Date.now() - 7 * 86400000
  if (periodo === '30d') return d >= Date.now() - 30 * 86400000
  return true
}
const PERIODOS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['tudo', 'Tudo']]

export default function EntregadoresHistorico() {
  const { empresa } = useAuth()
  const [entregadores, setEntregadores] = useState([])
  const [concluidas, setConcluidas] = useState([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState(null)      // entregador selecionado
  const [periodo, setPeriodo] = useState('tudo')

  const carregar = useCallback(async () => {
    if (!empresa) return
    setLoading(true)
    const [entRes, conRes] = await Promise.all([
      supabase.from('profiles')
        .select('id, nome, entregador_desconto_ativo, entregador_desconto_valor')
        .eq('empresa_id', empresa.id).eq('perfil', 'entregador').eq('ativo', true).order('nome'),
      supabase.from('pedidos_delivery')
        .select('id, numero_pedido, cliente_nome, total, taxa_entrega, forma_pagamento, pix_status, mp_payment_status, created_at, entregador_id, origem, entregador_pago, entregador_pago_em')
        .eq('empresa_id', empresa.id).eq('status', 'entregue').not('entregador_id', 'is', null)
        .order('created_at', { ascending: false }).limit(2000),
    ])
    setEntregadores(entRes.data || [])
    setConcluidas(conRes.data || [])
    setLoading(false)
  }, [empresa])

  useEffect(() => { carregar() }, [carregar])

  async function pagarCorridas(ids) {
    if (!ids?.length) return
    const agora = new Date().toISOString()
    setConcluidas(prev => prev.map(p => (ids.includes(p.id) ? { ...p, entregador_pago: true, entregador_pago_em: agora } : p)))
    await supabase.from('pedidos_delivery').update({ entregador_pago: true, entregador_pago_em: agora }).in('id', ids)
  }

  const doEntregador = (id) => concluidas.filter(p => p.entregador_id === id)

  if (loading) return <div><div className="page-header"><h1>Entregadores</h1></div><div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '70%' }} /></div></div>

  // ── Detalhe de um entregador ──
  if (sel) {
    const ent = entregadores.find(e => e.id === sel)
    const descValor = (ent?.entregador_desconto_ativo && Number(ent?.entregador_desconto_valor) > 0) ? Number(ent.entregador_desconto_valor) : 0
    const ganho = p => Math.max(0, Number(p.taxa_entrega || 0) - (p.origem === 'ifood' ? descValor : 0))
    const somaTaxa = arr => arr.reduce((s, p) => s + ganho(p), 0)
    const concl = doEntregador(sel).filter(p => dentroDoPeriodo(p.created_at, periodo))
    const pendentes = concl.filter(p => !p.entregador_pago)
    const pagos = concl.filter(p => p.entregador_pago)
    const dataDe = p => new Date(p.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    const agrupaPorData = arr => { const g = {}; for (const p of arr) (g[dataDe(p)] ??= []).push(p); return Object.entries(g) }
    const pagCliente = p => {
      const f = p.forma_pagamento, ehIfood = p.origem === 'ifood'
      if (f === 'dinheiro') return { pago: false, label: 'Dinheiro' + (ehIfood ? ' (via iFood)' : '') }
      if (['cartao', 'cartão', 'credito', 'debito'].includes(f)) { const n = f === 'debito' ? 'Débito' : f === 'credito' ? 'Crédito' : 'Cartão'; return { pago: false, label: n + (ehIfood ? ' (via iFood)' : ' (maquininha)') } }
      if (f === 'pix') return (p.pix_status === 'pago' || p.mp_payment_status === 'approved') ? { pago: true, label: 'PIX pago' } : { pago: false, label: 'PIX não confirmado' }
      if (ehIfood && f !== 'online') return { pago: false, label: (f || 'via iFood') + ' (via iFood)' }
      return { pago: true, label: ehIfood ? 'Pago no iFood' : (f || 'Pago') }
    }
    const OrderRow = (p, pago) => {
      const pgc = pagCliente(p)
      return (
        <div key={p.id} className="card" style={{ padding: '9px 11px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>#{p.numero_pedido ?? p.id.slice(-4).toUpperCase()}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 13, color: pago ? '#16a34a' : '#f59e0b' }}>{fmt(ganho(p))}</strong>
              {pago
                ? <span style={{ fontSize: 11, fontWeight: 800, color: '#16a34a', background: 'rgba(34,197,94,.14)', padding: '2px 8px', borderRadius: 20 }}>✓ Pago</span>
                : <button type="button" className="btn btn-sm" style={{ fontSize: 11, fontWeight: 800, color: '#16a34a', background: 'rgba(34,197,94,.12)', border: '1px solid #22c55e' }} onClick={() => pagarCorridas([p.id])}>Pagar</button>}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
            {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {p.cliente_nome || '—'}
            {p.origem === 'ifood' && descValor > 0 && <span style={{ color: '#f59e0b' }}> · iFood −{fmt(descValor)}</span>}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 8, color: pgc.pago ? '#16a34a' : '#f59e0b' }}>
            <span>{pgc.pago ? '✓ Pago' : '💵 Cobrar na entrega'} · {pgc.label}</span>
            <span>{fmt(p.total)}</span>
          </div>
        </div>
      )
    }
    return (
      <div>
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginBottom: 12 }} onClick={() => setSel(null)}>← Todos os entregadores</button>
        <div className="page-header"><h1>{ent?.nome || 'Entregador'}</h1></div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {PERIODOS.map(([val, lab]) => (
            <button key={val} type="button" className={`btn btn-sm ${periodo === val ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPeriodo(val)}>{lab}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {[['A receber', fmt(somaTaxa(pendentes)), '#f59e0b'], ['Pago', fmt(somaTaxa(pagos)), '#16a34a'], ['Corridas', concl.length, '#7c3aed']].map(([lab, val, cor]) => (
            <div key={lab} className="card" style={{ flex: 1, textAlign: 'center', padding: '10px 4px' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: cor }}>{val}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{lab}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 14, fontWeight: 800, color: '#f59e0b', margin: '8px 0 6px' }}>A pagar · {fmt(somaTaxa(pendentes))}</div>
        {pendentes.length === 0
          ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Tudo acertado. 🎉</div>
          : agrupaPorData(pendentes).map(([data, ps]) => (
            <div key={data} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>{data} · {ps.length} corrida{ps.length > 1 ? 's' : ''} · {fmt(somaTaxa(ps))}</span>
                <button type="button" className="btn btn-sm" style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: '#16a34a', border: 'none' }} onClick={() => pagarCorridas(ps.map(p => p.id))}>Pagar todas</button>
              </div>
              {ps.map(p => OrderRow(p, false))}
            </div>
          ))}

        <div style={{ fontSize: 14, fontWeight: 800, color: '#16a34a', margin: '14px 0 6px' }}>Pagas · {fmt(somaTaxa(pagos))}</div>
        {pagos.length === 0
          ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nenhuma corrida paga no período.</div>
          : agrupaPorData(pagos).map(([data, ps]) => (
            <div key={data} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>{data} · {ps.length} corrida{ps.length > 1 ? 's' : ''} · {fmt(somaTaxa(ps))}</div>
              {ps.map(p => OrderRow(p, true))}
            </div>
          ))}
      </div>
    )
  }

  // ── Lista de entregadores (com total geral de corridas concluídas) ──
  return (
    <div>
      <div className="page-header"><h1>Entregadores</h1></div>
      <p style={{ color: 'var(--text-muted)', marginTop: -6, maxWidth: 680 }}>
        Histórico completo por entregador (todos os períodos) e acerto das corridas. No gestor fica só o resumo do dia.
      </p>
      {entregadores.length === 0 ? (
        <div className="empty-state"><div className="empty-state-icon" style={{ fontSize: 22 }}>🛵</div><strong>Nenhum entregador</strong><p>Cadastre em Funcionários (perfil Entregador).</p></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {entregadores.map(e => {
            const arr = doEntregador(e.id)
            const aReceber = arr.filter(p => !p.entregador_pago).length
            return (
              <button key={e.id} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer', padding: '12px 14px' }} onClick={() => { setPeriodo('tudo'); setSel(e.id) }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>🛵 {e.nome || 'Entregador'}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 8, background: 'rgba(34,197,94,.14)', color: '#16a34a', fontWeight: 700 }}>Concl. {arr.length}</span>
                  <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 8, background: 'rgba(245,158,11,.15)', color: '#f59e0b', fontWeight: 700 }}>A pagar {aReceber}</span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
