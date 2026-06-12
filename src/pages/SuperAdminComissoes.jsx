import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

export default function SuperAdminComissoes() {
  const [comissoes, setComissoes] = useState([])
  const [resumo, setResumo] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [marcandoId, setMarcandoId] = useState(null)
  const [filtroEmpresa, setFiltroEmpresa] = useState('todas')
  const [filtroStatus, setFiltroStatus] = useState('todos')

  async function load() {
    setLoading(true)
    setError(null)

    const { data, error } = await supabase
      .from('comissoes')
      .select('*, empresas(nome), vendas(id, created_at)')
      .order('created_at', { ascending: false })

    if (error) { setError(error.message); setLoading(false); return }

    const rows = data ?? []
    setComissoes(rows)

    // Resumo por empresa
    const map = {}
    for (const c of rows) {
      const key = c.empresa_id
      if (!map[key]) {
        map[key] = {
          empresa_id: key,
          nome: c.empresas?.nome ?? '—',
          total_vendas: 0,
          total_comissao: 0,
          total_pendente: 0,
          total_pago: 0,
          pedidos: 0,
        }
      }
      map[key].total_vendas    += Number(c.valor_venda)
      map[key].total_comissao  += Number(c.valor_comissao)
      map[key].pedidos         += 1
      if (c.status === 'pendente') map[key].total_pendente += Number(c.valor_comissao)
      else                         map[key].total_pago    += Number(c.valor_comissao)
    }
    setResumo(Object.values(map).sort((a, b) => b.total_comissao - a.total_comissao))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function marcarPago(comissao) {
    setMarcandoId(comissao.id)
    const { error } = await supabase
      .from('comissoes')
      .update({ status: 'pago' })
      .eq('id', comissao.id)
    setMarcandoId(null)
    if (error) { alert(error.message); return }
    setComissoes(prev => prev.map(c => c.id === comissao.id ? { ...c, status: 'pago' } : c))
    // Atualiza resumo
    setResumo(prev => prev.map(r => {
      if (r.empresa_id !== comissao.empresa_id) return r
      return {
        ...r,
        total_pendente: r.total_pendente - Number(comissao.valor_comissao),
        total_pago:     r.total_pago    + Number(comissao.valor_comissao),
      }
    }))
  }

  const empresasUnicas = [{ id: 'todas', nome: 'Todas as empresas' }, ...resumo.map(r => ({ id: r.empresa_id, nome: r.nome }))]

  const comissoesFiltradas = comissoes.filter(c => {
    if (filtroEmpresa !== 'todas' && c.empresa_id !== filtroEmpresa) return false
    if (filtroStatus !== 'todos' && c.status !== filtroStatus) return false
    return true
  })

  const totalPendente = resumo.reduce((s, r) => s + r.total_pendente, 0)
  const totalPago     = resumo.reduce((s, r) => s + r.total_pago, 0)
  const totalGeral    = totalPendente + totalPago

  function fmt(val) {
    return Number(val).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  return (
    <div>
      <div className="page-header">
        <h1>Comissões da Plataforma</h1>
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* Cards de resumo geral */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Total gerado</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--primary)' }}>{fmt(totalGeral)}</div>
        </div>
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Pendente</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--warning)' }}>{fmt(totalPendente)}</div>
        </div>
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Recebido</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--success)' }}>{fmt(totalPago)}</div>
        </div>
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Pedidos</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{comissoes.length}</div>
        </div>
      </div>

      {/* Resumo por empresa */}
      {resumo.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ padding: '14px 16px 10px', fontWeight: 700, fontSize: 15, borderBottom: '1px solid var(--border)' }}>
            Resumo por empresa
          </div>
          <div className="data-table" style={{ marginBottom: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th className="caixa-amount-col">Vendas</th>
                  <th className="caixa-amount-col">Pedidos</th>
                  <th className="caixa-amount-col">Comissão total</th>
                  <th className="caixa-amount-col">Pendente</th>
                  <th className="caixa-amount-col">Pago</th>
                </tr>
              </thead>
              <tbody>
                {resumo.map(r => (
                  <tr key={r.empresa_id}>
                    <td>{r.nome}</td>
                    <td className="caixa-amount-col">{fmt(r.total_vendas)}</td>
                    <td className="caixa-amount-col">{r.pedidos}</td>
                    <td className="caixa-amount-col" style={{ fontWeight: 700, color: 'var(--primary)' }}>{fmt(r.total_comissao)}</td>
                    <td className="caixa-amount-col" style={{ color: 'var(--warning)' }}>{fmt(r.total_pendente)}</td>
                    <td className="caixa-amount-col" style={{ color: 'var(--success)' }}>{fmt(r.total_pago)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Filtros e lista detalhada */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <select
          value={filtroEmpresa}
          onChange={e => setFiltroEmpresa(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
        >
          {empresasUnicas.map(e => <option key={e.id} value={e.id}>{e.nome}</option>)}
        </select>
        <select
          value={filtroStatus}
          onChange={e => setFiltroStatus(e.target.value)}
          style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
        >
          <option value="todos">Todos os status</option>
          <option value="pendente">Pendente</option>
          <option value="pago">Pago</option>
        </select>
        <span style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
          {comissoesFiltradas.length} registro{comissoesFiltradas.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : comissoesFiltradas.length === 0 ? (
          <div className="empty-state">Nenhuma comissão encontrada.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Empresa</th>
                <th className="caixa-amount-col">Valor da venda</th>
                <th className="caixa-amount-col">Taxa %</th>
                <th className="caixa-amount-col">Comissão</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {comissoesFiltradas.map(c => (
                <tr key={c.id}>
                  <td style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    {new Date(c.created_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td>{c.empresas?.nome ?? '—'}</td>
                  <td className="caixa-amount-col">{fmt(c.valor_venda)}</td>
                  <td className="caixa-amount-col">{Number(c.taxa_percentual).toFixed(1)}%</td>
                  <td className="caixa-amount-col" style={{ fontWeight: 700, color: 'var(--primary)' }}>{fmt(c.valor_comissao)}</td>
                  <td>
                    <span className={`badge ${c.status === 'pago' ? 'badge-success' : 'badge-warning'}`}>
                      {c.status === 'pago' ? 'Pago' : 'Pendente'}
                    </span>
                  </td>
                  <td>
                    {c.status === 'pendente' && (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={marcandoId === c.id}
                        onClick={() => marcarPago(c)}
                      >
                        {marcandoId === c.id ? '...' : 'Marcar pago'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
