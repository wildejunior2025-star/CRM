import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const STATUS_LABELS = {
  trial: 'Trial',
  ativo: 'Ativo',
  atrasado: 'Atrasado',
  suspenso: 'Suspenso',
  cancelado: 'Cancelado',
}

const STATUS_BADGES = {
  trial: 'badge-primary',
  ativo: 'badge-success',
  atrasado: 'badge-warning',
  suspenso: 'badge-danger',
  cancelado: 'badge-neutral',
}

function fmt(val) {
  return Number(val).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// Medidor de capacidade — limite/alerta de cada gargalo conhecido.
// Ajuste os números conforme for aumentando a infraestrutura (Railway, IA, Supabase).
const CAP_METRICAS = [
  { key: 'bot_conversas_ativas', label: 'Conversas no bot', sub: 'atendimentos nos últimos 10 min', limite: 50,   alerta: 35,   unidade: '',     limiteLabel: '50' },
  { key: 'ia_por_minuto',        label: 'IA por minuto',    sub: 'respostas do bot no último minuto', limite: 50, alerta: 35,   unidade: '',     limiteLabel: '50/min' },
  { key: 'lojas_bot_ativo',      label: 'Lojas com bot',    sub: 'lojas ativas com crédito',          limite: 15, alerta: 10,   unidade: '',     limiteLabel: '15' },
  { key: 'banco_mb',             label: 'Banco de dados',   sub: 'espaço usado (8 GB inclusos)',      limite: 8192, alerta: 6000, unidade: ' MB', limiteLabel: '8 GB' },
]

export default function SuperAdminDashboard() {
  const [empresas, setEmpresas] = useState([])
  const [pedidosMes, setPedidosMes] = useState([])
  const [comissaoCfg, setComissaoCfg] = useState({})
  const [loading, setLoading] = useState(true)
  const [refToken, setRefToken] = useState(null)
  const [copiado, setCopiado] = useState(false)
  const [cap, setCap] = useState(null)
  const timerRef = useRef(null)
  const navigate = useNavigate()

  // ── Medidor de capacidade — atualiza a cada 30s ──
  useEffect(() => {
    let vivo = true
    async function carregarCap() {
      const { data, error } = await supabase.rpc('capacidade_sistema')
      if (vivo && !error) setCap(data)
    }
    carregarCap()
    const id = setInterval(carregarCap, 30_000)
    return () => { vivo = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    const inicioMes = new Date()
    inicioMes.setDate(1)
    inicioMes.setHours(0, 0, 0, 0)

    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) supabase.from('profiles').select('ref_token').eq('id', user.id).single()
        .then(({ data }) => { if (data?.ref_token) setRefToken(data.ref_token) })
    })

    Promise.all([
      supabase.from('empresas').select('*').order('created_at'),
      supabase
        .from('pedidos_delivery')
        .select('origem, total, status')
        .gte('created_at', inicioMes.toISOString())
        .neq('status', 'cancelado'),
      supabase
        .from('configuracoes_plataforma')
        .select('chave, valor')
        .in('chave', ['comissao_vendas_pct', 'comissao_vendas_ativo']),
    ]).then(([{ data: emp }, { data: ped }, { data: cfg }]) => {
      setEmpresas(emp ?? [])
      setPedidosMes(ped ?? [])
      const cfgMap = {}
      for (const c of cfg ?? []) cfgMap[c.chave] = c.valor
      setComissaoCfg(cfgMap)
      setLoading(false)
    })
  }, [])

  if (loading) return <div className="page-loading">Carregando...</div>

  const hoje = new Date()
  const hojeStr = hoje.toISOString().slice(0, 10)
  const em7dias = new Date(hoje.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const ativas    = empresas.filter(e => e.status === 'ativo')
  const trial     = empresas.filter(e => e.status === 'trial')
  const atrasadas = empresas.filter(e => e.status === 'atrasado')
  const suspensas = empresas.filter(e => e.status === 'suspenso')

  const mrr = ativas.reduce((s, e) => s + Number(e.valor_mensalidade ?? 0), 0)

  const comissaoPct   = Number(comissaoCfg.comissao_vendas_pct ?? 0)
  const comissaoAtiva = comissaoCfg.comissao_vendas_ativo !== 'false'

  const gmvMes     = pedidosMes.reduce((s, p) => s + Number(p.total ?? 0), 0)
  const pedidosWA  = pedidosMes.filter(p => p.origem === 'whatsapp')
  const pedidosApp = pedidosMes.filter(p => p.origem === 'app')
  const pedidosCar = pedidosMes.filter(p => !p.origem || p.origem === 'cardapio')
  const gmvWA      = pedidosWA.reduce((s, p) => s + Number(p.total ?? 0), 0)
  const gmvApp     = pedidosApp.reduce((s, p) => s + Number(p.total ?? 0), 0)
  const gmvCar     = pedidosCar.reduce((s, p) => s + Number(p.total ?? 0), 0)
  const comissaoMes = comissaoAtiva ? gmvApp * comissaoPct / 100 : 0

  const vencendoEm7 = empresas.filter(
    e => e.status === 'ativo' && e.vencimento && e.vencimento >= hojeStr && e.vencimento <= em7dias
  )

  const semCreditoWA = empresas.filter(
    e => ['ativo', 'trial'].includes(e.status) && (e.whatsapp_creditos ?? 0) === 0
  )

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
      </div>

      {/* Alerta WA zerado */}
      {semCreditoWA.length > 0 && (
        <div style={{
          marginBottom: 20,
          padding: '12px 16px',
          borderRadius: 10,
          background: 'rgba(239,68,68,.1)',
          border: '1px solid rgba(239,68,68,.35)',
          color: 'var(--danger)',
          fontSize: 14,
          lineHeight: 1.5,
        }}>
          <strong>⚠️ {semCreditoWA.length} loja{semCreditoWA.length !== 1 ? 's' : ''} com créditos WhatsApp zerados</strong>
          <br />
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            {semCreditoWA.map(e => e.nome).join(' · ')}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => navigate('/super-admin/empresas')}
            style={{ marginLeft: 12, verticalAlign: 'middle' }}
          >
            Gerenciar →
          </button>
        </div>
      )}

      {/* Cards principais */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="card" style={{ padding: '18px 22px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>MRR</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--primary)' }}>{fmt(mrr)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>receita mensal recorrente</div>
        </div>
        <div className="card" style={{ padding: '18px 22px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Ativas</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--success)' }}>{ativas.length}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>lojas pagantes</div>
        </div>
        <div className="card" style={{ padding: '18px 22px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Trial</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--primary)' }}>{trial.length}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>em período de teste</div>
        </div>
        <div className="card" style={{ padding: '18px 22px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Atrasadas</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--warning)' }}>{atrasadas.length}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>pagamento pendente</div>
        </div>
        <div className="card" style={{ padding: '18px 22px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Suspensas</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--danger)' }}>{suspensas.length}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>acesso bloqueado</div>
        </div>
        <div
          className="card"
          style={{ padding: '18px 22px', cursor: 'pointer', transition: 'box-shadow 150ms' }}
          onClick={() => navigate('/super-admin/empresas')}
          onMouseEnter={e => e.currentTarget.style.boxShadow = 'var(--shadow-md)'}
          onMouseLeave={e => e.currentTarget.style.boxShadow = ''}
        >
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Total</div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{empresas.length}</div>
          <div style={{ fontSize: 11, color: 'var(--primary)', marginTop: 2 }}>ver todas →</div>
        </div>
      </div>

      {/* Card vendas App */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="card" style={{ padding: '18px 22px' }}>
          <div style={{ fontSize: 11, color: '#f97316', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Vendas App / Portal</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{fmt(gmvApp)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{pedidosApp.length} pedidos este mês</div>
          {comissaoAtiva && comissaoPct > 0 && (
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--success)', marginTop: 6 }}>
              +{fmt(comissaoMes)} comissão ({comissaoPct}%)
            </div>
          )}
        </div>
      </div>

      {/* Medidor de capacidade do sistema */}
      {cap && (
        <div className="card" style={{ marginBottom: 24, padding: '18px 22px' }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>📊 Capacidade do sistema</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
            Uso atual × limite de cada parte. <span style={{ color: '#d97706', fontWeight: 700 }}>Amarelo</span> = comece a planejar o aumento; <span style={{ color: '#dc2626', fontWeight: 700 }}>vermelho</span> = no teto. Atualiza sozinho a cada 30s.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 14 }}>
            {CAP_METRICAS.map(m => {
              const val = Number(cap[m.key] ?? 0)
              const pct = Math.min(100, Math.round((val / m.limite) * 100))
              const cor   = val >= m.limite ? '#dc2626' : val >= m.alerta ? '#d97706' : '#16a34a'
              const fundo = val >= m.limite ? 'rgba(220,38,38,.10)' : val >= m.alerta ? 'rgba(217,119,6,.10)' : 'rgba(22,163,74,.08)'
              return (
                <div key={m.key} style={{ background: fundo, borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7, gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{m.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: cor, whiteSpace: 'nowrap' }}>
                      {val}{m.unidade}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}> / {m.limiteLabel}</span>
                    </span>
                  </div>
                  <div style={{ height: 8, borderRadius: 6, background: 'rgba(120,120,120,.18)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: cor, borderRadius: 6, transition: 'width 400ms ease' }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{m.sub}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Alerta vencendo em 7 dias */}
      {vencendoEm7.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{
            padding: '12px 16px 10px',
            fontWeight: 700,
            fontSize: 14,
            color: 'var(--warning)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            ⏳ Vencendo nos próximos 7 dias ({vencendoEm7.length})
          </div>
          <div className="data-table" style={{ marginBottom: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Empresa</th>
                  <th>Vencimento</th>
                  <th className="caixa-amount-col">Mensalidade</th>
                  <th>Telefone</th>
                </tr>
              </thead>
              <tbody>
                {vencendoEm7.map(e => {
                  const dias = Math.round((new Date(e.vencimento) - hoje) / (1000 * 60 * 60 * 24))
                  return (
                    <tr key={e.id}>
                      <td style={{ fontWeight: 600 }}>{e.nome}</td>
                      <td>
                        <span style={{ color: dias <= 3 ? 'var(--danger)' : 'var(--warning)', fontWeight: 700 }}>
                          {e.vencimento}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>
                          ({dias <= 0 ? 'hoje' : `em ${dias} dia${dias !== 1 ? 's' : ''}`})
                        </span>
                      </td>
                      <td className="caixa-amount-col">{fmt(e.valor_mensalidade ?? 0)}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{e.telefone_contato || '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Link de indicação */}
      {refToken && (() => {
        const link = `${window.location.origin}/entrar?ref=${refToken}`
        function copiar() {
          navigator.clipboard.writeText(link)
          setCopiado(true)
          clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setCopiado(false), 2500)
        }
        return (
          <div className="card" style={{ marginBottom: 24, padding: '18px 20px' }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>🔗 Seu link de indicação</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Quem se cadastrar pelo seu link entra na sua rede MLM e você ganha comissão nas compras deles.
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
              <button onClick={copiar} style={{
                padding: '8px 18px', borderRadius: 8, border: 'none',
                cursor: 'pointer', fontWeight: 700, fontSize: 13,
                background: copiado ? '#16a34a' : 'var(--primary)',
                color: '#fff', whiteSpace: 'nowrap', transition: 'background 200ms',
              }}>
                {copiado ? '✓ Copiado!' : '📋 Copiar link'}
              </button>
            </div>
          </div>
        )
      })()}

      {/* Visão geral das empresas */}
      <div className="card">
        <div style={{
          padding: '12px 16px 10px',
          fontWeight: 700,
          fontSize: 14,
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          Todas as empresas
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/super-admin/empresas')}>
            Gerenciar →
          </button>
        </div>
        <div className="data-table" style={{ marginBottom: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Status</th>
                <th className="caixa-amount-col">Mensalidade</th>
                <th className="caixa-amount-col">WA</th>
              </tr>
            </thead>
            <tbody>
              {empresas.map(e => (
                <tr key={e.id}>
                  <td style={{ fontWeight: 500 }}>{e.nome}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGES[e.status] ?? 'badge-neutral'}`}>
                      {STATUS_LABELS[e.status] ?? e.status}
                    </span>
                  </td>
                  <td className="caixa-amount-col">{fmt(e.valor_mensalidade ?? 0)}</td>
                  <td
                    className="caixa-amount-col"
                    style={{
                      fontWeight: 700,
                      color: (e.whatsapp_creditos ?? 0) === 0
                        ? 'var(--danger)'
                        : (e.whatsapp_creditos ?? 0) < 10
                          ? 'var(--warning)'
                          : 'var(--success)',
                    }}
                  >
                    {e.whatsapp_creditos ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
