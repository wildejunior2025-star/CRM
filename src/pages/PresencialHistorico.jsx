import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
const FORMA_LABEL = { dinheiro: 'Dinheiro', pix: 'PIX', cartao: 'Cartão' }

function horaBR(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function PresencialHistorico() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [comandas, setComandas] = useState([])
  const [garcons, setGarcons]   = useState({})  // { profile_id: nome }
  const [loading, setLoading]   = useState(true)
  const [aberta, setAberta]     = useState(null) // id da comanda expandida

  useEffect(() => {
    if (!empresaId) return
    Promise.all([
      supabase.from('comandas')
        .select('*, comanda_itens(*)')
        .eq('empresa_id', empresaId)
        .eq('status', 'fechada')
        .order('fechada_at', { ascending: false })
        .limit(100),
      supabase.from('profiles').select('id, nome').eq('empresa_id', empresaId),
    ]).then(([cs, gs]) => {
      setComandas(cs.data ?? [])
      setGarcons(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.nome])))
      setLoading(false)
    })
  }, [empresaId])

  // Resumo de hoje
  const resumoHoje = useMemo(() => {
    const hoje = new Date().toDateString()
    const doDia = comandas.filter(c => c.fechada_at && new Date(c.fechada_at).toDateString() === hoje)
    return {
      qtd: doDia.length,
      total: doDia.reduce((s, c) => s + Number(c.total || 0), 0),
    }
  }, [comandas])

  if (loading) return <div className="page"><p>Carregando...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Histórico de contas</h1>
          <p className="page-subtitle">Contas fechadas do salão.</p>
        </div>
      </div>

      {/* Resumo de hoje */}
      <div className="card" style={{ marginBottom: 18, display: 'flex', gap: 28, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Contas fechadas hoje</div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{resumoHoje.qtd}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Recebido hoje</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--success)' }}>{fmt(resumoHoje.total)}</div>
        </div>
      </div>

      {comandas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          Nenhuma conta fechada ainda. Feche uma conta no Salão que ela aparece aqui. 🧾
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {comandas.map(c => {
            const expandida = aberta === c.id
            return (
              <div key={c.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <button type="button" onClick={() => setAberta(expandida ? null : c.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {c.numero_mesa ? `Mesa ${c.numero_mesa}` : 'Balcão'}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {horaBR(c.fechada_at)} · {FORMA_LABEL[c.forma_pagamento] ?? c.forma_pagamento ?? '—'}
                      {' · '}{(c.comanda_itens ?? []).length} {(c.comanda_itens ?? []).length === 1 ? 'item' : 'itens'}
                    </div>
                    {c.garcom_id && garcons[c.garcom_id] && (
                      <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600 }}>
                        👤 {garcons[c.garcom_id]}
                      </div>
                    )}
                  </div>
                  <strong style={{ fontSize: 16 }}>{fmt(c.total)}</strong>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandida ? '▲' : '▼'}</span>
                </button>

                {expandida && (
                  <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--border)' }}>
                    {(c.comanda_itens ?? []).map(it => (
                      <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                        <div>
                          <div style={{ fontSize: 13.5 }}>{it.quantidade}× {it.nome}</div>
                          {it.observacao && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>📝 {it.observacao}</div>}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(it.preco_unitario * it.quantidade)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, paddingTop: 8, color: 'var(--text-muted)' }}>
                      <span>Subtotal</span><span>{fmt(c.subtotal)}</span>
                    </div>
                    {Number(c.taxa_servico) > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)' }}>
                        <span>Taxa de serviço</span><span>{fmt(c.taxa_servico)}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, paddingTop: 6 }}>
                      <span>Total</span><span>{fmt(c.total)}</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
