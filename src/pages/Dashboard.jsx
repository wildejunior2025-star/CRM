import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

export default function Dashboard() {
  const [stats, setStats] = useState({
    clientesAtivos: 0,
    produtosAtivos: 0,
    estoqueBaixo: 0,
    cascosPendentes: 0,
    vendasHoje: 0,
    totalFiadoAberto: 0,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refToken, setRefToken] = useState(null)
  const [copiado, setCopiado] = useState(false)
  const timerRef = useRef(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)

      // Busca ref_token do admin logado
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('ref_token')
          .eq('id', user.id)
          .single()
        if (profile?.ref_token) setRefToken(profile.ref_token)
      }

      const inicioHoje = new Date()
      inicioHoje.setHours(0, 0, 0, 0)

      const [clientesRes, produtosRes, saldoRes, cascoRes, vendasHojeRes, fiadoRes] =
        await Promise.all([
          supabase
            .from('clientes')
            .select('id', { count: 'exact', head: true })
            .eq('ativo', true),
          supabase
            .from('produtos')
            .select('id', { count: 'exact', head: true })
            .eq('ativo', true),
          supabase.from('estoque_saldo').select('*'),
          supabase.from('casco_saldo').select('*'),
          supabase
            .from('vendas')
            .select('total')
            .neq('status', 'cancelado')
            .gte('created_at', inicioHoje.toISOString()),
          supabase.from('clientes_saldo_fiado').select('saldo_fiado'),
        ])

      const firstError =
        clientesRes.error ||
        produtosRes.error ||
        saldoRes.error ||
        cascoRes.error ||
        vendasHojeRes.error ||
        fiadoRes.error
      if (firstError) setError(firstError.message)

      const estoqueBaixo = (saldoRes.data ?? []).filter(
        (s) => Number(s.quantidade_atual) <= Number(s.estoque_minimo)
      ).length

      const cascosPendentes = (cascoRes.data ?? []).filter(
        (c) => Number(c.saldo_cascos) > 0
      ).length

      const vendasHoje = (vendasHojeRes.data ?? []).reduce(
        (sum, v) => sum + Number(v.total),
        0
      )

      const totalFiadoAberto = (fiadoRes.data ?? []).reduce(
        (sum, f) => sum + Number(f.saldo_fiado),
        0
      )

      setStats({
        clientesAtivos: clientesRes.count ?? 0,
        produtosAtivos: produtosRes.count ?? 0,
        estoqueBaixo,
        cascosPendentes,
        vendasHoje,
        totalFiadoAberto,
      })
      setLoading(false)
    }

    load()
  }, [])

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="dashboard-grid">
        <Link to="/vendas" className="card dashboard-card dashboard-card-link">
          <div className="label">Vendas hoje</div>
          {loading
            ? <span className="value-loading" aria-hidden="true" />
            : <div className="value">{`R$ ${stats.vendasHoje.toFixed(2)}`}</div>
          }
        </Link>
        <Link to="/financeiro" className="card dashboard-card dashboard-card-link">
          <div className="label">Fiado em aberto</div>
          {loading
            ? <span className="value-loading" aria-hidden="true" />
            : <div className="value">{`R$ ${stats.totalFiadoAberto.toFixed(2)}`}</div>
          }
        </Link>
        <Link to="/clientes" className="card dashboard-card dashboard-card-link">
          <div className="label">Clientes ativos</div>
          {loading
            ? <span className="value-loading" aria-hidden="true" />
            : <div className="value">{stats.clientesAtivos}</div>
          }
        </Link>
        <Link to="/produtos" className="card dashboard-card dashboard-card-link">
          <div className="label">Produtos ativos</div>
          {loading
            ? <span className="value-loading" aria-hidden="true" />
            : <div className="value">{stats.produtosAtivos}</div>
          }
        </Link>
        <Link to="/estoque" className="card dashboard-card dashboard-card-link">
          <div className="label">Estoque baixo</div>
          {loading
            ? <span className="value-loading" aria-hidden="true" />
            : <div className="value">{stats.estoqueBaixo}</div>
          }
        </Link>
        <Link to="/estoque" className="card dashboard-card dashboard-card-link">
          <div className="label">Cascos pendentes</div>
          {loading
            ? <span className="value-loading" aria-hidden="true" />
            : <div className="value">{stats.cascosPendentes}</div>
          }
        </Link>
      </div>

      <a
        href="https://github.com/wildejunior2025-star/CRM/releases/download/v1.0.0/Painel.de.Pedidos.Setup.1.0.0.exe"
        download
        className="card"
        style={{
          marginTop: 24, padding: '18px 20px',
          display: 'flex', alignItems: 'center', gap: 16,
          textDecoration: 'none', color: 'var(--text)',
          cursor: 'pointer',
        }}
      >
        <div style={{
          width: 44, height: 44, borderRadius: 10,
          background: 'var(--primary)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="22" height="22" fill="none" viewBox="0 0 24 24">
            <path d="M12 3v13m0 0-4-4m4 4 4-4M4 20h16" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>APP Windows</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Baixar Painel de Pedidos para PC (.exe)
          </div>
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
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
              ðŸ”— Seu link de indicaÃ§Ã£o
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Compartilhe esse link. Quem se cadastrar pela sua indicaÃ§Ã£o entra na sua rede e vocÃª ganha comissÃ£o nas vendas deles.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{
                flex: 1, minWidth: 0,
                background: 'var(--bg)', border: '1.5px solid var(--border)',
                borderRadius: 8, padding: '8px 12px',
                fontSize: 13, color: 'var(--text-muted)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {link}
              </div>
              <button
                onClick={copiar}
                style={{
                  padding: '8px 18px', borderRadius: 8, border: 'none',
                  cursor: 'pointer', fontWeight: 700, fontSize: 13,
                  background: copiado ? '#16a34a' : 'var(--primary)',
                  color: '#fff', whiteSpace: 'nowrap', transition: 'background 200ms',
                }}
              >
                {copiado ? 'âœ“ Copiado!' : 'ðŸ“‹ Copiar link'}
              </button>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
