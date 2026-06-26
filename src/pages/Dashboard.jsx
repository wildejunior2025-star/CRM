import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const fmt = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
const pad = (n) => String(n).padStart(2, '0')
const normForma = (f) => {
  if (!f) return 'Outros'
  if (f.startsWith('boleto')) return 'Boleto'
  if (f === 'a_vista') return 'À vista'
  if (f === 'fiado') return 'Fiado'
  return f
}

// ── Gráfico de área (faturamento) ──────────────────────────────────────────
function AreaChart({ dias }) {
  const W = 640, H = 170, P = 10
  const vals = dias.map(d => d.value)
  const max = Math.max(1, ...vals)
  const stepX = (W - P * 2) / Math.max(1, dias.length - 1)
  const pts = dias.map((d, i) => [P + i * stepX, H - P - (d.value / max) * (H - P * 2 - 16)])
  const line = pts.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1)).join(' ')
  const area = `${line} L ${pts.at(-1)[0].toFixed(1)} ${H - P} L ${pts[0][0].toFixed(1)} ${H - P} Z`
  const last = pts.at(-1)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="dashArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#dashArea)" />
      <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="4.5" fill="var(--primary)" stroke="#fff" strokeWidth="2" />
    </svg>
  )
}

// ── Barras horizontais ──────────────────────────────────────────────────────
function BarsH({ data, money = true, cor = 'var(--primary)' }) {
  const max = Math.max(1, ...data.map(d => d.value))
  if (data.length === 0) return <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Sem dados ainda.</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {data.map((d, i) => (
        <div key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>{d.label}</span>
            <strong>{money ? fmt(d.value) : d.value}</strong>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(d.value / max) * 100}%`, background: cor, borderRadius: 999, transition: 'width 400ms' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function Delta({ atual, anterior }) {
  if (anterior <= 0) return null
  const pct = Math.round(((atual - anterior) / anterior) * 100)
  const up = pct >= 0
  return (
    <span style={{ fontSize: 12, fontWeight: 700, color: up ? '#16a34a' : '#ef4444', marginLeft: 8 }}>
      {up ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  )
}

export default function Dashboard() {
  const [stats, setStats] = useState({
    clientesAtivos: 0, produtosAtivos: 0, estoqueBaixo: 0,
    cascosPendentes: 0, vendasHoje: 0, totalFiadoAberto: 0,
  })
  const [an, setAn] = useState({ dias: [], hoje: 0, ontem: 0, mes: 0, top: [], formas: [], ultimas: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refToken, setRefToken] = useState(null)
  const [copiado, setCopiado] = useState(false)
  const timerRef = useRef(null)

  useEffect(() => {
    async function load() {
      setLoading(true); setError(null)

      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase.from('profiles').select('ref_token').eq('id', user.id).single()
        if (profile?.ref_token) setRefToken(profile.ref_token)
      }

      const hoje0 = new Date(); hoje0.setHours(0, 0, 0, 0)
      const desde = new Date(hoje0); desde.setDate(desde.getDate() - 31)
      const monthStart = new Date(hoje0.getFullYear(), hoje0.getMonth(), 1)

      const [clientesRes, produtosRes, saldoRes, cascoRes, fiadoRes,
             vendas31Res, topItensRes, prodNomesRes, ultimasRes] = await Promise.all([
        supabase.from('clientes').select('id', { count: 'exact', head: true }).eq('ativo', true),
        supabase.from('produtos').select('id', { count: 'exact', head: true }).eq('ativo', true),
        supabase.from('estoque_saldo').select('*'),
        supabase.from('casco_saldo').select('*'),
        supabase.from('clientes_saldo_fiado').select('saldo_fiado'),
        supabase.from('vendas').select('total, created_at, forma_pagamento').neq('status', 'cancelado').gte('created_at', desde.toISOString()),
        supabase.from('venda_itens').select('produto_id, quantidade, subtotal, vendas!inner(created_at, status)').neq('vendas.status', 'cancelado').gte('vendas.created_at', monthStart.toISOString()).limit(5000),
        supabase.from('produtos').select('id, nome'),
        supabase.from('vendas').select('id, total, forma_pagamento, created_at, clientes(nome)').neq('status', 'cancelado').order('created_at', { ascending: false }).limit(8),
      ])

      if (clientesRes.error || produtosRes.error || vendas31Res.error) {
        setError((clientesRes.error || produtosRes.error || vendas31Res.error).message)
      }

      const estoqueBaixo = (saldoRes.data ?? []).filter(s => Number(s.quantidade_atual) <= Number(s.estoque_minimo)).length
      const cascosPendentes = (cascoRes.data ?? []).filter(c => Number(c.saldo_cascos) > 0).length
      const totalFiadoAberto = (fiadoRes.data ?? []).reduce((s, f) => s + Number(f.saldo_fiado), 0)

      // série de 14 dias
      const dias = []; const idx = {}
      for (let i = 13; i >= 0; i--) {
        const dd = new Date(hoje0); dd.setDate(dd.getDate() - i)
        idx[dd.toDateString()] = dias.length
        dias.push({ label: `${pad(dd.getDate())}/${pad(dd.getMonth() + 1)}`, value: 0 })
      }
      let mes = 0; const formaMap = {}
      for (const v of (vendas31Res.data ?? [])) {
        const dt = new Date(v.created_at)
        const key = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).toDateString()
        if (idx[key] != null) dias[idx[key]].value += Number(v.total)
        if (dt >= monthStart) {
          mes += Number(v.total)
          const f = normForma(v.forma_pagamento)
          formaMap[f] = (formaMap[f] || 0) + Number(v.total)
        }
      }
      const hoje = dias[13].value, ontem = dias[12].value

      // top produtos do mês
      const nomes = Object.fromEntries((prodNomesRes.data ?? []).map(p => [p.id, p.nome]))
      const agg = {}
      for (const it of (topItensRes.data ?? [])) {
        const k = it.produto_id
        if (!agg[k]) agg[k] = { label: nomes[k] ?? 'Produto', value: 0 }
        agg[k].value += Number(it.subtotal)
      }
      const top = Object.values(agg).sort((a, b) => b.value - a.value).slice(0, 5)
      const formas = Object.entries(formaMap).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)

      setStats({
        clientesAtivos: clientesRes.count ?? 0, produtosAtivos: produtosRes.count ?? 0,
        estoqueBaixo, cascosPendentes, vendasHoje: hoje, totalFiadoAberto,
      })
      setAn({ dias, hoje, ontem, mes, top, formas, ultimas: ultimasRes.data ?? [] })
      setLoading(false)
    }
    load()
  }, [])

  const total14 = an.dias.reduce((s, d) => s + d.value, 0)
  const cardBox = { background: 'var(--card-bg, var(--bg))', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }

  return (
    <div>
      <div className="page-header"><h1>Dashboard</h1></div>
      {error && <p className="error-text">{error}</p>}

      <div className="dashboard-grid">
        <Link to="/vendas" className="card dashboard-card dashboard-card-link">
          <div className="label">Vendas hoje</div>
          {loading ? <span className="value-loading" aria-hidden="true" />
            : <div className="value">{fmt(stats.vendasHoje)}<Delta atual={an.hoje} anterior={an.ontem} /></div>}
        </Link>
        <Link to="/financeiro" className="card dashboard-card dashboard-card-link">
          <div className="label">Faturamento do mês</div>
          {loading ? <span className="value-loading" aria-hidden="true" /> : <div className="value">{fmt(an.mes)}</div>}
        </Link>
        <Link to="/financeiro" className="card dashboard-card dashboard-card-link">
          <div className="label">Fiado em aberto</div>
          {loading ? <span className="value-loading" aria-hidden="true" /> : <div className="value">{fmt(stats.totalFiadoAberto)}</div>}
        </Link>
        <Link to="/clientes" className="card dashboard-card dashboard-card-link">
          <div className="label">Clientes ativos</div>
          {loading ? <span className="value-loading" aria-hidden="true" /> : <div className="value">{stats.clientesAtivos}</div>}
        </Link>
        <Link to="/estoque" className="card dashboard-card dashboard-card-link">
          <div className="label">Estoque baixo</div>
          {loading ? <span className="value-loading" aria-hidden="true" /> : <div className="value">{stats.estoqueBaixo}</div>}
        </Link>
        <Link to="/estoque" className="card dashboard-card dashboard-card-link">
          <div className="label">Cascos pendentes</div>
          {loading ? <span className="value-loading" aria-hidden="true" /> : <div className="value">{stats.cascosPendentes}</div>}
        </Link>
      </div>

      {/* ── Gráficos ── */}
      {!loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
          {/* Faturamento 14 dias */}
          <div style={cardBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
              <strong style={{ fontSize: 15 }}>📈 Faturamento — últimos 14 dias</strong>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Total: <strong style={{ color: 'var(--text)' }}>{fmt(total14)}</strong></span>
            </div>
            <AreaChart dias={an.dias} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              {an.dias.filter((_, i) => i % 3 === 0 || i === an.dias.length - 1).map((d, i) => <span key={i}>{d.label}</span>)}
            </div>
          </div>

          {/* Top produtos + Vendas por tipo */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <div style={cardBox}>
              <strong style={{ fontSize: 15, display: 'block', marginBottom: 14 }}>🏆 Top produtos do mês</strong>
              <BarsH data={an.top} />
            </div>
            <div style={cardBox}>
              <strong style={{ fontSize: 15, display: 'block', marginBottom: 14 }}>💳 Vendas por tipo (mês)</strong>
              <BarsH data={an.formas} cor="#22c55e" />
            </div>
          </div>

          {/* Últimas vendas */}
          <div style={cardBox}>
            <strong style={{ fontSize: 15, display: 'block', marginBottom: 12 }}>🧾 Últimas vendas</strong>
            {an.ultimas.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhuma venda ainda.</p>
            ) : an.ultimas.map(v => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{v.clientes?.nome ?? 'Consumidor'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {new Date(v.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {normForma(v.forma_pagamento)}
                  </div>
                </div>
                <strong style={{ fontSize: 14 }}>{fmt(v.total)}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      <a
        href="https://github.com/wildejunior2025-star/CRM/releases/download/v1.0.0/Painel.de.Pedidos.Setup.1.0.0.exe"
        download className="card"
        style={{ marginTop: 24, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 16, textDecoration: 'none', color: 'var(--text)', cursor: 'pointer' }}
      >
        <div style={{ width: 44, height: 44, borderRadius: 10, background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="22" height="22" fill="none" viewBox="0 0 24 24">
            <path d="M12 3v13m0 0-4-4m4 4 4-4M4 20h16" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>APP Windows</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Baixar Painel de Pedidos para PC (.exe)</div>
        </div>
      </a>

      {refToken && (() => {
        const link = `${window.location.origin}/entrar?ref=${refToken}`
        function copiar() {
          navigator.clipboard.writeText(link)
          setCopiado(true)
          clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setCopiado(false), 2500)
        }
        return (
          <div className="card" style={{ marginTop: 24, padding: '18px 20px' }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Seu link de indicação</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Compartilhe esse link. Quem se cadastrar pela sua indicação entra na sua rede e você ganha comissão nas vendas deles.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {link}
              </div>
              <button onClick={copiar} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13, background: copiado ? '#16a34a' : 'var(--primary)', color: '#fff', whiteSpace: 'nowrap', transition: 'background 200ms' }}>
                {copiado ? '✔ Copiado!' : 'Copiar link'}
              </button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
