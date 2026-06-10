import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

export default function Dashboard() {
  const [stats, setStats] = useState({
    clientesAtivos: 0,
    produtosAtivos: 0,
    estoqueBaixo: 0,
    cascosPendentes: 0,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)

      const [clientesRes, produtosRes, saldoRes, cascoRes] = await Promise.all([
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
      ])

      const firstError =
        clientesRes.error || produtosRes.error || saldoRes.error || cascoRes.error
      if (firstError) setError(firstError.message)

      const estoqueBaixo = (saldoRes.data ?? []).filter(
        (s) => Number(s.quantidade_atual) <= Number(s.estoque_minimo)
      ).length

      const cascosPendentes = (cascoRes.data ?? []).filter(
        (c) => Number(c.saldo_cascos) > 0
      ).length

      setStats({
        clientesAtivos: clientesRes.count ?? 0,
        produtosAtivos: produtosRes.count ?? 0,
        estoqueBaixo,
        cascosPendentes,
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
        <div className="card dashboard-card">
          <div className="label">Clientes ativos</div>
          <div className="value">{loading ? '-' : stats.clientesAtivos}</div>
        </div>
        <div className="card dashboard-card">
          <div className="label">Produtos ativos</div>
          <div className="value">{loading ? '-' : stats.produtosAtivos}</div>
        </div>
        <div className="card dashboard-card">
          <div className="label">Itens com estoque baixo</div>
          <div className="value">{loading ? '-' : stats.estoqueBaixo}</div>
        </div>
        <div className="card dashboard-card">
          <div className="label">Clientes com cascos pendentes</div>
          <div className="value">{loading ? '-' : stats.cascosPendentes}</div>
        </div>
      </div>
    </div>
  )
}
