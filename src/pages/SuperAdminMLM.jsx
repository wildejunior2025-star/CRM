import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

function fmt(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

const STATUS_RESGATE = {
  pendente:  { label: 'Pendente',  cls: 'badge-warning' },
  aprovado:  { label: 'Aprovado',  cls: 'badge-success' },
  rejeitado: { label: 'Rejeitado', cls: 'badge-danger' },
}

export default function SuperAdminMLM() {
  const [comissoes, setComissoes]       = useState([])
  const [resumo, setResumo]             = useState([])
  const [resgates, setResgates]         = useState([])
  const [loading, setLoading]           = useState(true)
  const [loadingResgates, setLoadingResgates] = useState(true)
  const [error, setError]               = useState(null)
  const [marcandoId, setMarcandoId]     = useState(null)
  const [resolvendo, setResolvendo]     = useState(null)
  const [filtroStatus, setFiltroStatus] = useState('todos')
  const [filtroNivel, setFiltroNivel]   = useState('todos')
  const [filtroPeriodo, setFiltroPeriodo] = useState(new Date().toISOString().slice(0, 7))
  const [abaAtiva, setAbaAtiva]         = useState('comissoes')
  const [niveisLabel, setNiveisLabel]   = useState(['', '3,0%', '1,5%', '0,8%', '0,4%', '0,2%'])

  async function load() {
    setLoading(true)
    setError(null)

    const [comRes, cfgRes] = await Promise.all([
      supabase
        .from('comissoes_indicacao')
        .select(`
          *,
          beneficiario:profiles!comissoes_indicacao_beneficiario_id_fkey(nome, ref_token),
          comprador:profiles!comissoes_indicacao_comprador_id_fkey(nome)
        `)
        .order('created_at', { ascending: false }),

      supabase
        .from('configuracoes_plataforma')
        .select('chave, valor')
        .in('chave', ['mlm_pct_nivel_1','mlm_pct_nivel_2','mlm_pct_nivel_3','mlm_pct_nivel_4','mlm_pct_nivel_5']),
    ])

    if (comRes.error) { setError(comRes.error.message); setLoading(false); return }

    if (cfgRes.data) {
      const m = {}
      for (const r of cfgRes.data) m[r.chave] = r.valor
      setNiveisLabel(['',
        `${Number(m.mlm_pct_nivel_1 ?? 3).toFixed(1)}%`,
        `${Number(m.mlm_pct_nivel_2 ?? 1.5).toFixed(1)}%`,
        `${Number(m.mlm_pct_nivel_3 ?? 0.8).toFixed(1)}%`,
        `${Number(m.mlm_pct_nivel_4 ?? 0.4).toFixed(1)}%`,
        `${Number(m.mlm_pct_nivel_5 ?? 0.2).toFixed(1)}%`,
      ])
    }

    const rows = comRes.data ?? []
    setComissoes(rows)

    const map = {}
    for (const c of rows) {
      const key = c.beneficiario_id
      if (!map[key]) map[key] = {
        id: key, nome: c.beneficiario?.nome ?? '—',
        total: 0, totalPts: 0, pendente: 0, pago: 0, count: 0,
      }
      map[key].total    += Number(c.valor_comissao)
      map[key].totalPts += Number(c.pontos ?? 0)
      map[key].count    += 1
      if (c.status === 'pago') map[key].pago     += Number(c.valor_comissao)
      else                     map[key].pendente += Number(c.valor_comissao)
    }
    setResumo(Object.values(map).sort((a, b) => b.total - a.total))
    setLoading(false)
  }

  async function loadResgates() {
    setLoadingResgates(true)
    const { data } = await supabase
      .from('resgates_pontos')
      .select(`*, profile:profiles(nome)`)
      .order('created_at', { ascending: false })
    setResgates(data ?? [])
    setLoadingResgates(false)
  }

  useEffect(() => { load(); loadResgates() }, [])

  async function marcarPago(c) {
    setMarcandoId(c.id)
    const { error: err } = await supabase
      .from('comissoes_indicacao')
      .update({ status: 'pago' })
      .eq('id', c.id)
    setMarcandoId(null)
    if (err) { alert(err.message); return }
    setComissoes(prev => prev.map(r => r.id === c.id ? { ...r, status: 'pago' } : r))
    setResumo(prev => prev.map(r => {
      if (r.id !== c.beneficiario_id) return r
      return { ...r, pendente: r.pendente - Number(c.valor_comissao), pago: r.pago + Number(c.valor_comissao) }
    }))
  }

  async function marcarTodoPago(beneficiarioId) {
    if (!confirm('Marcar todas as comissões pendentes deste indicador como pagas?')) return
    const { error: err } = await supabase
      .from('comissoes_indicacao')
      .update({ status: 'pago' })
      .eq('beneficiario_id', beneficiarioId)
      .eq('status', 'pendente')
    if (err) { alert(err.message); return }
    await load()
  }

  async function resolverResgate(id, status) {
    const obs = status === 'rejeitado' ? prompt('Motivo da rejeição (opcional):') : null
    setResolvendo(id)
    const { error: err } = await supabase.rpc('resolver_resgate', {
      p_resgate_id: id,
      p_status: status,
      p_obs: obs ?? null,
    })
    setResolvendo(null)
    if (err) { alert(err.message); return }
    setResgates(prev => prev.map(r => r.id === id ? { ...r, status, observacao: obs } : r))
  }

  const filtradas = comissoes.filter(c => {
    if (filtroStatus !== 'todos' && c.status !== filtroStatus) return false
    if (filtroNivel !== 'todos' && String(c.nivel) !== filtroNivel) return false
    if (filtroPeriodo && !c.created_at.startsWith(filtroPeriodo)) return false
    return true
  })

  const totalGeral    = comissoes.reduce((s, c) => s + Number(c.valor_comissao), 0)
  const totalPts      = comissoes.reduce((s, c) => s + Number(c.pontos ?? 0), 0)
  const totalPendente = comissoes.filter(c => c.status === 'pendente').reduce((s, c) => s + Number(c.valor_comissao), 0)
  const totalPago     = comissoes.filter(c => c.status === 'pago').reduce((s, c) => s + Number(c.valor_comissao), 0)
  const resgatesPendentes = resgates.filter(r => r.status === 'pendente').length

  const tabStyle = (aba) => ({
    padding: '7px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 14,
    background: abaAtiva === aba ? 'var(--primary)' : 'var(--surface)',
    color: abaAtiva === aba ? '#fff' : 'var(--text)',
    border: `1.5px solid ${abaAtiva === aba ? 'var(--primary)' : 'var(--border)'}`,
  })

  return (
    <div>
      <div className="page-header">
        <h1>Rede de Indicações (MLM)</h1>
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* Cards de totais */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Total gerado</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--primary)' }}>{fmt(totalGeral)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{totalPts} pts totais</div>
        </div>
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Pendente</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--warning)' }}>{fmt(totalPendente)}</div>
        </div>
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Pago</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--success)' }}>{fmt(totalPago)}</div>
        </div>
        <div className="card" style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Indicadores</div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{resumo.length}</div>
        </div>
      </div>

      {/* Abas */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button style={tabStyle('comissoes')} onClick={() => setAbaAtiva('comissoes')}>
          Comissões
        </button>
        <button style={tabStyle('resgates')} onClick={() => setAbaAtiva('resgates')}>
          Resgates {resgatesPendentes > 0 && (
            <span style={{
              marginLeft: 6, background: '#ef4444', color: '#fff',
              borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700,
            }}>{resgatesPendentes}</span>
          )}
        </button>
      </div>

      {abaAtiva === 'comissoes' && (
        <>
          {/* Top indicadores */}
          {resumo.length > 0 && (
            <div className="card" style={{ marginBottom: 24 }}>
              <div style={{ padding: '14px 16px 10px', fontWeight: 700, fontSize: 15, borderBottom: '1px solid var(--border)' }}>
                Top indicadores
              </div>
              <div className="data-table" style={{ marginBottom: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Indicador</th>
                      <th className="caixa-amount-col">Indicações</th>
                      <th className="caixa-amount-col">Pontos</th>
                      <th className="caixa-amount-col">Total R$</th>
                      <th className="caixa-amount-col">Pendente</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resumo.map(r => (
                      <tr key={r.id}>
                        <td style={{ fontWeight: 600 }}>{r.nome}</td>
                        <td className="caixa-amount-col">{r.count}</td>
                        <td className="caixa-amount-col" style={{ fontWeight: 700, color: 'var(--primary)' }}>{r.totalPts} pts</td>
                        <td className="caixa-amount-col" style={{ color: 'var(--primary)', fontWeight: 700 }}>{fmt(r.total)}</td>
                        <td className="caixa-amount-col" style={{ color: r.pendente > 0 ? 'var(--warning)' : 'var(--text-muted)' }}>{fmt(r.pendente)}</td>
                        <td>
                          {r.pendente > 0 && (
                            <button className="btn btn-primary btn-sm" onClick={() => marcarTodoPago(r.id)}>
                              Pagar tudo
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Filtros */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="month"
              value={filtroPeriodo}
              onChange={e => setFiltroPeriodo(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
            />
            <select
              value={filtroNivel}
              onChange={e => setFiltroNivel(e.target.value)}
              style={{ padding: '7px 10px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}
            >
              <option value="todos">Todos os níveis</option>
              {[1,2,3,4,5].map(n => (
                <option key={n} value={n}>Nível {n} ({niveisLabel[n]})</option>
              ))}
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
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setFiltroPeriodo('')}
              style={{ opacity: filtroPeriodo ? 1 : 0.4 }}
            >
              Limpar mês
            </button>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>
              {filtradas.length} registro{filtradas.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Tabela detalhada */}
          <div className="data-table">
            {loading ? (
              <div className="empty-state">Carregando...</div>
            ) : filtradas.length === 0 ? (
              <div className="empty-state">Nenhuma comissão encontrada.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Indicador</th>
                    <th>Comprador</th>
                    <th>Nível</th>
                    <th className="caixa-amount-col">Venda</th>
                    <th className="caixa-amount-col">Pontos</th>
                    <th className="caixa-amount-col">R$</th>
                    <th>Status</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {filtradas.map(c => (
                    <tr key={c.id}>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(c.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                      </td>
                      <td style={{ fontWeight: 600 }}>{c.beneficiario?.nome ?? '—'}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{c.comprador?.nome ?? '—'}</td>
                      <td>
                        <span style={{
                          fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                          background: 'var(--primary-bg)', color: 'var(--primary)',
                        }}>
                          N{c.nivel} · {niveisLabel[c.nivel]}
                        </span>
                      </td>
                      <td className="caixa-amount-col">{fmt(c.valor_venda)}</td>
                      <td className="caixa-amount-col" style={{ fontWeight: 700, color: 'var(--primary)' }}>
                        {Number(c.pontos ?? 0)} pts
                      </td>
                      <td className="caixa-amount-col" style={{ fontWeight: 600 }}>{fmt(c.valor_comissao)}</td>
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
                            {marcandoId === c.id ? '...' : 'Pagar'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {abaAtiva === 'resgates' && (
        <div className="data-table">
          {loadingResgates ? (
            <div className="empty-state">Carregando...</div>
          ) : resgates.length === 0 ? (
            <div className="empty-state">Nenhum resgate solicitado ainda.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Cliente</th>
                  <th className="caixa-amount-col">Pontos</th>
                  <th className="caixa-amount-col">Valor R$</th>
                  <th>Status</th>
                  <th>Obs</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {resgates.map(r => {
                  const st = STATUS_RESGATE[r.status] ?? STATUS_RESGATE.pendente
                  return (
                    <tr key={r.id}>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(r.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                      </td>
                      <td style={{ fontWeight: 600 }}>{r.profile?.nome ?? '—'}</td>
                      <td className="caixa-amount-col" style={{ fontWeight: 700, color: 'var(--primary)' }}>
                        {r.pontos} pts
                      </td>
                      <td className="caixa-amount-col" style={{ fontWeight: 700 }}>{fmt(r.valor_reais)}</td>
                      <td>
                        <span className={`badge ${st.cls}`}>{st.label}</span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 160 }}>
                        {r.observacao ?? '—'}
                      </td>
                      <td>
                        {r.status === 'pendente' && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={resolvendo === r.id}
                              onClick={() => resolverResgate(r.id, 'aprovado')}
                            >
                              {resolvendo === r.id ? '...' : 'Aprovar'}
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              disabled={resolvendo === r.id}
                              onClick={() => resolverResgate(r.id, 'rejeitado')}
                              style={{ color: 'var(--danger)' }}
                            >
                              Rejeitar
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
